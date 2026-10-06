// 底牌可见性与每手结束后的复盘（纯逻辑，无 DOM）。

import { cardsToString } from './cards.js';
import { describeHand } from './evaluator.js';
import { STREET_NAMES } from './engine.js';

/**
 * 某座位的底牌此刻能否展示给用户。
 * @param {object} game
 * @param {number} seat
 * @param {{mode:'bot'|'hotseat', humanSeat:number, showAll:boolean, reviewBots:boolean}} opts
 */
export function isHoleVisible(game, seat, { mode = 'bot', humanSeat = 0, showAll = false, reviewBots = false } = {}) {
  const p = game.players[seat];
  if (!p.holeCards.length) return false;
  if (showAll) return true;
  const handDone = game.phase === 'handOver' || game.phase === 'gameOver';
  if (mode === 'bot') {
    if (seat === humanSeat) return true;
    if (handDone && reviewBots) return true; // 每手结束后复盘：包括弃牌的电脑
    return handDone && !!game.result?.hands?.[seat]; // 摊牌亮牌
  }
  if (game.phase === 'betting') return seat === game.toAct;
  return handDone && !!game.result?.hands?.[seat];
}

/** 某玩家本手的动作摘要，如 “翻牌前 加注到 25 → 翻牌 下注 21 → 转牌 弃牌” */
export function actionSummary(game, seat) {
  const acts = game.log.filter((e) => e.hand === game.handNumber && e.kind === 'action' && e.seat === seat);
  if (!acts.length) return '未主动行动';
  const name = game.players[seat].name;
  return acts.map((e) => `${STREET_NAMES[e.street]} ${e.text.slice(name.length + 1)}`).join(' → ');
}

/**
 * 一手结束后的复盘数据（只能在本手结束后调用）。
 * @param {number[]} seats 需要复盘的座位（如所有电脑座位）
 */
export function buildHandReview(game, seats) {
  if (game.phase === 'betting') throw new Error('本手尚未结束，不能复盘底牌');
  return seats
    .filter((s) => game.players[s].holeCards.length === 2)
    .map((s) => {
      const p = game.players[s];
      const full = game.board.length === 5;
      const desc = game.board.length >= 3 ? describeHand([...p.holeCards, ...game.board]) : null;
      const foldEntry = game.log.find((e) => e.hand === game.handNumber && e.seat === s && e.action === 'fold');
      return {
        seat: s,
        name: p.name,
        cards: p.holeCards.slice(),
        cardsText: cardsToString(p.holeCards),
        folded: !!foldEntry,
        foldStreet: foldEntry ? STREET_NAMES[foldEntry.street] : null,
        handName: desc ? desc.name : null,
        best5: full && desc ? desc.best5 : null,
        boardComplete: full,
        won: game.result?.winnings?.[s] || 0,
        actions: actionSummary(game, s),
      };
    });
}

/** 复盘写入牌局日志的文字 */
export function reviewLogLines(review) {
  return review.map((r) => {
    const status = r.folded ? `${r.foldStreet}弃牌` : r.won ? `赢得 ${r.won}` : '摊牌';
    const hand = r.handName ? ` · ${r.boardComplete ? '最终牌型' : '当前牌型'} ${r.handName}` : '';
    return `复盘：${r.name} 底牌 ${r.cardsText}（${status}）${hand}`;
  });
}
