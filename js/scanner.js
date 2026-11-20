// Caméra + lecture du texte de la carte (OCR Tesseract.js, exécuté sur le téléphone)
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let stream = null;
let workerPromise = null;

export async function startCamera(video) {
  stopCamera();
  const base = { facingMode: { ideal: 'environment' } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
  }
  // Mise au point continue quand le téléphone le permet (gros gain de netteté de près)
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  video.srcObject = stream;
  await video.play().catch(() => {});
  return stream;
}

export function stopCamera() {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
}

export function hasTorch() {
  const track = stream?.getVideoTracks()[0];
  return !!track?.getCapabilities?.().torch;
}

export async function setTorch(on) {
  const track = stream?.getVideoTracks()[0];
  if (!track?.getCapabilities?.().torch) return false;
  await track.applyConstraints({ advanced: [{ torch: on }] });
  return true;
}

// Découpe la zone du cadre-guide (+ une petite marge) dans l'image vidéo (affichée en object-fit: cover)
export function captureCard(video, guide) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error('camera not ready');
  const vr = video.getBoundingClientRect(), gr = guide.getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const ox = (vr.width - vw * scale) / 2, oy = (vr.height - vh * scale) / 2;
  const m = 0.04; // marge : la carte déborde souvent un peu du cadre
  let sx = (gr.left - vr.left - ox) / scale - (gr.width / scale) * m;
  let sy = (gr.top - vr.top - oy) / scale - (gr.height / scale) * m;
  let sw = (gr.width / scale) * (1 + 2 * m), sh = (gr.height / scale) * (1 + 2 * m);
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(sw, vw - sx); sh = Math.min(sh, vh - sy);
  const c = document.createElement('canvas');
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

// Photo importée : recadrage centré au format carte (63x88)
export async function fileToCanvas(file) {
  const bmp = await createImageBitmap(file);
  const ratio = 63 / 88;
  let sw = bmp.width, sh = bmp.height;
  if (sw / sh > ratio) sw = sh * ratio; else sh = sw / ratio;
  const sx = (bmp.width - sw) / 2, sy = (bmp.height - sh) / 2;
  const k = Math.min(1, 2000 / sh);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

export function thumbnail(canvas, width = 360) {
  const k = width / canvas.width;
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.78);
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('script load failed'));
    document.head.appendChild(s);
  });
}

let progressCb = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker(['fra', 'eng'], 1, { logger: m => progressCb?.(m) });
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Précharge le moteur de lecture en arrière-plan
export function warmup() { getWorker().catch(() => {}); }

// Bandes de lecture larges (fractions de l'image) : [x, y, largeur, hauteur]
// Larges exprès : la carte n'est jamais parfaitement alignée sur le cadre.
const REGIONS = {
  pokemon: { name: [0, 0, 1, 0.22], num: [0, 0.8, 1, 0.2] },
  mtg: { name: [0, 0, 1, 0.22], num: [0, 0.8, 1, 0.2] },
  yugioh: { name: [0, 0, 1, 0.2], num: [0.15, 0.6, 0.85, 0.25] },
};

// Recadre et agrandit une bande, puis applique un traitement :
//  'raw'   couleur telle quelle
//  'gray'  niveaux de gris + contraste robuste (percentiles 2 % / 98 %)
//  'adapt' seuillage adaptatif (Bradley) : texte noir sur blanc même sur fond chargé / reflet
function prep(src, [fx, fy, fw, fh], { width = 1400, mode = 'gray' } = {}) {
  const sx = fx * src.width, sy = fy * src.height, sw = fw * src.width, sh = fh * src.height;
  const k = Math.max(0.5, Math.min(4, width / sw));
  const W = Math.round(sw * k), H = Math.round(sh * k);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  if (mode === 'raw') return c;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const n = W * H;
  const gray = new Float64Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const put = (p, v) => { const i = p * 4; d[i] = d[i + 1] = d[i + 2] = v; };
  if (mode === 'adapt') {
    const S = new Float64Array((W + 1) * (H + 1)); // image intégrale
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) { row += gray[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; }
    }
    const r = Math.max(8, Math.round(W / 24)), T = 0.15;
    for (let y = 0; y < H; y++) {
      const y1 = Math.max(0, y - r), y2 = Math.min(H - 1, y + r);
      for (let x = 0; x < W; x++) {
        const x1 = Math.max(0, x - r), x2 = Math.min(W - 1, x + r);
        const cnt = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum = S[(y2 + 1) * (W + 1) + x2 + 1] - S[y1 * (W + 1) + x2 + 1] - S[(y2 + 1) * (W + 1) + x1] + S[y1 * (W + 1) + x1];
        put(y * W + x, gray[y * W + x] * cnt < sum * (1 - T) ? 0 : 255);
      }
    }
  } else {
    const hist = new Uint32Array(256);
    for (let p = 0; p < n; p++) hist[gray[p] | 0]++;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
    const range = Math.max(1, hi - lo);
    for (let p = 0; p < n; p++) put(p, Math.max(0, Math.min(255, ((gray[p] - lo) / range) * 255)));
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const STOP = new Set(('PV HP PS BASE BASIC BASIQUE STAGE NIVEAU NIV LV LEVEL EVOLUTION EVOLUE EVOLVES FROM TRAINER DRESSEUR '
  + 'ITEM OBJET SUPPORTER STADE STADIUM ENERGY ENERGIE POKEMON TOOL OUTIL VMAX VSTAR GX EX TAG TEAM ILLUS ILLUSTRATION '
  + 'ATTAQUE TALENT CAPACITE ABILITY POUVOIR FAIBLESSE RESISTANCE RETRAITE WEAKNESS RESISTANCE RETREAT DE DU DES LA LE LES '
  + 'THE OF AND ET UN UNE CREATURE INSTANT SORCERY RITUEL EPHEMERE ENCHANTMENT ARTIFACT LAND TERRAIN MONSTER MONSTRE SPELL TRAP '
  + 'MAGIE PIEGE EFFECT EFFET CARD CARTE').split(' '));

// Mots lisibles de la bande du haut (filtrés), du plus gros au plus petit
function nameWords(data) {
  const words = (data?.words || []).map(w => {
    let t = String(w.text || '').replace(/[^A-Za-zÀ-ÿ'’\-.]/g, '').replace(/^[-.'’]+|[-.'’]+$/g, '');
    t = t.replace(/[-–](ex|gx|v|vmax|vstar)$/i, '');
    const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
    return { t, letters, h: w.bbox.y1 - w.bbox.y0, conf: w.confidence };
  }).filter(w => w.letters.length >= 3 && w.conf >= 15 && !STOP.has(fold(w.letters))
    // un mot plausible a des voyelles et pas trop de majuscules au milieu
    && /[aeiouyàâäéèêëîïôöùûü]/i.test(w.letters) && !/[a-zà-ÿ][A-Z]{2,}/.test(w.t));
  return words.map(w => ({ t: w.t, key: fold(w.t), score: w.h * (0.5 + w.conf / 200) * (w.letters.length >= 4 ? 1 : 0.6) }));
}

function parseNumber(text, game) {
  const raw = String(text || '');
  if (game === 'yugioh') {
    const m = raw.toUpperCase().replace(/\s+/g, ' ').match(/([A-Z0-9]{3,4})\s?-\s?([A-Z]{2})?\s?([0-9O]{3})/);
    return m ? { number: `${m[1]}-${m[2] || ''}${m[3].replace(/O/g, '0')}` } : {};
  }
  // variantes de lecture : O→0 puis I/l→1
  const variants = [raw.replace(/[Oo]/g, '0'), raw.replace(/[Oo]/g, '0').replace(/[Il]/g, '1')];
  for (const t of variants) {
    const sp = t.match(/((?:TG|GG|SV|RC)?\d{1,3})\s{0,2}[\/\\|]\s{0,2}((?:TG|GG|SV|RC)?\d{2,3})/i);
    if (sp) return { number: sp[1].toUpperCase(), total: sp[2].replace(/\D/g, '') };
  }
  if (game === 'mtg') {
    const lone = variants[0].match(/\b(\d{1,4})\b/);
    if (lone) return { number: lone[1] };
  }
  return {};
}

const small = c => { const k = Math.min(1, 700 / c.width); const o = document.createElement('canvas'); o.width = c.width * k; o.height = c.height * k; o.getContext('2d').drawImage(c, 0, 0, o.width, o.height); return o.toDataURL('image/jpeg', 0.7); };

export { prep as _prep }; // pour le banc d'essai (test/ocr-sim.js)
// Passes retenues après comparatif sur photos simulées (voir test/ocr-sim.js) :
// le nom ressort selon les cartes avec l'une OU l'autre, on combine donc les trois.
const NAME_PASSES = [{ mode: 'adapt', psm: '6' }, { mode: 'adapt', psm: '11' }, { mode: 'raw', psm: '11' }];
const NUM_PASSES = [{ mode: 'gray', psm: '11' }, { mode: 'adapt', psm: '11' }];

// onStep(i, total) : avancement de la lecture
export async function recognizeCard(canvas, game, onProgress, onStep) {
  progressCb = onProgress;
  try {
    const worker = await getWorker();
    const R = REGIONS[game] || REGIONS.pokemon;
    const steps = NAME_PASSES.length + NUM_PASSES.length;
    let step = 0;
    const debug = { size: `${canvas.width}×${canvas.height}`, top: [], bottom: [] };

    // NOM : plusieurs traitements, on garde les mots lus plusieurs fois et/ou en gros
    const pool = new Map();
    for (const { mode, psm } of NAME_PASSES) {
      onStep?.(++step, steps);
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const img = prep(canvas, R.name, { width: 1300, mode });
      const r = await worker.recognize(img);
      debug.top.push({ mode: `${mode}/${psm}`, text: r.data.text, img: small(img) });
      const seenHere = new Set();
      for (const w of nameWords(r.data)) {
        const e = pool.get(w.key) || { t: w.t, n: 0, score: 0 };
        if (!seenHere.has(w.key)) { e.n++; seenHere.add(w.key); }
        e.score = Math.max(e.score, w.score);
        pool.set(w.key, e);
      }
    }
    const candidates = [...pool.values()].sort((a, b) => (b.n - a.n) || (b.score - a.score)).slice(0, 6).map(e => e.t);

    // NUMÉRO : on s'arrête dès qu'un « 051/064 » est lu
    let num = {};
    for (const { mode, psm } of NUM_PASSES) {
      onStep?.(++step, steps);
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const img = prep(canvas, R.num, { width: 2000, mode });
      const r = await worker.recognize(img);
      debug.bottom.push({ mode: `${mode}/${psm}`, text: r.data.text, img: small(img) });
      num = parseNumber(r.data.text, game);
      if (num.number) break;
    }
    return { name: candidates[0] || '', candidates, ...num, debug };
  } finally {
    progressCb = null;
  }
}
