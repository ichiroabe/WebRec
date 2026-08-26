// WebRec: 記録したステップ列から、再現可能なスクリプトを生成する。

import { resolveTemplate } from './template.js';

function jsStr(v) {
  return JSON.stringify(v == null ? '' : v);
}

// テンプレート変数を含む値は、生成したスクリプトの中でも「実行時に」解決させたい。
// （明日実行すれば明日の日付になってほしい）
// そのため resolveTemplate の実体をソースごと埋め込み、V(...) 経由で呼ぶ。
function hasTemplate(v) {
  return typeof v === 'string' && v.indexOf('{{') !== -1;
}

function recordingUsesTemplates(rec) {
  if (hasTemplate(rec.startUrl)) return true;
  return rec.steps.some(
    (s) => hasTemplate(s.value) || hasTemplate(s.url) || (Array.isArray(s.values) && s.values.some(hasTemplate))
  );
}

// テンプレートを含む場合は V("...") 形式、含まない場合はただの文字列リテラルにする
function val(v) {
  return hasTemplate(v) ? `V(${jsStr(v)})` : jsStr(v);
}

function valArray(values) {
  const arr = values || [];
  return arr.some(hasTemplate) ? `[${arr.map(val).join(', ')}]` : JSON.stringify(arr);
}

function hasDataset(rec) {
  return Array.isArray(rec.dataset) && rec.dataset.length > 0;
}

// 変換処理の本体。データセットの有無にかかわらず共通。
function templateEngineSource() {
  return [
    '// --- WebRec テンプレート変数 ({{date:YYYY-MM-DD}} など) を実行時に解決する ---',
    'let __webrecSeq = 1; // {{seq}} 用。必要なら実行のたびに変えてください。',
    'const __webrecNow = Date.now(); // 1回の実行中は同じ時刻を使う',
    resolveTemplate.toString(),
    '',
  ].join('\n');
}

// データセットがなければ V は 1 つだけ。あれば行ごとに定義するのでここでは出さない。
function templateHelperSource(rec) {
  const parts = [templateEngineSource()];
  if (!hasDataset(rec)) {
    parts.push('const V = (s) => resolveTemplate(s, { now: __webrecNow, seq: __webrecSeq });', '');
  }
  return parts.join('\n');
}

// アップロードを含む場合、必要なファイルを先頭で案内する
function uploadNoticeSource(rec) {
  const names = [];
  for (const step of rec.steps || []) {
    if (step.type !== 'upload') continue;
    for (const f of step.files || []) if (!names.includes(f.name)) names.push(f.name);
  }
  if (!names.length) return null;
  return [
    '// --- 実行前に用意するファイル ---',
    '// このスクリプトと同じ階層に files/ を作り、以下を置いてください。',
    '// （管理画面のステップ一覧にある「保存」から取り出せます）',
    ...names.map((n) => `//   files/${n}`),
    '',
  ].join('\n');
}

function datasetSource(rec) {
  return [
    '// --- 繰り返し実行するデータ（1行につき1回シナリオを流す） ---',
    `const dataset = ${JSON.stringify(rec.dataset, null, 2)};`,
    '',
  ].join('\n');
}

// 編集・エクスポート・インポートで共通に使う、スクリプト本体としての JSON 形式。
export function generateJson(rec) {
  const out = {
    webrecVersion: 1,
    name: rec.name,
    startUrl: rec.startUrl,
    createdAt: rec.createdAt,
    steps: rec.steps,
  };
  if (rec.settings && Object.keys(rec.settings).length) out.settings = rec.settings;
  if (Array.isArray(rec.dataset) && rec.dataset.length) out.dataset = rec.dataset;
  return JSON.stringify(out, null, 2);
}

// データセット（繰り返し実行用の表）を検証する
export function validateDataset(dataset) {
  if (dataset === undefined || dataset === null) return undefined;
  if (!Array.isArray(dataset)) throw new Error('dataset は配列である必要があります');
  dataset.forEach((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`dataset[${i}] は { "列名": "値" } 形式のオブジェクトである必要があります`);
    }
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && typeof v === 'object') {
        throw new Error(`dataset[${i}].${k} には文字列か数値を指定してください`);
      }
    }
  });
  return dataset.length ? dataset : undefined;
}

// 貼り付けた CSV/TSV を dataset 形式（オブジェクトの配列）へ変換する。
// 1行目を列名として扱い、"..." で囲まれた値と "" によるエスケープに対応する。
export function parseDelimitedText(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!src) return [];
  const delimiter = src.split('\n')[0].includes('\t') ? '\t' : ',';

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  rows.push(row);

  const header = (rows.shift() || []).map((h) => h.trim());
  if (!header.length || header.every((h) => !h)) throw new Error('1行目に列名がありません');

  return rows
    .filter((r) => r.some((cell) => cell.trim() !== '')) // 空行は捨てる
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => {
        if (h) obj[h] = (r[i] ?? '').trim();
      });
      return obj;
    });
}

const KNOWN_STEP_TYPES = new Set([
  'click',
  'input',
  'select',
  'selectMultiple',
  'keydown',
  'dragAndDrop',
  'navigate',
  'wait',
  'waitForSelector',
  'upload',
]);

// JSON を録画データとして受け入れる前に検証する。
// 手編集した JSON やインポートしたファイルが壊れていた場合、ここで具体的な理由を返す。
export function parseRecordingJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON の構文が不正です: ' + e.message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('オブジェクト形式の JSON を指定してください');
  }
  if (typeof data.startUrl !== 'string' || !/^https?:/.test(data.startUrl)) {
    throw new Error('startUrl は http/https の URL である必要があります');
  }
  if (!Array.isArray(data.steps)) {
    throw new Error('steps は配列である必要があります');
  }

  data.steps.forEach((step, i) => {
    const at = `steps[${i}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${at} はオブジェクトである必要があります`);
    }
    if (typeof step.type !== 'string') throw new Error(`${at}.type がありません`);
    if (!KNOWN_STEP_TYPES.has(step.type)) {
      throw new Error(`${at}.type "${step.type}" は未対応です（${[...KNOWN_STEP_TYPES].join(' / ')}）`);
    }
    if (step.type === 'navigate') {
      if (typeof step.url !== 'string') throw new Error(`${at}.url がありません`);
    } else if (step.type === 'wait') {
      if (!Number.isFinite(step.ms)) throw new Error(`${at}.ms は数値である必要があります`);
    } else {
      if (typeof step.selector !== 'string' || !step.selector) {
        throw new Error(`${at}.selector がありません`);
      }
    }
    if (step.type === 'selectMultiple' && !Array.isArray(step.values)) {
      throw new Error(`${at}.values は配列である必要があります`);
    }
    if (step.type === 'dragAndDrop' && typeof step.toSelector !== 'string') {
      throw new Error(`${at}.toSelector がありません`);
    }
    if (step.type === 'upload') {
      if (!Array.isArray(step.files)) throw new Error(`${at}.files は配列である必要があります`);
      step.files.forEach((f, j) => {
        if (!f || typeof f !== 'object') throw new Error(`${at}.files[${j}] はオブジェクトである必要があります`);
        if (typeof f.name !== 'string' || !f.name) throw new Error(`${at}.files[${j}].name がありません`);
      });
    }
  });

  return {
    name: typeof data.name === 'string' && data.name ? data.name : '無題の録画',
    startUrl: data.startUrl,
    steps: data.steps,
    settings: data.settings && typeof data.settings === 'object' ? data.settings : undefined,
    dataset: validateDataset(data.dataset),
    createdAt: Number.isFinite(data.createdAt) ? data.createdAt : Date.now(),
  };
}

// iframe 内のステップは page.frameLocator(...) を連ねたスコープから辿る
function pwScope(step) {
  if (!step.frames || !step.frames.length) return 'page';
  const parts = step.frames.map((f) =>
    typeof f === 'string' ? `.frameLocator(${jsStr(f)})` : `/* 特定できない iframe: ${f.url} */`
  );
  return 'page' + parts.join('');
}

// シナリオ本体（開始URL + 全ステップ）を、指定のインデントで組み立てる
function playwrightBody(rec, ind) {
  const lines = [];
  lines.push(`${ind}await page.goto(${val(rec.startUrl)});`);

  for (const step of rec.steps) {
    const scope = pwScope(step);
    if (step.disabled) {
      lines.push(`${ind}// [無効化] ${stepSummary(step)}`);
      continue;
    }
    if (Number.isFinite(step.waitBeforeMs) && step.waitBeforeMs > 0) {
      lines.push(`${ind}await page.waitForTimeout(${step.waitBeforeMs});`);
    }
    switch (step.type) {
      case 'navigate':
        lines.push(`${ind}await page.goto(${val(step.url)});`);
        break;
      case 'wait':
        lines.push(`${ind}await page.waitForTimeout(${Number.isFinite(step.ms) ? step.ms : 1000});`);
        break;
      case 'waitForSelector':
        lines.push(
          `${ind}await ${scope}.locator(${jsStr(step.selector)}).waitFor(${
            Number.isFinite(step.timeoutMs) ? `{ timeout: ${step.timeoutMs} }` : ''
          });`
        );
        break;
      case 'click':
        lines.push(`${ind}await ${scope}.locator(${jsStr(step.selector)}).click();`);
        break;
      case 'input':
        lines.push(`${ind}await ${scope}.locator(${jsStr(step.selector)}).fill(${val(step.value)});`);
        break;
      case 'select':
        lines.push(`${ind}await ${scope}.locator(${jsStr(step.selector)}).selectOption(${val(step.value)});`);
        break;
      case 'selectMultiple':
        lines.push(`${ind}await ${scope}.locator(${jsStr(step.selector)}).selectOption(${valArray(step.values)});`);
        break;
      case 'dragAndDrop':
        lines.push(
          `${ind}await ${scope}.locator(${jsStr(step.selector)}).dragTo(${scope}.locator(${jsStr(step.toSelector)}));`
        );
        break;
      case 'upload': {
        // 書き出したスクリプトはローカルのファイルパスを渡す方式にする。
        // 管理画面の「保存」から取り出したファイルを files/ に置いて実行する。
        const paths = (step.files || []).map((f) => `./files/${f.name}`);
        lines.push(`${ind}await ${scope}.locator(${jsStr(step.selector)}).setInputFiles(${JSON.stringify(paths)});`);
        break;
      }
      case 'keydown':
        lines.push(`${ind}await ${scope}.locator(${jsStr(step.selector)}).press(${jsStr(step.key)});`);
        break;
      default:
        lines.push(`${ind}// 未対応のステップ: ${step.type}`);
    }
  }
  return lines;
}

export function generatePlaywright(rec) {
  const lines = [];
  const name = rec.name || 'recorded scenario';
  lines.push("const { test, expect } = require('@playwright/test');");
  lines.push('');
  const uploadNotice = uploadNoticeSource(rec);
  if (uploadNotice) lines.push(uploadNotice);
  if (recordingUsesTemplates(rec) || hasDataset(rec)) lines.push(templateHelperSource(rec));

  if (hasDataset(rec)) {
    // データ1行につき1つのテストを作る（Playwright のデータ駆動テストの定石）
    lines.push(datasetSource(rec));
    lines.push('dataset.forEach((row, i) => {');
    lines.push(`  test(\`${name.replace(/`/g, '\\`')} [\${i + 1}/\${dataset.length}]\`, async ({ page }) => {`);
    lines.push('    const V = (s) => resolveTemplate(s, { now: __webrecNow, seq: __webrecSeq, data: row, row: i + 1 });');
    lines.push(...playwrightBody(rec, '    '));
    lines.push('  });');
    lines.push('});');
  } else {
    lines.push(`test(${jsStr(name)}, async ({ page }) => {`);
    lines.push(...playwrightBody(rec, '  '));
    lines.push('});');
  }

  lines.push('');
  return lines.join('\n');
}

function puppeteerBody(rec, ind) {
  const lines = [];
  lines.push(`${ind}await page.goto(${val(rec.startUrl)});`);

  let scopeVarCounter = 0;
  for (const step of rec.steps) {
    if (step.disabled) {
      lines.push(`${ind}// [無効化] ${stepSummary(step)}`);
      continue;
    }
    if (Number.isFinite(step.waitBeforeMs) && step.waitBeforeMs > 0) {
      lines.push(`${ind}await new Promise((r) => setTimeout(r, ${step.waitBeforeMs}));`);
    }
    // iframe 内のステップは、その都度フレームハンドルを解決してから操作する
    let scope = 'page';
    if (step.frames && step.frames.length) {
      const v = `frame${++scopeVarCounter}`;
      lines.push(`${ind}let ${v} = page;`);
      for (const f of step.frames) {
        if (typeof f !== 'string') {
          lines.push(`${ind}// 特定できない iframe: ${f.url}`);
          continue;
        }
        lines.push(`${ind}${v} = await (await ${v}.waitForSelector(${jsStr(f)})).contentFrame();`);
      }
      scope = v;
    }

    switch (step.type) {
      case 'navigate':
        lines.push(`${ind}await page.goto(${val(step.url)});`);
        break;
      case 'wait':
        lines.push(`${ind}await new Promise((r) => setTimeout(r, ${Number.isFinite(step.ms) ? step.ms : 1000}));`);
        break;
      case 'waitForSelector':
        lines.push(
          `${ind}await ${scope}.waitForSelector(${jsStr(step.selector)}${
            Number.isFinite(step.timeoutMs) ? `, { timeout: ${step.timeoutMs} }` : ''
          });`
        );
        break;
      case 'click':
        lines.push(`${ind}await ${scope}.click(${jsStr(step.selector)});`);
        break;
      case 'input':
        lines.push(`${ind}await ${scope}.click(${jsStr(step.selector)}, { clickCount: 3 });`);
        lines.push(`${ind}await ${scope}.type(${jsStr(step.selector)}, ${val(step.value)});`);
        break;
      case 'select':
        lines.push(`${ind}await ${scope}.select(${jsStr(step.selector)}, ${val(step.value)});`);
        break;
      case 'selectMultiple': {
        const args = (step.values || []).map((v) => val(v)).join(', ');
        lines.push(`${ind}await ${scope}.select(${jsStr(step.selector)}${args ? ', ' + args : ''});`);
        break;
      }
      case 'dragAndDrop':
        lines.push(
          `${ind}await (await ${scope}.waitForSelector(${jsStr(
            step.selector
          )})).drop(await ${scope}.waitForSelector(${jsStr(step.toSelector)}));`
        );
        break;
      case 'upload': {
        const args = (step.files || []).map((f) => jsStr(`./files/${f.name}`)).join(', ');
        lines.push(`${ind}await (await ${scope}.waitForSelector(${jsStr(step.selector)})).uploadFile(${args});`);
        break;
      }
      case 'keydown':
        lines.push(`${ind}await ${scope}.focus(${jsStr(step.selector)});`);
        lines.push(`${ind}await page.keyboard.press(${jsStr(step.key)});`);
        break;
      default:
        lines.push(`${ind}// 未対応のステップ: ${step.type}`);
    }
  }
  return lines;
}

export function generatePuppeteer(rec) {
  const lines = [];
  lines.push("const puppeteer = require('puppeteer');");
  lines.push('');
  const uploadNotice = uploadNoticeSource(rec);
  if (uploadNotice) lines.push(uploadNotice);
  if (recordingUsesTemplates(rec) || hasDataset(rec)) lines.push(templateHelperSource(rec));
  if (hasDataset(rec)) lines.push(datasetSource(rec));

  lines.push('(async () => {');
  lines.push('  const browser = await puppeteer.launch({ headless: false });');
  lines.push('  const page = await browser.newPage();');

  if (hasDataset(rec)) {
    // データ1行につきシナリオを1回流す
    lines.push('');
    lines.push('  for (let i = 0; i < dataset.length; i++) {');
    lines.push('    const row = dataset[i];');
    lines.push(
      '    const V = (s) => resolveTemplate(s, { now: __webrecNow, seq: __webrecSeq, data: row, row: i + 1 });'
    );
    lines.push('    console.log(`--- ${i + 1}/${dataset.length} 行目 ---`, row);');
    lines.push(...puppeteerBody(rec, '    '));
    lines.push('  }');
  } else {
    lines.push(...puppeteerBody(rec, '  '));
  }

  lines.push('');
  lines.push('  await browser.close();');
  lines.push('})();');
  lines.push('');
  return lines.join('\n');
}

export function generateScript(rec, format) {
  if (format === 'playwright') return generatePlaywright(rec);
  if (format === 'puppeteer') return generatePuppeteer(rec);
  return generateJson(rec);
}

export function stepSummary(step) {
  const inFrame =
    step.frames && step.frames.length
      ? ` [iframe: ${step.frames.map((f) => (typeof f === 'string' ? f : f.url)).join(' > ')}]`
      : '';
  switch (step.type) {
    case 'navigate':
      return `ページ遷移 -> ${step.url}`;
    case 'wait':
      return `待機: ${Number.isFinite(step.ms) ? step.ms : 1000}ms`;
    case 'waitForSelector':
      return `要素の出現待ち: ${step.selector}${inFrame}`;
    case 'upload': {
      const files = step.files || [];
      if (!files.length) return `ファイル選択を解除: ${step.selector}${inFrame}`;
      const names = files.map((f) => f.name + (f.omitted ? '（中身なし）' : '')).join(', ');
      return `ファイル選択: ${step.selector} = ${names}${inFrame}`;
    }
    case 'click':
      return `クリック: ${step.text ? `"${step.text}" ` : ''}${step.selector}${inFrame}`;
    case 'input':
      return `入力: ${step.selector} = "${step.value}"${inFrame}`;
    case 'select':
      return `選択: ${step.selector} = "${step.value}"${inFrame}`;
    case 'selectMultiple':
      return `複数選択: ${step.selector} = [${(step.values || []).join(', ')}]${inFrame}`;
    case 'dragAndDrop':
      return `ドラッグ&ドロップ: ${step.selector} -> ${step.toSelector}${inFrame}`;
    case 'keydown':
      return `キー入力: ${step.key} (${step.selector})${inFrame}`;
    default:
      return `${step.type}`;
  }
}
