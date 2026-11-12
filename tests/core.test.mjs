/**
 * 核心规则与决策的回归测试
 *
 * 跑：node --test tests/
 *
 * 这些用例是「保证」—— 改代码时如果破坏了下面任何一条，
 * 一次运行就能看到，不用再靠手工开浏览器点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shanten, standardWin, sevenPairs, waits, waitQuality, suitProfile,
  pureSuitPlan, pairGroups, countMissing,
} from '../assets/core/HandAnalysis.js';
import { RulesEngine } from '../assets/core/RulesEngine.js';
import { DecisionEngine } from '../assets/core/DecisionEngine.js';
import { meldSlots } from '../assets/core/constants.js';

// ---------------- 工具 ----------------
/** '123m4p' -> ['1m','2m','3m','4p'] */
function ex(str) {
  const out = [];
  for (const m of str.matchAll(/([0-9]+)([mps])/g)) {
    for (const n of m[1]) out.push(n + m[2]);
  }
  return out;
}

function state(hand, opts = {}) {
  return {
    myHand: hand.map((code) => ({ code })),
    visibleTiles: opts.visible || [],
    melds: opts.melds || [],
    turn: opts.turn || 8,
    currentPlayer: 'self',
    missingSuit: opts.missing === undefined ? 's' : opts.missing,
    strategyMode: opts.strategy || 'BALANCED',
    discardPiles: {
      self: [],
      right: (opts.right || []).map((tile) => ({ tile })),
      opposite: (opts.opposite || []).map((tile) => ({ tile })),
      left: (opts.left || []).map((tile) => ({ tile })),
    },
  };
}

const D = new DecisionEngine();
const R = new RulesEngine();

// ---------------- 向听 ----------------
test('向听：13 张听牌应为 0', () => {
  assert.equal(shanten(ex('123456789m1234p'), 0, 's'), 0);
});

test('向听：14 张成和应为 -1', () => {
  assert.equal(shanten(ex('123456789m123p55p'), 0, 's'), -1);
});

test('向听：14 张「4 组 + 1 搭子」不是和牌，应为 0', () => {
  // 这条专门防「假和牌」：多算一个搭子就会误判成 -1
  const hand = ex('12345678m123p555p');
  assert.equal(shanten(hand, 0, 's'), 0);
});

test('向听：缺门牌会推高向听', () => {
  const clean = ex('123456789m123p55p');
  const one = ex('123456789m123p5p').concat(['9s']);
  assert.ok(shanten(one, 0, 's') > shanten(clean, 0, 's'));
});

// ---------------- 和牌 ----------------
test('和牌：标准型', () => {
  assert.ok(standardWin(ex('123456789m123p55p'), 0, 's'));
});

test('和牌：手上还有缺门牌时不能胡', () => {
  const hand = ex('123456789m12355p').concat(['9s']);
  const r = R.analyzeWin(hand, { method: 'TSUMO', missingSuit: 's' });
  assert.equal(r.legal, false);
  assert.match(r.reason, /没打完/);
});

test('和牌：七对', () => {
  const quads = sevenPairs(ex('11223344556677m'), 0, 's');
  assert.notEqual(quads, null);
});

// ---------------- 听口 ----------------
test('听口：123456789m1234p 只听 1筒和4筒', () => {
  const w = waits(ex('123456789m1234p'), 0, 's');
  assert.deepEqual(w.map((x) => x.tile).sort(), ['1p', '4p']);
});

test('听口：剩余张数扣掉自己手里的', () => {
  // 手里 3 张 1 筒，听 1 筒时只剩 1 张
  const w = waits(ex('111123456789m1p').slice(0, 13), 0, 's');
  for (const item of w) {
    assert.ok(item.remaining >= 1 && item.remaining <= 3);
  }
});

test('听口：没听牌时返回空', () => {
  assert.deepEqual(waits(ex('13579m2468p1357s').slice(0, 13), 0, null), []);
});

// ---------------- 番型方向 ----------------
test('花色分布：缺门那门记 0', () => {
  const p = suitProfile(ex('123456789m123p'), 'p');
  assert.equal(p.p, 0);
  assert.equal(p.m, 9);
});

test('清一色：主色 9 张以上、异色 4 张以内才判定可行', () => {
  const good = pureSuitPlan(ex('123456789m11m').concat(['1p','2p']), 0, 's');
  assert.ok(good, '11 万 + 2 筒 应该可行');
  assert.equal(good.worth, true);

  const bad = pureSuitPlan(ex('1234567m234p55p'), 0, 's');
  assert.equal(bad.worth, false, '7 万 + 5 筒 不该硬做');
});

test('副露占位：碰 3 张、杠 4 张', () => {
  assert.equal(meldSlots([{ type: 'PONG' }]), 3);
  assert.equal(meldSlots([{ type: 'KONG' }]), 4);
  assert.equal(meldSlots([{ type: 'PONG' }, { type: 'KONG' }]), 7);
});

// ---------------- 决策 ----------------
test('决策：手上有缺门牌时，必须打缺门牌', () => {
  const r = D.analyze(state(ex('123456789m1234p').concat(['5s'])));
  assert.ok(r, '应该给出建议');
  assert.ok(r.tile.endsWith('s'), `应打条，实际打 ${r.tile}`);
  assert.equal(r.missingLeft, 1);
});

test('决策：碰 1 组（手牌 11 张）能正常分析', () => {
  const melds = [{ actor: 'self', type: 'PONG', tile: '5p', tiles: ['5p','5p','5p'] }];
  const r = D.analyze(state(ex('123456789m11p'), { melds }));
  assert.ok(r, '碰牌后应给出建议');
});

test('决策：杠 1 组（手牌 10 张）能正常分析', () => {
  // 回归用例：原来按「14 - 3 * 组数」校验，杠的 10 张会被判成张数不对，直接返回 null
  const melds = [{ actor: 'self', type: 'KONG', tile: '5p', tiles: ['5p','5p','5p','5p'] }];
  const r = D.analyze(state(ex('123456789m1p'), { melds }));
  assert.ok(r, '杠牌后应给出建议，不能返回 null');
});

test('决策：不为番数把听牌打成没听牌', () => {
  // 12 万 + 2 筒，打主色会掉到 1 向听，必须选保持 0 向听的
  const r = D.analyze(state(ex('112345678912m').concat(['1p','2p'])));
  assert.equal(r.shanten, 0, `应为 0 向听，实际 ${r.shanten}`);
});

test('决策：七对方向打单张、不拆对子', () => {
  const r = D.analyze(state(ex('11223344556679m')));
  assert.equal(r.plan.kind, 'SEVEN');
  const n = ex('11223344556679m').filter((t) => t === r.tile).length;
  assert.equal(n, 1, `应打单张，实际打了 ${r.tile}（手里 ${n} 张）`);
});

test('决策：普通手牌不强行给方向', () => {
  const r = D.analyze(state(ex('1234567m234p567p8m')));
  assert.equal(r.plan.kind, 'NORMAL');
});

test('决策：牌河读缺——对手连打 3 张条，判他缺条', () => {
  const r = D.analyze(state(ex('1234567m234p5678p'), { right: ['1s','5s','9s'] }));
  assert.ok(r);
  assert.equal(r.reads.right.suit, 's');
  assert.ok(r.reads.right.confidence >= 0.55);
});

test('决策：打对手缺门的花色，风险显著降低', () => {
  const hand = ex('1234567m').concat(ex('1234567s'));
  const plain = D.analyze(state(hand, { missing: 'p' }));
  const read = D.analyze(state(hand, { missing: 'p', right: ['1s','5s','9s','2s'] }));

  const riskOf = (r) => {
    const c = r.candidates.find((x) => x.tile.endsWith('s'));
    return c.opponents[0].ronEstimate;
  };
  assert.ok(riskOf(read) < riskOf(plain) * 0.5, '读牌后风险应至少降一半');
});

// ---------------- 牌墙 ----------------
test('牌墙：14 张、牌河空，剩 55 张', () => {
  const r = D.analyze(state(ex('123456789m123p55p')));
  assert.equal(r.wall, 55);
});

test('牌墙：每多一张牌河就少一张', () => {
  const hand = ex('123456789m123p55p');
  const a = D.analyze(state(hand));
  const b = D.analyze(state(hand, { right: ['1m','2m'], opposite: ['3m'], left: ['4m','5m'] }));
  assert.equal(b.wall, a.wall - 5);
});

test('牌墙：自己碰一组，占 3 张手牌位', () => {
  const melds = [{ actor: 'self', type: 'PONG', tile: '9m', tiles: ['9m','9m','9m'] }];
  // 碰一组的摸牌后手牌是 11 张（14 - 3）
  const r = D.analyze(state(ex('12345678m123p'), { melds }));
  assert.ok(r, '碰牌后应给出建议');
  // 11 张手牌 + 3 张副露 + 0 牌河 + 其余三家 39
  assert.equal(r.wall, 108 - 11 - 3 - 39);
});

// ---------------- 弃和 ----------------
test('弃和：牌墙少 + 对手露牌 + 自己高向听 → 触发', () => {
  const junk = ex('9p8m9m1m8p2p2m5p4m3p3p6m8p2m');
  const threat = [
    { actor: 'right', type: 'PONG', tile: '5m', tiles: ['5m','5m','5m'] },
    { actor: 'right', type: 'PONG', tile: '7p', tiles: ['7p','7p','7p'] },
  ];
  const lots = Array(20).fill('1m').concat(Array(10).fill('2p'), Array(5).fill('3s'));
  const r = D.analyze(state(junk, { melds: threat, right: lots }));
  assert.ok(r);
  assert.ok(r.wall <= 20, `牌墙应 ≤20，实际 ${r.wall}`);
  assert.ok(r.shanten >= 2, `向听应 ≥2，实际 ${r.shanten}`);
  assert.equal(r.defend, true);
});

test('弃和：牌墙还多时不触发', () => {
  const junk = ex('9p8m9m1m8p2p2m5p4m3p3p6m8p2m');
  const threat = [
    { actor: 'right', type: 'PONG', tile: '5m', tiles: ['5m','5m','5m'] },
    { actor: 'right', type: 'PONG', tile: '7p', tiles: ['7p','7p','7p'] },
  ];
  const r = D.analyze(state(junk, { melds: threat }));
  assert.equal(r.defend, false);
});

test('弃和：已经听牌时不弃（有胡就该胡）', () => {
  const threat = [
    { actor: 'right', type: 'PONG', tile: '5m', tiles: ['5m','5m','5m'] },
    { actor: 'right', type: 'PONG', tile: '7p', tiles: ['7p','7p','7p'] },
  ];
  const lots = Array(28).fill('1s').concat(Array(7).fill('2s'));
  const r = D.analyze(state(ex('123456789m123p55p'), { melds: threat, right: lots }));
  assert.equal(r.shanten, 0);
  assert.equal(r.defend, false);
});
