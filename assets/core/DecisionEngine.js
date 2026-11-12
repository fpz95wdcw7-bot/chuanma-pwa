/**
 * 川麻出牌决策
 *
 * 优先级只有一条硬的：
 *   手上还有缺门牌 → 只能从缺门牌里选，别的全不考虑
 * 这是川麻的基本规则，不是策略选择。打完缺之后才谈牌效和防守。
 */
import { PLAYER_LABELS, tileLabel, isMissing, SUIT_CN } from './constants.js';
import { effectiveDraws } from './HandAnalysis.js';
import { RulesEngine } from './RulesEngine.js';

export class DecisionEngine {
  constructor(rules = new RulesEngine()) { this.rules = rules; }

  analyze(gameState) {
    const meldCount = gameState.melds.filter((meld) => meld.actor === 'self').length;
    if (gameState.currentPlayer !== 'self' || gameState.myHand.length !== 14 - 3 * meldCount) return null;
    this.rules.validatePublicState(gameState);

    const missingSuit = gameState.missingSuit || null;
    const hand = gameState.myHand.map((item) => item.code);
    const mode = gameState.strategyMode || this.rules.profile.defaultStrategy;

    // 还有缺门牌 —— 只能打缺，别的牌留着
    const missingInHand = missingSuit ? hand.filter((tile) => isMissing(tile, missingSuit)) : [];
    const pool = missingInHand.length
      ? [...new Set(missingInHand)]
      : [...new Set(hand)];

    const candidates = pool.map((tile) => {
      const after = [...hand];
      after.splice(after.indexOf(tile), 1);
      const effectiveness = effectiveDraws(
        after, [...gameState.visibleTiles, tile], meldCount, missingSuit,
      );
      const opponents = ['right', 'opposite', 'left'].map((actor) => opponentRisk(gameState, actor, tile));
      const expectedRonLoss = opponents.reduce((sum, opponent) => sum + opponent.expectedLoss, 0);
      const ronProbabilityAny = 1 - opponents.reduce((product, opponent) => product * (1 - opponent.ronEstimate), 1);
      const disruption = opponents.reduce((sum, opponent) => sum + Number(opponent.pongPossible) + Number(opponent.exposedKongPossible), 0);
      return { tile, isMissingTile: isMissing(tile, missingSuit), ...effectiveness, opponents, expectedRonLoss, ronProbabilityAny, disruption };
    });

    const compare = (a, b) => {
      if (a.isMissingTile !== b.isMissingTile) return a.isMissingTile ? -1 : 1;
      const loss = a.expectedRonLoss - b.expectedRonLoss;
      const sh = a.shanten - b.shanten;
      const uke = b.remainingCount - a.remainingCount;
      if (mode === 'ATTACK_FIRST') return sh || uke || loss || a.disruption - b.disruption;
      if (mode === 'BALANCED') {
        return (Math.abs(sh) > 1 ? sh : loss * 0.5 + sh * 0.35 - (a.remainingCount - b.remainingCount) * 0.012) || uke;
      }
      return loss || a.ronProbabilityAny - b.ronProbabilityAny || a.disruption - b.disruption || sh || uke;
    };
    candidates.sort(compare);

    const best = candidates[0];
    const index = hand.indexOf(best.tile);
    const count = hand.length;
    const fromLeft = index + 1;
    const fromRight = count - index;
    const physicalPosition = fromRight < fromLeft
      ? { side: 'right', index: fromRight, text: `右边第${toChinese(fromRight)}张` }
      : { side: 'left', index: fromLeft, text: `左边第${toChinese(fromLeft)}张` };

    const missingLeft = missingInHand.length;

    // 14 张摸上来已经成和 —— 先说能胡，再给「不胡的话打哪张」
    const selfMelds = (gameState.melds || []).filter((m) => m.actor === 'self');
    let canWin = false;
    let winPatterns = [];
    try {
      const w = this.rules.analyzeWin(hand, { method: 'TSUMO', melds: selfMelds, missingSuit });
      canWin = Boolean(w.legal);
      winPatterns = (w.patterns || []).map((p) => `${p.name}${p.fan}番`);
    } catch { canWin = false; }

    let reason;
    if (canWin) {
      reason = `可以自摸胡：${winPatterns.join(' + ') || '平胡'}。不想胡的话，打${tileLabel(best.tile)}。`;
    } else if (missingLeft > 0) {
      reason = `定缺${SUIT_CN[missingSuit] || ''}，手上还有 ${missingLeft} 张没打完，先把${tileLabel(best.tile)}打掉。`;
    } else if (best.shanten === 0) {
      reason = `已听牌，打${tileLabel(best.tile)}，未见有效牌 ${best.remainingCount} 张。`;
    } else {
      reason = `打${tileLabel(best.tile)}后 ${best.shanten} 向听，未见有效牌 ${best.remainingCount} 张。`;
    }

    return {
      recommendedAction: 'DISCARD',
      tile: best.tile,
      physicalPosition,
      alternatives: candidates.slice(1, 3).map((c) => c.tile),
      shanten: best.shanten,
      usefulTiles: best.usefulTiles,
      remainingCount: best.remainingCount,
      missingLeft,
      canWin,
      winPatterns,
      risk: '相对估计',
      ruleProfile: this.rules.profile.id,
      strategyMode: mode,
      candidates,
      uncertainty: '对手暗手未知；风险值是同一局面内的启发式排序，未经真实概率校准。',
      reason,
    };
  }
}

function opponentRisk(state, actor, tile) {
  const river = state.discardPiles?.[actor] || [];
  const sameRiver = river.filter((item) => item.tile === tile).length;
  const melds = (state.melds || []).filter((meld) => meld.actor === actor);
  const exposedCount = melds.reduce((sum, meld) => sum + (meld.type === 'KONG' ? 4 : 3), 0);
  const profile = inferProfile(melds);
  const readyLikelihood = Math.min(0.75, 0.25 + Math.min(0.3, (state.turn - 1) * 0.025) + melds.length * 0.06);
  const profileCompatibility = compatibility(profile, tile);
  const ownRiverModifier = Math.max(0.46, 0.62 ** sameRiver);
  const openHandModifier = exposedCount < 6 ? 1 : exposedCount < 9 ? 1.05 : exposedCount < 12 ? 1.10 : 1.14;
  const ronEstimate = Math.min(0.42, Math.max(0.004, readyLikelihood * 0.17 * profileCompatibility * ownRiverModifier * openHandModifier));
  const valueWeight = profile.kind === 'PURE_SUIT' ? 8 : 4;
  const liabilityMultiplier = profile.kind === 'PURE_SUIT' && profileCompatibility > 1 && exposedCount >= 9 ? 1.85 : 1;
  const visibleSame = state.visibleTiles.filter((item) => item === tile).length;
  const selfSame = state.myHand.filter((item) => item.code === tile).length;
  const otherCopies = Math.max(0, 4 - visibleSame - selfSame);
  return {
    actor,
    label: PLAYER_LABELS[actor],
    profile: profile.kind,
    ronEstimate,
    expectedLoss: ronEstimate * valueWeight * liabilityMultiplier,
    valueWeight,
    liabilityMultiplier,
    pongPossible: otherCopies >= 2,
    exposedKongPossible: otherCopies >= 3,
    priorSameDiscard: sameRiver,
    note: sameRiver ? '这家打过同款，只能算软参考，不是绝对安全' : '暗手未知，按未校准模型估计',
  };
}

function inferProfile(melds) {
  if (melds.length < 2) return { kind: 'UNKNOWN' };
  const exposed = melds.flatMap((meld) => meld.tiles?.length ? meld.tiles : Array(meld.type === 'KONG' ? 4 : 3).fill(meld.tile));
  const suits = new Set(exposed.map((tile) => tile.at(-1)));
  if (suits.size === 1) return { kind: 'PURE_SUIT', suit: [...suits][0] };
  if (melds.every((meld) => ['PONG', 'KONG'].includes(meld.type))) return { kind: 'ALL_TRIPLETS' };
  return { kind: 'NORMAL' };
}

function compatibility(profile, tile) {
  const terminal = ['1', '9'].includes(tile[0]);
  if (profile.kind === 'PURE_SUIT') return tile.at(-1) === profile.suit ? 2.05 : 0.18;
  if (profile.kind === 'ALL_TRIPLETS') return terminal ? 1.18 : 1;
  if (profile.kind === 'NORMAL') return terminal ? 0.92 : Number(tile[0]) >= 3 && Number(tile[0]) <= 7 ? 1.15 : 1;
  return 1;
}

function toChinese(number) {
  return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四'][number] || String(number);
}
