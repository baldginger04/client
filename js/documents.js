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
  // Editing / selection state for the new operations:
  renamingFolderId: null,  // folder currently being inline-renamed
  renamingFileId: null,    // file currently being inline-renamed
  selectedFileIds: new Set(),  // checked files for bulk delete
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
  state.renamingFolderId = null;
  state.renamingFileId = null;
  state.selectedFileIds = new Set();

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

  // Click to select a folder (but not when clicking pencil, chevron, or input)
  host.querySelectorAll('.docs-tree-item').forEach((el) => {
    el.addEventListener('click', async (e) => {
      // Don't trigger if user clicked chevron, rename button, or is in the input
      if (e.target.classList.contains('docs-tree-chev')) return;
      if (e.target.classList.contains('docs-tree-rename')) return;
      if (e.target.classList.contains('docs-rename-input')) return;
      const id = el.dataset.folderId || null;
      state.selectedFolderId = id || null;
      // Clear any in-progress rename and selection
      state.renamingFolderId = null;
      state.selectedFileIds = new Set();
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
  // Pencil → enter rename mode
  host.querySelectorAll('[data-action="rename-folder"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      state.renamingFolderId = el.dataset.folderId;
      renderTree();
      // Focus the input and select all text
      const input = host.querySelector(`[data-rename-folder-id="${state.renamingFolderId}"]`);
      if (input) { input.focus(); input.select(); }
    });
  });
  // Rename input handlers — save on Enter or blur, cancel on Escape
  host.querySelectorAll('.docs-rename-input').forEach((input) => {
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await commitRenameFolder(input); }
      if (e.key === 'Escape') { state.renamingFolderId = null; renderTree(); }
    });
    input.addEventListener('blur', async () => {
      if (state.renamingFolderId) await commitRenameFolder(input);
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
  const isRenaming = state.renamingFolderId === folder.id;

  // The folder name area either shows the text + a pencil (team only) or,
  // when renaming, an inline input. Escape cancels, Enter or blur saves.
  const nameHtml = isRenaming
    ? `<input type="text" class="docs-rename-input" data-rename-folder-id="${folder.id}" value="${escapeAttr(folder.name)}" />`
    : `<span class="docs-tree-name">${escapeHtml(folder.name)}</span>
       ${state.isTeam ? `<button class="docs-tree-rename" data-action="rename-folder" data-folder-id="${folder.id}" title="Rename">✎</button>` : ''}`;

  let html = `
    <div class="docs-tree-item ${isActive ? 'is-active' : ''}" data-folder-id="${folder.id}" style="padding-left:${10 + depth * 14}px">
      ${hasChildren
        ? `<span class="docs-tree-chev" data-folder-id="${folder.id}">${isExpanded ? '▾' : '▸'}</span>`
        : `<span class="docs-tree-chev-spacer"></span>`}
      <span class="docs-tree-icon">📁</span>
      ${nameHtml}
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
    <div class="docs-upload-zone" id="docsDropZone">
      <input type="file" id="docsFileInput" multiple style="display:none" />
      <button class="btn btn-primary" id="docsUploadBtn">
        ⬆ Upload to ${crumbs[crumbs.length - 1].name}
      </button>
      <span class="docs-upload-hint">or drop files here</span>
      <span id="docsUploadStatus" class="docs-upload-status"></span>
    </div>`;

  // Bulk action bar — only shown when there are selected files
  const selectedCount = state.selectedFileIds.size;
  const bulkHtml = selectedCount > 0
    ? `<div class="docs-bulk-bar">
         <span class="docs-bulk-count">${selectedCount} selected</span>
         <button class="btn btn-ghost btn-sm" data-action="clear-selection">Clear</button>
         <button class="btn btn-ghost btn-sm" data-action="bulk-delete" style="color:var(--red,#c0392b)">Delete ${selectedCount}</button>
       </div>`
    : '';

  const filesHtml = state.files.length === 0
    ? `<div class="docs-empty">No files in this folder yet. Drop files here to upload.</div>`
    : `<div class="docs-files">${state.files.map(renderFileRow).join('')}</div>`;

  host.innerHTML = `${crumbHtml}${uploadHtml}${bulkHtml}${filesHtml}`;

  // ── Breadcrumb clicks ──
  host.querySelectorAll('[data-crumb]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = el.dataset.crumb || null;
      state.selectedFolderId = id || null;
      state.selectedFileIds = new Set();
      await loadFiles();
      renderTree();
      renderFileList();
    });
  });

  // ── Upload button (file picker) ──
  const btn = document.getElementById('docsUploadBtn');
  const input = document.getElementById('docsFileInput');
  if (btn && input) {
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => handleUploadFiles([...input.files]));
  }

  // ── Drag-and-drop on the whole pane ──
  setupDropZone(host);

  // ── File row actions ──
  host.querySelectorAll('[data-action="preview-file"]').forEach((el) => {
    el.addEventListener('click', () => previewFile(el.dataset.fileId));
  });
  host.querySelectorAll('[data-action="download-file"]').forEach((el) => {
    el.addEventListener('click', () => downloadFile(el.dataset.fileId));
  });
  host.querySelectorAll('[data-action="delete-file"]').forEach((el) => {
    el.addEventListener('click', () => deleteFile(el.dataset.fileId));
  });
  host.querySelectorAll('[data-action="rename-file"]').forEach((el) => {
    el.addEventListener('click', () => {
      state.renamingFileId = el.dataset.fileId;
      renderFileList();
      const inp = host.querySelector(`[data-rename-file-id="${state.renamingFileId}"]`);
      if (inp) { inp.focus(); inp.select(); }
    });
  });
  host.querySelectorAll('[data-action="move-file"]').forEach((el) => {
    el.addEventListener('click', () => openMoveModal(el.dataset.fileId));
  });

  // ── Inline rename input ──
  host.querySelectorAll('.docs-file-rename').forEach((inp) => {
    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await commitRenameFile(inp); }
      if (e.key === 'Escape') { state.renamingFileId = null; renderFileList(); }
    });
    inp.addEventListener('blur', async () => {
      if (state.renamingFileId) await commitRenameFile(inp);
    });
  });

  // ── Selection checkboxes ──
  host.querySelectorAll('.docs-file-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.fileId;
      if (cb.checked) state.selectedFileIds.add(id);
      else state.selectedFileIds.delete(id);
      renderFileList();
    });
  });

  // ── Bulk actions ──
  host.querySelector('[data-action="clear-selection"]')?.addEventListener('click', () => {
    state.selectedFileIds = new Set();
    renderFileList();
  });
  host.querySelector('[data-action="bulk-delete"]')?.addEventListener('click', bulkDelete);
}

function renderFileRow(f) {
  const canDelete = state.isTeam || f.uploaded_by === state.userId;
  const canRename = state.isTeam || f.uploaded_by === state.userId;
  const canMove = state.isTeam || f.uploaded_by === state.userId;
  const previewable = PREVIEWABLE.test(f.filename);
  const sizeKb = f.size_bytes ? Math.round(f.size_bytes / 1024) : null;
  const when = formatDate(f.created_at);
  const isRenaming = state.renamingFileId === f.id;
  const isChecked = state.selectedFileIds.has(f.id);

  // The file name area swaps to an inline input when renaming.
  const nameHtml = isRenaming
    ? `<input type="text" class="docs-rename-input docs-file-rename" data-rename-file-id="${f.id}" value="${escapeAttr(f.filename)}" />`
    : `<div class="docs-file-name">${escapeHtml(f.filename)}</div>`;

  return `
    <div class="docs-file" data-file-id="${f.id}">
      <input type="checkbox" class="docs-file-check" data-file-id="${f.id}" ${isChecked ? 'checked' : ''} />
      <div class="docs-file-icon">${iconForFile(f.filename)}</div>
      <div class="docs-file-main">
        ${nameHtml}
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
        ${canRename
          ? `<button class="btn btn-ghost btn-sm" data-action="rename-file" data-file-id="${f.id}">Rename</button>`
          : ''}
        ${canMove
          ? `<button class="btn btn-ghost btn-sm" data-action="move-file" data-file-id="${f.id}">Move</button>`
          : ''}
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
// Upload one or more files sequentially. Used by both the file picker and
// the drag-and-drop handler. Sequential rather than parallel so the status
// line shows clear "1 of N" progress and a flaky network has less to retry.
async function handleUploadFiles(files) {
  if (!files || files.length === 0) return;
  const status = document.getElementById('docsUploadStatus');
  const btn = document.getElementById('docsUploadBtn');
  if (btn) btn.disabled = true;

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (status) status.textContent = `Uploading ${i + 1} of ${files.length}: ${file.name}…`;
    const ok = await uploadSingle(file);
    if (ok) succeeded++;
    else failed++;
  }

  if (status) {
    if (failed === 0) status.textContent = `✓ Uploaded ${succeeded} file${succeeded === 1 ? '' : 's'}`;
    else if (succeeded === 0) status.textContent = `Upload failed for all ${failed} file${failed === 1 ? '' : 's'}`;
    else status.textContent = `Uploaded ${succeeded}, failed ${failed}`;
  }
  if (btn) btn.disabled = false;
  await loadFiles();
  renderFileList();
  setTimeout(() => { const s = document.getElementById('docsUploadStatus'); if (s) s.textContent = ''; }, 5000);
}

// Upload a single file. Returns true on success, false on failure.
// Pulled out of handleUpload so handleUploadFiles can loop over it without
// repeating the storage + DB insert dance.
async function uploadSingle(file) {
  try {
    const safeName = sanitizeFilename(file.name);
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
      await sb.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      throw insErr;
    }
    return true;
  } catch (err) {
    console.error('uploadSingle failed:', err);
    return false;
  }
}

// Wire drag-and-drop listeners on the pane. Highlights the drop zone on
// dragover, accepts dropped files via handleUploadFiles. Browser default
// is to navigate to the file, so we must preventDefault on both dragover
// and drop.
function setupDropZone(host) {
  const zone = host.querySelector('#docsDropZone');
  if (!zone) return;
  // Use the whole pane as the drop target so users don't have to aim
  // precisely at the small zone bar.
  const pane = host;
  let depth = 0;  // nested dragenter counter; needed so dragleave on
                  // a child doesn't unhighlight while still inside the pane
  pane.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    depth++;
    pane.classList.add('docs-drop-active');
  });
  pane.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();  // required to allow drop
  });
  pane.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) pane.classList.remove('docs-drop-active');
  });
  pane.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    pane.classList.remove('docs-drop-active');
    const files = [...e.dataTransfer.files];
    await handleUploadFiles(files);
  });
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
    state.selectedFileIds.delete(fileId);
    renderFileList();
  } catch (err) {
    console.error('delete failed:', err);
    alert("Couldn't delete: " + (err.message || err));
  }
}

// Bulk-delete every file in state.selectedFileIds. Confirms once, then loops.
// We delete storage objects in a single .remove([paths]) call for efficiency,
// then drop the DB rows in one .delete().in(). If any single operation fails,
// we surface a partial-success message rather than rolling back.
async function bulkDelete() {
  const ids = [...state.selectedFileIds];
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} file${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const filesToDelete = state.files.filter((f) => ids.includes(f.id));
  const paths = filesToDelete.map((f) => f.storage_path);
  try {
    // Best-effort storage removal — failures here don't block DB cleanup
    await sb.storage.from(BUCKET).remove(paths).catch(() => {});
    const { error } = await sb.from('document_files').delete().in('id', ids);
    if (error) throw error;
    state.files = state.files.filter((f) => !ids.includes(f.id));
    state.selectedFileIds = new Set();
    renderFileList();
  } catch (err) {
    console.error('bulk delete failed:', err);
    alert("Some deletes failed: " + (err.message || err));
    // Refresh from DB so we show truth
    await loadFiles();
    state.selectedFileIds = new Set();
    renderFileList();
  }
}

// Commit a folder rename. Reads the input value, updates the DB, and re-renders.
// Same name → no-op. Empty → cancel.
async function commitRenameFolder(input) {
  const folderId = input.dataset.renameFolderId;
  const newName = input.value.trim();
  const folder = state.folders.find((f) => f.id === folderId);
  state.renamingFolderId = null;
  if (!folder || !newName || newName === folder.name) {
    renderTree();
    return;
  }
  const { error } = await sb.from('document_folders').update({ name: newName }).eq('id', folderId);
  if (error) {
    alert("Couldn't rename folder: " + error.message);
    renderTree();
    return;
  }
  folder.name = newName;  // patch local cache
  renderTree();
  // Breadcrumb may include this folder, so re-render the pane too
  renderFileList();
}

// Commit a file rename. Updates the DB filename field; the storage object
// stays at its original path. Downloads pass the new filename through the
// signed-URL `download` parameter, so users always see the renamed name.
async function commitRenameFile(input) {
  const fileId = input.dataset.renameFileId;
  const newName = input.value.trim();
  const file = state.files.find((f) => f.id === fileId);
  state.renamingFileId = null;
  if (!file || !newName || newName === file.filename) {
    renderFileList();
    return;
  }
  const { error } = await sb.from('document_files').update({ filename: newName }).eq('id', fileId);
  if (error) {
    alert("Couldn't rename file: " + error.message);
    renderFileList();
    return;
  }
  file.filename = newName;
  renderFileList();
}

// Move modal — pick a destination folder from the full tree.
// The picker lists all folders for this client, indented to show hierarchy.
// Selecting "All Documents" (the root) moves the file to folder_id = null.
function openMoveModal(fileId) {
  const file = state.files.find((f) => f.id === fileId);
  if (!file) return;

  // Build flat list of folders with depth for indentation
  const flat = [];
  const walk = (parentId, depth) => {
    const kids = state.folders.filter((f) => f.parent_folder_id === parentId)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    for (const f of kids) {
      flat.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);

  // Stale modal cleanup
  const stale = document.getElementById('docsMoveModal');
  if (stale) stale.remove();

  const optionRow = (label, id, depth, disabled) => `
    <div class="docs-move-option ${disabled ? 'is-disabled' : ''}" data-move-folder-id="${id || ''}" style="padding-left:${12 + depth * 18}px">
      <span class="docs-move-icon">${id ? '📁' : '🗂️'}</span>
      <span class="docs-move-name">${escapeHtml(label)}</span>
      ${disabled ? '<span class="docs-move-current">(current)</span>' : ''}
    </div>`;

  // Disable selecting the current folder so we don't re-save a no-op
  const currentId = file.folder_id || '';
  const html = `
    <div id="docsMoveModal" class="pnl-modal-backdrop">
      <div class="pnl-modal" style="max-width:480px;width:92vw">
        <div class="pnl-modal-header">
          <div>
            <div class="pnl-modal-title">Move "${escapeHtml(file.filename)}"</div>
            <div class="pnl-modal-sub">Pick a destination folder</div>
          </div>
          <button class="icon-btn" data-action="close-move">✕</button>
        </div>
        <div class="pnl-modal-body" style="max-height:60vh;overflow-y:auto;padding:8px 0">
          ${optionRow('All Documents', null, 0, currentId === '')}
          ${flat.map((f) => optionRow(f.name, f.id, f.depth + 1, f.id === currentId)).join('')}
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  const modal = document.getElementById('docsMoveModal');
  modal.querySelector('[data-action="close-move"]').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target.id === 'docsMoveModal') modal.remove(); });
  modal.querySelectorAll('.docs-move-option').forEach((el) => {
    if (el.classList.contains('is-disabled')) return;
    el.addEventListener('click', async () => {
      const destId = el.dataset.moveFolderId || null;
      modal.remove();
      await moveFile(fileId, destId);
    });
  });
}

// Move a file by updating folder_id. Storage path doesn't change — it stays
// in the original location. The only authoritative pointer is folder_id.
async function moveFile(fileId, destFolderId) {
  const { error } = await sb.from('document_files')
    .update({ folder_id: destFolderId })
    .eq('id', fileId);
  if (error) {
    alert("Couldn't move file: " + error.message);
    return;
  }
  // Refresh the current folder's file list — the moved file will disappear
  // from view since it's no longer in this folder.
  await loadFiles();
  renderFileList();
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
