import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { srcUrl } from './helpers/src.mjs';
const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;

const { parseRecordingJson, generateJson, generatePlaywright, generatePuppeteer, stepSummary } = await import(
  srcUrl('generator.js')
);
const { validateRecording } = await import(srcUrl('validate.js'));

const rec = {
  name: '新パターン一式',
  startUrl: 'https://example.com/',
  createdAt: 1,
  steps: [
    { type: 'dblclick', selector: '#dbl', text: 'ダブル' },
    { type: 'contextmenu', selector: '#ctx', text: '右' },
    { type: 'editable', selector: '#editor', html: '<b>太字</b>です', text: '太字です' },
    { type: 'scroll', x: 0, y: 800 },
    { type: 'scroll', selector: '#pane', x: 0, y: 300 },
    { type: 'pointerPath', selector: '#pad', points: [{ x: 5, y: 5 }, { x: 40, y: 30 }, { x: 80, y: 10 }] },
    { type: 'newTab', url: 'https://example.com/child' },
    { type: 'input', selector: 'my-field#host >>> #inner', value: 'shadow値' },
  ],
};

// --- JSON 往復と検証 ---
const parsed = parseRecordingJson(generateJson(rec));
assert.equal(parsed.steps.length, 8);
assert.deepEqual(parsed.steps[5].points, rec.steps[5].points, '軌跡が保たれる');
assert.deepEqual(validateRecording(rec).issues, [], `指摘が出ないこと: ${JSON.stringify(validateRecording(rec).issues)}`);
console.log('OK: all new step types round-trip and validate');

// --- 不正な形は弾く ---
const bad = [
  ['{"startUrl":"https://a/","steps":[{"type":"editable","selector":"#e"}]}', /html がありません/],
  ['{"startUrl":"https://a/","steps":[{"type":"pointerPath","selector":"#p","points":[{"x":1,"y":1}]}]}', /2点以上/],
  ['{"startUrl":"https://a/","steps":[{"type":"pointerPath","selector":"#p","points":[{"x":1},{"x":2,"y":2}]}]}', /\{ x, y \}/],
  ['{"startUrl":"https://a/","steps":[{"type":"scroll"}]}', /数値である必要/],
];
for (const [input, pattern] of bad) assert.throws(() => parseRecordingJson(input), pattern);
console.log(`OK: ${bad.length} malformed shapes are rejected with specific messages`);

// selector 不要な型は selector なしでも通る
parseRecordingJson('{"startUrl":"https://a/","steps":[{"type":"newTab","url":"https://a/x"}]}');
parseRecordingJson('{"startUrl":"https://a/","steps":[{"type":"scroll","x":0,"y":10}]}');
console.log('OK: newTab and window-scroll need no selector');

// --- 表示 ---
const summaries = rec.steps.map(stepSummary);
console.log('\n--- ステップ一覧の表示 ---');
summaries.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
assert.match(summaries[0], /ダブルクリック/);
assert.match(summaries[1], /右クリック/);
assert.match(summaries[2], /リッチテキスト/);
assert.match(summaries[3], /スクロール: \(0, 800\)/);
assert.match(summaries[5], /3 点/);
assert.match(summaries[6], /新しいタブ/);
console.log('\nOK: summaries render for every new type');

// --- Playwright 出力 ---
const pw = generatePlaywright(rec);
assert.match(pw, /\.dblclick\(\)/);
assert.match(pw, /\.click\(\{ button: 'right' \}\)/);
assert.match(pw, /el\.innerHTML = html/);
assert.match(pw, /window\.scrollTo\(0, 800\)/);
assert.match(pw, /el\.scrollTo\(0, 300\)/);
assert.match(pw, /page\.mouse\.down\(\)/);
assert.match(pw, /waitForEvent\('page'\)/);
// shadow DOM: Playwright は自動で貫通するので最後の区間だけ
assert.match(pw, /locator\("#inner"\)\.fill/, 'shadow は最後の区間だけ渡す');
assert.ok(!pw.includes('>>>'), 'Playwright 出力に >>> は残さない');
console.log('OK: Playwright output covers every new type');

// --- Puppeteer 出力 ---
const pp = generatePuppeteer(rec);
assert.match(pp, /clickCount: 2/);
assert.match(pp, /button: 'right'/);
assert.match(pp, /\$eval\("#editor"/);
assert.match(pp, /window\.scrollTo\(0, 800\)/);
assert.match(pp, /page\.mouse\.down\(\)/);
assert.match(pp, /browser\.pages\(\)/);
assert.match(pp, /"my-field#host >>> #inner"/, 'Puppeteer は >>> をそのまま使う');
console.log('OK: Puppeteer output covers every new type');

// --- 生成コードが構文として妥当か ---
for (const [label, code] of [['playwright', pw], ['puppeteer', pp]]) {
  // require/await を含むので関数本体として構文チェックする
  new Function('require', 'test', 'expect', 'puppeteer', `return async () => {\n${code}\n}`);
  console.log(`OK: generated ${label} script parses as valid JavaScript`);
}

console.log('\nALL NEW-TYPE CHECKS PASSED');
