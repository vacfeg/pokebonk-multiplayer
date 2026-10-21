// Hostile actions across players: boss/miniboss attacks aimed at a friend,
// enemy projectiles, visual effects of everyone's attacks, and boss state.
(() => {
  const LAN = window.LAN;

  // -------------------------------------------------- puppet proxies (host)

  // A stand-in for a remote player that boss code can target. Attack code
  // captures the player object when it winds up an attack, so delayed hits
  // (slams, beams, pools) land on the right friend.
  const proxies = new Map(); // puppet id -> proxy

  function proxyFor(run, pp) {
    let entry = proxies.get(pp.id);
    if (!entry || entry.run !== run) {
      // run.player may itself be a proxy while an attack is resolving.
      const real = run.__lanPlayer ?? run.player;
      const state = {
        pos: real.pos.clone(),
        vel: real.vel.clone(),
        lastHurtAt: 0,
      };
      const overrides = {
        pos: state.pos,
        vel: state.vel,
        radius: 0.55,
        get dead() { return !!pp.target?.dead; },
        get hp() { return pp.target?.hp ?? 100; },
        get maxHp() { return pp.target?.mhp ?? 100; },
        iframes: 0,
        invisT: 0,
        __lanPuppet: pp.id,
        hurt(...args) {
          if (pp.target?.dead) return false;
          state.lastHurtAt = performance.now();
          LAN.send({ t: 'hurt', to: pp.id, a: sanitize(args) });
          return true;
        },
        wound(w) { LAN.send({ t: 'wound', to: pp.id, w }); },
        shove(x, z, n) { LAN.send({ t: 'shove', to: pp.id, x, z, n }); },
      };
      const proxy = new Proxy(overrides, {
        get(t, k) {
          if (k in t) return t[k];
          const v = real[k];
          return typeof v === 'function' ? () => false : v;
        },
        set(t, k, v) {
          if (k in t && k !== 'pos' && k !== 'vel') t[k] = v;
          return true;
        },
      });
      entry = { run, proxy, state, pp };
      proxies.set(pp.id, entry);
    }
    const s = entry.state;
    const t = pp.target;
    if (t) {
      s.vel.set((t.x - s.pos.x) * 10, 0, (t.z - s.pos.z) * 10);
      s.pos.set(pp.x, pp.y, pp.z);
    }
    entry.pp = pp;
    return entry.proxy;
  }

  // Keeps proxy positions fresh even between swaps (delayed hits read them).
  function refreshProxies(run) {
    for (const pp of LAN.visiblePuppets(run)) proxyFor(run, pp);
  }

  function sanitize(args) {
    return args.map((a) => {
      if (typeof a === 'number' && !Number.isFinite(a)) return null;
      if (a && typeof a === 'object') {
        const o = {};
        for (const k in a) if (typeof a[k] !== 'function' && typeof a[k] !== 'object') o[k] = a[k];
        return o;
      }
      return a;
    });
  }

  // Runs fn with run.player temporarily replaced by a puppet's proxy.
  function withPlayer(run, pp, fn) {
    if (!pp) return fn();
    const prev = run.player;
    run.player = proxyFor(run, pp);
    try { return fn(); } finally { run.player = prev; }
  }

  // Same, for the puppet the enemy loop just picked as target.
  function asTarget(run, fn) {
    if (!LAN.multi || LAN.tHost || !LAN.tPuppet) return fn();
    return withPlayer(run, LAN.tPuppet, fn);
  }

  // Global systems (waves, events) take turns focusing each player.
  function rotating(run, obj, method) {
    if (!obj || obj['__lan_' + method]) return;
    obj['__lan_' + method] = true;
    const orig = obj[method].bind(obj);
    let turn = 0;
    obj[method] = (...a) => {
      const others = LAN.multi ? LAN.hostPlayers() : [];
      if (!others.length) return orig(...a);
      const k = turn++ % (others.length + 1);
      return k === 0 ? orig(...a) : withPlayer(run, others[k - 1], () => orig(...a));
    };
  }

  // Timers scheduled while targeting a friend keep targeting that friend when
  // they fire (most telegraphed hits read run.player at impact time).
  function hookLater(run) {
    const later = run.later.bind(run);
    run.later = (t, fn) => {
      const ctx = run.player;
      if (ctx?.__lanPuppet == null) return later(t, fn);
      return later(t, () => {
        const prev = run.player;
        run.player = ctx;
        try { fn(); } finally { run.player = prev; }
      });
    };
  }

  // Boss ground pools and shockwaves are resolved against the host only by
  // the game; check them for each friend here.
  const poolT = new Map();
  const waveHit = new WeakMap();
  function bossHazards(run, dt) {
    const b = run.boss;
    if (!b.alive || b.kit) return;
    const a = b.bossIndex;
    const en = run.enemies;
    for (const pp of LAN.hostPlayers()) {
      const proxy = proxyFor(run, pp);
      let t = (poolT.get(pp.id) ?? 0) - dt;
      for (const c of b.pools) {
        if (t <= 0 && (pp.x - c.x) ** 2 + (pp.z - c.z) ** 2 < c.r * c.r && pp.y - c.y < 1) {
          t = 0.5;
          proxy.hurt((pp.target.mhp || 100) * 0.04, en.typesOf(a)[0], -1, NaN, NaN, true, 0, a);
        }
      }
      poolT.set(pp.id, t);
      for (const w of b.waves) {
        const hit = waveHit.get(w) ?? new Set();
        waveHit.set(w, hit);
        if (hit.has(pp.id)) continue;
        const l = Math.hypot(pp.x - w.x, pp.z - w.z);
        if (l >= w.r - 13 * dt - 0.6 && l < w.r + 0.6) {
          hit.add(pp.id);
          if (pp.y - run.terrain.height(pp.x, pp.z) < 1.3) withPlayer(run, pp, () => b.strike(a, 1.3, 0.1));
        }
      }
    }
  }

  function installHostTargeting(run) {
    hookLater(run);
    const boss = run.boss;
    const update = boss.update.bind(boss);
    boss.update = (l, e, h) => asTarget(run, () => update(l, e, h));
    const spawn = boss.spawn.bind(boss);
    boss.spawn = (...args) => {
      const idx = spawn(...args);
      const kit = boss.kit;
      if (kit && !kit.__lan) {
        kit.__lan = true;
        const steer = kit.steer.bind(kit);
        kit.steer = (e) => asTarget(run, () => steer(e));
      }
      if (idx >= 0) {
        LAN.send({
          t: 'boss', seed: run.seed >>> 0, stage: run.stage, idx, gen: run.enemies.gen[idx],
          name: boss.name, legendary: !!args[3], secs: boss.fightSecs,
        });
      }
      return idx;
    };
    hookStage(run);
    const buildStage = run.buildStage.bind(run);
    run.buildStage = (first) => { buildStage(first); hookStage(run); };
  }

  // Systems rebuilt on every zone change.
  function hookStage(run) {
    const mb = run.minibosses;
    if (!mb.__lanAct) {
      mb.__lanAct = true;
      const act = mb.act.bind(mb);
      mb.act = (l, e, h) => asTarget(run, () => act(l, e, h));
    }
    rotating(run, run.director, 'update');
    rotating(run, run.events, 'update');
    rotating(run, run.minibosses, 'update');
  }

  // ----------------------------------------------- hits arriving (clients)

  let lastHurtOk = 0;
  LAN.on('hurt', (m) => {
    const run = LAN.run;
    if (!run?.__lan.sync || run.state !== 'play') return;
    const a = m.a;
    for (const i of [3, 4]) if (a[i] == null) a[i] = NaN;
    if (typeof a[8] !== 'object' || a[8] === null) a[8] = {};
    const ok = run.player.hurt(...a);
    if (ok) lastHurtOk = performance.now();
  });
  LAN.on('wound', (m) => {
    const run = LAN.run;
    if (!run?.__lan.sync) return;
    if (performance.now() - lastHurtOk < 300) run.player.wound(m.w);
  });
  LAN.on('shove', (m) => {
    const run = LAN.run;
    if (!run?.__lan.sync || run.state !== 'play') return;
    run.player.shove(m.x, m.z, m.n);
  });

  // ------------------------------------------- hostile projectiles (host→all)

  const shotQueue = [];
  const ownShots = []; // our own projectiles, shown to friends as visuals only
  const OWN_SHOT_CAP = 40;
  function hookProjectiles(run) {
    const pr = run.projectiles;
    const fire = pr.fire.bind(pr);
    pr.fire = (spec) => {
      const id = fire(spec);
      if (id < 0 || replaying) return id;
      if ((spec.flags ?? 0) & 1) {
        if (!LAN.isHost) return id;
        const s = {};
        for (const k in spec) {
          const v = spec[k];
          if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v === null) s[k] = v;
        }
        shotQueue.push(s);
      } else if (ownShots.length < OWN_SHOT_CAP) {
        const r2 = (v) => Math.round(v * 100) / 100;
        ownShots.push([r2(pr.x[id]), r2(pr.y[id]), r2(pr.z[id]), r2(pr.vx[id]), r2(pr.vy[id]), r2(pr.vz[id]),
          r2(pr.life[id]), r2(pr.size[id]), pr.color[id], pr.shape[id], r2(pr.rad[id])]);
      }
      return id;
    };
  }

  // Friends' projectiles: drawn as glowing orbs that fly until they hit an
  // enemy or expire. They never deal damage here (the owner already did).
  const ghosts = [];
  LAN.on('pshots', (m) => {
    const run = LAN.run;
    if (!run?.__lan.sync || m.seed !== (run.seed >>> 0) || m.stage !== run.stage) return;
    for (const g of m.list) {
      if (ghosts.length >= 400) break;
      const [x, y, z, vx, vy, vz, life, size, color, shape, rad] = g;
      ghosts.push({ x, y, z, vx, vy, vz, life, size, color, shape, rad });
    }
  });

  function stepGhosts(run, dt) {
    const en = run.enemies;
    const add = run.vfx.add;
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i];
      g.life -= dt;
      g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
      let hit = false;
      if (g.life > 0) {
        const n = en.grid.query(g.x, g.z, g.rad + 2);
        const res = en.grid.result;
        for (let k = 0; k < n; k++) {
          const j = res[k];
          if (!en.alive[j] || en.dying[j] > 0) continue;
          const r = g.rad + en.radius[j];
          if ((en.x[j] - g.x) ** 2 + (en.z[j] - g.z) ** 2 < r * r && Math.abs(en.y[j] + en.hgt[j] * 0.5 - g.y) < en.hgt[j]) { hit = true; break; }
        }
      }
      if (g.life <= 0 || hit) { ghosts.splice(i, 1); continue; }
      try {
        add.spawn({ x: g.x, y: g.y, z: g.z, life: 0.07, size: g.size, endSize: g.size * 0.7, color: g.color, shape: g.shape, glow: 1 });
      } catch {}
    }
  }

  LAN.on('shots', (m) => {
    const run = LAN.run;
    if (!run?.__lan.sync || m.seed !== (run.seed >>> 0) || m.stage !== run.stage || LAN.isHost) return;
    replaying = true;
    try {
      for (const s of m.list) run.projectiles.fire(s);
    } catch (e) {
      console.warn('[LAN] shots', e);
    } finally { replaying = false; }
  });

  // --------------------------------------------------- visual effects (all)

  let replaying = false;
  let suppress = 0;
  // Warnings (telegraphs, beams, shockwaves) must always arrive; hit sparks
  // are nice to have and get dropped first when there are too many.
  const fxQueue = [];
  const fxLow = [];
  const FX_CAP = 160;
  const FX_LOW_CAP = 50;

  const FX_METHODS = ['burst', 'ring', 'staticRing', 'telegraph', 'flash', 'lightning'];
  const FX_LOW = new Set(['burst', 'flash']);
  const FX_SUB = ['beams', 'ground', 'groundN'];

  function hookFx(run) {
    const vfx = run.vfx;
    FX_METHODS.forEach((name, code) => {
      const orig = vfx[name].bind(vfx);
      const q = FX_LOW.has(name) ? fxLow : fxQueue;
      const cap = FX_LOW.has(name) ? FX_LOW_CAP : FX_CAP;
      vfx[name] = (...args) => {
        if (!replaying && !suppress && q.length < cap) q.push([code, ...plain(args)]);
        return orig(...args);
      };
    });
    FX_SUB.forEach((name, i) => {
      const sub = vfx[name];
      const orig = sub.spawn.bind(sub);
      const code = 100 + i;
      sub.spawn = (...args) => {
        if (!replaying && !suppress && fxQueue.length < FX_CAP) fxQueue.push([code, ...plain(args)]);
        return orig(...args);
      };
    });
    // Each player runs their own death bursts when an enemy dies: don't echo.
    const combat = run.combat;
    const credit = combat.credit.bind(combat);
    combat.credit = (...a) => { suppress++; try { return credit(...a); } finally { suppress--; } };
    // The ring under your own feet is drawn locally by everyone for their puppet.
    const player = run.player;
    const render = player.render.bind(player);
    player.render = (...a) => { suppress++; try { return render(...a); } finally { suppress--; } };
  }

  function plain(args) {
    return args.map((a) => {
      if (typeof a === 'number') return Number.isFinite(a) ? Math.round(a * 100) / 100 : 0;
      if (a && typeof a === 'object') {
        const o = {};
        for (const k in a) if (typeof a[k] === 'number' || typeof a[k] === 'string') o[k] = typeof a[k] === 'number' ? Math.round(a[k] * 100) / 100 : a[k];
        return o;
      }
      return a;
    });
  }

  LAN.on('fx', (m) => {
    const run = LAN.run;
    if (!run?.__lan.sync || m.seed !== (run.seed >>> 0) || m.stage !== run.stage) return;
    const vfx = run.vfx;
    replaying = true;
    try {
      for (const [code, ...args] of m.list) {
        if (code >= 100) vfx[FX_SUB[code - 100]]?.spawn(...args);
        else vfx[FX_METHODS[code]]?.(...args);
      }
    } catch (e) {
      // A malformed effect shouldn't break the frame.
    } finally { replaying = false; }
  });

  function flush(run) {
    const seed = run.seed >>> 0;
    if (fxQueue.length || fxLow.length) {
      LAN.send({ t: 'fx', seed, stage: run.stage, list: fxQueue.concat(fxLow) });
      fxQueue.length = 0;
      fxLow.length = 0;
    }
    if (shotQueue.length && LAN.isHost) {
      LAN.send({ t: 'shots', seed, stage: run.stage, list: shotQueue.splice(0) });
    }
    if (ownShots.length) {
      LAN.send({ t: 'pshots', seed, stage: run.stage, list: ownShots.splice(0) });
    }
  }

  // ------------------------------------------------------- boss (clients)

  LAN.on('boss', (m) => {
    const run = LAN.run;
    if (!run?.__lan.sync || LAN.isHost || m.seed !== (run.seed >>> 0) || m.stage !== run.stage) return;
    const b = run.boss;
    b.bossIndex = m.idx;
    b.bossGen = m.gen;
    b.name = m.name;
    b.fightSecs = m.secs ?? b.fightSecs;
    b.fightT = 0;
    b.kit = null;
    b.pools = [];
    run.bossSpawned = true;
    // The intro needs the boss on screen; wait for the snapshot to bring it.
    const t0 = performance.now();
    const wait = setInterval(() => {
      if (LAN.run !== run || performance.now() - t0 > 3000) return clearInterval(wait);
      if (run.enemies.alive[m.idx] && run.enemies.gen[m.idx] === m.gen) {
        clearInterval(wait);
        try { run.introBoss(m.idx, m.legendary); } catch {}
        try { run.audio.bossStart(); } catch {}
      }
    }, 50);
  });

  // --------------------------------------------------------------- wiring

  let sendAcc = 0;
  LAN.combat = {
    install(run) {
      proxies.clear();
      fxQueue.length = 0;
      shotQueue.length = 0;
      ownShots.length = 0;
      ghosts.length = 0;
      run.__lanPlayer = run.player;
      if (!run.__lan.sync) return;
      hookFx(run);
      hookProjectiles(run);
      if (LAN.isHost) installHostTargeting(run);
      const buildStage = run.buildStage.bind(run);
      run.buildStage = (first) => { buildStage(first); ghosts.length = 0; };
    },
    post(run, dt) {
      if (!run.__lan.sync) return;
      if (ghosts.length) stepGhosts(run, Math.min(dt, 0.1));
      if (LAN.isHost && LAN.multi) {
        refreshProxies(run);
        try { bossHazards(run, Math.min(dt, 1 / 20)); } catch (e) { console.warn('[LAN] hazards', e); }
      }
      sendAcc += dt;
      if (sendAcc >= 1 / 20) {
        sendAcc = 0;
        if (LAN.roster.length > 1) flush(run);
        else { fxQueue.length = 0; fxLow.length = 0; shotQueue.length = 0; ownShots.length = 0; }
      }
    },
  };
})();
