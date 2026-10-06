import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, mulberry32 } from '../js/cards.js';
import { HoldemGame } from '../js/engine.js';
import { getAdvice, evaluateDecision, adviceSummary, describeHandClass, POSTFLOP_DISCLAIMER } from '../js/advice.js';
import { getPositions, classifyPreflopSpot, allowedSizes, detectDraws, analyzeTexture } from '../js/strategy.js';

const P = parseCards;
const near1 = (x) => Math.abs(x - 1) < 1e-9;

/** 6 人桌，庄家座位 0：SB=1, BB=2, UTG=3, HJ=4, CO=5 */
function six(hole = [], board) {
  const g = new HoldemGame({ numPlayers: 6, startingStack: 1000, dealerSeat: 0 });
  g.startHand({ hole, board });
  return g;
}

test('位置识别：6 人、3 人、单挑', () => {
  const g = six();
  assert.deepEqual(getPositions(g), { 0: 'BTN', 1: 'SB', 2: 'BB', 3: 'UTG', 4: 'HJ', 5: 'CO' });
  const g3 = new HoldemGame({ numPlayers: 3, dealerSeat: 1 });
  g3.startHand();
  assert.deepEqual(getPositions(g3), { 1: 'BTN', 2: 'SB', 0: 'BB' });
  const hu = new HoldemGame({ numPlayers: 2, dealerSeat: 0 });
  hu.startHand();
  assert.deepEqual(getPositions(hu), { 0: 'BTN', 1: 'BB' });
});

test('翻牌前点位识别：开池、面对开池、3bet、冷 4bet、4bet、溜入', () => {
  const pos = { 0: 'BTN', 1: 'SB', 2: 'BB', 3: 'UTG', 4: 'HJ', 5: 'CO' };
  const A = (seat, action, amount) => ({ seat, action, amount });
  assert.equal(classifyPreflopSpot(3, [], pos).key, 'RFI_UTG');
  assert.equal(classifyPreflopSpot(0, [A(3, 'fold'), A(4, 'fold'), A(5, 'raise', 25)], pos).key, 'IP_vs_LP');
  assert.equal(classifyPreflopSpot(2, [A(3, 'raise', 25)], pos).key, 'BB_vs_EP');
  assert.equal(classifyPreflopSpot(2, [A(0, 'raise', 25), A(1, 'fold')], pos).key, 'BB_vs_BTN');
  assert.equal(classifyPreflopSpot(1, [A(5, 'raise', 25)], pos).key, 'SB_vs_LP');
  assert.equal(classifyPreflopSpot(3, [A(3, 'raise', 25), A(0, 'raise', 75)], pos).key, 'EP_vs_3bet');
  assert.equal(classifyPreflopSpot(2, [A(3, 'raise', 25), A(0, 'raise', 75)], pos).key, 'COLD_vs_3bet');
  const s4 = classifyPreflopSpot(0, [A(3, 'raise', 25), A(0, 'raise', 75), A(3, 'raise', 180)], pos);
  assert.equal(s4.type, 'vs4bet');
  assert.equal(classifyPreflopSpot(5, [A(3, 'call', 10)], pos).key, 'ISO_CO');
  assert.equal(classifyPreflopSpot(2, [A(3, 'call', 10), A(1, 'call', 10)], pos).key, 'BB_vs_limp');
});

test('翻牌前建议：UTG 的 AA 加注、72o 弃牌，并给出反馈', () => {
  const aa = six([undefined, undefined, undefined, P('As Ad')]);
  const adv = getAdvice(aa);
  assert.equal(adv.street, 'preflop');
  assert.equal(adv.tableKey, 'RFI_UTG');
  assert.equal(adv.handClass, 'AA');
  assert.equal(adv.handCategory, '大口袋对子');
  assert.equal(adv.freqs.raise, 1);
  assert.equal(adv.primary, 'raise');
  assert.ok(near1(adv.freqs.raise + adv.freqs.call + adv.freqs.fold));
  assert.ok(allowedSizes(aa.getLegalActions()).some((s) => s.to === adv.raiseTo), '翻牌前加注尺度也只用四种比例');
  assert.equal(adv.raiseTo, 27); // 10 + 2/3 × (15 + 10)
  assert.match(adv.sizeText, /2\/3 池/);
  assert.match(adviceSummary(adv), /开池加注 100%/);
  assert.equal(evaluateDecision(adv, { type: 'raise', amount: 27 }).verdict, 'good');
  const bad = evaluateDecision(adv, { type: 'fold' });
  assert.equal(bad.verdict, 'bad');
  assert.match(bad.label, /偏离/);
  assert.match(bad.text, /偏紧/);
  assert.match(evaluateDecision(adv, { type: 'raise', amount: 100 }).text, /尺度/);

  const trash = six([undefined, undefined, undefined, P('7c 2d')]);
  const a2 = getAdvice(trash);
  assert.equal(a2.primary, 'fold');
  const loose = evaluateDecision(a2, { type: 'call' });
  assert.equal(loose.verdict, 'bad');
  assert.match(loose.text, /偏松/);
});

test('翻牌前建议：大盲面对庄位开池时防守，可免费过牌时不建议弃牌', () => {
  const g = six([undefined, undefined, P('9h 8h')]);
  g.act({ type: 'fold' }); // UTG
  g.act({ type: 'fold' }); // HJ
  g.act({ type: 'fold' }); // CO
  g.act({ type: 'raise', amount: 25 }); // BTN
  g.act({ type: 'fold' }); // SB
  const adv = getAdvice(g);
  assert.equal(adv.tableKey, 'BB_vs_BTN');
  assert.ok(adv.freqs.call + adv.freqs.raise > 0.9);

  const limp = six([undefined, undefined, P('7c 2d')]);
  for (let i = 0; i < 4; i++) limp.act({ type: i === 3 ? 'call' : 'fold' }); // UTG/HJ/CO 弃，BTN 溜入
  limp.act({ type: 'call' }); // SB 补盲
  const a2 = getAdvice(limp);
  assert.equal(a2.tableKey, 'BB_vs_limp');
  assert.equal(a2.freqs.fold, 0);
  assert.equal(a2.primary, 'call');
  assert.equal(a2.names.call, '过牌');
});

test('起手牌类别描述', () => {
  assert.equal(describeHandClass('AKs'), '同花高张');
  assert.equal(describeHandClass('A5s'), '同花 A（Axs）');
  assert.equal(describeHandClass('98s'), '同花连张');
  assert.equal(describeHandClass('55'), '小口袋对子');
  assert.equal(describeHandClass('72o'), '杂色杂牌');
});

test('牌面与听牌识别', () => {
  const d = detectDraws(P('Ah 5h'), P('Kh 9h 2c'));
  assert.ok(d.flushDraw);
  const s = detectDraws(P('9c 8d'), P('7h 6s 2c'));
  assert.ok(s.oesd);
  const gs = detectDraws(P('9c 8d'), P('Jh 7s 2c'));
  assert.ok(gs.gutshot && !gs.oesd);
  assert.ok(analyzeTexture(P('Ah 7c 2d')).dry);
  assert.ok(analyzeTexture(P('9h 8h 7c')).wet);
  assert.ok(analyzeTexture(P('Kh 9h 4h')).monotone);
});

/** 构造一个翻牌圈局面：庄家（座位 0）开池，大盲跟注 */
function flopSpot(heroHole, villainHole, board, villainBets) {
  const g = new HoldemGame({ numPlayers: 3, dealerSeat: 0 });
  g.startHand({ hole: [heroHole, P('2c 3c'), villainHole], board });
  g.act({ type: 'raise', amount: 25 });
  g.act({ type: 'fold' });
  g.act({ type: 'call' });
  if (villainBets) g.act({ type: 'bet', amount: villainBets });
  else g.act({ type: 'check' });
  return g;
}

test('翻牌后建议：带免责声明、频率和为 1、尺度只用四种比例', () => {
  const rng = mulberry32(11);
  const g = flopSpot(P('As Ah'), P('Qd Jd'), P('Ac 7d 2h 5s 9c'));
  const adv = getAdvice(g, g.toAct, { iterations: 800, rng });
  assert.equal(adv.disclaimer, POSTFLOP_DISCLAIMER);
  assert.equal(POSTFLOP_DISCLAIMER, '近似建议，非求解器结果');
  assert.ok(near1(adv.actions.reduce((s, a) => s + a.freq, 0)));
  assert.ok(near1(adv.groups.aggressive + adv.groups.passive + adv.groups.fold));
  assert.ok(adv.equity > 0.85, `顶三条胜率 ${adv.equity}`);
  assert.match(adv.category, /价值/);
  assert.equal(adv.primary, 'aggressive');
  const allowed = allowedSizes(g.getLegalActions()).map((s) => s.to);
  for (const a of adv.actions) {
    if (a.kind === 'bet' || a.kind === 'raise') {
      assert.ok([1 / 3, 1 / 2, 2 / 3, 4 / 3].includes(a.size), `尺度 ${a.size}`);
      assert.ok(allowed.includes(a.to));
    }
  }
  const fb = evaluateDecision(adv, { type: 'check' });
  assert.ok(['ok', 'bad', 'good'].includes(fb.verdict));
  assert.match(fb.text, /近似建议/);
});

test('翻牌后建议：空气牌面对超池下注应弃牌', () => {
  const rng = mulberry32(12);
  const g = flopSpot(P('4s 3h'), P('Kd Kc'), P('Ac Kh Td 8s 9c'), 80);
  const adv = getAdvice(g, g.toAct, { iterations: 800, rng });
  assert.ok(adv.toCall === 80);
  assert.equal(adv.primary, 'fold');
  assert.ok(adv.need > 0.3);
  assert.equal(evaluateDecision(adv, { type: 'fold' }).verdict, 'good');
  assert.equal(evaluateDecision(adv, { type: 'call' }).verdict, 'bad');
});
