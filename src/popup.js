import { initI18n, applyI18n, t, getLang, setLang, LANGS } from './i18n.js';

const idleView = document.getElementById('idleView');
const recordingView = document.getElementById('recordingView');
const doneView = document.getElementById('doneView');
const errorMsg = document.getElementById('errorMsg');
const idleHint = document.getElementById('idleHint');

function showView(view) {
  for (const v of [idleView, recordingView, doneView]) {
    v.classList.toggle('hidden', v !== view);
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const tab = await getActiveTab();
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: tab?.id });
  if (state && state.isRecording && state.isCurrentTab) {
    document.getElementById('stepCount').textContent = t('popup.stepCount', { n: state.stepCount });
    document.getElementById('startUrlHint').textContent = t('popup.startUrl', { url: state.startUrl });
    showView(recordingView);
  } else if (state && state.isRecording && !state.isCurrentTab) {
    idleHint.textContent = t('popup.otherTabHint');
    showView(idleView);
    document.getElementById('startBtn').disabled = true;
  } else {
    showView(idleView);
  }
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    showError(t('popup.errNotHttp'));
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id, startUrl: tab.url });
  if (!res || !res.ok) {
    showError(res?.error || t('popup.errStart'));
    return;
  }
  window.close();
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  if (!res || !res.ok) {
    showError(res?.error || t('popup.errStop'));
    return;
  }
  document.getElementById('doneMessage').textContent = t('popup.savedWithSteps', { n: res.stepCount });
  showView(doneView);
});

function openManager() {
  chrome.runtime.openOptionsPage();
}

document.getElementById('openManagerBtn').addEventListener('click', openManager);
document.getElementById('openManagerFromDone').addEventListener('click', openManager);

// --- 言語切り替え ---
const langSelect = document.getElementById('langSelect');

langSelect.addEventListener('change', async () => {
  await setLang(langSelect.value);
  location.reload();
});

(async function start() {
  await initI18n(); // 文言を確定させてから描画する
  applyI18n();
  for (const lang of LANGS) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    opt.selected = lang.code === getLang();
    langSelect.appendChild(opt);
  }
  await refresh();
})();

// 記録中はステップ数を軽く更新し続ける
setInterval(() => {
  if (!recordingView.classList.contains('hidden')) refresh();
}, 1000);
