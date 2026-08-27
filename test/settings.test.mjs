import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

// chrome.storage.local の最小スタブ（settings.js は import 時ではなく呼び出し時に触る）
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

const { getSettings, saveSettings, resetSettings, effectiveSettings, DEFAULT_SETTINGS } = await import(
  srcUrl('settings.js')
);

// 未設定なら既定値
assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
console.log('OK: defaults when nothing stored');

// 保存と読み出し
await saveSettings({ pageLoadTimeoutMs: 120000 });
assert.equal((await getSettings()).pageLoadTimeoutMs, 120000);
assert.equal((await getSettings()).elementTimeoutMs, DEFAULT_SETTINGS.elementTimeoutMs, '他の値は既定のまま');
console.log('OK: save/read a single field without disturbing others');

// 範囲外はクランプされる
await saveSettings({ pageLoadTimeoutMs: 99999999, stepIntervalMs: -500, injectRetries: 999 });
const clamped = await getSettings();
assert.equal(clamped.pageLoadTimeoutMs, 600000);
assert.equal(clamped.stepIntervalMs, 0);
assert.equal(clamped.injectRetries, 10);
console.log('OK: out-of-range values are clamped, not stored raw');

// 不正な型は無視され既定値に落ちる
await resetSettings();
await saveSettings({ pageLoadTimeoutMs: 'abc' });
assert.equal((await getSettings()).pageLoadTimeoutMs, DEFAULT_SETTINGS.pageLoadTimeoutMs);
console.log('OK: non-numeric input falls back to default');

// リセット
await saveSettings({ elementTimeoutMs: 30000 });
assert.deepEqual(await resetSettings(), DEFAULT_SETTINGS);
assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
console.log('OK: reset restores defaults');

// 録画ごとの設定がグローバルを上書きする
const global = await getSettings();
const eff = effectiveSettings(global, { settings: { pageLoadTimeoutMs: 300000 } });
assert.equal(eff.pageLoadTimeoutMs, 300000, '録画側が優先される');
assert.equal(eff.elementTimeoutMs, global.elementTimeoutMs, '指定のない項目はグローバル値');
console.log('OK: per-recording settings override globals, others inherit');

// 録画側の異常値もクランプされる
const effBad = effectiveSettings(global, { settings: { pageLoadTimeoutMs: 99999999 } });
assert.equal(effBad.pageLoadTimeoutMs, 600000);
console.log('OK: per-recording values are clamped too');

// settings が無い録画でも壊れない
assert.deepEqual(effectiveSettings(global, {}), global);
assert.deepEqual(effectiveSettings(global, null), global);
console.log('OK: recordings without settings are safe');

console.log('\nALL SETTINGS CHECKS PASSED');
