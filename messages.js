// =====================================================================
// messages.js — load, send, render, and subscribe to client messages
// =====================================================================
import { sb } from './config.js';

let currentChannel = null;
let currentRenderTarget = null;
let currentClientId = null;
let currentUserId = null;

/** Load all messages for a client and render them. */
export async function loadMessages(clientId, listEl, userId) {
  currentRenderTarget = listEl;
  currentClientId = clientId;
  currentUserId = userId;

  listEl.innerHTML = '<div class="state-msg"><span class="spinner"></span> Loading messages…</div>';

  const { data, error } = await sb
    .from('messages')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });

  if (error) {
    listEl.innerHTML = `<div class="state-msg error">Couldn't load messages. ${escape(error.message)}</div>`;
    return;
  }

  renderAll(data || []);
  subscribeRealtime(clientId);
}

/** Send a new message in the current client thread. */
export async function sendMessage({ clientId, author, body, isTeam }) {
  const trimmed = (body || '').trim();
  if (!trimmed) return;

  const { error } = await sb.from('messages').insert({
    client_id: clientId,
    author,
    body: trimmed,
    is_team: isTeam,
  });
  if (error) throw error;
  // realtime will pick it up and render — but for snappier UX we could
  // optimistically append. Keeping it simple for now.
}

/** Subscribe to realtime inserts AND updates for this client's messages.
 *  Updates matter because Triple users can mark messages cleared/uncleared,
 *  and the portal should reflect that state change without a refresh. */
function subscribeRealtime(clientId) {
  if (currentChannel) {
    sb.removeChannel(currentChannel);
    currentChannel = null;
  }

  currentChannel = sb
    .channel(`messages:client:${clientId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `client_id=eq.${clientId}`,
      },
      (payload) => appendMessage(payload.new)
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `client_id=eq.${clientId}`,
      },
      (payload) => updateMessage(payload.new)
    )
    .subscribe();
}

/** Stop listening for realtime updates. */
export function unsubscribeMessages() {
  if (currentChannel) {
    sb.removeChannel(currentChannel);
    currentChannel = null;
  }
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function renderAll(messages) {
  if (!currentRenderTarget) return;
  if (!messages.length) {
    currentRenderTarget.innerHTML = '<div class="msg-empty">No messages yet. Say hi 👋</div>';
    return;
  }
  currentRenderTarget.innerHTML = messages.map(renderOne).join('');
  currentRenderTarget.scrollTop = currentRenderTarget.scrollHeight;
}

function appendMessage(msg) {
  if (!currentRenderTarget) return;
  // If the list is currently showing the empty state, clear it first.
  const empty = currentRenderTarget.querySelector('.msg-empty');
  if (empty) currentRenderTarget.innerHTML = '';
  currentRenderTarget.insertAdjacentHTML('beforeend', renderOne(msg));
  currentRenderTarget.scrollTop = currentRenderTarget.scrollHeight;
}

/** Replace a message in place when an UPDATE comes in via realtime.
 *  Most commonly: the team marked it cleared/uncleared in Triple. We swap
 *  the DOM node so the resolved styling appears/disappears without scrolling
 *  the chat back to the bottom or re-rendering anything else. */
function updateMessage(msg) {
  if (!currentRenderTarget) return;
  const existing = currentRenderTarget.querySelector(`[data-msg-id="${CSS.escape(String(msg.id))}"]`);
  if (!existing) return;
  // Build the new node from HTML and swap it in. Using a template div as an
  // adapter since insertAdjacentHTML doesn't replace, only insert.
  const tpl = document.createElement('template');
  tpl.innerHTML = renderOne(msg).trim();
  const fresh = tpl.content.firstElementChild;
  if (fresh) existing.replaceWith(fresh);
}

function renderOne(msg) {
  const author = msg.author || 'Unknown';
  const teamBadge = msg.is_team ? '<span class="badge-team">Team</span>' : '';
  // A "cleared" message is one the team has marked as resolved over in Triple.
  // The portal can't mark or unmark — clients only see the visual state. We
  // fade the card and add a small "Resolved" badge so they know the team
  // considers the matter handled.
  const resolvedClass = msg.cleared ? ' is-resolved' : '';
  const resolvedBadge = msg.cleared ? '<span class="badge-resolved">✓ Resolved</span>' : '';
  const img = msg.image_url
    ? `<img src="${escape(msg.image_url)}" alt="attachment" />`
    : '';
  return `
    <div class="msg${resolvedClass}" data-msg-id="${escape(msg.id)}">
      <div class="msg-meta">
        ${avHtml(author)}
        <span class="msg-author">${escape(author)}</span>
        ${teamBadge}
        ${resolvedBadge}
        <span class="msg-time">${formatTime(msg.created_at)}</span>
      </div>
      <div class="msg-body">${escape(msg.body || '')}${img}</div>
    </div>
  `;
}

/** Avatar color class for a given name. Mirrors Triple's avClass() exactly so
 *  the same person shows up in the same color across both apps. */
function avClass(name) {
  if (!name) return 'av-default';
  if (name.includes('Ed')) return 'av-ed';
  if (name.includes('Jennifer')) return 'av-jennifer';
  if (name.includes('Lydia')) return 'av-lydia';
  if (name.includes('Jen')) return 'av-jen';
  return 'av-default';
}

/** Render an avatar circle with up to 2-letter initials for the given name.
 *  e.g. "Ed Hattrup" -> "EH" inside a colored circle. */
function avHtml(name) {
  if (!name) return '';
  const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  return `<span class="msg-avatar ${avClass(name)}">${escape(initials)}</span>`;
}

function inferMine(msg) {
  // Kept as a no-op for now in case other code references it. Card-style
  // messages don't differentiate by sender on the layout level; the "Team"
  // badge is the visual cue for who's who. Safe to delete in a future pass.
  return false;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
       + ' · '
       + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function escape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
