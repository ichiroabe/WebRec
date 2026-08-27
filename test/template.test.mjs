import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

const { resolveTemplate, resolveStepTemplates, previewTemplate } = await import(srcUrl('template.js'));
const { generatePlaywright, generatePuppeteer } = await import(srcUrl('generator.js'));

// 2026-08-27 (木) 14:05:09 を基準時刻に固定して検証する
const FIXED = new Date(2026, 7, 27, 14, 5, 9).getTime();
const ctx = { now: FIXED, seq: 42 };
const R = (s) => resolveTemplate(s, ctx);

// --- 日付 ---
assert.equal(R('{{date}}'), '2026-08-27');
assert.equal(R('{{date:YYYY年MM月DD日}}'), '2026年08月27日');
assert.equal(R('{{date:YYYY/MM/DD}}'), '2026/08/27');
assert.equal(R('{{date:YY-M-D}}'), '26-8-27');
console.log('OK: date formats');

// 年・月・日を別々の欄に入れるケース
assert.equal(R('{{date:YYYY}}'), '2026');
assert.equal(R('{{date:MM}}'), '08');
assert.equal(R('{{date:DD}}'), '27');
assert.equal(R('{{date:M}}'), '8', '0埋めなしの月');
assert.equal(R('{{date:D}}'), '27');
console.log('OK: year/month/day individually, with and without zero padding');

// --- 相対日付 ---
assert.equal(R('{{date:YYYY-MM-DD|+1d}}'), '2026-08-28');
assert.equal(R('{{date:YYYY-MM-DD|-1d}}'), '2026-08-26');
assert.equal(R('{{date:YYYY-MM-DD|+1w}}'), '2026-09-03');
assert.equal(R('{{date:YYYY-MM-DD|+1m}}'), '2026-09-27');
assert.equal(R('{{date:YYYY-MM-DD|-1y}}'), '2025-08-27');
assert.equal(R('{{date:YYYY-MM-DD|+5d}}'), '2026-09-01', '月をまたぐ加算');
console.log('OK: relative offsets (+1d/-1d/+1w/+1m/-1y) incl. month rollover');

// --- 時刻 ---
assert.equal(R('{{time}}'), '14:05:09');
assert.equal(R('{{time:HH:mm}}'), '14:05', 'コロンを含む書式が壊れないこと');
assert.equal(R('{{datetime}}'), '2026-08-27 14:05:09');
assert.equal(R('{{date:YYYY-MM-DD HH:mm:ss}}'), '2026-08-27 14:05:09');
console.log('OK: time formats, including formats containing colons');

// --- 乱数 ---
for (let i = 0; i < 200; i++) {
  const four = R('{{random:0000}}');
  assert.match(four, /^\d{4}$/, `0埋め4桁のはず: ${four}`);
  const ranged = Number(R('{{random:1-10}}'));
  assert.ok(ranged >= 1 && ranged <= 10, `1-10の範囲のはず: ${ranged}`);
}
assert.match(R('{{random:####}}'), /^\d{1,4}$/);
console.log('OK: random with 0-padding mask, # mask, and explicit range (200 iterations)');

// --- 連番 ---
assert.equal(R('{{seq:000}}'), '042');
assert.equal(R('{{seq}}'), '42');
assert.equal(R('{{seq:00000}}'), '00042');
console.log('OK: seq with zero padding');

// --- uuid ---
assert.match(R('{{uuid}}'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
console.log('OK: uuid');

// --- 混在・そのまま残すケース ---
assert.equal(R('注文日:{{date:YYYY/MM/DD}} 番号:{{seq:000}}'), '注文日:2026/08/27 番号:042');
assert.equal(R('{{unknown}}'), '{{unknown}}', '未知の変数はそのまま残す');
assert.equal(R('テンプレートなし'), 'テンプレートなし');
assert.equal(R(''), '');
assert.equal(resolveTemplate(null, ctx), null, 'null を壊さない');
assert.equal(resolveTemplate(123, ctx), 123, '数値を壊さない');
console.log('OK: mixed text, unknown vars preserved, non-strings untouched');

// --- ステップ単位の解決 ---
const step = { type: 'input', selector: '#d', value: '{{date:YYYY-MM-DD}}' };
const resolved = resolveStepTemplates(step, ctx);
assert.equal(resolved.value, '2026-08-27');
assert.equal(step.value, '{{date:YYYY-MM-DD}}', '元のステップは変更しない');
const multi = resolveStepTemplates({ type: 'selectMultiple', values: ['{{date:YYYY}}', 'fixed'] }, ctx);
assert.deepEqual(multi.values, ['2026', 'fixed']);
const nav = resolveStepTemplates({ type: 'navigate', url: 'http://x/?d={{date:YYYY-MM-DD}}' }, ctx);
assert.equal(nav.url, 'http://x/?d=2026-08-27');
console.log('OK: step-level resolution is non-destructive and covers value/values/url');

// --- プレビュー ---
assert.equal(previewTemplate('固定値'), null, 'テンプレートでなければ null');
assert.equal(previewTemplate('{{date:YYYY}}', ctx), '2026');
console.log('OK: preview returns null for plain values');

// --- 生成スクリプトが「実行時に」解決するコードを吐くこと ---
const rec = {
  name: 'テンプレート録画',
  startUrl: 'http://127.0.0.1:8791/complex.html?d={{date:YYYY-MM-DD}}',
  steps: [
    { type: 'input', selector: '#y', value: '{{date:YYYY}}' },
    { type: 'input', selector: '#fixed', value: 'ただの文字列' },
    { type: 'selectMultiple', selector: '#m', values: ['{{date:MM}}', 'x'] },
  ],
};

const pw = generatePlaywright(rec);
console.log('\n=== Playwright (テンプレートあり) ===\n' + pw);
assert.match(pw, /function resolveTemplate/, 'ヘルパー本体が埋め込まれること');
assert.match(pw, /\.fill\(V\("\{\{date:YYYY\}\}"\)\)/, 'テンプレートは V() 経由');
assert.match(pw, /\.fill\("ただの文字列"\)/, 'テンプレートでない値は素のリテラル');
assert.match(pw, /page\.goto\(V\(/, '開始URLもテンプレート対応');
console.log('OK: playwright embeds the resolver and wraps only templated values');

// テンプレートを含まない録画にはヘルパーを入れない
const plain = { name: 'x', startUrl: 'http://a/', steps: [{ type: 'input', selector: '#a', value: 'b' }] };
assert.ok(!generatePlaywright(plain).includes('resolveTemplate'), 'テンプレート未使用ならヘルパー不要');
assert.ok(!generatePuppeteer(plain).includes('resolveTemplate'));
console.log('OK: helper is omitted when no templates are used');

// --- 生成されたコードを実際に実行して、埋め込みヘルパーが動くことを確認 ---
const pp = generatePuppeteer(rec);
const helperSrc = pp.slice(pp.indexOf('let __webrecSeq'), pp.indexOf('(async () => {'));
const runHelper = new Function(helperSrc + '\nreturn V("{{date:YYYY-MM-DD}}");');
const fromGenerated = runHelper();
assert.match(fromGenerated, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(fromGenerated, resolveTemplate('{{date:YYYY-MM-DD}}', { now: Date.now(), seq: 1 }));
console.log(`OK: embedded helper executes standalone and agrees with the extension (${fromGenerated})`);

console.log('\nALL TEMPLATE CHECKS PASSED');
