// ステップ一覧からの削除・有効/無効の切り替えを検証する。
// manager.js 全体は chrome API に依存するため、同じ操作ロジックを再現して確かめる。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { srcUrl } from './helpers/src.mjs';

globalThis.document = new JSDOM('<div></div>').window.document;

const { parseRecordingJson, generateJson, stepSummary } = await import(srcUrl('generator.js'));
const { validateRecording } = await import(srcUrl('validate.js'));

// manager.js の deleteStep / toggleStepDisabled と同じ組み立て
const deleteStep = (steps, index) => steps.filter((_, i) => i !== index);
const toggleDisabled = (steps, index) =>
  steps.map((st, i) => {
    if (i !== index) return st;
    const next = { ...st };
    if (next.disabled) delete next.disabled;
    else next.disabled = true;
    return next;
  });

const base = [
  { type: 'click', selector: '#a' },
  { type: 'input', selector: '#b', value: 'x' },
  { type: 'click', selector: '#c' },
];

// --- 削除 ---
assert.deepEqual(deleteStep(base, 0), base.slice(1), '先頭を消せる');
assert.deepEqual(deleteStep(base, 2), base.slice(0, 2), '末尾を消せる');
assert.deepEqual(deleteStep(base, 1), [base[0], base[2]], '中間を消すと前後が詰まる');
assert.equal(base.length, 3, '元の配列は変えない');
console.log('OK: a step can be removed from the head, middle and tail');

// 存在しない位置を指定しても壊さない
assert.deepEqual(deleteStep(base, 9), base, '範囲外なら何も起きない');
assert.deepEqual(deleteStep([], 0), [], '空でも落ちない');
console.log('OK: out-of-range and empty inputs are harmless');

// 全部消しても保存できる形であること（検証は「ステップが無い」と警告するだけ）
let steps = base;
for (let i = base.length - 1; i >= 0; i--) steps = deleteStep(steps, i);
assert.deepEqual(steps, []);
const emptyRec = { name: 'x', startUrl: 'https://example.com/', steps, createdAt: 1 };
parseRecordingJson(generateJson(emptyRec)); // 例外が出ないこと
const v = validateRecording(emptyRec);
assert.ok(v.warnings.some((w) => w.code === 'no-steps'), '空になったら警告で知らせる');
assert.equal(v.errors.length, 0, '空でもエラーにはしない');
console.log('OK: deleting every step still saves, with a warning');

// --- 有効 / 無効の切り替え ---
let toggled = toggleDisabled(base, 1);
assert.equal(toggled[1].disabled, true, '無効にできる');
assert.equal(toggled[0].disabled, undefined, '他のステップは触らない');
assert.equal(base[1].disabled, undefined, '元の配列は変えない');

toggled = toggleDisabled(toggled, 1);
assert.ok(!('disabled' in toggled[1]), '戻したら値を残さない（既定に戻す）');
console.log('OK: disable/enable toggles cleanly and leaves no leftover key');

// 無効にしたステップは JSON 往復でも保たれる
const rec = { name: 'x', startUrl: 'https://example.com/', steps: toggleDisabled(base, 2), createdAt: 1 };
const parsed = parseRecordingJson(generateJson(rec));
assert.equal(parsed.steps[2].disabled, true);
assert.deepEqual(validateRecording(rec).errors, [], '無効化だけでエラーにはならない');
console.log('OK: a disabled step survives the JSON round trip');

// 全部無効にすると警告が出る
const allOff = { ...rec, steps: base.map((s) => ({ ...s, disabled: true })) };
assert.ok(
  validateRecording(allOff).warnings.some((w) => w.code === 'all-disabled'),
  '全部無効なら知らせる'
);
console.log('OK: disabling every step is reported');

// --- 表示 ---
assert.match(stepSummary(base[0]), /#a/);
console.log('OK: summaries still render:', stepSummary(base[1]));

console.log('\nALL STEP-EDIT CHECKS PASSED');
