import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { srcUrl, srcPath } from './helpers/src.mjs';

// 生成コードは CommonJS の require を使うので、評価時に渡してやる
const nodeRequire = createRequire(import.meta.url);

const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;

const { validateRecording } = await import(srcUrl('validate.js'));
const { generatePlaywright, generatePuppeteer } = await import(srcUrl('generator.js'));
const { base32Decode } = await import(srcUrl('template.js'));

// --- content.js の OTP 判定ロジックを取り出して検証する ---
// content.js の並びが変わっても壊れないよう、必要な定義だけを名指しで取り出す
const contentSrc = readFileSync(srcPath('content.js'), 'utf8');

function extractFunction(src, name) {
  const head = src.indexOf(`function ${name}(`);
  assert.notEqual(head, -1, `${name} が content.js に見つからない`);
  let depth = 0;
  for (let i = src.indexOf('{', head); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(head, i + 1);
  }
  throw new Error(`${name} の終わりが見つからない`);
}

const constLines = contentSrc
  .split('\n')
  .filter((l) => /^\s*const OTP_HINT(_JA)? =/.test(l))
  .join('\n');
assert.match(constLines, /OTP_HINT_JA/, 'OTP の判定パターンが取り出せていない');

const detectSrc = `${constLines}\n${extractFunction(contentSrc, 'isOneTimeCodeField')}`;
const isOneTimeCodeField = new Function('el', `${detectSrc}\nreturn isOneTimeCodeField(el);`);

const makeEl = (attrs) => {
  const el = dom.window.document.createElement('input');
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'id') el.id = v;
    else el.setAttribute(k, v);
  }
  return el;
};

// 検出されるべきもの
for (const attrs of [
  { autocomplete: 'one-time-code' },
  { autocomplete: 'ONE-TIME-CODE' },
  { name: 'otp' },
  { name: 'otpCode' },
  { id: 'totp_input' },
  { name: 'mfa_code' },
  { name: '2fa' },
  { placeholder: 'One-Time Password' },
  { placeholder: 'ワンタイムパスワード' },
  { 'aria-label': '認証コード' },
  { placeholder: '確認コードを入力' },
  { name: 'verification-code' },
  { name: 'authCode' },
  { 'data-testid': 'otp-field' },
]) {
  assert.ok(isOneTimeCodeField(makeEl(attrs)), `検出されるべき: ${JSON.stringify(attrs)}`);
}
console.log('OK: OTP fields are detected (autocomplete, name/id/placeholder/aria-label, ja and en)');

// 誤検出してはいけないもの
for (const attrs of [
  { name: 'username' },
  { name: 'email' },
  { id: 'zipcode' },
  { placeholder: '郵便番号' },
  { name: 'promoCode' },
  { name: 'couponCode' },
  { name: 'countryCode' },
  { placeholder: '商品コード' },
  { name: 'securityCode' }, // カードの CVV。OTP と混同しない
  { placeholder: 'セキュリティコード' },
  { autocomplete: 'current-password' },
  {},
]) {
  assert.ok(!isOneTimeCodeField(makeEl(attrs)), `誤検出: ${JSON.stringify(attrs)}`);
}
console.log('OK: ordinary "code" fields (zip, promo, coupon, country) are not misdetected');

// --- 検証: <OTP> はエラー ---
const base = { name: 't', startUrl: 'https://example.com/' };
let r = validateRecording({ ...base, steps: [{ type: 'input', selector: '#otp', value: '<OTP>' }] });
assert.ok(
  r.errors.some((e) => e.code === 'otp-placeholder'),
  '<OTP> のままならエラーになること'
);
assert.match(r.errors[0].message, /\{\{totp:/, '直し方を案内すること');
console.log('OK: a leftover <OTP> is an error and points at {{totp:...}}');

// {{totp:...}} に直せば指摘が消える
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
r = validateRecording({ ...base, steps: [{ type: 'input', selector: '#otp', value: `{{totp:${SECRET}}}` }] });
assert.deepEqual(r.issues, [], `totp に直したら無指摘のはずが: ${JSON.stringify(r.issues)}`);
console.log('OK: {{totp:...}} is recognised as a known variable');

// --- 書き出したスクリプトが実行時に計算すること ---
const rec = {
  name: 'ログイン（2要素）',
  startUrl: 'https://example.com/login',
  steps: [
    { type: 'input', selector: '#user', value: 'tester' },
    { type: 'input', selector: '#pass', value: 'pw' },
    { type: 'input', selector: '#otp', value: `{{totp:${SECRET}}}` },
    { type: 'click', selector: '#login' },
  ],
};

const pw = generatePlaywright(rec);
assert.match(pw, /require\('crypto'\)/, 'crypto を読み込むこと');
assert.match(pw, /function __webrecTotp\(/, 'TOTP 実装が埋め込まれること');
assert.match(pw, /__webrecTotpPass\(s\)/, 'V が totp を先に解決すること');
assert.match(pw, /\.fill\(V\("\{\{totp:GEZ/, 'シークレットは V 経由で渡ること');
assert.ok(!pw.includes('.fill("123456")'), '固定の数字が焼き付いていないこと');
console.log('OK: exported Playwright script computes the code at run time');

// 生成コードを実際に動かし、独立実装と一致するか確かめる
const engineStart = pw.indexOf("const __webrecCrypto");
const engineEnd = pw.indexOf('const V = ');
const runnable = pw.slice(engineStart, engineEnd) + '\nreturn __webrecTotpPass("{{totp:' + SECRET + '}}");';
const fromGenerated = new Function('require', runnable)(nodeRequire);
assert.match(fromGenerated, /^\d{6}$/, `6桁になるはずが: ${fromGenerated}`);

const { generateTotp } = await import(srcUrl('template.js'));
const fromExtension = await generateTotp(SECRET, { now: Date.now() });
assert.equal(fromGenerated, fromExtension, '書き出したスクリプトと拡張機能で同じコードになること');
console.log(`OK: generated script and the extension agree on the current code (${fromGenerated})`);

// 桁数指定
const rec8 = { ...rec, steps: [{ type: 'input', selector: '#otp', value: `{{totp:${SECRET}|8}}` }] };
const pp = generatePuppeteer(rec8);
const s2 = pp.indexOf('const __webrecCrypto');
const e2 = pp.indexOf('(async () => {');
const eight = new Function('require', pp.slice(s2, e2) + '\nreturn __webrecTotpPass("{{totp:' + SECRET + '|8}}");')(
  nodeRequire
);
assert.match(eight, /^\d{8}$/);
console.log('OK: digit count is honoured in the generated script');

// totp を使わない録画には TOTP コードを入れない
const plain = { name: 'x', startUrl: 'https://a/', steps: [{ type: 'input', selector: '#a', value: '{{date}}' }] };
assert.ok(!generatePlaywright(plain).includes('__webrecTotp'), 'totp 未使用なら埋め込まないこと');
console.log('OK: recordings without totp get no crypto code');

console.log('\nALL OTP CHECKS PASSED');
