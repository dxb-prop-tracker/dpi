// Build-time SVG charts. No libraries, no client JS: 2px lines, hairline grid,
// surface-ringed end markers, native <title> tooltips; the tables on every page
// remain the accessible data view.
const C = {
  line: '#0e5c63',        // series-1 deep teal
  wash: 'rgba(14,92,99,0.08)',
  bar: '#a9c5c2',         // sequential teal, light step
  grid: '#e7e1d5',
  axis: '#c9c1b1',
  muted: '#6e675c',
  ink: '#57524a',
  surface: '#fffdf9',
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const monthLabel = (m: string) => {
  if (!m.includes('-')) return m; // a plain year
  const [y, mo] = m.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[+mo - 1]} ${y.slice(2)}`;
};
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(s => span / s <= count + 0.5) ?? 10 * mag;
  const start = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/** Price trend: single-series line with area wash, end value label, per-month hover titles. */
export function lineChart(rows: { m: string; psm: number | null; n?: number }[], opts: { title: string; unit?: string } = { title: '' }) {
  const pts = rows.filter(r => r.psm != null);
  if (pts.length < 3) return '';
  const W = 760, H = 210, L = 52, R = 70, T = 12, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const ys = pts.map(p => p.psm!);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.12 || hi * 0.05; lo -= pad; hi += pad; if (lo < 0) lo = 0;
  const X = (i: number) => L + (rows.length === 1 ? 0 : (i / (rows.length - 1)) * iw);
  const Y = (v: number) => T + ih - ((v - lo) / (hi - lo)) * ih;
  const ticks = niceTicks(lo, hi, 4);
  let g = '';
  for (const t of ticks) g += `<line x1="${L}" y1="${Y(t).toFixed(1)}" x2="${L + iw}" y2="${Y(t).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`
    + `<text x="${L - 6}" y="${(Y(t) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.muted}">${fmt(t)}</text>`;
  // x labels: ~6 across
  const every = Math.max(1, Math.round(rows.length / 6));
  let xl = '';
  rows.forEach((r, i) => { if (i % every === 0) xl += `<text x="${X(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${C.muted}">${monthLabel(r.m)}</text>`; });
  // line path over non-null points (use row index positions)
  const coords: [number, number][] = [];
  rows.forEach((r, i) => { if (r.psm != null) coords.push([X(i), Y(r.psm)]); });
  const path = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join('');
  const area = `M${coords[0][0].toFixed(1)},${(T + ih).toFixed(1)}` + coords.map(c => `L${c[0].toFixed(1)},${c[1].toFixed(1)}`).join('') + `L${coords[coords.length - 1][0].toFixed(1)},${(T + ih).toFixed(1)}Z`;
  const [ex, ey] = coords[coords.length - 1];
  const last = pts[pts.length - 1];
  // Data labels: every point when the series is short, otherwise the first, the highest, the lowest and the last.
  let labels = '';
  const idxs: number[] = [];
  const nonNull = rows.map((r, i) => r.psm != null ? i : -1).filter(i => i >= 0);
  // ≤20 points: label every one; ≤40: every other (plus the extremes); beyond that the first, highest and lowest.
  const vals = nonNull.map(i => rows[i].psm!);
  const iMax = nonNull[vals.indexOf(Math.max(...vals))], iMin = nonNull[vals.indexOf(Math.min(...vals))];
  if (nonNull.length <= 20) idxs.push(...nonNull);
  else if (nonNull.length <= 40) { nonNull.forEach((i, k) => { if (k % 2 === 0 || i === iMax || i === iMin) idxs.push(i); }); }
  else idxs.push(nonNull[0], iMax, iMin);
  const fs = nonNull.length > 12 ? 8 : 9.5;
  for (const i of idxs) { if (i === rows.length - 1) continue; const x = X(i), y = Y(rows[i].psm!); const above = i === iMin ? false : true; labels += `<text x="${x.toFixed(1)}" y="${(above ? y - 7 : y + 13).toFixed(1)}" text-anchor="middle" font-size="${fs}" fill="${C.ink}">${fmt(rows[i].psm!)}</text>`; }
  // hover targets
  let hov = '';
  rows.forEach((r, i) => {
    if (r.psm == null) return;
    const x0 = X(Math.max(0, i - 0.5)), x1 = X(Math.min(rows.length - 1, i + 0.5));
    hov += `<rect x="${x0.toFixed(1)}" y="${T}" width="${(x1 - x0).toFixed(1)}" height="${ih}" fill="transparent"><title>${esc(monthLabel(r.m))}: AED ${fmt(r.psm)}${opts.unit ?? '/sqm'}${r.n ? ` · ${fmt(r.n)} sales` : ''}</title></rect>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}" style="width:100%;height:auto;display:block">
<line x1="${L}" y1="${T + ih}" x2="${L + iw}" y2="${T + ih}" stroke="${C.axis}" stroke-width="1"/>${g}${xl}
<path d="${area}" fill="${C.wash}"/><path d="${path}" fill="none" stroke="${C.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="${C.line}" stroke="${C.surface}" stroke-width="2"/>
<text x="${(ex + 8).toFixed(1)}" y="${(ey + 4).toFixed(1)}" font-size="11" font-weight="600" fill="${C.ink}">${fmt(last.psm!)}</text>
${labels}${hov}</svg>`;
}

/** Volume strip: monthly bars, rounded data-end, 2px gaps, hover titles. */
export function barStrip(rows: { m: string; n: number }[], label = 'sales') {
  if (rows.length < 2) return '';
  const W = 760, H = 64, L = 52, R = 70, T = 6, B = 4;
  const iw = W - L - R, ih = H - T - B;
  const hi = Math.max(...rows.map(r => r.n), 1);
  const slot = iw / rows.length;
  const bw = Math.min(24, Math.max(3, slot - 2));
  let bars = '';
  rows.forEach((r, i) => {
    const h = Math.max(1.5, (r.n / hi) * ih);
    const x = L + i * slot + (slot - bw) / 2, y = T + ih - h;
    const rr = Math.min(2.5, bw / 2, h);
    bars += `<path d="M${x.toFixed(1)},${(T + ih).toFixed(1)}V${(y + rr).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + rr).toFixed(1)},${y.toFixed(1)}H${(x + bw - rr).toFixed(1)}Q${(x + bw).toFixed(1)},${y.toFixed(1)} ${(x + bw).toFixed(1)},${(y + rr).toFixed(1)}V${(T + ih).toFixed(1)}Z" fill="${C.bar}"><title>${esc(monthLabel(r.m))}: ${fmt(r.n)} ${esc(label)}</title></path>`;
  });
  const last = rows[rows.length - 1];
  // Data labels above the bars: all of them when there are few, otherwise every nth plus the last.
  const every = rows.length <= 20 ? 1 : rows.length <= 40 ? 2 : Math.ceil(rows.length / 10);
  let labs = '';
  rows.forEach((r, i) => {
    if (i % every !== 0 && i !== rows.length - 1) return;
    const h = Math.max(1.5, (r.n / hi) * ih);
    const x = L + i * slot + slot / 2, y = T + ih - h - 3;
    labs += `<text x="${x.toFixed(1)}" y="${Math.max(9, y).toFixed(1)}" text-anchor="middle" font-size="${rows.length > 12 ? 7.5 : 8.5}" fill="${C.ink}">${fmt(r.n)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H + 8}" role="img" aria-label="Monthly ${esc(label)}" style="width:100%;height:auto;display:block">
<g transform="translate(0,8)"><line x1="${L}" y1="${T + ih}" x2="${L + iw}" y2="${T + ih}" stroke="${C.axis}" stroke-width="1"/>
<text x="${L - 6}" y="${T + 10}" text-anchor="end" font-size="10" fill="${C.muted}">${fmt(hi)}</text>
${bars}${labs}<text x="${L + iw + 6}" y="${T + ih - 2}" font-size="10" fill="${C.muted}">${fmt(last.n)} ${esc(label)}</text></g></svg>`;
}

/** Tiny 12-point trend for table rows: de-emphasized line, accent end dot. */
export function sparkline(values: number[]) {
  const v = values.filter(x => x != null);
  if (v.length < 4) return '';
  const W = 96, H = 26, P = 3;
  const lo = Math.min(...v), hi = Math.max(...v);
  const X = (i: number) => P + (i / (v.length - 1)) * (W - 2 * P - 5);
  const Y = (x: number) => hi === lo ? H / 2 : P + (H - 2 * P) * (1 - (x - lo) / (hi - lo));
  const pts = v.map((x, i) => `${X(i).toFixed(1)},${Y(x).toFixed(1)}`).join(' ');
  const up = v[v.length - 1] >= v[0];
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${C.bar}" stroke-width="1.5" stroke-linejoin="round"/><circle cx="${X(v.length - 1).toFixed(1)}" cy="${Y(v[v.length - 1]).toFixed(1)}" r="2.5" fill="${up ? '#0e7b52' : '#b03426'}" stroke="${C.surface}" stroke-width="1.5"/></svg>`;
}

/** Two-series grouped bars (e.g. previous pull vs this pull, by month). Values labelled on top. */
export function groupedBars(rows: { m: string; a: number; b: number | null }[], labels: [string, string], opts: { title?: string } = {}) {
  if (!rows.length) return '';
  const W = 760, H = 230, L = 52, R = 16, T = 30, B = 24;
  const iw = W - L - R, ih = H - T - B;
  const hi = Math.max(1, ...rows.map(r => Math.max(r.a, r.b ?? 0))) * 1.12;
  const ticks = niceTicks(0, hi, 4);
  const Y = (v: number) => T + ih - (v / hi) * ih;
  const slot = iw / rows.length, bw = Math.min(26, Math.max(4, (slot - 10) / 2));
  let g = '';
  for (const t of ticks) g += `<line x1="${L}" y1="${Y(t).toFixed(1)}" x2="${L + iw}" y2="${Y(t).toFixed(1)}" stroke="${C.grid}"/><text x="${L - 6}" y="${(Y(t) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.muted}">${fmt(t)}</text>`;
  let bars = '';
  rows.forEach((r, i) => {
    const x0 = L + i * slot + (slot - 2 * bw - 3) / 2;
    const draw = (v: number | null, x: number, fill: string, lab: string) => {
      if (v == null) return;
      const h = Math.max(1, (v / hi) * ih), y = T + ih - h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}"><title>${esc(monthLabel(r.m))} · ${esc(lab)}: ${fmt(v)}</title></rect>`;
      if (rows.length <= 14) bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="${rows.length > 9 ? 7.5 : 8.5}" fill="${lab === labels[1] ? C.ink : C.muted}">${fmt(v)}</text>`;
    };
    draw(r.a, x0, C.bar, labels[0]);
    draw(r.b, x0 + bw + 3, C.line, labels[1]);
    bars += `<text x="${(x0 + bw + 1.5).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="10" fill="${C.muted}">${esc(monthLabel(r.m))}</text>`;
  });
  const l2x = L + 14 + Math.round(labels[1].length * 5.6) + 24;
  const legend = `<rect x="${L}" y="6" width="10" height="10" rx="2" fill="${C.line}"/><text x="${L + 14}" y="15" font-size="10.5" fill="${C.ink}">${esc(labels[1])}</text><rect x="${l2x}" y="6" width="10" height="10" rx="2" fill="${C.bar}"/><text x="${l2x + 14}" y="15" font-size="10.5" fill="${C.ink}">${esc(labels[0])}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title ?? '')}" style="width:100%;height:auto;display:block">${g}${legend}<line x1="${L}" y1="${T + ih}" x2="${L + iw}" y2="${T + ih}" stroke="${C.axis}"/>${bars}</svg>`;
}

/** Horizontal ranked bars (areas, projects, revisions). Negative values are drawn to the left in red. */
export function hBars(rows: { label: string; v: number; note?: string }[], opts: { unit?: string; signed?: boolean } = {}) {
  if (!rows.length) return '';
  const W = 760, LW = 250, R = 70, rh = 20, T = 6;
  const H = T + rows.length * rh + 6;
  const iw = W - LW - R;
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.v)));
  const zero = opts.signed ? LW + iw / 2 : LW;
  const scale = opts.signed ? (iw / 2) / maxAbs : iw / maxAbs;
  let out = '';
  rows.forEach((r, i) => {
    const y = T + i * rh, len = Math.abs(r.v) * scale, neg = r.v < 0;
    const x = neg ? zero - len : zero;
    out += `<text x="${LW - 8}" y="${y + 14}" text-anchor="end" font-size="11" fill="${C.ink}">${esc(r.label.length > 38 ? r.label.slice(0, 36) + '…' : r.label)}</text>`
      + `<rect x="${x.toFixed(1)}" y="${y + 3}" width="${Math.max(1, len).toFixed(1)}" height="${rh - 7}" rx="2" fill="${neg ? '#b03426' : C.line}"><title>${esc(r.label)}: ${opts.signed && r.v > 0 ? '+' : ''}${fmt(r.v)}${esc(opts.unit ?? '')}${r.note ? ' · ' + esc(r.note) : ''}</title></rect>`
      + `<text x="${(neg ? x - 5 : x + len + 5).toFixed(1)}" y="${y + 14}" text-anchor="${neg ? 'end' : 'start'}" font-size="10.5" font-weight="600" fill="${C.ink}">${opts.signed && r.v > 0 ? '+' : ''}${fmt(r.v)}${esc(opts.unit ?? '')}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto;display:block">${opts.signed ? `<line x1="${zero}" y1="${T}" x2="${zero}" y2="${H - 4}" stroke="${C.axis}"/>` : ''}${out}</svg>`;
}

/** One stacked composition bar with a legend (status mix, progress mix). */
export function stackedBar(parts: { label: string; n: number }[]) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return '';
  const palette = ['#0e5c63', '#0e7b52', '#a9853e', '#b03426', '#5b7f8a', '#a9c5c2', '#c9c1b1', '#e7e1d5'];
  const W = 760, H = 26, LH = 18;
  let x = 0, bars = '', legend = '';
  const perRow = 5;
  parts.forEach((p, i) => {
    const w = (p.n / total) * W;
    bars += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" fill="${palette[i % palette.length]}"><title>${esc(p.label)}: ${fmt(p.n)} (${(100 * p.n / total).toFixed(0)}%)</title></rect>`;
    if (w > 28) bars += `<text x="${(x + w / 2).toFixed(1)}" y="17" text-anchor="middle" font-size="11" font-weight="600" fill="#fff">${fmt(p.n)}</text>`;
    const lx = (i % perRow) * (W / perRow), ly = H + 10 + Math.floor(i / perRow) * LH;
    legend += `<rect x="${lx}" y="${ly}" width="9" height="9" rx="2" fill="${palette[i % palette.length]}"/><text x="${lx + 13}" y="${ly + 8.5}" font-size="10.5" fill="${C.ink}">${esc(p.label)} ${(100 * p.n / total).toFixed(0)}%</text>`;
    x += w;
  });
  const rowsN = Math.ceil(parts.length / perRow);
  return `<svg viewBox="0 0 ${W} ${H + 12 + rowsN * LH}" role="img" style="width:100%;height:auto;display:block">${bars}${legend}</svg>`;
}

/** Simple labelled columns (a histogram of buckets). */
export function columns(rows: { label: string; n: number }[]) {
  if (!rows.length) return '';
  const W = 360, H = 170, L = 8, R = 8, T = 22, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const hi = Math.max(1, ...rows.map(r => r.n));
  const slot = iw / rows.length, bw = Math.min(40, slot - 8);
  let out = '';
  rows.forEach((r, i) => {
    const h = Math.max(1, (r.n / hi) * ih), x = L + i * slot + (slot - bw) / 2, y = T + ih - h;
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#5b7f8a"><title>${esc(r.label)}: ${fmt(r.n)}</title></rect>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" fill="${C.ink}">${fmt(r.n)}</text>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${C.muted}">${esc(r.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto;display:block"><line x1="${L}" y1="${T + ih}" x2="${L + iw}" y2="${T + ih}" stroke="${C.axis}"/>${out}</svg>`;
}
