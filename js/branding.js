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
  if (img) {
    img.addEventListener('error', () => { img.style.display = 'none'; });
    // Many logos carry wide blank margins, which makes them render tiny.
    // Swap in a margin-trimmed copy; if that fails, the original stays.
    const token = renderToken;
    loadImageAsPng(url, 600, { trim: true }).then((t) => {
      if (t && token === renderToken && img.isConnected) img.src = t.dataUrl;
    });
  }
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
 * opts.trim: crop away transparent / near-white margins first.
 */
export function loadImageAsPng(url, maxEdge = 600, opts = {}) {
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
        // Crop box in source pixels (whole image unless trimming).
        let sx = 0, sy = 0, sw = w0, sh = h0;
        if (opts.trim) {
          const probe = document.createElement('canvas');
          probe.width = w0; probe.height = h0;
          const pg = probe.getContext('2d');
          pg.drawImage(img, 0, 0);
          const px = pg.getImageData(0, 0, w0, h0).data;   // throws if CORS-tainted -> caught below
          let x0 = w0, y0 = h0, x1 = -1, y1 = -1;
          for (let y = 0; y < h0; y++) {
            for (let x = 0; x < w0; x++) {
              const i = (y * w0 + x) * 4;
              const blank = px[i + 3] < 16 || (px[i] > 245 && px[i + 1] > 245 && px[i + 2] > 245);
              if (!blank) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
            }
          }
          if (x1 >= 0) {
            const padX = Math.round((x1 - x0 + 1) * 0.02), padY = Math.round((y1 - y0 + 1) * 0.02);
            sx = Math.max(0, x0 - padX); sy = Math.max(0, y0 - padY);
            sw = Math.min(w0, x1 + padX + 1) - sx; sh = Math.min(h0, y1 + padY + 1) - sy;
          }
        }
        const k = Math.min(1, maxEdge / Math.max(sw, sh));
        const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
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
