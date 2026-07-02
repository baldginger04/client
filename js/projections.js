// js/projections.js
// Projections tab — team side has two sub-views:
//   • Enter sales — week-anchored (Mon–Sun). Three input paths (covers/day,
//     covers/week, revenue/week) all resolve into DAILY projection_sales rows.
//   • Setup — the projection profile + effective-dated monthly cost goals.
// Clients get a placeholder until the pace-to-goal view lands in a later slice.

import { sb } from './config.js';
import { mountReconcile } from './reconcile.js';

const PANE = 'tab-projections';
const CATS = [
  { key: 'food',     label: 'Food' },
  { key: 'lbw',      label: 'Liquor · Beer · Wine' },
  { key: 'supplies', label: 'Supplies & Smallwares' },
];
const METHODS = [
  { key: 'covers_daily',   title: 'Covers by day',   desc: 'Guest counts per day. Most precise.' },
  { key: 'covers_weekly',  title: 'Covers by week',  desc: 'One guest count for the week.' },
  { key: 'revenue_weekly', title: 'Revenue by week', desc: 'Enter food & LBW dollars directly.' },
];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let ctx = null;   // { clientId, isTeam, userId }
let store = null; // { profile, goals, week (Monday Date), sub }

/* ---------- date + format helpers ---------- */
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mondayOf(d) { const x = new Date(d); const off = (x.getDay() + 6) % 7; x.setDate(x.getDate() - off); x.setHours(0, 0, 0, 0); return x; }
function weekDates(mon) { return Array.from({ length: 7 }, (_, i) => addDays(mon, i)); }
function rangeLabel(mon) {
  const m = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${m(mon)} – ${m(addDays(mon, 6))}`;
}
function weekdayRange(mon) {
  const e = addDays(mon, 6);
  const fmt = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  let label = `${fmt(mon)} – ${fmt(e)}`;
  if (e.getFullYear() !== new Date().getFullYear()) label += `, ${e.getFullYear()}`;
  return label;
}
function firstOfMonthISO(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }
function firstOfMonthDate(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function lastOfMonthDate(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function addMonths(d, k) { return new Date(d.getFullYear(), d.getMonth() + k, 1); }
function monthName(d) { return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function upcomingMonday() { return addDays(mondayOf(new Date()), 7); }
function relativeWeek(mon) {
  const w = Math.round((mon.getTime() - mondayOf(new Date()).getTime()) / (7 * 86400000));
  if (w === 0) return 'This week';
  if (w === 1) return 'Next week';
  if (w === -1) return 'Last week';
  return w > 0 ? `In ${w} weeks` : `${-w} weeks ago`;
}
function monthLabel(d = new Date()) { return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function num(v) { const x = parseFloat(v); return isFinite(x) ? x : 0; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- mount ---------- */
export async function mountProjections({ clientId, isTeam, userId }) {
  ctx = { clientId, isTeam: !!isTeam, userId };
  const pane = document.getElementById(PANE);
  if (!pane) return;

  pane.innerHTML = pjStyles() + `<div class="pj-wrap"><div class="pj-loading">Loading…</div></div>`;
  try {
    const [p, g] = await Promise.all([
      sb.from('projection_profiles').select('*').eq('client_id', clientId).maybeSingle(),
      sb.from('projection_goals').select('category,effective_from,goal_pct').eq('client_id', clientId),
    ]);
    if (p.error) throw p.error;
    if (g.error) throw g.error;
    const defaultSub = ctx.isTeam ? (p.data ? 'log' : 'setup') : 'log';
    store = { profile: p.data || null, goals: g.data || [], week: upcomingMonday(), month: firstOfMonthDate(), editing: null, editingPath: null, pendingImage: null, sub: defaultSub };
  } catch (e) {
    pane.innerHTML = pjStyles() + `<div class="pj-wrap"><div class="pj-err">Couldn't load: ${esc(e.message)}</div></div>`;
    return;
  }
  renderShell(pane);
}

export function unmountProjections() { ctx = null; store = null; }

/* ---------- shell + sub-nav ---------- */
function renderShell(pane) {
  const tabs = ctx.isTeam
    ? [['log', 'Receiving log'], ['sales', 'Enter sales'], ['reconcile', 'Month-end review'], ['setup', 'Setup']]
    : [['log', 'Receiving log']];
  const nav = tabs.map(([k, l]) => `<button data-sub="${k}" class="${store.sub === k ? 'on' : ''}">${l}</button>`).join('');
  pane.innerHTML = pjStyles() + `
  <div class="pj-wrap">
    <div class="pj-subnav">${nav}</div>
    <div id="pjContent"></div>
  </div>`;
  pane.querySelectorAll('.pj-subnav button').forEach((b) =>
    b.addEventListener('click', () => {
      store.sub = b.dataset.sub;
      pane.querySelectorAll('.pj-subnav button').forEach((x) => x.classList.toggle('on', x === b));
      renderActive();
    }));
  renderActive();
}

function renderActive() {
  const el = document.getElementById('pjContent');
  if (!el) return;
  if (store.sub === 'setup') renderSetup(el);
  else if (store.sub === 'sales') renderSales(el);
  else if (store.sub === 'reconcile') mountReconcile({ container: el, clientId: ctx.clientId, userId: ctx.userId });
  else renderLog(el);
}

function goSub(sub) {
  store.sub = sub;
  const pane = document.getElementById(PANE);
  pane.querySelectorAll('.pj-subnav button').forEach((x) => x.classList.toggle('on', x.dataset.sub === sub));
  renderActive();
}

/* ===================================================================
   SALES ENTRY (week-anchored)
   =================================================================== */
async function renderSales(el) {
  const prof = store.profile;
  if (!prof) {
    el.innerHTML = `<div class="pj-notice">This client isn't set up yet.
      <button class="pj-link" id="pjGoSetup">Open Setup</button> to choose a sales method and goals first.</div>`;
    el.querySelector('#pjGoSetup').addEventListener('click', () => goSub('setup'));
    return;
  }

  const method = prof.method;
  const coverMethod = method === 'covers_daily' || method === 'covers_weekly';
  const needsBits = coverMethod && (prof.avg_check == null || prof.food_mix_pct == null);
  const dates = weekDates(store.week);

  const rel = relativeWeek(store.week);
  const tone = rel === 'This week' ? 'now' : (store.week.getTime() < mondayOf(new Date()).getTime() ? 'past' : 'future');
  el.innerHTML = `
    <div class="pj-shead">
      <div class="pj-title">Sales projection</div>
      <div class="pj-sub">Forecast the week you're operating — receiving targets pace against these numbers.</div>
    </div>
    <div class="pj-weeknav">
      <button class="pj-wbtn" id="pjPrev">‹</button>
      <div class="pj-wlabel"><span class="pj-wrel ${tone}">${rel}</span><span class="pj-wrange">${weekdayRange(store.week)}</span></div>
      <button class="pj-wbtn" id="pjNext">›</button>
      <button class="pj-today" id="pjThis">This week</button>
    </div>
    <div id="pjSalesBody"><div class="pj-loading">Loading week…</div></div>`;
  el.querySelector('#pjPrev').addEventListener('click', () => { store.week = addDays(store.week, -7); renderSales(el); });
  el.querySelector('#pjNext').addEventListener('click', () => { store.week = addDays(store.week, 7); renderSales(el); });
  el.querySelector('#pjThis').addEventListener('click', () => { store.week = mondayOf(new Date()); renderSales(el); });

  if (needsBits) {
    el.querySelector('#pjSalesBody').innerHTML = `<div class="pj-notice">This method needs an <b>average check</b> and a <b>food/LBW split</b>.
      Set them in <button class="pj-link" id="pjGoSetup2">Setup</button> and come back.</div>`;
    el.querySelector('#pjGoSetup2').addEventListener('click', () => goSub('setup'));
    return;
  }

  let rows = [];
  try {
    const r = await sb.from('projection_sales').select('sales_date,covers,food_revenue,lbw_revenue')
      .eq('client_id', ctx.clientId).gte('sales_date', ymd(dates[0])).lte('sales_date', ymd(dates[6]));
    if (r.error) throw r.error;
    rows = r.data || [];
  } catch (e) {
    el.querySelector('#pjSalesBody').innerHTML = `<div class="pj-err">Couldn't load week: ${esc(e.message)}</div>`;
    return;
  }
  const byDate = {}; rows.forEach((r) => { byDate[r.sales_date] = r; });

  let arows = [];
  try {
    const ra = await sb.from('projection_actuals').select('sales_date,food_revenue,lbw_revenue')
      .eq('client_id', ctx.clientId).gte('sales_date', ymd(dates[0])).lte('sales_date', ymd(dates[6]));
    if (ra.error) throw ra.error;
    arows = ra.data || [];
  } catch (e) { arows = []; }
  const byDateA = {}; arows.forEach((r) => { byDateA[r.sales_date] = r; });
  const projF = dates.reduce((s, d) => s + num(byDate[ymd(d)]?.food_revenue), 0);
  const projL = dates.reduce((s, d) => s + num(byDate[ymd(d)]?.lbw_revenue), 0);

  const body = el.querySelector('#pjSalesBody');
  let formHtml;
  if (method === 'revenue_weekly') formHtml = revenueWeeklyForm(dates, byDate, prof);
  else if (method === 'covers_weekly') formHtml = coversWeeklyForm(dates, byDate, prof);
  else formHtml = coversDailyForm(dates, byDate, prof);
  body.innerHTML = formHtml + actualsCard(dates, byDateA, prof, projF, projL);
  wireSales(el, method, dates, prof);
  wireActuals(el, dates, prof, projF, projL);
}

function actualsCard(dates, byDateA, prof, projF, projL) {
  const lbw = tracksLbw(prof);
  const aF = dates.reduce((s, d) => s + num(byDateA[ymd(d)]?.food_revenue), 0);
  const aL = dates.reduce((s, d) => s + num(byDateA[ymd(d)]?.lbw_revenue), 0);
  return `
  <div class="pj-actuals">
    <div class="pj-ahead">Actual sales <span>enter once the week has closed</span></div>
    <div class="pj-arow">
      <div class="pj-bigin"><label>Actual food · week</label>
        <div class="pj-money big"><span>$</span><input type="number" min="0" step="1" id="pjAFood" value="${aF ? Math.round(aF) : ''}"></div>
        <div class="pj-aproj">Projected ${money(projF)}</div></div>
      ${lbw ? `<div class="pj-bigin"><label>Actual LBW · week</label>
        <div class="pj-money big"><span>$</span><input type="number" min="0" step="1" id="pjALbw" value="${aL ? Math.round(aL) : ''}"></div>
        <div class="pj-aproj">Projected ${money(projL)}</div></div>` : ''}
    </div>
    <div class="pj-avar" id="pjAVar"></div>
    <div class="pj-save"><button class="pj-btn" id="pjSaveActual">Save actuals</button>
      <span class="pj-note" id="pjActualMsg"></span></div>
  </div>`;
}

function wireActuals(el, dates, prof, projF, projL) {
  const lbw = tracksLbw(prof);
  const varEl = el.querySelector('#pjAVar');
  function compute() {
    const aF = num(el.querySelector('#pjAFood')?.value);
    const aL = lbw ? num(el.querySelector('#pjALbw')?.value) : 0;
    const a = aF + aL, p = projF + projL;
    if (!a) { varEl.innerHTML = ''; return; }
    const d = a - p, pct = p ? (d / p * 100) : 0, ahead = d >= 0;
    varEl.innerHTML = `Actual <b>${money(a)}</b> vs projected ${money(p)} — <span class="${ahead ? 'up' : 'down'}">${ahead ? '+' : '−'}${money(Math.abs(d))}${p ? ` (${ahead ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)` : ''}</span>`;
  }
  ['#pjAFood', '#pjALbw'].forEach((s) => { const i = el.querySelector(s); if (i) i.addEventListener('input', compute); });
  compute();
  el.querySelector('#pjSaveActual').addEventListener('click', () => saveActuals(el, dates, prof));
}

async function saveActuals(el, dates, prof) {
  const btn = el.querySelector('#pjSaveActual');
  const msg = el.querySelector('#pjActualMsg');
  const setMsg = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? 'var(--red)' : 'var(--green)'; } };
  const lbw = tracksLbw(prof);
  const aF = num(el.querySelector('#pjAFood')?.value);
  const aL = lbw ? num(el.querySelector('#pjALbw')?.value) : 0;
  const out = dates.map((d) => ({ client_id: ctx.clientId, sales_date: ymd(d), food_revenue: aF / 7, lbw_revenue: lbw ? aL / 7 : 0, covers: null, entered_by: ctx.userId, entered_at: new Date().toISOString() }));
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…'; setMsg('', false);
  try {
    const r = await sb.from('projection_actuals').upsert(out, { onConflict: 'client_id,sales_date' });
    if (r.error) throw r.error;
    setMsg('Saved.', false);
  } catch (e) { setMsg('Error: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

function tracksLbw(prof) { return (prof.categories || []).includes('lbw'); }

function revenueWeeklyForm(dates, byDate, prof) {
  const foodW = dates.reduce((s, d) => s + num(byDate[ymd(d)]?.food_revenue), 0);
  const lbwW = dates.reduce((s, d) => s + num(byDate[ymd(d)]?.lbw_revenue), 0);
  const lbw = tracksLbw(prof);
  return `
    <div class="pj-bigrow">
      <div class="pj-bigin"><label>Food revenue · week</label>
        <div class="pj-money big"><span>$</span><input type="number" min="0" step="1" id="pjFoodW" value="${foodW ? Math.round(foodW) : ''}"></div></div>
      ${lbw ? `<div class="pj-bigin"><label>LBW revenue · week</label>
        <div class="pj-money big"><span>$</span><input type="number" min="0" step="1" id="pjLbwW" value="${lbwW ? Math.round(lbwW) : ''}"></div></div>` : ''}
    </div>
    ${salesSummary()}${saveBar()}`;
}
function coversWeeklyForm(dates, byDate, prof) {
  const coversW = Math.round(dates.reduce((s, d) => s + num(byDate[ymd(d)]?.covers), 0));
  return `
    <div class="pj-bigrow">
      <div class="pj-bigin"><label>Covers · week</label>
        <div class="pj-money big"><input type="number" min="0" step="1" id="pjCoversW" value="${coversW || ''}" style="width:120px"><span>guests</span></div></div>
      <div class="pj-context">× ${money(prof.avg_check)} avg check · ${Math.round(prof.food_mix_pct * 100)}% food</div>
    </div>
    ${salesSummary()}${saveBar()}`;
}
function coversDailyForm(dates, byDate, prof) {
  const days = dates.map((d, i) => {
    const c = byDate[ymd(d)]?.covers;
    return `<div class="pj-day">
      <div class="pj-dlabel">${DOW[i]}<span>${d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span></div>
      <div class="pj-money"><input type="number" min="0" step="1" class="pjCoverDay" data-i="${i}" value="${c != null && c !== '' ? Math.round(c) : ''}" placeholder="0"><span>covers</span></div>
      <div class="pj-drev" data-rev="${i}">—</div></div>`;
  }).join('');
  return `
    <div class="pj-context" style="margin-bottom:10px">× ${money(prof.avg_check)} avg check · ${Math.round(prof.food_mix_pct * 100)}% food</div>
    <div class="pj-days">${days}</div>
    ${salesSummary()}${saveBar()}`;
}
function salesSummary() {
  return `<div class="pj-sum">
    <div><span>Weekly revenue</span><b id="pjSumRev">—</b></div>
    <div><span>Food</span><b id="pjSumFood">—</b></div>
    <div><span>LBW</span><b id="pjSumLbw">—</b></div></div>`;
}
function saveBar() {
  return `<div class="pj-save"><button class="pj-btn" id="pjSaveSales">Save week</button>
    <span class="pj-note" id="pjSalesMsg"></span></div>`;
}

function wireSales(el, method, dates, prof) {
  const mix = prof.food_mix_pct, avg = prof.avg_check, lbw = tracksLbw(prof);
  function setSummary(rev, food, lbwv) {
    el.querySelector('#pjSumRev').textContent = money(rev);
    el.querySelector('#pjSumFood').textContent = money(food);
    el.querySelector('#pjSumLbw').textContent = lbw ? money(lbwv) : 'n/a';
  }
  function compute() {
    if (method === 'revenue_weekly') {
      const f = num(el.querySelector('#pjFoodW')?.value);
      const l = lbw ? num(el.querySelector('#pjLbwW')?.value) : 0;
      setSummary(f + l, f, l); return;
    }
    let rev = 0;
    if (method === 'covers_weekly') {
      rev = num(el.querySelector('#pjCoversW')?.value) * avg;
    } else {
      el.querySelectorAll('.pjCoverDay').forEach((inp) => {
        const c = num(inp.value); const r = c * avg; rev += r;
        const cell = el.querySelector(`[data-rev="${inp.dataset.i}"]`);
        if (cell) cell.textContent = c ? money(r) : '—';
      });
    }
    setSummary(rev, rev * mix, rev * (1 - mix));
  }
  el.querySelectorAll('input[type=number]').forEach((i) => i.addEventListener('input', compute));
  compute();
  el.querySelector('#pjSaveSales').addEventListener('click', () => saveSales(el, method, dates, prof));
}

async function saveSales(el, method, dates, prof) {
  const btn = el.querySelector('#pjSaveSales'); const msg = el.querySelector('#pjSalesMsg');
  const setMsg = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? 'var(--red)' : 'var(--green)'; } };
  const mix = prof.food_mix_pct, avg = prof.avg_check, lbw = tracksLbw(prof);

  const out = dates.map((d) => ({ client_id: ctx.clientId, sales_date: ymd(d), covers: null, food_revenue: 0, lbw_revenue: 0, source_method: method, entered_by: ctx.userId, entered_at: new Date().toISOString() }));
  if (method === 'revenue_weekly') {
    const foodW = num(el.querySelector('#pjFoodW')?.value);
    const lbwW = lbw ? num(el.querySelector('#pjLbwW')?.value) : 0;
    out.forEach((r) => { r.food_revenue = foodW / 7; r.lbw_revenue = lbwW / 7; });
  } else if (method === 'covers_weekly') {
    const c = num(el.querySelector('#pjCoversW')?.value); const revW = c * avg;
    out.forEach((r) => { r.covers = c / 7; r.food_revenue = (revW * mix) / 7; r.lbw_revenue = (revW * (1 - mix)) / 7; });
  } else {
    el.querySelectorAll('.pjCoverDay').forEach((inp) => {
      const i = +inp.dataset.i; const c = num(inp.value); const rev = c * avg;
      out[i].covers = c; out[i].food_revenue = rev * mix; out[i].lbw_revenue = rev * (1 - mix);
    });
  }
  if (!lbw) out.forEach((r) => { r.lbw_revenue = 0; });

  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…'; setMsg('', false);
  try {
    const r = await sb.from('projection_sales').upsert(out, { onConflict: 'client_id,sales_date' });
    if (r.error) throw r.error;
    setMsg('Saved.', false);
  } catch (e) { setMsg('Error: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

/* ===================================================================
   RECEIVING LOG (client + team) — month-anchored line entry, with a
   "snap a receipt" path that extracts fields via the receipt-extract fn.
   =================================================================== */
async function renderLog(el) {
  const cats = (store.profile && store.profile.categories) || ['food', 'lbw', 'supplies'];
  const m = store.month;
  el.innerHTML = `
    <div class="pj-weeknav">
      <button class="pj-wbtn" id="pjMPrev">‹</button>
      <div class="pj-wlabel">${monthName(m)}<span>Receiving log</span></div>
      <button class="pj-wbtn" id="pjMNext">›</button>
      <button class="pj-today" id="pjMThis">This month</button>
    </div>
    <div id="pjLogTotals"></div>
    ${logForm(cats)}
    <div id="pjLogList"><div class="pj-loading">Loading…</div></div>`;
  el.querySelector('#pjMPrev').addEventListener('click', () => { store.month = addMonths(store.month, -1); store.editing = null; renderLog(el); });
  el.querySelector('#pjMNext').addEventListener('click', () => { store.month = addMonths(store.month, 1); store.editing = null; renderLog(el); });
  el.querySelector('#pjMThis').addEventListener('click', () => { store.month = firstOfMonthDate(); store.editing = null; renderLog(el); });
  wireLog(el, cats);
  await loadEntries(el, cats);
}

function logForm(cats) {
  const today = ymd(new Date());
  const opts = CATS.filter((c) => cats.includes(c.key)).map((c) => `<option value="${c.key}">${c.label}</option>`).join('');
  return `
  <div class="pj-logform" id="pjLogForm">
    <div class="pj-lf-row">
      <input type="date" id="lfDate" class="pj-lin" value="${today}">
      <select id="lfCat" class="pj-lin">${opts}</select>
      <input type="text" id="lfVendor" class="pj-lin" placeholder="Vendor" style="flex:1;min-width:120px">
      <input type="text" id="lfInv" class="pj-lin" placeholder="Invoice #" style="width:110px">
      <div class="pj-money"><span>$</span><input type="number" id="lfAmt" min="0" step="0.01" placeholder="0.00" style="width:90px"></div>
    </div>
    <div class="pj-lf-actions">
      <button class="pj-snap" id="lfSnap">📷 Snap a receipt</button>
      <input type="file" id="lfPhoto" accept="image/*" capture="environment" style="display:none">
      <span class="pj-snapmsg" id="lfSnapMsg"></span>
      <span class="pj-attach" id="lfAttach" style="display:none"></span>
      <span style="flex:1"></span>
      <button class="pj-ghost" id="lfCancel" style="display:none">Cancel</button>
      <button class="pj-btn" id="lfSave">Add entry</button>
    </div>
  </div>`;
}

function wireLog(el, cats) {
  el.querySelector('#lfSnap').addEventListener('click', () => el.querySelector('#lfPhoto').click());
  el.querySelector('#lfPhoto').addEventListener('change', () => handleSnap(el));
  el.querySelector('#lfSave').addEventListener('click', () => saveEntry(el, cats));
  el.querySelector('#lfCancel').addEventListener('click', () => { store.editing = null; resetForm(el); });
}

function resetForm(el) {
  el.querySelector('#lfVendor').value = '';
  el.querySelector('#lfInv').value = '';
  el.querySelector('#lfAmt').value = '';
  el.querySelector('#lfDate').value = ymd(new Date());
  el.querySelector('#lfSave').textContent = 'Add entry';
  el.querySelector('#lfCancel').style.display = 'none';
  const m = el.querySelector('#lfSnapMsg'); if (m) m.textContent = '';
  store.pendingImage = null; store.editingPath = null;
  refreshAttach(el);
}

function startEdit(el, row) {
  if (!row) return;
  store.editing = row.id;
  el.querySelector('#lfDate').value = row.receiving_date;
  el.querySelector('#lfCat').value = row.category;
  el.querySelector('#lfVendor').value = row.vendor || '';
  el.querySelector('#lfInv').value = row.invoice_number || '';
  el.querySelector('#lfAmt').value = row.amount;
  el.querySelector('#lfSave').textContent = 'Update entry';
  el.querySelector('#lfCancel').style.display = '';
  store.pendingImage = null;
  store.editingPath = row.receipt_path || null;
  refreshAttach(el);
  el.querySelector('#pjLogForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Downscale + re-encode to JPEG so iPhone HEIC and huge photos both work and
// the payload stays small.
function compressImage(file, maxDim = 1600, q = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      canvas.toBlob((blob) => { URL.revokeObjectURL(url); resolve({ dataUrl, blob }); }, 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

async function handleSnap(el) {
  const input = el.querySelector('#lfPhoto');
  const file = input.files && input.files[0];
  if (!file) return;
  const msg = el.querySelector('#lfSnapMsg');
  const setM = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? 'var(--red)' : 'var(--text3)'; } };
  setM('Reading receipt…');
  try {
    const { dataUrl, blob } = await compressImage(file);
    store.pendingImage = blob || null;
    refreshAttach(el);
    const { data, error } = await sb.functions.invoke('receipt-extract', { body: { image: dataUrl, mime: 'image/jpeg' } });
    if (error || !data || !data.ok) throw new Error((data && (data.message || data.error)) || (error && error.message) || 'could not read');
    if (data.vendor) el.querySelector('#lfVendor').value = data.vendor;
    if (data.invoice_number) el.querySelector('#lfInv').value = data.invoice_number;
    if (data.amount) el.querySelector('#lfAmt').value = data.amount;
    if (data.date) el.querySelector('#lfDate').value = data.date;
    if (data.category && el.querySelector(`#lfCat option[value="${data.category}"]`)) el.querySelector('#lfCat').value = data.category;
    setM('Got it — check the fields and hit Add.');
  } catch (e) {
    setM('Couldn’t read that one — enter it by hand. (' + e.message + ')', true);
  } finally {
    input.value = '';
  }
}

function refreshAttach(el) {
  const a = el.querySelector('#lfAttach'); if (!a) return;
  if (store.pendingImage) {
    a.style.display = ''; a.innerHTML = `🧾 New photo attached · <button class="pj-link" id="lfRmPhoto">remove</button>`;
    a.querySelector('#lfRmPhoto').addEventListener('click', () => { store.pendingImage = null; refreshAttach(el); });
  } else if (store.editing && store.editingPath) {
    a.style.display = ''; a.innerHTML = `🧾 Receipt on file · <button class="pj-link" id="lfViewPhoto">view</button>`;
    a.querySelector('#lfViewPhoto').addEventListener('click', () => viewReceipt(store.editingPath));
  } else { a.style.display = 'none'; a.innerHTML = ''; }
}

async function uploadReceipt(blob) {
  if (!blob) throw new Error('no image');
  const path = `${ctx.clientId}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('receipts').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return path;
}

async function viewReceipt(path) {
  if (!path) return;
  try {
    const { data, error } = await sb.storage.from('receipts').createSignedUrl(path, 120);
    if (error) throw error;
    openLightbox(data.signedUrl);
  } catch (e) { alert('Could not open receipt: ' + e.message); }
}

function openLightbox(url) {
  const prev = document.getElementById('pjLightbox'); if (prev) prev.remove();
  const ov = document.createElement('div'); ov.id = 'pjLightbox'; ov.className = 'pj-lightbox';
  ov.innerHTML = `<div class="pj-lb-inner"><img src="${url}" alt="receipt"><button class="pj-lb-close" title="Close">✕</button></div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.classList.contains('pj-lb-close')) ov.remove(); });
  document.body.appendChild(ov);
}

async function loadEntries(el, cats) {
  const list = el.querySelector('#pjLogList');
  const totals = el.querySelector('#pjLogTotals');
  const from = ymd(store.month), to = ymd(lastOfMonthDate(store.month));
  let rows = [];
  try {
    const r = await sb.from('receiving_log')
      .select('id,receiving_date,category,vendor,invoice_number,amount,source,receipt_path')
      .eq('client_id', ctx.clientId).gte('receiving_date', from).lte('receiving_date', to)
      .order('receiving_date', { ascending: false }).order('id', { ascending: false });
    if (r.error) throw r.error;
    rows = r.data || [];
  } catch (e) {
    list.innerHTML = `<div class="pj-err">Couldn't load entries: ${esc(e.message)}</div>`;
    return;
  }

  const sum = {}; cats.forEach((c) => { sum[c] = 0; });
  let total = 0;
  rows.forEach((r) => { if (sum[r.category] != null) sum[r.category] += num(r.amount); total += num(r.amount); });
  totals.innerHTML = `<div class="pj-totals">
    ${CATS.filter((c) => cats.includes(c.key)).map((c) => `<div class="pj-tcard"><span>${c.label}</span><b>${money(sum[c.key])}</b></div>`).join('')}
    <div class="pj-tcard total"><span>Total logged</span><b>${money(total)}</b></div></div>`;

  if (!rows.length) {
    list.innerHTML = `<div class="pj-lempty">No entries yet for ${monthName(store.month)}. Add your first above — or snap a receipt.</div>`;
    return;
  }
  const catLabel = (k) => (CATS.find((c) => c.key === k) || {}).label || k;
  list.innerHTML = `<div class="pj-ltable">` + rows.map((r) => `
    <div class="pj-lrow">
      <div class="pj-ldate">${new Date(r.receiving_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
      <div class="pj-lcat cat-${r.category}">${catLabel(r.category)}</div>
      <div class="pj-lvendor">${esc(r.vendor || '—')}${r.invoice_number ? `<span>#${esc(r.invoice_number)}</span>` : ''}</div>
      <div class="pj-lamt">${money(r.amount)}</div>
      <div class="pj-lact">${r.receipt_path ? `<button data-view="${r.id}" title="View receipt">🧾</button>` : ''}<button data-edit="${r.id}" title="Edit">\u270e</button><button data-del="${r.id}" title="Delete">\u2715</button></div>
    </div>`).join('') + `</div>`;

  list.querySelectorAll('[data-del]').forEach((b) => { const row = rows.find((x) => String(x.id) === b.dataset.del); b.addEventListener('click', () => deleteEntry(el, row, cats)); });
  list.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => startEdit(el, rows.find((x) => String(x.id) === b.dataset.edit))));
  list.querySelectorAll('[data-view]').forEach((b) => { const row = rows.find((x) => String(x.id) === b.dataset.view); b.addEventListener('click', () => viewReceipt(row.receipt_path)); });
}

async function saveEntry(el, cats) {
  const btn = el.querySelector('#lfSave');
  const setSnap = (t, bad) => { const m = el.querySelector('#lfSnapMsg'); if (m) { m.textContent = t; m.style.color = bad ? 'var(--red)' : 'var(--green)'; } };
  const date = el.querySelector('#lfDate').value;
  const category = el.querySelector('#lfCat').value;
  const vendor = el.querySelector('#lfVendor').value.trim();
  const invoice_number = el.querySelector('#lfInv').value.trim() || null;
  const amount = num(el.querySelector('#lfAmt').value);
  if (!date) { setSnap('Pick a date.', true); return; }
  if (!(amount > 0)) { setSnap('Enter an amount.', true); return; }

  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…';
  try {
    let receipt_path = store.editing ? store.editingPath : null;
    let oldPath = null;
    if (store.pendingImage) {
      const newPath = await uploadReceipt(store.pendingImage);
      if (store.editing && store.editingPath) oldPath = store.editingPath;
      receipt_path = newPath;
    }
    if (store.editing) {
      const r = await sb.from('receiving_log').update({ receiving_date: date, category, vendor: vendor || null, invoice_number, amount, receipt_path }).eq('id', store.editing);
      if (r.error) throw r.error;
    } else {
      const r = await sb.from('receiving_log').insert({ client_id: ctx.clientId, receiving_date: date, category, vendor: vendor || null, invoice_number, amount, source: 'manual', entered_by: ctx.userId, receipt_path });
      if (r.error) throw r.error;
    }
    if (oldPath) { try { await sb.storage.from('receipts').remove([oldPath]); } catch (_) {} }
    store.editing = null; resetForm(el); setSnap('', false);
    await loadEntries(el, cats);
  } catch (e) {
    setSnap('Error: ' + e.message, true);
    btn.disabled = false; btn.textContent = orig;
  }
}

async function deleteEntry(el, row, cats) {
  if (!row) return;
  if (!confirm('Delete this entry?')) return;
  try {
    const r = await sb.from('receiving_log').delete().eq('id', row.id);
    if (r.error) throw r.error;
    if (row.receipt_path) { try { await sb.storage.from('receipts').remove([row.receipt_path]); } catch (_) {} }
    if (String(store.editing) === String(row.id)) { store.editing = null; resetForm(el); }
    await loadEntries(el, cats);
  } catch (e) { alert('Could not delete: ' + e.message); }
}

/* ===================================================================
   SETUP (profile + effective-dated goals)
   =================================================================== */
function currentGoals() {
  const month = firstOfMonthISO();
  const out = {};
  for (const cat of CATS.map((c) => c.key)) {
    const rows = (store.goals || []).filter((g) => g.category === cat && g.effective_from <= month)
      .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
    if (rows.length) out[cat] = rows[0].goal_pct;
  }
  return out;
}

function renderSetup(el) {
  const profile = store.profile;
  const goalsByCat = currentGoals();
  const method = profile?.method || 'covers_daily';
  const avg = profile?.avg_check ?? '';
  const mix = profile?.food_mix_pct != null ? Math.round(profile.food_mix_pct * 100) : '';
  const cats = profile?.categories || ['food', 'lbw', 'supplies'];
  const revenueOnly = method === 'revenue_weekly';

  const methodCards = METHODS.map((m) => `
    <div class="pj-method ${m.key === method ? 'on' : ''}" data-method="${m.key}">
      <div class="pj-mt">${m.title}</div><div class="pj-md">${m.desc}</div></div>`).join('');
  const catToggles = CATS.map((c) => `
    <label class="pj-cat ${cats.includes(c.key) ? 'on' : ''}">
      <input type="checkbox" data-cat="${c.key}" ${cats.includes(c.key) ? 'checked' : ''}> ${c.label}</label>`).join('');
  const goalInputs = CATS.map((c) => `
    <div class="pj-goal" data-goalwrap="${c.key}" ${cats.includes(c.key) ? '' : 'style="display:none"'}>
      <div class="pj-gk">${c.label}</div>
      <div class="pj-gv"><input type="number" step="0.1" min="0" data-goal="${c.key}"
        value="${goalsByCat[c.key] != null ? +(goalsByCat[c.key] * 100).toFixed(2) : ''}"><span>%</span></div></div>`).join('');

  el.innerHTML = `
    <div class="pj-head">
      <div class="pj-title">Projection setup</div>
      <div class="pj-sub">How sales come in and the monthly cost goals. Change anytime — new settings only affect future months.</div>
    </div>
    <div class="pj-panel">
      <div class="pj-field"><div class="pj-flabel">How sales are entered</div>
        <div class="pj-fhelp">Pick whichever fits this client.</div>
        <div class="pj-methods">${methodCards}</div></div>
      <div class="pj-field" data-avgwrap ${revenueOnly ? 'style="display:none"' : ''}>
        <div class="pj-flabel">Average check</div>
        <div class="pj-fhelp">Turns covers into dollars. From Toast once connected — set by hand for now.</div>
        <div class="pj-row"><div class="pj-money"><span>$</span><input type="number" step="0.01" min="0" id="pjAvg" value="${avg}"></div>
          <div class="pj-src"><span class="on">Manual</span><span class="dis">Toast — soon</span></div></div></div>
      <div class="pj-field" data-mixwrap ${revenueOnly ? 'style="display:none"' : ''}>
        <div class="pj-flabel">Food vs LBW split</div>
        <div class="pj-fhelp">Splits a blended check into food and bar dollars. Auto-pull from the P&amp;L is coming — set it for now.</div>
        <div class="pj-row"><div class="pj-money"><input type="number" step="1" min="0" max="100" id="pjMix" value="${mix}" style="width:70px"><span>% food</span></div>
          <div class="pj-mixnote" id="pjMixNote"></div></div></div>
      <div class="pj-field"><div class="pj-flabel">Categories tracked</div>
        <div class="pj-fhelp">A food-only client can track just food — the other cards won't show for them.</div>
        <div class="pj-cats">${catToggles}</div></div>
      <div class="pj-field"><div class="pj-flabel">Monthly cost goals <span class="pj-tag">effective ${monthLabel()}</span></div>
        <div class="pj-fhelp">The targets the team paces against. Tighten them as the client improves — past months keep their goals.</div>
        <div class="pj-goals">${goalInputs}</div></div>
      <div class="pj-save"><button class="pj-btn" id="pjSave">Save settings</button>
        <span class="pj-note" id="pjMsg">Set once, change anytime — new settings only affect future months.</span></div>
    </div>`;
  wireSetup(el, method);
}

function wireSetup(el, method) {
  let current = method;
  el.querySelectorAll('.pj-method').forEach((m) => m.addEventListener('click', () => {
    el.querySelectorAll('.pj-method').forEach((x) => x.classList.remove('on'));
    m.classList.add('on'); current = m.dataset.method;
    const rev = current === 'revenue_weekly';
    const a = el.querySelector('[data-avgwrap]'); const mx = el.querySelector('[data-mixwrap]');
    if (a) a.style.display = rev ? 'none' : ''; if (mx) mx.style.display = rev ? 'none' : '';
  }));
  el.querySelectorAll('input[data-cat]').forEach((cb) => cb.addEventListener('change', () => {
    cb.closest('.pj-cat').classList.toggle('on', cb.checked);
    const gw = el.querySelector(`[data-goalwrap="${cb.dataset.cat}"]`);
    if (gw) gw.style.display = cb.checked ? '' : 'none';
  }));
  const mixInput = el.querySelector('#pjMix'); const mixNote = el.querySelector('#pjMixNote');
  const updMix = () => { const v = num(mixInput?.value); if (mixNote) mixNote.textContent = v >= 0 && v <= 100 ? `LBW ${100 - v}%` : ''; };
  if (mixInput) { mixInput.addEventListener('input', updMix); updMix(); }
  el.querySelector('#pjSave').addEventListener('click', () => saveSetup(el, current));
}

async function saveSetup(el, method) {
  const btn = el.querySelector('#pjSave'); const msg = el.querySelector('#pjMsg');
  const setMsg = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? 'var(--red)' : 'var(--green)'; } };
  const cats = Array.from(el.querySelectorAll('input[data-cat]:checked')).map((c) => c.dataset.cat);
  if (!cats.length) { setMsg('Pick at least one category.', true); return; }
  const rev = method === 'revenue_weekly';
  const avgV = num(el.querySelector('#pjAvg')?.value);
  const mixV = num(el.querySelector('#pjMix')?.value);
  const avg_check = (!rev && avgV > 0) ? avgV : null;
  const food_mix_pct = (!rev && mixV >= 0 && mixV <= 100) ? mixV / 100 : null;

  const eff = firstOfMonthISO();
  const goalRows = [];
  for (const cat of cats) {
    const gv = num(el.querySelector(`input[data-goal="${cat}"]`)?.value);
    if (!(gv >= 0)) { setMsg(`Enter a goal % for ${CATS.find((c) => c.key === cat).label}.`, true); return; }
    goalRows.push({ client_id: ctx.clientId, category: cat, effective_from: eff, goal_pct: gv / 100, created_by: ctx.userId });
  }

  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…'; setMsg('', false);
  try {
    const up = await sb.from('projection_profiles').upsert({
      client_id: ctx.clientId, method, avg_check, avg_check_source: 'manual',
      food_mix_pct, mix_source: 'manual', categories: cats, week_start_dow: 1,
      updated_at: new Date().toISOString(), updated_by: ctx.userId,
    }, { onConflict: 'client_id' });
    if (up.error) throw up.error;
    const g = await sb.from('projection_goals').upsert(goalRows, { onConflict: 'client_id,category,effective_from' });
    if (g.error) throw g.error;

    store.profile = { client_id: ctx.clientId, method, avg_check, food_mix_pct, categories: cats, week_start_dow: 1 };
    goalRows.forEach((gr) => {
      const i = (store.goals || []).findIndex((x) => x.category === gr.category && x.effective_from === gr.effective_from);
      if (i >= 0) store.goals[i].goal_pct = gr.goal_pct; else (store.goals ||= []).push({ category: gr.category, effective_from: gr.effective_from, goal_pct: gr.goal_pct });
    });
    setMsg('Saved.', false);
  } catch (e) { setMsg('Error: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

/* ---------- styles ---------- */
function pjStyles() {
  return `<style>
    #tab-projections .pj-wrap{max-width:760px}
    #tab-projections .pj-loading,#tab-projections .pj-err{padding:22px;color:var(--text3);font-size:14px}
    #tab-projections .pj-err{color:var(--red)}
    #tab-projections .pj-subnav{display:inline-flex;background:var(--warm);border:1px solid var(--border);border-radius:999px;padding:3px;margin-bottom:20px}
    #tab-projections .pj-subnav button{border:0;background:none;font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--text3);padding:7px 16px;border-radius:999px;cursor:pointer}
    #tab-projections .pj-subnav button.on{background:var(--navy);color:#fff}
    #tab-projections .pj-head{margin-bottom:16px}
    #tab-projections .pj-title{font-family:var(--font-display);font-weight:800;font-size:22px;color:var(--text);letter-spacing:-.01em}
    #tab-projections .pj-sub{font-size:13px;color:var(--text2);margin-top:4px;max-width:60ch}
    #tab-projections .pj-panel{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-lg);padding:24px;box-shadow:var(--shadow-sm)}
    #tab-projections .pj-field{margin-bottom:24px}
    #tab-projections .pj-field:last-of-type{margin-bottom:0}
    #tab-projections .pj-flabel{font-family:var(--font-display);font-weight:700;font-size:14px;color:var(--text)}
    #tab-projections .pj-fhelp{font-size:12.5px;color:var(--text3);margin:3px 0 11px}
    #tab-projections .pj-methods{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
    #tab-projections .pj-method{border:1.5px solid var(--border);border-radius:var(--r);padding:12px 13px;cursor:pointer;transition:.15s;background:var(--bg)}
    #tab-projections .pj-method:hover{border-color:var(--border2)}
    #tab-projections .pj-method.on{border-color:var(--navy);background:var(--warm);box-shadow:0 0 0 3px rgba(27,42,75,.07)}
    #tab-projections .pj-mt{font-family:var(--font-display);font-weight:700;font-size:13.5px;color:var(--text)}
    #tab-projections .pj-md{font-size:11.5px;color:var(--text3);margin-top:3px;line-height:1.4}
    #tab-projections .pj-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    #tab-projections .pj-money{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);border-radius:var(--r);padding:8px 11px;background:var(--bg)}
    #tab-projections .pj-money.big{padding:12px 15px}
    #tab-projections .pj-money.big input{font-size:22px;font-family:var(--font-display);font-weight:800;color:var(--navy);width:130px}
    #tab-projections .pj-money span{color:var(--text3);font-size:13px;font-weight:600}
    #tab-projections .pj-money input{border:0;outline:0;font-family:var(--font-body);font-size:14px;font-weight:600;color:var(--text);width:90px;background:transparent}
    #tab-projections .pj-src{display:inline-flex;border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
    #tab-projections .pj-src span{padding:8px 12px;font-size:12.5px;font-weight:600;color:var(--text3)}
    #tab-projections .pj-src span.on{background:var(--navy);color:#fff}
    #tab-projections .pj-src span.dis{opacity:.5}
    #tab-projections .pj-mixnote{font-size:13px;color:var(--text2);font-weight:600}
    #tab-projections .pj-cats{display:flex;flex-wrap:wrap;gap:9px}
    #tab-projections .pj-cat{display:inline-flex;align-items:center;gap:8px;border:1.5px solid var(--border);border-radius:999px;padding:7px 14px;cursor:pointer;font-size:13px;font-weight:600;color:var(--text2)}
    #tab-projections .pj-cat.on{border-color:var(--navy);color:var(--text);background:var(--warm)}
    #tab-projections .pj-goals{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
    #tab-projections .pj-goal{border:1px solid var(--border);border-radius:var(--r);padding:12px 14px}
    #tab-projections .pj-gk{font-size:12px;color:var(--text3);font-weight:600;margin-bottom:7px}
    #tab-projections .pj-gv{display:flex;align-items:baseline;gap:3px}
    #tab-projections .pj-gv input{width:64px;border:0;outline:0;font-family:var(--font-display);font-weight:800;font-size:24px;color:var(--navy);padding:0;background:transparent}
    #tab-projections .pj-gv span{font-family:var(--font-display);font-weight:800;font-size:17px;color:var(--text3)}
    #tab-projections .pj-tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text3);background:var(--warm);border:1px solid var(--border);border-radius:5px;padding:3px 7px;margin-left:6px;vertical-align:middle}
    #tab-projections .pj-save{display:flex;align-items:center;gap:16px;margin-top:24px;flex-wrap:wrap}
    #tab-projections .pj-btn{background:var(--coral);color:#fff;border:0;font-family:var(--font-display);font-weight:700;font-size:14px;padding:11px 22px;border-radius:var(--r);cursor:pointer}
    #tab-projections .pj-btn:disabled{opacity:.6;cursor:default}
    #tab-projections .pj-note{font-size:12.5px;color:var(--text3);font-weight:500}
    #tab-projections .pj-link{border:0;background:none;color:var(--coral);font-weight:700;font-family:inherit;font-size:inherit;cursor:pointer;padding:0;text-decoration:underline}
    #tab-projections .pj-notice{background:var(--warm);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px;font-size:14px;color:var(--text2)}
    #tab-projections .pj-weeknav{display:flex;align-items:center;gap:10px;margin-bottom:16px}
    #tab-projections .pj-wbtn{width:34px;height:34px;border:1px solid var(--border);background:var(--bg);border-radius:var(--r);font-size:18px;color:var(--text2);cursor:pointer;line-height:1}
    #tab-projections .pj-wbtn:hover{border-color:var(--navy);color:var(--navy)}
    #tab-projections .pj-wlabel{font-family:var(--font-display);font-weight:800;font-size:17px;color:var(--text);display:flex;flex-direction:column;line-height:1.15}
    #tab-projections .pj-wlabel span{font-family:var(--font-body);font-weight:500;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}
    #tab-projections .pj-shead{margin-bottom:14px}
    #tab-projections .pj-wlabel .pj-wrel{order:-1;font-family:var(--font-body);font-weight:700;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px;border-radius:999px;width:fit-content;margin-bottom:3px}
    #tab-projections .pj-wlabel .pj-wrel.now{background:#eef1f8;color:var(--navy)}
    #tab-projections .pj-wlabel .pj-wrel.future{background:#fde9df;color:var(--coral)}
    #tab-projections .pj-wlabel .pj-wrel.past{background:var(--warm);color:var(--text3)}
    #tab-projections .pj-wlabel .pj-wrange{font-family:var(--font-display);font-weight:800;font-size:17px;color:var(--text);text-transform:none;letter-spacing:-.01em}
    #tab-projections .pj-today{margin-left:6px;border:1px solid var(--border);background:var(--bg);border-radius:999px;padding:6px 13px;font-size:12px;font-weight:600;color:var(--text2);cursor:pointer}
    #tab-projections .pj-context{font-size:12.5px;color:var(--text3);font-weight:600}
    #tab-projections .pj-bigrow{display:flex;gap:22px;align-items:flex-end;flex-wrap:wrap;margin-bottom:6px}
    #tab-projections .pj-bigin label{display:block;font-family:var(--font-display);font-weight:700;font-size:12.5px;color:var(--text2);margin-bottom:6px}
    #tab-projections .pj-days{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-bottom:6px}
    #tab-projections .pj-day{border:1px solid var(--border);border-radius:var(--r);padding:10px;text-align:center}
    #tab-projections .pj-dlabel{font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--text);display:flex;flex-direction:column}
    #tab-projections .pj-dlabel span{font-weight:500;font-size:10.5px;color:var(--text3)}
    #tab-projections .pj-day .pj-money{margin:8px 0 6px;padding:6px 8px}
    #tab-projections .pj-day .pj-money input{width:100%;text-align:center;font-size:15px}
    #tab-projections .pj-day .pj-money span{display:none}
    #tab-projections .pj-drev{font-size:11px;color:var(--text3);font-weight:600}
    #tab-projections .pj-sum{display:flex;gap:26px;background:var(--warm);border:1px solid var(--border);border-radius:var(--r);padding:14px 18px;margin:14px 0 4px;flex-wrap:wrap}
    #tab-projections .pj-sum div{display:flex;flex-direction:column;gap:3px}
    #tab-projections .pj-sum span{font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
    #tab-projections .pj-sum b{font-family:var(--font-display);font-weight:800;font-size:18px;color:var(--navy)}
    #tab-projections .pj-actuals{margin-top:22px;padding-top:20px;border-top:1px dashed var(--border)}
    #tab-projections .pj-ahead{font-family:var(--font-display);font-weight:800;font-size:15px;color:var(--text)}
    #tab-projections .pj-ahead span{font-family:var(--font-body);font-weight:500;font-size:12px;color:var(--text3);margin-left:8px}
    #tab-projections .pj-arow{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
    #tab-projections .pj-aproj{font-size:11.5px;color:var(--text3);font-weight:600;margin-top:5px}
    #tab-projections .pj-avar{margin-top:14px;font-size:14px;color:var(--text2);font-weight:500}
    #tab-projections .pj-avar b{font-family:var(--font-display);font-weight:800;color:var(--navy)}
    #tab-projections .pj-avar .up{color:var(--green);font-weight:700}
    #tab-projections .pj-avar .down{color:var(--coral);font-weight:700}
    #tab-projections .pj-empty{text-align:center;padding:64px 20px;color:var(--text3)}
    #tab-projections .pj-empty-emoji{font-size:34px;margin-bottom:12px}
    #tab-projections .pj-empty-t{font-family:var(--font-display);font-weight:700;font-size:17px;color:var(--text2)}
    #tab-projections .pj-empty-s{font-size:13px;margin-top:5px}
    #tab-projections .pj-totals{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
    #tab-projections .pj-tcard{flex:1;min-width:120px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;display:flex;flex-direction:column;gap:4px}
    #tab-projections .pj-tcard span{font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
    #tab-projections .pj-tcard b{font-family:var(--font-display);font-weight:800;font-size:20px;color:var(--navy)}
    #tab-projections .pj-tcard.total{background:var(--warm)}
    #tab-projections .pj-logform{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-lg);padding:16px;margin-bottom:18px;box-shadow:var(--shadow-sm)}
    #tab-projections .pj-lf-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    #tab-projections .pj-lin{border:1px solid var(--border);border-radius:var(--r);padding:9px 11px;font-family:var(--font-body);font-size:13px;font-weight:500;color:var(--text);background:var(--bg)}
    #tab-projections .pj-lf-actions{display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap}
    #tab-projections .pj-snap{border:1px solid var(--coral);background:var(--bg);color:var(--coral);font-family:var(--font-display);font-weight:700;font-size:13px;padding:9px 14px;border-radius:var(--r);cursor:pointer}
    #tab-projections .pj-snap:hover{background:var(--coral);color:#fff}
    #tab-projections .pj-snapmsg{font-size:12.5px;color:var(--text3);font-weight:500}
    #tab-projections .pj-ghost{border:1px solid var(--border);background:var(--bg);color:var(--text2);font-family:var(--font-display);font-weight:700;font-size:13px;padding:9px 14px;border-radius:var(--r);cursor:pointer}
    #tab-projections .pj-ltable{border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden}
    #tab-projections .pj-lrow{display:flex;align-items:center;gap:12px;padding:11px 14px;border-top:1px solid var(--border)}
    #tab-projections .pj-lrow:first-child{border-top:0}
    #tab-projections .pj-lrow:hover{background:var(--warm)}
    #tab-projections .pj-ldate{width:56px;font-size:12.5px;color:var(--text2);font-weight:600;flex:none}
    #tab-projections .pj-lcat{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;flex:none}
    #tab-projections .pj-lcat.cat-food{background:#fdf1dc;color:#8a6500}
    #tab-projections .pj-lcat.cat-lbw{background:#eef1f8;color:var(--navy)}
    #tab-projections .pj-lcat.cat-supplies{background:#eef0f2;color:var(--text2)}
    #tab-projections .pj-lvendor{flex:1;min-width:0;font-size:13.5px;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #tab-projections .pj-lvendor span{color:var(--text3);font-weight:500;margin-left:6px;font-size:12px}
    #tab-projections .pj-lamt{font-family:var(--font-display);font-weight:800;font-size:14px;color:var(--text);flex:none}
    #tab-projections .pj-lact{display:flex;gap:4px;flex:none}
    #tab-projections .pj-lact button{width:26px;height:26px;border:1px solid var(--border);background:var(--bg);border-radius:6px;cursor:pointer;color:var(--text3);font-size:12px}
    #tab-projections .pj-lact button:hover{border-color:var(--navy);color:var(--navy)}
    #tab-projections .pj-lempty{text-align:center;padding:34px 20px;color:var(--text3);font-size:13.5px;background:var(--bg);border:1px dashed var(--border);border-radius:var(--r-lg)}
    @media (max-width:640px){
      #tab-projections .pj-methods,#tab-projections .pj-goals{grid-template-columns:1fr}
      #tab-projections .pj-days{grid-template-columns:repeat(2,1fr)}
      #tab-projections .pj-lf-row{flex-direction:column;align-items:stretch}
      #tab-projections .pj-lin,#tab-projections .pj-lf-row .pj-money{width:100%}
    }
    #tab-projections .pj-attach{font-size:12.5px;color:var(--text2);font-weight:600}
    .pj-lightbox{position:fixed;inset:0;background:rgba(20,26,40,.82);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px}
    .pj-lightbox .pj-lb-inner{position:relative;max-width:92vw;max-height:92vh}
    .pj-lightbox img{max-width:92vw;max-height:92vh;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,.5);display:block}
    .pj-lightbox .pj-lb-close{position:absolute;top:-14px;right:-14px;width:34px;height:34px;border-radius:50%;border:0;background:#fff;color:#1B2A4B;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)}
  </style>`;
}
