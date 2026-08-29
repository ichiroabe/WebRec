// 記録後の正規化（連続する同じ操作の畳み込み）を検証する。
import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

const { normalizeSteps } = await import(srcUrl('normalize.js'));

const run = (steps) => normalizeSteps(steps);

// --- 連続する同じ欄への入力は最後だけ残る ---
let r = run([
  { type: 'input', selector: '#a', value: '1' },
  { type: 'input', selector: '#a', value: '12' },
  { type: 'input', selector: '#a', value: '123' },
]);
assert.deepEqual(r.steps, [{ type: 'input', selector: '#a', value: '123' }]);
assert.equal(r.removed, 2);
assert.deepEqual(r.byType, { input: 2 });
console.log('OK: consecutive inputs on one field collapse to the last value');

// --- 間に別の操作が入れば畳まない ---
r = run([
  { type: 'input', selector: '#a', value: '1' },
  { type: 'click', selector: '#go' },
  { type: 'input', selector: '#a', value: '2' },
]);
assert.equal(r.steps.length, 3, '検索→再入力のような流れは壊さない');
assert.equal(r.removed, 0);
console.log('OK: an intervening step keeps both inputs');

// --- 別の欄なら畳まない ---
r = run([
  { type: 'input', selector: '#a', value: '1' },
  { type: 'input', selector: '#b', value: '2' },
]);
assert.equal(r.steps.length, 2);
console.log('OK: different fields are untouched');

// --- 同じセレクタでもフレームが違えば別物 ---
r = run([
  { type: 'input', selector: '#a', value: '1', frames: ['#f1'] },
  { type: 'input', selector: '#a', value: '2', frames: ['#f2'] },
  { type: 'input', selector: '#a', value: '3' },
]);
assert.equal(r.steps.length, 3, 'フレームが違えば畳まない');
console.log('OK: same selector in different frames is not collapsed');

// --- スクロール ---
r = run([
  { type: 'scroll', x: 0, y: 100 },
  { type: 'scroll', x: 0, y: 400 },
  { type: 'scroll', x: 0, y: 900 },
]);
assert.deepEqual(r.steps, [{ type: 'scroll', x: 0, y: 900 }], '最後の位置だけ残る');
console.log('OK: consecutive window scrolls collapse to the final position');

// ウィンドウのスクロールと要素のスクロールは別物
r = run([
  { type: 'scroll', x: 0, y: 100 },
  { type: 'scroll', selector: '#pane', x: 0, y: 50 },
]);
assert.equal(r.steps.length, 2);
console.log('OK: window scroll and element scroll are distinct');

// --- select / editable も同じ扱い ---
r = run([
  { type: 'select', selector: '#s', value: 'a' },
  { type: 'select', selector: '#s', value: 'b' },
]);
assert.deepEqual(r.steps, [{ type: 'select', selector: '#s', value: 'b' }]);
r = run([
  { type: 'editable', selector: '#e', html: '<b>1</b>' },
  { type: 'editable', selector: '#e', html: '<b>2</b>' },
]);
assert.equal(r.steps.length, 1);
assert.equal(r.steps[0].html, '<b>2</b>');
console.log('OK: select and contenteditable collapse the same way');

// --- 1回ずつ意味のあるものは畳まない ---
for (const type of ['click', 'keydown', 'navigate', 'upload', 'dblclick', 'contextmenu']) {
  const a = { type, selector: '#x', key: 'Enter', url: 'https://a/', files: [] };
  r = run([a, { ...a }]);
  assert.equal(r.steps.length, 2, `${type} は畳んではいけない`);
}
console.log('OK: clicks, keys, navigations and uploads are never collapsed');

// --- 手で入れた指定は消さない ---
r = run([
  { type: 'input', selector: '#a', value: '1', waitBeforeMs: 2000 },
  { type: 'input', selector: '#a', value: '2' },
]);
assert.equal(r.steps.length, 2, '待ちを指定したステップは残す');
r = run([
  { type: 'input', selector: '#a', value: '1', disabled: true },
  { type: 'input', selector: '#a', value: '2' },
]);
assert.equal(r.steps.length, 2, '無効化したステップは残す');
console.log('OK: steps carrying an explicit intent are preserved');

// --- 冪等: 2回かけても変わらない ---
const messy = [
  { type: 'input', selector: '#a', value: '1' },
  { type: 'input', selector: '#a', value: '2' },
  { type: 'scroll', x: 0, y: 10 },
  { type: 'scroll', x: 0, y: 20 },
  { type: 'click', selector: '#go' },
];
const once = run(messy);
const twice = run(once.steps);
assert.deepEqual(twice.steps, once.steps, '2回目は何も変わらない');
assert.equal(twice.removed, 0);
console.log('OK: normalization is idempotent');

// --- 元の配列を壊さない ---
assert.equal(messy.length, 5);
console.log('OK: the input array is left untouched');

// --- 端の条件 ---
assert.deepEqual(run([]).steps, []);
assert.deepEqual(run(null).steps, []);
assert.equal(run([{ type: 'click', selector: '#a' }]).removed, 0);
console.log('OK: empty and single-step inputs are safe');

// --- まとまった例 ---
r = run([
  { type: 'scroll', x: 0, y: 200 },
  { type: 'scroll', x: 0, y: 700 },
  { type: 'input', selector: '#name', value: 'Yam' },
  { type: 'input', selector: '#name', value: 'Yamada' },
  { type: 'input', selector: '#name', value: 'Suzuki' },
  { type: 'click', selector: '#submit' },
]);
assert.deepEqual(r.steps, [
  { type: 'scroll', x: 0, y: 700 },
  { type: 'input', selector: '#name', value: 'Suzuki' },
  { type: 'click', selector: '#submit' },
]);
assert.equal(r.removed, 3);
assert.deepEqual(r.byType, { scroll: 1, input: 2 });
console.log('OK: a realistic recording goes from 6 steps to 3');

console.log('\nALL NORMALIZE CHECKS PASSED');
