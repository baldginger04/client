// =====================================================================
// branding.js — the client's logo in the top-right of the page header.
//
//   - Logos live in the public Storage bucket `client-logos`, one folder per
//     client ({client_id}/logo-{timestamp}.png). The public URL is saved on
//     clients.logo_url. Public is fine here: a logo is not confidential, and
//     a public URL never expires, which also lets the Prime Sheet PDF embed it.
//   - Team members can add, change or remove a logo right from the header.
//     Clients just see their logo (or nothing, if none has been added).
//   - The client row is read with select('*') so this module keeps working
//     even before the logo_url column exists — it simply shows no logo.
// =====================================================================
import { sb } from './config.js';

const LOGO_BUCKET = 'client-logos';
const MAX_BYTES = 2 * 1024 * 1024;           // 2 MB — matches the bucket limit
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];

const cache = {};          // client_id -> clients row (or null)
let renderToken = 0;       // guards against a slow fetch painting the wrong client
let ctx = { client: null, isTeam: false, visible: false };

/** Read (and cache) the client row. Never throws; returns null on failure. */
export async function getClientRow(clientId, { fresh = false } = {}) {
  if (!clientId) return null;
  if (!fresh && Object.prototype.hasOwnProperty.call(cache, clientId)) return cache[clientId];
  try {
    const { data, error } = await sb.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (error) throw error;
    cache[clientId] = data || null;
  } catch (e) {
    console.warn('branding: could not read client row', e);
    cache[clientId] = null;
  }
  return cache[clientId];
}

/**
 * Paint (or hide) the logo slot. Called by main.js every time the page
 * header updates — i.e. on client switch and on tab switch.
 *   client  — { id, name } from the client switcher
 *   isTeam  — team members get the add/change/remove controls
 *   visible — false on Home (not client-scoped) and the no-clients state
 */
export async function applyClientBranding({ client, isTeam, visible }) {
  ctx = { client: client || null, isTeam: !!isTeam, visible: !!visible };
  const host = document.getElementById('clientBrand');
  if (!host) return;
  const token = ++renderToken;
  if (!ctx.visible || !ctx.client) { host.innerHTML = ''; host.style.display = 'none'; return; }
  const row = await getClientRow(ctx.client.id);
  if (token !== renderToken) return;   // a newer call has taken over
  paint(host, row);
}

function paint(host, row) {
  const url = row && row.logo_url;
  const team = ctx.isTeam;
  const name = (ctx.client && ctx.client.name) || '';
  if (!url && !team) { host.innerHTML = ''; host.style.display = 'none'; return; }
  host.style.display = '';
  let html = '';
  if (url) {
    html += '<img class="client-brand-img" alt="' + esc(name) + ' logo" src="' + esc(url) + '">';
    if (team) {
      html += '<div class="client-brand-actions">'
        + '<button type="button" data-act="change">Change logo</button>'
        + '<span aria-hidden="true">·</span>'
        + '<button type="button" data-act="remove">Remove</button>'
        + '</div>';
    }
  } else {
    html += '<button type="button" class="client-brand-add" data-act="change">+ Add client logo</button>';
  }
  html += '<div class="client-brand-msg" id="clientBrandMsg"></div>';
  html += '<input type="file" id="clientBrandFile" accept="' + ACCEPT.join(',') + '" hidden>';
  host.innerHTML = html;

  const img = host.querySelector('.client-brand-img');
  if (img) img.addEventListener('error', () => { img.style.display = 'none'; });
  if (!team) return;

  const file = host.querySelector('#clientBrandFile');
  host.querySelectorAll('[data-act="change"]').forEach((b) => b.addEventListener('click', () => file.click()));
  const rm = host.querySelector('[data-act="remove"]');
  if (rm) rm.addEventListener('click', () => removeLogo(host, row));
  file.addEventListener('change', () => { const f = file.files && file.files[0]; if (f) uploadLogo(host, row, f); });
}

function say(host, text, color) {
  const m = host.querySelector('#clientBrandMsg');
  if (m) { m.textContent = text || ''; m.style.color = color || 'var(--text3)'; }
}

async function uploadLogo(host, row, f) {
  const client = ctx.client;
  if (!client) return;
  if (!ACCEPT.includes(f.type)) { say(host, 'Use a PNG, JPG or WebP image.', '#b93232'); return; }
  if (f.size > MAX_BYTES) { say(host, 'That image is over 2 MB — use a smaller one.', '#b93232'); return; }
  say(host, 'Uploading…');
  try {
    const ext = f.type === 'image/png' ? 'png' : f.type === 'image/webp' ? 'webp' : 'jpg';
    const path = client.id + '/logo-' + Date.now() + '.' + ext;
    const up = await sb.storage.from(LOGO_BUCKET).upload(path, f, { contentType: f.type, cacheControl: '31536000', upsert: false });
    if (up.error) throw up.error;
    const publicUrl = sb.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl;
    const { error } = await sb.from('clients').update({ logo_url: publicUrl }).eq('id', client.id);
    if (error) {
      sb.storage.from(LOGO_BUCKET).remove([path]).catch(() => {});
      throw error;
    }
    removeStoredFile(row && row.logo_url);       // tidy up the previous logo
    cache[client.id] = Object.assign({}, row || {}, { logo_url: publicUrl });
    if (ctx.client && ctx.client.id === client.id) paint(host, cache[client.id]);
  } catch (e) {
    say(host, 'Couldn’t save the logo: ' + (e.message || e), '#b93232');
  }
}

async function removeLogo(host, row) {
  const client = ctx.client;
  if (!client) return;
  if (!window.confirm('Remove ' + (client.name || 'this client') + '’s logo from the portal?')) return;
  say(host, 'Removing…');
  try {
    const { error } = await sb.from('clients').update({ logo_url: null }).eq('id', client.id);
    if (error) throw error;
    removeStoredFile(row && row.logo_url);
    cache[client.id] = Object.assign({}, row || {}, { logo_url: null });
    if (ctx.client && ctx.client.id === client.id) paint(host, cache[client.id]);
  } catch (e) {
    say(host, 'Couldn’t remove it: ' + (e.message || e), '#b93232');
  }
}

// Best-effort delete of an old logo file. Only touches files in our bucket.
function removeStoredFile(url) {
  if (!url) return;
  const marker = '/storage/v1/object/public/' + LOGO_BUCKET + '/';
  const i = url.indexOf(marker);
  if (i < 0) return;
  const path = decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
  sb.storage.from(LOGO_BUCKET).remove([path]).catch(() => {});
}

/**
 * Load an image (any format the browser can draw) and return it as a PNG
 * data URL with its natural size — what jsPDF needs. Resolves null if the
 * image can't be loaded or read (e.g. a CORS failure); callers just skip it.
 */
export function loadImageAsPng(url, maxEdge = 600) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 10000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
        if (!w0 || !h0) { resolve(null); return; }
        const k = Math.min(1, maxEdge / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: c.toDataURL('image/png'), w, h });
      } catch (e) { resolve(null); }
    };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
