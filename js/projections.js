// js/projections.js
// Projections tab — Phase 1, slice 1: team-only SETUP panel.
// Configures a client's projection profile (sales-entry method, average check,
// food/LBW split, tracked categories) and effective-dated monthly cost goals.
// Reads/writes projection_profiles + projection_goals. Client (non-team) users
// get a friendly placeholder until the pace-to-goal view lands in a later slice.

import { sb } from './config.js';

const PANE = 'tab-projections';

const CATS = [
  { key: 'food',     label: 'Food' },
  { key: 'lbw',      label: 'Liquor · Beer · Wine' },
  { key: 'supplies', label: 'Supplies & Smallwares' },
];
const METHODS = [
  { key: 'covers_daily',   title: 'Covers by day',   desc: 'Guest counts per day. Most precise.' },
  { key: 'covers_weekly',  title: 'Covers by week',  desc: 'One guest count for the week.' },
  { key: 'revenue_weekly', title: 'Revenue by week', desc: 'Enter food & LBW dollars directly.' },
];

let ctx = null; // { clientId, isTeam, userId }

function firstOfMonthISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function monthLabel(d = new Date()) {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function mountProjections({ clientId, isTeam, userId }) {
  ctx = { clientId, isTeam: !!isTeam, userId };
  const pane = document.getElementById(PANE);
  if (!pane) return;

  if (!ctx.isTeam) {
    pane.innerHTML = pjStyles() + `
      <div class="pj-wrap"><div class="pj-empty">
        <div class="pj-empty-emoji">🔮</div>
        <div class="pj-empty-t">Your live pace-to-goal view is coming here soon</div>
        <div class="pj-empty-s">Real-time food and bar spend against your monthly targets.</div>
      </div></div>`;
    return;
  }

  pane.innerHTML = pjStyles() + `<div class="pj-wrap"><div class="pj-loading">Loading setup…</div></div>`;

  let profile = null, goals = [];
  try {
    const [p, g] = await Promise.all([
      sb.from('projection_profiles').select('*').eq('client_id', clientId).maybeSingle(),
      sb.from('projection_goals').select('category,effective_from,goal_pct').eq('client_id', clientId),
    ]);
    if (p.error) throw p.error;
    if (g.error) throw g.error;
    profile = p.data || null;
    goals = g.data || [];
  } catch (e) {
    pane.innerHTML = pjStyles() + `<div class="pj-wrap"><div class="pj-err">Couldn't load setup: ${esc(e.message)}</div></div>`;
    return;
  }

  renderSetup(pane, profile, currentGoals(goals));
}

export function unmountProjections() { ctx = null; }

// The goal in effect for the current month = latest effective_from <= this month.
function currentGoals(goals) {
  const month = firstOfMonthISO();
  const out = {};
  for (const cat of CATS.map((c) => c.key)) {
    const rows = goals
      .filter((g) => g.category === cat && g.effective_from <= month)
      .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
    if (rows.length) out[cat] = rows[0].goal_pct;
  }
  return out;
}

function renderSetup(pane, profile, goalsByCat) {
  const method = profile?.method || 'covers_daily';
  const avg = profile?.avg_check ?? '';
  const mix = profile?.food_mix_pct != null ? Math.round(profile.food_mix_pct * 100) : '';
  const cats = profile?.categories || ['food', 'lbw', 'supplies'];
  const revenueOnly = method === 'revenue_weekly';

  const methodCards = METHODS.map((m) => `
    <div class="pj-method ${m.key === method ? 'on' : ''}" data-method="${m.key}">
      <div class="pj-mt">${m.title}</div><div class="pj-md">${m.desc}</div>
    </div>`).join('');

  const catToggles = CATS.map((c) => `
    <label class="pj-cat ${cats.includes(c.key) ? 'on' : ''}">
      <input type="checkbox" data-cat="${c.key}" ${cats.includes(c.key) ? 'checked' : ''}> ${c.label}
    </label>`).join('');

  const goalInputs = CATS.map((c) => `
    <div class="pj-goal" data-goalwrap="${c.key}" ${cats.includes(c.key) ? '' : 'style="display:none"'}>
      <div class="pj-gk">${c.label}</div>
      <div class="pj-gv">
        <input type="number" step="0.1" min="0" data-goal="${c.key}"
               value="${goalsByCat[c.key] != null ? +(goalsByCat[c.key] * 100).toFixed(2) : ''}">
        <span>%</span>
      </div>
    </div>`).join('');

  pane.innerHTML = pjStyles() + `
  <div class="pj-wrap">
    <div class="pj-head">
      <div class="pj-title">Projection setup</div>
      <div class="pj-sub">Set how sales come in and the monthly cost goals. Change anytime — new settings only affect future months.</div>
    </div>

    <div class="pj-panel">
      <div class="pj-field">
        <div class="pj-flabel">How sales are entered</div>
        <div class="pj-fhelp">Pick whichever fits this client.</div>
        <div class="pj-methods">${methodCards}</div>
      </div>

      <div class="pj-field" data-avgwrap ${revenueOnly ? 'style="display:none"' : ''}>
        <div class="pj-flabel">Average check</div>
        <div class="pj-fhelp">Turns covers into dollars. From Toast once connected — set by hand for now.</div>
        <div class="pj-row">
          <div class="pj-money"><span>$</span><input type="number" step="0.01" min="0" id="pjAvg" value="${avg}"></div>
          <div class="pj-src"><span class="on">Manual</span><span class="dis">Toast — soon</span></div>
        </div>
      </div>

      <div class="pj-field" data-mixwrap ${revenueOnly ? 'style="display:none"' : ''}>
        <div class="pj-flabel">Food vs LBW split</div>
        <div class="pj-fhelp">Splits a blended check into food and bar dollars. Auto-pull from the P&amp;L is coming — set it for now.</div>
        <div class="pj-row">
          <div class="pj-money"><input type="number" step="1" min="0" max="100" id="pjMix" value="${mix}" style="width:70px"><span>% food</span></div>
          <div class="pj-mixnote" id="pjMixNote"></div>
        </div>
      </div>

      <div class="pj-field">
        <div class="pj-flabel">Categories tracked</div>
        <div class="pj-fhelp">A food-only client can track just food — the other cards won't show for them.</div>
        <div class="pj-cats">${catToggles}</div>
      </div>

      <div class="pj-field">
        <div class="pj-flabel">Monthly cost goals <span class="pj-tag">effective ${monthLabel()}</span></div>
        <div class="pj-fhelp">The targets the team paces against. Tighten them as the client improves — past months keep their goals.</div>
        <div class="pj-goals">${goalInputs}</div>
      </div>

      <div class="pj-save">
        <button class="pj-btn" id="pjSave">Save settings</button>
        <span class="pj-note" id="pjMsg">Set once, change anytime — new settings only affect future months.</span>
      </div>
    </div>
  </div>`;

  wire(pane, method);
}

function wire(pane, method) {
  let current = method;

  pane.querySelectorAll('.pj-method').forEach((el) =>
    el.addEventListener('click', () => {
      pane.querySelectorAll('.pj-method').forEach((x) => x.classList.remove('on'));
      el.classList.add('on');
      current = el.dataset.method;
      const rev = current === 'revenue_weekly';
      const a = pane.querySelector('[data-avgwrap]');
      const m = pane.querySelector('[data-mixwrap]');
      if (a) a.style.display = rev ? 'none' : '';
      if (m) m.style.display = rev ? 'none' : '';
    }));

  pane.querySelectorAll('input[data-cat]').forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.closest('.pj-cat').classList.toggle('on', cb.checked);
      const gw = pane.querySelector(`[data-goalwrap="${cb.dataset.cat}"]`);
      if (gw) gw.style.display = cb.checked ? '' : 'none';
    }));

  const mixInput = pane.querySelector('#pjMix');
  const mixNote = pane.querySelector('#pjMixNote');
  const updMix = () => {
    const v = parseFloat(mixInput?.value);
    if (mixNote) mixNote.textContent = v >= 0 && v <= 100 ? `LBW ${+(100 - v).toFixed(0)}%` : '';
  };
  if (mixInput) { mixInput.addEventListener('input', updMix); updMix(); }

  pane.querySelector('#pjSave').addEventListener('click', () => save(pane, current));
}

async function save(pane, method) {
  const btn = pane.querySelector('#pjSave');
  const msg = pane.querySelector('#pjMsg');
  const setMsg = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? 'var(--red)' : 'var(--green)'; } };

  const cats = Array.from(pane.querySelectorAll('input[data-cat]:checked')).map((c) => c.dataset.cat);
  if (!cats.length) { setMsg('Pick at least one category.', true); return; }

  const rev = method === 'revenue_weekly';
  const avgV = parseFloat(pane.querySelector('#pjAvg')?.value);
  const mixV = parseFloat(pane.querySelector('#pjMix')?.value);
  const avg_check = (!rev && avgV > 0) ? avgV : null;
  const food_mix_pct = (!rev && mixV >= 0 && mixV <= 100) ? (mixV / 100) : null;

  const eff = firstOfMonthISO();
  const goalRows = [];
  for (const cat of cats) {
    const gv = parseFloat(pane.querySelector(`input[data-goal="${cat}"]`)?.value);
    if (!(gv >= 0)) { setMsg(`Enter a goal % for ${CATS.find((c) => c.key === cat).label}.`, true); return; }
    goalRows.push({ client_id: ctx.clientId, category: cat, effective_from: eff, goal_pct: gv / 100, created_by: ctx.userId });
  }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Saving…';
  setMsg('', false);
  try {
    const up = await sb.from('projection_profiles').upsert({
      client_id: ctx.clientId,
      method,
      avg_check,
      avg_check_source: 'manual',
      food_mix_pct,
      mix_source: 'manual',
      categories: cats,
      week_start_dow: 1,
      updated_at: new Date().toISOString(),
      updated_by: ctx.userId,
    }, { onConflict: 'client_id' });
    if (up.error) throw up.error;

    const g = await sb.from('projection_goals')
      .upsert(goalRows, { onConflict: 'client_id,category,effective_from' });
    if (g.error) throw g.error;

    setMsg('Saved.', false);
  } catch (e) {
    setMsg('Error: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function pjStyles() {
  return `<style>
    #tab-projections .pj-wrap{max-width:760px}
    #tab-projections .pj-loading,#tab-projections .pj-err{padding:24px;color:var(--text3);font-size:14px}
    #tab-projections .pj-err{color:var(--red)}
    #tab-projections .pj-head{margin-bottom:18px}
    #tab-projections .pj-title{font-family:var(--font-display);font-weight:800;font-size:22px;color:var(--text);letter-spacing:-.01em}
    #tab-projections .pj-sub{font-size:13px;color:var(--text2);margin-top:4px;max-width:60ch}
    #tab-projections .pj-panel{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-lg);padding:24px;box-shadow:var(--shadow-sm)}
    #tab-projections .pj-field{margin-bottom:24px}
    #tab-projections .pj-field:last-of-type{margin-bottom:0}
    #tab-projections .pj-flabel{font-family:var(--font-display);font-weight:700;font-size:14px;color:var(--text)}
    #tab-projections .pj-fhelp{font-size:12.5px;color:var(--text3);margin:3px 0 11px}
    #tab-projections .pj-methods{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
    #tab-projections .pj-method{border:1.5px solid var(--border);border-radius:var(--r);padding:12px 13px;cursor:pointer;transition:.15s;background:var(--bg)}
    #tab-projections .pj-method:hover{border-color:var(--border2)}
    #tab-projections .pj-method.on{border-color:var(--navy);background:var(--warm);box-shadow:0 0 0 3px rgba(27,42,75,.07)}
    #tab-projections .pj-mt{font-family:var(--font-display);font-weight:700;font-size:13.5px;color:var(--text)}
    #tab-projections .pj-md{font-size:11.5px;color:var(--text3);margin-top:3px;line-height:1.4}
    #tab-projections .pj-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    #tab-projections .pj-money{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);border-radius:var(--r);padding:8px 11px;background:var(--bg)}
    #tab-projections .pj-money span{color:var(--text3);font-size:13px;font-weight:600}
    #tab-projections .pj-money input{border:0;outline:0;font-family:var(--font-body);font-size:14px;font-weight:600;color:var(--text);width:90px;background:transparent}
    #tab-projections .pj-src{display:inline-flex;border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
    #tab-projections .pj-src span{padding:8px 12px;font-size:12.5px;font-weight:600;color:var(--text3)}
    #tab-projections .pj-src span.on{background:var(--navy);color:#fff}
    #tab-projections .pj-src span.dis{opacity:.5}
    #tab-projections .pj-mixnote{font-size:13px;color:var(--text2);font-weight:600}
    #tab-projections .pj-cats{display:flex;flex-wrap:wrap;gap:9px}
    #tab-projections .pj-cat{display:inline-flex;align-items:center;gap:8px;border:1.5px solid var(--border);border-radius:999px;padding:7px 14px;cursor:pointer;font-size:13px;font-weight:600;color:var(--text2);transition:.15s}
    #tab-projections .pj-cat.on{border-color:var(--navy);color:var(--text);background:var(--warm)}
    #tab-projections .pj-cat input{cursor:pointer}
    #tab-projections .pj-goals{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
    #tab-projections .pj-goal{border:1px solid var(--border);border-radius:var(--r);padding:12px 14px}
    #tab-projections .pj-gk{font-size:12px;color:var(--text3);font-weight:600;margin-bottom:7px}
    #tab-projections .pj-gv{display:flex;align-items:baseline;gap:3px}
    #tab-projections .pj-gv input{width:64px;border:0;outline:0;font-family:var(--font-display);font-weight:800;font-size:24px;color:var(--navy);padding:0;background:transparent}
    #tab-projections .pj-gv span{font-family:var(--font-display);font-weight:800;font-size:17px;color:var(--text3)}
    #tab-projections .pj-tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text3);background:var(--warm);border:1px solid var(--border);border-radius:5px;padding:3px 7px;margin-left:6px;vertical-align:middle}
    #tab-projections .pj-save{display:flex;align-items:center;gap:16px;margin-top:26px;flex-wrap:wrap}
    #tab-projections .pj-btn{background:var(--coral);color:#fff;border:0;font-family:var(--font-display);font-weight:700;font-size:14px;padding:11px 22px;border-radius:var(--r);cursor:pointer}
    #tab-projections .pj-btn:disabled{opacity:.6;cursor:default}
    #tab-projections .pj-note{font-size:12.5px;color:var(--text3);font-weight:500}
    #tab-projections .pj-empty{text-align:center;padding:64px 20px;color:var(--text3)}
    #tab-projections .pj-empty-emoji{font-size:34px;margin-bottom:12px}
    #tab-projections .pj-empty-t{font-family:var(--font-display);font-weight:700;font-size:17px;color:var(--text2)}
    #tab-projections .pj-empty-s{font-size:13px;margin-top:5px}
    @media (max-width:560px){
      #tab-projections .pj-methods,#tab-projections .pj-goals{grid-template-columns:1fr}
    }
  </style>`;
}
