// =====================================================================
// compare.js — P&L Compare tab. Side-by-side P&L for several entities.
//
// Two views, one toggle:
//   - "Prime Sheet lines": mapped categories from pnl_data (the same rows the
//     Prime Sheet uses). Lines up cleanly across entities even when their
//     charts of accounts differ, and covers every backfilled month.
//   - "Full P&L": the published QuickBooks statement from pnl_reports, down to
//     Net Income, rows matched across entities by section path + account name
//     (account numbers stripped, since they differ between entities).
//
// Access: nothing here filters by permission itself. Both tables are read
// with the signed-in user's session, so RLS returns only the entities that
// user can see — the same policies that already let a client read its own
// Financials and Prime Sheet tabs. The picker only lists state.clients,
// which is itself RLS-filtered.
//
// Periods: an END month plus a range (single month, year to date, trailing
// 3, trailing 12). Ranges are summed dollars; every % is ratio-of-sums,
// never an average of monthly percentages.
// =====================================================================
import { sb } from './config.js';
import { pnlWithOwnRows } from './financials.js';

const SEL_KEY_PREFIX = 'bg_compare_sel_';
const MODE_KEY = 'bg_compare_mode';
const RANGE_KEY = 'bg_compare_range';
const AUTO_SELECT_ALL_MAX = 6;   // users with this many entities or fewer start with all selected

const RANGES = [
  { id: 'm1',  label: 'Month' },
  { id: 'ytd', label: 'Year to date' },
  { id: 't3',  label: 'Trailing 3 mo' },
  { id: 't12', label: 'Trailing 12 mo' },
];

// Labels for mapped categories, drawn from every Prime Sheet template. Any
// category not listed here still renders, with a tidied version of its key.
const CAT_LABELS = {
  food_sales: 'Food', liquor_sales: 'Liquor', beer_sales: 'Beer', wine_sales: 'Wine',
  na_bev_sales: 'NA Beverages', merchandise_sales: 'Merchandise', amusement_sales: 'Amusement / Mini Golf',
  events_sales: 'Events / Banquets', deli_sales: 'Deli & Bakery', cafe_sales: 'Cafe', grocery_sales: 'Grocery',
  produce_sales: 'Produce & Floral', cheese_sales: 'Cheese & Charcuterie', meat_sales: 'Meat & Seafood',
  bodycare_sales: 'Body Care & Health', housewares_sales: 'Housewares & Other', smoke_sales: 'Smoke (CBD/Tobacco)',
  other_sales: 'Other Sales', discounts: 'Discounts & Refunds',
  food_cogs: 'Food COGS', liquor_cogs: 'Liquor COGS', beer_cogs: 'Beer COGS', wine_cogs: 'Wine COGS',
  na_bev_cogs: 'NA Beverages COGS', merchandise_cogs: 'Merchandise COGS', deli_cogs: 'Deli & Bakery COGS',
  cafe_cogs: 'Cafe COGS', grocery_cogs: 'Grocery COGS', produce_cogs: 'Produce & Floral COGS',
  cheese_cogs: 'Cheese & Charcuterie COGS', meat_cogs: 'Meat & Seafood COGS', bodycare_cogs: 'Body Care COGS',
  housewares_cogs: 'Housewares COGS', smoke_cogs: 'Smoke COGS', other_cogs: 'Other COGS',
  labor_boh: 'BOH', labor_foh: 'FOH', labor_management: 'Management', labor_other: 'Other Labor',
  labor_bonus: 'Bonus', labor_benefits: 'Benefits', payroll_taxes: 'Payroll Taxes',
};
const CAT_ORDER = Object.keys(CAT_LABELS);

let state = {
  clients: [],          // [{id,name}] — RLS-filtered list from main.js
  currentClientId: null,
  userId: null,
  selected: [],         // client ids, kept in state.clients order
  mode: 'cat',          // 'cat' | 'stmt'
  range: 'm1',
  endMonth: null,       // Date, first of month
  pickerOpen: false,
  reqId: 0,
};
let docClickBound = false;

// =====================================================================
// PUBLIC API
// =====================================================================
export async function mountCompare({ clients, currentClientId, userId }) {
  const firstMount = state.userId !== userId;
  state.clients = clients || [];
  state.currentClientId = currentClientId;
  state.userId = userId;
  if (firstMount || !state.endMonth) {
    state.endMonth = addMonths(firstOfMonth(new Date()), -1);   // last completed month
    state.mode = lsGet(MODE_KEY) === 'stmt' ? 'stmt' : 'cat';
    const r = lsGet(RANGE_KEY);
    state.range = RANGES.some((x) => x.id === r) ? r : 'm1';
    state.selected = initialSelection();
  } else {
    // Keep the working selection, but drop anything no longer accessible.
    const ok = new Set(state.clients.map((c) => c.id));
    state.selected = orderIds(state.selected.filter((id) => ok.has(id)));
    if (!state.selected.length) state.selected = initialSelection();
  }
  injectStyles();
  renderShell();
  await loadAndRender();
}

export function unmountCompare() {
  state.pickerOpen = false;
  state.reqId++;   // any in-flight load drops its result
}

// =====================================================================
// SELECTION
// =====================================================================
function initialSelection() {
  const ok = new Set(state.clients.map((c) => c.id));
  let saved = null;
  try { saved = JSON.parse(lsGet(SEL_KEY_PREFIX + state.userId) || 'null'); } catch (_) { saved = null; }
  if (Array.isArray(saved)) {
    const valid = saved.filter((id) => ok.has(id));
    if (valid.length) return orderIds(valid);
  }
  if (state.clients.length <= AUTO_SELECT_ALL_MAX) return state.clients.map((c) => c.id);
  return state.currentClientId && ok.has(state.currentClientId) ? [state.currentClientId] : [];
}
function orderIds(ids) {
  const want = new Set(ids);
  return state.clients.filter((c) => want.has(c.id)).map((c) => c.id);
}
function saveSelection() { lsSet(SEL_KEY_PREFIX + state.userId, JSON.stringify(state.selected)); }
function clientName(id) { const c = state.clients.find((x) => x.id === id); return c ? c.name : '(unknown)'; }

// =====================================================================
// SHELL + CONTROLS
// =====================================================================
function renderShell() {
  const root = document.getElementById('tab-compare');
  if (!root) return;
  root.innerHTML = `
    <section class="card cmp-card">
      <div class="cmp-controls">
        <div class="cmp-seg" id="cmpMode" role="tablist" aria-label="View">
          <button type="button" data-mode="cat">Prime Sheet lines</button>
          <button type="button" data-mode="stmt">Full P&amp;L</button>
        </div>
        <div class="cmp-month">
          <button type="button" class="cmp-arrow" id="cmpPrev" aria-label="Previous month">&#8249;</button>
          <span id="cmpMonthLabel"></span>
          <button type="button" class="cmp-arrow" id="cmpNext" aria-label="Next month">&#8250;</button>
        </div>
        <select id="cmpRange" class="cmp-select" aria-label="Range">
          ${RANGES.map((r) => `<option value="${r.id}">${r.label}</option>`).join('')}
        </select>
      </div>
      <div class="cmp-entities">
        <div class="cmp-picker-wrap">
          <button type="button" class="cmp-pick-btn" id="cmpPickBtn">Entities <span id="cmpPickCount"></span> &#9662;</button>
          <div class="cmp-picker" id="cmpPicker" style="display:none"></div>
        </div>
        <div class="cmp-chips" id="cmpChips"></div>
      </div>
      <div id="cmpNote" class="cmp-note"></div>
      <div id="cmpBody"><div class="state-msg"><span class="spinner"></span> Loading…</div></div>
    </section>`;

  root.querySelectorAll('#cmpMode button').forEach((b) => b.addEventListener('click', () => {
    if (state.mode === b.dataset.mode) return;
    state.mode = b.dataset.mode; lsSet(MODE_KEY, state.mode); syncControls(); loadAndRender();
  }));
  root.querySelector('#cmpPrev').addEventListener('click', () => { state.endMonth = addMonths(state.endMonth, -1); syncControls(); loadAndRender(); });
  root.querySelector('#cmpNext').addEventListener('click', () => { state.endMonth = addMonths(state.endMonth, 1); syncControls(); loadAndRender(); });
  root.querySelector('#cmpRange').addEventListener('change', (e) => { state.range = e.target.value; lsSet(RANGE_KEY, state.range); syncControls(); loadAndRender(); });
  root.querySelector('#cmpPickBtn').addEventListener('click', (e) => { e.stopPropagation(); state.pickerOpen = !state.pickerOpen; renderPicker(); });
  root.querySelector('#cmpChips').addEventListener('click', (e) => {
    const x = e.target.closest('[data-rm]'); if (!x) return;
    state.selected = state.selected.filter((id) => id !== x.dataset.rm);
    saveSelection(); syncControls(); renderPicker(); loadAndRender();
  });
  if (!docClickBound) {
    docClickBound = true;
    document.addEventListener('click', (e) => {
      if (!state.pickerOpen) return;
      if (e.target.closest('.cmp-picker-wrap')) return;
      state.pickerOpen = false; renderPicker();
    });
  }
  syncControls();
  renderPicker();
}

function syncControls() {
  const root = document.getElementById('tab-compare'); if (!root) return;
  root.querySelectorAll('#cmpMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  const lbl = root.querySelector('#cmpMonthLabel');
  if (lbl) lbl.textContent = rangeLabel();
  const rs = root.querySelector('#cmpRange'); if (rs) rs.value = state.range;
  const cnt = root.querySelector('#cmpPickCount'); if (cnt) cnt.textContent = '(' + state.selected.length + ')';
  const chips = root.querySelector('#cmpChips');
  if (chips) {
    chips.innerHTML = state.selected.length
      ? state.selected.map((id) => `<span class="cmp-chip">${esc(clientName(id))}<button type="button" data-rm="${esc(id)}" aria-label="Remove">&times;</button></span>`).join('')
      : '<span class="cmp-muted">No entities selected — pick at least two to compare.</span>';
  }
}

function renderPicker() {
  const el = document.getElementById('cmpPicker'); if (!el) return;
  el.style.display = state.pickerOpen ? 'block' : 'none';
  if (!state.pickerOpen) return;
  const many = state.clients.length > 8;
  const prevQ = (el.querySelector('#cmpPickQ') || {}).value || '';
  const sel = new Set(state.selected);
  el.innerHTML = (many ? `<input type="text" id="cmpPickQ" class="cmp-pick-q" placeholder="Search entities…" value="${esc(prevQ)}" autocomplete="off">` : '')
    + '<div class="cmp-pick-actions"><button type="button" data-act="all">Select all</button><button type="button" data-act="none">Clear</button></div>'
    + '<div class="cmp-pick-list">' + state.clients.map((c) =>
      `<label class="cmp-pick-row" data-name="${esc(c.name.toLowerCase())}"><input type="checkbox" value="${esc(c.id)}"${sel.has(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('') + '</div>';
  const q = el.querySelector('#cmpPickQ');
  const filter = () => {
    const t = (q ? q.value : '').trim().toLowerCase();
    el.querySelectorAll('.cmp-pick-row').forEach((r) => { r.style.display = !t || r.dataset.name.includes(t) ? '' : 'none'; });
  };
  if (q) { q.addEventListener('input', filter); filter(); setTimeout(() => q.focus(), 0); }
  el.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
    const s = new Set(state.selected);
    if (cb.checked) s.add(cb.value); else s.delete(cb.value);
    state.selected = orderIds([...s]); saveSelection(); syncControls(); loadAndRender();
  }));
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'all') {
      // "Select all" respects the search box: it adds what's visible.
      const visible = [...el.querySelectorAll('.cmp-pick-row')].filter((r) => r.style.display !== 'none').map((r) => r.querySelector('input').value);
      state.selected = orderIds([...new Set([...state.selected, ...visible])]);
    } else state.selected = [];
    saveSelection(); syncControls(); renderPicker(); loadAndRender();
  }));
}

// =====================================================================
// PERIODS
// =====================================================================
function rangeKeys() {
  const end = state.endMonth;
  let start;
  if (state.range === 'ytd') start = new Date(end.getFullYear(), 0, 1);
  else if (state.range === 't3') start = addMonths(end, -2);
  else if (state.range === 't12') start = addMonths(end, -11);
  else start = end;
  const keys = [];
  for (let d = start; d <= end; d = addMonths(d, 1)) keys.push(monthKey(d));
  return keys;
}
function rangeLabel() {
  const keys = rangeKeys();
  if (keys.length === 1) return monthName(state.endMonth);
  return shortMonth(keys[0]) + ' – ' + shortMonth(keys[keys.length - 1]);
}

// =====================================================================
// LOAD
// =====================================================================
async function loadAndRender() {
  const body = document.getElementById('cmpBody'); if (!body) return;
  const note = document.getElementById('cmpNote'); if (note) note.innerHTML = '';
  const my = ++state.reqId;
  if (!state.selected.length) { body.innerHTML = '<div class="cmp-empty">Pick entities above to compare them side by side.</div>'; return; }
  body.innerHTML = '<div class="state-msg"><span class="spinner"></span> Loading…</div>';
  try {
    const html = state.mode === 'stmt' ? await buildStatementView() : await buildCategoryView();
    if (my !== state.reqId) return;
    body.innerHTML = html.table;
    if (note) note.innerHTML = html.note || '';
  } catch (e) {
    if (my !== state.reqId) return;
    body.innerHTML = `<div class="cmp-err">Couldn’t load: ${esc(e.message || e)} <button type="button" class="cmp-retry">Retry</button></div>`;
    const r = body.querySelector('.cmp-retry'); if (r) r.addEventListener('click', loadAndRender);
  }
}

// ---------------------------------------------------------------------
// View 1: Prime Sheet lines (pnl_data)
// ---------------------------------------------------------------------
async function buildCategoryView() {
  const keys = rangeKeys();
  const ids = state.selected;
  // Paginate: PostgREST caps each response at the project's max-rows.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; ) {
    const res = await sb.from('pnl_data')
      .select('client_id, period, category, amount')
      .in('client_id', ids)
      .gte('period', keys[0]).lte('period', keys[keys.length - 1])
      .not('category', 'is', null)
      // One row per client × period × account (× class), so this order is
      // stable across pages.
      .order('client_id').order('period').order('account_number').order('account_name').order('class').order('category')
      .range(from, from + PAGE - 1);
    if (res.error) throw res.error;
    const page = res.data || [];
    rows.push(...page);
    if (page.length < PAGE) break;
    from += page.length;
  }

  // byClient[id][category] = summed dollars; monthsSeen[id] = set of periods with any data
  const byClient = {}; const monthsSeen = {};
  ids.forEach((id) => { byClient[id] = {}; monthsSeen[id] = new Set(); });
  rows.forEach((r) => {
    if (!byClient[r.client_id]) return;
    byClient[r.client_id][r.category] = (byClient[r.client_id][r.category] || 0) + Number(r.amount || 0);
    monthsSeen[r.client_id].add(r.period);
  });

  // Group the categories present in ANY selected entity.
  const present = new Set();
  ids.forEach((id) => Object.entries(byClient[id]).forEach(([k, v]) => { if (Math.abs(v) >= 0.5) present.add(k); }));
  const sortCats = (arr) => arr.sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
  });
  const roleOf = (k) => (/_sales$/.test(k) || k === 'discounts') ? 'income'
    : /_cogs$/.test(k) ? 'cogs'
    : (/^labor_/.test(k) || k === 'payroll_taxes') ? 'labor' : 'other';
  const groups = { income: [], cogs: [], labor: [], other: [] };
  sortCats([...present]).forEach((k) => groups[roleOf(k)].push(k));

  const cols = ids.map((id) => ({ id, name: clientName(id), data: byClient[id] }));
  const combined = {};
  cols.forEach((c) => Object.entries(c.data).forEach(([k, v]) => { combined[k] = (combined[k] || 0) + v; }));
  const showCombined = cols.length > 1;
  const allCols = showCombined ? [...cols, { id: '__all', name: 'All selected', data: combined, combined: true }] : cols;

  const tot = (data, role) => groups[role].reduce((s, k) => s + (data[k] || 0), 0);
  allCols.forEach((c) => {
    c.t = { income: tot(c.data, 'income'), cogs: tot(c.data, 'cogs'), labor: tot(c.data, 'labor') };
  });

  const out = [];
  const lineRow = (label, getVal, getBase, cls) => out.push({ label, cls, cells: allCols.map((c) => {
    const v = getVal(c); const b = getBase ? getBase(c) : null;
    return { v, pct: (b && Math.abs(b) >= 0.5 && v != null) ? (v / b) * 100 : null };
  }) });
  const header = (label) => out.push({ label, cls: 'hdr', cells: null });
  const inc = (c) => c.t.income;

  if (groups.income.length) {
    header('Sales');
    groups.income.forEach((k) => lineRow(catLabel(k), (c) => c.data[k] || 0, inc, ''));
    lineRow('Total Income', (c) => c.t.income, null, 'tot');
  }
  if (groups.cogs.length) {
    header('Cost of Goods Sold');
    groups.cogs.forEach((k) => {
      const salesKey = k.replace(/_cogs$/, '_sales');
      lineRow(catLabel(k), (c) => c.data[k] || 0, (c) => c.data[salesKey] || 0, '');
    });
    lineRow('Total COGS', (c) => c.t.cogs, inc, 'tot');
    lineRow('Gross Profit', (c) => c.t.income - c.t.cogs, inc, 'tot');
  }
  if (groups.labor.length) {
    header('Labor');
    groups.labor.forEach((k) => lineRow(catLabel(k), (c) => c.data[k] || 0, inc, ''));
    lineRow('Total Labor', (c) => c.t.labor, inc, 'tot');
  }
  if (groups.cogs.length || groups.labor.length) lineRow('Prime Cost', (c) => c.t.cogs + c.t.labor, inc, 'key');
  if (groups.other.length) {
    header('Other mapped lines');
    groups.other.forEach((k) => lineRow(catLabel(k), (c) => c.data[k] || 0, inc, ''));
  }

  if (!out.length) {
    return { table: `<div class="cmp-empty">No P&amp;L data for ${esc(rangeLabel())} in the selected entities.</div>` };
  }

  // Coverage notes: an entity missing months in the range is summed on what it has.
  const notes = [];
  cols.forEach((c) => {
    const n = monthsSeen[c.id].size;
    if (n === 0) notes.push(`<b>${esc(c.name)}</b> has no data for this period.`);
    else if (n < keys.length) notes.push(`<b>${esc(c.name)}</b> has ${n} of ${keys.length} months.`);
  });
  const foot = 'COGS lines show % of their own sales line; everything else is % of Total Income. Ranges sum the dollars, so % are true ratios.';
  return { table: renderTable(allCols, out, 'Prime Sheet lines · ' + rangeLabel()) + `<div class="cmp-foot">${foot}</div>`, note: notes.join(' ') };
}

// ---------------------------------------------------------------------
// View 2: Full P&L (published pnl_reports statements)
// ---------------------------------------------------------------------
async function buildStatementView() {
  const keys = rangeKeys();
  const ids = state.selected;
  const endKey = keys[keys.length - 1];
  const res = await sb.from('pnl_reports')
    .select('client_id, statement, generated_at')
    .in('client_id', ids).eq('period', endKey).eq('published', true);
  if (res.error) throw res.error;
  const byId = {}; (res.data || []).forEach((r) => { byId[r.client_id] = r; });
  const periods = keys.map((k) => ({ key: k }));

  const cols = [];
  const notes = [];
  // A merged, ordered list of row keys; each entity contributes its rows.
  const merged = [];                 // [{ key, kind, label, indent }]
  const indexOf = new Map();         // key -> position in merged
  ids.forEach((id) => {
    const rep = byId[id];
    const col = { id, name: clientName(id), vals: {}, base: null, missing: !rep };
    cols.push(col);
    if (!rep) { notes.push(`<b>${esc(col.name)}</b> has no published P&amp;L for ${esc(monthName(state.endMonth))}.`); return; }
    const rows = pnlWithOwnRows(rep.statement || [], periods);
    // Which range months does this statement actually carry?
    const have = new Set();
    rows.forEach((r) => Object.keys(r.amounts || {}).forEach((k) => have.add(k)));
    const covered = keys.filter((k) => have.has(k)).length;
    if (covered < keys.length) notes.push(`<b>${esc(col.name)}</b>’s published statement covers ${covered} of ${keys.length} months in this range.`);

    const path = [];                 // open header keys, for disambiguating same-named lines
    let lastPos = -1;
    const seen = new Map();          // guard: identical key twice within one statement
    rows.forEach((r) => {
      const nl = normLabel(r.label);
      let key;
      if (r.kind === 'header') { key = path.join('>') + '>H:' + nl; }
      else if (r.kind === 'total') {
        const base = stripTotal(nl);
        if (base != null && path.length && path[path.length - 1].endsWith('H:' + base)) {
          key = path.join('>') + '>T';
          path.pop();
        } else key = path.join('>') + '>T:' + nl;
      } else key = path.join('>') + '>A:' + nl + (r.own ? ':own' : '');
      const dup = seen.get(key) || 0; seen.set(key, dup + 1);
      if (dup) key += '#' + dup;
      if (r.kind === 'header') path.push(key);

      if (!indexOf.has(key)) {
        merged.splice(lastPos + 1, 0, { key, kind: r.kind, label: displayLabel(r.label, r.kind), indent: r.indent || 0, own: !!r.own });
        // re-index everything after the insertion point
        for (let i = lastPos + 1; i < merged.length; i++) indexOf.set(merged[i].key, i);
      }
      lastPos = indexOf.get(key);
      if (r.kind === 'header') return;
      let sum = null;
      keys.forEach((k) => { const v = r.amounts ? r.amounts[k] : null; if (v != null) sum = (sum || 0) + Number(v); });
      col.vals[key] = sum;
      if (col.base == null && r.kind === 'total' && /^total (income|revenue|sales)$/.test(nl) && sum) col.base = sum;
    });
  });

  const live = cols.filter((c) => !c.missing);
  if (!live.length) {
    return { table: `<div class="cmp-empty">None of the selected entities has a published P&amp;L for ${esc(monthName(state.endMonth))}.</div>`, note: '' };
  }
  const showCombined = live.length > 1;
  let allCols = cols;
  if (showCombined) {
    const comb = { id: '__all', name: 'All selected', vals: {}, base: 0, combined: true };
    live.forEach((c) => {
      Object.entries(c.vals).forEach(([k, v]) => { if (v != null) comb.vals[k] = (comb.vals[k] || 0) + v; });
      comb.base += c.base || 0;
    });
    if (!comb.base) comb.base = null;
    allCols = [...cols, comb];
  }

  const out = merged.map((m) => {
    if (m.kind === 'header') return { label: m.label, cls: 'hdr', indent: m.indent, cells: null };
    const cls = m.kind === 'total' ? (/^(net income|net operating income|gross profit)$/i.test(m.label) ? 'key' : 'tot') : '';
    return {
      label: m.label, cls, indent: m.indent, own: m.own,
      cells: allCols.map((c) => {
        if (c.missing) return { v: null, pct: null, na: true };
        const v = c.vals[m.key];
        return { v: v == null ? null : v, pct: (v != null && c.base) ? (v / c.base) * 100 : null };
      }),
    };
  });
  const foot = 'Rows are matched by section and account name (account numbers are dropped because they differ between entities). A blank means that entity doesn’t carry the line. % is of each entity’s Total Income.';
  return { table: renderTable(allCols, out, 'Full P&L · ' + rangeLabel()) + `<div class="cmp-foot">${foot}</div>`, note: notes.join(' ') };
}

// =====================================================================
// RENDER
// =====================================================================
function renderTable(cols, rows, caption) {
  const head1 = '<tr><th class="cmp-lbl" rowspan="2">' + esc(caption) + '</th>'
    + cols.map((c) => `<th colspan="2" class="cmp-ent${c.combined ? ' cmp-comb' : ''}${c.missing ? ' cmp-miss' : ''}">${esc(c.name)}${c.missing ? '<div class="cmp-miss-tag">not published</div>' : ''}</th>`).join('') + '</tr>';
  const head2 = '<tr>' + cols.map((c) => `<th class="cmp-sub${c.combined ? ' cmp-comb' : ''}">$</th><th class="cmp-sub cmp-pcol${c.combined ? ' cmp-comb' : ''}">%</th>`).join('') + '</tr>';
  const body = rows.map((r) => {
    const pad = 10 + (r.indent || 0) * 14;
    if (!r.cells) return `<tr class="cmp-hdr"><td class="cmp-lbl" style="padding-left:${pad}px">${esc(r.label)}</td><td colspan="${cols.length * 2}"></td></tr>`;
    return `<tr class="${r.cls ? 'cmp-' + r.cls : ''}"><td class="cmp-lbl" style="padding-left:${pad}px">${esc(r.label)}</td>`
      + r.cells.map((cell, i) => {
        const comb = cols[i].combined ? ' cmp-comb' : '';
        if (cell.na) return `<td class="cmp-num cmp-na${comb}"></td><td class="cmp-pct cmp-na${comb}"></td>`;
        return `<td class="cmp-num${comb}">${fmtMoney(cell.v)}</td><td class="cmp-pct${comb}">${fmtPct(cell.pct)}</td>`;
      }).join('') + '</tr>';
  }).join('');
  return `<div class="cmp-scroll"><table class="cmp-table"><thead>${head1}${head2}</thead><tbody>${body}</tbody></table></div>`;
}

function injectStyles() {
  if (document.getElementById('cmpStyles')) return;
  const s = document.createElement('style');
  s.id = 'cmpStyles';
  s.textContent = `
  .cmp-card{padding:18px 18px 14px}
  .cmp-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
  .cmp-seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .cmp-seg button{border:0;background:var(--bg2);color:var(--text2);font:inherit;font-size:13px;font-weight:600;padding:7px 13px;cursor:pointer}
  .cmp-seg button+button{border-left:1px solid var(--border)}
  .cmp-seg button.on{background:var(--navy);color:#fff}
  .cmp-month{display:flex;align-items:center;gap:6px;font-weight:700}
  .cmp-month span{min-width:150px;text-align:center}
  .cmp-arrow{width:30px;height:30px;border:1px solid var(--border);background:var(--bg2);border-radius:7px;cursor:pointer;font-size:16px;line-height:1}
  .cmp-select{border:1px solid var(--border);background:var(--bg2);border-radius:7px;padding:6px 8px;font:inherit;font-size:13px;color:var(--text)}
  .cmp-entities{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:10px}
  .cmp-picker-wrap{position:relative}
  .cmp-pick-btn{border:1px solid var(--navy);background:var(--bg2);color:var(--navy);border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}
  .cmp-picker{position:absolute;z-index:30;top:calc(100% + 6px);left:0;width:300px;max-width:calc(100vw - 32px);background:var(--bg2);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 30px rgba(20,30,50,.15);padding:10px}
  .cmp-pick-q{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:7px;padding:7px 9px;font:inherit;font-size:13px;margin-bottom:8px}
  .cmp-pick-actions{display:flex;gap:10px;margin-bottom:6px}
  .cmp-pick-actions button{border:0;background:none;color:var(--accent);font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:0}
  .cmp-pick-list{max-height:300px;overflow:auto}
  .cmp-pick-row{display:flex;align-items:center;gap:8px;padding:5px 4px;font-size:13px;cursor:pointer;border-radius:6px}
  .cmp-pick-row:hover{background:var(--bg3)}
  .cmp-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:32px}
  .cmp-chip{display:inline-flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border);border-radius:999px;padding:3px 4px 3px 11px;font-size:12.5px;font-weight:600;color:var(--text)}
  .cmp-chip button{border:0;background:none;color:var(--text3);cursor:pointer;font-size:15px;line-height:1;padding:0 5px}
  .cmp-chip button:hover{color:var(--red)}
  .cmp-muted{font-size:12.5px;color:var(--text3)}
  .cmp-note{font-size:12.5px;color:#8a5a00;margin-bottom:8px}
  .cmp-note:empty{display:none}
  .cmp-scroll{overflow-x:auto;border:1px solid var(--border);border-radius:8px;max-width:100%}
  .cmp-table{border-collapse:separate;border-spacing:0;font-size:13px;min-width:100%;font-variant-numeric:tabular-nums}
  .cmp-table th,.cmp-table td{padding:5px 10px;white-space:nowrap;border-bottom:1px solid var(--border)}
  .cmp-table thead th{background:var(--bg3);font-size:12px;color:var(--text2);font-weight:700;position:sticky;top:0}
  .cmp-table .cmp-lbl{position:sticky;left:0;z-index:1;background:var(--bg2);text-align:left;min-width:190px;max-width:320px;overflow:hidden;text-overflow:ellipsis;border-right:1px solid var(--border)}
  .cmp-table thead .cmp-lbl{background:var(--bg3);z-index:2;color:var(--text3);font-weight:600;vertical-align:bottom}
  .cmp-ent{text-align:center;color:var(--navy)!important;border-left:1px solid var(--border)}
  .cmp-sub{text-align:right;font-size:10.5px!important;text-transform:uppercase;letter-spacing:.04em}
  .cmp-sub:not(.cmp-pcol){border-left:1px solid var(--border)}
  .cmp-num{text-align:right;border-left:1px solid var(--border)}
  .cmp-pct{text-align:right;color:var(--text3);font-size:12px}
  .cmp-comb{background:#fbf3ea}
  .cmp-table thead .cmp-comb{background:#f6e6d6}
  .cmp-miss{color:var(--text3)!important}
  .cmp-miss-tag{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--red)}
  .cmp-na{background:repeating-linear-gradient(135deg,transparent 0 6px,rgba(0,0,0,.025) 6px 12px)}
  .cmp-hdr td{font-weight:800;color:var(--navy);background:var(--bg2);padding-top:12px}
  .cmp-hdr .cmp-lbl{background:var(--bg2)}
  .cmp-tot td{font-weight:700}
  .cmp-tot td,.cmp-key td{border-top:1px solid var(--border2, #cfd4dc)}
  .cmp-key td{font-weight:800;color:var(--navy)}
  .cmp-key .cmp-lbl{background:#eef1f6}
  .cmp-key td:not(.cmp-lbl):not(.cmp-comb){background:#f5f7fa}
  .cmp-foot{font-size:11.5px;color:var(--text3);margin-top:8px;line-height:1.45}
  .cmp-empty{padding:28px 10px;text-align:center;color:var(--text2);font-size:13.5px}
  .cmp-err{color:var(--red);font-size:13px;padding:10px 0}
  .cmp-retry{margin-left:8px;border:1px solid var(--border);background:var(--bg2);border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit;font-size:12px}
  @media (max-width:640px){.cmp-month span{min-width:120px}.cmp-table .cmp-lbl{min-width:140px;max-width:170px}}
  `;
  document.head.appendChild(s);
}

// =====================================================================
// HELPERS
// =====================================================================
function normLabel(x) { return String(x || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^(total )?\d[\d.\-]*\s+/, '$1'); }
function stripTotal(nl) { const m = /^total (.+)$/.exec(nl); return m ? m[1] : null; }
function displayLabel(label, kind) {
  const s = String(label || '').trim();
  const m = /^(Total\s+)?\d[\d.\-]*\s+(.*)$/i.exec(s);
  return m ? (m[1] || '') + m[2] : s;
}
function catLabel(k) { return CAT_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d, k) { return new Date(d.getFullYear(), d.getMonth() + k, 1); }
function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function monthName(d) { return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function shortMonth(key) { const [y, m] = key.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }
function fmtMoney(v) {
  if (v == null || isNaN(v)) return '';
  const r = Math.round(v);
  if (r === 0) return '$0';
  const s = '$' + Math.abs(r).toLocaleString('en-US');
  return r < 0 ? '(' + s + ')' : s;
}
function fmtPct(p) { return p == null || !isFinite(p) ? '' : p.toFixed(1) + '%'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode etc. */ } }
