/**
 * 川麻（血战到底）规则
 *
 * 和广东版最根本的差异：
 *   1. 108 张，无字牌，没有十三幺 / 字一色 / 三元四喜这些东西
 *   2. 定缺：手上还有缺门牌时不能胡，必须先打完
 *   3. 血战到底：有人胡牌后不结束，剩下的继续打
 *   4. 一炮多响：一张牌可以同时点几家
 *
 * 番数是「番」，不是「分」。血战到底一般是 1番=底分、每加一番翻倍，
 * 具体底分和封顶由房间定，这里不结算总分。
 */
import { sevenPairs, standardWin, tileCounts, countMissing } from './HandAnalysis.js';
import { SUIT_CN } from './constants.js';

export const RULE_PROFILE = Object.freeze({
  id: 'CM-XZDD-V1',
  name: '四川麻将 · 血战到底',
  players: 4,
  tileCount: 108,
  flowers: false,
  chi: false,
  multiRon: true,
  mustClearMissing: true,
  defaultStrategy: 'BALANCED',
  scores: Object.freeze({
    平胡: 1,
    对对胡: 2,
    清一色: 4,
    七对: 4,
    清对: 8,
    龙七对: 8,
    金钩钓: 4,
    带幺九: 4,
    清幺九: 8,
    杠上花: 1,
    海底捞月: 1,
    抢杠胡: 1,
    天胡: 16,
    地胡: 16,
  }),
  unresolved: ['底分与封顶', '刮风下雨（杠分）', '查大叫 / 查花猪', '呼叫转移与包牌'],
});

const TERMINALS = new Set(['1m', '9m', '1p', '9p', '1s', '9s']);

export class RulesEngine {
  constructor() { this.profile = RULE_PROFILE; this.rule = RULE_PROFILE.id; }

  getName() { return this.profile.name; }
  canCall(action) { return ['PONG', 'KONG', 'PASS', 'WIN'].includes(action); }
  nextRound(round) { return Number(round || 0) + 1; }
  validateTiles(tiles) { tileCounts(tiles); return true; }

  /** 缺门打完了吗 —— 没打完不能胡，也不能听 */
  missingCleared(tiles, missingSuit) {
    return countMissing(tiles, missingSuit) === 0;
  }

  validatePublicState(state) {
    if (state.integrityErrors?.length) throw new Error(state.integrityErrors[0]);
    const all = [...state.myHand.map((item) => item.code), ...state.visibleTiles];
    tileCounts(all);
    if (state.myHand.length > 14) throw new Error('手牌超过 14 张');
    for (const meld of state.melds || []) validateMeld(meld);
    return true;
  }

  /**
   * 判胡。
   * missingSuit 必传 —— 川麻里「有没有打完缺」比「牌型对不对」优先级更高。
   */
  analyzeWin(tiles, { method = 'TSUMO', melds = [], missingSuit = null } = {}) {
    if (!['TSUMO', 'RON'].includes(method)) throw new Error('胡牌方式必须是自摸或荣和');
    if (melds.length > 4) throw new Error('副露组数超限');
    melds.forEach(validateMeld);
    this.validateTiles(tiles);

    const left = countMissing(tiles, missingSuit);
    if (left > 0) {
      return {
        legal: false,
        reason: `手上还有 ${left} 张${SUIT_CN[missingSuit] || ''}没打完，川麻不能胡`,
        patterns: [],
      };
    }

    const exposedMelds = melds.length;
    const normal = standardWin(tiles, exposedMelds, missingSuit);
    const quads = sevenPairs(tiles, exposedMelds, missingSuit);
    if (!normal && quads === null) {
      return { legal: false, reason: '手牌没组成可识别的和牌结构', patterns: [] };
    }

    const all = [...tiles, ...melds.flatMap((meld) => (
      meld.tiles?.length ? meld.tiles : Array(meld.type === 'KONG' ? 4 : 3).fill(meld.tile)))];
    tileCounts(all);

    const patterns = [];
    if (quads !== null) patterns.push(quads >= 1 ? '龙七对' : '七对');

    const suitSet = new Set(all.map((tile) => tile.at(-1)));
    const pure = suitSet.size === 1;
    const triplets = normal && isAllTriplets(tiles, exposedMelds);

    if (normal) {
      if (triplets) patterns.push(pure ? '清对' : '对对胡');
      else if (pure) patterns.push('清一色');
      if (normal && all.every((tile) => TERMINALS.has(tile))) patterns.push('清幺九');
      else if (normal && all.every((tile) => TERMINALS.has(tile) || Number(tile[0]) === 1 || Number(tile[0]) === 9)) patterns.push('带幺九');
      if (exposedMelds >= 1 && isSingleWait(tiles, exposedMelds)) patterns.push('金钩钓');
    }
    if (pure && quads !== null && patterns.length === 1) patterns.push('清七对');

    if (patterns.length === 0) patterns.push('平胡');

    return {
      legal: true,
      patterns: patterns.map((name) => ({ name, fan: this.profile.scores[name] ?? 1 })),
      totalFan: patterns.reduce((sum, name) => sum + (this.profile.scores[name] ?? 1), 0),
      reason: '牌型可识别；底分、封顶与杠分未定义，不结算总分',
      unresolved: this.profile.unresolved,
    };
  }
}

function validateMeld(meld) {
  if (!['PONG', 'KONG'].includes(meld.type)) throw new Error('川麻不能吃，只允许碰和杠');
  if (meld.tiles?.length) {
    const expected = meld.type === 'KONG' ? 4 : 3;
    if (meld.tiles.length !== expected || meld.tiles.some((tile) => tile !== meld.tile)) {
      throw new Error('副露牌型不一致');
    }
  }
}

function isAllTriplets(tiles, exposedMelds) {
  const counts = tileCounts(tiles);
  if (tiles.length !== 14 - 3 * exposedMelds) return false;
  for (let index = 0; index < 27; index += 1) {
    if (counts[index] < 2) continue;
    counts[index] -= 2;
    if (counts.every((count) => count % 3 === 0)) return true;
    counts[index] += 2;
  }
  return false;
}

/** 金钩钓：副露到底，手上只剩单吊那一张 */
function isSingleWait(tiles, exposedMelds) {
  return tiles.length === 2 && exposedMelds === 4;
}
