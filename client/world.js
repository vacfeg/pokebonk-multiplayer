// Shared world: the host's browser owns the enemies and streams them to the
// other players; each client reports the damage and statuses it caused back.
(() => {
  const LAN = window.LAN;
  const SNAP_HZ = 15;
  const KEYFRAME_EVERY = 2; // seconds between full static resends

  // Status fields a client may change with its hits (forwarded to the host).
  const STATUS_FIELDS = ['burn', 'burnDps', 'poison', 'poisonStacks', 'poisonDps', 'para', 'stun', 'chill',
    'chillT', 'frozen', 'wet', 'sleep', 'confuse', 'curse', 'healBlock', 'charm', 'root', 'pull'];
  // Statuses mirrored to clients as on/off bits (visual tint + combat reactions).
  const STATUS_BITS = ['burn', 'poison', 'para', 'frozen', 'wet', 'curse', 'chill', 'sleep', 'stun', 'confuse', 'charm', 'root'];

  const POS_SCALE = 64; // int16 fixed point, ±512 world units

  // ------------------------------------------------------------ shared helpers

  function otherPlayers(run) {
    return LAN.visiblePuppets(run).filter((p) => !p.target.dead);
  }

  // ---------------------------------------------------------------- host

  const host = {
    run: null,
    seq: 0,
    acc: 0,
    keyAcc: 0,
    sentGen: null,
    sentFlags: null,
    sentMaxHp: null,
    acks: new Map(), // client id -> last applied damage seq
    spawnRot: 0,
  };

  // Called by the patched enemy update for each enemy: picks the closest
  // living player so swarms split between everyone.
  LAN.pickTarget = (x, z) => {
    const run = host.run;
    const me = run.__lanPlayer ?? run.player;
    let best = me.dead ? Infinity : (me.pos.x - x) ** 2 + (me.pos.z - z) ** 2;
    LAN.tx = me.pos.x; LAN.ty = me.pos.y; LAN.tz = me.pos.z; LAN.tHost = true; LAN.tPuppet = null;
    for (const pp of host.players) {
      const d = (pp.x - x) ** 2 + (pp.z - z) ** 2;
      if (d < best) { best = d; LAN.tx = pp.x; LAN.ty = pp.y; LAN.tz = pp.z; LAN.tHost = false; LAN.tPuppet = pp; }
    }
  };

  // Far-enemy recycling only when the enemy is far from every player.
  LAN.farCheck = (x, z, dHost) => {
    if (!LAN.isHost && LAN.run?.__lan?.sync) return false; // clients never move host enemies
    if (!LAN.multi) return dHost > 5625;
    if (dHost <= 5625) return false;
    for (const pp of host.players) if ((pp.x - x) ** 2 + (pp.z - z) ** 2 <= 5625) return false;
    return true;
  };

  function installHost(run) {
    host.run = run;
    host.players = [];
    host.seq = 0;
    host.sentGen = new Uint32Array(4096);
    host.sentFlags = new Int32Array(4096);
    host.sentMaxHp = new Float64Array(4096);
    host.keyAcc = KEYFRAME_EVERY;
    const buildStage = run.buildStage.bind(run);
    run.buildStage = (first) => {
      buildStage(first);
      host.keyAcc = KEYFRAME_EVERY;
    };
  }

  LAN.hostPlayers = () => host.players ?? [];

  function hostPre(run) {
    host.players = otherPlayers(run);
    LAN.multi = host.players.length > 0;
  }

  // Keeps the world running while the host is in a menu, and makes the host
  // untouchable meanwhile (clients get the same treatment on their side).
  const WORLD_STATES = new Set(['modal', 'paused', 'evolving', 'capturing']);
  function hostWorldTick(run, dt) {
    if (!LAN.multi || !WORLD_STATES.has(run.state)) return;
    const r = Math.min(dt, 1 / 20) * run.timeScale;
    run.player.iframes = Math.max(run.player.iframes, 0.3);
    run.time += r;
    run.stageTime += r;
    const mew = run.mewtwo?.active;
    try {
      if (!run.sanctuary && !mew) run.director.update(r);
      run.endless?.update(r);
      run.enemies.update(r);
      run.boss.tick(r);
      if (!mew) run.minibosses.update(r);
      if (!run.sanctuary && !mew) run.events.update(r);
      run.projectiles.update(r);
      run.zones.update(r);
    } catch (e) {
      console.warn('[LAN] world tick', e);
    }
  }

  function hostPost(run, dt) {
    hostWorldTick(run, dt);
    if (LAN.roster.length < 2) return;
    host.acc += dt;
    host.keyAcc += dt;
    if (host.acc < 1 / SNAP_HZ) return;
    host.acc = 0;
    const key = host.keyAcc >= KEYFRAME_EVERY;
    if (key) host.keyAcc = 0;
    LAN.sendBinary(encodeSnapshot(run, key));
  }

  function encodeSnapshot(run, keyframe) {
    const en = run.enemies;
    const n = en.n;
    const statics = [];
    const dyn = [];
    for (let i = 0; i < n; i++) {
      if (!en.alive[i]) continue;
      dyn.push(i);
      if (keyframe || host.sentGen[i] !== en.gen[i] || host.sentFlags[i] !== en.flags[i] || host.sentMaxHp[i] !== en.maxHp[i]) {
        statics.push(i);
        host.sentGen[i] = en.gen[i];
        host.sentFlags[i] = en.flags[i];
        host.sentMaxHp[i] = en.maxHp[i];
      }
    }
    const acks = [...host.acks];
    const size = 1 + 4 + 2 + 4 + 2 + acks.length * 6 + 2 + statics.length * 38 + 2 + dyn.length * 23 + 16;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    let o = 0;
    v.setUint8(o, 1); o += 1;
    v.setUint32(o, run.seed >>> 0, true); o += 4;
    v.setUint16(o, run.stage, true); o += 2;
    v.setUint32(o, ++host.seq, true); o += 4;
    v.setUint16(o, acks.length, true); o += 2;
    for (const [id, seq] of acks) { v.setUint16(o, id, true); v.setUint32(o + 2, seq, true); o += 6; }
    v.setUint16(o, statics.length, true); o += 2;
    for (const i of statics) {
      v.setUint16(o, i, true);
      v.setUint32(o + 2, en.gen[i], true);
      v.setUint16(o + 6, en.species[i], true);
      v.setInt32(o + 8, en.flags[i], true);
      v.setFloat32(o + 12, en.maxHp[i], true);
      v.setFloat32(o + 16, en.scale[i], true);
      v.setFloat32(o + 20, en.dmg[i], true);
      v.setFloat32(o + 24, en.speed[i], true);
      v.setFloat32(o + 28, en.xp[i], true);
      v.setUint8(o + 32, en.t1[i]);
      v.setUint8(o + 33, en.t2[i]);
      v.setFloat32(o + 34, en.radius[i], true);
      o += 38;
    }
    v.setUint16(o, dyn.length, true); o += 2;
    for (const i of dyn) {
      v.setUint16(o, i, true);
      v.setUint8(o + 2, en.gen[i] & 255);
      v.setInt16(o + 3, clamp16(en.x[i] * POS_SCALE), true);
      v.setInt16(o + 5, clamp16(en.y[i] * POS_SCALE), true);
      v.setInt16(o + 7, clamp16(en.z[i] * POS_SCALE), true);
      v.setFloat32(o + 9, en.hp[i], true);
      v.setFloat32(o + 13, en.shield[i], true);
      let bits = 0;
      for (let b = 0; b < STATUS_BITS.length; b++) if (en[STATUS_BITS[b]][i] > 0) bits |= 1 << b;
      v.setUint16(o + 17, bits, true);
      v.setInt8(o + 19, Math.round(en.fx[i] * 127));
      v.setInt8(o + 20, Math.round(en.fz[i] * 127));
      v.setUint8(o + 21, (en.dying[i] > 0 ? 1 : 0) | (en.atkAnim[i] > 0 ? 2 : 0) | (en.air[i] ? 4 : 0));
      v.setUint8(o + 22, Math.min(255, Math.round((en.dying[i] > 0 ? en.dying[i] : 0) * 400)));
      o += 23;
    }
    return buf.slice(0, o);
  }

  const clamp16 = (x) => Math.max(-32768, Math.min(32767, Math.round(x)));

  LAN.on('summon', (m) => {
    const run = host.run;
    if (!LAN.isHost || !run || m.seed !== (run.seed >>> 0) || m.stage !== run.stage) return;
    if (run.bossSpawned || run.state === 'transition') return;
    if (run.mewtwo?.active) return;
    const who = LAN.roster.find((p) => p.id === m.from)?.name ?? 'A player';
    run.ui.toast(`${who} summoned the guardian`, null);
    run.spawnBoss(m.x, m.z);
  });

  // Damage, statuses and knockback reported by a client.
  LAN.on('dmg', (m) => {
    const run = host.run;
    if (!LAN.isHost || !run || run !== LAN.run || m.seed !== (run.seed >>> 0) || m.stage !== run.stage) {
      if (LAN.isHost) host.acks.set(m.from, m.seq);
      return;
    }
    const en = run.enemies;
    for (const h of m.hits) {
      const [i, gen, dmg, dShield, dkx, dkz, kill, st] = h;
      if (!en.alive[i] || en.gen[i] !== gen || en.dying[i] > 0) continue;
      if (dShield) en.shield[i] = Math.max(0, en.shield[i] - dShield);
      if (dmg) {
        en.hp[i] -= dmg;
        en.flash[i] = 1;
        en.squash[i] = 0.6;
        if (en.flags[i] & 4) run.boss.kit?.clampHp?.();
      }
      if (dkx || dkz) { en.kx[i] += dkx; en.kz[i] += dkz; }
      if (st) for (const k in st) {
        const f = STATUS_FIELDS[k];
        if (f) en[f][i] = f.endsWith('Dps') || f === 'poisonStacks' || f === 'chill' ? st[k] : Math.max(en[f][i], st[k]);
      }
      if (kill || en.hp[i] <= 0) {
        try { run.combat.killEnemy(i, { type: 'normal', slot: -1 }); } catch (e) { console.warn('[LAN] kill', e); }
      }
    }
    host.acks.set(m.from, m.seq);
  });

  // -------------------------------------------------------------- client

  const cli = {
    run: null,
    ready: false,
    tx: null, ty: null, tz: null,
    fresh: null,
    bHp: null, bShield: null, bKx: null, bKz: null,
    bStatus: null,
    localHitAt: null,
    localKilled: null, // gen killed locally, so snapshots don't revive it
    killedAt: null,
    present: null,
    pending: [], // [seq, idx, gen, dmg]
    seq: 0,
    lastSnap: 0,
  };

  function installClient(run) {
    cli.run = run;
    const N = 4096;
    cli.tx = new Float32Array(N); cli.ty = new Float32Array(N); cli.tz = new Float32Array(N);
    cli.fresh = new Uint8Array(N);
    cli.bHp = new Float64Array(N); cli.bShield = new Float64Array(N);
    cli.bKx = new Float32Array(N); cli.bKz = new Float32Array(N);
    cli.bStatus = STATUS_FIELDS.map(() => new Float32Array(N));
    cli.localHitAt = new Float64Array(N);
    cli.localKilled = new Int32Array(N).fill(-1);
    cli.killedAt = new Float64Array(N);
    cli.present = new Uint32Array(N);
    cli.pending = [];
    cli.ready = true;

    const en = run.enemies;
    en.clear();
    en.spawn = () => -1;
    en.update = (dt) => mirrorUpdate(run, dt);
    disableSpawners(run);
    // Summoning the guardian at an altar happens in the host's world.
    run.spawnBoss = (x, z) => {
      run.bossSpawned = true;
      LAN.send({ t: 'summon', seed: run.seed >>> 0, stage: run.stage, x, z });
    };
    const buildStage = run.buildStage.bind(run);
    run.buildStage = (first) => {
      buildStage(first);
      disableSpawners(run);
      run.enemies.clear();
      cli.pending.length = 0;
      cli.localKilled.fill(-1);
    };
  }

  const noop = () => {};
  function disableSpawners(run) {
    run.director.update = noop;
    run.events.update = noop;
    run.minibosses.update = noop;
    run.mewtwo.update = noop;
    if (run.endless) run.endless.update = noop;
  }

  LAN.on('binary', (buf) => {
    if (LAN.isHost || !cli.ready || cli.run !== LAN.run) return;
    const v = new DataView(buf);
    if (v.getUint8(0) !== 1) return;
    applySnapshot(cli.run, v);
  });

  function applySnapshot(run, v) {
    let o = 1;
    const seed = v.getUint32(o, true); o += 4;
    const stage = v.getUint16(o, true); o += 2;
    const seq = v.getUint32(o, true); o += 4;
    if (seed !== (run.seed >>> 0) || stage !== run.stage || run.state === 'transition') return;
    const en = run.enemies;
    const now = performance.now();

    const nAck = v.getUint16(o, true); o += 2;
    for (let k = 0; k < nAck; k++) {
      const id = v.getUint16(o, true), ack = v.getUint32(o + 2, true);
      o += 6;
      if (id === LAN.myId) cli.pending = cli.pending.filter((p) => p[0] > ack);
    }

    const nStatic = v.getUint16(o, true); o += 2;
    for (let k = 0; k < nStatic; k++) {
      const i = v.getUint16(o, true);
      const gen = v.getUint32(o + 2, true);
      if (en.gen[i] !== gen || !en.alive[i]) {
        resetSlot(en, i, gen);
        cli.fresh[i] = 1;
      }
      en.species[i] = v.getUint16(o + 6, true);
      en.flags[i] = v.getInt32(o + 8, true);
      en.maxHp[i] = v.getFloat32(o + 12, true);
      en.scale[i] = v.getFloat32(o + 16, true);
      en.dmg[i] = v.getFloat32(o + 20, true);
      en.speed[i] = v.getFloat32(o + 24, true);
      en.xp[i] = v.getFloat32(o + 28, true);
      en.t1[i] = v.getUint8(o + 32);
      en.t2[i] = v.getUint8(o + 33);
      const radius = v.getFloat32(o + 34, true);
      if (radius > 0 && !en.sized[i]) en.radius[i] = radius;
      o += 38;
    }

    const nDyn = v.getUint16(o, true); o += 2;
    let maxIdx = -1;
    for (let k = 0; k < nDyn; k++) {
      const i = v.getUint16(o, true);
      const genLo = v.getUint8(o + 2);
      const x = v.getInt16(o + 3, true) / POS_SCALE;
      const y = v.getInt16(o + 5, true) / POS_SCALE;
      const z = v.getInt16(o + 7, true) / POS_SCALE;
      const hp = v.getFloat32(o + 9, true);
      const shield = v.getFloat32(o + 13, true);
      const bits = v.getUint16(o + 17, true);
      const fx = v.getInt8(o + 19) / 127, fz = v.getInt8(o + 20) / 127;
      const flags = v.getUint8(o + 21);
      const dyingT = v.getUint8(o + 22) / 400;
      o += 23;
      if ((en.gen[i] & 255) !== genLo) continue; // static info not received yet
      cli.present[i] = seq;
      if (i > maxIdx) maxIdx = i;
      cli.tx[i] = x; cli.ty[i] = y; cli.tz[i] = z;

      if (cli.localKilled[i] === (en.gen[i] | 0)) {
        // Already dead here. A local kill the host never confirms comes back.
        if (cli.killedAt[i] > 0 && !(flags & 1) && now - cli.killedAt[i] > 1500) {
          cli.localKilled[i] = -1;
          if (!en.alive[i]) en.count++;
          en.alive[i] = 1; en.dying[i] = 0; en.hp[i] = hp;
          en.x[i] = x; en.y[i] = y; en.z[i] = z;
          cli.bHp[i] = hp;
        } else continue;
      }

      if (!en.alive[i]) { en.alive[i] = 1; en.count++; cli.fresh[i] = 1; }
      if (cli.fresh[i]) {
        cli.fresh[i] = 0;
        en.x[i] = x; en.y[i] = y; en.z[i] = z;
        en.fx[i] = fx; en.fz[i] = fz;
      }

      if (flags & 1) {
        if (en.dying[i] <= 0) remoteDeath(run, i, dyingT);
        continue;
      }

      let pend = 0;
      for (const p of cli.pending) if (p[1] === i && p[2] === en.gen[i]) pend += p[3];
      const newHp = hp - pend;
      if (newHp < en.hp[i] - 0.01) { en.flash[i] = Math.max(en.flash[i], 0.8); en.squash[i] = 0.5; }
      en.hp[i] = newHp;
      en.shield[i] = shield;
      cli.bHp[i] = en.hp[i];
      cli.bShield[i] = shield;
      if (flags & 2 && en.atkAnim[i] <= 0) en.atkAnim[i] = 0.35;
      en.air[i] = flags & 4 ? 1 : 0;
      if (Math.abs(fx) + Math.abs(fz) > 0.1) { en.fx[i] = fx; en.fz[i] = fz; }

      if (now - cli.localHitAt[i] > 400) {
        for (let b = 0; b < STATUS_BITS.length; b++) {
          const f = STATUS_BITS[b];
          const on = (bits >> b) & 1;
          if (on && en[f][i] <= 0) en[f][i] = f === 'chill' ? 1 : 0.5;
          else if (!on && en[f][i] > 0) en[f][i] = 0;
        }
        snapStatusBaseline(en, i);
      }
    }

    // Enemies the host no longer has: removed without a death (despawned).
    for (let i = 0; i < en.n; i++) {
      if (en.alive[i] && cli.present[i] !== seq && en.dying[i] <= 0 && cli.localKilled[i] !== (en.gen[i] | 0)) {
        en.alive[i] = 0;
        en.count--;
      }
    }
    en.n = Math.max(maxIdx + 1, highestAlive(en) + 1);
    cli.lastSnap = now;
  }

  function highestAlive(en) {
    for (let i = en.n - 1; i >= 0; i--) if (en.alive[i]) return i;
    return -1;
  }

  function resetSlot(en, i, gen) {
    if (!en.alive[i]) en.count++;
    en.alive[i] = 1;
    en.gen[i] = gen;
    en.dying[i] = 0;
    en.sized[i] = 0;
    en.flash[i] = 0; en.squash[i] = 0; en.atkAnim[i] = 0; en.atk[i] = 0;
    en.vx[i] = en.vz[i] = en.vy[i] = en.kx[i] = en.kz[i] = 0;
    en.air[i] = 0;
    en.anim[i] = Math.random() * 3;
    en.shield[i] = 0;
    for (const f of STATUS_FIELDS) en[f][i] = 0;
    en.hazSlow[i] = 1;
    en.knockAt[i] = en.flinchAt[i] = -99;
    en.ccT[i] = en.ccImmune[i] = 0;
    en.lastHitBy[i] = -1;
    en.counted[i] = 0;
    cli.localKilled[i] = -1;
    cli.localHitAt[i] = 0;
    cli.bKx[i] = cli.bKz[i] = 0;
    cli.pending = cli.pending.filter((p) => p[1] !== i);
    snapStatusBaseline(en, i);
  }

  function snapStatusBaseline(en, i) {
    for (let k = 0; k < STATUS_FIELDS.length; k++) cli.bStatus[k][i] = en[STATUS_FIELDS[k]][i];
  }

  // Someone else killed this enemy: play its death and give us our share of
  // the loot (experience, coins, chests are personal).
  function remoteDeath(run, i, dyingT) {
    const en = run.enemies;
    en.dying[i] = dyingT > 0 ? dyingT : 0.35;
    en.hp[i] = 0;
    cli.bHp[i] = 0;
    cli.localKilled[i] = en.gen[i] | 0;
    cli.killedAt[i] = 0; // remote deaths are final
    try {
      run.combat.credit(i, { type: 'normal', slot: -1 }, true);
    } catch (e) {
      console.warn('[LAN] credit', e);
    }
  }

  // Replaces the enemy AI on clients: glide toward the host's positions and
  // resolve contact damage against our own player.
  function mirrorUpdate(run, dt) {
    const en = run.enemies;
    const p = run.player;
    en.grid.build(en.n, en.x, en.z, en.alive);
    const k = 1 - Math.exp(-dt * 14);
    const canHurt = run.state === 'play' && !p.dead;
    for (let l = 0; l < en.n; l++) {
      if (!en.alive[l]) continue;
      if (en.dying[l] > 0) {
        en.dying[l] -= dt;
        if (en.dying[l] <= 0) { en.alive[l] = 0; en.count--; }
        continue;
      }
      en.flash[l] = Math.max(0, en.flash[l] - dt * 6);
      en.squash[l] *= Math.exp(-dt * 10);
      en.atkAnim[l] = Math.max(0, en.atkAnim[l] - dt);
      if (!en.sized[l]) {
        const s = run.sprites.get(en.species[l]);
        if (s.ready) {
          en.sized[l] = 1;
          en.radius[l] = Math.max(0.45, Math.min(4, s.bodyWidth(en.scale[l]) * 0.42));
          en.hgt[l] = Math.max(0.8, s.bodyHeight(en.scale[l]));
        }
      }
      const ox = en.x[l], oz = en.z[l];
      en.x[l] += (cli.tx[l] - en.x[l]) * k;
      en.z[l] += (cli.tz[l] - en.z[l]) * k;
      en.y[l] += (cli.ty[l] - en.y[l]) * k;
      const mv = Math.hypot(en.x[l] - ox, en.z[l] - oz);
      if (mv > 0.0005) en.anim[l] += dt * (0.6 + Math.min(6, mv / Math.max(dt, 1e-4)) / 4);

      const u = en.flags[l];
      if (u & 16512 || !canHurt) continue;
      const frozen = en.frozen[l] > 0 || en.sleep[l] > 0 || en.stun[l] > 0;
      const dx = en.x[l] - p.pos.x, dz = en.z[l] - p.pos.z;
      const dist = Math.hypot(dx, dz) || 1;
      const v = en.radius[l];
      // Soft push so the player can't walk through crowds.
      const s = (v + p.radius) * 0.8;
      if (dist < s && p.pos.y < en.y[l] + en.hgt[l] * 0.8 && p.pos.y > en.y[l] - 1) {
        const d = s - dist;
        p.crowdX -= (dx / dist) * d * 0.5;
        p.crowdZ -= (dz / dist) * d * 0.5;
      }
      if (!frozen && dist < v + p.radius && Math.abs(en.y[l] - p.pos.y) < en.hgt[l] + 0.8) {
        const elite = u & 12294;
        const crit = elite ? 0.25 : 0;
        const hit = p.hurt(
          en.dmg[l] * (en.charm[l] > 0 ? 0.6 : 1) * run.diff.enemyDamage,
          en.typesOf(l)[0], l, NaN, NaN, false, crit, l, u & 4 ? { floor: 0.05 } : {},
        );
        if (hit) {
          en.atkAnim[l] = 0.35;
          p.shove(-dx / dist, -dz / dist, u & 12294 ? 9 : 3 + Math.min(4, v * 2.5));
        }
      }
    }
  }

  // After our simulation step: report what our attacks did to the enemies.
  function clientPost(run, dt) {
    const en = run.enemies;
    if (!cli.ready || run.state === 'transition') return;
    // simulate() (and our mirror inside it) is frozen while we're in a menu.
    if (WORLD_STATES.has(run.state)) mirrorUpdate(run, Math.min(dt, 1 / 20));
    const hits = [];
    const now = performance.now();
    for (let i = 0; i < en.n; i++) {
      if (!en.alive[i]) continue;
      const killedNow = en.dying[i] > 0 && cli.localKilled[i] !== (en.gen[i] | 0) && cli.bHp[i] > 0;
      const dmg = cli.bHp[i] - en.hp[i];
      const dShield = cli.bShield[i] - en.shield[i];
      const dkx = en.kx[i] - cli.bKx[i], dkz = en.kz[i] - cli.bKz[i];
      let st = null;
      for (let k = 0; k < STATUS_FIELDS.length; k++) {
        const cur = en[STATUS_FIELDS[k]][i];
        if (cur !== cli.bStatus[k][i]) {
          if (cur > cli.bStatus[k][i]) (st ??= {})[k] = +cur.toFixed(3);
          cli.bStatus[k][i] = cur;
        }
      }
      if (dmg > 0.001 || dShield > 0.001 || Math.abs(dkx) + Math.abs(dkz) > 0.01 || st || killedNow) {
        hits.push([i, en.gen[i], dmg > 0 ? +dmg.toFixed(2) : 0, dShield > 0 ? +dShield.toFixed(2) : 0,
          +dkx.toFixed(2), +dkz.toFixed(2), killedNow ? 1 : 0, st]);
        cli.localHitAt[i] = now;
        if (dmg > 0) cli.pending.push([cli.seq + 1, i, en.gen[i], dmg]);
        if (killedNow) { cli.localKilled[i] = en.gen[i] | 0; cli.killedAt[i] = now; }
      }
      cli.bHp[i] = en.hp[i];
      cli.bShield[i] = en.shield[i];
      // Knockback is applied by the host; keep ours decaying so it isn't resent.
      en.kx[i] *= Math.exp(-dt * 7); en.kz[i] *= Math.exp(-dt * 7);
      cli.bKx[i] = en.kx[i]; cli.bKz[i] = en.kz[i];
    }
    if (hits.length) {
      cli.seq++;
      LAN.send({ t: 'dmg', seq: cli.seq, seed: run.seed >>> 0, stage: run.stage, hits });
    }
  }

  // ------------------------------------------------------------- wiring

  LAN.world = {
    install(run) {
      cli.ready = false;
      host.run = null;
      LAN.multi = false;
      if (!run.__lan.sync) return;
      if (LAN.isHost) installHost(run);
      else installClient(run);
    },
    pre(run, dt) {
      if (!run.__lan.sync) return;
      if (LAN.isHost && host.run === run) hostPre(run);
    },
    post(run, dt) {
      if (!run.__lan.sync) return;
      if (LAN.isHost && host.run === run) hostPost(run, dt);
      else if (!LAN.isHost && cli.run === run) clientPost(run, dt);
    },
    reset() {
      cli.ready = false;
      host.run = null;
      LAN.multi = false;
    },
  };
})();
