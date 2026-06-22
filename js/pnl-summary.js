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
// Per-client templates. A client's clients.kpi_template selects which one
// renders. Each section carries a `role` ('income' | 'cogs' | 'labor') so
// totals sum correctly regardless of how many/which rows a template shows.
// `restaurant` is the original layout, kept byte-for-byte; the 42 existing
// restaurant clients render exactly as before.

// Shared headline metric defs (the Quick-look picker cards).
const HM = {
  food:   { id: 'h_food',   label: 'Food Cost',     kind: 'line',  key: 'food_cogs', pctBase: 'food_sales', dir: 'down', noun: 'food COGS' },
  bev:    { id: 'h_bev',    label: 'Beverage Cost', kind: 'bev',   dir: 'down', noun: 'bev COGS (liq+beer+wine)' },
  labor:  { id: 'h_labor',  label: 'Labor',         kind: 'total', which: 'labor', pctBase: 'TOTAL_INCOME', dir: 'down', noun: 'labor' },
  prime:  { id: 'h_prime',  label: 'Prime Cost',    kind: 'prime', pctBase: 'TOTAL_INCOME', dir: 'down', noun: 'COGS + labor' },
  income: { id: 'h_income', label: 'Total Income',  kind: 'total', which: 'income', pctBase: null, dir: 'up', noun: 'total income' },
  comps:  { id: 'h_comps',  label: 'Comps %',       kind: 'comps', pctBase: null, dir: 'down', noun: 'comps & discounts' },
};

const RESTAURANT_TEMPLATE = {
  sections: [
    {
      title: 'Sales', role: 'income',
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
      title: 'Cost of Goods Sold', role: 'cogs',
      rows: [
        { key: 'food_cogs',          label: 'Food COGS',         pctBase: 'food_sales' },
        { key: 'liquor_cogs',        label: 'Liquor COGS',       pctBase: 'liquor_sales' },
        { key: 'beer_cogs',          label: 'Beer COGS',         pctBase: 'beer_sales' },
        { key: 'wine_cogs',          label: 'Wine COGS',         pctBase: 'wine_sales' },
        { key: 'na_bev_cogs',        label: 'NA Beverages COGS', pctBase: 'na_bev_sales' },
        { key: 'merchandise_cogs',   label: 'Merchandise COGS',  pctBase: 'merchandise_sales' },
        { key: 'other_cogs',         label: 'Other COGS',        pctBase: 'other_sales' },
      ],
      subtotal: { label: 'Total COGS', favorableDirection: 'down', pctBase: 'TOTAL_INCOME' },
    },
    {
      title: 'Labor', role: 'labor',
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
  ],
  computed: [
    { label: 'Gross Profit',  compute: (s) => s.totals.income - s.totals.cogs,   favorableDirection: 'up',   isPct: false, pctBase: 'TOTAL_INCOME' },
    { label: 'Prime Cost',    compute: (s) => s.totals.cogs + s.totals.labor,    favorableDirection: 'down', isPct: false, pctBase: 'TOTAL_INCOME' },
  ],
  headline: [HM.food, HM.bev, HM.labor, HM.prime, HM.income],
};

// Entertainment venue (e.g. mini-golf + bar/kitchen). Golf/events are
// pure-margin sales lines with no COGS, so cost %s are taken against their
// OWN sales base — never blended against the golf-inflated top line. Comps
// (incl. drink-ticket comps) surface as a headline; Prime Cost stays in the
// table but is demoted from the headline since it's meaningless here.
const ENTERTAINMENT_TEMPLATE = {
  sections: [
    {
      title: 'Sales', role: 'income',
      rows: [
        { key: 'amusement_sales',    label: 'Mini Golf',          pctBase: null },
        { key: 'food_sales',         label: 'Food',               pctBase: null },
        { key: 'liquor_sales',       label: 'Liquor',             pctBase: null },
        { key: 'beer_sales',         label: 'Beer',               pctBase: null },
        { key: 'wine_sales',         label: 'Wine',               pctBase: null },
        { key: 'na_bev_sales',       label: 'Soft Beverages',     pctBase: null },
        { key: 'events_sales',       label: 'Events / Banquets',  pctBase: null },
        { key: 'merchandise_sales',  label: 'Merchandise',        pctBase: null },
        { key: 'other_sales',        label: 'Other',              pctBase: null },
        { key: 'discounts',          label: 'Comps & Discounts',  pctBase: null },
      ],
      subtotal: { label: 'Total Income', favorableDirection: 'up', pctBase: null },
    },
    {
      title: 'Cost of Goods Sold', role: 'cogs',
      rows: [
        { key: 'food_cogs',          label: 'Food COGS',         pctBase: 'food_sales' },
        { key: 'liquor_cogs',        label: 'Liquor COGS',       pctBase: 'liquor_sales' },
        { key: 'beer_cogs',          label: 'Beer COGS',         pctBase: 'beer_sales' },
        { key: 'wine_cogs',          label: 'Wine COGS',         pctBase: 'wine_sales' },
        { key: 'merchandise_cogs',   label: 'Merchandise COGS',  pctBase: 'merchandise_sales' },
      ],
      subtotal: { label: 'Total COGS', favorableDirection: 'down', pctBase: 'TOTAL_INCOME' },
    },
    {
      title: 'Labor', role: 'labor',
      rows: [
        { key: 'labor_boh',          label: 'BOH',               pctBase: 'TOTAL_INCOME' },
        { key: 'labor_foh',          label: 'FOH',               pctBase: 'TOTAL_INCOME' },
        { key: 'labor_management',   label: 'Management',        pctBase: 'TOTAL_INCOME' },
        { key: 'labor_other',        label: 'Other (incl. course ops)', pctBase: 'TOTAL_INCOME' },
        { key: 'labor_benefits',     label: 'Benefits',          pctBase: 'TOTAL_INCOME' },
        { key: 'payroll_taxes',      label: 'Payroll Taxes',     pctBase: 'TOTAL_INCOME' },
      ],
      subtotal: { label: 'Total Labor', favorableDirection: 'down', pctBase: 'TOTAL_INCOME' },
    },
  ],
  computed: [
    { label: 'Gross Profit',  compute: (s) => s.totals.income - s.totals.cogs,   favorableDirection: 'up',   isPct: false, pctBase: 'TOTAL_INCOME' },
    { label: 'Prime Cost',    compute: (s) => s.totals.cogs + s.totals.labor,    favorableDirection: 'down', isPct: false, pctBase: 'TOTAL_INCOME' },
  ],
  headline: [HM.food, HM.bev, HM.labor, HM.comps, HM.income],
};

const TEMPLATES = {
  restaurant:    RESTAURANT_TEMPLATE,
  entertainment: ENTERTAINMENT_TEMPLATE,
};

// Active template for the client currently mounted (set in mountPnlSummary).
let activeTemplate = RESTAURANT_TEMPLATE;

// State for the active drill-down (current client + raw rows kept here so
// the modal can re-query account-level detail without another DB call).
let activeData = null;
let selectedMetric = 'h_food';

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------
export async function mountPnlSummary({ clientId }) {
  const root = document.getElementById('tab-pnl-summary');
  if (!root) return;

  // Pick the per-client KPI template (default 'restaurant'). Failure to read
  // it must never break the sheet, so any error falls back to restaurant.
  try {
    const { data: cli } = await sb.from('clients').select('kpi_template').eq('id', clientId).single();
    activeTemplate = TEMPLATES[cli && cli.kpi_template] || RESTAURANT_TEMPLATE;
  } catch (_) {
    activeTemplate = RESTAURANT_TEMPLATE;
  }
  // Ensure the Quick-look picker starts on a metric this template actually has.
  if (!activeTemplate.headline.some((m) => m.id === selectedMetric)) {
    selectedMetric = activeTemplate.headline[0].id;
  }

  root.innerHTML = `
    <section class="card">
      <h2 style="font-family:var(--font-display);font-style:italic;font-size:24px;margin:0 0 4px">Prime Sheet</h2>
      <p style="color:var(--text2);margin:0 0 18px;font-size:13px">Current month vs prior month and same month last year. Click any row for account-level detail.</p>
      <div id="pnl-metric-picker"></div>
      <div id="pnl-summary-content" style="padding:24px;text-align:center;color:var(--text3)">Loading…</div>
    </section>`;

  let rows;
  try {
    // Supabase/PostgREST caps a single response at the project's max-rows
    // (1000 by default). With one row per account per month, a client with a
    // year-plus of P&L exceeds 1000 rows, so an unpaginated fetch returns only
    // the OLDEST ~1000 rows. That made `current` (periods[last]) resolve to a
    // stale month (e.g. Aug '25 instead of the true latest), silently showing
    // the wrong "current month". Page through the full set, ordered by period.
    rows = [];
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const res = await sb
        .from('pnl_data')
        .select('period, category, amount, account_number, account_name')
        .eq('client_id', clientId)
        .not('category', 'is', null)
        .order('period', { ascending: true })
        .range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      const page = res.data || [];
      rows.push(...page);
      if (page.length === 0) break;     // exhausted
      from += page.length;
      if (page.length < PAGE) break;    // last (partial) page
    }
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
  for (const section of activeTemplate.sections) {
    for (const r of section.rows) t[section.role] += (data[r.key] || 0);
  }
  return t;
}

// ---------------------------------------------------------------------
// Metric picker — trailing 1 / 3 / 12 month view of a single metric.
// Renders above the full table on all screen sizes. Each window is the
// sum of the last N months aggregated into one synthetic period, then run
// through the SAME sectionTotals/computePct the table uses, so the numbers
// tie out exactly. Percentages are ratio-of-summed-dollars across the
// window (never an average of monthly percentages).
// ---------------------------------------------------------------------
function buildMetricList() {
  const headline = activeTemplate.headline;
  const lines = [];
  activeTemplate.sections.forEach((section) => {
    const dir = section.title === 'Sales' ? 'up' : 'down';
    section.rows.forEach((row) => {
      lines.push({ id: 'k_' + row.key, group: section.title, label: row.label,
        kind: 'line', key: row.key, pctBase: row.pctBase, dir, noun: row.label });
    });
  });
  const totalsRows = [
    { id: 't_income', group: 'Totals', label: 'Total Income', kind: 'total', which: 'income', pctBase: null, dir: 'up', noun: 'total income' },
    { id: 't_cogs',   group: 'Totals', label: 'Total COGS',   kind: 'total', which: 'cogs', pctBase: 'TOTAL_INCOME', dir: 'down', noun: 'COGS' },
    { id: 't_labor',  group: 'Totals', label: 'Total Labor',  kind: 'total', which: 'labor', pctBase: 'TOTAL_INCOME', dir: 'down', noun: 'labor' },
    { id: 't_gross',  group: 'Totals', label: 'Gross Profit', kind: 'gross', pctBase: 'TOTAL_INCOME', dir: 'up', noun: 'income − COGS' },
    { id: 't_prime',  group: 'Totals', label: 'Prime Cost',   kind: 'prime', pctBase: 'TOTAL_INCOME', dir: 'down', noun: 'COGS + labor' },
  ];
  return { headline, lines, totalsRows };
}

function findMetric(id) {
  const { headline, lines, totalsRows } = buildMetricList();
  const all = headline.concat(lines, totalsRows);
  return all.find((m) => m.id === id) || headline[0];
}

// Sum a slice of period keys into one synthetic data dict + section totals.
function aggregateWindow(byPeriod, periodSlice) {
  const data = {};
  periodSlice.forEach((p) => {
    const pd = byPeriod[p] || {};
    Object.keys(pd).forEach((cat) => { data[cat] = (data[cat] || 0) + pd[cat]; });
  });
  return { data, totals: sectionTotals(data), months: periodSlice.length };
}

// { value, pct } for a metric over an aggregated window.
function metricValue(metric, win) {
  const { data, totals } = win;
  switch (metric.kind) {
    case 'line': {
      const value = data[metric.key] || 0;
      return { value, pct: computePct(value, metric.pctBase, data, totals) };
    }
    case 'bev': {
      const value = (data.liquor_cogs || 0) + (data.beer_cogs || 0) + (data.wine_cogs || 0);
      const base  = (data.liquor_sales || 0) + (data.beer_sales || 0) + (data.wine_sales || 0);
      return { value, pct: base ? (value / base) * 100 : null };
    }
    case 'total': {
      const value = totals[metric.which] || 0;
      return { value, pct: computePct(value, metric.pctBase, data, totals) };
    }
    case 'prime': {
      const value = (totals.cogs || 0) + (totals.labor || 0);
      return { value, pct: computePct(value, 'TOTAL_INCOME', data, totals) };
    }
    case 'gross': {
      const value = (totals.income || 0) - (totals.cogs || 0);
      return { value, pct: computePct(value, 'TOTAL_INCOME', data, totals) };
    }
    case 'comps': {
      // discounts are stored negative; comps % = |discounts| / gross sales,
      // where gross = net income with the discounts added back in.
      const disc = data.discounts || 0;
      const value = Math.abs(disc);
      const gross = (totals.income || 0) - disc;
      return { value, pct: gross ? (value / gross) * 100 : null };
    }
    default: return { value: 0, pct: null };
  }
}

function renderMetricPicker() {
  const host = document.getElementById('pnl-metric-picker');
  if (!host || !activeData) return;
  const { headline, lines, totalsRows } = buildMetricList();
  const opt = (m) => `<option value="${m.id}"${m.id === selectedMetric ? ' selected' : ''}>${escapeHtml(m.label)}</option>`;
  const byGroup = {};
  lines.forEach((m) => { (byGroup[m.group] = byGroup[m.group] || []).push(m); });
  const lineGroups = Object.keys(byGroup)
    .map((g) => `<optgroup label="${escapeAttr(g)}">${byGroup[g].map(opt).join('')}</optgroup>`)
    .join('');
  host.innerHTML = `
    <div class="pnl-mp">
      <div class="pnl-mp-bar">
        <label for="pnl-metric-select" class="pnl-mp-label">Quick look</label>
        <select id="pnl-metric-select" class="pnl-mp-select">
          <optgroup label="Headline">${headline.map(opt).join('')}</optgroup>
          ${lineGroups}
          <optgroup label="Totals">${totalsRows.map(opt).join('')}</optgroup>
        </select>
      </div>
      <div class="pnl-mp-windows" id="pnl-windows"></div>
    </div>`;
  document.getElementById('pnl-metric-select').addEventListener('change', (e) => {
    selectedMetric = e.target.value;
    renderWindows();
  });
  renderWindows();
}

function renderWindows() {
  const host = document.getElementById('pnl-windows');
  if (!host || !activeData) return;
  const { byPeriod } = activeData;
  const periods = Object.keys(byPeriod).sort();
  const metric = findMetric(selectedMetric);
  const specs = [
    { n: 1,  label: 'Last month' },
    { n: 3,  label: 'Last quarter' },
    { n: 12, label: 'Last year' },
  ];
  host.innerHTML = specs.map((spec) => {
    const cur = aggregateWindow(byPeriod, periods.slice(-spec.n));
    const priorSlice = periods.length >= spec.n * 2 ? periods.slice(-spec.n * 2, -spec.n) : [];
    const prior = priorSlice.length ? aggregateWindow(byPeriod, priorSlice) : null;
    const mv = metricValue(metric, cur);
    const pv = prior ? metricValue(metric, prior) : null;

    const isPct = mv.pct !== null && mv.pct !== undefined && !isNaN(mv.pct);
    // A percentage metric whose dollars roll up to $0 means the underlying
    // lines aren't booked for this client (e.g. a place that lumps bar COGS
    // into food, so liquor/beer/wine COGS are empty). Show "not recorded"
    // rather than a misleading 0.0%.
    const noData = isPct && Math.round(mv.value) === 0;
    const big = noData
      ? '—'
      : (isPct ? `${mv.pct.toFixed(1)}%` : fmtMoney(mv.value));
    const sub = noData
      ? `not recorded · ${cur.months} mo`
      : (isPct
          ? `${fmtMoney(mv.value)} ${metric.noun} · ${cur.months} mo`
          : `${metric.noun} · ${cur.months} mo`);

    let chip = '';
    if (pv && !noData) {
      let favorable = false, txt = '';
      if (isPct && pv.pct !== null && pv.pct !== undefined && !isNaN(pv.pct)) {
        const d = mv.pct - pv.pct;
        if (Math.abs(d) >= 0.05) {
          favorable = (metric.dir === 'up' && d > 0) || (metric.dir === 'down' && d < 0);
          txt = `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts`;
        }
      } else if (!isPct && pv.value) {
        const d = ((mv.value - pv.value) / Math.abs(pv.value)) * 100;
        if (Math.abs(d) >= 0.05) {
          favorable = (metric.dir === 'up' && d > 0) || (metric.dir === 'down' && d < 0);
          txt = `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%`;
        }
      }
      if (txt) {
        const color = favorable ? '#2e7d4f' : '#c0392b';
        const arrow = txt.indexOf('−') === 0 ? '↓' : '↑';
        chip = `<span class="pnl-mp-chip" style="color:${color}">${arrow} ${txt}</span>`;
      }
    }
    return `
      <div class="pnl-mp-card">
        <div class="pnl-mp-card-top">
          <span class="pnl-mp-win">${spec.label}</span>
          ${chip}
        </div>
        <div class="pnl-mp-big">${big}</div>
        <div class="pnl-mp-sub">${sub}</div>
      </div>`;
  }).join('');
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

  const sectionHtml = activeTemplate.sections.map((section) => {
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

    const totalKey = section.role;
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
  const computedHtml = activeTemplate.computed.map((c) => {
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

  renderMetricPicker();
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
