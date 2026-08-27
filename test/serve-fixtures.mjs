// 手動確認用のテストページを配信する小さなサーバー。
//   npm run serve  →  http://127.0.0.1:8791/complex.html
//
// 拡張機能そのものは chrome://extensions から読み込む。ここで配るのは
// 記録・再生を試すための題材のページだけ。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures');
const PORT = Number(process.env.PORT) || 8791;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  // ROOT の外を読ませない
  const target = normalize(join(ROOT, rel === '/' ? 'complex.html' : rel));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': TYPES[extname(target)] || 'application/octet-stream' });
    res.end(body);
  } catch (_) {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`テストページ: http://127.0.0.1:${PORT}/complex.html`);
  console.log(`入力パターン: http://127.0.0.1:${PORT}/patterns.html`);
  console.log('終了するには Ctrl+C');
});
