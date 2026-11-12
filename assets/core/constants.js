/**
 * 川麻（血战到底）牌与常量
 *
 * 108 张：万 / 筒 / 条 各 1-9，每种 4 张。没有字牌，没有花牌。
 * 索引 0-8 万，9-17 筒，18-26 条 —— 和标准 34 位数组的前 27 位对齐，
 * 算法里只用 0-26。
 */

export const SUITS = ['m', 'p', 's'];
export const SUIT_CN = { m: '万', p: '筒', s: '条' };
export const SUIT_OFFSET = { m: 0, p: 9, s: 18 };
export const TILE_TYPES = 27;

export const PLAYERS = ['self', 'right', 'opposite', 'left'];

export const PLAYER_LABELS = {
  self: '我',
  right: '下家',
  opposite: '对家',
  left: '上家',
};

export const NEXT_PLAYER = {
  self: 'right',
  right: 'opposite',
  opposite: 'left',
  left: 'self',
};

const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export const TILE_LABELS = {};
export const TILE_GLYPHS = {};
const GLYPH_BASE = { m: 0x1F007, p: 0x1F019, s: 0x1F010 };

for (const suit of SUITS) {
  for (let n = 1; n <= 9; n += 1) {
    const code = `${n}${suit}`;
    TILE_LABELS[code] = `${CN_NUM[n]}${SUIT_CN[suit]}`;
    TILE_GLYPHS[code] = String.fromCodePoint(GLYPH_BASE[suit] + (n - 1));
  }
}

export const TILE_CODES_ORDER = Object.keys(TILE_LABELS);

/** 一条在川麻里叫幺鸡 */
export const ALIASES = { '1s': ['幺鸡', '一条'] };

export const INITIAL_HAND = ['1m', '2m', '3m', '4m', '5m', '6m', '2p', '3p', '4p', '5p', '6p', '7p', '1m'];

export const EVENT_LABELS = {
  GAME_START: '开局', INITIAL_HAND: '初始手牌', DRAW: '摸牌', DISCARD: '打出',
  PONG: '碰', KONG: '杠', WIN: '胡', PASS: '过', STRATEGY_MODE: '策略',
  RECOMMENDATION: '建议', CORRECTION: '纠错', PAUSE: '暂停', RESUME: '继续', END_GAME: '结束',
  SET_MISSING: '定缺',
};

/** 定缺：川麻开局必须选一门打完，打完之前不能胡 */
export const MISSING_OPTIONS = [
  { value: 'm', label: '缺万' },
  { value: 'p', label: '缺筒' },
  { value: 's', label: '缺条' },
];

export function tileLabel(code) { return TILE_LABELS[code] || code || '—'; }
export function tileGlyph(code) { return TILE_GLYPHS[code] || '◻'; }

export function suitOf(code) { return code ? code.at(-1) : ''; }
export function isMissing(code, missingSuit) { return Boolean(missingSuit) && suitOf(code) === missingSuit; }
