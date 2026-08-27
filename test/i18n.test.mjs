import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { srcUrl, srcPath } from './helpers/src.mjs';

const store = {};
const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;
// Node 24 の navigator は読み取り専用なので上書きせず、chrome.i18n 側で言語を切り替える
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return key in store ? { [key]: store[key] } : {};
      },
      async set(obj) {
        Object.assign(store, obj);
      },
      async remove(key) {
        delete store[key];
      },
    },
  },
  i18n: { getUILanguage: () => 'ja' },
};

const i18n = await import(srcUrl('i18n.js'));
const { t, initI18n, setLang, getLang, applyI18n, LANGS } = i18n;

// --- カタログの網羅性: ja と en のキーが完全に一致すること ---
const src = readFileSync(srcPath('i18n.js'), 'utf8');
const jaBlock = src.slice(src.indexOf('  ja: {'), src.indexOf('  en: {'));
const enBlock = src.slice(src.indexOf('  en: {'), src.lastIndexOf('};'));
const keysOf = (block) => new Set([...block.matchAll(/^\s{4}'([^']+)':/gm)].map((m) => m[1]));
const jaKeys = keysOf(jaBlock);
const enKeys = keysOf(enBlock);

const onlyJa = [...jaKeys].filter((k) => !enKeys.has(k));
const onlyEn = [...enKeys].filter((k) => !jaKeys.has(k));
assert.deepEqual(onlyJa, [], `英語に無いキー: ${onlyJa.join(', ')}`);
assert.deepEqual(onlyEn, [], `日本語に無いキー: ${onlyEn.join(', ')}`);
console.log(`OK: both catalogs define the same ${jaKeys.size} keys`);

// --- ソース中で使われているキーがカタログに存在すること ---
const usedKeys = new Set();
for (const file of ['manager.js', 'popup.js', 'generator.js', 'validate.js', 'settings.js', 'template.js', 'background.js']) {
  const text = readFileSync(srcPath(file), 'utf8');
  for (const m of text.matchAll(/\bt\('([^']+)'/g)) usedKeys.add(m[1]);
  for (const m of text.matchAll(/(?:labelKey|hintKey|descKey):\s*'([^']+)'/g)) usedKeys.add(m[1]);
}
for (const file of ['manager.html', 'popup.html']) {
  const text = readFileSync(srcPath(file), 'utf8');
  for (const m of text.matchAll(/data-i18n(?:-html|-title|-placeholder)?="([^"]+)"/g)) usedKeys.add(m[1]);
}
const undefinedKeys = [...usedKeys].filter((k) => !jaKeys.has(k));
assert.deepEqual(undefinedKeys, [], `カタログに無いキーが使われている: ${undefinedKeys.join(', ')}`);
console.log(`OK: all ${usedKeys.size} keys used in code/HTML exist in the catalog`);

// content.js は module ではないためオーバーレイの文言を自前で持っている。
// カタログとズレていないことを確認する（片方だけ直す事故を防ぐ）。
const contentSrc = readFileSync(srcPath('content.js'), 'utf8');
const overlayBlock = contentSrc.slice(contentSrc.indexOf('const OVERLAY_TEXT'), contentSrc.indexOf('let overlayLang'));
for (const [lang, key, prop] of [
  ['ja', 'overlay.recording', 'recording'],
  ['ja', 'overlay.stop', 'stop'],
  ['en', 'overlay.recording', 'recording'],
  ['en', 'overlay.stop', 'stop'],
]) {
  const block = overlayBlock.slice(overlayBlock.indexOf(`${lang}: {`));
  const m = new RegExp(`${prop}: '([^']*)'`).exec(block);
  assert.ok(m, `content.js に ${lang}.${prop} が見つからない`);
  const fromCatalog = (lang === 'ja' ? jaBlock : enBlock).match(new RegExp(`'${key}': '([^']*)'`))[1];
  assert.equal(m[1], fromCatalog, `content.js の ${lang}.${prop} がカタログとズレている`);
}
console.log('OK: content.js overlay strings match the catalog (both languages)');

// t(`runs.status.${x}`) のように動的に組み立てるキーもあるので、
// テンプレートリテラルの前半をプレフィックスとして拾う
const dynamicPrefixes = new Set();
for (const file of ['manager.js', 'popup.js', 'generator.js', 'validate.js', 'background.js']) {
  const text = readFileSync(srcPath(file), 'utf8');
  for (const m of text.matchAll(/\bt\(`([A-Za-z0-9_.]*?)\$\{/g)) dynamicPrefixes.add(m[1]);
  // t(cond ? 'a.b' : 'c.d') のように、t( の直後以外に現れるキーも拾う
  for (const m of text.matchAll(/'([a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+)'/g)) usedKeys.add(m[1]);
}
const coveredDynamically = (k) => [...dynamicPrefixes].some((p) => p && k.startsWith(p));

// 使われていないキーの報告（エラーにはしない）
const unused = [...jaKeys].filter(
  (k) => !usedKeys.has(k) && !k.startsWith('overlay.') && !coveredDynamically(k)
);
if (unused.length) console.log(`   (note: ${unused.length} keys not referenced: ${unused.slice(0, 8).join(', ')}…)`);

// --- 言語判定 ---
await initI18n();
assert.equal(getLang(), 'ja', 'ブラウザが日本語なら既定は ja');
console.log('OK: defaults to ja for a Japanese browser');

globalThis.chrome.i18n.getUILanguage = () => 'en-US';
delete store.webrec_lang;
await initI18n();
assert.equal(getLang(), 'en', '英語環境なら既定は en');
console.log('OK: defaults to en for an English browser');

// --- 保存した選択が優先されること ---
await setLang('ja');
assert.equal(store.webrec_lang, 'ja', '選択が保存される');
await initI18n();
assert.equal(getLang(), 'ja', 'ブラウザが英語でも保存した ja が優先される');
console.log('OK: an explicit choice overrides the browser language and persists');

// 不正な値は無視して自動判定に戻る
store.webrec_lang = 'fr';
await initI18n();
assert.equal(getLang(), 'en');
console.log('OK: an unsupported stored value falls back to detection');

// --- 置換 ---
await setLang('ja');
assert.equal(t('popup.stepCount', { n: 5 }), '5 ステップ');
assert.equal(t('list.confirmDelete', { name: 'テスト' }), '「テスト」を削除しますか？');
await setLang('en');
assert.equal(t('popup.stepCount', { n: 5 }), '5 steps');
assert.equal(t('list.confirmDelete', { name: 'demo' }), 'Delete "demo"?');
console.log('OK: placeholder substitution works in both languages');

// パラメータ未指定なら {name} を残す（消して意味不明にしない）
assert.equal(t('popup.stepCount'), '{n} steps');
// 未知のキーはキー名を返して気づけるようにする
assert.equal(t('no.such.key'), 'no.such.key');
console.log('OK: missing params and unknown keys degrade visibly');

// --- applyI18n が DOM を書き換えること ---
const page = new JSDOM(`
  <title data-i18n="app.managerTitle"></title>
  <h1 data-i18n="app.managerHeading"></h1>
  <p data-i18n-html="json.varsHint"></p>
  <button data-i18n-title="steps.jumpHint"></button>
`);
globalThis.document = page.window.document;
await setLang('en');
applyI18n(page.window.document);
assert.equal(page.window.document.querySelector('h1').textContent, '● WebRec Script Manager');
assert.match(page.window.document.querySelector('p').innerHTML, /<code>value<\/code>/, 'HTML はタグごと入る');
assert.equal(page.window.document.querySelector('button').title, 'Click to reveal this step in the JSON');
console.log('OK: applyI18n fills text, html and title attributes');

// --- 言語一覧 ---
assert.deepEqual(LANGS.map((l) => l.code), ['ja', 'en']);
assert.deepEqual(LANGS.map((l) => l.label), ['日本語', 'English']);
console.log('OK: language list');

console.log('\nALL I18N CHECKS PASSED');
