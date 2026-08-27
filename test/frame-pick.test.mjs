// 複数フレームの結果から採用するものを選ぶ処理の検証。
// とくに assertMissing は「どのフレームにも無い」ことが合格条件になる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { srcPath } from './helpers/src.mjs';

// background.js は chrome API に依存するので、対象の関数だけ取り出して評価する
const src = readFileSync(srcPath('background.js'), 'utf8');
const head = src.indexOf('export function pickStepResult(');
assert.notEqual(head, -1, 'pickStepResult が background.js に見つからない');
let depth = 0;
let body = '';
for (let i = src.indexOf('{', head); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) {
    body = src.slice(head, i + 1).replace(/^export /, '');
    break;
  }
}
const pickStepResult = new Function(`${body}\nreturn pickStepResult;`)();

const frame = (over) => ({ result: { matched: true, ...over } });
const notMine = { result: { matched: false } };

// --- 通常のステップ: 引き受けたフレームの結果を返す ---
assert.equal(pickStepResult({ type: 'click' }, [notMine, frame({ ok: 1 })]).ok, 1);
assert.equal(pickStepResult({ type: 'click' }, [notMine, notMine]), null, '誰も引き受けなければ null');
assert.equal(pickStepResult({ type: 'click' }, []), null);
assert.equal(pickStepResult({ type: 'click' }, null), null, 'results が無くても落ちない');
console.log('OK: ordinary steps take the frame that handled them');

// --- assertMissing: 1つでも「見えている」フレームがあれば不合格 ---
const present = frame({ assertPresent: true, assertFailed: { kind: 'missing', selector: '#row-3' } });
const absent = frame({ assertPresent: false });

// 同じ深さのフレームが複数あり、片方にだけ要素が残っているケース
let got = pickStepResult({ type: 'assertMissing' }, [absent, present]);
assert.ok(got.assertFailed, '別フレームに残っていれば不合格にする');
assert.equal(got.assertFailed.selector, '#row-3');

// 順番が逆でも同じ結論になること（先頭勝ちにしない）
got = pickStepResult({ type: 'assertMissing' }, [present, absent]);
assert.ok(got.assertFailed, '順序に依存しない');
console.log('OK: assertMissing fails when ANY frame still sees the element (order-independent)');

// --- どのフレームにも無ければ合格 ---
got = pickStepResult({ type: 'assertMissing' }, [absent, absent, notMine]);
assert.ok(got, '合格の結果が返る');
assert.ok(!got.assertFailed, 'どこにも無ければ合格');
console.log('OK: assertMissing passes only when every frame reports it absent');

// --- 単一フレーム（exact 一致）でも従来どおり ---
assert.ok(!pickStepResult({ type: 'assertMissing' }, [absent]).assertFailed);
assert.ok(pickStepResult({ type: 'assertMissing' }, [present]).assertFailed);
console.log('OK: single-frame behaviour is unchanged');

// --- 誰も引き受けなければ null（呼び出し側がリトライ/エラーにする） ---
assert.equal(pickStepResult({ type: 'assertMissing' }, [notMine, notMine]), null);
console.log('OK: assertMissing with no owning frame returns null');

// --- 他の assert は従来どおり先頭を採用 ---
const failedText = frame({ assertFailed: { kind: 'text', expected: 'a', actual: 'b' } });
assert.ok(pickStepResult({ type: 'assertText' }, [failedText]).assertFailed);
assert.ok(!pickStepResult({ type: 'assertVisible' }, [frame({})]).assertFailed);
console.log('OK: other assertions are unaffected');

console.log('\nALL FRAME-PICK CHECKS PASSED');
