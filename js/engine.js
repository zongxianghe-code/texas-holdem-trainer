// 德州扑克（无限注）游戏引擎：纯逻辑状态机，不依赖 DOM。
// 一个 HoldemGame 实例代表一张牌桌上的连续多手牌。

import { createDeck, shuffle, cardsToString, defaultRng } from './cards.js';
import { describeHand } from './evaluator.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river'];
export const STREET_NAMES = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  showdown: '摊牌',
};

const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * 根据每位玩家本手投入的总筹码计算主池/边池。
 * @param {{seat:number, amount:number, folded:boolean}[]} contribs
 * @returns {{amount:number, eligible:number[]}[]} 第一个为主池，其余为边池
 */
export function computePots(contribs) {
  const live = contribs.filter((c) => !c.folded && c.amount > 0);
  const levels = [...new Set(live.map((c) => c.amount))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contribs) amount += Math.max(0, Math.min(c.amount, level) - prev);
    const eligible = live.filter((c) => c.amount >= level).map((c) => c.seat);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  // 超出所有在局玩家投入的死钱（正常流程中不会出现，退还未跟注部分后为 0）
  let extra = 0;
  for (const c of contribs) extra += Math.max(0, c.amount - prev);
  if (extra > 0) {
    if (pots.length) pots[pots.length - 1].amount += extra;
    else pots.push({ amount: extra, eligible: [] });
  }
  return pots;
}

export class HoldemGame {
  /**
   * @param {object} opts
   * @param {number} [opts.numPlayers=6] 2~9
   * @param {number} [opts.startingStack=1000]
   * @param {number} [opts.smallBlind=5]
   * @param {number} [opts.bigBlind=10]
   * @param {number[]} [opts.stacks] 每个座位的初始筹码（指定后忽略 numPlayers/startingStack）
   * @param {string[]} [opts.names]
   * @param {number} [opts.dealerSeat=0] 第一手的庄家座位
   * @param {() => number} [opts.rng] 洗牌随机源
   */
  constructor(opts = {}) {
    const {
      numPlayers = 6,
      startingStack = 1000,
      smallBlind = 5,
      bigBlind = 10,
      stacks,
      names,
      dealerSeat = 0,
      rng,
    } = opts;
    const n = stacks ? stacks.length : numPlayers;
    if (!Number.isInteger(n) || n < 2 || n > 9) throw new Error('玩家人数必须在 2 到 9 之间');
    if (!isPosInt(smallBlind) || !isPosInt(bigBlind) || smallBlind > bigBlind) {
      throw new Error('盲注无效：必须是正整数，且小盲不能大于大盲');
    }
    const initial = stacks ? stacks.slice() : Array(n).fill(startingStack);
    if (!initial.every(isPosInt)) throw new Error('初始筹码必须是正整数');

    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.rng = rng || defaultRng;
    this.players = initial.map((stack, seat) => ({
      seat,
      name: names?.[seat] ?? `玩家${seat + 1}`,
      stack,
      holeCards: [],
      bet: 0, // 本轮（当前街）已下注
      totalBet: 0, // 本手累计投入
      folded: false,
      allIn: false,
      out: false, // 已出局（筹码输光）
      hasActed: false,
      raiseSeen: 0,
      lastAction: '',
    }));
    this.dealer = (((dealerSeat % n) + n) % n) - 1; // startHand 会移动到下一个有效座位
    this.handNumber = 0;
    this.phase = 'waiting'; // waiting | betting | handOver | gameOver
    this.street = null;
    this.board = [];
    this.deck = [];
    this.pendingBoard = [];
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.fullRaiseCount = 0;
    this.toAct = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.log = [];
    this.result = null;
    this.winner = null;
  }

  get numPlayers() {
    return this.players.length;
  }

  /** 当前底池总额（含本轮桌面上的下注） */
  get pot() {
    return this.players.reduce((s, p) => s + p.totalBet, 0);
  }

  /** 桌面上所有筹码（用于守恒校验） */
  get totalChips() {
    return this.players.reduce((s, p) => s + p.stack, 0) + this.pot;
  }

  inHand(p) {
    return !p.out && !p.folded;
  }

  canAct(p) {
    return !p.out && !p.folded && !p.allIn;
  }

  needsAction(p) {
    return this.canAct(p) && (!p.hasActed || p.bet < this.currentBet);
  }

  /** 从 from 之后（不含）顺时针找第一个满足条件的座位 */
  nextSeat(from, pred) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const s = (((from + i) % n) + n) % n;
      if (pred(this.players[s])) return s;
    }
    return -1;
  }

  _log(text, kind = 'action', extra = {}) {
    this.log.push({ hand: this.handNumber, street: this.street, kind, text, ...extra });
  }

  /**
   * 开始新的一手牌。
   * @param {{hole?: (number[]|undefined)[], board?: number[]}} [preset] 测试用：指定手牌/公共牌
   * @returns {boolean} 游戏已结束时返回 false
   */
  startHand(preset) {
    if (this.phase === 'betting') throw new Error('当前这手牌尚未结束');
    if (this.phase === 'gameOver') return false;
    for (const p of this.players) if (p.stack <= 0) p.out = true;
    const alive = this.players.filter((p) => !p.out);
    if (alive.length < 2) {
      this.phase = 'gameOver';
      this.winner = alive[0]?.seat ?? null;
      return false;
    }

    this.handNumber++;
    this.result = null;
    this.board = [];
    this.street = 'preflop';
    for (const p of this.players) {
      p.holeCards = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.out;
      p.allIn = false;
      p.hasActed = false;
      p.raiseSeen = 0;
      p.lastAction = p.out ? '出局' : '';
    }
    this.dealer = this.nextSeat(this.dealer, (p) => !p.out);

    // 牌堆
    let deck = shuffle(createDeck(), this.rng);
    const used = new Set();
    const presetHole = preset?.hole || [];
    const presetBoard = preset?.board || [];
    for (const c of [...presetHole.flat().filter((c) => c !== undefined), ...presetBoard]) {
      if (used.has(c)) throw new Error('预设牌重复');
      used.add(c);
    }
    deck = deck.filter((c) => !used.has(c));
    for (const p of alive) {
      p.holeCards = presetHole[p.seat] ? presetHole[p.seat].slice() : [deck.pop(), deck.pop()];
    }
    this.deck = deck;
    this.pendingBoard = presetBoard.slice();

    const headsUp = alive.length === 2;
    const notOut = (p) => !p.out;
    this.sbSeat = headsUp ? this.dealer : this.nextSeat(this.dealer, notOut);
    this.bbSeat = this.nextSeat(this.sbSeat, notOut);

    this._log(`第 ${this.handNumber} 手开始 · 庄家：${this.players[this.dealer].name}`, 'header');
    this._postBlind(this.players[this.sbSeat], this.smallBlind, '小盲');
    this._postBlind(this.players[this.bbSeat], this.bigBlind, '大盲');

    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.fullRaiseCount = 0;
    this.phase = 'betting';

    const first = headsUp ? this.sbSeat : this.nextSeat(this.bbSeat, notOut);
    this._beginRound(first);
    return true;
  }

  _commit(p, amount) {
    const amt = Math.min(amount, p.stack);
    p.stack -= amt;
    p.bet += amt;
    p.totalBet += amt;
    if (p.stack === 0) p.allIn = true;
    return amt;
  }

  _postBlind(p, amount, label) {
    const amt = this._commit(p, amount);
    p.lastAction = `${label} ${amt}`;
    this._log(`${p.name} 下${label} ${amt}${p.allIn ? '（全下）' : ''}`, 'blind', { seat: p.seat });
  }

  _beginRound(startSeat) {
    if (this._isRoundComplete()) {
      this._finishStreet();
      return;
    }
    const n = this.players.length;
    this.toAct = this.nextSeat(startSeat - 1 + n, (p) => this.needsAction(p));
  }

  _isRoundComplete() {
    const actors = this.players.filter((p) => this.canAct(p));
    if (actors.length === 0) return true;
    if (actors.length === 1) {
      const p = actors[0];
      let maxOther = 0;
      for (const q of this.players) if (q !== p && this.inHand(q)) maxOther = Math.max(maxOther, q.bet);
      return p.bet >= maxOther;
    }
    return actors.every((p) => p.hasActed && p.bet === this.currentBet);
  }

  /** 当前行动玩家可执行的动作 */
  getLegalActions() {
    if (this.phase !== 'betting' || this.toAct < 0) return null;
    const p = this.players[this.toAct];
    const owe = Math.max(0, this.currentBet - p.bet);
    const toCall = Math.min(owe, p.stack);
    const othersCanAct = this.players.some((q) => q !== p && this.canAct(q));
    const reopened = !p.hasActed || p.raiseSeen < this.fullRaiseCount;
    const canRaise = p.stack > owe && othersCanAct && reopened;
    const maxRaiseTo = p.bet + p.stack;
    const minRaiseTo = Math.min(this.currentBet + this.minRaise, maxRaiseTo);
    return {
      seat: p.seat,
      canFold: true,
      canCheck: owe === 0,
      canCall: owe > 0,
      toCall,
      callIsAllIn: owe > 0 && toCall === p.stack,
      canRaise,
      raiseType: this.currentBet === 0 ? 'bet' : 'raise',
      minRaiseTo,
      maxRaiseTo,
      canAllIn: canRaise || (owe > 0 && p.stack <= owe),
      currentBet: this.currentBet,
      pot: this.pot,
      stack: p.stack,
      bet: p.bet,
    };
  }

  /**
   * 执行动作。
   * @param {{type:'fold'|'check'|'call'|'bet'|'raise'|'allin', amount?:number}} action
   *   bet/raise 的 amount 为“本轮下注到”的总额（raise to）
   */
  act(action) {
    if (this.phase !== 'betting') throw new Error('当前不在下注阶段');
    const p = this.players[this.toAct];
    const la = this.getLegalActions();
    let { type, amount } = action;

    if (type === 'allin') {
      if (la.canRaise && la.maxRaiseTo > this.currentBet) {
        type = this.currentBet === 0 ? 'bet' : 'raise';
        amount = la.maxRaiseTo;
      } else if (la.canCall) {
        type = 'call';
      } else {
        throw new Error('当前不能全下');
      }
    }

    let text;
    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = '弃牌';
        text = '弃牌';
        break;
      case 'check':
        if (!la.canCheck) throw new Error('当前不能过牌，需要跟注或弃牌');
        p.lastAction = '过牌';
        text = '过牌';
        break;
      case 'call': {
        if (!la.canCall) throw new Error('当前没有需要跟注的下注');
        const amt = this._commit(p, la.toCall);
        text = p.allIn ? `全下跟注 ${amt}` : `跟注 ${amt}`;
        p.lastAction = p.allIn ? `全下 ${p.bet}` : `跟注 ${p.bet}`;
        break;
      }
      case 'bet':
      case 'raise': {
        if (!la.canRaise) throw new Error('当前不能下注或加注');
        amount = Number(amount);
        if (!Number.isInteger(amount)) throw new Error('下注金额必须是整数');
        if (amount > la.maxRaiseTo) throw new Error(`筹码不足，最多只能到 ${la.maxRaiseTo}`);
        if (amount <= this.currentBet) throw new Error(`金额必须大于当前下注 ${this.currentBet}`);
        const minTo = this.currentBet + this.minRaise;
        if (amount < minTo && amount !== la.maxRaiseTo) {
          throw new Error(`${this.currentBet === 0 ? '最小下注' : '最小加注到'} ${minTo}`);
        }
        const wasBet = this.currentBet === 0;
        const raiseBy = amount - this.currentBet;
        this._commit(p, amount - p.bet);
        if (raiseBy >= this.minRaise) {
          this.minRaise = raiseBy;
          this.fullRaiseCount++;
        }
        this.currentBet = amount;
        const base = wasBet ? `下注 ${amount}` : `加注到 ${amount}`;
        text = p.allIn ? `全下（${base}）` : base;
        p.lastAction = p.allIn ? `全下 ${amount}` : wasBet ? `下注 ${amount}` : `加注到 ${amount}`;
        break;
      }
      default:
        throw new Error(`未知动作: ${type}`);
    }

    p.hasActed = true;
    p.raiseSeen = this.fullRaiseCount;
    this._log(`${p.name} ${text}`, 'action', { seat: p.seat, action: type });
    this._advance(p.seat);
  }

  _advance(lastSeat) {
    if (this.players.filter((p) => this.inHand(p)).length === 1) {
      this._endByFold();
      return;
    }
    if (this._isRoundComplete()) {
      this._finishStreet();
      return;
    }
    this.toAct = this.nextSeat(lastSeat, (p) => this.needsAction(p));
  }

  _returnUncalled() {
    let top = null;
    for (const p of this.players) if (p.bet > 0 && (!top || p.bet > top.bet)) top = p;
    if (!top) return;
    let second = 0;
    for (const p of this.players) if (p !== top) second = Math.max(second, p.bet);
    const excess = top.bet - second;
    if (excess > 0) {
      top.bet -= excess;
      top.totalBet -= excess;
      top.stack += excess;
      if (top.stack > 0) top.allIn = false;
      this._log(`未被跟注的 ${excess} 退还给 ${top.name}`, 'info', { seat: top.seat });
    }
  }

  _dealBoard(k) {
    for (let i = 0; i < k; i++) {
      this.board.push(this.pendingBoard.length ? this.pendingBoard.shift() : this.deck.pop());
    }
  }

  _finishStreet() {
    this._returnUncalled();
    for (const p of this.players) p.bet = 0;
    this.toAct = -1;

    if (this.street === 'river') {
      this._showdown();
      return;
    }
    const idx = STREETS.indexOf(this.street);
    this.street = STREETS[idx + 1];
    this._dealBoard(this.street === 'flop' ? 3 : 1);
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.fullRaiseCount = 0;
    for (const p of this.players) {
      p.hasActed = false;
      p.raiseSeen = 0;
      if (this.canAct(p)) p.lastAction = '';
    }
    this._log(`${STREET_NAMES[this.street]}：${cardsToString(this.board)}（底池 ${this.pot}）`, 'street');

    if (this._isRoundComplete()) {
      this._finishStreet(); // 无人可继续下注：直接发完公共牌
      return;
    }
    this.toAct = this.nextSeat(this.dealer, (p) => this.canAct(p));
  }

  _seatOrderFromDealer() {
    const n = this.players.length;
    return Array.from({ length: n }, (_, i) => (this.dealer + 1 + i) % n);
  }

  _endByFold() {
    this._returnUncalled();
    for (const p of this.players) p.bet = 0;
    const winner = this.players.find((p) => this.inHand(p));
    const amount = this.pot;
    winner.stack += amount;
    this.result = {
      type: 'fold',
      totalPot: amount,
      pots: [{ name: '底池', amount, eligible: [winner.seat], winners: [winner.seat], handName: null }],
      winnings: { [winner.seat]: amount },
      hands: {},
    };
    this._log(`${winner.name} 赢得底池 ${amount}（其他玩家均已弃牌）`, 'result', { seat: winner.seat });
    this._concludeHand();
  }

  _showdown() {
    this.street = 'showdown';
    const live = this.players.filter((p) => this.inHand(p));
    const hands = {};
    for (const p of live) {
      hands[p.seat] = describeHand([...p.holeCards, ...this.board]);
      this._log(`${p.name} 亮牌 ${cardsToString(p.holeCards)} — ${hands[p.seat].name}`, 'showdown', { seat: p.seat });
    }
    const contribs = this.players.map((p) => ({ seat: p.seat, amount: p.totalBet, folded: !this.inHand(p) }));
    const pots = computePots(contribs);
    const order = this._seatOrderFromDealer();
    const winnings = {};
    const totalPot = this.pot;
    const resultPots = pots.map((pot, i) => {
      const name = pots.length === 1 ? '底池' : i === 0 ? '主池' : `边池${i}`;
      let best = -1;
      for (const s of pot.eligible) best = Math.max(best, hands[s].score);
      const winners = pot.eligible.filter((s) => hands[s].score === best).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const share = Math.floor(pot.amount / winners.length);
      let rem = pot.amount - share * winners.length;
      for (const s of winners) {
        const win = share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        this.players[s].stack += win;
        winnings[s] = (winnings[s] || 0) + win;
      }
      const handName = hands[winners[0]].name;
      const names = winners.map((s) => this.players[s].name).join('、');
      if (pot.eligible.length === 1) {
        this._log(`${names} 收回${name} ${pot.amount}`, 'result', { seats: winners });
      } else if (winners.length > 1) {
        this._log(`${names} 以${handName}平分${name} ${pot.amount}`, 'result', { seats: winners });
      } else {
        this._log(`${names} 以${handName}赢得${name} ${pot.amount}`, 'result', { seats: winners });
      }
      return { name, amount: pot.amount, eligible: pot.eligible, winners, handName };
    });
    this.result = { type: 'showdown', totalPot, pots: resultPots, winnings, hands };
    this._concludeHand();
  }

  _concludeHand() {
    for (const p of this.players) {
      p.totalBet = 0;
      p.bet = 0;
    }
    this.toAct = -1;
    this.phase = 'handOver';
    for (const p of this.players) {
      if (!p.out && p.stack === 0) {
        p.out = true;
        p.lastAction = '出局';
        this._log(`${p.name} 筹码输光，出局`, 'info', { seat: p.seat });
      }
    }
    const alive = this.players.filter((p) => !p.out);
    if (alive.length <= 1) {
      this.phase = 'gameOver';
      this.winner = alive[0]?.seat ?? null;
      if (alive[0]) this._log(`游戏结束，${alive[0].name} 赢得全部筹码！`, 'result');
    }
  }
}
