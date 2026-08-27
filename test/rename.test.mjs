// 一覧での名前変更の挙動を jsdom 上で検証する。
// manager.js の buildRow と同じロジックを再現して確かめる。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<table><tbody id="body"></tbody></table>');
const { document: doc, Event, KeyboardEvent } = dom.window;

// updateRecording の呼び出しを記録するスタブ
const saved = [];
async function updateRecording(id, patch) {
  saved.push({ id, patch });
}

function buildNameInput(rec) {
  const nameInput = doc.createElement('input');
  nameInput.className = 'name-input';
  nameInput.value = rec.name;

  nameInput.addEventListener('change', async () => {
    const next = nameInput.value.trim();
    if (!next) {
      nameInput.value = rec.name;
      return;
    }
    if (next === rec.name) return;
    await updateRecording(rec.id, { name: next });
    rec.name = next;
    nameInput.value = next;
    nameInput.classList.add('saved');
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      nameInput.value = rec.name;
      nameInput.blur();
    }
  });

  return nameInput;
}

// jsdom は blur だけでは change を発火しないので、ブラウザの挙動を模して明示的に投げる
function typeAndCommit(input, text, how = 'blur') {
  const before = input.value;
  input.value = text;
  if (how === 'enter') {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  } else if (how === 'escape') {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return; // Esc は値を戻すので change は起きない
  }
  if (input.value !== before) input.dispatchEvent(new Event('change'));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// --- 1. 通常の変更 ---
saved.length = 0;
let rec = { id: 'r1', name: '元の名前' };
let input = buildNameInput(rec);
typeAndCommit(input, '新しい名前');
await tick();
assert.deepEqual(saved, [{ id: 'r1', patch: { name: '新しい名前' } }]);
assert.equal(rec.name, '新しい名前', '手元のオブジェクトも更新される');
assert.ok(input.classList.contains('saved'), '保存フィードバックが出る');
console.log('OK: rename saves and updates in place');

// --- 2. Enter で確定 ---
saved.length = 0;
rec = { id: 'r2', name: 'A' };
input = buildNameInput(rec);
typeAndCommit(input, 'B', 'enter');
await tick();
assert.deepEqual(saved, [{ id: 'r2', patch: { name: 'B' } }]);
console.log('OK: Enter commits the rename');

// --- 3. Esc で取り消し ---
saved.length = 0;
rec = { id: 'r3', name: '変えない' };
input = buildNameInput(rec);
typeAndCommit(input, '打ち間違い', 'escape');
await tick();
assert.equal(saved.length, 0, 'Esc では保存しない');
assert.equal(input.value, '変えない', '元の名前に戻る');
console.log('OK: Escape reverts without saving');

// --- 4. 空文字は拒否して元に戻す ---
saved.length = 0;
rec = { id: 'r4', name: '消さないで' };
input = buildNameInput(rec);
typeAndCommit(input, '');
await tick();
assert.equal(saved.length, 0, '空の名前では保存しない');
assert.equal(input.value, '消さないで');
console.log('OK: empty name is rejected and reverted');

// --- 5. 空白だけも拒否 ---
saved.length = 0;
rec = { id: 'r5', name: '元' };
input = buildNameInput(rec);
typeAndCommit(input, '   ');
await tick();
assert.equal(saved.length, 0);
assert.equal(input.value, '元');
console.log('OK: whitespace-only name is rejected');

// --- 6. 前後の空白は取り除いて保存 ---
saved.length = 0;
rec = { id: 'r6', name: '元' };
input = buildNameInput(rec);
typeAndCommit(input, '  整形される  ');
await tick();
assert.deepEqual(saved, [{ id: 'r6', patch: { name: '整形される' } }]);
console.log('OK: surrounding whitespace is trimmed');

// --- 7. 変更なしなら書き込まない ---
saved.length = 0;
rec = { id: 'r7', name: '同じ' };
input = buildNameInput(rec);
input.dispatchEvent(new Event('change')); // 値を変えずに blur した場合
await tick();
assert.equal(saved.length, 0, '同じ名前では保存しない');
console.log('OK: no write when the name is unchanged');

// --- 8. 日本語・記号・長い名前も通る ---
saved.length = 0;
rec = { id: 'r8', name: 'x' };
input = buildNameInput(rec);
const tricky = '受注登録テスト①【本番】 2026/08/27 <確認>';
typeAndCommit(input, tricky);
await tick();
assert.deepEqual(saved, [{ id: 'r8', patch: { name: tricky } }]);
console.log('OK: Japanese text, symbols and brackets are preserved');

console.log('\nALL RENAME CHECKS PASSED');
