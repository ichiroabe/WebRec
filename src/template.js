// WebRec: 入力値に埋め込むテンプレート変数。
// 例: {{date:YYYY-MM-DD}} / {{date:YYYY年MM月DD日|+1d}} / {{random:0000}} / {{seq:000}}
//
// この関数は「自己完結」であること。generator.js が Function.prototype.toString() で
// そのままソースを書き出し、生成した Playwright / Puppeteer スクリプトの中でも
// 同じ結果になるようにしているため、外部の変数や関数を参照してはいけない。

export function resolveTemplate(text, ctx) {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text;

  const now = ctx && ctx.now ? new Date(ctx.now) : new Date();
  const seq = ctx && isFinite(ctx.seq) ? Number(ctx.seq) : 1;

  function pad(n, len) {
    let s = String(Math.abs(Math.trunc(n)));
    while (s.length < len) s = '0' + s;
    return s;
  }

  // +1d / -3m / +2w / +1y といった相対指定
  function applyOffset(base, spec) {
    const m = /^([+-])(\d+)([dwmy])$/.exec(spec);
    if (!m) return base;
    const n = (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10);
    const d = new Date(base.getTime());
    if (m[3] === 'd') d.setDate(d.getDate() + n);
    else if (m[3] === 'w') d.setDate(d.getDate() + n * 7);
    else if (m[3] === 'm') d.setMonth(d.getMonth() + n);
    else if (m[3] === 'y') d.setFullYear(d.getFullYear() + n);
    return d;
  }

  function formatDate(d, fmt) {
    const map = {
      YYYY: String(d.getFullYear()),
      YY: pad(d.getFullYear() % 100, 2),
      MM: pad(d.getMonth() + 1, 2),
      M: String(d.getMonth() + 1),
      DD: pad(d.getDate(), 2),
      D: String(d.getDate()),
      HH: pad(d.getHours(), 2),
      H: String(d.getHours()),
      mm: pad(d.getMinutes(), 2),
      m: String(d.getMinutes()),
      ss: pad(d.getSeconds(), 2),
      s: String(d.getSeconds()),
    };
    return fmt.replace(/YYYY|YY|MM|DD|HH|mm|ss|M|D|H|m|s/g, function (t) {
      return map[t];
    });
  }

  // マスク "0000" は 0 埋め、"####" は 0 埋めなし
  function byMask(value, mask) {
    if (/^0+$/.test(mask)) return pad(value, mask.length);
    return String(Math.trunc(value));
  }

  return text.replace(/\{\{([^}]+)\}\}/g, function (whole, body) {
    const idx = body.indexOf(':');
    // データ列名は大小文字を区別するため、生の名前も保持する
    const rawName = (idx === -1 ? body : body.slice(0, idx)).trim();
    const name = rawName.toLowerCase();
    const rest = idx === -1 ? '' : body.slice(idx + 1);
    const args = rest === '' ? [] : rest.split('|');

    // {{data.列名}} / {{data:列名}} … 繰り返し実行中の現在行の値
    if (name === 'data' || name.indexOf('data.') === 0) {
      const dot = rawName.indexOf('.');
      const key = dot === -1 ? (args[0] || '').trim() : rawName.slice(dot + 1).trim();
      const data = ctx && ctx.data;
      if (!data || !key || !Object.prototype.hasOwnProperty.call(data, key)) return whole;
      const v = data[key];
      return v === null || v === undefined ? '' : String(v);
    }

    // {{row}} / {{row:000}} … 現在が何行目か（1 始まり）
    if (name === 'row') {
      const rowNo = ctx && isFinite(ctx.row) ? Number(ctx.row) : 1;
      return byMask(rowNo, (args[0] || '#').trim());
    }

    if (name === 'date' || name === 'time' || name === 'datetime') {
      let fmt = null;
      let offset = null;
      for (let i = 0; i < args.length; i++) {
        const a = args[i].trim();
        if (/^[+-]\d+[dwmy]$/.test(a)) offset = a;
        else if (args[i] !== '') fmt = args[i];
      }
      const d = offset ? applyOffset(now, offset) : now;
      if (!fmt) {
        fmt = name === 'time' ? 'HH:mm:ss' : name === 'datetime' ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD';
      }
      return formatDate(d, fmt);
    }

    if (name === 'random') {
      const spec = (args[0] || '####').trim();
      const range = /^(\d+)-(\d+)$/.exec(spec);
      if (range) {
        const lo = parseInt(range[1], 10);
        const hi = parseInt(range[2], 10);
        if (hi >= lo) return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
        return String(lo);
      }
      const len = Math.max(1, spec.length);
      const max = Math.pow(10, len) - 1;
      return byMask(Math.floor(Math.random() * (max + 1)), spec);
    }

    if (name === 'seq') {
      return byMask(seq, (args[0] || '#').trim());
    }

    if (name === 'uuid') {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    }

    return whole; // 未知の変数は置換せずそのまま残す
  });
}

// ステップ内のテンプレートを解決した新しいステップを返す（元のステップは変更しない）
export function resolveStepTemplates(step, ctx) {
  const out = { ...step };
  if (typeof out.value === 'string') out.value = resolveTemplate(out.value, ctx);
  if (Array.isArray(out.values)) out.values = out.values.map((v) => resolveTemplate(v, ctx));
  if (typeof out.url === 'string') out.url = resolveTemplate(out.url, ctx);
  return out;
}

// 管理画面でのプレビュー用。テンプレートを含む場合だけ解決後の値を返す。
export function previewTemplate(text, ctx) {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return null;
  const resolved = resolveTemplate(text, ctx);
  return resolved === text ? null : resolved;
}

export const TEMPLATE_HELP = [
  { syntax: '{{data.列名}}', desc: '「データ」タブの現在行の値（繰り返し実行）' },
  { syntax: '{{row}}', desc: '現在が何行目か（1, 2, 3 …）' },
  { syntax: '{{row:000}}', desc: '同上を0埋め（001, 002 …）' },
  { syntax: '{{date}}', desc: '本日 (YYYY-MM-DD)' },
  { syntax: '{{date:YYYY年MM月DD日}}', desc: '書式を指定した本日' },
  { syntax: '{{date:YYYY/MM/DD|+1d}}', desc: '翌日 (+1d / -3d / +2w / +1m / -1y)' },
  { syntax: '{{date:YYYY}} {{date:MM}} {{date:DD}}', desc: '年・月・日を個別の欄に入れる' },
  { syntax: '{{time:HH:mm}}', desc: '現在時刻' },
  { syntax: '{{datetime}}', desc: '日時 (YYYY-MM-DD HH:mm:ss)' },
  { syntax: '{{random:0000}}', desc: '4桁の乱数 (0埋め)。#### なら0埋めなし' },
  { syntax: '{{random:1-100}}', desc: '1〜100 の乱数' },
  { syntax: '{{seq}}', desc: '再生するたびに1増える通し番号（0埋めなし）' },
  { syntax: '{{seq:000}}', desc: '同上を0埋め（001, 002 …）' },
  { syntax: '{{uuid}}', desc: 'ランダムなUUID' },
];
