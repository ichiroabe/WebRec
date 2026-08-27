// ステップ一覧 -> JSON の位置特定ロジックを検証する。
import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

const { generateJson, parseRecordingJson, stepSummary } = await import(srcUrl('generator.js'));

// manager.js と同じ実装
function findStepRange(text, index) {
  const keyPos = text.indexOf('"steps"');
  if (keyPos === -1) return null;
  const arrStart = text.indexOf('[', keyPos);
  if (arrStart === -1) return null;
  let depth = 0,
    inStr = false,
    esc = false,
    elemStart = -1,
    count = 0;
  for (let i = arrStart + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0) elemStart = i;
      depth++;
    } else if (c === '}' || c === ']') {
      if (depth === 0) return null;
      depth--;
      if (depth === 0) {
        if (count === index) return { start: elemStart, end: i + 1 };
        count++;
      }
    }
  }
  return null;
}

function findKeyRange(text, key) {
  const p = text.indexOf(`"${key}"`);
  if (p === -1) return null;
  const lineEnd = text.indexOf('\n', p);
  return { start: p, end: lineEnd === -1 ? text.length : lineEnd };
}

// 引っかけを混ぜた録画: 値の中に波括弧・角括弧・エスケープ済みの引用符・配列を含む
const rec = {
  name: '位置特定テスト',
  startUrl: 'http://127.0.0.1:8791/complex.html',
  createdAt: 1700000000000,
  steps: [
    { type: 'click', selector: '#a', text: 'ボタン' },
    { type: 'input', selector: '#b', value: '波括弧を含む値 {"nested": [1,2]}' },
    { type: 'input', selector: '#c', value: 'エスケープした引用符 \\" と ] と }' },
    { type: 'selectMultiple', selector: '#d', values: ['x', 'y', 'z'] },
    { type: 'input', selector: '#e', value: '{{date:YYYY-MM-DD}}', frames: ['#innerFrame'] },
    { type: 'navigate', url: 'http://127.0.0.1:8791/page2.html' },
  ],
};

const json = generateJson(rec);

// 各ステップについて、切り出した範囲が本当にそのステップの JSON になっているか
for (let i = 0; i < rec.steps.length; i++) {
  const range = findStepRange(json, i);
  assert.ok(range, `steps[${i}] の位置が見つからない`);
  const slice = json.slice(range.start, range.end);
  const parsed = JSON.parse(slice);
  assert.deepEqual(parsed, rec.steps[i], `steps[${i}] の切り出しが一致しない`);
}
console.log(`OK: located all ${rec.steps.length} steps exactly, incl. braces/brackets/escapes inside values`);

// 範囲外は null
assert.equal(findStepRange(json, rec.steps.length), null, '存在しない index は null');
assert.equal(findStepRange(json, 99), null);
console.log('OK: out-of-range index returns null');

// steps が空でも壊れない
assert.equal(findStepRange(generateJson({ name: 'x', startUrl: 'http://a/', steps: [] }), 0), null);
console.log('OK: empty steps array is handled');

// startUrl の位置
const urlRange = findKeyRange(json, 'startUrl');
assert.ok(urlRange);
const urlLine = json.slice(urlRange.start, urlRange.end);
assert.match(urlLine, /"startUrl": "http:\/\/127\.0\.0\.1:8791\/complex\.html",?/);
console.log('OK: startUrl line located:', urlLine.trim());

// 設定つき（steps より前に settings が来ない形でも動くこと）
const withSettings = generateJson({ ...rec, settings: { pageLoadTimeoutMs: 120000 } });
const r0 = findStepRange(withSettings, 0);
assert.deepEqual(JSON.parse(withSettings.slice(r0.start, r0.end)), rec.steps[0]);
console.log('OK: works when the recording also has a settings block');

// --- インポート後にステップ一覧がどう見えるか ---
console.log('\n================ インポート後のステップ一覧 ================');

// 手書きJSON（記録では出てこない wait / waitForSelector / disabled / optional を含む）
const handWritten = JSON.stringify({
  name: '手書きしたシナリオ',
  startUrl: 'http://127.0.0.1:8791/complex.html',
  settings: { pageLoadTimeoutMs: 120000 },
  steps: [
    { type: 'input', selector: '#yearField', value: '{{date:YYYY}}' },
    { type: 'input', selector: '#monthField', value: '{{date:MM}}' },
    { type: 'click', selector: '#chkA', text: 'オプションA' },
    { type: 'selectMultiple', selector: '#availableList', values: ['item1', 'item3'] },
    { type: 'dragAndDrop', selector: '#dragItem1', toSelector: '#dropTarget' },
    { type: 'input', selector: '#frameText', value: 'iframe値', frames: ['#innerFrame'] },
    { type: 'wait', ms: 5000 },
    { type: 'waitForSelector', selector: '#result', timeoutMs: 120000 },
    { type: 'click', selector: '#maybe', optional: true },
    { type: 'input', selector: '#skip', value: 'x', disabled: true },
    { type: 'navigate', url: 'http://127.0.0.1:8791/page2.html' },
  ],
});

const imported = parseRecordingJson(handWritten);
console.log(`名前: ${imported.name}`);
console.log(`開始URL: ${imported.startUrl}`);
console.log(`録画ごとの設定: ${JSON.stringify(imported.settings)}`);
console.log('---- ステップ一覧の表示 ----');
console.log(`1. 開始URLを開く -> ${imported.startUrl}`);
imported.steps.forEach((step, i) => {
  const flags = [];
  if (step.disabled) flags.push('無効');
  if (step.optional) flags.push('任意');
  console.log(`${i + 2}. ${stepSummary(step)}${flags.length ? ` （${flags.join(' / ')}）` : ''}`);
});
console.log('==========================================================');

// 記録した録画と手書き録画で、表示ロジックが同じであることを確認
assert.equal(stepSummary(imported.steps[2]), stepSummary({ type: 'click', selector: '#chkA', text: 'オプションA' }));
console.log('\nOK: imported steps render through the exact same formatter as recorded steps');

console.log('\nALL JUMP/IMPORT CHECKS PASSED');
