// 策略核心（纯逻辑，无 DOM）：位置识别、翻牌前点位识别与范围查询、翻牌后牌力/牌面分析与启发式策略。
// 电脑玩家（bot.js）与建议面板（advice.js）共用这里的逻辑。
// 注意：这里只使用“公开信息 + 当前玩家自己的底牌”，绝不读取其他玩家的底牌。

import { rankOf, suitOf, mulberry32 } from './cards.js';
import { evaluate, describeHand, categoryOf } from './evaluator.js';
import { getTable, handClassOf, HAND_CLASSES, CLASS_COMBOS, comboCount, RANGE_SPECS } from './ranges.js';

export const POSITION_NAMES = {
  UTG: '枪口位 UTG',
  HJ: '劫持位 HJ',
  CO: '关煞位 CO',
  BTN: '庄位 BTN',
  SB: '小盲 SB',
  BB: '大盲 BB',
};

const EARLY = new Set(['UTG', 'HJ']);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------- 位置

/**
 * 座位 → 位置（UTG/HJ/CO/BTN/SB/BB）。按 6 人桌命名；人数更少时从前位开始去掉；
 * 超过 6 人（自对弈模式）时多出的前位都视为 UTG。单挑时庄家（同时是小盲）按 BTN 范围处理。
 */
export function getPositions(game) {
  const n = game.players.length;
  const alive = [];
  for (let i = 0; i < n; i++) {
    const s = (game.dealer + i) % n;
    if (!game.players[s].out) alive.push(s);
  }
  const pos = {};
  if (alive.length < 2) return pos;
  if (alive.length === 2) {
    pos[alive[0]] = 'BTN';
    pos[alive[1]] = 'BB';
    return pos;
  }
  pos[alive[0]] = 'BTN';
  pos[alive[1]] = 'SB';
  pos[alive[2]] = 'BB';
  const rest = alive.slice(3);
  const tail = ['UTG', 'HJ', 'CO'].slice(Math.max(0, 3 - rest.length));
  const labels = [...Array(Math.max(0, rest.length - 3)).fill('UTG'), ...tail];
  rest.forEach((s, i) => (pos[s] = labels[i]));
  return pos;
}

export const isHeadsUp = (game) => game.players.filter((p) => !p.out).length === 2;

export function positionLabel(game, seat, pos = getPositions(game)) {
  const p = pos[seat];
  if (isHeadsUp(game) && p === 'BTN') return '庄位/小盲（单挑）';
  return POSITION_NAMES[p] || p || '';
}

// ---------------------------------------------------------------- 翻牌前

/** 当前这手牌的动作记录（可按街过滤） */
export function handActions(game, street) {
  return game.log.filter(
    (e) => e.hand === game.handNumber && e.kind === 'action' && (street === undefined || e.street === street),
  );
}

/**
 * 根据此前的翻牌前动作，判断 seat 当前所处的点位。
 * @returns {{type:string, key:string, raises:object[], limpers:number, callersAfter:number, openerPos?:string}}
 */
export function classifyPreflopSpot(seat, acts, pos) {
  const raises = acts.filter((a) => a.action === 'raise' || a.action === 'bet');
  let limpers = 0;
  for (const a of acts) {
    if (a.action === 'raise' || a.action === 'bet') break;
    if (a.action === 'call') limpers++;
  }
  let callersAfter = 0;
  if (raises.length) {
    const lastIdx = acts.lastIndexOf(raises[raises.length - 1]);
    for (let i = lastIdx + 1; i < acts.length; i++) if (acts[i].action === 'call') callersAfter++;
  }
  const p = pos[seat];
  const heroRaised = raises.some((r) => r.seat === seat);
  let type;
  let key;
  let openerPos;
  if (raises.length === 0) {
    if (limpers === 0) {
      type = 'rfi';
      key = p === 'BB' ? 'BB_vs_limp' : `RFI_${p}`;
    } else if (p === 'BB') {
      type = 'bbVsLimp';
      key = 'BB_vs_limp';
    } else if (p === 'SB') {
      type = 'sbVsLimp';
      key = 'SB_vs_limp';
    } else {
      type = 'vsLimp';
      key = `ISO_${p}`;
    }
  } else if (raises.length === 1) {
    type = 'vsOpen';
    openerPos = pos[raises[0].seat];
    const early = EARLY.has(openerPos);
    if (p === 'BB') key = early ? 'BB_vs_EP' : `BB_vs_${openerPos === 'BB' ? 'SB' : openerPos}`;
    else if (p === 'SB') key = early ? 'SB_vs_EP' : 'SB_vs_LP';
    else key = early ? 'IP_vs_EP' : 'IP_vs_LP';
  } else if (raises.length === 2) {
    openerPos = pos[raises[0].seat];
    if (raises[0].seat === seat) {
      type = 'vs3bet';
      key = EARLY.has(p) ? 'EP_vs_3bet' : p === 'SB' ? 'SB_vs_3bet' : 'LP_vs_3bet';
    } else {
      type = 'coldVs3bet';
      key = 'COLD_vs_3bet';
    }
  } else {
    openerPos = pos[raises[0].seat];
    type = heroRaised ? 'vs4bet' : 'coldVs4bet';
    key = 'VS_4bet';
  }
  if (!RANGE_SPECS[key]) key = 'VS_4bet'; // 理论上不会发生，保底
  return { type, key, raises, limpers, callersAfter, openerPos, position: p };
}

export const SPOT_NAMES = {
  rfi: '无人入池，开池',
  vsLimp: '有人溜入',
  sbVsLimp: '有人溜入（小盲）',
  bbVsLimp: '有人溜入（大盲）',
  vsOpen: '面对开池加注',
  vs3bet: '开池后面对 3bet',
  coldVs3bet: '面对开池 + 3bet',
  vs4bet: '面对 4bet',
  coldVs4bet: '面对 4bet（未主动加注）',
};

let strengthCache = null;
/**
 * 每种起手牌对一手随机牌的全下胜率（固定种子的蒙特卡洛估计，首次调用时计算并缓存），
 * 以及按组合数加权的“前 x%”排名。
 */
export function preflopStrength() {
  if (strengthCache) return strengthCache;
  const rng = mulberry32(169);
  const eq = new Map();
  const cards = new Array(7);
  const opp = new Array(7);
  const mark = new Uint8Array(52);
  for (const h of HAND_CLASSES) {
    const [a, b] = CLASS_COMBOS.get(h)[0];
    let score = 0;
    const N = 1000;
    for (let it = 0; it < N; it++) {
      mark.fill(0);
      mark[a] = 1;
      mark[b] = 1;
      const draw = () => {
        let c;
        do c = Math.floor(rng() * 52);
        while (mark[c]);
        mark[c] = 1;
        return c;
      };
      cards[0] = a; cards[1] = b; opp[0] = draw(); opp[1] = draw();
      for (let k = 0; k < 5; k++) { const c = draw(); cards[2 + k] = c; opp[2 + k] = c; }
      const d = evaluate(cards) - evaluate(opp);
      score += d > 0 ? 1 : d === 0 ? 0.5 : 0;
    }
    eq.set(h, score / N);
  }
  const sorted = HAND_CLASSES.slice().sort((x, y) => eq.get(y) - eq.get(x));
  const percentile = new Map();
  let acc = 0;
  for (const h of sorted) {
    acc += comboCount(h);
    percentile.set(h, acc / 1326);
  }
  strengthCache = { eq, percentile, sorted };
  return strengthCache;
}

/**
 * 翻牌后唯一允许的下注尺度（底池比例）：1/3、1/2、2/3、4/3（超池）。翻牌前使用以大盲为单位的常规尺度。
 * “下注到”金额 = 当前最高下注 + 比例 × (底池 + 跟注所需)，与界面快捷按钮完全一致；
 * 结果再限制到合法的最小加注与全下之间。
 */
export const BET_SIZES = [
  { frac: 1 / 3, label: '1/3 池' },
  { frac: 1 / 2, label: '1/2 池' },
  { frac: 2 / 3, label: '2/3 池' },
  { frac: 4 / 3, label: '4/3 池（超池）' },
];
export const sizeLabel = (frac) => BET_SIZES.find((b) => Math.abs(b.frac - frac) < 1e-9)?.label ?? '';

/** 按底池比例计算合法的“下注到”金额 */
export function potFractionTo(la, frac) {
  if (!BET_SIZES.some((b) => Math.abs(b.frac - frac) < 1e-9)) throw new Error(`不支持的下注尺度: ${frac}`);
  const owe = Math.max(0, la.currentBet - la.bet);
  const target = Math.round(la.currentBet + frac * (la.pot + owe));
  return clamp(target, la.minRaiseTo, la.maxRaiseTo);
}

/** 当前局面下四种尺度对应的合法金额 */
export function allowedSizes(la) {
  return BET_SIZES.map((b) => ({ ...b, to: potFractionTo(la, b.frac) }));
}

// ---------------------------------------------------------------- 翻牌前尺度（以大盲为单位）
// 常见 6-max 100BB 尺度：开池 2.5BB（小盲 3BB）；隔离溜入 3BB + 每名溜入者 1BB；
// 3bet 有位置约 3 倍、无位置（SB/BB）约 4 倍；挤压 4 倍 + 每名跟注者 1 倍；4bet 约 2.2 倍；5bet 全下。

/** 翻牌前推荐尺度（未限制）：{ to, label, kind } */
export function preflopSizing(game, spot) {
  const bb = game.bigBlind;
  const p = spot.position;
  const oop = p === 'SB' || p === 'BB';
  const last = spot.raises[spot.raises.length - 1];
  switch (spot.type) {
    case 'rfi': {
      const sb = p === 'SB' && !isHeadsUp(game);
      return { to: Math.round((sb ? 3 : 2.5) * bb), label: sb ? '3BB' : '2.5BB', kind: sb ? 'sbOpen' : 'open' };
    }
    case 'vsLimp':
    case 'sbVsLimp':
    case 'bbVsLimp':
      return { to: Math.round((3 + spot.limpers) * bb), label: `${3 + spot.limpers}BB（3BB + ${spot.limpers} 名溜入者各 1BB）`, kind: 'iso' };
    case 'vsOpen':
      if (spot.callersAfter > 0) {
        const m = 4 + spot.callersAfter;
        return { to: Math.round(last.amount * m), label: `${m} 倍（4 倍 + ${spot.callersAfter} 名跟注者各 1 倍）`, kind: 'squeeze' };
      }
      return oop
        ? { to: Math.round(last.amount * 4), label: '4 倍', kind: '3betOOP' }
        : { to: Math.round(last.amount * 3), label: '3 倍', kind: '3betIP' };
    case 'vs3bet':
    case 'coldVs3bet':
      return { to: Math.round(last.amount * 2.2), label: '2.2 倍', kind: '4bet' };
    default:
      return { to: Infinity, label: '全下', kind: 'jam' };
  }
}

/** 限制到合法区间 */
export const clampRaise = (la, to) => clamp(Number.isFinite(to) ? Math.round(to) : la.maxRaiseTo, la.minRaiseTo, la.maxRaiseTo);

/**
 * 行动面板翻牌前快捷按钮（以大盲为单位）：
 * 无人加注：2BB / 2.5BB / 3BB（有溜入者时每人再加 1BB）；面对一次加注：3x / 4x；面对 3bet 及以上：2.2x / 3x。
 */
export function preflopQuickSizes(game, la) {
  const bb = game.bigBlind;
  const acts = handActions(game, 'preflop');
  const raises = acts.filter((a) => a.action === 'raise' || a.action === 'bet');
  let opts;
  if (raises.length === 0) {
    let limpers = 0;
    for (const a of acts) if (a.action === 'call') limpers++;
    opts = [2, 2.5, 3].map((x) => ({ label: limpers ? `${x + limpers}BB` : `${x}BB`, to: Math.round((x + limpers) * bb) }));
  } else {
    const last = raises[raises.length - 1].amount;
    const mults = raises.length === 1 ? [3, 4] : [2.2, 3];
    opts = mults.map((m) => ({ label: `${m}x`, to: Math.round(last * m) }));
  }
  const seen = new Set();
  return opts
    .map((o) => ({ ...o, to: clampRaise(la, o.to) }))
    .filter((o) => (seen.has(o.to) ? false : (seen.add(o.to), true)));
}

/** 翻牌前位于身后、尚未行动且仍在局的玩家数（不含自己） */
export function playersBehind(game, seat) {
  const n = game.players.length;
  const order = [];
  const first = isHeadsUp(game) ? game.dealer : game.nextSeat(game.bbSeat, (p) => !p.out);
  for (let i = 0; i < n; i++) {
    const s = (first + i) % n;
    if (!game.players[s].out) order.push(s);
  }
  const idx = order.indexOf(seat);
  return order.slice(idx + 1).filter((s) => !game.players[s].folded && !game.players[s].hasActed).length;
}

/**
 * 翻牌前策略：返回范围表频率（已根据合法动作修正）与推荐加注尺度。
 */
export function preflopStrategy(game, seat = game.toAct) {
  const pos = getPositions(game);
  const acts = handActions(game, 'preflop');
  const spot = classifyPreflopSpot(seat, acts, pos);
  const p = game.players[seat];
  const hc = handClassOf(p.holeCards[0], p.holeCards[1]);
  const base = getTable(spot.key).get(hc);
  const freqs = { ...base };
  const la = game.toAct === seat ? game.getLegalActions() : null;
  const notes = [];

  if (la) {
    if (la.canCheck && freqs.fold > 0) {
      freqs.call += freqs.fold; // 可以免费看牌时不弃牌
      freqs.fold = 0;
    }
    if (!la.canRaise && freqs.raise > 0) {
      freqs.call += freqs.raise;
      freqs.raise = 0;
      notes.push('当前不能再加注，强牌改为跟注');
    }
    if (la.toCall > 0) {
      const need = la.toCall / (la.pot + la.toCall);
      const pct = preflopStrength().percentile.get(hc);
      if (need <= 0.22 && freqs.fold > 0 && pct <= 0.6) {
        freqs.call += freqs.fold;
        freqs.fold = 0;
        notes.push(`跟注价格很便宜（只需 ${(need * 100).toFixed(0)}% 胜率），放宽跟注`);
      }
    }
  }
  const sizing = preflopSizing(game, spot);
  const raiseTo = la && la.canRaise ? clampRaise(la, sizing.to) : null;
  return {
    street: 'preflop',
    spot,
    position: pos[seat],
    handClass: hc,
    freqs,
    raiseTo,
    sizing,
    playersBehind: playersBehind(game, seat),
    notes,
    tableKey: spot.key,
  };
}

/**
 * 根据某玩家此前的翻牌前动作推断其范围：Map(起手牌 → 权重)。
 * 任何手牌至少保留一个很小的权重，以容纳“范围外”的打法（例如人类玩家的随意跟注）。
 */
export function inferPreflopRange(game, seat, pos = getPositions(game)) {
  const acts = handActions(game, 'preflop');
  let last = null;
  for (let i = 0; i < acts.length; i++) {
    if (acts[i].seat !== seat) continue;
    last = { act: acts[i], spot: classifyPreflopSpot(seat, acts.slice(0, i), pos) };
  }
  const weights = new Map();
  if (!last) {
    for (const h of HAND_CLASSES) weights.set(h, 1);
    return weights;
  }
  const table = getTable(last.spot.key);
  for (const h of HAND_CLASSES) {
    const f = table.get(h);
    let w;
    if (last.act.action === 'raise' || last.act.action === 'bet') w = f.raise;
    else if (last.act.action === 'check') w = f.call + f.fold;
    else w = f.call + (last.act.allIn ? f.raise : 0); // 跟注（全下跟注时也可能是强牌）
    weights.set(h, Math.max(w, 0.02));
  }
  return weights;
}

// ---------------------------------------------------------------- 翻牌后：牌面与牌力

/** 牌面结构 */
export function analyzeTexture(board) {
  const suits = [0, 0, 0, 0];
  const ranks = board.map(rankOf);
  for (const c of board) suits[suitOf(c)]++;
  const maxSuit = Math.max(...suits);
  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  const paired = uniq.length < ranks.length;
  // 是否存在包含 3 张公共牌的 5 连窗口（顺子可能）
  const withAceLow = uniq.includes(12) ? [-1, ...uniq] : uniq;
  let maxInWindow = 0;
  for (let lo = -1; lo <= 8; lo++) {
    const cnt = withAceLow.filter((r) => r >= lo && r <= lo + 4).length;
    maxInWindow = Math.max(maxInWindow, cnt);
  }
  const connected = maxInWindow >= 3;
  const monotone = maxSuit >= 3;
  const twoTone = maxSuit === 2;
  const high = Math.max(...ranks);
  const wet = monotone || (connected && twoTone) || (connected && !paired && maxInWindow >= 3 && uniq.length >= 3 && uniq[uniq.length - 1] - uniq[0] <= 4);
  const parts = [];
  parts.push(monotone ? (maxSuit >= 4 ? '四张同花色' : '单色') : twoTone ? '两色' : '彩虹');
  if (paired) parts.push('公对');
  parts.push(connected ? '连接' : '不连接');
  parts.push(high >= 10 ? '高牌面' : high <= 7 ? '低牌面' : '中等牌面');
  return { maxSuit, monotone, twoTone, paired, connected, high, wet, dry: !wet, text: `${wet ? '湿润' : '干燥'}（${parts.join('、')}）` };
}

/** 听牌检测（只统计用到自己底牌的听牌） */
export function detectDraws(hole, board) {
  const res = { flushDraw: false, oesd: false, gutshot: false, outsRanks: 0, overcards: false, backdoorFlush: false };
  if (board.length < 3 || board.length >= 5) return res;
  const all = [...hole, ...board];
  const cat = categoryOf(evaluate(all));
  for (let s = 0; s < 4; s++) {
    const total = all.filter((c) => suitOf(c) === s).length;
    const mine = hole.filter((c) => suitOf(c) === s).length;
    if (mine > 0 && total === 4 && cat < 5) res.flushDraw = true;
    if (board.length === 3 && mine === 2 && total === 3) res.backdoorFlush = true;
  }
  if (cat < 4) {
    const has = new Set(all.map(rankOf));
    const holeRanks = new Set(hole.map(rankOf));
    if (has.has(12)) has.add(-1);
    if (holeRanks.has(12)) holeRanks.add(-1);
    const outs = new Set();
    for (let lo = -1; lo <= 8; lo++) {
      const win = [lo, lo + 1, lo + 2, lo + 3, lo + 4];
      const missing = win.filter((r) => !has.has(r));
      if (missing.length === 1 && win.some((r) => holeRanks.has(r))) outs.add(missing[0] === -1 ? 12 : missing[0]);
    }
    res.outsRanks = outs.size;
    if (outs.size >= 2) res.oesd = true;
    else if (outs.size === 1) res.gutshot = true;
  }
  const maxBoard = Math.max(...board.map(rankOf));
  res.overcards = cat === 0 && hole.every((c) => rankOf(c) > maxBoard);
  return res;
}

/** 构建某个对手的加权组合列表（排除已知的死牌） */
function buildComboSampler(weights, dead) {
  const combos = [];
  const cum = [];
  let total = 0;
  for (const [h, w] of weights) {
    if (w <= 0) continue;
    for (const [a, b] of CLASS_COMBOS.get(h)) {
      if (dead[a] || dead[b]) continue;
      total += w;
      combos.push(a, b);
      cum.push(total);
    }
  }
  return { combos, cum, total };
}

function sampleCombo(sampler, rng) {
  const x = rng() * sampler.total;
  let lo = 0;
  let hi = sampler.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sampler.cum[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 对估计范围的胜率（蒙特卡洛）。对手范围来自其翻牌前动作；本街主动下注/加注的对手，
 * 抽样时更偏向“用到底牌的成牌”（简单的范围收窄）。
 */
export function equityVsRanges(game, seat, { iterations = 400, rng = Math.random } = {}) {
  const hero = game.players[seat];
  const board = game.board;
  const pos = getPositions(game);
  const opps = game.players.filter((p) => p.seat !== seat && !p.out && !p.folded);
  if (opps.length === 0) return 1;
  const dead = new Uint8Array(52);
  for (const c of [...hero.holeCards, ...board]) dead[c] = 1;
  const streetActs = handActions(game, game.street);
  const samplers = opps.map((o) => ({
    sampler: buildComboSampler(inferPreflopRange(game, o.seat, pos), dead),
    aggressive: streetActs.some((a) => a.seat === o.seat && (a.action === 'bet' || a.action === 'raise')),
  }));
  const boardCat = board.length >= 3 ? categoryOf(evaluate(board)) : 0;
  const need = 5 - board.length;
  const heroCards = [...hero.holeCards, ...board, ...new Array(need).fill(0)];
  const oppCards = opps.map(() => new Array(7).fill(0));
  const mark = new Uint8Array(52);
  let total = 0;
  let samples = 0;
  for (let it = 0; it < iterations; it++) {
    mark.set(dead);
    let ok = true;
    for (let i = 0; i < opps.length; i++) {
      const { sampler, aggressive } = samplers[i];
      if (sampler.total <= 0) { ok = false; break; }
      let found = false;
      for (let t = 0; t < 30 && !found; t++) {
        const idx = sampleCombo(sampler, rng);
        const a = sampler.combos[idx * 2];
        const b = sampler.combos[idx * 2 + 1];
        if (mark[a] || mark[b]) continue;
        if (aggressive && board.length >= 3 && t < 6) {
          const cat = categoryOf(evaluate([a, b, ...board]));
          if (cat <= boardCat && rng() > 0.4) continue; // 下注者更可能有成牌
        }
        mark[a] = 1;
        mark[b] = 1;
        oppCards[i][0] = a;
        oppCards[i][1] = b;
        found = true;
      }
      if (!found) { ok = false; break; }
    }
    if (!ok) continue;
    for (let k = 0; k < need; k++) {
      let c;
      do c = Math.floor(rng() * 52);
      while (mark[c]);
      mark[c] = 1;
      heroCards[2 + board.length + k] = c;
    }
    const hs = evaluate(heroCards);
    let best = hs;
    let tie = 1;
    let heroBest = true;
    for (let i = 0; i < opps.length; i++) {
      const oc = oppCards[i];
      for (let k = 0; k < 5; k++) oc[2 + k] = heroCards[2 + k];
      const s = evaluate(oc);
      if (s > best) { best = s; heroBest = false; }
      else if (s === best) { if (heroBest) tie++; }
    }
    if (heroBest) total += 1 / tie;
    samples++;
  }
  return samples ? total / samples : 0.5;
}

/** 当前街的局面信息（只用公开信息 + 自己的底牌） */
export function analyzePostflop(game, seat = game.toAct, { iterations = 400, rng = Math.random } = {}) {
  const p = game.players[seat];
  const board = game.board;
  const la = game.toAct === seat ? game.getLegalActions() : null;
  const pot = game.pot;
  const toCall = la ? la.toCall : Math.max(0, Math.min(game.currentBet - p.bet, p.stack));
  const opps = game.players.filter((q) => q.seat !== seat && !q.out && !q.folded);
  const equity = equityVsRanges(game, seat, { iterations, rng });
  const made = describeHand([...p.holeCards, ...board]);
  const boardOnly = categoryOf(evaluate(board));
  const draws = detectDraws(p.holeCards, board);
  const texture = analyzeTexture(board);
  const n = game.players.length;
  const order = [];
  for (let i = 1; i <= n; i++) order.push((game.dealer + i) % n);
  const live = order.filter((s) => !game.players[s].out && !game.players[s].folded);
  const inPosition = live[live.length - 1] === seat;
  const pre = handActions(game, 'preflop').filter((a) => a.action === 'raise' || a.action === 'bet');
  const pfrSeat = pre.length ? pre[pre.length - 1].seat : -1;
  const streetActs = handActions(game, game.street);
  const aggr = streetActs.filter((a) => a.action === 'bet' || a.action === 'raise');
  const maxOppStack = Math.max(0, ...opps.map((q) => q.stack + q.bet));
  const effStack = Math.min(p.stack + p.bet, maxOppStack) - p.bet;
  return {
    seat,
    street: game.street,
    equity,
    pot,
    toCall,
    need: toCall > 0 ? toCall / (pot + toCall) : 0,
    numOpp: opps.length,
    made,
    usesHole: made.category > boardOnly,
    draws,
    texture,
    inPosition,
    isPFR: pfrSeat === seat,
    facingRaise: aggr.length >= 2 && toCall > 0,
    heroCheckedThisStreet: streetActs.some((a) => a.seat === seat && a.action === 'check'),
    spr: effStack / Math.max(1, pot),
    effStack,
    la,
  };
}

// 不同对手人数下的胜率阈值（对手越多，同样的绝对胜率代表越强的相对牌力）
const THR = {
  nut: [0.8, 0.68, 0.6, 0.54, 0.5],
  value: [0.63, 0.5, 0.42, 0.36, 0.32],
  medium: [0.42, 0.32, 0.26, 0.22, 0.2],
};
const thr = (kind, k) => THR[kind][clamp(k, 1, 5) - 1];

/**
 * 翻牌后启发式策略：返回动作频率分布。
 * actions: [{ kind: 'bet'|'raise'|'check'|'call'|'fold', freq, size?(底池比例), to?(下注到) }]
 */
export function postflopStrategy(game, seat = game.toAct, opts = {}) {
  const info = analyzePostflop(game, seat, opts);
  const { equity, numOpp, draws, texture, street, la } = info;
  const k = numOpp;
  const nut = equity >= thr('nut', k);
  const strong = equity >= thr('value', k);
  const medium = equity >= thr('medium', k);
  const strongDraw = (draws.flushDraw || draws.oesd) && street !== 'river';
  const weakDraw = draws.gutshot && street !== 'river';
  const multi = k >= 2 ? 0.45 : 1; // 多人底池减少诈唬
  const notes = [];
  let category;
  const acts = [];
  const add = (kind, freq, extra = {}) => freq > 0 && acts.push({ kind, freq, ...extra });

  if (info.toCall === 0) {
    const S = BET_SIZES.map((b) => b.frac);
    const [third, half, twoThirds, over] = S;
    const small = third;
    const big = twoThirds;
    const preferBig = texture.wet || street !== 'flop';
    if (nut) {
      category = '价值下注（强牌）';
      const slow = texture.dry && street === 'flop' ? 0.25 : 0.1;
      if (street === 'river') {
        add('bet', (1 - slow) * 0.45, { size: over });
        add('bet', (1 - slow) * 0.55, { size: big });
      } else {
        add('bet', (1 - slow) * (preferBig ? 0.75 : 0.35), { size: big });
        add('bet', (1 - slow) * (preferBig ? 0.25 : 0.65), { size: small });
      }
      add('check', slow);
      notes.push(slow > 0.15 ? '干燥牌面可以偶尔慢打诱导诈唬' : '强牌应主动建立底池');
    } else if (strong) {
      category = '价值下注';
      const f = 0.72;
      add('bet', f * (preferBig ? 0.6 : 0.3), { size: preferBig ? big : half });
      add('bet', f * (preferBig ? 0.4 : 0.7), { size: preferBig ? half : small });
      add('check', 1 - f);
    } else if (strongDraw) {
      category = '半诈唬（强听牌）';
      const f = (info.isPFR ? 0.65 : 0.4) * (k >= 2 ? 0.7 : 1);
      add('bet', f, { size: big });
      add('check', 1 - f);
      notes.push(draws.flushDraw && (draws.oesd || draws.gutshot) ? '组合听牌，可积极半诈唬' : '听牌有补牌，适合半诈唬');
    } else if (medium) {
      if (info.isPFR && street === 'flop' && texture.dry) {
        category = '持续下注（薄价值/保护）';
        const f = 0.55 * (k >= 2 ? 0.6 : 1);
        add('bet', f, { size: small });
        add('check', 1 - f);
        notes.push('干燥牌面上翻牌前加注者可以高频小注持续下注');
      } else {
        category = '过牌（有摊牌价值）';
        add('bet', 0.2 * multi, { size: street === 'flop' ? small : half });
        add('check', 1 - 0.2 * multi);
        notes.push('中等牌力以控池为主');
      }
    } else {
      let f;
      if (info.isPFR && street === 'flop') f = texture.dry ? 0.45 : 0.25;
      else if (info.inPosition && street !== 'flop') f = 0.2;
      else f = 0.08;
      if (weakDraw || draws.backdoorFlush || draws.overcards) f += 0.12;
      f = Math.min(0.6, f * multi);
      category = f >= 0.3 ? '诈唬与过牌混合（弱牌）' : '过牌 / 放弃';
      // 诈唬：干燥翻牌小注；河牌两极化（2/3 或超池）；其余 1/2
      if (info.isPFR && street === 'flop' && texture.dry) add('bet', f, { size: small });
      else if (street === 'river') {
        add('bet', f * 0.6, { size: big });
        add('bet', f * 0.4, { size: over });
      } else add('bet', f, { size: half });
      add('check', 1 - f);
      if (f < 0.3) notes.push('牌力弱且缺少听牌，多数时候过牌');
    }
  } else {
    let margin = 0.02;
    if (info.facingRaise) margin += 0.07;
    if (info.toCall >= 0.5 * (game.players[seat].stack)) margin += 0.04;
    const implied = strongDraw && info.spr > 2 ? 0.06 : 0;
    const adj = equity + implied;
    const need = info.need;
    const canRaise = la ? la.canRaise : true;
    if (nut) {
      category = '价值加注';
      add('raise', canRaise ? 0.65 : 0, { size: info.spr < 1.5 || street === 'river' ? 4 / 3 : 2 / 3 });
      add('call', canRaise ? 0.35 : 1);
    } else if (strong && adj >= need) {
      category = '价值跟注 / 加注';
      const r = canRaise && !info.facingRaise ? 0.25 : 0;
      add('raise', r, { size: 2 / 3 });
      add('call', 1 - r);
    } else if (adj >= need + margin) {
      if (strongDraw && canRaise && !info.facingRaise) {
        category = '听牌：跟注或半诈唬加注';
        add('raise', 0.25, { size: 2 / 3 });
        add('call', 0.75);
      } else {
        category = strongDraw || weakDraw ? '听牌跟注（赔率合适）' : '跟注（抓诈 / 摊牌价值）';
        add('call', 1);
      }
    } else if (adj >= need + margin - 0.07) {
      category = '边缘：跟注与弃牌混合';
      add('call', 0.35);
      add('fold', 0.65);
    } else {
      category = '弃牌（胜率不足以支付赔率）';
      const bluff = canRaise && !info.facingRaise && street !== 'river' && (weakDraw || draws.backdoorFlush) && info.inPosition ? 0.06 : 0;
      add('raise', bluff, { size: 2 / 3 });
      add('fold', 1 - bluff);
    }
    if (implied) notes.push('听牌考虑隐含赔率');
    notes.push(`需要胜率 ${(need * 100).toFixed(1)}%，估计胜率 ${(equity * 100).toFixed(1)}%`);
  }

  // 计算具体金额
  if (la) {
    for (const a of acts) {
      if (a.kind === 'bet' || a.kind === 'raise') a.to = la.canRaise ? potFractionTo(la, a.size) : null;
    }
    // 不能加注时把加注频率并入跟注/过牌
    for (const a of acts) {
      if ((a.kind === 'bet' || a.kind === 'raise') && !la.canRaise) {
        a.kind = la.canCheck ? 'check' : 'call';
        delete a.size;
        delete a.to;
      }
    }
  }
  // 合并同类并归一化
  const merged = [];
  for (const a of acts) {
    // 两种尺度被限制到同一金额（如都等于全下）时合并
    const m = merged.find((x) => x.kind === a.kind && (a.to !== undefined && a.to !== null ? x.to === a.to : x.size === a.size));
    if (m) m.freq += a.freq;
    else merged.push({ ...a });
  }
  const sum = merged.reduce((s, a) => s + a.freq, 0) || 1;
  for (const a of merged) a.freq /= sum;
  merged.sort((x, y) => y.freq - x.freq);
  return { street, info, category, actions: merged, notes };
}
