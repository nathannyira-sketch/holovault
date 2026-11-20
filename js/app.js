import { db } from './db.js';
import { providers, market, fetchRate, marketLinks, GAMES, listSets, correctNames, warmDictionary, setCards, normNum } from './api.js';
import { visualScores } from './match.js';
import * as scanner from './scanner.js';
import { t, setLang, getLang } from './i18n.js';
import { lineChart, sparkline, donut, bars } from './charts.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------- état
const DEFAULTS = {
  uiLang: (navigator.language || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en',
  cardLang: 'fr', currency: 'EUR', game: 'pokemon',
  condAdjust: true, autoRefresh: true, lastRefresh: 0,
  rate: 0.91, view: 'grid', sort: 'value', setLock: {},
};
const COND = { NM: 1, EX: 0.85, GD: 0.7, LP: 0.55, PL: 0.4, PO: 0.25 };
const VARIANTS = ['normal', 'holo', 'reverse', 'first'];
const S = { cards: [], settings: { ...DEFAULTS }, filter: { q: '', game: 'all', dupes: false }, valueHistory: [], route: null };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const view = $('#view');
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const inCollection = c => (c.list || 'collection') === 'collection';

// ---------------------------------------------------------------- argent
const locale = () => (getLang() === 'fr' ? 'fr-FR' : 'en-US');
function money(v, cur = S.settings.currency) {
  if (v == null || isNaN(v)) return '—';
  return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
}
function pct(v) {
  if (v == null || !isFinite(v)) return '';
  return `${v > 0 ? '+' : ''}${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(v * 100)} %`;
}
function convert(v, from, to) {
  if (v == null) return null;
  if (from === to) return v;
  const r = S.settings.rate || 0.91; // 1 USD = r EUR
  return from === 'USD' ? v * r : v / r;
}
const condFactor = c => (S.settings.condAdjust && !c.grade ? COND[c.condition || 'NM'] ?? 1 : 1);

// Valeur unitaire dans la devise choisie (key = 'eur' | 'avg30' | 'avg7' | 'avg1')
function unitValue(c, cur = S.settings.currency, key = 'eur') {
  if (c.customValue != null && c.customValue !== '') return convert(+c.customValue, c.customCur || 'EUR', cur);
  const m = market(c);
  let v = null;
  if (key !== 'eur' && m[key] != null) v = convert(m[key], 'EUR', cur);
  else if (cur === 'EUR') v = m.eur ?? convert(m.usd, 'USD', 'EUR');
  else v = m.usd ?? convert(m.eur, 'EUR', 'USD');
  return v == null ? null : v * condFactor(c);
}
const lineValue = (c, cur, key) => (unitValue(c, cur, key) || 0) * (c.qty || 1);
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

function trendOf(c) {
  const m = market(c);
  if (m.eur && m.avg30) return (m.eur - m.avg30) / m.avg30;
  const h = (c.history || []).filter(p => p.eur ?? p.usd);
  if (h.length >= 2) {
    const a = h[0].eur ?? h[0].usd, b = h[h.length - 1].eur ?? h[h.length - 1].usd;
    if (a) return (b - a) / a;
  }
  return null;
}
function trendBadge(tr, small = true) {
  if (tr == null) return '';
  const cls = tr > 0.03 ? 'up' : tr < -0.03 ? 'down' : 'flat';
  return `<span class="trend ${cls} ${small ? 'sm' : ''}">${icon(cls === 'up' ? 'up' : cls === 'down' ? 'down' : 'flat')}${pct(tr)}</span>`;
}
const isFoil = c => c.variant && c.variant !== 'normal'
  || /holo|rare|ex|gx|ultra|secret|illustr|mythic|ultime|chromat|full|prism|star|vmax|vstar/i.test(c.rarity || '');

// ---------------------------------------------------------------- persistance
async function saveSettings() { await db.setMeta('settings', S.settings); }
async function saveCard(c) {
  const i = S.cards.findIndex(x => x.uid === c.uid);
  if (i >= 0) S.cards[i] = c; else S.cards.push(c);
  await db.put(c);
}
function pushHistory(c) {
  const m = market(c);
  if (m.eur == null && m.usd == null) return;
  const p = { t: Date.now(), eur: m.eur, usd: m.usd };
  const h = c.history || (c.history = []);
  if (h.length && sameDay(h[h.length - 1].t, p.t)) h[h.length - 1] = p; else h.push(p);
  if (h.length > 180) h.splice(0, h.length - 180);
}
async function snapshotValue() {
  const col = S.cards.filter(inCollection);
  const p = { t: Date.now(), eur: sum(col, c => lineValue(c, 'EUR')), usd: sum(col, c => lineValue(c, 'USD')), n: sum(col, c => c.qty || 1) };
  const h = S.valueHistory;
  if (h.length && sameDay(h[h.length - 1].t, p.t)) h[h.length - 1] = p; else h.push(p);
  if (h.length > 400) h.splice(0, h.length - 400);
  await db.setMeta('valueHistory', h);
}

// ---------------------------------------------------------------- UI : toasts & feuilles
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  $('#toast-root').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  const timer = setTimeout(close, 2800);
  return { el, update: m => { el.innerHTML = m; }, close: () => { clearTimeout(timer); close(); }, keep: () => clearTimeout(timer) };
}

const sheets = [];
function openSheet(html, { cls = '', onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop"></div>
    <div class="sheet ${cls}" role="dialog" aria-modal="true">
      <div class="sheet-grip"><span></span></div>
      <button class="icon-btn sheet-close" aria-label="${t('close')}">${icon('x')}</button>
      <div class="sheet-body">${html}</div>
    </div>`;
  $('#sheet-root').appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  wrap.querySelector('.sheet-backdrop').onclick = closeSheet;
  wrap.querySelector('.sheet-close').onclick = closeSheet;
  enableSwipeDown(wrap.querySelector('.sheet'));
  sheets.push({ wrap, onClose });
  history.pushState({ sheet: sheets.length }, '');
  document.body.classList.add('has-sheet');
  return wrap.querySelector('.sheet-body');
}
function closeSheet() { if (sheets.length) history.back(); }
function closeSheets(n = sheets.length) { if (n > 0) history.go(-Math.min(n, sheets.length)); }
function popSheet() {
  const s = sheets.pop();
  if (!s) return;
  s.wrap.classList.remove('open');
  setTimeout(() => s.wrap.remove(), 320);
  s.onClose?.();
  if (!sheets.length) document.body.classList.remove('has-sheet');
}
window.addEventListener('popstate', e => {
  const depth = e.state?.sheet || 0;
  while (sheets.length > depth) popSheet();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
function enableSwipeDown(sheet) {
  const grip = sheet.querySelector('.sheet-grip');
  let y0 = null, dy = 0;
  grip.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; sheet.style.transition = 'none'; }, { passive: true });
  grip.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  grip.addEventListener('touchend', () => {
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 90) closeSheet();
    y0 = null; dy = 0;
  });
}

// Effet holographique : inclinaison au doigt / à la souris / au gyroscope
function bindTilt(root) {
  $$('[data-tilt]', root).forEach(el => {
    const set = (px, py) => {
      el.style.setProperty('--rx', `${(0.5 - py) * 20}deg`);
      el.style.setProperty('--ry', `${(px - 0.5) * 24}deg`);
      el.style.setProperty('--mx', `${px * 100}%`);
      el.style.setProperty('--my', `${py * 100}%`);
      el.style.setProperty('--o', '1');
    };
    el.addEventListener('pointermove', e => {
      const r = el.getBoundingClientRect();
      set((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); el.style.setProperty('--o', '0.35');
    });
    el._tilt = set;
  });
}
window.addEventListener('deviceorientation', e => {
  if (e.beta == null || !sheets.length) return;
  const px = Math.min(1, Math.max(0, 0.5 + (e.gamma || 0) / 50));
  const py = Math.min(1, Math.max(0, 0.5 + ((e.beta || 0) - 45) / 50));
  $$('.sheet-wrap.open [data-tilt]').forEach(el => el._tilt?.(px, py));
});

function cardVisual(c, cls = '') {
  const src = c.image || c.thumb || c.photo || '';
  return `<div class="holo-card ${isFoil(c) ? 'foil' : ''} ${cls}" data-tilt>
    ${src ? `<img src="${esc(src)}" alt="${esc(c.name)}" ${c.photo ? `onerror="this.onerror=null;this.src='${c.photo}'"` : ''}>` : `<div class="ph">${icon('cards')}</div>`}
    <div class="shine"></div><div class="glare"></div>
  </div>`;
}
function thumbImg(src, alt = '') {
  return `<div class="ph">${icon('cards')}</div>${src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" onerror="this.remove()">` : ''}`;
}

// ---------------------------------------------------------------- navigation
const routes = {
  collection: () => renderList('collection'),
  wishlist: () => renderList('wishlist'),
  stats: renderStats,
  settings: renderSettings,
  scan: renderScan,
};
function go() {
  const r = location.hash.replace(/^#\/?/, '') || 'collection';
  const name = routes[r] ? r : 'collection';
  if (S.route === 'scan' && name !== 'scan') scanner.stopCamera();
  S.route = name;
  document.body.dataset.route = name;
  view.onclick = null;
  $$('.tabbar [data-route]').forEach(b => b.classList.toggle('active', b.dataset.route === name));
  routes[name]();
  if (name !== 'scan') window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', go);

function applyStaticI18n() {
  document.documentElement.lang = getLang();
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
}

// ---------------------------------------------------------------- COLLECTION / WISHLIST
function lastUpdateText() {
  const ts = S.settings.lastRefresh;
  if (!ts) return t('neverUpdated');
  const mins = Math.round((Date.now() - ts) / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (mins < 60) return `${t('updated')} ${rtf.format(-mins, 'minute')}`;
  if (mins < 1440) return `${t('updated')} ${rtf.format(-Math.round(mins / 60), 'hour')}`;
  return `${t('updated')} ${rtf.format(-Math.round(mins / 1440), 'day')}`;
}

function deltaHTML() {
  const h = S.valueHistory, k = S.settings.currency === 'EUR' ? 'eur' : 'usd';
  if (h.length < 2) return '';
  const a = h[h.length - 2][k], b = h[h.length - 1][k];
  if (!a) return '';
  return trendBadge((b - a) / a);
}

function tileHTML(c) {
  const v = unitValue(c);
  return `<button class="tile" data-uid="${c.uid}">
    <div class="tile-img ${isFoil(c) ? 'foil' : ''} tier-${rarityTier(c)}">${thumbImg(c.thumb || c.image || c.photo, c.name)}
      ${(c.qty || 1) > 1 ? `<span class="qty">×${c.qty}</span>` : ''}
      ${c.grade ? `<span class="grade">${esc(c.grade)}</span>` : ''}
      <span class="game-tag" style="--g:${GAMES[c.game]?.color}">${GAMES[c.game]?.short}</span>
    </div>
    <div class="tile-meta">
      <div class="tile-name">${esc(c.name)}</div>
      <div class="tile-sub">${esc(c.set || '')}${c.number ? ` · ${esc(c.number)}` : ''}</div>
      <div class="tile-price"><b>${money(v)}</b>${trendBadge(trendOf(c))}</div>
    </div>
  </button>`;
}
function rowHTML(c) {
  const v = unitValue(c);
  const h = (c.history || []).map(p => p.eur ?? p.usd).filter(x => x != null);
  return `<button class="row" data-uid="${c.uid}">
    <div class="row-img">${thumbImg(c.thumb || c.image || c.photo, c.name)}</div>
    <div class="row-main">
      <div class="tile-name">${esc(c.name)} ${(c.qty || 1) > 1 ? `<span class="pill">×${c.qty}</span>` : ''}</div>
      <div class="tile-sub">${esc(c.set || '')}${c.number ? ` · ${esc(c.number)}` : ''}</div>
      <div class="tile-sub">${esc(c.rarity || '')} · ${t('var_' + (c.variant || 'normal'))} · ${c.grade ? esc(c.grade) : c.condition || 'NM'}</div>
    </div>
    <div class="row-side">
      <b>${money(v)}</b>
      ${trendBadge(trendOf(c))}
      ${sparkline(h, { w: 64, h: 20, color: 'var(--accent2)' })}
    </div>
  </button>`;
}

function sortCards(arr) {
  const s = S.settings.sort;
  const by = {
    value: (a, b) => (unitValue(b) || 0) - (unitValue(a) || 0),
    recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    set: (a, b) => (a.set || '').localeCompare(b.set || '') || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }),
    trend: (a, b) => (trendOf(b) ?? -9) - (trendOf(a) ?? -9),
  }[s];
  return arr.sort(by);
}

// ---------- inventaire (liste filtrable) : utilisé par « Toutes mes cartes » et la liste d'envies
function inventoryHTML(items, isCol) {
  if (!items.length) return '<div id="grid"></div>';
  return `
    <div class="toolbar">
      <label class="search">${icon('search')}<input id="q" type="search" placeholder="${t('searchCollection')}" value="${esc(S.filter.q)}" autocomplete="off"></label>
      <button class="icon-btn" id="toggle-view" aria-label="view">${icon(S.settings.view === 'grid' ? 'list' : 'grid')}</button>
    </div>
    <div class="chips">
      ${['all', 'pokemon', 'mtg', 'yugioh'].filter(g => g === 'all' || items.some(c => c.game === g)).map(g =>
        `<button class="chip ${S.filter.game === g ? 'on' : ''}" data-game="${g}">${g === 'all' ? t('all') : GAMES[g].label}</button>`).join('')}
      ${isCol ? `<button class="chip ${S.filter.dupes ? 'on' : ''}" id="dupes">${icon('copy')}${t('duplicates')}</button>` : ''}
      <label class="chip select">${t('sortBy')}
        <select id="sort">${['value', 'recent', 'name', 'set', 'trend'].map(s => `<option value="${s}" ${S.settings.sort === s ? 'selected' : ''}>${t('sort_' + s)}</option>`).join('')}</select>
      </label>
    </div>
    <div id="grid"></div>`;
}

function bindInventory(root, items, list) {
  const isCol = list === 'collection';
  const grid = $('#grid', root);
  const draw = () => {
    const q = S.filter.q.trim().toLowerCase();
    const arr = items.filter(c =>
      (S.filter.game === 'all' || c.game === S.filter.game)
      && (!S.filter.dupes || !isCol || (c.qty || 1) > 1)
      && (!q || `${c.name} ${c.set} ${c.number} ${c.rarity} ${c.notes || ''}`.toLowerCase().includes(q)));
    sortCards(arr);
    grid.className = S.settings.view === 'grid' ? 'grid' : 'rows';
    if (!items.length) grid.innerHTML = emptyHTML(list);
    else if (!arr.length) grid.innerHTML = `<div class="empty small"><p>${t('noMatch')}</p></div>`;
    else grid.innerHTML = arr.map(S.settings.view === 'grid' ? tileHTML : rowHTML).join('');
  };
  draw();
  grid.addEventListener('click', e => {
    const b = e.target.closest('[data-uid]');
    if (b) openCard(b.dataset.uid);
    if (e.target.closest('#empty-search')) openSearch({ list });
  });
  $('#q', root)?.addEventListener('input', e => { S.filter.q = e.target.value; draw(); });
  $$('.chip[data-game]', root).forEach(b => b.onclick = () => {
    S.filter.game = b.dataset.game;
    $$('.chip[data-game]', root).forEach(x => x.classList.toggle('on', x === b));
    draw();
  });
  $('#dupes', root)?.addEventListener('click', e => { S.filter.dupes = !S.filter.dupes; e.currentTarget.classList.toggle('on', S.filter.dupes); draw(); });
  $('#sort', root)?.addEventListener('change', e => { S.settings.sort = e.target.value; saveSettings(); draw(); });
  $('#toggle-view', root)?.addEventListener('click', e => {
    S.settings.view = S.settings.view === 'grid' ? 'list' : 'grid';
    e.currentTarget.innerHTML = icon(S.settings.view === 'grid' ? 'list' : 'grid');
    saveSettings(); draw();
  });
}

function renderList(list) {
  if (list === 'collection') return renderCollection();
  const items = S.cards.filter(c => (c.list || 'collection') === list);
  const total = sum(items, c => lineValue(c));
  const count = sum(items, c => c.qty || 1);
  view.innerHTML = `
    <section class="hero wish">
      <div class="hero-top"><div class="hero-label">${t('wishlistValue')}</div></div>
      <div class="hero-value">${money(total)}</div>
      <div class="hero-sub">${count} ${t(count > 1 ? 'cards' : 'card')} · ${new Set(items.map(c => c.setId || c.set)).size} ${t('sets')}</div>
    </section>
    ${inventoryHTML(items, false)}`;
  bindInventory(view, items, list);
}

// ---------- regroupement par série
const setKey = c => `${c.game}|${c.game === 'yugioh' ? (c.set || '') : (c.setId || c.set || '')}`;
const setMeta = {}; // clé → { logo, total, name } complétés depuis les listes de séries

function groupSets(items) {
  const m = new Map();
  for (const c of items) {
    const k = setKey(c);
    let g = m.get(k);
    if (!g) m.set(k, g = { key: k, game: c.game, setId: c.setId, set: c.set, name: c.set || '—', logo: c.setLogo || null, total: c.setTotal || null, lang: c.lang, cards: [] });
    g.cards.push(c);
    if (!g.logo && c.setLogo) g.logo = c.setLogo;
    if (!g.total && c.setTotal) g.total = c.setTotal;
  }
  for (const g of m.values()) {
    const meta = setMeta[g.key];
    if (meta) { g.logo = g.logo || meta.logo; g.total = g.total || meta.total; }
    g.value = sum(g.cards, c => lineValue(c));
    g.count = sum(g.cards, c => c.qty || 1);
    const nums = new Set(g.cards.map(c => normNum(c.number)));
    g.unique = nums.size;
    g.mainOwned = g.total ? [...nums].filter(n => /^\d+$/.test(n) && +n >= 1 && +n <= g.total).length : g.unique;
    g.extra = g.unique - g.mainOwned; // cartes « secrètes » au-delà du total officiel
    g.pct = g.total ? Math.min(1, g.mainOwned / g.total) : null;
    g.last = Math.max(...g.cards.map(c => c.addedAt || 0));
    g.top = [...g.cards].sort((a, b) => (unitValue(b) || 0) - (unitValue(a) || 0)).slice(0, 3);
  }
  return [...m.values()];
}

// Complète logos / totaux manquants (MTG, Yu-Gi-Oh!, anciennes fiches) puis redessine
async function enrichSets(groups, onDone) {
  const missing = groups.filter(g => (!g.logo || !g.total) && !setMeta[g.key]);
  if (!missing.length) return;
  const games = [...new Set(missing.map(g => g.game))];
  await Promise.all(games.map(async game => {
    try {
      const sets = await listSets(game, S.settings.cardLang);
      missing.filter(g => g.game === game).forEach(g => {
        const s = sets.find(x => x.id === (game === 'yugioh' ? g.set : g.setId));
        setMeta[g.key] = s ? { logo: s.logo, total: s.total } : {};
      });
    } catch { /* hors ligne : on garde ce qu'on a */ }
  }));
  onDone();
}

const RARITY_TIERS = [
  ['legend', /secr|hyper|gold|ultime|sp[ée]ciale|special illus|mythic|starlight|ghost|collector|quarter|platinum|shiny|chromatique|ace spec|magnifique/i],
  ['epic', /ultra|double|illus|full art|vmax|vstar|\bgx\b|\bex\b|\bv\b|prism|super rare|ultimate|amazing|radieu|radiant/i],
  ['rare', /rare|holo/i],
];
const rarityTier = c => (RARITY_TIERS.find(([, re]) => re.test(c.rarity || '')) || [''])[0];

function ringSVG(pct, size = 64, stroke = 7) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const id = `rg${Math.random().toString(36).slice(2, 7)}`;
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7ac6"/><stop offset=".5" stop-color="#60a5fa"/><stop offset="1" stop-color="#34d399"/></linearGradient></defs>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c * (pct || 0)} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})" class="ring-arc"/>
  </svg>`;
}

function countUp(el, to) {
  const from = S.heroShown ?? 0;
  S.heroShown = to;
  if (Math.abs(to - from) < 0.01 || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = money(to); return; }
  const t0 = performance.now(), d = 1000;
  const step = now => {
    const p = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - p, 3);
    el.textContent = money(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- onglet Collection
function renderCollection() {
  const items = S.cards.filter(inCollection);
  if (!items.length) {
    view.innerHTML = `<section class="hero"><div class="hero-label">${t('collectionValue')}</div><div class="hero-value">${money(0)}</div></section>${emptyHTML('collection')}`;
    $('#empty-search')?.addEventListener('click', () => openSearch({}));
    return;
  }
  const groups = groupSets(items);
  const total = sum(items, c => lineValue(c));
  const count = sum(items, c => c.qty || 1);
  const complete = groups.filter(g => g.pct === 1).length;
  const best = [...items].sort((a, b) => (unitValue(b) || 0) - (unitValue(a) || 0))[0];
  const k = S.settings.currency === 'EUR' ? 'eur' : 'usd';
  const hist = S.valueHistory.map(p => p[k]).filter(v => v != null).slice(-30);
  if (S.colTab && S.colTab !== 'overview' && S.colTab !== 'all' && !groups.some(g => g.key === S.colTab)) S.colTab = 'overview';
  S.colTab = S.colTab || 'overview';
  const sortedTabs = [...groups].sort((a, b) => b.last - a.last);

  view.innerHTML = `
    <section class="hero hero-col">
      <div class="hero-shine"></div>
      <div class="hero-top">
        <div class="hero-label">${t('collectionValue')}</div>
        <button class="ghost-btn" id="refresh">${icon('refresh')}<span>${t('refresh')}</span></button>
      </div>
      <div class="hero-value"><span id="hero-num">${money(S.heroShown ?? 0)}</span> ${deltaHTML()}</div>
      ${hist.length >= 2 ? `<div class="hero-spark">${sparkline(hist, { w: 300, h: 34, color: '#fff' })}</div>` : ''}
      <div class="hero-stats">
        <div><b>${count}</b><span>${t(count > 1 ? 'cards' : 'card')}</span></div>
        <div><b>${groups.length}</b><span>${t('sets')}</span></div>
        <div><b>${complete}</b><span>${t('completeShort')}</span></div>
        <div class="gem"><b>${new Intl.NumberFormat(locale(), { style: 'currency', currency: S.settings.currency, notation: 'compact', maximumFractionDigits: 1 }).format(unitValue(best) || 0)}</b><span>${t('topCard')}</span></div>
      </div>
      <div class="hero-sub muted">${lastUpdateText()}</div>
    </section>
    <nav class="col-tabs" id="col-tabs">
      <button class="col-tab ${S.colTab === 'overview' ? 'on' : ''}" data-tab="overview">${icon('sparkles')}${t('overview')}</button>
      <button class="col-tab ${S.colTab === 'all' ? 'on' : ''}" data-tab="all">${icon('grid')}${t('allCards')}<em>${count}</em></button>
      ${sortedTabs.map(g => `<button class="col-tab set ${S.colTab === g.key ? 'on' : ''} ${g.pct === 1 ? 'done' : ''}" data-tab="${esc(g.key)}" style="--g:${GAMES[g.game].color}">
        ${g.logo ? `<img src="${esc(g.logo)}" alt="" onerror="this.remove()">` : '<i class="dot"></i>'}<span>${esc(g.name)}</span>
        ${g.pct != null ? `<em>${Math.round(g.pct * 100)}%</em>` : `<em>${g.unique}</em>`}</button>`).join('')}
    </nav>
    <div id="col-content"></div>`;

  countUp($('#hero-num'), total);
  $('#refresh').onclick = () => refreshAll();
  const tabs = $('#col-tabs');
  tabs.onclick = e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    S.colTab = b.dataset.tab;
    $$('.col-tab', tabs).forEach(x => x.classList.toggle('on', x === b));
    b.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    drawTab();
  };
  const drawTab = () => {
    const box = $('#col-content');
    box.className = 'tab-anim';
    void box.offsetWidth; box.classList.add('in');
    if (S.colTab === 'overview') renderOverview(box, groups, items);
    else if (S.colTab === 'all') { box.innerHTML = inventoryHTML(items, true); bindInventory(box, items, 'collection'); }
    else renderBinder(box, groups.find(g => g.key === S.colTab));
  };
  drawTab();
  requestAnimationFrame(() => $('.col-tab.on', tabs)?.scrollIntoView({ inline: 'center', block: 'nearest' }));
  // Précharge en douceur la liste de chaque série possédée : les classeurs s'ouvriront sans attente
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 800));
  idle(() => sortedTabs.slice(0, 12).forEach(g => setCards(g.game, g.lang || S.settings.cardLang, { setId: g.setId, set: g.set }).catch(() => {})));
  enrichSets(groups, () => { if (S.route === 'collection' && !sheets.length) renderCollection(); });
}

function renderOverview(box, groups, items) {
  const latest = [...items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 12);
  const sort = S.settings.setSort || 'recent';
  const sorted = [...groups].sort({
    recent: (a, b) => b.last - a.last,
    value: (a, b) => b.value - a.value,
    progress: (a, b) => (b.pct ?? -1) - (a.pct ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
  }[sort]);
  box.innerHTML = `
    <section class="ov-sec">
      <div class="sec-head"><h3>${t('latestAdds')}</h3></div>
      <div class="carousel">${latest.map((c, i) => `
        <button class="car-card tier-${rarityTier(c)}" data-uid="${c.uid}" style="--i:${i}">
          <div class="car-img ${isFoil(c) ? 'foil' : ''}">${thumbImg(c.thumb || c.image || c.photo, c.name)}</div>
          <span class="car-name">${esc(c.name)}</span><span class="car-price">${money(unitValue(c))}</span>
        </button>`).join('')}</div>
    </section>
    <section class="ov-sec">
      <div class="sec-head"><h3>${t('mySets')}</h3>
        <label class="chip select">${t('sortBy')}<select id="set-sort">${['recent', 'value', 'progress', 'name'].map(s => `<option value="${s}" ${sort === s ? 'selected' : ''}>${t('setSort_' + s)}</option>`).join('')}</select></label>
      </div>
      <div class="set-grid">${sorted.map((g, i) => `
        <button class="set-tile ${g.pct === 1 ? 'done' : ''}" data-tab="${esc(g.key)}" style="--g:${GAMES[g.game].color};--i:${i}">
          <div class="set-fan">${g.top.map((c, j) => `<div class="fan-card f${j} ${isFoil(c) ? 'foil' : ''}">${thumbImg(c.thumb || c.image || c.photo, '')}</div>`).join('')}</div>
          <div class="set-body">
            <div class="set-head">
              ${g.logo ? `<img class="set-logo" src="${esc(g.logo)}" alt="" onerror="this.remove()">` : ''}
              <span class="game-tag inline" style="--g:${GAMES[g.game].color}">${GAMES[g.game].short}</span>
            </div>
            <div class="set-title">${esc(g.name)}</div>
            <div class="set-meta"><b>${money(g.value)}</b> · ${g.total ? `${g.mainOwned}/${g.total}${g.extra > 0 ? ` +${g.extra}` : ''}` : `${g.unique} ${t('cards')}`}</div>
            ${g.pct != null ? `<div class="progress"><div style="width:${g.pct * 100}%"></div></div>` : ''}
          </div>
          ${g.pct === 1 ? `<span class="done-badge">${icon('check')}${t('completeBadge')}</span>` : ''}
        </button>`).join('')}</div>
    </section>`;
  box.onclick = e => {
    const c = e.target.closest('[data-uid]');
    if (c) return openCard(c.dataset.uid);
    const s = e.target.closest('[data-tab]');
    if (s) $(`#col-tabs [data-tab="${CSS.escape(s.dataset.tab)}"]`)?.click();
  };
  $('#set-sort', box).onchange = e => { S.settings.setSort = e.target.value; saveSettings(); renderOverview(box, groups, items); };
}

// ---------- classeur d'une série : possédées, manquantes ou classeur complet
function renderBinder(box, g) {
  const mode = S.binderMode || 'all';
  const owned = new Map();
  g.cards.forEach(c => { const n = normNum(c.number); owned.set(n, [...(owned.get(n) || []), c]); });
  const missingCount = g.total ? Math.max(0, g.total - g.mainOwned) : null;
  box.innerHTML = `
    <section class="set-hero" style="--g:${GAMES[g.game].color}">
      <div class="set-hero-ring">${ringSVG(g.pct ?? 0, 92, 9)}<div class="ring-txt"><b>${g.pct != null ? Math.round(g.pct * 100) + '%' : g.unique}</b><span>${g.pct != null ? `${g.mainOwned}/${g.total}` : t('cards')}</span></div></div>
      <div class="set-hero-info">
        ${g.logo ? `<img class="set-hero-logo" src="${esc(g.logo)}" alt="" onerror="this.remove()">` : ''}
        <h2>${esc(g.name)}</h2>
        <div class="set-hero-stats">
          <span><b>${money(g.value)}</b>${t('value')}</span>
          <span><b>${g.count}</b>${t('cards')}</span>
          ${missingCount != null ? `<span><b>${missingCount}</b>${t('missing')}</span>` : ''}
          ${g.extra > 0 ? `<span><b>+${g.extra}</b>${t('secret')}</span>` : ''}
        </div>
      </div>
      ${g.pct === 1 ? `<div class="set-complete">${icon('sparkles')}${t('setComplete')}</div>` : ''}
    </section>
    <div class="seg" id="binder-mode">
      ${['owned', 'missing', 'all'].map(m => `<button data-m="${m}" class="${mode === m ? 'on' : ''}">${t('binder_' + m)}</button>`).join('')}
    </div>
    <div id="binder" class="binder"></div>`;

  const out = $('#binder', box);
  // Vignette légère : image décodée hors du fil principal, pas d'animation par carte
  const img = (src, alt) => `<div class="ph">${icon('cards')}</div>${src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" onerror="this.remove()">` : ''}`;
  const ownedSlot = cards => {
    const c = cards.slice().sort((a, b) => (unitValue(b) || 0) - (unitValue(a) || 0))[0];
    const qty = sum(cards, x => x.qty || 1);
    return `<button class="slot owned tier-${rarityTier(c)}" data-uid="${c.uid}">
      <div class="slot-img ${isFoil(c) ? 'foil' : ''}">${img(c.thumb || c.image || c.photo, c.name)}${qty > 1 ? `<span class="qty">×${qty}</span>` : ''}</div>
      <span class="slot-num">#${esc(c.number || '?')}</span><span class="slot-price">${money(unitValue(c))}</span>
    </button>`;
  };
  const ownedSorted = () => [...owned.values()].sort((a, b) => String(a[0].number).localeCompare(String(b[0].number), undefined, { numeric: true }));
  let all = null; // liste complète de la série, une fois chargée

  // Le classeur est construit UNE SEULE FOIS ; changer de mode ne fait que masquer/afficher des vignettes
  // (aucune image rechargée, aucun re-rendu : instantané même sur téléphone).
  const setMode = m => {
    S.binderMode = m;
    out.dataset.mode = m;
    $$('#binder-mode button', box).forEach(b => b.classList.toggle('on', b.dataset.m === m));
    const empty = $('.binder-empty', out);
    if (empty) empty.hidden = !(m === 'missing' && all && !all.some(r => !owned.has(normNum(r.number))));
    if (!all && m !== 'owned') out.classList.add('waiting'); else out.classList.remove('waiting');
  };

  // 1) tout de suite : les cartes possédées
  out.innerHTML = ownedSorted().map(ownedSlot).join('')
    + `<div class="binder-wait"><div class="spinner"></div><p class="muted">${t('binderLoading')}</p></div>`;
  setMode(mode);

  // 2) dès que la liste de la série arrive : le classeur complet (possédées + manquantes), dans l'ordre
  setCards(g.game, g.lang || S.settings.cardLang, { setId: g.setId, set: g.set }).then(list => {
    if (!out.isConnected) return;
    all = list;
    const seen = new Set();
    const html = all.map((r, i) => {
      const n = normNum(r.number);
      const mine = owned.get(n);
      if (mine) { seen.add(n); return ownedSlot(mine); }
      return `<button class="slot missing" data-miss="${i}">
        <div class="slot-img">${img(r.thumb, r.name)}<span class="slot-add">${icon('plus')}</span></div>
        <span class="slot-num">#${esc(r.number)}</span><span class="slot-name">${esc(r.name)}</span>
      </button>`;
    }).join('');
    // cartes possédées absentes de la liste officielle (numérotation différente, promo…)
    const extra = ownedSorted().filter(cs => !seen.has(normNum(cs[0].number))).map(ownedSlot).join('');
    out.innerHTML = html + extra + `<div class="empty small binder-empty" hidden><p>${t('nothingMissing')}</p></div>`;
    setMode(S.binderMode);
  }).catch(() => {
    if (!out.isConnected) return;
    $('.binder-wait', out)?.replaceWith(Object.assign(document.createElement('p'), { className: 'muted center binder-wait', textContent: t('binderError') }));
  });

  out.onclick = e => {
    const o = e.target.closest('[data-uid]');
    if (o) return openCard(o.dataset.uid);
    const miss = e.target.closest('[data-miss]');
    if (miss && all) openAdd(all[+miss.dataset.miss], {});
  };
  $$('#binder-mode button', box).forEach(b => b.onclick = () => setMode(b.dataset.m));
}

// ---------- confettis (étapes de collection)
function confetti(amount = 140) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#ff7ac6', '#a78bfa', '#60a5fa', '#34d399', '#fde047', '#fb923c', '#ffffff'];
  const P = Array.from({ length: amount }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 13 - 4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  const frame = now => {
    const el = now - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    P.forEach(p => {
      p.vy += 0.38; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, 1 - el / 2600);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    });
    if (el < 2600) requestAnimationFrame(frame); else cv.remove();
  };
  requestAnimationFrame(frame);
}

// Félicite quand une carte ajoutée ouvre une série ou franchit 25/50/75/100 %
function celebrate(before, after, name) {
  if (!after) return;
  if (!before) { toast(`${icon('sparkles')} ${t('newSet')} <b>${esc(name)}</b>`, 'ok'); confetti(60); return; }
  if (before.pct == null || after.pct == null) return;
  const step = [1, 0.75, 0.5, 0.25].find(s => before.pct < s && after.pct >= s);
  if (!step) return;
  toast(`${icon('sparkles')} <b>${esc(name)}</b> : ${step === 1 ? t('setComplete') : `${step * 100} % ${t('reached')}`}`, 'ok');
  confetti(step === 1 ? 220 : 120);
  navigator.vibrate?.([30, 60, 30, 60, 60]);
}

function emptyHTML(list) {
  if (list === 'wishlist') return `<div class="empty">
    <div class="empty-art">${icon('heart')}</div>
    <h3>${t('wishEmptyTitle')}</h3><p>${t('wishEmptyText')}</p>
    <button class="btn primary" id="empty-search">${icon('search')}${t('searchCard')}</button></div>`;
  return `<div class="empty">
    <div class="empty-art stack"><span></span><span></span><span></span></div>
    <h3>${t('emptyTitle')}</h3><p>${t('emptyText')}</p>
    <a class="btn primary" href="#/scan">${icon('scan')}${t('scanFirst')}</a>
    <button class="btn ghost" id="empty-search">${icon('search')}${t('manualSearch')}</button></div>`;
}

// ---------------------------------------------------------------- SCANNER
const lockedSet = game => S.settings.setLock?.[game] || null;
function setLockChip() {
  const l = lockedSet(S.settings.game);
  return l ? `<button class="chip glass set-lock" id="unlock">${icon('cards')}<span>${esc(l.name)}</span>${icon('x')}</button>` : '';
}

async function renderScan() {
  const g = S.settings.game;
  view.innerHTML = `
  <section class="scanner">
    <video id="video" playsinline muted autoplay></video>
    <div class="scan-mask"><div class="scan-guide" id="guide">
      <i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>
      <div class="zone name"></div><div class="zone num ${g}"></div>
      <div class="scan-line"></div>
    </div></div>
    <div class="scan-top">
      <div class="seg glass" id="game-seg">${Object.keys(GAMES).map(k => `<button data-g="${k}" class="${g === k ? 'on' : ''}">${GAMES[k].label}</button>`).join('')}</div>
      <div id="lock-slot">${setLockChip()}</div>
    </div>
    <div class="scan-hint" id="hint">${t('scanHint')}</div>
    <div class="scan-controls">
      <label class="round-btn" aria-label="${t('fromGallery')}">${icon('image')}<input type="file" accept="image/*" id="file" hidden></label>
      <button class="shutter" id="shutter" aria-label="${t('capture')}"><span></span></button>
      <button class="round-btn" id="torch" aria-label="torch">${icon('bolt')}</button>
    </div>
    <button class="manual-btn glass" id="manual">${icon('search')}${t('manualSearch')}</button>
    <div class="scan-busy" id="busy" hidden><div class="spinner"></div><div id="busy-text">${t('analyzing')}</div></div>
  </section>`;

  const video = $('#video');
  scanner.warmup();
  warmDictionary(g, S.settings.cardLang);
  try {
    await scanner.startCamera(video);
    if (!scanner.hasTorch()) $('#torch').classList.add('disabled');
  } catch (e) {
    $('.scanner').classList.add('no-cam');
    $('#hint').innerHTML = `${icon('info')} ${t(location.protocol === 'https:' || location.hostname === 'localhost' ? 'cameraError' : 'cameraHttps')}`;
  }

  const bindLock = () => { const u = $('#unlock'); if (u) u.onclick = () => { delete S.settings.setLock[S.settings.game]; saveSettings(); $('#lock-slot').innerHTML = ''; }; };
  bindLock();
  $$('#game-seg button').forEach(b => b.onclick = () => {
    S.settings.game = b.dataset.g; saveSettings();
    $$('#game-seg button').forEach(x => x.classList.toggle('on', x === b));
    $('.zone.num').className = `zone num ${b.dataset.g}`;
    $('#lock-slot').innerHTML = setLockChip(); bindLock();
    warmDictionary(b.dataset.g, S.settings.cardLang);
  });
  let torchOn = false;
  $('#torch').onclick = async () => { torchOn = !torchOn; if (await scanner.setTorch(torchOn)) $('#torch').classList.toggle('on', torchOn); };
  $('#manual').onclick = () => openSearch({ game: S.settings.game });
  let shooting = false;
  $('#shutter').onclick = async () => {
    if (shooting) return;
    shooting = true;
    let canvas;
    try {
      $('#hint').textContent = t('holdStill');
      canvas = await scanner.captureBest(video, $('#guide'));
    } catch { shooting = false; return toast(t('cameraNotReady'), 'warn'); }
    $('#hint').textContent = t('scanHint');
    $('.scanner').classList.add('flash');
    setTimeout(() => $('.scanner')?.classList.remove('flash'), 250);
    await analyze(canvas);
    shooting = false;
  };
  $('#file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    e.target.value = '';
    analyze(await scanner.fileToCanvas(f));
  };
}

async function analyze(canvas) {
  const busy = $('#busy'), txt = $('#busy-text');
  const game = S.settings.game, lock = lockedSet(game);
  busy.hidden = false;
  navigator.vibrate?.(25);
  const photo = scanner.thumbnail(canvas, 360);
  let res = {};
  try {
    res = await scanner.recognizeCard(canvas, game, m => {
      if (!txt || m.status === 'recognizing text') return;
      if (m.progress != null) txt.textContent = `${t('loadingOcr')} ${Math.round(m.progress * 100)} %`;
    }, (i, n) => { if (txt) txt.textContent = `${t('analyzing')} ${i}/${n}`; });
  } catch (e) {
    console.warn(e);
    toast(t('ocrFailed'), 'warn');
  }
  // Correction des mots lus avec le dictionnaire des vrais noms de cartes
  let fixes = [];
  try {
    if (txt) txt.textContent = t('matchingNames');
    fixes = await correctNames(game, S.settings.cardLang, [res.name, ...(res.candidates || [])].filter(Boolean), lock?.id);
  } catch { /* dictionnaire indisponible : on garde la lecture brute */ }
  busy.hidden = true;
  const candidates = [...new Set([...fixes.map(f => f.query), ...(res.candidates || [])])];
  openSearch({
    game, query: fixes[0]?.query || res.name || '', number: res.number || '', total: res.total || '',
    candidates, fixed: fixes.map(f => f.query), raw: res.name, debug: res.debug, photo, fromScan: true,
  });
}

// ---------------------------------------------------------------- RECHERCHE
function openSearch(o = {}) {
  let game = o.game || S.settings.game;
  let lang = S.settings.cardLang;
  let setId = lockedSet(game)?.id || '';
  let runId = 0;
  const fixed = new Set(o.fixed || []);
  const body = openSheet(`
    <h2 class="sheet-title">${o.fromScan ? t('scanResult') : t('searchCard')}</h2>
    ${o.photo ? `<div class="scan-preview"><img src="${o.photo}" alt="">
      <div><div class="muted small">${t('detected')}</div>
      <div class="detected">${o.query ? esc(o.query) : `<span class="muted">${t('nothingRead')}</span>`}
      ${o.number ? `<span class="pill">#${esc(o.number)}${o.total ? '/' + esc(o.total) : ''}</span>` : ''}</div>
      <div class="muted small">${o.raw && o.raw !== o.query ? `${t('readAs')} « ${esc(o.raw)} » · ` : ''}${t('detectedHelp')}</div></div></div>` : ''}
    ${o.candidates?.length > 1 ? `<div class="cand-row"><span class="muted small">${t('wordsRead')}</span>
      ${o.candidates.slice(0, 8).map(c => `<button type="button" class="chip sm ${fixed.has(c) ? 'ok' : ''}" data-cand="${esc(c)}">${fixed.has(c) ? icon('check') : ''}${esc(c)}</button>`).join('')}</div>` : ''}
    ${o.debug ? `<details class="ocr-debug"><summary>${icon('info')} ${t('whatWasRead')}</summary>
      <p class="muted small">${t('debugHelp')} · ${esc(o.debug.size)} px</p>
      ${[...o.debug.top, ...o.debug.bottom].map(d => `<figure><img src="${d.img}" alt=""><figcaption>${esc(d.mode)} : ${esc(d.text.replace(/\s+/g, ' ').trim().slice(0, 140)) || '∅'}</figcaption></figure>`).join('')}
    </details>` : ''}
    <div class="seg" id="s-game">${Object.keys(GAMES).map(k => `<button type="button" data-g="${k}" class="${game === k ? 'on' : ''}">${GAMES[k].label}</button>`).join('')}</div>
    <div class="set-row">
      <label class="set-select">${icon('cards')}<select id="s-set"><option value="">${t('allSets')}</option></select></label>
      <button type="button" class="icon-btn lock-btn" id="s-lock" aria-label="${t('lockSet')}" title="${t('lockSet')}">${icon('pin')}</button>
    </div>
    <div class="set-help muted small" id="s-set-help"></div>
    <form class="search-form" id="s-form">
      <label class="search">${icon('search')}<input name="q" value="${esc(o.query || '')}" placeholder="${t('cardName')}" autocomplete="off" enterkeyhint="search"></label>
      <input name="num" class="num-input" value="${esc(o.number || '')}" placeholder="${t('numberPh')}" autocomplete="off">
      <button class="btn primary icon-only" aria-label="${t('search')}">${icon('search')}</button>
    </form>
    <div class="lang-row muted small">${t('cardLanguage')} :
      <button type="button" class="link ${lang === 'fr' ? 'on' : ''}" data-l="fr">FR</button> /
      <button type="button" class="link ${lang === 'en' ? 'on' : ''}" data-l="en">EN</button></div>
    <div id="s-results" class="results"></div>`, { cls: 'tall' });

  const form = $('#s-form', body), out = $('#s-results', body), sel = $('#s-set', body);

  // --- menu des séries ---
  const syncLockBtn = () => {
    const locked = !!setId && lockedSet(game)?.id === setId;
    $('#s-lock', body).classList.toggle('on', locked);
    $('#s-lock', body).hidden = !setId;
    $('#s-set-help', body).textContent = locked ? t('setLocked') : setId ? t('setChosen') : '';
  };
  const fillSets = async () => {
    sel.innerHTML = `<option value="">${t('loadingSets')}</option>`;
    try {
      const sets = await listSets(game, lang);
      const groups = [];
      sets.forEach(s => { let g = groups.find(x => x.name === s.group); if (!g) groups.push(g = { name: s.group, sets: [] }); g.sets.push(s); });
      sel.innerHTML = `<option value="">${t('allSets')}</option>` + groups.map(g => `<optgroup label="${esc(g.name)}">${g.sets.map(s =>
        `<option value="${esc(s.id)}" ${s.id === setId ? 'selected' : ''}>${esc(s.name)}${s.total ? ` · ${s.total}` : ''}</option>`).join('')}</optgroup>`).join('');
      if (setId && sel.value !== setId) setId = '';
    } catch { sel.innerHTML = `<option value="">${t('allSets')}</option>`; }
    syncLockBtn();
  };
  sel.onchange = () => {
    setId = sel.value;
    if (lockedSet(game) && lockedSet(game).id !== setId) { delete S.settings.setLock[game]; saveSettings(); }
    syncLockBtn();
    run();
  };
  $('#s-lock', body).onclick = () => {
    S.settings.setLock = S.settings.setLock || {};
    if (lockedSet(game)?.id === setId) delete S.settings.setLock[game];
    else S.settings.setLock[game] = { id: setId, name: sel.selectedOptions[0]?.textContent.split(' · ')[0] || setId };
    saveSettings(); syncLockBtn();
    const slot = $('#lock-slot'); if (slot) slot.innerHTML = setLockChip();
    toast(t(lockedSet(game) ? 'setLockedToast' : 'setUnlockedToast'), 'ok');
  };

  // --- résultats ---
  const resultHTML = (r, i) => `
      <button class="result ${r.numMatch ? 'match' : ''} ${r.best ? 'best' : ''}" data-i="${i}">
        <div class="result-img">${thumbImg(r.thumb, r.name)}</div>
        <div class="result-main">
          <div class="tile-name">${esc(r.name)}</div>
          <div class="tile-sub">${esc(r.set || '')}</div>
          <div class="tile-sub">${r.number ? `#${esc(r.number)}${r.setTotal ? '/' + r.setTotal : ''}` : ''} ${r.rarity ? '· ' + esc(r.rarity) : ''}</div>
          ${r.best ? `<div class="best-tag">${icon('sparkles')}${t('bestMatch')}</div>` : ''}
        </div>
        ${r.numMatch ? `<span class="badge-match">${icon('check')}${t('numberMatch')}</span>` : icon('plus', 'add-ic')}
      </button>`;
  let list = [];
  const draw = () => {
    out.innerHTML = list.map(resultHTML).join('');
    out.onclick = e => {
      const b = e.target.closest('[data-i]');
      if (b) openAdd(list[+b.dataset.i], { photo: o.photo, list: o.list });
    };
  };
  const run = async () => {
    const id = ++runId;
    const q = form.q.value.trim(), num = form.num.value.trim();
    if (!q && !num && !setId) { out.innerHTML = `<p class="muted center">${t('typeName')}</p>`; return; }
    out.innerHTML = Array(5).fill('<div class="result skeleton"><div></div><div></div></div>').join('');
    // tant que l'utilisateur n'a pas retouché le nom lu, on essaie aussi les autres mots lus sur la carte
    const candidates = q === (o.query || '') ? (o.candidates || []) : [];
    let res = [];
    try {
      res = await providers[game].search(q, { lang, number: num, total: o.total, candidates, setId });
      for (const c of candidates) {
        if (res.length) break;
        if (c !== q) res = await providers[game].search(c, { lang, number: num, total: o.total, setId });
      }
    } catch (e) { if (id === runId) out.innerHTML = `<p class="error center">${t('networkError')}</p>`; return; }
    if (id !== runId) return;
    list = res;
    // Série choisie + photo, mais nom illisible : on compare la photo à TOUTES les cartes de la série
    const weak = !list.length || (list[0].score ?? 0) < 4;
    if (setId && o.photo && weak && game !== 'yugioh' && q === (o.query || '')) {
      out.innerHTML = `<div class="loading-block small"><div class="spinner"></div><p class="muted">${t('visualSearch')}</p></div>`;
      try {
        const all = await providers[game].search('', { lang, setId });
        const vis = await visualScores(all, o.photo, 400);
        if (id !== runId) return;
        if (vis.size) {
          all.forEach(r => { r.vis = vis.get(r.apiId) ?? -1; r.score = r.vis * 8; });
          all.sort((a, b) => b.vis - a.vis);
          if (all[0].vis > 0.35) all[0].best = true;
          list = all.slice(0, 30);
          draw();
          return;
        }
      } catch { /* on garde les résultats texte */ }
    }
    if (!list.length) {
      const other = lang === 'fr' ? 'en' : 'fr';
      out.innerHTML = `<div class="empty small"><p>${t('noResult')}</p>
        <button class="btn ghost" id="try-other">${t('tryLang')} ${other.toUpperCase()}</button></div>`;
      $('#try-other', out).onclick = () => { lang = other; syncLang(); fillSets(); run(); };
      return;
    }
    draw();
    // Comparaison visuelle avec la photo pour départager les éditions
    if (o.photo && game !== 'yugioh') {
      const vis = await visualScores(list, o.photo);
      if (id !== runId || !vis.size) return;
      list.forEach(r => { r.vis = vis.get(r.apiId); if (r.vis != null) r.score = (r.score || 0) + r.vis * 8; r.best = false; });
      list.sort((a, b) => (b.score || 0) - (a.score || 0));
      const top = list[0];
      if (top?.vis != null && top.vis > 0.35) top.best = true;
      draw();
    }
  };
  const syncLang = () => $$('.lang-row [data-l]', body).forEach(x => x.classList.toggle('on', x.dataset.l === lang));
  form.onsubmit = e => { e.preventDefault(); form.q.blur(); run(); };
  $$('#s-game button', body).forEach(b => b.onclick = () => {
    game = b.dataset.g;
    setId = lockedSet(game)?.id || '';
    $$('#s-game button', body).forEach(x => x.classList.toggle('on', x === b));
    fillSets(); run();
  });
  $$('.lang-row [data-l]', body).forEach(b => b.onclick = () => { lang = b.dataset.l; syncLang(); fillSets(); run(); });
  $$('[data-cand]', body).forEach(b => b.onclick = () => { form.q.value = b.dataset.cand; run(); });
  fillSets();
  if (o.query || o.number || setId) run(); else setTimeout(() => form.q.focus(), 350);
}

// ---------------------------------------------------------------- AJOUT
function defaultVariant(d) {
  const v = d.variantsAvailable;
  if (v && !v.normal && v.holo) return 'holo';
  return 'normal';
}

function fieldsHTML(c, { isNew } = {}) {
  const variants = c.game === 'yugioh' ? ['normal'] : VARIANTS.filter(v => c.game !== 'mtg' || v === 'normal' || v === 'holo');
  return `
  <div class="fields">
    <div class="field">
      <label>${t('quantity')}</label>
      <div class="stepper"><button type="button" data-step="-1">${icon('minus')}</button><output id="f-qty">${c.qty || 1}</output><button type="button" data-step="1">${icon('plus')}</button></div>
    </div>
    ${variants.length > 1 ? `<div class="field">
      <label>${t('variant')}</label>
      <div class="seg small" data-field="variant">${variants.map(v => `<button type="button" data-v="${v}" class="${(c.variant || 'normal') === v ? 'on' : ''}">${t(c.game === 'mtg' && v === 'holo' ? 'var_foil' : 'var_' + v)}</button>`).join('')}</div>
    </div>` : ''}
    ${c.printings?.length > 1 ? `<div class="field">
      <label>${t('printing')}</label>
      <select data-field="printing" class="input">${c.printings.map(p => `<option value="${esc(p.code)}" ${p.code === c.number ? 'selected' : ''}>${esc(p.code)} — ${esc(p.rarity || '')} (${esc(p.set)})</option>`).join('')}</select>
    </div>` : ''}
    <div class="field">
      <label>${t('condition')}</label>
      <div class="seg small cond" data-field="condition">${Object.keys(COND).map(k => `<button type="button" data-v="${k}" class="${(c.condition || 'NM') === k ? 'on' : ''}" title="${t('cond_' + k)}">${k}</button>`).join('')}</div>
      <div class="hint">${t('cond_' + (c.condition || 'NM'))}</div>
    </div>
    <div class="field two">
      <div><label>${t('purchasePrice')} (${S.settings.currency})</label><input class="input" type="number" inputmode="decimal" step="0.01" min="0" data-field="purchase" value="${c.purchase ?? ''}" placeholder="0,00"></div>
      <div><label>${t('grade')}</label><input class="input" data-field="grade" value="${esc(c.grade || '')}" placeholder="PSA 10"></div>
    </div>
    ${isNew ? `<div class="field">
      <label>${t('addTo')}</label>
      <div class="seg small" data-field="list"><button type="button" data-v="collection" class="${c.list !== 'wishlist' ? 'on' : ''}">${t('tab_collection')}</button><button type="button" data-v="wishlist" class="${c.list === 'wishlist' ? 'on' : ''}">${t('tab_wishlist')}</button></div>
    </div>` : `
    <div class="field two">
      <div><label>${t('customValue')} (${S.settings.currency})</label><input class="input" type="number" inputmode="decimal" step="0.01" min="0" data-field="customValue" value="${c.customValue != null && c.customValue !== '' ? +convert(+c.customValue, c.customCur || 'EUR', S.settings.currency).toFixed(2) : ''}" placeholder="${t('auto')}"></div>
      <div><label>${t('cardLanguage')}</label><select class="input" data-field="lang">${['fr', 'en', 'jp', 'de', 'es', 'it'].map(l => `<option ${c.lang === l ? 'selected' : ''} value="${l}">${l.toUpperCase()}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>${t('notes')}</label><textarea class="input" data-field="notes" rows="2" placeholder="${t('notesPh')}">${esc(c.notes || '')}</textarea></div>`}
  </div>`;
}

// Branche les champs d'édition ; onChange(c, champ) est appelé à chaque modif
function bindFields(root, c, onChange) {
  $$('[data-step]', root).forEach(b => b.onclick = () => {
    c.qty = Math.max(1, (c.qty || 1) + +b.dataset.step);
    $('#f-qty', root).textContent = c.qty;
    navigator.vibrate?.(8);
    onChange(c, 'qty');
  });
  $$('.seg[data-field]', root).forEach(seg => {
    const f = seg.dataset.field;
    $$('button', seg).forEach(b => b.onclick = () => {
      c[f] = b.dataset.v;
      $$('button', seg).forEach(x => x.classList.toggle('on', x === b));
      if (f === 'condition') seg.parentElement.querySelector('.hint').textContent = t('cond_' + c.condition);
      onChange(c, f);
    });
  });
  $$('input[data-field], textarea[data-field], select[data-field]', root).forEach(inp => {
    inp.addEventListener('change', () => {
      const f = inp.dataset.field;
      let v = inp.value;
      if (f === 'printing') {
        const p = c.printings.find(x => x.code === v);
        if (p) { c.number = p.code; c.set = p.set; c.rarity = p.rarity; c.setId = p.code.split('-')[0]; c.pricingRaw = { ...c.pricingRaw, set_price: p.price }; }
      } else if (f === 'purchase') c.purchase = v === '' ? null : +v;
      else if (f === 'customValue') { c.customValue = v === '' ? null : +v; c.customCur = S.settings.currency; }
      else c[f] = v.trim ? v.trim() : v;
      onChange(c, f);
    });
  });
}

function priceHTML(c) {
  const m = market(c);
  const v = unitValue(c);
  const cur = S.settings.currency;
  const f = condFactor(c);
  const custom = c.customValue != null && c.customValue !== '';
  // Analyse de tendance
  let verdict = '', vcls = 'flat';
  if (m.eur && m.avg30) {
    const d = (m.eur - m.avg30) / m.avg30;
    vcls = d > 0.08 ? 'up' : d < -0.08 ? 'down' : 'flat';
    verdict = t('verdict_' + vcls).replace('{p}', pct(d));
    if (m.avg1 && m.avg7 && Math.abs(m.avg1 - m.avg7) / m.avg7 > 0.25) verdict += ` ${t('volatile')}`;
  } else if ((c.history || []).length >= 2) {
    const tr = trendOf(c);
    vcls = tr > 0.03 ? 'up' : tr < -0.03 ? 'down' : 'flat';
    verdict = `${t('sinceAdded')} : ${pct(tr)}`;
  } else verdict = t('noHistory');

  const pts = [['30 j', m.avg30], ['7 j', m.avg7], ['24 h', m.avg1], [t('now'), m.eur]].filter(p => p[1] != null);
  const own = (c.history || []).map(p => ({ t: p.t, v: cur === 'EUR' ? p.eur ?? convert(p.usd, 'USD', 'EUR') : p.usd ?? convert(p.eur, 'EUR', 'USD') })).filter(p => p.v != null);
  const pl = c.purchase != null && v != null ? (v - c.purchase) : null;

  return `
  <div class="price-card">
    <div class="price-main">
      <div>
        <div class="muted small">${custom ? t('customValue') : t('estValue')}</div>
        <div class="price-big">${money(v)}</div>
        <div class="muted small">${!custom && f !== 1 ? `${t('condAdjusted')} (${c.condition} ×${f})` : ''}${(c.qty || 1) > 1 ? ` · ×${c.qty} = <b>${money((v || 0) * c.qty)}</b>` : ''}</div>
      </div>
      ${pl != null ? `<div class="pl ${pl >= 0 ? 'up' : 'down'}"><div class="muted small">${t('profit')}</div><b>${pl >= 0 ? '+' : ''}${money(pl)}</b><div class="small">${c.purchase ? pct(pl / c.purchase) : ''}</div></div>` : ''}
    </div>
    <div class="verdict ${vcls}">${icon(vcls === 'up' ? 'up' : vcls === 'down' ? 'down' : 'flat')}<span>${verdict}</span></div>
    ${pts.length >= 2 ? `<div class="chart-box"><div class="muted small">${t('cmTrend')}</div>${lineChart(pts.map(p => ({ v: p[1] })), { labels: pts.map(p => p[0]), color: vcls === 'down' ? '#fb7185' : '#34d399', fmt: x => money(x, 'EUR') })}</div>` : ''}
    <div class="price-grid">
      ${m.eur != null ? `<div><span>Cardmarket</span><b>${money(m.eur, 'EUR')}</b><em>${t('trendPrice')}</em></div>` : ''}
      ${m.low != null ? `<div><span>Cardmarket</span><b>${money(m.low, 'EUR')}</b><em>${t('lowPrice')}</em></div>` : ''}
      ${m.usd != null ? `<div><span>TCGplayer</span><b>${money(m.usd, 'USD')}</b><em>${t('marketPrice')}</em></div>` : ''}
      ${m.usdLow != null ? `<div><span>TCGplayer</span><b>${money(m.usdLow, 'USD')} – ${money(m.usdHigh, 'USD')}</b><em>${t('range')}</em></div>` : ''}
      ${m.ebay != null ? `<div><span>eBay</span><b>${money(m.ebay, 'USD')}</b><em>${t('marketPrice')}</em></div>` : ''}
      ${m.eur == null && m.usd == null ? `<div class="wide"><span>${t('noPrice')}</span></div>` : ''}
    </div>
    ${own.length >= 2 ? `<div class="chart-box"><div class="muted small">${t('myHistory')}</div>${lineChart(own.slice(-30).map(p => ({ v: p.v })), { color: '#8b5cf6', fmt: x => money(x) })}</div>` : ''}
  </div>`;
}

async function openAdd(r, { photo, list } = {}) {
  const body = openSheet(`<div class="loading-block"><div class="spinner"></div><p class="muted">${t('loadingCard')}</p></div>`, { cls: 'tall' });
  let d;
  try { d = await providers[r.game].getDetails(r.apiId, r.lang, r.extra); }
  catch (e) { body.innerHTML = `<p class="error center">${t('networkError')}</p>`; return; }
  const c = { uid: newId(), ...d, qty: 1, condition: 'NM', variant: defaultVariant(d), list: list || 'collection', purchase: null, addedAt: Date.now(), photo: photo || null, history: [] };

  const owned = () => S.cards.find(x => x.game === c.game && x.apiId === c.apiId && (x.variant || 'normal') === c.variant && x.condition === c.condition && (x.list || 'collection') === c.list && x.number === c.number);
  body.innerHTML = `
    <div class="detail-head">
      ${cardVisual(c, 'md')}
      <div class="detail-info">
        <span class="game-tag inline" style="--g:${GAMES[c.game].color}">${GAMES[c.game].label}</span>
        <h2>${esc(c.name)}</h2>
        <div class="muted">${esc(c.set || '')}</div>
        <div class="muted small">${c.number ? `#${esc(c.number)}${c.setTotal ? '/' + c.setTotal : ''}` : ''} ${c.rarity ? '· ' + esc(c.rarity) : ''}</div>
        <div id="owned"></div>
      </div>
    </div>
    <div id="price">${priceHTML(c)}</div>
    ${fieldsHTML(c, { isNew: true })}
    <div class="sticky-actions"><button class="btn primary block" id="add-btn">${icon('plus')}<span>${t('add')}</span></button></div>`;
  bindTilt(body);
  const refreshOwned = () => {
    const o = owned();
    $('#owned', body).innerHTML = o ? `<span class="pill ok">${icon('check')}${t('alreadyOwned')} ×${o.qty || 1}</span>` : '';
    $('#add-btn span', body).textContent = c.list === 'wishlist' ? t('addWish') : o ? t('addOneMore') : t('add');
  };
  refreshOwned();
  bindFields(body, c, () => { $('#price', body).innerHTML = priceHTML(c); refreshOwned(); });

  $('#add-btn', body).onclick = async () => {
    const progressOf = () => (c.list === 'wishlist' ? null : groupSets(S.cards.filter(inCollection)).find(g => g.key === setKey(c)));
    const before = progressOf();
    const o = owned();
    if (o) { o.qty = (o.qty || 1) + (c.qty || 1); if (c.purchase != null && o.purchase == null) o.purchase = c.purchase; await saveCard(o); }
    else { pushHistory(c); await saveCard(c); }
    navigator.vibrate?.([20, 40, 20]);
    toast(`${icon('check')} <b>${esc(c.name)}</b> ${t(c.list === 'wishlist' ? 'addedWish' : 'added')}`, 'ok');
    if (c.list !== 'wishlist') celebrate(before, progressOf(), c.set || '');
    snapshotValue();
    closeSheets(sheets.length);
    if (S.route !== 'scan') go();
  };
}

// ---------------------------------------------------------------- FICHE CARTE
function openCard(id) {
  const c = S.cards.find(x => x.uid === id);
  if (!c) return;
  const body = openSheet('', { cls: 'tall', onClose: () => { if (S.route !== 'scan') go(); } });
  const links = marketLinks(c);
  body.innerHTML = `
    <div class="detail-head">
      ${cardVisual(c, 'md')}
      <div class="detail-info">
        <span class="game-tag inline" style="--g:${GAMES[c.game].color}">${GAMES[c.game].label}</span>
        <h2>${esc(c.name)}</h2>
        <div class="muted">${esc(c.set || '')}</div>
        <div class="muted small">${c.number ? `#${esc(c.number)}${c.setTotal ? '/' + c.setTotal : ''}` : ''} ${c.rarity ? '· ' + esc(c.rarity) : ''}</div>
        ${c.artist ? `<div class="muted small">${t('artist')} : ${esc(c.artist)}</div>` : ''}
        <div class="muted small">${t('addedOn')} ${new Date(c.addedAt).toLocaleDateString(locale())}</div>
      </div>
    </div>
    ${c.photo && c.image ? `<details class="my-photo"><summary>${icon('image')} ${t('myScan')}</summary><img src="${c.photo}" alt=""></details>` : ''}
    <div id="price">${priceHTML(c)}</div>
    <div class="links">${links.map(l => `<a class="chip" href="${l.url}" target="_blank" rel="noopener">${l.label}${icon('external')}</a>`).join('')}</div>
    ${fieldsHTML(c)}
    <div class="action-row">
      <button class="btn ghost" id="c-refresh">${icon('refresh')}${t('refreshPrice')}</button>
      <button class="btn ghost" id="c-share">${icon('share')}${t('share')}</button>
      <button class="btn ghost" id="c-move">${icon(c.list === 'wishlist' ? 'cards' : 'heart')}${t(c.list === 'wishlist' ? 'moveToCollection' : 'moveToWishlist')}</button>
      <button class="btn danger" id="c-del">${icon('trash')}${t('delete')}</button>
    </div>`;
  bindTilt(body);
  bindFields(body, c, async () => { $('#price', body).innerHTML = priceHTML(c); await saveCard(c); });

  $('#c-refresh', body).onclick = async e => {
    const b = e.currentTarget; b.classList.add('loading');
    try {
      const d = await providers[c.game].getDetails(c.apiId, c.lang, { setCode: c.number });
      c.pricingRaw = d.pricingRaw; c.priceUpdated = Date.now();
      pushHistory(c); await saveCard(c);
      $('#price', body).innerHTML = priceHTML(c);
      toast(t('priceUpdated'), 'ok');
    } catch { toast(t('networkError'), 'warn'); }
    b.classList.remove('loading');
  };
  $('#c-share', body).onclick = async () => {
    const text = `${c.name} — ${c.set || ''} #${c.number || ''} · ${t('estValue')} ${money(unitValue(c))}`;
    if (navigator.share) navigator.share({ title: c.name, text, url: links[0].url }).catch(() => {});
    else { await navigator.clipboard?.writeText(`${text}\n${links[0].url}`); toast(t('copied'), 'ok'); }
  };
  $('#c-move', body).onclick = async () => {
    c.list = c.list === 'wishlist' ? 'collection' : 'wishlist';
    await saveCard(c); snapshotValue();
    toast(t(c.list === 'wishlist' ? 'movedWish' : 'movedCol'), 'ok');
    closeSheet();
  };
  $('#c-del', body).onclick = async () => {
    if (!confirm(t('confirmDelete').replace('{n}', c.name))) return;
    S.cards = S.cards.filter(x => x.uid !== c.uid);
    await db.del(c.uid); snapshotValue();
    toast(t('deleted'));
    closeSheet();
  };
}

// ---------------------------------------------------------------- STATS
function renderStats() {
  const col = S.cards.filter(inCollection);
  if (!col.length) {
    view.innerHTML = `<h1 class="page-title">${t('tab_stats')}</h1>${emptyHTML('collection')}`;
    $('#empty-search')?.addEventListener('click', () => openSearch({}));
    return;
  }
  const cur = S.settings.currency, k = cur === 'EUR' ? 'eur' : 'usd';
  const total = sum(col, c => lineValue(c));
  const count = sum(col, c => c.qty || 1);
  const bought = col.filter(c => c.purchase != null);
  const invested = sum(bought, c => c.purchase * (c.qty || 1));
  const boughtValue = sum(bought, c => lineValue(c));
  const pl = boughtValue - invested;
  const avg = total / count;

  // Tendance du marché sur ta collection (moyennes Cardmarket)
  const withAvg = col.filter(c => market(c).avg30 != null && (c.customValue == null || c.customValue === ''));
  const mk = key => sum(withAvg, c => lineValue(c, cur, key));
  const mpts = withAvg.length ? [['30 j', mk('avg30')], ['7 j', mk('avg7')], ['24 h', mk('avg1')], [t('now'), mk('eur')]] : [];
  const m30 = mpts.length ? (mpts[3][1] - mpts[0][1]) / (mpts[0][1] || 1) : null;

  const vh = S.valueHistory.filter(p => p[k] != null);

  const byGame = Object.keys(GAMES).map(g => ({ label: GAMES[g].label, color: GAMES[g].color, value: sum(col.filter(c => c.game === g), c => lineValue(c)) })).filter(x => x.value > 0);
  const rarity = {};
  col.forEach(c => { const r = c.rarity || '—'; rarity[r] = (rarity[r] || 0) + lineValue(c); });
  const rarityItems = Object.entries(rarity).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([label, value]) => ({ label: esc(label), value }));

  const top = [...col].sort((a, b) => (unitValue(b) || 0) - (unitValue(a) || 0)).slice(0, 10);
  const movers = col.map(c => ({ c, tr: trendOf(c) })).filter(x => x.tr != null && Math.abs(x.tr) > 0.005);
  const ups = [...movers].sort((a, b) => b.tr - a.tr).slice(0, 5).filter(x => x.tr > 0);
  const downs = [...movers].sort((a, b) => a.tr - b.tr).slice(0, 5).filter(x => x.tr < 0);

  // Progression des séries (Pokémon)
  const sets = {};
  col.filter(c => c.game === 'pokemon' && c.setTotal).forEach(c => {
    const s = sets[c.setId] || (sets[c.setId] = { name: c.set, total: c.setTotal, logo: c.setLogo, nums: new Set() });
    s.nums.add(String(c.number).replace(/^0+/, ''));
  });
  const setList = Object.values(sets).sort((a, b) => b.nums.size / b.total - a.nums.size / a.total).slice(0, 12);

  const moverRow = x => `<button class="mini-row" data-uid="${x.c.uid}">${thumbImg(x.c.thumb || x.c.image, x.c.name)}<span class="mini-name">${esc(x.c.name)}<em>${esc(x.c.set || '')}</em></span><b>${money(unitValue(x.c))}</b>${trendBadge(x.tr)}</button>`;

  view.innerHTML = `
    <h1 class="page-title">${t('tab_stats')}</h1>
    <section class="hero">
      <div class="hero-label">${t('collectionValue')}</div>
      <div class="hero-value">${money(total)} ${m30 != null ? trendBadge(m30, false) : ''}</div>
      <div class="hero-sub">${m30 != null ? t('marketTrend30') : ''}</div>
    </section>
    <div class="kpis">
      <div class="kpi"><span>${t('cardsOwned')}</span><b>${count}</b><em>${col.length} ${t('unique')}</em></div>
      <div class="kpi"><span>${t('avgValue')}</span><b>${money(avg)}</b><em>${t('perCard')}</em></div>
      <div class="kpi"><span>${t('invested')}</span><b>${money(invested)}</b><em>${bought.length} ${t('withPrice')}</em></div>
      <div class="kpi ${pl >= 0 ? 'up' : 'down'}"><span>${t('profit')}</span><b>${bought.length ? (pl >= 0 ? '+' : '') + money(pl) : '—'}</b><em>${invested ? pct(pl / invested) : t('addPurchase')}</em></div>
    </div>

    ${mpts.length ? `<section class="panel">
      <div class="panel-head"><h3>${t('marketAnalysis')}</h3><span class="muted small">Cardmarket · ${withAvg.length} ${t('cards')}</span></div>
      ${lineChart(mpts.map(p => ({ v: p[1] })), { labels: mpts.map(p => p[0]), color: m30 < 0 ? '#fb7185' : '#34d399', fmt: x => money(x) })}
      <p class="muted small">${t('marketAnalysisHelp')}</p>
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><h3>${t('valueHistory')}</h3><span class="muted small">${vh.length} ${t('points')}</span></div>
      ${vh.length >= 2 ? lineChart(vh.slice(-60).map(p => ({ v: p[k] })), { labels: vh.slice(-60).map((p, i, a) => (i === 0 || i === a.length - 1 ? new Date(p.t).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) : '')), color: '#8b5cf6', fmt: x => money(x) }) : `<p class="muted small">${t('historyHelp')}</p>`}
    </section>

    ${ups.length || downs.length ? `<section class="panel">
      <div class="panel-head"><h3>${t('movers')}</h3></div>
      ${ups.length ? `<div class="sub-head up">${icon('up')}${t('rising')}</div>${ups.map(moverRow).join('')}` : ''}
      ${downs.length ? `<div class="sub-head down">${icon('down')}${t('falling')}</div>${downs.map(moverRow).join('')}` : ''}
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><h3>${t('topCards')}</h3></div>
      <div class="top-list">${top.map((c, i) => `<button class="mini-row" data-uid="${c.uid}"><span class="rank">${i + 1}</span>${thumbImg(c.thumb || c.image, c.name)}<span class="mini-name">${esc(c.name)}<em>${esc(c.set || '')}</em></span><b>${money(unitValue(c))}</b></button>`).join('')}</div>
    </section>

    <div class="two-col">
      ${byGame.length > 1 ? `<section class="panel">
        <div class="panel-head"><h3>${t('byGame')}</h3></div>
        <div class="donut-wrap">${donut(byGame, { center: money(total) })}
          <div class="legend">${byGame.map(g => `<div><i style="background:${g.color}"></i>${g.label}<b>${Math.round(g.value / total * 100)} %</b></div>`).join('')}</div></div>
      </section>` : ''}
      <section class="panel">
        <div class="panel-head"><h3>${t('byRarity')}</h3></div>
        ${bars(rarityItems, { fmt: x => money(x) })}
      </section>
    </div>

    ${setList.length ? `<section class="panel">
      <div class="panel-head"><h3>${t('setProgress')}</h3></div>
      <div class="sets">${setList.map(s => {
        const p = Math.min(1, s.nums.size / s.total);
        return `<div class="set-row"><div class="set-name">${s.logo ? `<img src="${esc(s.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span>${esc(s.name)}</span><b>${s.nums.size}/${s.total}</b></div>
          <div class="progress"><div style="width:${p * 100}%"></div></div></div>`;
      }).join('')}</div>
    </section>` : ''}
    <p class="muted small center source-note">${t('sourcesNote')}</p>`;

  view.onclick = e => { const b = e.target.closest('[data-uid]'); if (b) openCard(b.dataset.uid); };
}

// ---------------------------------------------------------------- RÉGLAGES
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (S.route === 'settings') renderSettings(); });

function seg(name, value, options) {
  return `<div class="seg small" data-setting="${name}">${options.map(([v, l]) => `<button data-v="${v}" class="${value === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function toggle(name, value) {
  return `<label class="switch"><input type="checkbox" data-setting="${name}" ${value ? 'checked' : ''}><span></span></label>`;
}

function renderSettings() {
  const s = S.settings;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  view.innerHTML = `
    <h1 class="page-title">${t('tab_settings')}</h1>
    ${!standalone ? `<section class="panel install">
      <div class="install-ic">${icon('phone')}</div>
      <div><h3>${t('installTitle')}</h3><p class="muted small">${installPrompt ? t('installText') : t('installIos')}</p></div>
      ${installPrompt ? `<button class="btn primary" id="install">${t('install')}</button>` : ''}
    </section>` : ''}
    <section class="panel settings">
      <div class="set-item"><div><b>${t('appLanguage')}</b></div>${seg('uiLang', s.uiLang, [['fr', 'Français'], ['en', 'English']])}</div>
      <div class="set-item"><div><b>${t('cardLanguage')}</b><p class="muted small">${t('cardLanguageHelp')}</p></div>${seg('cardLang', s.cardLang, [['fr', 'FR'], ['en', 'EN']])}</div>
      <div class="set-item"><div><b>${t('currency')}</b><p class="muted small">1 USD = ${s.rate.toFixed(3)} EUR</p></div>${seg('currency', s.currency, [['EUR', '€ EUR'], ['USD', '$ USD']])}</div>
      <div class="set-item"><div><b>${t('defaultGame')}</b></div>${seg('game', s.game, Object.keys(GAMES).map(k => [k, GAMES[k].short]))}</div>
      <div class="set-item"><div><b>${t('condAdjust')}</b><p class="muted small">${t('condAdjustHelp')}</p></div>${toggle('condAdjust', s.condAdjust)}</div>
      <div class="set-item"><div><b>${t('autoRefresh')}</b><p class="muted small">${t('autoRefreshHelp')}</p></div>${toggle('autoRefresh', s.autoRefresh)}</div>
    </section>
    <section class="panel settings">
      <div class="panel-head"><h3>${t('data')}</h3><span class="muted small">${S.cards.length} ${t('entries')}</span></div>
      <button class="set-btn" id="refresh-all">${icon('refresh')}<span>${t('refreshAll')}<em>${lastUpdateText()}</em></span></button>
      <button class="set-btn" id="share-col">${icon('share')}<span>${t('shareCollection')}<em>${t('shareCollectionHelp')}</em></span></button>
      <button class="set-btn" id="export">${icon('download')}<span>${t('exportJson')}<em>${t('exportJsonHelp')}</em></span></button>
      <label class="set-btn">${icon('upload')}<span>${t('importJson')}<em>${t('importJsonHelp')}</em></span><input type="file" id="import" accept=".json,application/json" hidden></label>
      <button class="set-btn" id="export-csv">${icon('file')}<span>${t('exportCsv')}<em>${t('exportCsvHelp')}</em></span></button>
      <button class="set-btn danger" id="wipe">${icon('trash')}<span>${t('wipe')}</span></button>
    </section>
    <section class="panel about">
      <h3>${t('about')}</h3>
      <p class="muted small">${t('aboutText')}</p>
      <p class="muted small">${t('sourcesNote')}</p>
    </section>`;

  $$('.seg[data-setting]').forEach(sg => $$('button', sg).forEach(b => b.onclick = async () => {
    S.settings[sg.dataset.setting] = b.dataset.v;
    await saveSettings();
    if (sg.dataset.setting === 'uiLang') { setLang(b.dataset.v); applyStaticI18n(); }
    renderSettings();
  }));
  $$('input[data-setting]').forEach(i => i.onchange = async () => { S.settings[i.dataset.setting] = i.checked; await saveSettings(); });
  $('#install')?.addEventListener('click', async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; renderSettings(); });
  $('#refresh-all').onclick = () => refreshAll();
  $('#export').onclick = () => download(`holovault-${dateStamp()}.json`, JSON.stringify(exportData(), null, 1), 'application/json');
  $('#export-csv').onclick = () => download(`holovault-${dateStamp()}.csv`, toCSV(), 'text/csv');
  $('#share-col').onclick = shareCollection;
  $('#import').onchange = importFile;
  $('#wipe').onclick = async () => {
    if (!confirm(t('confirmWipe'))) return;
    await db.clear(); S.cards = []; S.valueHistory = []; await db.setMeta('valueHistory', []);
    toast(t('wiped')); renderSettings();
  };
}

const dateStamp = () => new Date().toISOString().slice(0, 10);
function exportData() {
  return { app: 'HoloVault', version: 1, exportedAt: new Date().toISOString(), currency: S.settings.currency, cards: S.cards, valueHistory: S.valueHistory };
}
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(t('exported'), 'ok');
}
function toCSV() {
  const cur = S.settings.currency;
  const head = ['list', 'game', 'name', 'set', 'number', 'rarity', 'language', 'variant', 'condition', 'grade', 'quantity', `purchase_${cur}`, `unit_value_${cur}`, `total_value_${cur}`, 'cardmarket_eur', 'tcgplayer_usd', 'added', 'notes'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = S.cards.map(c => {
    const m = market(c), v = unitValue(c);
    return [c.list || 'collection', c.game, c.name, c.set, c.number, c.rarity, c.lang, c.variant, c.condition, c.grade, c.qty || 1, c.purchase, v?.toFixed(2), ((v || 0) * (c.qty || 1)).toFixed(2), m.eur, m.usd, new Date(c.addedAt).toISOString().slice(0, 10), c.notes].map(q).join(';');
  });
  return '﻿' + [head.join(';'), ...rows].join('\n');
}
async function shareCollection() {
  const data = JSON.stringify({ ...exportData(), cards: S.cards.map(({ photo, ...c }) => c) });
  const file = new File([data], `collection-${dateStamp()}.json`, { type: 'application/json' });
  const col = S.cards.filter(inCollection);
  const text = `${t('myCollection')} : ${sum(col, c => c.qty || 1)} ${t('cards')} · ${money(sum(col, c => lineValue(c)))}`;
  if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file], title: 'HoloVault', text }).catch(() => {});
  else download(file.name, data, 'application/json');
}
async function importFile(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const cards = Array.isArray(data) ? data : data.cards;
    if (!Array.isArray(cards)) throw new Error('format');
    const merge = S.cards.length ? confirm(t('importMerge')) : true;
    if (!merge) { await db.clear(); S.cards = []; }
    const valid = cards.filter(c => c && c.uid && c.game && c.name);
    await db.putMany(valid);
    S.cards = await db.all();
    if (Array.isArray(data.valueHistory) && !S.valueHistory.length) { S.valueHistory = data.valueHistory; await db.setMeta('valueHistory', S.valueHistory); }
    toast(`${valid.length} ${t('imported')}`, 'ok');
    renderSettings();
  } catch { toast(t('importError'), 'warn'); }
}

// ---------------------------------------------------------------- ACTUALISATION DES PRIX
let refreshing = false;
async function refreshAll(silent = false) {
  if (refreshing || !S.cards.length) return;
  if (!navigator.onLine) return silent ? null : toast(t('offline'), 'warn');
  refreshing = true;
  document.body.classList.add('refreshing');
  const tt = toast(`${icon('refresh', 'spin')} ${t('refreshing')}…`);
  tt.keep();
  try { const r = await fetchRate(); if (r) S.settings.rate = r; } catch { /* taux par défaut */ }
  const cache = new Map();
  let ok = 0, i = 0;
  for (const c of S.cards) {
    i++;
    const key = `${c.game}|${c.apiId}|${c.lang}|${c.number}`;
    try {
      if (!cache.has(key)) {
        cache.set(key, providers[c.game].getDetails(c.apiId, c.lang, { setCode: c.number }));
        await sleep(c.game === 'mtg' ? 110 : 40);
      }
      const d = await cache.get(key);
      c.pricingRaw = d.pricingRaw;
      if (!c.image && d.image) { c.image = d.image; c.thumb = d.thumb; }
      c.priceUpdated = Date.now();
      pushHistory(c);
      ok++;
    } catch { /* on garde l'ancien prix */ }
    tt.update(`${icon('refresh', 'spin')} ${t('refreshing')} ${i}/${S.cards.length}`);
  }
  await db.putMany(S.cards);
  S.settings.lastRefresh = Date.now();
  await saveSettings();
  await snapshotValue();
  refreshing = false;
  document.body.classList.remove('refreshing');
  tt.close();
  toast(`${icon('check')} ${ok}/${S.cards.length} ${t('pricesUpdated')}`, 'ok');
  if (!sheets.length && S.route !== 'scan') go();
}

// ---------------------------------------------------------------- démarrage
async function init() {
  try {
    const s = await db.getMeta('settings');
    if (s) Object.assign(S.settings, s);
    S.cards = (await db.all()) || [];
    S.valueHistory = (await db.getMeta('valueHistory')) || [];
  } catch (e) { console.error(e); }
  setLang(S.settings.uiLang);
  applyStaticI18n();
  history.replaceState({ sheet: 0 }, '');
  go();
  document.body.classList.add('ready');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.();
  if (S.settings.autoRefresh && S.cards.length && Date.now() - S.settings.lastRefresh > 20 * 3600e3) setTimeout(() => refreshAll(true), 1500);

  document.addEventListener('visibilitychange', () => {
    if (S.route !== 'scan') return;
    if (document.hidden) scanner.stopCamera();
    else if ($('#video')) scanner.startCamera($('#video')).catch(() => {});
  });
  $('#btn-search').onclick = () => openSearch({});
}
init();
