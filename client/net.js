// PokéBonk LAN client. Loaded before the game bundle; it waits for the game to
// expose its app (window.__pbApp) and then hooks each run as it starts.
(() => {
  const SEND_HZ = 20;
  const NAME_KEY = 'pblan.name';

  const LAN = (window.LAN = {
    ws: null,
    myId: null,
    hostId: null,
    roster: [],
    hostRun: null, // { cfg, stage } announced by the host
    puppets: new Map(), // id -> remote player state
    run: null,
    joining: null, // cfg we are starting because the host started it
    pendingPortal: null,
    get isHost() { return this.myId != null && this.myId === this.hostId; },
    get connected() { return this.ws?.readyState === 1; },
    handlers: {},
    on(type, fn) { (this.handlers[type] ??= []).push(fn); },
  });

  // ---------------------------------------------------------------- network

  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/lan/ws`);
    ws.binaryType = 'arraybuffer';
    LAN.ws = ws;
    ws.onopen = () => { hello(); ui.refresh(); };
    ws.onclose = () => {
      LAN.myId = null;
      ui.refresh();
      setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return emit('binary', ev.data);
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      emit(msg.t, msg);
    };
  }

  function emit(type, msg) {
    for (const fn of LAN.handlers[type] ?? []) {
      try { fn(msg); } catch (e) { console.error('[LAN]', type, e); }
    }
  }

  LAN.send = (msg) => { if (LAN.connected) LAN.ws.send(JSON.stringify(msg)); };
  LAN.sendBinary = (buf) => { if (LAN.connected) LAN.ws.send(buf); };

  function myName() {
    try {
      const saved = localStorage.getItem(NAME_KEY);
      if (saved) return saved;
    } catch {}
    return window.__pbApp?.meta?.account?.name || 'Trainer';
  }

  // Identifies this browser tab across reconnects, so a dropped connection is
  // replaced instead of leaving a frozen copy of the player behind.
  // window.name survives reloads of the same tab/frame but isn't shared with
  // other tabs or frames.
  const TAB_KEY = (() => {
    const m = /^pblan:([a-z0-9]+)$/.exec(window.name || '');
    if (m) return m[1];
    const k = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { window.name = 'pblan:' + k; } catch {}
    return k;
  })();
  LAN.key = TAB_KEY;

  function hello() {
    LAN.send({ t: 'hello', key: TAB_KEY, name: myName(), species: window.__pbApp?.meta?.profile?.lastSpecies ?? null });
  }

  LAN.on('welcome', (m) => {
    LAN.myId = m.id;
    LAN.hostId = m.host;
    LAN.hostRun = m.run;
    ui.refresh();
  });
  LAN.on('roster', (m) => {
    LAN.hostId = m.host;
    LAN.roster = m.players;
    LAN.hostRun = m.run;
    for (const id of LAN.puppets.keys()) if (!m.players.some((p) => p.id === id)) LAN.puppets.delete(id);
    ui.refresh();
  });
  LAN.on('hostLeft', () => {
    LAN.hostRun = null;
  });

  // ------------------------------------------------------------- run start

  // Called by the patched game right before a run is created.
  LAN.runCfg = (cfg) => {
    if (LAN.joining) {
      const j = LAN.joining;
      LAN.joining = null;
      return { ...cfg, seed: j.seed, biome: j.biome, tier: j.tier, mode: j.mode, boosts: [] };
    }
    if (LAN.isHost) {
      const shared = { seed: cfg.seed, biome: cfg.biome, tier: cfg.tier, mode: cfg.mode };
      LAN.hostRun = { cfg: shared, stage: 1 };
      LAN.send({ t: 'start', cfg: shared });
    } else if (LAN.hostRun) {
      // A client pressed Play while the host is in a run: join that run instead.
      const j = LAN.hostRun.cfg;
      return { ...cfg, seed: j.seed, biome: j.biome, tier: j.tier, mode: j.mode, boosts: [] };
    }
    return cfg;
  };

  LAN.on('start', (m) => {
    LAN.hostRun = { cfg: m.cfg, stage: 1 };
    followHost();
  });
  LAN.on('stage', (m) => { if (LAN.hostRun) LAN.hostRun.stage = m.stage; });
  LAN.on('end', (m) => {
    LAN.hostRun = null;
    // The shared world lives in the host's game: when it ends, it ends for all.
    const run = LAN.run;
    if (run?.__lan.sync && !LAN.isHost && run.state !== 'over') {
      toast(m.victory ? 'Team victory!' : "The host's run has ended");
      run.finish(!!m.victory);
    }
  });
  LAN.on('hostLeft', () => {
    const run = LAN.run;
    if (run?.__lan.sync && run.state !== 'over') {
      toast('The host disconnected: the run is over');
      run.finish(false);
    }
  });

  // Pulls this player into the host's run once their menu is idle.
  let followAt = 0;
  function followHost() {
    const app = window.__pbApp;
    if (LAN.isHost || !LAN.hostRun || !app?.meta?.profile || app.starting || !app.screen) return;
    if (app.run && app.run.state !== 'over') return;
    if (performance.now() - followAt < 3000) return;
    followAt = performance.now();
    const cfg = LAN.hostRun.cfg;
    LAN.joining = cfg;
    const p = app.meta.profile;
    app.startRun({ species: p.lastSpecies, biome: cfg.biome, tier: cfg.tier, mode: cfg.mode, boosts: [] })
      .then((ok) => { if (!ok) LAN.joining = null; });
  }

  // --------------------------------------------------------------- run hooks

  function onNewRun(run) {
    LAN.run = run;
    LAN.pendingPortal = null;
    const sync = !!LAN.hostRun && run.seed === LAN.hostRun.cfg.seed;
    run.__lan = { sync, sendAcc: 0 };

    const update = run.update.bind(run);
    run.update = (dt) => {
      preUpdate(run, dt);
      update(dt);
      postUpdate(run, dt);
    };

    const enterPortal = run.enterPortal.bind(run);
    run.__lanEnterPortal = enterPortal;
    run.enterPortal = async () => {
      if (run.state !== 'play' || run.player.dead) return enterPortal();
      if (run.__lan.sync) LAN.send({ t: 'portal', stage: run.stage });
      const r = await enterPortal();
      if (LAN.isHost && run.__lan.sync) LAN.send({ t: 'stage', stage: run.stage });
      return r;
    };

    hookPlayerRender(run);
    LAN.world?.install(run);
    LAN.combat?.install(run);
    if (sync) installDeath(run);

    // Late join: catch up with the host's current zone.
    if (sync && !LAN.isHost && LAN.hostRun.stage > 1) {
      const target = LAN.hostRun.stage;
      const wait = setInterval(async () => {
        if (LAN.run !== run) return clearInterval(wait);
        if (run.state !== 'play') return;
        clearInterval(wait);
        run.stage = target - 1;
        await enterPortal();
      }, 300);
    }
    if (LAN.isHost && sync) LAN.send({ t: 'stage', stage: run.stage });
    ui.refresh();
  }

  function onRunEnded(run) {
    if (run.__lan?.ended) return;
    if (run.__lan) run.__lan.ended = true;
    if (LAN.isHost && run.__lan?.sync) LAN.send({ t: 'end', victory: !!run.victory });
    LAN.run = null;
    LAN.world?.reset();
    tags.clear();
    ui.refresh();
  }

  LAN.on('portal', (m) => {
    const run = LAN.run;
    if (!run?.__lan.sync || run.stage !== m.stage) return;
    LAN.pendingPortal = m.stage;
  });

  function isFinalStage(run) {
    return run.stage >= 4 || (run.stage >= 3 && !run.biome.sanctuary);
  }

  function preUpdate(run, dt) {
    LAN.world?.pre(run, dt);
    if (run.__lan.sync) applyScaling(run);
    if (LAN.pendingPortal != null) {
      if (run.stage !== LAN.pendingPortal) LAN.pendingPortal = null;
      else if (run.state === 'play') {
        LAN.pendingPortal = null;
        if (isFinalStage(run)) {
          if (run.player.dead) revive(run, false);
          run.finish(true);
        } else {
          if (run.player.dead) revive(run, false);
          run.__lanEnterPortal().then(() => {
            if (LAN.isHost) LAN.send({ t: 'stage', stage: run.stage });
            if (run.__lan.reviveBanner) {
              run.__lan.reviveBanner = false;
              try { run.ui.banner('Back in action!', 'You revived in the new zone', '#7aff8a', { species: run.player.speciesId }); } catch {}
            }
          });
        }
      }
    }
    if (run.__lan.spectating) spectateTick(run, dt);
  }

  function postUpdate(run, dt) {
    const st = run.__lan;
    LAN.world?.post(run, dt);
    LAN.combat?.post(run, dt);
    st.sendAcc += dt;
    if (st.sendAcc >= 1 / SEND_HZ) {
      st.sendAcc = 0;
      sendPlayerState(run);
    }
    stepPuppets(dt);
    tags.update(run);
  }

  // ------------------------------------------------------- death & spectate

  function livingFriends(run) {
    return visiblePuppets(run).filter((p) => !p.target.dead);
  }

  function installDeath(run) {
    const onPlayerDeath = run.onPlayerDeath.bind(run);
    run.__lanGameOver = onPlayerDeath;
    run.onPlayerDeath = () => {
      // Final legendary beaten: the run ends in victory as usual.
      if (run.regionCleared || !livingFriends(run).length) return onPlayerDeath();
      startSpectating(run);
    };
    // A dead player keeps the world running but doesn't act.
    const interact = run.interactables.interact.bind(run.interactables);
    run.interactables.interact = (...a) => (run.player.dead ? undefined : interact(...a));
    const updateCamera = run.updateCamera.bind(run);
    run.updateCamera = (dt) => {
      const st = run.__lan;
      const pp = st.spectating ? LAN.puppets.get(st.watch) : null;
      if (!pp) return updateCamera(dt);
      const pos = run.player.pos;
      const x = pos.x, y = pos.y, z = pos.z;
      pos.set(pp.x, pp.y, pp.z);
      try { updateCamera(dt); } finally { pos.set(x, y, z); }
    };
  }

  function startSpectating(run) {
    const st = run.__lan;
    st.spectating = true;
    st.allDeadT = 0;
    st.reviveBanner = true;
    const friend = livingFriends(run)[0];
    st.watch = friend?.id ?? null;
    run.audio.defeat?.();
    const name = LAN.roster.find((p) => p.id === st.watch)?.name ?? 'your team';
    try {
      run.ui.banner('You were defeated', `Watching ${name} · you revive in the next zone`, '#ff6a8a', { species: run.player.speciesId });
    } catch {}
  }

  function spectateTick(run, dt) {
    const st = run.__lan;
    if (!run.player.dead) { st.spectating = false; return; }
    const alive = livingFriends(run);
    if (!alive.length) {
      // Everyone is down: give the network a moment, then end the run for real.
      st.allDeadT += dt;
      if (st.allDeadT > 1.2 && run.state === 'play') {
        st.spectating = false;
        run.__lanGameOver();
      }
      return;
    }
    st.allDeadT = 0;
    if (!alive.some((p) => p.id === st.watch)) st.watch = alive[0].id;
    // Tab / click cycles who you're watching.
    if (run.input.hit?.('Tab') || run.input.mouseClicked?.[0]) {
      const i = alive.findIndex((p) => p.id === st.watch);
      st.watch = alive[(i + 1) % alive.length].id;
    }
  }

  function revive(run, banner = true) {
    const p = run.player;
    p.dead = false;
    p.hp = Math.max(1, p.maxHp * 0.5);
    p.iframes = 3;
    run.__lan.spectating = false;
    if (banner) {
      try { run.ui.banner('Back in action!', 'You revived', '#7aff8a', { species: p.speciesId }); } catch {}
    }
  }

  // More players, tougher and more numerous enemies. Experience per kill is
  // scaled down because every player gets experience from every kill.
  function applyScaling(run) {
    const base = (run.__lan.baseDiff ??= { ...run.diff });
    const n = 1 + visiblePuppets(run).length;
    if (run.__lan.scaledFor === n) return;
    run.__lan.scaledFor = n;
    const k = n - 1;
    run.diff.enemyHp = base.enemyHp * (1 + 0.7 * k);
    run.diff.enemyAmount = base.enemyAmount * (1 + 0.45 * k);
    run.diff.enemyDamage = base.enemyDamage * (1 + 0.1 * k);
    run.diff.xp = base.xp / (1 + 0.45 * k);
  }

  // ------------------------------------------------------------- puppets

  function sendPlayerState(run) {
    const p = run.player;
    if (!p) return;
    LAN.send({
      t: 'p',
      k: TAB_KEY,
      seed: run.seed,
      stage: run.stage,
      x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3), z: +p.pos.z.toFixed(3),
      fx: +p.facing.x.toFixed(3), fz: +p.facing.y.toFixed(3),
      sp: p.speciesId,
      mv: p.speedNow > 0.6 ? 1 : 0,
      atk: p.attackT > 0 ? 1 : 0,
      hurt: p.hurtT > 0 ? 1 : 0,
      sc: +p.renderScale.toFixed(3),
      hp: Math.round(p.hp), mhp: Math.round(p.maxHp),
      lv: p.level,
      dead: p.dead ? 1 : 0,
      shiny: run.shinySkin ? 1 : 0,
    });
  }

  LAN.on('p', (m) => {
    let pp = LAN.puppets.get(m.from);
    if (!pp) {
      pp = { id: m.from, x: m.x, y: m.y, z: m.z, animT: 0 };
      LAN.puppets.set(m.from, pp);
    }
    pp.target = m;
    pp.seen = performance.now();
    if (Math.hypot(pp.x - m.x, pp.z - m.z) > 12) { pp.x = m.x; pp.y = m.y; pp.z = m.z; }
  });

  // One entry per player: if a reconnect briefly leaves two connections for
  // the same tab, only the freshest one is shown.
  function visiblePuppets(run) {
    const byKey = new Map();
    const now = performance.now();
    for (const pp of LAN.puppets.values()) {
      const t = pp.target;
      if (!t || now - pp.seen > 3000) continue;
      if (t.seed !== run.seed || t.stage !== run.stage) continue;
      const k = t.k ?? pp.id;
      if (k === TAB_KEY) continue;
      const prev = byKey.get(k);
      if (!prev || pp.seen > prev.seen) byKey.set(k, pp);
    }
    return [...byKey.values()];
  }
  LAN.visiblePuppets = visiblePuppets;

  function stepPuppets(dt) {
    const k = 1 - Math.exp(-dt * 14);
    for (const pp of LAN.puppets.values()) {
      const t = pp.target;
      if (!t) continue;
      pp.x += (t.x - pp.x) * k;
      pp.y += (t.y - pp.y) * k;
      pp.z += (t.z - pp.z) * k;
      pp.animT += dt;
    }
  }

  function hookPlayerRender(run) {
    const player = run.player;
    const render = player.render.bind(player);
    player.render = () => {
      render();
      for (const pp of visiblePuppets(run)) renderPuppet(run, pp);
    };
  }

  function renderPuppet(run, pp) {
    const t = pp.target;
    const sprite = run.sprites.get(t.sp);
    let anim = t.mv ? 'walk' : 'idle';
    let animT = pp.animT;
    let hold = false;
    if (t.hurt) { anim = 'hurt'; animT = 0.6; hold = true; }
    if (t.dead) { anim = 'hurt'; animT = 1; hold = true; }
    const row = run.sprites.dirRow(t.fx, t.fz);
    sprite.push(pp.x, pp.y, pp.z, anim, animT, row, t.sc || 1, 0, t.dead ? 0.5 : 0, 0, 0, 1, 1, 1, 0, hold);
    const ground = run.terrain.surface(pp.x, pp.z);
    run.sprites.shadows.push(pp.x, ground, pp.z, 1.4);
  }

  // ------------------------------------------------------------- name tags

  const tags = {
    el: null,
    nodes: new Map(),
    vec: null,
    ensure() {
      if (this.el) return;
      this.el = document.createElement('div');
      this.el.id = 'lan-tags';
      document.body.append(this.el);
    },
    clear() {
      for (const n of this.nodes.values()) n.remove();
      this.nodes.clear();
    },
    update(run) {
      this.ensure();
      const app = window.__pbApp;
      const cam = app?.r?.camera;
      if (!cam) return;
      this.vec ??= run.camTarget.clone();
      const seen = new Set();
      const w = innerWidth, h = innerHeight;
      for (const pp of visiblePuppets(run)) {
        const v = this.vec.set(pp.x, pp.y + 2.4 * (pp.target.sc || 1), pp.z).project(cam);
        let node = this.nodes.get(pp.id);
        if (!node) {
          node = document.createElement('div');
          node.className = 'lan-tag';
          node.innerHTML = '<b></b><i><s></s></i>';
          this.el.append(node);
          this.nodes.set(pp.id, node);
        }
        seen.add(pp.id);
        const behind = v.z > 1;
        node.style.display = behind ? 'none' : '';
        if (behind) continue;
        node.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
        const info = LAN.roster.find((p) => p.id === pp.id);
        const t = pp.target;
        node.firstChild.textContent = `${info?.name ?? 'Player'} · Lv ${t.lv}${t.dead ? ' · 💀' : ''}`;
        node.lastChild.firstChild.style.width = `${Math.max(0, Math.min(1, t.hp / (t.mhp || 1))) * 100}%`;
      }
      for (const [id, node] of this.nodes) if (!seen.has(id)) { node.remove(); this.nodes.delete(id); }
    },
  };

  // ------------------------------------------------------------- overlay UI

  function toast(text) {
    const app = window.__pbApp;
    if (app?.run?.ui?.toast) app.run.ui.toast(text, null);
    else console.log('[LAN]', text);
  }
  LAN.toast = toast;

  const ui = {
    el: null,
    open: (() => { try { return !localStorage.getItem(NAME_KEY); } catch { return false; } })(),
    ensure() {
      if (this.el || !document.body) return;
      const style = document.createElement('style');
      style.textContent = `
        #lan-pill{position:fixed;left:10px;bottom:10px;z-index:99999;font:600 12px/1.3 system-ui,sans-serif;
          color:#fff;background:rgba(20,16,40,.82);border:1px solid rgba(255,255,255,.18);border-radius:12px;
          padding:7px 11px;cursor:pointer;user-select:none;max-width:280px;backdrop-filter:blur(6px)}
        #lan-pill .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#e55}
        #lan-pill.on .dot{background:#4d6}
        #lan-pill ul{margin:6px 0 0;padding:0;list-style:none;font-weight:500}
        #lan-pill li{padding:2px 0;opacity:.92}
        #lan-pill li.me{color:#ffd23a}
        #lan-pill .hint{margin-top:6px;font-weight:400;opacity:.75}
        #lan-pill .warn{margin-top:6px;padding:5px 7px;border-radius:8px;background:#7a2a2a;font-weight:600}
        #lan-pill .links{margin-top:8px;display:grid;gap:5px}
        #lan-pill .links small{display:block;opacity:.7;font-weight:500}
        #lan-pill .links code{font:600 11px ui-monospace,monospace;word-break:break-all;user-select:all}
        #lan-pill .links button{margin:2px 0 0 6px;padding:2px 7px}
        #lan-pill .gfx{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
        #lan-pill .gfx span{width:100%;opacity:.8}
        #lan-pill .gfx button{margin-top:0;background:rgba(255,255,255,.14)}
        #lan-pill .gfx button.sel{background:#6a4cff}
        #lan-pill button{margin-top:6px;font:inherit;color:#fff;background:#6a4cff;border:0;border-radius:8px;padding:4px 9px;cursor:pointer}
        #lan-tags{position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden}
        .lan-tag{position:absolute;left:0;top:0;text-align:center;white-space:nowrap;
          font:700 12px/1.2 system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px #000,0 0 4px #000}
        .lan-tag i{display:block;margin:3px auto 0;width:54px;height:5px;background:rgba(0,0,0,.55);border-radius:3px;overflow:hidden}
        .lan-tag s{display:block;height:100%;background:#4dde6a;text-decoration:none}
      `;
      document.head.append(style);
      this.el = document.createElement('div');
      this.el.id = 'lan-pill';
      this.el.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        this.open = !this.open;
        this.refresh();
      });
      document.body.append(this.el);
    },
    refresh() {
      this.ensure();
      if (!this.el) return;
      const on = LAN.connected && LAN.myId != null;
      this.el.classList.toggle('on', on);
      const host = LAN.roster.find((p) => p.id === LAN.hostId);
      let html = `<span class="dot"></span>Multiplayer · ${on ? `${LAN.roster.length} player${LAN.roster.length === 1 ? '' : 's'}` : 'connecting…'}`;
      if (on) html += LAN.isHost ? " · you're the host" : ` · host: ${esc(host?.name ?? '—')}`;
      if (LAN.info?.patchFailures?.length) {
        html += '<div class="warn">⚠ PokéBonk was updated and parts of multiplayer may not work. Check for a newer version of the mod.</div>';
      }
      if (this.open && on) {
        html += '<ul>' + LAN.roster.map((p) =>
          `<li class="${p.id === LAN.myId ? 'me' : ''}">${p.id === LAN.hostId ? '👑 ' : ''}${esc(p.name)}</li>`).join('') + '</ul>';
        html += `<div class="hint">${LAN.isHost
          ? 'Pick a map and difficulty and press Play: everyone joins.'
          : LAN.hostRun ? 'The host is in a run: press Play to join.' : 'Pick your Pokémon and wait for the host to start.'}</div>`;
        if (LAN.isHost && LAN.info) {
          const links = [];
          if (LAN.info.publicUrl) links.push(['Over the internet', LAN.info.publicUrl]);
          else if (LAN.info.internet) links.push(['Over the internet', 'opening link…']);
          for (const u of LAN.info.lan ?? []) if (u.includes('192.168.') || u.includes('10.')) links.push(['Same network', u]);
          html += '<div class="links">' + links.map(([label, u]) =>
            `<div><small>${label}</small><code>${esc(u)}</code>${u.startsWith('http') ? `<button data-copy="${esc(u)}">Copy</button>` : ''}</div>`).join('') + '</div>';
        }
        let named = false;
        try { named = !!localStorage.getItem(NAME_KEY); } catch {}
        html += `<button data-act="name">${named ? 'Change name' : 'Set your name'}</button>`;
      }
      if (this.open && LAN.perf) {
        const modes = Object.keys(LAN.perf.labels);
        html += '<div class="gfx"><span>Graphics</span>' + modes.map((m) =>
          `<button data-gfx="${m}" class="${LAN.perf.mode === m ? 'sel' : ''}">${LAN.perf.labels[m]}</button>`).join('') + '</div>';
        html += '<div class="hint fps"></div>';
      }
      this.el.innerHTML = html;
      this.el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
        const u = b.dataset.copy;
        try { await navigator.clipboard.writeText(u); b.textContent = 'Copied!'; }
        catch { prompt('Copy this link and send it to your friends:', u); }
      }));
      this.el.querySelectorAll('[data-gfx]').forEach((b) => b.addEventListener('click', () => LAN.perf.set(b.dataset.gfx)));
      this.el.querySelector('[data-act=name]')?.addEventListener('click', () => {
        const n = prompt('Your name in multiplayer:', myName());
        if (n && n.trim()) {
          try { localStorage.setItem(NAME_KEY, n.trim().slice(0, 24)); } catch {}
          hello();
        }
      });
    },
  };

  LAN.ui = ui;
  // Addresses friends can use to join (shown to the host in the panel).
  async function pollInfo() {
    try {
      const info = await (await fetch('/lan/info', { cache: 'no-store' })).json();
      const changed = JSON.stringify(info) !== JSON.stringify(LAN.info);
      LAN.info = info;
      if (changed) ui.refresh();
    } catch {}
    setTimeout(pollInfo, LAN.info?.internet && !LAN.info.publicUrl ? 2000 : 8000);
  }
  pollInfo();
  setInterval(() => {
    const el = ui.el?.querySelector('.fps');
    const run = window.__pbApp?.run;
    if (el) el.textContent = run ? `${Math.round(run.fps)} fps` : '';
  }, 1000);

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------- watcher

  // Profile changes made in menus (lab upgrades, items, quests) are applied
  // locally by the game; in LAN mode we just store the resulting profile.
  function patchBackend(app) {
    const be = app.backend;
    if (!be || be.__lan) return;
    be.__lan = true;
    const pushProfile = async (account) => {
      const res = await be.req('/profile/full', 'PUT', { profile: app.meta.profile }, account.token);
      return res;
    };
    for (const name of ['buyLab', 'buyItem', 'archiveItem', 'claimQuest', 'claimTask', 'rerollTask']) {
      if (typeof be[name] !== 'function') continue;
      be[name] = async (account) => {
        const res = await pushProfile(account);
        return app.meta.profile ?? res.profile;
      };
    }
  }

  let lastRun = null;
  let lastSpecies = null;
  function watch() {
    const app = window.__pbApp;
    if (app?.backend) patchBackend(app);
    const run = app?.run ?? null;
    if (run !== lastRun) {
      if (lastRun) onRunEnded(lastRun);
      lastRun = run;
      if (run) onNewRun(run);
    }
    if (run && run.state === 'over' && LAN.run === run) onRunEnded(run);
    const sp = app?.meta?.profile?.lastSpecies ?? null;
    if (sp !== lastSpecies) { lastSpecies = sp; hello(); }
    if (!run && LAN.hostRun && !LAN.isHost) followHost();
    requestAnimationFrame(watch);
  }

  // The browser stops drawing frames in a hidden tab. If the host minimizes the
  // game, keep simulating from a worker clock so the world doesn't freeze.
  function keepHostAlive() {
    let worker;
    try {
      const src = 'setInterval(() => postMessage(0), 33);';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch { return; }
    let last = performance.now();
    worker.onmessage = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const app = window.__pbApp;
      const run = app?.run;
      if (!document.hidden || !LAN.isHost || !run?.__lan?.sync || LAN.roster.length < 2) return;
      try {
        run.update(dt);
      } catch (e) {
        console.warn('[LAN] background tick', e);
      } finally {
        app.input?.endFrame?.();
      }
    };
  }

  connect();
  keepHostAlive();
  requestAnimationFrame(watch);
  addEventListener('DOMContentLoaded', () => ui.refresh());
})();
