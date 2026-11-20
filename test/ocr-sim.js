// Banc d'essai : simule une photo de téléphone (carte un peu décalée, inclinée, floue, reflet)
// Utilisation (console, sur localhost) : const t = await import('/test/ocr-sim.js?v='+Date.now()); await t.run();
export const CARDS = [
  ['https://assets.tcgdex.net/fr/base/base2/51/high.png', 'pokemon', 'Évoli', '51'],
  ['https://assets.tcgdex.net/fr/swsh/swsh3/20/high.png', 'pokemon', 'Dracaufeu VMAX', '020'],
  ['https://assets.tcgdex.net/fr/sv/sv03.5/006/high.png', 'pokemon', 'Dracaufeu-ex', '006'],
  ['https://assets.tcgdex.net/fr/sv/sv01/063/high.png', 'pokemon', '?', '063'],
  ['https://assets.tcgdex.net/fr/swsh/swsh12/046/high.png', 'pokemon', '?', '046'],
];

async function load(url) {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = url; await img.decode(); return img;
}

// Construit une "image vidéo" 1080x1920 et renvoie le recadrage du cadre-guide
export function simulate(img, { fill = 0.9, dx = 0.03, dy = -0.02, rot = 3, blur = 1.2, glare = true } = {}) {
  const W = 1080, H = 1920;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#6b5a48'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`; g.fillRect(Math.random() * W, Math.random() * H, 3, 3); }
  const gw = W * 0.61, gh = gw * 88 / 63, gx = (W - gw) / 2, gy = (H - gh) / 2 - 90;
  const cw = gw * fill, ch = gh * fill;
  g.save();
  g.translate(gx + gw / 2 + dx * gw, gy + gh / 2 + dy * gh);
  g.rotate(rot * Math.PI / 180);
  g.filter = `blur(${blur}px)`;
  g.drawImage(img, -cw / 2, -ch / 2, cw, ch);
  g.restore();
  if (glare) {
    const gr = g.createRadialGradient(gx + gw * 0.7, gy + gh * 0.3, 10, gx + gw * 0.7, gy + gh * 0.3, gw * 0.5);
    gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  const out = document.createElement('canvas'); out.width = Math.round(gw); out.height = Math.round(gh);
  out.getContext('2d').drawImage(c, gx, gy, gw, gh, 0, 0, out.width, out.height);
  return out;
}

export async function run(opts = {}) {
  const sc = await import('/js/scanner.js?v=' + Date.now());
  const api = await import('/js/api.js?v=' + Date.now());
  const res = [];
  for (const [url, game, expName, expNum] of CARDS) {
    const crop = simulate(await load(url), opts);
    const t0 = performance.now();
    const r = await sc.recognizeCard(crop, game);
    const list = await api.providers.pokemon.search(r.name, { lang: 'fr', number: r.number, total: r.total, candidates: r.candidates });
    res.push({ exp: `${expName} ${expNum}`, read: `${r.name} | ${r.number || ''}/${r.total || ''}`, cands: (r.candidates || []).join(','), top: list[0] ? `${list[0].name} ${list[0].number} (${list[0].set})` : '—', ms: Math.round(performance.now() - t0) });
  }
  return res;
}
