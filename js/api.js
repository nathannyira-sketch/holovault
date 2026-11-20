// Sources de données et de prix :
//  - Pokémon : TCGdex (noms FR/EN, prix Cardmarket € et TCGplayer $)
//  - Magic   : Scryfall (prix Cardmarket € et TCGplayer $)
//  - Yu-Gi-Oh: YGOPRODeck (prix Cardmarket € et TCGplayer $)
import { db } from './db.js';

const TCGDEX = 'https://api.tcgdex.net/v2';
const SCRY = 'https://api.scryfall.com';
const YGO = 'https://db.ygoprodeck.com/api/v7';

export const GAMES = {
  pokemon: { label: 'Pokémon', short: 'PKM', color: '#ffcb05' },
  mtg: { label: 'Magic', short: 'MTG', color: '#c084fc' },
  yugioh: { label: 'Yu-Gi-Oh!', short: 'YGO', color: '#fb7185' },
};

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const num = v => (v === null || v === undefined || v === '' || isNaN(+v) || +v === 0 ? null : +v);
export const normNum = s => String(s ?? '').trim().toUpperCase().replace(/^0+(?=\w)/, '');

// --- similarité de texte (pour classer les résultats d'OCR) ---
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
// Levenshtein normalisé sur des chaînes déjà « pliées » (rapide, sans allocation de matrice)
function levSim(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  if (a === b) return 1;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[n] / Math.max(m, n);
}
function similarity(a, b) {
  a = fold(a); b = fold(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}

function rank(list, { query, number, total }) {
  const n = number ? normNum(number) : null;
  const queries = (Array.isArray(query) ? query : [query]).filter(Boolean);
  // le 1er nom (saisi ou corrigé) compte pleinement, les autres mots lus comptent moins
  const sim = name => Math.max(0, ...queries.map((q, qi) => (qi ? 0.6 : 1) * Math.max(
    similarity(q, name),
    similarity(q, String(name || '').split(/[\s-]/)[0]) * 0.9, // « Dracaufeu » ≈ « Dracaufeu VMAX »
  )));
  list.forEach((r, i) => {
    r.numMatch = !!n && normNum(r.number) === n;
    const s = Math.max(sim(r.name), sim(r.altName));
    // le nom prime : un numéro mal lu ne doit pas faire gagner une autre carte
    r.score = s * 6
      + (r.numMatch ? 4 : 0)
      + (r.numMatch && s > 0.75 ? 4 : 0)
      + (total && r.setTotal && +r.setTotal === +total ? 3 : 0)
      + (r.thumb ? 0.5 : 0)
      - i * 0.0001;
  });
  return list.sort((a, b) => b.score - a.score);
}

// =============== POKÉMON (TCGdex) ===============
const setCache = {};
function pokemonSets(lang) {
  if (!setCache[lang]) {
    setCache[lang] = getJSON(`${TCGDEX}/${lang}/sets`)
      .then(l => Object.fromEntries((l || []).map(s => [s.id, s])))
      .catch(() => { delete setCache[lang]; return {}; });
  }
  return setCache[lang];
}

const tcgdexImg = (base, q) => (base ? `${base}/${q}.webp` : null);

// Contenu complet d'une série (liste de ses cartes)
const setCardsCache = {};
function pokemonSetCards(lang, setId) {
  const k = `${lang}|${setId}`;
  if (!setCardsCache[k]) {
    setCardsCache[k] = getJSON(`${TCGDEX}/${lang}/sets/${encodeURIComponent(setId)}`)
      .catch(e => { delete setCardsCache[k]; throw e; });
  }
  return setCardsCache[k];
}

// Correspondance souple d'un nom avec une saisie / un mot lu
const looseMatch = (names, cardName) => names.some(nm => {
  const a = fold(nm), b = fold(cardName);
  return b.includes(a) || levSim(a, b.split(/[\s-]/)[0]) >= 0.6 || levSim(a, b) >= 0.6;
});

const pokemon = {
  async search(query, { lang = 'fr', number, total, candidates = [], setId } = {}) {
    if (setId) {
      // Série choisie : on parcourt ses cartes (marche même sans nom, ou avec juste le numéro)
      const s = await pokemonSetCards(lang, setId);
      if (!s) return [];
      const all = (s.cards || []).map(c => ({
        game: 'pokemon', apiId: c.id, lang, name: c.name, number: c.localId,
        set: s.name, setId: s.id, setTotal: s.cardCount?.official, thumb: tcgdexImg(c.image, 'low'),
      }));
      const names = [query, ...candidates].map(x => (x || '').trim()).filter(x => x.length >= 2);
      const n = number ? normNum(number) : null;
      const list = names.length || n
        ? all.filter(r => (names.length && looseMatch(names, r.name)) || (n && normNum(r.number) === n))
        : all;
      return rank(list, { query: names, number, total }).slice(0, 300);
    }
    const sets = await pokemonSets(lang);
    const fetchQ = q => getJSON(`${TCGDEX}/${lang}/cards?${q}&pagination:itemsPerPage=500`).catch(() => null);
    const fetchName = q => fetchQ(`name=${encodeURIComponent(q)}`);
    const setTotalOf = c => sets[c.id.slice(0, c.id.lastIndexOf('-'))]?.cardCount?.official;
    query = (query || '').trim();
    // Noms à essayer : la saisie + les autres mots candidats lus sur la carte
    const names = [...new Set([query, ...candidates.slice(0, 5)].filter(w => w && w.length >= 3))];
    // 1) chaque nom + ce nom sans sa 1re lettre (gère « Evoli » / « Évoli » et une 1re lettre mal lue)
    // 2) numéro exact dans une série de la bonne taille (fonctionne même si le nom est illisible)
    const byNumber = async () => {
      if (!number || !total) return [];
      const variants = [...new Set([number, normNum(number), String(normNum(number)).padStart(3, '0')])];
      const res = (await Promise.all(variants.map(v => fetchQ(`localId=${encodeURIComponent(v)}`)))).flat().filter(Boolean);
      const exact = res.filter(c => +setTotalOf(c) === +total);
      // un chiffre du total mal lu (164 au lieu de 165) : on tolère ±1 s'il n'y a rien d'exact
      return exact.length ? exact : res.filter(c => Math.abs(+setTotalOf(c) - +total) === 1);
    };
    const nameReqs = names.flatMap(nm => {
      const first = nm.split(' ')[0];
      return [fetchName(nm), first.length >= 4 ? fetchName(first.slice(1)) : null];
    });
    const [n, ...byName] = await Promise.all([byNumber(), ...nameReqs]);
    const nameHits = byName.flatMap(r => r || []);
    let list = [...(n || []), ...nameHits];
    // 3) repli : chaque mot (du plus long au plus court) et ses fragments
    if (!nameHits.length) {
      const words = [...new Set(names.flatMap(nm => nm.split(' ')).filter(w => w.length >= 4).sort((x, y) => y.length - x.length))];
      for (const w of words) {
        let r = null;
        for (const frag of [w, w.slice(1), w.slice(0, -1), w.slice(1, -1)]) {
          if (frag.length < 3) continue;
          r = await fetchName(frag);
          if (r?.length) break;
        }
        if (r?.length) { list.push(...r); break; }
      }
    }
    const seen = new Set();
    list = list.filter(c => !seen.has(c.id) && seen.add(c.id));
    const out = list.map(c => {
      const setId = c.id.slice(0, c.id.lastIndexOf('-'));
      const s = sets[setId];
      return {
        game: 'pokemon', apiId: c.id, lang, name: c.name, number: c.localId,
        set: s?.name || setId, setId, setTotal: s?.cardCount?.official,
        thumb: tcgdexImg(c.image, 'low') || (s?.logo ? `${s.logo}.webp` : null),
      };
    });
    return rank(out, { query: names, number, total }).slice(0, 80);
  },

  async getDetails(apiId, lang = 'fr') {
    const c = await getJSON(`${TCGDEX}/${lang}/cards/${encodeURIComponent(apiId)}`);
    if (!c) throw new Error('not found');
    let image = c.image;
    if (!image && lang !== 'en') {
      const en = await getJSON(`${TCGDEX}/en/cards/${encodeURIComponent(apiId)}`).catch(() => null);
      image = en?.image;
    }
    return {
      game: 'pokemon', apiId: c.id, lang, name: c.name, number: c.localId,
      set: c.set?.name, setId: c.set?.id, setTotal: c.set?.cardCount?.official,
      setLogo: c.set?.logo ? `${c.set.logo}.webp` : null,
      rarity: c.rarity, artist: c.illustrator,
      image: tcgdexImg(image, 'high'), thumb: tcgdexImg(image, 'low'),
      variantsAvailable: c.variants || null,
      pricingRaw: c.pricing || null,
    };
  },

  market(raw, variant) {
    const cm = raw?.cardmarket, tp = raw?.tcgplayer;
    const sfx = variant === 'reverse' ? '-holo' : '';
    const g = k => num(cm?.[k + sfx]) ?? (sfx ? num(cm?.[k]) : null);
    const keys = {
      normal: ['normal', 'holofoil', 'reverseHolofoil', 'reverse-holofoil'],
      holo: ['holofoil', 'normal', 'reverseHolofoil'],
      reverse: ['reverseHolofoil', 'reverse-holofoil', 'normal', 'holofoil'],
      first: ['1stEditionHolofoil', '1st-edition-holofoil', '1stEditionNormal', '1st-edition-normal', 'holofoil', 'normal'],
    }[variant || 'normal'] || [];
    let tpo = null;
    if (tp) {
      for (const k of keys) if (tp[k] && typeof tp[k] === 'object') { tpo = tp[k]; break; }
      if (!tpo) tpo = Object.values(tp).find(v => v && typeof v === 'object' && (v.marketPrice || v.midPrice)) || null;
    }
    return {
      eur: g('trend') ?? g('avg30') ?? g('avg'),
      low: g('low'), avg1: g('avg1'), avg7: g('avg7'), avg30: g('avg30'),
      usd: num(tpo?.marketPrice) ?? num(tpo?.midPrice),
      usdLow: num(tpo?.lowPrice), usdHigh: num(tpo?.highPrice),
      src: { eur: 'Cardmarket', usd: 'TCGplayer' },
      updated: cm?.updated || tp?.updated,
    };
  },
};

// =============== MAGIC (Scryfall) ===============
const scryImg = (c, size) => c?.image_uris?.[size] || c?.card_faces?.[0]?.image_uris?.[size] || null;
const mtgNorm = (c, lang) => ({
  game: 'mtg', apiId: c.id, lang: c.lang || lang, name: c.printed_name || c.name, altName: c.name,
  number: c.collector_number, set: c.set_name, setId: c.set, setTotal: null,
  thumb: scryImg(c, 'normal'),
});

const mtg = {
  async search(query, { lang = 'fr', number, setId } = {}) {
    if (!query && !setId) return [];
    const s = q => getJSON(`${SCRY}/cards/search?unique=prints&order=${setId ? 'set' : 'released'}&q=${encodeURIComponent(q)}`).catch(() => null);
    if (setId) {
      const base = `${query || ''} e:${setId}`.trim();
      let d = lang === 'fr' ? await s(`${base} lang:fr`) : null;
      if (!d?.data?.length) d = await s(base);
      return rank((d?.data || []).map(c => mtgNorm(c, lang)), { query, number }).slice(0, 300);
    }
    let d = lang === 'fr' ? await s(`${query} lang:fr`) : null;
    if (!d?.data?.length) d = await s(query);
    if (!d?.data?.length) {
      const f = await getJSON(`${SCRY}/cards/named?fuzzy=${encodeURIComponent(query)}`).catch(() => null);
      if (f) d = await s(`!"${f.name}"`);
    }
    return rank((d?.data || []).map(c => mtgNorm(c, lang)), { query, number }).slice(0, 80);
  },

  async getDetails(apiId) {
    const c = await getJSON(`${SCRY}/cards/${encodeURIComponent(apiId)}`);
    if (!c) throw new Error('not found');
    let prices = c.prices || null;
    const empty = p => !p || !['eur', 'eur_foil', 'usd', 'usd_foil'].some(k => p[k]);
    // Les impressions non anglaises n'ont souvent pas de prix : on prend ceux de la version anglaise
    if (empty(prices) && c.lang !== 'en') {
      const en = await getJSON(`${SCRY}/cards/${c.set}/${encodeURIComponent(c.collector_number)}`).catch(() => null);
      if (en && !empty(en.prices)) prices = en.prices;
    }
    return {
      ...mtgNorm(c), rarity: c.rarity, artist: c.artist,
      image: scryImg(c, 'large') || scryImg(c, 'normal'), thumb: scryImg(c, 'normal'),
      pricingRaw: prices,
    };
  },

  market(raw, variant) {
    const foil = variant === 'holo' || variant === 'reverse';
    return {
      eur: foil ? (num(raw?.eur_foil) ?? num(raw?.eur)) : (num(raw?.eur) ?? num(raw?.eur_foil)),
      usd: foil ? (num(raw?.usd_foil) ?? num(raw?.usd_etched) ?? num(raw?.usd)) : (num(raw?.usd) ?? num(raw?.usd_foil)),
      low: null, avg1: null, avg7: null, avg30: null,
      src: { eur: 'Cardmarket', usd: 'TCGplayer' },
    };
  },
};

// =============== YU-GI-OH (YGOPRODeck) ===============
const SETCODE = /^[A-Z0-9]{2,5}-[A-Z]{0,2}\d{2,3}$/;
const ygoImg = (id, small) => `https://images.ygoprodeck.com/images/${small ? 'cards_small' : 'cards'}/${id}.jpg`;

const yugioh = {
  async search(query, { lang = 'fr', number, setId } = {}) {
    const L = lang === 'fr' ? '&language=fr' : '';
    const out = [];
    if (setId) {
      const d = await getJSON(`${YGO}/cardinfo.php?cardset=${encodeURIComponent(setId)}${query ? `&fname=${encodeURIComponent(query)}` : ''}${L}`).catch(() => null);
      (d?.data || []).forEach(c => {
        const s0 = (c.card_sets || []).find(x => x.set_name === setId) || c.card_sets?.[0];
        out.push({
          game: 'yugioh', apiId: String(c.id), lang, name: c.name, number: s0?.set_code || '', set: s0?.set_name,
          rarity: s0?.set_rarity, thumb: c.card_images?.[0]?.image_url_small || ygoImg(c.id, true), extra: { setCode: s0?.set_code },
        });
      });
      return rank(out, { query, number }).slice(0, 300);
    }
    const code = String(number || '').toUpperCase().replace(/\s/g, '');
    if (SETCODE.test(code)) {
      const s = await getJSON(`${YGO}/cardsetsinfo.php?setcode=${encodeURIComponent(code)}`).catch(() => null);
      if (s?.id) out.push({
        game: 'yugioh', apiId: String(s.id), lang, name: s.name, number: s.set_code, set: s.set_name,
        rarity: s.set_rarity, thumb: ygoImg(s.id, true), extra: { setCode: s.set_code },
      });
    }
    if (query) {
      const d = await getJSON(`${YGO}/cardinfo.php?fname=${encodeURIComponent(query)}&num=60&offset=0${L}`).catch(() => null);
      (d?.data || []).forEach(c => {
        if (out.some(o => o.apiId === String(c.id))) return;
        const s0 = c.card_sets?.[0];
        out.push({
          game: 'yugioh', apiId: String(c.id), lang, name: c.name, number: s0?.set_code || '',
          set: s0?.set_name || c.type, thumb: c.card_images?.[0]?.image_url_small || ygoImg(c.id, true),
          extra: { setCode: s0?.set_code },
        });
      });
    }
    return rank(out, { query, number }).slice(0, 80);
  },

  async getDetails(apiId, lang = 'fr', extra = {}) {
    const L = lang === 'fr' ? '&language=fr' : '';
    let d = await getJSON(`${YGO}/cardinfo.php?id=${encodeURIComponent(apiId)}${L}`).catch(() => null);
    if (!d?.data?.length && L) d = await getJSON(`${YGO}/cardinfo.php?id=${encodeURIComponent(apiId)}`);
    const c = d?.data?.[0];
    if (!c) throw new Error('not found');
    const sets = c.card_sets || [];
    const s = sets.find(x => x.set_code === extra?.setCode) || sets[0];
    return {
      game: 'yugioh', apiId: String(c.id), lang, name: c.name,
      number: s?.set_code || '', set: s?.set_name || c.type, setId: s?.set_code?.split('-')[0] || null,
      rarity: s?.set_rarity || null, artist: null,
      image: c.card_images?.[0]?.image_url || ygoImg(c.id), thumb: c.card_images?.[0]?.image_url_small || ygoImg(c.id, true),
      printings: sets.map(x => ({ code: x.set_code, set: x.set_name, rarity: x.set_rarity, price: x.set_price })),
      pricingRaw: { ...(c.card_prices?.[0] || {}), set_price: s?.set_price },
    };
  },

  market(raw) {
    return {
      eur: num(raw?.cardmarket_price),
      usd: num(raw?.set_price) ?? num(raw?.tcgplayer_price),
      low: null, avg1: null, avg7: null, avg30: null,
      ebay: num(raw?.ebay_price),
      src: { eur: 'Cardmarket', usd: 'TCGplayer' },
    };
  },
};

export const providers = { pokemon, mtg, yugioh };

// Taux USD→EUR utilisé pour le contrôle de cohérence (mis à jour par l'appli)
let usdToEur = 0.91;
export const setRate = r => { if (r > 0) usdToEur = r; };

// Contrôle de cohérence des prix.
// Problème constaté : pour les séries récentes, TCGdex rattache souvent les versions rares
// (illustration rare, illustration spéciale, hyper rare…) au produit Cardmarket de la version
// standard. Ex. Méga-Rayquaza-ex 138/141 (Règne Delta) : Cardmarket 2,93 € (prix de la n° 084)
// alors que TCGplayer donne ~280 $. Quand le prix Cardmarket est très inférieur au prix TCGplayer
// de la même carte, il est considéré comme faux : on l'écarte et la valeur se base sur TCGplayer.
export function market(card) {
  const m = providers[card.game]?.market(card.pricingRaw, card.variant) || {};
  if (card.game !== 'pokemon' || m.eur == null) return m;
  const drop = () => ({ ...m, cmSuspect: { trend: m.eur, low: m.low }, eur: null, low: null, avg1: null, avg7: null, avg30: null });
  // 1) certitude : une autre version de la même carte (même série) a le même produit Cardmarket
  if (card.cmShared) return drop();
  if (m.usd != null) {
    // 2) écart énorme avec TCGplayer (un simple écart Europe/USA reste en dessous de ×6)
    const tpEur = m.usd * usdToEur;
    if (tpEur >= 1.5 && m.eur * 6 < tpEur) return drop();
  } else if (m.eur < 1 && /illus|sp[ée]cial|hyper|secr|gold|magnifique|m[ée]ga hyper|ace spec|chromatique/i.test(card.rarity || '')) {
    // carte très rare à quelques centimes et aucun autre prix pour vérifier : prix jugé non fiable
    return drop();
  }
  return m;
}

export async function fetchRate() {
  const d = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR').catch(() => null)
    || await getJSON('https://open.er-api.com/v6/latest/USD').catch(() => null);
  return num(d?.rates?.EUR);
}

// =============== LISTES DE SÉRIES (menu déroulant) ===============
// Renvoie [{ id, name, total, group }] du plus récent au plus ancien
const setListCache = {};
export function listSets(game, lang = 'fr') {
  const key = `${game}|${lang}`;
  if (setListCache[key]) return setListCache[key];
  const MTG_TYPES = new Set(['core', 'expansion', 'masters', 'draft_innovation', 'commander', 'starter', 'funny', 'box']);
  const year = d => (d || '').slice(0, 4) || '—';
  const p = (async () => {
    if (game === 'pokemon') {
      const [sets, series] = await Promise.all([getJSON(`${TCGDEX}/${lang}/sets`), getJSON(`${TCGDEX}/${lang}/series`).catch(() => [])]);
      const serieName = Object.fromEntries((series || []).map(s => [s.id, s.name]));
      const serieOrder = Object.fromEntries((series || []).map((s, i) => [s.id, i]));
      const serieOf = s => { const parts = (s.logo || s.symbol || '').split('/'); return parts.length > 3 ? parts[parts.length - 3] : 'misc'; };
      return (sets || []).map((s, i) => ({ id: s.id, name: s.name, total: s.cardCount?.official, serie: serieOf(s), i, logo: s.logo ? `${s.logo}.webp` : null }))
        .filter(s => s.serie !== 'tcgp') // Pokémon TCG Pocket : jeu mobile, pas de cartes physiques
        .sort((a, b) => ((serieOrder[b.serie] ?? -1) - (serieOrder[a.serie] ?? -1)) || (b.i - a.i))
        .map(s => ({ id: s.id, name: s.name, total: s.total, logo: s.logo, group: serieName[s.serie] || s.serie }));
    }
    if (game === 'mtg') {
      const d = await getJSON(`${SCRY}/sets`);
      return (d?.data || []).filter(s => !s.digital && MTG_TYPES.has(s.set_type) && s.card_count > 0)
        .sort((a, b) => (b.released_at || '').localeCompare(a.released_at || ''))
        .map(s => ({ id: s.code, name: s.name, total: s.card_count, logo: s.icon_svg_uri, group: year(s.released_at) }));
    }
    const d = await getJSON(`${YGO}/cardsets.php`);
    return (d || []).sort((a, b) => (b.tcg_date || '').localeCompare(a.tcg_date || ''))
      .map(s => ({ id: s.set_name, name: `${s.set_name} (${s.set_code})`, total: s.num_of_cards, logo: s.set_image, group: year(s.tcg_date) }));
  })().catch(e => { delete setListCache[key]; throw e; });
  setListCache[key] = p;
  return p;
}

// =============== CONTENU COMPLET D'UNE SÉRIE (vue « classeur ») ===============
// Renvoie toutes les cartes d'une série, triées par numéro
const binderCache = {};
const byNumber = (a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
export function setCards(game, lang, { setId, set }) {
  const key = `${game}|${lang}|${setId || set}`;
  if (binderCache[key]) return binderCache[key];
  const p = (async () => {
    if (game === 'pokemon') {
      const s = await pokemonSetCards(lang, setId);
      return (s?.cards || []).map(c => ({
        game, apiId: c.id, lang, name: c.name, number: c.localId, set: s.name, setId: s.id,
        setTotal: s.cardCount?.official, thumb: tcgdexImg(c.image, 'low'),
      })).sort(byNumber);
    }
    if (game === 'mtg') {
      const out = [];
      let url = `${SCRY}/cards/search?unique=prints&order=set&q=${encodeURIComponent(`e:${setId}`)}`;
      while (url && out.length < 1200) {
        const d = await getJSON(url);
        if (!d) break;
        out.push(...d.data);
        url = d.has_more ? d.next_page : null;
      }
      return out.map(c => mtgNorm(c, 'en')).sort(byNumber);
    }
    const d = await getJSON(`${YGO}/cardinfo.php?cardset=${encodeURIComponent(set)}`);
    return (d?.data || []).flatMap(c => (c.card_sets || []).filter(x => x.set_name === set).map(s0 => ({
      game, apiId: String(c.id), lang, name: c.name, number: s0.set_code, set, rarity: s0.set_rarity,
      thumb: c.card_images?.[0]?.image_url_small || ygoImg(c.id, true), extra: { setCode: s0.set_code },
    }))).sort(byNumber);
  })().catch(e => { delete binderCache[key]; throw e; });
  binderCache[key] = p;
  return p;
}

// =============== DICTIONNAIRE DE NOMS (correction des mots lus) ===============
const dictCache = {};
async function nameDictionary(game, lang) {
  if (game === 'yugioh') return null;
  const key = `dict_${game}_${game === 'mtg' ? 'en' : lang}`;
  if (!dictCache[key]) {
    dictCache[key] = (async () => {
      const stored = await db.getMeta(key).catch(() => null);
      if (stored?.names?.length && Date.now() - stored.t < 14 * 864e5) return stored.names;
      let names;
      if (game === 'pokemon') {
        const all = await getJSON(`${TCGDEX}/${lang}/cards`);
        names = [...new Set((all || []).map(c => c.name).filter(Boolean))];
      } else {
        names = (await getJSON(`${SCRY}/catalog/card-names`))?.data || [];
      }
      if (names.length) db.setMeta(key, { t: Date.now(), names }).catch(() => {});
      return names.length ? names : stored?.names || [];
    })().catch(e => { delete dictCache[key]; throw e; });
  }
  return dictCache[key];
}
const indexCache = new WeakMap();
function dictIndex(names) {
  if (!indexCache.has(names)) {
    indexCache.set(names, names.map(name => {
      const full = fold(name);
      const firstRaw = name.split(/[\s]/)[0].replace(/[-–](ex|gx|v|vmax|vstar)$/i, '');
      return { name, full, firstRaw, first: fold(firstRaw) };
    }));
  }
  return indexCache.get(names);
}

// Précharge le dictionnaire (appelé à l'ouverture du scanner)
export function warmDictionary(game, lang) { nameDictionary(game, lang).catch(() => {}); }

// Rapproche des mots mal lus d'un vrai nom de carte : « Oracauteu » → « Dracaufeu »
// Renvoie [{ query, name, sim, word }] trié du plus sûr au moins sûr
export async function correctNames(game, lang, words, setId) {
  let names = null;
  try {
    if (setId && game === 'pokemon') names = [...new Set(((await pokemonSetCards(lang, setId))?.cards || []).map(c => c.name))];
    else names = await nameDictionary(game, lang);
  } catch { return []; }
  if (!names?.length) return [];
  const idx = dictIndex(names);
  const out = [];
  for (const w of words) {
    const fw = fold(w).replace(/[^a-z0-9' -]/g, '');
    if (fw.length < 3) continue;
    let best = null, bs = 0, onFirst = false;
    for (const e of idx) {
      const df = Math.abs(e.first.length - fw.length), dF = Math.abs(e.full.length - fw.length);
      if (df > 3 && dF > 3) continue;
      const s1 = df <= 3 ? levSim(fw, e.first) : 0;
      const s2 = dF <= 3 ? levSim(fw, e.full) : 0;
      const s = Math.max(s1, s2);
      if (s > bs || (s === bs && best && e.full.length < best.full.length)) { bs = s; best = e; onFirst = s1 >= s2; }
    }
    // seuil selon la longueur : un mot court doit être presque exact
    const need = setId ? 0.5 : fw.length >= 7 ? 0.68 : fw.length >= 5 ? 0.74 : 0.9;
    if (best && bs >= need) out.push({ word: w, name: best.name, query: onFirst ? best.firstRaw : best.name, sim: bs });
  }
  out.sort((a, b) => b.sim - a.sim || b.query.length - a.query.length);
  const seen = new Set();
  return out.filter(o => !seen.has(fold(o.query)) && seen.add(fold(o.query)));
}

export function marketLinks(card) {
  const name = encodeURIComponent(card.name);
  const full = encodeURIComponent(`${card.name} ${card.number || ''}`.trim());
  const cmGame = { pokemon: 'Pokemon', mtg: 'Magic', yugioh: 'YuGiOh' }[card.game];
  const lang = card.lang === 'fr' ? 'fr' : 'en';
  return [
    { label: 'Cardmarket', url: `https://www.cardmarket.com/${lang}/${cmGame}/Products/Search?searchString=${name}` },
    { label: 'TCGplayer', url: `https://www.tcgplayer.com/search/all/product?q=${name}` },
    { label: 'eBay', url: `https://www.ebay.fr/sch/i.html?_nkw=${full}&LH_Sold=1&LH_Complete=1` },
  ];
}
