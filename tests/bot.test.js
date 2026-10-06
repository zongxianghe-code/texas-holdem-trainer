import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, mulberry32 } from '../js/cards.js';
import { HoldemGame } from '../js/engine.js';
import { decideBotAction, legalize } from '../js/bot.js';
import { allowedSizes, BET_SIZES, potFractionTo } from '../js/strategy.js';

const P = parseCards;
const sum = (a) => a.reduce((x, y) => x + y, 0);

/** 跑电脑对局，校验每一步的合法性和尺度 */
function runBots({ seed, games, maxHands, difficulty, players, stack, iterations = 60 }) {
  const rng = mulberry32(seed);
  const stats = { hands: 0, actions: 0, raises: 0, showdowns: 0, sidePots: 0, games: 0 };
  for (let gi = 0; gi < games; gi++) {
    const n = players ?? 2 + (gi % 5);
    const g = new HoldemGame({
      numPlayers: n,
      startingStack: stack ?? 100 + Math.floor(rng() * 1900),
      smallBlind: 5,
      bigBlind: 10,
      dealerSeat: gi % n,
      rng,
    });
    const total = g.totalChips;
    let h = 0;
    while (g.phase !== 'gameOver' && h < maxHands) {
      g.startHand();
      h++;
      let guard = 0;
      while (g.phase === 'betting') {
        assert.ok(guard++ < 300, '一手牌没有结束');
        const la = g.getLegalActions();
        const d = decideBotAction(g, { rng, difficulty, iterations });
        // 合法性（在执行前独立检查）
        if (d.type === 'check') assert.ok(la.canCheck, '非法过牌');
        if (d.type === 'call') assert.ok(la.canCall, '非法跟注');
        if (d.type === 'fold') assert.ok(!la.canCheck, '能免费过牌时不应弃牌');
        if (d.type === 'bet' || d.type === 'raise') {
          assert.ok(la.canRaise, '非法加注');
          assert.ok(d.amount >= la.minRaiseTo && d.amount <= la.maxRaiseTo, `加注金额越界 ${d.amount}`);
          const allowed = allowedSizes(la).map((s) => s.to);
          assert.ok(allowed.includes(d.amount), `尺度 ${d.amount} 不在四种允许尺度 ${allowed} 中`);
          stats.raises++;
        }
        g.act(d); // 若非法，引擎会抛出异常导致测试失败
        stats.actions++;
        assert.equal(g.totalChips, total, '筹码不守恒');
      }
      assert.equal(sum(g.players.map((p) => p.stack)), total);
      assert.equal(sum(Object.values(g.result.winnings)), g.result.totalPot);
      if (g.result.type === 'showdown') {
        stats.showdowns++;
        if (g.result.pots.length > 1) stats.sidePots++;
      }
    }
    stats.hands += h;
    stats.games++;
  }
  return stats;
}

test('电脑对局（标准难度，2–6 人，随机筹码）：数千手牌无非法动作、筹码守恒、每手都能结束', () => {
  const s = runBots({ seed: 42, games: 60, maxHands: 60, difficulty: 'standard' });
  assert.ok(s.hands >= 2000, `只跑了 ${s.hands} 手`);
  assert.ok(s.raises > 500);
  assert.ok(s.showdowns > 100);
  assert.ok(s.sidePots > 0, '应出现过边池');
});

test('电脑对局（简单难度，6 人 100BB）', () => {
  const s = runBots({ seed: 7, games: 10, maxHands: 120, difficulty: 'easy', players: 6, stack: 1000 });
  assert.ok(s.hands >= 500, `只跑了 ${s.hands} 手`);
});

test('电脑对局（短筹码，频繁全下）', () => {
  const s = runBots({ seed: 99, games: 40, maxHands: 40, difficulty: 'standard', players: 6, stack: 150 });
  assert.ok(s.hands >= 200);
});

test('legalize 总能把任意意图转为合法动作', () => {
  const rng = mulberry32(3);
  const g = new HoldemGame({ numPlayers: 4, rng });
  let checked = 0;
  for (let h = 0; h < 50 && g.phase !== 'gameOver'; h++) {
    g.startHand();
    while (g.phase === 'betting') {
      const la = g.getLegalActions();
      for (const intent of [
        { type: 'fold' }, { type: 'check' }, { type: 'call' }, { type: 'raise', amount: -5 },
        { type: 'raise', amount: 1e9 }, { type: 'bet', amount: NaN }, { type: 'allin' }, { type: 'dance' }, null,
      ]) {
        const a = legalize(intent, la);
        if (a.type === 'check') assert.ok(la.canCheck);
        else if (a.type === 'call') assert.ok(la.canCall);
        else if (a.type === 'fold') assert.ok(!la.canCheck);
        else {
          assert.ok(la.canRaise);
          assert.ok(a.amount >= la.minRaiseTo && a.amount <= la.maxRaiseTo);
        }
        checked++;
      }
      g.act(decideBotAction(g, { rng, iterations: 40 }));
    }
  }
  assert.ok(checked > 100);
});

test('四种下注尺度：1/3、1/2、2/3、4/3 底池，并限制在合法区间', () => {
  assert.deepEqual(BET_SIZES.map((b) => b.frac), [1 / 3, 1 / 2, 2 / 3, 4 / 3]);
  // 翻牌后底池 60，无人下注
  const la = { currentBet: 0, bet: 0, pot: 60, minRaiseTo: 10, maxRaiseTo: 1000 };
  assert.deepEqual(allowedSizes(la).map((s) => s.to), [20, 30, 40, 80]);
  // 面对下注 30（底池 90 含该下注）：加注到 = 30 + f × (90 + 30)
  const la2 = { currentBet: 30, bet: 0, pot: 90, minRaiseTo: 60, maxRaiseTo: 500 };
  assert.deepEqual(allowedSizes(la2).map((s) => s.to), [70, 90, 110, 190]);
  // 限制：最小加注与全下
  const la3 = { currentBet: 0, bet: 0, pot: 15, minRaiseTo: 10, maxRaiseTo: 18 };
  assert.deepEqual(allowedSizes(la3).map((s) => s.to), [10, 10, 10, 18]);
  assert.throws(() => potFractionTo(la, 1));
});

test('电脑不偷看对手底牌：对手底牌不同但公开信息相同时决策相同', () => {
  const board = P('Kd 7c 2h 9s 3d');
  const make = (oppHole) => {
    const g = new HoldemGame({ numPlayers: 3, dealerSeat: 0 });
    g.startHand({ hole: [P('Ah Kh'), oppHole[0], oppHole[1]], board });
    g.act({ type: 'raise', amount: 25 }); // 座位 0（庄家）
    g.act({ type: 'call' }); // 小盲
    g.act({ type: 'call' }); // 大盲
    g.act({ type: 'check' }); // 翻牌 小盲
    g.act({ type: 'bet', amount: 40 }); // 大盲下注
    return g; // 轮到座位 0 面对下注
  };
  const g1 = make([P('Qs Qd'), P('8c 8d')]);
  const g2 = make([P('5s 4s'), P('Jc Tc')]);
  assert.equal(g1.toAct, 0);
  for (let seed = 1; seed <= 5; seed++) {
    const a = decideBotAction(g1, { rng: mulberry32(seed), iterations: 200 });
    const b = decideBotAction(g2, { rng: mulberry32(seed), iterations: 200 });
    assert.deepEqual({ ...a }, { ...b });
  }
});
