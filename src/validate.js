// WebRec: 録画データの整合性チェック。
// parseRecordingJson が「JSON として壊れていないか」を見るのに対し、
// こちらは「シナリオとして辻褄が合っているか」を見る。
//
// 例: {{data.氏名}} と書いてあるのにデータに「氏名」列が無い、など
//     JSON としては正しいが再生すると意図しない結果になるものを拾う。

const KNOWN_VARS = ['data', 'row', 'date', 'time', 'datetime', 'random', 'seq', 'uuid'];

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
  return out;
}

function isValidSelector(sel) {
  if (typeof document === 'undefined') return true; // DOM の無い環境では判定しない
  try {
    document.querySelector(sel);
    return true;
  } catch (_) {
    return false;
  }
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
    issues.push(issue('warning', 'no-steps', 'ステップが1つもありません。再生しても開始URLを開くだけです。'));
  }
  if (steps.length && steps.every((s) => s.disabled)) {
    issues.push(issue('warning', 'all-disabled', 'すべてのステップが無効化されています。'));
  }

  // --- データセット ---
  if (dataset) {
    if (!dataset.length) {
      issues.push(issue('warning', 'empty-dataset', 'データが空です。1回だけの実行になります。'));
    }
    // 行によって列が欠けていると、その行だけ {{data.○○}} が置換されない
    dataset.forEach((row, i) => {
      const missing = [...datasetColumns].filter((c) => !Object.prototype.hasOwnProperty.call(row, c));
      if (missing.length) {
        issues.push(
          issue('warning', 'dataset-ragged', `データ ${i + 1} 行目に列がありません: ${missing.join(', ')}`)
        );
      }
    });
  }

  // --- ステップごと ---
  const referencedColumns = new Set();

  steps.forEach((step, i) => {
    const at = `ステップ ${i + 1}`;

    // セレクタの構文
    if (typeof step.selector === 'string' && step.selector && !isValidSelector(step.selector)) {
      issues.push(issue('error', 'bad-selector', `${at}: セレクタとして解釈できません: ${step.selector}`, i));
    }
    if (step.type === 'dragAndDrop' && typeof step.toSelector === 'string' && !isValidSelector(step.toSelector)) {
      issues.push(issue('error', 'bad-selector', `${at}: 移動先セレクタが不正です: ${step.toSelector}`, i));
    }

    // 数値項目
    for (const key of ['timeoutMs', 'waitBeforeMs', 'ms']) {
      if (step[key] !== undefined) {
        if (!Number.isFinite(step[key])) {
          issues.push(issue('error', 'bad-number', `${at}: ${key} は数値で指定してください`, i));
        } else if (step[key] < 0) {
          issues.push(issue('error', 'bad-number', `${at}: ${key} に負の値は指定できません`, i));
        }
      }
    }

    // navigate の URL
    if (step.type === 'navigate' && typeof step.url === 'string' && step.url.indexOf('{{') === -1) {
      if (!/^https?:\/\//.test(step.url)) {
        issues.push(issue('error', 'bad-url', `${at}: url は http/https で始まる必要があります`, i));
      }
    }

    // 空の選択肢
    if (step.type === 'selectMultiple' && Array.isArray(step.values) && !step.values.length) {
      issues.push(issue('warning', 'empty-values', `${at}: 複数選択の値が空です（何も選ばれません）`, i));
    }

    // アップロード: 中身が保存されていないと再生できない
    if (step.type === 'upload') {
      for (const f of step.files || []) {
        if (f.omitted === 'too-large') {
          issues.push(
            issue('error', 'upload-too-large', `${at}: ${f.name} は大きすぎて保存されていません（8MBまで）`, i)
          );
        } else if (f.omitted) {
          issues.push(issue('error', 'upload-not-stored', `${at}: ${f.name} の中身を読み取れませんでした`, i));
        } else if (!f.fileId && !f.dataUrl) {
          issues.push(issue('error', 'upload-missing', `${at}: ${f.name} の中身が保存されていません`, i));
        }
      }
    }

    // 無効と任意の同時指定は意味がない
    if (step.disabled && step.optional) {
      issues.push(issue('info', 'disabled-and-optional', `${at}: 無効化されているため optional は効きません`, i));
    }

    // 記録時にマスクされたパスワードがそのまま残っている
    for (const v of valueStrings(step)) {
      if (v.includes('<PASSWORD>')) {
        issues.push(
          issue('warning', 'password-placeholder', `${at}: <PASSWORD> のままです。実際の値に書き換えてください`, i)
        );
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
            issues.push(issue('error', 'data-no-column', `${at}: ${whole} に列名がありません`, i));
          } else if (!dataset) {
            issues.push(
              issue('error', 'data-without-dataset', `${at}: ${whole} を使っていますが「データ」タブが空です`, i)
            );
          } else if (!datasetColumns.has(column)) {
            issues.push(
              issue(
                'error',
                'data-unknown-column',
                `${at}: データに「${column}」列がありません（ある列: ${[...datasetColumns].join(', ') || 'なし'}）`,
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
            issue('warning', 'unknown-var', `${at}: ${whole} は未対応の変数です。そのまま文字列として入力されます`, i)
          );
        }
      }
    }
  });

  // 開始URLの変数もチェック対象にする
  for (const varInfo of extractVars(rec.startUrl)) {
    if (!KNOWN_VARS.includes(varInfo.name) && varInfo.name.indexOf('data.') !== 0) {
      issues.push(issue('warning', 'unknown-var', `開始URL: ${varInfo.whole} は未対応の変数です`));
    }
  }

  // 使われていないデータ列
  if (dataset && datasetColumns.size) {
    const unused = [...datasetColumns].filter((c) => !referencedColumns.has(c));
    if (unused.length) {
      issues.push(
        issue('info', 'unused-column', `どのステップからも参照されていない列: ${unused.join(', ')}`)
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
  if (!errors.length && !warnings.length && !infos.length) return '問題は見つかりませんでした';
  const parts = [];
  if (errors.length) parts.push(`エラー ${errors.length}`);
  if (warnings.length) parts.push(`警告 ${warnings.length}`);
  if (infos.length) parts.push(`情報 ${infos.length}`);
  return parts.join(' / ');
}
