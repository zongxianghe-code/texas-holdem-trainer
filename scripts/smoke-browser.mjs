// 可选的浏览器冒烟测试（需要 playwright-core 和本机 Chrome/Chromium，不属于 `node --test`）
//   npm i --no-save playwright-core
//   python3 -m http.server 8000 &
//   CHROME=/usr/bin/google-chrome node scripts/smoke-browser.mjs http://127.0.0.1:8000/
// 覆盖：人机对战（桌面/手机宽度、复盘开/关）与自对弈模式，随机点击行动按钮打若干手牌；检查翻牌前大盲尺度、
// 翻牌后四种底池尺度、建议理由、每手结束后（含弃牌结束）亮出电脑底牌与复盘、手牌进行中不暴露、控制台无错误。
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const shotDir = process.env.SHOTS; // 可选：截图目录
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];

const POSTFLOP_QUICK = '最小 1/3 池 1/2 池 2/3 池 4/3 池';
const PREFLOP_QUICK = /^最小( \d+(\.\d+)?(BB|x))*$/;

async function play({ mode, viewport, players = 6, speed = '0', maxHands = 15, tag, reviewOff = false }) {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${tag}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`[${tag}] HTTP ${r.status()} ${r.url()}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click(`.mode-card:has(input[value=${mode}])`);
  if (mode === 'hotseat') await page.selectOption('#num-players', String(players));
  else {
    await page.selectOption('#bot-speed', speed);
    if (!(await page.isChecked('#setup-review'))) errors.push(`[${tag}] “每手结束后查看电脑手牌”默认应开启`);
  }
  await page.click('button[type=submit]');
  await page.waitForSelector('#game-screen:not(.hidden)');
  if (reviewOff) await page.uncheck('#review-bots'); // 顶栏开关
  const st = () =>
    page.evaluate(() => {
      const h = window.__holdem;
      const g = h.state.game;
      const human = h.state.humanSeat;
      return {
        phase: g.phase,
        street: g.street,
        human: g.phase === 'betting' && h.isHuman(g.toAct),
        resultType: g.result?.type,
        dealtBots: g.players.filter((p) => p.seat !== human && p.holeCards.length === 2).length,
        foldedBots: g.players.filter((p) => p.seat !== human && p.holeCards.length === 2 && p.folded).length,
      };
    });
  const c = { humanActs: 0, feedback: 0, fbReasons: 0, minReasons: Infinity, exposedDuringHand: 0, hiddenBacks: null, foldOutReviews: 0, foldedBotsRevealed: 0, reviewHands: 0 };
  const pre = new Set();
  const post = new Set();
  let hands = 1;
  let shots = 0;
  for (let i = 0; i < 5000 && hands <= maxHands; i++) {
    const s = await st();
    if (s.phase === 'gameOver') break;
    if (s.phase === 'handOver') {
      if (mode === 'bot') {
        const faceUp = await page.$$eval('.seat:not(.human) .hole .card:not(.back)', (e) => e.length);
        const rows = await page.$$eval('.review .rv-row', (e) => e.length);
        if (reviewOff) {
          if (rows) errors.push(`[${tag}] 关闭复盘后仍显示复盘`);
          if (s.resultType === 'fold' && faceUp) errors.push(`[${tag}] 关闭复盘后弃牌结束仍亮出电脑底牌`);
        } else {
          if (faceUp !== s.dealtBots * 2) errors.push(`[${tag}] 第 ${hands} 手结束：亮出 ${faceUp} 张，应为 ${s.dealtBots * 2}`);
          if (rows !== s.dealtBots) errors.push(`[${tag}] 第 ${hands} 手复盘行 ${rows}，应为 ${s.dealtBots}`);
          c.reviewHands++;
          c.foldedBotsRevealed += s.foldedBots;
          if (s.resultType === 'fold') c.foldOutReviews++;
          if (shotDir && c.foldOutReviews === 1 && s.resultType === 'fold') await page.screenshot({ path: `${shotDir}/${tag}-review.png`, fullPage: true });
        }
      }
      await page.click('button[data-act=next]');
      hands++;
      continue;
    }
    if (mode === 'bot') {
      c.exposedDuringHand += await page.$$eval('.seat:not(.human) .hole .card:not(.back)', (e) => e.length);
      if (c.hiddenBacks === null) c.hiddenBacks = await page.$$eval('.seat:not(.human):not(.out):not(.folded) .card.back', (e) => e.length);
    }
    if (!s.human) {
      await page.waitForTimeout(20);
      continue;
    }
    if (await page.$('#raise-btn')) {
      const q = (await page.$$eval('.raise-row .quick button', (bs) => bs.map((b) => b.textContent.trim()))).join(' ');
      (s.street === 'preflop' ? pre : post).add(q);
    }
    if (mode === 'bot') {
      const n = await page.$$eval('#advice-panel .reasons li', (e) => e.filter((x) => x.offsetParent !== null && x.textContent.trim()).length);
      c.minReasons = Math.min(c.minReasons, n);
    }
    if (shotDir && shots < 3 && (shots === 0 || s.street !== 'preflop')) {
      if (shots === 0 && (await page.$('#toggle-range'))) await page.click('#toggle-range');
      await page.screenshot({ path: `${shotDir}/${tag}-${shots}.png`, fullPage: true });
      shots++;
    }
    const acts = await page.$$eval('#action-panel button[data-act]', (bs) => bs.map((b) => b.dataset.act));
    const r = Math.random();
    let pick = acts.includes('check') ? 'check' : 'call';
    if (r < 0.05 && acts.includes('allin')) pick = 'allin';
    else if (r < 0.3 && acts.includes('raise')) {
      const sizes = await page.$$('.raise-row .quick button[data-size], .raise-row .quick button[data-to]');
      if (sizes.length) await sizes[Math.floor(Math.random() * sizes.length)].click();
      pick = 'raise';
    } else if (r < 0.5 && acts.includes('call')) pick = 'fold';
    await page.click(`#action-panel button[data-act=${pick}]`);
    c.humanActs++;
    c.feedback = Math.max(c.feedback, await page.$$eval('.feedback', (e) => e.length));
    c.fbReasons = Math.max(c.fbReasons, await page.$$eval('.fb-reasons li', (e) => e.length));
  }
  const info = await page.evaluate(() => {
    const g = window.__holdem.state.game;
    return {
      phase: g.phase,
      hand: g.handNumber,
      chips: g.players.reduce((s, p) => s + p.stack, 0) + g.pot,
      buyIn: g.totalBuyIn,
      statsRows: document.querySelectorAll('#stats .stats-table tbody tr').length,
      reviewLog: document.querySelectorAll('.log-e.k-review').length,
    };
  });
  console.log(`[${tag}]`, { ...info, ...c, preflopQuick: [...pre], postflopQuick: [...post] });
  if (info.chips !== info.buyIn) errors.push(`[${tag}] 筹码 ${info.chips} ≠ 累计买入 ${info.buyIn}`);
  if (!info.statsRows) errors.push(`[${tag}] 没有筹码统计表`);
  for (const q of post) if (q !== POSTFLOP_QUICK) errors.push(`[${tag}] 翻牌后快捷按钮不符合: ${q}`);
  for (const q of pre) if (!PREFLOP_QUICK.test(q) || /池/.test(q)) errors.push(`[${tag}] 翻牌前快捷按钮不符合: ${q}`);
  if (mode === 'bot' && c.humanActs > 0) {
    if (c.feedback === 0) errors.push(`[${tag}] 没有看到决策反馈`);
    if (c.fbReasons === 0) errors.push(`[${tag}] 反馈没有理由`);
    if (!(c.minReasons >= 2)) errors.push(`[${tag}] 建议面板“为什么”理由不足: ${c.minReasons}`);
  }
  if (mode === 'bot' && c.hiddenBacks === 0) errors.push(`[${tag}] 电脑底牌没有隐藏`);
  if (mode === 'bot' && c.exposedDuringHand) errors.push(`[${tag}] 手牌进行中暴露了电脑底牌 ${c.exposedDuringHand} 次`);
  if (mode === 'bot' && !reviewOff && maxHands >= 10) {
    if (!c.foldOutReviews) errors.push(`[${tag}] 没有遇到弃牌结束的复盘`);
    if (!info.reviewLog) errors.push(`[${tag}] 牌局日志没有复盘记录`);
  }
  await page.close();
  return { pre, post };
}

// 重新买入：短筹码人机桌，人类每手全下直到输光，然后点“按平均筹码重新买入”；电脑输光自动买入，保持 6 人
async function rebuyRun(tag) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${tag}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('.mode-card:has(input[value=bot])');
  await page.selectOption('#bot-speed', '0');
  if (!(await page.isChecked('#setup-rebuy'))) errors.push(`[${tag}] “允许重新买入”默认应开启`);
  await page.fill('#starting-stack', '40');
  await page.click('button[type=submit]');
  await page.waitForSelector('#game-screen:not(.hidden)');
  const st = () =>
    page.evaluate(() => {
      const h = window.__holdem;
      const g = h.state.game;
      const me = g.players[h.state.humanSeat];
      return { phase: g.phase, human: g.phase === 'betting' && h.isHuman(g.toAct), meOut: me.out, myRebuys: me.rebuys, outCount: g.players.filter((p) => p.out).length, botRebuys: g.players.reduce((s, p) => s + (p.seat === h.state.humanSeat ? 0 : p.rebuys), 0), chips: g.totalChips, buyIn: g.totalBuyIn };
    });
  let humanRebuys = 0;
  let notFull = 0;
  let sawButton = false;
  for (let i = 0; i < 3000 && humanRebuys < 2; i++) {
    const s = await st();
    if (s.chips !== s.buyIn) errors.push(`[${tag}] 筹码 ${s.chips} ≠ 累计买入 ${s.buyIn}`);
    if (s.phase === 'gameOver') {
      errors.push(`[${tag}] 允许重新买入时不应出现游戏结束`);
      break;
    }
    if (s.phase === 'handOver') {
      if (s.meOut) {
        const btn = await page.$('button[data-act=rebuy]');
        if (!btn) {
          errors.push(`[${tag}] 人类输光后没有“按平均筹码重新买入”按钮`);
          break;
        }
        sawButton = true;
        const text = (await btn.textContent()).trim();
        if (!/^按平均筹码重新买入（\d+）$/.test(text)) errors.push(`[${tag}] 按钮文字不符: ${text}`);
        if (!(await page.$('button[data-act=next]')) || !(await page.$('button[data-act=restart]'))) errors.push(`[${tag}] 缺少观看/重新开始选项`);
        if (shotDir && humanRebuys === 0) await page.screenshot({ path: `${shotDir}/${tag}-busted.png`, fullPage: true });
        await btn.click();
        humanRebuys++;
        const after = await st();
        if (after.myRebuys !== humanRebuys || after.meOut) errors.push(`[${tag}] 重新买入没有生效`);
      } else await page.click('button[data-act=next]');
      continue;
    }
    if (s.outCount) notFull++;
    if (!s.human) {
      await page.waitForTimeout(10);
      continue;
    }
    const acts = await page.$$eval('#action-panel button[data-act]', (bs) => bs.map((b) => b.dataset.act));
    await page.click(`#action-panel button[data-act=${acts.includes('allin') ? 'allin' : acts.includes('raise') ? 'raise' : acts.includes('call') ? 'call' : 'check'}]`);
  }
  const fin = await st();
  const logRebuys = await page.$$eval('.log-e.k-rebuy', (e) => e.map((x) => x.textContent));
  await page.click('#stats-details summary');
  if (shotDir) await page.screenshot({ path: `${shotDir}/${tag}-stats.png`, fullPage: true });
  const nets = await page.$$eval('.seat .net', (e) => e.length);
  console.log(`[${tag}]`, { humanRebuys, botRebuys: fin.botRebuys, notFullDuringHands: notFull, logRebuyLines: logRebuys.length, sample: logRebuys[0], seatNetLabels: nets, chips: fin.chips, buyIn: fin.buyIn });
  if (!sawButton || humanRebuys < 1) errors.push(`[${tag}] 没有测到人类重新买入`);
  if (!fin.botRebuys) errors.push(`[${tag}] 电脑没有自动重新买入`);
  if (notFull) errors.push(`[${tag}] 手牌进行中有 ${notFull} 次不是满桌`);
  if (!logRebuys.length || !/重新买入 \d+（第 \d+ 次，累计买入 \d+，净盈亏 [+-]?\d+）/.test(logRebuys[0])) errors.push(`[${tag}] 日志缺少重新买入记录`);
  if (nets !== 6) errors.push(`[${tag}] 座位上应显示净盈亏`);
  await page.close();
}

await rebuyRun('bot-rebuy');
const a = await play({ mode: 'bot', viewport: { width: 1366, height: 900 }, speed: '0', maxHands: 20, tag: 'bot-desktop' });
const b = await play({ mode: 'bot', viewport: { width: 390, height: 844 }, speed: '300', maxHands: 4, tag: 'bot-mobile' });
await play({ mode: 'bot', viewport: { width: 1280, height: 860 }, speed: '0', maxHands: 5, tag: 'bot-review-off', reviewOff: true });
const h6 = await play({ mode: 'hotseat', viewport: { width: 1366, height: 860 }, players: 6, tag: 'hotseat-6' });
await play({ mode: 'hotseat', viewport: { width: 1024, height: 768 }, players: 2, tag: 'hotseat-hu' });
const allPre = [...a.pre, ...b.pre, ...h6.pre];
if (!allPre.some((q) => q === '最小 2BB 2.5BB 3BB' || /2\.5BB/.test(q))) errors.push('从未看到翻牌前开池尺度 2BB/2.5BB/3BB');
if (![...a.post, ...b.post, ...h6.post].length) errors.push('从未看到翻牌后快捷按钮');
await browser.close();
if (errors.length) {
  console.error('发现错误:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('页面无控制台错误 ✓');
