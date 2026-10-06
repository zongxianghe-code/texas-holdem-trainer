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
  assert.equal(adv.raiseTo, 25); // 开池 2.5BB
  assert.match(adv.sizeText, /2\.5BB/);
  assert.match(adviceSummary(adv), /开池加注 100%/);
  assert.equal(evaluateDecision(adv, { type: 'raise', amount: 25 }).verdict, 'good');
  const bad = evaluateDecision(adv, { type: 'fold' });
  assert.equal(bad.verdict, 'bad');
  assert.match(bad.label, /偏离/);
  assert.ok(bad.reasons.some((r) => /偏紧/.test(r)), bad.reasons.join('|'));
  assert.ok(evaluateDecision(adv, { type: 'raise', amount: 100 }).reasons.some((r) => /尺度：建议 2\.5BB/.test(r)));

  const trash = six([undefined, undefined, undefined, P('7c 2d')]);
  const a2 = getAdvice(trash);
  assert.equal(a2.primary, 'fold');
  const loose = evaluateDecision(a2, { type: 'call' });
  assert.equal(loose.verdict, 'bad');
  assert.ok(loose.reasons.some((r) => /偏松/.test(r)), loose.reasons.join('|'));
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
  assert.ok(fb.reasons.length > 0);
});

test('翻牌后建议：空气牌面对超池下注应弃牌', () => {
  const rng = mulberry32(12);
  const g = flopSpot(P('4s 3h'), P('Kd Kc'), P('Ac Kh Td 8s 9c'), 80);
  const adv = getAdvice(g, g.toAct, { iterations: 800, rng });
  assert.ok(adv.toCall === 80);
  assert.equal(adv.primary, 'fold');
  assert.ok(adv.need > 0.3);
  assert.equal(evaluateDecision(adv, { type: 'fold' }).verdict, 'good');
  const fb = evaluateDecision(adv, { type: 'call' });
  assert.equal(fb.verdict, 'bad');
  assert.ok(fb.reasons.some((r) => /跟注偏松/.test(r) && /低于/.test(r)), fb.reasons.join('|'));
  // 理由与推荐动作一致：提到赔率、胜率不足、MDF，并属于放弃的部分
  const all = adv.reasons.join('');
  assert.ok(adv.reasons.length >= 2 && adv.reasons.length <= 4);
  assert.match(all, /底池赔率要求/);
  assert.match(all, /不足/);
  assert.match(all, /MDF/);
  assert.match(all, /放弃/);
  assert.doesNotMatch(all, /胜率足够支付跟注/);
});

test('翻牌后理由：强牌给出价值理由与尺度理由', () => {
  const g = flopSpot(P('As Ah'), P('Qd Jd'), P('Ac 7d 2h 5s 9c'));
  const adv = getAdvice(g, g.toAct, { iterations: 800, rng: mulberry32(5) });
  const all = adv.reasons.join('');
  assert.ok(adv.reasons.length >= 2 && adv.reasons.length <= 4, adv.reasons.join('|'));
  assert.match(all, /价值/);
  assert.match(all, /尺度/);
  assert.match(all, /牌面/);
});

test('翻牌前尺度：以大盲为单位的常规尺度', () => {
  const sz = (g) => getAdvice(g).raiseTo;
  // 开池 2.5BB
  assert.equal(sz(six()), 25);
  // 小盲开池 3BB
  const sb = six();
  for (let i = 0; i < 4; i++) sb.act({ type: 'fold' });
  assert.equal(getAdvice(sb).position, 'SB');
  assert.equal(sz(sb), 30);
  // 有位置 3bet 3 倍：UTG 开到 25，HJ 3bet 到 75
  const ip = six();
  ip.act({ type: 'raise', amount: 25 });
  assert.equal(sz(ip), 75);
  assert.match(getAdvice(ip).sizeText, /3 倍/);
  // 无位置 3bet 4 倍：大盲面对庄位 25 → 100
  const oop = six();
  for (let i = 0; i < 3; i++) oop.act({ type: 'fold' });
  oop.act({ type: 'raise', amount: 25 });
  oop.act({ type: 'fold' });
  assert.equal(sz(oop), 100);
  // 挤压：4 倍 + 每名跟注者 1 倍 → 25 × 5 = 125
  const sq = six();
  sq.act({ type: 'raise', amount: 25 });
  sq.act({ type: 'call' });
  assert.equal(getAdvice(sq).spot.callersAfter, 1);
  assert.equal(sz(sq), 125);
  // 4bet 约 2.2 倍：25 → 3bet 75 → 4bet 165
  const fb = six();
  fb.act({ type: 'raise', amount: 25 });
  fb.act({ type: 'raise', amount: 75 });
  for (let i = 0; i < 4; i++) fb.act({ type: 'fold' });
  assert.equal(fb.toAct, 3);
  assert.equal(sz(fb), 165);
  // 5bet 全下
  fb.act({ type: 'raise', amount: 165 });
  assert.equal(sz(fb), 1000);
  assert.match(getAdvice(fb).sizeText, /全下/);
  // 隔离溜入：3BB + 每名溜入者 1BB
  const iso = six();
  iso.act({ type: 'call' });
  iso.act({ type: 'call' });
  assert.equal(sz(iso), 50);
});

test('行动面板翻牌前快捷尺度：开池 2/2.5/3BB，面对加注 3x/4x，面对 3bet 2.2x/3x', async () => {
  const { preflopQuickSizes } = await import('../js/strategy.js');
  const g = six();
  assert.deepEqual(preflopQuickSizes(g, g.getLegalActions()).map((o) => [o.label, o.to]), [['2BB', 20], ['2.5BB', 25], ['3BB', 30]]);
  g.act({ type: 'raise', amount: 25 });
  assert.deepEqual(preflopQuickSizes(g, g.getLegalActions()).map((o) => [o.label, o.to]), [['3x', 75], ['4x', 100]]);
  g.act({ type: 'raise', amount: 75 });
  assert.deepEqual(preflopQuickSizes(g, g.getLegalActions()).map((o) => o.label), ['2.2x', '3x']);
});

test('翻牌前理由：2–4 条，且与推荐动作一致', () => {
  const check = (adv) => {
    assert.ok(adv.reasons.length >= 2 && adv.reasons.length <= 4, adv.reasons.join('|'));
    for (const r of adv.reasons) assert.ok(r.length > 4);
  };
  // AA 开池：位置/范围宽度 + 尺度理由
  const aa = getAdvice(six([undefined, undefined, undefined, P('As Ad')]));
  check(aa);
  assert.match(aa.reasons[0], /身后还有 5 名玩家/);
  assert.ok(aa.reasons.some((r) => /2\.5BB/.test(r)));
  // 72o 弃牌：给出弃牌理由
  const trash = getAdvice(six([undefined, undefined, undefined, P('7c 2d')]));
  check(trash);
  assert.ok(trash.reasons.some((r) => /^弃牌/.test(r)));
  assert.ok(!trash.reasons.some((r) => /开池 2\.5BB/.test(r)));
  // 混合频率：UTG 的 98s（50%）说明为什么混合
  const mix = getAdvice(six([undefined, undefined, undefined, P('9s 8s')]));
  check(mix);
  assert.ok(mix.reasons.some((r) => /混合/.test(r)));
  // 被压制风险：BTN 开池、SB 面对时的 K8o（弃牌）
  const dom = six([undefined, P('Kc 8d')]);
  for (let i = 0; i < 3; i++) dom.act({ type: 'fold' });
  dom.act({ type: 'raise', amount: 25 });
  const d = getAdvice(dom);
  check(d);
  assert.equal(d.primary, 'fold');
  assert.ok(d.reasons.some((r) => /压制/.test(r)));
  // 阻断牌 + 无位置大尺度：小盲面对 CO 开池的 A5s（3bet 60%）
  const bl = six([undefined, P('As 5s')]);
  for (let i = 0; i < 2; i++) bl.act({ type: 'fold' });
  bl.act({ type: 'raise', amount: 25 });
  bl.act({ type: 'fold' });
  const b = getAdvice(bl);
  check(b);
  assert.equal(b.primary, 'raise');
  assert.ok(b.reasons.some((r) => /阻断/.test(r)), b.reasons.join('|'));
  assert.ok(b.reasons.some((r) => /位置劣势/.test(r)), b.reasons.join('|'));
});
