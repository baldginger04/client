// js/reconcile.js
// Team-only "Month-end review" sub-view of the Projections tab.
// Slice 1: QuickBooks connection status + connect/disconnect.
// The actual receiving-log-vs-QBO reconciliation renders in #rcBody (next slice).

import { sb } from './config.js';

let ctx = null;       // { clientId, userId }
let pollTimer = null;

export async function mountReconcile({ container, clientId, userId }) {
  ctx = { clientId, userId };
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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

async function callFn(action, extra = {}) {
  const { data, error } = await sb.functions.invoke('qbo-oauth', { body: { action, client_id: ctx.clientId, ...extra } });
  if (error) throw new Error(error.message || 'request failed');
  if (data && data.error) throw new Error(data.error);
  return data;
}

async function renderConn() {
  const el = document.getElementById('rcConn');
  if (!el) return;
  let s;
  try { s = await callFn('status'); }
  catch (e) { el.innerHTML = `<div class="rc-err">Couldn't check the connection: ${e.message}</div>`; return; }

  if (s.connected) {
    el.innerHTML = `
      <div class="rc-row">
        <div><div class="rc-t"><span class="rc-dot on"></span>QuickBooks connected</div>
          <div class="rc-s">Realm ${s.realm_id}${s.updated_at ? ` · linked ${new Date(s.updated_at).toLocaleDateString()}` : ''}</div></div>
        <button class="rc-ghost" id="rcDisc">Disconnect</button>
      </div>`;
    el.querySelector('#rcDisc').addEventListener('click', disconnect);
    const body = document.getElementById('rcBody');
    if (body) body.innerHTML = `<div class="rc-stub">Reconciliation runs here — QuickBooks food bills vs. the receiving log, with anything unlogged flagged. Coming in the next update.</div>`;
  } else {
    el.innerHTML = `
      <div class="rc-row">
        <div><div class="rc-t"><span class="rc-dot"></span>Connect QuickBooks</div>
          <div class="rc-s">Link this client's QuickBooks so month-end review can pull its food-coded bills.</div></div>
        <button class="rc-btn" id="rcConnect">Connect</button>
      </div>`;
    el.querySelector('#rcConnect').addEventListener('click', startConnect);
    const body = document.getElementById('rcBody');
    if (body) body.innerHTML = '';
  }
}

async function startConnect() {
  const btn = document.getElementById('rcConnect');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  try {
    const { url } = await callFn('start');
    window.open(url, 'qboConnect', 'width=680,height=780');
    // Poll for the connection to land (Intuit redirect writes it server-side).
    let tries = 0;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      tries++;
      let s = null;
      try { s = await callFn('status'); } catch { /* keep polling */ }
      if ((s && s.connected) || tries > 45) {
        clearInterval(pollTimer); pollTimer = null;
        renderConn();
      }
    }, 2000);
    if (btn) btn.textContent = 'Waiting for QuickBooks…';
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
    alert('Could not start the connection: ' + e.message);
  }
}

async function disconnect() {
  if (!confirm('Disconnect QuickBooks for this client? Month-end review will stop working until it is reconnected.')) return;
  try { await callFn('disconnect'); renderConn(); }
  catch (e) { alert('Could not disconnect: ' + e.message); }
}

function rcStyles() {
  return `<style>
    #tab-projections .rc-wrap{max-width:760px}
    #tab-projections .rc-head{margin-bottom:16px}
    #tab-projections .rc-loading{color:var(--text3);font-size:14px}
    #tab-projections .rc-err{color:var(--red);font-size:14px}
    #tab-projections .rc-card{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-lg);padding:18px 20px;box-shadow:var(--shadow-sm)}
    #tab-projections .rc-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    #tab-projections .rc-t{font-family:var(--font-display);font-weight:800;font-size:15px;color:var(--text);display:flex;align-items:center;gap:8px}
    #tab-projections .rc-s{font-size:12.5px;color:var(--text3);margin-top:3px}
    #tab-projections .rc-dot{width:9px;height:9px;border-radius:50%;background:var(--text3);display:inline-block}
    #tab-projections .rc-dot.on{background:var(--green)}
    #tab-projections .rc-btn{background:var(--coral);color:#fff;border:0;font-family:var(--font-display);font-weight:700;font-size:14px;padding:10px 20px;border-radius:var(--r);cursor:pointer}
    #tab-projections .rc-btn:disabled{opacity:.6;cursor:default}
    #tab-projections .rc-ghost{border:1px solid var(--border);background:var(--bg);color:var(--text2);font-family:var(--font-display);font-weight:700;font-size:13px;padding:9px 15px;border-radius:var(--r);cursor:pointer}
    #tab-projections .rc-ghost:hover{border-color:var(--red);color:var(--red)}
    #tab-projections .rc-stub{margin-top:16px;padding:20px;background:var(--warm);border:1px dashed var(--border);border-radius:var(--r-lg);font-size:13.5px;color:var(--text2)}
  </style>`;
}
