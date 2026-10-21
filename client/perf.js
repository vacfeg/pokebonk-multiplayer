// Graphics modes for weak PCs (integrated graphics). Each player picks their
// own; it only changes how this browser draws the game, never the shared world.
//
//   normal      the game as shipped
//   light       no post-processing, 75% resolution, shorter view distance,
//               low particle quality
//   ultra       same, at 50% resolution (pixelated), even shorter view
//               distance, 30 fps cap and no damage numbers
(() => {
  const LAN = window.LAN;
  const KEY = 'pblan.perf';
  const SAVED_KEY = 'pblan.perf.saved';

  const MODES = {
    normal: null,
    light: { scale: 0.75, far: 110, cull: 85, pixelated: false, saver: false, numbers: true },
    ultra: { scale: 0.5, far: 72, cull: 56, pixelated: true, saver: true, numbers: false },
  };

  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

  const perf = (LAN.perf = {
    mode: MODES[read(KEY)] !== undefined ? read(KEY) : 'normal',
    get cfg() { return MODES[this.mode]; },
    labels: { normal: 'Normal', light: 'Light', ultra: 'Ultra light' },
    set(mode) {
      if (!(mode in MODES) || mode === this.mode) return;
      const prev = this.mode;
      this.mode = mode;
      write(KEY, mode);
      applySettings(prev);
      refreshRenderer();
      const run = window.__pbApp?.run;
      if (run) cullProps(run);
      LAN.ui?.refresh();
    },
  });

  // ------------------------------------------------------------ renderer

  let hooked = null;
  let lastSky = null;

  function hookRenderer(R) {
    if (hooked === R) return;
    hooked = R;

    // Draw the scene straight to the screen: skips the outline pass (which
    // draws every object a second time), bloom and colour grading.
    const composerRender = R.composer.render.bind(R.composer);
    R.composer.render = (dt) => {
      if (!perf.cfg) return composerRender(dt);
      R.renderer.setRenderTarget(null);
      R.renderer.render(R.scene, R.camera);
    };

    const resize = R.resize.bind(R);
    R.resize = () => {
      resize();
      const c = perf.cfg;
      if (!c) return;
      const pr = Math.round(Math.min(window.devicePixelRatio || 1, 1) * c.scale * 100) / 100;
      const key = `${innerWidth}x${innerHeight}@${pr}`;
      if (R.__lanSize === key) return;
      R.__lanSize = key;
      R.renderer.setPixelRatio(pr);
      R.renderer.setSize(innerWidth, innerHeight, false);
      R.canvas.style.imageRendering = c.pixelated ? 'pixelated' : 'auto';
      R.needsDraw = true;
    };

    const setSky = R.setSky.bind(R);
    R.setSky = (...args) => {
      lastSky = args;
      setSky(...args);
      clampView(R);
    };
  }

  // Fog closes in before the camera's far plane, so distant chests, altars and
  // rocks (most of the draw calls) are never sent to the GPU.
  function clampView(R) {
    const c = perf.cfg;
    const cam = R.camera;
    if (!c) {
      if (cam.far !== 600) { cam.far = 600; cam.updateProjectionMatrix(); }
      return;
    }
    const fog = R.scene.fog;
    const far = Math.min(fog.far, c.far);
    const near = Math.min(fog.near, far * 0.35);
    fog.far = far; fog.near = near;
    R.shared.uFogFar.value = far;
    R.shared.uFogNear.value = near;
    if (cam.far !== far + 8) { cam.far = far + 8; cam.updateProjectionMatrix(); }
  }

  function refreshRenderer() {
    const R = window.__pbApp?.r;
    if (!R) return;
    R.__lanSize = '';
    R.sizeKey = '';
    R.resize();
    if (lastSky) R.setSky(...lastSky);
    else clampView(R);
    R.needsDraw = true;
  }

  // ------------------------------------------------------- game settings

  // The game's own quality options do part of the job (fewer particles, no
  // bloom, 30 fps). Keep the player's original values to restore them later.
  const TOUCHED = ['quality', 'batterySaver', 'damageNumbers'];

  function applySettings(prevMode) {
    const app = window.__pbApp;
    const s = app?.meta?.profile?.settings;
    if (!s) return;
    const c = perf.cfg;
    if (c) {
      if (!MODES[prevMode] && !read(SAVED_KEY)) {
        write(SAVED_KEY, JSON.stringify(Object.fromEntries(TOUCHED.map((k) => [k, s[k] ?? null]))));
      }
      s.quality = 'low';
      s.batterySaver = c.saver;
      s.damageNumbers = c.numbers;
    } else {
      let saved = null;
      try { saved = JSON.parse(read(SAVED_KEY)); } catch {}
      if (saved) for (const k of TOUCHED) { if (saved[k] === null) delete s[k]; else s[k] = saved[k]; }
      write(SAVED_KEY, null);
    }
    try { app.applySettings(); } catch {}
    try { app.meta.save?.(); } catch {}
  }

  // Chests, altars, rocks and signs are built from many separate pieces
  // (around 17 draw calls each). Hide the ones already lost in the fog.
  const culled = new Set();
  function cullProps(run) {
    const list = run.interactables?.list;
    if (!list) return;
    const c = perf.cfg;
    const p = run.camTarget;
    const lim2 = c ? c.cull * c.cull : Infinity;
    for (const e of list) {
      const g = e.group;
      if (!g) continue;
      const far = (e.x - p.x) ** 2 + (e.z - p.z) ** 2 > lim2;
      if (far && g.visible) { g.visible = false; culled.add(e); }
      else if (!far && culled.has(e)) { g.visible = true; culled.delete(e); }
    }
    if (culled.size) for (const e of culled) if (!list.includes(e)) culled.delete(e);
  }

  // ------------------------------------------------------- fps watch

  let slowT = 0;
  let suggested = false;
  function watchFps(run, dt) {
    if (suggested || perf.mode !== 'normal' || run.state !== 'play') return;
    slowT = run.fps < 28 ? slowT + dt : Math.max(0, slowT - dt);
    if (slowT > 8) {
      suggested = true;
      try { run.ui.toast('Running slow? Open the multiplayer panel (bottom left) and pick "Light" graphics', null); } catch {}
    }
  }

  // ------------------------------------------------------------- wiring

  // First visit on integrated graphics: start in a lighter mode on our own.
  let detected = false;
  function autoDetect(R) {
    if (detected) return;
    detected = true;
    if (read(KEY)) return;
    const gpu = R.gpu || '';
    if (R.softwareGpu) perf.mode = 'ultra';
    else if (/intel|uhd|iris|radeon\(tm\)( r\d)? graphics|radeon vega|vega \d|mali|adreno/i.test(gpu)) perf.mode = 'light';
    else return;
    write(KEY, perf.mode);
    console.log('[LAN] integrated graphics detected:', gpu, '→', perf.mode);
  }

  let appliedFor = null;
  function tick() {
    const app = window.__pbApp;
    if (app?.r) {
      autoDetect(app.r);
      hookRenderer(app.r);
      // Re-assert once the profile is loaded (login replaces settings).
      if (app.meta?.profile && appliedFor !== app.meta.profile) {
        appliedFor = app.meta.profile;
        if (perf.cfg) applySettings('normal');
        refreshRenderer();
      }
      const run = app.run;
      if (run) {
        clampView(app.r);
        if (!run.__lanPerf) {
          run.__lanPerf = true;
          const update = run.update.bind(run);
          culled.clear();
          let acc = 0;
          run.update = (dt) => {
            update(dt);
            watchFps(run, dt);
            if ((acc += dt) > 0.2) { acc = 0; cullProps(run); }
          };
        }
      }
    }
    setTimeout(tick, 250);
  }
  tick();
})();
