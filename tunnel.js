// Internet mode: a free Cloudflare "quick tunnel" gives the server a public
// https://<random>.trycloudflare.com address. No account needed. The official
// cloudflared binary is downloaded from Cloudflare's GitHub releases on first use.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function binaryName() {
  if (process.platform === 'win32') return process.arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  return null;
}

function onPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['cloudflared'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
    return out || null;
  } catch { return null; }
}

async function ensureCloudflared(root) {
  const local = path.join(root, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(local)) return local;
  const sys = onPath();
  if (sys) return sys;
  const name = binaryName();
  if (!name) throw new Error('This system is not supported; install cloudflared manually.');
  console.log(`Downloading cloudflared (Cloudflare's official tunnel tool, ~40 MB) from ${RELEASES}${name} ...`);
  const res = await fetch(RELEASES + name, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download cloudflared (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, buf);
  if (process.platform !== 'win32') fs.chmodSync(local, 0o755);
  console.log('cloudflared is ready.');
  return local;
}

// Starts the tunnel and calls onUrl(url) once Cloudflare assigns the address.
// Restarts it if it drops (the address changes when that happens).
export async function startTunnel(root, port, onUrl) {
  // PBLAN_TUNNEL_CMD (a JSON array) replaces cloudflared, for testing.
  const override = process.env.PBLAN_TUNNEL_CMD ? JSON.parse(process.env.PBLAN_TUNNEL_CMD) : null;
  const exe = override ? override[0] : await ensureCloudflared(root);
  const args = override ? override.slice(1) : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];
  let child = null;
  const stop = () => { try { child?.kill(); } catch {} };
  process.once('exit', stop);
  process.once('SIGINT', () => { stop(); process.exit(0); });
  const launch = () => {
    child = spawn(exe, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let found = false;
    const scan = (chunk) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(chunk.toString());
      if (m && !found) { found = true; onUrl(m[0]); }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', (code) => {
      onUrl(null);
      console.log(`The internet tunnel closed (code ${code}). Retrying in 5 s...`);
      setTimeout(launch, 5000);
    });
  };
  launch();
}
