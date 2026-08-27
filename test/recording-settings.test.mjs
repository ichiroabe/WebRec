// 録画ごとの設定 UI のロジック（継承 / 上書き / 解除）を jsdom 上で検証する。
// manager.js 全体は chrome API に依存するため、同じ描画・収集ロジックを再現して確かめる。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { srcUrl } from './helpers/src.mjs';

const { SETTING_FIELDS, DEFAULT_SETTINGS, effectiveSettings } = await import(srcUrl('settings.js'));

const dom = new JSDOM('<div id="recSettingsFields"></div>');
const doc = dom.window.document;
const recSettingsFields = doc.getElementById('recSettingsFields');

// --- manager.js と同じ描画ロジック ---
function renderRecSettings(rec, globals) {
  const overrides = rec.settings || {};
  recSettingsFields.innerHTML = '';
  for (const field of SETTING_FIELDS) {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, field.key);
    const row = doc.createElement('div');

    const inherit = doc.createElement('input');
    inherit.type = 'checkbox';
    inherit.dataset.inheritFor = field.key;
    inherit.checked = !overridden;

    const input = doc.createElement('input');
    input.type = 'number';
    input.dataset.key = field.key;
    input.value = String(overridden ? overrides[field.key] : globals[field.key]);
    input.disabled = !overridden;

    inherit.addEventListener('change', () => {
      input.disabled = inherit.checked;
      if (inherit.checked) input.value = String(globals[field.key]);
    });

    row.append(inherit, input);
    recSettingsFields.appendChild(row);
  }
}

function collectRecSettings() {
  const out = {};
  for (const input of recSettingsFields.querySelectorAll('input[data-key]')) {
    const inherit = recSettingsFields.querySelector(`input[data-inherit-for="${input.dataset.key}"]`);
    if (inherit && inherit.checked) continue;
    out[input.dataset.key] = Number(input.value);
  }
  return Object.keys(out).length ? out : undefined;
}

function setOverride(key, value) {
  const inherit = recSettingsFields.querySelector(`input[data-inherit-for="${key}"]`);
  inherit.checked = false;
  inherit.dispatchEvent(new dom.window.Event('change'));
  recSettingsFields.querySelector(`input[data-key="${key}"]`).value = String(value);
}

const globals = { ...DEFAULT_SETTINGS };

// --- 1. 設定なしの録画: 全項目が継承、保存しても undefined ---
renderRecSettings({}, globals);
const boxes = [...recSettingsFields.querySelectorAll('input[data-inherit-for]')];
assert.equal(boxes.length, SETTING_FIELDS.length);
assert.ok(boxes.every((b) => b.checked), '既定では全項目が「全体設定に従う」');
assert.ok(
  [...recSettingsFields.querySelectorAll('input[data-key]')].every((i) => i.disabled),
  '継承中の入力欄は編集不可'
);
assert.equal(collectRecSettings(), undefined, '何も上書きしなければ settings は付けない');
console.log('OK: recording without settings inherits everything');

// --- 2. 1項目だけ上書き ---
setOverride('pageLoadTimeoutMs', 180000);
const one = collectRecSettings();
assert.deepEqual(one, { pageLoadTimeoutMs: 180000 }, '上書きした項目だけが保存される');
console.log('OK: only the overridden field is saved');

// 実効値: 上書きした項目だけ変わり、他は全体設定のまま
const eff = effectiveSettings(globals, { settings: one });
assert.equal(eff.pageLoadTimeoutMs, 180000);
assert.equal(eff.elementTimeoutMs, globals.elementTimeoutMs);
assert.equal(eff.stepIntervalMs, globals.stepIntervalMs);
console.log('OK: effective settings apply the override and inherit the rest');

// --- 3. 上書きのある録画を開き直すと、その値が復元される ---
renderRecSettings({ settings: { pageLoadTimeoutMs: 180000 } }, globals);
const pageBox = recSettingsFields.querySelector('input[data-inherit-for="pageLoadTimeoutMs"]');
const pageInput = recSettingsFields.querySelector('input[data-key="pageLoadTimeoutMs"]');
assert.equal(pageBox.checked, false, '上書き済みの項目はチェックが外れて表示される');
assert.equal(pageInput.disabled, false);
assert.equal(pageInput.value, '180000');
const elemBox = recSettingsFields.querySelector('input[data-inherit-for="elementTimeoutMs"]');
assert.equal(elemBox.checked, true, '上書きしていない項目は継承のまま');
console.log('OK: reopening shows overrides checked-off with their values');

// --- 4. 継承に戻すと全体設定の値が表示され、保存対象から外れる ---
pageBox.checked = true;
pageBox.dispatchEvent(new dom.window.Event('change'));
assert.equal(pageInput.disabled, true);
assert.equal(pageInput.value, String(globals.pageLoadTimeoutMs), '継承に戻すと全体設定の値が入る');
assert.equal(collectRecSettings(), undefined);
console.log('OK: re-checking inherit clears the override');

// --- 5. 複数項目の上書き ---
renderRecSettings({}, globals);
setOverride('pageLoadTimeoutMs', 120000);
setOverride('stepIntervalMs', 1000);
assert.deepEqual(collectRecSettings(), { pageLoadTimeoutMs: 120000, stepIntervalMs: 1000 });
console.log('OK: multiple overrides');

// --- 6. 録画側の異常値は effectiveSettings 側でクランプされる ---
const clamped = effectiveSettings(globals, { settings: { pageLoadTimeoutMs: 99999999 } });
assert.equal(clamped.pageLoadTimeoutMs, 600000);
console.log('OK: out-of-range per-recording value is clamped at replay time');

// --- 7. 全体設定を変えると、継承している項目に追従する ---
const raisedGlobals = { ...DEFAULT_SETTINGS, elementTimeoutMs: 30000 };
const eff2 = effectiveSettings(raisedGlobals, { settings: { pageLoadTimeoutMs: 120000 } });
assert.equal(eff2.elementTimeoutMs, 30000, '継承項目は新しい全体設定に追従する');
assert.equal(eff2.pageLoadTimeoutMs, 120000, '上書き項目は影響を受けない');
console.log('OK: inherited fields follow later changes to global settings');

console.log('\nALL PER-RECORDING SETTINGS CHECKS PASSED');
