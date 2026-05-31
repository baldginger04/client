// =====================================================================
// pnl-comments-ui.js — UI for Google-Sheets-style cell-anchored comments
//
// Activated from financials.js after a file preview renders. Owns:
//   - decorating cells with comments (yellow tint + superscript number)
//   - the cell-click popover (view, add, reply, resolve)
//   - the right-side footnote sidebar listing all threads
//
// Cell anchoring uses SheetJS's emitted id="sjs-A1" on every <td>. We strip
// the "sjs-" prefix to get the cell ref. Multi-tab files: sheet_name lives
// on the active tab button (data-sheet attr).
// =====================================================================
import { fetchComments, groupIntoThreads, postComment, setThreadResolved, deleteComment } from './pnl-comments.js';

// Module-level state for the currently-active commenting session.
// Cleared on unmount or when a different file preview opens.
let session = null;

/**
 * Activate commenting on a previewed file. Called by financials.js right
 * after expandFile() has rendered the table into the host div.
 *
 *   host         — the DOM element wrapping the rendered table
 *   fileId       — uuid of the file
 *   currentUser  — { id, isTeam, fullName } for attribution
 */
export async function activateCommenting({ host, fileId, currentUser }) {
  // Clean up any prior session first (e.g. user opened a different file).
  deactivateCommenting();

  session = {
    host,
    fileId,
    currentUser,
    threads: [],          // grouped threads from the DB
    currentSheet: null,   // active sheet name (from sheet tabs)
    sidebarOpen: true,
    popover: null,        // currently-open popover DOM element
    realtimeChannel: null,  // Supabase realtime subscription
  };

  // Detect current sheet (if the file is multi-tab). The first sheet tab
  // (if any) has class .active.
  const activeTab = host.querySelector('.sheet-tab.active');
  session.currentSheet = activeTab ? activeTab.dataset.sheet : null;

  // Hook into sheet-tab switches so re-decorating happens when the user
  // switches tabs. We piggyback on the existing tab click handler by
  // listening on the host for clicks on .sheet-tab.
  host.addEventListener('click', onHostClick);

  // Listen for cell clicks (event delegation on the host)
  host.addEventListener('click', onCellClick);

  // Set up sidebar + container — wrap the existing preview in a flex layout
  setupSidebarLayout(host);

  // Subscribe to realtime changes on pnl_comments for THIS file only.
  // Inserts, updates (resolve toggling), and deletes all trigger a reload.
  // Lazily imported sb avoids a circular import; we re-use the same client
  // by reaching into the comments module which has it.
  try {
    const { sb } = await import('./config.js');
    session.realtimeChannel = sb
      .channel(`pnl-comments-${fileId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'pnl_comments',
        filter: `file_id=eq.${fileId}`,
      }, () => {
        // Any change → refetch and re-render. Cheap and avoids merge logic.
        // We ignore the payload because the cell decorate + sidebar work
        // off the full threads list anyway.
        reloadComments();
      })
      .subscribe();
  } catch (e) {
    console.warn('Realtime subscription failed (continuing without):', e);
  }

  // Fetch + render
  await reloadComments();
}

export function deactivateCommenting() {
  if (!session) return;
  closePopover();
  if (session.realtimeChannel) {
    // sb.removeChannel is async but we don't need to await — fire-and-forget
    // is fine since we're tearing down anyway.
    import('./config.js').then(({ sb }) => {
      sb.removeChannel(session.realtimeChannel).catch(() => {});
    });
  }
  if (session.host) {
    session.host.removeEventListener('click', onHostClick);
    session.host.removeEventListener('click', onCellClick);
  }
  // Restore the host to its un-sidebar'd state if we modified it
  if (session.layoutWrap) {
    const inner = session.layoutWrap.querySelector('.pnl-comments-doc');
    if (inner && session.host) {
      // Move children back to host, remove wrap
      while (inner.firstChild) session.host.appendChild(inner.firstChild);
      session.layoutWrap.remove();
    }
  }
  session = null;
}

// ---------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------
function setupSidebarLayout(host) {
  // Wrap the host's existing content in a flex container with a sidebar.
  // The doc occupies the left; sidebar (footnotes) the right.
  const wrap = document.createElement('div');
  wrap.className = 'pnl-comments-wrap';
  const doc = document.createElement('div');
  doc.className = 'pnl-comments-doc';
  while (host.firstChild) doc.appendChild(host.firstChild);
  const sidebar = document.createElement('div');
  sidebar.className = 'pnl-comments-sidebar';
  sidebar.innerHTML = `
    <div class="pnl-comments-sidebar-header">
      <span class="pnl-comments-sidebar-title">Comments</span>
      <button class="pnl-comments-sidebar-toggle" title="Collapse" data-action="toggle-sidebar">▶</button>
    </div>
    <div class="pnl-comments-sidebar-body" id="pnlCommentsSidebarBody">
      <div class="pnl-comments-empty">No comments yet. Click any cell to start a thread.</div>
    </div>`;
  wrap.appendChild(doc);
  wrap.appendChild(sidebar);
  host.appendChild(wrap);
  session.layoutWrap = wrap;

  // Sidebar toggle
  sidebar.querySelector('[data-action="toggle-sidebar"]').addEventListener('click', () => {
    session.sidebarOpen = !session.sidebarOpen;
    sidebar.classList.toggle('pnl-comments-sidebar-collapsed', !session.sidebarOpen);
    sidebar.querySelector('[data-action="toggle-sidebar"]').textContent = session.sidebarOpen ? '▶' : '◀';
  });
}

// ---------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------
async function reloadComments() {
  try {
    const all = await fetchComments(session.fileId);
    session.threads = groupIntoThreads(all);
  } catch (e) {
    console.error('fetchComments failed:', e);
    session.threads = [];
  }
  decorateCells();
  renderSidebar();
}

// ---------------------------------------------------------------------
// Cell decoration
// ---------------------------------------------------------------------
function decorateCells() {
  if (!session.host) return;
  // Clear any prior decorations first
  session.host.querySelectorAll('.pnl-cell-commented, .pnl-cell-resolved').forEach((td) => {
    td.classList.remove('pnl-cell-commented', 'pnl-cell-resolved');
    const sup = td.querySelector('.pnl-cell-marker');
    if (sup) sup.remove();
  });

  // Number threads in DB-insertion order, but only count threads on the
  // CURRENT sheet (or threads with no sheet set, treating as default).
  let num = 0;
  for (const thread of session.threads) {
    const matchesSheet = !thread.root.sheet_name || thread.root.sheet_name === session.currentSheet;
    if (!matchesSheet) continue;
    num++;
    thread._displayNum = num;
    if (!thread.root.cell_ref) continue;  // file-level comment — appears in sidebar only

    // Find the td via SheetJS's id="sjs-<CELL>" convention. sheet_to_html
    // uses uppercase letters. cell_ref values stored should match.
    const td = session.host.querySelector(`td[id="sjs-${cssEscape(thread.root.cell_ref)}"]`);
    if (!td) continue;
    td.classList.add(thread.root.is_resolved ? 'pnl-cell-resolved' : 'pnl-cell-commented');
    const sup = document.createElement('sup');
    sup.className = 'pnl-cell-marker';
    sup.textContent = thread._displayNum;
    td.appendChild(sup);
  }
}

function cssEscape(str) {
  // Cell refs are alphanumeric like "B27", so this is safe. Defensive anyway.
  return String(str).replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------
// Click handling
// ---------------------------------------------------------------------
function onHostClick(e) {
  // Catch sheet tab switches and re-decorate
  const tab = e.target.closest('.sheet-tab');
  if (tab && tab.dataset.sheet) {
    session.currentSheet = tab.dataset.sheet;
    // sheet_to_html re-renders the table on tab click (existing logic).
    // We need to wait a microtask then re-decorate.
    Promise.resolve().then(decorateCells);
  }
}

function onCellClick(e) {
  // Detect a click on a td with a SheetJS-style id
  const td = e.target.closest('td');
  if (!td || !td.id || !td.id.startsWith('sjs-')) return;
  // Ignore clicks on the marker itself if user clicked the superscript;
  // that's still on the cell, so behavior is the same.
  const cellRef = td.id.slice(4);  // strip "sjs-"
  openPopoverForCell(td, cellRef);
}

// ---------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------
function closePopover() {
  if (!session || !session.popover) return;
  session.popover.remove();
  session.popover = null;
  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('keydown', onDocKeyDown);
}

function onDocMouseDown(e) {
  if (!session || !session.popover) return;
  if (session.popover.contains(e.target)) return;
  // Allow clicks on other cells to navigate (closePopover before propagation
  // doesn't help; we just close and let the new click open the new one).
  closePopover();
}
function onDocKeyDown(e) {
  if (e.key === 'Escape') closePopover();
}

function openPopoverForCell(td, cellRef) {
  closePopover();

  // Find threads on this cell. Multiple separate threads on a single cell
  // are allowed (rare but possible — different topics).
  const onThisCell = session.threads.filter((t) =>
    t.root.cell_ref === cellRef &&
    (!t.root.sheet_name || t.root.sheet_name === session.currentSheet));

  const pop = document.createElement('div');
  pop.className = 'pnl-comment-popover';
  pop.innerHTML = renderPopoverHtml(cellRef, onThisCell);
  document.body.appendChild(pop);

  // Position near the cell
  const rect = td.getBoundingClientRect();
  const popW = 360;
  let left = rect.right + 8 + window.scrollX;
  let top = rect.top + window.scrollY;
  // Flip to the left side if overflowing
  if (left + popW > window.innerWidth - 16) {
    left = rect.left - popW - 8 + window.scrollX;
  }
  if (left < 8) left = 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  session.popover = pop;
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onDocKeyDown);

  bindPopoverEvents(pop, cellRef);
}

function renderPopoverHtml(cellRef, threads) {
  const threadsHtml = threads.length === 0
    ? `<div class="pnl-popover-empty">No comments on cell ${cellRef} yet.</div>`
    : threads.map(renderThreadHtml).join('');

  return `
    <div class="pnl-popover-header">
      <span class="pnl-popover-title">Cell ${escapeHtml(cellRef)}</span>
      <button class="icon-btn" data-action="close-popover" title="Close">✕</button>
    </div>
    <div class="pnl-popover-body">
      ${threadsHtml}
    </div>
    <div class="pnl-popover-new">
      <textarea class="pnl-popover-input" data-role="new-root" placeholder="Start a new thread on ${escapeHtml(cellRef)}…" rows="2"></textarea>
      <button class="btn btn-primary btn-sm" data-action="post-root">Post</button>
    </div>`;
}

function renderThreadHtml(thread) {
  const t = thread.root;
  const num = thread._displayNum || '';
  const resolvedTag = t.is_resolved
    ? `<span class="pnl-thread-resolved-tag">Resolved</span>`
    : '';
  // Delete button on comments the current user authored. Replies and roots
  // both get this. Deleting the root orphans its replies (intentional — we
  // could cascade later, but for now this matches the data layer).
  const myId = session?.currentUser?.id;
  const deleteBtn = (c) => c.author_id === myId
    ? `<button class="pnl-comment-delete" data-action="delete-comment" data-comment-id="${c.id}" title="Delete">×</button>`
    : '';
  const repliesHtml = thread.replies.map((r) => `
    <div class="pnl-comment pnl-comment-reply">
      <div class="pnl-comment-meta">
        <span class="pnl-comment-author">${escapeHtml(r.author?.full_name || r.author?.email || 'Unknown')}</span>
        <span class="pnl-comment-time">${formatTime(r.created_at)}</span>
        ${deleteBtn(r)}
      </div>
      <div class="pnl-comment-body">${escapeHtml(r.body)}</div>
    </div>
  `).join('');

  return `
    <div class="pnl-thread ${t.is_resolved ? 'pnl-thread-resolved' : ''}" data-thread-id="${t.id}">
      <div class="pnl-comment pnl-comment-root">
        <div class="pnl-comment-meta">
          <span class="pnl-comment-num">#${num}</span>
          <span class="pnl-comment-author">${escapeHtml(t.author?.full_name || t.author?.email || 'Unknown')}</span>
          <span class="pnl-comment-time">${formatTime(t.created_at)}</span>
          ${resolvedTag}
          ${deleteBtn(t)}
        </div>
        <div class="pnl-comment-body">${escapeHtml(t.body)}</div>
      </div>
      ${repliesHtml}
      <div class="pnl-thread-actions">
        <textarea class="pnl-popover-input" data-role="reply" data-thread-id="${t.id}" placeholder="Reply…" rows="1"></textarea>
        <div class="pnl-thread-actions-row">
          <button class="btn btn-ghost btn-sm" data-action="post-reply" data-thread-id="${t.id}">Reply</button>
          <button class="btn btn-ghost btn-sm" data-action="${t.is_resolved ? 'unresolve' : 'resolve'}" data-thread-id="${t.id}">
            ${t.is_resolved ? 'Re-open' : 'Resolve'}
          </button>
        </div>
      </div>
    </div>`;
}

function bindPopoverEvents(pop, cellRef) {
  pop.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'close-popover') return closePopover();

    if (action === 'post-root') {
      const ta = pop.querySelector('[data-role="new-root"]');
      const body = ta.value.trim();
      if (!body) return;
      btn.disabled = true;
      try {
        await postComment({
          fileId: session.fileId,
          cellRef,
          sheetName: session.currentSheet,
          body,
          authorId: session.currentUser.id,
        });
        await reloadComments();
        // Reopen the popover so the user sees their new comment
        const td = session.host.querySelector(`td[id="sjs-${cssEscape(cellRef)}"]`);
        if (td) openPopoverForCell(td, cellRef);
      } catch (err) {
        alert("Couldn't post: " + (err.message || err));
        btn.disabled = false;
      }
    }

    if (action === 'post-reply') {
      const threadId = btn.dataset.threadId;
      const ta = pop.querySelector(`[data-role="reply"][data-thread-id="${threadId}"]`);
      const body = ta.value.trim();
      if (!body) return;
      btn.disabled = true;
      try {
        await postComment({
          fileId: session.fileId,
          cellRef,
          sheetName: session.currentSheet,
          body,
          authorId: session.currentUser.id,
          parentThreadId: threadId,
        });
        await reloadComments();
        const td = session.host.querySelector(`td[id="sjs-${cssEscape(cellRef)}"]`);
        if (td) openPopoverForCell(td, cellRef);
      } catch (err) {
        alert("Couldn't reply: " + (err.message || err));
        btn.disabled = false;
      }
    }

    if (action === 'resolve' || action === 'unresolve') {
      const threadId = btn.dataset.threadId;
      btn.disabled = true;
      try {
        await setThreadResolved(threadId, action === 'resolve', session.currentUser.id);
        await reloadComments();
        const td = session.host.querySelector(`td[id="sjs-${cssEscape(cellRef)}"]`);
        if (td) openPopoverForCell(td, cellRef);
      } catch (err) {
        alert("Couldn't update: " + (err.message || err));
        btn.disabled = false;
      }
    }

    if (action === 'delete-comment') {
      const commentId = btn.dataset.commentId;
      // Find whether this is a root with replies — warn if it'd orphan them.
      let extraWarning = '';
      for (const t of session.threads) {
        if (t.root.id === commentId && t.replies.length > 0) {
          extraWarning = `\n\nThis comment has ${t.replies.length} repl${t.replies.length === 1 ? 'y' : 'ies'}. The replies will be orphaned (visible in the DB but not shown anywhere).`;
          break;
        }
      }
      if (!confirm('Delete this comment?' + extraWarning)) return;
      btn.disabled = true;
      try {
        await deleteComment(commentId);
        await reloadComments();
        const td = session.host.querySelector(`td[id="sjs-${cssEscape(cellRef)}"]`);
        if (td) openPopoverForCell(td, cellRef);
      } catch (err) {
        alert("Couldn't delete: " + (err.message || err));
        btn.disabled = false;
      }
    }
  });
}

// ---------------------------------------------------------------------
// Sidebar (footnotes view)
// ---------------------------------------------------------------------
function renderSidebar() {
  const body = document.getElementById('pnlCommentsSidebarBody');
  if (!body) return;

  if (session.threads.length === 0) {
    body.innerHTML = '<div class="pnl-comments-empty">No comments yet. Click any cell to start a thread.</div>';
    return;
  }

  // Group threads: unresolved first, then resolved
  const open = session.threads.filter((t) => !t.root.is_resolved);
  const closed = session.threads.filter((t) => t.root.is_resolved);

  const renderItem = (thread) => {
    const t = thread.root;
    const num = thread._displayNum || '·';
    const cellLabel = t.cell_ref ? `Cell ${t.cell_ref}` : 'File';
    const replyCount = thread.replies.length;
    return `
      <div class="pnl-sidebar-thread ${t.is_resolved ? 'pnl-sidebar-thread-resolved' : ''}" data-thread-id="${t.id}" data-cell-ref="${t.cell_ref || ''}">
        <div class="pnl-sidebar-thread-num">#${num}</div>
        <div class="pnl-sidebar-thread-content">
          <div class="pnl-sidebar-thread-cell">${escapeHtml(cellLabel)}</div>
          <div class="pnl-sidebar-thread-body">${escapeHtml(t.body)}</div>
          <div class="pnl-sidebar-thread-meta">
            ${escapeHtml(t.author?.full_name || 'Unknown')}
            ${replyCount > 0 ? ` · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : ''}
            ${t.is_resolved ? ' · Resolved' : ''}
          </div>
        </div>
      </div>`;
  };

  body.innerHTML = `
    ${open.length > 0 ? `<div class="pnl-sidebar-section-label">Open</div>${open.map(renderItem).join('')}` : ''}
    ${closed.length > 0 ? `<div class="pnl-sidebar-section-label">Resolved</div>${closed.map(renderItem).join('')}` : ''}
  `;

  // Click a sidebar thread → scroll to + open its popover
  body.querySelectorAll('.pnl-sidebar-thread').forEach((row) => {
    row.addEventListener('click', () => {
      const cellRef = row.dataset.cellRef;
      if (!cellRef) return;
      const td = session.host.querySelector(`td[id="sjs-${cssEscape(cellRef)}"]`);
      if (td) {
        td.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Brief flash effect so the user sees which cell was clicked
        td.classList.add('pnl-cell-flash');
        setTimeout(() => td.classList.remove('pnl-cell-flash'), 1100);
        openPopoverForCell(td, cellRef);
      }
    });
  });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}h ago`;
  if (diffMin < 60 * 24 * 7) return `${Math.floor(diffMin / 60 / 24)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
