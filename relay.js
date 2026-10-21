// WebSocket relay. The browser on the machine running this server is the host:
// it simulates the shared world and everyone else mirrors it.
let nextId = 1;

const isLoopback = (addr = '') => addr === '::1' || addr.startsWith('127.') || addr === '::ffff:127.0.0.1';

// Connections arriving through the internet tunnel also come from 127.0.0.1;
// the proxy headers tell them apart from the host's own browser.
function isLocal(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false;
  return isLoopback(req.socket.remoteAddress);
}

const HEARTBEAT_MS = 4000;

export function attachRelay(wss) {
  const peers = new Map(); // id -> { ws, name, species, local, key, alive }
  let hostId = null;
  let run = null; // { cfg, stage } of the host's active run, for late joiners

  const sendTo = (p, msg) => p.ws.readyState === 1 && p.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  const broadcast = (msg, exceptId) => {
    const s = JSON.stringify(msg);
    for (const [id, p] of peers) if (id !== exceptId) sendTo(p, s);
  };
  const roster = () => ({
    t: 'roster',
    host: hostId,
    run,
    players: [...peers.entries()].map(([id, p]) => ({ id, name: p.name, species: p.species ?? null })),
  });
  const pickHost = () => {
    const local = [...peers.entries()].find(([, p]) => p.local);
    return local ? local[0] : peers.size ? peers.keys().next().value : null;
  };

  function drop(id, replacedBy = null) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.ws.terminate(); } catch {}
    if (hostId === id && replacedBy != null) {
      // The host's own tab reconnected: hand it the role back, keep the run.
      hostId = replacedBy;
    } else if (hostId === id) {
      hostId = pickHost();
      run = null;
      broadcast({ t: 'hostLeft' });
    }
    broadcast(roster());
  }

  // Dead connections (a phone or laptop whose WiFi dropped) never send a close;
  // without this they'd linger as a frozen copy of the player.
  const beat = setInterval(() => {
    for (const [id, p] of peers) {
      if (!p.alive) { drop(id); continue; }
      p.alive = false;
      try { p.ws.ping(); } catch {}
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(beat));

  wss.on('connection', (ws, req) => {
    const id = nextId++;
    const local = isLocal(req);
    peers.set(id, { ws, name: 'Player ' + id, local, alive: true });
    ws.on('pong', () => { const p = peers.get(id); if (p) p.alive = true; });
    const prevHost = hostId;
    if (hostId === null || (local && !peers.get(hostId)?.local && !run)) hostId = id;
    if (prevHost !== null && prevHost !== hostId) broadcast({ t: 'hostChanged' });
    sendTo(peers.get(id), { t: 'welcome', id, host: hostId, run });
    broadcast(roster());

    ws.on('message', (data, isBinary) => {
      const peer = peers.get(id);
      if (!peer) return;
      peer.alive = true;
      if (isBinary) {
        // Binary frames are world snapshots from the host: fan out untouched.
        if (id !== hostId) return;
        for (const [pid, p] of peers) if (pid !== id && p.ws.readyState === 1) p.ws.send(data, { binary: true });
        return;
      }
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      msg.from = id;
      switch (msg.t) {
        case 'hello': {
          peer.name = String(msg.name || peer.name).slice(0, 24);
          peer.species = msg.species ?? null;
          // Same browser tab reconnecting: retire its previous connection now.
          if (msg.key) {
            peer.key = String(msg.key).slice(0, 64);
            for (const [oid, o] of peers) if (oid !== id && o.key === peer.key) drop(oid, id);
          }
          broadcast(roster());
          return;
        }
        case 'start':
          if (id !== hostId) return;
          run = { cfg: msg.cfg, stage: 1 };
          break;
        case 'stage':
          if (id === hostId && run) run.stage = msg.stage;
          break;
        case 'end':
          if (id !== hostId) return;
          run = null;
          break;
      }
      if (msg.to != null) {
        const target = peers.get(msg.to);
        if (target) sendTo(target, msg);
        return;
      }
      broadcast(msg, id);
    });

    ws.on('close', () => drop(id));
    ws.on('error', () => drop(id));
  });
}
