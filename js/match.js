// Comparaison visuelle entre la photo scannée et les images des cartes candidates.
// Sert à trouver la bonne ÉDITION quand plusieurs cartes portent le même nom.
const GW = 16, GH = 22; // grille de comparaison (format carte)

function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// Empreinte couleur normalisée d'une zone d'image (moyenne 0, écart-type 1 par canal)
function signature(img, sx, sy, sw, sh) {
  const c = document.createElement('canvas'); c.width = GW; c.height = GH;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(img, sx, sy, sw, sh, 0, 0, GW, GH);
  const d = x.getImageData(0, 0, GW, GH).data; // lève une erreur si l'image n'autorise pas la lecture (CORS)
  const n = GW * GH, v = new Float32Array(n * 3);
  for (let ch = 0; ch < 3; ch++) {
    let s = 0, s2 = 0;
    for (let p = 0; p < n; p++) { const val = d[p * 4 + ch]; s += val; s2 += val * val; }
    const mean = s / n, sd = Math.sqrt(Math.max(1, s2 / n - mean * mean));
    for (let p = 0; p < n; p++) v[ch * n + p] = (d[p * 4 + ch] - mean) / sd;
  }
  return v;
}

const corr = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s / a.length; };

// Plusieurs recadrages de la photo : la carte n'est jamais parfaitement centrée dans le cadre
function photoSignatures(img) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const out = [];
  for (const k of [0.97, 0.91, 0.85]) for (const ox of [-0.03, 0, 0.03]) for (const oy of [-0.03, 0, 0.03]) {
    const sw = W * k, sh = H * k;
    const sx = (W - sw) / 2 + ox * W, sy = (H - sh) / 2 + oy * H;
    if (sx < 0 || sy < 0 || sx + sw > W || sy + sh > H) continue;
    out.push(signature(img, sx, sy, sw, sh));
  }
  return out;
}

// Renvoie Map(apiId → ressemblance entre -1 et 1) pour les `limit` premiers résultats
export async function visualScores(results, photoSrc, limit = 48) {
  const scores = new Map();
  let photo;
  try { photo = photoSignatures(await loadImg(photoSrc)); } catch { return scores; }
  await Promise.all(results.filter(r => r.thumb).slice(0, limit).map(async r => {
    try {
      const img = await loadImg(r.thumb);
      const sig = signature(img, 0, 0, img.naturalWidth, img.naturalHeight);
      scores.set(r.apiId, Math.max(...photo.map(p => corr(p, sig))));
    } catch { /* image non comparable (CORS / logo) */ }
  }));
  return scores;
}
