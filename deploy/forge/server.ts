/**
 * VOLUND FORGE — static file server.
 *
 * Streams the Vite-built `dist/` as a SPA. Non-asset paths (anything that
 * doesn't resolve to a real file under /assets) fall through to /index.html
 * so the React Router (BrowserRouter) handles deep links like /demandas
 * and the 404 page on real misses.
 *
 * Logging is one line per request so Easypanel can pick it up. The server
 * also supports SPA-style history fallback via the `Bun.serve.routes` /
 * fetch combination below.
 */
import { file, serve, ServerWebSocket } from 'bun';
import { join, normalize, resolve } from 'node:path';

const DIST = resolve(import.meta.dir, 'dist');
const PORT = Number(process.env.PORT ?? 5180);
const HOSTNAME = process.env.HOSTNAME ?? '0.0.0.0';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function mimeFor(path: string): string {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return MIME[path.slice(i).toLowerCase()] ?? 'application/octet-stream';
}

const server = serve({
  port: PORT,
  hostname: HOSTNAME,
  development: false,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Only allow assets inside DIST (no path traversal)
    const candidate = normalize(join(DIST, pathname));
    if (!candidate.startsWith(DIST)) {
      return new Response('forbidden', { status: 403 });
    }

    const f = file(candidate);
    if (await f.exists()) {
      return new Response(f, { headers: { 'content-type': mimeFor(candidate) } });
    }

    // SPA fallback: anything that doesn't resolve to a real file under /assets
    // gets the index. Real misses (like /assets/missing.png) are 404.
    if (pathname.startsWith('/assets/')) {
      return new Response('not found', { status: 404 });
    }
    const index = file(join(DIST, 'index.html'));
    return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

console.log(`[forge] listening on http://${server.hostname}:${server.port}`);
