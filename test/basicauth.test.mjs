// Basic 認証の設定が、保存・検証・再生・書き出しの各段で辻褄を保っているかを見る。
// 再生時のヘッダ付与は declarativeNetRequest 頼みなので、組み立てたルールの中身を検証する。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { srcUrl } from './helpers/src.mjs';

// validate.js のセレクタ構文チェックが DOM を必要とする
const dom = new JSDOM('<div></div>');
globalThis.document = dom.window.document;

const {
  normalizeAuthUrl,
  normalizeBasicAuth,
  basicAuthHeaderValue,
  splitUrlCredentials,
  buildBasicAuthRules,
  resolveBasicAuth,
  basicAuthUsesTemplates,
  matchAuthEntry,
  applyBasicAuth,
  clearBasicAuth,
  RULE_ID_BASE,
  MAX_ENTRIES,
} = await import(srcUrl('basicauth.js'));
const { validateRecording } = await import(srcUrl('validate.js'));
const { generateJson, parseRecordingJson, generatePlaywright, generatePuppeteer } = await import(
  srcUrl('generator.js')
);

// --- 対象URLの正規化 ---
assert.equal(normalizeAuthUrl('https://example.com'), 'https://example.com/');
assert.equal(normalizeAuthUrl('  https://example.com/  '), 'https://example.com/');
assert.equal(normalizeAuthUrl('https://example.com/*'), 'https://example.com/');
assert.equal(normalizeAuthUrl('https://example.com/admin/'), 'https://example.com/admin/');
assert.equal(normalizeAuthUrl('http://127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app');
// クエリやフラグメントは先頭一致の邪魔になるので落とす
assert.equal(normalizeAuthUrl('https://example.com/a?b=1#c'), 'https://example.com/a');
console.log('OK: target URLs are normalized to a prefix');

for (const [input, code] of [
  ['', 'empty'],
  ['   ', 'empty'],
  ['example.com', 'unparsable'],
  ['ftp://example.com/', 'scheme'],
  ['https://u:p@example.com/', 'credentials'],
]) {
  assert.throws(
    () => normalizeAuthUrl(input),
    (err) => err.code === code,
    `"${input}" は ${code} で弾かれるべき`
  );
}
console.log('OK: bad target URLs are rejected with a reason code');

// --- ヘッダ値（RFC 7617。非 ASCII は UTF-8） ---
assert.equal(basicAuthHeaderValue('Aladdin', 'open sesame'), 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
assert.equal(basicAuthHeaderValue('', ''), 'Basic Og==');
assert.equal(
  Buffer.from(basicAuthHeaderValue('user', 'ぱすわーど').slice(6), 'base64').toString('utf8'),
  'user:ぱすわーど'
);
console.log('OK: Authorization header value follows RFC 7617 (UTF-8 safe)');

// --- URL に埋め込まれた資格情報の取り出し ---
assert.deepEqual(splitUrlCredentials('https://qa:p%40ss@example.com/a'), {
  url: 'https://example.com/a',
  username: 'qa',
  password: 'p@ss',
});
assert.equal(splitUrlCredentials('https://example.com/'), null);
assert.equal(splitUrlCredentials('not a url'), null);
console.log('OK: credentials embedded in a URL are split out');

// --- declarativeNetRequest のルール ---
const entries = [
  { url: 'https://staging.example.com/', username: 'qa', password: 'pw' },
  { url: 'https://other.example.com/admin/', username: 'a', password: 'b' },
];
const rules = buildBasicAuthRules(entries, [7]);
assert.equal(rules.length, 2);
assert.deepEqual(
  rules.map((r) => r.id),
  [RULE_ID_BASE, RULE_ID_BASE + 1]
);
// 先頭の | が「URL の先頭から一致」を意味する。これが無いと部分一致で広く当たる。
assert.equal(rules[0].condition.urlFilter, '|https://staging.example.com/');
assert.deepEqual(rules[0].condition.tabIds, [7]);
assert.equal(rules[0].condition.isUrlFilterCaseSensitive, false);
assert.equal(rules[0].action.type, 'modifyHeaders');
assert.deepEqual(rules[0].action.requestHeaders, [
  { header: 'Authorization', operation: 'set', value: basicAuthHeaderValue('qa', 'pw') },
]);
// ページ本体だけでなくサブリソースにも付けないと、画像や fetch でダイアログが出る
for (const type of ['main_frame', 'sub_frame', 'xmlhttprequest', 'image']) {
  assert.ok(rules[0].condition.resourceTypes.includes(type), `${type} が対象に入っていない`);
}
// タブを限定しない場合は tabIds ごと落とす（条件が空配列だと何にも当たらない）
assert.equal('tabIds' in buildBasicAuthRules(entries, [])[0].condition, false);
console.log('OK: session rules add Authorization only to the matching URL prefix');

// --- 資格情報のテンプレート変数 ---
assert.equal(basicAuthUsesTemplates(entries), false);
const tpl = [{ url: 'https://x.example/', username: '{{data.user}}', password: '{{data.pw}}' }];
assert.equal(basicAuthUsesTemplates(tpl), true);
assert.deepEqual(resolveBasicAuth(tpl, { data: { user: 'u1', pw: 'p1' } }), [
  { url: 'https://x.example/', username: 'u1', password: 'p1' },
]);
console.log('OK: credentials can be driven from the dataset');

// --- どのエントリが当たるか ---
assert.equal(matchAuthEntry(entries, 'https://staging.example.com/a/b').username, 'qa');
assert.equal(matchAuthEntry(entries, 'https://other.example.com/public/'), null);
console.log('OK: the matching entry is found by prefix');

// --- 保存形式（normalize / 上限） ---
assert.equal(normalizeBasicAuth(undefined), undefined);
assert.equal(normalizeBasicAuth([]), undefined);
assert.deepEqual(normalizeBasicAuth([{ url: 'https://a.example' }]), [
  { url: 'https://a.example/', username: '', password: '' },
]);
assert.throws(() => normalizeBasicAuth('x'), /配列/);
assert.throws(() => normalizeBasicAuth([{ url: 'https://a.example', username: 1 }]), /文字列/);
assert.throws(
  () => normalizeBasicAuth(Array.from({ length: MAX_ENTRIES + 1 }, () => ({ url: 'https://a.example/' }))),
  new RegExp(`${MAX_ENTRIES} 件まで`)
);
console.log('OK: stored entries are normalized and bounded');

// --- JSON の往復 ---
const rec = {
  name: 'ステージング',
  startUrl: 'https://staging.example.com/',
  createdAt: 1700000000000,
  steps: [{ type: 'click', selector: '#go' }],
  basicAuth: [{ url: 'https://staging.example.com/', username: 'qa', password: 'pw' }],
};
const parsed = parseRecordingJson(generateJson(rec));
assert.deepEqual(parsed.basicAuth, rec.basicAuth);
// basicAuth を持たない録画にキーを生やさない（既存の JSON を無闇に太らせない）
assert.equal('basicAuth' in JSON.parse(generateJson({ ...rec, basicAuth: undefined })), false);
assert.throws(
  () => parseRecordingJson('{"startUrl":"https://a/","steps":[],"basicAuth":[{"url":"ftp://x/"}]}'),
  /http\/https/
);
console.log('OK: basicAuth round-trips through JSON and rejects bad entries');

// --- 整合性チェック ---
let v = validateRecording(rec);
assert.deepEqual(v.errors, []);
assert.deepEqual(v.warnings, []);
// 資格情報を持つことは常に知らせる（エクスポートに含まれるため）
assert.ok(v.infos.some((i) => i.code === 'basic-auth-stored'));

v = validateRecording({
  ...rec,
  basicAuth: [{ url: 'https://a.example/', username: '', password: '<PASSWORD>' }],
});
assert.ok(v.warnings.some((i) => i.code === 'basic-auth-no-user'));
assert.ok(v.warnings.some((i) => i.code === 'basic-auth-placeholder'));

v = validateRecording({ ...rec, basicAuth: [{ url: 'https://a.example/*x', username: 'u', password: 'p' }] });
assert.ok(v.errors.some((i) => i.code === 'basic-auth-bad-url'));
console.log('OK: validation flags missing, placeholder and malformed credentials');

// --- 書き出し ---
const pw = generatePlaywright(rec);
assert.match(pw, /test\.use\(\{ httpCredentials: \{ username: "qa", password: "pw", origin: "https:\/\/staging\.example\.com" \} \}\);/);
assert.match(pw, /Basic 認証/); // 共有時の注意書き
const pp = generatePuppeteer(rec);
assert.match(pp, /await page\.authenticate\(\{ username: "qa", password: "pw" \}\);/);
// authenticate は最初の goto より前に置く（401 に応答する設定のため）
assert.ok(pp.indexOf('page.authenticate') < pp.indexOf('page.goto'));
// 資格情報が無い録画には何も混ぜない
assert.equal(generatePlaywright({ ...rec, basicAuth: undefined }).includes('httpCredentials'), false);
assert.equal(generatePuppeteer({ ...rec, basicAuth: undefined }).includes('authenticate'), false);
// 2 組目以降は適用できないので、黙って落とさず注意書きに出す
const many = generatePlaywright({ ...rec, basicAuth: [...rec.basicAuth, { url: 'https://b.example/', username: 'x', password: 'y' }] });
assert.match(many, /https:\/\/b\.example\//);
assert.equal((many.match(/httpCredentials/g) || []).length, 1);
console.log('OK: exported scripts carry the credentials (and warn about them)');

// --- セッションルールの張り替え / 後始末 ---
{
  let stored = [];
  globalThis.chrome = {
    declarativeNetRequest: {
      async getSessionRules() {
        return stored;
      },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        stored = stored.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
      },
    },
  };
  // 拡張機能以外のルールを消してしまわないこと
  stored.push({ id: 1, action: {}, condition: {} });

  assert.equal(await applyBasicAuth(entries, [3]), 2);
  assert.equal(stored.length, 3);
  // 張り替えても増え続けない
  assert.equal(await applyBasicAuth([entries[0]], [3]), 1);
  assert.deepEqual(
    stored.map((r) => r.id),
    [1, RULE_ID_BASE]
  );
  await clearBasicAuth();
  assert.deepEqual(
    stored.map((r) => r.id),
    [1],
    '再生が終わったら資格情報つきのルールは残さない'
  );
  delete globalThis.chrome;
}
console.log('OK: session rules are replaced on apply and removed on clear');


// --- 対象URLの不備は、検証タブと管理画面で同じ文言になる ---
{
  const { authUrlIssueMessage } = await import(srcUrl('validate.js'));
  let thrown;
  try {
    normalizeAuthUrl('ftp://x/');
  } catch (err) {
    thrown = err;
  }
  const message = authUrlIssueMessage(thrown, 0, 'ftp://x/');
  assert.match(message, /Basic/);
  assert.equal(
    message,
    validateRecording({
      name: 't',
      startUrl: 'https://a.example/',
      steps: [],
      basicAuth: [{ url: 'ftp://x/', username: 'u', password: 'p' }],
    }).errors[0].message
  );
  console.log('OK: the same wording is used by validation and by the editor');
}

console.log('\nALL BASIC AUTH CHECKS PASSED');
