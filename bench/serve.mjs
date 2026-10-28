#!/usr/bin/env node
/**
 * Static server for the benchmark fixture. Loopback only, on both 127.0.0.1
 * and ::1, so `localhost` resolves to the same pages under a different host
 * (the cross-domain task needs that). GET /api/ping answers a fetch.
 *
 *   node bench/serve.mjs            # http://127.0.0.1:8899/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
const PORT = Number(process.env.BENCH_PORT || 8899);
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

const server = (host) => http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`${new Date().toISOString()} ${host} ${req.method} ${req.headers.host}${url.pathname}${url.search}`);
  if (url.pathname === '/api/ping') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end(`pong ${Date.now()}`);
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, host, () => console.log(`fixture on http://${host.includes(':') ? `[${host}]` : host}:${PORT}/`));

server('127.0.0.1');
server('::1');
