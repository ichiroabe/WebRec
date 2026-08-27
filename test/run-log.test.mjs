// プルで入った実行ログ（runs ストア / DB v3）のテスト
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { srcUrl } from './helpers/src.mjs';

const db = await import(srcUrl('db.js'));
const { saveRun, getRun, getAllRuns, deleteRun, clearRuns, pruneRuns, saveRecording, getAllRecordings } = db;

const mkRun = (over = {}) => ({
  id: crypto.randomUUID(),
  recordingId: 'rec-1',
  name: 'テスト録画',
  startedAt: Date.now(),
  finishedAt: Date.now() + 1000,
  trigger: 'manual',
  status: 'done',
  steps: [],
  ...over,
});

// --- 保存と取得 ---
const run = mkRun();
await saveRun(run);
const got = await getRun(run.id);
assert.equal(got.name, 'テスト録画');
assert.equal(got.trigger, 'manual');
console.log('OK: a run is saved and read back');

// --- 新しい順に並ぶ ---
await clearRuns();
const base = Date.now();
await saveRun(mkRun({ name: '古い', startedAt: base - 10000 }));
await saveRun(mkRun({ name: '新しい', startedAt: base + 10000 }));
await saveRun(mkRun({ name: '中間', startedAt: base }));
const sorted = await getAllRuns();
assert.deepEqual(sorted.map((r) => r.name), ['新しい', '中間', '古い']);
console.log('OK: runs come back newest first');

// --- 再生中の逐次上書き（同じ id で put する）---
await clearRuns();
const live = mkRun({ status: 'running', steps: [] });
await saveRun(live);
live.steps.push({ index: 0, status: 'done' });
await saveRun(live);
live.status = 'failed';
live.steps.push({ index: 1, status: 'error', error: 'だめ' });
await saveRun(live);
const after = await getAllRuns();
assert.equal(after.length, 1, '同じ id なら増えない');
assert.equal(after[0].status, 'failed');
assert.equal(after[0].steps.length, 2, '途中経過が残る');
console.log('OK: a run is updated in place while replaying (progress survives)');

// --- 削除 ---
await deleteRun(after[0].id);
assert.equal((await getAllRuns()).length, 0);
console.log('OK: deleteRun / clearRuns');

// --- 件数の間引き ---
await clearRuns();
for (let i = 0; i < 105; i++) await saveRun(mkRun({ name: `run-${i}`, startedAt: base + i }));
assert.equal((await getAllRuns()).length, 105);
const pruned = await pruneRuns();
const left = await getAllRuns();
assert.equal(left.length, 100, '100件に収まる');
assert.equal(pruned, 5);
assert.equal(left[0].name, 'run-104', '新しいものが残る');
assert.ok(!left.some((r) => r.name === 'run-0'), '古いものから消える');
console.log('OK: pruneRuns keeps the newest 100 and drops the rest');

// --- 録画ストアと同居できる（DB v3 への移行）---
await saveRecording({ id: 'rec-1', name: 'r', startUrl: 'https://a/', steps: [], createdAt: 1 });
assert.equal((await getAllRecordings()).length, 1, '録画は無事');
assert.equal((await getAllRuns()).length, 100, '実行ログも無事');
console.log('OK: recordings and runs coexist in the upgraded database');

console.log('\nALL RUN-LOG CHECKS PASSED');
