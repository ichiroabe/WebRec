// WebRec: background service worker
// - 録画セッションの管理（開始/停止/イベント収集）
// - ページ遷移(navigate)の自動検知
// - 完了した録画を IndexedDB へ保存
// - 保存済み録画の再生（リプレイ）

import { saveRecording, getRecording, saveFile, getFile } from './db.js';
import { getSettings, effectiveSettings, nextSeq } from './settings.js';
import { resolveStepTemplates, resolveStepTotp } from './template.js';
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
async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(t('bg.tabGone'));
    if (tab.status === 'complete') return;
    if (Date.now() - start > timeoutMs) throw new Error(t('bg.loadTimeout'));
    await sleep(150);
  }
}

// content スクリプトのコンテキストで動く、ステップ実行の本体。
// executeScript 経由で全フレームに注入されるため、外側の変数を閉じ込めず自己完結させる。
// 各フレームは自身のフレーム位置が step.frames と一致する場合のみ実行する。
function performStepInPage(step) {
  const MSG = step.__msg || {}; // 呼び出し元が渡さなかった場合でも落ちないように

  function cssEscape(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  // content.js の getFrameChain と同じ規則でこのフレームの位置を求める
  function getFrameChain() {
    const chain = [];
    let win = window;
    while (win !== window.top) {
      let frameEl = null;
      try {
        frameEl = win.frameElement;
      } catch (_) {
        frameEl = null;
      }
      if (!frameEl) {
        chain.unshift({ unresolved: true, url: win.location.href });
        break;
      }
      const parentDoc = frameEl.ownerDocument;
      let sel = null;
      for (const attr of ['data-testid', 'id', 'name']) {
        const v = frameEl.getAttribute(attr);
        if (v) {
          const candidate = attr === 'id' ? `#${cssEscape(v)}` : `iframe[${attr}="${cssEscape(v)}"]`;
          if (parentDoc.querySelectorAll(candidate).length === 1) {
            sel = candidate;
            break;
          }
        }
      }
      if (!sel) {
        const all = Array.from(parentDoc.querySelectorAll('iframe'));
        sel = `iframe:nth-of-type(${all.indexOf(frameEl) + 1})`;
      }
      chain.unshift(sel);
      win = win.parent;
    }
    return chain;
  }

  const myChain = JSON.stringify(getFrameChain());
  const wantChain = JSON.stringify(step.frames || []);
  if (myChain !== wantChain) return { matched: false };

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

  function findEl(selector, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        let el = null;
        try {
          el = queryDeep(selector);
        } catch (e) {
          return reject(new Error((MSG.badSelector || '') + selector));
        }
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) {
          return reject(new Error((MSG.notFound || '') + selector));
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
      await findEl(step.selector, elementTimeout);
      return { matched: true };
    }

    if (step.type === 'upload') {
      const input = await findEl(step.selector, elementTimeout);
      const dt = new DataTransfer();
      for (const f of step.files || []) {
        if (!f.dataUrl) throw new Error((MSG.fileMissing || '') + f.name);
        dt.items.add(dataUrlToFile(f.dataUrl, f.name, f.mimeType));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { matched: true };
    }

    // ウィンドウ全体のスクロールは対象要素を持たない
    if (step.type === 'scroll' && !step.selector) {
      window.scrollTo({ left: step.x || 0, top: step.y || 0, behavior: 'instant' });
      return { matched: true };
    }

    const el = await findEl(step.selector, elementTimeout);
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
      const to = await findEl(step.toSelector, 8000);
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
    return { matched: true };
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
      await waitForTabComplete(tabId, cfg.pageLoadTimeoutMs);
      // iframe 内の操作もありうるため全フレームに注入し、該当フレームだけが実行する
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: performStepInPage,
        args: [
          {
            ...ready,
            __elementTimeoutMs: cfg.elementTimeoutMs,
            // 注入される関数からは t() を呼べないため、文言を渡しておく
            __msg: {
              badSelector: t('bg.badSelectorPrefix'),
              notFound: t('bg.notFoundPrefix'),
              fileMissing: t('bg.fileMissingPrefix'),
            },
          },
        ],
      });
      if (results.some((r) => r.result && r.result.matched)) return;
      lastErr = new Error(t('bg.frameNotFound'));
    } catch (err) {
      lastErr = err;
    }
    await sleep(500); // 遷移が始まっていた場合に落ち着くのを待つ
  }
  throw lastErr || new Error(t('bg.stepFailed'));
}

async function replayRecording(id, onProgress) {
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

  // 管理画面(進捗リスト)を見ながらでも再生の様子が隠れないよう、別ウィンドウで開く
  const win = await chrome.windows.create({ url: firstUrl, focused: true });
  let tab = win.tabs[0]; // newTab ステップで別のタブに乗り換えることがある
  await waitForTabComplete(tab.id, cfg.pageLoadTimeoutMs);
  await stubDialogs(tab.id); // ダイアログで止まらないようにしておく
  await sleep(300);

  const total = rec.steps.length;

  for (let r = 0; r < rows.length; r++) {
    const tplCtx = { ...baseCtx, data: rows[r], row: r + 1 };
    // marker という別名にしている: port 送信時に { type: 'PROGRESS', ...progress } と
    // 展開されるため、ここで type を使うとメッセージ種別を上書きしてしまう。
    onProgress({ marker: 'row', rowIndex: r, rowCount: rows.length, data: rows[r], status: 'running' });

    // 2行目以降は開始URLに戻してからシナリオをやり直す
    if (r > 0) {
      const startUrl = resolveStepTemplates({ url: rec.startUrl }, tplCtx).url;
      await chrome.tabs.update(tab.id, { url: startUrl });
      await sleep(200);
      await waitForTabComplete(tab.id, cfg.pageLoadTimeoutMs);
      await stubDialogs(tab.id);
      await sleep(300);
    }

    for (let i = 0; i < total; i++) {
      const raw = rec.steps[i];

      // 無効化されたステップ、および旧バージョンで誤って記録された WebRec 自身のUI操作は飛ばす
      const isOwnUi = typeof raw.selector === 'string' && raw.selector.includes('__webrec_overlay__');
      if (raw.disabled || isOwnUi) {
        onProgress({ rowIndex: r, index: i, total, step: raw, status: 'skipped' });
        continue;
      }

      // {{date:...}} や {{data.列名}} をここで実際の値に置き換える。
      // {{totp:...}} は毎回その場で計算する必要があり、Web Crypto が非同期なので別経路。
      const step = await resolveStepTotp(resolveStepTemplates(raw, tplCtx), tplCtx);

      onProgress({ rowIndex: r, index: i, total, step, status: 'running' });
      try {
        // ステップ個別の事前待機（重い処理の後などに JSON へ手で足せる）
        if (Number.isFinite(step.waitBeforeMs) && step.waitBeforeMs > 0) {
          await sleep(step.waitBeforeMs);
        }

        if (step.type === 'wait') {
          await sleep(Number.isFinite(step.ms) ? step.ms : 1000);
        } else if (step.type === 'navigate') {
          // 直前のクリック等で自然に遷移が始まっている場合があるので、まず完了を待つ。
          await waitForTabComplete(tab.id, cfg.pageLoadTimeoutMs);
          const current = await chrome.tabs.get(tab.id).catch(() => null);
          if (!current || current.url !== step.url) {
            // 自然遷移で辿り着いていない場合のみ、対象URLへ直接遷移させる。
            // 既に到達している場合に再遷移しないことで、POST 結果画面などを壊さない。
            await chrome.tabs.update(tab.id, { url: step.url });
            await sleep(200); // status が新しいナビゲーションに切り替わるのを少し待つ
            await waitForTabComplete(tab.id, cfg.pageLoadTimeoutMs);
          }
          await stubDialogs(tab.id); // 遷移で window が入れ替わるので入れ直す
        } else if (step.type === 'newTab') {
          // 直前のクリックで開いたタブを掴む。既に開いていればそれを使う。
          const child = await waitForChildTab(tab.id, 5000);
          const opened =
            child || (await chrome.tabs.query({ openerTabId: tab.id })).slice(-1)[0] || null;
          if (!opened) throw new Error(t('bg.newTabNotOpened'));
          tab = opened;
          await waitForTabComplete(tab.id, cfg.pageLoadTimeoutMs);
          await stubDialogs(tab.id);
          await chrome.tabs.update(tab.id, { active: true });
        } else {
          await executeStepWithRetry(tab.id, step, cfg);
        }
        onProgress({ rowIndex: r, index: i, total, step, status: 'done' });
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        // optional 指定のステップは、失敗しても警告扱いにして続行する
        onProgress({
          rowIndex: r,
          index: i,
          total,
          step,
          status: step.optional ? 'warned' : 'error',
          error: message,
        });
      }
      await sleep(cfg.stepIntervalMs);
    }

    onProgress({ marker: 'row', rowIndex: r, rowCount: rows.length, data: rows[r], status: 'done' });
  }

  onProgress({ index: total, total, status: 'complete' });
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
    replayRecording(msg.id, (progress) => {
      try {
        port.postMessage({ type: 'PROGRESS', ...progress });
      } catch (_) {
        /* port may be closed */
      }
    })
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
