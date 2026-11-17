// Runs the Quiet List server on Node 22.13+ with a local SQLite file. No dependencies.
//
//   SETUP_CODE=<long random text> node server/node.js
//
// Environment: PORT (8080), HOST (127.0.0.1), DATA_FILE (./data/quiet-list.sqlite),
// SETUP_CODE (required to create accounts; leave unset to close sign-up),
// PUBLIC_ORIGIN (e.g. https://lists.example.com when behind a TLS proxy).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp, SCHEMA } from './app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

export function sqliteAdapter(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec(SCHEMA);
  return {
    get: async (sql, ...params) => database.prepare(sql).get(...params) ?? null,
    all: async (sql, ...params) => database.prepare(sql).all(...params),
    run: async (sql, ...params) => ({ changes: Number(database.prepare(sql).run(...params).changes) }),
    close: () => database.close(),
  };
}

export async function staticAssets(request) {
  const url = new URL(request.url);
  let name = decodeURIComponent(url.pathname);
  if (name === '/') name = '/index.html';
  const file = path.join(root, name);
  if (!file.startsWith(root + path.sep) || !TYPES[path.extname(file)]) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(file);
    // The shell is small; always revalidate so a new version is picked up at once.
    return new Response(body, { headers: { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-cache' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

export function startServer({ port = 8080, host = '127.0.0.1', dataFile = ':memory:', setupCode = '', origin = '', passwordIterations } = {}) {
  const db = sqliteAdapter(dataFile);
  const app = createApp({ db, assets: staticAssets, config: { setupCode, origin, passwordIterations } });
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1_500_000) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined });
      const response = await app(request, { ip: req.socket.remoteAddress || 'unknown' });
      const headers = {};
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') headers[key] = value; });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end(); }
  });
  return new Promise(resolve => server.listen(port, host, () => resolve({ server, db, url: `http://${host}:${server.address().port}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer({
    port: Number(process.env.PORT) || 8080, host: process.env.HOST || '127.0.0.1',
    dataFile: process.env.DATA_FILE || './data/quiet-list.sqlite', setupCode: process.env.SETUP_CODE || '', origin: process.env.PUBLIC_ORIGIN || '',
  });
  console.log(`Quiet List running at ${process.env.PUBLIC_ORIGIN || url}`);
  if (!process.env.SETUP_CODE) console.log('SETUP_CODE is not set, so no new accounts can be created.');
}
