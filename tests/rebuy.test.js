import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards } from '../js/cards.js';
import { HoldemGame } from '../js/engine.js';

const P = parseCards;

/** 3 人桌：座位 2（大盲，60 筹码）全下输给座位 0 → 座位 2 输光 */
function bustHand(opts = {}) {
  const g = new HoldemGame({ stacks: [1000, 1003, 60], dealerSeat: 0, ...opts });
  g.startHand({ hole: [P('As Ad'), P('7c 2d'), P('Kh Qh')], board: P('2c 7d 9s Jc 3s') });
  g.act({ type: 'raise', amount: 75 }); // 座位 0
  g.act({ type: 'fold' }); // 座位 1 小盲
  g.act({ type: 'call' }); // 座位 2 全下跟注 60
  assert.equal(g.phase === 'handOver' || g.phase === 'gameOver', true);
  return g;
}

test('重新买入金额：未输光玩家的平均筹码，取整到大盲', () => {
  const g = bustHand();
  assert.deepEqual(g.players.map((p) => p.stack), [1065, 998, 0]);
  assert.equal(g.players[2].out, true);
  assert.equal(g.rebuyAmount(), 1030); // (1065 + 998) / 2 = 1031.5 → 1030
  const r = g.rebuyBusted();
  assert.deepEqual(r, [{ seat: 2, amount: 1030 }]);
  const p = g.players[2];
  assert.equal(p.stack, 1030);
  assert.equal(p.out, false);
  assert.equal(p.rebuys, 1);
  assert.equal(p.buyIn, 1090);
  assert.equal(g.netProfit(2), -60);
  assert.equal(g.netProfit(0), 65);
  assert.equal(g.netProfit(1), -5);
  assert.equal(g.totalChips, g.totalBuyIn);
  assert.equal(g.totalBuyIn, 1000 + 1003 + 60 + 1030);
  const log = g.log.filter((e) => e.kind === 'rebuy');
  assert.equal(log.length, 1);
  assert.match(log[0].text, /玩家3 重新买入 1030（第 1 次，累计买入 1090，净盈亏 -60）/);
  // 下一手仍是 3 人桌
  g.startHand();
  assert.equal(g.players.filter((q) => q.holeCards.length === 2).length, 3);
});

test('重新买入的限制：牌局进行中不能买入，有筹码不需要买入', () => {
  const g = new HoldemGame({ numPlayers: 3 });
  g.startHand();
  assert.throws(() => g.rebuy(0), /进行中/);
  assert.deepEqual(g.rebuyBusted(), []);
  const h = bustHand();
  assert.throws(() => h.rebuy(0), /还有筹码/);
  assert.throws(() => h.rebuy(2, 0), /正整数/);
});

test('允许重新买入时只剩一人也不会直接结束；关闭时结束，但仍可通过买入继续', () => {
  const hu = (allowRebuy) => {
    const g = new HoldemGame({ stacks: [100, 100], dealerSeat: 0, allowRebuy });
    g.startHand({ hole: [P('As Ad'), P('7c 2d')], board: P('2c 8d 9s Jc 3s') });
    g.act({ type: 'allin' });
    g.act({ type: 'call' });
    return g;
  };
  const on = hu(true);
  assert.equal(on.phase, 'handOver');
  assert.equal(on.players[1].out, true);
  assert.equal(on.startHand(), false, '不买入则无法开始下一手');
  const on2 = hu(true);
  on2.rebuyBusted();
  assert.equal(on2.players[1].stack, 200, '买入金额 = 剩余玩家平均筹码');
  assert.notEqual(on2.startHand(), false);

  const off = hu(false);
  assert.equal(off.phase, 'gameOver');
  off.rebuy(1);
  assert.equal(off.phase, 'handOver');
  assert.equal(off.winner, null);
  assert.notEqual(off.startHand(), false);
});

test('重新买入金额下限：至少 1 个大盲，且不低于 min(20BB, 初始筹码)', () => {
  const g = bustHand();
  g.players[0].stack = 30;
  g.players[1].stack = 40;
  assert.equal(g.rebuyAmount(), 200); // 平均 35 → 下限 20BB = 200
  const tiny = new HoldemGame({ stacks: [50, 50, 50], smallBlind: 5, bigBlind: 10 });
  tiny.players[0].stack = 0;
  tiny.players[1].stack = 4;
  tiny.players[2].stack = 6;
  tiny.players[0].out = true;
  assert.equal(tiny.rebuyAmount(), 50); // 平均 5 → 下限 min(200, 50) = 50
});

test('人机桌：只为电脑自动买入，人类玩家需要自己选择', () => {
  const g = bustHand({ allowRebuy: true });
  const human = 2;
  assert.deepEqual(g.rebuyBusted((p) => p.seat !== human), []);
  assert.equal(g.players[human].out, true);
  g.rebuy(human);
  assert.equal(g.players[human].rebuys, 1);
});
