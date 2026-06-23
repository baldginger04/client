// =====================================================================
// pnl-parser.js — parse QBO P&L xlsx files (multi-month OR single-month)
//
// Workflow:
//   1. parsePnlWorkbook(arrayBuffer)   → extracts raw rows + month columns
//   2. matchAccounts(rows, mappings)   → categorizes each account
//   3. persistPnlData(...)             → writes to pnl_data table
//
// Two export shapes are supported:
//
//   MULTI-month (QBO "compare months"):
//     Row 3: date range (e.g. "May 2025 - April 2026")
//     Row 5: header — col A blank, cols B+ are months ("May 2025", ...),
//            trailing "Total" column.
//
//   SINGLE-month (QBO "this month"):
//     Row 3: the period ("May 2026") — note it sits in COLUMN A, not a header
//     Row 5: header — col A blank, single data column labeled "Total"
//     The period is read from the title block; "Total" holds the values.
//
//   Row 6+ (both shapes): account rows. Leading spaces in column A indicate
//          hierarchy (top-level ~3 spaces, children 6+). Labels can be:
//     "   4100 Food Sales"        → number=4100, name=Food Sales
//     "      Mixed Beverage Tax"  → no number, name only
//     "Total 4100 Food Sales"     → subtotal line (skipped — we use leaf rows)
//     "Net Income", "Gross Profit" → calculated lines (skipped)
// =====================================================================
import { sb } from './config.js';

// Lines that aren't accounts and should be ignored when extracting data.
const SKIP_PREFIXES = ['Total ', 'Net ', 'Gross '];
const SKIP_EXACT = new Set([
  'Income', 'Cost of Goods Sold', 'Expenses', 'Other Income',
  'Net Income', 'Gross Profit', 'Net Operating Income', 'Net Other Income',
  'Total Income', 'Total Cost of Goods Sold', 'Total Expenses', 'Total Other Income',
]);

/**
 * Parse a QBO P&L xlsx given an ArrayBuffer.
 * Returns { months: ['2025-05', ...], rows: [{ account_number, account_name, amounts: { '2025-05': 1234.56, ... } }, ...] }
 * Throws if the file doesn't look like a QBO P&L export.
 */
export function parsePnlWorkbook(arrayBuffer) {
  // SheetJS is loaded as a global by the portal's index.html.
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('SheetJS (XLSX) not loaded');

  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  if (!wb.SheetNames.length) throw new Error('Empty workbook');

  // QBO exports usually have exactly one sheet. If multiple, prefer one named
  // like "Profit and Loss"; otherwise take the first.
  const sheetName = wb.SheetNames.find((n) => /profit.*loss|p.*?l\b/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // Get a 2D array of values. Defval ensures blank cells are '' not undefined.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Find the header row + the month columns. QBO P&L exports come in two shapes:
  //
  //   (a) MULTI-month: column A blank, columns B+ are month labels ("May 2025",
  //       "Jun 2025", ...), usually with a trailing "Total" column.
  //   (b) SINGLE-month: the period lives in the title block (e.g. A3 = "May 2026"
  //       or a range like "January - May 2026"), and the one data column is
  //       labeled "Total".
  //
  // Try (a) first, then fall back to (b).
  let headerRowIdx = -1;
  let singlePeriod = null;  // set only for shape (b)

  // (a) A row whose first data cell (col B) is a month-year label.
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i];
    if (!row) continue;
    const colA = String(row[0] || '').trim();
    const colB = String(row[1] || '').trim();
    if (colA === '' && /^[A-Za-z]{3,9}\s+\d{4}$/.test(colB)) {
      headerRowIdx = i;
      break;
    }
  }

  // (b) Single-month: a row with column A blank and a "Total" column, where the
  //     period comes from a month/range label in the title rows above it.
  if (headerRowIdx < 0) {
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
      const row = aoa[i];
      if (!row) continue;
      const colA = String(row[0] || '').trim();
      const hasTotal = row.slice(1).some((v) => String(v || '').trim().toLowerCase() === 'total');
      if (colA !== '' || !hasTotal) continue;
      // Found the value-column header; read the period from the title rows above.
      // parseMonthLabel is strict ("May 2026"); parseMonthRangeEnd handles ranges.
      for (let j = 0; j < i; j++) {
        const title = String((aoa[j] || [])[0] || '').trim();
        const p = parseMonthLabel(title) || parseMonthRangeEnd(title);
        if (p) { singlePeriod = p; break; }
      }
      if (singlePeriod) { headerRowIdx = i; break; }
    }
  }

  if (headerRowIdx < 0) throw new Error("Couldn't find month header row — is this a QBO P&L export?");

  // Build the month list + the column index each month's values live in.
  const headerRow = aoa[headerRowIdx];
  const months = [];
  const monthColIdxs = [];  // index into the row array for each month column
  if (singlePeriod) {
    // Shape (b): single period; the values sit in the "Total" column.
    let totalCol = -1;
    for (let c = 1; c < headerRow.length; c++) {
      if (String(headerRow[c] || '').trim().toLowerCase() === 'total') { totalCol = c; break; }
    }
    months.push(singlePeriod);
    monthColIdxs.push(totalCol >= 0 ? totalCol : 1);
  } else {
    // Shape (a): one column per month; skip the trailing "Total".
    for (let c = 1; c < headerRow.length; c++) {
      const label = String(headerRow[c] || '').trim();
      if (label === 'Total' || label === '') continue;
      const period = parseMonthLabel(label);
      if (period) {
        months.push(period);
        monthColIdxs.push(c);
      }
    }
  }
  if (months.length === 0) throw new Error('No month columns found in header row');

  // Walk account rows. Start right after the header. Skip lines that are
  // section headers, totals, or computed rows.
  //
  // To avoid double-counting (e.g. "5300 Liquor COGS" parent + "5310 Liquor COGS"
  // child both sum into liquor_cogs), we keep only LEAF rows — accounts whose
  // immediate next non-blank account row is NOT indented deeper. The indent
  // level is the count of leading spaces in column A.
  const collected = [];
  for (let r = headerRowIdx + 1; r < aoa.length; r++) {
    const raw = aoa[r];
    if (!raw) continue;
    const label = String(raw[0] || '');
    const trimmed = label.trim();
    if (!trimmed) continue;
    if (SKIP_EXACT.has(trimmed)) continue;
    if (SKIP_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    if (/accrual basis|cash basis|^\w+,\s+\w+\s+\d+,\s+\d{4}/i.test(trimmed)) break;

    const indent = label.length - label.replace(/^ +/, '').length;
    const m = trimmed.match(/^(\d{3,5}(?:\.\.)?)\s+(.+)$/);
    const accountNumber = m ? m[1] : null;
    const accountName   = m ? m[2].trim() : trimmed;

    const amounts = {};
    let hasAny = false;
    monthColIdxs.forEach((colIdx, mIdx) => {
      const v = raw[colIdx];
      const num = typeof v === 'number' ? v : (parseFloat(String(v).replace(/[$,]/g, '')) || 0);
      amounts[months[mIdx]] = num;
      if (num !== 0) hasAny = true;
    });
    if (!hasAny && trimmed.length < 4) continue;

    collected.push({ indent, account_number: accountNumber, account_name: accountName, amounts });
  }

  // Return the FULL collected hierarchy (including zero-posting parent rows).
  // The leaf filter that drops pure-sum parents now runs in matchAccounts,
  // AFTER category inheritance — otherwise a zero-posting department parent
  // (e.g. "4120 Tiny Cafe" with all its value on child rows) would be dropped
  // before its children could inherit its category. For clients with no
  // inherit_children rules this is behaviourally identical: matchAccounts
  // applies the exact same leaf filter to the exact same rows.
  return { months, rows: collected };
}

/**
 * Detect whether a workbook is a "Profit and Loss by Class" export (class
 * columns) versus a standard month/Total P&L. Cheap: checks the sheet name
 * first, then falls back to a header-row scan (col A blank, a Total column,
 * and ≥2 non-month value labels). Returns 'by_class' or 'standard'.
 */
export function detectPnlFormat(arrayBuffer) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('SheetJS (XLSX) not loaded');
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  if (!wb.SheetNames.length) return 'standard';
  if (wb.SheetNames.some((n) => /by\s*class/i.test(n))) return 'by_class';
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i];
    if (!row || String(row[0] || '').trim() !== '') continue;
    const labels = row.slice(1).map((v) => String(v || '').trim());
    const hasTotal = labels.some((l) => l.toLowerCase() === 'total');
    const classish = labels.filter((l) => l && l.toLowerCase() !== 'total' && !parseMonthLabel(l));
    if (hasTotal && classish.length >= 2) return 'by_class';
  }
  return 'standard';
}

/**
 * Parse a "Profit and Loss by Class" export. Unlike the standard parser the
 * columns are CLASSES (business units), not months, and the single period
 * lives in the title block. Returns:
 *   { period: '2026-05', classes: ['Alexander\'s', ...],
 *     rowsByClass: { "Alexander's": [ {indent, account_number, account_name,
 *                                      amounts: { '2026-05': 1234.56 } }, ... ], ... } }
 *
 * Every account row is emitted for every class (including its zero rows) so
 * each class carries the FULL account hierarchy — matchAccounts then applies
 * parent inheritance + the leaf filter per class independently.
 */
export function parsePnlByClass(arrayBuffer) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('SheetJS (XLSX) not loaded');
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  if (!wb.SheetNames.length) throw new Error('Empty workbook');
  const sheetName = wb.SheetNames.find((n) => /by\s*class/i.test(n))
    || wb.SheetNames.find((n) => /profit.*loss|p.*?l\b/i.test(n))
    || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Header row: col A blank, a Total column, and ≥2 non-month value labels.
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i];
    if (!row || String(row[0] || '').trim() !== '') continue;
    const labels = row.slice(1).map((v) => String(v || '').trim());
    const hasTotal = labels.some((l) => l.toLowerCase() === 'total');
    const classish = labels.filter((l) => l && l.toLowerCase() !== 'total' && !parseMonthLabel(l));
    if (hasTotal && classish.length >= 2) { headerRowIdx = i; break; }
  }
  if (headerRowIdx < 0) throw new Error("Couldn't find the class header row — is this a P&L by Class export?");

  // Period: a month / range label in the title rows above the header.
  let period = null;
  for (let j = 0; j < headerRowIdx; j++) {
    const title = String((aoa[j] || [])[0] || '').trim();
    const p = parseMonthLabel(title) || parseMonthRangeEnd(title);
    if (p) { period = p; break; }
  }
  if (!period) throw new Error("Couldn't read the period (e.g. 'May 2026') from the title rows");

  // Class columns: every column whose header isn't blank/Total. Strip the
  // leading "N - " QBO class-number prefix so "1 - Alexander's" → "Alexander's".
  const headerRow = aoa[headerRowIdx];
  const classCols = [];
  for (let c = 1; c < headerRow.length; c++) {
    const label = String(headerRow[c] || '').trim();
    if (!label || label.toLowerCase() === 'total') continue;
    classCols.push({ col: c, name: label.replace(/^\d+\s*-\s*/, '').trim() });
  }
  if (!classCols.length) throw new Error('No class columns found in header row');

  const rowsByClass = {};
  classCols.forEach((cc) => { rowsByClass[cc.name] = []; });

  for (let r = headerRowIdx + 1; r < aoa.length; r++) {
    const raw = aoa[r];
    if (!raw) continue;
    const label = String(raw[0] || '');
    const trimmed = label.trim();
    if (!trimmed) continue;
    if (SKIP_EXACT.has(trimmed)) continue;
    if (SKIP_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    if (/accrual basis|cash basis|^\w+,\s+\w+\s+\d+,\s+\d{4}/i.test(trimmed)) break;

    const indent = label.length - label.replace(/^ +/, '').length;
    const m = trimmed.match(/^(\d{3,5}(?:\.\.)?)\s+(.+)$/);
    const accountNumber = m ? m[1] : null;
    const accountName   = m ? m[2].trim() : trimmed;

    classCols.forEach((cc) => {
      const v = raw[cc.col];
      const num = typeof v === 'number' ? v : (parseFloat(String(v).replace(/[$,]/g, '')) || 0);
      rowsByClass[cc.name].push({
        indent, account_number: accountNumber, account_name: accountName,
        amounts: { [period]: num },
      });
    });
  }

  return { period, classes: classCols.map((c) => c.name), rowsByClass };
}

/** Convert "May 2025" / "January 2026" → "2025-05" / "2026-01". */
function parseMonthLabel(label) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = label.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const monthIdx = months.findIndex((mm) => m[1].toLowerCase().startsWith(mm.toLowerCase()));
  if (monthIdx < 0) return null;
  return `${m[2]}-${String(monthIdx + 1).padStart(2, '0')}`;
}

/** Best-effort period from a single-month title that isn't a bare "May 2026" —
 *  e.g. "January - May 2026", "May 1-31, 2026", "Jan 1 - May 31, 2026" — returns
 *  the END month as "2026-05". Requires a 4-digit year, so plain text without a
 *  year (company names, "Profit and Loss") safely returns null. */
function parseMonthRangeEnd(label) {
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const yearM = String(label).match(/(\d{4})/);
  if (!yearM) return null;
  const lower = String(label).toLowerCase();
  let bestPos = -1, bestIdx = -1;
  for (let k = 0; k < months.length; k++) {
    const pos = lower.lastIndexOf(months[k]);  // latest month mentioned = period end
    if (pos > bestPos) { bestPos = pos; bestIdx = k; }
  }
  if (bestIdx < 0) return null;
  return `${yearM[1]}-${String(bestIdx + 1).padStart(2, '0')}`;
}

/**
 * Given parsed rows and a list of COA mappings, return rows with a category
 * assigned to each. Unmatched rows get category=null so the UI can surface them.
 *
 * Rule resolution:
 *   1. Client-specific rules (client_id matches) outrank global rules.
 *   2. Within a tier, lower priority number wins.
 *   3. number_exact > number_prefix > name_contains for ties at same priority.
 */
export function matchAccounts(rows, mappings, clientId) {
  // Pre-sort mappings: client-specific first, then by priority, then by type
  // specificity. We iterate in order and the first hit wins.
  const typeOrder = { number_exact: 0, number_prefix: 1, name_contains: 2 };
  const sorted = [...mappings].sort((a, b) => {
    const aIsClient = a.client_id === clientId ? 0 : 1;
    const bIsClient = b.client_id === clientId ? 0 : 1;
    if (aIsClient !== bIsClient) return aIsClient - bIsClient;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (typeOrder[a.match_type] ?? 99) - (typeOrder[b.match_type] ?? 99);
  });

  // Parent-category inheritance (opt-in, gated by the matched rule's
  // inherit_children flag — default false). When a row matches no rule, it
  // inherits the category of the nearest shallower-indent ancestor whose rule
  // had inherit_children = true. This lets a single parent mapping (e.g.
  // "4170 Grocery → grocery_sales") carry an arbitrary set of name-only child
  // line items (Chocolate & Treats, Drinks & Juice, …) with no per-name rules
  // and no account numbers. Restaurant clients set inherit_children nowhere,
  // so their categorization is byte-identical to before. `indent` is the count
  // of leading spaces captured at parse time. The same mechanism lets the Inn
  // (P&L by class) and any future deeply-nested COA resolve cleanly.
  const ancestors = [];  // stack of { indent, category, inherit }
  const categorized = rows.map((row) => {
    const rule = findCategoryRule(row, sorted);
    let cat = rule ? rule.category : null;
    let inherit = rule ? !!rule.inherit_children : false;

    // Drop ancestors that are not strict parents of this row.
    while (ancestors.length && ancestors[ancestors.length - 1].indent >= row.indent) {
      ancestors.pop();
    }
    // Unmatched row: inherit from nearest inheriting ancestor, if any.
    if (cat === null) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        if (ancestors[i].inherit && ancestors[i].category) {
          cat = ancestors[i].category;
          inherit = true;  // propagate so deeper descendants inherit too
          break;
        }
      }
    }
    ancestors.push({ indent: row.indent, category: cat, inherit });
    return { ...row, category: cat };
  });

  // Leaf filter (moved here from parsePnlWorkbook): drop pure-sum parent rows
  // — those that have deeper-indented children AND post no value of their own
  // — now that their children have inherited any category they needed. The
  // logic and result are identical to the previous in-parse filter, so for
  // clients with no inherit_children rules the output is byte-identical.
  return categorized.filter((row, i) => {
    const next = rows[i + 1];
    const hasChildren = next && next.indent > row.indent;
    if (!hasChildren) return true;  // leaf — no children below
    const hasOwnValue = Object.values(row.amounts).some((v) => v !== 0);
    return hasOwnValue;
  });
}

function findCategoryRule(row, sortedMappings) {
  for (const rule of sortedMappings) {
    if (rule.match_type === 'number_exact' && row.account_number === rule.account_match) return rule;
    if (rule.match_type === 'number_prefix' && row.account_number && row.account_number.startsWith(rule.account_match)) return rule;
    if (rule.match_type === 'name_contains' && row.account_name.toLowerCase().includes(rule.account_match.toLowerCase())) return rule;
  }
  return null;
}

/**
 * Write parsed rows to the pnl_data table. Replaces existing rows for the
 * affected periods so re-uploads supersede cleanly.
 */
export async function persistPnlData(clientId, parsedRows, months, sourceFileId) {
  // Wipe existing rows for these client+period combos
  const { error: delErr } = await sb
    .from('pnl_data')
    .delete()
    .eq('client_id', clientId)
    .in('period', months);
  if (delErr) throw new Error(`Failed to clear existing data: ${delErr.message}`);

  // Insert new rows. One row per (period × account).
  const insertRows = [];
  for (const row of parsedRows) {
    for (const period of months) {
      const amount = row.amounts[period];
      if (amount === undefined) continue;
      insertRows.push({
        client_id: clientId,
        period,
        account_number: row.account_number,
        account_name: row.account_name,
        amount,
        category: row.category || null,
        class: row.class || null,
        source_file_id: sourceFileId,
      });
    }
  }
  if (insertRows.length === 0) return { inserted: 0 };

  // Supabase has a row-size limit on inserts; chunk into batches of 500.
  let inserted = 0;
  for (let i = 0; i < insertRows.length; i += 500) {
    const chunk = insertRows.slice(i, i + 500);
    const { error } = await sb.from('pnl_data').insert(chunk);
    if (error) throw new Error(`Insert batch failed: ${error.message}`);
    inserted += chunk.length;
  }
  return { inserted };
}

/** Fetch all mappings (global + client-specific) for the parser to use. */
export async function fetchMappings(clientId) {
  const { data, error } = await sb
    .from('coa_mappings')
    .select('*')
    .or(`client_id.is.null,client_id.eq.${clientId}`);
  if (error) throw error;
  return data || [];
}
