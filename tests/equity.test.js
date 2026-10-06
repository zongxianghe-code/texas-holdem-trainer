import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, mulberry32 } from '../js/cards.js';
import { calcEquity } from '../js/equity.js';

const H = (s) => parseCards(s);

test('AA 对 KK 翻牌前约 82%', () => {
  const r = calcEquity({ hands: [H('As Ah'), H('Kd Kc')], iterations: 20000, rng: mulberry32(7) });
  assert.equal(r.exact, false);
  assert.ok(Math.abs(r.equities[0] - 0.82) < 0.015, `AA 胜率 ${r.equities[0]}`);
  assert.ok(Math.abs(r.equities[0] + r.equities[1] - 1) < 1e-9);
});

test('河牌：直接比较，平分底池计 50%', () => {
  const board = H('Ts Js Qs Ks As');
  const r = calcEquity({ hands: [H('2c 3d'), H('4h 5h')], board });
  assert.equal(r.exact, true);
  assert.deepEqual(r.equities, [0.5, 0.5]);
  assert.deepEqual(r.ties, [1, 1]);
});

test('转牌：精确枚举剩余 44 张', () => {
  // 玩家1 有坚果顺子，玩家2 听同花（9 张补牌）
  const r = calcEquity({ hands: [H('9c 8d'), H('4h 2h')], board: H('Th Jh Qc 3s') });
  assert.equal(r.exact, true);
  assert.equal(r.samples, 44);
  assert.ok(Math.abs(r.equities[1] - 9 / 44) < 1e-9, `听花胜率 ${r.equities[1]}`);
});

test('翻牌：精确枚举两张，三人胜率和为 1', () => {
  const r = calcEquity({ hands: [H('As Ad'), H('Kh Kd'), H('7c 8c')], board: H('2c 5c Ks') });
  assert.equal(r.exact, true);
  assert.equal(r.samples, (43 * 42) / 2);
  const sum = r.equities.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(r.equities[1] > r.equities[0]);
});

test('重复的牌会报错', () => {
  assert.throws(() => calcEquity({ hands: [H('As Ad'), H('As Kd')] }));
});
