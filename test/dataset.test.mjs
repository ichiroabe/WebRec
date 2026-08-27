import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

const { resolveTemplate, resolveStepTemplates } = await import(srcUrl('template.js'));
const {
  generatePlaywright,
  generatePuppeteer,
  generateJson,
  parseRecordingJson,
  validateDataset,
  parseDelimitedText,
} = await import(srcUrl('generator.js'));

const FIXED = new Date(2026, 7, 27, 14, 5, 9).getTime();

// --- {{data.列名}} の解決 ---
const row = { 氏名: '山田太郎', 年齢: 30, plan: 'pro', 空欄: '' };
const ctx = { now: FIXED, seq: 7, data: row, row: 2 };
const R = (s) => resolveTemplate(s, ctx);

assert.equal(R('{{data.氏名}}'), '山田太郎', '日本語の列名');
assert.equal(R('{{data:氏名}}'), '山田太郎', 'コロン記法も同じ');
assert.equal(R('{{data.年齢}}'), '30', '数値は文字列化される');
assert.equal(R('{{data.plan}}'), 'pro');
assert.equal(R('{{data.空欄}}'), '', '空文字はそのまま空文字');
console.log('OK: {{data.列名}} resolves, both dot and colon syntax');

// 列名の大小文字は区別される（{{date}} 等の判定で小文字化しないこと）
assert.equal(resolveTemplate('{{data.userName}}', { data: { userName: 'abc' } }), 'abc');
assert.equal(resolveTemplate('{{data.username}}', { data: { userName: 'abc' } }), '{{data.username}}');
console.log('OK: data keys are case-sensitive');

// 存在しない列はそのまま残る（間違いに気づけるように）
assert.equal(R('{{data.存在しない}}'), '{{data.存在しない}}');
assert.equal(resolveTemplate('{{data.x}}', { now: FIXED }), '{{data.x}}', 'データ無しの実行でも壊れない');
console.log('OK: unknown columns and dataset-less runs are left visible');

// --- {{row}} ---
assert.equal(R('{{row}}'), '2');
assert.equal(R('{{row:000}}'), '002');
assert.equal(resolveTemplate('{{row}}', { now: FIXED }), '1', '既定は1行目');
console.log('OK: {{row}} numbering');

// 他の変数と併用できる
assert.equal(R('{{data.氏名}}_{{date:YYYYMMDD}}_{{row:00}}'), '山田太郎_20260827_02');
console.log('OK: data mixes with date/row in one value');

// ステップ単位
const step = resolveStepTemplates({ type: 'input', selector: '#n', value: '{{data.氏名}}' }, ctx);
assert.equal(step.value, '山田太郎');
console.log('OK: step-level resolution uses the row');

// --- dataset の検証 ---
assert.equal(validateDataset(undefined), undefined);
assert.equal(validateDataset([]), undefined, '空配列は「データなし」扱い');
assert.deepEqual(validateDataset([{ a: '1' }]), [{ a: '1' }]);
assert.throws(() => validateDataset('abc'), /配列である必要/);
assert.throws(() => validateDataset([['a']]), /オブジェクトである必要/);
assert.throws(() => validateDataset([{ a: { b: 1 } }]), /文字列か数値/);
console.log('OK: dataset validation');

// --- CSV / TSV 取り込み ---
const csv = `氏名,年齢,備考
山田太郎,30,"カンマ, を含む"
鈴木花子,25,"引用符 "" を含む"
`;
const rows = parseDelimitedText(csv);
assert.equal(rows.length, 2);
assert.deepEqual(rows[0], { 氏名: '山田太郎', 年齢: '30', 備考: 'カンマ, を含む' });
assert.deepEqual(rows[1], { 氏名: '鈴木花子', 年齢: '25', 備考: '引用符 " を含む' });
console.log('OK: CSV with quoted commas and escaped quotes');

const tsv = '氏名\t年齢\n田中\t40\n';
assert.deepEqual(parseDelimitedText(tsv), [{ 氏名: '田中', 年齢: '40' }]);
console.log('OK: TSV is auto-detected');

assert.deepEqual(parseDelimitedText(''), []);
assert.deepEqual(parseDelimitedText('a,b\n\n\n1,2\n'), [{ a: '1', b: '2' }], '空行は捨てる');
console.log('OK: empty input and blank lines');

// --- JSON 往復 ---
const rec = {
  name: '一括登録テスト',
  startUrl: 'http://127.0.0.1:8791/complex.html',
  createdAt: 1700000000000,
  dataset: [
    { 氏名: '山田太郎', 年齢: '30' },
    { 氏名: '鈴木花子', 年齢: '25' },
    { 氏名: '佐藤次郎', 年齢: '41' },
  ],
  steps: [
    { type: 'input', selector: '#textField', value: '{{data.氏名}}' },
    { type: 'input', selector: '#refField', value: 'REF-{{date:YYYYMMDD}}-{{row:000}}' },
    { type: 'click', selector: '#submitBtn', text: '送信' },
  ],
};

const parsed = parseRecordingJson(generateJson(rec));
assert.equal(parsed.dataset.length, 3, 'dataset が JSON 往復で保たれる');
console.log('OK: dataset survives the JSON round trip');

// --- 生成スクリプトがループになること ---
const pw = generatePlaywright(rec);
console.log('\n=== Playwright (データ駆動) ===\n' + pw);
assert.match(pw, /const dataset = \[/);
assert.match(pw, /dataset\.forEach\(\(row, i\) => \{/);
assert.match(pw, /data: row, row: i \+ 1/);
assert.match(pw, /\.fill\(V\("\{\{data\.氏名\}\}"\)\)/);
console.log('OK: playwright emits one test per row');

const pp = generatePuppeteer(rec);
assert.match(pp, /for \(let i = 0; i < dataset\.length; i\+\+\)/);
assert.match(pp, /const row = dataset\[i\]/);
assert.match(pp, /await page\.goto\(/);
console.log('OK: puppeteer emits a loop over the dataset');

// 生成コードを実際に評価して、行ごとに違う値になることを確認
const engineStart = pp.indexOf('let __webrecSeq');
const engineEnd = pp.indexOf('// --- 繰り返し実行するデータ');
const datasetEnd = pp.indexOf('(async () => {');
const runnable =
  pp.slice(engineStart, engineEnd) +
  pp.slice(engineEnd, datasetEnd) +
  `
  return dataset.map((row, i) => {
    const V = (s) => resolveTemplate(s, { now: __webrecNow, seq: __webrecSeq, data: row, row: i + 1 });
    return V("{{data.氏名}}") + "/" + V("{{row:000}}");
  });`;
const results = new Function(runnable)();
assert.deepEqual(results, ['山田太郎/001', '鈴木花子/002', '佐藤次郎/003']);
console.log('OK: generated code produces per-row values:', results.join(', '));

// データなしの録画は従来どおりループを作らない
const plain = { name: 'x', startUrl: 'http://a/', steps: [{ type: 'click', selector: '#a' }] };
assert.ok(!generatePlaywright(plain).includes('dataset'), 'データ無しならループ無し');
assert.ok(!generatePuppeteer(plain).includes('dataset'));
console.log('OK: recordings without a dataset are unchanged');

console.log('\nALL DATASET CHECKS PASSED');
