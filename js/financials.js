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
import { parsePnlWorkbook, matchAccounts, persistPnlData, fetchMappings } from './pnl-parser.js';

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
export async function mountFinancials({ clientId, isTeam, userId }) {
  state.clientId = clientId;
  state.isTeam = isTeam;
  state.userId = userId;
  state.expandedFileId = null;

  renderUploadCard();
  bindUploadForm();
  await loadAndRenderFiles();
}

/** Called when the user leaves this tab — currently a no-op, here for symmetry. */
export function unmountFinancials() {
  // Nothing to tear down yet. Realtime subscription on files would go here.
}

// =====================================================================
// UPLOAD
// =====================================================================

function renderUploadCard() {
  const card = document.getElementById('uploadCard');
  if (!card) return;
  card.style.display = state.isTeam ? 'block' : 'none';

  // Default the period selector to current month
  const periodInput = document.getElementById('uploadPeriod');
  if (periodInput && !periodInput.value) {
    const d = new Date();
    periodInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // Inject the "Notify client" checkbox into the form if it isn't already there.
  // We append it right before the Upload button so it's visually clear that the
  // checkbox controls behavior of the upload that's about to happen.
  if (state.isTeam && !document.getElementById('uploadNotifyCheckbox')) {
    const btn = document.getElementById('uploadBtn');
    if (btn && btn.parentNode) {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer;user-select:none;margin-right:.5rem;white-space:nowrap';
      wrap.innerHTML = `<input type="checkbox" id="uploadNotifyCheckbox" style="cursor:pointer"> Notify client`;
      btn.parentNode.insertBefore(wrap, btn);
    }
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
    const storagePath = `${state.clientId}/${period}_${Date.now()}_${safeName}`;

    // 1. Upload to Storage
    const { error: upErr } = await sb.storage
      .from(BUCKET)
      .upload(storagePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined,
      });
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
    const host = document.getElementById(`preview-host-${id}`);
    if (host) host.innerHTML = '';
    return;
  }
  // collapse any existing preview first
  if (state.expandedFileId) {
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
    const wb = XLSX.read(buffer, { type: 'array' });
    host.innerHTML = renderWorkbookHTML(wb);
    bindSheetTabs(host, wb);
    if (scrollTo) host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

export function renderWorkbookHTML(wb) {
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
  html += '<div class="xlsx-preview" id="xlsxPreviewBody">' + sheetToHTML(wb.Sheets[sheetNames[0]]) + '</div>';
  return html;
}

export function bindSheetTabs(host, wb) {
  const tabs = host.querySelectorAll('.sheet-tab');
  const body = host.querySelector('#xlsxPreviewBody');
  if (!tabs.length || !body) return;
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const name = t.dataset.sheet;
      body.innerHTML = sheetToHTML(wb.Sheets[name]);
    });
  });
}

function sheetToHTML(sheet) {
  if (!sheet) return '<div class="state-msg">Empty sheet.</div>';
  // SheetJS will emit a full <table>. We use html: with editable: false so
  // formatted values are preserved.
  const raw = XLSX.utils.sheet_to_html(sheet, { editable: false, header: '', footer: '' });
  // sheet_to_html wraps in <html><body>; strip wrappers, keep the <table>.
  const m = raw.match(/<table[\s\S]*<\/table>/i);
  return m ? m[0] : raw;
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
  { value: 'discounts',          label: 'Discounts / Refunds' },
  // COGS
  { value: 'food_cogs',          label: 'Food COGS' },
  { value: 'liquor_cogs',        label: 'Liquor COGS' },
  { value: 'beer_cogs',          label: 'Beer COGS' },
  { value: 'wine_cogs',          label: 'Wine COGS' },
  { value: 'na_bev_cogs',        label: 'NA Beverages COGS' },
  { value: 'merchandise_cogs',   label: 'Merchandise / Retail COGS' },
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

async function openParseModal(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f) return alert("File not found");

  // 1. Download + parse the xlsx
  let parsed;
  try {
    const buf = await downloadAsBuffer(f.storage_path);
    parsed = parsePnlWorkbook(buf);
  } catch (e) {
    return alert("Couldn't parse P&L: " + (e.message || e));
  }

  // 2. Fetch mappings and categorize
  const mappings = await fetchMappings(state.clientId);
  const rowsWithCat = matchAccounts(parsed.rows, mappings, state.clientId);

  // 3. Stash the session and render modal
  parseSession = {
    file: f,
    months: parsed.months,
    rows: rowsWithCat,
    overrides: {},  // keyed by row index — user-edited categories
  };
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

  const { file, months, rows } = parseSession;
  const unmatchedCount = rows.filter((r) => !r.category).length;
  const periodRange = months.length === 1 ? months[0] : `${months[0]} → ${months[months.length - 1]}`;

  // Sort: unmatched first (so the team's eye lands on them), then by account
  // number (ascending). Stable enough for QBO numbering conventions.
  const ordered = [...rows.map((r, i) => ({ ...r, _origIdx: i }))].sort((a, b) => {
    const am = !a.category ? 0 : 1;
    const bm = !b.category ? 0 : 1;
    if (am !== bm) return am - bm;
    return (a.account_number || '~').localeCompare(b.account_number || '~');
  });

  const sampleMonth = months[months.length - 1];  // most recent month for the sample column

  const rowsHtml = ordered.map((row) => {
    const sample = row.amounts[sampleMonth] || 0;
    const isUnmatched = !row.category;
    const select = `<select class="pnl-cat-select" data-row-idx="${row._origIdx}">
      <option value="">— unmapped —</option>
      ${PNL_CATEGORIES.map((c) => `<option value="${c.value}"${row.category === c.value ? ' selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
    </select>`;
    return `<tr class="${isUnmatched ? 'pnl-row-unmatched' : ''}">
      <td class="pnl-acct-num">${escapeHtml(row.account_number || '—')}</td>
      <td class="pnl-acct-name">${escapeHtml(row.account_name)}</td>
      <td class="pnl-sample">${formatMoney(sample)}</td>
      <td>${select}</td>
    </tr>`;
  }).join('');

  const html = `
    <div id="pnlParseModal" class="pnl-modal-backdrop">
      <div class="pnl-modal">
        <div class="pnl-modal-header">
          <div>
            <div class="pnl-modal-title">Parse P&amp;L: ${escapeHtml(file.filename)}</div>
            <div class="pnl-modal-sub">
              ${months.length} month${months.length === 1 ? '' : 's'} (${periodRange}) ·
              ${rows.length} accounts ·
              ${unmatchedCount > 0 ? `<strong style="color:var(--red)">${unmatchedCount} unmapped</strong>` : `<span style="color:var(--green)">all mapped</span>`}
            </div>
          </div>
          <button class="icon-btn" id="pnlParseClose" title="Close">✕</button>
        </div>
        <div class="pnl-modal-body">
          <div class="pnl-help">
            Review the category assignments below. Any changes you make are saved as rules for this client
            (next time, the same account auto-maps the same way). Unmapped rows are listed first.
            Set to <em>— Ignore this account —</em> to exclude an account from all charts.
          </div>
          <table class="pnl-review-table">
            <thead>
              <tr>
                <th style="width:80px">#</th>
                <th>Account Name</th>
                <th style="width:120px;text-align:right">${escapeHtml(sampleMonth)}</th>
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
  // Capture dropdown changes into overrides
  document.querySelectorAll('.pnl-cat-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.rowIdx, 10);
      const val = e.target.value;
      parseSession.overrides[idx] = val || null;  // empty string → null (unmapped)
    });
  });
}

async function saveParseSession() {
  if (!parseSession) return;
  const saveBtn = document.getElementById('pnlParseSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    const { file, months, rows, overrides } = parseSession;

    // 1. Apply overrides to the rows; collect any category changes to persist
    //    as per-client mappings.
    const finalRows = rows.map((r, i) => ({
      ...r,
      category: (i in overrides) ? overrides[i] : r.category,
    }));

    // 2. For every override that differs from what the global rules produced,
    //    save a per-client coa_mappings row (number_exact). Re-running a parse
    //    later will then auto-apply the same rule. Skip "ignore" mappings that
    //    weren't unmatched to begin with (no rule needed for them).
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
