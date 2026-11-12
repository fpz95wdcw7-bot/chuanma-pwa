import { AudioService } from './services/AudioService.js';
import { CameraService } from './services/CameraService.js';
import { SpeechService } from './services/SpeechService.js';
import { VisionService } from './services/VisionService.js';
import { DecisionEngine } from './core/DecisionEngine.js';
import { EventStore } from './core/EventStore.js';
import { GameStateEngine } from './core/GameStateEngine.js';
import { RulesEngine } from './core/RulesEngine.js';
import { EVENT_LABELS, INITIAL_HAND, MISSING_OPTIONS, PLAYER_LABELS, SUIT_CN, TILE_LABELS, meldSlots, tileGlyph, tileLabel } from './core/constants.js';

const app = document.querySelector('#app');
const APP_BASE = new URL('../', import.meta.url).pathname;
const eventStore = new EventStore();
const rulesEngine = new RulesEngine();
const game = new GameStateEngine(eventStore, rulesEngine);
const camera = new CameraService();
const vision = new VisionService();
const audio = new AudioService();
const speech = new SpeechService(() => audio.active);
const decision = new DecisionEngine(rulesEngine);

const setup = {
  step: Number(new URLSearchParams(location.search).get('step') || sessionStorage.getItem('mahjong-setup-step') || 1),
  rule: rulesEngine.profile.id, seat: 'east', dealer: 'self',
  permissions: { camera: camera.state === 'ready', microphone: Boolean(speech.stream), audio: false, wake: false },
  initialHand: [], scan: null, handConfirmed: false, missingSuit: sessionStorage.getItem('cm-missing') || 's',
};
const runtime = { lastMessage: '', speechFallback: false, wakeLock: null };
const visionTest = { result: null, expectedCount: 13, imageName: '', verified: false,
  message: '先开启摄像头，对准整排手牌后，再点“拍摄当前画面”；也可直接选择照片。' };
let toastTimer;

function route() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (path.endsWith('/setup')) return 'setup';
  if (path.endsWith('/play')) return 'play';
  if (path.endsWith('/review')) return 'review';
  if (path.endsWith('/vision-test')) return 'vision-test';
  return 'home';
}
function navigate(path) {
  const suffix = path === '/' ? '' : `${path.replace(/^\/+|\/+$/g, '')}/`;
  history.pushState({}, '', `${APP_BASE}${suffix}`);
  render();
}
function render() {
  app.className = `app-shell route-${route()}`;
  try {
    if (route() === 'setup') renderSetup();
    else if (route() === 'play') renderPlay();
    else if (route() === 'review') renderReview();
    else if (route() === 'vision-test') renderVisionTest();
    else renderHome();
  } catch (error) {
    // 渲染失败别留白屏，把栈直接摊在页面上，省得只能开控制台
    console.error(error);
    app.innerHTML = `<pre style="padding:20px;color:#ff6c5b;white-space:pre-wrap;font-size:12px;line-height:1.6">渲染出错：${escapeHtml(error.message)}\n\n${escapeHtml(error.stack || '')}</pre>`;
  }
}

function renderHome() {
  speech.stop();
  const sessions = getSessions();
  app.innerHTML = `
    <main class="home">
      <div class="brand-row"><div class="brand-mark" aria-hidden="true">中</div><div class="status-chip"><span class="pulse"></span>设备端原型</div></div>
      <section class="home-intro"><div class="eyebrow">Realtime Mahjong Copilot</div><h1>AI 麻将<br />助手</h1><p>看住你的手牌，听懂牌桌变化，在你摸牌后立即给出清楚的出牌建议。</p></section>
      <section class="start-card" aria-label="开始牌局">
        <div class="start-meta"><span>四川麻将 · 血战到底</span><span>约 1 分钟设置</span></div>
        <button class="primary-btn" id="start-game"><span>开始新牌局</span><span class="button-icon">›</span></button>
        <nav class="home-nav" aria-label="其他功能"><button type="button" data-toast="设置会在牌局中随时可用">设置</button><button type="button" id="recognition-test">识别测试</button><button type="button" id="history-button">历史记录${sessions.length ? ` · ${sessions.length}` : ''}</button></nav>
      </section>
      ${sessions.length ? `<section class="recent-games"><div class="section-kicker">最近牌局</div>${sessions.slice(0, 2).map((session) => `<button data-review-session="${session.id}"><span>${formatDate(session.endedAt)}</span><b>${session.turns} 巡</b></button>`).join('')}</section>` : ''}
      <div class="toast" id="toast" role="status"></div>
    </main>`;
  byId('start-game').onclick = () => { setup.step = 1; sessionStorage.setItem('mahjong-setup-step', '1'); navigate('/setup'); };
  byId('recognition-test').onclick = () => navigate('/vision-test');
  byId('history-button').onclick = () => sessions.length ? navigate('/review') : showToast('还没有已保存的牌局');
  document.querySelectorAll('[data-toast]').forEach((button) => button.onclick = () => showToast(button.dataset.toast));
  document.querySelectorAll('[data-review-session]').forEach((button) => button.onclick = () => navigate('/review'));
}

function renderSetup() {
  speech.stop();
  const steps = ['规则', '座位', '权限', '校准', '手牌'];
  app.innerHTML = `
    <main class="setup-page">
      <header class="setup-header"><button class="icon-btn" id="setup-back" aria-label="返回">‹</button><div class="setup-progress" aria-label="设置进度">${steps.map((label, index) => `<span class="${index + 1 <= setup.step ? 'active' : ''}"></span>`).join('')}</div><span class="step-count">${setup.step}/5</span></header>
      <section class="setup-content">${setupStepTemplate()}</section>
      <footer class="setup-footer">${setup.step > 1 ? '<button class="secondary-btn" id="previous-step">上一步</button>' : ''}<button class="primary-btn compact" id="next-step" ${canContinueSetup() ? '' : 'disabled'}>${setup.step === 5 ? '开始牌局' : '下一步'}<span>›</span></button></footer>
      <dialog class="tile-dialog" id="tile-picker"></dialog><div class="toast" id="toast" role="status"></div>
    </main>`;
  byId('setup-back').onclick = () => setup.step > 1 ? changeSetupStep(-1) : navigate('/');
  if (byId('previous-step')) byId('previous-step').onclick = () => changeSetupStep(-1);
  byId('next-step').onclick = () => setup.step === 5 ? startGame() : changeSetupStep(1);
  bindSetupStep();
}

function setupStepTemplate() {
  if (setup.step === 1) return `
    <div class="setup-title"><span class="section-kicker">STEP 01</span><h2>选择麻将规则</h2><p>四川麻将血战到底：108 张、无字牌、必须定缺、不能吃、胡牌后其他人接着打。</p></div>
    <div class="choice-list">${[[rulesEngine.profile.id, '四川麻将 · 血战到底', '108 张 / 定缺 / 一炮多响'], ['national', '其他地方麻将', '未配置'], ['custom', '自定义', '未配置']].map(([value, label, note]) => `<button class="choice-row ${setup.rule === value ? 'selected' : ''} ${value !== rulesEngine.profile.id ? 'disabled' : ''}" data-rule="${value}" ${value !== rulesEngine.profile.id ? 'disabled' : ''}><span class="radio-dot"></span><span><b>${label}</b><small>${note}</small></span></button>`).join('')}</div>`;
  if (setup.step === 2) return `
    <div class="setup-title"><span class="section-kicker">STEP 02</span><h2>确认你的位置</h2><p>系统会按牌桌方向自动推算下一位出牌者。</p></div>
    <div class="seat-map"><button data-seat="north" class="seat top ${setup.seat === 'north' ? 'selected' : ''}">北<span>对家</span></button><button data-seat="west" class="seat left ${setup.seat === 'west' ? 'selected' : ''}">西<span>上家</span></button><div class="table-mark">牌桌</div><button data-seat="east" class="seat bottom ${setup.seat === 'east' ? 'selected' : ''}">东<span>我</span></button><button data-seat="south" class="seat right ${setup.seat === 'south' ? 'selected' : ''}">南<span>下家</span></button></div>
    <label class="field-label" for="dealer-select">庄家是谁？</label><select class="select-control" id="dealer-select"><option value="self">我</option><option value="right">下家</option><option value="opposite">对家</option><option value="left">上家</option></select>`;
  if (setup.step === 3) return `
    <div class="setup-title"><span class="section-kicker">STEP 03</span><h2>检查设备权限</h2><p>摄像头与麦克风会在浏览器内同时保持运行。</p></div>
    <div class="permission-list">${permissionRow('camera', '摄像头', '观察手牌', '允许摄像头')}${permissionRow('microphone', '麦克风', '听取出牌', '允许麦克风')}${permissionRow('audio', '音频播放', '播报建议', '测试扬声器')}${permissionRow('wake', '屏幕常亮', '避免牌局中锁屏', '保持常亮')}</div>
    <p class="privacy-note">摄像头画面只在本机识别，不上传完整照片。实时摸牌和出牌仍需用模拟按钮录入。</p>`;
  if (setup.step === 4) return `
    <div class="setup-title"><span class="section-kicker">STEP 04</span><h2>校准摄像头</h2><p>请让全部手牌落在框内，并保持机位稳定。</p></div>
    <div class="camera-frame"><video id="camera-preview" autoplay muted playsinline></video><div class="camera-placeholder"><span>摄像头预览</span><small>允许权限后显示实时画面</small></div><div class="roi"><span>请将手牌放在这里</span><div>${INITIAL_HAND.slice(0, 8).map(tileGlyph).join(' ')}</div></div><span class="camera-live">LIVE</span></div>
    <div class="calibration-status"><span>本机测试版：只适配样本里的牌面样式</span><span>识别不确定时必须人工核对</span></div><button class="secondary-btn full" id="scan-hand">拍照识别当前手牌</button><label class="file-button">或选择手牌照片<input type="file" id="setup-photo" accept="image/*" /></label><button class="text-btn" id="use-demo-hand">仅演示：使用固定 13 张牌</button>`;
  return `
    <div class="setup-title"><span class="section-kicker">STEP 05</span><h2>确认初始手牌</h2><p>从左到右保留物理位置。点任意牌可手动修改。</p></div>
    <div class="miss-block"><b>定缺 · 这局打哪一门</b><small>定缺后必须先打完这门牌，没打完不能胡</small><div class="miss-row">${MISSING_OPTIONS.map((o) => `<button data-missing="${o.value}" class="${setup.missingSuit === o.value ? 'selected' : ''}">${o.label}</button>`).join('')}</div></div>
    <div class="scan-summary"><span><b>${setup.scan?.source === 'VISION' ? '照片识别待核对' : '模拟手牌'}</b><small>${setup.initialHand.filter(Boolean).length}/${setup.initialHand.length} 张已确定 · ${setup.initialHand.length - setup.initialHand.filter(Boolean).length} 张待修改</small></span><span class="success-badge">${setup.handConfirmed ? '已确认' : '待确认'}</span></div>
    <div class="initial-hand-grid">${setup.initialHand.map((tile, index) => tileButton(tile, index, true)).join('')}</div><div class="hand-order"><span>左</span><div></div><span>右</span></div>
    <div class="confirm-note"><span>!</span><p><b>请逐张核对</b><small>未确认前不会写入牌局事件；样本外牌面可能识别失败。</small></p></div><button class="secondary-btn full" id="confirm-hand" ${setup.initialHand.length === 13 && setup.initialHand.every(Boolean) ? '' : 'disabled'}>确认这 13 张牌正确</button><button class="text-btn" id="rescan-hand">重新扫描</button>`;
}

function permissionRow(key, title, note, action) {
  const ready = setup.permissions[key];
  return `<div class="permission-row"><span class="permission-icon">${{ camera: '▣', microphone: '◉', audio: '◖', wake: '☀' }[key]}</span><span class="permission-copy"><b>${title}</b><small>${note}</small></span>${ready ? '<span class="permission-ok">✓ 已就绪</span>' : `<button data-permission="${key}">${action}</button>`}</div>`;
}
function bindSetupStep() {
  document.querySelectorAll('[data-missing]').forEach((button) => button.onclick = () => {
    setup.missingSuit = button.dataset.missing;
    sessionStorage.setItem('cm-missing', setup.missingSuit);
    renderSetup();
  });
  document.querySelectorAll('[data-rule]').forEach((button) => button.onclick = () => { setup.rule = button.dataset.rule; renderSetup(); });
  document.querySelectorAll('[data-seat]').forEach((button) => button.onclick = () => { setup.seat = button.dataset.seat; renderSetup(); });
  if (byId('dealer-select')) { byId('dealer-select').value = setup.dealer; byId('dealer-select').onchange = (event) => setup.dealer = event.target.value; }
  document.querySelectorAll('[data-permission]').forEach((button) => button.onclick = () => requestPermission(button.dataset.permission));
  if (byId('scan-hand')) byId('scan-hand').onclick = async () => {
    const button = byId('scan-hand'); button.disabled = true; button.textContent = '正在读取画面…';
    try {
      const image = camera.snapshot(byId('camera-preview'));
      if (!image) throw new Error('摄像头尚未准备好，请稍后重试或选择照片');
      applySetupScan(await vision.detectHand(image));
    } catch (error) { showToast(error.message); button.disabled = false; button.textContent = '拍照识别当前手牌'; }
  };
  if (byId('setup-photo')) byId('setup-photo').onchange = async (event) => {
    try { applySetupScan(await vision.detectHand(await imageFromFile(event.target.files[0]))); }
    catch (error) { showToast(error.message); }
  };
  if (byId('use-demo-hand')) byId('use-demo-hand').onclick = () => {
    setup.initialHand = [...INITIAL_HAND]; setup.scan = { source: 'MOCK' }; setup.handConfirmed = false; changeSetupStep(1);
  };
  if (byId('camera-preview')) { camera.attach(byId('camera-preview')); if (!camera.stream) camera.request(byId('camera-preview')).then(() => setup.permissions.camera = true).catch(() => showToast('摄像头未开启，可选择照片测试')); }
  document.querySelectorAll('[data-initial-index]').forEach((button) => button.onclick = () => showTilePicker((tile) => {
    const index = Number(button.dataset.initialIndex);
    setup.initialHand[index] = tile; setup.handConfirmed = false;
    if (setup.scan?.source === 'VISION') void vision.learnCorrection(setup.scan.observations[index]?.crop, tile);
    renderSetup();
  }, `修改第 ${Number(button.dataset.initialIndex) + 1} 张`));
  if (byId('confirm-hand')) byId('confirm-hand').onclick = () => { setup.handConfirmed = true; renderSetup(); };
  if (byId('rescan-hand')) byId('rescan-hand').onclick = () => { setup.step = 4; renderSetup(); };
}
function applySetupScan(result) { setup.scan = result; setup.initialHand = [...result.tiles]; setup.handConfirmed = false; changeSetupStep(1); }
function canContinueSetup() {
  if (setup.step === 3) return setup.permissions.camera && setup.permissions.microphone && setup.permissions.audio;
  if (setup.step === 4) return Boolean(setup.scan);
  if (setup.step === 5) return setup.handConfirmed && setup.initialHand.length === 13 && setup.initialHand.every(Boolean);
  return true;
}
async function requestPermission(key) {
  try {
    if (key === 'camera') await camera.request();
    if (key === 'microphone') await speech.requestPermission();
    if (key === 'audio' && !await audio.test()) throw new Error('当前浏览器无法播放语音');
    if (key === 'wake') { if ('wakeLock' in navigator) runtime.wakeLock = await navigator.wakeLock.request('screen'); else showToast('浏览器不支持常亮锁，建议关闭自动锁屏'); }
    setup.permissions[key] = true; renderSetup();
  } catch (error) { showToast(error?.message || `${key} 权限未开启`); }
}
function changeSetupStep(delta) { setup.step = Math.max(1, Math.min(5, setup.step + delta)); sessionStorage.setItem('mahjong-setup-step', String(setup.step)); renderSetup(); }
function startGame() {
  try { game.startGame({ tiles: setup.initialHand, rules: setup.rule, seat: setup.seat, dealer: setup.dealer,
    missingSuit: setup.missingSuit,
    initialSource: setup.scan?.source === 'VISION' ? 'VISION' : 'MANUAL' }); navigate('/play'); }
  catch (error) { showToast(error.message); }
}

let demoBooted = false;
function renderPlay() {
  let state = game.getState();
  if (!state.started) {
    // ?demo=1 用默认 13 张直接开一局，方便看效果。
    // 必须打标记：startGame 会触发 store 订阅 -> 又回到 renderPlay，不打标记就递归爆栈。
    if (!demoBooted && new URLSearchParams(location.search).get('demo')) {
      demoBooted = true;
      // demo=2 用一手 11 万 + 2 筒，能触发清一色方向
      const demoHand = new URLSearchParams(location.search).get('demo') === '2'
        ? ['1m','1m','2m','3m','4m','5m','6m','7m','8m','9m','1m','1p','2p']
        : INITIAL_HAND;
      game.startGame({ tiles: demoHand, rules: rulesEngine.profile.id, seat: 'east', dealer: 'self', missingSuit: setup.missingSuit });
      game.recordDraw('2m');
      state = game.getState();
    } else if (!demoBooted) { navigate('/setup'); return; }
    else { state = game.getState(); }
  }
  // 没有历史建议事件时，轮到自己且手牌够 14 张就直接算一次，不必先点模拟按钮
  let recommendation = state.lastRecommendation;
  if (!recommendation && !state.paused) {
    const selfSlots = meldSlots(state.melds.filter((meld) => meld.actor === 'self'));
    if (state.currentPlayer === 'self' && state.myHand.length === 14 - selfSlots) {
      try { recommendation = decision.analyze(state) || null; }
      catch (error) { console.warn('自动分析失败', error); }
    }
  }
  app.innerHTML = `
    <main class="play-page">
      <header class="play-header"><div><span class="round-label">第 ${state.turn} 巡</span><small>${rulesEngine.getName()}</small></div><div class="header-actions"><button class="icon-btn" id="settings" aria-label="设置">⚙</button><button class="icon-btn ${state.paused ? 'active' : ''}" id="pause" aria-label="暂停">${state.paused ? '▶' : 'Ⅱ'}</button></div></header>
      <section class="table-zone" aria-label="牌桌状态">${playerSeat('opposite', state)}${playerSeat('left', state)}${playerSeat('right', state)}<div class="table-center"><span>当前</span><b>${PLAYER_LABELS[state.currentPlayer]}</b><i></i></div></section>
      <section class="hand-panel"><div class="panel-heading"><span><b>我的手牌</b><small>从左到右</small></span><strong>${state.myHand.length}<small> 张</small></strong></div><div class="hand-row">${state.myHand.map((tile, index) => tileButton(tile.code, index)).join('')}</div><div class="vision-line"><span class="camera-dot"></span><b>${setup.scan?.source === 'VISION' ? '初始手牌已人工确认' : '模拟初始手牌'}</b><span>摸牌/弃牌仍为模拟录入</span><video id="play-camera" muted playsinline></video></div></section>
      ${recommendation && state.currentPlayer === 'self' && state.myHand.length === 14 - meldSlots(state.melds.filter((meld) => meld.actor === 'self')) ? recommendationCard(recommendation) : waitingCard(state)}
      <section class="listen-panel"><div class="listen-state"><span class="listen-orb ${audio.active ? 'locked' : ''}">${audio.active ? '🔊' : '🎤'}</span><span><b>${audio.active ? '正在播报 · 语音录入已锁定' : speech.listening ? '正在监听' : '麦克风待启动'}</b><small>${runtime.lastMessage || `当前：${PLAYER_LABELS[state.currentPlayer]}${state.currentPlayer === 'self' ? '摸牌' : '出牌'}`}</small></span></div><form class="speech-input" id="speech-form"><input id="speech-text" autocomplete="off" placeholder="也可输入：七条 / 对家碰 / 撤销" aria-label="输入语音命令" /><button>记录</button></form><div class="sim-row">${simulationControls(state)}</div></section>
      <nav class="play-nav"><button id="undo"><span>↶</span>撤销</button><button id="correct"><span>✎</span>纠正</button><button id="log"><span>≡</span>记录</button><button id="end"><span>■</span>结束</button></nav>
      ${state.paused ? '<div class="pause-overlay"><div><span>Ⅱ</span><h2>牌局已暂停</h2><p>摄像头仍可预览，语音事件停止记录。</p><button class="primary-btn" id="resume">继续牌局</button></div></div>' : ''}
      <dialog class="sheet-dialog" id="event-log">${eventLogTemplate(state.events)}</dialog><dialog class="sheet-dialog" id="settings-dialog">${settingsTemplate(state)}</dialog><dialog class="sheet-dialog" id="why-dialog">${whyTemplate(recommendation)}</dialog><dialog class="confirm-dialog" id="confirm-dialog"></dialog><dialog class="tile-dialog" id="tile-picker"></dialog><div class="toast" id="toast" role="status"></div>
    </main>`;
  bindPlay(state);
  // ?why=1 自动展开「为什么」，方便验收和截图
  if (new URLSearchParams(location.search).get('why') && byId('why')) byId('why').click();
  if (camera.stream) camera.attach(byId('play-camera'));
  ensureSpeech();
}

function playerSeat(player, state) {
  const discards = state.discardPiles[player];
  const out = (state.outPlayers || []).includes(player);
  return `<div class="player-seat seat-${player} ${state.currentPlayer === player ? 'current' : ''} ${out ? 'out' : ''}"><span class="player-name"><i></i>${PLAYER_LABELS[player]}${out ? '<em class="out-tag">已胡</em>' : ''}</span><div class="mini-river">${discards.length ? discards.slice(-6).map((item) => `<span title="${tileLabel(item.tile)}">${tileGlyph(item.tile)}</span>`).join('') : `<small>${out ? '血战中已退出' : '等待出牌'}</small>`}</div></div>`;
}
function planLabel(plan) {
  if (!plan || plan.kind === 'NORMAL') return '';
  if (plan.kind === 'PURE') return `清一色 · ${SUIT_CN[plan.suit] || ''}${plan.mainCount}张`;
  if (plan.kind === 'SEVEN') return `七对 · ${plan.pairs}对`;
  if (plan.kind === 'TRIPLETS') return `对对胡 · ${plan.triplets}刻${plan.pairs}对`;
  return '';
}

function recommendationCard(rec) {
  const tag = planLabel(rec.plan);
  // 听牌时「活口」比「有效牌种类」有意义得多 —— 一个死口只剩 1 张，跟两面 6 张不是一回事
  const quality = rec.shanten === 0
    ? `<span><small>活口</small><b>${rec.waitQuality || 0} 张</b></span>`
    : `<span><small>有效牌</small><b>${rec.usefulTiles.length} 种</b></span>`;
  const readLine = rec.reads
    ? Object.entries(rec.reads)
        .filter(([, r]) => r && r.suit && r.confidence >= 0.55)
        .map(([actor, r]) => `${PLAYER_LABELS[actor]}缺${SUIT_CN[r.suit]}`)
        .join(' · ')
    : '';
  return `<section class="recommendation-card">
    <div class="recommend-top"><span class="section-kicker">推荐出牌 · 攻守平衡</span><span class="risk-badge">${rec.risk}</span></div>
    ${tag ? `<div class="plan-line"><span class="plan-badge">${tag}</span></div>` : ''}
    <div class="recommend-main"><span class="hero-tile">${tileGlyph(rec.tile)}</span><div><h2>${tileLabel(rec.tile)}</h2><b>${rec.physicalPosition.text}</b></div></div>
    <div class="decision-meta"><span><small>向听</small><b>${rec.shanten}</b></span>${quality}<span><small>未见有效牌</small><b>${rec.remainingCount} 张</b></span></div>
    ${readLine ? `<div class="read-line">读牌：${readLine}</div>` : ''}
    <button class="why-btn" id="why">为什么？</button></section>`;
}
function waitingCard(state) {
  const selfTurn = state.currentPlayer === 'self';
  const target = 14 - meldSlots(state.melds.filter((meld) => meld.actor === 'self'));
  return `<section class="waiting-card"><span class="waiting-icon">${selfTurn ? '◫' : '···'}</span><div><span class="section-kicker">${selfTurn ? '等待摸牌' : '牌桌进行中'}</span><h3>${selfTurn ? '请用模拟按钮录入摸牌' : `等待${PLAYER_LABELS[state.currentPlayer]}出牌`}</h3><p>${selfTurn ? `实时时序检测尚未接入；目前只支持照片识别初始 ${target - 1} 张。` : '只需说出牌名，系统会自动归属当前玩家。'}</p></div></section>`;
}
function simulationControls(state) {
  if (state.currentPlayer === 'self' && state.myHand.length === 13 - meldSlots(state.melds.filter((m) => m.actor === 'self'))) return '<button type="button" data-sim="draw">模拟摸八筒</button>';
  if (state.currentPlayer === 'self' && state.myHand.length === 14 - meldSlots(state.melds.filter((m) => m.actor === 'self'))) return `<button type="button" data-sim="discard" data-tile="${state.lastRecommendation?.tile || state.myHand.at(-1)?.code}">模拟按建议出牌</button><button type="button" data-sim="discard" data-tile="6m">模拟改打六万</button>`;
  return '<button type="button" data-sim="sequence">演示下一步</button><button type="button" data-sim="call">模拟碰牌</button>';
}
function bindPlay(state) {
  byId('speech-form').onsubmit = (event) => { event.preventDefault(); const input = byId('speech-text'); handleSpeech({ ...speech.parse(input.value), confidence: 0.99, text: input.value }, 'MANUAL'); input.value = ''; };
  document.querySelectorAll('[data-sim]').forEach((button) => button.onclick = () => runSimulation(button.dataset.sim, button.dataset.tile));
  byId('pause').onclick = () => state.paused ? game.resume() : game.pause();
  if (byId('resume')) byId('resume').onclick = () => game.resume();
  byId('undo').onclick = () => confirmAction('撤销上一事件？', describeLastAction(), '确认撤销', () => { game.undoLast(); showToast('已撤销，牌局状态已重算'); });
  byId('correct').onclick = openCorrection;
  byId('log').onclick = () => byId('event-log').showModal();
  byId('settings').onclick = () => byId('settings-dialog').showModal();
  byId('end').onclick = () => confirmAction('结束当前牌局？', '结束后仍可在复盘中查看完整事件。', '结束本局', finishGame);
  if (byId('why')) byId('why').onclick = () => byId('why-dialog').showModal();
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.onclick = () => button.closest('dialog').close());
  document.querySelectorAll('[data-audio-mode]').forEach((button) => button.onclick = () => { audio.setMode(button.dataset.audioMode); renderPlay(); });
  document.querySelectorAll('[data-strategy-mode]').forEach((button) => button.onclick = () => { game.setStrategyMode(button.dataset.strategyMode); byId('settings-dialog')?.close(); showToast('策略已更新，下次摸牌按新策略计算'); });
}
async function ensureSpeech() {
  const state = game.getState();
  if (state.paused || speech.listening) return;
  try {
    const result = await speech.start((parsed) => handleSpeech(parsed, 'VOICE'), () => showToast('语音识别暂时不可用，可使用文字输入'));
    runtime.speechFallback = result.fallback;
    if (result.fallback) showToast('浏览器不支持连续识别，请使用文字输入');
    const node = document.querySelector('.listen-state b'); if (node) node.textContent = result.fallback ? '麦克风已授权 · 使用文字输入' : '正在监听';
  } catch { showToast('麦克风未开启，可使用文字输入继续'); }
}

function handleSpeech(parsed, source = 'VOICE') {
  const state = game.getState();
  if (parsed.action === 'RESUME' && state.paused) { game.resume(); return; }
  if (state.paused) { showToast('牌局已暂停，说“继续”可恢复'); return; }
  if (source === 'VOICE' && audio.active) return;
  if (!parsed.action || parsed.confidence < 0.72) { openLowConfidence(parsed); return; }
  if (parsed.action === 'UNDO') { game.undoLast(); showToast('已撤销上一事件'); return; }
  if (parsed.action === 'PAUSE') { game.pause(); return; }
  if (parsed.action === 'RESUME') { game.resume(); return; }
  if (parsed.action === 'END_GAME') { finishGame(); return; }
  if (parsed.action === 'RESCAN') { showToast('已请求重新识别手牌'); return; }
  if (parsed.action === 'UNSUPPORTED') { showToast('川麻不能吃，未记录事件'); return; }
  if (parsed.action === 'DISCARD' && parsed.tile) {
    const actor = parsed.actor || state.currentPlayer;
    runtime.lastMessage = `已记录：${PLAYER_LABELS[actor]} → ${tileLabel(parsed.tile)} ✓`;
    try { game.recordDiscard(parsed.tile, { actor, source, confidence: parsed.confidence, discardMode: parsed.discardMode }); showToast(runtime.lastMessage); }
    catch (error) { showToast(error.message); }
    return;
  }
  if (['PONG', 'KONG', 'WIN', 'PASS'].includes(parsed.action)) {
    if (parsed.action === 'WIN' && parsed.actors?.length > 1) {
      const lastDiscard = [...state.events].reverse().find((event) => event.type === 'DISCARD');
      try { game.recordMultipleRon(parsed.actors, parsed.tile || lastDiscard?.tile, lastDiscard?.id); runtime.lastMessage = `已记录一炮多响：${parsed.actors.map((actor) => PLAYER_LABELS[actor]).join('、')}`; }
      catch (error) { showToast(error.message); }
      return;
    }
    if (!parsed.actor && ['PONG', 'KONG'].includes(parsed.action)) { openActorChoice(parsed.action, parsed.tile); return; }
    const actor = parsed.actor || state.currentPlayer; runtime.lastMessage = `已记录：${PLAYER_LABELS[actor]} → ${EVENT_LABELS[parsed.action]}`;
    const lastDiscard = [...state.events].reverse().find((event) => event.type === 'DISCARD');
    const selfTsumo = actor === 'self' && state.currentPlayer === 'self' && state.myHand.length === 14;
    const isTsumo = parsed.winMethod === 'TSUMO' || selfTsumo;
    try {
      game.recordCall(actor, parsed.action, parsed.tile || (parsed.action === 'WIN' && !isTsumo ? lastDiscard?.tile : null));
      if (actor === 'self' && parsed.action === 'PONG') void recommendCurrentHand();
    } catch (error) { showToast(error.message); }
  }
}

async function runSimulation(action, tile) {
  if (action === 'draw') {
    runtime.lastMessage = '模拟摸牌：八筒 · 正在计算建议'; game.recordDraw('8p', 'MANUAL');
    await recommendCurrentHand();
    return;
  }
  if (action === 'discard') {
    const recommended = game.getState().lastRecommendation?.tile;
    runtime.lastMessage = recommended === tile ? `✓ 我打出${tileLabel(tile)}` : `实际：${tileLabel(tile)} · 推荐：${tileLabel(recommended)}`;
    game.recordDiscard(tile, { actor: 'self', source: 'MANUAL', confidence: 1 });
    showToast(runtime.lastMessage); return;
  }
  if (action === 'call') { openActorChoice('PONG'); return; }
  const nextTiles = { right: '9m', opposite: '1p', left: '7s' }; const current = game.getState().currentPlayer;
  handleSpeech({ action: 'DISCARD', tile: nextTiles[current] || '7s', actor: null, confidence: 0.99, text: tileLabel(nextTiles[current]) }, 'MANUAL');
}

async function recommendCurrentHand() {
  try {
    const rec = decision.analyze(game.getState());
    if (!rec) return;
    runtime.lastMessage = `已生成建议：${tileLabel(rec.tile)}`;
    game.recordRecommendation(rec);
    await audio.speak(audio.recommendationText(rec));
    renderPlay();
  } catch (error) { showToast(`无法推荐：${error.message}`); }
}

function openActorChoice(action, tile = null) {
  const dialog = byId('confirm-dialog');
  dialog.innerHTML = `<div class="dialog-body"><span class="section-kicker">需要确认</span><h3>谁${EVENT_LABELS[action]}？</h3><div class="actor-grid">${['left', 'opposite', 'right'].map((actor) => `<button data-actor="${actor}">${PLAYER_LABELS[actor]}</button>`).join('')}</div><button class="text-btn" data-close-dialog>取消</button></div>`;
  dialog.querySelectorAll('[data-actor]').forEach((button) => button.onclick = () => { game.recordCall(button.dataset.actor, action, tile); runtime.lastMessage = `${PLAYER_LABELS[button.dataset.actor]} → ${EVENT_LABELS[action]}`; dialog.close(); });
  dialog.querySelector('[data-close-dialog]').onclick = () => dialog.close(); dialog.showModal();
}
function openLowConfidence(parsed) {
  const dialog = byId('confirm-dialog'); if (!dialog) return;
  dialog.innerHTML = `<div class="dialog-body"><span class="section-kicker">语音置信度较低</span><h3>听到：“${escapeHtml(parsed.text || '未识别')}”？</h3><p>未修改牌局状态，请确认后再记录。</p><div class="dialog-actions"><button class="secondary-btn" data-close-dialog>取消</button>${parsed.tile ? `<button class="primary-btn compact" id="confirm-heard">确认 ${tileLabel(parsed.tile)}</button>` : ''}</div></div>`;
  dialog.querySelector('[data-close-dialog]').onclick = () => dialog.close();
  if (byId('confirm-heard')) byId('confirm-heard').onclick = () => { dialog.close(); handleSpeech({ ...parsed, confidence: 1 }, 'MANUAL'); };
  dialog.showModal();
}
function openCorrection() {
  const corrected = new Set(eventStore.getEvents().filter((event) => event.type === 'CORRECTION').map((event) => event.metadata?.corrects));
  const target = [...eventStore.getEvents()].reverse().find((event) => event.tile && ['DISCARD', 'DRAW'].includes(event.type) && !corrected.has(event.id));
  if (!target) { showToast('暂无可纠正的牌面事件'); return; }
  showTilePicker((tile) => { try { game.correct(target.id, tile); showToast(`已将${tileLabel(target.tile)}纠正为${tileLabel(tile)}`); } catch (error) { showToast(`无法纠正：${error.message}`); } }, `纠正：${PLAYER_LABELS[target.actor]} · ${tileLabel(target.tile)}`);
}
function confirmAction(title, copy, confirmLabel, callback) {
  const dialog = byId('confirm-dialog');
  dialog.innerHTML = `<div class="dialog-body"><span class="section-kicker">请确认</span><h3>${title}</h3><p>${copy}</p><div class="dialog-actions"><button class="secondary-btn" data-close-dialog>继续牌局</button><button class="danger-btn" id="dialog-confirm">${confirmLabel}</button></div></div>`;
  dialog.querySelector('[data-close-dialog]').onclick = () => dialog.close(); byId('dialog-confirm').onclick = () => { dialog.close(); callback(); }; dialog.showModal();
}
function finishGame() {
  if (!game.getState().ended) game.endGame();
  const state = game.getState(); const session = { id: state.events[0]?.id || String(Date.now()), endedAt: new Date().toISOString(), turns: state.turn, events: state.events };
  const sessions = getSessions().filter((item) => item.id !== session.id); sessions.unshift(session); localStorage.setItem('mahjong-sessions', JSON.stringify(sessions.slice(0, 10)));
  speech.stop(); navigate('/review');
}

function eventLogTemplate(events) {
  return `<div class="sheet-handle"></div><div class="sheet-head"><div><span class="section-kicker">EVENT SOURCE</span><h3>牌局记录</h3></div><button class="icon-btn" data-close-dialog>×</button></div><div class="event-list">${events.length ? events.map((event, index) => eventRow(event, index)).join('') : '<p class="empty-state">暂无记录</p>'}</div>`;
}
function eventRow(event, index) {
  const number = String(index + 1).padStart(2, '0');
  const copy = event.type === 'INITIAL_HAND' ? `识别 ${event.tiles.length} 张初始手牌` : event.type === 'CORRECTION' ? event.metadata?.operation === 'UNDO' ? `撤销事件 · ${tileLabel(event.metadata.old)}` : `${tileLabel(event.metadata?.old)} → ${tileLabel(event.tile)}` : event.type === 'RECOMMENDATION' ? `推荐 ${tileLabel(event.tile)} · ${event.metadata.physicalPosition?.text || ''}` : `${PLAYER_LABELS[event.actor] || '系统'} ${EVENT_LABELS[event.type] || event.type}${event.tile ? ` ${tileLabel(event.tile)}` : ''}`;
  return `<div class="event-row"><span>${number}</span><div><b>${copy}</b><small>${event.source} · ${formatTime(event.timestamp)}${event.confidence < 1 ? ` · ${Math.round(event.confidence * 100)}%` : ''}</small></div></div>`;
}
function settingsTemplate(state) {
  return `<div class="sheet-handle"></div><div class="sheet-head"><div><span class="section-kicker">AUDIO</span><h3>播报模式</h3></div><button class="icon-btn" data-close-dialog>×</button></div><div class="mode-list">${[['quick', '快速', '“东。”'], ['standard', '标准', '“打东，右边第二张。”'], ['coach', '教练', '附带向听与有效牌说明']].map(([value, title, copy]) => `<button data-audio-mode="${value}" class="${audio.mode === value ? 'selected' : ''}"><span><b>${title}</b><small>${copy}</small></span><i></i></button>`).join('')}</div><div class="sheet-head"><div><span class="section-kicker">STRATEGY</span><h3>出牌策略</h3></div></div><div class="mode-list">${[['DEFENSE_FIRST', '防守优先', '默认；先比较相对点炮损失'], ['BALANCED', '攻守平衡', '兼顾向听与未见有效牌'], ['ATTACK_FIRST', '进攻优先', '先比较牌效']].map(([value, title, copy]) => `<button data-strategy-mode="${value}" class="${state.strategyMode === value ? 'selected' : ''}"><span><b>${title}</b><small>${copy}</small></span><i></i></button>`).join('')}</div>`;
}

function whyTemplate(rec) {
  if (!rec) return '';

  const rows = (rec.candidates || []).slice(0, 5).map((item) => {
    const isBest = item.tile === rec.tile;
    // 方向分正负号要显式给出来，否则看不出「这张会拆牌」
    const tag = item.planScore > 0 ? '<i class="c-good">顺方向</i>'
      : item.planScore < 0 ? '<i class="c-bad">拆方向</i>' : '';
    return `<div class="cand-row ${isBest ? 'best' : ''}">
      <span class="c-glyph">${tileGlyph(item.tile)}</span>
      <span class="c-name">${tileLabel(item.tile)}${isBest ? '<em>建议</em>' : ''}</span>
      <span class="c-v">${item.shanten}向</span>
      <span class="c-v">${item.shanten === 0 ? `${item.waitQuality || 0}活口` : `${item.remainingCount}张`}</span>
      <span class="c-v">险 ${item.expectedRonLoss.toFixed(2)}</span>
      <span class="c-tag">${tag}</span>
    </div>`;
  }).join('');

  const opponents = (rec.candidates?.[0]?.opponents || []).map((o) => (
    `<div class="event-row"><span>${o.label}</span><div><b>点炮估计 ${(o.ronEstimate * 100).toFixed(1)}%</b><small>${escapeHtml(o.note)}</small></div></div>`
  )).join('');

  const planLine = rec.plan && rec.plan.kind !== 'NORMAL'
    ? `<p><b>当前主攻方向：</b>${escapeHtml(planLabel(rec.plan))}</p>` : '';

  // 有时候建议的这张是「拆方向」，而顺方向的那张被排除了。
  // 不解释一句，用户会觉得矛盾。
  const aligned = (rec.candidates || []).find((c) => c.planScore > 0 && c.shanten > rec.shanten);
  const conflictLine = aligned
    ? `<p class="cand-conflict">没打${tileLabel(aligned.tile)}：它顺方向，但打完会掉到 ${aligned.shanten} 向听，按「听牌优先」规则排除。想做大就改打它。</p>`
    : '';

  return `<div class="sheet-handle"></div>
    <div class="sheet-head"><div><span class="section-kicker">DECISION</span><h3>为什么打${tileLabel(rec.tile)}？</h3></div><button class="icon-btn" data-close-dialog>×</button></div>
    <div class="event-list">
      <p>${escapeHtml(rec.reason || '暂无说明')}</p>
      ${planLine}
      <div class="cand-head"><span>手牌</span><span>向听</span><span>进张</span><span>风险</span></div>
      <div class="cand-table">${rows}</div>
      ${conflictLine}
      <p class="cand-note">排序规则：缺门优先 → 听牌优先 → 向听差≥2 看牌效 → 活口差≥3 倍不追番 → 番型方向 → 听口多 → 策略模式。牌墙剩 ${rec.wall ?? '?'} 张${rec.defend ? '，已进入弃和' : ''}。</p>
      ${opponents}
      <p>${escapeHtml(rec.uncertainty || '对手暗手未知，风险仅供参考。')}</p>
    </div>`;
}

function renderVisionTest() {
  speech.stop();
  const result = visionTest.result;
  app.innerHTML = `<main class="setup-page vision-test-page">
    <header class="setup-header"><button class="icon-btn" id="test-home" aria-label="返回首页">‹</button><b>真实牌面测试</b><span></span></header>
    <section class="setup-content"><div class="setup-title"><span class="section-kicker">ON-DEVICE VISION</span><h2>用照片测试识别</h2><p>选择一张能看清整排手牌的照片。照片只在本机处理；目前仅以你提供的三张照片建立牌面模板，未见过的牌应手动确认。</p></div>
      <label class="file-button">选择照片<input type="file" id="test-photo" accept="image/*" /></label>
      <button class="secondary-btn full" id="test-camera">${camera.stream ? '拍摄当前画面' : '开启后置摄像头'}</button>
      <p class="test-status" id="test-status" role="status">${escapeHtml(visionTest.message)}</p>
      <div class="camera-frame test-camera-frame"><video id="test-preview" autoplay muted playsinline></video><div class="camera-placeholder"><span>摄像头预览</span></div></div>
      <label class="field-label" for="test-count">预期手牌张数</label><select class="select-control" id="test-count"><option value="13">13 张</option><option value="14">14 张</option></select>
      ${result ? `<div id="test-results" class="scan-summary"><span><b>已定位 ${result.count} 个牌位</b><small>${result.recognized} 张暂识别 · ${result.count - result.recognized} 张待确认</small></span><span class="success-badge">${escapeHtml(visionTest.imageName)}</span></div>
        ${location.hostname === '127.0.0.1' ? `<pre id="test-geometry" hidden>${JSON.stringify(result.geometry)}</pre>` : ''}
        <p class="test-caveat">牌位按预期张数分割，不等于独立验证张数。点下面任意牌可纠正；相近牌和样本外牌不要直接用于实战。</p>
        <div class="test-tile-grid">${result.observations.map((item) => `<button class="test-tile ${item.tile ? '' : 'uncertain'}" data-test-index="${item.index}" title="${item.alternatives.map((candidate) => `${candidate.tile}:${candidate.distance.toFixed(3)}`).join(' ')}"><img src="${item.crop}" alt="第 ${item.index + 1} 张牌面裁剪" /><span>${item.index + 1}. ${item.tile ? tileLabel(item.tile) : `待确认${item.candidate ? ` · 可能${tileLabel(item.candidate)}` : ''}`}</span></button>`).join('')}</div>
        <section class="sample-export"><h3>导出小样本，不传视频</h3><p>逐张核对牌名后，只导出 ${result.count} 张牌面小图和标签；不会包含整张照片。</p><label><input id="verify-samples" type="checkbox" ${visionTest.verified ? 'checked' : ''} ${result.tiles.every(Boolean) ? '' : 'disabled'} /> 我已逐张核对以上牌名</label><button class="secondary-btn full" id="export-samples" ${visionTest.verified && result.tiles.every(Boolean) ? '' : 'disabled'}>导出已标注牌面</button></section>` : '<p class="privacy-note">测试结果不会自动进入牌局。开局时请在设置流程中再次扫描并逐张确认。</p>'}
    </section><dialog class="tile-dialog" id="tile-picker"></dialog><div class="toast" id="toast" role="status"></div>
  </main>`;
  byId('test-home').onclick = () => navigate('/');
  byId('test-count').value = String(visionTest.expectedCount);
  byId('test-count').onchange = (event) => { visionTest.expectedCount = Number(event.target.value); visionTest.result = null; visionTest.verified = false; renderVisionTest(); };
  byId('test-photo').onchange = async (event) => {
    const file = event.target.files[0]; if (!file) return;
    visionTest.message = '正在分析所选照片…'; byId('test-status').textContent = visionTest.message;
    try { visionTest.imageName = file.name; visionTest.result = await vision.detectHand(await imageFromFile(file), { expectedCount: visionTest.expectedCount }); finishVisionTestScan(); }
    catch (error) { visionTest.message = error.message; renderVisionTest(); }
  };
  byId('test-camera').onclick = async () => {
    const button = byId('test-camera'); button.disabled = true;
    try {
      if (!camera.stream) {
        visionTest.message = '正在打开后置摄像头…'; byId('test-status').textContent = visionTest.message;
        await camera.request(byId('test-preview'));
        visionTest.message = '摄像头已打开。请把整排牌放在画面内，再点“拍摄当前画面”进行识别。';
        renderVisionTest(); return;
      }
      visionTest.message = '正在截取并分析当前画面…'; byId('test-status').textContent = visionTest.message;
      const image = camera.snapshot(byId('test-preview'));
      visionTest.imageName = '摄像头';
      visionTest.result = await vision.detectHand(image, { expectedCount: visionTest.expectedCount }); finishVisionTestScan();
    } catch (error) { visionTest.message = error.message; renderVisionTest(); }
  };
  if (camera.stream) camera.attach(byId('test-preview'));
  document.querySelectorAll('[data-test-index]').forEach((button) => button.onclick = () => {
    const index = Number(button.dataset.testIndex);
    showTilePicker((tile) => {
      void vision.learnCorrection(visionTest.result.observations[index].crop, tile);
      visionTest.result.observations[index].tile = tile;
      visionTest.result.tiles[index] = tile;
      visionTest.result.recognized = visionTest.result.tiles.filter(Boolean).length;
      visionTest.verified = false;
      renderVisionTest();
    }, `纠正第 ${index + 1} 张`);
  });
  if (byId('verify-samples')) byId('verify-samples').onchange = (event) => {
    visionTest.verified = event.target.checked;
    byId('export-samples').disabled = !visionTest.verified;
  };
  if (byId('export-samples')) byId('export-samples').onclick = exportVisionSamples;
  const sample = new URLSearchParams(location.search).get('sample');
  if (location.hostname === '127.0.0.1' && /^[1-3]$/.test(sample || '') && !visionTest.result) {
    const image = new Image(); image.src = `/__sample/${sample}.jpg`;
    const holdout = new URLSearchParams(location.search).has('holdout');
    image.decode().then(() => vision.detectHand(image, { expectedCount: 13, excludeRows: holdout ? [Number(sample) - 1] : [] })).then((result) => {
      visionTest.imageName = `本地测试照片 ${sample}${holdout ? ' · 留出验证' : ''}`; visionTest.result = result; finishVisionTestScan();
    }).catch((error) => { visionTest.message = error.message; renderVisionTest(); });
  }
}

function finishVisionTestScan() {
  visionTest.verified = false;
  const recognized = visionTest.result.recognized;
  visionTest.message = recognized === 0
    ? '已找到牌列，但没有一张达到自动确认门槛。请点下面的牌面核对，或靠近手牌重新拍摄。'
    : `已找到牌列，${recognized}/${visionTest.result.count} 张达到暂识别门槛。请向下逐张核对，未确定的牌不会自动写入牌局。`;
  renderVisionTest();
  requestAnimationFrame(() => byId('test-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function exportVisionSamples() {
  const result = visionTest.result;
  if (!visionTest.verified || !result?.tiles.every(Boolean)) return;
  const payload = { format: 'mahjong-tile-samples-v1', createdAt: new Date().toISOString(),
    tiles: result.observations.map((item) => ({ position: item.index + 1, tile: item.tile, image: item.crop })) };
  const file = new File([JSON.stringify(payload)], `mahjong-tiles-${Date.now()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '麻将牌面小样本' }); return; }
    catch (error) { if (error.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已导出牌面小样本');
}

async function imageFromFile(file) {
  if (!file) throw new Error('请选择照片');
  if (!file.type.startsWith('image/')) throw new Error('请使用图片文件');
  const url = URL.createObjectURL(file);
  try { const image = new Image(); image.src = url; await image.decode(); return image; }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function renderReview() {
  speech.stop();
  const state = game.getState(); const events = state.events.length ? state.events : (getSessions()[0]?.events || []);
  const voided = new Set(events.filter((event) => event.type === 'CORRECTION' && event.metadata?.operation === 'UNDO').map((event) => event.metadata.corrects));
  const activeEvents = events.filter((event) => !voided.has(event.id));
  const recommendations = activeEvents.filter((event) => event.type === 'RECOMMENDATION'); const selfDiscards = activeEvents.filter((event) => event.type === 'DISCARD' && event.actor === 'self');
  const followed = selfDiscards.filter((event) => event.metadata?.recommendedDiscard && event.metadata.recommendedDiscard === event.tile).length; const corrected = events.filter((event) => event.type === 'CORRECTION').length; const turns = Math.max(1, selfDiscards.length || state.turn - 1);
  const endedAt = [...events].reverse().find((event) => event.type === 'END_GAME')?.timestamp || new Date().toISOString();
  app.innerHTML = `<main class="review-page"><header class="review-header"><button class="icon-btn" id="review-home">×</button><span>本局复盘</span><button class="icon-btn" id="review-share" aria-label="分享">↗</button></header><section class="review-hero"><span class="section-kicker">GAME COMPLETE</span><h1>本局完成</h1><p>${formatDate(endedAt)} · ${rulesEngine.getName()}</p></section><section class="score-card"><div class="score-main"><span>${turns}</span><small>总巡数</small></div><div class="score-grid"><span><b>${recommendations.length}</b><small>系统建议</small></span><span><b>${followed}</b><small>按照建议</small></span><span><b>${Math.max(0, selfDiscards.length - followed)}</b><small>自行选择</small></span><span><b>${corrected}</b><small>识别纠错</small></span></div></section><section class="review-events"><div class="panel-heading"><span><b>完整事件记录</b><small>${events.length} 个事件 · 可追溯</small></span></div><div class="event-list">${events.map((event, index) => eventRow(event, index)).join('')}</div></section><button class="primary-btn" id="new-game">开始新牌局<span>›</span></button><div class="toast" id="toast" role="status"></div></main>`;
  byId('review-home').onclick = () => navigate('/'); byId('new-game').onclick = () => { setup.step = 1; navigate('/setup'); };
  byId('review-share').onclick = async () => { const text = `AI 麻将助手：本局 ${turns} 巡，获得 ${recommendations.length} 次建议。`; if (navigator.share) await navigator.share({ title: '本局复盘', text }).catch(() => {}); else { await navigator.clipboard?.writeText(text); showToast('复盘摘要已复制'); } };
}

function showTilePicker(callback, title = '选择牌面') {
  const dialog = byId('tile-picker'); if (!dialog) return; const groups = [['万', 'm'], ['筒', 'p'], ['条', 's']];
  dialog.innerHTML = `<div class="sheet-head"><div><span class="section-kicker">MANUAL EDIT</span><h3>${title}</h3></div><button class="icon-btn" data-close-dialog>×</button></div><div class="picker-groups">${groups.map(([label, suit]) => `<div><b>${label}</b><div>${Array.from({ length: 9 }, (_, index) => `<button data-pick-tile="${index + 1}${suit}">${tileGlyph(`${index + 1}${suit}`)}<small>${index + 1}</small></button>`).join('')}</div></div>`).join('')}</div>`;  dialog.querySelector('[data-close-dialog]').onclick = () => dialog.close(); dialog.querySelectorAll('[data-pick-tile]').forEach((button) => button.onclick = () => { dialog.close(); callback(button.dataset.pickTile); }); dialog.showModal();
}
function tileButton(tile, index, editable = false) { return `<button class="mahjong-tile ${editable ? 'editable' : ''}" ${editable ? `data-initial-index="${index}"` : 'tabindex="-1"'} aria-label="${tileLabel(tile)}"><span>${tileGlyph(tile)}</span>${editable ? `<small>${index + 1}</small>` : ''}</button>`; }
function describeLastAction() { const event = [...eventStore.getEvents()].reverse().find((item) => !['CORRECTION', 'GAME_START', 'INITIAL_HAND'].includes(item.type)); return event ? `${PLAYER_LABELS[event.actor] || '系统'} → ${EVENT_LABELS[event.type] || event.type}${event.tile ? ` ${tileLabel(event.tile)}` : ''}` : '暂无可撤销事件'; }
function getSessions() { try { return JSON.parse(localStorage.getItem('mahjong-sessions') || '[]'); } catch { return []; } }
function byId(id) { return document.getElementById(id); }
function formatTime(value) { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }
function formatDate(value) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value; return node.innerHTML; }
function showToast(message) { const toast = byId('toast'); if (!toast) return; toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2200); }

game.subscribe(() => { if (route() === 'play') renderPlay(); });
audio.subscribe(() => { if (route() === 'play') renderPlay(); });
addEventListener('popstate', render);
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && setup.permissions.wake && 'wakeLock' in navigator) runtime.wakeLock = await navigator.wakeLock.request('screen').catch(() => null); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register(`${APP_BASE}sw.js`, { scope: APP_BASE }).catch(() => {});
render();

function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const register = (tool) => Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
  register({
    name: 'read_mahjong_game_state', title: '读取当前牌局',
    description: '读取当前出牌者、手牌数量、最近建议和事件数量，不修改牌局。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      const state = game.getState();
      return { currentPlayer: state.currentPlayer, handCount: state.myHand.length, recommendation: state.lastRecommendation?.tile || null, eventCount: state.events.length, paused: state.paused };
    },
  });
  register({
    name: 'start_mock_mahjong_game', title: '开始模拟牌局',
    description: '使用已确认的默认 13 张手牌和川麻血战到底规则开始一局模拟牌局，并打开实时牌局页面。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute() {
      game.startGame({ tiles: INITIAL_HAND, rules: rulesEngine.profile.id, seat: 'east', dealer: 'self' });
      navigate('/play');
      return { started: true, currentPlayer: game.getState().currentPlayer, handCount: game.getState().myHand.length };
    },
  });
  register({
    name: 'record_mahjong_discard', title: '记录出牌',
    description: '按当前回合归属记录一张对手或自己的弃牌，并刷新可见牌局状态。',
    inputSchema: { type: 'object', properties: { tile: { type: 'string', enum: Object.keys(TILE_LABELS) } }, required: ['tile'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!input || !TILE_LABELS[input.tile]) throw new Error('tile 必须是有效麻将牌代码');
      const actor = game.getState().currentPlayer;
      const event = game.recordDiscard(input.tile, { actor, source: 'SYSTEM', confidence: 1 });
      return { eventId: event.id, actor, tile: input.tile, nextPlayer: game.getState().currentPlayer };
    },
  });
}

registerWebMcp();
