// =====================================================================
// auth.js — login, session, profile + client list lookup, logout
// =====================================================================
import { sb } from './config.js';

/** Sign the user in with email + password. */
export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/** Sign the user out. */
export async function signOut() {
  await sb.auth.signOut();
}

/** Get the current Supabase session (or null). */
export async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session;
}

/**
 * Load everything we need about the logged-in user:
 *   - their profile row (full_name, is_team)
 *   - the list of clients they have access to
 * Returns: { profile, clients }
 */
export async function loadUserContext(userId) {
  // Profile
  const { data: profile, error: pErr } = await sb
    .from('profiles')
    .select('id, email, full_name, is_team, active')
    .eq('id', userId)
    .single();
  if (pErr) throw pErr;

  // Client list. RLS makes this return only the clients the user can access:
  //   - team members see all clients
  //   - portal users see only clients they're linked to via client_users
  const { data: clients, error: cErr } = await sb
    .from('clients')
    .select('id, name')
    .order('name');
  if (cErr) throw cErr;

  return { profile, clients: clients || [] };
}

/** Subscribe to auth state changes (login/logout). */
export function onAuthChange(callback) {
  return sb.auth.onAuthStateChange((_event, session) => callback(session));
}
