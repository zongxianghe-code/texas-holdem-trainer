// 电脑玩家（纯逻辑，可测试）：翻牌前查范围表并按频率混合，翻牌后使用启发式策略。
// 只读取公开信息与自己的底牌；最终动作一律经过合法动作 API 校正，保证不会做出非法动作。

import { preflopStrategy, postflopStrategy } from './strategy.js';

export const DIFFICULTIES = {
  easy: { name: '简单', iterations: 150 },
  standard: { name: '标准', iterations: 400 },
};

/** 按频率抽样 */
function pick(items, rng) {
  const r = rng();
  let acc = 0;
  for (const it of items) {
    acc += it.freq;
    if (r < acc) return it;
  }
  return items[items.length - 1];
}

/**
 * 把任意“意图”转换为当前一定合法的动作。
 * @param {{type:string, amount?:number}} choice
 * @param {object} la game.getLegalActions() 的结果
 */
export function legalize(choice, la) {
  const type = choice?.type;
  if (type === 'fold') return la.canCheck ? { type: 'check' } : { type: 'fold' };
  if (type === 'check') return la.canCheck ? { type: 'check' } : { type: 'fold' };
  if (type === 'call') return la.canCall ? { type: 'call' } : { type: 'check' };
  if (type === 'bet' || type === 'raise' || type === 'allin') {
    if (!la.canRaise) return la.canCall ? { type: 'call' } : { type: 'check' };
    let amount = type === 'allin' ? la.maxRaiseTo : Math.round(Number(choice.amount));
    if (!Number.isFinite(amount)) amount = la.minRaiseTo;
    amount = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, amount));
    return { type: la.raiseType, amount };
  }
  return la.canCheck ? { type: 'check' } : { type: 'fold' };
}

/**
 * 电脑玩家为当前行动座位做决定。
 * @param {import('./engine.js').HoldemGame} game
 * @param {{rng?:()=>number, difficulty?:'easy'|'standard', iterations?:number}} [opts]
 * @returns {{type:string, amount?:number, reason:string}}
 */
export function decideBotAction(game, opts = {}) {
  const { rng = Math.random, difficulty = 'standard' } = opts;
  const la = game.getLegalActions();
  if (!la) throw new Error('当前没有需要行动的玩家');
  const seat = la.seat;
  const iterations = opts.iterations ?? DIFFICULTIES[difficulty]?.iterations ?? 400;
  let choice;
  let reason = '';
  try {
    if (game.street === 'preflop') {
      const s = preflopStrategy(game, seat);
      const f = { ...s.freqs };
      if (difficulty === 'easy') {
        // 简单难度：更松更被动，偶尔乱跟
        const cheap = la.toCall <= game.bigBlind * 3;
        if (cheap && f.fold > 0) { const m = f.fold * 0.4; f.fold -= m; f.call += m; }
        const r = f.raise * 0.4; f.raise -= r; f.call += r;
      }
      const it = pick([
        { kind: 'raise', freq: f.raise },
        { kind: 'call', freq: f.call },
        { kind: 'fold', freq: f.fold },
      ].filter((x) => x.freq > 0), rng);
      reason = `${s.tableKey} ${s.handClass}`;
      if (it.kind === 'raise') choice = { type: 'raise', amount: s.raiseTo };
      else if (it.kind === 'call') choice = { type: la.canCheck ? 'check' : 'call' };
      else choice = { type: 'fold' };
    } else {
      const s = postflopStrategy(game, seat, { iterations, rng });
      let actions = s.actions.map((a) => ({ ...a }));
      if (difficulty === 'easy') {
        // 简单难度：少诈唬、少加注、跟注更宽
        for (const a of actions) {
          if (a.kind === 'raise' || (a.kind === 'bet' && s.info.equity < 0.5)) a.freq *= 0.4;
          if (a.kind === 'fold' && s.info.need < 0.35) a.freq *= 0.6;
        }
        const total = actions.reduce((x, a) => x + a.freq, 0);
        const missing = 1 - total;
        if (missing > 0) actions.push({ kind: la.canCheck ? 'check' : 'call', freq: missing });
      }
      actions = actions.filter((a) => a.freq > 0);
      const it = pick(actions, rng);
      reason = s.category;
      if (it.kind === 'bet' || it.kind === 'raise') choice = { type: 'raise', amount: it.to ?? la.minRaiseTo };
      else choice = { type: it.kind };
    }
  } catch (e) {
    reason = `fallback: ${e.message}`;
    choice = { type: la.canCheck ? 'check' : 'fold' };
  }
  return { ...legalize(choice, la), reason };
}
