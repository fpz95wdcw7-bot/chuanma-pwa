/**
 * 川麻出牌决策
 *
 * 三层优先级，从硬到软：
 *   1. 手上还有缺门牌 → 只能打缺，别的全不考虑（这是规则，不是策略）
 *   2. 向听差 ≥ 2 → 牌效说话，不为了做大牺牲太多
 *   3. 向听接近 → 看番型方向、听口质量、点炮风险
 *
 * 番型方向只在「有明确迹象」时才生效（对子够多、主色够纯），
 * 模糊的时候返回 NORMAL，不干预排序 —— 猜错比不猜更糟。
 */
import { PLAYER_LABELS, tileLabel, isMissing, SUIT_CN, meldSlots } from './constants.js';
import {
  effectiveDraws, waitQuality, pureSuitPlan, tripletGroups, pairGroups,
  sevenPairsPlan, tileCounts, codeToIndex,
} from './HandAnalysis.js';
import { RulesEngine } from './RulesEngine.js';

export class DecisionEngine {
  constructor(rules = new RulesEngine()) { this.rules = rules; }

  analyze(gameState) {
    const selfMeldsAll = gameState.melds.filter((meld) => meld.actor === 'self');
    const meldCount = selfMeldsAll.length;                 // 组数，给向听算法用
    const slotUsed = meldSlots(selfMeldsAll);              // 手牌位，碰 3 杠 4
    if (gameState.currentPlayer !== 'self' || gameState.myHand.length !== 14 - slotUsed) return null;
    this.rules.validatePublicState(gameState);

    const missingSuit = gameState.missingSuit || null;
    const hand = gameState.myHand.map((item) => item.code);
    const mode = gameState.strategyMode || this.rules.profile.defaultStrategy;
    const visible = gameState.visibleTiles || [];

    // 还有缺门牌 —— 只能打缺，别的牌留着
    const missingInHand = missingSuit ? hand.filter((tile) => isMissing(tile, missingSuit)) : [];
    const pool = missingInHand.length ? [...new Set(missingInHand)] : [...new Set(hand)];

    const plan = buildPlan(hand, meldCount, missingSuit);
    const handCounts = tileCounts(hand);

    // 三家牌河读出来的缺门（川麻定缺，早期打的花色就是他的缺）
    const reads = {};
    for (const actor of ['right', 'opposite', 'left']) {
      reads[actor] = inferMissingFromRiver(gameState.discardPiles?.[actor]);
    }

    const candidates = pool.map((tile) => {
      const after = [...hand];
      after.splice(after.indexOf(tile), 1);
      const effectiveness = effectiveDraws(after, [...visible, tile], meldCount, missingSuit);

      // 打完后如果已经听牌，直接数活口 —— 这比「有效牌种类」更贴近实战
      const wq = effectiveness.shanten === 0
        ? waitQuality(after, meldCount, missingSuit, [...visible, tile])
        : 0;

      const opponents = ['right', 'opposite', 'left']
        .map((actor) => opponentRisk(gameState, actor, tile, reads[actor]));
      const expectedRonLoss = opponents.reduce((sum, o) => sum + o.expectedLoss, 0);
      const ronProbabilityAny = 1 - opponents.reduce((p, o) => p * (1 - o.ronEstimate), 1);
      const disruption = opponents.reduce((sum, o) => sum + Number(o.pongPossible) + Number(o.exposedKongPossible), 0);

      return {
        tile,
        isMissingTile: isMissing(tile, missingSuit),
        planScore: scoreByPlan(tile, plan, handCounts),
        waitQuality: wq,
        ...effectiveness,
        opponents,
        expectedRonLoss,
        ronProbabilityAny,
        disruption,
      };
    });

    const compare = (a, b) => {
      // 1. 缺门牌绝对优先
      if (a.isMissingTile !== b.isMissingTile) return a.isMissingTile ? -1 : 1;

      // 2. 听牌 > 没听牌 —— 这条不让步。
      //    曾经为了做清一色把 0 向听打成 1 向听，活口从 4 变成 0，纯亏。
      const aWait = a.shanten === 0;
      const bWait = b.shanten === 0;
      if (aWait !== bWait) return aWait ? -1 : 1;

      // 3. 向听差 2 以上，牌效说话
      const sh = a.shanten - b.shanten;
      if (Math.abs(sh) >= 2) return sh;

      // 4. 活口差 3 倍以上，番数补不回来。
      //    清一色 4 倍收益，撑得住活口差 2~3 倍，撑不住 3 倍以上。
      const aQ = a.waitQuality || a.remainingCount;
      const bQ = b.waitQuality || b.remainingCount;
      if (aQ > 0 && bQ > 0 && Math.max(aQ, bQ) >= 3 * Math.min(aQ, bQ)) {
        return bQ - aQ;
      }

      // 5. 向听接近、活口也接近：番型方向优先
      if (a.planScore !== b.planScore) return b.planScore - a.planScore;

      // 6. 都是听牌时，听口多的优先
      if (a.waitQuality !== b.waitQuality) return b.waitQuality - a.waitQuality;

      // 7. 剩下的按策略模式比
      const loss = a.expectedRonLoss - b.expectedRonLoss;
      const uke = b.remainingCount - a.remainingCount;
      if (mode === 'ATTACK_FIRST') return sh || uke || loss;
      if (mode === 'BALANCED') {
        return loss * 0.5 + sh * 0.35 - (a.remainingCount - b.remainingCount) * 0.012 || uke;
      }
      return loss || a.ronProbabilityAny - b.ronProbabilityAny || a.disruption - b.disruption || uke;
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
      reason = `已听牌，打${tileLabel(best.tile)}，${best.waitQuality} 张活口。`;
    } else {
      reason = `打${tileLabel(best.tile)}后 ${best.shanten} 向听，未见有效牌 ${best.remainingCount} 张。${planText(plan)}`;
    }

    return {
      recommendedAction: 'DISCARD',
      tile: best.tile,
      physicalPosition,
      alternatives: candidates.slice(1, 3).map((c) => c.tile),
      shanten: best.shanten,
      usefulTiles: best.usefulTiles,
      remainingCount: best.remainingCount,
      waitQuality: best.waitQuality,
      missingLeft,
      canWin,
      winPatterns,
      plan,
      reads,
      risk: '相对估计',
      ruleProfile: this.rules.profile.id,
      strategyMode: mode,
      candidates,
      uncertainty: '对手暗手未知；风险值是同一局面内的启发式排序，未经真实概率校准。',
      reason,
    };
  }
}

// ---------------- 番型方向 ----------------
/**
 * 只返回「有硬证据」的方向，否则 NORMAL。
 * 顺序按成型难度：七对（对子够多）> 对对胡（刻+对够多）> 清一色（主色够纯）
 */
function buildPlan(hand, meldCount, missingSuit) {
  const seven = sevenPairsPlan(hand, meldCount, missingSuit);
  if (seven && seven.pairs >= 6) return { kind: 'SEVEN', ...seven };

  const trip = tripletGroups(hand);
  const pairs = pairGroups(hand);
  if (meldCount + trip >= 2 && trip + pairs >= 5) {
    return { kind: 'TRIPLETS', triplets: trip, pairs, meldCount };
  }

  const pure = pureSuitPlan(hand, meldCount, missingSuit);
  if (pure && pure.worth) return { kind: 'PURE', ...pure };

  return { kind: 'NORMAL' };
}

function planText(plan) {
  if (!plan || plan.kind === 'NORMAL') return '';
  if (plan.kind === 'PURE') return `主色${SUIT_CN[plan.suit]} ${plan.mainCount} 张，往清一色走。`;
  if (plan.kind === 'SEVEN') return `对子 ${plan.pairs} 组，差 ${plan.need} 组做七对。`;
  if (plan.kind === 'TRIPLETS') return `刻子 ${plan.triplets} 组 + 对子 ${plan.pairs} 组，往对对胡走。`;
  return '';
}

/** 打出这张牌，对当前方向是帮忙还是拆台 */
function scoreByPlan(tile, plan, handCounts) {
  if (!plan || plan.kind === 'NORMAL') return 0;

  if (plan.kind === 'PURE') {
    return tile.at(-1) === plan.suit ? -2 : 2;
  }

  if (plan.kind === 'SEVEN' || plan.kind === 'TRIPLETS') {
    const idx = codeToIndex(tile);
    const n = handCounts[idx] || 0;
    // 单张打掉是帮忙（留对子/刻子），拆对子拆刻子是拆台
    if (n >= 3) return -2;
    if (n === 2) return -1;
    return 1;
  }
  return 0;
}

// ---------------- 对手建模 ----------------
/**
 * 从牌河读缺门。
 *
 * 川麻定缺之后必须先打完缺门那门牌，所以一个人**前几张**打出的花色
 * 基本就是他的缺门。看前 5 张就够，后面的牌是正常出牌，参考价值低。
 */
function inferMissingFromRiver(river) {
  if (!river || river.length < 2) return { suit: null, confidence: 0, ratio: 0 };
  const early = river.slice(0, 5).map((d) => (d && d.tile) || d).filter(Boolean);
  if (early.length < 2) return { suit: null, confidence: 0, ratio: 0 };
  const count = { m: 0, p: 0, s: 0 };
  for (const t of early) count[t.at(-1)] += 1;
  const [suit, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  const ratio = n / early.length;
  if (n < 2) return { suit: null, confidence: 0, ratio };
  if (ratio >= 0.6) return { suit, confidence: 0.85, ratio };
  if (ratio >= 0.4) return { suit, confidence: 0.55, ratio };
  return { suit: null, confidence: 0, ratio };
}

function opponentRisk(state, actor, tile, read) {
  const river = state.discardPiles?.[actor] || [];
  const sameRiver = river.filter((item) => item.tile === tile).length;
  const melds = (state.melds || []).filter((meld) => meld.actor === actor);
  const exposedCount = melds.reduce((sum, meld) => sum + (meld.type === 'KONG' ? 4 : 3), 0);
  const profile = inferProfile(melds, river);

  const readyLikelihood = Math.min(0.75, 0.25 + Math.min(0.3, (state.turn - 1) * 0.025) + melds.length * 0.06);
  const profileCompatibility = compatibility(profile, tile);
  const ownRiverModifier = Math.max(0.46, 0.62 ** sameRiver);
  const openHandModifier = exposedCount < 6 ? 1 : exposedCount < 9 ? 1.05 : exposedCount < 12 ? 1.10 : 1.14;

  // 打的是他缺门那门 → 他根本不要，风险直接压下去
  const hitMissing = read && read.suit && tile.at(-1) === read.suit;
  const readModifier = hitMissing ? (1 - 0.7 * read.confidence) : 1;

  const ronEstimate = Math.min(0.42, Math.max(0.004,
    readyLikelihood * 0.17 * profileCompatibility * ownRiverModifier * openHandModifier * readModifier));

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
    readSuit: read?.suit || null,
    readConfidence: read?.confidence || 0,
    note: hitMissing
      ? `他缺${SUIT_CN[read.suit] || ''}（可信度 ${Math.round(read.confidence * 100)}%），打这门风险低`
      : sameRiver ? '这家打过同款，只能算软参考' : '暗手未知，按未校准模型估计',
  };
}

function inferProfile(melds, river) {
  if (melds.length < 2) return { kind: 'UNKNOWN' };
  const exposed = melds.flatMap((meld) => meld.tiles?.length
    ? meld.tiles : Array(meld.type === 'KONG' ? 4 : 3).fill(meld.tile));
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
