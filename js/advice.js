// 给人类玩家的建议与决策反馈（纯逻辑，无 DOM）。
// 翻牌前：直接来自范围表（近似 6-max 100BB 图表）；翻牌后：启发式近似建议，非求解器结果。

import { preflopStrategy, postflopStrategy, positionLabel, SPOT_NAMES, preflopStrength, sizeLabel, BET_SIZES } from './strategy.js';

export { BET_SIZES };
import { RANGE_SPECS, RANGE_SOURCE_NOTE } from './ranges.js';

export const POSTFLOP_DISCLAIMER = '近似建议，非求解器结果';
export const PREFLOP_NOTE = RANGE_SOURCE_NOTE;

const pct = (x) => `${Math.round(x * 100)}%`;
const RANK_ORDER = 'AKQJT98765432';

/** 起手牌类别的中文描述 */
export function describeHandClass(hc) {
  const a = hc[0];
  const b = hc[1];
  const gap = RANK_ORDER.indexOf(b) - RANK_ORDER.indexOf(a);
  const broadway = (r) => 'AKQJT'.includes(r);
  if (hc.length === 2) return RANK_ORDER.indexOf(a) <= 4 ? '大口袋对子' : RANK_ORDER.indexOf(a) <= 7 ? '中口袋对子' : '小口袋对子';
  const suited = hc[2] === 's';
  if (broadway(a) && broadway(b)) return suited ? '同花高张' : '杂色高张';
  if (a === 'A') return suited ? '同花 A（Axs）' : '杂色 A（Axo）';
  if (gap === 1) return suited ? '同花连张' : '杂色连张';
  if (gap === 2) return suited ? '同花隔一张' : '杂色隔一张';
  if (a === 'K' || a === 'Q') return suited ? `同花 ${a}x` : `杂色 ${a}x`;
  return suited ? '同花杂牌' : '杂色杂牌';
}

function preflopActionNames(advice) {
  const t = advice.spot.type;
  const raise =
    t === 'rfi' ? '开池加注'
      : t === 'vsLimp' || t === 'sbVsLimp' || t === 'bbVsLimp' ? '加注（隔离）'
        : t === 'vsOpen' ? '3bet'
          : t === 'vs3bet' || t === 'coldVs3bet' ? '4bet'
            : '全下';
  const call = advice.canCheck ? '过牌' : '跟注';
  return { raise, call, fold: '弃牌' };
}

/**
 * 当前行动座位的建议。
 * @returns 翻牌前：{street:'preflop', freqs, primary, names, raiseTo, ...}
 *          翻牌后：{street, disclaimer, actions, groups, primary, category, equity, ...}
 */
export function getAdvice(game, seat = game.toAct, opts = {}) {
  const la = game.toAct === seat ? game.getLegalActions() : null;
  if (game.street === 'preflop') {
    const s = preflopStrategy(game, seat);
    const advice = {
      street: 'preflop',
      seat,
      handClass: s.handClass,
      handCategory: describeHandClass(s.handClass),
      percentile: preflopStrength().percentile.get(s.handClass),
      position: s.position,
      positionText: positionLabel(game, seat),
      spot: s.spot,
      spotText: SPOT_NAMES[s.spot.type] || s.spot.type,
      tableKey: s.tableKey,
      tableName: RANGE_SPECS[s.tableKey].name,
      freqs: s.freqs,
      raiseTo: s.raiseTo,
      raiseFrac: s.raiseFrac,
      sizeText: s.raiseTo ? `${sizeLabel(s.raiseFrac)}（到 ${s.raiseTo}${la && s.raiseTo === la.maxRaiseTo ? '，即全下' : ''}）` : '',
      canCheck: !!la?.canCheck,
      notes: s.notes,
      source: PREFLOP_NOTE,
    };
    advice.names = preflopActionNames(advice);
    const order = ['raise', 'call', 'fold'];
    advice.primary = order.reduce((best, k) => (s.freqs[k] > s.freqs[best] + 1e-9 ? k : best), 'fold');
    advice.groups = { aggressive: s.freqs.raise, passive: s.freqs.call, fold: s.freqs.fold };
    return advice;
  }
  const s = postflopStrategy(game, seat, { iterations: opts.iterations ?? 1500, rng: opts.rng });
  const groups = { aggressive: 0, passive: 0, fold: 0 };
  for (const a of s.actions) {
    if (a.kind === 'bet' || a.kind === 'raise') groups.aggressive += a.freq;
    else if (a.kind === 'fold') groups.fold += a.freq;
    else groups.passive += a.freq;
  }
  const primary = Object.keys(groups).reduce((b, k) => (groups[k] > groups[b] + 1e-9 ? k : b), 'passive');
  const { info } = s;
  const drawParts = [];
  if (info.draws.flushDraw) drawParts.push('同花听牌');
  if (info.draws.oesd) drawParts.push('两头顺听牌');
  if (info.draws.gutshot) drawParts.push('卡顺听牌');
  if (info.draws.backdoorFlush) drawParts.push('后门同花');
  if (info.draws.overcards) drawParts.push('两张高张');
  return {
    street: game.street,
    seat,
    disclaimer: POSTFLOP_DISCLAIMER,
    category: s.category,
    actions: s.actions,
    groups,
    primary,
    equity: info.equity,
    need: info.need,
    toCall: info.toCall,
    pot: info.pot,
    numOpp: info.numOpp,
    handText: `${info.made.name}${info.usesHole ? '' : '（牌面牌型，未用到底牌）'}`,
    drawText: drawParts.join('、') || '无',
    textureText: info.texture.text,
    inPosition: info.inPosition,
    isPFR: info.isPFR,
    spr: info.spr,
    canCheck: !!la?.canCheck,
    notes: s.notes,
  };
}

const ACTION_GROUP = { fold: 'fold', check: 'passive', call: 'passive', bet: 'aggressive', raise: 'aggressive', allin: 'aggressive' };
const GROUP_KEY_PRE = { aggressive: 'raise', passive: 'call', fold: 'fold' };

/** 动作分组的中文名称 */
export function groupName(advice, group) {
  if (advice.street === 'preflop') return advice.names[GROUP_KEY_PRE[group]];
  if (group === 'aggressive') return advice.toCall > 0 ? '加注' : '下注';
  if (group === 'passive') return advice.canCheck ? '过牌' : '跟注';
  return '弃牌';
}

/** 建议频率的简短文字，如 “加注 70% / 弃牌 30%” */
export function adviceSummary(advice) {
  return ['aggressive', 'passive', 'fold']
    .filter((g) => advice.groups[g] > 0.004)
    .sort((x, y) => advice.groups[y] - advice.groups[x])
    .map((g) => `${groupName(advice, g)} ${pct(advice.groups[g])}`)
    .join(' / ');
}

/**
 * 对玩家实际动作给出反馈。
 * @param {object} advice getAdvice() 的结果（在行动前计算）
 * @param {{type:string, amount?:number}} action 实际执行的动作（allin 视为加注）
 * @returns {{verdict:'good'|'ok'|'bad', label:string, text:string}}
 */
export function evaluateDecision(advice, action) {
  let group = ACTION_GROUP[action.type] || 'passive';
  if (group === 'fold' && advice.canCheck) group = 'passive';
  const freq = advice.groups[group] || 0;
  const chosen = groupName(advice, group);
  const best = advice.primary;
  let verdict;
  let label;
  if (freq >= 0.35 || group === best) {
    verdict = 'good';
    label = '符合';
  } else if (freq >= 0.1) {
    verdict = 'ok';
    label = '基本符合（低频选项）';
  } else {
    verdict = 'bad';
    label = '偏离';
  }
  const parts = [`你选择了${chosen}（建议频率 ${pct(freq)}）。建议：${adviceSummary(advice)}。`];
  if (verdict !== 'good') {
    const order = { fold: 0, passive: 1, aggressive: 2 };
    if (order[group] > order[best]) {
      parts.push(best === 'fold' ? '这手牌在此点位通常放弃，打得偏松。' : '这里偏激进，主流选择更被动。');
    } else {
      parts.push(group === 'fold' ? '这手牌有足够价值继续，弃牌偏紧。' : '这里偏被动，主流选择是主动加注。');
    }
  }
  // 尺度反馈：建议只使用 1/3、1/2、2/3、4/3 底池四种尺度
  if (group === 'aggressive' && action.amount) {
    const recs = advice.street === 'preflop'
      ? (advice.raiseTo ? [{ to: advice.raiseTo, size: advice.raiseFrac }] : [])
      : advice.actions.filter((a) => (a.kind === 'bet' || a.kind === 'raise') && a.to);
    if (recs.length && !recs.some((r) => r.to === action.amount)) {
      const closest = recs.reduce((b, r) => (Math.abs(r.to - action.amount) < Math.abs(b.to - action.amount) ? r : b));
      const off = Math.abs(action.amount - closest.to) / closest.to;
      if (off > 0.25) {
        const list = recs.map((r) => `${sizeLabel(r.size)}（${r.to}）`).join(' 或 ');
        parts.push(`尺度：建议 ${list}，你下到 ${action.amount}。`);
      }
    }
  }
  if (advice.street !== 'preflop') parts.push(`（${POSTFLOP_DISCLAIMER}）`);
  return { verdict, label, text: parts.join('') };
}
