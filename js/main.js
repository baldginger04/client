// =====================================================================
// main.js — entry point. Wires auth, client switcher, tabs, and pages.
// =====================================================================
import { sb, LAST_CLIENT_KEY } from './config.js';
import { signIn, signOut, loadUserContext, onAuthChange, sendPasswordReset, updatePassword } from './auth.js';
import { loadMessages, unsubscribeMessages } from './messages.js';
import { mountFinancials, unmountFinancials } from './financials.js';
// KPI Dashboard now renders P&L trend charts (Phase 2 step 5). The old
// kpi.js (Prime Sheet via SheetJS) is no longer used.
import { mountKPI, unmountKPI } from './charts.js';
import { mountPnlSummary, unmountPnlSummary } from './pnl-summary.js';
import { mountDocuments, unmountDocuments } from './documents.js';
import { mountHome as mountHomeView, unmountHome } from './home.js';

const LAST_TAB_KEY = 'bg_client_portal_last_tab';
const DEFAULT_TAB = 'home';
const TABS = ['home', 'financials', 'kpi', 'pnl-summary', 'documents', 'projections', 'messages'];

// App state
const state = {
  user: null,        // auth user
  profile: null,     // profiles row (full_name, is_team)
  clients: [],       // [{id, name}]
  currentClientId: null,
  currentTab: DEFAULT_TAB,
};

// True when the page was opened from a password-reset link. Captured here at
// module load — synchronously, before supabase-js gets a chance to strip the
// "#...type=recovery" hash off the URL during its async init.
let isRecovering = (window.location.hash || '').includes('type=recovery');

// DOM refs (filled in on DOMContentLoaded)
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  bindLoginForm();
  bindForgotFlow();
  bindAppShell();

  // Arrived from a password-reset link → show the "set new password" form and
  // stay out of the app until they finish.
  if (isRecovering) showResetForm();

  // Single source of truth for auth state. onAuthChange fires INITIAL_SESSION on
  // load (restoring an existing session), SIGNED_IN on login, SIGNED_OUT on
  // logout, and PASSWORD_RECOVERY when a reset link is opened.
  //
  // IMPORTANT: enterApp/showLogin are deferred with setTimeout(…,0). supabase-js
  // holds an internal lock while this callback runs, and enterApp queries the
  // database (loadUserContext). Calling that from inside the callback deadlocks
  // and makes sign-in hang forever. Deferring lets the lock release first.
  onAuthChange((session, event) => {
    if (event === 'PASSWORD_RECOVERY') { isRecovering = true; showResetForm(); return; }
    if (isRecovering) return;            // sit on the reset form; don't enter the app
    setTimeout(() => {
      if (session) enterApp(session.user);
      else showLogin();
    }, 0);
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
  if (!isRecovering) showSignIn();
}

// ---------------------------------------------------------------------
// Forgot / reset password
// ---------------------------------------------------------------------
function bindForgotFlow() {
  $('forgotLink').addEventListener('click', (e) => { e.preventDefault(); showForgot(); });
  $('backToSignIn').addEventListener('click', (e) => { e.preventDefault(); showSignIn(); });
  $('forgotForm').addEventListener('submit', (e) => { e.preventDefault(); handleSendReset(); });
  $('resetForm').addEventListener('submit', (e) => { e.preventDefault(); handleUpdatePassword(); });
}

function showSignIn() {
  $('forgotForm').style.display = 'none';
  $('resetForm').style.display = 'none';
  $('loginForm').style.display = 'block';
}

function showForgot() {
  $('loginForm').style.display = 'none';
  $('resetForm').style.display = 'none';
  $('forgotForm').style.display = 'block';
  const typed = $('loginEmail').value.trim();
  if (typed) $('forgotEmail').value = typed;
  $('forgotMsg').textContent = '';
  $('forgotEmail').focus();
}

function showResetForm() {
  // Force the login screen visible even if we got here mid-session.
  $('loginScreen').style.display = 'flex';
  $('appShell').style.display = 'none';
  $('loginForm').style.display = 'none';
  $('forgotForm').style.display = 'none';
  $('resetForm').style.display = 'block';
}

async function handleSendReset() {
  const email = $('forgotEmail').value.trim();
  const msg = $('forgotMsg');
  const btn = $('forgotBtn');
  msg.style.color = '';
  if (!email) { msg.textContent = 'Enter your email address.'; return; }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending…';
  try {
    // The link returns the user to wherever the portal is served from.
    await sendPasswordReset(email, window.location.origin + window.location.pathname);
    msg.style.color = '#16a34a';
    msg.textContent = "Check your email for a reset link. It can take a minute to arrive.";
  } catch (err) {
    msg.style.color = '';
    msg.textContent = err.message || 'Could not send the reset email. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send reset link';
  }
}

async function handleUpdatePassword() {
  const p1 = $('resetPass1').value;
  const p2 = $('resetPass2').value;
  const msg = $('resetMsg');
  const btn = $('resetBtn');
  msg.style.color = '';
  if (p1.length < 8) { msg.textContent = 'Password must be at least 8 characters.'; return; }
  if (p1 !== p2)     { msg.textContent = 'The two passwords do not match.'; return; }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Updating…';
  try {
    await updatePassword(p1);
    msg.style.color = '#16a34a';
    msg.textContent = 'Password updated. Taking you in…';
    // Strip the recovery hash and reload; the active session lands them in the app.
    setTimeout(() => window.location.replace(window.location.origin + window.location.pathname), 1200);
  } catch (err) {
    msg.style.color = '';
    msg.textContent = err.message || 'Could not update the password. The link may have expired — request a new one.';
    btn.disabled = false;
    btn.textContent = 'Update password';
  }
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

  // Landing tab. Team members (Ed, Lydia, the Jennifers) always start on Home
  // so the cross-client open-questions board is the first thing they see every
  // time they open the portal. Clients resume their last tab, falling back to Home.
  if (state.profile.is_team) {
    state.currentTab = 'home';
  } else {
    const savedTab = localStorage.getItem(LAST_TAB_KEY);
    state.currentTab = TABS.includes(savedTab) ? savedTab : DEFAULT_TAB;
  }
  highlightNav(state.currentTab);
  showPane(state.currentTab);

  // Pick a client and mount the current tab
  if (state.clients.length === 0) {
    showNoClients();
  } else {
    const saved = localStorage.getItem(LAST_CLIENT_KEY);
    const initial = state.clients.find((c) => c.id === saved) || state.clients[0];
    await setCurrentClient(initial.id);
    // setCurrentClient mounts the active *client* tab; Home isn't client-scoped,
    // so when it's the landing tab we mount it explicitly.
    if (state.currentTab === 'home') await mountHomeTab();
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

  // Refresh + (re)subscribe the "Client Questions" notification badge.
  loadClientQuestionsBadge();
  subscribeClientQuestionsBadge();

  await mountCurrentTab();
}

// ---------------------------------------------------------------------
// Client Questions nav badge — lights up when the Bald Ginger team has
// posted a client-facing message the client hasn't responded to yet.
// "Latest message in a thread is from the team and not cleared" = awaiting
// the client. Internal team notes (is_internal = true) are excluded here AND
// blocked by RLS, so they never surface to the client or trigger the badge.
// No per-user read state: it clears when the client replies (latest flips to
// them) or the team resolves the thread.
// ---------------------------------------------------------------------
let cqBadgeChannel = null;

async function loadClientQuestionsBadge() {
  const badge = $('cqBadge');
  if (!badge) return;
  const clientId = state.currentClientId;
  if (!clientId) { badge.style.display = 'none'; return; }
  try {
    const { data, error } = await sb
      .from('messages')
      .select('id, parent_message_id, is_team, created_at, cleared')
      .eq('client_id', clientId)
      .eq('is_internal', false)
      .eq('cleared', false);
    if (error) throw error;
    const latest = new Map();  // thread root -> latest message meta
    for (const m of (data || [])) {
      const key = m.parent_message_id || m.id;
      const cur = latest.get(key);
      if (!cur || new Date(m.created_at) > new Date(cur.created_at)) {
        latest.set(key, { created_at: m.created_at, is_team: m.is_team });
      }
    }
    let count = 0;
    latest.forEach((v) => { if (v.is_team === true) count++; });
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  } catch (err) {
    console.error('loadClientQuestionsBadge error:', err);
  }
}

function subscribeClientQuestionsBadge() {
  if (cqBadgeChannel) { sb.removeChannel(cqBadgeChannel); cqBadgeChannel = null; }
  const clientId = state.currentClientId;
  if (!clientId) return;
  cqBadgeChannel = sb
    .channel(`cq-badge-${clientId}`)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `client_id=eq.${clientId}` },
        () => loadClientQuestionsBadge())
    .subscribe();
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
  home:        { title: 'Home',                       sub: 'Your clients and any open questions' },
  financials:  { title: 'Financials',                 sub: 'P&L, Prime Sheet, and other monthly documents' },
  kpi:         { title: 'KPI Dashboard',              sub: 'Trailing 13 months from your P&L data' },
  'pnl-summary': { title: 'Prime Sheet',              sub: 'Current month vs prior month and same month last year' },
  documents:   { title: 'Documents',                  sub: 'W-9s, voided checks, tax documents, and other long-lived records' },
  projections: { title: 'Projections',                sub: 'Forward-looking forecasts' },
  messages:    { title: 'Client Questions',          sub: 'Questions and answers with the Bald Ginger team' },
};

async function switchTab(next) {
  // Unmount the current tab (cleanup hooks)
  unmountCurrentTab();

  state.currentTab = next;
  localStorage.setItem(LAST_TAB_KEY, next);

  highlightNav(next);
  showPane(next);

  updatePageHeader(state.clients.find((c) => c.id === state.currentClientId));

  // Mount the new tab. Home isn't client-scoped; every other tab needs a client.
  if (next === 'home') await mountHomeTab();
  else if (state.currentClientId) await mountCurrentTab();
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
  // KPI Dashboard, P&L Summary, Financials, and Documents all use a wider layout.
  // Toggle a class on .main so the global max-width:980px constraint is lifted.
  const mainEl = document.querySelector('.main');
  if (mainEl) mainEl.classList.toggle('main-wide', tab === 'kpi' || tab === 'pnl-summary' || tab === 'financials' || tab === 'documents');
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
        fullName: state.profile.full_name,
      });
    } else if (t === 'kpi') {
      await mountKPI({ clientId });
    } else if (t === 'pnl-summary') {
      await mountPnlSummary({ clientId });
    } else if (t === 'documents') {
      await mountDocuments({ clientId, isTeam: !!state.profile.is_team, userId: state.user.id });
    } else if (t === 'messages') {
      await loadMessages({
        clientId,
        userId: state.user.id,
        author: state.profile.full_name || state.profile.email,
        isTeam: !!state.profile.is_team,
      });
    }
    // projections: nothing to mount; placeholder "coming soon" card.
  } catch (err) {
    // Defensive: mount functions also handle their own errors, but if one
    // throws synchronously, we don't want it to break tab switching.
    console.error(`mount(${t}) failed:`, err);
  }
}

// Home isn't tied to a single client — it lists them all. Clicking a client
// selects it and drops you on its Client Questions tab.
async function mountHomeTab() {
  await mountHomeView({
    clients: state.clients,
    isTeam: !!state.profile.is_team,
    onPick: async (clientId) => {
      state.currentClientId = clientId;
      localStorage.setItem(LAST_CLIENT_KEY, clientId);
      const sel = $('clientSelect');
      if (sel) sel.value = clientId;
      loadClientQuestionsBadge();
      subscribeClientQuestionsBadge();
      await switchTab('messages');
    },
  });
}

function unmountCurrentTab() {
  const t = state.currentTab;
  try {
    if (t === 'home') unmountHome();
    else if (t === 'financials') unmountFinancials();
    else if (t === 'kpi')   unmountKPI();
    else if (t === 'pnl-summary') unmountPnlSummary();
    else if (t === 'documents') unmountDocuments();
    else if (t === 'messages') unsubscribeMessages();
  } catch (err) {
    console.error(`unmount(${t}) failed:`, err);
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
