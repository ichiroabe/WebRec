import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

const { generatePlaywright, generatePuppeteer, stepSummary } = await import(srcUrl('generator.js'));

const rec = {
  name: '複合フォーム',
  startUrl: 'http://127.0.0.1:8791/complex.html',
  createdAt: Date.now(),
  steps: [
    { type: 'input', selector: '#textField', value: '訂正後のテキスト' },
    { type: 'input', selector: '#passwordField', value: '<PASSWORD>' },
    { type: 'click', selector: '#chkA', tag: 'input', text: '' },
    { type: 'click', selector: '#planPro', tag: 'input', text: '' },
    { type: 'select', selector: '#singleSelect', value: 'osaka' },
    { type: 'selectMultiple', selector: '#availableList', values: ['item1', 'item3'] },
    { type: 'click', selector: '#moveRight', tag: 'button', text: '→ 追加' },
    { type: 'dragAndDrop', selector: '#dragItem1', toSelector: '#dropTarget' },
    // iframe 内の操作
    { type: 'input', selector: '#frameText', value: 'iframe値', frames: ['#innerFrame'] },
    { type: 'click', selector: '#frameCheck', tag: 'input', text: '', frames: ['#innerFrame'] },
    { type: 'select', selector: '#frameSelect', value: 'y', frames: ['#innerFrame'] },
    { type: 'navigate', url: 'http://127.0.0.1:8791/page2.html' },
  ],
};

const pw = generatePlaywright(rec);
console.log('=== Playwright ===\n' + pw);

assert.match(pw, /\.locator\("#availableList"\)\.selectOption\(\["item1","item3"\]\)/);
assert.match(pw, /\.locator\("#dragItem1"\)\.dragTo\(page\.locator\("#dropTarget"\)\)/);
assert.match(pw, /page\.frameLocator\("#innerFrame"\)\.locator\("#frameText"\)\.fill\("iframe値"\)/);
assert.match(pw, /page\.frameLocator\("#innerFrame"\)\.locator\("#frameCheck"\)\.click\(\)/);
assert.match(pw, /await page\.goto\("http:\/\/127\.0\.0\.1:8791\/page2\.html"\)/);
console.log('OK: playwright handles multi-select, D&D, iframe scope, navigate');

const pp = generatePuppeteer(rec);
console.log('\n=== Puppeteer ===\n' + pp);

assert.match(pp, /\.select\("#availableList", "item1", "item3"\)/);
assert.match(pp, /waitForSelector\("#dragItem1"\)\)\.drop\(/);
assert.match(pp, /waitForSelector\("#innerFrame"\)\)\.contentFrame\(\)/);
assert.match(pp, /frame1\.type\("#frameText", "iframe値"\)/);
console.log('OK: puppeteer handles multi-select, D&D, iframe frames');

const summaries = rec.steps.map(stepSummary);
console.log('\n=== summaries ===');
for (const s of summaries) console.log(' - ' + s);
assert.ok(summaries.find((s) => s.includes('複数選択') && s.includes('item1, item3')));
assert.ok(summaries.find((s) => s.includes('ドラッグ&ドロップ')));
assert.ok(summaries.find((s) => s.includes('[フレーム: #innerFrame]')));
console.log('\nOK: summaries describe new step types');

// 未対応タイプがクラッシュせずコメント化されること
const weird = { ...rec, steps: [{ type: 'somethingNew', selector: '#x' }] };
assert.match(generatePlaywright(weird), /未対応のステップ: somethingNew/);
console.log('OK: unknown step types degrade to a comment');

console.log('\nALL GENERATOR CHECKS PASSED');
