import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

const {
  generateJson,
  parseRecordingJson,
  generatePlaywright,
  generatePuppeteer,
  stepSummary,
} = await import(srcUrl('generator.js'));

const rec = {
  id: 'abc',
  name: '設定つき録画',
  startUrl: 'http://127.0.0.1:8791/complex.html',
  createdAt: 1700000000000,
  settings: { pageLoadTimeoutMs: 120000 },
  steps: [
    { type: 'click', selector: '#submitBtn', text: '送信' },
    { type: 'waitForSelector', selector: '#done', timeoutMs: 180000 },
    { type: 'wait', ms: 5000 },
    { type: 'input', selector: '#skipMe', value: 'x', disabled: true },
    { type: 'click', selector: '#maybe', optional: true, waitBeforeMs: 1500 },
  ],
};

// --- JSON round trip ---
const json = generateJson(rec);
const parsed = parseRecordingJson(json);
assert.equal(parsed.name, '設定つき録画');
assert.equal(parsed.steps.length, 5);
assert.deepEqual(parsed.settings, { pageLoadTimeoutMs: 120000 });
assert.equal(parsed.createdAt, 1700000000000);
console.log('OK: JSON round-trips including settings and createdAt');

// --- validation rejects bad input with useful messages ---
const bad = [
  ['not json at all', /構文が不正/],
  ['[]', /オブジェクト形式/],
  ['{"startUrl":"ftp://x","steps":[]}', /http\/https/],
  ['{"startUrl":"http://a/","steps":{}}', /steps は配列/],
  ['{"startUrl":"http://a/","steps":[{"selector":"#a"}]}', /type がありません/],
  ['{"startUrl":"http://a/","steps":[{"type":"teleport","selector":"#a"}]}', /未対応/],
  ['{"startUrl":"http://a/","steps":[{"type":"click"}]}', /selector がありません/],
  ['{"startUrl":"http://a/","steps":[{"type":"navigate"}]}', /url がありません/],
  ['{"startUrl":"http://a/","steps":[{"type":"wait"}]}', /ms は数値/],
  ['{"startUrl":"http://a/","steps":[{"type":"selectMultiple","selector":"#a"}]}', /values は配列/],
  ['{"startUrl":"http://a/","steps":[{"type":"dragAndDrop","selector":"#a"}]}', /toSelector がありません/],
];
for (const [input, pattern] of bad) {
  assert.throws(() => parseRecordingJson(input), pattern, `should reject: ${input}`);
}
console.log(`OK: validation rejects ${bad.length} kinds of malformed input`);

// --- valid minimal input is accepted ---
const minimal = parseRecordingJson('{"startUrl":"https://example.com/","steps":[]}');
assert.equal(minimal.name, '無題の録画');
assert.ok(Number.isFinite(minimal.createdAt));
console.log('OK: minimal valid JSON accepted with defaults filled in');

// --- generators respect disabled / waitBefore / new step types ---
const pw = generatePlaywright(rec);
console.log('\n=== Playwright ===\n' + pw);
assert.match(pw, /await page\.locator\("#done"\)\.waitFor\(\{ timeout: 180000 \}\)/);
assert.match(pw, /await page\.waitForTimeout\(5000\)/);
assert.match(pw, /\/\/ \[無効化\].*#skipMe/);
assert.ok(!pw.includes('.fill("x")'), 'disabled step must not emit a real action');
assert.match(pw, /await page\.waitForTimeout\(1500\)/);
console.log('OK: playwright honors disabled, waitBeforeMs, wait, waitForSelector');

const pp = generatePuppeteer(rec);
console.log('\n=== Puppeteer ===\n' + pp);
assert.match(pp, /waitForSelector\("#done", \{ timeout: 180000 \}\)/);
assert.match(pp, /setTimeout\(r, 5000\)/);
assert.match(pp, /\/\/ \[無効化\]/);
assert.ok(!pp.includes('"#skipMe", "x"'), 'disabled step must not emit a real action');
console.log('OK: puppeteer honors the same');

// --- summaries ---
assert.equal(stepSummary({ type: 'wait', ms: 3000 }), '待機: 3000ms');
assert.match(stepSummary({ type: 'waitForSelector', selector: '#x' }), /要素の出現待ち: #x/);
console.log('OK: summaries for new step types');

console.log('\nALL JSON/SETTINGS CHECKS PASSED');
