// =====================================================================
// charts.js — render Phase 2 P&L charts on the Projections tab
//
// Architecture:
//   mountCharts({ clientId }) → fetches pnl_data, builds a series object,
//   then renders 6 charts into pre-existing canvas slots in the DOM.
//
//   The chart engine is intentionally a single module that owns the
//   Projections-tab UI from scratch. Reading from pnl_data only — never
//   parses xlsx files; that's pnl-parser.js's job.
//
// Six charts (per the agreed design):
//   1. Revenue trend     ($)
//   2. Sales mix         (stacked area, % of total)
//   3. Food cost %       (food_cogs / food_sales)
//   4. Beverage cost %   (liquor / beer / wine, three lines)
//   5. Labor %           ((all labor + taxes + benefits) / total sales)
//   6. Prime cost %      ((labor + cogs) / total sales)
//
// All cost % charts have target band shading via Chart.js annotation logic
// using a custom "fill between" plugin (built inline — no extra dep).
// =====================================================================
import { sb } from './config.js';

// Brand palette for category lines. Restaurant industry conventions:
// food=red, liquor=warm brown, beer=gold, wine=plum.
const COLORS = {
  food:        '#c0392b',
  liquor:      '#8e5a3a',
  beer:        '#d4a017',
  wine:        '#6b4584',
  na_bev:      '#2d8a8a',
  merchandise: '#5b7a99',
  other:       '#9ca3af',
  // Cost/labor accents — desaturated versions for charts where they're alone
  total:       '#1f3543',
  labor:       '#3f6f8c',
  prime:       '#1f3543',
  // Target band colors (translucent green)
  targetFill:  'rgba(34, 139, 84, 0.10)',
  targetLine:  'rgba(34, 139, 84, 0.45)',
};

// Target bands per category — used to shade healthy ranges on cost % charts.
// Source: standard restaurant industry benchmarks (Texas/full-service).
const TARGETS = {
  food_cost_pct:    { min: 28, max: 32, label: 'Target 28–32%' },
  liquor_cost_pct:  { min: 18, max: 22, label: 'Target 18–22%' },
  beer_cost_pct:    { min: 22, max: 26, label: 'Target 22–26%' },
  wine_cost_pct:    { min: 30, max: 40, label: 'Target 30–40%' },
  labor_pct:        { min: 25, max: 35, label: 'Target 25–35%' },
  prime_cost_pct:   { min: 50, max: 60, label: 'Target <60%' },
};

// Active Chart.js instances by canvas id — destroyed on remount to free
// memory and avoid the "canvas already in use" error.
const activeCharts = {};

export async function mountKPI({ clientId }) {
  // The KPI Dashboard tab houses these charts. Container is #kpiContent
  // (injected by index.html). We own everything inside it.
  const root = document.getElementById('kpiContent');
  if (!root) return;

  // Loading state
  root.innerHTML = `
    <section class="card">
      <h2 style="font-family:var(--font-display);font-style:italic;font-size:24px;margin:0 0 4px">Trends</h2>
      <p style="color:var(--text2);margin:0 0 18px;font-size:13px">Trailing 13 months from your P&amp;L data.</p>
      <div id="charts-loading" style="padding:40px;text-align:center;color:var(--text3)">Loading charts…</div>
      <div id="charts-grid" class="charts-grid" style="display:none"></div>
      <div id="charts-empty" style="display:none"></div>
    </section>`;

  let rows;
  try {
    // Supabase/PostgREST caps a single response at the project's max-rows
    // (1000 by default). The charts pull one row per account per month, so a
    // client with a year-plus of P&L easily exceeds 1000 rows. Without an
    // explicit order + pagination, the server returns only the first 1000
    // rows in insertion order — the OLDEST months — and silently drops the
    // rest, clipping the charts to (e.g.) Jan–Aug '25. Page through the full
    // result set, ordered by period, so every month reaches the charts
    // regardless of the server cap.
    rows = [];
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const res = await sb
        .from('pnl_data')
        .select('period, category, amount')
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
    document.getElementById('charts-loading').innerHTML =
      `<div style="color:var(--red)">Couldn't load chart data: ${e.message || e}</div>`;
    return;
  }

  document.getElementById('charts-loading').style.display = 'none';

  if (!rows.length) {
    document.getElementById('charts-empty').style.display = 'block';
    document.getElementById('charts-empty').innerHTML = `
      <div style="padding:48px 24px;text-align:center;color:var(--text2)">
        <div style="font-size:42px;margin-bottom:10px">📊</div>
        <h3 style="margin:0 0 6px;color:var(--text)">No P&amp;L data yet</h3>
        <p style="margin:0;font-size:13px">Upload a P&amp;L to the Financials tab and click <em>Parse P&amp;L</em> to populate these charts.</p>
      </div>`;
    return;
  }

  // Aggregate: { period: { category: total } }
  const byPeriod = {};
  for (const r of rows) {
    if (!byPeriod[r.period]) byPeriod[r.period] = {};
    byPeriod[r.period][r.category] = (byPeriod[r.period][r.category] || 0) + Number(r.amount);
  }
  // Sort ascending, then cap to the trailing 13 months so YoY comparisons line
  // up neatly (Apr 2026 alongside Apr 2025) without cramping the x-axis.
  const allMonths = Object.keys(byPeriod).sort();
  const months = allMonths.slice(-13);

  // Wait for Chart.js to be ready (it's loaded async via CDN in index.html)
  if (!window.Chart) {
    await waitForChartJs();
  }

  // Render the grid of canvases
  const grid = document.getElementById('charts-grid');
  grid.style.display = 'grid';
  grid.innerHTML = `
    ${chartCardHtml('chart-revenue',  'Revenue', 'Total sales over time')}
    ${chartCardHtml('chart-mix',      'Sales Mix', 'Share of revenue by category')}
    ${chartCardHtml('chart-food-cost','Food Cost %', 'Food COGS as % of food sales')}
    ${chartCardHtml('chart-bev-cost', 'Beverage Cost %', 'Liquor, beer, wine cost percentages')}
    ${chartCardHtml('chart-labor',    'Labor %', 'All labor + taxes + benefits as % of sales')}
    ${chartCardHtml('chart-prime',    'Prime Cost %', 'Labor + COGS as % of sales')}
  `;

  // Render each chart
  destroyAll();
  renderRevenue(months, byPeriod);
  renderSalesMix(months, byPeriod);
  renderFoodCost(months, byPeriod);
  renderBevCost(months, byPeriod);
  renderLabor(months, byPeriod);
  renderPrime(months, byPeriod);
}

export function unmountKPI() {
  destroyAll();
}

function destroyAll() {
  for (const id of Object.keys(activeCharts)) {
    try { activeCharts[id].destroy(); } catch {}
    delete activeCharts[id];
  }
}

function chartCardHtml(canvasId, title, sub) {
  return `
    <div class="chart-card">
      <div class="chart-title">${title}</div>
      <div class="chart-sub">${sub}</div>
      <div class="chart-canvas-wrap"><canvas id="${canvasId}"></canvas></div>
    </div>`;
}

// =====================================================================
// Helpers
// =====================================================================

function waitForChartJs() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.Chart) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

// Format a YYYY-MM period as a short label like "Apr '26" for x-axes.
function shortPeriodLabel(period) {
  const [y, m] = period.split('-');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${monthNames[parseInt(m, 10) - 1]} '${y.slice(2)}`;
}

// Sum a list of categories for a given period. Missing categories = 0.
function sumCategories(periodData, categories) {
  return categories.reduce((acc, cat) => acc + (periodData[cat] || 0), 0);
}

// Safe ratio that returns null when divisor is 0 — Chart.js will skip nulls
// in line charts which is the right behavior (don't draw a 0% point that
// would be misleading).
function ratio(numerator, denominator) {
  if (!denominator || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

// =====================================================================
// Chart.js "target band" plugin — draws a shaded horizontal band between
// two y-values across the full chart width. Implemented as a tiny inline
// plugin because Chart.js doesn't ship this out of the box and we don't
// want to add chartjs-plugin-annotation as another dep.
// =====================================================================
const targetBandPlugin = {
  id: 'targetBand',
  beforeDatasetsDraw(chart, args, opts) {
    if (!opts || !opts.bands) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    for (const band of opts.bands) {
      const yMin = scales.y.getPixelForValue(band.min);
      const yMax = scales.y.getPixelForValue(band.max);
      ctx.fillStyle = band.fillStyle || COLORS.targetFill;
      ctx.fillRect(chartArea.left, yMax, chartArea.right - chartArea.left, yMin - yMax);
      // Optional border lines at top & bottom of band
      ctx.strokeStyle = band.lineStyle || COLORS.targetLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(chartArea.left, yMin); ctx.lineTo(chartArea.right, yMin);
      ctx.moveTo(chartArea.left, yMax); ctx.lineTo(chartArea.right, yMax);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  },
};

// Common chart options factory — keeps styling consistent across all six.
function baseOptions({ yTitle = '', yIsPct = false, yIsMoney = false, targetBands = null } = {}) {
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label(ctx) {
            const v = ctx.parsed.y;
            if (v === null || v === undefined) return `${ctx.dataset.label}: —`;
            const formatted = yIsPct
              ? `${v.toFixed(1)}%`
              : yIsMoney
                ? `$${Math.round(v).toLocaleString()}`
                : v.toLocaleString();
            return `${ctx.dataset.label}: ${formatted}`;
          },
        },
      },
    },
    scales: {
      x: { ticks: { font: { size: 10 } }, grid: { display: false } },
      y: {
        title: { display: !!yTitle, text: yTitle, font: { size: 11 } },
        ticks: {
          font: { size: 10 },
          callback(value) {
            if (yIsPct) return `${value}%`;
            if (yIsMoney) return `$${(value / 1000).toFixed(0)}k`;
            return value;
          },
        },
        grid: { color: 'rgba(0,0,0,0.05)' },
      },
    },
  };
  if (targetBands) {
    opts.plugins.targetBand = { bands: targetBands };
  }
  return opts;
}

// =====================================================================
// Individual chart renderers
// =====================================================================

function renderRevenue(months, byPeriod) {
  const SALES_CATS = ['food_sales','liquor_sales','beer_sales','wine_sales','na_bev_sales','merchandise_sales','other_sales'];
  const data = months.map((p) => sumCategories(byPeriod[p], SALES_CATS) + (byPeriod[p].discounts || 0));
  const ctx = document.getElementById('chart-revenue').getContext('2d');
  activeCharts['chart-revenue'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months.map(shortPeriodLabel),
      datasets: [{
        label: 'Total Sales',
        data,
        borderColor: COLORS.total,
        backgroundColor: 'rgba(31,53,67,0.08)',
        fill: true,
        tension: 0.25,
        pointRadius: 3,
      }],
    },
    options: baseOptions({ yIsMoney: true }),
  });
}

function renderSalesMix(months, byPeriod) {
  const cats = [
    { key: 'food_sales',        label: 'Food',         color: COLORS.food },
    { key: 'liquor_sales',      label: 'Liquor',       color: COLORS.liquor },
    { key: 'beer_sales',        label: 'Beer',         color: COLORS.beer },
    { key: 'wine_sales',        label: 'Wine',         color: COLORS.wine },
    { key: 'na_bev_sales',      label: 'NA Bev',       color: COLORS.na_bev },
    { key: 'merchandise_sales', label: 'Merchandise',  color: COLORS.merchandise },
    { key: 'other_sales',       label: 'Other',        color: COLORS.other },
  ];
  // Filter to categories with at least one non-zero value across the dataset
  const active = cats.filter((c) => months.some((p) => (byPeriod[p][c.key] || 0) > 0));

  // Compute per-month totals (gross — exclude discounts so mix sums to 100%
  // of gross sales, which is how mix is typically discussed).
  const totals = months.map((p) => active.reduce((acc, c) => acc + (byPeriod[p][c.key] || 0), 0));

  const datasets = active.map((c) => ({
    label: c.label,
    data: months.map((p, i) => totals[i] > 0 ? ((byPeriod[p][c.key] || 0) / totals[i]) * 100 : 0),
    backgroundColor: c.color,
    borderColor: c.color,
    fill: true,
    tension: 0.2,
    pointRadius: 0,
  }));

  const ctx = document.getElementById('chart-mix').getContext('2d');
  activeCharts['chart-mix'] = new Chart(ctx, {
    type: 'line',
    data: { labels: months.map(shortPeriodLabel), datasets },
    options: {
      ...baseOptions({ yIsPct: true }),
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y: { stacked: true, min: 0, max: 100, ticks: { callback: (v) => `${v}%`, font: { size: 10 } } },
      },
    },
  });
}

function renderFoodCost(months, byPeriod) {
  const data = months.map((p) => ratio(byPeriod[p].food_cogs || 0, byPeriod[p].food_sales || 0));
  const ctx = document.getElementById('chart-food-cost').getContext('2d');
  activeCharts['chart-food-cost'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months.map(shortPeriodLabel),
      datasets: [{ label: 'Food Cost %', data, borderColor: COLORS.food, backgroundColor: 'rgba(192,57,43,0.08)', fill: true, tension: 0.25, pointRadius: 3, spanGaps: false }],
    },
    options: baseOptions({ yIsPct: true, targetBands: [TARGETS.food_cost_pct] }),
    plugins: [targetBandPlugin],
  });
}

function renderBevCost(months, byPeriod) {
  const series = [
    { label: 'Liquor', cogsKey: 'liquor_cogs', salesKey: 'liquor_sales', color: COLORS.liquor, target: TARGETS.liquor_cost_pct },
    { label: 'Beer',   cogsKey: 'beer_cogs',   salesKey: 'beer_sales',   color: COLORS.beer,   target: TARGETS.beer_cost_pct },
    { label: 'Wine',   cogsKey: 'wine_cogs',   salesKey: 'wine_sales',   color: COLORS.wine,   target: TARGETS.wine_cost_pct },
  ];
  // Filter to series with at least one valid datapoint
  const active = series.filter((s) => months.some((p) => byPeriod[p][s.salesKey] && byPeriod[p][s.cogsKey]));

  const datasets = active.map((s) => ({
    label: s.label,
    data: months.map((p) => ratio(byPeriod[p][s.cogsKey] || 0, byPeriod[p][s.salesKey] || 0)),
    borderColor: s.color,
    backgroundColor: 'transparent',
    tension: 0.25,
    pointRadius: 3,
    spanGaps: false,
  }));

  // With three target bands overlapping (e.g. liquor 18-22, beer 22-26, wine 30-40),
  // shading them all is visually messy. We omit target bands here and rely on
  // tooltips / the "Target" lines in the user's mental model. Industry standard.
  const ctx = document.getElementById('chart-bev-cost').getContext('2d');
  activeCharts['chart-bev-cost'] = new Chart(ctx, {
    type: 'line',
    data: { labels: months.map(shortPeriodLabel), datasets },
    options: baseOptions({ yIsPct: true }),
  });
}

function renderLabor(months, byPeriod) {
  // NOTE: labor_bonus is intentionally NOT in LABOR_CATS. Bonuses are
  // discretionary and lumpy by nature, so including them in the labor %
  // trend would create noise that doesn't reflect operational efficiency.
  // Same exclusion applies in renderPrime below.
  const LABOR_CATS = ['labor_boh','labor_foh','labor_management','labor_other','labor_benefits','payroll_taxes'];
  const SALES_CATS = ['food_sales','liquor_sales','beer_sales','wine_sales','na_bev_sales','merchandise_sales','other_sales'];
  const data = months.map((p) => {
    const sales = sumCategories(byPeriod[p], SALES_CATS) + (byPeriod[p].discounts || 0);
    const labor = sumCategories(byPeriod[p], LABOR_CATS);
    return ratio(labor, sales);
  });
  const ctx = document.getElementById('chart-labor').getContext('2d');
  activeCharts['chart-labor'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months.map(shortPeriodLabel),
      datasets: [{ label: 'Labor %', data, borderColor: COLORS.labor, backgroundColor: 'rgba(63,111,140,0.08)', fill: true, tension: 0.25, pointRadius: 3 }],
    },
    options: baseOptions({ yIsPct: true, targetBands: [TARGETS.labor_pct] }),
    plugins: [targetBandPlugin],
  });
}

function renderPrime(months, byPeriod) {
  const LABOR_CATS = ['labor_boh','labor_foh','labor_management','labor_other','labor_benefits','payroll_taxes'];
  const COGS_CATS  = ['food_cogs','liquor_cogs','beer_cogs','wine_cogs','na_bev_cogs','merchandise_cogs','other_cogs'];
  const SALES_CATS = ['food_sales','liquor_sales','beer_sales','wine_sales','na_bev_sales','merchandise_sales','other_sales'];
  const data = months.map((p) => {
    const sales = sumCategories(byPeriod[p], SALES_CATS) + (byPeriod[p].discounts || 0);
    const labor = sumCategories(byPeriod[p], LABOR_CATS);
    const cogs  = sumCategories(byPeriod[p], COGS_CATS);
    return ratio(labor + cogs, sales);
  });
  const ctx = document.getElementById('chart-prime').getContext('2d');
  activeCharts['chart-prime'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months.map(shortPeriodLabel),
      datasets: [{ label: 'Prime Cost %', data, borderColor: COLORS.prime, backgroundColor: 'rgba(31,53,67,0.08)', fill: true, tension: 0.25, pointRadius: 3 }],
    },
    options: baseOptions({ yIsPct: true, targetBands: [TARGETS.prime_cost_pct] }),
    plugins: [targetBandPlugin],
  });
}
