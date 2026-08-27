// WebRec: background service worker
// - 録画セッションの管理（開始/停止/イベント収集）
// - ページ遷移(navigate)の自動検知
// - 完了した録画を IndexedDB へ保存
// - 保存済み録画の再生（リプレイ）

import { saveRecording, getRecording, saveFile, getFile, saveRun, pruneRuns } from './db.js';
import { getSettings, effectiveSettings, nextSeq } from './settings.js';
import { resolveStepTemplates, resolveStepTotp } from './template.js';
import { stepSummary } from './generator.js';
import { initI18n, t, getLang } from './i18n.js';

// service worker が起きたら文言を確定させておく
const i18nReady = initI18n();

const SESSION_KEY = 'webrec_active_session';

/** @type {null | { id: string, tabId: number, startUrl: string, name: string, steps: any[], startedAt: number, lastUrl: string }} */
let session = null;

async function persistSession() {
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: session });
  } catch (e) {
    console.warn('WebRec: failed to persist session', e);
  }
}

async function restoreSession() {
  if (session) return session;
  try {
    const data = await chrome.storage.session.get(SESSION_KEY);
    if (data && data[SESSION_KEY]) {
      session = data[SESSION_KEY];
    }
  } catch (e) {
    console.warn('WebRec: failed to restore session', e);
  }
  return session;
}

async function setBadge(tabId, recording) {
  try {
    await chrome.action.setBadgeText({ tabId, text: recording ? 'REC' : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
  } catch (_) {
    /* tab may be gone */
  }
}

async function notifyTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    /* content script may not be ready yet, ignore */
  }
}

// 拡張機能を再読み込みした後など、既に開いていたタブには content script が
// 注入されていない。その状態で記録を始めても何も拾えないため、
// 生存確認して必要なら注入し直す（ページの再読み込みを不要にする）。
async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'WEBREC_PING' });
    if (res && res.ok) return true;
  } catch (_) {
    /* 未注入。以下で注入する */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content.js'],
    });
    return true;
  } catch (err) {
    console.warn('WebRec: failed to inject content script', err);
    return false;
  }
}

async function startRecording({ tabId, startUrl, name }) {
  await restoreSession();
  if (session) {
    throw new Error(t('bg.alreadyRecording'));
  }

  // 監視できる状態にしてからセッションを作る。ここで失敗したまま始めると
  // 「記録中なのに何も記録されない」状態になってしまう。
  const ready = await ensureContentScript(tabId);
  if (!ready) {
    throw new Error(t('bg.cannotObserve'));
  }

  session = {
    id: crypto.randomUUID(),
    tabId,
    startUrl,
    name: name || t('bg.defaultName', { when: new Date().toLocaleString(getLang() === 'ja' ? 'ja-JP' : 'en-US') }),
    steps: [],
    startedAt: Date.now(),
    lastUrl: startUrl,
  };
  await persistSession();
  await setBadge(tabId, true);
  await notifyTab(tabId, { type: 'WEBREC_START' });
  return { ok: true, id: session.id };
}

async function stopRecording() {
  await restoreSession();
  if (!session) {
    return { ok: false, error: t('bg.notRecording') };
  }
  const finished = session;
  session = null;
  await chrome.storage.session.remove(SESSION_KEY);
  await setBadge(finished.tabId, false);
  await notifyTab(finished.tabId, { type: 'WEBREC_STOP' });

  const rec = {
    id: finished.id,
    name: finished.name,
    startUrl: finished.startUrl,
    steps: finished.steps,
    createdAt: finished.startedAt,
    updatedAt: Date.now(),
  };
  await saveRecording(rec);
  return { ok: true, id: rec.id, stepCount: rec.steps.length };
}

// アップロードされたファイルの中身は IndexedDB へ逃がし、ステップには参照だけ残す。
// chrome.storage.session は容量が小さく、dataUrl をそのまま入れると
// 記録中のセッションごと失われてしまうため。
async function externalizeFiles(step) {
  if (step.type !== 'upload' || !Array.isArray(step.files)) return step;
  const files = [];
  for (const f of step.files) {
    if (f.dataUrl) {
      const fileId = crypto.randomUUID();
      await saveFile({ id: fileId, name: f.name, mimeType: f.mimeType, size: f.size, dataUrl: f.dataUrl });
      files.push({ fileId, name: f.name, mimeType: f.mimeType, size: f.size });
    } else {
      files.push({ name: f.name, mimeType: f.mimeType, size: f.size, omitted: f.omitted });
    }
  }
  return { ...step, files };
}

async function recordEvent(tabId, step) {
  await restoreSession();
  if (!session || session.tabId !== tabId) return;

  // ダブルクリックはブラウザが click を2回先に出すので、その2件を取り消して置き換える
  if (step.type === 'dblclick' && step.replacesClicks) {
    for (let n = 0; n < step.replacesClicks; n++) {
      const last = session.steps[session.steps.length - 1];
      if (last && last.type === 'click' && last.selector === step.selector) session.steps.pop();
      else break;
    }
    delete step.replacesClicks;
  }

  session.steps.push(await externalizeFiles(step));
  if (step.type === 'navigate') session.lastUrl = step.url;
  await persistSession();
}

async function getState(tabId) {
  await restoreSession();
  if (!session) return { isRecording: false };
  return {
    isRecording: true,
    isCurrentTab: session.tabId === tabId,
    tabId: session.tabId,
    startUrl: session.startUrl,
    name: session.name,
    stepCount: session.steps.length,
  };
}

// --- ページ遷移の自動検知(履歴API による SPA 遷移も含む) ---
async function recordNavigate(tabId, url) {
  await restoreSession(); // service worker が再起動された直後でも state を復元してから判定する
  if (!session) return;
  if (tabId !== session.tabId) return;
  if (url === session.lastUrl) return;
  session.lastUrl = url;
  session.steps.push({ type: 'navigate', url, timestamp: Date.now() });
  await persistSession();
}

let historyDebounceTimer = null;

function handleCommitted(details) {
  if (details.frameId !== 0) return;
  if (historyDebounceTimer) {
    clearTimeout(historyDebounceTimer);
    historyDebounceTimer = null;
  }
  recordNavigate(details.tabId, details.url);
}

// ライブ検索欄など、1回の入力で history.pushState/replaceState が連続発火するケースがあるため、
// URL の変化が落ち着くまで待ってから最後の1回だけステップとして記録する。
function handleHistoryStateUpdated(details) {
  if (details.frameId !== 0) return;
  if (historyDebounceTimer) clearTimeout(historyDebounceTimer);
  historyDebounceTimer = setTimeout(() => {
    historyDebounceTimer = null;
    recordNavigate(details.tabId, details.url);
  }, 600);
}

chrome.webNavigation.onCommitted.addListener(handleCommitted);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleHistoryStateUpdated);

// target="_blank" などで新しいタブが開いたら、そちらへ記録を引き継ぐ。
// 追従しないと、新しいタブでの操作が丸ごと記録から抜け落ちてしまう。
chrome.tabs.onCreated.addListener(async (tab) => {
  await restoreSession();
  if (!session || tab.openerTabId !== session.tabId) return;
  session.steps.push({ type: 'newTab', url: tab.pendingUrl || tab.url || '', timestamp: Date.now() });
  await setBadge(session.tabId, false);
  session.tabId = tab.id;
  session.lastUrl = tab.pendingUrl || tab.url || '';
  await persistSession();
  await setBadge(tab.id, true);
  // 読み込み完了を待ってから監視を始める
  setTimeout(async () => {
    await ensureContentScript(tab.id);
    await notifyTab(tab.id, { type: 'WEBREC_START' });
  }, 500);
});

// 録画中のタブが閉じられたら、録れた分だけ保存して終える
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await restoreSession();
  if (session && session.tabId === tabId) {
    await stopRecording();
  }
});

// --- リプレイ（保存済み録画をブラウザ上で再現） ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// イベントリスナー方式だと「呼び出し時点で既に complete」なケースを取りこぼして
// タイムアウトまで固まって見えるため、ポーリングで現在の状態を都度確認する。
// 最上位フレームの DOM が使える状態か（読み込み完了までは待たない）
async function isDomUsable(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => document.readyState,
    });
    return !!res && (res.result === 'interactive' || res.result === 'complete');
  } catch (_) {
    return false; // 遷移中などで読めない。次のポーリングで見直す
  }
}

// tab.status === 'complete' を待つのが理想だが、広告や計測タグを読み込み続ける
// ニュースサイト等では 'complete' にならないことがある。そのまま待つと
// 「再生中の表示だけで何も起きない」状態が何分も続くため、DOM が使える状態に
// なっていれば、読み込みの完了を待たずに先へ進む。
const DOM_READY_GRACE_MS = 8000;

async function waitForTabReady(tabId, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(t('bg.tabGone'));
    if (tab.status === 'complete') return;
    const waited = Date.now() - start;
    if (waited > DOM_READY_GRACE_MS && (await isDomUsable(tabId))) return;
    if (waited > timeoutMs) throw new Error(t('bg.loadTimeout'));
    await sleep(150);
  }
}

// content スクリプトのコンテキストで動く、ステップ実行の本体。
// executeScript 経由で全フレームに注入されるため、外側の変数を閉じ込めず自己完結させる。
// 各フレームは自身のフレーム位置が step.frames と一致する場合のみ実行する。
function performStepInPage(step) {
  const MSG = step.__msg || {}; // 呼び出し元が渡さなかった場合でも落ちないように

  // 最上位から自フレームまでの frameElement を並べる（読めない区間があれば opaque）
  function myFrameElements() {
    const chain = [];
    let win = window;
    let opaque = false;
    for (let guard = 0; guard < 20 && win !== window.top; guard++) {
      let frameEl = null;
      try {
        frameEl = win.frameElement;
      } catch (_) {
        frameEl = null;
      }
      if (!frameEl) {
        opaque = true; // クロスオリジンの親。ここから上は辿れない
        break;
      }
      chain.unshift(frameEl);
      win = win.parent;
    }
    return { chain, opaque };
  }

  // 記録された frames が「このフレーム」を指しているかを判定する。
  // 記録時と同じ文字列を作り直して比較するのではなく、実際の frameElement に
  // セレクタを当てて確かめる。こうすると <frame>（frameset）でも効くうえ、
  // 記録側の生成規則が変わっても同じフレームなら一致させられる。
  //   'exact' … セレクタが自分の祖先フレームに一致した
  //   'loose' … 記録が古い/解決できない。要素の有無で引き受けるか決める
  //   'none'  … 別のフレーム
  function frameMatchLevel(want) {
    const { chain, opaque } = myFrameElements();
    if (!want.length) return chain.length === 0 ? 'exact' : 'none';
    if (opaque || want.some((w) => typeof w !== 'string')) return 'loose';
    if (chain.length !== want.length) return 'none';

    let unresolvable = false;
    for (let i = 0; i < want.length; i++) {
      const el = chain[i];
      let hit = false;
      try {
        hit = el.matches(want[i]);
      } catch (_) {
        unresolvable = true; // 不正なセレクタ（旧版の iframe:nth-of-type(0) など）
        continue;
      }
      if (hit) continue;
      // そのセレクタがそもそも誰も指していないなら、記録が古いだけとみなす
      let other = null;
      try {
        other = el.ownerDocument.querySelector(want[i]);
      } catch (_) {
        other = null;
      }
      if (other) return 'none'; // 実在する別フレームを指している
      unresolvable = true;
    }
    return unresolvable ? 'loose' : 'exact';
  }

  // 表示テキストで要素を指す独自表記。例: a:text("受信箱")
  const TEXT_SELECTOR_RE = /^([a-zA-Z][\w-]*):text\("([\s\S]*)"\)$/;

  // タグ名と表示テキストから要素を探す。
  // 候補がちょうど 1 つのときだけ採用し、取り違えを避ける。
  function findByLabel(tag, text) {
    const want = String(text || '').trim();
    if (!want || !tag) return null;
    let nodes;
    try {
      nodes = Array.from(document.querySelectorAll(tag));
    } catch (_) {
      return null;
    }
    const hits = nodes.filter((el) => {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
      // 記録時に 60 文字で切っているため、前方一致も許す
      return t === want || (want.length >= 3 && t.startsWith(want));
    });
    return hits.length === 1 ? hits[0] : null;
  }

  // 記録された候補セレクタ。古い録画には selector しか無いのでそれを1本の候補として扱う
  function candidatesOf(target) {
    const list =
      Array.isArray(target.selectors) && target.selectors.length ? target.selectors : [target.selector];
    return list.filter((sel) => typeof sel === 'string' && sel);
  }

  // 構文として使える候補か（壊れた候補は黙って飛ばし、全滅したときだけエラーにする）
  function selectorUsable(sel) {
    if (TEXT_SELECTOR_RE.test(sel)) return true;
    try {
      queryDeep(sel);
      return true;
    } catch (_) {
      return false;
    }
  }

  // 候補 1 本を要素に解決する
  function resolveOne(sel) {
    const m = TEXT_SELECTOR_RE.exec(sel);
    // テキスト頼みの指定は最後の試行でだけ使う。
    // 先に本来のセレクタで見つかるフレーム/要素に譲り、取り違えを避けるため。
    if (m) return allowFallback ? findByLabel(m[1], m[2].replace(/\\"/g, '"')) : null;
    try {
      return queryDeep(sel);
    } catch (_) {
      return null;
    }
  }

  // 候補を上から順に試す
  function resolveAny(cands) {
    for (let i = 0; i < cands.length; i++) {
      const el = resolveOne(cands[i]);
      if (el) return { el, index: i, selector: cands[i] };
    }
    return null;
  }

  const allowFallback = !!step.__allowTextFallback;
  let usedFallback = null; // 先頭以外の候補で見つけた場合、その候補を控えておく
  const done = (extra) => ({ matched: true, fallback: usedFallback, ...(extra || {}) });

  const level = frameMatchLevel(step.frames || []);
  if (level === 'none') return { matched: false };
  if (level === 'loose') {
    // フレームを特定しきれないケース。対象要素を持たないフレームまで実行すると、
    // 要素待ちのタイムアウトでステップ全体が失敗してしまうので、
    // 「今このフレームに対象がある」ものだけが引き受ける。
    // assertMissing は「無いこと」を確かめるステップなので、この判定には掛けられない。
    const cands = candidatesOf(step).filter(selectorUsable);
    if (cands.length && step.type !== 'assertMissing') {
      if (!resolveAny(cands)) return { matched: false };
    } else if (myFrameElements().chain.length !== (step.frames || []).length) {
      // scroll など対象要素を持たないステップは、深さが同じフレームだけに任せる
      return { matched: false };
    }
  }

  // ステップ個別の timeoutMs があればそれを優先する
  const elementTimeout = Number.isFinite(step.timeoutMs) ? step.timeoutMs : step.__elementTimeoutMs || 8000;

  // shadow DOM を貫通してセレクタを解決する。
  // 記録側は "host >>> inner" 形式で保存しているので、区間ごとに shadowRoot へ降りる。
  function queryDeep(selector) {
    const segments = String(selector).split(' >>> ');
    let scope = document;
    let el = null;
    for (let i = 0; i < segments.length; i++) {
      el = scope.querySelector(segments[i]); // 不正なら例外が飛ぶ
      if (!el) return null;
      if (i < segments.length - 1) {
        if (!el.shadowRoot) return null; // 閉じた shadow root には入れない
        scope = el.shadowRoot;
      }
    }
    return el;
  }

  // target は step そのもの（selector / selectors を持つオブジェクト）。
  // 候補を上から試し、先頭以外で見つかった場合はその旨を記録する。
  function findEl(target, timeoutMs) {
    const all = candidatesOf(target);
    const cands = all.filter(selectorUsable);
    return new Promise((resolve, reject) => {
      if (!cands.length) {
        return reject(new Error((MSG.badSelector || '') + (all[0] || '')));
      }
      const start = Date.now();
      (function poll() {
        const hit = resolveAny(cands);
        if (hit) {
          if (hit.index > 0) usedFallback = hit.selector;
          return resolve(hit.el);
        }
        if (Date.now() - start > timeoutMs) {
          return reject(new Error((MSG.notFound || '') + cands[0]));
        }
        setTimeout(poll, 150);
      })();
    });
  }

  // マウスイベントを座標付きで発火する（軌跡の再現用）
  function fireMouse(el, kind, clientX, clientY, extra) {
    el.dispatchEvent(
      new MouseEvent(kind, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        button: 0,
        ...(extra || {}),
      })
    );
  }

  function fireDragSequence(from, to) {
    const dt = new DataTransfer();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
    from.dispatchEvent(new DragEvent('dragstart', opts));
    to.dispatchEvent(new DragEvent('dragenter', opts));
    to.dispatchEvent(new DragEvent('dragover', opts));
    to.dispatchEvent(new DragEvent('drop', opts));
    from.dispatchEvent(new DragEvent('dragend', opts));
  }

  // data URL を File に戻す。fetch(data:) はページの CSP で塞がれることがあるため
  // base64 を自前でデコードする。
  function dataUrlToFile(dataUrl, name, mimeType) {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    let bytes;
    if (meta.includes(';base64')) {
      const bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return new File([bytes], name, { type: mimeType || 'application/octet-stream' });
  }

  return (async () => {
    if (step.type === 'waitForSelector') {
      await findEl(step, elementTimeout);
      return done();
    }

    // --- 検証ステップ ---
    // 期待どおりの画面になっているかを確かめ、違えば止める。
    // 削除など取り返しのつかない操作の前後に置くために用意している。
    // 文言の組み立ては呼び出し元（background）に任せ、ここでは事実だけ返す。
    if (step.type === 'assertText') {
      const el = await findEl(step, elementTimeout);
      const actual = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      const expected = String(step.value == null ? '' : step.value).trim();
      const ok = step.match === 'equals' ? actual === expected : actual.includes(expected);
      return done(ok ? null : { assertFailed: { kind: 'text', expected, actual: actual.slice(0, 200) } });
    }

    if (step.type === 'assertVisible') {
      const el = await findEl(step, elementTimeout);
      const style = window.getComputedStyle(el);
      const visible =
        el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      return done(visible ? null : { assertFailed: { kind: 'visible', selector: candidatesOf(step)[0] } });
    }

    if (step.type === 'assertMissing') {
      const cands = candidatesOf(step).filter(selectorUsable);
      const start = Date.now();
      for (;;) {
        if (!resolveAny(cands)) return done(); // 消えた/元から無い
        if (Date.now() - start > elementTimeout) {
          return done({ assertFailed: { kind: 'missing', selector: cands[0] } });
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    if (step.type === 'upload') {
      const input = await findEl(step, elementTimeout);
      const dt = new DataTransfer();
      for (const f of step.files || []) {
        if (!f.dataUrl) throw new Error((MSG.fileMissing || '') + f.name);
        dt.items.add(dataUrlToFile(f.dataUrl, f.name, f.mimeType));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return done();
    }

    // ウィンドウ全体のスクロールは対象要素を持たない
    if (step.type === 'scroll' && !step.selector) {
      window.scrollTo({ left: step.x || 0, top: step.y || 0, behavior: 'instant' });
      return done();
    }

    const el = await findEl(step, elementTimeout);
    if (step.type !== 'scroll') el.scrollIntoView({ block: 'center', inline: 'center' });

    if (step.type === 'click') {
      el.click();
    } else if (step.type === 'input') {
      el.focus();
      const proto =
        el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, step.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    } else if (step.type === 'select') {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, step.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (step.type === 'selectMultiple') {
      el.focus();
      const wanted = new Set(step.values);
      for (const opt of el.options) opt.selected = wanted.has(opt.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (step.type === 'dragAndDrop') {
      const to = await findEl({ selector: step.toSelector, selectors: step.toSelectors }, 8000);
      fireDragSequence(el, to);
    } else if (step.type === 'keydown') {
      el.focus();
      const keyInit = {
        key: step.key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ctrlKey: !!step.ctrlKey,
        altKey: !!step.altKey,
        shiftKey: !!step.shiftKey,
        metaKey: !!step.metaKey,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', keyInit));
      el.dispatchEvent(new KeyboardEvent('keyup', keyInit));
    } else if (step.type === 'dblclick') {
      // click 2回のあとに dblclick を出す（ブラウザと同じ順序）
      el.click();
      el.click();
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, detail: 2 }));
    } else if (step.type === 'contextmenu') {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      fireMouse(el, 'mousedown', cx, cy, { button: 2, buttons: 2 });
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: cx,
          clientY: cy,
          button: 2,
        })
      );
      fireMouse(el, 'mouseup', cx, cy, { button: 2, buttons: 0 });
    } else if (step.type === 'editable') {
      // リッチテキストは innerHTML を入れ替えて、エディタ側に変更を通知する
      el.focus();
      el.innerHTML = step.html;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    } else if (step.type === 'scroll') {
      el.scrollTo({ left: step.x || 0, top: step.y || 0, behavior: 'instant' });
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    } else if (step.type === 'pointerPath') {
      // canvas への描画や mousedown 実装のドラッグを、座標の列で再現する
      const r = el.getBoundingClientRect();
      const at = (p) => [Math.round(r.left + p.x), Math.round(r.top + p.y)];
      const pts = step.points || [];
      if (pts.length) {
        const [sx, sy] = at(pts[0]);
        fireMouse(el, 'mousedown', sx, sy, { buttons: 1 });
        for (let i = 1; i < pts.length; i++) {
          const [mx, my] = at(pts[i]);
          fireMouse(el, 'mousemove', mx, my, { buttons: 1 });
          // 画面外に出た先で受け取る実装もあるため window にも流す
          window.dispatchEvent(
            new MouseEvent('mousemove', { bubbles: true, clientX: mx, clientY: my, buttons: 1 })
          );
        }
        const [ex, ey] = at(pts[pts.length - 1]);
        fireMouse(el, 'mouseup', ex, ey, { buttons: 0 });
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ex, clientY: ey }));
      }
    }
    return done();
  })();
}

// alert / confirm / prompt はページの実行を止めてしまい、拡張機能からは閉じられない。
// 再生中だけ MAIN ワールドで差し替えて、ダイアログを出さずに既定の応答を返す。
function installDialogStubs() {
  if (window.__webrecDialogStubbed) return;
  window.__webrecDialogStubbed = true;
  window.__webrecDialogs = [];
  const log = (kind, message, answer) => window.__webrecDialogs.push({ kind, message, answer });
  window.alert = function (message) {
    log('alert', String(message == null ? '' : message), null);
  };
  window.confirm = function (message) {
    log('confirm', String(message == null ? '' : message), true);
    return true; // 「OK」を押した扱いにする
  };
  window.prompt = function (message, defaultValue) {
    const answer = defaultValue == null ? '' : String(defaultValue);
    log('prompt', String(message == null ? '' : message), answer);
    return answer;
  };
}

async function stubDialogs(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN', // ページ自身の window を書き換える必要がある
      func: installDialogStubs,
    });
  } catch (err) {
    console.warn('WebRec: failed to stub dialogs', err);
  }
}

// ダイアログ差し替えはドキュメント単位なので、遷移やフレームの読み込み直しで消える。
// frameset のように一部のフレームだけが読み込み直されるサイトでは、
// これを入れ直さないと confirm() でページごと止まってしまう。
let dialogGuardListener = null;

function startDialogGuard(getTabId) {
  stopDialogGuard();
  dialogGuardListener = (details) => {
    if (details.tabId !== getTabId()) return;
    chrome.scripting
      .executeScript({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        world: 'MAIN',
        func: installDialogStubs,
      })
      .catch(() => {
        /* 遷移直後で注入できないことがある。次のステップの待ちで吸収される */
      });
  };
  chrome.webNavigation.onCommitted.addListener(dialogGuardListener);
}

function stopDialogGuard() {
  if (!dialogGuardListener) return;
  try {
    chrome.webNavigation.onCommitted.removeListener(dialogGuardListener);
  } catch (_) {
    /* noop */
  }
  dialogGuardListener = null;
}

// 再生中にクリックで新しいタブが開いた場合、そのタブを掴み直す
function waitForChildTab(openerTabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onCreated.removeListener(listener);
      resolve(null);
    }, timeoutMs);
    function listener(tab) {
      if (tab.openerTabId !== openerTabId) return;
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(listener);
      resolve(tab);
    }
    chrome.tabs.onCreated.addListener(listener);
  });
}

// アップロードのステップは、注入直前に IndexedDB からファイル本体を読み戻す
async function hydrateFiles(step) {
  if (step.type !== 'upload' || !Array.isArray(step.files)) return step;
  const files = [];
  for (const f of step.files) {
    if (f.dataUrl) {
      files.push(f); // インポート直後などで既に埋め込まれている場合
      continue;
    }
    if (!f.fileId) {
      throw new Error(
        f.omitted === 'too-large'
          ? t('bg.fileTooLarge', { name: f.name })
          : t('bg.fileMissing', { name: f.name })
      );
    }
    const stored = await getFile(f.fileId);
    if (!stored || !stored.dataUrl) throw new Error(t('bg.fileNotStored', { name: f.name }));
    files.push({ ...f, dataUrl: stored.dataUrl });
  }
  return { ...step, files };
}

// ページ遷移の最中は executeScript が失敗するため、読み込み完了を待ってから注入し、
// それでも失敗した場合は数回リトライする。
async function executeStepWithRetry(tabId, step, cfg) {
  const ready = await hydrateFiles(step);
  let lastErr = null;
  for (let attempt = 0; attempt < cfg.injectRetries; attempt++) {
    try {
      await waitForTabReady(tabId, cfg.pageLoadTimeoutMs);
      // iframe 内の操作もありうるため全フレームに注入し、該当フレームだけが実行する
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: performStepInPage,
        args: [
          {
            ...ready,
            __elementTimeoutMs: cfg.elementTimeoutMs,
            // セレクタが当たらないときのテキスト頼みの探索は、最後の試行でだけ有効にする
            __allowTextFallback: attempt === cfg.injectRetries - 1,
            // 注入される関数からは t() を呼べないため、文言を渡しておく
            __msg: {
              badSelector: t('bg.badSelectorPrefix'),
              notFound: t('bg.notFoundPrefix'),
              fileMissing: t('bg.fileMissingPrefix'),
            },
          },
        ],
      });
      const hit = results.find((r) => r.result && r.result.matched);
      if (hit) return hit.result;
      lastErr = new Error(t('bg.frameNotFound'));
    } catch (err) {
      lastErr = err;
    }
    await sleep(500); // 遷移が始まっていた場合に落ち着くのを待つ
  }
  throw lastErr || new Error(t('bg.stepFailed'));
}

// --- 実行ログ ---
// 再生 1 回ぶんを 1 レコードとして残す。進捗が出るたびに上書き保存するので、
// 途中で Service Worker が止まっても、そこまでの経過は残る。

let currentRun = null;
let runSaveTimer = null;

// 実行ログは「おまけ」なので、これが詰まっても再生は止めない。
// IndexedDB が開けない・遅いといった理由で待ち続けないよう、必ず時間で見切る。
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

function saveRunSafely(run) {
  return withTimeout(
    saveRun(run).catch((err) => {
      console.warn('WebRec: failed to save run log', err);
    }),
    3000
  );
}

function beginRun(rec, opts, rowCount) {
  currentRun = {
    id: crypto.randomUUID(),
    recordingId: rec.id,
    name: rec.name,
    trigger: opts.trigger === 'schedule' ? 'schedule' : 'manual',
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    rowCount,
    options: {
      tabId: opts.tabId ?? null,
      keepCurrentUrl: !!opts.keepCurrentUrl,
      startAtIndex: Number.isFinite(opts.startAtIndex) ? opts.startAtIndex : 0,
    },
    steps: [],
    dialogs: [],
    error: null,
  };
  // 保存の完了は待たない（ここで待つと、ログが書けないだけで再生が始まらなくなる）
  flushRun(true);
}

// 保存は 1 秒に 1 回までに間引く（ステップごとに書くと IndexedDB が忙しくなる）
function flushRun(immediate) {
  if (!currentRun) return Promise.resolve();
  if (runSaveTimer) {
    clearTimeout(runSaveTimer);
    runSaveTimer = null;
  }
  if (immediate) return saveRunSafely({ ...currentRun });
  runSaveTimer = setTimeout(() => {
    runSaveTimer = null;
    if (currentRun) saveRunSafely({ ...currentRun });
  }, 1000);
  return Promise.resolve();
}

function logProgress(progress) {
  if (!currentRun) return;
  if (progress.marker === 'row' || progress.status === 'running' || progress.status === 'complete') return;
  currentRun.steps.push({
    rowIndex: progress.rowIndex || 0,
    index: progress.index,
    type: progress.step && progress.step.type,
    summary: progress.step ? safeSummary(progress.step) : '',
    status: progress.status,
    error: progress.error || null,
    fallback: progress.fallback || null,
    at: Date.now(),
  });
  flushRun(false);
}

function safeSummary(step) {
  try {
    return stepSummary(step);
  } catch (_) {
    return step.type || '';
  }
}

// 検証ステップの失敗を、利用者に読める文言にする
function assertMessage(info) {
  if (info.kind === 'text') return t('bg.assertTextFailed', { expected: info.expected, actual: info.actual });
  if (info.kind === 'visible') return t('bg.assertNotVisible', { selector: info.selector });
  return t('bg.assertStillThere', { selector: info.selector });
}

let lastFinishedRun = null;

async function finishRun(status, error) {
  if (!currentRun) return null;
  const failed = currentRun.steps.filter((s) => s.status === 'error').length;
  currentRun.finishedAt = Date.now();
  currentRun.failedCount = failed;
  currentRun.status = status === 'done' && failed ? 'failed' : status;
  if (error) currentRun.error = error;
  const finished = currentRun;
  await flushRun(true);
  lastFinishedRun = finished;
  currentRun = null;
  pruneRuns().catch(() => {});
  return finished;
}

// 再生中に出た alert / confirm / prompt を回収する（差し替え側が溜めている）
async function collectDialogs(tabId, stepIndex) {
  if (!currentRun) return;
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: () => {
          const list = window.__webrecDialogs || [];
          window.__webrecDialogs = [];
          return list;
        },
      }),
      3000
    );
    for (const r of results || []) {
      for (const d of Array.isArray(r.result) ? r.result : []) {
        currentRun.dialogs.push({ ...d, stepIndex, at: Date.now() });
      }
    }
  } catch (_) {
    /* 遷移直後などで読めないことがある。ログが欠けるだけなので握りつぶす */
  }
}

// opts:
//   tabId          … 既に開いているタブで再生する（ログイン済みの画面などを引き継ぐ）
//   keepCurrentUrl … 開始URLへ移動せず、今表示しているページから始める
//   startAtIndex   … 途中のステップから始める（手で済ませた前半を飛ばす）
// 同時に 2 本走らせると、同じタブを取り合って壊れる
let replayBusy = false;

async function replayRecording(id, onProgress, opts = {}) {
  if (replayBusy) throw new Error(t('bg.replayBusy'));
  replayBusy = true;
  try {
    const result = await runReplay(id, onProgress, opts);
    await finishRun('done');
    return result;
  } catch (err) {
    await finishRun('error', String(err && err.message ? err.message : err));
    throw err;
  } finally {
    replayBusy = false;
    stopDialogGuard();
  }
}

async function runReplay(id, onProgress, opts) {
  const rec = await getRecording(id);
  if (!rec) throw new Error(t('bg.recordingNotFound'));

  // グローバル設定に、その録画固有の設定を重ねた実効値で再生する
  const cfg = effectiveSettings(await getSettings(), rec);

  // テンプレート変数の基準時刻と連番は、1回の再生を通して固定する
  const baseCtx = { now: Date.now(), seq: await nextSeq() };

  // データセットがあれば、その行数分シナリオを繰り返す。無ければ1回だけ。
  const dataset = Array.isArray(rec.dataset) && rec.dataset.length ? rec.dataset : null;
  const rows = dataset || [null];

  const firstCtx = { ...baseCtx, data: rows[0], row: 1 };
  const firstUrl = resolveStepTemplates({ url: rec.startUrl }, firstCtx).url;

  const keepUrl = !!opts.keepCurrentUrl;
  const startAt = Number.isFinite(opts.startAtIndex) ? Math.max(0, opts.startAtIndex) : 0;

  beginRun(rec, opts, rows.length);
  // 進捗は画面と実行ログの両方へ流す
  const report = (progress) => {
    logProgress(progress);
    onProgress(progress);
  };

  let tab; // newTab ステップで別のタブに乗り換えることがある
  if (opts.tabId != null) {
    // 利用者が用意したタブ（ログイン済み、目的の画面を開いた状態など）をそのまま使う
    tab = await chrome.tabs.get(opts.tabId);
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } catch (_) {
      /* ウィンドウ操作に失敗しても再生自体は続行できる */
    }
    if (!keepUrl) {
      await chrome.tabs.update(tab.id, { url: firstUrl });
      await sleep(200);
    }
  } else {
    // 管理画面(進捗リスト)を見ながらでも再生の様子が隠れないよう、別ウィンドウで開く
    const win = await chrome.windows.create({ url: firstUrl, focused: true });
    tab = win.tabs[0];
  }
  // 開始URLの読み込みには時間がかかることがある。ここで無言のまま待つと
  // 「再生中の表示だけで何も起きない」ように見えるので、状態を出しておく。
  report({ marker: 'start', status: 'running' });
  await waitForTabReady(tab.id, cfg.pageLoadTimeoutMs);
  report({ marker: 'start', status: 'done' });
  await stubDialogs(tab.id); // ダイアログで止まらないようにしておく
  // 遷移のたびにダイアログ抑止を入れ直す（フレームが読み込み直されると消えるため）
  startDialogGuard(() => tab.id);
  await sleep(300);

  const total = rec.steps.length;
  let tabGone = false;

  for (let r = 0; r < rows.length && !tabGone; r++) {
    const tplCtx = { ...baseCtx, data: rows[r], row: r + 1 };
    // marker という別名にしている: port 送信時に { type: 'PROGRESS', ...progress } と
    // 展開されるため、ここで type を使うとメッセージ種別を上書きしてしまう。
    report({ marker: 'row', rowIndex: r, rowCount: rows.length, data: rows[r], status: 'running' });

    // 2行目以降は開始URLに戻してからシナリオをやり直す
    // （現在のページから始める指定のときは、状態を壊さないよう触らない）
    if (r > 0 && !keepUrl) {
      const startUrl = resolveStepTemplates({ url: rec.startUrl }, tplCtx).url;
      await chrome.tabs.update(tab.id, { url: startUrl });
      await sleep(200);
      await waitForTabReady(tab.id, cfg.pageLoadTimeoutMs);
      await stubDialogs(tab.id);
      await sleep(300);
    }

    for (let i = 0; i < total; i++) {
      const raw = rec.steps[i];

      // 無効化されたステップ、開始位置より前のステップ、および
      // 旧バージョンで誤って記録された WebRec 自身のUI操作は飛ばす
      const isOwnUi = typeof raw.selector === 'string' && raw.selector.includes('__webrec_overlay__');
      if (raw.disabled || isOwnUi || i < startAt) {
        report({ rowIndex: r, index: i, total, step: raw, status: 'skipped' });
        continue;
      }

      // {{date:...}} や {{data.列名}} をここで実際の値に置き換える。
      // {{totp:...}} は毎回その場で計算する必要があり、Web Crypto が非同期なので別経路。
      const step = await resolveStepTotp(resolveStepTemplates(raw, tplCtx), tplCtx);

      report({ rowIndex: r, index: i, total, step, status: 'running' });
      let outcome = null;
      try {
        // ステップ個別の事前待機（重い処理の後などに JSON へ手で足せる）
        if (Number.isFinite(step.waitBeforeMs) && step.waitBeforeMs > 0) {
          await sleep(step.waitBeforeMs);
        }

        if (step.type === 'wait') {
          await sleep(Number.isFinite(step.ms) ? step.ms : 1000);
        } else if (step.type === 'navigate') {
          // 直前のクリック等で自然に遷移が始まっている場合があるので、まず完了を待つ。
          await waitForTabReady(tab.id, cfg.pageLoadTimeoutMs);
          const current = await chrome.tabs.get(tab.id).catch(() => null);
          if (!current || current.url !== step.url) {
            // 自然遷移で辿り着いていない場合のみ、対象URLへ直接遷移させる。
            // 既に到達している場合に再遷移しないことで、POST 結果画面などを壊さない。
            await chrome.tabs.update(tab.id, { url: step.url });
            await sleep(200); // status が新しいナビゲーションに切り替わるのを少し待つ
            await waitForTabReady(tab.id, cfg.pageLoadTimeoutMs);
          }
          await stubDialogs(tab.id); // 遷移で window が入れ替わるので入れ直す
        } else if (step.type === 'newTab') {
          // 直前のクリックで開いたタブを掴む。既に開いていればそれを使う。
          const child = await waitForChildTab(tab.id, 5000);
          const opened =
            child || (await chrome.tabs.query({ openerTabId: tab.id })).slice(-1)[0] || null;
          if (!opened) throw new Error(t('bg.newTabNotOpened'));
          tab = opened;
          await waitForTabReady(tab.id, cfg.pageLoadTimeoutMs);
          await stubDialogs(tab.id);
          await chrome.tabs.update(tab.id, { active: true });
        } else {
          outcome = await executeStepWithRetry(tab.id, step, cfg);
          await collectDialogs(tab.id, i);
          if (outcome && outcome.assertFailed) throw new Error(assertMessage(outcome.assertFailed));
        }
        report({
          rowIndex: r,
          index: i,
          total,
          step,
          status: 'done',
          fallback: outcome && outcome.fallback ? outcome.fallback : null,
        });
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        // optional 指定のステップは、失敗しても警告扱いにして続行する
        report({
          rowIndex: r,
          index: i,
          total,
          step,
          status: step.optional ? 'warned' : 'error',
          error: message,
        });
        // 再生用のタブが無くなった後は、残り全部が同じ失敗になるだけなので打ち切る
        if (message === t('bg.tabGone')) {
          tabGone = true;
          break;
        }
      }
      await sleep(cfg.stepIntervalMs);
    }

    report({ marker: 'row', rowIndex: r, rowCount: rows.length, data: rows[r], status: 'done' });
  }

  report({ index: total, total, status: 'complete' });
}

// --- スケジュール実行 ---
// chrome.alarms で定期的に再生する。ブラウザが起動している間だけ動く。
// 予定は chrome.storage.local に持ち、変更のたびにアラームを作り直す。

// alarms 権限が反映されていない状態で読み込まれると chrome.alarms が無い。
// 例外を投げると service worker 全体が起動に失敗し、記録も再生も動かなくなる。
const alarmsAvailable = typeof chrome !== 'undefined' && !!chrome.alarms;

const SCHEDULE_KEY = 'webrec_schedules';
const ALARM_PREFIX = 'webrec-run:';

async function getSchedules() {
  try {
    const data = await chrome.storage.local.get(SCHEDULE_KEY);
    const list = data && data[SCHEDULE_KEY];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

async function setSchedules(list) {
  const clean = (Array.isArray(list) ? list : []).map((sc) => ({
    id: sc.id || crypto.randomUUID(),
    recordingId: String(sc.recordingId || ''),
    kind: sc.kind === 'interval' ? 'interval' : 'daily',
    at: typeof sc.at === 'string' && /^\d{1,2}:\d{2}$/.test(sc.at) ? sc.at : '09:00',
    everyMinutes: Math.max(1, Math.round(Number(sc.everyMinutes) || 60)),
    enabled: sc.enabled !== false,
    lastRunAt: sc.lastRunAt || null,
    lastStatus: sc.lastStatus || null,
    lastRunId: sc.lastRunId || null,
  }));
  await chrome.storage.local.set({ [SCHEDULE_KEY]: clean });
  await syncAlarms(clean);
  return clean;
}

// 次に "HH:MM" が来る時刻（今日の分を過ぎていれば明日）
function nextDailyTime(hhmm) {
  const [h, m] = String(hhmm || '09:00')
    .split(':')
    .map((v) => Number(v));
  const next = new Date();
  next.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function syncAlarms(list) {
  if (!alarmsAvailable) return;
  const schedules = list || (await getSchedules());
  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (alarm.name.startsWith(ALARM_PREFIX)) await chrome.alarms.clear(alarm.name);
  }
  for (const sc of schedules) {
    if (!sc.enabled || !sc.recordingId) continue;
    if (sc.kind === 'interval') {
      const mins = Math.max(1, sc.everyMinutes);
      chrome.alarms.create(ALARM_PREFIX + sc.id, { delayInMinutes: mins, periodInMinutes: mins });
    } else {
      chrome.alarms.create(ALARM_PREFIX + sc.id, { when: nextDailyTime(sc.at), periodInMinutes: 24 * 60 });
    }
  }
}

async function runScheduled(scheduleId) {
  await i18nReady;
  const list = await getSchedules();
  const sc = list.find((item) => item.id === scheduleId);
  if (!sc || !sc.enabled) return;

  lastFinishedRun = null;
  try {
    // 予定実行では画面の用意ができないため、常に新しいウィンドウで開始URLから流す
    await replayRecording(sc.recordingId, () => {}, { trigger: 'schedule' });
  } catch (err) {
    console.warn('WebRec: scheduled run failed', err);
  }
  const run = lastFinishedRun;
  await setSchedules(
    list.map((item) =>
      item.id === scheduleId
        ? {
            ...item,
            lastRunAt: Date.now(),
            lastStatus: run ? run.status : 'error',
            lastRunId: run ? run.id : null,
          }
        : item
    )
  );
}

if (!alarmsAvailable) {
  console.warn('WebRec: chrome.alarms is unavailable; schedules are disabled');
} else {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    runScheduled(alarm.name.slice(ALARM_PREFIX.length)).catch((err) =>
      console.warn('WebRec: schedule error', err)
    );
  });

  // 拡張機能の更新やブラウザ再起動でアラームが失われることがあるので張り直す
  chrome.runtime.onStartup.addListener(() => {
    syncAlarms().catch(() => {});
  });
  chrome.runtime.onInstalled.addListener(() => {
    syncAlarms().catch(() => {});
  });
}

// --- メッセージルーティング ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId ?? sender.tab?.id;
  (async () => {
    try {
      await i18nReady; // エラー文言を利用者の言語で返すため
      switch (message.type) {
        case 'GET_STATE': {
          sendResponse(await getState(tabId));
          break;
        }
        case 'START_RECORDING': {
          sendResponse(await startRecording({ tabId: message.tabId, startUrl: message.startUrl, name: message.name }));
          break;
        }
        case 'STOP_RECORDING': {
          sendResponse(await stopRecording());
          break;
        }
        case 'GET_SCHEDULES': {
          sendResponse({ ok: true, schedules: await getSchedules() });
          break;
        }
        case 'SET_SCHEDULES': {
          sendResponse({ ok: true, schedules: await setSchedules(message.schedules) });
          break;
        }
        case 'RECORD_EVENT': {
          await recordEvent(sender.tab?.id, message.step);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message: ' + message.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // 非同期で sendResponse するため
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'replay') return;
  port.onMessage.addListener((msg) => {
    if (msg.type !== 'START') return;
    replayRecording(
      msg.id,
      (progress) => {
        try {
          port.postMessage({ type: 'PROGRESS', ...progress });
        } catch (_) {
          /* port may be closed */
        }
      },
      {
        tabId: Number.isFinite(msg.tabId) ? msg.tabId : null,
        keepCurrentUrl: !!msg.keepCurrentUrl,
        startAtIndex: Number.isFinite(msg.startAtIndex) ? msg.startAtIndex : 0,
      }
    )
      .then(() => {
        try {
          port.postMessage({ type: 'DONE' });
        } catch (_) {}
      })
      .catch((err) => {
        try {
          port.postMessage({ type: 'ERROR', error: String(err && err.message ? err.message : err) });
        } catch (_) {}
      });
  });
});
