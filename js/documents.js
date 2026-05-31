// =====================================================================
// documents.js — long-lived reference document storage for clients
//
// Sibling tab to Financials. Where Financials is a feed of monthly
// deliverables, Documents is a filing cabinet for things like W-9s,
// voided checks, tax returns, insurance policies. Folders matter here.
//
// Architecture:
//   - document_folders + document_files tables (see migration)
//   - Folders nest via parent_folder_id; storage path is flat but the
//     UI walks the folder tree.
//   - Storage bucket 'documents' with RLS by client_id (first path segment)
//   - Five template folders (Tax, Legal, Banking, Insurance, Misc) auto-
//     created per client. Team can add more.
// =====================================================================
import { sb } from './config.js';

const BUCKET = 'documents';
const PREVIEWABLE = /\.(pdf|png|jpe?g|gif|webp|svg|xlsx|xls|csv)$/i;

let state = {
  clientId: null,
  isTeam: false,
  userId: null,
  folders: [],          // all folders for this client
  selectedFolderId: null, // currently-active folder; null = root
  files: [],            // files in the currently-selected folder
  expandedIds: new Set(),  // folder ids currently expanded in tree
};

// ---------------------------------------------------------------------
// Entry / exit
// ---------------------------------------------------------------------
export async function mountDocuments({ clientId, isTeam, userId }) {
  state.clientId = clientId;
  state.isTeam = isTeam;
  state.userId = userId;
  state.selectedFolderId = null;
  state.expandedIds = new Set();

  // Same cold-start warmup pattern as financials — wake the storage
  // subsystem in the background so the first upload doesn't hang.
  if (isTeam) {
    sb.storage.from(BUCKET).list(clientId, { limit: 1 }).catch(() => {});
  }

  renderShell();
  await loadFolders();
  await loadFiles();  // root files initially
  renderTree();
  renderFileList();
}

export function unmountDocuments() {
  // No persistent listeners or subscriptions to tear down.
}

// ---------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------
async function loadFolders() {
  const { data, error } = await sb
    .from('document_folders')
    .select('*')
    .eq('client_id', state.clientId)
    .order('sort_order')
    .order('name');
  if (error) {
    console.error('loadFolders failed:', error);
    state.folders = [];
    return;
  }
  state.folders = data || [];
}

async function loadFiles() {
  // folder_id IS null for root files. Supabase: use .is for null comparisons.
  let q = sb.from('document_files')
    .select('*')
    .eq('client_id', state.clientId)
    .order('created_at', { ascending: false });
  if (state.selectedFolderId === null) q = q.is('folder_id', null);
  else q = q.eq('folder_id', state.selectedFolderId);
  const { data, error } = await q;
  if (error) {
    console.error('loadFiles failed:', error);
    state.files = [];
    return;
  }
  state.files = data || [];
}

// ---------------------------------------------------------------------
// Shell render
// ---------------------------------------------------------------------
function renderShell() {
  const root = document.getElementById('tab-documents');
  if (!root) return;
  root.innerHTML = `
    <section class="card">
      <h2 style="font-family:var(--font-display);font-style:italic;font-size:24px;margin:0 0 4px">Documents</h2>
      <p style="color:var(--text2);margin:0 0 18px;font-size:13px">
        W-9s, voided checks, tax documents, insurance, and other long-lived records.
      </p>
      <div class="docs-layout">
        <aside class="docs-tree" id="docsTree"></aside>
        <main class="docs-pane" id="docsPane"></main>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Folder tree
// ---------------------------------------------------------------------
function renderTree() {
  const host = document.getElementById('docsTree');
  if (!host) return;
  // Build root-level folders and walk down.
  const rootFolders = state.folders.filter((f) => !f.parent_folder_id);
  let html = `
    <div class="docs-tree-item ${state.selectedFolderId === null ? 'is-active' : ''}" data-folder-id="">
      <span class="docs-tree-icon">🗂️</span>
      <span class="docs-tree-name">All Documents</span>
    </div>
  `;
  for (const f of rootFolders) {
    html += renderTreeNode(f, 0);
  }
  if (state.isTeam) {
    html += `
      <button class="docs-tree-add" data-action="new-folder" data-parent="">
        + New folder
      </button>`;
  }
  host.innerHTML = html;

  // Click to select a folder
  host.querySelectorAll('.docs-tree-item').forEach((el) => {
    el.addEventListener('click', async (e) => {
      // Don't trigger if user clicked the chevron (handled separately)
      if (e.target.classList.contains('docs-tree-chev')) return;
      const id = el.dataset.folderId || null;
      state.selectedFolderId = id || null;
      await loadFiles();
      renderTree();
      renderFileList();
    });
  });
  // Chevron toggles expand/collapse
  host.querySelectorAll('.docs-tree-chev').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.folderId;
      if (state.expandedIds.has(id)) state.expandedIds.delete(id);
      else state.expandedIds.add(id);
      renderTree();
    });
  });
  // New folder buttons (top-level + nested)
  host.querySelectorAll('[data-action="new-folder"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const parent = el.dataset.parent || null;
      promptCreateFolder(parent);
    });
  });
}

function renderTreeNode(folder, depth) {
  const children = state.folders.filter((f) => f.parent_folder_id === folder.id);
  const hasChildren = children.length > 0;
  const isExpanded = state.expandedIds.has(folder.id);
  const isActive = state.selectedFolderId === folder.id;

  // Folders are indented with padding-left scaled by depth
  let html = `
    <div class="docs-tree-item ${isActive ? 'is-active' : ''}" data-folder-id="${folder.id}" style="padding-left:${10 + depth * 14}px">
      ${hasChildren
        ? `<span class="docs-tree-chev" data-folder-id="${folder.id}">${isExpanded ? '▾' : '▸'}</span>`
        : `<span class="docs-tree-chev-spacer"></span>`}
      <span class="docs-tree-icon">📁</span>
      <span class="docs-tree-name">${escapeHtml(folder.name)}</span>
    </div>
  `;
  if (isExpanded && hasChildren) {
    for (const child of children) {
      html += renderTreeNode(child, depth + 1);
    }
  }
  // Team can add a subfolder under any folder when expanded
  if (state.isTeam && isExpanded) {
    html += `
      <button class="docs-tree-add" data-action="new-folder" data-parent="${folder.id}" style="padding-left:${24 + (depth + 1) * 14}px">
        + Subfolder
      </button>`;
  }
  return html;
}

// ---------------------------------------------------------------------
// File list (right pane)
// ---------------------------------------------------------------------
function renderFileList() {
  const host = document.getElementById('docsPane');
  if (!host) return;

  // Breadcrumb: show full path to current folder
  const crumbs = breadcrumb(state.selectedFolderId);
  const crumbHtml = `
    <nav class="docs-crumb">
      ${crumbs.map((c, i) => i < crumbs.length - 1
        ? `<a href="#" data-crumb="${c.id || ''}">${escapeHtml(c.name)}</a> <span class="docs-crumb-sep">/</span> `
        : `<span>${escapeHtml(c.name)}</span>`
      ).join('')}
    </nav>`;

  const uploadHtml = `
    <div class="docs-upload-zone">
      <input type="file" id="docsFileInput" style="display:none" />
      <button class="btn btn-primary" id="docsUploadBtn">
        ⬆ Upload to ${crumbs[crumbs.length - 1].name}
      </button>
      <span id="docsUploadStatus" class="docs-upload-status"></span>
    </div>`;

  const filesHtml = state.files.length === 0
    ? `<div class="docs-empty">No files in this folder yet.</div>`
    : `<div class="docs-files">${state.files.map(renderFileRow).join('')}</div>`;

  host.innerHTML = `${crumbHtml}${uploadHtml}${filesHtml}`;

  // Wire breadcrumb clicks
  host.querySelectorAll('[data-crumb]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = el.dataset.crumb || null;
      state.selectedFolderId = id || null;
      await loadFiles();
      renderTree();
      renderFileList();
    });
  });

  // Wire upload
  const btn = document.getElementById('docsUploadBtn');
  const input = document.getElementById('docsFileInput');
  if (btn && input) {
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => handleUpload(input.files[0]));
  }

  // Wire file row actions
  host.querySelectorAll('[data-action="preview-file"]').forEach((el) => {
    el.addEventListener('click', () => previewFile(el.dataset.fileId));
  });
  host.querySelectorAll('[data-action="download-file"]').forEach((el) => {
    el.addEventListener('click', () => downloadFile(el.dataset.fileId));
  });
  host.querySelectorAll('[data-action="delete-file"]').forEach((el) => {
    el.addEventListener('click', () => deleteFile(el.dataset.fileId));
  });
}

function renderFileRow(f) {
  const canDelete = state.isTeam || f.uploaded_by === state.userId;
  const previewable = PREVIEWABLE.test(f.filename);
  const sizeKb = f.size_bytes ? Math.round(f.size_bytes / 1024) : null;
  const when = formatDate(f.created_at);
  return `
    <div class="docs-file">
      <div class="docs-file-icon">${iconForFile(f.filename)}</div>
      <div class="docs-file-main">
        <div class="docs-file-name">${escapeHtml(f.filename)}</div>
        <div class="docs-file-meta">
          ${when}${sizeKb ? ` · ${sizeKb} KB` : ''}
          ${f.uploaded_by === state.userId ? ' · uploaded by you' : ''}
        </div>
      </div>
      <div class="docs-file-actions">
        ${previewable
          ? `<button class="btn btn-ghost btn-sm" data-action="preview-file" data-file-id="${f.id}">Preview</button>`
          : ''}
        <button class="btn btn-ghost btn-sm" data-action="download-file" data-file-id="${f.id}">Download</button>
        ${canDelete
          ? `<button class="btn btn-ghost btn-sm" data-action="delete-file" data-file-id="${f.id}" style="color:var(--red,#c0392b)">Delete</button>`
          : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------
async function promptCreateFolder(parentId) {
  const name = prompt('New folder name?');
  if (!name || !name.trim()) return;
  // Find a reasonable sort_order — append at end of siblings
  const siblings = state.folders.filter((f) => f.parent_folder_id === parentId);
  const maxOrder = siblings.reduce((m, f) => Math.max(m, f.sort_order || 0), 0);
  const { error } = await sb.from('document_folders').insert({
    client_id: state.clientId,
    parent_folder_id: parentId || null,
    name: name.trim(),
    sort_order: maxOrder + 1,
    is_template: false,
    created_by: state.userId,
  });
  if (error) {
    alert("Couldn't create folder: " + error.message);
    return;
  }
  // Reload folders and expand the parent so the new folder is visible
  await loadFolders();
  if (parentId) state.expandedIds.add(parentId);
  renderTree();
}

// ---------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------
async function handleUpload(file) {
  if (!file) return;
  const status = document.getElementById('docsUploadStatus');
  const btn = document.getElementById('docsUploadBtn');
  if (status) status.textContent = 'Uploading…';
  if (btn) btn.disabled = true;

  try {
    const safeName = sanitizeFilename(file.name);
    // Path: documents/<client_id>/<folder_id or "root">/<timestamp>_<filename>
    // Folder id segment lets storage RLS work via path; it doesn't need to be
    // semantic, just unique per folder. We store the real folder_id in the
    // DB row so the UI can move files between folders by updating folder_id
    // without re-uploading.
    const folderSeg = state.selectedFolderId || 'root';
    const storagePath = `${state.clientId}/${folderSeg}/${Date.now()}_${safeName}`;

    const { error: upErr } = await sb.storage.from(BUCKET).upload(storagePath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || undefined,
    });
    if (upErr) throw upErr;

    const { error: insErr } = await sb.from('document_files').insert({
      client_id: state.clientId,
      folder_id: state.selectedFolderId,
      storage_path: storagePath,
      filename: file.name,
      size_bytes: file.size,
      mime_type: file.type || null,
      uploaded_by: state.userId,
    });
    if (insErr) {
      // Roll back the storage object so we don't leave orphans
      await sb.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      throw insErr;
    }

    if (status) status.textContent = `✓ Uploaded ${file.name}`;
    await loadFiles();
    renderFileList();
  } catch (err) {
    console.error('upload failed:', err);
    if (status) status.textContent = 'Upload failed: ' + (err.message || err);
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => { if (status) status.textContent = ''; }, 4000);
  }
}

async function downloadFile(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f) return;
  // Create a short-lived signed URL and trigger download
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(f.storage_path, 60, {
    download: f.filename,
  });
  if (error) { alert("Couldn't get download URL: " + error.message); return; }
  // Use a link click to trigger download
  const a = document.createElement('a');
  a.href = data.signedUrl;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function previewFile(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f) return;
  // Get a signed URL for inline preview (no download attr).
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(f.storage_path, 300);
  if (error) { alert("Couldn't preview: " + error.message); return; }
  openPreviewModal(f, data.signedUrl);
}

async function deleteFile(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f) return;
  if (!confirm(`Delete "${f.filename}"? This cannot be undone.`)) return;
  try {
    // Remove from storage first (best-effort), then row
    await sb.storage.from(BUCKET).remove([f.storage_path]).catch(() => {});
    const { error } = await sb.from('document_files').delete().eq('id', fileId);
    if (error) throw error;
    state.files = state.files.filter((x) => x.id !== fileId);
    renderFileList();
  } catch (err) {
    console.error('delete failed:', err);
    alert("Couldn't delete: " + (err.message || err));
  }
}

// ---------------------------------------------------------------------
// Preview modal — handles PDF, image, and spreadsheet types inline.
// Others fall back to a "no preview available, download instead" message.
// ---------------------------------------------------------------------
function openPreviewModal(f, signedUrl) {
  // Remove any stale modal first
  const stale = document.getElementById('docsPreviewModal');
  if (stale) stale.remove();

  const lower = f.filename.toLowerCase();
  let body = '';
  if (lower.endsWith('.pdf')) {
    body = `<embed src="${signedUrl}" type="application/pdf" style="width:100%;height:75vh;border:0;background:white" />`;
  } else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) {
    body = `<img src="${signedUrl}" style="max-width:100%;max-height:75vh;display:block;margin:0 auto;background:white" alt="${escapeAttr(f.filename)}" />`;
  } else if (/\.(xlsx|xls|csv)$/i.test(lower)) {
    body = `<div id="docsXlsxPreview" style="background:white;padding:12px;max-height:75vh;overflow:auto"><span class="spinner"></span> Loading spreadsheet…</div>`;
  } else {
    body = `<div style="padding:24px;color:var(--text2);text-align:center">No inline preview available. Use Download instead.</div>`;
  }

  const html = `
    <div id="docsPreviewModal" class="pnl-modal-backdrop">
      <div class="pnl-modal" style="max-width:1100px;width:92vw">
        <div class="pnl-modal-header">
          <div>
            <div class="pnl-modal-title">${escapeHtml(f.filename)}</div>
          </div>
          <button class="icon-btn" id="docsPreviewClose" title="Close">✕</button>
        </div>
        <div class="pnl-modal-body" style="padding:0">${body}</div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('docsPreviewClose').addEventListener('click', () => {
    document.getElementById('docsPreviewModal')?.remove();
  });
  document.getElementById('docsPreviewModal').addEventListener('click', (e) => {
    if (e.target.id === 'docsPreviewModal') document.getElementById('docsPreviewModal')?.remove();
  });

  // Spreadsheet: fetch + render with SheetJS, reusing pattern from financials
  if (/\.(xlsx|xls|csv)$/i.test(lower)) {
    fetch(signedUrl).then((r) => r.arrayBuffer()).then((buf) => {
      const XLSX = window.XLSX;
      if (!XLSX) {
        document.getElementById('docsXlsxPreview').innerHTML =
          '<div style="color:var(--red)">Spreadsheet renderer not available.</div>';
        return;
      }
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rawHtml = XLSX.utils.sheet_to_html(sheet, { editable: false, header: '', footer: '' });
      const m = rawHtml.match(/<table[\s\S]*<\/table>/i);
      document.getElementById('docsXlsxPreview').innerHTML =
        `<div class="xlsx-preview">${m ? m[0] : rawHtml}</div>`;
    }).catch((e) => {
      document.getElementById('docsXlsxPreview').innerHTML =
        `<div style="color:var(--red)">Failed to load: ${escapeHtml(e.message || String(e))}</div>`;
    });
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function breadcrumb(folderId) {
  // Walk from selected folder up to root, returning [root, ..., selected]
  const trail = [];
  let cur = folderId;
  while (cur) {
    const f = state.folders.find((x) => x.id === cur);
    if (!f) break;
    trail.unshift({ id: f.id, name: f.name });
    cur = f.parent_folder_id;
  }
  trail.unshift({ id: null, name: 'All Documents' });
  return trail;
}

function iconForFile(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return '📕';
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) return '🖼️';
  if (/\.(xlsx|xls|csv)$/i.test(lower)) return '📊';
  if (/\.(docx?|odt)$/i.test(lower)) return '📝';
  return '📄';
}
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }
