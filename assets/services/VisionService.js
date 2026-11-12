// Local, conservative template recognition for the supplied tile style.
// Frames stay in the browser. Uncertain tiles remain null until corrected.
const LABELS = [
  ['west','east','9s','3m','north','1s','red','2s','8m','9p','2p','1s','6p'],
  ['7s','9s','5s','3s','8m','8p','8m','white','2p','3m','2m','6s','6p'],
  ['1m','green','south','north','west','8m','9s','north','3m','4p','red','6p','1m'],
];
const ATLAS_URL = new URL('../vision-tiles-atlas.webp', import.meta.url);

export class VisionService {
  constructor() { this.templates = null; }

  async detectHand(image, { expectedCount = 13, excludeRows = [] } = {}) {
    if (!image) throw new Error('请先拍摄或选择一张手牌照片');
    if (![13, 14].includes(expectedCount)) throw new Error('目前只支持识别 13 或 14 张站立牌');
    const sourceWidth = image.videoWidth || image.naturalWidth || image.width;
    const sourceHeight = image.videoHeight || image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) throw new Error('照片还没有加载完成');
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = Math.round(1280 * sourceHeight / sourceWidth);
    if (canvas.height < 450 || canvas.height > 1800) throw new Error('请使用能看清整排手牌的横向照片');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const geometry = locateRow(data, canvas.width, canvas.height, expectedCount);
    const templates = (await this.loadTemplates()).filter((item) => !excludeRows.includes(item.row));
    const analyze = (centers) => centers.map((center, index) => {
      const face = document.createElement('canvas'); face.width = 68; face.height = 96;
      face.getContext('2d').drawImage(canvas, Math.round(center - geometry.pitch * .41),
        geometry.top, Math.round(geometry.pitch * .82), geometry.bottom - geometry.top, 0, 0, 68, 96);
      const ranked = rank(describe(face), templates);
      const first = ranked[0];
      const margin = (ranked[1]?.distance ?? 1) - first.distance;
      const accepted = first.distance < .22 && margin > .025;
      return { index, tile: accepted ? first.tile : null, candidate: first.tile,
        distance: first.distance, alternatives: ranked.slice(0, 5),
        status: accepted ? 'likely' : 'uncertain', crop: face.toDataURL('image/jpeg', .82) };
    });
    const layouts = [
      { name: 'ink', centers: geometry.inkCenters, observations: analyze(geometry.inkCenters) },
      { name: 'grid', centers: geometry.gridCenters, observations: analyze(geometry.gridCenters) },
    ];
    // Select layout from geometry, not classification scores: a badly cropped
    // neighboring glyph can otherwise look like a confident but wrong tile.
    const drifted = geometry.inkCenters.slice(-5).every((center, index) =>
      center < geometry.gridCenters[expectedCount - 5 + index] - geometry.pitch * .28);
    const selected = layouts.find((layout) => layout.name === (drifted ? 'grid' : 'ink'));
    const observations = selected.observations;
    geometry.centers = selected.centers;
    geometry.layout = selected.name;
    return { tiles: observations.map((item) => item.tile), observations,
      count: observations.length, recognized: observations.filter((item) => item.tile).length,
      source: 'VISION', stable: false, geometry };
  }

  async loadTemplates() {
    if (this.templates) return this.templates;
    const atlas = new Image(); atlas.src = ATLAS_URL.href; await atlas.decode();
    this.templates = LABELS.flatMap((row, y) => row.map((tile, x) => {
      const canvas = document.createElement('canvas'); canvas.width = 68; canvas.height = 96;
      canvas.getContext('2d').drawImage(atlas, x * 68, y * 96, 68, 96, 0, 0, 68, 96);
      return { tile, row: y, feature: describe(canvas) };
    }));
    try {
      const saved = JSON.parse(localStorage.getItem('mahjong-vision-examples') || '[]');
      this.templates.push(...saved.filter((item) => item?.tile && Array.isArray(item.feature) && item.feature.length === 2304)
        .map((item) => ({ tile: item.tile, row: -1, feature: Uint8Array.from(item.feature) })));
    } catch { /* Private browsing or damaged local data: bundled templates still work. */ }
    return this.templates;
  }

  async learnCorrection(crop, tile) {
    if (!crop || !tile) return;
    const image = new Image(); image.src = crop; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 68; canvas.height = 96;
    canvas.getContext('2d').drawImage(image, 0, 0, 68, 96);
    const feature = describe(canvas); if (!feature) return;
    const templates = await this.loadTemplates();
    templates.push({ tile, row: -1, feature });
    try {
      const key = 'mahjong-vision-examples';
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      saved.push({ tile, feature: Array.from(feature) });
      localStorage.setItem(key, JSON.stringify(saved.slice(-60)));
    } catch { /* A correction still applies to this game if storage is unavailable. */ }
  }

  async compareHands(before, after) {
    if (before.some((tile) => !tile) || after.some((tile) => !tile))
      return { added: null, removed: null, stable: false, reason: '有未确认的牌面' };
    const beforeCounts = count(before), afterCounts = count(after);
    return { added: after.find((tile) => afterCounts[tile] > (beforeCounts[tile] || 0)) || null,
      removed: before.find((tile) => beforeCounts[tile] > (afterCounts[tile] || 0)) || null, stable: true };
  }
}

function locateRow(data, width, height, expectedCount) {
  const strips = [];
  for (let y = Math.round(height * .30); y <= Math.round(height * .76) - 10; y += 10) {
    let occupied = 0;
    for (let x0 = 50; x0 < width - 80; x0 += 50) {
      let colored = 0;
      for (let dy = 0; dy < 10; dy += 2) for (let dx = 0; dx < 50; dx += 2) {
        const i = ((y + dy) * width + x0 + dx) * 4;
        if (isColor(data[i], data[i + 1], data[i + 2])) colored++;
      }
      if (colored > 2) occupied++;
    }
    strips.push({ y, occupied });
  }
  const peak = strips.reduce((best, item, index) => item.occupied > strips[best].occupied ? index : best, 0);
  if (strips[peak].occupied < 9) throw new Error('没有定位到整排牌面；请正对手牌、改善光线并让所有牌入镜');
  let first = peak, last = peak;
  while (first > 0 && strips[first - 1].occupied >= 7) first--;
  while (last + 1 < strips.length && strips[last + 1].occupied >= 7) last++;
  const top = strips[first].y, bottom = strips[last].y + 10;
  let left = 0, right = 0, white = null;
  for (let offset = -40; offset <= 5; offset += 5) {
    const bright = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < 10; dy++) {
        const y = Math.max(0, Math.min(height - 1, top + offset + dy));
        const i = (y * width + x) * 4;
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      }
      bright[x] = sum / 10;
    }
    const candidate = smooth(bright, 21);
    let runStart = -1;
    for (let x = 0; x <= width; x++) {
      if (x < width && candidate[x] > 195) { if (runStart < 0) runStart = x; }
      else if (runStart >= 0) {
        if (x - runStart > right - left) { left = runStart; right = x; white = candidate; }
        runStart = -1;
      }
    }
  }
  if (right - left < width * .56) throw new Error('无法找到完整手牌边界；请使整排牌顶部清晰可见');
  const pitch = (right - left) / expectedCount;
  const ink = new Float32Array(width);
  for (let y = top + 15; y < bottom - 10; y += 2) for (let x = left; x < right; x += 2) {
    const i = (y * width + x) * 4;
    if (isInk(data[i], data[i + 1], data[i + 2])) ink[x]++;
  }
  const projection = smooth(ink, 24), inkCenters = [], gridCenters = [];
  for (let n = 0; n < expectedCount; n++) {
    const expected = left + (n + .5) * pitch;
    const lo = Math.max(0, Math.round(expected - pitch * .55), inkCenters.length ? Math.round(inkCenters.at(-1) + pitch * .67) : 0);
    const hi = Math.min(width - 1, Math.round(expected + pitch * .55));
    let chosen = Math.round(expected), best = -1;
    for (let x = lo; x <= hi; x++) {
      const score = projection[x] * Math.max(0, Math.min(1, (white[x] - 160) / 55));
      if (score > best) { best = score; chosen = x; }
    }
    inkCenters.push(chosen);
    gridCenters.push(Math.round(expected));
  }
  return { left, right, top: Math.max(0, top - 12), bottom: Math.min(height, bottom + 16),
    pitch, inkCenters, gridCenters };
}

function describe(face) {
  const source = face.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 68, 96).data;
  let x0 = 68, y0 = 96, x1 = 0, y1 = 0;
  for (let y = 2; y < 93; y++) for (let x = 3; x < 65; x++) {
    const i = (y * 68 + x) * 4;
    if (isInk(source[i], source[i + 1], source[i + 2])) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  if (x1 - x0 < 9 || y1 - y0 < 14) return null;
  const normalized = document.createElement('canvas'); normalized.width = 24; normalized.height = 32;
  normalized.getContext('2d').drawImage(face, Math.max(0, x0 - 2), Math.max(0, y0 - 2),
    Math.min(68 - x0 + 2, x1 - x0 + 5), Math.min(96 - y0 + 2, y1 - y0 + 5), 0, 0, 24, 32);
  const pixels = normalized.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 24, 32).data;
  const feature = new Uint8Array(24 * 32 * 3);
  for (let i = 0; i < 24 * 32; i++) {
    const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
    const strength = Math.max(0, Math.min(245, 245 - (r + g + b) / 3));
    const channel = isColor(r, g, b) ? (r > g ? 0 : 1) : 2;
    feature[i * 3 + channel] = Math.round(strength);
  }
  return feature;
}

function rank(feature, templates) {
  if (!feature) return [{ tile: null, distance: 1 }];
  const distances = new Map();
  for (const sample of templates) {
    const d = Math.min(distance(feature, sample.feature, false), distance(feature, sample.feature, true));
    distances.set(sample.tile, Math.min(distances.get(sample.tile) ?? 1, d));
  }
  return [...distances].map(([tile, distance]) => ({ tile, distance })).sort((a, b) => a.distance - b.distance);
}
function distance(a, b, rotate) {
  let total = 0, weight = 0;
  for (let i = 0; i < 24 * 32; i++) {
    const j = rotate ? 24 * 32 - 1 - i : i;
    const ink = Math.max(a[i * 3], a[i * 3 + 1], a[i * 3 + 2], b[j * 3], b[j * 3 + 1], b[j * 3 + 2]);
    const w = 20 + ink;
    total += w * (Math.abs(a[i * 3] - b[j * 3]) + Math.abs(a[i * 3 + 1] - b[j * 3 + 1]) + Math.abs(a[i * 3 + 2] - b[j * 3 + 2])) / 3;
    weight += w;
  }
  return total / weight / 245;
}
function smooth(values, width) {
  const output = new Float32Array(values.length), radius = Math.floor(width / 2);
  for (let x = 0; x < values.length; x++) {
    let sum = 0;
    for (let d = -radius; d <= radius; d++) if (x + d >= 0 && x + d < values.length) sum += values[x + d];
    output[x] = sum / width;
  }
  return output;
}
function isColor(r, g, b) { return (r > g * 1.25 && r > b * 1.2 && r > 70) || (g > r * 1.2 && g > b * 1.02 && g > 50); }
function isInk(r, g, b) { return isColor(r, g, b) || (r + g + b) / 3 < 155; }
function count(tiles) { return tiles.reduce((map, tile) => ({ ...map, [tile]: (map[tile] || 0) + 1 }), {}); }
