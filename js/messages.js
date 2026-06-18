// =====================================================================
// messages.js — Client Questions
// ---------------------------------------------------------------------
// A threaded Q&A board between the client and the Bald Ginger team.
//
//   • Each "question" is a root message (parent_message_id = null).
//   • Replies hang off a question (parent_message_id = the root's id).
//   • A question + all its replies render as ONE card.
//   • Clearing a question cascades to its replies (DB trigger), so the
//     whole card disappears as a unit. "Show resolved" brings them back;
//     clearing is reversible (Reopen).
//   • Either side can ask, reply, attach a screenshot/PDF, and clear.
//
// Attachments live in the private "message-attachments" bucket at
//   <client_id>/<timestamp>-<filename>
// We store that path in messages.attachment_url and generate a short-lived
// signed URL at render time (the bucket is private — no public URLs).
// Legacy rows may still carry a full public URL in image_url; we honor it.
// =====================================================================
import { sb } from './config.js';

const BUCKET = 'message-attachments';
const SIGNED_TTL = 3600; // seconds

let currentChannel = null;
let reloadTimer = null;
let bound = false;

// Who/what we're posting as for the active client + tab.
const ctx = { clientId: null, userId: null, author: 'Unknown', isTeam: false };

let showResolved = false;
let cache = [];            // every message for the client (roots + replies)
const staged = new Map();  // 'new' | rootId  ->  File (an attachment awaiting send)

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/** Mount the Client Questions tab for a client. */
export async function loadMessages({ clientId, userId, author, isTeam }) {
  ctx.clientId = clientId;
  ctx.userId = userId;
  ctx.author = author || 'Unknown';
  ctx.isTeam = !!isTeam;

  staged.clear();
  bindOnce();
  resetComposer();
  cache = [];
  await fetchAndRender();
  subscribeRealtime(clientId);
}

/** Tear down realtime + pending reloads when leaving the tab or logging out. */
export function unsubscribeMessages() {
  if (currentChannel) { sb.removeChannel(currentChannel); currentChannel = null; }
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
}

// ---------------------------------------------------------------------
// Wiring (bound once — the composer + list elements are static in the shell)
// ---------------------------------------------------------------------
function bindOnce() {
  if (bound) return;
  bound = true;

  const sendBtn = $('composerSend');
  const input = $('composerInput');
  const attachBtn = $('composerAttach');
  const fileInput = $('composerFile');
  const toggle = $('showResolvedToggle');
  const list = $('msgList');

  if (sendBtn) sendBtn.addEventListener('click', submitQuestion);
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(); }
  });
  if (attachBtn && fileInput) attachBtn.addEventListener('click', () => fileInput.click());
  if (fileInput) fileInput.addEventListener('change', () => {
    addFiles('new', fileInput.files);
    fileInput.value = '';
  });
  if (toggle) toggle.addEventListener('change', () => { showResolved = toggle.checked; render(); });

  // Delegated handlers for the dynamically-rendered question cards.
  if (list) {
    list.addEventListener('click', onListClick);
    list.addEventListener('change', onListChange);
  }
}

function onListClick(e) {
  const clearBtn = e.target.closest('.qc-clear');
  if (clearBtn) { toggleCleared(clearBtn.dataset.rootId, clearBtn.dataset.to === '1'); return; }

  const attachBtn = e.target.closest('.qc-attach');
  if (attachBtn) {
    const card = attachBtn.dataset.card;
    const fileEl = e.currentTarget.querySelector(`.qc-file[data-card="${cssEsc(card)}"]`);
    if (fileEl) fileEl.click();
    return;
  }

  const rm = e.target.closest('.qc-staged-remove');
  if (rm) { removeStaged(rm.dataset.card, parseInt(rm.dataset.idx, 10)); return; }

  const replyBtn = e.target.closest('.qc-reply-send');
  if (replyBtn) { submitReply(replyBtn.dataset.rootId); return; }
}

function onListChange(e) {
  const fileEl = e.target.closest('.qc-file');
  if (!fileEl) return;
  addFiles(fileEl.dataset.card, fileEl.files);
  fileEl.value = '';
}

// ---------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------
async function fetchAndRender() {
  const list = $('msgList');
  if (!list) return;
  if (!cache.length) {
    list.innerHTML = '<div class="state-msg"><span class="spinner"></span> Loading questions…</div>';
  }

  const { data, error } = await sb
    .from('messages')
    .select('*')
    .eq('client_id', ctx.clientId)
    .order('created_at', { ascending: true });

  if (error) {
    list.innerHTML = `<div class="state-msg error">Couldn't load questions. ${esc(error.message)}</div>`;
    return;
  }

  cache = data || [];
  render();
}

/** Insert a question (parentId null) or a reply (parentId = root id). */
async function insertMessage({ body, parentId, atts }) {
  const row = {
    client_id: ctx.clientId,
    author: ctx.author,
    body: body || '',
    is_team: ctx.isTeam,
    parent_message_id: parentId,
  };
  if (atts && atts.length) row.attachments = atts;
  const { error } = await sb.from('messages').insert(row);
  if (error) throw error;
}

/** Upload every staged file; returns an array of { path, name }. */
async function uploadAll(files) {
  const out = [];
  for (const f of (files || [])) out.push(await uploadAttachment(f));
  return out;
}

/** Upload a file into the private bucket; returns its storage path + name. */
async function uploadAttachment(file) {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
  const path = `${ctx.clientId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
  });
  if (error) throw error;
  return { path, name: file.name };
}

async function toggleCleared(rootId, toCleared) {
  // Optimistic: flip the root + its replies in the cache and re-render now.
  // The DB trigger performs the same cascade server-side.
  cache.forEach((m) => {
    if (m.id === rootId || m.parent_message_id === rootId) m.cleared = toCleared;
  });
  render();

  const { error } = await sb.from('messages').update({ cleared: toCleared }).eq('id', rootId);
  if (error) {
    console.error('toggleCleared failed:', error);
    alert('Could not update that question. ' + (error.message || ''));
    await fetchAndRender(); // resync with the truth
  }
}

// ---------------------------------------------------------------------
// Submit handlers
// ---------------------------------------------------------------------
async function submitQuestion() {
  if (!ctx.clientId) return;
  const input = $('composerInput');
  const body = (input && input.value || '').trim();
  const files = staged.get('new') || [];
  if (!body && !files.length) return;

  const btn = $('composerSend');
  setBusy(btn, true, 'Asking…');
  try {
    const atts = files.length ? await uploadAll(files) : null;
    await insertMessage({ body, parentId: null, atts });
    if (input) input.value = '';
    clearStaged('new');
    await fetchAndRender();
  } catch (err) {
    console.error('submitQuestion failed:', err);
    alert('Could not post your question. ' + (err.message || ''));
  } finally {
    setBusy(btn, false, 'Ask');
  }
}

async function submitReply(rootId) {
  const list = $('msgList');
  if (!list) return;
  const ta = list.querySelector(`.qc-reply-input[data-root-id="${cssEsc(rootId)}"]`);
  const body = ta ? (ta.value || '').trim() : '';
  const files = staged.get(rootId) || [];
  if (!body && !files.length) return;

  const btn = list.querySelector(`.qc-reply-send[data-root-id="${cssEsc(rootId)}"]`);
  setBusy(btn, true, '…');
  try {
    const atts = files.length ? await uploadAll(files) : null;
    await insertMessage({ body, parentId: rootId, atts });
    if (ta) ta.value = '';
    clearStaged(rootId);
    await fetchAndRender();
  } catch (err) {
    console.error('submitReply failed:', err);
    alert('Could not post your reply. ' + (err.message || ''));
  } finally {
    setBusy(btn, false, 'Reply');
  }
}

// ---------------------------------------------------------------------
// Staged-attachment preview (before send) — each key holds an array of Files
// ---------------------------------------------------------------------
function addFiles(key, fileList) {
  const incoming = fileList ? Array.from(fileList) : [];
  if (!incoming.length) return;
  const arr = staged.get(key) || [];
  incoming.forEach((f) => arr.push(f));
  staged.set(key, arr);
  renderStagedPreview(key);
}

function removeStaged(key, idx) {
  const arr = staged.get(key) || [];
  if (idx >= 0 && idx < arr.length) arr.splice(idx, 1);
  if (arr.length) staged.set(key, arr); else staged.delete(key);
  renderStagedPreview(key);
}

function clearStaged(key) {
  staged.delete(key);
  renderStagedPreview(key);
}

function renderStagedPreview(key) {
  const files = staged.get(key) || [];
  const box = key === 'new'
    ? $('composerAttachPreview')
    : document.querySelector(`.qc-staged[data-card="${cssEsc(key)}"]`);
  if (!box) return;
  box.style.display = files.length ? 'flex' : 'none';
  box.innerHTML = files.map((f, i) => attachChipHtml(key, f.name, i)).join('');
}

function attachChipHtml(card, name, idx) {
  return `<span class="att-chip">📎 ${esc(name)}`
       + `<button type="button" class="qc-staged-remove" data-card="${esc(card)}"`
       + ` data-idx="${idx}" title="Remove">×</button>`
       + `</span>`;
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function render() {
  const list = $('msgList');
  if (!list) return;

  // Preserve any half-typed replies before we replace the DOM.
  const drafts = {};
  list.querySelectorAll('.qc-reply-input').forEach((ta) => {
    if (ta.value.trim()) drafts[ta.dataset.rootId] = ta.value;
  });

  const roots = cache.filter((m) => !m.parent_message_id);
  const repliesByRoot = groupReplies(cache);
  const newestFirst = (a, b) => new Date(b.created_at) - new Date(a.created_at);

  const open = roots.filter((r) => !r.cleared).sort(newestFirst);
  const resolved = roots.filter((r) => r.cleared).sort(newestFirst);

  const cardFor = (r) => renderCard(r, repliesByRoot[r.id] || []);

  let html = open.length
    ? open.map(cardFor).join('')
    : '<div class="msg-empty">No open questions. Ask one above 👆</div>';

  // Cleared history: only shown when the toggle is on. Rendered as a distinct
  // section below the open questions so it reads as an archive.
  if (showResolved) {
    html += `<div class="resolved-sep">Cleared history${resolved.length ? ` · ${resolved.length}` : ''}</div>`;
    html += resolved.length
      ? resolved.map(cardFor).join('')
      : '<div class="msg-empty">Nothing cleared yet.</div>';
  }

  list.innerHTML = html;

  // Restore drafts + any staged reply attachments.
  Object.entries(drafts).forEach(([rootId, val]) => {
    const ta = list.querySelector(`.qc-reply-input[data-root-id="${cssEsc(rootId)}"]`);
    if (ta) ta.value = val;
  });
  staged.forEach((_f, key) => { if (key !== 'new') renderStagedPreview(key); });

  hydrateAttachments();
}

function groupReplies(all) {
  const map = {};
  all.forEach((m) => {
    if (m.parent_message_id) (map[m.parent_message_id] ||= []).push(m);
  });
  Object.values(map).forEach((arr) =>
    arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  );
  return map;
}

function renderCard(root, replies) {
  const author = root.author || 'Unknown';
  const teamBadge = root.is_team ? '<span class="badge-team">Team</span>' : '';
  const resolved = !!root.cleared;
  const resolvedBadge = resolved ? '<span class="badge-resolved">✓ Resolved</span>' : '';
  const clearLabel = resolved ? '↩ Reopen' : '✓ Clear';
  const clearTo = resolved ? '0' : '1';

  const repliesHtml = replies.map(renderReply).join('');

  return `
    <div class="qcard${resolved ? ' is-resolved' : ''}" data-root-id="${esc(root.id)}">
      <div class="qcard-head">
        <div class="msg-meta">
          ${avHtml(author)}
          <span class="msg-author">${esc(author)}</span>
          ${teamBadge}
          ${resolvedBadge}
          <span class="msg-time">${formatTime(root.created_at)}</span>
        </div>
        <button type="button" class="btn btn-ghost btn-sm qc-clear"
                data-root-id="${esc(root.id)}" data-to="${clearTo}">${clearLabel}</button>
      </div>

      <div class="msg-body">${esc(root.body || '')}${attachmentSlot(root)}</div>

      ${repliesHtml ? `<div class="qcard-replies">${repliesHtml}</div>` : ''}

      <div class="qcard-foot">
        <div class="qc-reply">
          <textarea class="qc-reply-input" data-root-id="${esc(root.id)}" rows="1"
                    placeholder="Write a reply…"></textarea>
          <div class="qc-reply-actions">
            <button type="button" class="attach-btn qc-attach" data-card="${esc(root.id)}"
                    title="Attach a screenshot or PDF">📎</button>
            <input type="file" class="qc-file" data-card="${esc(root.id)}"
                   accept="image/*,.pdf" multiple hidden />
            <button type="button" class="btn btn-primary btn-sm qc-reply-send"
                    data-root-id="${esc(root.id)}">Reply</button>
          </div>
        </div>
        <div class="att-preview qc-staged" data-card="${esc(root.id)}" style="display:none"></div>
      </div>
    </div>
  `;
}

function renderReply(r) {
  const author = r.author || 'Unknown';
  const teamBadge = r.is_team ? '<span class="badge-team">Team</span>' : '';
  return `
    <div class="qreply">
      <div class="msg-meta">
        ${avHtml(author)}
        <span class="msg-author">${esc(author)}</span>
        ${teamBadge}
        <span class="msg-time">${formatTime(r.created_at)}</span>
      </div>
      <div class="msg-body">${esc(r.body || '')}${attachmentSlot(r)}</div>
    </div>
  `;
}

/** Render all attachments on a message. New rows carry a JSONB `attachments`
 *  array of { path, name }; we also honor the legacy single attachment_url and
 *  the older public image_url. Signed (private-bucket) items render as .att
 *  placeholders that hydrateAttachments() fills in after render. */
function attachmentSlot(m) {
  const items = [];
  if (Array.isArray(m.attachments)) {
    m.attachments.forEach((a) => {
      if (a && a.path) items.push({ path: a.path, name: a.name || 'attachment' });
    });
  }
  if (m.attachment_url) {
    items.push({ path: m.attachment_url, name: m.attachment_name || 'attachment' });
  }

  let html = items.map((it) => {
    const isImg = isImageName(it.name) ? '1' : '0';
    return `<div class="att" data-att-path="${esc(it.path)}"`
         + ` data-att-name="${esc(it.name)}" data-att-img="${isImg}"></div>`;
  }).join('');

  if (m.image_url) {
    html += `<div class="att"><img src="${esc(m.image_url)}" alt="attachment" /></div>`;
  }

  return html ? `<div class="att-group">${html}</div>` : '';
}

async function hydrateAttachments() {
  const slots = Array.from(document.querySelectorAll('.att[data-att-path]'));
  await Promise.all(slots.map(async (el) => {
    const path = el.getAttribute('data-att-path');
    const name = el.getAttribute('data-att-name') || 'attachment';
    const isImg = el.getAttribute('data-att-img') === '1';
    el.removeAttribute('data-att-path'); // don't re-hydrate on next pass
    try {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
      if (error || !data) throw error || new Error('no signed url');
      const url = data.signedUrl;
      el.innerHTML = isImg
        ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${esc(name)}" /></a>`
        : `<a class="att-file" href="${esc(url)}" target="_blank" rel="noopener">📎 ${esc(name)}</a>`;
    } catch (err) {
      console.error('attachment signing failed:', err);
      el.innerHTML = `<span class="att-file att-err">📎 ${esc(name)} (unavailable)</span>`;
    }
  }));
}

// ---------------------------------------------------------------------
// Realtime — coalesce bursts (e.g. a clear cascade fires many UPDATEs)
// into a single debounced reload.
// ---------------------------------------------------------------------
function subscribeRealtime(clientId) {
  if (currentChannel) { sb.removeChannel(currentChannel); currentChannel = null; }
  currentChannel = sb
    .channel(`messages:client:${clientId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `client_id=eq.${clientId}` },
      scheduleReload)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `client_id=eq.${clientId}` },
      scheduleReload)
    .subscribe();
}

function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { reloadTimer = null; fetchAndRender(); }, 200);
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function resetComposer() {
  const input = $('composerInput');
  if (input) input.value = '';
  const box = $('composerAttachPreview');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  const toggle = $('showResolvedToggle');
  if (toggle) toggle.checked = false;
  showResolved = false;
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy) btn.innerHTML = `<span class="spinner"></span> ${esc(label)}`;
  else btn.textContent = label;
}

/** Avatar color class — mirrors Triple's avClass() so people match across apps. */
function avClass(name) {
  if (!name) return 'av-default';
  if (name.includes('Ed')) return 'av-ed';
  if (name.includes('Jennifer')) return 'av-jennifer';
  if (name.includes('Lydia')) return 'av-lydia';
  if (name.includes('Jen')) return 'av-jen';
  return 'av-default';
}

function avHtml(name) {
  if (!name) return '';
  const initials = name.split(' ').map((w) => w[0]).join('').substring(0, 2).toUpperCase();
  return `<span class="msg-avatar ${avClass(name)}">${esc(initials)}</span>`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
       + ' · '
       + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function isImageName(n) {
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i.test(n || '');
}

function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/"/g, '\\"');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
