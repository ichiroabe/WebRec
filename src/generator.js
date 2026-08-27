// WebRec: 記録したステップ列から、再現可能なスクリプトを生成する。

import { resolveTemplate } from './template.js';
import { t } from './i18n.js';

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

function usesTotp(rec) {
  const has = (v) => typeof v === 'string' && v.indexOf('{{totp:') !== -1;
  if (has(rec.startUrl)) return true;
  return (rec.steps || []).some(
    (s) => has(s.value) || has(s.url) || (Array.isArray(s.values) && s.values.some(has))
  );
}

// 書き出したスクリプト用の TOTP。Node の crypto は同期なので V を非同期にしなくて済む。
function totpEngineSource() {
  return [
    "const __webrecCrypto = require('crypto');",
    '',
    '// {{totp:SECRET}} を実行時に計算する (RFC 6238)',
    'function __webrecBase32(input) {',
    "  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';",
    "  const clean = String(input).toUpperCase().replace(/[=\\s-]/g, '');",
    '  let bits = 0, value = 0;',
    '  const out = [];',
    '  for (const ch of clean) {',
    '    const idx = alphabet.indexOf(ch);',
    "    if (idx === -1) throw new Error('invalid base32 character: ' + ch);",
    '    value = (value << 5) | idx;',
    '    bits += 5;',
    '    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }',
    '  }',
    '  return Buffer.from(out);',
    '}',
    '',
    'function __webrecTotp(secret, digits) {',
    '  const d = digits || 6;',
    '  const counter = Math.floor(Date.now() / 1000 / 30);',
    '  const buf = Buffer.alloc(8);',
    '  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);',
    '  buf.writeUInt32BE(counter >>> 0, 4);',
    "  const h = __webrecCrypto.createHmac('sha1', __webrecBase32(secret)).update(buf).digest();",
    '  const off = h[h.length - 1] & 0x0f;',
    '  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);',
    "  return String(code % Math.pow(10, d)).padStart(d, '0');",
    '}',
    '',
    '// V に渡る前に {{totp:...}} だけ先に解決する',
    'function __webrecTotpPass(s) {',
    "  if (typeof s !== 'string' || s.indexOf('{{totp:') === -1) return s;",
    '  return s.replace(/\\{\\{totp:([^}]+)\\}\\}/g, function (whole, body) {',
    "    const args = body.split('|');",
    '    try { return __webrecTotp(args[0].trim(), Number(args[1]) || 6); } catch (_) { return whole; }',
    '  });',
    '}',
    '',
  ].join('\n');
}

// データセットがなければ V は 1 つだけ。あれば行ごとに定義するのでここでは出さない。
function templateHelperSource(rec) {
  const parts = [templateEngineSource()];
  if (usesTotp(rec)) parts.push(totpEngineSource());
  if (!hasDataset(rec)) {
    const inner = usesTotp(rec) ? '__webrecTotpPass(s)' : 's';
    parts.push(`const V = (s) => resolveTemplate(${inner}, { now: __webrecNow, seq: __webrecSeq });`, '');
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
  'dblclick',
  'contextmenu',
  'editable',
  'scroll',
  'pointerPath',
  'newTab',
  'assertText',
  'assertVisible',
  'assertMissing',
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
    } else if (step.type === 'newTab') {
      // 新しいタブを掴むだけなので対象要素は不要
    } else if (step.type === 'scroll' && !step.selector) {
      // ウィンドウ全体のスクロール
      if (!Number.isFinite(step.x) || !Number.isFinite(step.y)) {
        throw new Error(`${at}.x / ${at}.y は数値である必要があります`);
      }
    } else {
      // 対象は selector（1本）でも selectors（候補の配列）でも良い
      const hasSelector = typeof step.selector === 'string' && step.selector;
      const hasCandidates = Array.isArray(step.selectors) && step.selectors.some((sel) => typeof sel === 'string' && sel);
      if (!hasSelector && !hasCandidates) {
        throw new Error(`${at}.selector がありません`);
      }
    }
    if (step.selectors !== undefined) {
      if (!Array.isArray(step.selectors) || !step.selectors.length) {
        throw new Error(`${at}.selectors は1つ以上のセレクタの配列である必要があります`);
      }
      step.selectors.forEach((sel, j) => {
        if (typeof sel !== 'string' || !sel) {
          throw new Error(`${at}.selectors[${j}] は空でない文字列である必要があります`);
        }
      });
    }
    if (step.type === 'assertText' && typeof step.value !== 'string') {
      throw new Error(`${at}.value（期待する文言）がありません`);
    }
    if (step.type === 'selectMultiple' && !Array.isArray(step.values)) {
      throw new Error(`${at}.values は配列である必要があります`);
    }
    if (step.type === 'dragAndDrop' && typeof step.toSelector !== 'string') {
      throw new Error(`${at}.toSelector がありません`);
    }
    if (step.type === 'editable' && typeof step.html !== 'string') {
      throw new Error(`${at}.html がありません`);
    }
    if (step.type === 'pointerPath') {
      if (!Array.isArray(step.points) || step.points.length < 2) {
        throw new Error(`${at}.points は2点以上の配列である必要があります`);
      }
      step.points.forEach((pt, j) => {
        if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
          throw new Error(`${at}.points[${j}] は { x, y } 形式である必要があります`);
        }
      });
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

// Playwright の CSS エンジンは open な shadow root を自動で貫通するため、
// 記録した "host >>> inner" のうち最後の区間だけを渡せばよい。
function pwSel(selector) {
  const parts = String(selector).split(' >>> ');
  return parts[parts.length - 1];
}

// 書き出すコードには1本しか書けないため、候補の中から CSS として使える先頭を選ぶ。
// 表示テキスト表記（tag:text("...")）は CSS ではないので避ける。
function primarySelector(step) {
  if (typeof step.selector === 'string' && step.selector) return step.selector;
  const list = Array.isArray(step.selectors) ? step.selectors : [];
  return list.find((sel) => !/^[a-zA-Z][\w-]*:text\(/.test(sel)) || list[0] || '';
}

// フレーム内（<iframe> / frameset の <frame>）のステップは
// page.frameLocator(...) を連ねたスコープから辿る
function pwScope(step) {
  if (!step.frames || !step.frames.length) return 'page';
  const parts = step.frames.map((f) =>
    typeof f === 'string' ? `.frameLocator(${jsStr(f)})` : `/* 特定できないフレーム: ${f.url} */`
  );
  return 'page' + parts.join('');
}

// シナリオ本体（開始URL + 全ステップ）を、指定のインデントで組み立てる
function playwrightBody(rec, ind) {
  const lines = [];
  lines.push(`${ind}await page.goto(${val(rec.startUrl)});`);

  for (let step of rec.steps) {
    step = { ...step, selector: primarySelector(step) };
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
          `${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).waitFor(${
            Number.isFinite(step.timeoutMs) ? `{ timeout: ${step.timeoutMs} }` : ''
          });`
        );
        break;
      case 'assertText':
        lines.push(
          `${ind}await expect(${scope}.locator(${jsStr(pwSel(step.selector))})).${
            step.match === 'equals' ? 'toHaveText' : 'toContainText'
          }(${val(step.value)});`
        );
        break;
      case 'assertVisible':
        lines.push(`${ind}await expect(${scope}.locator(${jsStr(pwSel(step.selector))})).toBeVisible();`);
        break;
      case 'assertMissing':
        lines.push(`${ind}await expect(${scope}.locator(${jsStr(pwSel(step.selector))})).toHaveCount(0);`);
        break;
      case 'click':
        lines.push(`${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).click();`);
        break;
      case 'input':
        lines.push(`${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).fill(${val(step.value)});`);
        break;
      case 'select':
        lines.push(`${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).selectOption(${val(step.value)});`);
        break;
      case 'selectMultiple':
        lines.push(`${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).selectOption(${valArray(step.values)});`);
        break;
      case 'dragAndDrop':
        lines.push(
          `${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).dragTo(${scope}.locator(${jsStr(pwSel(step.toSelector))}));`
        );
        break;
      case 'upload': {
        // 書き出したスクリプトはローカルのファイルパスを渡す方式にする。
        // 管理画面の「保存」から取り出したファイルを files/ に置いて実行する。
        const paths = (step.files || []).map((f) => `./files/${f.name}`);
        lines.push(`${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).setInputFiles(${JSON.stringify(paths)});`);
        break;
      }
      case 'dblclick':
        lines.push(`${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).dblclick();`);
        break;
      case 'contextmenu':
        lines.push(`${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).click({ button: 'right' });`);
        break;
      case 'editable':
        lines.push(
          `${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).evaluate((el, html) => {`,
          `${ind}  el.innerHTML = html;`,
          `${ind}  el.dispatchEvent(new InputEvent('input', { bubbles: true }));`,
          `${ind}}, ${val(step.html)});`
        );
        break;
      case 'scroll':
        if (step.selector) {
          lines.push(
            `${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).evaluate((el) => el.scrollTo(${
              step.x || 0
            }, ${step.y || 0}));`
          );
        } else {
          lines.push(`${ind}await page.evaluate(() => window.scrollTo(${step.x || 0}, ${step.y || 0}));`);
        }
        break;
      case 'pointerPath': {
        const pts = JSON.stringify(step.points || []);
        lines.push(
          `${ind}{`,
          `${ind}  const box = await ${scope}.locator(${jsStr(pwSel(step.selector))}).boundingBox();`,
          `${ind}  const pts = ${pts};`,
          `${ind}  await page.mouse.move(box.x + pts[0].x, box.y + pts[0].y);`,
          `${ind}  await page.mouse.down();`,
          `${ind}  for (const p of pts.slice(1)) await page.mouse.move(box.x + p.x, box.y + p.y);`,
          `${ind}  await page.mouse.up();`,
          `${ind}}`
        );
        break;
      }
      case 'newTab':
        lines.push(`${ind}page = await page.context().waitForEvent('page'); // 新しいタブに移る`);
        lines.push(`${ind}await page.waitForLoadState();`);
        break;
      case 'keydown':
        lines.push(`${ind}await ${scope}.locator(${jsStr(pwSel(step.selector))}).press(${jsStr(step.key)});`);
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
    const inner = usesTotp(rec) ? '__webrecTotpPass(s)' : 's';
    lines.push(
      `    const V = (s) => resolveTemplate(${inner}, { now: __webrecNow, seq: __webrecSeq, data: row, row: i + 1 });`
    );
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
  for (let step of rec.steps) {
    step = { ...step, selector: primarySelector(step) };
    if (step.disabled) {
      lines.push(`${ind}// [無効化] ${stepSummary(step)}`);
      continue;
    }
    if (Number.isFinite(step.waitBeforeMs) && step.waitBeforeMs > 0) {
      lines.push(`${ind}await new Promise((r) => setTimeout(r, ${step.waitBeforeMs}));`);
    }
    // フレーム内のステップは、その都度フレームハンドルを解決してから操作する
    let scope = 'page';
    if (step.frames && step.frames.length) {
      const v = `frame${++scopeVarCounter}`;
      lines.push(`${ind}let ${v} = page;`);
      for (const f of step.frames) {
        if (typeof f !== 'string') {
          lines.push(`${ind}// 特定できないフレーム: ${f.url}`);
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
      case 'assertText': {
        const v = `text${++scopeVarCounter}`;
        lines.push(`${ind}const ${v} = await ${scope}.$eval(${jsStr(step.selector)}, (el) => el.innerText || el.value || '');`);
        lines.push(
          `${ind}if (${step.match === 'equals' ? `${v}.trim() !== ${val(step.value)}` : `!${v}.includes(${val(step.value)})`}) throw new Error('assertText failed: ' + ${v});`
        );
        break;
      }
      case 'assertVisible':
        lines.push(`${ind}await ${scope}.waitForSelector(${jsStr(step.selector)}, { visible: true });`);
        break;
      case 'assertMissing':
        lines.push(`${ind}await ${scope}.waitForSelector(${jsStr(step.selector)}, { hidden: true });`);
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
      case 'dblclick':
        lines.push(`${ind}await ${scope}.click(${jsStr(step.selector)}, { clickCount: 2 });`);
        break;
      case 'contextmenu':
        lines.push(`${ind}await ${scope}.click(${jsStr(step.selector)}, { button: 'right' });`);
        break;
      case 'editable':
        lines.push(
          `${ind}await ${scope}.$eval(${jsStr(step.selector)}, (el, html) => {`,
          `${ind}  el.innerHTML = html;`,
          `${ind}  el.dispatchEvent(new InputEvent('input', { bubbles: true }));`,
          `${ind}}, ${val(step.html)});`
        );
        break;
      case 'scroll':
        if (step.selector) {
          lines.push(
            `${ind}await ${scope}.$eval(${jsStr(step.selector)}, (el) => el.scrollTo(${step.x || 0}, ${step.y || 0}));`
          );
        } else {
          lines.push(`${ind}await page.evaluate(() => window.scrollTo(${step.x || 0}, ${step.y || 0}));`);
        }
        break;
      case 'pointerPath': {
        const pts = JSON.stringify(step.points || []);
        lines.push(
          `${ind}{`,
          `${ind}  const box = await (await ${scope}.waitForSelector(${jsStr(step.selector)})).boundingBox();`,
          `${ind}  const pts = ${pts};`,
          `${ind}  await page.mouse.move(box.x + pts[0].x, box.y + pts[0].y);`,
          `${ind}  await page.mouse.down();`,
          `${ind}  for (const p of pts.slice(1)) await page.mouse.move(box.x + p.x, box.y + p.y);`,
          `${ind}  await page.mouse.up();`,
          `${ind}}`
        );
        break;
      }
      case 'newTab':
        lines.push(`${ind}await new Promise((r) => setTimeout(r, 500));`);
        lines.push(`${ind}page = (await browser.pages()).slice(-1)[0]; // 新しいタブに移る`);
        break;
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
  // newTab ステップで page を差し替えるため、その場合だけ let にする
  const usesNewTab = (rec.steps || []).some((st) => st.type === 'newTab');
  lines.push(`  ${usesNewTab ? 'let' : 'const'} page = await browser.newPage();`);

  if (hasDataset(rec)) {
    // データ1行につきシナリオを1回流す
    lines.push('');
    lines.push('  for (let i = 0; i < dataset.length; i++) {');
    lines.push('    const row = dataset[i];');
    lines.push(
      `    const V = (s) => resolveTemplate(${
        usesTotp(rec) ? '__webrecTotpPass(s)' : 's'
      }, { now: __webrecNow, seq: __webrecSeq, data: row, row: i + 1 });`
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
      ? t('step.inFrame', { frames: step.frames.map((f) => (typeof f === 'string' ? f : f.url)).join(' > ') })
      : '';
  switch (step.type) {
    case 'navigate':
      return t('step.navigate', { url: step.url });
    case 'wait':
      return t('step.wait', { ms: Number.isFinite(step.ms) ? step.ms : 1000 });
    case 'waitForSelector':
      return t('step.waitForSelector', { selector: step.selector }) + inFrame;
    case 'assertText':
      return (
        t(step.match === 'equals' ? 'step.assertTextEquals' : 'step.assertTextContains', {
          selector: step.selector,
          value: step.value,
        }) + inFrame
      );
    case 'assertVisible':
      return t('step.assertVisible', { selector: step.selector }) + inFrame;
    case 'assertMissing':
      return t('step.assertMissing', { selector: step.selector }) + inFrame;
    case 'dblclick':
      return t('step.dblclick', { text: step.text ? `"${step.text}" ` : '', selector: step.selector }) + inFrame;
    case 'contextmenu':
      return t('step.contextmenu', { text: step.text ? `"${step.text}" ` : '', selector: step.selector }) + inFrame;
    case 'editable':
      return t('step.editable', { selector: step.selector, text: step.text || '' }) + inFrame;
    case 'scroll':
      return step.selector
        ? t('step.scrollElement', { selector: step.selector, x: step.x, y: step.y }) + inFrame
        : t('step.scrollWindow', { x: step.x, y: step.y });
    case 'pointerPath':
      return t('step.pointerPath', { selector: step.selector, n: (step.points || []).length }) + inFrame;
    case 'newTab':
      return t('step.newTab', { url: step.url || '' });
    case 'upload': {
      const files = step.files || [];
      if (!files.length) return t('step.uploadClear', { selector: step.selector }) + inFrame;
      const names = files.map((f) => f.name + (f.omitted ? t('step.uploadOmitted') : '')).join(', ');
      return t('step.upload', { selector: step.selector, names }) + inFrame;
    }
    case 'click':
      return t('step.click', { text: step.text ? `"${step.text}" ` : '', selector: step.selector }) + inFrame;
    case 'input':
      return t('step.input', { selector: step.selector, value: step.value }) + inFrame;
    case 'select':
      return t('step.select', { selector: step.selector, value: step.value }) + inFrame;
    case 'selectMultiple':
      return t('step.selectMultiple', { selector: step.selector, values: (step.values || []).join(', ') }) + inFrame;
    case 'dragAndDrop':
      return t('step.dragAndDrop', { selector: step.selector, toSelector: step.toSelector }) + inFrame;
    case 'keydown':
      return t('step.keydown', { key: step.key, selector: step.selector }) + inFrame;
    default:
      return `${step.type}`;
  }
}
