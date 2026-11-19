// Petits graphiques SVG sans dépendance
let gid = 0;

export function lineChart(points, { w = 340, h = 150, color = '#8b5cf6', fmt = v => v, labels } = {}) {
  if (!points || points.length < 2) return '';
  const vals = points.map(p => p.v);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1e-9) { min = min * 0.9; max = max * 1.1 || 1; }
  const padX = 14, top = 22, bottom = labels ? 22 : 8;
  const x = i => padX + (i / (points.length - 1)) * (w - padX * 2);
  const y = v => top + (1 - (v - min) / (max - min)) * (h - top - bottom);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const id = `lg${++gid}`;
  const base = h - bottom;
  const last = points.length - 1;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".42"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${d}L${x(last)},${base}L${x(0)},${base}Z" fill="url(#${id})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="${i === last ? 4.5 : 2.5}" fill="${i === last ? color : 'var(--bg)'}" stroke="${color}" stroke-width="2"/>`).join('')}
    <text x="${Math.min(x(last), w - 4)}" y="${Math.max(12, y(points[last].v) - 9)}" text-anchor="end" class="chart-val">${fmt(points[last].v)}</text>
    ${labels ? labels.map((l, i) => `<text x="${x(i)}" y="${h - 5}" text-anchor="${i === 0 ? 'start' : i === last ? 'end' : 'middle'}" class="chart-lbl">${l}</text>`).join('') : ''}
  </svg>`;
}

export function sparkline(values, { w = 90, h = 28, color = '#8b5cf6' } = {}) {
  if (!values || values.length < 2) return '';
  let min = Math.min(...values), max = Math.max(...values);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const x = i => (i / (values.length - 1)) * w;
  const y = v => 2 + (1 - (v - min) / (max - min)) * (h - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="spark"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function donut(segments, { size = 150, thickness = 20, center = '' } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2, c = 2 * Math.PI * r;
  let acc = 0;
  const arcs = segments.map(s => {
    const len = (s.value / total) * c;
    const gap = segments.length > 1 ? Math.min(3, len / 2) : 0;
    const el = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${s.color}" stroke-width="${thickness}"
      stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-acc}" stroke-linecap="butt"/>`;
    acc += len;
    return el;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="donut">
    <g transform="rotate(-90 ${size / 2} ${size / 2})">
      <circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(--line)" stroke-width="${thickness}"/>${arcs}
    </g>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" class="donut-center">${center}</text>
  </svg>`;
}

export function bars(items, { fmt = v => v, color = 'var(--accent2)' } = {}) {
  const max = Math.max(...items.map(i => i.value), 1e-9);
  return `<div class="bars">${items.map(i => `
    <div class="bar-row">
      <div class="bar-label" title="${i.label}">${i.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (i.value / max) * 100)}%;background:${i.color || color}"></div></div>
      <div class="bar-val">${fmt(i.value)}</div>
    </div>`).join('')}</div>`;
}
