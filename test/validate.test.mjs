import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { srcUrl } from './helpers/src.mjs';

// セレクタ構文チェックのため DOM を用意する
const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;

const { validateRecording, summarize } = await import(srcUrl('validate.js'));

const base = { name: 't', startUrl: 'http://127.0.0.1:8791/complex.html', steps: [] };
const codes = (r) => r.issues.map((i) => i.code);

// --- 問題のない録画 ---
let r = validateRecording({
  ...base,
  dataset: [{ 氏名: '山田' }],
  steps: [{ type: 'input', selector: '#name', value: '{{data.氏名}}' }],
});
assert.deepEqual(r.issues, [], `問題なしのはずが: ${JSON.stringify(r.issues)}`);
assert.equal(summarize(r), '問題は見つかりませんでした');
console.log('OK: a clean recording produces no issues');

// --- データ列の不一致（最重要） ---
r = validateRecording({
  ...base,
  dataset: [{ 氏名: '山田', 年齢: '30' }],
  steps: [{ type: 'input', selector: '#a', value: '{{data.名前}}' }],
});
assert.ok(codes(r).includes('data-unknown-column'), '存在しない列を検出する');
assert.equal(r.errors.length, 1);
assert.match(r.errors[0].message, /「名前」列がありません/);
assert.match(r.errors[0].message, /ある列: 氏名, 年齢/, '実在する列名を案内する');
assert.equal(r.errors[0].stepIndex, 0, '該当ステップを指す');
console.log('OK: unknown data column is an error and names the available columns');

// データが無いのに {{data.x}} を使っている
r = validateRecording({ ...base, steps: [{ type: 'input', selector: '#a', value: '{{data.氏名}}' }] });
assert.ok(codes(r).includes('data-without-dataset'));
console.log('OK: {{data.x}} without a dataset is an error');

// {{data:列名}} 記法も検証される
r = validateRecording({
  ...base,
  dataset: [{ 氏名: '山田' }],
  steps: [{ type: 'input', selector: '#a', value: '{{data:誤り}}' }],
});
assert.ok(codes(r).includes('data-unknown-column'), 'コロン記法も同様に検出');
console.log('OK: colon syntax is validated too');

// --- 未対応の変数 ---
r = validateRecording({ ...base, steps: [{ type: 'input', selector: '#a', value: '{{today}}' }] });
assert.ok(codes(r).includes('unknown-var'));
assert.equal(r.warnings[0].level, 'warning', 'エラーではなく警告');
console.log('OK: unknown variable is a warning');

// 既知の変数は警告しない
r = validateRecording({
  ...base,
  steps: [{ type: 'input', selector: '#a', value: '{{date:YYYY}}{{seq:000}}{{uuid}}{{row}}{{random:0000}}' }],
});
assert.deepEqual(r.issues, [], '既知の変数だけなら無警告');
console.log('OK: all known variables pass');

// --- セレクタ構文 ---
r = validateRecording({ ...base, steps: [{ type: 'click', selector: '###' }] });
assert.ok(codes(r).includes('bad-selector'));
console.log('OK: malformed selector is an error');

r = validateRecording({ ...base, steps: [{ type: 'dragAndDrop', selector: '#a', toSelector: '[[bad' }] });
assert.ok(codes(r).includes('bad-selector'), '移動先セレクタも検証');
console.log('OK: dragAndDrop toSelector is validated');

// 複雑だが妥当なセレクタは通す
r = validateRecording({
  ...base,
  steps: [{ type: 'click', selector: 'div#x > ul:nth-of-type(2) > li[data-a="b c"]' }],
});
assert.deepEqual(r.issues, []);
console.log('OK: valid complex selectors pass');

// --- 数値項目 ---
r = validateRecording({ ...base, steps: [{ type: 'click', selector: '#a', timeoutMs: 'abc' }] });
assert.ok(codes(r).includes('bad-number'));
r = validateRecording({ ...base, steps: [{ type: 'click', selector: '#a', waitBeforeMs: -100 }] });
assert.ok(codes(r).includes('bad-number'), '負の値も弾く');
console.log('OK: non-numeric and negative timings are errors');

// --- navigate の URL ---
r = validateRecording({ ...base, steps: [{ type: 'navigate', url: 'ftp://x/' }] });
assert.ok(codes(r).includes('bad-url'));
// テンプレートを含む URL は実行時に決まるので検証をスキップする
r = validateRecording({ ...base, steps: [{ type: 'navigate', url: '{{data.url}}' }], dataset: [{ url: 'http://a/' }] });
assert.ok(!codes(r).includes('bad-url'), 'テンプレートURLは弾かない');
console.log('OK: navigate URL scheme is checked, templated URLs are exempt');

// --- パスワードの置き忘れ ---
r = validateRecording({ ...base, steps: [{ type: 'input', selector: '#p', value: '<PASSWORD>' }] });
assert.ok(codes(r).includes('password-placeholder'));
console.log('OK: leftover <PASSWORD> is flagged');

// --- データセットの列欠け ---
r = validateRecording({
  ...base,
  dataset: [{ a: '1', b: '2' }, { a: '3' }],
  steps: [
    { type: 'input', selector: '#a', value: '{{data.a}}' },
    { type: 'input', selector: '#b', value: '{{data.b}}' },
  ],
});
assert.ok(codes(r).includes('dataset-ragged'));
assert.match(r.warnings[0].message, /2 行目に列がありません: b/);
console.log('OK: ragged dataset rows are reported with the row number');

// --- 未使用の列 ---
r = validateRecording({
  ...base,
  dataset: [{ 使う: '1', 使わない: '2' }],
  steps: [{ type: 'input', selector: '#a', value: '{{data.使う}}' }],
});
assert.ok(codes(r).includes('unused-column'));
assert.match(r.infos[0].message, /使わない/);
console.log('OK: unused dataset columns are reported as info');

// --- その他 ---
r = validateRecording({ ...base, steps: [] });
assert.ok(codes(r).includes('no-steps'));
r = validateRecording({ ...base, steps: [{ type: 'click', selector: '#a', disabled: true }] });
assert.ok(codes(r).includes('all-disabled'));
r = validateRecording({ ...base, steps: [{ type: 'selectMultiple', selector: '#a', values: [] }] });
assert.ok(codes(r).includes('empty-values'));
r = validateRecording({ ...base, steps: [{ type: 'click', selector: '#a', disabled: true, optional: true }] });
assert.ok(codes(r).includes('disabled-and-optional'));
console.log('OK: empty steps / all-disabled / empty values / disabled+optional');

// --- 複数の値フィールドを走査する ---
r = validateRecording({
  ...base,
  dataset: [{ ok: '1' }],
  steps: [{ type: 'selectMultiple', selector: '#a', values: ['{{data.ok}}', '{{data.ng}}'] }],
});
assert.ok(codes(r).includes('data-unknown-column'), 'values 配列の中も見る');
console.log('OK: values[] entries are scanned');

// --- サマリ表示 ---
r = validateRecording({
  ...base,
  dataset: [{ a: '1', unused: '2' }],
  steps: [
    { type: 'input', selector: '###', value: '{{data.nope}}' },
    { type: 'input', selector: '#b', value: '{{mystery}}' },
  ],
});
assert.equal(summarize(r), 'エラー 2 / 警告 1 / 情報 1');
console.log('OK: summary line:', summarize(r));

console.log('\n--- 実際の指摘の見え方 ---');
for (const i of r.issues) console.log(`  [${i.level}] ${i.message}`);

console.log('\nALL VALIDATION CHECKS PASSED');
