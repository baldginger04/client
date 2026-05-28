// =====================================================================
// main.js — entry point. Wires auth, client switcher, tabs, and pages.
// =====================================================================
import { sb, LAST_CLIENT_KEY } from './config.js';
import { signIn, signOut, getSession, loadUserContext, onAuthChange } from './auth.js';
import { loadMessages, sendMessage, unsubscribeMessages } from './messages.js';
import { mountFinancials, unmountFinancials } from './financials.js';
import { mountKPI, unmountKPI } from './kpi.js';

const LAST_TAB_KEY = 'bg_client_portal_last_tab';
const DEFAULT_TAB = 'financials';
const TABS = ['financials', 'kpi', 'projections', 'messages'];

// App state
const state = {
  user: null,        // auth user
  profile: null,     // profiles row (full_name, is_team)
  clients: [],       // [{id, name}]
  currentClientId: null,
  currentTab: DEFAULT_TAB,
};

// DOM refs (filled in on DOMContentLoaded)
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  bindLoginForm();
  bindAppShell();

  const session = await getSession();
  if (session) {
    await enterApp(session.user);
  } else {
    showLogin();
  }

  // React to login/logout from elsewhere (e.g. another tab).
  onAuthChange(async (session) => {
    if (session) await enterApp(session.user);
    else showLogin();
  });
});

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
function bindLoginForm() {
  const form = $('loginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    const errEl = $('loginErr');
    const btn = $('loginBtn');

    errEl.textContent = '';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';

    try {
      await signIn(email, password);
      // onAuthChange will fire and call enterApp.
    } catch (err) {
      errEl.textContent = err.message || 'Sign-in failed.';
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

function showLogin() {
  state.user = null;
  state.profile = null;
  state.clients = [];
  state.currentClientId = null;
  unsubscribeMessages();
  $('loginScreen').style.display = 'flex';
  $('appShell').style.display = 'none';
  $('loginBtn').disabled = false;
  $('loginBtn').textContent = 'Sign in';
  $('loginPassword').value = '';
}

// ---------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------
async function enterApp(user) {
  state.user = user;

  try {
    const { profile, clients } = await loadUserContext(user.id);
    state.profile = profile;
    state.clients = clients;
    // expose for messages.js render heuristic
    window.__bg_user_is_team = !!profile.is_team;
  } catch (err) {
    console.error('loadUserContext failed:', err);
    alert('Could not load your account. Please try again or contact Bald Ginger.');
    await signOut();
    return;
  }

  // Populate user card
  const displayName = state.profile.full_name || state.profile.email;
  $('userName').textContent = displayName;
  $('userRole').textContent = state.profile.is_team ? 'Team member' : 'Client';
  $('userAvatar').textContent = initials(displayName);

  // Populate client switcher
  populateClientSwitcher();

  $('loginScreen').style.display = 'none';
  $('appShell').style.display = 'block';

  // Restore last tab (defaults to financials)
  const savedTab = localStorage.getItem(LAST_TAB_KEY);
  state.currentTab = TABS.includes(savedTab) ? savedTab : DEFAULT_TAB;
  highlightNav(state.currentTab);
  showPane(state.currentTab);

  // Pick a client and mount the current tab
  if (state.clients.length === 0) {
    showNoClients();
  } else {
    const saved = localStorage.getItem(LAST_CLIENT_KEY);
    const initial = state.clients.find((c) => c.id === saved) || state.clients[0];
    await setCurrentClient(initial.id);
  }
}

function bindAppShell() {
  $('logoutBtn').addEventListener('click', async () => {
    await signOut();
    // onAuthChange fires → showLogin()
  });

  $('clientSelect').addEventListener('change', async (e) => {
    await setCurrentClient(e.target.value);
  });

  // Tab nav (event delegation)
  $('sidebarNav').addEventListener('click', async (e) => {
    const item = e.target.closest('.nav-item');
    if (!item || !item.dataset.tab) return;
    const next = item.dataset.tab;
    if (!TABS.includes(next) || next === state.currentTab) return;
    await switchTab(next);
  });

  // Composer (messages)
  $('composerSend').addEventListener('click', handleSend);
  $('composerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
}

function populateClientSwitcher() {
  const sel = $('clientSelect');
  sel.innerHTML = state.clients
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join('');
}

async function setCurrentClient(clientId) {
  state.currentClientId = clientId;
  localStorage.setItem(LAST_CLIENT_KEY, clientId);
  $('clientSelect').value = clientId;

  const client = state.clients.find((c) => c.id === clientId);
  updatePageHeader(client);

  // Hide the no-clients banner; remount whichever tab is active
  $('noClientsState').style.display = 'none';
  await mountCurrentTab();
}

function showNoClients() {
  TABS.forEach((t) => { const el = $(`tab-${t}`); if (el) el.style.display = 'none'; });
  $('noClientsState').style.display = 'block';
  $('pageTitle').textContent = 'Welcome';
  $('pageSub').textContent = '';
}

// ---------------------------------------------------------------------
// Tab routing
// ---------------------------------------------------------------------

const TAB_TITLES = {
  financials:  { title: 'Financials',                 sub: 'P&L, Prime Sheet, and other monthly documents' },
  kpi:         { title: 'KPI Dashboard',              sub: 'Current Prime Sheet at a glance' },
  projections: { title: 'Projections',                sub: 'Forward-looking forecasts' },
  messages:    { title: 'Client Specific Messages',   sub: 'Conversation with the Bald Ginger team' },
};

async function switchTab(next) {
  // Unmount the current tab (cleanup hooks)
  unmountCurrentTab();

  state.currentTab = next;
  localStorage.setItem(LAST_TAB_KEY, next);

  highlightNav(next);
  showPane(next);

  updatePageHeader(state.clients.find((c) => c.id === state.currentClientId));

  // Mount the new tab (only if we have a client)
  if (state.currentClientId) await mountCurrentTab();
}

function highlightNav(tab) {
  document.querySelectorAll('.nav-item[data-tab]').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
}

function showPane(tab) {
  TABS.forEach((t) => {
    const el = $(`tab-${t}`);
    if (el) el.style.display = (t === tab ? 'block' : 'none');
  });
}

function updatePageHeader(client) {
  const meta = TAB_TITLES[state.currentTab] || { title: '—', sub: '' };
  // For Messages, prefer the client name as the title (keeps prior behavior).
  if (state.currentTab === 'messages' && client) {
    $('pageTitle').textContent = client.name;
  } else {
    $('pageTitle').textContent = meta.title;
  }
  $('pageSub').textContent = meta.sub;
}

async function mountCurrentTab() {
  const t = state.currentTab;
  const clientId = state.currentClientId;
  if (!clientId) return;

  try {
    if (t === 'financials') {
      await mountFinancials({
        clientId,
        isTeam: !!state.profile.is_team,
        userId: state.user.id,
      });
    } else if (t === 'kpi') {
      await mountKPI({ clientId });
    } else if (t === 'messages') {
      await loadMessages(clientId, $('msgList'), state.user.id);
    }
    // projections: nothing to mount; it's a static "coming soon" card.
  } catch (err) {
    // Defensive: mount functions also handle their own errors, but if one
    // throws synchronously, we don't want it to break tab switching.
    console.error(`mount(${t}) failed:`, err);
  }
}

function unmountCurrentTab() {
  const t = state.currentTab;
  try {
    if (t === 'financials') unmountFinancials();
    else if (t === 'kpi')   unmountKPI();
    else if (t === 'messages') unsubscribeMessages();
  } catch (err) {
    console.error(`unmount(${t}) failed:`, err);
  }
}

// ---------------------------------------------------------------------
// Messages (existing logic kept for the messages tab)
// ---------------------------------------------------------------------
async function handleSend() {
  const input = $('composerInput');
  const body = input.value.trim();
  if (!body || !state.currentClientId) return;

  const btn = $('composerSend');
  btn.disabled = true;
  try {
    await sendMessage({
      clientId: state.currentClientId,
      author: state.profile.full_name || state.profile.email,
      body,
      isTeam: !!state.profile.is_team,
    });
    input.value = '';
  } catch (err) {
    console.error('sendMessage failed:', err);
    alert('Could not send your message. ' + (err.message || ''));
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
