// =====================================================================
// pnl-summary.js — monthly P&L table view (Phase 2 follow-up)
//
// Shows the most recent month side-by-side with the prior month and the
// same month from the prior year. Variance columns highlight the change.
// Each cost row shows % of the relevant sales base (food cogs / food sales,
// labor / total sales, etc.). Clicking any row opens a drill-down modal
// with the underlying account-level detail.
// =====================================================================
import { sb } from './config.js';

// ---------------------------------------------------------------------
// Section structure. pctBase is the category we divide by to get the row's
// percentage: e.g. food_cogs / food_sales, labor_boh / total_income.
// rows that should NOT show a percentage have pctBase: null.
// ---------------------------------------------------------------------
const SECTIONS = [
  {
    title: 'Sales',
    rows: [
      { key: 'food_sales',         label: 'Food',              pctBase: null },
      { key: 'liquor_sales',       label: 'Liquor',            pctBase: null },
      { key: 'beer_sales',         label: 'Beer',              pctBase: null },
      { key: 'wine_sales',         label: 'Wine',              pctBase: null },
      { key: 'na_bev_sales',       label: 'NA Beverages',      pctBase: null },
      { key: 'merchandise_sales',  label: 'Merchandise',       pctBase: null },
      { key: 'other_sales',        label: 'Other',             pctBase: null },
      { key: 'discounts',          label: 'Discounts & Refunds', pctBase: null },
    ],
    subtotal: { label: 'Total Income', favorableDirection: 'up', pctBase: null },
  },
  {
    title: 'Cost of Goods Sold',
    rows: [
      { key: 'food_cogs',          label: 'Food COGS',         pctBase: 'food_sales' },
      { key: 'liquor_cogs',        label: 'Liquor COGS',       pctBase: 'liquor_sales' },
      { key: 'beer_cogs',          label: 'Beer COGS',         pctBase: 'beer_sales' },
      { key: 'wine_cogs',          label: 'Wine COGS',         pctBase: 'wine_sales' },
      { key: 'na_bev_cogs',        label: 'NA Beverages COGS', pctBase: 'na_bev_sales' },
      { key: 'merchandise_cogs',   label: 'Merchandise COGS',  pctBase: 'merchandise_sales' },
      { key: 'other_cogs',         label: 'Other COGS',        pctBase: 'other_sales' },
    ],
    // Total COGS % is of Total Income (computed separately below).
    subtotal: { label: 'Total COGS', favorableDirection: 'down', pctBase: 'TOTAL_INCOME' },
  },
  {
    title: 'Labor',
    rows: [
      { key: 'labor_boh',          label: 'BOH',               pctBase: 'TOTAL_INCOME' },
      { key: 'labor_foh',          label: 'FOH',               pctBase: 'TOTAL_INCOME' },
      { key: 'labor_management',   label: 'Management',        pctBase: 'TOTAL_INCOME' },
      { key: 'labor_other',        label: 'Other',             pctBase: 'TOTAL_INCOME' },
      { key: 'labor_bonus',        label: 'Bonus',             pctBase: 'TOTAL_INCOME' },
      { key: 'labor_benefits',     label: 'Benefits',          pctBase: 'TOTAL_INCOME' },
      { key: 'payroll_taxes',      label: 'Payroll Taxes',     pctBase: 'TOTAL_INCOME' },
    ],
    subtotal: { label: 'Total Labor', favorableDirection: 'down', pctBase: 'TOTAL_INCOME' },
  },
];

// Pseudo-rows computed from section totals.
const COMPUTED = [
  { label: 'Gross Profit',  compute: (s) => s.totals.income - s.totals.cogs,                                                   favorableDirection: 'up',   isPct: false, pctBase: 'TOTAL_INCOME' },
  { label: 'Prime Cost',    compute: (s) => s.totals.cogs + s.totals.labor,                                                    favorableDirection: 'down', isPct: false, pctBase: 'TOTAL_INCOME' },
];

// State for the active drill-down (current client + raw rows kept here so
// the modal can re-query account-level detail without another DB call).
let activeData = null;

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------
export async function mountPnlSummary({ clientId }) {
  const root = document.getElementById('tab-pnl-summary');
  if (!root) return;

  root.innerHTML = `
    <section class="card">
      <h2 style="font-family:var(--font-display);font-style:italic;font-size:24px;margin:0 0 4px">Prime Sheet</h2>
      <p style="color:var(--text2);margin:0 0 18px;font-size:13px">Current month vs prior month and same month last year. Click any row for account-level detail.</p>
      <div id="pnl-summary-content" style="padding:24px;text-align:center;color:var(--text3)">Loading…</div>
    </section>`;

  let rows;
  try {
    const res = await sb
      .from('pnl_data')
      .select('period, category, amount, account_number, account_name')
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

  // Aggregate by period + category (for the summary table). Also keep raw
  // rows so the drill-down can show account-level breakdowns by category.
  const byPeriod = {};
  const rawByPeriodCategory = {};  // { period: { category: [ {account_number, account_name, amount}, ... ] } }
  for (const r of rows) {
    if (!byPeriod[r.period]) byPeriod[r.period] = {};
    byPeriod[r.period][r.category] = (byPeriod[r.period][r.category] || 0) + Number(r.amount);
    if (!rawByPeriodCategory[r.period]) rawByPeriodCategory[r.period] = {};
    if (!rawByPeriodCategory[r.period][r.category]) rawByPeriodCategory[r.period][r.category] = [];
    rawByPeriodCategory[r.period][r.category].push({
      account_number: r.account_number,
      account_name: r.account_name,
      amount: Number(r.amount),
    });
  }
  const periods = Object.keys(byPeriod).sort();
  const current = periods[periods.length - 1];
  const prior = periods[periods.length - 2] || null;
  const yoy = subtractYear(current);
  const yoyExists = byPeriod[yoy] ? yoy : null;

  activeData = { byPeriod, rawByPeriodCategory, current, prior, yoy: yoyExists };
  renderTable();
}

export function unmountPnlSummary() {
  closeDrillModal();
  activeData = null;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function subtractYear(period) {
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
  if (v === null || v === undefined || isNaN(v)) return '<span style="color:var(--text3)">—</span>';
  return `${v.toFixed(1)}%`;
}
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

// Compute a row's % given the period's data dict, the row's pctBase, and
// the period's precomputed totals. Returns null if percentage doesn't apply
// or the denominator is zero.
function computePct(value, pctBase, periodData, periodTotals) {
  if (!pctBase) return null;
  let denom;
  if (pctBase === 'TOTAL_INCOME') denom = periodTotals.income;
  else denom = periodData[pctBase] || 0;
  if (!denom || denom === 0) return null;
  return (value / denom) * 100;
}

function sectionTotals(data) {
  const t = { income: 0, cogs: 0, labor: 0 };
  for (const r of SECTIONS[0].rows) t.income += (data[r.key] || 0);
  for (const r of SECTIONS[1].rows) t.cogs   += (data[r.key] || 0);
  for (const r of SECTIONS[2].rows) t.labor  += (data[r.key] || 0);
  return t;
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function renderTable() {
  const { byPeriod, current, prior, yoy } = activeData;
  const cur = byPeriod[current] || {};
  const pri = prior ? (byPeriod[prior] || {}) : null;
  const yoyData = yoy ? (byPeriod[yoy] || {}) : null;

  const totals = {
    current: sectionTotals(cur),
    prior:   pri ? sectionTotals(pri) : null,
    yoy:     yoyData ? sectionTotals(yoyData) : null,
  };

  // Header. New column structure adds a % column right after each period $.
  const header = `
    <thead>
      <tr>
        <th class="pnl-sum-acct"></th>
        <th class="pnl-sum-num" colspan="2">${formatPeriodLabel(current)}</th>
        <th class="pnl-sum-num" colspan="2">${formatPeriodLabel(prior)}</th>
        <th class="pnl-sum-num">vs Prior</th>
        <th class="pnl-sum-num" colspan="2">${formatPeriodLabel(yoy)}</th>
        <th class="pnl-sum-num">vs YoY</th>
      </tr>
      <tr class="pnl-sum-subheader">
        <th class="pnl-sum-acct"></th>
        <th class="pnl-sum-num">$</th><th class="pnl-sum-num pnl-sum-pct">%</th>
        <th class="pnl-sum-num">$</th><th class="pnl-sum-num pnl-sum-pct">%</th>
        <th class="pnl-sum-num"></th>
        <th class="pnl-sum-num">$</th><th class="pnl-sum-num pnl-sum-pct">%</th>
        <th class="pnl-sum-num"></th>
      </tr>
    </thead>`;

  const sectionHtml = SECTIONS.map((section, sIdx) => {
    const rowsHtml = section.rows.map((row) => {
      const cV = cur[row.key] || 0;
      const pV = pri ? (pri[row.key] || 0) : null;
      const yV = yoyData ? (yoyData[row.key] || 0) : null;
      if (cV === 0 && (pV === null || pV === 0) && (yV === null || yV === 0)) return '';

      const dir = section.title === 'Sales' ? 'up' : 'down';
      const rowDir = row.key === 'discounts' ? 'down' : dir;

      // Per-period percentages
      const cPct = computePct(cV, row.pctBase, cur, totals.current);
      const pPct = pri    ? computePct(pV, row.pctBase, pri, totals.prior)  : null;
      const yPct = yoyData ? computePct(yV, row.pctBase, yoyData, totals.yoy) : null;

      // Drillable rows have a click handler; we mark them so the cursor and
      // hover state reflect interactivity. Skip rows that are all-zero or
      // are pure sales (drilling into a single 4100 row isn't useful — but
      // we still allow it for consistency).
      return `<tr class="pnl-sum-row pnl-sum-drillable" data-category="${row.key}" data-label="${escapeAttr(row.label)}">
        <td class="pnl-sum-acct">${row.label}</td>
        <td class="pnl-sum-num">${fmtMoney(cV)}</td>
        <td class="pnl-sum-num pnl-sum-pct">${fmtPct(cPct)}</td>
        <td class="pnl-sum-num">${fmtMoney(pV)}</td>
        <td class="pnl-sum-num pnl-sum-pct">${fmtPct(pPct)}</td>
        <td class="pnl-sum-num">${fmtVariance(cV, pV, rowDir)}</td>
        <td class="pnl-sum-num">${fmtMoney(yV)}</td>
        <td class="pnl-sum-num pnl-sum-pct">${fmtPct(yPct)}</td>
        <td class="pnl-sum-num">${fmtVariance(cV, yV, rowDir)}</td>
      </tr>`;
    }).join('');

    const totalKey = sIdx === 0 ? 'income' : sIdx === 1 ? 'cogs' : 'labor';
    const cT = totals.current[totalKey];
    const pT = totals.prior ? totals.prior[totalKey] : null;
    const yT = totals.yoy ? totals.yoy[totalKey] : null;
    const subDir = section.subtotal.favorableDirection;

    // Subtotal % uses pctBase from the subtotal definition. For Sales,
    // there's no base; for COGS and Labor, base is TOTAL_INCOME.
    const cSubPct = computePct(cT, section.subtotal.pctBase, cur, totals.current);
    const pSubPct = pri    ? computePct(pT, section.subtotal.pctBase, pri, totals.prior) : null;
    const ySubPct = yoyData ? computePct(yT, section.subtotal.pctBase, yoyData, totals.yoy) : null;

    const subtotalHtml = `<tr class="pnl-sum-subtotal">
      <td class="pnl-sum-acct">${section.subtotal.label}</td>
      <td class="pnl-sum-num">${fmtMoney(cT)}</td>
      <td class="pnl-sum-num pnl-sum-pct">${fmtPct(cSubPct)}</td>
      <td class="pnl-sum-num">${fmtMoney(pT)}</td>
      <td class="pnl-sum-num pnl-sum-pct">${fmtPct(pSubPct)}</td>
      <td class="pnl-sum-num">${fmtVariance(cT, pT, subDir)}</td>
      <td class="pnl-sum-num">${fmtMoney(yT)}</td>
      <td class="pnl-sum-num pnl-sum-pct">${fmtPct(ySubPct)}</td>
      <td class="pnl-sum-num">${fmtVariance(cT, yT, subDir)}</td>
    </tr>`;

    return `<tbody class="pnl-sum-section">
      <tr class="pnl-sum-section-header"><td colspan="9">${section.title}</td></tr>
      ${rowsHtml}
      ${subtotalHtml}
    </tbody>`;
  }).join('');

  // Computed section (Gross Profit / Prime Cost)
  const computedHtml = COMPUTED.map((c) => {
    const cV = c.compute({ totals: totals.current });
    const pV = totals.prior ? c.compute({ totals: totals.prior }) : null;
    const yV = totals.yoy   ? c.compute({ totals: totals.yoy })   : null;
    const cPct = computePct(cV, c.pctBase, cur, totals.current);
    const pPct = pri    ? computePct(pV, c.pctBase, pri, totals.prior) : null;
    const yPct = yoyData ? computePct(yV, c.pctBase, yoyData, totals.yoy) : null;
    return `<tr class="pnl-sum-computed-row">
      <td class="pnl-sum-acct">${c.label}</td>
      <td class="pnl-sum-num">${fmtMoney(cV)}</td>
      <td class="pnl-sum-num pnl-sum-pct">${fmtPct(cPct)}</td>
      <td class="pnl-sum-num">${fmtMoney(pV)}</td>
      <td class="pnl-sum-num pnl-sum-pct">${fmtPct(pPct)}</td>
      <td class="pnl-sum-num">${fmtVariance(cV, pV, c.favorableDirection)}</td>
      <td class="pnl-sum-num">${fmtMoney(yV)}</td>
      <td class="pnl-sum-num pnl-sum-pct">${fmtPct(yPct)}</td>
      <td class="pnl-sum-num">${fmtVariance(cV, yV, c.favorableDirection)}</td>
    </tr>`;
  }).join('');

  const computedBlock = `<tbody class="pnl-sum-section">
    <tr class="pnl-sum-section-header"><td colspan="9">Profitability</td></tr>
    ${computedHtml}
  </tbody>`;

  const html = `
    <table class="pnl-summary-table">
      ${header}
      ${sectionHtml}
      ${computedBlock}
    </table>`;
  document.getElementById('pnl-summary-content').innerHTML = html;

  // Wire row clicks for drill-down. Subtotal and computed rows aren't
  // drillable (no clean category to expand on).
  document.querySelectorAll('.pnl-sum-drillable').forEach((tr) => {
    tr.addEventListener('click', () => {
      const category = tr.dataset.category;
      const label = tr.dataset.label;
      openDrillModal(category, label);
    });
  });
}

// ---------------------------------------------------------------------
// Drill-down modal — shows the account-level breakdown of a category
// across the same three time periods.
// ---------------------------------------------------------------------
function openDrillModal(category, label) {
  if (!activeData) return;
  const { rawByPeriodCategory, current, prior, yoy } = activeData;

  // Collect all account numbers seen across the three periods for this
  // category, so accounts that appeared in only one month still show up.
  const accountMap = {};  // account_number → { name, current, prior, yoy }
  const periodsToShow = [
    { key: 'current', period: current },
    { key: 'prior',   period: prior },
    { key: 'yoy',     period: yoy },
  ];
  for (const { key, period } of periodsToShow) {
    if (!period) continue;
    const rows = (rawByPeriodCategory[period] || {})[category] || [];
    for (const row of rows) {
      // Some accounts don't have a number (e.g. "Mixed Beverage Gross Receipts
      // Tax"); use the name as a fallback key.
      const id = row.account_number || `~${row.account_name}`;
      if (!accountMap[id]) accountMap[id] = { number: row.account_number, name: row.account_name, current: 0, prior: 0, yoy: 0 };
      accountMap[id][key] += row.amount;
    }
  }
  // Sort: accounts with numbers first (ascending), then unnumbered alphabetically.
  const sorted = Object.values(accountMap).sort((a, b) => {
    if (a.number && b.number) return a.number.localeCompare(b.number);
    if (a.number) return -1;
    if (b.number) return 1;
    return a.name.localeCompare(b.name);
  });

  if (sorted.length === 0) {
    alert(`No account-level detail found for ${label}.`);
    return;
  }

  // Build the modal
  const rowsHtml = sorted.map((acct) => {
    return `<tr>
      <td class="pnl-drill-num">${acct.number || '—'}</td>
      <td class="pnl-drill-name">${escapeHtml(acct.name)}</td>
      <td class="pnl-drill-amt">${fmtMoney(acct.current)}</td>
      <td class="pnl-drill-amt">${fmtMoney(acct.prior)}</td>
      <td class="pnl-drill-amt">${fmtMoney(acct.yoy)}</td>
    </tr>`;
  }).join('');

  // Sum row at bottom
  const sumC = sorted.reduce((a, r) => a + r.current, 0);
  const sumP = sorted.reduce((a, r) => a + r.prior, 0);
  const sumY = sorted.reduce((a, r) => a + r.yoy, 0);

  // Cleanup any stale modal
  const stale = document.getElementById('pnlDrillModal');
  if (stale) stale.remove();

  const html = `
    <div id="pnlDrillModal" class="pnl-modal-backdrop">
      <div class="pnl-modal" style="max-width:720px">
        <div class="pnl-modal-header">
          <div>
            <div class="pnl-modal-title">${escapeHtml(label)} — Detail</div>
            <div class="pnl-modal-sub">${sorted.length} account${sorted.length === 1 ? '' : 's'}</div>
          </div>
          <button class="icon-btn" id="pnlDrillClose" title="Close">✕</button>
        </div>
        <div class="pnl-modal-body">
          <table class="pnl-drill-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Account</th>
                <th class="pnl-drill-amt">${formatPeriodLabel(current)}</th>
                <th class="pnl-drill-amt">${formatPeriodLabel(prior)}</th>
                <th class="pnl-drill-amt">${formatPeriodLabel(yoy)}</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
              <tr class="pnl-drill-total">
                <td></td>
                <td><strong>Total</strong></td>
                <td class="pnl-drill-amt"><strong>${fmtMoney(sumC)}</strong></td>
                <td class="pnl-drill-amt"><strong>${fmtMoney(sumP)}</strong></td>
                <td class="pnl-drill-amt"><strong>${fmtMoney(sumY)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pnl-modal-footer">
          <button class="btn btn-ghost" id="pnlDrillCloseBtn">Close</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('pnlDrillClose').addEventListener('click', closeDrillModal);
  document.getElementById('pnlDrillCloseBtn').addEventListener('click', closeDrillModal);
  // Click outside to close
  document.getElementById('pnlDrillModal').addEventListener('click', (e) => {
    if (e.target.id === 'pnlDrillModal') closeDrillModal();
  });
}

function closeDrillModal() {
  const m = document.getElementById('pnlDrillModal');
  if (m) m.remove();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }
