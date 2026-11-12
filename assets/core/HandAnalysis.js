/**
 * 川麻向听 / 和牌 / 有效进牌
 *
 * 和日麻那套的唯一实质区别是「定缺」：
 *   缺门那张花色的牌必须先打完，打完之前不能胡。
 *   所以算向听时把缺门牌整体摘掉，再按剩下的牌算标准向听，
 *   最后把缺门张数加回去 —— 每打一张缺门牌要消耗一轮摸打。
 *
 * 这个近似是偏保守的（真实值可能比它小），但方向正确：
 * 缺门牌越多，越优先打缺，和川麻的实际打法一致。
 */
import { TILE_LABELS, SUIT_OFFSET, TILE_TYPES } from './constants.js';

export const TILE_CODES = Object.keys(TILE_LABELS);
const INDEX = new Map(TILE_CODES.map((code, index) => [code, index]));
const PER_SUIT = 9;

export function tileCounts(tiles) {
  const counts = Array(TILE_TYPES).fill(0);
  for (const tile of tiles) {
    const code = typeof tile === 'string' ? tile : tile?.code;
    const index = INDEX.get(code);
    if (index === undefined) throw new Error(`存在无效牌码：${code}`);
    counts[index] += 1;
    if (counts[index] > 4) throw new Error(`${code} 超过四张`);
  }
  return counts;
}

export function codeToIndex(code) { return INDEX.get(code); }
export function indexToCode(index) { return TILE_CODES[index]; }

function missingRange(missingSuit) {
  const off = SUIT_OFFSET[missingSuit];
  return off === undefined ? null : [off, off + PER_SUIT];
}

export function countMissing(tiles, missingSuit) {
  const range = missingRange(missingSuit);
  if (!range) return 0;
  const counts = tileCounts(tiles);
  let sum = 0;
  for (let i = range[0]; i < range[1]; i += 1) sum += counts[i];
  return sum;
}

// ---------------- 和牌 ----------------
export function standardWin(tiles, exposedMelds = 0, missingSuit = null) {
  if (countMissing(tiles, missingSuit) > 0) return false;
  const counts = tileCounts(tiles);
  if (tiles.length !== 14 - 3 * exposedMelds) return false;
  const meldsNeeded = 4 - exposedMelds;
  for (let index = 0; index < TILE_TYPES; index += 1) {
    if (counts[index] < 2) continue;
    counts[index] -= 2;
    if (completeMelds(counts, meldsNeeded)) return true;
    counts[index] += 2;
  }
  return false;
}

function completeMelds(counts, needed) {
  const index = counts.findIndex(Boolean);
  if (index === -1) return needed === 0;
  if (needed === 0) return false;
  if (counts[index] >= 3) {
    counts[index] -= 3;
    if (completeMelds(counts, needed - 1)) return true;
    counts[index] += 3;
  }
  if (index < TILE_TYPES && index % PER_SUIT < 7 && counts[index + 1] && counts[index + 2]) {
    counts[index] -= 1; counts[index + 1] -= 1; counts[index + 2] -= 1;
    if (completeMelds(counts, needed - 1)) return true;
    counts[index] += 1; counts[index + 1] += 1; counts[index + 2] += 1;
  }
  return false;
}

/** 七对：返回 4 张的组数（龙七对判定用），不是七对返回 null */
export function sevenPairs(tiles, exposedMelds = 0, missingSuit = null) {
  if (exposedMelds || tiles.length !== 14) return null;
  if (countMissing(tiles, missingSuit) > 0) return null;
  const counts = tileCounts(tiles);
  if (counts.reduce((sum, count) => sum + Math.floor(count / 2), 0) !== 7) return null;
  return counts.filter((count) => count === 4).length;
}

// ---------------- 向听 ----------------
const shantenCache = new Map();

export function shanten(tiles, exposedMelds = 0, missingSuit = null) {
  const counts = tileCounts(tiles);
  const range = missingRange(missingSuit);
  let missingCount = 0;
  if (range) {
    for (let i = range[0]; i < range[1]; i += 1) {
      missingCount += counts[i];
      counts[i] = 0;
    }
  }

  const key = `${exposedMelds}|${missingSuit || '-'}|${counts.join('')}`;
  if (shantenCache.has(key)) return shantenCache.get(key);

  let best = 8;
  const search = (index, melds, pairs, taatsu) => {
    while (index < TILE_TYPES && counts[index] === 0) index += 1;
    if (index === TILE_TYPES) {
      const totalMelds = exposedMelds + melds;
      const usableTaatsu = Math.min(taatsu, 4 - totalMelds);
      best = Math.min(best, 8 - totalMelds * 2 - usableTaatsu - Math.min(pairs, 1));
      return;
    }
    if (exposedMelds + melds > 4) return;
    if (counts[index] >= 3) { counts[index] -= 3; search(index, melds + 1, pairs, taatsu); counts[index] += 3; }
    if (index % PER_SUIT < 7 && counts[index + 1] && counts[index + 2]) {
      counts[index]--; counts[index + 1]--; counts[index + 2]--;
      search(index, melds + 1, pairs, taatsu);
      counts[index]++; counts[index + 1]++; counts[index + 2]++;
    }
    if (counts[index] >= 2) { counts[index] -= 2; search(index, melds, pairs + 1, taatsu); search(index, melds, pairs, taatsu + 1); counts[index] += 2; }
    if (index % PER_SUIT < 8 && counts[index + 1]) {
      counts[index]--; counts[index + 1]--;
      search(index, melds, pairs, taatsu + 1);
      counts[index]++; counts[index + 1]++;
    }
    if (index % PER_SUIT < 7 && counts[index + 2]) {
      counts[index]--; counts[index + 2]--;
      search(index, melds, pairs, taatsu + 1);
      counts[index]++; counts[index + 2]++;
    }
    counts[index]--; search(index, melds, pairs, taatsu); counts[index]++;
  };
  search(0, 0, 0, 0);

  // 七对（川麻只在没副露时可能）
  if (!exposedMelds && tiles.length - missingCount >= 13) {
    const uniquePairs = counts.filter((count) => count >= 2).length;
    const filled = counts.filter(Boolean).length;
    const quads = counts.filter((count) => count === 4).length;
    best = Math.min(best, 6 - uniquePairs + Math.max(0, 7 - uniquePairs - (TILE_TYPES - filled)) - quads);
  }

  const total = Math.min(8, Math.max(-1, best + missingCount));
  shantenCache.set(key, total);
  return total;
}

/**
 * 有效进牌：摸到哪些牌能让向听下降。
 * 缺门牌永远不算 —— 手上还有缺门牌时，摸到缺门只会更糟。
 */
export function effectiveDraws(handAfterDiscard, visibleTiles = [], exposedMelds = 0, missingSuit = null) {
  const base = shanten(handAfterDiscard, exposedMelds, missingSuit);
  const known = tileCounts([...handAfterDiscard, ...visibleTiles]);
  const range = missingRange(missingSuit);
  const usefulTiles = [];
  let remainingCount = 0;
  TILE_CODES.forEach((tile, index) => {
    if (range && index >= range[0] && index < range[1]) return;
    const left = 4 - known[index];
    if (left <= 0) return;
    if (shanten([...handAfterDiscard, tile], exposedMelds, missingSuit) < base) {
      usefulTiles.push(tile);
      remainingCount += left;
    }
  });
  return { shanten: base, usefulTiles, remainingCount };
}

export function clearShantenCache() { shantenCache.clear(); }
