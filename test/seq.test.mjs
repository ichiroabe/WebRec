import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

const store = {};
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
};

const { peekSeq, setNextSeq, nextSeq } = await import(srcUrl('settings.js'));
const { resolveTemplate, TEMPLATE_HELP, helpSyntax } = await import(srcUrl('template.js'));
const { t } = await import(srcUrl('i18n.js'));

// --- 0埋めあり / なしの書式 ---
const ctx = { seq: 42, row: 7 };
assert.equal(resolveTemplate('{{seq}}', ctx), '42', '書式なしは0埋めなしの通常連番');
assert.equal(resolveTemplate('{{seq:#}}', ctx), '42', '# も0埋めなし');
assert.equal(resolveTemplate('{{seq:####}}', ctx), '42', '#### でも桁は増えない');
assert.equal(resolveTemplate('{{seq:000}}', ctx), '042', '0埋め3桁');
assert.equal(resolveTemplate('{{seq:00000}}', ctx), '00042', '0埋め5桁');
console.log('OK: {{seq}} is the plain counter; only 0-masks pad');

// 桁数を超える値は切り詰めずそのまま出す
assert.equal(resolveTemplate('{{seq:00}}', { seq: 12345 }), '12345', 'マスクより大きい値は欠けない');
console.log('OK: values larger than the mask are not truncated');

// row も同じ規則
assert.equal(resolveTemplate('{{row}}', ctx), '7');
assert.equal(resolveTemplate('{{row:000}}', ctx), '007');
console.log('OK: {{row}} follows the same rule');

// --- 採番の永続化 ---
assert.equal(await peekSeq(), 1, '初回は 1');
assert.equal(await nextSeq(), 1, '1回目の再生で 1 を使う');
assert.equal(await peekSeq(), 2, '次は 2');
assert.equal(await nextSeq(), 2);
assert.equal(await nextSeq(), 3);
assert.equal(await peekSeq(), 4);
console.log('OK: seq increments once per replay and persists');

// --- 振り直し ---
assert.equal(await setNextSeq(1), 1);
assert.equal(await peekSeq(), 1, '1 に戻せる');
assert.equal(await nextSeq(), 1);
console.log('OK: seq can be reset to 1');

assert.equal(await setNextSeq(100), 100, '任意の値から開始できる');
assert.equal(await nextSeq(), 100);
assert.equal(await nextSeq(), 101);
console.log('OK: seq can start from an arbitrary value');

// 不正な入力は 1 に丸める
assert.equal(await setNextSeq(0), 1);
assert.equal(await setNextSeq(-5), 1);
assert.equal(await setNextSeq('abc'), 1);
assert.equal(await setNextSeq(3.7), 4, '小数は四捨五入');
console.log('OK: invalid seq input is clamped to a sane value');

// --- ヘルプ表に0埋めなしの形が載っていること ---
const syntaxes = TEMPLATE_HELP.map((h) => helpSyntax(h, 'ja'));
assert.ok(syntaxes.includes('{{seq}}'), 'ヘルプに {{seq}} がある');
assert.ok(syntaxes.includes('{{seq:000}}'), 'ヘルプに {{seq:000}} がある');
assert.ok(syntaxes.includes('{{row}}'), 'ヘルプに {{row}} がある');
console.log('OK: help table lists both padded and unpadded forms');

// 言語ごとに構文サンプルが用意されていること
assert.equal(helpSyntax(TEMPLATE_HELP[0], 'ja'), '{{data.列名}}');
assert.equal(helpSyntax(TEMPLATE_HELP[0], 'en'), '{{data.column}}');
console.log('OK: help syntax adapts to the language');

console.log('\nヘルプ表:');
for (const h of TEMPLATE_HELP) console.log(`  ${helpSyntax(h, 'ja').padEnd(30)} ${t(h.descKey)}`);

console.log('\nALL SEQ CHECKS PASSED');
