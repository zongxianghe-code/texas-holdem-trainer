// 手牌评估：从 2~7 张牌中找出最佳 5 张组合（纯逻辑，无 DOM）
// evaluate() 返回一个整数分数，分数越大牌越大，可直接比较。

import { rankOf, suitOf } from './cards.js';

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

export const CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
export const ROYAL_FLUSH_NAME = '皇家同花顺';

const CATEGORY_BASE = 16 ** 5; // 1048576

// 复用的临时数组（JS 单线程，安全）
const counts = new Int8Array(13);
const suitCounts = new Int8Array(4);
const suitMasks = new Int32Array(4);

/** 返回顺子的最高张（0..12），A-2-3-4-5 返回 3（即 5），没有返回 -1 */
function straightHigh(mask) {
  for (let h = 12; h >= 4; h--) {
    if (((mask >> (h - 4)) & 31) === 31) return h;
  }
  if ((mask & 0x100f) === 0x100f) return 3; // A,2,3,4,5
  return -1;
}

function score(category, k0 = -1, k1 = -1, k2 = -1, k3 = -1, k4 = -1) {
  // rank+1 编码，0 表示“无”，保证少于 5 张牌时也能比较
  return category * CATEGORY_BASE + (k0 + 1) * 65536 + (k1 + 1) * 4096 + (k2 + 1) * 256 + (k3 + 1) * 16 + (k4 + 1);
}

/** 评估 2~7 张牌，返回分数 */
export function evaluate(cards) {
  counts.fill(0);
  suitCounts.fill(0);
  suitMasks.fill(0);
  let rankMask = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const r = c >> 2;
    const s = c & 3;
    counts[r]++;
    suitCounts[s]++;
    suitMasks[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCounts[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    const sf = straightHigh(suitMasks[flushSuit]);
    if (sf >= 0) return score(8, sf);
  }

  let quad = -1;
  let t0 = -1, t1 = -1;
  let p0 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const n = counts[r];
    if (n === 4) { if (quad < 0) quad = r; }
    else if (n === 3) { if (t0 < 0) t0 = r; else if (t1 < 0) t1 = r; }
    else if (n === 2) { if (p0 < 0) p0 = r; else if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }

  if (quad >= 0) {
    let kicker = -1;
    for (let r = 12; r >= 0; r--) if (r !== quad && counts[r] > 0) { kicker = r; break; }
    return score(7, quad, kicker);
  }
  if (t0 >= 0 && (t1 >= 0 || p0 >= 0)) {
    return score(6, t0, Math.max(t1, p0));
  }
  if (flushSuit >= 0) {
    const m = suitMasks[flushSuit];
    const ks = [];
    for (let r = 12; r >= 0 && ks.length < 5; r--) if (m & (1 << r)) ks.push(r);
    return score(5, ks[0], ks[1], ks[2], ks[3], ks[4]);
  }
  const st = straightHigh(rankMask);
  if (st >= 0) return score(4, st);

  if (t0 >= 0) {
    const ks = topKickers(rankMask, [t0], 2);
    return score(3, t0, ks[0], ks[1]);
  }
  if (p1 >= 0) {
    const ks = topKickers(rankMask, [p0, p1], 1);
    return score(2, p0, p1, ks[0]);
  }
  if (p0 >= 0) {
    const ks = topKickers(rankMask, [p0], 3);
    return score(1, p0, ks[0], ks[1], ks[2]);
  }
  const ks = topKickers(rankMask, [], 5);
  return score(0, ks[0], ks[1], ks[2], ks[3], ks[4]);
}

function topKickers(rankMask, exclude, n) {
  const out = [];
  for (let r = 12; r >= 0 && out.length < n; r--) {
    if ((rankMask & (1 << r)) && !exclude.includes(r)) out.push(r);
  }
  return out;
}

export const categoryOf = (s) => Math.floor(s / CATEGORY_BASE);

/** 由分数得到中文牌型名 */
export function scoreName(s) {
  const cat = categoryOf(s);
  if (cat === 8 && Math.floor(s / 65536) % 16 === 13) return ROYAL_FLUSH_NAME; // 顶张为 A
  return CATEGORY_NAMES[cat];
}

/** 详细描述：分数、牌型、名称、组成最佳牌型的 5 张牌 */
export function describeHand(cards) {
  const s = evaluate(cards);
  let best5 = cards.slice();
  if (cards.length > 5) {
    const n = cards.length;
    outer: for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++)
          for (let d = c + 1; d < n; d++)
            for (let e = d + 1; e < n; e++) {
              const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
              if (evaluate(combo) === s) { best5 = combo; break outer; }
            }
  }
  best5.sort((x, y) => rankOf(y) - rankOf(x) || suitOf(x) - suitOf(y));
  return { score: s, category: categoryOf(s), name: scoreName(s), best5 };
}

/** 比较两手牌：>0 表示 a 大 */
export const compareHands = (a, b) => evaluate(a) - evaluate(b);
