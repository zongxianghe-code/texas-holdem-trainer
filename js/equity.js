// 胜率计算：已知所有在局玩家的真实手牌，对剩余公共牌做枚举或蒙特卡洛模拟。

import { evaluate } from './evaluator.js';

/**
 * @param {object} opts
 * @param {number[][]} opts.hands 每个在局玩家的两张底牌
 * @param {number[]} [opts.board] 已发出的公共牌（0~5 张）
 * @param {number} [opts.iterations=3000] 蒙特卡洛次数（剩余 3 张及以上公共牌时使用）
 * @param {number} [opts.exactLimit=2] 剩余公共牌不超过该数量时精确枚举
 * @param {() => number} [opts.rng]
 * @returns {{equities:number[], wins:number[], ties:number[], samples:number, exact:boolean}}
 */
export function calcEquity({ hands, board = [], iterations = 3000, exactLimit = 2, rng = Math.random }) {
  const n = hands.length;
  const equities = new Array(n).fill(0);
  const wins = new Array(n).fill(0);
  const ties = new Array(n).fill(0);
  if (n === 0) return { equities, wins, ties, samples: 0, exact: true };
  if (n === 1) return { equities: [1], wins: [1], ties: [0], samples: 1, exact: true };

  const used = new Set([...hands.flat(), ...board]);
  if (used.size !== hands.length * 2 + board.length) throw new Error('存在重复的牌');
  const deck = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const need = 5 - board.length;

  const cards = hands.map((h) => [h[0], h[1], ...board, ...new Array(need).fill(0)]);
  const scores = new Array(n);
  let samples = 0;

  const runout = (extra) => {
    for (let i = 0; i < n; i++) {
      const c = cards[i];
      for (let k = 0; k < need; k++) c[2 + board.length + k] = extra[k];
      scores[i] = evaluate(c);
    }
    let best = -1;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (scores[i] > best) { best = scores[i]; count = 1; }
      else if (scores[i] === best) count++;
    }
    for (let i = 0; i < n; i++) {
      if (scores[i] === best) {
        if (count === 1) wins[i]++;
        else ties[i]++;
        equities[i] += 1 / count;
      }
    }
    samples++;
  };

  const exact = need <= exactLimit;
  if (need === 0) {
    runout([]);
  } else if (exact) {
    const extra = new Array(need);
    const rec = (start, depth) => {
      if (depth === need) { runout(extra); return; }
      for (let i = start; i < deck.length; i++) {
        extra[depth] = deck[i];
        rec(i + 1, depth + 1);
      }
    };
    rec(0, 0);
  } else {
    const d = deck.slice();
    const extra = new Array(need);
    for (let it = 0; it < iterations; it++) {
      // 部分 Fisher–Yates：只抽需要的几张
      for (let k = 0; k < need; k++) {
        const j = k + Math.floor(rng() * (d.length - k));
        const t = d[k]; d[k] = d[j]; d[j] = t;
        extra[k] = d[k];
      }
      runout(extra);
    }
  }
  for (let i = 0; i < n; i++) equities[i] /= samples;
  return { equities, wins, ties, samples, exact: need === 0 || exact };
}
