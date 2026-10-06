// 牌与牌堆工具（纯逻辑，无 DOM）
// 一张牌用 0..51 的整数表示：rank = card >> 2（0=2 … 12=A），suit = card & 3（0=♠ 1=♥ 2=♦ 3=♣）

export const RANK_CHARS = '23456789TJQKA';
export const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUIT_CHARS = 'shdc';
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];

export const rankOf = (card) => card >> 2;
export const suitOf = (card) => card & 3;
export const makeCard = (rank, suit) => rank * 4 + suit;
export const isRed = (card) => suitOf(card) === 1 || suitOf(card) === 2;

/** 解析 "As" / "Td" / "10h" / "A♠" 形式的牌 */
export function parseCard(str) {
  const s = String(str).trim();
  if (s.length < 2) throw new Error(`无法解析的牌: ${str}`);
  let rankStr = s.slice(0, -1).toUpperCase();
  const suitStr = s.slice(-1);
  if (rankStr === '10') rankStr = 'T';
  const rank = RANK_CHARS.indexOf(rankStr);
  let suit = SUIT_CHARS.indexOf(suitStr.toLowerCase());
  if (suit < 0) suit = SUIT_SYMBOLS.indexOf(suitStr);
  if (rank < 0 || suit < 0 || rankStr.length !== 1) throw new Error(`无法解析的牌: ${str}`);
  return makeCard(rank, suit);
}

/** 解析以空格分隔的多张牌，如 "As Kd 7h" */
export function parseCards(str) {
  if (Array.isArray(str)) return str.map(parseCard);
  return String(str).trim().split(/\s+/).filter(Boolean).map(parseCard);
}

/** 显示用：A♠ / 10♥ */
export const cardToString = (card) => RANK_LABELS[rankOf(card)] + SUIT_SYMBOLS[suitOf(card)];
/** 代码用：As / Th */
export const cardCode = (card) => RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
export const cardsToString = (cards) => cards.map(cardToString).join(' ');

export function createDeck() {
  return Array.from({ length: 52 }, (_, i) => i);
}

/** 默认随机源：优先使用 crypto（更均匀），否则回退到 Math.random */
export function defaultRng() {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return Math.random();
}

/** Fisher–Yates 原地洗牌；rng() 返回 [0,1) */
export function shuffle(arr, rng = defaultRng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** 可复现的伪随机数生成器（测试用） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
