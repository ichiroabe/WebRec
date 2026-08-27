// 独自表記 tag:text("...") のエスケープ往復を検証する
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { srcPath } from './helpers/src.mjs';

const contentSrc = readFileSync(srcPath('content.js'), 'utf8');
const bgSrc = readFileSync(srcPath('background.js'), 'utf8');

function extractFunction(src, name) {
  const head = src.indexOf(`function ${name}(`);
  assert.notEqual(head, -1, `${name} が見つからない`);
  let depth = 0;
  for (let i = src.indexOf('{', head); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(head, i + 1);
  }
  throw new Error(`${name} の終わりが見つからない`);
}

// 記録側のエンコード
const attrEscape = new Function('str', `${extractFunction(contentSrc, 'attrEscape')}\nreturn attrEscape(str);`);
const textSelector = new Function(
  'tag',
  'text',
  `${extractFunction(contentSrc, 'attrEscape')}\n${extractFunction(contentSrc, 'textSelector')}\nreturn textSelector(tag, text);`
);

// 再生側のデコード（background.js の resolveOne が使っている変換をそのまま取り出す）
const RE = /^([a-zA-Z][\w-]*):text\("([\s\S]*)"\)$/;
const decodeLine = bgSrc.match(/findByLabel\(m\[1\], (.+?)\)\s*:/);
assert.ok(decodeLine, 'resolveOne のデコード処理が見つからない');
const decodeExpr = decodeLine[1]; // 例: m[2].replace(/\\"/g, '"')
const decode = new Function('m', `return ${decodeExpr};`);

function roundTrip(tag, text) {
  const sel = textSelector(tag, text);
  const m = RE.exec(sel);
  assert.ok(m, `セレクタが自分の正規表現に合致しない: ${sel}`);
  return decode(m);
}

// --- 通常のテキスト ---
for (const text of ['受信箱', '保存', 'Save changes', '削除 (3件)', 'a b  c']) {
  assert.equal(roundTrip('button', text), text, `往復で変わってしまう: ${text}`);
}
console.log('OK: plain labels round-trip');

// --- 引用符を含む ---
for (const text of ['say "hi"', 'a")b', '"', '""']) {
  assert.equal(roundTrip('button', text), text, `引用符の往復に失敗: ${text}`);
}
console.log('OK: labels containing double quotes round-trip');

// --- バックスラッシュを含む ---
const backslashCases = ['C:\\temp', 'a\\b', '保存\\', '\\', 'a\\"b'];
const broken = [];
for (const text of backslashCases) {
  const got = roundTrip('button', text);
  if (got !== text) broken.push({ text, got });
}
if (broken.length) {
  console.log('NG: バックスラッシュを含むラベルが往復しない');
  for (const b of broken) console.log(`   入力 ${JSON.stringify(b.text)} → 復元 ${JSON.stringify(b.got)}`);
}
assert.deepEqual(broken, [], 'バックスラッシュを含むラベルの往復が壊れている');
console.log('OK: labels containing backslashes round-trip');

console.log('\nALL TEXT-SELECTOR CHECKS PASSED');
