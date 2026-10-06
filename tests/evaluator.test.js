import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, createDeck, mulberry32, rankOf, suitOf } from '../js/cards.js';
import { evaluate, describeHand, categoryOf, CATEGORY } from '../js/evaluator.js';

const ev = (s) => evaluate(parseCards(s));
const name = (s) => describeHand(parseCards(s)).name;

test('各牌型中文名称', () => {
  assert.equal(name('As Kd 9h 7c 3s 2d 4h'), '高牌');
  assert.equal(name('As Ad 9h 7c 3s'), '一对');
  assert.equal(name('As Ad 9h 9c 3s Kd 2c'), '两对');
  assert.equal(name('As Ad Ah 7c 3s'), '三条');
  assert.equal(name('5s 6d 7h 8c 9s Kd Kh'), '顺子');
  assert.equal(name('Ah 2d 3c 4s 5h Kd Qd'), '顺子');
  assert.equal(name('2h 7h 9h Jh Kh As Ad'), '同花');
  assert.equal(name('As Ad Ah 7c 7s'), '葫芦');
  assert.equal(name('As Ad Ah Ac 7s'), '四条');
  assert.equal(name('5h 6h 7h 8h 9h Ah Ad'), '同花顺');
  assert.equal(name('Th Jh Qh Kh Ah 2c 3d'), '皇家同花顺');
  assert.equal(name('Ah Kd'), '高牌');
  assert.equal(name('Qh Qd'), '一对');
});

test('牌型大小顺序', () => {
  const order = [
    'As Kd 9h 7c 3s', // 高牌
    '2s 2d 4h 5c 7s', // 一对
    '2s 2d 3h 3c 5s', // 两对
    '2s 2d 2h 4c 5s', // 三条
    'As 2d 3h 4c 5s', // 顺子（最小）
    '2h 4h 5h 6h 8h', // 同花
    '2s 2d 2h 3c 3s', // 葫芦
    '2s 2d 2h 2c 3s', // 四条
    'As 2s 3s 4s 5s', // 同花顺（最小）
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(ev(order[i]) > ev(order[i - 1]), `${order[i]} 应大于 ${order[i - 1]}`);
    assert.equal(categoryOf(ev(order[i])), i);
  }
});

test('顺子：A-5 最小，A 高最大，不能绕圈', () => {
  assert.ok(ev('2s 3d 4h 5c 6s') > ev('As 2d 3h 4c 5s'));
  assert.ok(ev('Ts Jd Qh Kc As') > ev('9s Td Jh Qc Ks'));
  assert.equal(categoryOf(ev('Qs Kd Ah 2c 3s')), CATEGORY.HIGH_CARD);
  // 七张中取最大的顺子
  assert.equal(ev('4s 5d 6h 7c 8s 9d 2c'), ev('5d 6h 7c 8s 9d'));
});

test('踢脚比较', () => {
  assert.ok(ev('As Ad Kh 7c 3s') > ev('As Ad Qh Jc Ts'));
  assert.ok(ev('As Ad Kh 7c 4s') > ev('Ah Ac Kd 7d 3h'));
  assert.equal(ev('As Ad Kh 7c 4s'), ev('Ah Ac Kd 7d 4h'));
  // 两对 + 第三对：踢脚取第三对与单张中较大者
  assert.equal(ev('Ks Kd Qh Qc Js Jd 2c'), ev('Ks Kd Qh Qc Js'));
  assert.ok(ev('Ks Kd Qh Qc 3s 3d Ac') > ev('Ks Kd Qh Qc Js Jd 2c'));
  // 两个三条组成葫芦
  assert.equal(ev('9s 9d 9h 5c 5s 5d 2c'), ev('9s 9d 9h 5c 5s'));
  // 四条踢脚可以来自对子
  assert.equal(ev('7s 7d 7h 7c Ks Kd 2c'), ev('7s 7d 7h 7c Kh'));
  // 同花比较五张
  assert.ok(ev('Ah Qh 9h 5h 3h') > ev('Ah Qh 9h 5h 2h'));
  // 六张同花取最大五张
  assert.equal(ev('Ah Qh 9h 5h 3h 2h Kd'), ev('Ah Qh 9h 5h 3h'));
});

test('describeHand 给出最佳 5 张', () => {
  const d = describeHand(parseCards('Ah Kh Qh Jh Th 9h 2c'));
  assert.equal(d.name, '皇家同花顺');
  assert.equal(d.best5.length, 5);
  assert.deepEqual(d.best5.map(rankOf), [12, 11, 10, 9, 8]);
  assert.ok(d.best5.every((c) => suitOf(c) === 1));
});

test('穷举全部 2,598,960 种五张牌，牌型数量与组合数学一致', () => {
  const counts = new Array(9).fill(0);
  let royals = 0;
  const h = [0, 0, 0, 0, 0];
  for (let a = 0; a < 52; a++)
    for (let b = a + 1; b < 52; b++)
      for (let c = b + 1; c < 52; c++)
        for (let d = c + 1; d < 52; d++)
          for (let e = d + 1; e < 52; e++) {
            h[0] = a; h[1] = b; h[2] = c; h[3] = d; h[4] = e;
            const s = evaluate(h);
            const cat = categoryOf(s);
            counts[cat]++;
            if (cat === 8 && Math.floor(s / 65536) % 16 === 13) royals++;
          }
  assert.deepEqual(counts, [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
  assert.equal(royals, 4);
});

// 独立实现的朴素五张牌评估器，用来交叉验证七张牌评估
function naive5(cards) {
  const ranks = cards.map(rankOf).sort((x, y) => y - x);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const uniq = [...new Set(ranks)];
  let straight = -1;
  if (uniq.length === 5) {
    if (ranks[0] - ranks[4] === 4) straight = ranks[0];
    else if (ranks.join() === '12,3,2,1,0') straight = 3;
  }
  const groups = uniq.map((r) => [ranks.filter((x) => x === r).length, r]).sort((x, y) => y[0] - x[0] || y[1] - x[1]);
  const shape = groups.map((g) => g[0]).join('');
  const key = groups.map((g) => g[1]);
  let cat;
  if (straight >= 0 && flush) return [8, straight];
  if (shape === '41') cat = 7;
  else if (shape === '32') cat = 6;
  else if (flush) cat = 5;
  else if (straight >= 0) return [4, straight];
  else if (shape === '311') cat = 3;
  else if (shape === '221') cat = 2;
  else if (shape === '2111') cat = 1;
  else cat = 0;
  return [cat, ...key];
}
const cmpArr = (x, y) => {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
};
function naive7(cards) {
  let best = null;
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b);
      const v = naive5(five);
      if (!best || cmpArr(v, best) > 0) best = v;
    }
  return best;
}

test('随机七张牌：与朴素评估器的牌型及大小关系一致', () => {
  const rng = mulberry32(12345);
  const draw = () => {
    const d = createDeck();
    for (let i = 0; i < 7; i++) {
      const j = i + Math.floor(rng() * (52 - i));
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d.slice(0, 7);
  };
  for (let i = 0; i < 4000; i++) {
    const x = draw();
    const y = draw();
    const nx = naive7(x);
    const ny = naive7(y);
    assert.equal(categoryOf(evaluate(x)), nx[0]);
    assert.equal(Math.sign(evaluate(x) - evaluate(y)), Math.sign(cmpArr(nx, ny)));
  }
});
