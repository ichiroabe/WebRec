const idleView = document.getElementById('idleView');
const recordingView = document.getElementById('recordingView');
const doneView = document.getElementById('doneView');
const errorMsg = document.getElementById('errorMsg');

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
    document.getElementById('stepCount').textContent = state.stepCount;
    document.getElementById('startUrlHint').textContent = `開始URL: ${state.startUrl}`;
    showView(recordingView);
  } else if (state && state.isRecording && !state.isCurrentTab) {
    document.getElementById('idleView').querySelector('.hint').textContent =
      '別のタブで記録中です。そのタブを開いて操作を続けてください。';
    showView(idleView);
    document.getElementById('startBtn').disabled = true;
  } else {
    showView(idleView);
  }
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    showError('このページでは記録を開始できません（http/https のページで開始してください）');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id, startUrl: tab.url });
  if (!res || !res.ok) {
    showError(res?.error || '記録を開始できませんでした');
    return;
  }
  window.close();
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  if (!res || !res.ok) {
    showError(res?.error || '記録を停止できませんでした');
    return;
  }
  document.getElementById('doneMessage').textContent = `保存しました（${res.stepCount} ステップ）`;
  showView(doneView);
});

function openManager() {
  chrome.runtime.openOptionsPage();
}

document.getElementById('openManagerBtn').addEventListener('click', openManager);
document.getElementById('openManagerFromDone').addEventListener('click', openManager);

refresh();

// 記録中はステップ数を軽く更新し続ける
setInterval(() => {
  if (!recordingView.classList.contains('hidden')) refresh();
}, 1000);
