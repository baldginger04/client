// =====================================================================
// pnl-summary.js — monthly P&L table view (Phase 2 follow-up)
//
// Shows the most recent month side-by-side with the prior month and the
// same month from the prior year. Variance columns highlight the change.
//
// Reads from pnl_data (no parsing, no recomputation). Categories that
// don't apply to a client just stay zero/blank in their respective columns.
// =====================================================================
import { sb } from './config.js';

// Section structure. Each section has rows; each row is a category key
// that we look up in the aggregated data. `subtotal` rows are computed
// from the section's children; never a direct category lookup.
const SECTIONS = [
  {
    title: 'Sales',
    rows: [
      { key: 'food_sales',         label: 'Food' },
      { key: 'liquor_sales',       label: 'Liquor' },
      { key: 'beer_sales',         label: 'Beer' },
      { key: 'wine_sales',         label: 'Wine' },
      { key: 'na_bev_sales',       label: 'NA Beverages' },
      { key: 'merchandise_sales',  label: 'Merchandise' },
      { key: 'other_sales',        label: 'Other' },
      { key: 'discounts',          label: 'Discounts & Refunds' },
    ],
    // Total Income = sum of children. discounts are negative in QBO so they
    // naturally subtract when summed. favorableDirection: 'up' means a
    // higher value is good (green).
    subtotal: { label: 'Total Income', favorableDirection: 'up' },
  },
  {
    title: 'Cost of Goods Sold',
    rows: [
      { key: 'food_cogs',          label: 'Food COGS' },
      { key: 'liquor_cogs',        label: 'Liquor COGS' },
      { key: 'beer_cogs',          label: 'Beer COGS' },
      { key: 'wine_cogs',          label: 'Wine COGS' },
      { key: 'na_bev_cogs',        label: 'NA Beverages COGS' },
      { key: 'merchandise_cogs',   label: 'Merchandise COGS' },
      { key: 'other_cogs',         label: 'Other COGS' },
    ],
    subtotal: { label: 'Total COGS', favorableDirection: 'down' },
  },
  {
    title: 'Labor',
    rows: [
      { key: 'labor_boh',          label: 'BOH' },
      { key: 'labor_foh',          label: 'FOH' },
      { key: 'labor_management',   label: 'Management' },
      { key: 'labor_other',        label: 'Other' },
      { key: 'labor_bonus',        label: 'Bonus' },
      { key: 'labor_benefits',     label: 'Benefits' },
      { key: 'payroll_taxes',      label: 'Payroll Taxes' },
    ],
    subtotal: { label: 'Total Labor', favorableDirection: 'down' },
  },
];

// Pseudo-rows that are computed from section totals. Rendered as their own
// section after the three above.
const COMPUTED = [
  { label: 'Gross Profit',  compute: (s) => s.totals.income - s.totals.cogs,                 favorableDirection: 'up' },
  { label: 'Prime Cost',    compute: (s) => s.totals.cogs + s.totals.labor,                  favorableDirection: 'down' },
  { label: 'Prime Cost %',  compute: (s) => s.totals.income ? ((s.totals.cogs + s.totals.labor) / s.totals.income) * 100 : null, isPct: true, favorableDirection: 'down' },
];

export async function mountPnlSummary({ clientId }) {
  const root = document.getElementById('tab-pnl-summary');
  if (!root) return;

  root.innerHTML = `
    <section class="card">
      <h2 style="font-family:var(--font-display);font-style:italic;font-size:24px;margin:0 0 4px">P&amp;L Summary</h2>
      <p style="color:var(--text2);margin:0 0 18px;font-size:13px">Current month vs prior month and same month last year.</p>
      <div id="pnl-summary-content" style="padding:24px;text-align:center;color:var(--text3)">Loading…</div>
    </section>`;

  let rows;
  try {
    const res = await sb
      .from('pnl_data')
      .select('period, category, amount')
      .eq('client_id', clientId)
      .not('category', 'is', null);
    if (res.error) throw res.error;
    rows = res.data || [];
  } catch (e) {
    document.getElementById('pnl-summary-content').innerHTML =
      `<div style="color:var(--red)">Couldn't load: ${e.message || e}</div>`;
    return;
  }

  if (!rows.length) {
    document.getElementById('pnl-summary-content').innerHTML = `
      <div style="padding:48px 24px;text-align:center;color:var(--text2)">
        <div style="font-size:42px;margin-bottom:10px">📋</div>
        <h3 style="margin:0 0 6px;color:var(--text)">No P&amp;L data yet</h3>
        <p style="margin:0;font-size:13px">Upload a P&amp;L to the Financials tab and click <em>Parse P&amp;L</em> to populate this view.</p>
      </div>`;
    return;
  }

  // Aggregate by period+category
  const byPeriod = {};
  for (const r of rows) {
    if (!byPeriod[r.period]) byPeriod[r.period] = {};
    byPeriod[r.period][r.category] = (byPeriod[r.period][r.category] || 0) + Number(r.amount);
  }
  const periods = Object.keys(byPeriod).sort();
  const current = periods[periods.length - 1];
  const prior = periods[periods.length - 2] || null;
  // "Same month last year" = current period minus 12 months
  const yoy = subtractYear(current);
  const yoyExists = byPeriod[yoy] ? yoy : null;

  renderTable(byPeriod, current, prior, yoyExists);
}

export function unmountPnlSummary() {
  // No persistent listeners to tear down.
}

// =====================================================================
// Helpers
// =====================================================================

function subtractYear(period) {
  // period is "YYYY-MM" → return "YYYY-MM" one year prior
  const [y, m] = period.split('-');
  return `${parseInt(y, 10) - 1}-${m}`;
}

function formatPeriodLabel(period) {
  if (!period) return '—';
  const [y, m] = period.split('-');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${monthNames[parseInt(m, 10) - 1]} ${y}`;
}

function fmtMoney(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  if (v === 0) return '$0';
  const neg = v < 0;
  const abs = Math.abs(v);
  const s = '$' + Math.round(abs).toLocaleString();
  return neg ? `(${s})` : s;
}

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return `${v.toFixed(1)}%`;
}

// Variance display: $ amount, colored by favorability. Direction tells us
// whether "up" or "down" is good for this row. Sales going up = green.
// COGS going up = red.
function fmtVariance(curr, prev, direction) {
  if (prev === null || prev === undefined) return '<span style="color:var(--text3)">—</span>';
  if (curr === null || curr === undefined) return '<span style="color:var(--text3)">—</span>';
  const delta = curr - prev;
  if (delta === 0) return '<span style="color:var(--text3)">—</span>';

  const isFavorable = (direction === 'up' && delta > 0) || (direction === 'down' && delta < 0);
  const color = isFavorable ? '#2e7d4f' : '#c0392b';
  const sign = delta > 0 ? '+' : '−';
  const abs = Math.abs(delta);
  return `<span style="color:${color};font-variant-numeric:tabular-nums">${sign}$${Math.round(abs).toLocaleString()}</span>`;
}

// =====================================================================
// Render
// =====================================================================

function renderTable(byPeriod, currentP, priorP, yoyP) {
  const cur = byPeriod[currentP] || {};
  const pri = priorP ? (byPeriod[priorP] || {}) : null;
  const yoy = yoyP ? (byPeriod[yoyP] || {}) : null;

  // Pre-compute per-section totals so we can show Total Income / Total COGS /
  // Total Labor consistently AND derive Gross Profit / Prime Cost.
  const sectionTotals = (data) => {
    const t = { income: 0, cogs: 0, labor: 0 };
    for (const r of SECTIONS[0].rows) t.income += (data[r.key] || 0);
    for (const r of SECTIONS[1].rows) t.cogs   += (data[r.key] || 0);
    for (const r of SECTIONS[2].rows) t.labor  += (data[r.key] || 0);
    return t;
  };
  const totals = {
    current: sectionTotals(cur),
    prior:   pri ? sectionTotals(pri) : null,
    yoy:     yoy ? sectionTotals(yoy) : null,
  };

  const colHeader = `
    <thead>
      <tr>
        <th class="pnl-sum-acct"></th>
        <th class="pnl-sum-num">${formatPeriodLabel(currentP)}</th>
        <th class="pnl-sum-num">${formatPeriodLabel(priorP)}</th>
        <th class="pnl-sum-num">vs Prior</th>
        <th class="pnl-sum-num">${formatPeriodLabel(yoyP)}</th>
        <th class="pnl-sum-num">vs YoY</th>
      </tr>
    </thead>`;

  // Build each section's body
  const sectionHtml = SECTIONS.map((section, sIdx) => {
    const rowKeys = section.rows;
    // The standard rows for this section
    const rowsHtml = rowKeys.map((row) => {
      const cV = cur[row.key] || 0;
      const pV = pri ? (pri[row.key] || 0) : null;
      const yV = yoy ? (yoy[row.key] || 0) : null;
      // Skip rows that are zero across all visible columns to keep it clean
      if (cV === 0 && (pV === null || pV === 0) && (yV === null || yV === 0)) return '';
      // Direction inferred from section: Sales section is "up is good"; cost
      // sections are "down is good".
      const dir = section.title === 'Sales' ? 'up' : 'down';
      // Discounts are negative; flip the favorable direction so a bigger
      // discount = unfavorable (red). It's a sales-section row so direction
      // is "up" by default → flip to "down".
      const rowDir = row.key === 'discounts' ? 'down' : dir;
      return `<tr>
        <td class="pnl-sum-acct">${row.label}</td>
        <td class="pnl-sum-num">${fmtMoney(cV)}</td>
        <td class="pnl-sum-num">${fmtMoney(pV)}</td>
        <td class="pnl-sum-num">${fmtVariance(cV, pV, rowDir)}</td>
        <td class="pnl-sum-num">${fmtMoney(yV)}</td>
        <td class="pnl-sum-num">${fmtVariance(cV, yV, rowDir)}</td>
      </tr>`;
    }).join('');

    // Subtotal: use precomputed totals.income / .cogs / .labor based on
    // section index. Cleaner than recomputing inline.
    const totalKey = sIdx === 0 ? 'income' : sIdx === 1 ? 'cogs' : 'labor';
    const cT = totals.current[totalKey];
    const pT = totals.prior ? totals.prior[totalKey] : null;
    const yT = totals.yoy ? totals.yoy[totalKey] : null;
    const subDir = section.subtotal.favorableDirection;

    const subtotalHtml = `<tr class="pnl-sum-subtotal">
      <td class="pnl-sum-acct">${section.subtotal.label}</td>
      <td class="pnl-sum-num">${fmtMoney(cT)}</td>
      <td class="pnl-sum-num">${fmtMoney(pT)}</td>
      <td class="pnl-sum-num">${fmtVariance(cT, pT, subDir)}</td>
      <td class="pnl-sum-num">${fmtMoney(yT)}</td>
      <td class="pnl-sum-num">${fmtVariance(cT, yT, subDir)}</td>
    </tr>`;

    return `<tbody class="pnl-sum-section">
      <tr class="pnl-sum-section-header"><td colspan="6">${section.title}</td></tr>
      ${rowsHtml}
      ${subtotalHtml}
    </tbody>`;
  }).join('');

  // Computed bottom section (Gross Profit, Prime Cost, Prime Cost %)
  const computedHtml = COMPUTED.map((c) => {
    const cV = c.compute({ totals: totals.current });
    const pV = totals.prior ? c.compute({ totals: totals.prior }) : null;
    const yV = totals.yoy   ? c.compute({ totals: totals.yoy })   : null;
    const fmt = c.isPct ? fmtPct : fmtMoney;
    return `<tr class="pnl-sum-computed-row">
      <td class="pnl-sum-acct">${c.label}</td>
      <td class="pnl-sum-num">${fmt(cV)}</td>
      <td class="pnl-sum-num">${fmt(pV)}</td>
      <td class="pnl-sum-num">${fmtVariance(cV, pV, c.favorableDirection)}</td>
      <td class="pnl-sum-num">${fmt(yV)}</td>
      <td class="pnl-sum-num">${fmtVariance(cV, yV, c.favorableDirection)}</td>
    </tr>`;
  }).join('');

  const computedBlock = `<tbody class="pnl-sum-section">
    <tr class="pnl-sum-section-header"><td colspan="6">Profitability</td></tr>
    ${computedHtml}
  </tbody>`;

  const html = `
    <table class="pnl-summary-table">
      ${colHeader}
      ${sectionHtml}
      ${computedBlock}
    </table>`;

  document.getElementById('pnl-summary-content').innerHTML = html;
}
