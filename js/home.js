// =====================================================================
// home.js — Portal landing page.
//
// Lists every client the user can see (RLS-scoped: team sees all, a client
// user sees only their own) with a bubble showing the number of OPEN Client
// Questions. Clicking a client jumps straight to its Client Questions tab.
//
// COUNT vs. COLOUR (changed 2026-07-29)
// -------------------------------------
// The bubble used to count only threads where the client spoke last ("ball in
// our court"), which meant it disagreed with the Client Questions nav badge:
// three open Bill's Oyster questions that the team had posted showed a "3" in
// the sidebar and no bubble at all on this board, under the line "No open
// client questions right now."
//
// The two signals are now separated:
//   • the NUMBER is every open thread root — the same definition the sidebar
//     badge and the Client Questions page use, so the three always reconcile;
//   • the COLOUR carries the triage signal — solid when at least one of that
//     client's open threads is waiting on the viewer, hollow when every open
//     thread is waiting on the other side.
// The title tooltip spells out the split.
// =====================================================================
import { sb } from './config.js';

let homeChannel = null;
let homeDebounce = null;
let homeOpts = null;  // { clients, isTeam, onPick }

export async function mountHome(opts) {
  homeOpts = opts;
  const root = document.getElementById('tab-home');
  if (!root) return;
  await renderInto(root);
  subscribeHome();
}

export function unmountHome() {
  if (homeChannel) { sb.removeChannel(homeChannel); homeChannel = null; }
  if (homeDebounce) { clearTimeout(homeDebounce); homeDebounce = null; }
}

// Whose court the ball is in depends on who is looking. For a team member an
// open thread is "awaiting you" when the CLIENT posted last; for a client user
// it's the reverse. main.js is expected to pass isTeam through mountHome; if it
// doesn't (the flag is only read here), we fall back to the team reading, which
// is the perspective this board was originally written from.
function viewerIsTeam() {
  return !(homeOpts && homeOpts.isTeam === false);
}

async function renderInto(root) {
  if (!homeOpts) return;
  const counts = await loadOpenQuestionCounts();
  render(root, homeOpts.clients, counts, homeOpts.onPick);
}

// Map of client_id -> { total, awaitingViewer }.
//
//   total          = open question threads for that client. A thread is one
//                    ROOT row (parent_message_id is null) still at
//                    cleared = false. This is exactly what the Client
//                    Questions page lists and what the nav badge counts.
//   awaitingViewer = of those, how many have the OTHER side's message as the
//                    most recent activity in the thread.
//
// RLS limits the rows to clients the user can see, so the grouping is
// automatically scoped correctly.
//
// A thread only counts while its ROOT is open. Keying purely on
// parent_message_id, as this once did, let a reply left at cleared = false
// under a CLEARED root invent a thread of its own — a client card lit up over
// a question the Client Questions tab files under "Show cleared history" and
// never lists as open. Deriving the open roots first and skipping replies that
// don't belong to one keeps this board honest.
//
// is_internal = false keeps internal team notes out of it entirely; they are
// invisible to clients by RLS and have no business on this board either.
async function loadOpenQuestionCounts() {
  const counts = {};
  try {
    const { data, error } = await sb
      .from('messages')
      .select('id, parent_message_id, is_team, created_at, cleared, client_id')
      .eq('is_internal', false)
      .eq('cleared', false);
    if (error) throw error;
    const rows = data || [];

    // Open thread roots, and the client each one belongs to. The root's own
    // client_id is authoritative — replies inherit it, but we never rely on
    // a reply to tell us which client a thread is under.
    const rootClient = new Map();  // root id -> client_id
    for (const m of rows) {
      if (!m.parent_message_id && m.client_id) rootClient.set(m.id, m.client_id);
    }

    // Latest activity per open thread, root and replies together.
    const latest = new Map();  // root id -> { created_at, is_team }
    for (const m of rows) {
      const key = m.parent_message_id || m.id;
      if (!rootClient.has(key)) continue;   // reply under a cleared/foreign root
      const cur = latest.get(key);
      if (!cur || new Date(m.created_at) > new Date(cur.created_at)) {
        latest.set(key, { created_at: m.created_at, is_team: m.is_team });
      }
    }

    const teamViewer = viewerIsTeam();
    rootClient.forEach((clientId, rootId) => {
      const bucket = counts[clientId] || (counts[clientId] = { total: 0, awaitingViewer: 0 });
      bucket.total += 1;
      const last = latest.get(rootId);
      // lastFromTeam: treat a missing/false is_team as client-authored, which
      // is how the rest of the portal reads that column.
      const lastFromTeam = !!(last && last.is_team === true);
      if (teamViewer ? !lastFromTeam : lastFromTeam) bucket.awaitingViewer += 1;
    });
  } catch (err) {
    console.error('home: loadOpenQuestionCounts error:', err);
  }
  return counts;
}

const OPEN_BORDER   = 'rgba(229,72,77,.35)';  // at least one thread awaits the viewer
const IDLE_BORDER   = '#cbd2de';              // open, but waiting on the other side
const PLAIN_BORDER  = '#e2e6ee';              // nothing open

function borderFor(entry) {
  if (!entry || !entry.total) return PLAIN_BORDER;
  return entry.awaitingViewer > 0 ? OPEN_BORDER : IDLE_BORDER;
}

// Solid orange bubble = something is waiting on the viewer. Hollow bubble =
// open questions exist but the other side owes the next message. Same number
// either way, so this board, the nav badge and the questions list agree.
function bubbleHtml(entry, teamViewer) {
  if (!entry || !entry.total) return '';
  const n = entry.total;
  const label = n > 99 ? '99+' : String(n);
  const awaiting = entry.awaitingViewer;
  const hot = awaiting > 0;
  const who = teamViewer ? 'your reply' : 'a reply from Bald Ginger';
  const tip = `${n} open question${n === 1 ? '' : 's'} · ${awaiting} awaiting ${who}`;
  const base = 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;'
    + 'min-width:22px;height:22px;padding:0 7px;font-size:12px;font-weight:700;border-radius:11px;flex:none';
  const skin = hot
    ? 'background:#e5484d;color:#fff;border:1px solid #e5484d'
    : 'background:#fff;color:#5b6472;border:1px solid #aeb6c4';
  return `<span title="${escapeAttr(tip)}" style="${base};${skin}">${label}</span>`;
}

function render(root, clients, counts, onPick) {
  const list = [...(clients || [])].sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) {
    root.innerHTML = '<div style="padding:40px;color:#5b6472">No clients to show yet.</div>';
    return;
  }

  const teamViewer = viewerIsTeam();
  const clientsWithOpen = list.filter((c) => counts[c.id] && counts[c.id].total);
  const totalOpen = clientsWithOpen.reduce((sum, c) => sum + counts[c.id].total, 0);
  const totalAwaiting = clientsWithOpen.reduce((sum, c) => sum + counts[c.id].awaitingViewer, 0);
  const nClients = clientsWithOpen.length;
  const s = (n) => (n === 1 ? '' : 's');
  const who = teamViewer ? 'your reply' : 'a reply from Bald Ginger';

  let intro;
  if (!totalOpen) {
    intro = 'No open client questions right now.';
  } else if (totalAwaiting > 0) {
    intro = `${totalAwaiting} question${s(totalAwaiting)} awaiting ${who}, `
      + `out of ${totalOpen} open across ${nClients} client${s(nClients)}. `
      + 'Click a client to jump to the conversation.';
  } else {
    intro = `${totalOpen} open client question${s(totalOpen)} across ${nClients} client${s(nClients)}, `
      + `all waiting on ${teamViewer ? 'the client' : 'Bald Ginger'}. `
      + 'Click a client to jump to the conversation.';
  }

  root.innerHTML = `
    <div style="margin:0 0 18px;color:#5b6472;font-size:14px">${escapeHtml(intro)}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">
      ${list.map((c) => {
        const entry = counts[c.id];
        return `<button type="button" data-client="${escapeAttr(c.id)}" class="home-client-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:16px 18px;border:1px solid ${borderFor(entry)};border-radius:12px;background:#fff;cursor:pointer;font:inherit;transition:border-color .12s, box-shadow .12s">
          <span style="font-weight:600;color:#1B2A4B;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.name)}</span>
          ${bubbleHtml(entry, teamViewer)}
        </button>`;
      }).join('')}
    </div>`;

  root.querySelectorAll('.home-client-card').forEach((btn) => {
    const resting = borderFor(counts[btn.dataset.client]);
    btn.addEventListener('mouseenter', () => {
      btn.style.boxShadow = '0 2px 10px rgba(27,42,75,.08)';
      btn.style.borderColor = '#D85B31';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.boxShadow = 'none';
      btn.style.borderColor = resting;
    });
    btn.addEventListener('click', () => onPick(btn.dataset.client));
  });
}

function subscribeHome() {
  if (homeChannel) sb.removeChannel(homeChannel);
  homeChannel = sb
    .channel('home-questions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
      if (homeDebounce) clearTimeout(homeDebounce);
      homeDebounce = setTimeout(() => {
        homeDebounce = null;
        const root = document.getElementById('tab-home');
        if (root && root.style.display !== 'none' && homeOpts) renderInto(root);
      }, 300);
    })
    .subscribe();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }
