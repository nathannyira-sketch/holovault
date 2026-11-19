// Caméra + lecture du texte de la carte (OCR Tesseract.js, exécuté sur le téléphone)
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let stream = null;
let workerPromise = null;

export async function startCamera(video) {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
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

// Découpe la zone du cadre-guide dans l'image vidéo (vidéo affichée en object-fit: cover)
export function captureCard(video, guide) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error('camera not ready');
  const vr = video.getBoundingClientRect(), gr = guide.getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const ox = (vr.width - vw * scale) / 2, oy = (vr.height - vh * scale) / 2;
  let sx = (gr.left - vr.left - ox) / scale, sy = (gr.top - vr.top - oy) / scale;
  let sw = gr.width / scale, sh = gr.height / scale;
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
  const k = Math.min(1, 1600 / sh);
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
      return window.Tesseract.createWorker(['eng', 'fra'], 1, { logger: m => progressCb?.(m) });
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Précharge le moteur de lecture en arrière-plan
export function warmup() { getWorker().catch(() => {}); }

// Zones de lecture (fractions de la carte) : [x, y, largeur, hauteur]
const REGIONS = {
  pokemon: { name: [0.03, 0.02, 0.74, 0.1], num: [0, 0.875, 1, 0.125] },
  mtg: { name: [0.04, 0.03, 0.72, 0.08], num: [0, 0.89, 0.55, 0.11] },
  yugioh: { name: [0.04, 0.025, 0.8, 0.09], num: [0.4, 0.69, 0.6, 0.075] },
};

// Recadre, agrandit, passe en niveaux de gris et étire le contraste
function prep(src, [fx, fy, fw, fh]) {
  const sx = fx * src.width, sy = fy * src.height, sw = fw * src.width, sh = fh * src.height;
  const k = Math.max(1, Math.min(4, 1400 / sw));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let min = 255, max = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = g; if (g < min) min = g; if (g > max) max = g; sum += g;
  }
  const mean = sum / (d.length / 4);
  const invert = mean < 110; // texte clair sur fond sombre
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    let g = ((d[i] - min) / range) * 255;
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const STOP = /\b(PV|HP|PS|BASE|BASIC|BASIQUE|STAGE|NIVEAU|NIV|LV|LEVEL|EVOLUTION|ÉVOLUTION|EVOLVES|FROM|TRAINER|DRESSEUR|ITEM|OBJET|SUPPORTER|STADE|STADIUM|ENERGY|ÉNERGIE|POKEMON|POKÉMON|TOOL|OUTIL)\b/gi;

function cleanName(s) {
  return String(s || '')
    .replace(/[0-9]+/g, ' ')
    .replace(STOP, ' ')
    .replace(/[^A-Za-zÀ-ÿ'’\-. ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.replace(/[^A-Za-zÀ-ÿ]/g, '').length >= 2)
    .slice(0, 4)
    .join(' ');
}

function bestName(data) {
  const lines = (data?.lines || [])
    .map(l => ({ clean: cleanName(l.text), h: l.bbox.y1 - l.bbox.y0, conf: l.confidence }))
    .filter(l => l.clean.replace(/[^A-Za-zÀ-ÿ]/g, '').length >= 3 && l.conf > 20);
  lines.sort((a, b) => (b.h - a.h) || (b.conf - a.conf));
  return lines[0]?.clean || cleanName(data?.text);
}

function parseNumber(text, game) {
  const t = String(text || '').replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
  if (game === 'yugioh') {
    const m = t.toUpperCase().match(/([A-Z0-9]{3,4})\s*-\s*([A-Z]{2})?\s*([0-9O]{3})/);
    return m ? { number: `${m[1]}-${m[2] || ''}${m[3].replace(/O/g, '0')}` } : {};
  }
  const sp = t.match(/([A-Z]{0,2}\d{1,3})\s*[\/|\\]\s*([A-Z]{0,2}\d{2,3})/i);
  if (sp) return { number: sp[1].toUpperCase(), total: sp[2].replace(/\D/g, '') };
  const lone = t.match(/\b(\d{2,4})\b/);
  return lone ? { number: lone[1] } : {};
}

export async function recognizeCard(canvas, game, onProgress) {
  progressCb = onProgress;
  const worker = await getWorker();
  const R = REGIONS[game] || REGIONS.pokemon;
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  const a = await worker.recognize(prep(canvas, R.name));
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  const b = await worker.recognize(prep(canvas, R.num));
  progressCb = null;
  return { name: bestName(a.data), ...parseNumber(b.data.text, game) };
}
