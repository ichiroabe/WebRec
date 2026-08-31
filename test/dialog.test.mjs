// ブラウザが出す alert / confirm / prompt を、記録して再生で再現できることを検証する。
//
// 押した結果はステップとして残り（種類・文言・応答）、再生時は
// ダイアログを出さずにその応答をその場で返す、という往復を確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { srcUrl, srcPath } from './helpers/src.mjs';

const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;

const { parseRecordingJson, generateJson, generatePlaywright, generatePuppeteer, stepSummary } = await import(
  srcUrl('generator.js')
);
const { validateRecording } = await import(srcUrl('validate.js'));
const { resolveStepTemplates } = await import(srcUrl('template.js'));

const rec = {
  name: 'ダイアログ一式',
  startUrl: 'https://example.com/',
  createdAt: 1,
  steps: [
    { type: 'click', selector: '#delete', text: '削除' },
    { type: 'dialog', kind: 'confirm', message: '本当に削除しますか？', answer: false },
    { type: 'click', selector: '#delete', text: '削除' },
    { type: 'dialog', kind: 'confirm', message: '本当に削除しますか？', answer: true },
    { type: 'dialog', kind: 'alert', message: '削除しました', answer: null },
    { type: 'click', selector: '#rename' },
    { type: 'dialog', kind: 'prompt', message: '新しい名前', answer: '山田太郎' },
    { type: 'click', selector: '#rename' },
    { type: 'dialog', kind: 'prompt', message: '新しい名前', answer: null },
  ],
};

// --- JSON 往復と検証 ---
const parsed = parseRecordingJson(generateJson(rec));
assert.equal(parsed.steps.length, rec.steps.length);
assert.equal(parsed.steps[1].answer, false, 'キャンセルが false のまま残る');
assert.equal(parsed.steps[8].answer, null, 'prompt のキャンセルが null のまま残る');
assert.deepEqual(validateRecording(rec).issues, [], JSON.stringify(validateRecording(rec).issues));
console.log('OK: dialog steps round-trip through JSON and validate cleanly');

// --- 不正な形は弾く ---
const bad = [
  ['{"startUrl":"https://a/","steps":[{"type":"dialog","kind":"toast","message":"x"}]}', /alert \/ confirm \/ prompt/],
  ['{"startUrl":"https://a/","steps":[{"type":"dialog","kind":"confirm","answer":"yes"}]}', /true\(OK\)/],
  ['{"startUrl":"https://a/","steps":[{"type":"dialog","kind":"prompt","answer":5}]}', /null/],
];
for (const [input, pattern] of bad) assert.throws(() => parseRecordingJson(input), pattern);
console.log(`OK: ${bad.length} malformed dialog shapes are rejected`);

// validateRecording も同じ食い違いを拾う（DB から読んだ録画は parse を通らないため）
const kindIssue = validateRecording({ steps: [{ type: 'dialog', kind: 'toast' }] });
assert.equal(kindIssue.errors.length, 1, '種類の誤りをエラーにする');

// --- 一覧の表示: 何にどう答えたかが読めること ---
const summaries = rec.steps.map(stepSummary);
console.log('\n--- ステップ一覧の表示 ---');
summaries.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
assert.match(summaries[1], /confirm「本当に削除しますか？」で キャンセル/);
assert.match(summaries[3], /confirm「本当に削除しますか？」で OK/);
assert.match(summaries[4], /alert「削除しました」を閉じる/);
assert.match(summaries[6], /prompt「新しい名前」に "山田太郎" と入力/);
assert.match(summaries[8], /prompt「新しい名前」でキャンセル/);

// 長い文言でも一覧が崩れないよう頭だけ見せる
const long = stepSummary({ type: 'dialog', kind: 'alert', message: 'あ'.repeat(100) });
assert.ok(long.includes('…') && long.length < 80, `長い文言が切り詰められる: ${long}`);
console.log('\nOK: summaries say which dialog was answered and how');

// --- 書き出し: 応答は、それを出す操作より前に登録されていること ---
for (const [label, code] of [
  ['Playwright', generatePlaywright(rec)],
  ['Puppeteer', generatePuppeteer(rec)],
]) {
  const lines = code.split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  const dismiss = at(/page\.once\('dialog', \(d\) => d\.dismiss\(\)\)/);
  const firstClick = at(/#delete/);
  assert.notEqual(dismiss, -1, `${label}: dismiss の登録が無い`);
  assert.ok(dismiss < firstClick, `${label}: 応答の登録がクリックより後にある`);
  assert.ok(code.includes('d.accept("山田太郎")'), `${label}: prompt の入力値が渡っていない`);
  // dialog ステップ自体からは操作が出ない（応答は上で登録済み）
  assert.ok(!code.includes('未対応のステップ: dialog'), `${label}: dialog が未対応扱いになっている`);
}
console.log('OK: generated scripts register the answer before the action that opens the dialog');

// --- prompt への応答にもテンプレートが効く ---
const resolved = resolveStepTemplates(
  { type: 'dialog', kind: 'prompt', answer: '{{data.名前}} さん' },
  { data: { 名前: '田中' } }
);
assert.equal(resolved.answer, '田中 さん');
console.log('OK: prompt answers accept {{data.列名}} like other input values');

// --- 再生側の差し替え: 記録した応答を順番に返すこと ---
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
const install = new Function(
  'window',
  'queue',
  `${extractFunction(bgSrc, 'installDialogStubs')}\ninstallDialogStubs(queue);`
);

// 記録した応答（クリック2回ぶん）を仕込んで、出る順に返るか見る
const w = {};
install(w, [
  { kind: 'confirm', answer: false },
  { kind: 'confirm', answer: true },
  { kind: 'alert', answer: null },
  { kind: 'prompt', answer: '山田太郎' },
  { kind: 'prompt', answer: null },
]);
assert.equal(w.confirm('本当に削除しますか？'), false, '1回目はキャンセル');
assert.equal(w.confirm('本当に削除しますか？'), true, '2回目は OK');
w.alert('削除しました');
assert.equal(w.prompt('新しい名前', '既定値'), '山田太郎', '記録した入力が返る');
assert.equal(w.prompt('新しい名前', '既定値'), null, 'キャンセルは null が返る');
assert.deepEqual(
  w.__webrecDialogs.map((d) => [d.kind, d.answer, d.planned]),
  [
    ['confirm', false, true],
    ['confirm', true, true],
    ['alert', null, true],
    ['prompt', '山田太郎', true],
    ['prompt', null, true],
  ],
  '実行ログにも同じ応答が残る'
);
console.log('OK: replay returns the recorded answers, in order');

// 記録に無いダイアログが出たら、従来どおりの既定の応答で通す
const w2 = {};
install(w2, []);
assert.equal(w2.confirm('想定外'), true, '記録が無い confirm は OK 扱い');
assert.equal(w2.prompt('想定外', '初期値'), '初期値', '記録が無い prompt は初期値を返す');
assert.deepEqual(w2.__webrecDialogs.map((d) => d.planned), [false, false], '記録どおりでないことが残る');

// 種類が食い違ったら消費せず、後続のためにとっておく
const w3 = {};
install(w3, [{ kind: 'prompt', answer: '控えていた入力' }]);
assert.equal(w3.confirm('先に別のダイアログが出た'), true, 'confirm は既定の応答で通す');
assert.equal(w3.prompt('本来の prompt', ''), '控えていた入力', '記録した応答は残っている');
console.log('OK: a dialog that was not recorded falls back without eating the queue');

// --- 記録側の差し替え: 本物を出したうえで、押した結果を流すこと ---
const installRecorder = new Function(
  'window',
  `${extractFunction(bgSrc, 'installDialogRecorder')}\ninstallDialogRecorder();`
);

const asked = [];
const posted = [];
const w4 = {
  alert: (m) => asked.push(['alert', m]),
  confirm: (m) => (asked.push(['confirm', m]), false), // 利用者が「キャンセル」を押す
  prompt: (m, d) => (asked.push(['prompt', m, d]), '山田太郎'),
  postMessage: (data) => posted.push(data),
};
installRecorder(w4);

w4.alert('削除しました');
assert.equal(w4.confirm('本当に削除しますか？'), false, '本物の応答がページへ返る');
assert.equal(w4.prompt('新しい名前', '既定値'), '山田太郎');
assert.deepEqual(
  asked,
  [
    ['alert', '削除しました'],
    ['confirm', '本当に削除しますか？'],
    ['prompt', '新しい名前', '既定値'],
  ],
  '本物のダイアログはそのまま出る（記録中は利用者が自分で答える）'
);
assert.deepEqual(
  posted.map((p) => [p.__webrec, p.kind, p.message, p.answer]),
  [
    ['dialog', 'alert', '削除しました', null],
    ['dialog', 'confirm', '本当に削除しますか？', false],
    ['dialog', 'prompt', '新しい名前', '山田太郎'],
  ],
  '押した結果がステップの元として流れる'
);

// 入れ直しても二重に包まない（遷移のたびに注入し直すため）
installRecorder(w4);
w4.confirm('もう一度');
assert.equal(posted.length, 4, '1回の操作で1件だけ流れる');

// 記録が終わったら本物に戻す
const restore = new Function('window', `${extractFunction(bgSrc, 'uninstallDialogHooks')}\nuninstallDialogHooks();`);
restore(w4);
w4.confirm('記録の後');
assert.equal(posted.length, 4, '記録を止めた後は何も流れない');
console.log('OK: recording keeps the real dialog and reports the answer the user gave');

// --- 応答の先取り: 操作の直後に続く dialog ステップだけを拾うこと ---
const { resolveStepTemplates: rst, resolveStepTotp: rstt } = await import(srcUrl('template.js'));
const plannedDialogs = new Function(
  'resolveStepTemplates',
  'resolveStepTotp',
  // 取り出した本体は async が落ちるので付け直す
  `async ${extractFunction(bgSrc, 'plannedDialogs')}\nreturn plannedDialogs;`
)(rst, rstt);

const planned = await plannedDialogs(rec.steps, 2, {}); // 2 番目のクリックの後
assert.deepEqual(planned, [
  { kind: 'confirm', answer: true },
  { kind: 'alert', answer: null },
], '続けて出る2件をまとめて仕込む');
assert.deepEqual(await plannedDialogs(rec.steps, 0, {}), [{ kind: 'confirm', answer: false }]);
assert.deepEqual(await plannedDialogs(rec.steps, 1, {}), [], '次の操作までしか見ない');

// 無効化した応答は使わず、ブラウザの既定に任せる
const withDisabled = [
  { type: 'click', selector: '#x' },
  { type: 'dialog', kind: 'confirm', message: 'a', answer: false, disabled: true },
  { type: 'dialog', kind: 'alert', message: 'b', answer: null },
];
assert.deepEqual(await plannedDialogs(withDisabled, 0, {}), [{ kind: 'alert', answer: null }]);

// prompt の応答にもデータ列が効く
const templated = [
  { type: 'click', selector: '#x' },
  { type: 'dialog', kind: 'prompt', message: '名前', answer: '{{data.名前}}' },
];
assert.deepEqual(await plannedDialogs(templated, 0, { data: { 名前: '田中' } }), [
  { kind: 'prompt', answer: '田中' },
]);
console.log('OK: answers are armed for the action that opens them, before it runs');
