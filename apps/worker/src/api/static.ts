/** Serves the built hub (apps/web/dist) with an SPA fallback. No directory listing, no path escapes. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/** apps/worker/dist/api/static.js → apps/web/dist */
export function defaultWebDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return process.env.FINC_WEB_DIST?.trim() || path.resolve(here, '..', '..', '..', 'web', 'dist');
}

export function webDistExists(dir = defaultWebDist()): boolean {
  return existsSync(path.join(dir, 'index.html'));
}

export function serveStatic(dir: string, urlPath: string): Response | null {
  const index = path.join(dir, 'index.html');
  if (!existsSync(index)) return null;
  let clean: string;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0] ?? '/').replace(/\\/g, '/');
  } catch {
    return new Response('bad request', { status: 400 }); // a malformed % escape is the caller's problem, not a 500
  }
  const rel = clean.replace(/^\/+/, '');
  let file = path.resolve(dir, rel);
  // containment by path.relative, so a sibling folder with the same prefix (dist-old) cannot pass (audit L4)
  const inside = path.relative(path.resolve(dir), file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return new Response('forbidden', { status: 403 });
  if (!rel || !existsSync(file) || statSync(file).isDirectory()) file = index; // SPA fallback
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const immutable = rel.startsWith('assets/') && file !== index;
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (file === index) {
    headers['content-security-policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
    headers['referrer-policy'] = 'no-referrer';
  }
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, { status: 200, headers });
}
