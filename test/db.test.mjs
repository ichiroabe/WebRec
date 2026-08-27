import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { srcUrl } from './helpers/src.mjs';

const { saveRecording, getRecording, getAllRecordings, updateRecording, deleteRecording } = await import(srcUrl('db.js'));
const { generatePlaywright, generatePuppeteer, generateJson, stepSummary } = await import(srcUrl('generator.js'));

// Node lacks crypto.randomUUID on `self`/global in some setups but has it on globalThis.crypto in modern node
const uuid = () => globalThis.crypto.randomUUID();

const sample = {
  id: uuid(),
  name: 'サンプル録画',
  startUrl: 'http://127.0.0.1:8791/page1.html',
  createdAt: Date.now(),
  steps: [
    { type: 'click', selector: '#myButton', tag: 'button', text: 'Click Me', timestamp: Date.now() },
    { type: 'input', selector: '#myInput', value: 'hello world', timestamp: Date.now() },
    { type: 'select', selector: '#mySelect', value: 'b', timestamp: Date.now() },
    { type: 'keydown', selector: '#enterField', key: 'Enter', timestamp: Date.now() },
    { type: 'navigate', url: 'http://127.0.0.1:8791/page2.html', timestamp: Date.now() },
  ],
};

async function main() {
  // --- db.js round trip ---
  await saveRecording(sample);
  const fetched = await getRecording(sample.id);
  assert.equal(fetched.name, 'サンプル録画');
  assert.equal(fetched.steps.length, 5);
  console.log('OK: saveRecording/getRecording round-trip');

  const all = await getAllRecordings();
  assert.equal(all.length, 1);
  console.log('OK: getAllRecordings returns 1 record');

  const updated = await updateRecording(sample.id, { name: 'リネーム後' });
  assert.equal(updated.name, 'リネーム後');
  const refetched = await getRecording(sample.id);
  assert.equal(refetched.name, 'リネーム後');
  console.log('OK: updateRecording persists change');

  // sort order check: add a second, older record and a newer one
  await saveRecording({ ...sample, id: uuid(), name: '古い', createdAt: Date.now() - 100000 });
  await saveRecording({ ...sample, id: uuid(), name: '新しい', createdAt: Date.now() + 100000 });
  const sorted = await getAllRecordings();
  assert.equal(sorted[0].name, '新しい');
  assert.equal(sorted[sorted.length - 1].name, '古い');
  console.log('OK: getAllRecordings sorted by createdAt desc');

  await deleteRecording(sample.id);
  const afterDelete = await getRecording(sample.id);
  assert.equal(afterDelete, undefined);
  console.log('OK: deleteRecording removes record');

  // --- generator.js output checks ---
  const pw = generatePlaywright(fetched);
  assert.match(pw, /page\.goto\("http:\/\/127\.0\.0\.1:8791\/page1\.html"\)/);
  assert.match(pw, /page\.locator\("#myButton"\)\.click\(\)/);
  assert.match(pw, /page\.locator\("#myInput"\)\.fill\("hello world"\)/);
  assert.match(pw, /page\.locator\("#mySelect"\)\.selectOption\("b"\)/);
  assert.match(pw, /page\.locator\("#enterField"\)\.press\("Enter"\)/);
  // navigate ステップは実際に遷移させる（旧: waitForURL で待つだけ）
  assert.match(pw, /await page\.goto\("http:\/\/127\.0\.0\.1:8791\/page2\.html"\)/);
  console.log('OK: generatePlaywright contains expected calls');
  console.log('--- playwright output ---\n' + pw);

  const pp = generatePuppeteer(fetched);
  assert.match(pp, /page\.goto\("http:\/\/127\.0\.0\.1:8791\/page1\.html"\)/);
  assert.match(pp, /page\.click\("#myButton"\)/);
  assert.match(pp, /page\.type\("#myInput", "hello world"\)/);
  assert.match(pp, /page\.select\("#mySelect", "b"\)/);
  assert.match(pp, /page\.keyboard\.press\("Enter"\)/);
  console.log('OK: generatePuppeteer contains expected calls');

  const json = generateJson(fetched);
  const parsed = JSON.parse(json);
  assert.equal(parsed.steps.length, 5);
  console.log('OK: generateJson round-trips as valid JSON');

  const summaries = fetched.steps.map(stepSummary);
  console.log('step summaries:', summaries);
  assert.ok(summaries[0].includes('クリック'));
  assert.ok(summaries[1].includes('hello world'));

  // --- password masking is applied by content.js before it ever reaches here;
  // verify generator doesn't choke on that placeholder value ---
  const pwStep = { type: 'input', selector: '#pw', value: '<PASSWORD>', timestamp: Date.now() };
  const withPw = { ...fetched, steps: [pwStep] };
  assert.match(generatePlaywright(withPw), /\.fill\("<PASSWORD>"\)/);

  console.log('\nALL UNIT CHECKS PASSED');
}

main().catch((e) => {
  console.error('UNIT TEST FAILED:', e);
  process.exit(1);
});
