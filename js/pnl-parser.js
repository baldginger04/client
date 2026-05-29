// =====================================================================
// pnl-parser.js — parse QBO multi-month P&L xlsx files
//
// Workflow:
//   1. parsePnlWorkbook(arrayBuffer)   → extracts raw rows + month columns
//   2. matchAccounts(rows, mappings)   → categorizes each account
//   3. persistPnlData(...)             → writes to pnl_data table
//
// The QBO format we expect (verified against Bill's Hospitality export):
//   Row 1: Company name
//   Row 2: "Profit and Loss"
//   Row 3: Date range (e.g. "May 2025 - April 2026")
//   Row 4: blank
//   Row 5: Header row — column A blank, B-? months ("May 2025", "Jun 2025",...),
//          last column is "Total"
//   Row 6+: account rows. Leading spaces in column A indicate hierarchy.
//          Top-level accounts (3 spaces), child accounts (6+ spaces).
//   Account labels can be:
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

  // Find the header row (the one with month labels in B onward). We look for
  // a row where column A is blank and column B contains a month-year string.
  let headerRowIdx = -1;
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
  if (headerRowIdx < 0) throw new Error("Couldn't find month header row — is this a QBO P&L export?");

  // Build month list — convert "May 2025" → "2025-05" for each header cell.
  const headerRow = aoa[headerRowIdx];
  const months = [];
  const monthColIdxs = [];  // index into the row array for each month column
  for (let c = 1; c < headerRow.length; c++) {
    const label = String(headerRow[c] || '').trim();
    if (label === 'Total' || label === '') continue;
    const period = parseMonthLabel(label);
    if (period) {
      months.push(period);
      monthColIdxs.push(c);
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

  // Filter to leaf rows: a row is a leaf if either
  //   (a) the NEXT collected row's indent is <= this row's indent (no children), OR
  //   (b) this row has at least one non-zero direct value (a "parent with its
  //       own posting" — QBO puts a value on a parent row only when there's a
  //       direct journal entry to that account, not a sum of children).
  //
  // Without (b), parent-level adjustments (e.g. "6120 Payroll Taxes" with a
  // -$82.93 correcting entry above its children 6121-6124) get dropped.
  const rows = collected.filter((row, i) => {
    const next = collected[i + 1];
    const hasChildren = next && next.indent > row.indent;
    if (!hasChildren) return true;  // leaf — no children below
    // Has children: keep ONLY if the parent itself posts a non-zero amount.
    const hasOwnValue = Object.values(row.amounts).some((v) => v !== 0);
    return hasOwnValue;
  });

  return { months, rows };
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

  return rows.map((row) => {
    const cat = findCategory(row, sorted);
    return { ...row, category: cat };
  });
}

function findCategory(row, sortedMappings) {
  for (const rule of sortedMappings) {
    if (rule.match_type === 'number_exact' && row.account_number === rule.account_match) return rule.category;
    if (rule.match_type === 'number_prefix' && row.account_number && row.account_number.startsWith(rule.account_match)) return rule.category;
    if (rule.match_type === 'name_contains' && row.account_name.toLowerCase().includes(rule.account_match.toLowerCase())) return rule.category;
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
