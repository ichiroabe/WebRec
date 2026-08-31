// WebRec: 録画データの整合性チェック。
// parseRecordingJson が「JSON として壊れていないか」を見るのに対し、
// こちらは「シナリオとして辻褄が合っているか」を見る。
//
// 例: {{data.氏名}} と書いてあるのにデータに「氏名」列が無い、など
//     JSON としては正しいが再生すると意図しない結果になるものを拾う。

import { t } from './i18n.js';
import { normalizeAuthUrl } from './basicauth.js';

// normalizeAuthUrl が返す理由コードと、表示する文言の対応
const AUTH_URL_REASON = {
  empty: 'v.basicAuthUrlEmpty',
  unparsable: 'v.basicAuthUrlUnparsable',
  scheme: 'v.basicAuthUrlScheme',
  credentials: 'v.basicAuthUrlCredentials',
  specials: 'v.basicAuthUrlSpecials',
};

// normalizeAuthUrl が投げた例外を、表示言語に合わせた1行にする。
// 管理画面の「Basic認証」タブでも同じ文言を出すため、ここから公開している。
export function authUrlIssueMessage(err, index, url) {
  return t(AUTH_URL_REASON[err && err.code] || 'v.basicAuthUrlUnparsable', {
    at: t('v.basicAuthAt', { n: index + 1 }),
    url: String(url == null ? '' : url),
  });
}

const KNOWN_VARS = ['data', 'row', 'date', 'time', 'datetime', 'random', 'seq', 'uuid', 'totp'];

function issue(level, code, message, stepIndex = null) {
  return { level, code, message, stepIndex };
}

// 値の中の {{...}} をすべて取り出す
function extractVars(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const re = /\{\{([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    const idx = body.indexOf(':');
    const rawName = (idx === -1 ? body : body.slice(0, idx)).trim();
    out.push({ whole: m[0], rawName, name: rawName.toLowerCase() });
  }
  return out;
}

// 1つのステップが持つ「値になりうる文字列」を集める
function valueStrings(step) {
  const out = [];
  if (typeof step.value === 'string') out.push(step.value);
  if (typeof step.url === 'string') out.push(step.url);
  if (Array.isArray(step.values)) for (const v of step.values) if (typeof v === 'string') out.push(v);
  if (typeof step.answer === 'string') out.push(step.answer); // prompt に入力した文字
  return out;
}

// 表示テキストで指す独自表記（例: a:text("受信箱")）。CSS ではないので構文チェックの対象外
const TEXT_SELECTOR_RE = /^([a-zA-Z][\w-]*):text\("([\s\S]*)"\)$/;

function isValidSelector(sel) {
  if (TEXT_SELECTOR_RE.test(sel)) return true;
  if (typeof document === 'undefined') return true; // DOM の無い環境では判定しない
  // shadow DOM を跨ぐセレクタは " >>> " 区切り。区間ごとに構文を見る。
  for (const segment of String(sel).split(' >>> ')) {
    if (!segment.trim()) return false;
    try {
      document.querySelector(segment);
    } catch (_) {
      return false;
    }
  }
  return true;
}

export function validateRecording(rec) {
  const issues = [];
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  const dataset = Array.isArray(rec.dataset) ? rec.dataset : null;

  // データセットの列名を集める（行ごとに列が違う場合もあるので全行から）
  const datasetColumns = new Set();
  if (dataset) for (const row of dataset) for (const k of Object.keys(row)) datasetColumns.add(k);

  // --- 全体 ---
  if (!steps.length) {
    issues.push(issue('warning', 'no-steps', t('v.noSteps')));
  }
  if (steps.length && steps.every((s) => s.disabled)) {
    issues.push(issue('warning', 'all-disabled', t('v.allDisabled')));
  }

  // --- データセット ---
  if (dataset) {
    if (!dataset.length) {
      issues.push(issue('warning', 'empty-dataset', t('v.emptyDataset')));
    }
    // 行によって列が欠けていると、その行だけ {{data.○○}} が置換されない
    dataset.forEach((row, i) => {
      const missing = [...datasetColumns].filter((c) => !Object.prototype.hasOwnProperty.call(row, c));
      if (missing.length) {
        issues.push(
          issue('warning', 'dataset-ragged', t('v.datasetRagged', { row: i + 1, columns: missing.join(', ') }))
        );
      }
    });
  }

  // --- Basic 認証 ---
  // 資格情報は録画に平文で入り、JSON エクスポートにも含まれる。
  // TOTP シークレットと同じ「パスワード同等」の扱いをしていることを気づかせる。
  const basicAuth = Array.isArray(rec.basicAuth) ? rec.basicAuth : [];
  basicAuth.forEach((entry, i) => {
    const at = t('v.basicAuthAt', { n: i + 1 });
    if (!entry || typeof entry !== 'object') {
      issues.push(issue('error', 'basic-auth-bad-entry', t('v.basicAuthBadEntry', { at })));
      return;
    }
    try {
      normalizeAuthUrl(entry.url);
    } catch (err) {
      issues.push(issue('error', 'basic-auth-bad-url', authUrlIssueMessage(err, i, entry.url)));
    }
    if (!String(entry.username || '').trim()) {
      issues.push(issue('warning', 'basic-auth-no-user', t('v.basicAuthNoUser', { at })));
    }
    if (!String(entry.password || '')) {
      issues.push(issue('warning', 'basic-auth-no-password', t('v.basicAuthNoPassword', { at })));
    } else if (String(entry.password).includes('<PASSWORD>')) {
      issues.push(issue('warning', 'basic-auth-placeholder', t('v.basicAuthPlaceholder', { at })));
    }
  });
  if (basicAuth.length) {
    issues.push(issue('info', 'basic-auth-stored', t('v.basicAuthStored', { n: basicAuth.length })));
  }

  // --- ステップごと ---
  const referencedColumns = new Set();

  steps.forEach((step, i) => {
    const at = t('v.stepAt', { n: i + 1 });

    // セレクタの構文
    if (typeof step.selector === 'string' && step.selector && !isValidSelector(step.selector)) {
      issues.push(issue('error', 'bad-selector', t('v.badSelector', { at, selector: step.selector }), i));
    }
    if (step.type === 'dragAndDrop' && typeof step.toSelector === 'string' && !isValidSelector(step.toSelector)) {
      issues.push(issue('error', 'bad-selector', t('v.badToSelector', { at, selector: step.toSelector }), i));
    }

    // 代替セレクタ（候補）
    if (step.selectors !== undefined) {
      if (!Array.isArray(step.selectors) || !step.selectors.length) {
        issues.push(issue('error', 'bad-selectors', t('v.badSelectors', { at }), i));
      } else {
        const usable = step.selectors.filter((sel) => typeof sel === 'string' && sel && isValidSelector(sel));
        if (!usable.length) {
          issues.push(issue('error', 'bad-selectors', t('v.allSelectorsBad', { at }), i));
        } else if (usable.length < step.selectors.length) {
          issues.push(issue('warning', 'some-selectors-bad', t('v.someSelectorsBad', { at }), i));
        }
      }
    }

    // 検証ステップ
    if (step.type === 'assertText' || step.type === 'assertVisible' || step.type === 'assertMissing') {
      const hasTarget =
        (typeof step.selector === 'string' && step.selector) ||
        (Array.isArray(step.selectors) && step.selectors.length);
      if (!hasTarget) {
        issues.push(issue('error', 'assert-no-selector', t('v.assertNoSelector', { at }), i));
      }
      if (step.type === 'assertText' && !String(step.value == null ? '' : step.value).trim()) {
        issues.push(issue('error', 'assert-no-value', t('v.assertNoValue', { at }), i));
      }
      if (step.type === 'assertText' && step.match !== undefined && !['equals', 'contains'].includes(step.match)) {
        issues.push(issue('error', 'assert-bad-match', t('v.assertBadMatch', { at }), i));
      }
    }

    // 数値項目
    for (const key of ['timeoutMs', 'waitBeforeMs', 'ms']) {
      if (step[key] !== undefined) {
        if (!Number.isFinite(step[key])) {
          issues.push(issue('error', 'bad-number', t('v.badNumberType', { at, key }), i));
        } else if (step[key] < 0) {
          issues.push(issue('error', 'bad-number', t('v.badNumberNegative', { at, key }), i));
        }
      }
    }

    // navigate の URL
    if (step.type === 'navigate' && typeof step.url === 'string' && step.url.indexOf('{{') === -1) {
      if (!/^https?:\/\//.test(step.url)) {
        issues.push(issue('error', 'bad-url', t('v.badUrl', { at }), i));
      }
    }

    // ダイアログへの応答
    if (step.type === 'dialog') {
      if (!['alert', 'confirm', 'prompt'].includes(step.kind)) {
        issues.push(issue('error', 'dialog-bad-kind', t('v.dialogBadKind', { at, kind: String(step.kind) }), i));
      } else if (step.kind === 'confirm' && typeof step.answer !== 'boolean') {
        issues.push(issue('error', 'dialog-bad-answer', t('v.dialogBadConfirm', { at }), i));
      } else if (step.kind === 'prompt' && step.answer !== null && typeof step.answer !== 'string') {
        issues.push(issue('error', 'dialog-bad-answer', t('v.dialogBadPrompt', { at }), i));
      }
    }

    // 空の選択肢
    if (step.type === 'selectMultiple' && Array.isArray(step.values) && !step.values.length) {
      issues.push(issue('warning', 'empty-values', t('v.emptyValues', { at }), i));
    }

    // アップロード: 中身が保存されていないと再生できない
    if (step.type === 'upload') {
      for (const f of step.files || []) {
        if (f.omitted === 'too-large') {
          issues.push(
            issue('error', 'upload-too-large', t('v.uploadTooLarge', { at, name: f.name }), i)
          );
        } else if (f.omitted) {
          issues.push(issue('error', 'upload-not-stored', t('v.uploadNotStored', { at, name: f.name }), i));
        } else if (!f.fileId && !f.dataUrl) {
          issues.push(issue('error', 'upload-missing', t('v.uploadMissing', { at, name: f.name }), i));
        }
      }
    }

    // 無効と任意の同時指定は意味がない
    if (step.disabled && step.optional) {
      issues.push(issue('info', 'disabled-and-optional', t('v.disabledAndOptional', { at }), i));
    }

    // 記録時にマスクされたパスワードがそのまま残っている
    for (const v of valueStrings(step)) {
      if (v.includes('<PASSWORD>')) {
        issues.push(
          issue('warning', 'password-placeholder', t('v.passwordPlaceholder', { at }), i)
        );
      }
      // ワンタイムパスワードは記録した数字が使えないので、必ず書き換えが要る
      if (v.includes('<OTP>')) {
        issues.push(issue('error', 'otp-placeholder', t('v.otpPlaceholder', { at }), i));
      }
    }

    // テンプレート変数
    for (const v of valueStrings(step)) {
      for (const varInfo of extractVars(v)) {
        const { name, rawName, whole } = varInfo;

        if (name === 'data' || name.indexOf('data.') === 0) {
          const dot = rawName.indexOf('.');
          const key = dot === -1 ? '' : rawName.slice(dot + 1).trim();
          const colonKey = dot === -1 ? (v.match(/\{\{data:([^}|]+)/) || [])[1] : null;
          const column = (key || (colonKey || '').trim()).trim();

          if (!column) {
            issues.push(issue('error', 'data-no-column', t('v.dataNoColumn', { at, var: whole }), i));
          } else if (!dataset) {
            issues.push(
              issue('error', 'data-without-dataset', t('v.dataWithoutDataset', { at, var: whole }), i)
            );
          } else if (!datasetColumns.has(column)) {
            issues.push(
              issue(
                'error',
                'data-unknown-column',
                t('v.dataUnknownColumn', {
                  at,
                  column,
                  available: [...datasetColumns].join(', ') || t('v.noColumns'),
                }),
                i
              )
            );
          } else {
            referencedColumns.add(column);
          }
          continue;
        }

        if (!KNOWN_VARS.includes(name)) {
          issues.push(
            issue('warning', 'unknown-var', t('v.unknownVar', { at, var: whole }), i)
          );
        }
      }
    }
  });

  // 開始URLの変数もチェック対象にする
  for (const varInfo of extractVars(rec.startUrl)) {
    if (!KNOWN_VARS.includes(varInfo.name) && varInfo.name.indexOf('data.') !== 0) {
      issues.push(issue('warning', 'unknown-var', t('v.unknownVarStartUrl', { var: varInfo.whole })));
    }
  }

  // 使われていないデータ列
  if (dataset && datasetColumns.size) {
    const unused = [...datasetColumns].filter((c) => !referencedColumns.has(c));
    if (unused.length) {
      issues.push(
        issue('info', 'unused-column', t('v.unusedColumn', { columns: unused.join(', ') }))
      );
    }
  }

  return {
    issues,
    errors: issues.filter((x) => x.level === 'error'),
    warnings: issues.filter((x) => x.level === 'warning'),
    infos: issues.filter((x) => x.level === 'info'),
  };
}

export function summarize(result) {
  const { errors, warnings, infos } = result;
  if (!errors.length && !warnings.length && !infos.length) return t('json.noIssues');
  const parts = [];
  if (errors.length) parts.push(t('json.summaryErrors', { n: errors.length }));
  if (warnings.length) parts.push(t('json.summaryWarnings', { n: warnings.length }));
  if (infos.length) parts.push(t('json.summaryInfos', { n: infos.length }));
  return parts.join(' / ');
}
