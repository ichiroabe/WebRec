import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { srcUrl } from './helpers/src.mjs';

const { base32Decode, generateTotp, resolveTotp, resolveStepTotp } = await import(srcUrl('template.js'));

// --- Base32 デコード (RFC 4648 のテストベクタ) ---
const dec = (s) => Buffer.from(base32Decode(s)).toString();
assert.equal(dec('MY======'), 'f');
assert.equal(dec('MZXQ===='), 'fo');
assert.equal(dec('MZXW6==='), 'foo');
assert.equal(dec('MZXW6YQ='), 'foob');
assert.equal(dec('MZXW6YTB'), 'fooba');
assert.equal(dec('MZXW6YTBOI======'), 'foobar');
console.log('OK: base32 decode matches RFC 4648 vectors');

// 区切り文字・小文字・パディング無しを許容する
assert.equal(dec('mzxw6ytboi'), 'foobar');
assert.equal(dec('MZXW 6YTB OI'), 'foobar');
assert.equal(dec('MZXW-6YTB-OI'), 'foobar');
console.log('OK: lowercase, spaces and dashes in secrets are accepted');

assert.throws(() => base32Decode('MZXW6YTB!'), /invalid base32/);
assert.throws(() => base32Decode(''), /empty secret/);
console.log('OK: malformed secrets are rejected');

// --- TOTP (RFC 6238 の公式テストベクタ) ---
// シークレットは ASCII "12345678901234567890" = Base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
assert.equal(Buffer.from(base32Decode(SECRET)).toString(), '12345678901234567890');

const vectors = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
for (const [seconds, expected] of vectors) {
  const got = await generateTotp(SECRET, { digits: 8, now: seconds * 1000 });
  assert.equal(got, expected, `t=${seconds} で ${expected} になるはずが ${got}`);
}
console.log(`OK: TOTP matches all ${vectors.length} RFC 6238 test vectors (SHA-1, 8 digits)`);

// 6桁は8桁の下6桁
for (const [seconds, expected] of vectors) {
  const six = await generateTotp(SECRET, { digits: 6, now: seconds * 1000 });
  assert.equal(six, expected.slice(-6));
}
console.log('OK: 6-digit codes are the last 6 of the 8-digit codes');

// --- 30秒ごとに変わり、同一period内では一定 ---
// 30秒境界に揃えた時刻を基準にする（1700000010 は 30 で割り切れる）
const base = 1700000010000;
assert.equal((base / 1000) % 30, 0, 'テストの基準時刻は枠の先頭であること');
const a = await generateTotp(SECRET, { now: base });
const sameWindow = await generateTotp(SECRET, { now: base + 29000 });
const nextWindow = await generateTotp(SECRET, { now: base + 31000 });
assert.equal(a, sameWindow, '同じ30秒枠なら同じコード');
assert.notEqual(a, nextWindow, '枠が変われば別のコード');
console.log('OK: the code is stable within a 30s window and changes across windows');

// --- 独立実装 (Node crypto) と突き合わせ ---
function refTotp(secretB32, nowMs, digits = 6, period = 30) {
  const key = Buffer.from(base32Decode(secretB32));
  const counter = Math.floor(nowMs / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}
for (let i = 0; i < 50; i++) {
  const t = 1500000000000 + i * 37000;
  assert.equal(await generateTotp(SECRET, { now: t }), refTotp(SECRET, t), `t=${t} で不一致`);
}
console.log('OK: agrees with an independent Node-crypto implementation over 50 time points');

// --- テンプレート置換 ---
const ctx = { now: 59000 };
assert.equal(await resolveTotp(`{{totp:${SECRET}|8}}`, ctx), '94287082');
assert.equal(await resolveTotp(`{{totp:${SECRET}}}`, ctx), '287082');
assert.equal(await resolveTotp(`code=${SECRET ? '{{totp:' + SECRET + '}}' : ''}!`, ctx), 'code=287082!');
assert.equal(await resolveTotp('テンプレートなし', ctx), 'テンプレートなし');
console.log('OK: {{totp:...}} substitution, with and without a digit count');

// 不正なシークレットはそのまま残す（画面に出て気づけるように）
assert.equal(await resolveTotp('{{totp:NOT!VALID}}', ctx), '{{totp:NOT!VALID}}');
console.log('OK: an invalid secret is left visible instead of silently blanked');

// --- ステップ単位 ---
const step = { type: 'input', selector: '#otp', value: `{{totp:${SECRET}|8}}` };
const resolved = await resolveStepTotp(step, ctx);
assert.equal(resolved.value, '94287082');
assert.equal(step.value, `{{totp:${SECRET}|8}}`, '元のステップは変更しない');

const plain = { type: 'click', selector: '#a' };
assert.equal(await resolveStepTotp(plain, ctx), plain, 'totp が無ければそのまま返す');
console.log('OK: step-level resolution is non-destructive and skips unrelated steps');

console.log('\nALL TOTP CHECKS PASSED');
