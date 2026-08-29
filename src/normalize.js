// WebRec: 記録し終えたステップ列を整理する。
//
// 記録中に間引くのではなく、記録が終わってからまとめて処理する。
// そうすると条件を変えてやり直せるし、この関数だけを単体で確かめられる。
//
// 何度かけても結果が変わらない（冪等）ようにしてある。

// 「同じ対象への連続」を畳んでよい種類。
// click / keydown / upload / navigate は 1 回ずつに意味があるので対象外。
const COLLAPSIBLE = new Set(['input', 'select', 'selectMultiple', 'editable', 'scroll']);

// フレームの位置まで一致していないと「同じ対象」とは言えない
function sameFrames(a, b) {
  const fa = a.frames || [];
  const fb = b.frames || [];
  if (fa.length !== fb.length) return false;
  return fa.every((v, i) => JSON.stringify(v) === JSON.stringify(fb[i]));
}

function sameTarget(a, b) {
  if (a.type !== b.type) return false;
  if (!COLLAPSIBLE.has(a.type)) return false;
  // scroll はウィンドウ全体（selector なし）もありうる
  if ((a.selector || null) !== (b.selector || null)) return false;
  return sameFrames(a, b);
}

// 手で無効化した指定などを畳んで消してしまわないよう、
// 意図が入っているステップは残す
function hasIntent(step) {
  return !!(step.disabled || step.optional || step.waitBeforeMs || step.timeoutMs);
}

/**
 * 連続する同じ対象の操作を、最後の 1 つにまとめる。
 * 例) 同じ欄への入力が続けて 3 件 → 最後の値だけ残す
 *     同じ場所へのスクロールが続けて 4 件 → 最後の位置だけ残す
 *
 * @returns {{ steps: any[], removed: number, byType: Record<string, number> }}
 */
export function normalizeSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const out = [];
  const byType = {};

  for (const step of list) {
    const prev = out[out.length - 1];
    if (prev && sameTarget(prev, step) && !hasIntent(prev)) {
      out[out.length - 1] = step; // 後から来た方が確定値
      byType[step.type] = (byType[step.type] || 0) + 1;
      continue;
    }
    out.push(step);
  }

  return { steps: out, removed: list.length - out.length, byType };
}

// 整理した結果を「入力 2 件 / スクロール 3 件」のように読める形にする
export function describeNormalization(byType, label) {
  return Object.entries(byType)
    .map(([type, n]) => `${label(type)} ${n}`)
    .join(' / ');
}
