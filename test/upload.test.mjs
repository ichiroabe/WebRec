import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { srcUrl } from './helpers/src.mjs';

const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;
// atob / TextEncoder は Node 標準のものをそのまま使う
// （dom.window.atob を取り出して代入すると this が外れて動かない）

const { validateRecording } = await import(srcUrl('validate.js'));
const { parseRecordingJson, generateJson, generatePlaywright, generatePuppeteer, stepSummary } = await import(
  srcUrl('generator.js')
);

// --- data URL <-> バイト列の往復（再生時に同じファイルが再現できるか） ---
// background.js の dataUrlToFile と同じロジック
function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (meta.includes(';base64')) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

// テキスト（日本語込み）
const text = 'テスト内容\nline2\t"quoted",comma';
const textBytes = new TextEncoder().encode(text);
const textDataUrl = 'data:text/plain;base64,' + Buffer.from(textBytes).toString('base64');
assert.deepEqual([...dataUrlToBytes(textDataUrl)], [...textBytes], 'UTF-8 テキストが1バイトも変わらない');
console.log('OK: UTF-8 text survives the data-URL round trip byte-for-byte');

// バイナリ（全256バイトパターン + PDF/PNG のマジックバイト）
const binary = new Uint8Array(256 + 8);
for (let i = 0; i < 256; i++) binary[i] = i;
binary.set([0x89, 0x50, 0x4e, 0x47, 0x25, 0x50, 0x44, 0x46], 256);
const binDataUrl = 'data:application/octet-stream;base64,' + Buffer.from(binary).toString('base64');
assert.deepEqual([...dataUrlToBytes(binDataUrl)], [...binary], 'バイナリが壊れない');
console.log('OK: binary (all 256 byte values) survives intact');

// base64 でない data URL も扱える
const plainUrl = 'data:text/plain,' + encodeURIComponent('hello 日本語');
assert.equal(new TextDecoder().decode(dataUrlToBytes(plainUrl)), 'hello 日本語');
console.log('OK: non-base64 data URLs are handled');

// --- ステップの表示 ---
assert.equal(
  stepSummary({ type: 'upload', selector: '#f', files: [{ name: 'a.pdf' }, { name: 'b.png' }] }),
  'ファイル選択: #f = a.pdf, b.png'
);
assert.equal(stepSummary({ type: 'upload', selector: '#f', files: [] }), 'ファイル選択を解除: #f');
assert.match(
  stepSummary({ type: 'upload', selector: '#f', files: [{ name: 'big.zip', omitted: 'too-large' }] }),
  /中身なし/
);
console.log('OK: upload step summaries');

// --- JSON 検証 ---
const rec = {
  name: 'アップロードテスト',
  startUrl: 'http://127.0.0.1:8791/complex.html',
  createdAt: 1700000000000,
  steps: [
    { type: 'upload', selector: '#singleFile', files: [{ fileId: 'f1', name: '請求書.pdf', mimeType: 'application/pdf', size: 1234 }] },
    { type: 'upload', selector: '#multiFile', files: [{ fileId: 'f2', name: 'a.csv', size: 10 }, { fileId: 'f3', name: 'b.csv', size: 20 }] },
    { type: 'click', selector: '#submitBtn' },
  ],
};

const parsed = parseRecordingJson(generateJson(rec));
assert.equal(parsed.steps[0].files[0].name, '請求書.pdf', 'upload が JSON 往復で保たれる');
console.log('OK: upload steps survive the JSON round trip');

// files が無い / 壊れている upload は弾く
assert.throws(() => parseRecordingJson('{"startUrl":"http://a/","steps":[{"type":"upload","selector":"#f"}]}'), /files は配列/);
assert.throws(
  () => parseRecordingJson('{"startUrl":"http://a/","steps":[{"type":"upload","selector":"#f","files":[{}]}]}'),
  /name がありません/
);
console.log('OK: malformed upload steps are rejected with a specific message');

// --- 整合性チェック ---
let v = validateRecording(rec);
assert.deepEqual(v.issues, [], `正常な upload で指摘が出ないこと: ${JSON.stringify(v.issues)}`);

v = validateRecording({
  ...rec,
  steps: [{ type: 'upload', selector: '#f', files: [{ name: 'big.zip', omitted: 'too-large' }] }],
});
assert.ok(v.errors.some((e) => e.code === 'upload-too-large'));
assert.match(v.errors[0].message, /8MBまで/);

v = validateRecording({ ...rec, steps: [{ type: 'upload', selector: '#f', files: [{ name: 'x.txt' }] }] });
assert.ok(v.errors.some((e) => e.code === 'upload-missing'), '中身が無い参照はエラー');
console.log('OK: validation flags oversized and content-less uploads');

// --- 生成スクリプト ---
const pw = generatePlaywright(rec);
console.log('\n=== Playwright ===\n' + pw);
assert.match(pw, /実行前に用意するファイル/, '必要なファイルを案内する');
assert.match(pw, /files\/請求書\.pdf/);
assert.match(pw, /setInputFiles\(\["\.\/files\/請求書\.pdf"\]\)/);
assert.match(pw, /setInputFiles\(\["\.\/files\/a\.csv","\.\/files\/b\.csv"\]\)/, '複数ファイル');
console.log('OK: playwright emits setInputFiles and a fixture-file notice');

const pp = generatePuppeteer(rec);
assert.match(pp, /uploadFile\("\.\/files\/請求書\.pdf"\)/);
assert.match(pp, /uploadFile\("\.\/files\/a\.csv", "\.\/files\/b\.csv"\)/);
console.log('OK: puppeteer emits uploadFile');

// アップロードが無い録画には案内を出さない
const plain = { name: 'x', startUrl: 'http://a/', steps: [{ type: 'click', selector: '#a' }] };
assert.ok(!generatePlaywright(plain).includes('実行前に用意するファイル'));
console.log('OK: recordings without uploads are unchanged');

console.log('\nALL UPLOAD CHECKS PASSED');
