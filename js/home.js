// =====================================================================
// home.js — Portal landing page.
//
// Lists every client the user can see (RLS-scoped: team sees all, a client
// user sees only their own) with a bubble showing the number of OPEN Client
// Questions — message threads (cleared=false) whose latest reply is from the
// client, i.e. the ball is in our court. This is the same definition that
// powers the Client Portal badge in Triple, grouped per client. Clicking a
// client jumps straight to its Client Questions tab.
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

async function renderInto(root) {
  if (!homeOpts) return;
  const counts = await loadOpenQuestionCounts();
  render(root, homeOpts.clients, counts, homeOpts.onPick);
}

// Map of client_id -> count of open question threads whose latest message is
// from the client (is_team !== true). RLS limits the rows to clients the user
// can see, so the grouping is automatically scoped correctly.
async function loadOpenQuestionCounts() {
  const counts = {};
  try {
    const { data, error } = await sb
      .from('messages')
      .select('id, parent_message_id, is_team, created_at, cleared, client_id')
      .eq('cleared', false);
    if (error) throw error;
    const latest = new Map();  // thread root -> latest message meta
    for (const m of (data || [])) {
      const key = m.parent_message_id || m.id;
      const cur = latest.get(key);
      if (!cur || new Date(m.created_at) > new Date(cur.created_at)) {
        latest.set(key, { created_at: m.created_at, is_team: m.is_team, client_id: m.client_id });
      }
    }
    latest.forEach((v) => {
      if (v.is_team !== true && v.client_id) counts[v.client_id] = (counts[v.client_id] || 0) + 1;
    });
  } catch (err) {
    console.error('home: loadOpenQuestionCounts error:', err);
  }
  return counts;
}

function render(root, clients, counts, onPick) {
  const list = [...(clients || [])].sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) {
    root.innerHTML = '<div style="padding:40px;color:#5b6472">No clients to show yet.</div>';
    return;
  }

  const clientsWithOpen = list.filter((c) => counts[c.id]);
  const totalOpen = clientsWithOpen.reduce((sum, c) => sum + (counts[c.id] || 0), 0);
  const intro = totalOpen > 0
    ? `${totalOpen} open client question${totalOpen === 1 ? '' : 's'} across ${clientsWithOpen.length} client${clientsWithOpen.length === 1 ? '' : 's'}. Click a client to jump to the conversation.`
    : 'No open client questions right now.';

  root.innerHTML = `
    <div style="margin:0 0 18px;color:#5b6472;font-size:14px">${escapeHtml(intro)}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">
      ${list.map((c) => {
        const n = counts[c.id] || 0;
        const bubble = n > 0
          ? `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 7px;background:#e5484d;color:#fff;font-size:12px;font-weight:700;border-radius:11px;flex:none">${n > 99 ? '99+' : n}</span>`
          : '';
        return `<button type="button" data-client="${escapeAttr(c.id)}" class="home-client-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:16px 18px;border:1px solid ${n > 0 ? 'rgba(229,72,77,.35)' : '#e2e6ee'};border-radius:12px;background:#fff;cursor:pointer;font:inherit;transition:border-color .12s, box-shadow .12s">
          <span style="font-weight:600;color:#1B2A4B;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.name)}</span>
          ${bubble}
        </button>`;
      }).join('')}
    </div>`;

  root.querySelectorAll('.home-client-card').forEach((btn) => {
    const hasOpen = !!counts[btn.dataset.client];
    btn.addEventListener('mouseenter', () => {
      btn.style.boxShadow = '0 2px 10px rgba(27,42,75,.08)';
      btn.style.borderColor = '#D85B31';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.boxShadow = 'none';
      btn.style.borderColor = hasOpen ? 'rgba(229,72,77,.35)' : '#e2e6ee';
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
