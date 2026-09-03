// WebRec: Basic 認証（ブラウザが出すユーザー名/パスワードのダイアログ）への対応。
//
// このダイアログはページの中ではなくブラウザ側にあり、alert/confirm と違って
// 差し替えられる window の関数すら存在しない。ページの JS からは触れないので、
// 「出てから答える」ことはできず、「出させない」しかない。
//
// そこで拡張の立場を使い、再生中だけ declarativeNetRequest のセッションルールで
// Authorization ヘッダを足す。サーバーは最初から認証済みとして応答するため、
// ダイアログはそもそも出ない。URL に user:pass@ を埋める方式と違って、
// 資格情報が URL 文字列やリファラに残らない。
//
// ルールはセッションルール（ディスクに残らない）で、再生に使うタブに限定して登録し、
// 再生が終わったら必ず消す。

import { resolveTemplate } from './template.js';

// セッションルールの ID はこの範囲だけを使う（他人のルールと混ざらないように）
export const RULE_ID_BASE = 90001;
export const MAX_ENTRIES = 20;

// Authorization を付ける対象。サブリソースにも付けないと、
// ページ本体は通っても画像や fetch でダイアログが出てしまう。
const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
];

// declarativeNetRequest の urlFilter で特別な意味を持つ記号。
// 対象URLは「先頭一致」で判定するので、これらが混ざると意図より広く当たってしまう。
const URL_FILTER_SPECIALS = /[*^|]/;

function toBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// RFC 7617。非 ASCII は UTF-8 で符号化する（多くのサーバーがこれを期待する）
export function basicAuthHeaderValue(username, password) {
  const raw = `${username == null ? '' : username}:${password == null ? '' : password}`;
  return 'Basic ' + toBase64(new TextEncoder().encode(raw));
}

// "https://user:pass@example.com/" のように資格情報が埋まった URL を分解する。
// 管理画面で URL をそのまま貼られたときに、ユーザー名/パスワード欄へ振り分ける。
export function splitUrlCredentials(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch (_) {
    return null;
  }
  if (!url.username && !url.password) return null;
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  return { url: url.href, username, password };
}

// 対象URLを正規化する。戻り値は「この文字列で始まるリクエストに付ける」という前提。
//   https://example.com        → https://example.com/     （サイト全体）
//   https://example.com/admin/ → そのまま                  （/admin/ 配下だけ）
//   https://example.com/*      → https://example.com/      （末尾の * は書かれがちなので許す）
// 理由はコードで返す（表示側で言語に合わせて文言を選べるように）
function authError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function normalizeAuthUrl(input) {
  let text = String(input == null ? '' : input).trim();
  if (!text) throw authError('empty', '対象URLがありません');
  text = text.replace(/\*+$/, ''); // 末尾の "/*" や "*" は先頭一致では不要
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    throw authError('unparsable', `対象URL "${input}" を URL として解釈できません`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw authError('scheme', '対象URL は http/https である必要があります');
  }
  if (url.username || url.password) {
    throw authError('credentials', '対象URL に user:pass@ を含めないでください（ユーザー名・パスワード欄に分けてください）');
  }
  url.hash = '';
  url.search = '';
  const href = url.href;
  if (URL_FILTER_SPECIALS.test(href)) {
    throw authError('specials', '対象URL に * ^ | は使えません（先頭一致で判定します）');
  }
  return href;
}

// 対象URLのオリジン。書き出した Playwright の httpCredentials.origin に渡す。
export function authOrigin(authUrl) {
  try {
    return new URL(authUrl).origin;
  } catch (_) {
    return undefined;
  }
}

// 1件ぶんを検証して整える。壊れていれば理由つきで投げる。
export function normalizeBasicAuthEntry(raw, at = 'basicAuth') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${at} は { url, username, password } 形式のオブジェクトである必要があります`);
  }
  let url;
  try {
    url = normalizeAuthUrl(raw.url);
  } catch (err) {
    throw new Error(`${at}: ${err.message}`);
  }
  for (const key of ['username', 'password']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      throw new Error(`${at}.${key} は文字列である必要があります`);
    }
  }
  return { url, username: raw.username || '', password: raw.password || '' };
}

// 録画に保存する形へ整える。空なら undefined（キーごと持たせない）。
export function normalizeBasicAuth(list) {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new Error('basicAuth は配列である必要があります');
  if (list.length > MAX_ENTRIES) {
    throw new Error(`basicAuth は ${MAX_ENTRIES} 件までです`);
  }
  const out = list.map((raw, i) => normalizeBasicAuthEntry(raw, `basicAuth[${i}]`));
  return out.length ? out : undefined;
}

// 長い対象URLの中から、リクエストURLに最初に当たるものを選ぶ（表示用）
export function matchAuthEntry(entries, requestUrl) {
  const url = String(requestUrl || '');
  return (entries || []).find((e) => url.toLowerCase().startsWith(e.url.toLowerCase())) || null;
}

// 資格情報にも {{data.列名}} や {{date}} を書けるようにする。
// データ駆動で行ごとにアカウントを変えたい場合に効く。
export function resolveBasicAuth(entries, ctx) {
  if (!entries || !entries.length) return entries;
  return entries.map((e) => ({
    ...e,
    username: resolveTemplate(e.username, ctx),
    password: resolveTemplate(e.password, ctx),
  }));
}

// 資格情報にテンプレートが含まれているか（書き出し側で扱いを変えるのに使う）
export function basicAuthUsesTemplates(entries) {
  return (entries || []).some(
    (e) => String(e.username || '').includes('{{') || String(e.password || '').includes('{{')
  );
}

// declarativeNetRequest のセッションルールを組み立てる。
// tabIds を必ず付けて、再生に使っているタブの外へは影響させない。
export function buildBasicAuthRules(entries, tabIds) {
  const ids = (tabIds || []).filter((id) => Number.isInteger(id) && id >= 0);
  return (entries || []).slice(0, MAX_ENTRIES).map((entry, i) => ({
    id: RULE_ID_BASE + i,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        {
          header: 'Authorization',
          operation: 'set',
          value: basicAuthHeaderValue(entry.username, entry.password),
        },
      ],
    },
    condition: {
      // 先頭に | を置くと「URL の先頭から一致」の意味になる
      urlFilter: '|' + entry.url,
      isUrlFilterCaseSensitive: false,
      resourceTypes: RESOURCE_TYPES,
      ...(ids.length ? { tabIds: ids } : {}),
    },
  }));
}

function dnr() {
  return typeof chrome !== 'undefined' && chrome.declarativeNetRequest ? chrome.declarativeNetRequest : null;
}

async function ownRuleIds(api) {
  const rules = await api.getSessionRules();
  return rules.filter((r) => r.id >= RULE_ID_BASE && r.id < RULE_ID_BASE + MAX_ENTRIES).map((r) => r.id);
}

// 再生中だけ有効なルールを張り替える。entries が空なら消すだけ。
export async function applyBasicAuth(entries, tabIds) {
  const api = dnr();
  if (!api) {
    if (entries && entries.length) {
      throw new Error('declarativeNetRequest を利用できません（拡張機能を再読み込みしてください）');
    }
    return 0;
  }
  const addRules = buildBasicAuthRules(entries, tabIds);
  await api.updateSessionRules({ removeRuleIds: await ownRuleIds(api), addRules });
  return addRules.length;
}

export async function clearBasicAuth() {
  const api = dnr();
  if (!api) return;
  const removeRuleIds = await ownRuleIds(api);
  if (removeRuleIds.length) await api.updateSessionRules({ removeRuleIds });
}
