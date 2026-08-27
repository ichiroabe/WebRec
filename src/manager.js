import {
  getAllRecordings,
  updateRecording,
  saveRecording,
  saveFile,
  getFile,
  deleteRecordingWithFiles,
  getAllRuns,
  deleteRun,
  clearRuns,
} from './db.js';
import {
  generateScript,
  stepSummary,
  generateJson,
  parseRecordingJson,
  validateDataset,
  parseDelimitedText,
} from './generator.js';
import { getSettings, saveSettings, resetSettings, SETTING_FIELDS, peekSeq, setNextSeq } from './settings.js';
import { previewTemplate, TEMPLATE_HELP, helpSyntax } from './template.js';
import { validateRecording, summarize } from './validate.js';
import { initI18n, applyI18n, t, getLang, setLang, LANGS } from './i18n.js';

const recordingsBody = document.getElementById('recordingsBody');
const emptyState = document.getElementById('emptyState');
const countLabel = document.getElementById('countLabel');

let currentList = [];
let currentDetailId = null;
let currentFormat = 'steps'; // 'steps' | 'playwright' | 'puppeteer' | 'json'

function fmtDate(ts) {
  return new Date(ts).toLocaleString(getLang() === 'ja' ? 'ja-JP' : 'en-US');
}

async function refreshList() {
  currentList = await getAllRecordings();
  countLabel.textContent = currentList.length ? t('list.count', { n: currentList.length }) : '';
  emptyState.classList.toggle('hidden', currentList.length > 0);
  recordingsBody.innerHTML = '';
  for (const rec of currentList) {
    recordingsBody.appendChild(buildRow(rec));
  }
}

function buildRow(rec) {
  const tr = document.createElement('tr');

  const nameTd = document.createElement('td');
  nameTd.className = 'name-cell';
  const nameInput = document.createElement('input');
  nameInput.className = 'name-input';
  nameInput.value = rec.name;
  nameInput.title = t('list.renameTitle');
  nameInput.setAttribute('aria-label', t('list.nameAria'));

  // 変更は blur / Enter で確定する。行の再描画はせず、その場で反映してフォーカスを保つ。
  nameInput.addEventListener('change', async () => {
    const next = nameInput.value.trim();
    if (!next) {
      nameInput.value = rec.name; // 空の名前は許可しない
      return;
    }
    if (next === rec.name) return;
    await updateRecording(rec.id, { name: next });
    rec.name = next; // 詳細ダイアログなど他の表示と食い違わないよう手元も更新
    nameInput.value = next;
    nameInput.classList.add('saved');
    setTimeout(() => nameInput.classList.remove('saved'), 900);
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur(); // blur で change が走り確定する
    } else if (e.key === 'Escape') {
      e.preventDefault();
      nameInput.value = rec.name; // 値を戻すので change は発火しない
      nameInput.blur();
    }
  });

  nameTd.appendChild(nameInput);

  const urlTd = document.createElement('td');
  urlTd.className = 'url-cell';
  urlTd.textContent = rec.startUrl;
  urlTd.title = rec.startUrl;

  const dateTd = document.createElement('td');
  dateTd.textContent = fmtDate(rec.createdAt);

  const stepsTd = document.createElement('td');
  stepsTd.textContent = String(rec.steps.length);

  const actionsTd = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  const viewBtn = document.createElement('button');
  viewBtn.textContent = t('list.view');
  viewBtn.addEventListener('click', () => openDetail(rec.id));

  const replayBtn = document.createElement('button');
  replayBtn.textContent = t('list.replay');
  replayBtn.addEventListener('click', () => openReplayOptions(rec));

  const delBtn = document.createElement('button');
  delBtn.textContent = t('common.delete');
  delBtn.className = 'danger';
  delBtn.addEventListener('click', async () => {
    if (!confirm(t('list.confirmDelete', { name: rec.name }))) return;
    await deleteRecordingWithFiles(rec.id); // 他の録画で使っていないファイルも片付ける
    refreshList();
  });

  wrap.append(viewBtn, replayBtn, delBtn);
  actionsTd.appendChild(wrap);

  tr.append(nameTd, urlTd, dateTd, stepsTd, actionsTd);
  return tr;
}

// --- 詳細モーダル ---
const detailModal = document.getElementById('detailModal');
const detailTitle = document.getElementById('detailTitle');
const stepsPanel = document.getElementById('stepsPanel');
const codePanel = document.getElementById('codePanel');
const stepsList = document.getElementById('stepsList');
const codeView = document.getElementById('codeView');
const copyMsg = document.getElementById('copyMsg');

function openDetail(id) {
  currentDetailId = id;
  currentFormat = 'steps';
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'steps'));
  renderDetail();
  detailModal.classList.remove('hidden');
}

function getCurrentRecording() {
  return currentList.find((r) => r.id === currentDetailId);
}

const jsonPanel = document.getElementById('jsonPanel');
const jsonEditor = document.getElementById('jsonEditor');
const jsonError = document.getElementById('jsonError');
const saveJsonBtn = document.getElementById('saveJsonBtn');
const revertJsonBtn = document.getElementById('revertJsonBtn');
const validateBtn = document.getElementById('validateBtn');
const validationBox = document.getElementById('validationBox');
const validationSummary = document.getElementById('validationSummary');
const validationList = document.getElementById('validationList');

// 検証結果を一覧表示する。ステップに紐づく指摘はクリックでその位置へ飛べる。
function showValidation(result) {
  validationSummary.textContent = summarize(result);
  validationSummary.className = result.errors.length ? 'has-error' : result.warnings.length ? 'has-warning' : 'has-ok';
  validationList.innerHTML = '';

  for (const item of result.issues) {
    const li = document.createElement('li');
    li.className = `v-${item.level}`;

    const badge = document.createElement('span');
    badge.className = 'v-badge';
    badge.textContent = { error: t('json.levelError'), warning: t('json.levelWarning'), info: t('json.levelInfo') }[item.level];
    li.appendChild(badge);
    li.appendChild(document.createTextNode(' ' + item.message));

    if (Number.isFinite(item.stepIndex)) {
      li.classList.add('clickable');
      li.title = t('json.issueJumpHint');
      li.addEventListener('click', () => {
        selectInEditor(findStepRange(jsonEditor.value, item.stepIndex));
      });
    }
    validationList.appendChild(li);
  }
  validationBox.classList.remove('hidden');
}

// 編集中のテキストを対象に検証する。JSON として壊れている場合はその旨だけ返す。
function runValidation() {
  let parsed;
  try {
    parsed = parseRecordingJson(jsonEditor.value);
  } catch (err) {
    jsonError.textContent = String(err.message || err);
    jsonError.classList.remove('hidden');
    validationBox.classList.add('hidden');
    return null;
  }
  jsonError.classList.add('hidden');
  const result = validateRecording(parsed);
  showValidation(result);
  return result;
}

// テンプレート変数のヘルプ表（言語切り替え後に描き直せるよう関数にしてある）
function renderTemplateHelp() {
  const table = document.getElementById('tplHelpTable');
  table.innerHTML = '';
  for (const item of TEMPLATE_HELP) {
    const syntax = helpSyntax(item, getLang());
    const tr = document.createElement('tr');

    const code = document.createElement('td');
    const codeEl = document.createElement('code');
    codeEl.textContent = syntax;
    code.appendChild(codeEl);

    const desc = document.createElement('td');
    desc.textContent = t(item.descKey);

    const now = document.createElement('td');
    now.className = 'tpl-preview';
    now.textContent = previewTemplate(syntax) ?? '';

    tr.append(code, desc, now);
    table.appendChild(tr);
  }
}

// ステップ一覧から待機ステップを差し込む（JSON を手で書かなくて済むように）
async function insertWaitBefore(index) {
  const rec = getCurrentRecording();
  if (!rec) return;

  const answer = prompt(t('steps.insertWaitPrompt'), '3');
  if (answer === null) return;

  const seconds = Number(String(answer).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    alert(t('steps.insertWaitInvalid'));
    return;
  }

  const steps = [...rec.steps];
  steps.splice(index, 0, { type: 'wait', ms: Math.round(seconds * 1000) });
  await updateRecording(rec.id, { steps });
  await refreshList();
  await renderDetail();
  flashCopyMsg(t('steps.insertWaitDone', { sec: seconds }));
}

// ステップ一覧から検証ステップを差し込む。
// 「この時点でこの文言が出ているはず」を JSON を書かずに足せるようにする。
async function insertAssertAfter(index) {
  const rec = getCurrentRecording();
  if (!rec) return;
  const step = rec.steps[index];
  const target = step && (step.selector || (step.selectors && step.selectors[0]));
  if (!target) {
    alert(t('steps.insertAssertNoTarget'));
    return;
  }

  const answer = prompt(t('steps.insertAssertPrompt', { selector: target }), step.text || '');
  if (answer === null) return;
  const value = String(answer).trim();
  if (!value) {
    alert(t('steps.insertAssertEmpty'));
    return;
  }

  const assertStep = {
    type: 'assertText',
    selector: step.selector,
    ...(step.selectors ? { selectors: step.selectors } : {}),
    ...(step.frames ? { frames: step.frames } : {}),
    value,
    match: 'contains',
  };
  const steps = [...rec.steps];
  steps.splice(index + 1, 0, assertStep);
  await updateRecording(rec.id, { steps });
  await refreshList();
  await renderDetail();
  flashCopyMsg(t('steps.insertAssertDone'));
}

// 保存済みのアップロードファイルを取り出す
async function downloadStoredFile(fileRef) {
  let dataUrl = fileRef.dataUrl;
  if (!dataUrl && fileRef.fileId) {
    const stored = await getFile(fileRef.fileId);
    dataUrl = stored && stored.dataUrl;
  }
  if (!dataUrl) {
    alert(t('steps.fileMissing', { name: fileRef.name }));
    return;
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileRef.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// --- ステップ一覧から JSON の該当位置へ移動する ---

// steps 配列の index 番目の要素が、JSON テキストのどこからどこまでかを求める。
// 文字列リテラル中の括弧に惑わされないよう、エスケープと引用符を見ながら走査する。
function findStepRange(text, index) {
  const keyPos = text.indexOf('"steps"');
  if (keyPos === -1) return null;
  const arrStart = text.indexOf('[', keyPos);
  if (arrStart === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let count = 0;

  for (let i = arrStart + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0) elemStart = i;
      depth++;
    } else if (c === '}' || c === ']') {
      if (depth === 0) return null; // steps 配列の終端に達した
      depth--;
      if (depth === 0) {
        if (count === index) return { start: elemStart, end: i + 1 };
        count++;
      }
    }
  }
  return null;
}

// 先頭の "開始URLを開く" 行から startUrl へ飛ぶ用
function findKeyRange(text, key) {
  const p = text.indexOf(`"${key}"`);
  if (p === -1) return null;
  const lineEnd = text.indexOf('\n', p);
  return { start: p, end: lineEnd === -1 ? text.length : lineEnd };
}

function selectInEditor(range) {
  if (!range) return;
  jsonEditor.focus();
  jsonEditor.setSelectionRange(range.start, range.end);

  // textarea は選択しただけでは必ずしもスクロールしないので、行位置から自前で寄せる
  const line = jsonEditor.value.slice(0, range.start).split('\n').length - 1;
  const lineHeight = parseFloat(getComputedStyle(jsonEditor).lineHeight) || 19;
  jsonEditor.scrollTop = Math.max(0, line * lineHeight - jsonEditor.clientHeight / 3);
}

// stepIndex が null のときは startUrl へ移動する
async function revealInJson(stepIndex) {
  currentFormat = 'json';
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.tab-btn[data-format="json"]').classList.add('active');
  await renderDetail();
  const text = jsonEditor.value;
  selectInEditor(stepIndex === null ? findKeyRange(text, 'startUrl') : findStepRange(text, stepIndex));
}

// フッターの一時メッセージ（保存しました等）。既定の「コピーしました」に戻す。
function flashCopyMsg(text) {
  copyMsg.textContent = text;
  copyMsg.classList.remove('hidden');
  setTimeout(() => {
    copyMsg.classList.add('hidden');
    copyMsg.textContent = t('common.copied');
  }, 1500);
}

// --- データセット（繰り返し実行用の表） ---
const datasetPanel = document.getElementById('datasetPanel');
const datasetEditor = document.getElementById('datasetEditor');
const datasetError = document.getElementById('datasetError');
const datasetPreview = document.getElementById('datasetPreview');
const datasetCount = document.getElementById('datasetCount');
const datasetTab = document.getElementById('datasetTab');
const saveDatasetBtn = document.getElementById('saveDatasetBtn');
const datasetCsvBtn = document.getElementById('datasetCsvBtn');
const datasetClearBtn = document.getElementById('datasetClearBtn');

function renderDatasetPreview(dataset) {
  datasetPreview.innerHTML = '';
  if (!dataset || !dataset.length) {
    datasetCount.textContent = t('dataset.none');
    return;
  }
  datasetCount.textContent = t('dataset.shape', { rows: dataset.length, cols: Object.keys(dataset[0]).length });

  // 行によって列が違っても取りこぼさないよう、全行から列名を集める
  const columns = [];
  for (const row of dataset) {
    for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const numTh = document.createElement('th');
  numTh.textContent = '#';
  headRow.appendChild(numTh);
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c;
    const code = document.createElement('span');
    code.className = 'col-token';
    code.textContent = `{{data.${c}}}`;
    th.appendChild(code);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  dataset.forEach((row, i) => {
    const tr = document.createElement('tr');
    const num = document.createElement('td');
    num.textContent = String(i + 1);
    tr.appendChild(num);
    for (const c of columns) {
      const td = document.createElement('td');
      const has = Object.prototype.hasOwnProperty.call(row, c);
      td.textContent = has ? String(row[c]) : '—';
      if (!has) td.className = 'missing';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  datasetPreview.appendChild(table);
}

const recSettingsPanel = document.getElementById('recSettingsPanel');
const recSettingsFields = document.getElementById('recSettingsFields');
const recSettingsTab = document.getElementById('recSettingsTab');
const saveRecSettingsBtn = document.getElementById('saveRecSettingsBtn');
const clearRecSettingsBtn = document.getElementById('clearRecSettingsBtn');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');

// 録画ごとの設定。各項目は「全体設定に従う」か「この録画だけの値」かを選べる。
function renderRecSettings(rec, globals) {
  const overrides = rec.settings || {};
  recSettingsFields.innerHTML = '';

  for (const field of SETTING_FIELDS) {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, field.key);

    const row = document.createElement('div');
    row.className = 'setting-row';

    const label = document.createElement('label');
    label.textContent = t(field.labelKey);

    const inheritLabel = document.createElement('label');
    inheritLabel.className = 'inherit-label';
    const inherit = document.createElement('input');
    inherit.type = 'checkbox';
    inherit.dataset.inheritFor = field.key;
    inherit.checked = !overridden;
    inheritLabel.append(inherit, document.createTextNode(t('recSettings.inherit', { value: globals[field.key] })));

    const input = document.createElement('input');
    input.type = 'number';
    input.dataset.key = field.key;
    input.min = String(field.min);
    input.max = String(field.max);
    input.value = String(overridden ? overrides[field.key] : globals[field.key]);
    input.disabled = !overridden;

    inherit.addEventListener('change', () => {
      input.disabled = inherit.checked;
      if (inherit.checked) input.value = String(globals[field.key]);
    });

    const hint = document.createElement('p');
    hint.className = 'setting-hint';
    hint.textContent = t(field.hintKey);

    row.append(label, inheritLabel, input, hint);
    recSettingsFields.appendChild(row);
  }
}

function collectRecSettings() {
  const out = {};
  for (const input of recSettingsFields.querySelectorAll('input[data-key]')) {
    const inherit = recSettingsFields.querySelector(`input[data-inherit-for="${input.dataset.key}"]`);
    if (inherit && inherit.checked) continue; // 全体設定に従う項目は保存しない
    out[input.dataset.key] = Number(input.value);
  }
  return Object.keys(out).length ? out : undefined;
}

async function renderDetail() {
  const rec = getCurrentRecording();
  if (!rec) return;
  detailTitle.textContent = `${rec.name} — ${rec.startUrl}`;

  const isSteps = currentFormat === 'steps';
  const isJson = currentFormat === 'json';
  const isRecSettings = currentFormat === 'recSettings';
  const isDataset = currentFormat === 'dataset';
  const isCode = !isSteps && !isJson && !isRecSettings && !isDataset;

  stepsPanel.classList.toggle('hidden', !isSteps);
  jsonPanel.classList.toggle('hidden', !isJson);
  recSettingsPanel.classList.toggle('hidden', !isRecSettings);
  datasetPanel.classList.toggle('hidden', !isDataset);
  codePanel.classList.toggle('hidden', !isCode);

  saveJsonBtn.classList.toggle('hidden', !isJson);
  revertJsonBtn.classList.toggle('hidden', !isJson);
  validateBtn.classList.toggle('hidden', !isJson);
  saveRecSettingsBtn.classList.toggle('hidden', !isRecSettings);
  clearRecSettingsBtn.classList.toggle('hidden', !isRecSettings);
  saveDatasetBtn.classList.toggle('hidden', !isDataset);
  copyBtn.classList.toggle('hidden', isRecSettings || isDataset);
  downloadBtn.classList.toggle('hidden', isRecSettings || isDataset);

  // 個別設定を持つ録画はタブに印をつけて気づけるようにする
  const overrideCount = rec.settings ? Object.keys(rec.settings).length : 0;
  recSettingsTab.textContent = overrideCount
    ? t('tab.recSettingsWithCount', { n: overrideCount })
    : t('tab.recSettings');
  const rowCount = Array.isArray(rec.dataset) ? rec.dataset.length : 0;
  datasetTab.textContent = rowCount ? t('tab.datasetWithCount', { n: rowCount }) : t('tab.dataset');

  if (isDataset) {
    datasetEditor.value = rowCount ? JSON.stringify(rec.dataset, null, 2) : '';
    datasetError.classList.add('hidden');
    renderDatasetPreview(rec.dataset);
    return;
  }

  if (isRecSettings) {
    renderRecSettings(rec, await getSettings());
    return;
  }

  if (isSteps) {
    stepsList.innerHTML = '';

    const startLi = document.createElement('li');
    startLi.className = 'step-item';
    startLi.textContent = t('steps.openStartUrl', { url: rec.startUrl });
    startLi.title = t('steps.jumpHint');
    startLi.addEventListener('click', () => revealInJson(null));
    stepsList.appendChild(startLi);

    rec.steps.forEach((step, index) => {
      const li = document.createElement('li');
      li.className = 'step-item';
      li.title = t('steps.jumpHint');
      const flags = [];
      if (step.disabled) flags.push(t('steps.flagDisabled'));
      if (step.optional) flags.push(t('steps.flagOptional'));
      li.textContent = stepSummary(step) + (flags.length ? ` （${flags.join(' / ')}）` : '');

      // テンプレート変数を含む値は、いま実行したらどうなるかを併記する
      const preview = previewTemplate(step.value) ?? previewTemplate(step.url);
      if (preview !== null && preview !== undefined) {
        const span = document.createElement('span');
        span.className = 'tpl-preview';
        span.textContent = t('steps.nowIs', { value: preview });
        li.appendChild(span);
      }

      // アップロードしたファイルは、書き出したスクリプト用に取り出せるようにする
      if (step.type === 'upload') {
        for (const f of step.files || []) {
          if (!f.fileId && !f.dataUrl) continue;
          const btn = document.createElement('button');
          btn.className = 'file-save-btn';
          btn.textContent = t('steps.saveFile', { name: f.name });
          btn.title = t('steps.saveFileTitle');
          btn.addEventListener('click', async (e) => {
            e.stopPropagation(); // 行のクリック（JSONへ移動）と競合させない
            await downloadStoredFile(f);
          });
          li.appendChild(btn);
        }
      }

      // このステップの前に待機を差し込むボタン
      const waitBtn = document.createElement('button');
      waitBtn.className = 'insert-wait-btn';
      waitBtn.textContent = t('steps.insertWait');
      waitBtn.title = t('steps.insertWaitTitle');
      waitBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 行のクリック（JSONへ移動）と競合させない
        insertWaitBefore(index);
      });
      li.appendChild(waitBtn);

      // このステップの直後に検証を差し込むボタン（対象を持つステップのみ）
      if (step.selector || (step.selectors && step.selectors.length)) {
        const assertBtn = document.createElement('button');
        assertBtn.className = 'insert-wait-btn';
        assertBtn.textContent = t('steps.insertAssert');
        assertBtn.title = t('steps.insertAssertTitle');
        assertBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          insertAssertAfter(index);
        });
        li.appendChild(assertBtn);
      }

      if (step.disabled) li.classList.add('step-disabled');
      li.addEventListener('click', () => revealInJson(index));
      stepsList.appendChild(li);
    });
  } else if (isJson) {
    jsonEditor.value = generateJson(rec);
    jsonError.classList.add('hidden');
    // 開いた時点で問題があれば気づけるよう、自動で1度検証する
    const result = validateRecording(rec);
    if (result.issues.length) showValidation(result);
    else validationBox.classList.add('hidden');
  } else {
    codeView.textContent = generateScript(rec, currentFormat);
  }
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFormat = btn.dataset.format || 'steps';
    renderDetail();
  });
});

document.getElementById('closeDetail').addEventListener('click', () => {
  detailModal.classList.add('hidden');
});

validateBtn.addEventListener('click', () => {
  const result = runValidation();
  if (result && !result.issues.length) flashCopyMsg(t('json.noIssues'));
});

document.getElementById('validationClose').addEventListener('click', () => {
  validationBox.classList.add('hidden');
});

// --- JSON の手編集を保存する ---
saveJsonBtn.addEventListener('click', async () => {
  const rec = getCurrentRecording();
  if (!rec) return;
  let parsed;
  try {
    parsed = parseRecordingJson(jsonEditor.value);
  } catch (err) {
    jsonError.textContent = String(err.message || err);
    jsonError.classList.remove('hidden');
    validationBox.classList.add('hidden');
    return;
  }
  jsonError.classList.add('hidden');

  // 整合性チェック: エラーがあれば保存しない。警告は表示だけして続行する。
  const result = validateRecording(parsed);
  if (result.issues.length) showValidation(result);
  else validationBox.classList.add('hidden');
  if (result.errors.length) {
    flashCopyMsg(t('json.notSavedDueToErrors'));
    return;
  }
  await updateRecording(rec.id, {
    name: parsed.name,
    startUrl: parsed.startUrl,
    steps: parsed.steps,
    settings: parsed.settings,
    dataset: parsed.dataset,
  });
  await refreshList();
  await renderDetail();
  flashCopyMsg(t('common.saved'));
});

revertJsonBtn.addEventListener('click', () => {
  renderDetail();
});

// --- データセットの保存 / CSV取り込み / 削除 ---
saveDatasetBtn.addEventListener('click', async () => {
  const rec = getCurrentRecording();
  if (!rec) return;
  const text = datasetEditor.value.trim();
  let dataset;
  try {
    dataset = text ? validateDataset(JSON.parse(text)) : undefined;
  } catch (err) {
    datasetError.textContent = String(err.message || err);
    datasetError.classList.remove('hidden');
    return;
  }
  datasetError.classList.add('hidden');
  await updateRecording(rec.id, { dataset });
  await refreshList();
  await renderDetail();
  flashCopyMsg(dataset ? t('dataset.savedRows', { n: dataset.length }) : t('dataset.deleted'));
});

datasetCsvBtn.addEventListener('click', () => {
  const text = prompt(t('dataset.csvPrompt'));
  if (text === null) return;
  try {
    const rows = parseDelimitedText(text);
    if (!rows.length) throw new Error(t('dataset.csvNoRows'));
    datasetEditor.value = JSON.stringify(rows, null, 2);
    datasetError.classList.add('hidden');
    renderDatasetPreview(rows); // 保存前に結果を確認できるようにする
    flashCopyMsg(t('dataset.csvLoaded', { n: rows.length }));
  } catch (err) {
    datasetError.textContent = String(err.message || err);
    datasetError.classList.remove('hidden');
  }
});

datasetClearBtn.addEventListener('click', async () => {
  const rec = getCurrentRecording();
  if (!rec) return;
  if (!confirm(t('dataset.confirmClear'))) return;
  await updateRecording(rec.id, { dataset: undefined });
  await refreshList();
  await renderDetail();
  flashCopyMsg(t('dataset.deleted'));
});

// --- 録画ごとの設定を保存 ---
saveRecSettingsBtn.addEventListener('click', async () => {
  const rec = getCurrentRecording();
  if (!rec) return;
  await updateRecording(rec.id, { settings: collectRecSettings() });
  await refreshList();
  await renderDetail();
  flashCopyMsg(t('common.saved'));
});

clearRecSettingsBtn.addEventListener('click', async () => {
  const rec = getCurrentRecording();
  if (!rec) return;
  await updateRecording(rec.id, { settings: undefined });
  await refreshList();
  await renderDetail();
  flashCopyMsg(t('recSettings.cleared'));
});

document.getElementById('copyBtn').addEventListener('click', async () => {
  const rec = getCurrentRecording();
  if (!rec) return;
  let text;
  if (currentFormat === 'steps') text = stepsList.innerText;
  else if (currentFormat === 'json') text = jsonEditor.value;
  else text = generateScript(rec, currentFormat);
  await navigator.clipboard.writeText(text);
  copyMsg.classList.remove('hidden');
  setTimeout(() => copyMsg.classList.add('hidden'), 1500);
});

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(name) {
  return (name || 'webrec').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}

// エクスポート用: 別ストアにあるファイル本体を JSON に埋め込んで持ち運べる形にする
async function inlineFiles(rec) {
  const steps = [];
  for (const step of rec.steps || []) {
    if (step.type !== 'upload' || !Array.isArray(step.files)) {
      steps.push(step);
      continue;
    }
    const files = [];
    for (const f of step.files) {
      if (f.dataUrl || !f.fileId) {
        files.push(f);
        continue;
      }
      const stored = await getFile(f.fileId);
      files.push(
        stored && stored.dataUrl
          ? { name: f.name, mimeType: f.mimeType, size: f.size, dataUrl: stored.dataUrl }
          : { name: f.name, mimeType: f.mimeType, size: f.size, omitted: 'not-found' }
      );
    }
    steps.push({ ...step, files });
  }
  return { ...rec, steps };
}

// インポート用: 埋め込まれたファイル本体を別ストアへ移し、ステップは参照だけにする
async function externalizeFiles(rec) {
  const steps = [];
  for (const step of rec.steps || []) {
    if (step.type !== 'upload' || !Array.isArray(step.files)) {
      steps.push(step);
      continue;
    }
    const files = [];
    for (const f of step.files) {
      if (!f.dataUrl) {
        files.push(f);
        continue;
      }
      const fileId = crypto.randomUUID();
      await saveFile({ id: fileId, name: f.name, mimeType: f.mimeType, size: f.size, dataUrl: f.dataUrl });
      files.push({ fileId, name: f.name, mimeType: f.mimeType, size: f.size });
    }
    steps.push({ ...step, files });
  }
  return { ...rec, steps };
}

document.getElementById('downloadBtn').addEventListener('click', async () => {
  const rec = getCurrentRecording();
  if (!rec) return;
  const ext = { playwright: 'spec.js', puppeteer: 'js', json: 'json', steps: 'json' }[currentFormat];
  const format = currentFormat === 'steps' ? 'json' : currentFormat;
  let content;
  if (currentFormat === 'json') {
    // JSON は持ち運べるよう、アップロードしたファイルの中身も埋め込んで書き出す
    content = generateJson(await inlineFiles(rec));
  } else {
    content = generateScript(rec, format);
  }
  downloadText(`${safeFileName(rec.name)}.${ext}`, content);
});

// --- 全件エクスポート / インポート ---
document.getElementById('exportAllBtn').addEventListener('click', async () => {
  const all = await getAllRecordings();
  if (!all.length) {
    alert(t('io.nothingToExport'));
    return;
  }
  const recordings = [];
  for (const r of all) recordings.push(JSON.parse(generateJson(await inlineFiles(r))));
  const payload = {
    webrecVersion: 1,
    exportedAt: new Date().toISOString(),
    recordings,
  };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadText(`webrec-export-${stamp}.json`, JSON.stringify(payload, null, 2));
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 同じファイルを続けて選べるようにリセット
  if (!file) return;

  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch (err) {
    alert(t('io.readFailed', { error: err.message }));
    return;
  }

  // 単一録画・複数録画（全件エクスポート形式）・素の配列のいずれも受け付ける
  const candidates = Array.isArray(raw) ? raw : Array.isArray(raw.recordings) ? raw.recordings : [raw];

  const imported = [];
  const errors = [];
  const warnings = [];
  candidates.forEach((c, i) => {
    try {
      const parsed = parseRecordingJson(JSON.stringify(c));
      imported.push(parsed);
      // 取り込めるが辻褄が合っていないものは、取り込んだうえで知らせる
      const check = validateRecording(parsed);
      for (const issue of [...check.errors, ...check.warnings]) {
        warnings.push(`「${parsed.name}」${issue.message}`);
      }
    } catch (err) {
      errors.push(`#${i + 1}: ${err.message}`);
    }
  });

  if (!imported.length) {
    alert(t('io.nothingImported') + '\n\n' + errors.join('\n'));
    return;
  }

  const now = Date.now();
  for (const parsed of imported) {
    // 埋め込まれたファイル本体は別ストアへ移す
    const withFiles = await externalizeFiles(parsed);
    // 既存を上書きしないよう、常に新しい ID を採番する
    await saveRecording({
      id: crypto.randomUUID(),
      name: withFiles.name,
      startUrl: withFiles.startUrl,
      steps: withFiles.steps,
      settings: withFiles.settings,
      dataset: withFiles.dataset,
      createdAt: withFiles.createdAt || now,
      updatedAt: now,
    });
  }

  await refreshList();
  const parts = [t('io.imported', { n: imported.length })];
  if (errors.length) parts.push('\n' + t('io.notImported') + '\n' + errors.join('\n'));
  if (warnings.length) {
    // 数が多いと読めないので先頭だけ見せ、残りは件数で示す
    const shown = warnings.slice(0, 10);
    parts.push('\n' + t('io.needsAttention') + '\n' + shown.join('\n'));
    if (warnings.length > shown.length) parts.push(t('io.andMore', { n: warnings.length - shown.length }));
    parts.push('\n' + t('io.seeValidation'));
  }
  alert(parts.join('\n'));
});

// --- 設定 ---
const settingsModal = document.getElementById('settingsModal');
const settingsFields = document.getElementById('settingsFields');
const settingsMsg = document.getElementById('settingsMsg');

function renderSettings(values) {
  settingsFields.innerHTML = '';
  for (const field of SETTING_FIELDS) {
    const row = document.createElement('div');
    row.className = 'setting-row';

    const label = document.createElement('label');
    label.textContent = t(field.labelKey);
    label.htmlFor = `setting_${field.key}`;

    const input = document.createElement('input');
    input.type = 'number';
    input.id = `setting_${field.key}`;
    input.dataset.key = field.key;
    input.min = String(field.min);
    input.max = String(field.max);
    input.value = String(values[field.key]);

    const hint = document.createElement('p');
    hint.className = 'setting-hint';
    hint.textContent = t(field.hintKey);

    row.append(label, input, hint);
    settingsFields.appendChild(row);
  }
}

function flashSettingsMsg(text) {
  settingsMsg.textContent = text;
  settingsMsg.classList.remove('hidden');
  setTimeout(() => settingsMsg.classList.add('hidden'), 1500);
}

const seqInput = document.getElementById('seqInput');

document.getElementById('settingsBtn').addEventListener('click', async () => {
  renderSettings(await getSettings());
  seqInput.value = String(await peekSeq());
  settingsModal.classList.remove('hidden');
});

document.getElementById('closeSettings').addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const patch = {};
  for (const input of settingsFields.querySelectorAll('input[data-key]')) {
    patch[input.dataset.key] = Number(input.value);
  }
  const saved = await saveSettings(patch);
  renderSettings(saved); // 範囲外の値は丸められるので、確定値を表示し直す
  seqInput.value = String(await setNextSeq(seqInput.value));
  flashSettingsMsg(t('common.saved'));
});

document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
  renderSettings(await resetSettings());
  seqInput.value = String(await setNextSeq(1));
  flashSettingsMsg(t('settings.resetDone'));
});

// --- 実行ログ ---
const runsModal = document.getElementById('runsModal');
const runsList = document.getElementById('runsList');
const runsEmpty = document.getElementById('runsEmpty');
const runsCount = document.getElementById('runsCount');

function fmtDuration(run) {
  if (!run.finishedAt) return '';
  const sec = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000));
  return t('runs.duration', { sec });
}

function buildRunRow(run) {
  const wrap = document.createElement('div');
  wrap.className = 'run-row';

  const head = document.createElement('div');
  head.className = 'run-head';

  const when = document.createElement('span');
  when.className = 'run-when';
  when.textContent = fmtDate(run.startedAt);

  const name = document.createElement('span');
  name.className = 'run-name';
  name.textContent = run.name || run.recordingId;

  const trigger = document.createElement('span');
  trigger.className = 'run-when';
  trigger.textContent = t(run.trigger === 'schedule' ? 'runs.bySchedule' : 'runs.byHand');

  const badge = document.createElement('span');
  badge.className = `run-badge ${run.status}`;
  badge.textContent = t(`runs.status.${run.status}`, { n: run.failedCount || 0 });

  const dur = document.createElement('span');
  dur.className = 'run-when';
  dur.textContent = fmtDuration(run);

  const del = document.createElement('button');
  del.className = 'btn';
  del.textContent = t('common.delete');
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await deleteRun(run.id);
    await refreshRuns();
  });

  head.append(when, name, trigger, badge, dur, del);

  const detail = document.createElement('div');
  detail.className = 'run-detail hidden';

  const ol = document.createElement('ol');
  for (const entry of run.steps || []) {
    const li = document.createElement('li');
    li.className = entry.status;
    let text = entry.summary || entry.type || '';
    if (run.rowCount > 1) text = t('runs.rowPrefix', { row: (entry.rowIndex || 0) + 1 }) + text;
    if (entry.error) text += t('replay.failed', { error: entry.error });
    if (entry.fallback) text += t('replay.usedFallback', { selector: entry.fallback });
    li.textContent = text;
    ol.appendChild(li);
  }
  detail.appendChild(ol);

  if (run.error) {
    const err = document.createElement('p');
    err.className = 'json-error';
    err.textContent = run.error;
    detail.appendChild(err);
  }

  if ((run.dialogs || []).length) {
    const dlg = document.createElement('div');
    dlg.className = 'run-dialogs';
    dlg.textContent =
      t('runs.dialogs') +
      run.dialogs.map((d) => `${d.kind}: ${String(d.message || '').slice(0, 80)}`).join(' / ');
    detail.appendChild(dlg);
  }

  head.addEventListener('click', () => detail.classList.toggle('hidden'));
  wrap.append(head, detail);
  return wrap;
}

async function refreshRuns() {
  const runs = await getAllRuns();
  runsList.innerHTML = '';
  runsEmpty.classList.toggle('hidden', runs.length > 0);
  runsCount.textContent = runs.length ? t('list.count', { n: runs.length }) : '';
  for (const run of runs) runsList.appendChild(buildRunRow(run));
}

document.getElementById('runsBtn').addEventListener('click', async () => {
  await refreshRuns();
  runsModal.classList.remove('hidden');
});
document.getElementById('closeRuns').addEventListener('click', () => {
  runsModal.classList.add('hidden');
});
document.getElementById('clearRunsBtn').addEventListener('click', async () => {
  if (!confirm(t('runs.clearConfirm'))) return;
  await clearRuns();
  await refreshRuns();
});

// --- スケジュール ---
const scheduleModal = document.getElementById('scheduleModal');
const scheduleList = document.getElementById('scheduleList');
const scheduleEmpty = document.getElementById('scheduleEmpty');
const scheduleRecording = document.getElementById('scheduleRecording');
const scheduleKind = document.getElementById('scheduleKind');
const scheduleAt = document.getElementById('scheduleAt');
const scheduleEvery = document.getElementById('scheduleEvery');
const scheduleMsg = document.getElementById('scheduleMsg');

let schedules = [];

async function pushSchedules(next) {
  const res = await chrome.runtime.sendMessage({ type: 'SET_SCHEDULES', schedules: next });
  schedules = (res && res.schedules) || [];
  renderSchedules();
}

function scheduleWhenText(sc) {
  return sc.kind === 'interval'
    ? t('schedule.whenInterval', { n: sc.everyMinutes })
    : t('schedule.whenDaily', { at: sc.at });
}

function renderSchedules() {
  scheduleList.innerHTML = '';
  scheduleEmpty.classList.toggle('hidden', schedules.length > 0);
  for (const sc of schedules) {
    const row = document.createElement('div');
    row.className = 'schedule-row';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = sc.enabled !== false;
    toggle.title = t('schedule.enabledTitle');
    toggle.addEventListener('change', () =>
      pushSchedules(schedules.map((x) => (x.id === sc.id ? { ...x, enabled: toggle.checked } : x)))
    );

    const name = document.createElement('span');
    name.className = 'schedule-name';
    const rec = currentList.find((r) => r.id === sc.recordingId);
    name.textContent = rec ? rec.name : t('schedule.missingRecording');
    if (!rec) name.style.color = '#dc2626';

    const when = document.createElement('span');
    when.className = 'schedule-when';
    when.textContent = scheduleWhenText(sc);

    const last = document.createElement('span');
    last.className = 'schedule-last';
    last.textContent = sc.lastRunAt
      ? t('schedule.lastRun', { when: fmtDate(sc.lastRunAt), status: t(`runs.status.${sc.lastStatus || 'done'}`, { n: 0 }) })
      : t('schedule.neverRun');

    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = t('common.delete');
    del.addEventListener('click', () => pushSchedules(schedules.filter((x) => x.id !== sc.id)));

    row.append(toggle, name, when, last, del);
    scheduleList.appendChild(row);
  }
}

function syncScheduleForm() {
  const daily = scheduleKind.value === 'daily';
  document.getElementById('scheduleDailyWrap').classList.toggle('hidden', !daily);
  document.getElementById('scheduleIntervalWrap').classList.toggle('hidden', daily);
}

scheduleKind.addEventListener('change', syncScheduleForm);

document.getElementById('scheduleBtn').addEventListener('click', async () => {
  scheduleRecording.innerHTML = '';
  for (const rec of currentList) {
    const opt = document.createElement('option');
    opt.value = rec.id;
    opt.textContent = rec.name;
    scheduleRecording.appendChild(opt);
  }
  const res = await chrome.runtime.sendMessage({ type: 'GET_SCHEDULES' });
  schedules = (res && res.schedules) || [];
  renderSchedules();
  syncScheduleForm();
  scheduleModal.classList.remove('hidden');
});

document.getElementById('closeSchedule').addEventListener('click', () => {
  scheduleModal.classList.add('hidden');
});

document.getElementById('addScheduleBtn').addEventListener('click', async () => {
  if (!scheduleRecording.value) return;
  await pushSchedules([
    ...schedules,
    {
      recordingId: scheduleRecording.value,
      kind: scheduleKind.value,
      at: scheduleAt.value || '09:00',
      everyMinutes: Number(scheduleEvery.value) || 60,
      enabled: true,
    },
  ]);
  scheduleMsg.textContent = t('schedule.added');
  scheduleMsg.classList.remove('hidden');
  setTimeout(() => scheduleMsg.classList.add('hidden'), 2000);
});

// --- 再生オプション（再生先タブ / 開始位置） ---
const replayOptionsModal = document.getElementById('replayOptionsModal');
const replayOptionsTitle = document.getElementById('replayOptionsTitle');
const replayTargetSelect = document.getElementById('replayTargetSelect');
const replayKeepUrl = document.getElementById('replayKeepUrl');
const replayStartAt = document.getElementById('replayStartAt');
const runReplayBtn = document.getElementById('runReplayBtn');

// ポップアップの「このタブで再生」から開かれた場合、対象タブが渡ってくる
const presetTargetTabId = Number(new URLSearchParams(location.search).get('targetTab'));

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch (_) {
    return url;
  }
}

// 再生先の候補（新しいウィンドウ + 今開いている http(s) のタブ）を並べる
async function fillTargetSelect() {
  replayTargetSelect.innerHTML = '';
  const newWin = document.createElement('option');
  newWin.value = '';
  newWin.textContent = t('replayOpts.newWindow');
  replayTargetSelect.appendChild(newWin);

  const self = await chrome.tabs.getCurrent().catch(() => null);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !/^https?:/.test(tab.url)) continue;
    if (self && tab.id === self.id) continue; // 管理画面自身は選ばせない
    const opt = document.createElement('option');
    opt.value = String(tab.id);
    opt.textContent = `${tab.title || shortUrl(tab.url)} — ${shortUrl(tab.url)}`;
    replayTargetSelect.appendChild(opt);
  }

  if (presetTargetTabId && replayTargetSelect.querySelector(`option[value="${presetTargetTabId}"]`)) {
    replayTargetSelect.value = String(presetTargetTabId);
  }
}

function syncKeepUrlState() {
  // 新しいウィンドウで開く場合は必ず開始URLから始まる
  const isNewWindow = !replayTargetSelect.value;
  replayKeepUrl.disabled = isNewWindow;
  if (isNewWindow) replayKeepUrl.checked = false;
}

replayTargetSelect.addEventListener('change', syncKeepUrlState);

async function openReplayOptions(rec) {
  replayOptionsTitle.textContent = rec.name;

  await fillTargetSelect();
  replayKeepUrl.checked = !!replayTargetSelect.value; // 用意したタブを選んだときは既定でON
  syncKeepUrlState();

  replayStartAt.innerHTML = '';
  const head = document.createElement('option');
  head.value = '0';
  head.textContent = t('replayOpts.fromStart');
  replayStartAt.appendChild(head);
  rec.steps.forEach((step, i) => {
    if (i === 0) return; // 先頭から = 「最初から」
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i + 1}. ${stepSummary(step)}`;
    replayStartAt.appendChild(opt);
  });

  replayOptionsModal.classList.remove('hidden');
  runReplayBtn.onclick = () => {
    replayOptionsModal.classList.add('hidden');
    startReplay(rec, {
      tabId: replayTargetSelect.value ? Number(replayTargetSelect.value) : null,
      keepCurrentUrl: !replayKeepUrl.disabled && replayKeepUrl.checked,
      startAtIndex: Number(replayStartAt.value) || 0,
    });
  };
}

document.getElementById('closeReplayOptions').addEventListener('click', () => {
  replayOptionsModal.classList.add('hidden');
});

// --- リプレイ ---
const replayModal = document.getElementById('replayModal');
const replayTitle = document.getElementById('replayTitle');
const replayList = document.getElementById('replayList');

function startReplay(rec, opts = {}) {
  const dataset = Array.isArray(rec.dataset) && rec.dataset.length ? rec.dataset : null;
  replayTitle.textContent = dataset ? t('replay.withRows', { name: rec.name, n: dataset.length }) : rec.name;
  replayList.innerHTML = '';

  // 行ごとにセクションを作る。データがなければ1セクションだけ。
  const rows = dataset || [null];
  const stepLisByRow = [];
  const rowHeaders = [];

  rows.forEach((rowData, r) => {
    const section = document.createElement('section');
    section.className = 'replay-row';

    if (dataset) {
      const header = document.createElement('div');
      header.className = 'replay-row-header';
      const summary = Object.entries(rowData)
        .map(([k, v]) => `${k}=${v}`)
        .join(' / ');
      header.textContent = t('replay.rowHeader', { current: r + 1, total: rows.length, summary });
      section.appendChild(header);
      rowHeaders.push(header);
    }

    const ol = document.createElement('ol');
    const startLi = document.createElement('li');
    startLi.textContent = opts.keepCurrentUrl
      ? t('steps.useCurrentPage')
      : t('steps.openStartUrl', { url: rec.startUrl });
    ol.appendChild(startLi);

    stepLisByRow.push(
      rec.steps.map((step) => {
        const li = document.createElement('li');
        li.textContent = stepSummary(step);
        ol.appendChild(li);
        return li;
      })
    );

    section.appendChild(ol);
    replayList.appendChild(section);
  });

  replayModal.classList.remove('hidden');

  const port = chrome.runtime.connect({ name: 'replay' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS') {
      if (msg.status === 'complete') return;

      // 行の開始/終了の通知
      if (msg.marker === 'row') {
        const header = rowHeaders[msg.rowIndex];
        if (header) {
          header.classList.remove('running', 'done');
          header.classList.add(msg.status);
          if (msg.status === 'running') header.scrollIntoView({ block: 'nearest' });
        }
        return;
      }

      const li = (stepLisByRow[msg.rowIndex || 0] || [])[msg.index];
      if (!li) return;
      li.classList.remove('running', 'done', 'error', 'skipped', 'warned');
      li.classList.add(msg.status);
      if (msg.status === 'running') li.scrollIntoView({ block: 'nearest' });
      if (msg.status === 'error') li.textContent += t('replay.failed', { error: msg.error });
      if (msg.status === 'warned') li.textContent += t('replay.warned', { error: msg.error });
      if (msg.status === 'skipped') li.textContent += t('replay.skipped');
      if (msg.status === 'done' && msg.fallback) li.textContent += t('replay.usedFallback', { selector: msg.fallback });
    } else if (msg.type === 'ERROR') {
      alert(t('replay.error', { error: msg.error }));
    }
  });
  port.postMessage({
    type: 'START',
    id: rec.id,
    tabId: Number.isFinite(opts.tabId) ? opts.tabId : null,
    keepCurrentUrl: !!opts.keepCurrentUrl,
    startAtIndex: Number.isFinite(opts.startAtIndex) ? opts.startAtIndex : 0,
  });
}

document.getElementById('closeReplay').addEventListener('click', () => {
  replayModal.classList.add('hidden');
});

// --- 言語切り替え ---
const langSelect = document.getElementById('langSelect');

function renderLangSelect() {
  langSelect.innerHTML = '';
  for (const lang of LANGS) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    opt.selected = lang.code === getLang();
    langSelect.appendChild(opt);
  }
}

langSelect.addEventListener('change', async () => {
  await setLang(langSelect.value);
  // 開いているダイアログや生成済みの行も含めて確実に切り替えるため読み込み直す
  location.reload();
});

// --- 起動 ---
(async function start() {
  await initI18n(); // 文言を確定させてから描画する
  applyI18n();
  renderLangSelect();
  renderTemplateHelp();
  await refreshList();
})();
