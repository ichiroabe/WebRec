import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { srcUrl } from './helpers/src.mjs';
const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;

const { parseRecordingJson, generateJson, generatePlaywright, generatePuppeteer, stepSummary } =
  await import(srcUrl('generator.js'));
const { validateRecording } = await import(srcUrl('validate.js'));

// manager.js の insertWaitBefore と同じ挿入ロジック
function insertWaitBefore(steps, index, seconds) {
  const out = [...steps];
  out.splice(index, 0, { type: 'wait', ms: Math.round(seconds * 1000) });
  return out;
}

const original = [
  { type: 'click', selector: '#a' },
  { type: 'input', selector: '#b', value: 'x' },
  { type: 'click', selector: '#c' },
];

// 先頭・中間・末尾に入れられること
assert.deepEqual(insertWaitBefore(original, 0, 3)[0], { type: 'wait', ms: 3000 });
assert.deepEqual(insertWaitBefore(original, 1, 1.5)[1], { type: 'wait', ms: 1500 }, '小数秒');
assert.deepEqual(insertWaitBefore(original, 3, 2)[3], { type: 'wait', ms: 2000 }, '末尾');
console.log('OK: a wait can be inserted at the head, middle and tail');

// 既存ステップの順序が保たれること
const withWait = insertWaitBefore(original, 1, 3);
assert.equal(withWait.length, original.length + 1);
assert.deepEqual(withWait.filter((s) => s.type !== 'wait'), original, '既存ステップは変わらない');
assert.deepEqual(original.length, 3, '元の配列を壊さない');
console.log('OK: existing steps keep their order and the original array is untouched');

// 挿入後も保存できる形であること
const rec = { name: 'w', startUrl: 'https://example.com/', steps: withWait, createdAt: 1 };
const parsed = parseRecordingJson(generateJson(rec));
assert.equal(parsed.steps[1].type, 'wait');
assert.equal(parsed.steps[1].ms, 3000);
assert.deepEqual(validateRecording(rec).issues, [], '検証で指摘が出ないこと');
console.log('OK: the result validates and round-trips through JSON');

// 表示
assert.equal(stepSummary({ type: 'wait', ms: 3000 }), '待機: 3000ms');
console.log('OK: shown as', stepSummary({ type: 'wait', ms: 3000 }));

// 生成スクリプトに出ること
const pw = generatePlaywright(rec);
assert.match(pw, /await page\.waitForTimeout\(3000\)/);
const pp = generatePuppeteer(rec);
assert.match(pp, /setTimeout\(r, 3000\)/);
console.log('OK: the wait appears in both exported scripts');

// waitForSelector / waitBeforeMs も検証を通ること
const rec2 = {
  name: 'w2',
  startUrl: 'https://example.com/',
  steps: [
    { type: 'waitForSelector', selector: '#done', timeoutMs: 120000 },
    { type: 'click', selector: '#a', waitBeforeMs: 2000 },
  ],
  createdAt: 1,
};
assert.deepEqual(validateRecording(rec2).issues, []);
const pw2 = generatePlaywright(rec2);
assert.match(pw2, /\.waitFor\(\{ timeout: 120000 \}\)/);
assert.match(pw2, /waitForTimeout\(2000\)/);
console.log('OK: waitForSelector and waitBeforeMs also validate and export');

console.log('\nALL WAIT CHECKS PASSED');
