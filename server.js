'use strict';
// Zero-dependency local server. Binds to 127.0.0.1 only — this exposes local
// session transcripts and must never be reachable off the machine.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildIndex } = require('./lib/scan');
const { transfer } = require('./lib/move');

const PORT = Number(process.env.PORT) || 7788;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');

// This is a utility you open, use, and forget about — so it must not outlive
// your attention. The page heartbeats while its tab is open; when the heartbeat
// stops (tab closed, browser quit, machine left alone) the server exits on its
// own. IDLE_MINUTES=0 disables it.
const IDLE_MS = (process.env.IDLE_MINUTES === undefined ? 5 : Number(process.env.IDLE_MINUTES)) * 60000;
const GRACE_MS = 30000; // after a tab closes — long enough to survive a reload
let lastSeen = Date.now();
let shuttingDown = false;

function touch() {
  lastSeen = Date.now();
}

function quit(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  Shutting down — ${why}.`);
  server.close(() => process.exit(0));
  // Do not let a lingering keep-alive socket hold the process open.
  setTimeout(() => process.exit(0), 1500).unref();
}

if (IDLE_MS > 0) {
  setInterval(() => {
    const idle = Date.now() - lastSeen;
    if (idle >= IDLE_MS) quit(`idle for ${Math.round(idle / 60000)} min`);
  }, 5000).unref();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

let cache = null;
let cacheAt = 0;
const CACHE_MS = 4000;

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  touch();

  try {
    if (url.pathname === '/api/ping') {
      return json(res, 200, { ok: true, idleMinutes: IDLE_MS / 60000, uptimeSec: Math.round(process.uptime()) });
    }

    // Tab closed. Arm a short grace window instead of exiting immediately, so a
    // reload or a quick tab-switch does not kill the server underneath you.
    if (url.pathname === '/api/bye') {
      if (IDLE_MS > 0) lastSeen = Date.now() - Math.max(0, IDLE_MS - GRACE_MS);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true, message: 'Server stopped.' });
      return setTimeout(() => quit('closed from the UI'), 150);
    }

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const fresh = url.searchParams.get('refresh') === '1';
      if (fresh || !cache || Date.now() - cacheAt > CACHE_MS) {
        const t0 = Date.now();
        cache = buildIndex();
        cache.scanMs = Date.now() - t0;
        cacheAt = Date.now();
      }
      return json(res, 200, cache);
    }

    if (url.pathname === '/api/rename' && req.method === 'POST') {
      const body = await readBody(req);
      const result = require('./lib/rename').setTitle(body);
      cache = null;
      return json(res, 200, result);
    }

    if (url.pathname === '/api/transfer' && req.method === 'POST') {
      const body = await readBody(req);
      const result = transfer(body);
      cache = null; // force rescan on next read
      return json(res, 200, result);
    }

    // Static
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Claude Session Switcher`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(IDLE_MS > 0 ? `  Auto-stops after ${IDLE_MS / 60000} min idle.\n` : `  Idle shutdown disabled.\n`);
});

process.on('SIGINT', () => quit('interrupted'));
process.on('SIGTERM', () => quit('terminated'));
