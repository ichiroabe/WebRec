// WebRec: background service worker
// - 録画セッションの管理（開始/停止/イベント収集）
// - ページ遷移(navigate)の自動検知
// - 完了した録画を IndexedDB へ保存
// - 保存済み録画の再生（リプレイ）

import { saveRecording, getRecording, saveFile, getFile } from './db.js';
import { getSettings, effectiveSettings, nextSeq } from './settings.js';
import { resolveStepTemplates } from './template.js';

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

async function startRecording({ tabId, startUrl, name }) {
  await restoreSession();
  if (session) {
    throw new Error('すでに録画中です');
  }
  session = {
    id: crypto.randomUUID(),
    tabId,
    startUrl,
    name: name || `録画 ${new Date().toLocaleString('ja-JP')}`,
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
    return { ok: false, error: '録画は開始されていません' };
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
    if (!tab) throw new Error('タブが見つかりません');
    if (tab.status === 'complete') return;
    if (Date.now() - start > timeoutMs) throw new Error('ページ読み込みがタイムアウトしました');
    await sleep(150);
  }
}

// content スクリプトのコンテキストで動く、ステップ実行の本体。
// executeScript 経由で全フレームに注入されるため、外側の変数を閉じ込めず自己完結させる。
// 各フレームは自身のフレーム位置が step.frames と一致する場合のみ実行する。
function performStepInPage(step) {
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

  function findEl(selector, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        let el = null;
        try {
          el = document.querySelector(selector);
        } catch (e) {
          return reject(new Error('不正なセレクタ: ' + selector));
        }
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) {
          return reject(new Error('要素が見つかりません: ' + selector));
        }
        setTimeout(poll, 150);
      })();
    });
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
        if (!f.dataUrl) throw new Error(`ファイルの中身が保存されていません: ${f.name}`);
        dt.items.add(dataUrlToFile(f.dataUrl, f.name, f.mimeType));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { matched: true };
    }

    const el = await findEl(step.selector, elementTimeout);
    el.scrollIntoView({ block: 'center', inline: 'center' });

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
      el.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: step.key, bubbles: true, cancelable: true }));
    }
    return { matched: true };
  })();
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
          ? `ファイルが大きすぎて保存されていません: ${f.name}`
          : `ファイルの中身が保存されていません: ${f.name}`
      );
    }
    const stored = await getFile(f.fileId);
    if (!stored || !stored.dataUrl) throw new Error(`保存済みファイルが見つかりません: ${f.name}`);
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
        args: [{ ...ready, __elementTimeoutMs: cfg.elementTimeoutMs }],
      });
      if (results.some((r) => r.result && r.result.matched)) return;
      lastErr = new Error('対象のフレームが見つかりません');
    } catch (err) {
      lastErr = err;
    }
    await sleep(500); // 遷移が始まっていた場合に落ち着くのを待つ
  }
  throw lastErr || new Error('ステップを実行できませんでした');
}

async function replayRecording(id, onProgress) {
  const rec = await getRecording(id);
  if (!rec) throw new Error('録画が見つかりません');

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
  const tab = win.tabs[0];
  await waitForTabComplete(tab.id, cfg.pageLoadTimeoutMs);
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

      // {{date:...}} や {{data.列名}} をここで実際の値に置き換える
      const step = resolveStepTemplates(raw, tplCtx);

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
