// テストから拡張機能のソースを指すためのパス解決。
// 絶対パスを直接書くと別の環境で動かなくなるので、必ずここを経由する。

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, '..', '..', 'src');

// import() に渡す URL（例: srcUrl('generator.js')）
export function srcUrl(name) {
  return new URL(`../../src/${name}`, import.meta.url).href;
}

// readFileSync に渡すファイルパス（例: srcPath('content.js')）
export function srcPath(name) {
  return join(SRC_DIR, name);
}
