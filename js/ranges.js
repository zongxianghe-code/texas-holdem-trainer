// 6 人桌 100BB 翻牌前范围表（数据模块）
//
// 来源与假设：这些范围是根据常见的公开 6-max 100BB 现金局翻牌前图表整理的“近似”范围，
// 并做了简化（例如小盲采用“加注或弃牌”策略、不区分开池尺度、多人底池沿用单挑范围）。
// 它们不是任何求解器（solver）的精确输出，只用于训练参考与电脑玩家决策。
//
// 记法：逗号分隔；"TT+" 表示 TT 及以上；"A2s-A5s" 表示区间；"ATs+" 表示 ATs、AJs、AQs、AKs；
// "AK" 同时表示 AKs 与 AKo；"*" 表示全部 169 种起手牌；":0.5" 表示该组合以 50% 频率执行。
// 每个点位有 raise（加注 / 3bet / 4bet）与 call（跟注 / 过牌）两份列表；
// 若某手牌同时出现在两份列表中，跟注频率取“1 − 加注频率”与列出频率中的较小值；其余为弃牌。

import { RANK_CHARS, rankOf, suitOf } from './cards.js';

export const RANGE_SOURCE_NOTE =
  '范围表依据常见公开的 6 人桌 100BB 翻牌前图表整理并简化，属于近似范围，并非求解器精确输出。';

const OVERLIMP = '22-77:0.5, T9s:0.4, 98s:0.4, 87s:0.4, 76s:0.4, 65s:0.4, 54s:0.4';

const RFI = {
  UTG: '55+, 44:0.5, 33:0.5, 22:0.5, A2s+, K9s+, Q9s+, J9s+, T9s, 98s:0.5, 87s:0.5, 76s:0.5, 65s:0.5, AJo+, ATo:0.5, KQo, KJo:0.5',
  HJ: '22+, A2s+, K8s+, Q9s+, J9s+, T8s+, 98s, 87s, 76s:0.7, 65s:0.7, 54s:0.5, ATo+, KJo+, QJo, KTo:0.5, QTo:0.3, JTo:0.3',
  CO: '22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 64s:0.5, 54s, A8o+, A7o:0.5, A5o:0.5, KTo+, QTo+, JTo, K9o:0.5, T9o:0.3',
  BTN: '22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 74s+, 63s+, 53s+, 43s, A2o+, K8o+, Q9o+, J9o+, T8o+, 98o, K7o:0.5, Q8o:0.5, J8o:0.5, 87o:0.5, 97o:0.3, 76o:0.3',
  SB: '22+, A2s+, K3s+, Q6s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, 43s:0.5, A4o+, A3o:0.5, A2o:0.5, K9o+, K8o:0.5, Q9o+, J9o+, T9o, 98o:0.5',
};

/** 每个点位：name 中文说明，raise / call 范围字符串 */
export const RANGE_SPECS = {
  // ---- 无人入池时开池（RFI）----
  RFI_UTG: { name: '枪口位（UTG）开池加注', raise: RFI.UTG, call: '' },
  RFI_HJ: { name: '劫持位（HJ）开池加注', raise: RFI.HJ, call: '' },
  RFI_CO: { name: '关煞位（CO）开池加注', raise: RFI.CO, call: '' },
  RFI_BTN: { name: '庄位（BTN）开池加注', raise: RFI.BTN, call: '' },
  RFI_SB: { name: '小盲（SB）开池加注（加注或弃牌）', raise: RFI.SB, call: '' },

  // ---- 面对开池加注 ----
  IP_vs_EP: {
    name: '非盲位面对前位（UTG/HJ）开池：3bet / 跟注',
    raise: 'QQ+, AKs, AKo, JJ:0.3, AQs:0.3, KQs:0.3, A5s:0.5, A4s:0.5, 76s:0.2, 65s:0.2',
    call: 'JJ-66, 55:0.5, 44:0.5, AQs-ATs, KQs, KJs, QJs, JTs, T9s, 98s:0.5, AQo:0.7',
  },
  IP_vs_LP: {
    name: '庄位面对关煞位（CO）开池：3bet / 跟注',
    raise: 'JJ+, AQs+, AKo, AQo:0.5, A5s:0.6, A4s:0.6, A3s:0.4, KJs:0.4, K9s:0.3, QTs:0.3, 76s:0.3, 65s:0.3',
    call: 'TT-22, AJs, ATs, A9s:0.7, KQs, KJs, KTs, QJs, QTs, JTs, T9s, 98s, 87s, AQo, AJo:0.6, KQo:0.6',
  },
  SB_vs_EP: {
    name: '小盲面对前位开池：3bet 或弃牌',
    raise: 'TT+, AQs+, AKo, 99:0.5, AJs:0.5, KQs:0.5, A5s:0.5, A4s:0.5, AQo:0.5',
    call: '',
  },
  SB_vs_LP: {
    name: '小盲面对后位（CO/BTN）开池：3bet 或弃牌',
    raise: '88+, ATs+, KTs+, QJs, AJo+, KQo, 77:0.6, 66:0.4, JTs:0.5, QTs:0.5, K9s:0.4, T9s:0.4, 98s:0.3, A5s-A2s:0.6',
    call: '',
  },
  BB_vs_EP: {
    name: '大盲面对前位（UTG/HJ）开池：防守',
    raise: 'QQ+, AKs, AKo, JJ:0.3, KQs:0.3, A5s:0.5, A4s:0.5',
    call: 'JJ-22, A2s+, K8s+, Q9s+, J9s+, T8s+, 97s+, 87s, 86s, 76s, 65s, 54s, ATo+, KQo, KJo, QJo:0.5',
  },
  BB_vs_CO: {
    name: '大盲面对关煞位（CO）开池：防守',
    raise: 'JJ+, AQs+, AKo, TT:0.4, AQo:0.4, A5s:0.6, A4s:0.6, KJs:0.3, K9s:0.2, 76s:0.3, 65s:0.3',
    call: 'TT-22, A2s+, K2s+, Q6s+, J7s+, T7s+, 96s+, 85s+, 75s+, 64s+, 53s+, 43s, A9o+, KTo+, QTo+, JTo, T9o, A8o:0.5, K9o:0.5, 98o:0.5',
  },
  BB_vs_BTN: {
    name: '大盲面对庄位（BTN）开池：防守',
    raise: 'TT+, AJs+, AQo+, KQs, 99:0.4, ATs:0.5, KJs:0.5, A5s-A2s:0.5, K9s:0.3, Q9s:0.3, J9s:0.3, T8s:0.3, 97s:0.3, 86s:0.3, 75s:0.3, 64s:0.3',
    call: '99-22, A2s+, K2s+, Q2s+, J5s+, T6s+, 95s+, 84s+, 74s+, 63s+, 52s+, 42s+, A2o+, K7o+, Q8o+, J8o+, T8o+, 97o+, 87o, 76o, 65o:0.5',
  },
  BB_vs_SB: {
    name: '大盲面对小盲开池：防守',
    raise: '99+, ATs+, KJs+, AJo+, KQo, 88:0.5, A5s-A2s:0.5, K9s:0.4, QTs:0.4, J9s:0.4, T8s:0.4, 87s:0.4, 76s:0.4, 65s:0.4',
    call: '88-22, A2s+, K2s+, Q2s+, J4s+, T5s+, 95s+, 84s+, 73s+, 63s+, 52s+, 42s+, 32s, A2o+, K5o+, Q7o+, J7o+, T7o+, 97o+, 86o+, 76o, 65o, 54o:0.5',
  },

  // ---- 开池后面对 3bet ----
  EP_vs_3bet: {
    name: '前位开池后面对 3bet：4bet / 跟注 / 弃牌',
    raise: 'KK+, AKs, QQ:0.5, AKo:0.6, A5s:0.3, A4s:0.2',
    call: 'QQ-TT, 99:0.7, 88:0.5, 77:0.3, AKo, AQs, AJs, ATs:0.5, KQs, KJs:0.5, QJs:0.5, JTs:0.6, T9s:0.4, AQo:0.4',
  },
  LP_vs_3bet: {
    name: '后位开池后面对 3bet：4bet / 跟注 / 弃牌',
    raise: 'QQ+, AKs, AKo:0.7, JJ:0.3, A5s:0.4, A4s:0.3, A3s:0.2, KJs:0.2',
    call: 'JJ-66, 55:0.5, AKo, AQs-ATs, A9s:0.5, KQs, KJs, KTs, QJs, QTs, JTs, T9s, 98s, 87s:0.6, 76s:0.6, AQo, AJo:0.5, KQo:0.5',
  },
  SB_vs_3bet: {
    name: '小盲开池后面对大盲 3bet：4bet / 跟注 / 弃牌',
    raise: 'QQ+, AKs, AKo:0.7, JJ:0.3, A5s:0.4, A4s:0.4, K9s:0.2',
    call: 'JJ-55, AQs-A8s, KQs, KJs, KTs, QJs, QTs, JTs, T9s, 98s, 87s:0.6, 76s:0.5, AKo, AQo, AJo:0.5, KQo:0.5',
  },
  COLD_vs_3bet: {
    name: '未主动加注时面对开池 + 3bet：冷 4bet / 冷跟注 / 弃牌',
    raise: 'KK+, AKs:0.5',
    call: 'QQ, JJ:0.6, TT:0.3, AKs, AKo:0.6, AQs:0.3',
  },
  VS_4bet: {
    name: '面对 4bet 及以上：全下 / 跟注 / 弃牌',
    raise: 'KK+, AKs, QQ:0.5, AKo:0.5, A5s:0.15',
    call: 'QQ, JJ:0.7, TT:0.3, AKo, AQs:0.5, KQs:0.2',
  },

  // ---- 有人溜入（limp）----
  ISO_UTG: { name: '面对溜入：隔离加注 / 跟入', raise: RFI.UTG, call: OVERLIMP },
  ISO_HJ: { name: '面对溜入：隔离加注 / 跟入', raise: RFI.UTG, call: OVERLIMP },
  ISO_CO: { name: '面对溜入：隔离加注 / 跟入', raise: RFI.HJ, call: OVERLIMP },
  ISO_BTN: { name: '面对溜入：隔离加注 / 跟入', raise: RFI.CO, call: OVERLIMP },
  SB_vs_limp: {
    name: '小盲面对溜入：加注 / 补盲 / 弃牌',
    raise: '77+, ATs+, KJs+, AJo+, KQo',
    call: '22+, A2s+, K9s+, Q9s+, J9s+, T8s+, 97s+, 86s+, 76s, 65s, 54s, ATo+, KJo+',
  },
  BB_vs_limp: {
    name: '大盲面对溜入：加注 / 过牌',
    raise: '88+, ATs+, KTs+, QJs, AJo+, KQo, A5s:0.4, 98s:0.2',
    call: '*',
  },
};

// ---------- 起手牌类别 ----------

const RANKS_DESC = 'AKQJT98765432';

/** 13x13 网格中的起手牌：对角线为对子，右上为同花，左下为杂色 */
export function gridHand(row, col) {
  const a = RANKS_DESC[row];
  const b = RANKS_DESC[col];
  if (row === col) return a + a;
  return row < col ? a + b + 's' : b + a + 'o';
}

/** 全部 169 种起手牌（网格顺序） */
export const HAND_CLASSES = (() => {
  const out = [];
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) out.push(gridHand(r, c));
  return out;
})();

export const comboCount = (hc) => (hc.length === 2 ? 6 : hc[2] === 's' ? 4 : 12);

/** 两张底牌 → 起手牌类别，如 "AKs" / "T9o" / "77" */
export function handClassOf(c1, c2) {
  let r1 = rankOf(c1);
  let r2 = rankOf(c2);
  if (r1 < r2) [r1, r2] = [r2, r1];
  if (r1 === r2) return RANK_CHARS[r1] + RANK_CHARS[r2];
  return RANK_CHARS[r1] + RANK_CHARS[r2] + (suitOf(c1) === suitOf(c2) ? 's' : 'o');
}

/** 所有 1326 种具体组合，按类别分组 */
export const CLASS_COMBOS = (() => {
  const map = new Map(HAND_CLASSES.map((h) => [h, []]));
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) map.get(handClassOf(a, b)).push([a, b]);
  return map;
})();

// ---------- 解析 ----------

const rv = (ch) => {
  const v = RANK_CHARS.indexOf(ch);
  if (v < 0) throw new Error(`无效点数: ${ch}`);
  return v;
};
const pairName = (v) => RANK_CHARS[v] + RANK_CHARS[v];
const nonPair = (hi, lo, suf) => (suf ? [RANK_CHARS[hi] + RANK_CHARS[lo] + suf] : [RANK_CHARS[hi] + RANK_CHARS[lo] + 's', RANK_CHARS[hi] + RANK_CHARS[lo] + 'o']);

function expandToken(tok) {
  if (tok === '*') return HAND_CLASSES.slice();
  let m;
  if ((m = tok.match(/^([2-9TJQKA])\1(\+)?$/))) {
    const v = rv(m[1]);
    const out = [];
    for (let x = v; x <= (m[2] ? 12 : v); x++) out.push(pairName(x));
    return out;
  }
  if ((m = tok.match(/^([2-9TJQKA])\1-([2-9TJQKA])\2$/))) {
    let a = rv(m[1]);
    let b = rv(m[2]);
    if (a > b) [a, b] = [b, a];
    const out = [];
    for (let x = a; x <= b; x++) out.push(pairName(x));
    return out;
  }
  if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so])?(\+)?$/))) {
    let hi = rv(m[1]);
    let lo = rv(m[2]);
    if (hi === lo) throw new Error(`无效记法: ${tok}`);
    if (hi < lo) [hi, lo] = [lo, hi];
    const out = [];
    for (let k = lo; k <= (m[4] ? hi - 1 : lo); k++) out.push(...nonPair(hi, k, m[3]));
    return out;
  }
  if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so])?-([2-9TJQKA])([2-9TJQKA])([so])?$/))) {
    if (m[1] !== m[4] || (m[3] || '') !== (m[6] || '')) throw new Error(`无效区间: ${tok}`);
    const hi = rv(m[1]);
    let a = rv(m[2]);
    let b = rv(m[5]);
    if (a > b) [a, b] = [b, a];
    if (b >= hi) throw new Error(`无效区间: ${tok}`);
    const out = [];
    for (let k = a; k <= b; k++) out.push(...nonPair(hi, k, m[3]));
    return out;
  }
  throw new Error(`无法解析的范围记法: ${tok}`);
}

/** 解析范围字符串 → Map(起手牌 → 频率)；后出现的条目覆盖先出现的 */
export function parseRange(str) {
  const map = new Map();
  if (!str || !str.trim()) return map;
  for (const raw of str.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const [tok, f] = t.split(':');
    const freq = f === undefined ? 1 : Number(f);
    if (!(freq >= 0 && freq <= 1)) throw new Error(`无效频率: ${t}`);
    for (const h of expandToken(tok.trim())) map.set(h, freq);
  }
  return map;
}

const tableCache = new Map();

/** 获取点位表：Map(起手牌 → {raise, call, fold})，三者之和为 1 */
export function getTable(key) {
  if (tableCache.has(key)) return tableCache.get(key);
  const spec = RANGE_SPECS[key];
  if (!spec) throw new Error(`未知的范围表: ${key}`);
  const raise = parseRange(spec.raise);
  const call = parseRange(spec.call);
  const table = new Map();
  for (const h of HAND_CLASSES) {
    const r = raise.get(h) || 0;
    const c = Math.min(call.get(h) || 0, 1 - r);
    const fold = Math.max(0, 1 - r - c);
    table.set(h, { raise: r, call: c, fold: Math.abs(fold) < 1e-12 ? 0 : fold });
  }
  tableCache.set(key, table);
  return table;
}

/** 某个动作（raise / call / any）在全部 1326 种组合中所占比例 */
export function rangeWidth(key, action = 'raise') {
  const t = getTable(key);
  let w = 0;
  for (const [h, f] of t) {
    const v = action === 'any' ? f.raise + f.call : f[action];
    w += v * comboCount(h);
  }
  return w / 1326;
}
