// manager.html と manager.js の配線が噛み合っているかを検証する。
// (getElementById の綴り違いや、HTML 側に存在しない id を掴んでいないか)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { srcPath } from './helpers/src.mjs';

const html = readFileSync(srcPath('manager.html'), 'utf8');
const js = readFileSync(srcPath('manager.js'), 'utf8');
const css = readFileSync(srcPath('manager.css'), 'utf8');

const dom = new JSDOM(html);
const doc = dom.window.document;

// manager.js が触る id をすべて洗い出し、HTML に存在するか確認する
const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
const missing = ids.filter((id) => !doc.getElementById(id));
assert.deepEqual(missing, [], `manager.js が参照する id が manager.html にありません: ${missing.join(', ')}`);
console.log(`OK: all ${new Set(ids).size} referenced ids exist in manager.html`);

// querySelector で使うクラスも確認
for (const sel of ['.tab-btn', '#recordingsBody', '#settingsFields']) {
  assert.ok(doc.querySelector(sel), `${sel} が見つかりません`);
}
console.log('OK: key selectors resolve');

// タブは steps / json / playwright / puppeteer の4つ
const tabs = [...doc.querySelectorAll('.tab-btn')].map((b) => b.dataset.format || b.dataset.tab);
assert.deepEqual(tabs, ['steps', 'json', 'dataset', 'recSettings', 'playwright', 'puppeteer']);
console.log('OK: tabs are', tabs.join(' / '));

// 各タブに対応するパネルが存在すること
for (const id of ['stepsPanel', 'jsonPanel', 'datasetPanel', 'recSettingsPanel', 'codePanel']) {
  assert.ok(doc.getElementById(id), `${id} がありません`);
}
// データセット編集の各要素
for (const id of ['datasetEditor', 'datasetError', 'datasetPreview', 'datasetCount', 'datasetTab',
                  'saveDatasetBtn', 'datasetCsvBtn', 'datasetClearBtn']) {
  assert.ok(doc.getElementById(id), `${id} がありません`);
}
console.log('OK: dataset panel and controls present');
// 録画ごとの設定の保存/解除ボタン
for (const id of ['recSettingsFields', 'recSettingsTab', 'saveRecSettingsBtn', 'clearRecSettingsBtn']) {
  assert.ok(doc.getElementById(id), `${id} がありません`);
}
console.log('OK: per-recording settings panel and controls present');

// 状態表示に使うクラスが CSS に定義されているか
for (const cls of ['running', 'done', 'error', 'skipped', 'warned']) {
  assert.ok(css.includes(`.replay-list li.${cls}`), `.replay-list li.${cls} の定義がありません`);
}
console.log('OK: every replay status has a CSS rule');

// ヘッダーのボタンが揃っているか
for (const id of ['importBtn', 'exportAllBtn', 'settingsBtn', 'importFile']) {
  assert.ok(doc.getElementById(id), `${id} がありません`);
}
assert.equal(doc.getElementById('importFile').getAttribute('accept'), 'application/json,.json');
console.log('OK: import/export/settings controls present');

// JSON編集パネルの要素
for (const id of ['jsonPanel', 'jsonEditor', 'jsonError', 'saveJsonBtn', 'revertJsonBtn']) {
  assert.ok(doc.getElementById(id), `${id} がありません`);
}
console.log('OK: JSON editor panel present');

console.log('\nALL DOM WIRING CHECKS PASSED');

// --- パネルの排他表示 (ID セレクタが .panel.hidden を打ち消していないこと) ---
{
  const styled = new JSDOM(html.replace('<link rel="stylesheet" href="manager.css" />', `<style>${css}</style>`));
  const w = styled.window;
  const d = w.document;
  const panels = ['stepsPanel', 'jsonPanel', 'datasetPanel', 'recSettingsPanel', 'codePanel'];
  for (const active of panels) {
    for (const id of panels) d.getElementById(id).classList.toggle('hidden', id !== active);
    for (const id of panels) {
      const display = w.getComputedStyle(d.getElementById(id)).display;
      if (id === active) assert.notEqual(display, 'none', `${active} が表示されるべき`);
      else assert.equal(display, 'none', `${active} が有効なとき ${id} は隠れるべき`);
    }
  }
  console.log('OK: exactly one panel is visible for each active tab');
}
