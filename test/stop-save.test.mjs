// 記録の停止と保存の関係を確かめる。
// 「停止できたのに管理画面には何も無い」= 記録が消える事故を防ぐのが目的なので、
// 保存が失敗したときにセッションを捨てていないことまで見る。
//
// background.js は何も export しない service worker なので、
// chrome API を差し替えて onMessage 経由で動かす。
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

// --- chrome API の最小限のモック ---
const localStore = {};
const sessionStore = {};
const openTabs = new Map([[1, { id: 1, url: 'https://example.test/' }]]);
const listeners = { message: [], created: [], removed: [] };

function area(store) {
  return {
    async get(key) {
      if (key == null) return { ...store };
      return key in store ? { [key]: store[key] } : {};
    },
    async set(obj) {
      // storage は構造化複製で往復するので、参照を共有しない
      Object.assign(store, JSON.parse(JSON.stringify(obj)));
    },
    async remove(key) {
      delete store[key];
    },
  };
}

const noopEvent = () => ({ addListener() {} });

globalThis.chrome = {
  storage: { local: area(localStore), session: area(sessionStore) },
  i18n: { getUILanguage: () => 'ja' },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  scripting: { async executeScript() {} },
  webNavigation: { onCommitted: noopEvent(), onHistoryStateUpdated: noopEvent() },
  windows: { async create() {}, async update() {} },
  tabs: {
    async get(id) {
      if (!openTabs.has(id)) throw new Error('No tab with id: ' + id);
      return openTabs.get(id);
    },
    async query() {
      return [...openTabs.values()];
    },
    async update() {},
    async sendMessage(tabId, msg) {
      if (!openTabs.has(tabId)) throw new Error('no tab');
      return msg.type === 'WEBREC_PING' ? { ok: true } : undefined;
    },
    onCreated: { addListener: (fn) => listeners.created.push(fn) },
    onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onConnect: noopEvent(),
    onStartup: noopEvent(),
    onInstalled: noopEvent(),
  },
  // alarms は載せない（無くても動くことの確認も兼ねる）
};

await import(srcUrl('background.js'));
const { getAllRecordings } = await import(srcUrl('db.js'));

// onMessage は sendResponse で返すので、promise に均す
function send(message, tabId = 1) {
  return new Promise((resolve) => {
    listeners.message[0](message, { tab: openTabs.get(tabId) || { id: tabId } }, resolve);
  });
}

async function main() {
  // --- 記録して停止すると保存される ---
  const started = await send({ type: 'START_RECORDING', tabId: 1, startUrl: 'https://example.test/', name: 'テスト録画' });
  assert.equal(started.ok, true, '記録を開始できる');

  await send({ type: 'RECORD_EVENT', step: { type: 'click', selector: '#a' } });
  await send({ type: 'RECORD_EVENT', step: { type: 'input', selector: '#b', value: 'x' } });
  assert.equal((await send({ type: 'GET_STATE', tabId: 1 })).stepCount, 2);
  console.log('OK: events are collected while recording');

  const stopped = await send({ type: 'STOP_RECORDING' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stepCount, 2);
  assert.equal((await getAllRecordings()).length, 1, '管理画面から見える形で残っている');
  assert.equal((await send({ type: 'GET_STATE', tabId: 1 })).isRecording, false);
  console.log('OK: stopping saves the recording and clears the session');

  // --- 保存に失敗したらセッションを捨てない ---
  await send({ type: 'START_RECORDING', tabId: 1, startUrl: 'https://example.test/2', name: '保存失敗' });
  await send({ type: 'RECORD_EVENT', step: { type: 'click', selector: '#c' } });

  const realPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () {
    throw new Error('boom');
  };
  const failed = await send({ type: 'STOP_RECORDING' });
  IDBObjectStore.prototype.put = realPut;

  assert.equal(failed.ok, false, '保存できなければ停止も失敗として返す');
  assert.match(failed.error, /boom/, '理由が利用者に届く');
  assert.equal((await getAllRecordings()).length, 1, '壊れた録画は増えていない');

  const stillOn = await send({ type: 'GET_STATE', tabId: 1 });
  assert.equal(stillOn.isRecording, true, '記録は残ったまま。捨てられていない');
  assert.equal(stillOn.stepCount, 1);
  console.log('OK: a failed save keeps the session instead of losing the recording');

  // --- 押し直せばやり直せる ---
  const retried = await send({ type: 'STOP_RECORDING' });
  assert.equal(retried.ok, true);
  assert.equal((await getAllRecordings()).length, 2, 'やり直しで保存される');
  console.log('OK: stopping again after a failure saves the recording');

  // --- 記録元のタブが消えたら、次に状態を聞かれたときに締める ---
  await send({ type: 'START_RECORDING', tabId: 1, startUrl: 'https://example.test/3', name: 'タブ消失' });
  await send({ type: 'RECORD_EVENT', step: { type: 'click', selector: '#d' } });
  openTabs.delete(1); // onRemoved を取りこぼした状況（service worker が止まっていた等）

  const afterGone = await send({ type: 'GET_STATE', tabId: 9 });
  assert.equal(afterGone.isRecording, false, '開始ボタンが二度と押せない状態にならない');
  const saved = (await getAllRecordings()).find((r) => r.name === 'タブ消失');
  assert.ok(saved, 'そこまでの記録は捨てずに保存される');
  assert.equal(saved.steps.length, 1);
  console.log('OK: a session whose tab is gone is closed out instead of blocking new recordings');

  console.log('\nALL STOP/SAVE CHECKS PASSED');
}

await main();
