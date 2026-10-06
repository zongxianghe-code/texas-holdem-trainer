// 界面层：只负责渲染与交互，所有规则都在 engine.js 中。

import { HoldemGame, STREET_NAMES } from './engine.js';
import { describeHand } from './evaluator.js';
import { calcEquity } from './equity.js';
import { RANK_LABELS, SUIT_SYMBOLS, rankOf, suitOf, isRed } from './cards.js';
import { decideBotAction, legalize } from './bot.js';
import { getAdvice, evaluateDecision, adviceSummary, POSTFLOP_DISCLAIMER } from './advice.js';
import { getTable, gridHand } from './ranges.js';
import { BET_SIZES, potFractionTo, sizeLabel, preflopQuickSizes } from './strategy.js';
import { isHoleVisible, buildHandReview, reviewLogLines } from './review.js';

const EQUITY_ITERATIONS = 3000;
const SETTINGS_KEY = 'holdem-trainer-settings';

const $ = (id) => document.getElementById(id);

const state = {
  game: null,
  settings: null,
  mode: 'bot', // bot | hotseat
  humanSeat: 0,
  difficulty: 'standard',
  botSpeed: 700,
  showAdvice: true,
  reviewBots: true, // 每手结束后查看电脑手牌
  reviewLogged: 0,
  showRange: false,
  advice: null, // { key, data }
  feedback: [], // 本手的决策反馈
  botTimer: 0,
  botKey: '',
  showAll: true,
  raiseValue: 0,
  error: '',
  equity: null, // { key, bySeat: {seat: eq}, exact, samples }
  equityTimer: 0,
};

// ---------- 工具 ----------

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

function cardHTML(card, { faceDown = false, cls = '' } = {}) {
  if (faceDown) return `<div class="card back ${cls}"></div>`;
  if (card === undefined || card === null) return `<div class="card slot ${cls}"></div>`;
  const label = RANK_LABELS[rankOf(card)];
  const suit = SUIT_SYMBOLS[suitOf(card)];
  return `<div class="card ${isRed(card) ? 'red' : 'black'} ${cls}" aria-label="${label}${suit}"><span class="rank">${label}</span><span class="suit">${suit}</span></div>`;
}

/** 日志文本中的牌面上色 */
function colorizeCards(text) {
  return escapeHtml(text).replace(/(10|[2-9JQKA])([♠♥♦♣])/g, (m, r, s) =>
    `<span class="lc ${s === '♥' || s === '♦' ? 'red' : 'black'}">${r}${s}</span>`,
  );
}

const isMobileLayout = () => window.matchMedia('(max-width: 640px)').matches;

function seatPos(i, n, radiusScale = 1) {
  const angle = ((90 + (i * 360) / n) * Math.PI) / 180;
  const mobile = isMobileLayout();
  const rx = (mobile ? 39 : 44) * radiusScale;
  const ry = (mobile ? 43 : 41) * radiusScale;
  return { x: 50 + rx * Math.cos(angle), y: 50 + ry * Math.sin(angle) };
}

// ---------- 设置 ----------

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!s) return;
    const radio = document.querySelector(`input[name=mode][value=${s.mode === 'hotseat' ? 'hotseat' : 'bot'}]`);
    if (radio) radio.checked = true;
    if (s.numPlayers) $('num-players').value = String(s.numPlayers);
    if (s.humanSeat !== undefined) $('human-seat').value = String(s.humanSeat);
    if (s.difficulty) $('difficulty').value = s.difficulty;
    if (s.botSpeed !== undefined) $('bot-speed').value = String(s.botSpeed);
    $('starting-stack').value = s.startingStack;
    $('small-blind').value = s.smallBlind;
    $('big-blind').value = s.bigBlind;
    // v0.1 保存的设置没有 mode 字段：沿用新的默认值（人机模式默认隐藏电脑底牌）
    $('setup-show-all').checked = s.mode ? !!s.showAll : false;
    $('setup-advice').checked = s.showAdvice !== false;
    $('setup-review').checked = s.reviewBots !== false;
    $('setup-rebuy').checked = s.allowRebuy !== false;
  } catch {
    /* 忽略 */
  }
}

function selectedMode() {
  return document.querySelector('input[name=mode]:checked')?.value === 'hotseat' ? 'hotseat' : 'bot';
}

function syncSetupMode(resetShowAll) {
  const mode = selectedMode();
  $('bot-options').classList.toggle('hidden', mode !== 'bot');
  $('hotseat-options').classList.toggle('hidden', mode !== 'hotseat');
  $('setup-show-all-label').textContent = mode === 'bot' ? '训练用：始终显示电脑的底牌' : '训练模式：显示所有玩家的底牌';
  $('setup-review-wrap').classList.toggle('hidden', mode !== 'bot');
  if (resetShowAll) $('setup-show-all').checked = mode === 'hotseat';
  document.querySelectorAll('.mode-card').forEach((el) => el.classList.toggle('selected', el.querySelector('input').checked));
}

function readSetup() {
  const mode = selectedMode();
  const numPlayers = mode === 'bot' ? 6 : Number($('num-players').value);
  const startingStack = Number($('starting-stack').value);
  const smallBlind = Number($('small-blind').value);
  const bigBlind = Number($('big-blind').value);
  const showAll = $('setup-show-all').checked;
  const isInt = (v) => Number.isInteger(v) && v > 0;
  if (!(numPlayers >= 2 && numPlayers <= 9)) throw new Error('玩家人数需在 2 到 9 之间');
  if (!isInt(startingStack)) throw new Error('初始筹码必须是正整数');
  if (!isInt(smallBlind) || !isInt(bigBlind)) throw new Error('盲注必须是正整数');
  if (smallBlind > bigBlind) throw new Error('小盲不能大于大盲');
  if (bigBlind > startingStack) throw new Error('大盲不能超过初始筹码');
  return {
    mode,
    numPlayers,
    startingStack,
    smallBlind,
    bigBlind,
    showAll,
    humanSeat: Number($('human-seat').value) || 0,
    difficulty: $('difficulty').value === 'easy' ? 'easy' : 'standard',
    botSpeed: Number($('bot-speed').value),
    showAdvice: $('setup-advice').checked,
    reviewBots: $('setup-review').checked,
    allowRebuy: $('setup-rebuy').checked,
  };
}

function startGame(settings) {
  stopBots();
  state.settings = settings;
  state.mode = settings.mode || 'hotseat';
  state.humanSeat = Math.min(settings.humanSeat || 0, settings.numPlayers - 1);
  state.difficulty = settings.difficulty || 'standard';
  state.botSpeed = Number.isFinite(settings.botSpeed) ? settings.botSpeed : 700;
  state.showAdvice = settings.showAdvice !== false;
  state.reviewBots = settings.reviewBots !== false;
  state.reviewLogged = 0;
  state.allowRebuy = settings.allowRebuy !== false;
  state.showAll = settings.showAll;
  state.equity = null;
  state.advice = null;
  state.feedback = [];
  state.error = '';
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 忽略 */
  }
  const names =
    state.mode === 'bot'
      ? Array.from({ length: settings.numPlayers }, (_, i) => (i === state.humanSeat ? '你' : `电脑${i + 1}`))
      : undefined;
  state.game = new HoldemGame({
    numPlayers: settings.numPlayers,
    startingStack: settings.startingStack,
    smallBlind: settings.smallBlind,
    bigBlind: settings.bigBlind,
    names,
    dealerSeat: state.mode === 'bot' ? Math.floor(Math.random() * settings.numPlayers) : 0,
    allowRebuy: state.allowRebuy,
  });
  state.game.startHand();
  onStateChanged();
  $('setup-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  $('show-all').checked = state.showAll;
  $('show-all-label').textContent = state.mode === 'bot' ? '显示电脑手牌' : '显示所有手牌';
  $('speed-wrap').classList.toggle('hidden', state.mode !== 'bot');
  $('review-wrap').classList.toggle('hidden', state.mode !== 'bot');
  $('review-bots').checked = state.reviewBots;
  $('speed').value = String(state.botSpeed);
  $('advice-panel').classList.toggle('hidden', !state.showAdvice);
  render();
}

function backToSetup() {
  stopBots();
  state.game = null;
  $('game-screen').classList.add('hidden');
  $('setup-screen').classList.remove('hidden');
}

const isHuman = (seat) => state.mode === 'hotseat' || seat === state.humanSeat;
const decisionKey = (g) => `${g.handNumber}|${g.log.length}|${g.toAct}`;

// ---------- 电脑玩家 ----------

function stopBots() {
  clearTimeout(state.botTimer);
  state.botTimer = 0;
  state.botKey = '';
}

function scheduleBots() {
  const g = state.game;
  if (!g || state.mode !== 'bot' || g.phase !== 'betting' || isHuman(g.toAct)) {
    stopBots();
    return;
  }
  const key = decisionKey(g);
  if (state.botKey === key && state.botTimer) return; // 已经在等待这一步
  clearTimeout(state.botTimer);
  state.botKey = key;
  state.botTimer = setTimeout(() => {
    state.botTimer = 0;
    if (state.game !== g || g.phase !== 'betting' || isHuman(g.toAct) || decisionKey(g) !== key) return;
    try {
      g.act(decideBotAction(g, { difficulty: state.difficulty }));
    } catch (e) {
      console.warn('电脑决策异常，改为保守动作：', e);
      g.act(legalize({ type: 'check' }, g.getLegalActions()));
    }
    onStateChanged();
    render();
  }, state.botSpeed);
}

// ---------- 动作 ----------

function onStateChanged() {
  const la = state.game?.getLegalActions();
  state.raiseValue = la && la.canRaise ? la.minRaiseTo : 0;
}

function doAction(type, amount) {
  const g = state.game;
  if (!g || g.phase !== 'betting' || !isHuman(g.toAct)) return;
  const advice = state.showAdvice ? currentAdvice(g) : null;
  const seatName = g.players[g.toAct].name;
  const street = g.street;
  try {
    const la = g.getLegalActions();
    g.act({ type, amount });
    if (advice) {
      const fb = evaluateDecision(advice, { type, amount: type === 'allin' ? la.maxRaiseTo : amount });
      state.feedback.push({ ...fb, street, seatName, hand: g.handNumber });
    }
    state.error = '';
    onStateChanged();
  } catch (e) {
    state.error = e.message;
  }
  render();
}

function nextHand() {
  const g = state.game;
  if (!g || g.phase !== 'handOver') return;
  // 允许重新买入：电脑（自对弈模式下为所有玩家）输光后自动按平均筹码买入，保持满桌
  if (state.allowRebuy) g.rebuyBusted((p) => state.mode === 'hotseat' || p.seat !== state.humanSeat);
  g.startHand();
  state.error = '';
  state.feedback = [];
  onStateChanged();
  render();
}

/** 人类玩家输光后按平均筹码重新买入，并直接开始下一手 */
function rebuyHuman() {
  const g = state.game;
  if (!g || state.mode !== 'bot' || !state.allowRebuy || g.phase !== 'handOver') return;
  if (g.players[state.humanSeat].stack > 0) return;
  g.rebuy(state.humanSeat);
  nextHand();
}

// ---------- 渲染 ----------

const visOpts = () => ({ mode: state.mode, humanSeat: state.humanSeat, showAll: state.showAll, reviewBots: state.reviewBots });
const holeVisible = (p) => isHoleVisible(state.game, p.seat, visOpts());

/** 一手结束后（开启复盘时）把电脑底牌写入日志，每手只写一次 */
function logReviewIfNeeded(g) {
  if (state.mode !== 'bot' || !state.reviewBots || g.phase === 'betting' || state.reviewLogged === g.handNumber) return;
  state.reviewLogged = g.handNumber;
  const seats = g.players.map((p) => p.seat).filter((s) => s !== state.humanSeat);
  for (const text of reviewLogLines(buildHandReview(g, seats))) {
    g.log.push({ hand: g.handNumber, street: 'review', kind: 'review', text });
  }
}

function render() {
  const g = state.game;
  if (!g) return;
  logReviewIfNeeded(g);
  renderTopbar(g);
  renderTable(g);
  renderActionPanel(g);
  renderAdvice(g);
  renderTraining(g);
  renderStats(g);
  renderLog(g);
  scheduleEquity();
  scheduleBots();
}

function renderTopbar(g) {
  const alive = g.players.filter((p) => !p.out).length;
  const mode = state.mode === 'bot' ? `人机 · ${state.difficulty === 'easy' ? '简单' : '标准'}` : '自对弈';
  $('hand-info').textContent = `${mode} · 第 ${g.handNumber} 手 · 盲注 ${g.smallBlind}/${g.bigBlind} · 剩余 ${alive} 人`;
}

function renderTable(g) {
  const n = g.numPlayers;
  const result = g.result;
  const showEq = state.showAll && g.phase === 'betting' && state.equity?.key === equityKey(g);
  let html = '';
  for (const p of g.players) {
    const pos = seatPos(p.seat, n);
    const classes = ['seat'];
    if (g.phase === 'betting' && p.seat === g.toAct) classes.push('active');
    if (p.folded && !p.out) classes.push('folded');
    if (p.out) classes.push('out');
    if (p.allIn) classes.push('allin');
    const won = result?.winnings?.[p.seat];
    if (won && g.phase !== 'betting') classes.push('winner');

    let cards = '';
    if (p.holeCards.length) {
      const vis = holeVisible(p);
      cards = p.holeCards.map((c) => cardHTML(c, { faceDown: !vis })).join('');
    }
    const badges = [];
    if (!p.out && p.seat === g.sbSeat) badges.push('<span class="badge sb">SB</span>');
    if (!p.out && p.seat === g.bbSeat) badges.push('<span class="badge bb">BB</span>');

    let status = p.lastAction;
    const handInfo = result?.hands?.[p.seat];
    if (g.phase !== 'betting' && handInfo) status = handInfo.name;
    if (p.out) status = '出局';
    if (state.mode === 'bot' && g.phase === 'betting' && p.seat === g.toAct && !isHuman(p.seat)) status = '思考中…';
    if (state.mode === 'bot' && p.seat === state.humanSeat) classes.push('human');

    const eq = showEq && state.equity.bySeat[p.seat] !== undefined && !p.folded
      ? `<div class="eq-badge" title="胜率">${pct(state.equity.bySeat[p.seat], 0)}</div>`
      : '';
    const winBadge = won && g.phase !== 'betting' ? `<div class="win-badge">+${won}</div>` : '';

    html += `<div class="${classes.join(' ')}" style="left:${pos.x}%;top:${pos.y}%" data-seat="${p.seat}">
      <div class="hole">${cards}</div>
      <div class="plate">
        <div class="name-row"><span class="name">${escapeHtml(p.name)}</span>${badges.join('')}</div>
        <div class="stack">${p.stack.toLocaleString('zh-CN')}</div>
        ${netHTML(g, p)}
        <div class="status">${escapeHtml(status || '')}</div>
      </div>
      ${eq}${winBadge}
    </div>`;

    if (p.bet > 0) {
      const bp = seatPos(p.seat, n, 0.62);
      html += `<div class="bet-chip" style="left:${bp.x}%;top:${bp.y}%"><i></i>${p.bet}</div>`;
    }
  }
  // 庄家按钮
  if (g.dealer >= 0) {
    const off = 360 / n / 4.5;
    const angle = ((90 + (g.dealer * 360) / n + off) * Math.PI) / 180;
    const mobile = isMobileLayout();
    const x = 50 + (mobile ? 25 : 30) * Math.cos(angle);
    const y = 50 + (mobile ? 30 : 27) * Math.sin(angle);
    html += `<div class="dealer-btn" style="left:${x}%;top:${y}%" title="庄家">D</div>`;
  }
  $('seats').innerHTML = html;

  // 公共牌
  const board = [];
  for (let i = 0; i < 5; i++) board.push(cardHTML(g.board[i]));
  $('board').innerHTML = board.join('');
  $('street-name').textContent = g.phase === 'betting' ? STREET_NAMES[g.street] : g.phase === 'gameOver' ? '游戏结束' : '本手结束';

  if (g.phase === 'betting') {
    $('pot').innerHTML = `底池 <b>${g.pot.toLocaleString('zh-CN')}</b>`;
  } else if (result) {
    $('pot').innerHTML = `底池 <b>${result.totalPot.toLocaleString('zh-CN')}</b>`;
  } else {
    $('pot').textContent = '';
  }

  let banner = '';
  if (g.phase !== 'betting' && result) {
    banner = result.pots
      .filter((pot) => pot.eligible.length > 1 || result.pots.length === 1)
      .map((pot) => {
        const names = pot.winners.map((s) => g.players[s].name).join('、');
        const how = pot.handName ? `（${pot.handName}）` : '';
        const verb = pot.winners.length > 1 ? '平分' : '赢得';
        return `<div>${escapeHtml(names)} ${verb}${pot.name} ${pot.amount}${how}</div>`;
      })
      .join('');
    if (g.phase === 'gameOver' && g.winner !== null) {
      banner += `<div class="champion">🏆 ${escapeHtml(g.players[g.winner].name)} 赢得全部筹码！</div>`;
    }
  }
  $('result-banner').innerHTML = banner;
}

function renderActionPanel(g) {
  const el = $('action-panel');
  if (g.phase === 'betting' && !isHuman(g.toAct)) {
    const p = g.players[g.toAct];
    const human = g.players[state.humanSeat];
    el.innerHTML = `
      <div class="ap-head"><span class="ap-turn"><span class="spinner"></span> <b>${escapeHtml(p.name)}</b> 思考中…</span>
      <span class="ap-meta">${human.out ? '你已出局，正在观看电脑对局' : human.folded ? '你已弃牌，等待本手结束' : '等待电脑行动'}</span></div>`;
    return;
  }
  if (g.phase === 'betting') {
    const la = g.getLegalActions();
    const p = g.players[g.toAct];
    const callLabel = la.canCheck ? '过牌' : la.callIsAllIn ? `全下跟注 ${la.toCall}` : `跟注 ${la.toCall}`;
    let raiseBlock = '';
    if (la.canRaise) {
      const v = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, state.raiseValue || la.minRaiseTo));
      state.raiseValue = v;
      const fixed = la.minRaiseTo === la.maxRaiseTo;
      raiseBlock = `
        <div class="raise-row ${fixed ? 'fixed' : ''}">
          <div class="quick">
            <button class="btn small" data-to="${la.minRaiseTo}">最小</button>
            ${
              g.street === 'preflop'
                ? preflopQuickSizes(g, la).map((o) => `<button class="btn small" data-to="${o.to}" title="到 ${o.to}">${o.label}</button>`).join('')
                : BET_SIZES.map((b, i) => `<button class="btn small" data-size="${i}" title="${b.label}：到 ${potFractionTo(la, b.frac)}">${b.label.replace('（超池）', '')}</button>`).join('')
            }
          </div>
          <div class="slider">
            <input id="raise-slider" type="range" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" step="1" value="${v}" ${fixed ? 'disabled' : ''} aria-label="下注大小" />
            <input id="raise-input" type="number" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" step="1" value="${v}" inputmode="numeric" ${fixed ? 'disabled' : ''} aria-label="下注金额" />
          </div>
        </div>`;
    }
    el.innerHTML = `
      <div class="ap-head">
        <span class="ap-turn">轮到 <b>${escapeHtml(p.name)}</b></span>
        <span class="ap-meta">筹码 ${p.stack} · 本轮已下 ${p.bet}${la.toCall > 0 ? ` · 需跟 <b>${la.toCall}</b>` : ''}</span>
      </div>
      <div class="ap-buttons">
        <button class="btn fold" data-act="fold">弃牌</button>
        <button class="btn call" data-act="${la.canCheck ? 'check' : 'call'}">${callLabel}</button>
        ${la.canRaise ? `<button class="btn raise" data-act="raise" id="raise-btn">${raiseLabel(la, state.raiseValue)}</button>` : ''}
        ${la.canAllIn && la.canRaise && la.maxRaiseTo > la.minRaiseTo ? `<button class="btn allin" data-act="allin">全下 ${la.maxRaiseTo}</button>` : ''}
      </div>
      ${raiseBlock}
      <div class="ap-error" role="alert">${escapeHtml(state.error)}</div>`;
    return;
  }

  // 一手结束 / 游戏结束
  const result = g.result;
  let lines = '';
  if (result) {
    lines = result.pots
      .map((pot) => {
        const names = pot.winners.map((s) => escapeHtml(g.players[s].name)).join('、');
        if (pot.eligible.length === 1 && result.type === 'showdown') return `<li>${names} 收回${pot.name} ${pot.amount}（无人跟注）</li>`;
        return `<li>${pot.name} <b>${pot.amount}</b> → ${names}${pot.handName ? `（${pot.handName}）` : '（其他人弃牌）'}</li>`;
      })
      .join('');
  }
  const busted = g.log.filter((e) => e.hand === g.handNumber && e.kind === 'info' && e.text.includes('出局')).map((e) => `<li class="muted">${escapeHtml(e.text)}</li>`).join('');
  const review = reviewHTML(g);
  const humanOut = state.mode === 'bot' && g.players[state.humanSeat].out;
  const canRebuy = humanOut && state.allowRebuy && g.phase === 'handOver';
  if (g.phase === 'gameOver') {
    const winnerName = g.players[g.winner]?.name ?? '';
    el.innerHTML = `
      <div class="ap-head"><span class="ap-turn">🏆 游戏结束：<b>${escapeHtml(winnerName)}</b> ${winnerName === '你' ? '赢得了全部筹码！' : '获胜'}</span></div>
      <ul class="ap-results">${lines}${busted}</ul>
      ${review}
      <div class="ap-buttons">
        <button class="btn primary" data-act="restart">再来一局（相同设置）</button>
        <button class="btn ghost" data-act="setup">返回设置</button>
      </div>`;
  } else {
    el.innerHTML = `
      <div class="ap-head"><span class="ap-turn">第 ${g.handNumber} 手结束</span>${humanOut ? '<span class="ap-meta">你已出局</span>' : ''}</div>
      <ul class="ap-results">${lines}${busted}</ul>
      ${review}
      <div class="ap-buttons">
        ${canRebuy ? `<button class="btn primary" data-act="rebuy" autofocus>按平均筹码重新买入（${g.rebuyAmount()}）</button>` : ''}
        <button class="btn ${canRebuy ? 'ghost' : 'primary'}" data-act="next" ${canRebuy ? '' : 'autofocus'}>${humanOut ? '继续观看电脑对局 ▶' : '下一手 ▶'}</button>
        ${humanOut ? '<button class="btn ghost" data-act="restart">再来一局</button>' : ''}
      </div>`;
  }
}

function reviewHTML(g) {
  if (state.mode !== 'bot' || !state.reviewBots || g.phase === 'betting') return '';
  const seats = g.players.map((p) => p.seat).filter((s) => s !== state.humanSeat);
  const rows = buildHandReview(g, seats)
    .map((r) => {
      const status = r.folded ? `<span class="muted">${r.foldStreet}弃牌</span>` : r.won ? `<span class="win">赢 ${r.won}</span>` : '<span>摊牌</span>';
      const hand = r.handName
        ? `<span class="rv-hand">${r.boardComplete ? '' : '当前 '}${r.handName}</span>${r.best5 ? `<span class="mini">${r.best5.map((c) => cardHTML(c, { cls: 'xs' })).join('')}</span>` : ''}`
        : '<span class="muted">未到翻牌</span>';
      return `<div class="rv-row"><div class="rv-top"><b>${escapeHtml(r.name)}</b><span class="mini">${r.cards.map((c) => cardHTML(c, { cls: 'xs' })).join('')}</span>${status}${hand}</div><div class="rv-acts muted">${escapeHtml(r.actions)}</div></div>`;
    })
    .join('');
  return rows ? `<details class="review" open><summary>本手复盘：电脑底牌</summary>${rows}</details>` : '';
}

function raiseLabel(la, v) {
  if (v >= la.maxRaiseTo) return `全下 ${la.maxRaiseTo}`;
  return la.raiseType === 'bet' ? `下注 ${v}` : `加注到 ${v}`;
}

function setRaiseValue(v, la) {
  la = la || state.game.getLegalActions();
  if (!la?.canRaise) return;
  v = Math.round(Number(v));
  if (!Number.isFinite(v)) return;
  v = Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, v));
  state.raiseValue = v;
  const slider = $('raise-slider');
  const input = $('raise-input');
  const btn = $('raise-btn');
  if (slider) slider.value = v;
  if (input && document.activeElement !== input) input.value = v;
  if (btn) btn.textContent = raiseLabel(la, v);
}

function equityKey(g) {
  const live = g.players.filter((p) => !p.out && !p.folded);
  return `${g.handNumber}|${g.board.join(',')}|${live.map((p) => p.seat).join(',')}`;
}

function scheduleEquity() {
  const g = state.game;
  if (!g || g.phase !== 'betting') return;
  if (state.mode === 'bot' && !state.showAll) return; // 人机模式不泄露电脑底牌
  const key = equityKey(g);
  if (state.equity?.key === key) return;
  clearTimeout(state.equityTimer);
  state.equityTimer = setTimeout(() => {
    if (state.game !== g || equityKey(g) !== key) return;
    const live = g.players.filter((p) => !p.out && !p.folded);
    const r = calcEquity({ hands: live.map((p) => p.holeCards), board: g.board, iterations: EQUITY_ITERATIONS });
    const bySeat = {};
    live.forEach((p, i) => (bySeat[p.seat] = r.equities[i]));
    state.equity = { key, bySeat, exact: r.exact, samples: r.samples };
    renderTable(g);
    renderTraining(g);
  }, 16);
}

function renderTraining(g) {
  const el = $('training-panel');
  if (g.phase !== 'betting') {
    const hands = g.result?.hands || {};
    const rows = Object.keys(hands)
      .map((s) => {
        const p = g.players[s];
        const h = hands[s];
        const won = g.result.winnings[s];
        return `<tr class="${won ? 'win' : ''}"><td>${escapeHtml(p.name)}</td><td class="mini">${h.best5.map((c) => cardHTML(c, { cls: 'xs' })).join('')}</td><td>${h.name}</td><td>${won ? '+' + won : ''}</td></tr>`;
      })
      .join('');
    el.innerHTML = `<h3>训练辅助</h3>${
      rows ? `<p class="muted">摊牌结果（最佳五张）：</p><table class="sd-table">${rows}</table>` : '<p class="muted">本手无人摊牌。</p>'
    }`;
    return;
  }
  if (state.mode === 'bot' && !isHuman(g.toAct)) {
    const h = g.players[state.humanSeat];
    const mine = !h.out && h.holeCards.length ? describeHand([...h.holeCards, ...g.board]).name : '—';
    el.innerHTML = `<h3>训练辅助</h3>
      <div class="stat"><span>你的当前牌型</span><b>${h.folded || h.out ? '（已弃牌）' : mine}</b></div>
      <div class="stat"><span>底池</span><b>${g.pot}</b></div>
      <p class="muted small">轮到你行动时显示胜率与底池赔率。</p>`;
    return;
  }
  const p = g.players[g.toAct];
  const la = g.getLegalActions();
  const hand = describeHand([...p.holeCards, ...g.board]);
  const trueEqAllowed = state.mode !== 'bot' || state.showAll;
  const eqReady = trueEqAllowed && state.equity?.key === equityKey(g);
  let myEq = eqReady ? state.equity.bySeat[p.seat] : null;
  const opponents = g.players.filter((q) => !q.out && !q.folded && q !== p).length;
  let myEqLabel = `胜率（对 ${opponents} 名对手的实际手牌）`;
  let methodOverride = null;
  if (!trueEqAllowed) {
    // 人机模式且不显示电脑底牌：只用对“估计范围”的胜率（来自建议模块）
    const adv = state.showAdvice ? currentAdvice(g) : null;
    myEqLabel = `胜率（对 ${opponents} 名对手的估计范围）`;
    if (adv && adv.street !== 'preflop') {
      myEq = adv.equity;
      methodOverride = '按对手翻牌前动作推断范围，蒙特卡洛估计（不读取电脑底牌）';
    } else {
      methodOverride = adv ? `起手牌强度约前 ${Math.max(1, Math.round(adv.percentile * 100))}%（翻牌前不计算范围胜率）` : '打开“显示电脑手牌”可查看真实胜率';
    }
  }
  const method = methodOverride ?? (eqReady
    ? state.equity.exact
      ? `精确枚举 ${state.equity.samples.toLocaleString('zh-CN')} 种发牌`
      : `蒙特卡洛模拟 ${state.equity.samples.toLocaleString('zh-CN')} 次`
    : '计算中…');

  // 底池赔率（简化：只考虑当前底池中该玩家可赢得的部分，不计后续下注）
  let oddsHtml = '';
  if (la.toCall > 0) {
    const myTotalAfter = p.totalBet + la.toCall;
    let winnable = 0;
    for (const q of g.players) if (q !== p) winnable += Math.min(q.totalBet, myTotalAfter);
    winnable += p.totalBet;
    const need = la.toCall / (winnable + la.toCall);
    let verdict = '';
    if (myEq !== null) {
      const ev = myEq * (winnable + la.toCall) - la.toCall;
      const good = myEq >= need;
      verdict = `<div class="verdict ${good ? 'good' : 'bad'}">胜率 ${pct(myEq)} ${good ? '≥' : '<'} 所需 ${pct(need)}：跟注 EV ≈ ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}</div>`;
    }
    oddsHtml = `
      <div class="stat"><span>需跟注</span><b>${la.toCall}</b></div>
      <div class="stat"><span>底池赔率</span><b>${la.toCall} : ${winnable}（需 ${pct(need)} 胜率）</b></div>
      ${verdict}`;
  } else {
    oddsHtml = `<div class="stat"><span>需跟注</span><b>0（可以免费过牌）</b></div>`;
  }

  let eqTable = '';
  if (state.showAll && eqReady) {
    const rows = g.players
      .filter((q) => !q.out && !q.folded)
      .map((q) => {
        const e = state.equity.bySeat[q.seat];
        const name = describeHand([...q.holeCards, ...g.board]).name;
        return `<tr class="${q === p ? 'me' : ''}"><td>${escapeHtml(q.name)}</td><td class="mini">${q.holeCards.map((c) => cardHTML(c, { cls: 'xs' })).join('')}</td><td>${name}</td><td><div class="bar"><i style="width:${(e * 100).toFixed(1)}%"></i><span>${pct(e)}</span></div></td></tr>`;
      })
      .join('');
    eqTable = `<p class="muted small">所有在局玩家：</p><table class="eq-table">${rows}</table>`;
  }

  el.innerHTML = `
    <h3>训练辅助 · ${escapeHtml(p.name)}</h3>
    <div class="stat"><span>当前牌型</span><b>${hand.name}</b></div>
    ${g.board.length >= 3 ? `<div class="mini best5">${hand.best5.map((c) => cardHTML(c, { cls: 'xs' })).join('')}</div>` : ''}
    <div class="stat"><span>${myEqLabel}</span><b class="eq-main">${myEq === null ? '—' : pct(myEq)}</b></div>
    <div class="muted small">${method}</div>
    <div class="stat"><span>底池</span><b>${g.pot}</b></div>
    ${oddsHtml}
    ${eqTable}`;
}

// ---------- GTO 建议 ----------

function currentAdvice(g) {
  if (!g || g.phase !== 'betting' || !isHuman(g.toAct)) return null;
  const key = decisionKey(g);
  if (state.advice?.key !== key) {
    try {
      state.advice = { key, data: getAdvice(g, g.toAct) };
    } catch (e) {
      console.warn('建议计算失败', e);
      state.advice = { key, data: null };
    }
  }
  return state.advice.data;
}

function freqRow(label, freq, cls, sub = '') {
  return `<div class="freq-row ${cls}"><span class="fr-label">${label}${sub ? `<small>${sub}</small>` : ''}</span>
    <div class="fr-bar"><i style="width:${(freq * 100).toFixed(1)}%"></i></div><b>${Math.round(freq * 100)}%</b></div>`;
}

function rangeGridHTML(tableKey, highlight) {
  const table = getTable(tableKey);
  let cells = '';
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const h = gridHand(r, c);
      const f = table.get(h);
      const a = f.raise * 100;
      const b = a + f.call * 100;
      const bg = `linear-gradient(to right, var(--rg-raise) 0 ${a}%, var(--rg-call) ${a}% ${b}%, var(--rg-fold) ${b}% 100%)`;
      const title = `${h}：加注 ${Math.round(f.raise * 100)}% / 跟注 ${Math.round(f.call * 100)}% / 弃牌 ${Math.round(f.fold * 100)}%`;
      cells += `<div class="rg-cell${h === highlight ? ' me' : ''}" style="background:${bg}" title="${title}">${h}</div>`;
    }
  }
  return `<div class="range-grid">${cells}</div>
    <div class="rg-legend"><span class="lg raise"></span>加注 <span class="lg call"></span>跟注/过牌 <span class="lg fold"></span>弃牌</div>`;
}

function reasonsHTML(reasons) {
  if (!reasons?.length) return '';
  return `<div class="reasons"><div class="reasons-title">为什么</div><ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`;
}

function feedbackHTML(g) {
  const list = state.feedback.filter((f) => f.hand === g.handNumber).slice(-3);
  if (!list.length) return '';
  return list
    .map(
      (f) => `<div class="feedback ${f.verdict}"><b>${STREET_NAMES[f.street]}${state.mode === 'hotseat' ? ` · ${escapeHtml(f.seatName)}` : ''}：${f.label}</b><div>${escapeHtml(f.text)}</div>${
        f.reasons?.length ? `<ul class="fb-reasons">${f.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''
      }</div>`,
    )
    .join('');
}

function renderAdvice(g) {
  const el = $('advice-panel');
  if (!state.showAdvice) return;
  const fb = feedbackHTML(g);
  const adv = currentAdvice(g);
  if (!adv) {
    let waiting = '';
    if (g.phase === 'betting') waiting = `<p class="muted small">等待 ${escapeHtml(g.players[g.toAct].name)} 行动…</p>`;
    else waiting = '<p class="muted small">轮到你行动时会显示建议。</p>';
    el.innerHTML = `<h3>GTO 建议</h3>${fb ? `<p class="muted small">本手你的决策：</p>${fb}` : ''}${waiting}`;
    return;
  }
  const who = state.mode === 'hotseat' ? ` · ${escapeHtml(g.players[adv.seat].name)}` : '';
  if (adv.street === 'preflop') {
    const f = adv.freqs;
    const raiseSub = adv.raiseTo ? adv.sizeText : '';
    const primaryText = adv.primary === 'raise' && adv.raiseTo ? `${adv.names.raise} ${adv.sizeText}` : adv.names[adv.primary];
    el.innerHTML = `
      <h3>GTO 建议${who} <span class="tag">翻牌前 · 范围表</span></h3>
      <div class="adv-line"><span class="muted">位置</span> ${escapeHtml(adv.positionText)} · ${escapeHtml(adv.spotText)}</div>
      <div class="adv-line"><span class="muted">手牌</span> <b class="hc">${adv.handClass}</b> ${adv.handCategory} · 约前 ${Math.max(1, Math.round(adv.percentile * 100))}%</div>
      <div class="freqs">
        ${freqRow(adv.names.raise, f.raise, 'raise', raiseSub)}
        ${freqRow(adv.names.call, f.call, 'call')}
        ${freqRow('弃牌', f.fold, 'fold')}
      </div>
      <div class="adv-primary">推荐：<b>${primaryText}</b>${f[adv.primary] < 0.99 ? '（混合策略：可按频率随机选择）' : ''}</div>
      ${reasonsHTML(adv.reasons)}
      <button class="btn small ghost" id="toggle-range">${state.showRange ? '收起范围图 ▴' : '查看本点位 13×13 范围图 ▾'}</button>
      ${state.showRange ? `<div class="muted small rg-title">${escapeHtml(adv.tableName)}</div>${rangeGridHTML(adv.tableKey, adv.handClass)}` : ''}
      <p class="adv-source">${escapeHtml(adv.source)}</p>
      ${fb ? `<p class="muted small">本手之前的决策：</p>${fb}` : ''}`;
    return;
  }
  const rows = adv.actions
    .map((a) => {
      let label;
      if (a.kind === 'bet') label = `下注 ${sizeLabel(a.size).replace('（超池）', '')}`;
      else if (a.kind === 'raise') label = `加注 ${sizeLabel(a.size).replace('（超池）', '')}`;
      else if (a.kind === 'check') label = '过牌';
      else if (a.kind === 'call') label = '跟注';
      else label = '弃牌';
      const cls = a.kind === 'bet' || a.kind === 'raise' ? 'raise' : a.kind === 'fold' ? 'fold' : 'call';
      return freqRow(label, a.freq, cls, a.to ? `到 ${a.to}` : '');
    })
    .join('');
  el.innerHTML = `
    <h3>GTO 建议${who} <span class="tag warn">${POSTFLOP_DISCLAIMER}</span></h3>
    <div class="adv-line"><span class="muted">牌型</span> ${escapeHtml(adv.handText)}</div>
    <div class="adv-line"><span class="muted">听牌</span> ${escapeHtml(adv.drawText)}</div>
    <div class="adv-line"><span class="muted">牌面</span> ${escapeHtml(adv.textureText)}</div>
    <div class="adv-line"><span class="muted">局面</span> ${adv.inPosition ? '有位置' : '无位置'} · ${adv.isPFR ? '翻牌前进攻者' : '翻牌前跟注方'} · SPR ${adv.spr.toFixed(1)}</div>
    <div class="adv-line"><span class="muted">对估计范围胜率</span> <b>${pct(adv.equity)}</b>${adv.toCall > 0 ? ` · 需要 ${pct(adv.need)}` : ''}</div>
    <div class="adv-cat">${escapeHtml(adv.category)}</div>
    <div class="freqs">${rows}</div>
    <div class="adv-primary">推荐：<b>${adviceSummary(adv)}</b></div>
    ${reasonsHTML(adv.reasons)}
    <p class="adv-source">对手范围按其翻牌前动作从范围表推断，翻牌后为启发式规则（牌力、听牌、牌面、赔率、SPR、位置），${POSTFLOP_DISCLAIMER}。</p>
    ${fb ? `<p class="muted small">本手之前的决策：</p>${fb}` : ''}`;
}

const signed = (v) => (v > 0 ? `+${v.toLocaleString('zh-CN')}` : v.toLocaleString('zh-CN'));

/** 座位上的净盈亏与买入次数 */
function netHTML(g, p) {
  const net = g.netProfit(p.seat);
  const cls = net > 0 ? 'up' : net < 0 ? 'down' : '';
  const re = p.rebuys ? ` · 买入×${p.rebuys + 1}` : '';
  return `<div class="net ${cls}" title="净盈亏 = 筹码 − 累计买入（${p.buyIn}）">净 ${signed(net)}${re}</div>`;
}

/** 筹码统计：每个座位的重新买入次数、累计买入、净盈亏 */
function renderStats(g) {
  const rows = g.players
    .map((p) => {
      const net = g.netProfit(p.seat);
      return `<tr class="${state.mode === 'bot' && p.seat === state.humanSeat ? 'me' : ''}"><td>${escapeHtml(p.name)}</td><td>${(p.stack + p.totalBet).toLocaleString('zh-CN')}</td><td>${p.rebuys}</td><td>${p.buyIn.toLocaleString('zh-CN')}</td><td class="${net > 0 ? 'up' : net < 0 ? 'down' : ''}">${signed(net)}</td></tr>`;
    })
    .join('');
  const totalRebuys = g.players.reduce((s, p) => s + p.rebuys, 0);
  $('stats').innerHTML = `<table class="stats-table"><thead><tr><th>玩家</th><th>筹码</th><th>重新买入</th><th>累计买入</th><th>净盈亏</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">桌面总筹码 ${g.totalChips.toLocaleString('zh-CN')} = 累计买入 ${g.totalBuyIn.toLocaleString('zh-CN')}（共重新买入 ${totalRebuys} 次）${state.allowRebuy ? '' : ' · 未开启重新买入'}</p>`;
}

function renderLog(g) {
  const el = $('log');
  const minHand = Math.max(1, g.handNumber - 15);
  let html = '';
  let curHand = -1;
  for (const e of g.log) {
    if (e.hand < minHand) continue;
    if (e.hand !== curHand) {
      if (curHand !== -1) html += '</div>';
      html += `<div class="log-hand">`;
      curHand = e.hand;
    }
    html += `<div class="log-e k-${e.kind}">${colorizeCards(e.text)}</div>`;
  }
  if (curHand !== -1) html += '</div>';
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

// ---------- 事件 ----------

function bindEvents() {
  $('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      $('setup-error').textContent = '';
      startGame(readSetup());
    } catch (err) {
      $('setup-error').textContent = err.message;
    }
  });

  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => syncSetupMode(true)));
  $('speed').addEventListener('change', (e) => {
    state.botSpeed = Number(e.target.value);
    if (state.settings) {
      state.settings.botSpeed = state.botSpeed;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
      } catch {
        /* 忽略 */
      }
    }
    stopBots();
    scheduleBots();
  });
  $('advice-panel').addEventListener('click', (e) => {
    if (e.target.closest('#toggle-range')) {
      state.showRange = !state.showRange;
      renderAdvice(state.game);
    }
  });

  $('review-bots').addEventListener('change', (e) => {
    state.reviewBots = e.target.checked;
    if (state.settings) state.settings.reviewBots = state.reviewBots;
    render();
  });

  $('show-all').addEventListener('change', (e) => {
    state.showAll = e.target.checked;
    if (state.settings) state.settings.showAll = state.showAll;
    render();
  });

  $('new-game').addEventListener('click', () => {
    if (!state.game || state.game.phase === 'gameOver' || confirm('确定放弃当前牌局，返回设置界面吗？')) backToSetup();
  });

  const panel = $('action-panel');
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const g = state.game;
    if (btn.dataset.act) {
      const act = btn.dataset.act;
      if (act === 'next') nextHand();
      else if (act === 'rebuy') rebuyHuman();
      else if (act === 'restart') startGame(state.settings);
      else if (act === 'setup') backToSetup();
      else if (act === 'raise') doAction(g.currentBet === 0 ? 'bet' : 'raise', state.raiseValue);
      else doAction(act);
      return;
    }
    const la = g?.getLegalActions();
    if (!la) return;
    if (btn.dataset.size !== undefined) setRaiseValue(potFractionTo(la, BET_SIZES[Number(btn.dataset.size)].frac), la);
    else if (btn.dataset.to) setRaiseValue(Number(btn.dataset.to), la);
  });
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'raise-slider') setRaiseValue(e.target.value);
    if (e.target.id === 'raise-input') {
      const la = state.game?.getLegalActions();
      const v = Number(e.target.value);
      if (la && v >= la.minRaiseTo && v <= la.maxRaiseTo) setRaiseValue(v, la);
    }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.id === 'raise-input') {
      setRaiseValue(e.target.value);
      e.target.value = state.raiseValue;
    }
  });

  document.addEventListener('keydown', (e) => {
    const g = state.game;
    if (!g || $('game-screen').classList.contains('hidden')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range';
    if (g.phase === 'handOver' && (e.key === 'Enter' || e.key === 'n' || e.key === 'N')) {
      if (tag === 'BUTTON' && e.key === 'Enter') return; // 让按钮自己处理
      e.preventDefault();
      nextHand();
      return;
    }
    if (g.phase !== 'betting' || typing || !isHuman(g.toAct)) return;
    const la = g.getLegalActions();
    const k = e.key.toLowerCase();
    if (k === 'f') doAction('fold');
    else if (k === 'c') doAction(la.canCheck ? 'check' : 'call');
    else if (k === 'r' && la.canRaise) doAction(g.currentBet === 0 ? 'bet' : 'raise', state.raiseValue);
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.game && renderTable(state.game), 100);
  });
}

loadSettings();
syncSetupMode(false);
bindEvents();

// 调试/自动化测试用
window.__holdem = { rebuyHuman, state, startGame, doAction, nextHand, isHuman };
