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
      const retryPath = `${state.clientId}/${period}_${Date.now()}_retry_${safeName}`;
      const retry = await Promise.race([
        sb.storage.from(BUCKET).upload(retryPath, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type || undefined,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_AGAIN')), 45000)),
      ]).catch((e) => ({ error: e }));
      if (retry.error) throw new Error('Upload timed out twice. Check your connection and try again.');
      // Retry succeeded — use the retry path for the DB insert below
      storagePath = retryPath;
      upErr = null;
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
    // cellStyles: true tells SheetJS to preserve style information per cell.
    // Community Edition reads number formats, bold/italic/underline, and
    // indentation. Cell fills and font colors require Pro and won't come
    // through here — known limitation, acceptable for our use.
    const wb = XLSX.read(buffer, { type: 'array', cellStyles: true });
    host.innerHTML = renderWorkbookHTML(wb);
    bindSheetTabs(host, wb);
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
    // Value cells are everything except the first (label) and last (Total).
    // QBO files always have a Total column at the right.
    const valueCells = cellMatches.slice(1, -1);
    const totalCell = cellMatches[cellMatches.length - 1];
    const allValueCellsBlank = valueCells.every((c) => isBlank(plain(c[2])));

    // Classify the row
    let extraClass = '';
    if (GRAND_TOTAL_LABELS.has(labelText)) {
      extraClass = 'xlsx-row-grandtotal';
    } else if (/^(Total |Net |Gross )/.test(labelText)) {
      extraClass = 'xlsx-row-subtotal';
    } else if (/^(Income|Expenses|Cost of Goods Sold|Other Income|Other Expenses)$/.test(labelText)) {
      extraClass = 'xlsx-row-section';
    } else if (labelText !== '' && allValueCellsBlank && isBlank(plain(totalCell[2]))) {
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
      const monthHits = valueCells.filter((c) => monthLike(plain(c[2]))).length;
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
      // Blank the Total cell if all values are empty
      if (idx === cellMatches.length - 1 && allValueCellsBlank) {
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
