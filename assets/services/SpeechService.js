const NUMBERS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ACTORS = { 上家: 'left', 对家: 'opposite', 下家: 'right', 我: 'self', 自己: 'self' };
const ACTIONS = { 碰: 'PONG', 杠: 'KONG', 自摸: 'WIN', 荣和: 'WIN', 胡: 'WIN', 过: 'PASS' };

export class SpeechService {
  constructor(isLocked = () => false) {
    this.isLocked = isLocked; this.stream = null; this.recognition = null; this.listening = false; this.onResult = null;
  }

  async requestPermission() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风访问');
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
    }
    return this.stream;
  }

  async start(onResult, onError = () => {}) {
    this.onResult = onResult;
    await this.requestPermission();
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { this.listening = true; return { fallback: true }; }
    if (this.recognition) { this.listening = true; return { fallback: false }; }
    this.recognition = new Recognition();
    Object.assign(this.recognition, { lang: 'zh-CN', continuous: true, interimResults: false, maxAlternatives: 3 });
    this.recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const text = result[0].transcript.trim();
      if (this.isLocked()) return;
      onResult({ ...this.parse(text), confidence: Number(result[0].confidence || 0.86), text });
    };
    this.recognition.onerror = (event) => { if (!['no-speech', 'aborted'].includes(event.error)) onError(event.error); };
    this.recognition.onend = () => {
      if (this.listening) setTimeout(() => { try { this.recognition.start(); } catch {} }, 350);
    };
    this.listening = true;
    try { this.recognition.start(); } catch {}
    return { fallback: false };
  }

  stop() { this.listening = false; if (this.recognition) { try { this.recognition.stop(); } catch {} this.recognition = null; } }

  parse(input) {
    const text = String(input || '').replace(/[，。！？,.!?\s]/g, '');
    const actors = [...new Set(Object.entries(ACTORS).filter(([name]) => text.includes(name)).map(([, value]) => value))];
    const actor = actors[0] || null;
    const actionEntry = Object.entries(ACTIONS).find(([name]) => text.includes(name));
    const systemCommands = [
      ['结束本局', 'END_GAME'], ['重新识别', 'RESCAN'], ['继续', 'RESUME'], ['暂停', 'PAUSE'], ['撤销', 'UNDO'],
    ];
    const systemAction = systemCommands.find(([name]) => text.includes(name))?.[1];
    if (systemAction) return { text: input, action: systemAction, actor, actors, tile: parseTile(text), confidence: 0.98 };
    if (text.includes('吃')) return { text: input, action: 'UNSUPPORTED', actor, actors, tile: parseTile(text), confidence: 0.99 };
    return { text: input, action: actionEntry?.[1] || (parseTile(text) ? 'DISCARD' : null), actor, actors, tile: parseTile(text), winMethod: text.includes('自摸') ? 'TSUMO' : text.includes('荣和') ? 'RON' : null, discardMode: text.includes('摸切') ? 'draw' : text.includes('手切') ? 'hand' : 'unknown', confidence: parseTile(text) ? 0.96 : actionEntry ? 0.9 : 0.45 };
  }
}

function parseTile(text) {
  const honors = [
    ['红中', 'red'], ['中', 'red'], ['发财', 'green'], ['发', 'green'], ['白板', 'white'], ['白', 'white'],
    ['东风', 'east'], ['东', 'east'], ['南风', 'south'], ['南', 'south'], ['西风', 'west'], ['西', 'west'], ['北风', 'north'], ['北', 'north'],
  ];
  const honor = honors.find(([name]) => text.includes(name));
  if (honor) return honor[1];
  if (text.includes('幺鸡')) return '1s';
  const match = text.match(/([一二两三四五六七八九1-9])([万筒饼条索])/);
  if (!match) return null;
  const number = Number(match[1]) || NUMBERS[match[1]];
  const suit = match[2] === '万' ? 'm' : ['筒', '饼'].includes(match[2]) ? 'p' : 's';
  return `${number}${suit}`;
}
