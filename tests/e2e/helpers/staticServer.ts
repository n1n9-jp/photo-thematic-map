import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

export interface StaticServer {
  /** 例: `http://127.0.0.1:12345`（末尾にスラッシュなし） */
  origin: string;
  close(): Promise<void>;
}

/**
 * `dir` を `prefix`（例: `/photo-thematic-map/`）の下で配信する静的サーバー。
 * GitHub Pages のサブパス配信の再現用。存在しないパスは 404 を返す（index.html に逃がさない）。
 */
export async function serveUnderPrefix(dir: string, prefix: string): Promise<StaticServer> {
  const base = resolve(dir);
  const server: Server = createServer((req, res) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      if (!pathname.startsWith(prefix)) return notFound(res);
      let rel = normalize(pathname.slice(prefix.length));
      if (rel === '' || rel.endsWith('/') || rel === '.') rel = join(rel, 'index.html');
      const file = join(base, rel);
      if (!file.startsWith(base)) return notFound(res);
      try {
        if (!(await stat(file)).isFile()) return notFound(res);
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        notFound(res);
      }
    })();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

function notFound(res: import('node:http').ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}
