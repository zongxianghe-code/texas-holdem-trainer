// 界面层：只负责渲染与交互，所有规则都在 engine.js 中。

import { HoldemGame, STREET_NAMES } from './engine.js';
import { describeHand } from './evaluator.js';
import { calcEquity } from './equity.js';
import { RANK_LABELS, SUIT_SYMBOLS, rankOf, suitOf, isRed } from './cards.js';

const EQUITY_ITERATIONS = 3000;
const SETTINGS_KEY = 'holdem-trainer-settings';

const $ = (id) => document.getElementById(id);

const state = {
  game: null,
  settings: null,
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
    $('num-players').value = String(s.numPlayers);
    $('starting-stack').value = s.startingStack;
    $('small-blind').value = s.smallBlind;
    $('big-blind').value = s.bigBlind;
    $('setup-show-all').checked = s.showAll !== false;
  } catch {
    /* 忽略 */
  }
}

function readSetup() {
  const numPlayers = Number($('num-players').value);
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
  return { numPlayers, startingStack, smallBlind, bigBlind, showAll };
}

function startGame(settings) {
  state.settings = settings;
  state.showAll = settings.showAll;
  state.equity = null;
  state.error = '';
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 忽略 */
  }
  state.game = new HoldemGame({
    numPlayers: settings.numPlayers,
    startingStack: settings.startingStack,
    smallBlind: settings.smallBlind,
    bigBlind: settings.bigBlind,
  });
  state.game.startHand();
  onStateChanged();
  $('setup-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  $('show-all').checked = state.showAll;
  render();
}

function backToSetup() {
  state.game = null;
  $('game-screen').classList.add('hidden');
  $('setup-screen').classList.remove('hidden');
}

// ---------- 动作 ----------

function onStateChanged() {
  const la = state.game?.getLegalActions();
  state.raiseValue = la && la.canRaise ? la.minRaiseTo : 0;
}

function doAction(type, amount) {
  const g = state.game;
  if (!g || g.phase !== 'betting') return;
  try {
    g.act({ type, amount });
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
  g.startHand();
  state.error = '';
  onStateChanged();
  render();
}

/** 按底池比例计算“下注到”的金额 */
function potSizedTo(la, frac) {
  const owe = la.currentBet - la.bet;
  const target = Math.round(la.currentBet + frac * (la.pot + owe));
  return Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, target));
}

// ---------- 渲染 ----------

function holeVisible(p) {
  const g = state.game;
  if (p.out) return false;
  if (state.showAll) return true;
  if (g.phase === 'betting') return p.seat === g.toAct;
  return !!g.result?.hands?.[p.seat]; // 摊牌时亮牌
}

function render() {
  const g = state.game;
  if (!g) return;
  renderTopbar(g);
  renderTable(g);
  renderActionPanel(g);
  renderTraining(g);
  renderLog(g);
  scheduleEquity();
}

function renderTopbar(g) {
  const alive = g.players.filter((p) => !p.out).length;
  $('hand-info').textContent = `第 ${g.handNumber} 手 · 盲注 ${g.smallBlind}/${g.bigBlind} · 剩余 ${alive} 人`;
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
    if (!p.out && p.holeCards.length) {
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

    const eq = showEq && state.equity.bySeat[p.seat] !== undefined && !p.folded
      ? `<div class="eq-badge" title="胜率">${pct(state.equity.bySeat[p.seat], 0)}</div>`
      : '';
    const winBadge = won && g.phase !== 'betting' ? `<div class="win-badge">+${won}</div>` : '';

    html += `<div class="${classes.join(' ')}" style="left:${pos.x}%;top:${pos.y}%" data-seat="${p.seat}">
      <div class="hole">${cards}</div>
      <div class="plate">
        <div class="name-row"><span class="name">${escapeHtml(p.name)}</span>${badges.join('')}</div>
        <div class="stack">${p.stack.toLocaleString('zh-CN')}</div>
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
            <button class="btn small" data-frac="0.5">1/2 池</button>
            <button class="btn small" data-frac="0.6667">2/3 池</button>
            <button class="btn small" data-frac="1">底池</button>
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
  const busted = g.log.filter((e) => e.hand === g.handNumber && e.text.includes('出局')).map((e) => `<li class="muted">${escapeHtml(e.text)}</li>`).join('');
  if (g.phase === 'gameOver') {
    el.innerHTML = `
      <div class="ap-head"><span class="ap-turn">🏆 游戏结束：<b>${escapeHtml(g.players[g.winner]?.name ?? '')}</b> 获胜</span></div>
      <ul class="ap-results">${lines}${busted}</ul>
      <div class="ap-buttons">
        <button class="btn primary" data-act="restart">再来一局（相同设置）</button>
        <button class="btn ghost" data-act="setup">返回设置</button>
      </div>`;
  } else {
    el.innerHTML = `
      <div class="ap-head"><span class="ap-turn">第 ${g.handNumber} 手结束</span></div>
      <ul class="ap-results">${lines}${busted}</ul>
      <div class="ap-buttons">
        <button class="btn primary" data-act="next" autofocus>下一手 ▶</button>
      </div>`;
  }
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
  const p = g.players[g.toAct];
  const la = g.getLegalActions();
  const hand = describeHand([...p.holeCards, ...g.board]);
  const eqReady = state.equity?.key === equityKey(g);
  const myEq = eqReady ? state.equity.bySeat[p.seat] : null;
  const opponents = g.players.filter((q) => !q.out && !q.folded && q !== p).length;
  const method = eqReady
    ? state.equity.exact
      ? `精确枚举 ${state.equity.samples.toLocaleString('zh-CN')} 种发牌`
      : `蒙特卡洛模拟 ${state.equity.samples.toLocaleString('zh-CN')} 次`
    : '计算中…';

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
    <div class="stat"><span>胜率（对 ${opponents} 名对手的实际手牌）</span><b class="eq-main">${myEq === null ? '…' : pct(myEq)}</b></div>
    <div class="muted small">${method}</div>
    <div class="stat"><span>底池</span><b>${g.pot}</b></div>
    ${oddsHtml}
    ${eqTable}`;
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
      else if (act === 'restart') startGame(state.settings);
      else if (act === 'setup') backToSetup();
      else if (act === 'raise') doAction(g.currentBet === 0 ? 'bet' : 'raise', state.raiseValue);
      else doAction(act);
      return;
    }
    const la = g?.getLegalActions();
    if (!la) return;
    if (btn.dataset.frac) setRaiseValue(potSizedTo(la, Number(btn.dataset.frac)), la);
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
    if (g.phase !== 'betting' || typing) return;
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
bindEvents();

// 调试/自动化测试用
window.__holdem = { state, startGame, doAction, nextHand };
