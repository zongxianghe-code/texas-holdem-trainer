// 可选的浏览器冒烟测试（需要 playwright-core 和本机 Chrome/Chromium，不属于 `node --test`）
//   npm i --no-save playwright-core
//   python3 -m http.server 8000 &
//   CHROME=/usr/bin/google-chrome node scripts/smoke-browser.mjs http://127.0.0.1:8000/
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
for (const [viewport, players] of [[{ width: 1366, height: 860 }, 6], [{ width: 390, height: 844 }, 9], [{ width: 1024, height: 768 }, 2]]) {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.selectOption('#num-players', String(players));
  await page.click('button[type=submit]');
  await page.waitForSelector('#game-screen:not(.hidden)');
  let hands = 1;
  for (let i = 0; i < 2000 && hands <= 40; i++) {
    const phase = await page.evaluate(() => window.__holdem.state.game.phase);
    if (phase === 'gameOver') break;
    if (phase === 'handOver') { await page.click('button[data-act=next]'); hands++; continue; }
    const acts = await page.$$eval('#action-panel button[data-act]', (bs) => bs.map((b) => b.dataset.act));
    const r = Math.random();
    let pick = acts.includes('check') ? 'check' : 'call';
    if (r < 0.1 && acts.includes('allin')) pick = 'allin';
    else if (r < 0.3 && acts.includes('raise')) pick = 'raise';
    else if (r < 0.45 && acts.includes('call')) pick = 'fold';
    await page.click(`#action-panel button[data-act=${pick}]`);
  }
  const info = await page.evaluate(() => {
    const g = window.__holdem.state.game;
    return { phase: g.phase, hand: g.handNumber, chips: g.players.reduce((s, p) => s + p.stack, 0) + g.pot };
  });
  console.log(`${viewport.width}x${viewport.height} ${players}人:`, info);
  await page.close();
}
await browser.close();
if (errors.length) {
  console.error('发现错误:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('页面无控制台错误 ✓');
