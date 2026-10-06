import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, mulberry32 } from '../js/cards.js';
import { HoldemGame, computePots } from '../js/engine.js';

const P = parseCards;
const stacks = (g) => g.players.map((p) => p.stack);
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('单挑：庄家下小盲且翻牌前先行动，翻牌后大盲先行动', () => {
  const g = new HoldemGame({ numPlayers: 2, startingStack: 1000, smallBlind: 5, bigBlind: 10, dealerSeat: 0 });
  g.startHand();
  assert.equal(g.dealer, 0);
  assert.equal(g.sbSeat, 0);
  assert.equal(g.bbSeat, 1);
  assert.equal(g.players[0].bet, 5);
  assert.equal(g.players[1].bet, 10);
  assert.equal(g.toAct, 0);
  g.act({ type: 'call' });
  assert.equal(g.toAct, 1, '大盲有选择权');
  const la = g.getLegalActions();
  assert.ok(la.canCheck && la.canRaise);
  g.act({ type: 'check' });
  assert.equal(g.street, 'flop');
  assert.equal(g.board.length, 3);
  assert.equal(g.toAct, 1, '翻牌后非庄家（大盲）先行动');
  g.act({ type: 'check' });
  assert.equal(g.toAct, 0);
  g.act({ type: 'check' });
  assert.equal(g.street, 'turn');
  assert.equal(g.toAct, 1);
  g.act({ type: 'bet', amount: 20 });
  g.act({ type: 'fold' });
  assert.equal(g.phase, 'handOver');
  assert.deepEqual(stacks(g), [990, 1010]);

  // 下一手庄家轮换
  g.startHand();
  assert.equal(g.dealer, 1);
  assert.equal(g.sbSeat, 1);
  assert.equal(g.toAct, 1);
});

test('多人：枪口位先行动，大盲有选择权，翻牌后小盲先行动', () => {
  const g = new HoldemGame({ numPlayers: 4, dealerSeat: 0 });
  g.startHand();
  assert.equal(g.sbSeat, 1);
  assert.equal(g.bbSeat, 2);
  assert.equal(g.toAct, 3);
  g.act({ type: 'call' }); // UTG
  assert.equal(g.toAct, 0);
  g.act({ type: 'call' }); // 庄家
  g.act({ type: 'call' }); // 小盲
  assert.equal(g.toAct, 2);
  assert.equal(g.street, 'preflop');
  g.act({ type: 'check' }); // 大盲过牌
  assert.equal(g.street, 'flop');
  assert.equal(g.pot, 40);
  assert.equal(g.toAct, 1);

  // 三人桌：庄家就是翻牌前第一个行动的人
  const g3 = new HoldemGame({ numPlayers: 3, dealerSeat: 1 });
  g3.startHand();
  assert.equal(g3.dealer, 1);
  assert.equal(g3.sbSeat, 2);
  assert.equal(g3.bbSeat, 0);
  assert.equal(g3.toAct, 1);
});

test('最小加注规则', () => {
  const g = new HoldemGame({ numPlayers: 3, dealerSeat: 0 });
  g.startHand();
  let la = g.getLegalActions();
  assert.equal(la.minRaiseTo, 20);
  assert.throws(() => g.act({ type: 'raise', amount: 15 }), /最小加注到 20/);
  g.act({ type: 'raise', amount: 30 }); // 加注 20
  la = g.getLegalActions();
  assert.equal(la.minRaiseTo, 50);
  assert.throws(() => g.act({ type: 'raise', amount: 49 }));
  g.act({ type: 'raise', amount: 80 }); // 加注 50
  la = g.getLegalActions();
  assert.equal(la.minRaiseTo, 130);
  g.act({ type: 'call' });
  g.act({ type: 'call' });
  assert.equal(g.street, 'flop');
  la = g.getLegalActions();
  assert.equal(la.raiseType, 'bet');
  assert.equal(la.minRaiseTo, 10, '翻牌后最小下注为一个大盲');
  assert.throws(() => g.act({ type: 'bet', amount: 5 }));
  g.act({ type: 'bet', amount: 25 });
  assert.equal(g.getLegalActions().minRaiseTo, 50);
});

test('不足额全下加注不会重新开放加注权', () => {
  const g = new HoldemGame({ stacks: [150, 1000, 1000, 1000], dealerSeat: 0 });
  g.startHand();
  assert.equal(g.toAct, 3);
  g.act({ type: 'raise', amount: 100 }); // UTG 加注 90
  assert.equal(g.toAct, 0);
  g.act({ type: 'allin' }); // 庄家全下 150，只多 50，不足额
  assert.equal(g.currentBet, 150);
  assert.equal(g.minRaise, 90);
  // 小盲还没行动过，可以加注，最小加注到 150 + 90
  let la = g.getLegalActions();
  assert.equal(g.toAct, 1);
  assert.ok(la.canRaise);
  assert.equal(la.minRaiseTo, 240);
  g.act({ type: 'call' });
  g.act({ type: 'call' }); // 大盲
  // UTG 已行动且之后没有完整加注：只能跟注或弃牌
  assert.equal(g.toAct, 3);
  la = g.getLegalActions();
  assert.equal(la.canRaise, false);
  assert.equal(la.toCall, 50);
  assert.throws(() => g.act({ type: 'raise', amount: 300 }));
  g.act({ type: 'call' });
  assert.equal(g.street, 'flop');
  assert.equal(g.pot, 600);
});

test('完整加注后，已行动的玩家可以再加注', () => {
  const g = new HoldemGame({ numPlayers: 3, dealerSeat: 0 });
  g.startHand();
  g.act({ type: 'raise', amount: 30 }); // 庄家
  g.act({ type: 'raise', amount: 90 }); // 小盲再加注
  g.act({ type: 'call' }); // 大盲
  assert.equal(g.toAct, 0);
  assert.ok(g.getLegalActions().canRaise);
});

test('边池：三人不同筹码全下，按层级分配，并退还未被跟注部分', () => {
  const g = new HoldemGame({ stacks: [500, 300, 100], dealerSeat: 0 });
  g.startHand({
    hole: [P('Qs Qh'), P('Ks Kh'), P('As Ah')],
    board: P('2c 7d 9h Jc 3s'),
  });
  assert.equal(g.toAct, 0);
  g.act({ type: 'allin' }); // 500
  const la = g.getLegalActions();
  assert.ok(la.callIsAllIn);
  g.act({ type: 'call' }); // 小盲全下 300
  g.act({ type: 'call' }); // 大盲全下 100
  assert.equal(g.phase, 'handOver');
  assert.equal(g.board.length, 5);
  const { pots, winnings } = g.result;
  assert.deepEqual(pots.map((p) => p.amount), [300, 400]);
  assert.deepEqual(pots[0].eligible.sort(), [0, 1, 2]);
  assert.deepEqual(pots[1].eligible.sort(), [0, 1]);
  assert.deepEqual(pots[0].winners, [2]);
  assert.deepEqual(pots[1].winners, [1]);
  assert.deepEqual(winnings, { 1: 400, 2: 300 });
  assert.deepEqual(stacks(g), [200, 400, 300]);
  assert.ok(g.log.some((e) => e.text.includes('未被跟注的 200 退还给 玩家1')));
  assert.equal(g.players[0].out, false);
});

test('边池：短筹码赢主池，大筹码之间比边池', () => {
  const g = new HoldemGame({ stacks: [100, 300, 500], dealerSeat: 0 });
  g.startHand({
    hole: [P('As Ah'), P('Ks Kh'), P('Qs Qh')],
    board: P('2c 7d 9h Jc 3s'),
  });
  g.act({ type: 'allin' });
  g.act({ type: 'allin' });
  // 其他人都已全下，大盲不能再加注，全下等于跟注
  assert.equal(g.getLegalActions().canRaise, false);
  g.act({ type: 'allin' });
  assert.deepEqual(g.result.pots.map((p) => p.amount), [300, 400]);
  assert.deepEqual(stacks(g), [300, 400, 200]);
  assert.equal(sum(stacks(g)), 900);
});

test('平分底池：零头筹码给庄家左侧最近的赢家', () => {
  const g = new HoldemGame({ numPlayers: 3, dealerSeat: 0 });
  g.startHand({ hole: [P('2c 3d'), P('4c 5d'), P('6c 7d')], board: P('Ts Js Qs Ks As') });
  g.act({ type: 'call' }); // 庄家跟注 10
  g.act({ type: 'fold' }); // 小盲弃牌（5 成为死钱）
  g.act({ type: 'check' }); // 大盲
  for (let i = 0; i < 6; i++) g.act({ type: 'check' });
  assert.equal(g.phase, 'handOver');
  assert.equal(g.result.type, 'showdown');
  assert.equal(g.result.pots.length, 1);
  assert.deepEqual(g.result.pots[0].winners, [2, 0]);
  assert.equal(g.result.pots[0].handName, '皇家同花顺');
  assert.deepEqual(stacks(g), [1002, 995, 1003]);
});

test('主池平分、边池单独结算', () => {
  // 玩家1 与 玩家2 同为 AK 顺子平分主池，玩家3 投入更多但输掉
  const g = new HoldemGame({ stacks: [200, 200, 600], dealerSeat: 2 });
  g.startHand({
    hole: [P('Ad Kd'), P('Ac Kc'), P('Qh Qc')],
    board: P('Ts Js Qs 2h 3d'),
  });
  // dealer 2, sb 0, bb 1, 先行动 2
  assert.equal(g.toAct, 2);
  g.act({ type: 'raise', amount: 600 });
  g.act({ type: 'call' });
  g.act({ type: 'call' });
  assert.equal(g.result.pots.length, 1);
  assert.equal(g.result.pots[0].amount, 600);
  assert.deepEqual(g.result.pots[0].winners.sort(), [0, 1]);
  assert.deepEqual(stacks(g), [300, 300, 400]);
});

test('所有人弃牌：大盲赢得盲注', () => {
  const g = new HoldemGame({ numPlayers: 3, dealerSeat: 0 });
  g.startHand();
  g.act({ type: 'fold' });
  g.act({ type: 'fold' });
  assert.equal(g.phase, 'handOver');
  assert.equal(g.result.type, 'fold');
  assert.deepEqual(stacks(g), [1000, 995, 1005]);
});

test('大盲筹码不足：单挑时直接发完公共牌并退还多余小盲', () => {
  const g = new HoldemGame({ stacks: [1000, 3], dealerSeat: 0 });
  g.startHand({ hole: [P('As Ah'), P('7c 2d')], board: P('Kc 9d 4h 3s Jc') });
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.board.length, 5);
  assert.deepEqual(stacks(g), [1003, 0]);
  assert.equal(g.winner, 0);
  assert.ok(g.log.some((e) => e.text.includes('未被跟注的 2 退还给 玩家1')));
});

test('大盲全下不足一个大盲时，其他人仍需跟注完整大盲', () => {
  const g = new HoldemGame({ stacks: [1000, 1000, 4], dealerSeat: 0 });
  g.startHand({ hole: [P('As Ah'), P('Ks Kh'), P('7c 2d')], board: P('Qc 9d 4h 3s Jc') });
  assert.ok(g.players[2].allIn);
  assert.equal(g.getLegalActions().toCall, 10);
  g.act({ type: 'call' });
  g.act({ type: 'call' });
  assert.equal(g.street, 'flop');
  for (let i = 0; i < 6; i++) g.act({ type: 'check' });
  assert.deepEqual(g.result.pots.map((p) => p.amount), [12, 12]);
  assert.deepEqual(stacks(g), [1014, 990, 0]);
  assert.ok(g.players[2].out);
});

test('玩家出局后庄家轮换跳过该座位，最后剩一人时游戏结束', () => {
  const g = new HoldemGame({ stacks: [100, 1000, 1000], dealerSeat: 0 });
  g.startHand({ hole: [P('7c 2d'), P('As Ah'), P('Ks Kh')], board: P('Qc 9d 4h 3s Jc') });
  g.act({ type: 'allin' }); // 玩家1 全下 100
  g.act({ type: 'call' }); // 玩家2 跟注
  g.act({ type: 'fold' }); // 玩家3 弃牌
  assert.equal(g.phase, 'handOver');
  assert.ok(g.players[0].out);
  assert.deepEqual(stacks(g), [0, 1110, 990]);

  g.startHand({ hole: [undefined, P('As Ah'), P('Ks Kh')], board: P('Qc 9d 4h 3s Jc') });
  assert.equal(g.dealer, 1);
  assert.equal(g.sbSeat, 1, '只剩两人：庄家下小盲');
  assert.equal(g.bbSeat, 2);
  assert.equal(g.toAct, 1);
  assert.deepEqual(g.players[0].holeCards, []);
  g.act({ type: 'allin' });
  g.act({ type: 'call' });
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winner, 1);
  assert.equal(g.players[1].stack, 2100);
  assert.equal(g.startHand(), false);
});

test('computePots：含弃牌玩家死钱的多层边池', () => {
  const pots = computePots([
    { seat: 0, amount: 50, folded: false },
    { seat: 1, amount: 200, folded: false },
    { seat: 2, amount: 120, folded: true },
    { seat: 3, amount: 200, folded: false },
  ]);
  assert.deepEqual(pots, [
    { amount: 200, eligible: [0, 1, 3] },
    { amount: 370, eligible: [1, 3] },
  ]);
});

test('非法动作会被拒绝', () => {
  const g = new HoldemGame({ numPlayers: 2, dealerSeat: 0 });
  assert.throws(() => g.act({ type: 'check' }), /不在下注阶段/);
  g.startHand();
  assert.throws(() => g.act({ type: 'check' }), /不能过牌/);
  assert.throws(() => g.act({ type: 'raise', amount: 5000 }), /筹码不足/);
  assert.throws(() => g.act({ type: 'dance' }));
  assert.throws(() => new HoldemGame({ numPlayers: 10 }));
  assert.throws(() => new HoldemGame({ smallBlind: 20, bigBlind: 10 }));
});

test('随机对局压力测试：筹码守恒（含重新买入）、状态一致', () => {
  const rng = mulberry32(2026);
  for (let game = 0; game < 40; game++) {
    const n = 2 + (game % 8);
    const allowRebuy = game % 3 === 0;
    const g = new HoldemGame({ numPlayers: n, startingStack: 200 + Math.floor(rng() * 800), smallBlind: 5, bigBlind: 10, rng, allowRebuy });
    let total = g.totalChips; // 初始筹码 + 重新买入
    let hands = 0;
    // 随机全下 + 按平均筹码买入会让总筹码几何增长（多人同时输光时尤甚），买入局在总量过大前停止
    while (g.phase !== 'gameOver' && hands < 150 && total < 1e12) {
      if (allowRebuy) for (const r of g.rebuyBusted()) total += r.amount;
      assert.equal(g.totalBuyIn, total);
      g.startHand();
      hands++;
      let guard = 0;
      while (g.phase === 'betting') {
        assert.ok(guard++ < 500, '下注轮没有结束');
        const la = g.getLegalActions();
        const p = g.players[g.toAct];
        assert.ok(!p.folded && !p.allIn && !p.out);
        const r = rng();
        if (la.canRaise && r < 0.25) {
          const amt = la.minRaiseTo + Math.floor(rng() * (la.maxRaiseTo - la.minRaiseTo + 1));
          g.act({ type: 'raise', amount: amt });
        } else if (la.canAllIn && r < 0.3) {
          g.act({ type: 'allin' });
        } else if (la.canCall && r < 0.45) {
          g.act({ type: 'fold' });
        } else if (la.canCheck) {
          g.act({ type: 'check' });
        } else {
          g.act({ type: 'call' });
        }
        assert.equal(g.totalChips, total);
        for (const q of g.players) {
          assert.ok(q.stack >= 0);
          assert.ok(q.bet <= g.currentBet || q.bet === 0);
        }
      }
      assert.equal(sum(stacks(g)), total, '每手结束后筹码总数不变');
      assert.ok(g.result);
      const won = sum(Object.values(g.result.winnings));
      assert.equal(won, g.result.totalPot);
      if (g.result.type === 'showdown') assert.equal(g.board.length, 5);
    }
  }
});
