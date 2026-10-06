// 静态检查：页面引用的资源都存在，非 DOM 模块都可以在 Node 中直接导入（无需构建）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('index.html 引用的脚本与样式存在', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(refs.includes('js/ui.js'));
  assert.ok(refs.includes('css/style.css'));
  for (const r of refs) assert.ok(existsSync(join(root, r)), `缺少文件 ${r}`);
  assert.match(html, /<script type="module"/);
});

test('所有 import 使用相对路径且目标存在（适配 GitHub Pages 静态托管）', () => {
  for (const f of readdirSync(join(root, 'js'))) {
    const src = readFileSync(join(root, 'js', f), 'utf8');
    for (const m of src.matchAll(/from '([^']+)'/g)) {
      assert.ok(m[1].startsWith('./'), `${f} 中的导入 ${m[1]} 不是相对路径`);
      assert.ok(existsSync(join(root, 'js', m[1])), `${f} 导入的 ${m[1]} 不存在`);
    }
  }
});

test('纯逻辑模块可以在无 DOM 环境中导入', async () => {
  for (const m of ['cards.js', 'evaluator.js', 'engine.js', 'equity.js']) {
    const mod = await import(join(root, 'js', m));
    assert.ok(Object.keys(mod).length > 0);
  }
});

test('快捷下注按钮只有 1/3、1/2、2/3、4/3 底池（以及最小、全下）', () => {
  const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  assert.match(ui, /BET_SIZES\.map\(/);
  assert.doesNotMatch(ui, /data-frac/);
  assert.doesNotMatch(ui, />底池<\/button>/);
  assert.match(ui, /data-to="\$\{la\.minRaiseTo\}">最小</);
});
