import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, mulberry32 } from '../js/cards.js';
import { HoldemGame } from '../js/engine.js';
import { decideBotAction } from '../js/bot.js';
import { isHoleVisible, buildHandReview, reviewLogLines, actionSummary } from '../js/review.js';

const P = parseCards;
const opts = { mode: 'bot', humanSeat: 0, showAll: false, reviewBots: true };

test('开启“每手结束后查看电脑手牌”：手牌进行中电脑底牌绝不可见，结束后（含弃牌的电脑）全部可见', () => {
  const rng = mulberry32(21);
  const g = new HoldemGame({ numPlayers: 6, startingStack: 1000, rng });
  let foldedHands = 0;
  let checks = 0;
  for (let h = 0; h < 120 && g.phase !== 'gameOver'; h++) {
    g.startHand();
    while (g.phase === 'betting') {
      for (const p of g.players) {
        if (p.seat === 0) continue;
        assert.equal(isHoleVisible(g, p.seat, opts), false, `第 ${g.handNumber} 手进行中暴露了 ${p.name} 的底牌`);
        checks++;
      }
      assert.throws(() => buildHandReview(g, [1, 2, 3, 4, 5]), /尚未结束/);
      g.act(decideBotAction(g, { rng, iterations: 60 }));
    }
    const dealt = g.players.filter((p) => p.seat !== 0 && p.holeCards.length === 2);
    for (const p of dealt) assert.equal(isHoleVisible(g, p.seat, opts), true, `${p.name} 结束后应可见`);
    // 关闭复盘时，只有摊牌的电脑可见
    for (const p of dealt) {
      assert.equal(isHoleVisible(g, p.seat, { ...opts, reviewBots: false }), !!g.result.hands[p.seat]);
    }
    const review = buildHandReview(g, dealt.map((p) => p.seat));
    assert.equal(review.length, dealt.length);
    if (g.result.type === 'fold') foldedHands++;
    for (const r of review) {
      assert.equal(r.cards.length, 2);
      assert.ok(r.actions.length > 0);
      if (r.folded) assert.ok(r.foldStreet);
    }
  }
  assert.ok(foldedHands > 5, '应包含无人摊牌就结束的手牌');
  assert.ok(checks > 1000);
});

test('复盘内容：弃牌结束的手牌也列出每个电脑的底牌与动作', () => {
  const g = new HoldemGame({ numPlayers: 3, dealerSeat: 0 });
  g.startHand({ hole: [P('As Ks'), P('7c 2d'), P('Qh Qd')], board: P('2c 7d 9h Jc 3s') });
  g.act({ type: 'raise', amount: 25 }); // 座位 0（人类）
  g.act({ type: 'fold' }); // 电脑2 小盲
  g.act({ type: 'raise', amount: 100 }); // 电脑3 大盲 3bet
  g.act({ type: 'fold' }); // 人类弃牌
  assert.equal(g.result.type, 'fold');
  const review = buildHandReview(g, [1, 2]);
  assert.deepEqual(review.map((r) => r.cardsText), ['7♣ 2♦', 'Q♥ Q♦']);
  assert.equal(review[0].folded, true);
  assert.equal(review[0].foldStreet, '翻牌前');
  assert.equal(review[1].folded, false);
  assert.equal(review[1].won, 55); // 25 + 5 + 25（未被跟注的 75 已退还）
  assert.equal(review[1].handName, null, '未发翻牌时没有牌型');
  assert.equal(actionSummary(g, 2), '翻牌前 加注到 100');
  const lines = reviewLogLines(review);
  assert.match(lines[0], /复盘：玩家2 底牌 7♣ 2♦（翻牌前弃牌）/);
  assert.match(lines[1], /玩家3 底牌 Q♥ Q♦（赢得 55）/);
});

test('复盘：发完公共牌时给出最终牌型与最佳五张', () => {
  const g = new HoldemGame({ numPlayers: 2, dealerSeat: 0 });
  g.startHand({ hole: [P('As Ks'), P('Qh Qd')], board: P('2c 7d 9h Jc 3s') });
  g.act({ type: 'call' });
  for (let i = 0; i < 7; i++) g.act({ type: 'check' });
  const [r] = buildHandReview(g, [1]);
  assert.equal(r.boardComplete, true);
  assert.equal(r.handName, '一对');
  assert.equal(r.best5.length, 5);
});

test('自对弈模式的可见性：隐藏模式下只显示当前行动者', () => {
  const g = new HoldemGame({ numPlayers: 3, dealerSeat: 0 });
  g.startHand();
  const hs = { mode: 'hotseat', showAll: false };
  assert.equal(isHoleVisible(g, g.toAct, hs), true);
  for (const p of g.players) if (p.seat !== g.toAct) assert.equal(isHoleVisible(g, p.seat, hs), false);
  assert.equal(isHoleVisible(g, 1, { mode: 'hotseat', showAll: true }), true);
});
