// =====================================================================
// kpi.js — KPI Dashboard tab. Phase 1: render latest uploaded
// Prime Sheet for the current client. Phase 2 will replace this with
// structured Prime Sheet data + line charts.
// =====================================================================

import { sb } from './config.js';
import { downloadAsBuffer, renderWorkbookHTML, bindSheetTabs } from './financials.js';

const LOAD_TIMEOUT_MS = 30_000;

let state = {
  clientId: null,
};

export async function mountKPI({ clientId }) {
  state.clientId = clientId;
  await loadAndRender();
}

export function unmountKPI() {
  // No teardown yet.
}

async function loadAndRender() {
  const host = document.getElementById('kpiContent');
  if (!host) return;
  host.innerHTML = '<div class="state-msg"><span class="spinner"></span> Loading KPI dashboard…</div>';

  try {
    let file;
    try {
      file = await withTimeout(fetchLatestPrimeSheet(state.clientId), LOAD_TIMEOUT_MS);
    } catch (firstErr) {
      if (firstErr && firstErr.code === 'TIMEOUT') {
        host.innerHTML = '<div class="state-msg"><span class="spinner"></span> Warming up…</div>';
        file = await withTimeout(fetchLatestPrimeSheet(state.clientId), LOAD_TIMEOUT_MS);
      } else {
        throw firstErr;
      }
    }
    if (!file) {
      host.innerHTML = `
        <div class="card empty-card">
          <div class="empty-title">No Prime Sheet for this client yet</div>
          <div class="empty-sub">
            Once a Prime Sheet has been uploaded under the Financials tab,
            its latest version will appear here. In a future release this
            tab will show line charts of monthly costs.
          </div>
        </div>`;
      return;
    }

    // Render header card + xlsx preview
    host.innerHTML = `
      <section class="card" style="margin-bottom: 1rem;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap;">
          <div>
            <div style="font-size:11px; color: var(--text3); text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px;">
              Latest Prime Sheet
            </div>
            <div style="font-family: var(--font-display); font-size: 20px; color: var(--text);">
              ${escapeHtml(formatPeriodLabel(file.period))}
            </div>
            <div style="font-size:12px; color: var(--text2); margin-top:4px;">
              ${escapeHtml(file.filename)}
            </div>
          </div>
          <div style="font-size:11px; color: var(--text3);">
            Uploaded ${formatDate(file.created_at)}
          </div>
        </div>
      </section>
      <div id="kpiPreviewHost"></div>`;

    const previewHost = document.getElementById('kpiPreviewHost');
    previewHost.innerHTML = '<div class="state-msg"><span class="spinner"></span> Rendering Prime Sheet…</div>';

    try {
      const buffer = await downloadAsBuffer(file.storage_path);
      const wb = XLSX.read(buffer, { type: 'array' });
      previewHost.innerHTML = renderWorkbookHTML(wb);
      bindSheetTabs(previewHost, wb);
    } catch (err) {
      console.error('KPI preview failed:', err);
      previewHost.innerHTML = `<div class="state-msg error">Couldn't render Prime Sheet: ${escapeHtml(err.message || String(err))}</div>`;
    }
  } catch (err) {
    console.error('KPI load failed:', err);
    if (err && err.code === 'TIMEOUT') {
      host.innerHTML = retryHtml('Loading is taking longer than expected.');
    } else {
      host.innerHTML = retryHtml(`Couldn't load KPI dashboard: ${escapeHtml(err.message || String(err))}`);
    }
    bindRetry(loadAndRender);
  }
}

async function fetchLatestPrimeSheet(clientId) {
  // Get the most recently uploaded prime_sheet for this client, regardless
  // of archive status (we want clients to see their most recent KPIs even
  // after the month closes).
  const { data, error } = await sb
    .from('files')
    .select('id, client_id, storage_path, filename, file_type, period, created_at')
    .eq('client_id', clientId)
    .eq('file_type', 'prime_sheet')
    .order('period', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// ----- utils (duplicated to keep this module independent) -----

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPeriodLabel(period) {
  const [y, m] = (period || '').split('-').map(Number);
  if (!y || !m) return period || '—';
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject({ code: 'TIMEOUT', message: 'Timed out' }), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

function retryHtml(msg) {
  return `
    <div class="retry-state">
      <div>${escapeHtml(msg)}</div>
      <button class="btn btn-ghost btn-sm" id="retryBtn">Retry</button>
    </div>`;
}
function bindRetry(fn) {
  const btn = document.getElementById('retryBtn');
  if (btn) btn.addEventListener('click', fn);
}
