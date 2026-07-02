// js/reconcile.js
// Team-only "Month-end review" sub-view of the Projections tab.
// Connect a client's QuickBooks, then pull the month's food-coded bills and
// flag anything missing from the receiving log (and logged-but-not-in-QBO).

import { sb } from './config.js';

let ctx = null;         // { clientId, userId }
let pollTimer = null;
let month = null;       // Date at first of the review month (default: last month)

function firstOfMonth(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d, k) { return new Date(d.getFullYear(), d.getMonth() + k, 1); }
function monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function monthName(d) { return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function money2(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(s) { return new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

export async function mountReconcile({ container, clientId, userId }) {
  ctx = { clientId, userId };
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (!month) month = firstOfMonth(addMonths(new Date(), -1)); // default: last completed month
  container.innerHTML = rcStyles() + `
    <div class="rc-wrap">
      <div class="rc-head">
        <div class="pj-title">Month-end review</div>
        <div class="pj-sub">Pull this client's food-coded bills from QuickBooks and flag anything missing from the receiving log. Team only.</div>
      </div>
      <div class="rc-card" id="rcConn"><div class="rc-loading">Checking QuickBooks connection…</div></div>
      <div id="rcBody"></div>
    </div>`;
  await renderConn();
}

async function callFn(fn, action, extra = {}) {
  const body = action ? { action, client_id: ctx.clientId, ...extra } : { client_id: ctx.clientId, ...extra };
  const { data, error } = await sb.functions.invoke(fn, { body });
  if (error) throw new Error(error.message || 'request failed');
  return data;
}

async function renderConn() {
  const el = document.getElementById('rcConn');
  if (!el) return;
  let s;
  try { s = await callFn('qbo-oauth', 'status'); }
  catch (e) { el.innerHTML = `<div class="rc-err">Couldn't check the connection: ${esc(e.message)}</div>`; return; }

  if (s && s.connected) {
    el.innerHTML = `
      <div class="rc-row">
        <div><div class="rc-t"><span class="rc-dot on"></span>QuickBooks connected</div>
          <div class="rc-s">Realm ${esc(s.realm_id)}${s.updated_at ? ` · linked ${new Date(s.updated_at).toLocaleDateString()}` : ''}</div></div>
        <button class="rc-ghost" id="rcDisc">Disconnect</button>
      </div>`;
    el.querySelector('#rcDisc').addEventListener('click', disconnect);
    renderPanel();
  } else {
    el.innerHTML = `
      <div class="rc-row">
        <div><div class="rc-t"><span class="rc-dot"></span>Connect QuickBooks</div>
          <div class="rc-s">Link this client's QuickBooks so month-end review can pull its food-coded bills.</div></div>
        <button class="rc-btn" id="rcConnect">Connect</button>
      </div>`;
    el.querySelector('#rcConnect').addEventListener('click', startConnect);
    const body = document.getElementById('rcBody'); if (body) body.innerHTML = '';
  }
}

function renderPanel() {
  const body = document.getElementById('rcBody');
  if (!body) return;
  body.innerHTML = `
    <div class="rc-panel">
      <div class="rc-monthnav">
        <button class="rc-wbtn" id="rcPrev">‹</button>
        <div class="rc-mlabel">${monthName(month)}</div>
        <button class="rc-wbtn" id="rcNext">›</button>
        <button class="rc-run" id="rcRun">Run review</button>
      </div>
      <div id="rcResult"><div class="rc-hint">Pick a month and run the review to compare QuickBooks against the receiving log.</div></div>
    </div>`;
  body.querySelector('#rcPrev').addEventListener('click', () => { month = addMonths(month, -1); renderPanel(); });
  body.querySelector('#rcNext').addEventListener('click', () => { month = addMonths(month, 1); renderPanel(); });
  body.querySelector('#rcRun').addEventListener('click', runReview);
}

async function runReview() {
  const btn = document.getElementById('rcRun');
  const out = document.getElementById('rcResult');
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Pulling from QuickBooks…';
  out.innerHTML = `<div class="rc-loading">Reading ${monthName(month)} bills, accounts, and the receiving log…</div>`;
  try {
    const d = await callFn('qbo-reconcile', null, { month: monthKey(month) });
    if (d && d.error === 'not_connected') { out.innerHTML = `<div class="rc-err">QuickBooks isn't connected for this client.</div>`; return; }
    if (d && d.error === 'reauth_needed') {
      out.innerHTML = `<div class="rc-err">QuickBooks needs to be reconnected — the authorization expired.</div>`;
      return;
    }
    if (!d || !d.ok) throw new Error((d && (d.message || d.error)) || 'no result');
    renderResult(out, d);
  } catch (e) {
    out.innerHTML = `<div class="rc-err">Review failed: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

function renderResult(out, d) {
  const s = d.summary;
  const cards = `
    <div class="rc-cards">
      <div class="rc-c"><span>QBO food invoices</span><b>${s.qboCount}</b><i>${money(s.qboTotal)}</i></div>
      <div class="rc-c"><span>Logged</span><b>${s.loggedCount}</b><i>${money(s.loggedTotal)}</i></div>
      <div class="rc-c ok"><span>Matched</span><b>${s.matchedCount}</b><i>&nbsp;</i></div>
      <div class="rc-c ${s.missingCount ? 'bad' : 'ok'}"><span>Missing from log</span><b>${s.missingCount}</b><i>${money(s.missingTotal)}</i></div>
    </div>`;

  const missing = d.missingFromLog.length ? `
    <div class="rc-sec">
      <div class="rc-sec-h bad">⚠ In QuickBooks (food) but not in the receiving log — ${d.missingFromLog.length}</div>
      ${rows(d.missingFromLog.map((x) => ({ vendor: x.vendor, date: x.date, inv: x.docNumber, amount: x.foodAmount })), 'bad')}
    </div>` : `<div class="rc-sec"><div class="rc-sec-h ok">✓ Every food invoice in QuickBooks was logged.</div></div>`;

  const extra = d.loggedNotInQbo.length ? `
    <div class="rc-sec">
      <div class="rc-sec-h warn">Logged but not found in QuickBooks — ${d.loggedNotInQbo.length}</div>
      <div class="rc-sec-note">Likely a bill not yet booked, coded to a non-food account, or a vendor/amount that didn't match.</div>
      ${rows(d.loggedNotInQbo.map((x) => ({ vendor: x.vendor, date: x.date, inv: x.invoice_number, amount: x.amount })), 'warn')}
    </div>` : '';

  const accNote = d.foodAccounts && d.foodAccounts.length
    ? `<div class="rc-acc">Food accounts pulled: ${d.foodAccounts.map((a) => esc(a)).join(' · ')}</div>`
    : `<div class="rc-acc bad">No accounts classified as food_cogs for this client — check the COA mappings.</div>`;

  out.innerHTML = cards + missing + extra + accNote;
}

function rows(list, tone) {
  if (!list.length) return '';
  return `<div class="rc-table">` + list.map((r) => `
    <div class="rc-tr ${tone}">
      <div class="rc-td-date">${r.date ? fmtDate(r.date) : '—'}</div>
      <div class="rc-td-vend">${esc(r.vendor || '—')}${r.inv ? `<span>#${esc(r.inv)}</span>` : ''}</div>
      <div class="rc-td-amt">${money2(r.amount)}</div>
    </div>`).join('') + `</div>`;
}

async function startConnect() {
  const btn = document.getElementById('rcConnect');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  try {
    const { url } = await callFn('qbo-oauth', 'start');
    window.open(url, 'qboConnect', 'width=680,height=780');
    let tries = 0;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      tries++;
      let s = null;
      try { s = await callFn('qbo-oauth', 'status'); } catch { /* keep polling */ }
      if ((s && s.connected) || tries > 45) { clearInterval(pollTimer); pollTimer = null; renderConn(); }
    }, 2000);
    if (btn) btn.textContent = 'Waiting for QuickBooks…';
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
    alert('Could not start the connection: ' + e.message);
  }
}

async function disconnect() {
  if (!confirm('Disconnect QuickBooks for this client? Month-end review will stop working until it is reconnected.')) return;
  try { await callFn('qbo-oauth', 'disconnect'); renderConn(); }
  catch (e) { alert('Could not disconnect: ' + e.message); }
}

function rcStyles() {
  return `<style>
    #tab-projections .rc-wrap{max-width:820px}
    #tab-projections .rc-head{margin-bottom:16px}
    #tab-projections .rc-loading,#tab-projections .rc-hint{color:var(--text3);font-size:14px;padding:6px 0}
    #tab-projections .rc-err{color:var(--red);font-size:14px;padding:6px 0}
    #tab-projections .rc-card{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-lg);padding:18px 20px;box-shadow:var(--shadow-sm)}
    #tab-projections .rc-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    #tab-projections .rc-t{font-family:var(--font-display);font-weight:800;font-size:15px;color:var(--text);display:flex;align-items:center;gap:8px}
    #tab-projections .rc-s{font-size:12.5px;color:var(--text3);margin-top:3px}
    #tab-projections .rc-dot{width:9px;height:9px;border-radius:50%;background:var(--text3);display:inline-block}
    #tab-projections .rc-dot.on{background:var(--green)}
    #tab-projections .rc-btn,#tab-projections .rc-run{background:var(--coral);color:#fff;border:0;font-family:var(--font-display);font-weight:700;font-size:14px;padding:10px 20px;border-radius:var(--r);cursor:pointer}
    #tab-projections .rc-btn:disabled,#tab-projections .rc-run:disabled{opacity:.6;cursor:default}
    #tab-projections .rc-ghost{border:1px solid var(--border);background:var(--bg);color:var(--text2);font-family:var(--font-display);font-weight:700;font-size:13px;padding:9px 15px;border-radius:var(--r);cursor:pointer}
    #tab-projections .rc-ghost:hover{border-color:var(--red);color:var(--red)}
    #tab-projections .rc-panel{margin-top:18px}
    #tab-projections .rc-monthnav{display:flex;align-items:center;gap:10px;margin-bottom:16px}
    #tab-projections .rc-wbtn{width:34px;height:34px;border:1px solid var(--border);background:var(--bg);border-radius:var(--r);font-size:18px;color:var(--text2);cursor:pointer;line-height:1}
    #tab-projections .rc-wbtn:hover{border-color:var(--navy);color:var(--navy)}
    #tab-projections .rc-mlabel{font-family:var(--font-display);font-weight:800;font-size:17px;color:var(--text);min-width:150px}
    #tab-projections .rc-run{margin-left:auto}
    #tab-projections .rc-cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
    #tab-projections .rc-c{flex:1;min-width:130px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;display:flex;flex-direction:column;gap:2px}
    #tab-projections .rc-c span{font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
    #tab-projections .rc-c b{font-family:var(--font-display);font-weight:800;font-size:22px;color:var(--navy)}
    #tab-projections .rc-c i{font-size:12px;color:var(--text3);font-style:normal;font-weight:600}
    #tab-projections .rc-c.ok b{color:var(--green)}
    #tab-projections .rc-c.bad{border-color:var(--red)}
    #tab-projections .rc-c.bad b{color:var(--red)}
    #tab-projections .rc-sec{margin-bottom:16px}
    #tab-projections .rc-sec-h{font-family:var(--font-display);font-weight:800;font-size:14px;margin-bottom:8px}
    #tab-projections .rc-sec-h.bad{color:var(--red)}
    #tab-projections .rc-sec-h.warn{color:#a5730d}
    #tab-projections .rc-sec-h.ok{color:var(--green)}
    #tab-projections .rc-sec-note{font-size:12px;color:var(--text3);margin:-4px 0 8px}
    #tab-projections .rc-table{border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
    #tab-projections .rc-tr{display:flex;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid var(--border)}
    #tab-projections .rc-tr:first-child{border-top:0}
    #tab-projections .rc-tr.bad{border-left:3px solid var(--red)}
    #tab-projections .rc-tr.warn{border-left:3px solid #d9a326}
    #tab-projections .rc-td-date{width:56px;font-size:12.5px;color:var(--text2);font-weight:600;flex:none}
    #tab-projections .rc-td-vend{flex:1;min-width:0;font-size:13.5px;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #tab-projections .rc-td-vend span{color:var(--text3);font-weight:500;margin-left:6px;font-size:12px}
    #tab-projections .rc-td-amt{font-family:var(--font-display);font-weight:800;font-size:14px;color:var(--text);flex:none}
    #tab-projections .rc-acc{margin-top:12px;font-size:11.5px;color:var(--text3);line-height:1.5}
    #tab-projections .rc-acc.bad{color:var(--red)}
  </style>`;
}
