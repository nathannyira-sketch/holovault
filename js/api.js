// Sources de données et de prix :
//  - Pokémon : TCGdex (noms FR/EN, prix Cardmarket € et TCGplayer $)
//  - Magic   : Scryfall (prix Cardmarket € et TCGplayer $)
//  - Yu-Gi-Oh: YGOPRODeck (prix Cardmarket € et TCGplayer $)
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
  list.forEach((r, i) => {
    r.numMatch = !!n && normNum(r.number) === n;
    r.score = (r.numMatch ? 10 : 0)
      + (total && r.setTotal && +r.setTotal === +total ? 5 : 0)
      + Math.max(similarity(query, r.name), similarity(query, r.altName)) * 4
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

const pokemon = {
  async search(query, { lang = 'fr', number, total } = {}) {
    const sets = await pokemonSets(lang);
    const fetchQ = q => getJSON(`${TCGDEX}/${lang}/cards?${q}&pagination:itemsPerPage=500`).catch(() => null);
    const fetchName = q => fetchQ(`name=${encodeURIComponent(q)}`);
    const setTotalOf = c => sets[c.id.slice(0, c.id.lastIndexOf('-'))]?.cardCount?.official;
    query = (query || '').trim();
    const first = query.split(' ')[0];
    // 1) nom complet + nom sans sa 1re lettre (gère « Evoli » / « Évoli » et une 1re lettre mal lue)
    // 2) numéro exact dans une série de la bonne taille (utile quand le nom est mal lu)
    const byNumber = async () => {
      if (!number || !total) return [];
      const variants = [...new Set([number, normNum(number), String(normNum(number)).padStart(3, '0')])];
      const res = await Promise.all(variants.map(v => fetchQ(`localId=${encodeURIComponent(v)}`)));
      return res.flat().filter(c => c && +setTotalOf(c) === +total);
    };
    const [a, b, n] = await Promise.all([
      query ? fetchName(query) : null,
      first.length >= 4 ? fetchName(first.slice(1)) : null,
      byNumber(),
    ]);
    let list = [...(n || []), ...(a || []), ...(b || [])];
    // 3) repli : chaque mot (du plus long au plus court) et ses fragments
    if (!(a?.length || b?.length)) {
      const words = query.split(' ').filter(w => w.length >= 4).sort((x, y) => y.length - x.length);
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
    return rank(out, { query, number, total }).slice(0, 80);
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
  async search(query, { lang = 'fr', number } = {}) {
    if (!query) return [];
    const s = q => getJSON(`${SCRY}/cards/search?unique=prints&order=released&q=${encodeURIComponent(q)}`).catch(() => null);
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
  async search(query, { lang = 'fr', number } = {}) {
    const L = lang === 'fr' ? '&language=fr' : '';
    const out = [];
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

export function market(card) {
  return providers[card.game]?.market(card.pricingRaw, card.variant) || {};
}

export async function fetchRate() {
  const d = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR').catch(() => null)
    || await getJSON('https://open.er-api.com/v6/latest/USD').catch(() => null);
  return num(d?.rates?.EUR);
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
