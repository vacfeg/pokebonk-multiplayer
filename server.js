// PokéBonk LAN: serves a cached copy of pokebonk.com with multiplayer patches,
// a local stand-in for the account API, and the WebSocket relay for co-op.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { patchBundle, isGameBundle } from './patches.js';
import { handleApi } from './api.js';
import { attachRelay } from './relay.js';
import { startTunnel } from './tunnel.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, 'cache');
const CLIENT = path.join(ROOT, 'client');
const ORIGIN = 'https://pokebonk.com';
const PORT = Number(process.env.PORT || 8777);
const INTERNET = process.argv.includes('--internet');
let publicUrl = null;

const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.txt': 'text/plain',
};

const inflight = new Map();

// Fetches a file from the official site once and keeps it in ./cache.
async function cached(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  if (rel.includes('..')) throw Object.assign(new Error('bad path'), { status: 400 });
  const file = path.join(CACHE, rel);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  if (inflight.has(file)) return inflight.get(file);
  const job = (async () => {
    const res = await fetch(ORIGIN + '/' + rel.split('/').map(encodeURIComponent).join('/'), {
      headers: { 'User-Agent': 'Mozilla/5.0 pokebonk-lan' },
    });
    if (!res.ok) throw Object.assign(new Error(`upstream ${res.status}`), { status: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return file;
  })().finally(() => inflight.delete(file));
  inflight.set(file, job);
  return job;
}

// The build id of the cached copy (e.g. "mvgy3iyx"), read from its index.html.
// The cached copy stays on that build even after pokebonk.com updates, so the
// game never sees a mismatch and never asks to reload.
async function currentBuild() {
  const html = fs.readFileSync(await cached('index.html'), 'utf8');
  return /assets\/main-[\w-]+?-([a-z0-9]{8})\.js/.exec(html)?.[1] ?? 'unknown';
}

// JS files are classified once (by content) and the game bundle is patched.
const jsInfo = new Map(); // file -> { key, game, code, loader }
let patchFailures = [];

function classify(file) {
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${patchTag()}`;
  let info = jsInfo.get(file);
  if (!info || info.key !== key) {
    const src = fs.readFileSync(file, 'utf8');
    info = { key, game: isGameBundle(src) };
    if (info.game) {
      const { code, failed } = patchBundle(src);
      info.code = code;
      patchFailures = failed;
      if (failed.length) console.error(`WARNING: PokéBonk changed and ${failed.length} patch(es) no longer apply: ${failed.join(', ')}`);
    }
    jsInfo.set(file, info);
  }
  return info;
}

function serveJs(file) {
  const info = classify(file);
  if (info.game) return info.code;
  // The small loader that imports the game bundle: point it at a URL that
  // changes with the patches, so browsers never reuse a stale unpatched copy.
  if (info.loader === undefined) {
    const game = findGameBundle(path.dirname(file));
    const src = fs.readFileSync(file, 'utf8');
    info.loader = game && src.includes('./' + game) ? src.split('./' + game).join(`./${game}?lan=${patchTag()}`) : null;
  }
  return info.loader;
}

function patchTag() {
  return Math.round(fs.statSync(path.join(ROOT, 'patches.js')).mtimeMs).toString(36);
}

function findGameBundle(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.js') && classify(path.join(dir, name)).game) return name;
  }
  return null;
}

// Downloads every code chunk of the cached build right away: once pokebonk.com
// moves to a newer version, the old build's files may disappear from it.
async function warmCache() {
  try {
    const html = fs.readFileSync(await cached('index.html'), 'utf8');
    const entries = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    const chunks = new Set(entries);
    for (const entry of entries.filter((e) => e.endsWith('.js'))) {
      const js = fs.readFileSync(await cached(entry), 'utf8');
      for (const m of js.matchAll(/"\.\/([\w.-]+\.(?:js|css))"/g)) chunks.add('assets/' + m[1]);
    }
    await Promise.all([...chunks].map((c) => cached(c).catch((e) => console.error('Could not download', c, e.message))));
    const version = await fetch(ORIGIN + '/version.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    const build = await currentBuild();
    console.log(`  PokéBonk version in use:     build ${build}` + (version?.build === build ? ` (${version.version}, latest)` : version ? ` (the site is on ${version.version}; keeping the saved copy)` : ''));
  } catch (e) {
    console.error('Could not prepare the game files:', e.message, '- is this PC online?');
  }
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, p.slice(4), url);

    if (p === '/lan/info') {
      return send(res, 200, JSON.stringify({
        internet: INTERNET,
        publicUrl,
        patchFailures,
        lan: lanIps().map((ip) => `http://${ip}:${PORT}`),
      }), TYPES['.json']);
    }

    if (p.startsWith('/lan/')) {
      const file = path.join(CLIENT, p.slice(5));
      if (!file.startsWith(CLIENT) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    }

    if (p === '/version.json') return send(res, 200, JSON.stringify({ build: await currentBuild() }), TYPES['.json']);

    if (p === '/' || p === '/index.html') {
      const file = await cached('index.html');
      let html = fs.readFileSync(file, 'utf8');
      const scripts = ['net.js', 'world.js', 'combat.js', 'perf.js'].map((f) => `<script src="/lan/${f}"></script>`).join('\n');
      html = html.replace('<head>', '<head>\n' + scripts);
      // Fresh URL for the game's entry script whenever the patches change.
      html = html.replace(/(<script type="module"[^>]*src="[^"]+\.js)"/, `$1?lan=${patchTag()}"`);
      return send(res, 200, html, TYPES['.html']);
    }

    const file = await cached(p);
    const ext = path.extname(file);
    if (ext === '.js') {
      const code = serveJs(file);
      if (code) return send(res, 200, code, TYPES['.js']);
    }
    // Code is always revalidated; images, sounds and data can be cached.
    const cacheable = ext !== '.js' && ext !== '.css';
    return send(res, 200, fs.readFileSync(file), TYPES[ext] || 'application/octet-stream',
      cacheable ? { 'Cache-Control': 'public, max-age=3600' } : {});
  } catch (err) {
    if (!err.status || err.status >= 500) console.error(p, err.message);
    send(res, err.status || 500, String(err.message), 'text/plain');
  }
});

// Compression roughly halves the world snapshots, which matters over internet.
const wss = new WebSocketServer({
  server,
  path: '/lan/ws',
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 } },
});
attachRelay(wss);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PokéBonk Multiplayer is running.`);
  console.log(`  You (host):                  http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`  Friends on your network:     http://${ip}:${PORT}`);
  warmCache();
  if (INTERNET) {
    console.log('');
    console.log('Opening the internet link (takes a few seconds)...');
    startTunnel(ROOT, PORT, (url) => {
      publicUrl = url;
      if (!url) return;
      console.log('');
      console.log('  ================================================================');
      console.log(`   INTERNET LINK FOR FRIENDS:  ${url}`);
      console.log('   (also shown in the in-game multiplayer panel, with a Copy button)');
      console.log('  ================================================================');
      console.log('');
    }).catch((err) => console.error('Could not open the internet link:', err.message));
  }
});
