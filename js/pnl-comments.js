// =====================================================================
// pnl-comments.js — Google-Sheets-style comment threads on uploaded files
//
// Data model (see pnl_comments table):
//   - Each row is one comment.
//   - A root comment has thread_id = null. Replies have thread_id = root.id.
//   - cell_ref is the SheetJS cell address (e.g. "B27") or null for
//     file-level comments. sheet_name pairs with it for multi-tab files.
//   - is_resolved on the ROOT comment marks the whole thread resolved.
//
// This module is the data layer only. UI lives in pnl-comments-ui.js.
// =====================================================================
import { sb } from './config.js';

// Fetch all comments for a file, joined with author info, ordered oldest
// first. UI then groups them into threads.
export async function fetchComments(fileId) {
  const { data, error } = await sb
    .from('pnl_comments')
    .select('id, file_id, cell_ref, sheet_name, thread_id, body, author_id, is_resolved, resolved_by, resolved_at, created_at')
    .eq('file_id', fileId)
    .order('created_at', { ascending: true });
  if (error) throw error;

  // Pull author info for every comment in one shot. profiles table has the
  // names we need to render author lines.
  const authorIds = [...new Set((data || []).map((r) => r.author_id))];
  let profileMap = {};
  if (authorIds.length > 0) {
    const { data: profs } = await sb
      .from('profiles')
      .select('id, full_name, email, avatar_initials, is_team')
      .in('id', authorIds);
    profileMap = (profs || []).reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
  }
  return (data || []).map((c) => ({ ...c, author: profileMap[c.author_id] || null }));
}

// Group comments into threads. Returns an array of thread objects, ordered
// by root comment created_at ascending. Threads on the same cell stay
// distinct (each represents a separate conversation).
export function groupIntoThreads(comments) {
  const rootsById = {};
  const threads = [];
  // First pass: collect roots
  for (const c of comments) {
    if (!c.thread_id) {
      const thread = { root: c, replies: [] };
      rootsById[c.id] = thread;
      threads.push(thread);
    }
  }
  // Second pass: attach replies
  for (const c of comments) {
    if (c.thread_id) {
      const t = rootsById[c.thread_id];
      if (t) t.replies.push(c);
    }
  }
  return threads;
}

// Post a new root comment (or reply if parentThreadId provided).
export async function postComment({ fileId, cellRef, sheetName, body, authorId, parentThreadId = null }) {
  if (!body || !body.trim()) throw new Error('Empty comment');
  const row = {
    file_id: fileId,
    cell_ref: cellRef || null,
    sheet_name: sheetName || null,
    thread_id: parentThreadId,
    body: body.trim(),
    author_id: authorId,
  };
  const { data, error } = await sb.from('pnl_comments').insert(row).select().single();
  if (error) throw error;
  return data;
}

// Toggle resolved on a root comment. We update only the root because the
// thread's resolution status lives there.
export async function setThreadResolved(rootId, isResolved, resolvedByUserId) {
  const patch = isResolved
    ? { is_resolved: true, resolved_by: resolvedByUserId, resolved_at: new Date().toISOString() }
    : { is_resolved: false, resolved_by: null, resolved_at: null };
  const { data, error } = await sb
    .from('pnl_comments')
    .update(patch)
    .eq('id', rootId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Delete a single comment. Note: the FK cascade on thread_id is NOT set up
// (we didn't want to delete replies if the root goes), so deleting a root
// orphans its replies. For now, only allow deleting your own comments OR
// the whole thread via the caller's logic.
export async function deleteComment(commentId) {
  const { error } = await sb.from('pnl_comments').delete().eq('id', commentId);
  if (error) throw error;
}
