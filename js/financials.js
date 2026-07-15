// =====================================================================
// financials.js — upload, list, archive, render xlsx files
//
// Design notes:
//   - Defensive loading: try/catch around fetch AND render; spinner is
//     ALWAYS replaced with content OR an error/retry state, never left
//     spinning. (This is the fix for the Nickel-City-spinning-wheel bug.)
//   - 10s timeout fallback: if the load doesn't resolve, show a retry
//     button. Race against the actual fetch with Promise.race.
//   - Cache: files for the current client are held in memory so
//     archive toggles don't re-fetch.
//   - SheetJS handles xlsx parsing in-browser; PDFs link out to a
//     download URL (no in-browser preview).
// =====================================================================

import { sb } from './config.js';
import { parsePnlWorkbook, parsePnlByClass, detectPnlFormat, matchAccounts, persistPnlData, fetchMappings } from './pnl-parser.js';
import { activateCommenting, deactivateCommenting } from './pnl-comments-ui.js';

const BUCKET = 'financials';
const LOAD_TIMEOUT_MS = 30_000;

// Per-tab state.
let state = {
  clientId: null,
  isTeam: false,
  userId: null,
  files: [],           // cached files for current client
  expandedFileId: null // file currently showing inline preview, if any
};

// =====================================================================
// PUBLIC API
// =====================================================================

/** Mount the financials tab. Called when user opens the tab OR switches clients. */
export async function mountFinancials({ clientId, isTeam, userId, fullName }) {
  state.clientId = clientId;
  state.isTeam = isTeam;
  state.userId = userId;
  state.fullName = fullName || null;
  state.expandedFileId = null;

  renderUploadCard();
  bindUploadForm();
  // Warm up Supabase storage. The storage subsystem is separate from the
  // SQL API and has its own cold-start. Without this, the first upload of
  // the session can hang for 30+ seconds, then time out silently. A cheap
  // list() call wakes the connection so by the time the user actually
  // uploads, storage is ready. Fire-and-forget — failures are ignored.
  if (isTeam) {
    sb.storage.from(BUCKET).list(clientId, { limit: 1 }).catch(() => {});
  }
  await loadAndRenderFiles();
  renderPnlSection();
  renderBalanceSheetSection();
  renderPnlDetailSection();
}

/** Called when the user leaves this tab — tear down any commenting UI. */
export function unmountFinancials() {
  // Clean up the comment popover + sidebar if a preview was open.
  deactivateCommenting();
}

// =====================================================================
// UPLOAD
// =====================================================================

function renderUploadCard() {
  // Upload form retired — P&L, Balance Sheet and P&L Detail now come from
  // QuickBooks. Hide the old upload card; give the team a standalone
  // "Notify client" button at the top of the tab.
  const card = document.getElementById('uploadCard');
  if (card) card.style.display = 'none';
  const pane = document.getElementById('tab-financials');
  if (state.isTeam && pane && !document.getElementById('notifyBar')) {
    const bar = document.createElement('div');
    bar.id = 'notifyBar';
    bar.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-bottom:14px';
    bar.innerHTML = '<span id="notifyMsg" style="font-size:12.5px;color:var(--text3)"></span>'
      + '<button type="button" id="notifyClientBtn" style="border:1px solid #1B2A4B;background:#fff;color:#1B2A4B;border-radius:8px;padding:8px 16px;font-weight:700;font-size:13px;cursor:pointer">\u2709 Notify client</button>';
    pane.insertBefore(bar, pane.firstChild);
    document.getElementById('notifyClientBtn').addEventListener('click', notifyClient);
  }
}

async function notifyClient() {
  const btn = document.getElementById('notifyClientBtn');
  const msg = document.getElementById('notifyMsg');
  if (!state.clientId || !state.userId) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
  if (msg) msg.textContent = '';
  try {
    const { data, error } = await sb.functions.invoke('send-upload-notification', {
      body: { clientId: state.clientId, uploaderUserId: state.userId },
    });
    if (error) throw error;
    if (data && data.ok === false) throw new Error(data.error || 'Unknown error');
    const nRec = ((data && data.sentTo) || []).length;
    if (msg) { msg.textContent = 'Notified ' + nRec + ' recipient' + (nRec === 1 ? '' : 's') + '.'; msg.style.color = '#1e7a45'; }
  } catch (e) {
    if (msg) { msg.textContent = "Couldn't send: " + (e.message || e); msg.style.color = '#b93232'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\u2709 Notify client'; }
  }
}

// =====================================================================
// PROFIT & LOSS (from QuickBooks) — single month. Team pulls, sees the
// rendered statement + a match check vs stored pnl_data, and Publish does
// BOTH: refresh pnl_data (KPI/Prime/charts) and post the statement to client.
// =====================================================================
let pnlMonth = null;
function renderPnlSection() {
  const pane = document.getElementById('tab-financials');
  if (!pane) return;
  if (!pnlMonth) pnlMonth = bsAddMonths(bsFirstOfMonth(new Date()), -1);
  let sec = document.getElementById('pnlSection');
  if (!sec) { sec = document.createElement('section'); sec.className = 'card'; sec.id = 'pnlSection'; sec.style.cssText = 'margin-top:18px'; pane.appendChild(sec); }
  drawPnlSection(sec);
}
function drawPnlSection(sec) {
  const team = state.isTeam;
  sec.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">'
    + '<div style="font-weight:800;font-size:16px;color:var(--text)">Profit &amp; Loss</div>'
    + '<div style="display:flex;align-items:center;gap:6px;margin-left:6px">'
    + '<button type="button" id="pnlPrev" style="width:30px;height:30px;border:1px solid var(--border);background:var(--bg);border-radius:7px;cursor:pointer">\u2039</button>'
    + '<span style="font-weight:700;min-width:130px;text-align:center">' + bsMonthName(pnlMonth) + '</span>'
    + '<button type="button" id="pnlNext" style="width:30px;height:30px;border:1px solid var(--border);background:var(--bg);border-radius:7px;cursor:pointer">\u203a</button>'
    + '<select id="pnlJump" style="border:1px solid var(--border);background:var(--bg);border-radius:7px;padding:5px 7px;font-size:12.5px;color:var(--text)"><option value="">Jump to\u2026</option></select>'
    + '</div>'
    + (team ? '<button type="button" id="pnlPull" style="margin-left:auto;border:1px solid #1B2A4B;background:#1B2A4B;color:#fff;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer">\u21ba Pull from QuickBooks</button>' : '')
    + (team ? '<button type="button" id="pnlBackfill" style="border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer">\u21e3 Backfill history</button>' : '')
    + '</div>'
    + (team ? '<div id="pnlBackfillPanel" style="display:none"></div>' : '')
    + '<div id="pnlBody"><div style="color:var(--text3);font-size:13px;padding:6px 0">Loading\u2026</div></div>';
  sec.querySelector('#pnlPrev').addEventListener('click', () => { pnlMonth = bsAddMonths(pnlMonth, -1); drawPnlSection(sec); });
  sec.querySelector('#pnlNext').addEventListener('click', () => { pnlMonth = bsAddMonths(pnlMonth, 1); drawPnlSection(sec); });
  loadPnlJump(sec);
  if (team) sec.querySelector('#pnlPull').addEventListener('click', () => pullPnl(sec));
  if (team) sec.querySelector('#pnlBackfill').addEventListener('click', () => toggleBackfill(sec));
  loadPublishedPnl(sec);
}
async function loadPublishedPnl(sec) {
  const body = sec.querySelector('#pnlBody'); if (!body) return;
  try {
    const r = await sb.from('pnl_reports').select('statement,generated_at').eq('client_id', state.clientId).eq('period', bsKey(pnlMonth)).eq('published', true).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) { body.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:10px 0">' + (state.isTeam ? 'Nothing published for ' + bsMonthName(pnlMonth) + ' yet. Pull it from QuickBooks above, then publish.' : 'No P&L has been posted for ' + bsMonthName(pnlMonth) + ' yet.') + '</div>'; return; }
    body.innerHTML = renderPnlStatement(r.data.statement || [], pnlPeriods()) + '<div style="font-size:11px;color:var(--text3);margin-top:8px">Published ' + (r.data.generated_at ? new Date(r.data.generated_at).toLocaleDateString() : '') + ' \u00b7 click any account line to see its transactions</div>';
    wirePnlDrill(body);
  } catch (e) { body.innerHTML = '<div style="color:#b93232;font-size:13px">Couldn\u2019t load: ' + bsEsc(e.message || e) + '</div>'; }
}
// ── Backfill history: one wide qbo-pnl pull, classified under CURRENT
// mappings, persisted month-by-month into pnl_data. Feeds KPI/Prime/charts;
// deliberately does NOT publish statements (that stays a monthly human act).
// Skips months that already have data unless overwrite is ticked.
function bfLastClosedMonth() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function toggleBackfill(sec) {
  const p = sec.querySelector('#pnlBackfillPanel'); if (!p) return;
  if (p.style.display !== 'none') { p.style.display = 'none'; return; }
  p.style.display = 'block';
  p.innerHTML =
    '<div style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:12px;background:var(--bg)">'
    + '<div style="font-weight:700;font-size:13.5px;margin-bottom:8px">Backfill P&amp;L history from QuickBooks</div>'
    + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px">'
    + '<label>From <input type="month" id="bfFrom" value="2025-01" style="border:1px solid var(--border);border-radius:7px;padding:5px 7px"></label>'
    + '<label>Through <input type="month" id="bfTo" value="' + bfLastClosedMonth() + '" style="border:1px solid var(--border);border-radius:7px;padding:5px 7px"></label>'
    + '<label style="display:flex;align-items:center;gap:5px"><input type="checkbox" id="bfOverwrite"> Overwrite months that already have data</label>'
    + '<button type="button" id="bfRun" style="border:0;background:#D85B31;color:#fff;border-radius:8px;padding:7px 14px;font-weight:700;cursor:pointer">Run backfill</button>'
    + '</div>'
    + '<div id="bfLog" style="font-size:12.5px;color:var(--text3);margin-top:8px;white-space:pre-line"></div>'
    + '</div>';
  p.querySelector('#bfRun').addEventListener('click', () => runBackfill(sec));
}
async function runBackfill(sec) {
  const p = sec.querySelector('#pnlBackfillPanel');
  const log = p.querySelector('#bfLog');
  const btn = p.querySelector('#bfRun');
  const fromM = p.querySelector('#bfFrom').value, toM = p.querySelector('#bfTo').value;
  const overwrite = p.querySelector('#bfOverwrite').checked;
  const say = (t) => { log.textContent += (log.textContent ? '\n' : '') + t; };
  if (!/^\d{4}-\d{2}$/.test(fromM) || !/^\d{4}-\d{2}$/.test(toM) || fromM > toM) { log.textContent = 'Pick a valid month range.'; return; }
  btn.disabled = true; btn.textContent = 'Running\u2026'; log.textContent = '';
  try {
    const from = fromM + '-01';
    const [ty, tm] = toM.split('-').map(Number);
    const to = toM + '-' + String(new Date(ty, tm, 0).getDate()).padStart(2, '0');
    say('Pulling ' + fromM + ' \u2192 ' + toM + ' from QuickBooks\u2026');
    const { data, error } = await sb.functions.invoke('qbo-pnl', { body: { client_id: state.clientId, from, to } });
    if (error) throw new Error(error.message || 'request failed');
    if (data && data.error === 'not_connected') { say('QuickBooks isn\u2019t connected for this client.'); return; }
    if (data && data.error === 'reauth_needed') { say('QuickBooks needs to be reconnected.'); return; }
    if (!data || !data.ok) throw new Error((data && (data.message || data.error)) || 'no result');
    const months = data.months || [];
    say('Got ' + months.length + ' months, ' + (data.rows || []).length + ' account rows. Classifying\u2026');
    const mappings = await fetchMappings(state.clientId);
    const classified = matchAccounts(data.rows || [], mappings, state.clientId);
    const er = await sb.from('pnl_data').select('period').eq('client_id', state.clientId).in('period', months).range(0, 49999);
    if (er.error) throw er.error;
    const existing = new Set((er.data || []).map((r) => r.period));
    const target = overwrite ? months : months.filter((m) => !existing.has(m));
    const skipped = months.length - target.length;
    if (!target.length) { say('All ' + months.length + ' months already have data \u2014 nothing written. Tick overwrite to replace them.'); return; }
    say('Writing ' + target.length + ' month(s)' + (skipped ? ' (skipping ' + skipped + ' that already have data)' : '') + '\u2026');
    const res = await persistPnlData(state.clientId, classified, target, null);
    say('Done \u2014 ' + (res && res.inserted != null ? res.inserted : '?') + ' rows across: ' + target.join(', '));
    say('KPI Dashboard, Prime Sheet, and charts now include this history. Statements were not published.');
  } catch (e) {
    say('Error: ' + (e.message || e));
  } finally { btn.disabled = false; btn.textContent = 'Run backfill'; }
}
async function pullPnl(sec) {
  const btn = sec.querySelector('#pnlPull'); const body = sec.querySelector('#pnlBody');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Pulling\u2026'; }
  body.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:6px 0">Pulling the P&L from QuickBooks\u2026</div>';
  try {
    const period = bsKey(pnlMonth);
    const from = bsKey(bsAddMonths(pnlMonth, -12)) + '-01', to = bsLastDay(pnlMonth);
    const { data, error } = await sb.functions.invoke('qbo-pnl', { body: { client_id: state.clientId, from, to } });
    if (error) throw new Error(error.message || 'request failed');
    if (data && data.error === 'not_connected') { body.innerHTML = '<div style="color:#b93232;font-size:13px">QuickBooks isn\u2019t connected for this client.</div>'; return; }
    if (data && data.error === 'reauth_needed') { body.innerHTML = '<div style="color:#b93232;font-size:13px">QuickBooks needs to be reconnected.</div>'; return; }
    if (!data || !data.ok) throw new Error((data && (data.message || data.error)) || 'no result');

    const mappings = await fetchMappings(state.clientId);
    const classified = matchAccounts(data.rows || [], mappings, state.clientId);
    const qbo = {}; classified.forEach((r) => { const a = (r.amounts && r.amounts[period]) || 0; const cat = r.category || '(uncategorized)'; qbo[cat] = (qbo[cat] || 0) + a; });
    const sr = await sb.from('pnl_data').select('category,amount').eq('client_id', state.clientId).eq('period', period);
    const stored = {}; (sr.data || []).forEach((r) => { const cat = r.category || '(uncategorized)'; stored[cat] = (stored[cat] || 0) + Number(r.amount || 0); });
    const cats = new Set([...Object.keys(qbo), ...Object.keys(stored)]); let m = 0; cats.forEach((cat) => { if (Math.abs((qbo[cat] || 0) - (stored[cat] || 0)) < 0.5) m++; });
    const hasStored = Object.keys(stored).length > 0;
    const matchLine = hasStored ? (m + ' of ' + cats.size + ' categories match the stored P&L.') : ('Nothing stored for ' + bsMonthName(pnlMonth) + ' yet \u2014 this will be the first load.');

    body.innerHTML = '<div style="font-size:12.5px;color:var(--text3);margin-bottom:8px">' + matchLine + '</div>'
      + renderPnlStatement(data.statement || [], pnlPeriods())
      + '<div style="display:flex;gap:12px;align-items:center;margin-top:14px"><button type="button" id="pnlPublish" style="border:0;background:#D85B31;color:#fff;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer">Publish for client</button><span id="pnlPubMsg" style="font-size:12.5px;color:var(--text3)">Preview \u2014 publishing updates KPI/Prime and posts the statement to the client.</span></div>';
    sec.querySelector('#pnlPublish').addEventListener('click', () => publishPnl(sec, data.statement || [], classified));
    wirePnlDrill(body);
  } catch (e) {
    body.innerHTML = '<div style="color:#b93232;font-size:13px">Couldn\u2019t pull: ' + bsEsc(e.message || e) + '</div>';
  } finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}
async function publishPnl(sec, statement, classified) {
  const btn = sec.querySelector('#pnlPublish'); const msg = sec.querySelector('#pnlPubMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing\u2026'; }
  try {
    await persistPnlData(state.clientId, classified, [bsKey(pnlMonth)], null);
    const { error } = await sb.from('pnl_reports').upsert({ client_id: state.clientId, period: bsKey(pnlMonth), statement, generated_by: state.userId, generated_at: new Date().toISOString(), published: true }, { onConflict: 'client_id,period' });
    if (error) throw error;
    if (msg) { msg.textContent = 'Published \u2014 analytics updated and the client can see it.'; msg.style.color = '#1e7a45'; }
    if (btn) btn.textContent = 'Published \u2713';
  } catch (e) {
    if (msg) { msg.textContent = 'Error: ' + (e.message || e); msg.style.color = '#b93232'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Publish for client'; }
  }
}

let uploadBound = false;
function bindUploadForm() {
  if (uploadBound) return;
  uploadBound = true;

  const form = document.getElementById('uploadForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleUpload();
  });
}

// #6 diagnostics: record cold-start upload-retry events to a Supabase table so
// we can tell, over normal usage, whether the refresh+re-upload quirk still
// occurs. Fire-and-forget and fully swallowed — diagnostics must never break or
// slow an upload. Requires table public.upload_diagnostics (team-only RLS).
function logUploadDiag(event, storagePath, detail) {
  try {
    sb.from('upload_diagnostics').insert({
      client_id: state.clientId || null,
      user_id: state.userId || null,
      event: event,
      storage_path: storagePath || null,
      detail: detail || null,
    }).then(function () {}, function () {});
  } catch (_) { /* never throw from diagnostics */ }
}

async function handleUpload() {
  const fileInput = document.getElementById('uploadFile');
  const typeSelect = document.getElementById('uploadType');
  const periodInput = document.getElementById('uploadPeriod');
  const btn = document.getElementById('uploadBtn');
  const status = document.getElementById('uploadStatus');

  const file = fileInput.files[0];
  if (!file) { setStatus(status, 'error', 'Choose a file first.'); return; }
  if (!state.clientId) { setStatus(status, 'error', 'No client selected.'); return; }

  const fileType = typeSelect.value;
  const period = periodInput.value; // 'YYYY-MM' from <input type="month">
  if (!period) { setStatus(status, 'error', 'Pick a period.'); return; }

  btn.disabled = true;
  setStatus(status, '', 'Uploading…');

  try {
    // Build storage path: financials/<client_id>/<period>_<filename>
    // Prefix with period so listings sort naturally.
    const safeName = sanitizeFilename(file.name);
    let storagePath = `${state.clientId}/${period}_${Date.now()}_${safeName}`;

    // 1. Upload to Storage. Wrapped in a timeout + one-shot retry because
    // Supabase storage occasionally hangs on cold starts for the first call
    // of a session. Without this guard the user sees an infinite spinner
    // and has to refresh — the bug that prompted this fix. 45s is generous
    // for cold-start; legit uploads of normal P&L files complete in <5s.
    const upWithTimeout = () => Promise.race([
      sb.storage.from(BUCKET).upload(storagePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 45000)),
    ]);
    let upErr;
    try {
      const result = await upWithTimeout();
      upErr = result.error;
    } catch (timeoutErr) {
      // First attempt timed out — try once more. If the first call was a
      // cold-start that eventually completed server-side, this retry may
      // collide; we use a slightly different path suffix to avoid duplicate
      // key errors from upsert:false.
      console.warn('Upload timed out, retrying once...');
      setStatus(status, '', 'Still uploading…');
      const originalPath = storagePath;
      // #6 telemetry: the cold-start stall just fired.
      logUploadDiag('coldstart_retry', originalPath, 'file=' + safeName);
      const retryPath = `${state.clientId}/${period}_${Date.now()}_retry_${safeName}`;
      const retry = await Promise.race([
        sb.storage.from(BUCKET).upload(retryPath, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type || undefined,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_AGAIN')), 45000)),
      ]).catch((e) => ({ error: e }));
      if (retry.error) {
        logUploadDiag('timeout_twice', originalPath, 'file=' + safeName);
        throw new Error('Upload timed out twice. Check your connection and try again.');
      }
      // Retry succeeded — use the retry path for the DB insert below
      storagePath = retryPath;
      upErr = null;
      logUploadDiag('retry_succeeded', retryPath, 'orphan=' + originalPath);
      // The first attempt may have completed server-side before the client gave
      // up, leaving an orphan at originalPath. Best-effort clean + note if found.
      sb.storage.from(BUCKET).remove([originalPath])
        .then(function (r) { if (r && r.data && r.data.length) logUploadDiag('orphan_removed', originalPath, null); })
        .catch(function () {});
    }
    if (upErr) throw upErr;

    // 2. Insert row in files table
    // pending_notification mirrors the "Notify client" checkbox; the Send button
    // (rendered as a banner when any files have this flag) batches all pending
    // files into one email via the send-upload-notification Edge Function.
    const notifyChecked = document.getElementById('uploadNotifyCheckbox')?.checked || false;
    const { error: insErr } = await sb.from('files').insert({
      client_id: state.clientId,
      storage_path: storagePath,
      filename: file.name,
      file_type: fileType,
      period,
      size_bytes: file.size,
      mime_type: file.type || null,
      uploaded_by: state.userId,
      pending_notification: notifyChecked,
    });
    if (insErr) {
      // Try to clean up the orphaned storage object so we don't leave junk
      await sb.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      throw insErr;
    }

    setStatus(status, 'ok', `✓ Uploaded ${file.name}`);
    fileInput.value = '';
    await loadAndRenderFiles({ force: true });
  } catch (err) {
    console.error('upload failed:', err);
    setStatus(status, 'error', `Upload failed: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
}

function setStatus(el, cls, text) {
  if (!el) return;
  el.className = 'upload-status' + (cls ? ' ' + cls : '');
  el.textContent = text;
}

// =====================================================================
// SEND NOTIFICATION
// =====================================================================
// Called when the team clicks "Send notification" in the pending-files banner.
// Invokes the send-upload-notification Edge Function, which looks up everything
// it needs (client users, uploader profile, file list) and sends one
// consolidated email via Resend, then clears the pending flag on those files.
async function sendNotification(btn) {
  if (!state.clientId || !state.userId) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const { data, error } = await sb.functions.invoke('send-upload-notification', {
      body: { clientId: state.clientId, uploaderUserId: state.userId },
    });
    if (error) throw error;
    if (data && data.ok === false) throw new Error(data.error || 'Unknown error');
    // Refresh the list — the banner disappears once pending_notification is cleared.
    const recipientCount = (data?.sentTo || []).length;
    const fileCount = data?.fileCount || 0;
    await loadAndRenderFiles({ force: true });
    // Flash a transient confirmation in the upload status area if it's visible.
    const status = document.getElementById('uploadStatus');
    if (status) {
      const label = `Sent to ${recipientCount} recipient${recipientCount === 1 ? '' : 's'} — ${fileCount} file${fileCount === 1 ? '' : 's'} included.`;
      setStatus(status, 'ok', '✓ ' + label);
      setTimeout(() => { if (status.textContent.includes('✓')) setStatus(status, '', ''); }, 6000);
    }
  } catch (err) {
    console.error('sendNotification failed:', err);
    alert("Couldn't send notification: " + (err.message || err));
    if (btn) { btn.disabled = false; btn.textContent = 'Send notification'; }
  }
}

// =====================================================================
// LIST / RENDER
// =====================================================================

async function loadAndRenderFiles({ force = false } = {}) {
  const container = document.getElementById('financialsList');
  if (!container) return;

  // Always show a spinner on (re)load, then race the fetch against a timeout.
  container.innerHTML = '<div class="state-msg"><span class="spinner"></span> Loading files…</div>';

  try {
    let files;
    try {
      // First attempt: race against the timeout.
      files = await withTimeout(fetchFiles(state.clientId), LOAD_TIMEOUT_MS);
    } catch (firstErr) {
      // If it timed out (and only then), the database was likely cold-started.
      // Try once more silently — the DB is warm now and this should be quick.
      if (firstErr && firstErr.code === 'TIMEOUT') {
        container.innerHTML = '<div class="state-msg"><span class="spinner"></span> Warming up…</div>';
        files = await withTimeout(fetchFiles(state.clientId), LOAD_TIMEOUT_MS);
      } else {
        throw firstErr;
      }
    }
    state.files = files;
    renderFileList();
  } catch (err) {
    console.error('loadFiles failed:', err);
    if (err && err.code === 'TIMEOUT') {
      container.innerHTML = retryHtml('Loading is taking longer than expected.');
    } else {
      container.innerHTML = retryHtml(`Couldn't load files: ${escapeHtml(err.message || String(err))}`);
    }
    bindRetry(() => loadAndRenderFiles({ force: true }));
  }
}

async function fetchFiles(clientId) {
  const { data, error } = await sb
    .from('files')
    .select('id, client_id, storage_path, filename, file_type, period, size_bytes, mime_type, is_archived, pending_notification, created_at')
    .eq('client_id', clientId)
    .order('period', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

function renderFileList() {
  const container = document.getElementById('financialsList');
  if (!container) return;

  if (state.files.length === 0) {
    container.innerHTML = `
      <div class="card empty-card">
        <div class="empty-title">No files yet</div>
        <div class="empty-sub">
          ${state.isTeam
            ? 'Upload a P&L, P&L Detail, Prime Sheet, or Balance Sheet using the form above.'
            : 'Your Bald Ginger team will share monthly financials here once the month closes.'}
        </div>
      </div>`;
    return;
  }

  // Split into active (not archived) and archived
  const active = state.files.filter((f) => !f.is_archived);
  const archived = state.files.filter((f) => f.is_archived);

  // Group active by period
  const activeByPeriod = groupByPeriod(active);
  const archivedByPeriod = groupByPeriod(archived);

  let html = '';

  // ---- Pending-notification banner (team only) ----
  // Files marked "Notify client" at upload sit pending until the team clicks
  // "Send notification" — this batches multiple uploads into one email. The
  // banner only renders if at least one such file exists and the viewer is on
  // the team.
  const pending = state.files.filter((f) => f.pending_notification && !f.is_archived);
  if (state.isTeam && pending.length > 0) {
    const label = pending.length === 1 ? '1 file' : `${pending.length} files`;
    html += `
      <div id="notifyBanner" style="background:#fff7ed;border:1px solid #f5c89a;border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem;display:flex;align-items:center;gap:.75rem">
        <div style="flex:1;font-size:13px;color:#7a3e0a">
          <strong>${label} pending notification.</strong> Click Send to email the client.
        </div>
        <button class="btn btn-primary btn-sm" id="notifySendBtn">Send notification</button>
      </div>`;
  }

  // ---- Active ----
  if (active.length === 0) {
    html += `
      <div class="card empty-card">
        <div class="empty-title">No open-month files</div>
        <div class="empty-sub">Closed-month financials are still available in the Archive below.</div>
      </div>`;
  } else {
    for (const [period, files] of activeByPeriod) {
      html += renderPeriodGroup(period, files, /* archived */ false);
    }
  }

  // ---- Archive ----
  if (archived.length > 0) {
    html += `
      <div class="archive-section">
        <div class="archive-toggle" id="archiveToggle">
          <span class="chev">▶</span>
          <span>Archive · ${archived.length} ${archived.length === 1 ? 'file' : 'files'}</span>
        </div>
        <div class="archive-body" id="archiveBody">`;
      for (const [period, files] of archivedByPeriod) {
        html += renderPeriodGroup(period, files, /* archived */ true);
      }
    html += `
        </div>
      </div>`;
  }

  container.innerHTML = html;

  // Bind archive toggle
  const toggle = document.getElementById('archiveToggle');
  const body = document.getElementById('archiveBody');
  if (toggle && body) {
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('is-open');
      body.classList.toggle('is-open');
    });
  }

  // Bind the Send notification button if the banner is showing.
  const notifyBtn = document.getElementById('notifySendBtn');
  if (notifyBtn) {
    notifyBtn.addEventListener('click', () => sendNotification(notifyBtn));
  }

  // Bind row actions
  container.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => handleRowAction(e, el));
  });

  // If a file was expanded before re-render, expand it again
  if (state.expandedFileId) {
    const f = state.files.find((x) => x.id === state.expandedFileId);
    if (f) expandFile(f, /* scrollTo */ false);
    else state.expandedFileId = null;
  }
}

function renderPeriodGroup(period, files, archived) {
  // Stable order within a period: by file_type, then created_at
  const order = ['pl', 'pl_detail', 'prime_sheet', 'balance_sheet', 'other'];
  files.sort((a, b) => {
    const ta = order.indexOf(a.file_type), tb = order.indexOf(b.file_type);
    if (ta !== tb) return ta - tb;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  // Period close/reopen happens in Triple, not the portal. The portal stays
  // focused on uploading and viewing files; bookkeeping workflow stays elsewhere.
  return `
    <div class="period-group">
      <div class="period-group-header">
        <div class="period-group-title">${formatPeriodLabel(period)}</div>
        <div style="display:flex; align-items:center; gap:.5rem">
          <div class="period-group-meta">${files.length} ${files.length === 1 ? 'file' : 'files'}</div>
        </div>
      </div>
      ${files.map(renderFileRow).join('')}
    </div>`;
}

function renderFileRow(f) {
  const isXlsx = /\.xlsx?$/i.test(f.filename);
  const previewBtn = isXlsx
    ? `<button class="icon-btn" data-action="preview" data-id="${f.id}" title="Preview">👁</button>`
    : '';
  const deleteBtn = state.isTeam
    ? `<button class="icon-btn" data-action="delete" data-id="${f.id}" title="Delete">🗑</button>`
    : '';
  // Per-file "Notify client" toggle (team only, active files only). When the
  // file is already queued for notification, the button reads "✓ Will notify"
  // and looks active so it's visually distinct. Clicking either way flips the
  // pending_notification flag in the DB and the banner re-renders.
  const notifyBtn = (state.isTeam && !f.is_archived)
    ? (f.pending_notification
        ? `<button class="btn btn-sm" data-action="toggle-notify" data-id="${f.id}" style="background:#fff7ed;color:#7a3e0a;border:1px solid #f5c89a" title="Click to remove from next notification">✓ Will notify</button>`
        : `<button class="btn btn-ghost btn-sm" data-action="toggle-notify" data-id="${f.id}" title="Include in next client notification email">Notify client</button>`)
    : '';

  // "Parse P&L" button (team only, P&L files only, active files only). Triggers
  // the xlsx parser + mapping review modal flow. Clicking opens a modal so the
  // team can confirm category assignments before the data is written to pnl_data.
  const parseBtn = (state.isTeam && !f.is_archived && f.file_type === 'pl')
    ? `<button class="btn btn-ghost btn-sm" data-action="parse-pl" data-id="${f.id}" title="Parse this P&L into chart data">Parse P&L</button>`
    : '';

  return `
    <div class="file-row" id="row-${f.id}">
      <div>
        <div class="file-name">${escapeHtml(f.filename)}</div>
        <div class="file-meta">
          <span class="file-type-tag ${f.file_type}">${typeLabel(f.file_type)}</span>
          · ${formatBytes(f.size_bytes)}
          · uploaded ${formatDate(f.created_at)}
        </div>
      </div>
      <div></div>
      <div></div>
      <div class="actions">
        ${parseBtn}
        ${notifyBtn}
        ${previewBtn}
        <button class="icon-btn" data-action="download" data-id="${f.id}" title="Download">⬇</button>
        ${deleteBtn}
      </div>
    </div>
    <div class="xlsx-preview-host" id="preview-host-${f.id}"></div>`;
}

// =====================================================================
// ROW ACTIONS
// =====================================================================

async function handleRowAction(e, el) {
  const action = el.dataset.action;
  const id = el.dataset.id;
  const period = el.dataset.period;

  switch (action) {
    case 'download':       return downloadFile(id);
    case 'preview':        return togglePreview(id);
    case 'delete':         return deleteFile(id);
    case 'toggle-notify':  return toggleFileNotify(id);
    case 'parse-pl':       return openParseModal(id);
  }
}

// Flip pending_notification on a single file. Used by the per-row "Notify client"
// button so the team can add or remove a file from the next batch notification
// after it's already been uploaded.
async function toggleFileNotify(id) {
  const f = state.files.find((x) => x.id === id);
  if (!f) return;
  const next = !f.pending_notification;
  const { error } = await sb.from('files').update({ pending_notification: next }).eq('id', id);
  if (error) {
    alert("Couldn't update notification flag: " + error.message);
    return;
  }
  // Patch local cache + re-render so the banner count and button label update
  // immediately, without a round trip.
  f.pending_notification = next;
  renderFileList();
}

async function downloadFile(id) {
  const f = state.files.find((x) => x.id === id);
  if (!f) return;
  try {
    const { data, error } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(f.storage_path, 60); // 60 second signed URL
    if (error) throw error;
    // Open in new tab; browser handles the download based on content type
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = f.filename;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    console.error('download failed:', err);
    alert(`Couldn't generate download link: ${err.message || err}`);
  }
}

async function togglePreview(id) {
  const f = state.files.find((x) => x.id === id);
  if (!f) return;
  if (state.expandedFileId === id) {
    // collapse
    state.expandedFileId = null;
    deactivateCommenting();
    const host = document.getElementById(`preview-host-${id}`);
    if (host) host.innerHTML = '';
    return;
  }
  // collapse any existing preview first
  if (state.expandedFileId) {
    deactivateCommenting();
    const oldHost = document.getElementById(`preview-host-${state.expandedFileId}`);
    if (oldHost) oldHost.innerHTML = '';
  }
  state.expandedFileId = id;
  await expandFile(f, /* scrollTo */ true);
}

async function expandFile(f, scrollTo) {
  const host = document.getElementById(`preview-host-${f.id}`);
  if (!host) return;
  host.innerHTML = '<div class="state-msg"><span class="spinner"></span> Loading preview…</div>';

  try {
    const buffer = await downloadAsBuffer(f.storage_path);
    // SheetJS Community Edition reads values, number formats, and structure but
    // drops cell fills + font colors. We layer those back in with ExcelJS (free,
    // open-source), lazy-loaded only here so it never touches initial page load.
    // If ExcelJS fails to load, we fall back to the plain (color-less) render.
    const wb = XLSX.read(buffer, { type: 'array', cellStyles: true });
    let colorMaps = {};
    try {
      await ensureExcelJS();
      colorMaps = await buildColorMaps(buffer);
    } catch (e) {
      console.warn('Cell-color layer skipped:', e);
    }
    host.innerHTML = renderWorkbookHTML(wb, colorMaps);
    bindSheetTabs(host, wb, colorMaps);
    if (scrollTo) host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Layer the commenting UI on top of the rendered preview. Runs after
    // the host is populated; activateCommenting wraps the host contents in
    // a flex layout with a sidebar and fetches existing threads.
    await activateCommenting({
      host,
      fileId: f.id,
      currentUser: {
        id: state.userId,
        isTeam: state.isTeam,
        fullName: state.fullName,
      },
    });
  } catch (err) {
    console.error('preview failed:', err);
    host.innerHTML = `<div class="state-msg error">Couldn't preview this file: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function deleteFile(id) {
  const f = state.files.find((x) => x.id === id);
  if (!f) return;
  if (!confirm(`Delete "${f.filename}"? This cannot be undone.`)) return;

  try {
    // Remove from storage first (best-effort), then row
    await sb.storage.from(BUCKET).remove([f.storage_path]).catch(() => {});
    const { error } = await sb.from('files').delete().eq('id', id);
    if (error) throw error;
    state.files = state.files.filter((x) => x.id !== id);
    renderFileList();
  } catch (err) {
    console.error('delete failed:', err);
    alert(`Couldn't delete: ${err.message || err}`);
  }
}

// =====================================================================
// XLSX RENDERING (also used by kpi.js)
// =====================================================================

export async function downloadAsBuffer(storagePath) {
  const { data, error } = await sb.storage.from(BUCKET).download(storagePath);
  if (error) throw error;
  return await data.arrayBuffer();
}

// =====================================================================
// CELL COLOR LAYER (ExcelJS)
// SheetJS CE drops cell fills + font colors on read. We re-read the same bytes
// with ExcelJS purely to recover those colors, key them by cell address, and
// inject them into the rendered table. ExcelJS is lazy-loaded so it never
// affects initial page load.
// =====================================================================

let _exceljsPromise = null;
function ensureExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  if (_exceljsPromise) return _exceljsPromise;
  _exceljsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { _exceljsPromise = null; reject(new Error('Failed to load ExcelJS')); };
    document.head.appendChild(s);
  });
  return _exceljsPromise;
}

// Default Office theme palette, indexed the way Excel stores the `theme`
// attribute (0=lt1, 1=dk1, 2=lt2, 3=dk2, 4..9=accent1..6, 10=hlink, 11=folHlink).
const THEME_COLORS = ['FFFFFF','000000','E7E6E6','44546A','4472C4','ED7D31','A5A5A5','FFC000','5B9BD5','70AD47','0563C1','954F72'];
// Legacy 56-color indexed palette (the subset that actually shows up in practice).
const INDEXED_COLORS = {
  0:'000000',1:'FFFFFF',2:'FF0000',3:'00FF00',4:'0000FF',5:'FFFF00',6:'FF00FF',7:'00FFFF',
  8:'000000',9:'FFFFFF',10:'FF0000',11:'00FF00',12:'0000FF',13:'FFFF00',14:'FF00FF',15:'00FFFF',
  16:'800000',17:'008000',18:'000080',19:'808000',20:'800080',21:'008080',22:'C0C0C0',23:'808080',
  24:'9999FF',25:'993366',26:'FFFFCC',27:'CCFFFF',28:'660066',29:'FF8080',30:'0066CC',31:'CCCCFF',
  32:'000080',33:'FF00FF',34:'FFFF00',35:'00FFFF',36:'800080',37:'800000',38:'008080',39:'0000FF',
  40:'00CCFF',41:'CCFFFF',42:'CCFFCC',43:'FFFF99',44:'99CCFF',45:'FF99CC',46:'CC99FF',47:'FFCC99',
  48:'3366FF',49:'33CCCC',50:'99CC00',51:'FFCC00',52:'FF9900',53:'FF6600',54:'666699',55:'969696',
  56:'003366',57:'339966',58:'003300',59:'333300',60:'993300',61:'993366',62:'333399',63:'333333'
};

function clampByte(x) { return Math.max(0, Math.min(255, Math.round(x))); }
function toHex2(x) { return clampByte(x).toString(16).padStart(2, '0').toUpperCase(); }

// OOXML tint: negative darkens, positive lightens. Per-channel linear approx of
// the spec's HSL-luminance method — visually close for the small tints QBO uses.
function applyTint(hex, tint) {
  if (!hex) return null;
  if (!tint) return hex;
  const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  const adj = (ch) => tint < 0 ? ch * (1 + tint) : ch * (1 - tint) + 255 * tint;
  return toHex2(adj(r)) + toHex2(adj(g)) + toHex2(adj(b));
}

// ExcelJS color object -> 'RRGGBB' (no #), or null for default/auto/unknown.
function resolveColor(col) {
  if (!col) return null;
  if (col.argb) { const a = String(col.argb); return a.length === 8 ? a.slice(2) : a; }
  if (typeof col.theme === 'number') return applyTint(THEME_COLORS[col.theme] || null, col.tint);
  if (typeof col.indexed === 'number') {
    if (col.indexed === 64 || col.indexed === 65) return null; // automatic fg/bg
    return INDEXED_COLORS[col.indexed] || null;
  }
  return null;
}

function fillToHex(fill) {
  if (!fill || fill.type !== 'pattern' || fill.pattern === 'none') return null;
  const hex = resolveColor(fill.fgColor); // solid fills render the fgColor
  if (!hex || hex.toUpperCase() === 'FFFFFF') return null; // white == no visible fill
  return '#' + hex;
}

function fontToHex(font) {
  if (!font || !font.color) return null;
  const hex = resolveColor(font.color);
  if (!hex || hex.toUpperCase() === '000000') return null; // default text -> leave to CSS
  return '#' + hex;
}

// Re-read the workbook bytes with ExcelJS; return { sheetName: { 'A1': {bg,fg} } }
// containing only cells that carry a non-default fill or font color.
async function buildColorMaps(buffer) {
  const ewb = new ExcelJS.Workbook();
  await ewb.xlsx.load(buffer.slice(0));
  const maps = {};
  ewb.eachSheet((ws) => {
    const m = {};
    ws.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const bg = fillToHex(cell.fill);
        const fg = fontToHex(cell.font);
        if (bg || fg) m[cell.address] = { bg, fg };
      });
    });
    maps[ws.name] = m;
  });
  return maps;
}

export function renderWorkbookHTML(wb, colorMaps = {}) {
  const sheetNames = wb.SheetNames;
  if (sheetNames.length === 0) return '<div class="state-msg">Empty workbook.</div>';

  // Sheet tabs (only show if >1 sheet)
  let html = '';
  if (sheetNames.length > 1) {
    html += '<div class="sheet-tabs">';
    sheetNames.forEach((name, i) => {
      html += `<button class="sheet-tab ${i === 0 ? 'active' : ''}" data-sheet="${escapeAttr(name)}">${escapeHtml(name)}</button>`;
    });
    html += '</div>';
  }

  // Render first sheet
  html += '<div class="xlsx-preview" id="xlsxPreviewBody">' + sheetToHTML(wb.Sheets[sheetNames[0]], colorMaps[sheetNames[0]]) + '</div>';
  return html;
}

export function bindSheetTabs(host, wb, colorMaps = {}) {
  const tabs = host.querySelectorAll('.sheet-tab');
  const body = host.querySelector('#xlsxPreviewBody');
  if (!tabs.length || !body) return;
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const name = t.dataset.sheet;
      body.innerHTML = sheetToHTML(wb.Sheets[name], colorMaps[name]);
    });
  });
}

function sheetToHTML(sheet, colorMap) {
  if (!sheet) return '<div class="state-msg">Empty sheet.</div>';
  // sheet_to_html emits a <table> with cell `style` attributes when the
  // workbook was read with cellStyles:true. We strip the <html><body>
  // wrappers but keep all inline styling, since that's where formatting lives.
  let raw = XLSX.utils.sheet_to_html(sheet, {
    editable: false,
    header: '',
    footer: '',
  });
  const m = raw.match(/<table[\s\S]*<\/table>/i);
  let table = m ? m[0] : raw;

  // QBO P&L files indent account hierarchy via leading spaces in the cell
  // text. Browsers collapse runs of whitespace by default, flattening the
  // hierarchy. Force a "preserve leading whitespace" treatment on every td.
  table = table.replace(/(<td[^>]*>)((?:\s|&nbsp;)+)/g, (full, openTag, leading) => {
    const spaceCount = leading.replace(/&nbsp;/g, ' ').length;
    return openTag + '&nbsp;'.repeat(spaceCount);
  });

  // Single-pass row transformation. For each row we:
  //   1. Classify the label (first cell) to decide row treatment:
  //        - Major section grand totals (Total Income / Total COGS / etc.)
  //          → xlsx-row-grandtotal (stronger emphasis)
  //        - Other "Total ", "Net ", "Gross " rows → xlsx-row-subtotal
  //        - Section headers (Income / Expenses / etc.) → xlsx-row-section
  //        - Parent-only header rows (no values in any column) → xlsx-row-parent
  //          (de-emphasized — they're navigation only)
  //   2. If all month cells are empty, blank the Total column too — QBO emits
  //      "0.00" there even when there's nothing to total, which looks like
  //      spurious zeros to the reader.
  //   3. Reformat negative numbers in parens (accounting style) per QBO
  //      convention. -4,863.26 → (4,863.26).
  //
  // Major-section grand totals: hard-coded list of the labels QBO uses for
  // the top-level closing totals. These deserve stronger visual weight than
  // sub-subtotals like "Total 5100 Food COGS".
  const GRAND_TOTAL_LABELS = new Set([
    'Total Income',
    'Total Cost of Goods Sold',
    'Total Expenses',
    'Total Other Income',
    'Total Other Expenses',
    'Gross Profit',
    'Net Operating Income',
    'Net Other Income',
    'Net Income',
  ]);

  // Only the FIRST month-header row gets frozen to the top. This flag makes
  // sure we tag exactly one row even if month-like text recurs further down.
  let headerTagged = false;

  table = table.replace(/<tr([^>]*)>([\s\S]*?)<\/tr>/g, (full, trAttrs, inner) => {
    // Pull out each <td> in document order so we can analyze and rewrite them.
    const cellMatches = [...inner.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
    if (cellMatches.length === 0) return full;

    // Helper: strip tags + nbsp to plain text for analysis.
    // isBlank tests for truly empty (no content) cells. Zero-valued cells
    // ($0.00, 0, 0.00) are real values for a real account and should NOT
    // trigger the "parent header" classification or hide the Total column.
    const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    const isBlank = (text) => text === '';

    const labelText = plain(cellMatches[0][2]);
    // Month value cells = the columns BETWEEN the label and the right-hand Total.
    // A single-month QBO P&L has none of these (just Label + Total), so this slice
    // is empty. Guard against [].every() === true, which would otherwise judge
    // every row "all blank" and wipe the Total — the only value on a single-month
    // sheet — leaving account names with no numbers.
    const totalCell = cellMatches[cellMatches.length - 1];
    const monthCells = cellMatches.slice(1, -1);
    const monthsAllBlank = monthCells.length > 0 && monthCells.every((c) => isBlank(plain(c[2])));
    // A true parent/header row has no value anywhere: every month blank (or there
    // are no month columns) AND a blank Total.
    const noValuesAnywhere =
      (monthCells.length === 0 || monthCells.every((c) => isBlank(plain(c[2])))) &&
      cellMatches.length > 1 && isBlank(plain(totalCell[2]));

    // Classify the row
    let extraClass = '';
    if (GRAND_TOTAL_LABELS.has(labelText)) {
      extraClass = 'xlsx-row-grandtotal';
    } else if (/^(Total |Net |Gross )/.test(labelText)) {
      extraClass = 'xlsx-row-subtotal';
    } else if (/^(Income|Expenses|Cost of Goods Sold|Other Income|Other Expenses)$/.test(labelText)) {
      extraClass = 'xlsx-row-section';
    } else if (labelText !== '' && noValuesAnywhere) {
      // A non-empty label with all-empty values is a parent section header
      // that QBO inserts above its children (e.g. "4900 Discounts and Refunds"
      // sitting above its sub-accounts). De-emphasize.
      extraClass = 'xlsx-row-parent';
    }

    // Detect the month-header row: a blank label cell whose value cells are
    // month-year labels ("Jan 2025", "Feb 2025", …). Tag the first such row
    // so CSS can freeze it to the top on vertical scroll. Require at least two
    // month-like hits so a stray text cell can't masquerade as the header.
    if (!extraClass && !headerTagged) {
      const monthLike = (t) => /^[A-Za-z]{3,9}\.?\s*'?\d{2,4}$/.test(t);
      const monthHits = monthCells.filter((c) => monthLike(plain(c[2]))).length;
      if (isBlank(labelText) && monthHits >= 2) {
        extraClass = 'xlsx-row-header';
        headerTagged = true;
      }
    }

    // Rewrite each cell:
    //   - Negative numbers → accounting parens
    //   - Total cell → blank if all months empty
    const rewriteNeg = (html) => html.replace(/(>|^|\s)-([\d,]+\.\d{2})/g, '$1($2)');
    const rewrittenCells = cellMatches.map((c, idx) => {
      const [_, attrs, content] = c;
      let newContent = rewriteNeg(content);
      // Blank the Total cell only on multi-month rows whose month columns are all
      // empty (a QBO stray total on a header row). Never on single-month sheets,
      // where the Total column holds the actual values.
      if (idx === cellMatches.length - 1 && monthsAllBlank) {
        newContent = '';
      }
      return `<td${attrs}>${newContent}</td>`;
    });
    let newInner = rewrittenCells.join('');

    if (extraClass) {
      const newTrAttrs = trAttrs.includes('class=')
        ? trAttrs.replace(/class="([^"]*)"/, `class="$1 ${extraClass}"`)
        : `${trAttrs} class="${extraClass}"`;
      return `<tr${newTrAttrs}>${newInner}</tr>`;
    }
    return `<tr${trAttrs}>${newInner}</tr>`;
  });

  // Color layer: apply QBO's cell fills + font colors (recovered via ExcelJS,
  // keyed by the sjs-<address> id that sheet_to_html stamps on every <td>).
  // Only non-default colors are present in the map, so default rows keep their
  // existing row-class styling untouched.
  if (colorMap) {
    table = table.replace(/<td([^>]*)>/g, (full, attrs) => {
      const m = attrs.match(/id="sjs-([A-Z]+\d+)"/);
      if (!m) return full;
      const c = colorMap[m[1]];
      if (!c || (!c.bg && !c.fg)) return full;
      const style = `${c.bg ? `background:${c.bg};` : ''}${c.fg ? `color:${c.fg};` : ''}`;
      if (/style="/.test(attrs)) {
        return `<td${attrs.replace(/style="([^"]*)"/, (s, inner) => `style="${inner};${style}"`)}>`;
      }
      return `<td${attrs} style="${style}">`;
    });
  }

  return table;
}

// =====================================================================
// UTILITIES
// =====================================================================

function groupByPeriod(files) {
  const m = new Map();
  for (const f of files) {
    if (!m.has(f.period)) m.set(f.period, []);
    m.get(f.period).push(f);
  }
  // Map preserves insertion order; files arrive already sorted period desc
  return m;
}

function typeLabel(t) {
  return {
    pl: 'P&L',
    pl_detail: 'P&L Detail',
    prime_sheet: 'Prime Sheet',
    balance_sheet: 'Balance Sheet',
    other: 'Other',
  }[t] || 'Other';
}

function formatPeriodLabel(period) {
  // 'YYYY-MM' → 'April 2026'
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function formatBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject({ code: 'TIMEOUT', message: 'Timed out' }), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); },
                 (e) => { clearTimeout(timer); reject(e); });
  });
}

function retryHtml(msg) {
  return `
    <div class="retry-state">
      <div>${escapeHtml(msg)}</div>
      <button class="btn btn-ghost btn-sm" id="retryBtn">Retry</button>
    </div>`;
}
function bindRetry(fn) {
  const btn = document.getElementById('retryBtn');
  if (btn) btn.addEventListener('click', fn);
}

// =====================================================================
// P&L PARSE MODAL
// =====================================================================
// Triggered from the per-file "Parse P&L" button. Flow:
//   1. Download the xlsx from storage
//   2. Run parsePnlWorkbook → extracts months + accounts
//   3. fetchMappings (global + per-client) and run matchAccounts
//   4. Render a modal showing every account row with its category dropdown.
//      Unmatched rows surface at the top.
//   5. On Save: persist any category edits as per-client mappings, then write
//      all rows to pnl_data via persistPnlData. Replaces existing rows for
//      the parsed months — so re-parses always supersede cleanly.
// All categories the chart engine cares about, listed once so the dropdown
// in the modal shows the same options everywhere.
const PNL_CATEGORIES = [
  // Sales
  { value: 'food_sales',         label: 'Food Sales' },
  { value: 'liquor_sales',       label: 'Liquor Sales' },
  { value: 'beer_sales',         label: 'Beer Sales' },
  { value: 'wine_sales',         label: 'Wine Sales' },
  { value: 'na_bev_sales',       label: 'NA Beverages Sales' },
  { value: 'merchandise_sales',  label: 'Merchandise / Retail Sales' },
  { value: 'other_sales',        label: 'Other Sales' },
  { value: 'amusement_sales',    label: 'Amusement / Golf Sales' },
  { value: 'events_sales',       label: 'Events / Banquet Sales' },
  { value: 'deli_sales',         label: 'Deli & Bakery Sales' },
  { value: 'cafe_sales',         label: 'Cafe Sales' },
  { value: 'grocery_sales',      label: 'Grocery Sales' },
  { value: 'produce_sales',      label: 'Produce & Floral Sales' },
  { value: 'cheese_sales',       label: 'Cheese & Charcuterie Sales' },
  { value: 'meat_sales',         label: 'Meat & Seafood Sales' },
  { value: 'bodycare_sales',     label: 'Body Care & Health Sales' },
  { value: 'housewares_sales',   label: 'Housewares & Other Sales' },
  { value: 'smoke_sales',        label: 'Smoke (CBD/Tobacco) Sales' },
  { value: 'discounts',          label: 'Discounts / Refunds' },
  // COGS
  { value: 'food_cogs',          label: 'Food COGS' },
  { value: 'liquor_cogs',        label: 'Liquor COGS' },
  { value: 'beer_cogs',          label: 'Beer COGS' },
  { value: 'wine_cogs',          label: 'Wine COGS' },
  { value: 'na_bev_cogs',        label: 'NA Beverages COGS' },
  { value: 'merchandise_cogs',   label: 'Merchandise / Retail COGS' },
  { value: 'deli_cogs',          label: 'Deli & Bakery COGS' },
  { value: 'cafe_cogs',          label: 'Cafe COGS' },
  { value: 'grocery_cogs',       label: 'Grocery COGS' },
  { value: 'produce_cogs',       label: 'Produce & Floral COGS' },
  { value: 'cheese_cogs',        label: 'Cheese & Charcuterie COGS' },
  { value: 'meat_cogs',          label: 'Meat & Seafood COGS' },
  { value: 'bodycare_cogs',      label: 'Body Care & Health COGS' },
  { value: 'housewares_cogs',    label: 'Housewares & Other COGS' },
  { value: 'smoke_cogs',         label: 'Smoke (CBD/Tobacco) COGS' },
  { value: 'other_cogs',         label: 'Other COGS' },
  // Labor
  { value: 'labor_boh',          label: 'Labor — BOH' },
  { value: 'labor_foh',          label: 'Labor — FOH' },
  { value: 'labor_management',   label: 'Labor — Management' },
  { value: 'labor_other',        label: 'Labor — Other' },
  { value: 'labor_benefits',     label: 'Labor — Benefits' },
  { value: 'payroll_taxes',      label: 'Payroll Taxes' },
  // Ops
  { value: 'operating_expense',  label: 'Operating Expense' },
  { value: 'other_income',       label: 'Other Income' },
  // Ignore (excluded from any aggregation)
  { value: 'ignore',             label: '— Ignore this account —' },
];

// In-memory state for the active parse session. Cleared when the modal closes.
let parseSession = null;

// Identity of an account across class columns (by-Class files emit the same
// account once per class). Used to dedupe the review modal and to apply a
// single category override to every class on save.
function pnlAcctKey(r) { return (r.account_number || '') + '|' + r.account_name; }

async function openParseModal(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f) return alert("File not found");

  // 1. Download
  let buf;
  try {
    buf = await downloadAsBuffer(f.storage_path);
  } catch (e) {
    return alert("Couldn't read file: " + (e.message || e));
  }

  // 2. Fetch mappings, then parse + categorize per format.
  const mappings = await fetchMappings(state.clientId);
  try {
    if (detectPnlFormat(buf) === 'by_class') {
      // P&L by Class: parse each class column as its own account hierarchy and
      // categorize it independently (inheritance + leaf filter run per class),
      // then tag each row with its class.
      const parsed = parsePnlByClass(buf);
      const rows = [];
      for (const cls of parsed.classes) {
        const cat = matchAccounts(parsed.rowsByClass[cls], mappings, state.clientId);
        cat.forEach((rw) => rows.push({ ...rw, class: cls }));
      }
      parseSession = {
        file: f, months: [parsed.period], classes: parsed.classes,
        byClass: true, rows, overrides: {},  // overrides keyed by account key
      };
    } else {
      const parsed = parsePnlWorkbook(buf);
      const rowsWithCat = matchAccounts(parsed.rows, mappings, state.clientId);
      parseSession = {
        file: f, months: parsed.months, byClass: false,
        rows: rowsWithCat, overrides: {},  // overrides keyed by row index
      };
    }
  } catch (e) {
    return alert("Couldn't parse P&L: " + (e.message || e));
  }
  injectAndShowModal();
}

function closeParseModal() {
  parseSession = null;
  const m = document.getElementById('pnlParseModal');
  if (m) m.remove();
}

// Build the modal HTML once per open and inject into <body>. We do it this
// way instead of a static markup block so financials.js stays self-contained
// (no changes to index.html required for this feature).
function injectAndShowModal() {
  // Remove any stale modal first
  const old = document.getElementById('pnlParseModal');
  if (old) old.remove();

  const { file, months, rows, byClass } = parseSession;
  const periodRange = months.length === 1 ? months[0] : `${months[0]} → ${months[months.length - 1]}`;
  const sampleMonth = months[months.length - 1];

  // Build review rows. Standard files: one row per parsed account, keyed by
  // index. By-Class files emit each account once per class, so dedupe to one
  // row per account (keyed by account identity); the sample column sums the
  // account across all classes and an override applies to every class on save.
  let viewRows;
  if (byClass) {
    const byKey = new Map();
    rows.forEach((r) => {
      const key = pnlAcctKey(r);
      if (!byKey.has(key)) {
        byKey.set(key, { _key: key, account_number: r.account_number,
          account_name: r.account_name, category: r.category, _sample: 0 });
      }
      byKey.get(key)._sample += (r.amounts[sampleMonth] || 0);
    });
    viewRows = [...byKey.values()];
  } else {
    viewRows = rows.map((r, i) => ({ _key: i, account_number: r.account_number,
      account_name: r.account_name, category: r.category, _sample: r.amounts[sampleMonth] || 0 }));
  }

  const unmatchedCount = viewRows.filter((r) => !r.category).length;

  // Sort: unmatched first, then by account number.
  const ordered = [...viewRows].sort((a, b) => {
    const am = !a.category ? 0 : 1, bm = !b.category ? 0 : 1;
    if (am !== bm) return am - bm;
    return (a.account_number || '~').localeCompare(b.account_number || '~');
  });

  const rowsHtml = ordered.map((row) => {
    const isUnmatched = !row.category;
    const select = `<select class="pnl-cat-select" data-key="${escapeHtml(String(row._key))}">
      <option value="">— unmapped —</option>
      ${PNL_CATEGORIES.map((c) => `<option value="${c.value}"${row.category === c.value ? ' selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
    </select>`;
    return `<tr class="${isUnmatched ? 'pnl-row-unmatched' : ''}">
      <td class="pnl-acct-num">${escapeHtml(row.account_number || '—')}</td>
      <td class="pnl-acct-name">${escapeHtml(row.account_name)}</td>
      <td class="pnl-sample">${formatMoney(row._sample)}</td>
      <td>${select}</td>
    </tr>`;
  }).join('');

  const subInfo = byClass
    ? `${parseSession.classes.length} classes · ${escapeHtml(months[0])} · ${viewRows.length} accounts · `
    : `${months.length} month${months.length === 1 ? '' : 's'} (${periodRange}) · ${viewRows.length} accounts · `;
  const sampleHeader = byClass ? `${escapeHtml(months[0])} · all units` : escapeHtml(sampleMonth);
  const helpText = byClass
    ? `This is a P&amp;L <strong>by Class</strong>. Each account appears once; the amount sums all classes, and the category applies to every class. Per-class figures populate each restaurant's Prime Sheet (Alexander's, The Shed).`
    : `Review the category assignments below. Any changes you make are saved as rules for this client (next time, the same account auto-maps the same way). Unmapped rows are listed first. Set to <em>— Ignore this account —</em> to exclude an account from all charts.`;

  const html = `
    <div id="pnlParseModal" class="pnl-modal-backdrop">
      <div class="pnl-modal">
        <div class="pnl-modal-header">
          <div>
            <div class="pnl-modal-title">Parse P&amp;L: ${escapeHtml(file.filename)}</div>
            <div class="pnl-modal-sub">
              ${subInfo}
              ${unmatchedCount > 0 ? `<strong style="color:var(--red)">${unmatchedCount} unmapped</strong>` : `<span style="color:var(--green)">all mapped</span>`}
            </div>
          </div>
          <button class="icon-btn" id="pnlParseClose" title="Close">✕</button>
        </div>
        <div class="pnl-modal-body">
          <div class="pnl-help">${helpText}</div>
          <table class="pnl-review-table">
            <thead>
              <tr>
                <th style="width:80px">#</th>
                <th>Account Name</th>
                <th style="width:140px;text-align:right">${sampleHeader}</th>
                <th style="width:220px">Category</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <div class="pnl-modal-footer">
          <button class="btn btn-ghost" id="pnlParseCancel">Cancel</button>
          <button class="btn btn-primary" id="pnlParseSave">Save &amp; Apply</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', html);

  // Wire events
  document.getElementById('pnlParseClose').addEventListener('click', closeParseModal);
  document.getElementById('pnlParseCancel').addEventListener('click', closeParseModal);
  document.getElementById('pnlParseSave').addEventListener('click', saveParseSession);
  // Capture dropdown changes into overrides (key is row index, or account key
  // for by-Class files).
  document.querySelectorAll('.pnl-cat-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const rawKey = e.target.dataset.key;
      const key = parseSession.byClass ? rawKey : parseInt(rawKey, 10);
      parseSession.overrides[key] = e.target.value || null;  // '' → null (unmapped)
    });
  });
}

async function saveParseSession() {
  if (!parseSession) return;
  const saveBtn = document.getElementById('pnlParseSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    const { file, months, rows, overrides, byClass } = parseSession;

    // 1. Apply overrides. Standard files key overrides by row index; by-Class
    //    files key by account identity, and the override applies to every class.
    const finalRows = byClass
      ? rows.map((r) => ({ ...r, category: (pnlAcctKey(r) in overrides) ? overrides[pnlAcctKey(r)] : r.category }))
      : rows.map((r, i) => ({ ...r, category: (i in overrides) ? overrides[i] : r.category }));

    // 2. Persist genuine overrides as per-client coa_mappings so future parses
    //    auto-apply them. Skipped for by-Class files (overrides there are keyed
    //    by account identity and apply straight to pnl_data; the Inn's mapping
    //    rules are seeded via SQL).
    if (!byClass) {
    const overrideEntries = Object.entries(overrides).filter(([k, v]) => {
      const orig = rows[k].category;
      return v !== orig;  // only persist genuine overrides
    });
    if (overrideEntries.length > 0) {
      // Build mapping inserts. Accounts WITH a number → save as number_exact;
      // accounts WITHOUT a number → save as name_contains so we can match
      // them by name on future parses. Either way, priority 10 (client-specific
      // beats global rules).
      const numberRules = [];
      const nameRules = [];
      for (const [k, v] of overrideEntries) {
        const row = rows[k];
        if (!v) continue;  // no category → don't write a "to unmapped" rule
        if (row.account_number) {
          numberRules.push({
            client_id: state.clientId,
            account_match: row.account_number,
            match_type: 'number_exact',
            category: v,
            priority: 10,
          });
        } else {
          nameRules.push({
            client_id: state.clientId,
            account_match: row.account_name,
            match_type: 'name_contains',
            category: v,
            priority: 10,
          });
        }
      }
      // Delete any prior client-specific rules for these account refs so the
      // override cleanly replaces rather than stacking.
      if (numberRules.length > 0) {
        const acctNums = numberRules.map((m) => m.account_match);
        const { error: delErr } = await sb
          .from('coa_mappings')
          .delete()
          .eq('client_id', state.clientId)
          .in('account_match', acctNums)
          .eq('match_type', 'number_exact');
        if (delErr) throw new Error('Failed to clear old number rules: ' + delErr.message);
      }
      if (nameRules.length > 0) {
        const names = nameRules.map((m) => m.account_match);
        const { error: delErr } = await sb
          .from('coa_mappings')
          .delete()
          .eq('client_id', state.clientId)
          .in('account_match', names)
          .eq('match_type', 'name_contains');
        if (delErr) throw new Error('Failed to clear old name rules: ' + delErr.message);
      }
      const mappingInserts = [...numberRules, ...nameRules];
      if (mappingInserts.length > 0) {
        const { error: insErr } = await sb.from('coa_mappings').insert(mappingInserts);
        if (insErr) throw new Error('Failed to save per-client mappings: ' + insErr.message);
      }
    }
    }

    // 3. Persist the actual P&L data
    const result = await persistPnlData(state.clientId, finalRows, months, file.id);

    // 4. Success — close modal, flash success
    closeParseModal();
    const status = document.getElementById('uploadStatus');
    if (status) {
      setStatus(status, 'ok', `✓ Parsed ${months.length} months, ${result.inserted} data points written.`);
      setTimeout(() => { if (status.textContent.includes('✓')) setStatus(status, '', ''); }, 6000);
    } else {
      alert(`Parsed ${months.length} months, ${result.inserted} data points written.`);
    }
  } catch (e) {
    console.error('Parse save failed:', e);
    alert("Couldn't save: " + (e.message || e));
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save & Apply'; }
  }
}

function formatMoney(n) {
  if (n === 0) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}


// =====================================================================
// BALANCE SHEET (render-only) — team pulls from QuickBooks and publishes a
// snapshot; the client views the published snapshot. No structured storage.
// =====================================================================
let bsMonth = null;
function bsFirstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function bsAddMonths(d, k) { return new Date(d.getFullYear(), d.getMonth() + k, 1); }
function bsKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function bsMonthName(d) { return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function bsLastDay(d) { const e = new Date(d.getFullYear(), d.getMonth() + 1, 0); return e.getFullYear() + '-' + String(e.getMonth() + 1).padStart(2, '0') + '-' + String(e.getDate()).padStart(2, '0'); }
function bsEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function bsFmt(n) { return n == null ? '' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }

function renderBalanceSheetSection() {
  const pane = document.getElementById('tab-financials');
  if (!pane) return;
  if (!bsMonth) bsMonth = bsAddMonths(bsFirstOfMonth(new Date()), -1); // default: last closed month
  let sec = document.getElementById('bsSection');
  if (!sec) {
    sec = document.createElement('section');
    sec.className = 'card';
    sec.id = 'bsSection';
    sec.style.cssText = 'margin-top:18px';
    pane.appendChild(sec);
  }
  drawBsSection(sec);
}

function drawBsSection(sec) {
  const team = state.isTeam;
  sec.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">'
    + '<div style="font-weight:800;font-size:16px;color:var(--text)">Balance Sheet</div>'
    + '<div style="display:flex;align-items:center;gap:6px;margin-left:6px">'
    + '<button type="button" id="bsPrev" style="width:30px;height:30px;border:1px solid var(--border);background:var(--bg);border-radius:7px;cursor:pointer">\u2039</button>'
    + '<span id="bsLabel" style="font-weight:700;min-width:130px;text-align:center">' + bsMonthName(bsMonth) + '</span>'
    + '<button type="button" id="bsNext" style="width:30px;height:30px;border:1px solid var(--border);background:var(--bg);border-radius:7px;cursor:pointer">\u203a</button>'
    + '</div>'
    + (team ? '<button type="button" id="bsPull" style="margin-left:auto;border:1px solid #1B2A4B;background:#1B2A4B;color:#fff;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer">\u21ba Pull from QuickBooks</button>' : '')
    + '</div>'
    + '<div id="bsBody"><div style="color:var(--text3);font-size:13px;padding:6px 0">Loading\u2026</div></div>';
  sec.querySelector('#bsPrev').addEventListener('click', () => { bsMonth = bsAddMonths(bsMonth, -1); drawBsSection(sec); });
  sec.querySelector('#bsNext').addEventListener('click', () => { bsMonth = bsAddMonths(bsMonth, 1); drawBsSection(sec); });
  if (team) sec.querySelector('#bsPull').addEventListener('click', () => pullBs(sec));
  loadPublishedBs(sec);
}

async function loadPublishedBs(sec) {
  const body = sec.querySelector('#bsBody');
  if (!body) return;
  try {
    const r = await sb.from('bs_reports').select('rows,as_of,generated_at')
      .eq('client_id', state.clientId).eq('period', bsKey(bsMonth)).eq('published', true).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) {
      body.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:10px 0">'
        + (state.isTeam ? 'Nothing published for ' + bsMonthName(bsMonth) + ' yet. Pull it from QuickBooks above, then publish.'
                        : 'No balance sheet has been posted for ' + bsMonthName(bsMonth) + ' yet.') + '</div>';
      return;
    }
    body.innerHTML = renderBsRows(r.data.rows || [])
      + '<div style="font-size:11px;color:var(--text3);margin-top:8px">Published ' + (r.data.generated_at ? new Date(r.data.generated_at).toLocaleDateString() : '') + '</div>';
  } catch (e) {
    body.innerHTML = '<div style="color:#b93232;font-size:13px">Couldn\u2019t load: ' + bsEsc(e.message || e) + '</div>';
  }
}

async function pullBs(sec) {
  const btn = sec.querySelector('#bsPull');
  const body = sec.querySelector('#bsBody');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Pulling\u2026'; }
  body.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:6px 0">Pulling the balance sheet from QuickBooks\u2026</div>';
  try {
    const { data, error } = await sb.functions.invoke('qbo-bs', { body: { client_id: state.clientId, as_of: bsLastDay(bsMonth) } });
    if (error) throw new Error(error.message || 'request failed');
    if (data && data.error === 'not_connected') { body.innerHTML = '<div style="color:#b93232;font-size:13px">QuickBooks isn\u2019t connected for this client.</div>'; return; }
    if (data && data.error === 'reauth_needed') { body.innerHTML = '<div style="color:#b93232;font-size:13px">QuickBooks needs to be reconnected.</div>'; return; }
    if (!data || !data.ok) throw new Error((data && (data.message || data.error)) || 'no result');
    const rows = data.rows || [];
    body.innerHTML = renderBsRows(rows)
      + '<div style="display:flex;gap:12px;align-items:center;margin-top:14px">'
      + '<button type="button" id="bsPublish" style="border:0;background:#D85B31;color:#fff;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer">Publish for client</button>'
      + '<span id="bsPubMsg" style="font-size:12.5px;color:var(--text3)">Preview \u2014 not visible to the client until published.</span></div>';
    sec.querySelector('#bsPublish').addEventListener('click', () => publishBs(sec, rows, data.as_of));
  } catch (e) {
    body.innerHTML = '<div style="color:#b93232;font-size:13px">Couldn\u2019t pull: ' + bsEsc(e.message || e) + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

async function publishBs(sec, rows, asOf) {
  const btn = sec.querySelector('#bsPublish');
  const msg = sec.querySelector('#bsPubMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing\u2026'; }
  try {
    const { error } = await sb.from('bs_reports').upsert({
      client_id: state.clientId, period: bsKey(bsMonth), as_of: asOf,
      rows, generated_by: state.userId, generated_at: new Date().toISOString(), published: true,
    }, { onConflict: 'client_id,period' });
    if (error) throw error;
    if (msg) { msg.textContent = 'Published \u2014 the client can now see it.'; msg.style.color = '#1e7a45'; }
    if (btn) btn.textContent = 'Published \u2713';
  } catch (e) {
    if (msg) { msg.textContent = 'Error: ' + (e.message || e); msg.style.color = '#b93232'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Publish for client'; }
  }
}

function renderBsRows(rows) {
  const body = (rows || []).map((r) => {
    const pad = 10 + (r.indent || 0) * 16;
    const bold = r.kind !== 'account';
    const border = r.kind === 'total' ? 'border-top:1px solid var(--border)' : '';
    const color = r.kind === 'header' ? 'var(--navy)' : 'var(--text)';
    return '<tr style="' + border + '">'
      + '<td style="padding:5px 10px 5px ' + pad + 'px;' + (bold ? 'font-weight:700;' : '') + 'color:' + color + '">' + bsEsc(r.label) + '</td>'
      + '<td style="padding:5px 10px;text-align:right;' + (bold ? 'font-weight:700' : '') + '">' + bsFmt(r.amount) + '</td></tr>';
  }).join('');
  return '<table style="width:100%;border-collapse:collapse;font-size:13px;max-width:560px">' + body + '</table>';
}


// =====================================================================
// P&L DETAIL — team pulls transaction detail from QuickBooks and publishes it;
// client reviews, drills into each account line, and can leave a note on a
// line that the team responds to (a thread per account line).
// =====================================================================
let pdMonth = null;
function pdKey(acct) { return acct.account_number || acct.account_name || ''; }

function renderPnlDetailSection() {
  const pane = document.getElementById('tab-financials');
  if (!pane) return;
  if (!pdMonth) pdMonth = bsAddMonths(bsFirstOfMonth(new Date()), -1);
  let sec = document.getElementById('pdSection');
  if (!sec) {
    sec = document.createElement('section');
    sec.className = 'card'; sec.id = 'pdSection'; sec.style.cssText = 'margin-top:18px';
    pane.appendChild(sec);
  }
  drawPdSection(sec);
}

function drawPdSection(sec) {
  const team = state.isTeam;
  sec.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">'
    + '<div style="font-weight:800;font-size:16px;color:var(--text)">P&L Detail</div>'
    + '<div style="display:flex;align-items:center;gap:6px;margin-left:6px">'
    + '<button type="button" id="pdPrev" style="width:30px;height:30px;border:1px solid var(--border);background:var(--bg);border-radius:7px;cursor:pointer">\u2039</button>'
    + '<span style="font-weight:700;min-width:130px;text-align:center">' + bsMonthName(pdMonth) + '</span>'
    + '<button type="button" id="pdNext" style="width:30px;height:30px;border:1px solid var(--border);background:var(--bg);border-radius:7px;cursor:pointer">\u203a</button>'
    + '</div>'
    + (team ? '<button type="button" id="pdPull" style="margin-left:auto;border:1px solid #1B2A4B;background:#1B2A4B;color:#fff;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer">\u21ba Pull from QuickBooks</button>' : '')
    + '</div>'
    + '<div id="pdBody"><div style="color:var(--text3);font-size:13px;padding:6px 0">Loading\u2026</div></div>';
  sec.querySelector('#pdPrev').addEventListener('click', () => { pdMonth = bsAddMonths(pdMonth, -1); drawPdSection(sec); });
  sec.querySelector('#pdNext').addEventListener('click', () => { pdMonth = bsAddMonths(pdMonth, 1); drawPdSection(sec); });
  if (team) sec.querySelector('#pdPull').addEventListener('click', () => pullPd(sec));
  loadPublishedPd(sec);
}

async function loadNotesByKey() {
  const map = {};
  try {
    const r = await sb.from('pnl_detail_notes').select('*')
      .eq('client_id', state.clientId).eq('period', bsKey(pdMonth)).order('created_at', { ascending: true });
    (r.data || []).forEach((nt) => { (map[nt.account_key] = map[nt.account_key] || []).push(nt); });
  } catch (e) { /* notes are non-fatal */ }
  return map;
}

async function loadPublishedPd(sec) {
  const body = sec.querySelector('#pdBody');
  if (!body) return;
  try {
    const [rep, notes] = await Promise.all([
      sb.from('pnl_detail_reports').select('accounts,generated_at').eq('client_id', state.clientId).eq('period', bsKey(pdMonth)).eq('published', true).maybeSingle(),
      loadNotesByKey(),
    ]);
    if (rep.error) throw rep.error;
    if (!rep.data) {
      body.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:10px 0">'
        + (state.isTeam ? 'Nothing published for ' + bsMonthName(pdMonth) + ' yet. Pull it from QuickBooks above, then publish.'
                        : 'No P&L detail has been posted for ' + bsMonthName(pdMonth) + ' yet.') + '</div>';
      return;
    }
    renderPdAccounts(sec, rep.data.accounts || [], notes, false);
  } catch (e) {
    body.innerHTML = '<div style="color:#b93232;font-size:13px">Couldn\u2019t load: ' + bsEsc(e.message || e) + '</div>';
  }
}

async function pullPd(sec) {
  const btn = sec.querySelector('#pdPull');
  const body = sec.querySelector('#pdBody');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Pulling\u2026'; }
  body.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:6px 0">Pulling the P&L detail from QuickBooks\u2026</div>';
  try {
    const [y, mo] = bsKey(pdMonth).split('-').map(Number);
    const from = bsKey(pdMonth) + '-01';
    const to = bsLastDay(pdMonth);
    const { data, error } = await sb.functions.invoke('qbo-pnl-detail', { body: { client_id: state.clientId, from, to } });
    if (error) throw new Error(error.message || 'request failed');
    if (data && data.error === 'not_connected') { body.innerHTML = '<div style="color:#b93232;font-size:13px">QuickBooks isn\u2019t connected for this client.</div>'; return; }
    if (data && data.error === 'reauth_needed') { body.innerHTML = '<div style="color:#b93232;font-size:13px">QuickBooks needs to be reconnected.</div>'; return; }
    if (!data || !data.ok) throw new Error((data && (data.message || data.error)) || 'no result');
    const notes = await loadNotesByKey();
    renderPdAccounts(sec, data.accounts || [], notes, true);
  } catch (e) {
    body.innerHTML = '<div style="color:#b93232;font-size:13px">Couldn\u2019t pull: ' + bsEsc(e.message || e) + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

async function publishPd(sec, accounts) {
  const btn = sec.querySelector('#pdPublish');
  const msg = sec.querySelector('#pdPubMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing\u2026'; }
  try {
    const { error } = await sb.from('pnl_detail_reports').upsert({
      client_id: state.clientId, period: bsKey(pdMonth), accounts,
      generated_by: state.userId, generated_at: new Date().toISOString(), published: true,
    }, { onConflict: 'client_id,period' });
    if (error) throw error;
    if (msg) { msg.textContent = 'Published \u2014 the client can now review it.'; msg.style.color = '#1e7a45'; }
    if (btn) btn.textContent = 'Published \u2713';
  } catch (e) {
    if (msg) { msg.textContent = 'Error: ' + (e.message || e); msg.style.color = '#b93232'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Publish for client'; }
  }
}

function renderPdAccounts(sec, accounts, notesByKey, isPreview) {
  const body = sec.querySelector('#pdBody');
  const rowsHtml = accounts.map((a, i) => {
    const key = pdKey(a);
    const notes = notesByKey[key] || [];
    const openCount = notes.filter((nt) => !nt.resolved).length;
    return '<div class="pd-acct" data-i="' + i + '" style="border:1px solid var(--border);border-radius:8px;margin-bottom:6px;overflow:hidden">'
      + '<div class="pd-head" data-i="' + i + '" style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;background:var(--bg)">'
      + '<span class="pd-caret" style="color:var(--text3);width:12px">\u25b8</span>'
      + '<span style="flex:1;font-weight:600;font-size:13.5px">' + bsEsc(a.account_name) + '</span>'
      + (notes.length ? '<span style="font-size:11.5px;color:' + (openCount ? '#b93232' : 'var(--text3)') + '">\ud83d\udcac ' + notes.length + '</span>' : '')
      + '<span style="font-family:var(--font-display,inherit);font-weight:800;font-size:14px;color:var(--navy)">' + bsFmt(a.total) + '</span>'
      + '</div>'
      + '<div class="pd-body-x" data-i="' + i + '" hidden style="padding:0 12px 12px"></div>'
      + '</div>';
  }).join('');

  const pubBar = isPreview
    ? '<div style="display:flex;gap:12px;align-items:center;margin-top:14px"><button type="button" id="pdPublish" style="border:0;background:#D85B31;color:#fff;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer">Publish for client</button><span id="pdPubMsg" style="font-size:12.5px;color:var(--text3)">Preview \u2014 not visible to the client until published.</span></div>'
    : '';
  body.innerHTML = (accounts.length ? rowsHtml : '<div style="color:var(--text3);font-size:13px">No detail rows.</div>') + pubBar;

  if (isPreview) sec.querySelector('#pdPublish').addEventListener('click', () => publishPd(sec, accounts));

  body.querySelectorAll('.pd-head').forEach((h) => h.addEventListener('click', () => {
    const i = h.dataset.i;
    const bx = body.querySelector('.pd-body-x[data-i="' + i + '"]');
    const caret = h.querySelector('.pd-caret');
    if (bx.hidden) { bx.hidden = false; caret.textContent = '\u25be'; renderPdExpanded(bx, accounts[+i], notesByKey[pdKey(accounts[+i])] || []); }
    else { bx.hidden = true; caret.textContent = '\u25b8'; }
  }));
}

function renderPdExpanded(bx, acct, notes) {
  const txns = acct.txns || [];
  const txnHtml = txns.length ? ('<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px">'
    + '<thead><tr style="color:#888;font-size:10.5px;text-transform:uppercase"><th style="text-align:left;padding:4px 8px">Date</th><th style="text-align:left;padding:4px 8px">Type</th><th style="text-align:left;padding:4px 8px">Name</th><th style="text-align:left;padding:4px 8px">Memo</th><th style="text-align:right;padding:4px 8px">Amount</th></tr></thead><tbody>'
    + txns.map((t) => '<tr style="border-top:1px solid #f0f0f0">'
      + '<td style="padding:4px 8px;white-space:nowrap">' + bsEsc(t.date) + '</td>'
      + '<td style="padding:4px 8px">' + bsEsc(t.type) + (t.doc_num ? ' #' + bsEsc(t.doc_num) : '') + '</td>'
      + '<td style="padding:4px 8px">' + bsEsc(t.name) + '</td>'
      + '<td style="padding:4px 8px;color:#666">' + bsEsc(t.memo) + '</td>'
      + '<td style="padding:4px 8px;text-align:right">' + bsFmt(t.amount) + '</td></tr>').join('')
    + '</tbody></table>') : '<div style="font-size:12.5px;color:var(--text3);margin-top:8px">No transactions.</div>';

  bx.innerHTML = txnHtml + renderPdNotes(acct, notes);
  wirePdNotes(bx, acct);
}

function renderPdNotes(acct, notes) {
  const resolved = notes.length && notes.every((nt) => nt.resolved);
  const msgs = notes.map((nt) => {
    const who = nt.is_team ? 'Bald Ginger' : 'Client';
    const when = nt.created_at ? new Date(nt.created_at).toLocaleDateString() : '';
    return '<div style="padding:6px 0;border-top:1px solid #f2f2f2">'
      + '<div style="font-size:11px;color:#999"><b style="color:' + (nt.is_team ? '#1B2A4B' : '#8a6500') + '">' + bsEsc(who) + '</b>' + (nt.author_name ? ' \u00b7 ' + bsEsc(nt.author_name) : '') + ' \u00b7 ' + when + '</div>'
      + '<div style="font-size:13px;color:var(--text);margin-top:2px">' + bsEsc(nt.body) + '</div></div>';
  }).join('');
  return '<div class="pd-notes" style="margin-top:12px;padding:10px 12px;background:var(--warm,#f6f5ef);border-radius:8px">'
    + '<div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#888;margin-bottom:4px">Notes' + (resolved ? ' \u00b7 <span style="color:#1e7a45">Resolved</span>' : '') + '</div>'
    + (msgs || '<div style="font-size:12.5px;color:#999">No notes yet' + (state.isTeam ? '' : ' \u2014 leave a question and your bookkeeper will reply.') + '</div>')
    + '<div style="display:flex;gap:8px;align-items:flex-start;margin-top:8px">'
    + '<textarea class="pd-note-input" rows="1" placeholder="' + (state.isTeam ? 'Reply\u2026' : 'Ask about this line\u2026') + '" style="flex:1;border:1px solid var(--border);border-radius:7px;padding:7px 9px;font-family:inherit;font-size:13px;resize:vertical"></textarea>'
    + '<button type="button" class="pd-note-add" style="border:0;background:#D85B31;color:#fff;border-radius:7px;padding:8px 14px;font-weight:700;font-size:12.5px;cursor:pointer">Post</button>'
    + (state.isTeam && notes.length && !resolved ? '<button type="button" class="pd-note-resolve" style="border:1px solid var(--border);background:var(--bg);color:var(--text2);border-radius:7px;padding:8px 12px;font-size:12.5px;cursor:pointer">Resolve</button>' : '')
    + '</div><div class="pd-note-msg" style="font-size:12px;margin-top:4px"></div></div>';
}

function wirePdNotes(bx, acct) {
  const key = pdKey(acct);
  const input = bx.querySelector('.pd-note-input');
  const msg = bx.querySelector('.pd-note-msg');
  const addBtn = bx.querySelector('.pd-note-add');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const text = (input.value || '').trim();
    if (!text) return;
    addBtn.disabled = true;
    try {
      const { error } = await sb.from('pnl_detail_notes').insert({
        client_id: state.clientId, period: bsKey(pdMonth), account_key: key,
        author_id: state.userId, author_name: state.fullName || null, is_team: !!state.isTeam, body: text,
      });
      if (error) throw error;
      const notes = (await loadNotesByKey())[key] || [];
      bx.innerHTML = bx.innerHTML.split('<div class="pd-notes"')[0] + renderPdNotes(acct, notes);
      wirePdNotes(bx, acct);
    } catch (e) {
      if (msg) { msg.textContent = 'Error: ' + (e.message || e); msg.style.color = '#b93232'; }
      addBtn.disabled = false;
    }
  });
  const resBtn = bx.querySelector('.pd-note-resolve');
  if (resBtn) resBtn.addEventListener('click', async () => {
    resBtn.disabled = true;
    try {
      const { error } = await sb.from('pnl_detail_notes').update({ resolved: true })
        .eq('client_id', state.clientId).eq('period', bsKey(pdMonth)).eq('account_key', key);
      if (error) throw error;
      const notes = (await loadNotesByKey())[key] || [];
      bx.innerHTML = bx.innerHTML.split('<div class="pd-notes"')[0] + renderPdNotes(acct, notes);
      wirePdNotes(bx, acct);
    } catch (e) {
      if (msg) { msg.textContent = 'Error: ' + (e.message || e); msg.style.color = '#b93232'; }
      resBtn.disabled = false;
    }
  });
}

function pnlPeriods() {
  const cur = pnlMonth, prior = bsAddMonths(pnlMonth, -1), yoy = bsAddMonths(pnlMonth, -12);
  return [
    { key: bsKey(cur), label: bsMonthName(cur) },
    { key: bsKey(prior), label: bsMonthName(prior) },
    { key: bsKey(yoy), label: bsMonthName(yoy) + ' (YoY)' },
  ];
}
function renderPnlStatement(rows, periods) {
  const cur = periods && periods[0] ? periods[0] : { key: '', label: '' };
  const head = '<tr><th style="text-align:left;padding:6px 10px"></th>'
    + periods.map((p) => '<th style="text-align:right;padding:6px 10px;font-size:11px;color:#888;white-space:nowrap">' + bsEsc(p.label) + '</th>').join('') + '</tr>';
  const body = (rows || []).map((r) => {
    const pad = 10 + (r.indent || 0) * 16;
    const bold = r.kind !== 'account';
    const border = r.kind === 'total' ? 'border-top:1px solid var(--border)' : '';
    const color = r.kind === 'header' ? 'var(--navy)' : 'var(--text)';
    const cells = periods.map((p) => {
      const v = r.amounts ? r.amounts[p.key] : null;
      return '<td style="padding:5px 10px;text-align:right;' + (bold ? 'font-weight:700' : '') + '">' + (v == null ? '' : bsFmt(v)) + '</td>';
    }).join('');
    const isAcct = r.kind === 'account';
    const curAmt = (isAcct && r.amounts && r.amounts[cur.key] != null) ? r.amounts[cur.key] : '';
    const attrs = isAcct
      ? ' class="pnl-acct" data-label="' + bsEsc(r.label) + '" data-amt="' + curAmt + '" title="Show transactions" '
      : ' ';
    const caret = isAcct ? '<span class="pnl-caret" style="color:#bbb;font-size:10px;margin-right:5px">\u25b8</span>' : '';
    return '<tr' + attrs + 'style="' + border + (isAcct ? ';cursor:pointer' : '') + '"><td style="padding:5px 10px 5px ' + pad + 'px;' + (bold ? 'font-weight:700;' : '') + 'color:' + color + '">' + caret + bsEsc(r.label) + '</td>' + cells + '</tr>';
  }).join('');
  return '<table data-period="' + bsEsc(cur.key) + '" data-plabel="' + bsEsc(cur.label) + '" style="width:100%;border-collapse:collapse;font-size:13px;max-width:680px"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

// ── Inline drill-down: click an account line in the statement, see that
// month's transactions LIVE from QuickBooks. One fetch per month (cached for
// the session); every expanded row reads from it. When the live total differs
// from the published figure, the row says so instead of leaving the reader to
// wonder which number to trust.
const pnlDrillCache = {};
function pnlDetailLive(period) {
  const key = state.clientId + '|' + period;
  if (!pnlDrillCache[key]) {
    const [y, m] = period.split('-').map(Number);
    const from = period + '-01';
    const to = period + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0');
    pnlDrillCache[key] = sb.functions.invoke('qbo-pnl-detail', { body: { client_id: state.clientId, from, to } })
      .then(({ data, error }) => {
        if (error) throw new Error(error.message || 'request failed');
        if (data && data.error === 'not_connected') throw new Error('QuickBooks isn\u2019t connected for this client.');
        if (data && data.error === 'reauth_needed') throw new Error('QuickBooks needs to be reconnected \u2014 ask your Bald Ginger team.');
        if (!data || !data.ok) throw new Error((data && (data.message || data.error)) || 'no result');
        return data.accounts || [];
      })
      .catch((e) => { delete pnlDrillCache[key]; throw e; });
  }
  return pnlDrillCache[key];
}
function pnlNorm(x) { return String(x || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function pnlFindAcct(accounts, label) {
  const L = pnlNorm(label);
  return accounts.find((a) => pnlNorm((a.account_number ? a.account_number + ' ' : '') + a.account_name) === L)
    || accounts.find((a) => pnlNorm(a.account_name) === L)
    || accounts.find((a) => a.account_number && L.startsWith(pnlNorm(a.account_number)) && L.indexOf(pnlNorm(a.account_name)) !== -1)
    || null;
}
function pnlDrillHtml(acct, stmtAmt, plabel) {
  const txns = (acct && acct.txns) || [];
  const live = acct ? Number(acct.total || 0) : 0;
  let note = '';
  if (acct == null) {
    note = '<div style="font-size:12px;color:var(--text3);margin-bottom:6px">No transaction detail found for this line in QuickBooks.</div>';
  } else if (stmtAmt !== '' && Math.abs(live - Number(stmtAmt)) > 0.5) {
    note = '<div style="font-size:12px;color:#8a5a00;background:#fbf0dd;border-radius:6px;padding:6px 9px;margin-bottom:6px">Live from QuickBooks: ' + bsFmt(live) + ' \u2014 differs from the published statement (' + bsFmt(Number(stmtAmt)) + '). The books have changed since this month was published.</div>';
  } else {
    note = '<div style="font-size:11.5px;color:var(--text3);margin-bottom:4px">Live from QuickBooks' + (stmtAmt !== '' ? ' \u2014 matches the published statement.' : '.') + '</div>';
  }
  const table = txns.length ? ('<table style="width:100%;border-collapse:collapse;font-size:12.5px">'
    + '<thead><tr style="color:#888;font-size:10.5px;text-transform:uppercase"><th style="text-align:left;padding:4px 8px">Date</th><th style="text-align:left;padding:4px 8px">Type</th><th style="text-align:left;padding:4px 8px">Name</th><th style="text-align:left;padding:4px 8px">Memo</th><th style="text-align:right;padding:4px 8px">Amount</th></tr></thead><tbody>'
    + txns.map((t) => '<tr style="border-top:1px solid #f0f0f0">'
      + '<td style="padding:4px 8px;white-space:nowrap">' + bsEsc(t.date) + '</td>'
      + '<td style="padding:4px 8px">' + bsEsc(t.type) + (t.doc_num ? ' #' + bsEsc(t.doc_num) : '') + '</td>'
      + '<td style="padding:4px 8px">' + bsEsc(t.name) + '</td>'
      + '<td style="padding:4px 8px;color:#666">' + bsEsc(t.memo) + '</td>'
      + '<td style="padding:4px 8px;text-align:right">' + bsFmt(t.amount) + '</td></tr>').join('')
    + '</tbody></table>') : (acct ? '<div style="font-size:12.5px;color:var(--text3)">No transactions this month.</div>' : '');
  return note + table;
}
function wirePnlDrill(container) {
  container.onclick = async (e) => {
    const tr = e.target.closest && e.target.closest('tr.pnl-acct');
    if (!tr || !container.contains(tr)) return;
    const table = tr.closest('table');
    const period = table ? table.getAttribute('data-period') : '';
    const plabel = table ? table.getAttribute('data-plabel') : '';
    if (!period) return;
    const caret = tr.querySelector('.pnl-caret');
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('pnl-drill')) { next.remove(); if (caret) caret.textContent = '\u25b8'; return; }
    if (caret) caret.textContent = '\u25be';
    const cols = tr.children.length;
    const drill = document.createElement('tr');
    drill.className = 'pnl-drill';
    drill.innerHTML = '<td colspan="' + cols + '" style="padding:8px 12px 12px 26px;background:var(--bg)"><div style="font-size:11px;color:var(--text3)">Loading ' + bsEsc(plabel) + ' transactions\u2026</div></td>';
    tr.after(drill);
    try {
      const accounts = await pnlDetailLive(period);
      if (!drill.isConnected) return;
      const acct = pnlFindAcct(accounts, tr.getAttribute('data-label'));
      drill.firstElementChild.innerHTML = '<div style="font-weight:700;font-size:12px;margin-bottom:4px">' + bsEsc(tr.getAttribute('data-label')) + ' \u2014 ' + bsEsc(plabel) + '</div>' + pnlDrillHtml(acct, tr.getAttribute('data-amt'), plabel);
    } catch (err) {
      if (drill.isConnected) drill.firstElementChild.innerHTML = '<div style="font-size:12.5px;color:#b93232">Couldn\u2019t load transactions: ' + bsEsc(err.message || err) + '</div>';
    }
  };
}
async function loadPnlJump(sec) {
  const sel = sec.querySelector('#pnlJump'); if (!sel) return;
  try {
    const r = await sb.from('pnl_reports').select('period').eq('client_id', state.clientId).eq('published', true).order('period', { ascending: false }).range(0, 199);
    (r.data || []).forEach((row) => {
      const [y, m] = String(row.period).split('-').map(Number);
      const o = document.createElement('option');
      o.value = row.period;
      o.textContent = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const [y, m] = sel.value.split('-').map(Number);
      pnlMonth = new Date(y, m - 1, 1);
      drawPnlSection(sec);
    });
  } catch (e) { /* picker is a convenience; arrows still work */ }
}
