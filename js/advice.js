// 给人类玩家的建议与决策反馈（纯逻辑，无 DOM）。
// 翻牌前：来自范围表（近似 6-max 100BB 图表），尺度以大盲为单位；
// 翻牌后：启发式近似建议（非求解器结果），尺度只用 1/3、1/2、2/3、4/3 底池。
// 每条建议都附带 2–4 条“为什么”，由规则模板根据实际用到的因素生成，不包含任何虚构的求解器数字。

import {
  preflopStrategy, postflopStrategy, positionLabel, SPOT_NAMES, preflopStrength, sizeLabel, BET_SIZES, POSITION_NAMES,
} from './strategy.js';
import { RANGE_SPECS, RANGE_SOURCE_NOTE, rangeWidth } from './ranges.js';

export { BET_SIZES };
export const POSTFLOP_DISCLAIMER = '近似建议，非求解器结果';
export const PREFLOP_NOTE = RANGE_SOURCE_NOTE;

const pct = (x) => `${Math.round(x * 100)}%`;
const RANK_ORDER = 'AKQJT98765432';
const ri = (ch) => RANK_ORDER.indexOf(ch); // 0 = A

/** 起手牌类别的中文描述 */
export function describeHandClass(hc) {
  const a = hc[0];
  const b = hc[1];
  const gap = ri(b) - ri(a);
  const broadway = (r) => 'AKQJT'.includes(r);
  if (hc.length === 2) return ri(a) <= 4 ? '大口袋对子' : ri(a) <= 7 ? '中口袋对子' : '小口袋对子';
  const suited = hc[2] === 's';
  if (broadway(a) && broadway(b)) return suited ? '同花高张' : '杂色高张';
  if (a === 'A') return suited ? '同花 A（Axs）' : '杂色 A（Axo）';
  if (gap === 1) return suited ? '同花连张' : '杂色连张';
  if (gap === 2) return suited ? '同花隔一张' : '杂色隔一张';
  if (a === 'K' || a === 'Q') return suited ? `同花 ${a}x` : `杂色 ${a}x`;
  return suited ? '同花杂牌' : '杂色杂牌';
}

/** 起手牌特征（用于生成理由） */
export function handFeatures(hc) {
  const a = hc[0];
  const b = hc[1];
  const pair = hc.length === 2;
  const suited = hc[2] === 's';
  const gap = pair ? 0 : ri(b) - ri(a);
  const broadway = 'AKQJT'.includes(a) && 'AKQJT'.includes(b);
  const f = {
    pair,
    bigPair: pair && ri(a) <= 3, // TT+
    smallPair: pair && ri(a) >= 7, // 66-
    suited,
    connected: !pair && gap <= 2 && ri(a) >= 1,
    broadway,
    blocksAces: !pair && a === 'A',
    blocksKings: !pair && (a === 'K' || b === 'K'),
    dominated: !pair && !suited && (a === 'A' || a === 'K') && ri(b) >= 4, // A9o-、K9o- 一类
    weakOffsuit: !pair && !suited && !broadway,
  };
  return f;
}

function handFeatureLine(hc, f, pctile) {
  const parts = [];
  if (f.bigPair) parts.push('大对子，翻牌前就领先绝大多数范围');
  else if (f.smallPair) parts.push('小对子主要靠翻出三条（约 1/8 机会）获利，需要足够的筹码深度和赔率');
  else if (f.pair) parts.push('中对子有一定摊牌价值，也可能翻出三条');
  if (f.broadway) parts.push('两张高张，容易配出顶对强踢脚');
  if (f.suited) parts.push('同花能带来同花听牌，翻牌后可玩性更好');
  if (f.connected && !f.broadway) parts.push('连张/隔张能形成顺子听牌');
  if (f.dominated) parts.push(`杂色弱踢脚的 ${hc[0]}，容易被更大的 ${hc[0]}x 压制（击中也常输大底池）`);
  if (f.weakOffsuit && !f.connected && !f.dominated) parts.push('杂色不连接，翻牌后很难击中有价值的牌');
  const head = `${hc}（${describeHandClass(hc)}，强度约前 ${Math.max(1, Math.round(pctile * 100))}%）`;
  return parts.length ? `${head}：${parts.slice(0, 2).join('；')}。` : `${head}。`;
}

function preflopReasons(adv, s, game) {
  const reasons = [];
  const f = handFeatures(adv.handClass);
  const t = s.spot.type;
  const pos = s.position;
  const posName = POSITION_NAMES[pos] || pos;
  // 1) 位置与范围宽度
  if (t === 'rfi') {
    const w = rangeWidth(s.tableKey, 'raise');
    reasons.push(
      `${posName}开池，身后还有 ${s.playersBehind} 名玩家未行动，${s.playersBehind >= 4 ? '被更强牌击中的概率高，' : s.playersBehind <= 2 ? '只需越过少数玩家，' : ''}此位置开池范围约 ${pct(w)}（越靠后越宽）。`,
    );
  } else if (t === 'vsOpen') {
    const opW = RANGE_SPECS[`RFI_${s.spot.openerPos}`] ? rangeWidth(`RFI_${s.spot.openerPos}`, 'raise') : null;
    const oop = pos === 'SB' || pos === 'BB';
    reasons.push(
      `面对${POSITION_NAMES[s.spot.openerPos] || '对手'}开池${opW ? `（其范围约 ${pct(opW)}）` : ''}，你${oop ? '翻牌后无位置' : '翻牌后有位置'}；${
        pos === 'BB' ? '大盲已投入 1BB，跟注价格较好，所以防守范围较宽。' : oop ? '小盲无位置，通常采用 3bet 或弃牌，很少平跟。' : '有位置可以更多平跟，也可用部分牌 3bet。'
      }`,
    );
  } else if (t === 'vs3bet') {
    reasons.push('你开池后被 3bet：对手的范围已明显变强，只继续较强或可玩性好的牌，其余放弃。');
  } else if (t === 'coldVs3bet' || t === 'coldVs4bet') {
    reasons.push('前面已有开池和再加注，两名对手的范围都很强，冷跟/冷加注只用顶级牌。');
  } else if (t === 'vs4bet') {
    reasons.push('面对 4bet，对手范围集中在大对子和 AK，只用最强的牌继续。');
  } else {
    reasons.push(`前面有人溜入（${s.spot.limpers} 人）：溜入范围通常较弱，可以用较强的牌隔离加注，${pos === 'BB' ? '其余免费过牌看翻牌。' : '其余多数弃牌。'}`);
  }
  // 2) 手牌特征
  reasons.push(handFeatureLine(adv.handClass, f, adv.percentile));
  // 3) 阻断牌（3bet/4bet 诈唬时）
  if ((t === 'vsOpen' || t === 'vs3bet') && adv.freqs.raise > 0 && adv.freqs.raise < 0.9 && (f.blocksAces || f.blocksKings)) {
    reasons.push(`手里有 ${f.blocksAces ? 'A' : 'K'}，减少了对手持有 ${f.blocksAces ? 'AA/AK' : 'KK/AK'} 的组合（阻断效应），适合作为再加注的诈唬牌。`);
  }
  // 4) 混合频率 / 尺度 / 弃牌原因
  const maxF = Math.max(adv.freqs.raise, adv.freqs.call, adv.freqs.fold);
  if (maxF < 0.95) {
    reasons.push('这手牌处于范围边缘，不同动作的期望值接近，按频率混合可以平衡范围、避免被针对；实战可随机选择。');
  }
  if (adv.primary === 'raise' && s.sizing) {
    const k = s.sizing.kind;
    const why = {
      open: '开池 2.5BB：足以争夺盲注，被 3bet 时损失也较小。',
      sbOpen: '小盲开池 3BB：翻牌后无位置，用稍大尺度减少大盲的跟注赔率。',
      iso: '隔离加注 3BB + 每名溜入者 1BB：底池里已有额外筹码，尺度要更大才能让溜入者难以跟注。',
      '3betIP': '有位置 3bet 约 3 倍：位置优势让你翻牌后更好操作，不需要太大尺度。',
      '3betOOP': '无位置 3bet 约 4 倍：翻牌后处于位置劣势，用更大尺度让对手少跟注、多弃牌。',
      squeeze: '挤压加注 4 倍 + 每名跟注者 1 倍：需要同时压迫开池者和跟注者。',
      '4bet': '4bet 约 2.2 倍：足以让对手难以用边缘牌继续，同时保留面对全下时弃牌的余地。',
      jam: '直接全下：剩余筹码已不足以再做小额加注。',
    }[k];
    if (why) reasons.push(why);
  } else if (adv.primary === 'fold') {
    reasons.push(
      f.dominated
        ? '弃牌：继续时常被更好的同类牌压制，赢小底池、输大底池。'
        : '弃牌：这手牌的胜率与翻牌后可玩性不足以支付继续的成本，长期看放弃更省筹码。',
    );
  } else if (adv.primary === 'call' && !adv.canCheck) {
    reasons.push('跟注：牌力足以继续，但用来再加注时价值或诈唬效果不如范围中的其他牌。');
  } else if (adv.canCheck && adv.primary === 'call') {
    reasons.push('可以免费过牌看翻牌，没有必要弃牌。');
  }
  for (const n of s.notes) reasons.push(`${n}。`);
  return trimReasons(reasons);
}

function trimReasons(list) {
  const out = [];
  for (const r of list) if (r && !out.includes(r)) out.push(r);
  if (out.length > 4) {
    // 保留第一条（位置/赔率）与最后一条（尺度或结论），中间取前两条
    return [out[0], out[1], out[2], out[out.length - 1]];
  }
  return out;
}

/** 把策略分类映射为理由模板（顺序很重要：先匹配更具体的分类） */
export function categoryKind(cat) {
  if (cat.startsWith('价值')) return 'value';
  if (cat.startsWith('持续下注')) return 'cbet';
  if (cat.startsWith('半诈唬') || cat.startsWith('听牌：')) return 'draw';
  if (cat.startsWith('听牌跟注')) return 'drawCall';
  if (cat.startsWith('过牌（有摊牌价值）')) return 'control';
  if (cat.startsWith('诈唬') || cat.startsWith('过牌 / 放弃')) return 'bluff';
  if (cat.startsWith('边缘')) return 'mixed';
  if (cat.startsWith('弃牌')) return 'fold';
  if (cat.startsWith('跟注')) return 'call';
  return 'other';
}

/** 谁有范围/坚果优势（规则模板） */
function advantageLine(info) {
  const tx = info.texture;
  const me = info.isPFR ? '你（翻牌前加注者）' : '对手（翻牌前加注者）';
  if (tx.monotone) {
    return info.made.category >= 5
      ? '单色牌面而你已成同花：你的牌力在这个牌面上很强，可以用较大尺度向更差的同花和听牌收费。'
      : '单色牌面：坚果优势取决于谁有更多同花组合，没有同花时宜控池。';
  }
  if (tx.paired) return `公对牌面双方都较少击中，范围优势通常在${me}一方。`;
  if (tx.high >= 10 && !tx.connected) return `高牌、干燥的牌面：${me}拥有更多大牌和超对组合，范围优势明显。`;
  if (tx.high <= 7 && tx.connected) return `低而连接的牌面更多击中跟注方范围（两对、顺子），${me}的范围优势较小。`;
  if (tx.wet) return '湿润牌面：听牌很多，成牌需要保护，坚果组合双方都有。';
  return '牌面中性，双方范围优势不大。';
}

function outsInfo(draws, street) {
  let outs = 0;
  if (draws.flushDraw) outs += 9;
  if (draws.oesd) outs += 8;
  else if (draws.gutshot) outs += 4;
  if (draws.flushDraw && (draws.oesd || draws.gutshot)) outs -= 2; // 重叠
  if (!outs) return null;
  const pctOne = outs * 2;
  return { outs, text: `听牌约 ${outs} 张补牌：下一张牌约 ${pctOne}% 成牌${street === 'flop' ? `，到河牌约 ${Math.min(outs * 4, 60)}%（2/4 法则）` : ''}` };
}

function sizeReason(adv, info) {
  const agg = adv.actions.filter((a) => (a.kind === 'bet' || a.kind === 'raise') && a.size).sort((x, y) => y.freq - x.freq)[0];
  if (!agg) return null;
  const s = agg.size;
  const raise = agg.kind === 'raise';
  if (s === 1 / 3) return '尺度 1/3 池：干燥牌面且有范围优势时，小注高频下注就能施压，并以低成本拿到价值或弃牌。';
  if (s === 1 / 2) return '尺度 1/2 池：兼顾价值与保护，适合中等牌力或转牌继续施压。';
  if (s === 2 / 3) {
    if (!raise && info.street === 'river') return '河牌下注 2/3 池：足够大以获得价值，又让更差的成牌仍愿意跟注。';
    return raise
      ? '加注到约 2/3 池：让听牌付出足够代价，同时为强牌建立底池。'
      : info.texture.wet
        ? '尺度 2/3 池：湿润牌面要向听牌收费并保护成牌。'
        : '尺度 2/3 池：后面街道用较大尺度建立底池、增加弃牌压力。';
  }
  return info.street === 'river'
    ? '尺度 4/3 池（超池）：河牌范围两极化（坚果或诈唬），超池能最大化强牌价值并给诈唬最大弃牌率。'
    : '尺度 4/3 池（超池）：拥有坚果优势或筹码较浅时，超池能尽快把筹码投入底池。';
}

function postflopReasons(adv, info) {
  const r = [];
  const eq = info.equity;
  if (info.toCall > 0) {
    const mdf = Math.max(0, (info.pot - info.toCall) / info.pot);
    let verdict;
    if (eq >= info.need) {
      verdict = adv.primary === 'fold' ? '只是略高于要求；对手下注后的范围往往比估计更强，余量不够。' : '胜率足够支付跟注。';
    } else {
      verdict = adv.primary === 'fold' ? '胜率不足以支付跟注。' : '略低于要求，但听牌还有后续街道的隐含赔率。';
    }
    r.push(`对估计范围胜率约 ${pct(eq)}，底池赔率要求至少 ${pct(info.need)}：${verdict}`);
    r.push(
      `面对这个下注，整体范围需要约 ${pct(mdf)} 的频率继续（最小防守频率 MDF），否则对手可以任意诈唬；${
        adv.primary === 'fold' ? '这手牌属于范围中最弱的一部分，适合作为放弃的部分。' : '这手牌足够强，应该在继续的部分里。'
      }`,
    );
  } else {
    r.push(`对估计范围胜率约 ${pct(eq)}（${info.numOpp} 名对手），${info.inPosition ? '你有位置' : '你无位置'}，SPR ${info.spr.toFixed(1)}。`);
  }
  const cat = adv.category;
  const o = outsInfo(info.draws, info.street);
  const kind = categoryKind(cat);
  const logic = {
    value: '牌力领先对手的估计范围，下注/加注可以从更差的牌那里获得价值，并保护你的成牌。',
    cbet: '作为翻牌前加注者，在对你有利的干燥牌面上可以用较多的牌小注持续下注。',
    draw: `${o ? o.text : '有听牌'}；主动下注既可能逼走更好的牌，没被跟住时也保留成牌机会。`,
    drawCall: `${o ? o.text : '有听牌'}；按当前价格跟注看下一张牌是划算的。`,
    control: '中等牌力：下注时更好的牌会跟、更差的牌会弃，所以过牌控池、保留摊牌价值。',
    bluff: '牌力弱，主要靠对手弃牌获利；只在有后门听牌、高张或牌面对你有利时少量诈唬，其余过牌。',
    mixed: '胜率与所需胜率接近（还要留出对手下注范围更强的余量），跟注与弃牌的期望值相近，可以混合。',
    fold: '长期来看，胜率不足以支付赔率的跟注会亏损；除非有明确的隐含赔率，否则放弃。',
    call: '跟注有利：加注会让更差的牌弃掉、只被更好的牌跟注，所以以跟注为主。',
  }[kind];
  if (logic) r.push(logic);
  if (o && kind !== 'draw' && kind !== 'drawCall') r.push(`${o.text}。`);
  r.push(advantageLine(info));
  const sz = adv.primary === 'aggressive' || adv.groups.aggressive >= 0.3 ? sizeReason(adv, info) : null;
  if (sz) r.push(sz);
  return trimReasons(r);
}

function preflopActionNames(advice) {
  const t = advice.spot.type;
  const raise =
    t === 'rfi' ? '开池加注'
      : t === 'vsLimp' || t === 'sbVsLimp' || t === 'bbVsLimp' ? '加注（隔离）'
        : t === 'vsOpen' ? (advice.spot.callersAfter > 0 ? '挤压 3bet' : '3bet')
          : t === 'vs3bet' || t === 'coldVs3bet' ? '4bet'
            : '全下';
  const call = advice.canCheck ? '过牌' : '跟注';
  return { raise, call, fold: '弃牌' };
}

/**
 * 当前行动座位的建议（附带 reasons：2–4 条中文理由）。
 */
export function getAdvice(game, seat = game.toAct, opts = {}) {
  const la = game.toAct === seat ? game.getLegalActions() : null;
  if (game.street === 'preflop') {
    const s = preflopStrategy(game, seat);
    const allIn = la && s.raiseTo === la.maxRaiseTo;
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
      sizing: s.sizing,
      sizeText: s.raiseTo ? `${s.sizing.label}（到 ${s.raiseTo}${allIn ? '，即全下' : ''}）` : '',
      canCheck: !!la?.canCheck,
      notes: s.notes,
      source: PREFLOP_NOTE,
    };
    advice.names = preflopActionNames(advice);
    advice.primary = ['raise', 'call', 'fold'].reduce((best, k) => (s.freqs[k] > s.freqs[best] + 1e-9 ? k : best), 'fold');
    advice.groups = { aggressive: s.freqs.raise, passive: s.freqs.call, fold: s.freqs.fold };
    advice.reasons = preflopReasons(advice, s, game);
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
  const advice = {
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
  advice.reasons = postflopReasons(advice, info);
  return advice;
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

/** 偏离方向的具体原因 */
function deviationReason(advice, group) {
  const order = { fold: 0, passive: 1, aggressive: 2 };
  const best = advice.primary;
  const looser = order[group] > order[best];
  if (advice.street === 'preflop') {
    const f = handFeatures(advice.handClass);
    const p = `约前 ${Math.max(1, Math.round(advice.percentile * 100))}%`;
    if (looser && best === 'fold') {
      return `偏松：${advice.handClass}（${p}）不在该点位的继续范围内${f.dominated ? '，而且容易被更好的同类牌压制' : f.weakOffsuit ? '，杂色不连接、翻牌后难以获利' : ''}。`;
    }
    if (looser) return `偏激进：${advice.handClass} 在这里更适合${advice.names[GROUP_KEY_PRE[best]]}，再加注会让更差的牌弃掉、只被更好的牌继续。`;
    if (group === 'fold') return `偏紧：${advice.handClass}（${p}）在该点位有足够的牌力或可玩性继续，弃牌放弃了正期望。`;
    return `偏被动：${advice.handClass} 在这里主要用来${advice.names.raise}，只跟注会少赢价值、也让对手更容易实现胜率。`;
  }
  const eq = pct(advice.equity);
  const need = pct(advice.need);
  if (group === 'passive' && best === 'fold') return `跟注偏松：估计胜率 ${eq} 低于赔率要求的 ${need}，长期会亏损。`;
  if (group === 'fold') {
    return advice.toCall > 0
      ? `弃牌偏紧：估计胜率 ${eq} 高于所需的 ${need}，而且需要防守足够频率，弃牌放弃了正期望。`
      : '可以免费过牌时不应弃牌。';
  }
  if (group === 'aggressive') {
    return advice.equity < 0.35
      ? '偏激进：牌力弱、缺少听牌，这里诈唬的频率应很低。'
      : '偏激进：中等牌力下注/加注时，更好的牌会继续、更差的牌会弃掉，价值有限。';
  }
  return `偏被动：牌力领先（估计胜率 ${eq}），过牌或只跟注放弃了价值，也让对手的听牌免费看牌。`;
}

/**
 * 对玩家实际动作给出反馈。
 * @param {object} advice getAdvice() 的结果（在行动前计算）
 * @param {{type:string, amount?:number}} action 实际执行的动作（allin 视为加注）
 * @returns {{verdict:'good'|'ok'|'bad', label:string, text:string, reasons:string[]}}
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
  const reasons = [];
  if (verdict !== 'good') reasons.push(deviationReason(advice, group));
  else if (verdict === 'good' && freq < 0.95 && freq > 0) reasons.push('这里是混合策略，你的选择是合理的一部分。');
  // 尺度反馈
  if (group === 'aggressive' && action.amount) {
    const recs = advice.street === 'preflop'
      ? (advice.raiseTo ? [{ to: advice.raiseTo, label: advice.sizing.label }] : [])
      : advice.actions.filter((a) => (a.kind === 'bet' || a.kind === 'raise') && a.to).map((a) => ({ to: a.to, label: sizeLabel(a.size) }));
    if (recs.length && !recs.some((r) => r.to === action.amount)) {
      const closest = recs.reduce((b, r) => (Math.abs(r.to - action.amount) < Math.abs(b.to - action.amount) ? r : b));
      if (Math.abs(action.amount - closest.to) / closest.to > 0.25) {
        reasons.push(`尺度：建议 ${recs.map((r) => `${r.label}（到 ${r.to}）`).join(' 或 ')}，你下到 ${action.amount}。`);
      }
    }
  }
  // 补充 1–2 条建议本身的理由
  for (const r of advice.reasons || []) {
    if (reasons.length >= 3) break;
    reasons.push(r);
  }
  if (advice.street !== 'preflop') parts.push(`（${POSTFLOP_DISCLAIMER}）`);
  return { verdict, label, text: parts.join(''), reasons };
}
