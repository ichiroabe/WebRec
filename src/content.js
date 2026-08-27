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
  let suppressNextClick = false; // ドラッグ直後の click を捨てるためのフラグ
  let suppressClickTimer = null;

  // content script は module ではないため i18n.js を import できない。
  // オーバーレイで使う2語だけをここに持つ。
  const OVERLAY_TEXT = {
    ja: { recording: 'WebRec 録画中', stop: '■ 停止' },
    en: { recording: 'WebRec recording', stop: '■ Stop' },
  };
  let overlayLang = 'ja';

  function loadOverlayLang() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('webrec_lang', (data) => {
          const saved = data && data.webrec_lang;
          if (OVERLAY_TEXT[saved]) overlayLang = saved;
          else overlayLang = String(navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  function cssEscape(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  // 属性セレクタの値（引用符の中）に入れる文字列のエスケープ。
  // cssEscape は識別子向けで "a[href=\"x\\.php\"]" のように読みにくくなるため、
  // 手で直すことの多いセレクタでは最小限のエスケープにする。
  function attrEscape(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Shadow DOM 対応: セレクタは「ホストを辿る道のり」を >>> で繋いだ形にする。
  // 例: my-field#host >>> #innerInput
  // document.querySelector は shadowRoot を貫通しないため、区間ごとに解決する。
  const SHADOW_SEP = ' >>> ';

  // 要素が属するツリーの根（document か ShadowRoot）
  function rootOf(el) {
    const root = el.getRootNode ? el.getRootNode() : document;
    return root || document;
  }

  function isUnique(sel, root) {
    try {
      return (root || document).querySelectorAll(sel).length === 1;
    } catch (_) {
      return false;
    }
  }

  // 同じツリー内（document か 1 つの shadowRoot 内）でのパスを組み立てる
  function buildCssPath(el, root) {
    const stop = root && root.host ? root : document;
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
      if (stop !== document && node === stop.host) break; // shadowRoot の境目で止める
    }
    return parts.join(' > ');
  }

  // 1 つのツリー内で要素を特定するセレクタ
  function selectorWithin(el, root) {
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) {
        const sel = `[${attr}="${cssEscape(v)}"]`;
        if (isUnique(sel, root)) return sel;
      }
    }
    if (el.id) {
      const sel = `#${cssEscape(el.id)}`;
      if (isUnique(sel, root)) return sel;
    }
    const name = el.getAttribute('name');
    if (name) {
      const sel = `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      if (isUnique(sel, root)) return sel;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const sel = `[aria-label="${cssEscape(aria)}"]`;
      if (isUnique(sel, root)) return sel;
    }
    return buildCssPath(el, root);
  }

  // 表示テキストで要素を指すための独自表記（CSS では書けない）。
  // 例: a:text("受信箱") / button:text("保存")
  function textSelector(tag, text) {
    return `${tag}:text("${attrEscape(text)}")`;
  }

  // 1つの要素を指す候補を優先順に並べる。再生時は上から順に試すので、
  // 「サイトの作りに紐づくもの」を先に、「並び順に依存するもの」を後ろに置く。
  // 記録した1本が外れただけで止まってしまうのを防ぐのが狙い。
  function getSelectorCandidates(el) {
    const primary = getSelector(el);
    if (!primary) return [];
    const root = rootOf(el);
    // shadow DOM をまたぐ場合は区間ごとの解決が要るため、候補は増やさない
    if (root && root.host) return [primary];

    const out = [];
    const tag = el.tagName.toLowerCase();
    const push = (sel) => {
      if (sel && !out.includes(sel) && isUnique(sel, root)) out.push(sel);
    };

    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) push(`[${attr}="${attrEscape(v)}"]`);
    }
    if (el.id) push(`#${cssEscape(el.id)}`);
    const name = el.getAttribute('name');
    if (name) push(`${tag}[name="${attrEscape(name)}"]`);
    const aria = el.getAttribute('aria-label');
    if (aria) push(`[aria-label="${attrEscape(aria)}"]`);
    // リンクやフォームの飛び先は、行が増減しても変わらないことが多い
    const href = el.getAttribute('href');
    if (href && href !== '#') push(`${tag}[href="${attrEscape(href)}"]`);
    // ボタンの表示文字は value 属性に入る
    if (tag === 'input') {
      const value = el.getAttribute('value');
      if (value) push(`input[value="${attrEscape(value)}"]`);
    }

    if (!out.includes(primary)) out.push(primary); // 位置パス（最後の砦）

    // 表示テキスト。リンクやボタンのように「文字で指せる」要素だけを対象にする。
    // select や textarea の innerText は選択肢や入力内容なので、指す手掛かりにならない。
    const TEXTLESS = ['select', 'textarea', 'input', 'option', 'iframe', 'frame', 'canvas'];
    if (!TEXTLESS.includes(tag)) {
      const label = (el.innerText || '').trim() || (el.getAttribute('aria-label') || '').trim();
      // 複数行に渡るものは要素の「名前」ではないので候補にしない
      if (label && !label.includes('\n')) out.push(textSelector(tag, label.slice(0, 60)));
    }
    return out;
  }

  // shadow root をまたぐ場合は、ホストごとのセレクタを >>> で連ねる
  function getSelector(el) {
    if (!(el instanceof Element)) return null;
    const segments = [];
    let node = el;
    for (let guard = 0; guard < 20; guard++) {
      const root = rootOf(node);
      segments.unshift(selectorWithin(node, root));
      if (!root || !root.host) break; // document に到達
      node = root.host;
    }
    return segments.join(SHADOW_SEP);
  }

  // 親ドキュメント側での要素の位置パス。frameElement は自分の document とは
  // 別のツリーに属するため、buildCssPath（自 document 前提）とは別に用意する。
  function cssPathInDoc(el, doc) {
    const parts = [];
    let node = el;
    for (let guard = 0; guard < 30 && node && node.nodeType === Node.ELEMENT_NODE; guard++) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${cssEscape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (!parent || node === doc.documentElement) break;
      node = parent;
    }
    return parts.join(' > ');
  }

  // frameElement（<iframe> でも <frameset> の <frame> でもありうる）を、
  // 親ドキュメントの中で一意に指すセレクタ。
  // タグ名を決め打ちにすると frameset 構成のサイトで必ず外れるため、
  // 実際のタグ名から組み立てる。
  function frameSelector(frameEl, parentDoc) {
    const tag = frameEl.tagName.toLowerCase();
    for (const attr of ['data-testid', 'id', 'name']) {
      const v = frameEl.getAttribute(attr);
      if (!v) continue;
      const candidate = attr === 'id' ? `${tag}#${cssEscape(v)}` : `${tag}[${attr}="${attrEscape(v)}"]`;
      try {
        if (parentDoc.querySelectorAll(candidate).length === 1) return candidate;
      } catch (_) {
        /* 不正なセレクタになった場合は位置パスに任せる */
      }
    }
    return cssPathInDoc(frameEl, parentDoc);
  }

  // フレーム内の要素を再生時に再び特定できるよう、最上位から自フレームまでの
  // フレームセレクタの連なりを記録しておく。
  function getFrameChain() {
    const chain = [];
    let win = window;
    for (let guard = 0; guard < 20 && win !== window.top; guard++) {
      let frameEl = null;
      try {
        frameEl = win.frameElement;
      } catch (_) {
        frameEl = null;
      }
      if (!frameEl) {
        // クロスオリジンで frameElement を読めない場合。URL で識別できるようにしておく。
        chain.unshift({ unresolved: true, url: win.location.href });
        break;
      }
      // frameElement は親ドキュメント側の要素なので、親のスコープで一意なセレクタを作る
      chain.unshift(frameSelector(frameEl, frameEl.ownerDocument));
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

  // ワンタイムパスワード欄の判定。
  // 標準の autocomplete="one-time-code" を第一に見て、無い場合は
  // name/id/placeholder/aria-label の語で推定する。
  // 「セキュリティコード」はカードの CVV と紛らわしいため意図的に含めていない
  const OTP_HINT = /(^|[^a-z])(otp|totp|mfa|2fa|onetime|one[-_]?time|verification[-_]?code|auth[-_]?code)/i;
  const OTP_HINT_JA = /(ワンタイム|認証コード|確認コード)/;

  function isOneTimeCodeField(el) {
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.includes('one-time-code')) return true;
    const hints = [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('data-testid'),
    ]
      .filter(Boolean)
      .join(' ');
    return OTP_HINT.test(hints) || OTP_HINT_JA.test(hints);
  }

  // shadow DOM 内で起きたイベントは e.target がホストに付け替えられるため、
  // composedPath() の先頭（実際に操作された要素）を使う。
  function realTarget(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    const first = path && path.length ? path[0] : e.target;
    return first instanceof Element ? first : e.target instanceof Element ? e.target : null;
  }

  // el を渡すと、その要素を指す代替セレクタも一緒に記録する。
  // selector（従来どおりの1本）は候補の先頭と同じで、古い録画との互換のために残す。
  function send(step, el) {
    const frames = getFrameChain();
    let selectors;
    if (el instanceof Element) {
      const candidates = getSelectorCandidates(el);
      if (candidates.length > 1) selectors = candidates;
    }
    chrome.runtime
      .sendMessage({
        type: 'RECORD_EVENT',
        step: {
          ...step,
          ...(selectors ? { selectors } : {}),
          frames: frames.length ? frames : undefined,
          timestamp: Date.now(),
        },
      })
      .catch(() => {});
  }

  function onClick(e) {
    const raw = realTarget(e);
    if (!raw) return;
    if (isOwnUi(raw)) return;
    if (suppressNextClick) {
      suppressNextClick = false; // ドラッグ操作として記録済み
      if (suppressClickTimer) {
        clearTimeout(suppressClickTimer);
        suppressClickTimer = null;
      }
      return;
    }
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
    send({ type: 'click', selector, tag, text: visibleText(target) }, target);
  }

  function onChange(e) {
    const target = realTarget(e);
    if (!target) return;
    if (isOwnUi(target)) return;
    const tag = target.tagName.toLowerCase();
    if (tag === 'select') {
      const selector = getSelector(target);
      if (!selector) return;
      if (target.multiple) {
        // 複数選択リストは選ばれている全ての値を保持する
        const values = Array.from(target.selectedOptions).map((o) => o.value);
        send({ type: 'selectMultiple', selector, values }, target);
      } else {
        send({ type: 'select', selector, value: target.value }, target);
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
      // ワンタイムパスワードは記録しても30秒で無効になるうえ、
      // 認証情報そのものなので保存しない。{{totp:...}} に書き換えて使う。
      const value = type === 'password' ? '<PASSWORD>' : isOneTimeCodeField(target) ? '<OTP>' : target.value;
      send({ type: 'input', selector, value }, target);
      return;
    }
    if (tag === 'textarea') {
      const selector = getSelector(target);
      if (!selector) return;
      send({ type: 'input', selector, value: target.value }, target);
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
      send({ type: 'upload', selector, files: [] }, target); // 選択を解除した操作
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
    send({ type: 'upload', selector, files }, target);
  }

  // 修飾キー単体は記録しない（Shift を押しただけ等）
  const MODIFIER_ONLY = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']);

  function onKeyDown(e) {
    const target = realTarget(e);
    if (!target) return;
    if (isOwnUi(target)) return;
    if (MODIFIER_ONLY.has(e.key)) return;

    const withModifier = e.ctrlKey || e.altKey || e.metaKey;
    const isSpecial = e.key.length > 1; // Enter, Tab, ArrowDown, F5 ...

    // 通常の文字入力は change で確定値を拾うので記録しない
    if (!withModifier && !isSpecial) return;

    // 文字入力中の Backspace / Delete も change に含まれるため冗長
    const tag = target.tagName.toLowerCase();
    const isTextField = tag === 'textarea' || (tag === 'input' && !/^(checkbox|radio|button|submit)$/i.test(target.type || ''));
    if (!withModifier && isTextField && (e.key === 'Backspace' || e.key === 'Delete')) return;

    const selector = getSelector(target);
    if (!selector) return;

    const step = { type: 'keydown', selector, key: e.key };
    if (e.ctrlKey) step.ctrlKey = true;
    if (e.altKey) step.altKey = true;
    if (e.shiftKey) step.shiftKey = true;
    if (e.metaKey) step.metaKey = true;
    send(step);
  }

  // --- ダブルクリック ---
  // click が2回先に送られているので、背景側でそれらを取り消してもらう
  function onDblClick(e) {
    const raw = realTarget(e);
    if (!raw) return;
    if (isOwnUi(raw)) return;
    const target = closestClickable(raw);
    const selector = getSelector(target);
    if (!selector) return;
    send({ type: 'dblclick', selector, text: visibleText(target), replacesClicks: 2 }, target);
  }

  // --- 右クリック ---
  function onContextMenu(e) {
    const raw = realTarget(e);
    if (!raw) return;
    if (isOwnUi(raw)) return;
    const target = closestClickable(raw);
    const selector = getSelector(target);
    if (!selector) return;
    send({ type: 'contextmenu', selector, text: visibleText(target) }, target);
  }

  // --- contenteditable（リッチテキストエディタ） ---
  // change イベントが無いので、フォーカスが外れた時点の内容を確定値として記録する。
  let editableTarget = null;
  let editableBefore = null;

  function editableRoot(el) {
    if (!(el instanceof Element)) return null;
    const host = el.closest('[contenteditable=""], [contenteditable="true"]');
    return host && host.isContentEditable ? host : null;
  }

  function onFocusIn(e) {
    const host = editableRoot(realTarget(e));
    if (!host || isOwnUi(host)) return;
    editableTarget = host;
    editableBefore = host.innerHTML;
  }

  function onFocusOut() {
    if (!editableTarget) return;
    const host = editableTarget;
    const before = editableBefore;
    editableTarget = null;
    editableBefore = null;
    if (host.innerHTML === before) return; // 変化なし
    const selector = getSelector(host);
    if (!selector) return;
    send({ type: 'editable', selector, html: host.innerHTML, text: (host.innerText || '').slice(0, 80) }, host);
  }

  // --- スクロール位置 ---
  // 遅延読み込みの画面で「見えていないと操作できない」ことがあるため記録する。
  let scrollTimer = null;

  function onScroll(e) {
    if (scrollTimer) clearTimeout(scrollTimer);
    const t = e.target;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (t === document || t === document.documentElement || t === document.body) {
        send({ type: 'scroll', x: Math.round(window.scrollX), y: Math.round(window.scrollY) });
        return;
      }
      if (!(t instanceof Element) || isOwnUi(t)) return;
      const selector = getSelector(t);
      if (!selector) return;
      send({ type: 'scroll', selector, x: Math.round(t.scrollLeft), y: Math.round(t.scrollTop) }, t);
    }, 400);
  }

  // --- マウスの軌跡（canvas への描画、mousedown 実装のドラッグ） ---
  // HTML5 の drag イベントを使わない実装でも再現できるよう、座標の列を残す。
  const DRAG_THRESHOLD_PX = 8;
  let pathPoints = null;
  let pathTarget = null;

  function localPoint(el, e) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const target = realTarget(e);
    if (!target || isOwnUi(target)) return;
    pathTarget = target;
    pathPoints = [localPoint(target, e)];
  }

  function onMouseMove(e) {
    if (!pathTarget || !pathPoints) return;
    const p = localPoint(pathTarget, e);
    const last = pathPoints[pathPoints.length - 1];
    if (Math.abs(p.x - last.x) < 2 && Math.abs(p.y - last.y) < 2) return; // 間引く
    if (pathPoints.length < 300) pathPoints.push(p);
  }

  function onMouseUp(e) {
    if (!pathTarget || !pathPoints) return;
    const target = pathTarget;
    const points = pathPoints;
    pathTarget = null;
    pathPoints = null;

    const first = points[0];
    const last = localPoint(target, e);
    const moved = Math.abs(last.x - first.x) + Math.abs(last.y - first.y);
    if (moved < DRAG_THRESHOLD_PX || points.length < 2) return; // ただのクリック

    if (dragSource) return; // HTML5 D&D 側で記録済み

    const selector = getSelector(target);
    if (!selector) return;
    points.push(last);
    // 直後の click は同じ操作なので捨てる。click が来ない場合に備えて自動で解除する。
    suppressNextClick = true;
    if (suppressClickTimer) clearTimeout(suppressClickTimer);
    suppressClickTimer = setTimeout(() => {
      suppressNextClick = false;
      suppressClickTimer = null;
    }, 500);
    send({ type: 'pointerPath', selector, points }, target);
  }

  // --- HTML5 ドラッグ&ドロップ（左右リスト間の移動などで使われる） ---
  function onDragStart(e) {
    const target = e.target;
    if (isOwnUi(target)) return;
    pathTarget = null; // HTML5 D&D 側で記録するので軌跡は捨てる
    pathPoints = null;
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
    label.textContent = OVERLAY_TEXT[overlayLang].recording;

    const stopBtn = document.createElement('button');
    stopBtn.textContent = OVERLAY_TEXT[overlayLang].stop;
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

  async function startListening() {
    if (recording) return;
    recording = true;
    await loadOverlayLang(); // オーバーレイを出す前に表示言語を確定させる
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
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
    document.removeEventListener('dblclick', onDblClick, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('dragstart', onDragStart, true);
    document.removeEventListener('drop', onDrop, true);
    removeOverlay();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 生存確認。background 側はこれに応答があるかで注入済みかを判断する。
    if (message.type === 'WEBREC_PING') {
      sendResponse({ ok: true });
      return;
    }
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
