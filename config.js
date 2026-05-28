// =====================================================================
// config.js — Supabase connection + brand constants
// REPLACE THE TWO PLACEHOLDER VALUES BELOW with the same Supabase URL
// and anon key that Triple's index.html uses. They're safe to commit
// (anon key is public-by-design; RLS is what protects your data).
// =====================================================================

export const SUPABASE_URL = 'https://evfemokwtofbarjeezhu.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2ZmVtb2t3dG9mYmFyamVlemh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDUxMjQsImV4cCI6MjA5NTEyMTEyNH0.B9OSeB9CEP0TX80dJWpBPAIP6IEhYIzYlYKe4WL-6B0';

// Single shared client. Imported by every module that talks to Supabase.
export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// localStorage key for remembering the last selected client
export const LAST_CLIENT_KEY = 'bg_client_portal_last_client';
