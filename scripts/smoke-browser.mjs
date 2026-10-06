// 可选的浏览器冒烟测试（需要 playwright-core 和本机 Chrome/Chromium，不属于 `node --test`）
//   npm i --no-save playwright-core
//   python3 -m http.server 8000 &
//   CHROME=/usr/bin/google-chrome node scripts/smoke-browser.mjs http://127.0.0.1:8000/
// 覆盖：人机对战（桌面/手机宽度）与自对弈模式，随机点击行动按钮打若干手牌，检查控制台无错误。
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const shotDir = process.env.SHOTS; // 可选：截图目录
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];

async function play({ mode, viewport, players = 6, speed = '0', maxHands = 15, tag }) {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${tag}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`[${tag}] HTTP ${r.status()} ${r.url()}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click(`.mode-card:has(input[value=${mode}])`);
  if (mode === 'hotseat') await page.selectOption('#num-players', String(players));
  else await page.selectOption('#bot-speed', speed);
  await page.click('button[type=submit]');
  await page.waitForSelector('#game-screen:not(.hidden)');
  const st = () =>
    page.evaluate(() => {
      const h = window.__holdem;
      const g = h.state.game;
      return { phase: g.phase, street: g.street, human: g.phase === 'betting' && h.isHuman(g.toAct) };
    });
  let hands = 1;
  let humanActs = 0;
  let quick = null;
  let feedback = 0;
  let hiddenBacks = null;
  let shots = 0;
  for (let i = 0; i < 5000 && hands <= maxHands; i++) {
    const s = await st();
    if (s.phase === 'gameOver') break;
    if (s.phase === 'handOver') {
      await page.click('button[data-act=next]');
      hands++;
      continue;
    }
    if (!s.human) {
      await page.waitForTimeout(20);
      continue;
    }
    if (quick === null && (await page.$('#raise-btn'))) {
      quick = await page.$$eval('.raise-row .quick button', (bs) => bs.map((b) => b.textContent.trim()));
    }
    if (mode === 'bot' && hiddenBacks === null) {
      hiddenBacks = await page.$$eval('.seat:not(.human):not(.out):not(.folded) .card.back', (e) => e.length);
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
      const sizes = await page.$$('.raise-row .quick button[data-size]');
      if (sizes.length) await sizes[Math.floor(Math.random() * sizes.length)].click();
      pick = 'raise';
    } else if (r < 0.45 && acts.includes('call')) pick = 'fold';
    await page.click(`#action-panel button[data-act=${pick}]`);
    humanActs++;
    feedback = Math.max(feedback, await page.$$eval('.feedback', (e) => e.length));
  }
  const info = await page.evaluate(() => {
    const g = window.__holdem.state.game;
    return { phase: g.phase, hand: g.handNumber, chips: g.players.reduce((s, p) => s + p.stack, 0) + g.pot };
  });
  console.log(`[${tag}]`, { ...info, humanActs, quickButtons: quick?.join(' '), feedbackSeen: feedback, hiddenBotCards: hiddenBacks });
  if (quick && quick.join(' ') !== '最小 1/3 池 1/2 池 2/3 池 4/3 池') errors.push(`[${tag}] 快捷按钮不符合: ${quick}`);
  if (mode === 'bot' && humanActs > 0 && feedback === 0) errors.push(`[${tag}] 没有看到决策反馈`);
  if (mode === 'bot' && hiddenBacks === 0) errors.push(`[${tag}] 电脑底牌没有隐藏`);
  await page.close();
}

await play({ mode: 'bot', viewport: { width: 1366, height: 900 }, speed: '0', tag: 'bot-desktop' });
await play({ mode: 'bot', viewport: { width: 390, height: 844 }, speed: '300', maxHands: 4, tag: 'bot-mobile' });
await play({ mode: 'hotseat', viewport: { width: 1366, height: 860 }, players: 6, tag: 'hotseat-6' });
await play({ mode: 'hotseat', viewport: { width: 1024, height: 768 }, players: 2, tag: 'hotseat-hu' });
await browser.close();
if (errors.length) {
  console.error('发现错误:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('页面无控制台错误 ✓');
