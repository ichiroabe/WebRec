// test/*.test.mjs をすべて実行し、結果をまとめて報告する。
// 各スイートは独立したプロセスで動かす（グローバルを汚し合わないように）。

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2); // 例: npm test -- totp

const files = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !only.length || only.some((k) => f.includes(k)))
  .sort();

if (!files.length) {
  console.error(only.length ? `一致するテストがありません: ${only.join(', ')}` : 'テストが見つかりません');
  process.exit(1);
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ file, code, out }));
  });
}

const started = Date.now();
const results = [];
for (const file of files) {
  const r = await run(file);
  results.push(r);
  console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${file}`);
  // 失敗したものだけ出力を見せる（成功時の詳細は伏せて読みやすくする）
  if (r.code !== 0) {
    console.log(
      r.out
        .split('\n')
        .map((line) => '      ' + line)
        .join('\n')
    );
  }
}

const failed = results.filter((r) => r.code !== 0);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log('---');
console.log(`${results.length - failed.length}/${results.length} suites passed in ${seconds}s`);

if (failed.length) {
  console.log('failed: ' + failed.map((r) => r.file).join(', '));
  process.exit(1);
}
