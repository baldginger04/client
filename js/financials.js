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
    const { error: insErr } = await sb.from('files').insert({
      client_id: state.clientId,
      storage_path: storagePath,
      filename: file.name,
      file_type: fileType,
      period,
      size_bytes: file.size,
      mime_type: file.type || null,
      uploaded_by: state.userId,
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
    .select('id, client_id, storage_path, filename, file_type, period, size_bytes, mime_type, is_archived, created_at')
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

  const closeBtnHtml = (state.isTeam && !archived)
    ? `<button class="btn btn-ghost btn-sm" data-action="close-period" data-period="${escapeAttr(period)}">Close month</button>`
    : (state.isTeam && archived)
      ? `<button class="btn btn-ghost btn-sm" data-action="reopen-period" data-period="${escapeAttr(period)}">Reopen</button>`
      : '';

  return `
    <div class="period-group">
      <div class="period-group-header">
        <div class="period-group-title">${formatPeriodLabel(period)}</div>
        <div style="display:flex; align-items:center; gap:.5rem">
          <div class="period-group-meta">${files.length} ${files.length === 1 ? 'file' : 'files'}</div>
          ${closeBtnHtml}
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
    case 'close-period':   return setPeriodArchived(period, true);
    case 'reopen-period':  return setPeriodArchived(period, false);
  }
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

async function setPeriodArchived(period, isArchived) {
  if (!state.isTeam) return;
  const label = isArchived ? 'Close' : 'Reopen';
  if (!confirm(`${label} ${formatPeriodLabel(period)} — affects all files for this period.`)) return;

  try {
    const { error } = await sb
      .from('files')
      .update({ is_archived: isArchived })
      .eq('client_id', state.clientId)
      .eq('period', period);
    if (error) throw error;
    // Update local cache so we don't refetch
    state.files = state.files.map((f) =>
      (f.period === period ? { ...f, is_archived: isArchived } : f)
    );
    renderFileList();
  } catch (err) {
    console.error('archive toggle failed:', err);
    alert(`Couldn't ${label.toLowerCase()} month: ${err.message || err}`);
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
