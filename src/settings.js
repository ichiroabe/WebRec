// WebRec: 再生時の待ち時間などの設定。
// 設定は 3 段階で解決される（後のものが優先）:
//   1. グローバル設定（この画面で編集、chrome.storage.local に保存）
//   2. 録画ごとの設定（recording.settings）
//   3. ステップごとの指定（step.timeoutMs / step.waitBeforeMs など）

const STORAGE_KEY = 'webrec_settings';

export const DEFAULT_SETTINGS = {
  pageLoadTimeoutMs: 60000, // ページ読み込み完了を待つ上限
  elementTimeoutMs: 8000, // 要素が現れるまで待つ上限
  stepIntervalMs: 350, // 各ステップの後に置く間隔
  injectRetries: 3, // 遷移中などで失敗した際のリトライ回数
};

// label / hint は表示のたびに t() で引く（言語切り替えに追従させるため）
export const SETTING_FIELDS = [
  { key: 'pageLoadTimeoutMs', labelKey: 'settings.pageLoadTimeout', hintKey: 'settings.pageLoadTimeoutHint', min: 1000, max: 600000 },
  { key: 'elementTimeoutMs', labelKey: 'settings.elementTimeout', hintKey: 'settings.elementTimeoutHint', min: 500, max: 600000 },
  { key: 'stepIntervalMs', labelKey: 'settings.stepInterval', hintKey: 'settings.stepIntervalHint', min: 0, max: 60000 },
  { key: 'injectRetries', labelKey: 'settings.injectRetries', hintKey: 'settings.injectRetriesHint', min: 1, max: 10 },
];

function sanitize(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const field of SETTING_FIELDS) {
    const v = Number(raw[field.key]);
    if (Number.isFinite(v)) {
      out[field.key] = Math.min(field.max, Math.max(field.min, Math.round(v)));
    }
  }
  return out;
}

export async function getSettings() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return sanitize(data && data[STORAGE_KEY]);
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(partial) {
  const merged = sanitize({ ...(await getSettings()), ...partial });
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  return merged;
}

export async function resetSettings() {
  await chrome.storage.local.remove(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS };
}

// グローバル設定に、その録画固有の設定を重ねた実効値を返す
export function effectiveSettings(globalSettings, recording) {
  return sanitize({ ...globalSettings, ...(recording && recording.settings) });
}

// --- {{seq}} の通し番号 ---
// 再生1回につき1つ採番し、その実行中は同じ値を使う。再生をまたいで increment される。
const SEQ_KEY = 'webrec_seq';

// 次の再生で使われる値（まだ採番していない値）を返す
export async function peekSeq() {
  try {
    const data = await chrome.storage.local.get(SEQ_KEY);
    return (Number(data && data[SEQ_KEY]) || 0) + 1;
  } catch (_) {
    return 1;
  }
}

// 次の再生で使う値を指定する（1 を渡せば次回は 1 から始まる）
export async function setNextSeq(next) {
  const n = Math.max(1, Math.round(Number(next) || 1));
  try {
    await chrome.storage.local.set({ [SEQ_KEY]: n - 1 });
  } catch (_) {
    /* 保存できなくても再生自体は続けられる */
  }
  return n;
}

// 採番して確定する（再生開始時に呼ぶ）
export async function nextSeq() {
  try {
    const data = await chrome.storage.local.get(SEQ_KEY);
    const next = (Number(data && data[SEQ_KEY]) || 0) + 1;
    await chrome.storage.local.set({ [SEQ_KEY]: next });
    return next;
  } catch (_) {
    return 1;
  }
}
