// プルで入った新機能（検証ステップ / 代替セレクタ）のテスト
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { srcUrl } from './helpers/src.mjs';
const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;

const { parseRecordingJson, generateJson, generatePlaywright, generatePuppeteer, stepSummary } = await import(
  srcUrl('generator.js')
);
const { validateRecording } = await import(srcUrl('validate.js'));

// ---------- 検証ステップ ----------
const rec = {
  name: '検証つき',
  startUrl: 'https://example.com/',
  createdAt: 1,
  steps: [
    { type: 'click', selector: '#del' },
    { type: 'assertText', selector: '#msg', value: '削除しました' },
    { type: 'assertText', selector: '#title', value: '受信箱', match: 'equals' },
    { type: 'assertVisible', selector: '#result' },
    { type: 'assertMissing', selector: '#row-3' },
  ],
};

const parsed = parseRecordingJson(generateJson(rec));
assert.equal(parsed.steps.length, 5);
assert.equal(parsed.steps[2].match, 'equals', 'match 指定が保たれる');
assert.deepEqual(validateRecording(rec).issues, [], `指摘なしのはず: ${JSON.stringify(validateRecording(rec).issues)}`);
console.log('OK: assertion steps round-trip and validate');

// 必須項目が欠けていれば弾く
assert.throws(
  () => parseRecordingJson('{"startUrl":"https://a/","steps":[{"type":"assertText","selector":"#m"}]}'),
  /value/,
  'assertText には期待値が要る'
);
console.log('OK: assertText without a value is rejected');

console.log('\n--- 検証ステップの表示 ---');
rec.steps.slice(1).forEach((s) => console.log('  ' + stepSummary(s)));

// 出力にアサーションが入ること
const pw = generatePlaywright(rec);
const pp = generatePuppeteer(rec);
assert.match(pw, /expect/, 'Playwright は expect を使う');
assert.ok(/toContainText|toHaveText/.test(pw), 'テキスト検証が出力される');
assert.ok(/toBeVisible/.test(pw), '表示検証が出力される');
assert.ok(/toHaveCount\(0\)|not\.toBeVisible|toBeHidden/.test(pw), '不在検証が出力される');
console.log('OK: Playwright output contains real assertions');
assert.ok(/waitForSelector|\$eval|\$\(/.test(pp), 'Puppeteer 側にも検証が出る');
console.log('OK: Puppeteer output contains assertions');

// 生成コードが構文として妥当
for (const [label, code] of [['playwright', pw], ['puppeteer', pp]]) {
  new Function('require', 'test', 'expect', 'puppeteer', `return async () => {\n${code}\n}`);
  console.log(`OK: generated ${label} script parses`);
}

// ---------- 代替セレクタ ----------
const alt = {
  name: '代替セレクタ',
  startUrl: 'https://example.com/',
  createdAt: 1,
  steps: [
    {
      type: 'click',
      selector: '#inbox',
      selectors: ['#inbox', 'div#box > table > tbody > tr:nth-of-type(1) > td > a', 'a:text("受信箱")'],
    },
  ],
};
const altParsed = parseRecordingJson(generateJson(alt));
assert.equal(altParsed.steps[0].selectors.length, 3, '候補が保たれる');
assert.deepEqual(validateRecording(alt).issues, [], '独自表記 a:text(...) を不正セレクタ扱いしないこと');
console.log('OK: alternative selectors survive and do not trip the validator');

// selectors だけでも通る（selector 省略）
parseRecordingJson('{"startUrl":"https://a/","steps":[{"type":"click","selectors":["#a"]}]}');
console.log('OK: selectors alone is accepted');

// 空配列や非文字列は弾く
for (const [label, input, pattern] of [
  // selector も selectors も無い扱いになるので「セレクタが無い」で弾かれる
  ['どちらも無い', '{"startUrl":"https://a/","steps":[{"type":"click","selectors":[]}]}', /selector/],
  // selector はあるが selectors が空 → 候補配列そのものの検証で弾かれる
  ['候補が空', '{"startUrl":"https://a/","steps":[{"type":"click","selector":"#a","selectors":[]}]}', /1つ以上/],
  ['候補が文字列でない', '{"startUrl":"https://a/","steps":[{"type":"click","selector":"#a","selectors":[123]}]}', /./],
]) {
  assert.throws(() => parseRecordingJson(input), pattern, label);
}
console.log('OK: malformed selectors arrays are rejected on both paths');

// 出力は先頭の候補を使う（1本に決まること）
const altPw = generatePlaywright(alt);
assert.match(altPw, /locator\("#inbox"\)/, '出力は先頭候補を使う');
assert.ok(!altPw.includes('a:text('), '独自表記は出力に漏らさない');
console.log('OK: exports use the first candidate and never leak the custom :text() syntax');

console.log('\nALL ASSERTION / ALT-SELECTOR CHECKS PASSED');
