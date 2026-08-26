// WebRec: content script
// 録画中のみ DOM イベントを監視し、background へステップを送信する。
// 通常のページには一切影響を与えない（録画OFF時はリスナーなし）。
// all_frames: true のため iframe 内でも動作する。オーバーレイUIは最上位フレームのみに出す。

(function () {
  if (window.__webrecInjected) return;
  window.__webrecInjected = true;

  const IS_TOP = window.top === window;

  let recording = false;
  let overlayEl = null;
  let dragSource = null;

  function cssEscape(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function isUnique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (_) {
      return false;
    }
  }

  function buildCssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${cssEscape(node.id)}`;
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function getSelector(el) {
    if (!(el instanceof Element)) return null;
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) {
        const sel = `[${attr}="${cssEscape(v)}"]`;
        if (isUnique(sel)) return sel;
      }
    }
    if (el.id) {
      const sel = `#${cssEscape(el.id)}`;
      if (isUnique(sel)) return sel;
    }
    const name = el.getAttribute('name');
    if (name) {
      const sel = `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      if (isUnique(sel)) return sel;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const sel = `[aria-label="${cssEscape(aria)}"]`;
      if (isUnique(sel)) return sel;
    }
    return buildCssPath(el);
  }

  // iframe 内の要素を再生時に再び特定できるよう、最上位から自フレームまでの
  // iframe セレクタの連なりを記録しておく。
  function getFrameChain() {
    const chain = [];
    let win = window;
    while (win !== window.top) {
      const frameEl = win.frameElement;
      if (!frameEl) {
        // クロスオリジンで frameElement を読めない場合。URL で識別できるようにしておく。
        chain.unshift({ unresolved: true, url: win.location.href });
        break;
      }
      // frameElement は親ドキュメント側の要素なので、親のスコープで一意なセレクタを作る
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

  function visibleText(el) {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    return t ? t.slice(0, 60) : '';
  }

  const CLICKABLE_SELECTOR =
    'button, a, [role="button"], input[type="button"], input[type="submit"], ' +
    'input[type="checkbox"], input[type="radio"], select, label, summary';

  function closestClickable(el) {
    return el.closest(CLICKABLE_SELECTOR) || el;
  }

  // WebRec 自身のオーバーレイUI（停止ボタンなど）への操作は記録対象外。
  // 記録してしまうと、再生時に存在しない要素を探して失敗する。
  function isOwnUi(el) {
    return el instanceof Element && !!el.closest('#__webrec_overlay__');
  }

  function send(step) {
    const frames = getFrameChain();
    chrome.runtime
      .sendMessage({
        type: 'RECORD_EVENT',
        step: { ...step, frames: frames.length ? frames : undefined, timestamp: Date.now() },
      })
      .catch(() => {});
  }

  function onClick(e) {
    const raw = e.target;
    if (!(raw instanceof Element)) return;
    if (isOwnUi(raw)) return;
    const target = closestClickable(raw);
    const tag = target.tagName.toLowerCase();
    // テキスト入力系は click だけでは意味がある操作にならないためスキップ（input/change 側で拾う）
    if (
      tag === 'input' &&
      !['button', 'submit', 'checkbox', 'radio'].includes((target.getAttribute('type') || 'text').toLowerCase())
    ) {
      return;
    }
    if (tag === 'textarea') return;
    if (tag === 'select') return; // 選択操作は change イベント側で 'select' ステップとして記録する
    const selector = getSelector(target);
    if (!selector) return;
    send({ type: 'click', selector, tag, text: visibleText(target) });
  }

  function onChange(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (isOwnUi(target)) return;
    const tag = target.tagName.toLowerCase();
    if (tag === 'select') {
      const selector = getSelector(target);
      if (!selector) return;
      if (target.multiple) {
        // 複数選択リストは選ばれている全ての値を保持する
        const values = Array.from(target.selectedOptions).map((o) => o.value);
        send({ type: 'selectMultiple', selector, values });
      } else {
        send({ type: 'select', selector, value: target.value });
      }
      return;
    }
    if (tag === 'input') {
      const type = (target.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') return; // click で再現済み
      const selector = getSelector(target);
      if (!selector) return;
      if (type === 'file') {
        // value は "C:\fakepath\..." にしかならないため、中身そのものを取り込む
        recordFileInput(target, selector);
        return;
      }
      const value = type === 'password' ? '<PASSWORD>' : target.value;
      send({ type: 'input', selector, value });
      return;
    }
    if (tag === 'textarea') {
      const selector = getSelector(target);
      if (!selector) return;
      send({ type: 'input', selector, value: target.value });
    }
  }

  // --- ファイルアップロード ---
  // OS のファイル選択ダイアログ自体は自動化できないが、選ばれたファイルの中身を
  // 記録しておけば、再生時に input.files へ直接流し込んで同じ状態を作れる。
  const MAX_EMBED_BYTES = 8 * 1024 * 1024; // 1ステップあたりの取り込み上限

  function readAsDataUrl(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  async function recordFileInput(target, selector) {
    const picked = Array.from(target.files || []);
    if (!picked.length) {
      send({ type: 'upload', selector, files: [] }); // 選択を解除した操作
      return;
    }

    const total = picked.reduce((sum, f) => sum + f.size, 0);
    const tooBig = total > MAX_EMBED_BYTES;

    const files = [];
    for (const f of picked) {
      const meta = { name: f.name, mimeType: f.type || 'application/octet-stream', size: f.size };
      // 大きすぎる場合は中身を取り込まず、ファイル名だけ残す（再生時に警告になる）
      if (!tooBig) {
        const dataUrl = await readAsDataUrl(f);
        if (dataUrl) meta.dataUrl = dataUrl;
        else meta.omitted = 'read-failed';
      } else {
        meta.omitted = 'too-large';
      }
      files.push(meta);
    }
    send({ type: 'upload', selector, files });
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (isOwnUi(target)) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    const selector = getSelector(target);
    if (!selector) return;
    send({ type: 'keydown', selector, key: e.key });
  }

  // --- HTML5 ドラッグ&ドロップ（左右リスト間の移動などで使われる） ---
  function onDragStart(e) {
    const target = e.target;
    if (isOwnUi(target)) return;
    dragSource = target instanceof Element ? getSelector(target) : null;
  }

  function onDrop(e) {
    const target = e.target;
    if (isOwnUi(target)) return;
    if (!dragSource || !(target instanceof Element)) return;
    const toSelector = getSelector(target);
    if (!toSelector) return;
    send({ type: 'dragAndDrop', selector: dragSource, toSelector });
    dragSource = null;
  }

  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = '__webrec_overlay__';
    overlayEl.style.cssText = [
      'position:fixed',
      'top:12px',
      'right:12px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'background:rgba(30,30,30,0.92)',
      'color:#fff',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'padding:6px 8px 6px 12px',
      'border-radius:999px',
      'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
      'pointer-events:auto',
      'user-select:none',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText =
      'width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block;animation:__webrec_pulse 1.2s infinite';
    const style = document.createElement('style');
    style.textContent = '@keyframes __webrec_pulse{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}';
    document.head?.appendChild(style);

    const label = document.createElement('span');
    label.textContent = 'WebRec 録画中';

    const stopBtn = document.createElement('button');
    stopBtn.textContent = '■ 停止';
    stopBtn.style.cssText =
      'background:#dc2626;color:#fff;border:none;border-radius:999px;padding:3px 10px;font:inherit;cursor:pointer';
    stopBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});
    });

    overlayEl.append(dot, label, stopBtn);
    (document.body || document.documentElement).appendChild(overlayEl);
  }

  function removeOverlay() {
    overlayEl?.remove();
    overlayEl = null;
  }

  function startListening() {
    if (recording) return;
    recording = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('drop', onDrop, true);
    if (!IS_TOP) return; // オーバーレイは最上位フレームだけに表示する
    if (document.body) ensureOverlay();
    else document.addEventListener('DOMContentLoaded', ensureOverlay, { once: true });
  }

  function stopListening() {
    if (!recording) return;
    recording = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('dragstart', onDragStart, true);
    document.removeEventListener('drop', onDrop, true);
    removeOverlay();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'WEBREC_START') startListening();
    if (message.type === 'WEBREC_STOP') stopListening();
  });

  // ページ読み込み直後、すでに録画中セッションがあれば継続する（別ページへの遷移後など）
  chrome.runtime
    .sendMessage({ type: 'GET_STATE' })
    .then((state) => {
      if (state && state.isRecording && state.isCurrentTab) startListening();
    })
    .catch(() => {});
})();
