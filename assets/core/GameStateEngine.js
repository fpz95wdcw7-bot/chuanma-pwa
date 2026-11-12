import { INITIAL_HAND, NEXT_PLAYER, PLAYERS, TILE_LABELS, meldSlots } from './constants.js';
import { RULE_PROFILE } from './RulesEngine.js';

const emptyDiscards = () => ({ self: [], right: [], opposite: [], left: [] });

export class GameStateEngine {
  constructor(eventStore, rulesEngine) {
    this.store = eventStore;
    this.rules = rulesEngine;
    this.listeners = new Set();
    this.state = this.rebuild();
    this.store.subscribe(() => {
      this.state = this.rebuild();
      this.listeners.forEach((listener) => listener(this.state));
    });
  }

  baseState() {
    return {
      rules: RULE_PROFILE.id, round: 1, dealer: 'self', seat: 'east', currentPlayer: 'right', turn: 1,
      myHand: [], discardPiles: emptyDiscards(), discardModes: emptyDiscards(), melds: [], visibleTiles: [], unknownTileCounts: {}, integrityErrors: [],
      responseLocks: [], handVersions: { self: 0, right: 0, opposite: 0, left: 0 }, pendingDrawTile: null,
      strategyMode: 'BALANCED', lastAction: null,
      // 川麻：定缺 + 血战到底
      missingSuit: null, outPlayers: [], winners: [],
      events: [], cameraState: 'idle', microphoneState: 'idle', audioOutputState: 'idle',
      lastRecommendation: null, started: false, paused: false, ended: false,
    };
  }

  rebuild(rawEvents = this.store.getEvents()) {
    const state = this.baseState();
    const voided = new Set();
    const replacements = new Map();
    rawEvents.filter((event) => event.type === 'CORRECTION').forEach((event) => {
      const targetId = event.metadata?.corrects;
      if (!targetId) return;
      if (event.metadata?.operation === 'UNDO') voided.add(targetId);
      if (event.metadata?.operation === 'REPLACE') replacements.set(targetId, event.tile);
    });

    rawEvents.forEach((original) => {
      if (original.type === 'CORRECTION' || voided.has(original.id)) return;
      const event = replacements.has(original.id) ? { ...original, tile: replacements.get(original.id) } : original;
      this.reduce(state, event);
    });
    state.events = rawEvents;
    state.visibleTiles = Object.values(state.discardPiles).flat().filter((item) => !item.claimed).map((item) => item.tile)
      .concat(state.melds.flatMap((meld) => meld.tiles || []));
    return state;
  }

  reduce(state, event) {
    switch (event.type) {
      case 'GAME_START':
        Object.assign(state, { ...event.metadata, started: true, ended: false, currentPlayer: event.metadata.currentPlayer || 'right' });
        break;
      case 'INITIAL_HAND':
        state.myHand = (event.tiles || []).map((code, index) => ({ uid: `${event.id}-${index}`, code }));
        break;
      case 'DRAW':
        if (event.actor === 'self') state.myHand.push({ uid: event.id, code: event.tile });
        if (event.actor === 'self') state.pendingDrawTile = event.tile;
        if (event.actor === 'self') state.lastRecommendation = null;
        state.currentPlayer = event.actor;
        state.lastAction = event;
        break;
      case 'DISCARD': {
        if (event.actor === 'self') {
          const index = state.myHand.findIndex((tile) => tile.code === event.tile);
          if (index >= 0) state.myHand.splice(index, 1);
          else state.integrityErrors.push(`事件 ${event.id}：手牌中没有要打出的牌`);
          state.turn += 1;
        }
        const mode = event.metadata?.discardMode || 'unknown';
        if (mode === 'hand') invalidateLocks(state, event.actor);
        if (event.actor === 'self') state.pendingDrawTile = null;
        if (event.actor === 'self') state.lastRecommendation = null;
        state.discardPiles[event.actor].push({ tile: event.tile, eventId: event.id });
        state.discardModes[event.actor].push(mode);
        state.currentPlayer = NEXT_PLAYER[event.actor];
        state.lastAction = event;
        break;
      }
      case 'PONG': case 'KONG':
        if (event.tile && (event.type === 'PONG' || event.metadata?.kongKind === 'EXPOSED')) {
          const previousActor = Object.keys(state.discardPiles).find((actor) => state.discardPiles[actor].at(-1)?.tile === event.tile && actor !== event.actor);
          if (previousActor) state.discardPiles[previousActor].at(-1).claimed = true;
        }
        if (event.actor === 'self' && event.tile) {
          const needed = event.type === 'PONG' ? 2 : event.metadata?.kongKind === 'ADDED' ? 1 : event.metadata?.kongKind === 'EXPOSED' ? 3 : 4;
          for (let count = 0; count < needed; count += 1) {
            const index = state.myHand.findIndex((item) => item.code === event.tile);
            if (index < 0) state.integrityErrors.push(`事件 ${event.id}：手牌不足以碰杠`);
            else state.myHand.splice(index, 1);
          }
        }
        if (event.metadata?.kongKind === 'ADDED') {
          const prior = state.melds.find((meld) => meld.actor === event.actor && meld.type === 'PONG' && meld.tile === event.tile);
          if (prior) { prior.type = 'KONG'; prior.tiles.push(event.tile); prior.kongKind = 'ADDED'; }
          else state.integrityErrors.push(`事件 ${event.id}：没有可补杠的碰牌`);
        } else state.melds.push({ actor: event.actor, type: event.type, tile: event.tile, tiles: event.tiles || (event.tile ? Array(event.type === 'KONG' ? 4 : 3).fill(event.tile) : []), kongKind: event.metadata?.kongKind || null });
        invalidateLocks(state, event.actor);
        state.currentPlayer = event.actor;
        state.lastAction = event;
        break;
      case 'PASS':
        for (const action of event.metadata?.locks || []) state.responseLocks.push({ actor: event.actor, tile: event.tile, action, sourceEventId: event.metadata?.sourceEventId || null, handVersion: state.handVersions[event.actor], active: true });
        break;
      case 'RECOMMENDATION':
        state.lastRecommendation = event.metadata;
        break;
      case 'STRATEGY_MODE': state.strategyMode = event.metadata.mode; break;
      case 'PAUSE': state.paused = true; break;
      case 'RESUME': state.paused = false; break;
      case 'WIN': {
        const winners = event.metadata?.winners || [event.actor];
        state.winners = [...new Set([...(state.winners || []), ...winners])];
        // 血战到底：胡了的人退出，不发牌不摸牌，但牌局继续
        state.outPlayers = [...new Set([...(state.outPlayers || []), ...winners])];
        state.lastAction = event;
        const alive = PLAYERS.filter((p) => !state.outPlayers.includes(p));
        // 只剩一家、或四家全胡，才算结束
        state.ended = alive.length <= 1;
        break;
      }
      case 'SET_MISSING':
        state.missingSuit = event.suit || null;
        state.lastAction = event;
        break;
      case 'END_GAME': state.ended = true; break;
      default: break;
    }
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getState() { return this.state; }

  startGame({ tiles = INITIAL_HAND, rules = RULE_PROFILE.id, seat = 'east', dealer = 'self', initialSource = 'MANUAL', missingSuit = null } = {}) {
    this.rules.validateTiles(tiles);
    if (tiles.length !== 13) throw new Error('初始手牌必须有 13 张');
    if (rules !== RULE_PROFILE.id) throw new Error('不认识的规则配置：' + rules);
    this.store.clear();
    const batch = [
      // 庄家先摸，所以 currentPlayer 就是 dealer
      { actor: 'system', type: 'GAME_START', metadata: { rules, seat, dealer, currentPlayer: dealer, round: 1 } },
      { actor: 'self', type: 'INITIAL_HAND', tiles, source: initialSource, confidence: 1,
        metadata: { humanConfirmed: true } },
    ];
    if (missingSuit) batch.push({ actor: 'system', type: 'SET_MISSING', suit: missingSuit, source: 'MANUAL' });
    this.store.appendMany(batch);
  }

  recordDiscard(tile, { actor = this.state.currentPlayer, source = 'VOICE', confidence = 0.97, discardMode = null } = {}) {
    this.assertActive();
    this.assertTile(tile);
    if (!PLAYERS.includes(actor)) throw new Error('出牌者无效');
    if (actor !== this.state.currentPlayer) throw new Error('出牌者与当前回合不一致，请先纠错');
    if (actor === 'self' && !this.state.myHand.some((item) => item.code === tile)) throw new Error('手牌中没有这张牌');
    if (actor !== 'self') this.assertAvailable(tile);
    if (discardMode && !['hand', 'draw', 'unknown'].includes(discardMode)) throw new Error('无效舍牌方式');
    const resolvedMode = discardMode && discardMode !== 'unknown' ? discardMode : actor === 'self' && this.state.pendingDrawTile ? (tile === this.state.pendingDrawTile ? 'draw' : 'hand') : actor === 'self' ? 'hand' : 'unknown';
    return this.store.append({
      actor, type: 'DISCARD', tile, source, confidence,
      metadata: actor === 'self' ? { recommendedDiscard: this.state.lastRecommendation?.tile || null, actualDiscard: tile, discardMode: resolvedMode } : { discardMode: resolvedMode },
    });
  }

  recordDraw(tile, source = 'MANUAL') {
    this.assertActive();
    this.assertTile(tile);
    const meldCount = this.state.melds.filter((meld) => meld.actor === 'self').length;
    const slotUsed = meldSlots(this.state.melds.filter((m) => m.actor === 'self'));
    if (this.state.currentPlayer !== 'self' || this.state.myHand.length !== 13 - slotUsed) throw new Error('当前不是可摸牌状态');
    this.assertAvailable(tile);
    return this.store.append({ actor: 'self', type: 'DRAW', tile, source, confidence: source === 'VISION' ? 0.95 : 1 });
  }
  recordCall(actor, type, tile = null) {
    this.assertActive();
    if (!this.rules.canCall(type)) throw new Error('此规则不允许该动作');
    if (!PLAYERS.includes(actor)) throw new Error('动作玩家无效');
    const lastDiscard = this.state.lastAction?.type === 'DISCARD' ? this.state.lastAction : null;
    if (!tile && ['PONG', 'KONG'].includes(type) && lastDiscard?.actor !== actor) tile = lastDiscard?.tile || null;
    if (tile) this.assertTile(tile);
    const claimsLastDiscard = Boolean(tile && lastDiscard?.tile === tile && lastDiscard?.actor !== actor);
    if (type === 'PONG' && !claimsLastDiscard) throw new Error('碰牌必须对应上一张他家弃牌');
    const priorPong = this.state.melds.some((meld) => meld.actor === actor && meld.type === 'PONG' && meld.tile === tile);
    const kongKind = type === 'KONG' ? claimsLastDiscard ? 'EXPOSED' : priorPong ? 'ADDED' : actor === 'self' ? 'CONCEALED' : 'UNKNOWN' : null;
    if (tile && ['PONG', 'KONG'].includes(type)) {
      if (actor === 'self') {
        const needed = type === 'PONG' ? 2 : kongKind === 'ADDED' ? 1 : kongKind === 'EXPOSED' ? 3 : 4;
        if (this.state.myHand.filter((item) => item.code === tile).length < needed) throw new Error('手牌不足以碰杠');
      }
      const known = this.state.myHand.filter((item) => item.code === tile).length + this.state.visibleTiles.filter((item) => item === tile).length;
      const newlyVisible = actor === 'self' ? 0 : kongKind === 'ADDED' ? 1 : (type === 'PONG' ? 3 : 4) - Number(claimsLastDiscard);
      if (known + newlyVisible > 4) throw new Error('碰杠后已知牌超过四张，请先纠错');
    }
    if (type === 'WIN' && actor === 'self') {
      const tiles = this.state.myHand.map((item) => item.code);
      const method = this.state.currentPlayer === 'self' && tiles.length === 14 ? 'TSUMO' : 'RON';
      if (method === 'RON' && (this.state.lastAction?.type !== 'DISCARD' || this.state.lastAction.actor === actor || this.state.lastAction.tile !== tile)) throw new Error('荣和必须对应最新的他家弃牌');
      if (method === 'RON' && tile) tiles.push(tile);
      const verdict = this.rules.analyzeWin(tiles, { method, melds: this.state.melds.filter((meld) => meld.actor === 'self') });
      if (!verdict.legal) throw new Error(verdict.reason);
      return this.store.append({ actor, type, tile: method === 'RON' ? tile : null, source: 'VOICE', confidence: 0.92, metadata: { method, verdict, winners: [actor] } });
    }
    if (type === 'WIN') {
      const method = this.state.lastAction?.type === 'DISCARD' && this.state.lastAction.actor !== actor && this.state.lastAction.tile === tile ? 'RON' : actor === this.state.currentPlayer ? 'TSUMO' : null;
      if (!method) throw new Error('无法确认胡牌来源，请先纠正当前回合');
      return this.store.append({ actor, type, tile: method === 'RON' ? tile : null, source: 'VOICE', confidence: 0.92, metadata: { method, winners: [actor], verification: '对手暗手未知，未验证和牌' } });
    }
    return this.store.append({ actor, type, tile, source: 'VOICE', confidence: 0.92, metadata: kongKind ? { kongKind } : {} });
  }
  recordMultipleRon(winners, tile, sourceEventId = null) {
    this.assertActive();
    this.assertTile(tile);
    if (!Array.isArray(winners) || !winners.length || winners.some((actor) => !PLAYERS.includes(actor))) throw new Error('荣和者无效');
    if (this.state.lastAction?.type !== 'DISCARD' || this.state.lastAction.tile !== tile) throw new Error('一炮多响必须对应最新弃牌');
    if (winners.includes(this.state.lastAction.actor)) throw new Error('出牌者不能荣和自己的弃牌');
    if (winners.includes('self')) {
      const verdict = this.rules.analyzeWin([...this.state.myHand.map((item) => item.code), tile], { method: 'RON', melds: this.state.melds.filter((meld) => meld.actor === 'self') });
      if (!verdict.legal) throw new Error(verdict.reason);
    }
    return this.store.append({ actor: 'system', type: 'WIN', tile, source: 'MANUAL', metadata: { method: 'RON', winners: [...new Set(winners)], sourceEventId, verification: '对手暗手未知，需人工确认' } });
  }
  recordResponsePass(actor, tile, actions, sourceEventId = null) {
    this.assertActive();
    this.assertTile(tile);
    const allowed = ['ron', 'pong', 'exposedKong'];
    if (!PLAYERS.includes(actor) || !Array.isArray(actions) || actions.some((action) => !allowed.includes(action))) throw new Error('响应锁参数无效');
    return this.store.append({ actor, type: 'PASS', tile, source: 'MANUAL', metadata: { locks: [...new Set(actions)], sourceEventId } });
  }
  setStrategyMode(mode) {
    if (!['DEFENSE_FIRST', 'BALANCED', 'ATTACK_FIRST'].includes(mode)) throw new Error('无效策略模式');
    return this.store.append({ actor: 'system', type: 'STRATEGY_MODE', source: 'MANUAL', metadata: { mode } });
  }

  /** 定缺：一局只定一次，定完才能开始摸打 */
  setMissingSuit(suit) {
    if (!['m', 'p', 's'].includes(suit)) throw new Error('定缺只能是 m / p / s');
    this.assertActive();
    return this.store.append({ actor: 'system', type: 'SET_MISSING', source: 'MANUAL', suit });
  }

  /** 轮转到下一个还没胡的人 */
  nextActive(from = this.state.currentPlayer) {
    let p = from;
    for (let i = 0; i < PLAYERS.length; i += 1) {
      p = NEXT_PLAYER[p];
      if (!(this.state.outPlayers || []).includes(p)) return p;
    }
    return from;
  }

  /** 还在打的人（血战到底） */
  activePlayers() {
    return PLAYERS.filter((p) => !(this.state.outPlayers || []).includes(p));
  }
  recordRecommendation(recommendation) { return this.store.append({ actor: 'system', type: 'RECOMMENDATION', tile: recommendation.tile, metadata: recommendation }); }
  pause() { return this.store.append({ actor: 'system', type: 'PAUSE', source: 'MANUAL' }); }
  resume() { return this.store.append({ actor: 'system', type: 'RESUME', source: 'MANUAL' }); }
  endGame() { return this.store.append({ actor: 'system', type: 'END_GAME', source: 'MANUAL' }); }

  undoLast() {
    const inactive = new Set(this.store.getEvents().filter((e) => e.type === 'CORRECTION' && e.metadata?.operation === 'UNDO').map((e) => e.metadata.corrects));
    const target = [...this.store.getEvents()].reverse().find((event) => !['CORRECTION', 'GAME_START', 'INITIAL_HAND'].includes(event.type) && !inactive.has(event.id));
    if (!target) return null;
    return this.store.append({ actor: 'system', type: 'CORRECTION', source: 'MANUAL', metadata: { operation: 'UNDO', corrects: target.id, old: target.tile || target.type } });
  }

  correct(targetId, tile) {
    this.assertTile(tile);
    const target = this.store.getEvents().find((event) => event.id === targetId);
    if (!target) return null;
    const correction = { id: 'correction-preview', actor: 'system', type: 'CORRECTION', tile, source: 'MANUAL', metadata: { operation: 'REPLACE', corrects: targetId, old: target.tile, next: tile } };
    this.rules.validatePublicState(this.rebuild([...this.store.getEvents(), correction]));
    const { id: _previewId, ...toAppend } = correction;
    return this.store.append(toAppend);
  }
  assertTile(tile) { if (!TILE_LABELS[tile]) throw new Error('无效牌码'); }
  assertActive() { if (!this.state.started || this.state.ended || this.state.paused) throw new Error('牌局未进行，请先开始或继续'); }
  assertAvailable(tile) {
    const known = this.state.myHand.filter((item) => item.code === tile).length + this.state.visibleTiles.filter((item) => item === tile).length;
    if (known >= 4) throw new Error('已知牌中该牌已有四张，请先纠错');
  }
}

function invalidateLocks(state, actor) {
  state.handVersions[actor] += 1;
  state.responseLocks.forEach((lock) => { if (lock.actor === actor) lock.active = false; });
}
