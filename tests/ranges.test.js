import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards } from '../js/cards.js';
import {
  RANGE_SPECS, HAND_CLASSES, CLASS_COMBOS, getTable, parseRange, rangeWidth, handClassOf, gridHand, comboCount,
} from '../js/ranges.js';

test('169 种起手牌、1326 种组合', () => {
  assert.equal(HAND_CLASSES.length, 169);
  assert.equal(new Set(HAND_CLASSES).size, 169);
  assert.equal(HAND_CLASSES.reduce((s, h) => s + comboCount(h), 0), 1326);
  assert.equal([...CLASS_COMBOS.values()].reduce((s, a) => s + a.length, 0), 1326);
  assert.equal(gridHand(0, 0), 'AA');
  assert.equal(gridHand(0, 1), 'AKs');
  assert.equal(gridHand(1, 0), 'AKo');
  assert.equal(gridHand(12, 12), '22');
  assert.equal(handClassOf(...parseCards('Kh Ah')), 'AKs');
  assert.equal(handClassOf(...parseCards('7c 2d')), '72o');
  assert.equal(handClassOf(...parseCards('9c 9d')), '99');
});

test('范围记法解析', () => {
  assert.deepEqual([...parseRange('TT+').keys()], ['TT', 'JJ', 'QQ', 'KK', 'AA']);
  assert.deepEqual([...parseRange('22-44').keys()], ['22', '33', '44']);
  assert.deepEqual([...parseRange('ATs+').keys()], ['ATs', 'AJs', 'AQs', 'AKs']);
  assert.deepEqual([...parseRange('A5s-A2s').keys()].sort(), ['A2s', 'A3s', 'A4s', 'A5s']);
  assert.deepEqual([...parseRange('AK').keys()], ['AKs', 'AKo']);
  assert.equal(parseRange('*').size, 169);
  assert.equal(parseRange('K9s:0.5').get('K9s'), 0.5);
  assert.throws(() => parseRange('AA:2'));
  assert.throws(() => parseRange('XYZ'));
});

test('每张范围表覆盖全部 169 手牌，频率在 [0,1] 且加注+跟注+弃牌=1', () => {
  for (const key of Object.keys(RANGE_SPECS)) {
    const t = getTable(key);
    assert.equal(t.size, 169, key);
    for (const h of HAND_CLASSES) {
      const f = t.get(h);
      assert.ok(f, `${key} 缺少 ${h}`);
      for (const k of ['raise', 'call', 'fold']) assert.ok(f[k] >= 0 && f[k] <= 1, `${key} ${h} ${k}=${f[k]}`);
      assert.ok(Math.abs(f.raise + f.call + f.fold - 1) < 1e-9, `${key} ${h} 频率和不为 1`);
    }
  }
});

test('范围合理性：开池范围随位置变宽，强牌总是继续，垃圾牌弃掉', () => {
  const w = ['UTG', 'HJ', 'CO', 'BTN'].map((p) => rangeWidth(`RFI_${p}`));
  for (let i = 1; i < w.length; i++) assert.ok(w[i] > w[i - 1], `RFI 宽度 ${w}`);
  assert.ok(w[0] > 0.12 && w[0] < 0.22, `UTG 开池 ${w[0]}`);
  assert.ok(w[3] > 0.38 && w[3] < 0.55, `BTN 开池 ${w[3]}`);
  for (const key of Object.keys(RANGE_SPECS)) {
    const aa = getTable(key).get('AA');
    assert.equal(aa.fold, 0, `${key} 不应弃 AA`);
  }
  for (const p of ['UTG', 'HJ', 'CO']) assert.equal(getTable(`RFI_${p}`).get('72o').fold, 1);
  assert.ok(rangeWidth('BB_vs_BTN', 'any') > rangeWidth('BB_vs_EP', 'any'));
  assert.ok(rangeWidth('BB_vs_limp', 'any') === 1, '大盲面对溜入可以免费看牌');
  assert.equal(getTable('RFI_UTG').get('AKo').raise, 1);
});
