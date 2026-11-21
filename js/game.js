// The tag game: rounds, IT, tagging, eliminations, bots, camera and effects.
// Works offline (you + bots on this computer) and online (one person per computer, plus bots).
// The "host" decides the rules (the map, who's IT, tags, who's out) and sends them as events.
// Every computer applies the same events, so everyone sees the same game.
// Each computer moves its own player; the host also moves the bots.
(function () {
  'use strict';
  const TG = window.TG;
  const MF = TG.MapFormat, P = TG.Physics, I = TG.Input;

  const SKILL = {
    easy:   { react: 0.45, lead: 0.15, fear: 8,  dash: 0.12, tagDelay: 0.4,  speed: 0.82 },
    normal: { react: 0.26, lead: 0.4,  fear: 11, dash: 0.3,  tagDelay: 0.2,  speed: 0.92 },
    hard:   { react: 0.12, lead: 0.7,  fear: 14, dash: 0.55, tagDelay: 0.08, speed: 1.0 },
  };
  const TAG_H = 1.2, TAG_V = 1.6, IT_BOOST = 1.06, TAG_FREEZE = 1.5, NO_TAG_BACK = 3, IT_HEADSTART = 2;
  const SEND_EVERY = 1 / 15, INTERP = 0.1;
  // Burning Battle: how big each fire patch is, how far apart they're dropped,
  // and how many seconds one burns before going out (Infinity = never goes out).
  const FIRE_R = 0.55, FIRE_GAP = 0.7, FIRE_LIFE = 8;

  let renderer, canvas, camera;
  let st = null;
  const $ = (id) => document.getElementById(id);
  const view = { yaw: Math.PI, pitch: 0.35, dist: 7, drag: false };
  const tmpV = new THREE.Vector3();

  function init(r, cvs) {
    renderer = r; canvas = cvs;
    camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1500);
    canvas.addEventListener('pointerdown', (e) => { if (st) { view.drag = true; try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ok */ } } });
    canvas.addEventListener('pointerup', () => { view.drag = false; });
    canvas.addEventListener('pointercancel', () => { view.drag = false; });
    canvas.addEventListener('pointermove', (e) => {
      if (!st || !view.drag || st.paused) return;
      view.yaw -= (e.movementX || 0) * 0.006;
      view.pitch = Math.max(-0.2, Math.min(1.2, view.pitch + (e.movementY || 0) * 0.004));
    });
    $('btn-resume').addEventListener('click', () => setPaused(false));
    $('btn-quit').addEventListener('click', () => { stop(); TG.Main.showMenu(); });
    $('btn-again').addEventListener('click', () => {
      const s = st.setup, online = st.online;
      stop();
      if (online) TG.Main.showLobby(); else start(s);
    });
    $('btn-results-menu').addEventListener('click', () => { stop(); TG.Main.showMenu(); });
  }
  function resize(a) { camera.aspect = a; camera.updateProjectionMatrix(); }

  // ---------- maps ----------
  function allMaps() {
    const custom = Object.values(TG.Store.all()).map((m) => MF.fixMap(m));
    return { official: (TG.OFFICIAL_MAPS || []).map((m) => MF.fixMap(m)), custom };
  }
  function findMap(id) {
    if (st.setup.cmap && st.setup.cmap.id === id) return st.setup.cmap;
    const { official, custom } = allMaps();
    return official.concat(st.online ? [] : custom).find((m) => m.id === id) || null;
  }
  function pickMap(round) {
    const { official, custom } = allMaps();
    const list = official.length ? official : custom;
    const mode = st.setup.mapMode;
    if (mode && mode.startsWith('map:')) {
      const m = findMap(mode.slice(4));
      if (m) return m;
    }
    if (!list.length) return MF.newMap('day');
    if (mode === 'random') return list[Math.floor(Math.random() * list.length)];
    return list[(round - 1) % list.length];
  }
  function spawnsFor(map) {
    const s = MF.spawnsOf(map);
    if (!s.length) for (let i = 0; i < 8; i++) s.push({ x: Math.cos(i) * 5, y: 3, z: Math.sin(i) * 5 });
    return s;
  }

  // ---------- start / stop ----------
  // setup: { players: [{ key, name, color, hat, kind: 'me' | 'bot' | 'remote', skill }], roundLen, mapMode, cmap? }
  // net: an online room (TG.Net), or nothing for a game on this computer.
  function start(setup, net) {
    const players = setup.players.map((s, i) => {
      const ch = TG.makeCharacter(s.color);
      const hat = TG.makeHat(s.hat);
      ch.hatAnchor.add(hat.group);
      const tagY = 1.95 + hat.height;
      const tagN = TG.makeNameTag(s.name, s.color, false);
      const tagIt = TG.makeNameTag('IT · ' + s.name, s.color, true);
      tagN.position.y = tagIt.position.y = tagY;
      tagIt.visible = false;
      ch.root.add(tagN, tagIt);
      const kind = s.kind || (s.ctrl === 'you' ? 'me' : 'bot');
      return {
        key: s.key || 'k' + i, name: s.name, color: s.color, kind, human: kind === 'me',
        skillName: s.skill, skill: SKILL[s.skill] || SKILL.normal,
        alive: true, ch, hat, tagN, tagIt, body: null, ai: {}, buf: [], rs: 0,
      };
    });
    st = {
      setup, players, byKey: new Map(players.map((p) => [p.key, p])),
      net: net || null, online: !!net, host: !net || net.isHost,
      inbox: [], pending: false, pendingT: 0, claimT: 0, sendT: 0,
      round: 0, totalRounds: players.length - 1, elim: [],
      human: players.find((p) => p.human) || null,
      time: 0, phase: 'none', paused: false, parts: [],
      scene: null, mapGroup: null,
      burning: setup.gameMode === 'burning', trail: [], lastDrop: null, emberT: 0,
    };
    if (net) {
      net.openGame({
        event: (ev) => { if (st) st.inbox.push(ev); },
        pos: onPos,
        claim: (c) => { if (st) st.inbox.push({ t: '_claim', c }); },
        left: (key) => { if (st) st.inbox.push({ t: '_left', who: key }); },
      });
    }
    $('game-ui').hidden = false;
    $('results').hidden = true;
    $('pause').hidden = true;
    $('btn-again').textContent = net ? 'Back to the room' : 'Play again';
    $('btn-quit').textContent = net ? 'Leave the room' : 'Quit to menu';
    I.clear();
    if (st.host) hostStartRound();
  }

  function stop() {
    if (!st) return;
    if (st.net) st.net.closeGame();
    clearScene();
    for (const p of st.players) p.ch.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map) o.material.map.dispose(); });
    st = null;
    $('game-ui').hidden = true;
    $('results').hidden = true;
    $('pause').hidden = true;
  }

  function clearScene() {
    if (!st || !st.scene) return;
    for (const p of st.players) st.scene.remove(p.ch.root);
    if (st.mapGroup) MF.disposeGroup(st.mapGroup);
    for (const q of st.parts) st.scene.remove(q.m);
    st.parts = [];
    clearTrail(false);
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---------- the host decides; everyone applies ----------
  function send(ev) {
    if (st.online) st.net.send(ev);
    else st.inbox.push(ev);
  }
  function setPending() { st.pending = true; st.pendingT = 3; }

  function hostStartRound() {
    const r = st.round + 1;
    const map = pickMap(r);
    const n = spawnsFor(map).length;
    const alive = alivePlayers();
    const order = shuffle([...Array(n).keys()]);
    const spots = {};
    alive.forEach((p, i) => { spots[p.key] = [order[i % n], i >= n ? 1 : 0]; });
    setPending();
    send({ t: 'round', r, map: map.id, it: alive[Math.floor(Math.random() * alive.length)].key, spots });
  }
  // fire = true when they got tagged by stepping in the fire trail
  function hostTag(by, who, fire) {
    setPending();
    send({ t: 'tag', r: st.round, by: by.key, who: who.key, fire: !!fire });
  }

  function applyEvent(ev) {
    if (!ev || typeof ev.t !== 'string') return;
    switch (ev.t) {
      case '_claim': {
        const c = ev.c || {};
        if (!st.host || st.pending || st.phase !== 'play' || c.r !== st.round || !st.it || st.it.key !== c.by) return;
        const q = st.byKey.get(c.who);
        if (q && canTag(st.it, q)) hostTag(st.it, q, !!c.fire);
        return;
      }
      case '_left': {
        const p = st.byKey.get(ev.who);
        if (st.host && p && p.kind === 'remote') send({ t: 'bot', who: p.key });
        return;
      }
      case 'round': if (ev.r === st.round + 1) applyRound(ev); return;
      case 'tag': {
        const by = st.byKey.get(ev.by), who = st.byKey.get(ev.who);
        if (ev.r !== st.round || !by || !who || by !== st.it || !who.alive || who === by) return;
        if (st.phase === 'countdown') { st.phase = 'play'; st.t = 0; }
        if (st.phase !== 'play') return;
        st.pending = false;
        applyTag(by, who, !!ev.fire);
        return;
      }
      case 'out': {
        const p = st.byKey.get(ev.who);
        if (ev.r !== st.round || !p || !p.alive || (st.phase !== 'play' && st.phase !== 'countdown')) return;
        st.pending = false;
        endRound(p);
        return;
      }
      case 'win': {
        const p = st.byKey.get(ev.who);
        if (!p || st.phase === 'over') return;
        st.pending = false;
        finish(p);
        return;
      }
      case 'bot': {
        const p = st.byKey.get(ev.who);
        if (!p || p.kind !== 'remote') return;
        if (st.host) {
          // a friend left: a bot takes over from where they were
          p.kind = 'bot';
          const b = P.createBody(p.body.x, p.body.y, p.body.z);
          b.yaw = p.body.yaw;
          p.body = b;
          p.ai = newAi(b);
          p.skill = SKILL.normal;
        }
        sub(`${p.name} left. A bot is playing for them.`, 2.5);
        return;
      }
    }
  }

  function newAi(b) {
    return { think: 0, dirX: 0, dirZ: 0, sx: b.x, sz: b.z, stuckT: 0, detourT: 0, crawlT: 0, tagT: 0, wanderT: 0 };
  }

  function applyRound(ev) {
    clearScene();
    st.round = ev.r;
    st.pending = false;
    const map = findMap(ev.map) || MF.newMap('day');
    st.map = map;
    const scene = new THREE.Scene();
    MF.applySky(scene, map.settings);
    const mg = new THREE.Group();
    mg.add(MF.buildEnvironment(map.settings));
    for (const p of map.pieces) mg.add(MF.buildPieceGroup(p));
    scene.add(mg);
    st.scene = scene; st.mapGroup = mg;
    st.colliders = MF.collidersOf(map);
    st.gravity = map.settings.gravity;
    st.half = map.settings.size / 2;
    st.spawns = spawnsFor(map);
    st.wanderPts = buildWanderPoints(map);

    // IT ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.07, 8, 36), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
    ring.rotation.x = Math.PI / 2;
    const glow = new THREE.PointLight(0xff3030, 1.4, 6);
    glow.position.y = 1;
    st.itMark = new THREE.Group();
    st.itMark.add(ring, glow);
    st.itRing = ring;
    scene.add(st.itMark);

    // Burning Battle: the flames that follow whoever is IT
    st.fireMark = null;
    st.trail = [];
    st.lastDrop = null;
    if (st.burning) {
      st.fireMark = makeFlames();
      scene.add(st.fireMark);
    }

    const alive = alivePlayers();
    const spots = ev.spots || {};
    alive.forEach((p, i) => {
      const s = Array.isArray(spots[p.key]) ? spots[p.key] : [i, 0];
      const sp = st.spawns[(Number(s[0]) || 0) % st.spawns.length];
      const off = s[1] ? 1.2 : 0;
      p.body = P.createBody(sp.x + off, sp.y + 0.05, sp.z + off);
      p.body.yaw = Math.atan2(-sp.x, -sp.z);
      p.body.frozen = 999;
      p.ai = newAi(p.body);
      p.buf = [];
      scene.add(p.ch.root);
      p.ch.update(p.body, 0);
    });
    const it = st.byKey.get(ev.it);
    st.it = it && it.alive ? it : alive[0];
    st.noBack = null;
    st.phase = 'countdown';
    st.t = 3;
    st.lastCount = 4;
    st.timeLeft = st.setup.roundLen;
    st.lastTick = 99;
    const me = st.human && st.human.alive ? st.human : null;
    view.yaw = (me ? me.body.yaw : st.it.body.yaw) + Math.PI;
    view.pitch = 0.35;
    updateTags();
    $('hud-map').textContent = (st.burning ? '🔥 ' : '') + map.name;
    banner(`Round ${st.round} of ${st.totalRounds}`, '', 1.6);
    if (st.burning) sub(st.it === st.human ? "You're IT and ON FIRE! Your fire trail tags people too!" : `${st.it.name} is IT and ON FIRE! Don't touch the fire!`, 3);
    else sub(st.it === st.human ? "You're IT first! Touch someone to tag them!" : `${st.it.name} is IT. Run!`, 3);
    refreshList();
  }

  function buildWanderPoints(map) {
    const pts = st.spawns.map((s) => ({ x: s.x, y: s.y, z: s.z }));
    for (const c of st.colliders) {
      if (c.floor || c.kind === 'pad' || c.maxY > 60) continue;
      if (c.maxX - c.minX >= 1.5 && c.maxZ - c.minZ >= 1.5) pts.push({ x: (c.minX + c.maxX) / 2, y: c.maxY, z: (c.minZ + c.maxZ) / 2 });
    }
    if (map.settings.floor) {
      const h = map.settings.size / 2 - 4;
      for (let i = 0; i < 24; i++) pts.push({ x: (Math.random() * 2 - 1) * h, y: 0, z: (Math.random() * 2 - 1) * h });
    }
    return pts;
  }

  // ---------- other computers' players ----------
  function onPos(key, a) {
    if (!st) return;
    const p = st.byKey.get(key);
    if (!p || p.kind !== 'remote' || a[0] !== st.round) return;
    for (let i = 1; i < 8; i++) if (typeof a[i] !== 'number' || !isFinite(a[i])) return;
    p.buf.push({ t: performance.now() / 1000, x: a[1], y: a[2], z: a[3], yaw: a[4], speed: a[5], f: a[6] | 0, rs: a[7] | 0 });
    if (p.buf.length > 30) p.buf.shift();
  }
  function snap(p) {
    const b = p.body, r2 = (v) => Math.round(v * 100) / 100;
    const f = (b.grounded ? 1 : 0) | (b.crawling ? 2 : 0) | (b.dashT > 0 || b.backT > 0 ? 4 : 0) | (b.frozen > 0 ? 8 : 0);
    return [st.round, r2(b.x), r2(b.y), r2(b.z), r2(b.yaw), r2(b.speed || 0), f, p.rs];
  }
  // Show them a tiny bit in the past, sliding smoothly between the positions we got.
  function updateRemote(p, dt) {
    const buf = p.buf, B = p.body;
    if (!buf.length) return;
    const rt = performance.now() / 1000 - INTERP;
    while (buf.length >= 2 && buf[1].t <= rt) buf.shift();
    const a = buf[0], b = buf[1];
    const px = B.x, pz = B.z;
    let s = a;
    if (b && rt > a.t && a.rs === b.rs) {
      const k = Math.min(1, (rt - a.t) / Math.max(1e-3, b.t - a.t));
      let dy = (b.yaw - a.yaw) % (Math.PI * 2);
      if (dy > Math.PI) dy -= Math.PI * 2;
      if (dy < -Math.PI) dy += Math.PI * 2;
      B.x = a.x + (b.x - a.x) * k; B.y = a.y + (b.y - a.y) * k; B.z = a.z + (b.z - a.z) * k;
      B.yaw = a.yaw + dy * k;
      B.speed = a.speed + (b.speed - a.speed) * k;
      s = k < 0.5 ? a : b;
    } else {
      if (b && a.rs !== b.rs && rt > a.t) s = b;
      B.x = s.x; B.y = s.y; B.z = s.z; B.yaw = s.yaw; B.speed = s.speed;
    }
    if (dt > 0) { B.vx = B.vx * 0.7 + ((B.x - px) / dt) * 0.3; B.vz = B.vz * 0.7 + ((B.z - pz) / dt) * 0.3; }
    B.grounded = !!(s.f & 1);
    B.crawling = !!(s.f & 2);
    B.dashT = s.f & 4 ? 0.1 : 0;
    B.backT = 0;
    B.frozen = s.f & 8 ? 1 : 0;
  }

  // ---------- per frame ----------
  function update(dt) {
    if (!st) return;
    TG.Pad.poll();
    if (st.phase !== 'over' && (I.pressed('Escape') || TG.Pad.pressed(0, 9))) setPaused(!st.paused);
    if (st.paused && !st.online) return; // online, the game keeps going while your menu is open
    st.time += dt;
    while (st.inbox.length) applyEvent(st.inbox.shift());
    if (!st.scene) return;
    if (st.pending && (st.pendingT -= dt) <= 0) st.pending = false; // a lost message: try again

    if (st.phase === 'countdown') {
      st.t -= dt;
      const n = Math.ceil(st.t);
      if (n !== st.lastCount && n > 0) { st.lastCount = n; banner(String(n), 'count', 0.9); TG.Sound.play('countdown'); }
      if (st.t <= 0) {
        st.phase = 'play';
        for (const p of alivePlayers()) if (p.kind !== 'remote') p.body.frozen = p === st.it ? IT_HEADSTART : 0;
        banner('GO!', 'go', 0.9);
        TG.Sound.play('go');
      }
    } else if (st.phase === 'play') {
      st.timeLeft -= dt;
      const s = Math.ceil(st.timeLeft);
      if (s <= 5 && s > 0 && s !== st.lastTick) { st.lastTick = s; TG.Sound.play('tick'); }
      if (st.timeLeft <= 0) {
        st.timeLeft = 0;
        if (st.host && !st.pending) { setPending(); send({ t: 'out', r: st.round, who: st.it.key }); }
      }
    } else if (st.phase === 'roundEnd') {
      st.t -= dt;
      if (st.t <= 0 && st.host && !st.pending) {
        const alive = alivePlayers();
        if (alive.length <= 1) { setPending(); send({ t: 'win', who: alive[0].key }); }
        else hostStartRound();
      }
    } else if (st.phase === 'over') {
      st.confettiT = (st.confettiT || 0) - dt;
      if (st.confettiT <= 0 && st.winner) {
        st.confettiT = 0.05;
        const b = st.winner.body;
        burst(b.x + (Math.random() - 0.5) * 6, b.y + 6, b.z + (Math.random() - 0.5) * 6, null, 3, 1.5, 3);
      }
    }

    for (const p of alivePlayers()) {
      if (p.kind === 'remote') {
        updateRemote(p, dt);
      } else {
        const inp = st.phase === 'over' ? {} : p.human ? (st.paused ? {} : humanInput(dt)) : botInput(p, dt);
        const mul = (p === st.it ? IT_BOOST : 1) * (p.human ? 1 : p.skill.speed);
        P.step(p.body, inp, { colliders: st.colliders, gravity: st.gravity, speedMul: mul }, dt);
        for (const e of p.body.events) {
          if (e === 'fell') {
            const sp = st.spawns[Math.floor(Math.random() * st.spawns.length)];
            P.respawn(p.body, sp.x, sp.y + 0.05, sp.z, 1);
            p.rs++;
            if (p.human) { TG.Sound.play('fell'); sub('Whoops! You fell off.', 1.5); }
          } else if (p.human || (!st.human || !st.human.alive) && p === st.it) TG.Sound.play(e);
        }
        if (st.phase === 'over' && p === st.winner && p.body.grounded) { p.body.vy = 7; p.body.grounded = false; }
      }
      p.ch.update(p.body, dt);
      p.hat.update(dt);
    }

    // IT tags by touching someone (no button). The host checks bots; your computer checks you.
    st.claimT -= dt;
    const it = st.it;
    if (st.phase === 'play' && it && it.alive && !st.pending && it.kind !== 'remote' && it.body.frozen <= 0) {
      const q = findTag(it);
      if (q) {
        if (st.host) hostTag(it, q);
        else if (st.claimT <= 0) { st.claimT = 0.5; st.net.claim({ r: st.round, by: it.key, who: q.key }); }
      }
    }

    // Burning Battle: stepping in IT's fire tags you. The host checks bots; your computer checks you.
    if (st.burning && st.phase === 'play' && it && it.alive && !st.pending && st.trail.length) {
      for (const q of alivePlayers()) {
        if (q.kind === 'remote' || !canTag(it, q) || !touchingFire(q)) continue;
        if (st.host) hostTag(it, q, true);
        else if (st.claimT <= 0) { st.claimT = 0.5; st.net.claim({ r: st.round, by: it.key, who: q.key, fire: true }); }
        break;
      }
    }

    // send where our players are
    if (st.online && (st.sendT -= dt) <= 0) {
      st.sendT = SEND_EVERY;
      const out = {};
      let any = false;
      for (const p of alivePlayers()) if (p.kind !== 'remote') { out[p.key] = snap(p); any = true; }
      if (any) st.net.sendPos(out);
    }

    if (st.it && st.it.alive) {
      const b = st.it.body;
      st.itMark.visible = true;
      st.itMark.position.set(b.x, b.y + 0.06, b.z);
      const s = 1 + Math.sin(st.time * 8) * 0.08;
      st.itRing.scale.set(s, s, s);
    } else st.itMark.visible = false;

    if (st.burning) updateFire(dt);
    updateParticles(dt);
    updateCamera(dt);
    updateHud(dt);
  }

  function render() { if (st && st.scene) renderer.render(st.scene, camera); }

  const alivePlayers = () => st.players.filter((p) => p.alive);

  function setPaused(v) {
    if (!st) return;
    st.paused = v;
    $('pause').hidden = !v;
    I.clear();
  }

  // ---------- tagging ----------
  function canTag(it, q) {
    if (q === it || !q.alive) return false;
    if (st.noBack && st.noBack.it === it && st.noBack.cannot === q && st.time < st.noBack.until) return false;
    return true;
  }
  function inReach(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z) <= TAG_H && Math.abs(a.y - b.y) <= TAG_V;
  }
  function findTag(p) {
    let best = null, bd = Infinity;
    for (const q of alivePlayers()) {
      if (!canTag(p, q) || !inReach(p.body, q.body)) continue;
      const d = Math.hypot(p.body.x - q.body.x, p.body.z - q.body.z);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }
  function applyTag(p, best, fire) {
    clearTrail(true); // a new IT: the old IT's fire goes out
    st.it = best;
    best.body.frozen = TAG_FREEZE;
    st.noBack = { it: best, cannot: p, until: st.time + NO_TAG_BACK };
    burst(best.body.x, best.body.y + 1, best.body.z, fire ? FIRE_COLORS : ['#ff2a2a', '#ffd23f', '#ffffff'], 26, 6);
    TG.Sound.play(fire ? 'burn' : 'tag');
    if (fire) {
      if (best.human) { banner("🔥 You're IT!", 'it', 1.4); sub(`You stepped in ${p.name}'s fire. Now YOU'RE on fire!`, 2.5); }
      else if (p.human) sub(`${best.name} stepped in your fire! Run!`, 2.5);
      else sub(`${best.name} stepped in ${p.name}'s fire!`, 2);
    } else if (best.human) { banner("You're IT!", 'it', 1.4); sub(`${p.name} got you. Go touch someone!`, 2.5); }
    else if (p.human) sub(`You tagged ${best.name}! Run!`, 2.5);
    else sub(`${p.name} tagged ${best.name}!`, 2);
    updateTags();
    refreshList();
  }

  function endRound(out) {
    clearTrail(true);
    out.alive = false;
    st.elim.push(out);
    st.scene.remove(out.ch.root);
    burst(out.body.x, out.body.y + 0.9, out.body.z, [out.color, '#ffffff', out.color], 60, 9);
    TG.Sound.play('elim');
    banner(out.human ? "You're OUT!" : `${out.name} is OUT!`, 'out', 2.6);
    sub(out.human ? 'You were IT when time ran out. Watch the rest!' : `${out.name} was IT when time ran out.`, 3);
    st.phase = 'roundEnd';
    st.t = 3.2;
    st.it = null;
    refreshList();
    updateTags();
  }

  function finish(w) {
    st.winner = w;
    st.phase = 'over';
    st.it = null;
    updateTags();
    TG.Sound.play('win');
    banner(w.human ? 'YOU WIN!' : `${w.name} WINS!`, 'win', 99);
    sub('', 0);
    const rank = [w].concat(st.elim.slice().reverse());
    $('results-list').innerHTML = rank.map((p, i) =>
      `<li style="--c:${p.color}"><b>${i + 1}</b><span class="dot"></span>${esc(p.name)}${p.human ? ' <em>(you)</em>' : ''}${i === 0 ? ' 🏆' : ''}</li>`).join('');
    setTimeout(() => { if (st && st.phase === 'over') $('results').hidden = false; }, 2200);
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function updateTags() {
    for (const p of st.players) {
      const isIt = p === st.it;
      p.tagN.visible = !isIt;
      p.tagIt.visible = isIt;
    }
  }

  // ---------- your controls ----------
  function humanInput(dt) {
    const pad = TG.Pad.get(0);
    if (I.down('KeyZ')) view.yaw += 2.6 * dt;
    if (I.down('KeyX')) view.yaw -= 2.6 * dt;
    if (pad) {
      view.yaw -= pad.rx * 3 * dt;
      view.pitch = Math.max(-0.2, Math.min(1.2, view.pitch + pad.ry * 2 * dt));
    }
    if (st.phase === 'roundEnd') return {};
    const fx = -Math.sin(view.yaw), fz = -Math.cos(view.yaw);
    const rx = Math.cos(view.yaw), rz = -Math.sin(view.yaw);
    let ix = (I.down('KeyD') ? 1 : 0) - (I.down('KeyA') ? 1 : 0);
    let iz = (I.down('KeyW') ? 1 : 0) - (I.down('KeyS') ? 1 : 0);
    if (pad && (pad.lx || pad.ly)) { ix = pad.lx; iz = -pad.ly; }
    return {
      mx: rx * ix + fx * iz, mz: rz * ix + fz * iz,
      run: I.down('ShiftLeft') || TG.Pad.down(0, 7),
      crawl: I.down('KeyC') || TG.Pad.down(0, 6),
      jump: I.pressed('Space') || TG.Pad.pressed(0, 0),
      dash: I.pressed('KeyF') || TG.Pad.pressed(0, 1),
      back: I.pressed('KeyQ') || TG.Pad.pressed(0, 3),
    };
  }

  // ---------- bots ----------
  function setDir(ai, x, z) {
    const l = Math.hypot(x, z);
    if (l < 1e-3) { ai.dirX = 0; ai.dirZ = 0; return; }
    ai.dirX = x / l; ai.dirZ = z / l;
  }

  function nearestTarget(p) {
    let best = null, bd = Infinity;
    for (const q of alivePlayers()) {
      if (!canTag(p, q)) continue;
      const d = Math.hypot(p.body.x - q.body.x, p.body.z - q.body.z) + Math.abs(p.body.y - q.body.y) * 1.5;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  function decide(p) {
    const b = p.body, ai = p.ai, sk = p.skill;
    ai.run = false;
    if (p === st.it) {
      const t = nearestTarget(p);
      if (!t) { wander(p); return; }
      const tb = t.body;
      const dist = Math.hypot(tb.x - b.x, tb.z - b.z);
      const lead = sk.lead * Math.min(1, dist / 8);
      setDir(ai, tb.x + tb.vx * lead - b.x, tb.z + tb.vz * lead - b.z);
      ai.run = dist < 9 || b.stamina > 2.2;
      if (dist < 5.5 && dist > 2 && Math.random() < sk.dash) ai.wantDash = true;
      if (tb.y > b.y + 0.8 && dist < 7 && b.grounded) ai.wantJump = true;
      return;
    }
    const it = st.it && st.it.alive ? st.it.body : null;
    const dist = it ? Math.hypot(b.x - it.x, b.z - it.z) : Infinity;
    if (it && dist < sk.fear) {
      let fx = (b.x - it.x) / (dist || 1), fz = (b.z - it.z) / (dist || 1);
      // don't run into corners: push away from the edges of the map
      const h = st.half, m = 7;
      if (b.x > h - m) fx -= ((b.x - (h - m)) / m) * 1.6;
      if (b.x < -h + m) fx += ((-h + m - b.x) / m) * 1.6;
      if (b.z > h - m) fz -= ((b.z - (h - m)) / m) * 1.6;
      if (b.z < -h + m) fz += ((-h + m - b.z) / m) * 1.6;
      // swerve a little so it's not a straight line
      ai.swerve = ai.swerve || (Math.random() < 0.5 ? -1 : 1);
      fx += -fz * 0.35 * ai.swerve; fz += fx * 0.35 * ai.swerve;
      setDir(ai, fx, fz);
      ai.run = true;
      if (dist < 3.4 && Math.random() < sk.dash * 1.4) {
        const facingIt = Math.sin(b.yaw) * (it.x - b.x) + Math.cos(b.yaw) * (it.z - b.z) > 0;
        if (facingIt && b.backCd <= 0) ai.wantBack = true;
        else if (Math.random() < 0.6 && b.dashCd <= 0) ai.wantDash = true;
        else ai.wantJump = true;
      }
      return;
    }
    wander(p);
  }

  function wander(p) {
    const b = p.body, ai = p.ai;
    if (!ai.goal || st.time > ai.wanderUntil || Math.hypot(ai.goal.x - b.x, ai.goal.z - b.z) < 1.5) {
      ai.goal = st.wanderPts[Math.floor(Math.random() * st.wanderPts.length)];
      ai.wanderUntil = st.time + 3 + Math.random() * 4;
    }
    setDir(ai, ai.goal.x - b.x, ai.goal.z - b.z);
    if (ai.goal.y > b.y + 0.8 && Math.hypot(ai.goal.x - b.x, ai.goal.z - b.z) < 5 && b.grounded) ai.wantJump = true;
  }

  function groundAhead(x, y, z) {
    for (const c of st.colliders) {
      if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && c.maxY <= y + 0.6 && c.maxY >= y - 8) return true;
    }
    return false;
  }

  // Look a little ahead: is there a wall, a low gap or a cliff?
  function probe(b, dx, dz) {
    const px = b.x + dx * 1.0, pz = b.z + dz * 1.0, r = 0.4;
    let top = -Infinity, low = false;
    for (const c of st.colliders) {
      if (c.floor) continue;
      if (!(px + r > c.minX && px - r < c.maxX && pz + r > c.minZ && pz - r < c.maxZ)) continue;
      if (c.maxY <= b.y + P.C.stepUp || c.minY >= b.y + P.C.standH) continue;
      if (c.minY > b.y + 0.9) low = true;
      else top = Math.max(top, c.maxY);
    }
    if (top > -Infinity) return top - b.y < 3.4 ? 'jump' : 'wall';
    if (low) return 'crawl';
    if (!groundAhead(b.x + dx * 1.6, b.y, b.z + dz * 1.6)) return 'edge';
    return 'ok';
  }

  // Is there a platform across the gap that we could jump to?
  function findLanding(b, dx, dz) {
    for (let d = 2; d <= 7.5; d += 0.5) {
      const x = b.x + dx * d, z = b.z + dz * d;
      let top = -Infinity;
      for (const c of st.colliders) {
        if (c.kind === 'pad' && c.maxY > b.y + 6) continue;
        if (x > c.minX + 0.3 && x < c.maxX - 0.3 && z > c.minZ + 0.3 && z < c.maxZ - 0.3 && c.maxY <= b.y + 2.6 && c.maxY >= b.y - 4) top = Math.max(top, c.maxY);
      }
      if (top > -Infinity) return { x, y: top, z, d };
    }
    return null;
  }

  function freeDir(b, dx, dz) {
    const r = probe(b, dx, dz);
    return r === 'ok' || r === 'crawl';
  }

  function botInput(p, dt) {
    const b = p.body, ai = p.ai, sk = p.skill;
    const inp = { mx: 0, mz: 0 };
    if (st.phase !== 'play' || b.frozen > 0) { ai.stuckT = 0; ai.sx = b.x; ai.sz = b.z; return inp; }
    ai.think -= dt;
    if (ai.think <= 0) { ai.think = sk.react * (0.7 + Math.random() * 0.6); decide(p); }
    let dx = ai.dirX, dz = ai.dirZ;
    if (ai.detourT > 0) { ai.detourT -= dt; dx = ai.detX; dz = ai.detZ; }

    // Burning Battle: runners steer around the fire, or jump over it if they can't
    if (st.burning && p !== st.it && (dx || dz) && fireAhead(b, dx, dz)) {
      const L = [-dz, dx], R = [dz, -dx];
      const lOk = !fireAhead(b, L[0], L[1]), rOk = !fireAhead(b, R[0], R[1]);
      if (lOk || rOk) {
        const d = lOk && (!rOk || Math.random() < 0.5) ? L : R;
        ai.detX = d[0]; ai.detZ = d[1]; ai.detourT = 0.4;
        dx = d[0]; dz = d[1];
      } else if (b.grounded) inp.jump = true;
    }

    if (dx || dz) {
      const r = probe(b, dx, dz);
      if (r === 'crawl') ai.crawlT = 0.7;
      else if (r === 'jump') {
        if (b.grounded) inp.jump = true;
        else if (b.jumps < 2 && b.vy < 2) inp.jump = true;
      } else if (r === 'edge' && b.grounded && (ai.leapCd || 0) <= 0 && (ai.leap = findLanding(b, dx, dz))) {
        inp.jump = true;
        ai.leapCd = 1.2;
      } else if (r === 'wall' || r === 'edge') {
        const L = [-dz, dx], R = [dz, -dx];
        const lOk = freeDir(b, L[0], L[1]), rOk = freeDir(b, R[0], R[1]);
        const pickL = lOk && (!rOk || Math.random() < 0.5);
        const d = pickL ? L : rOk ? R : [-dx, -dz];
        ai.detX = d[0]; ai.detZ = d[1]; ai.detourT = 0.6 + Math.random() * 0.4;
        dx = d[0]; dz = d[1];
      }
    }
    // flying over a gap: steer to the landing spot, double jump if we're dropping short
    ai.leapCd = Math.max(0, (ai.leapCd || 0) - dt);
    if (ai.leap) {
      if (b.grounded && !inp.jump) ai.leap = null;
      else {
        const lx = ai.leap.x - b.x, lz = ai.leap.z - b.z, l = Math.hypot(lx, lz) || 1;
        dx = lx / l; dz = lz / l;
        if (!b.grounded && b.vy < 0 && b.jumps < 2 && b.y < ai.leap.y + 0.6 && l > 1) inp.jump = true;
      }
    }
    if (ai.crawlT > 0) { ai.crawlT -= dt; inp.crawl = true; }
    inp.mx = dx; inp.mz = dz;
    inp.run = ai.run && !inp.crawl && !(ai.leap && ai.leap.d < 4.5);
    if (ai.wantJump) { inp.jump = true; ai.wantJump = false; }
    // only dash if there's ground to land on (no dashing off the edge!)
    if (ai.wantDash) {
      ai.wantDash = false;
      if (groundAhead(b.x + dx * 3.5, b.y, b.z + dz * 3.5) && groundAhead(b.x + dx * 2, b.y, b.z + dz * 2)) inp.dash = true;
    }
    if (ai.wantBack) {
      ai.wantBack = false;
      const bx = -Math.sin(b.yaw), bz = -Math.cos(b.yaw);
      if (groundAhead(b.x + bx * 3, b.y, b.z + bz * 3) && groundAhead(b.x + bx * 1.5, b.y, b.z + bz * 1.5)) inp.back = true;
    }

    // stuck? pick a random way and jump
    ai.stuckT += dt;
    if (ai.stuckT >= 0.8) {
      if (Math.hypot(b.x - ai.sx, b.z - ai.sz) < 0.5 && (dx || dz)) {
        const a = Math.random() * Math.PI * 2;
        ai.detX = Math.sin(a); ai.detZ = Math.cos(a); ai.detourT = 1;
        inp.jump = true;
      }
      ai.stuckT = 0; ai.sx = b.x; ai.sz = b.z;
    }

    return inp;
  }

  // ---------- camera ----------
  function updateCamera(dt) {
    let focus;
    const me = st.human && st.human.alive ? st.human : null;
    if (st.phase === 'over') {
      focus = st.winner;
      view.yaw += dt * 0.5;
      view.pitch += (0.25 - view.pitch) * Math.min(1, dt * 2);
    } else if (me) focus = me;
    else {
      focus = st.it && st.it.alive ? st.it : alivePlayers()[0];
      if (I.down('KeyZ')) view.yaw += 2.6 * dt;
      else if (I.down('KeyX')) view.yaw -= 2.6 * dt;
      else if (!view.drag) {
        const want = focus.body.yaw + Math.PI;
        let d = (want - view.yaw) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        view.yaw += d * Math.min(1, dt * 1.2);
      }
    }
    if (!focus) return;
    const b = focus.body;
    tmpV.set(b.x, b.y + (b.crawling ? 0.8 : 1.4), b.z);
    const cp = Math.cos(view.pitch);
    const d = [Math.sin(view.yaw) * cp, Math.sin(view.pitch), Math.cos(view.yaw) * cp];
    const want = st.phase === 'over' ? 6 : view.dist;
    const hit = P.rayBoxes(st.colliders, [tmpV.x, tmpV.y, tmpV.z], d, want);
    const dist = Math.max(0.6, Math.min(want, hit - 0.25));
    camera.position.set(tmpV.x + d[0] * dist, tmpV.y + d[1] * dist, tmpV.z + d[2] * dist);
    camera.lookAt(tmpV);
  }

  // ---------- particles ----------
  const partGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
  const partMats = new Map();
  const CONFETTI = ['#ff4b4b', '#ff9a2e', '#ffd93b', '#4fd16a', '#2fd0c0', '#3d8bff', '#9b5cff', '#ff7fc8'];
  function pmat(c) {
    let m = partMats.get(c);
    if (!m) { m = new THREE.MeshBasicMaterial({ color: c }); partMats.set(c, m); }
    return m;
  }
  function burst(x, y, z, colors, n, speed, grav) {
    colors = colors || CONFETTI;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(partGeo, pmat(colors[i % colors.length]));
      m.position.set(x, y, z);
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, q = Math.sqrt(1 - u * u);
      const v = speed * (0.4 + Math.random() * 0.6);
      st.parts.push({ m, vx: q * Math.cos(a) * v, vy: Math.abs(u) * v + speed * 0.3, vz: q * Math.sin(a) * v, life: 0.9 + Math.random() * 0.8, g: grav === undefined ? 14 : grav });
      st.scene.add(m);
    }
  }
  function updateParticles(dt) {
    for (let i = st.parts.length - 1; i >= 0; i--) {
      const q = st.parts[i];
      q.life -= dt;
      if (q.life <= 0) { st.scene.remove(q.m); st.parts.splice(i, 1); continue; }
      q.vy -= q.g * dt;
      q.m.position.x += q.vx * dt; q.m.position.y += q.vy * dt; q.m.position.z += q.vz * dt;
      q.m.rotation.x += dt * 6; q.m.rotation.y += dt * 4;
      const s = Math.min(1, q.life * 2);
      q.m.scale.set(s, s, s);
    }
  }

  // ---------- Burning Battle: fire ----------
  // Cone-shaped flames. translate() moves the cone so its bottom is at 0,
  // so when we stretch it taller it grows UP instead of in both directions.
  const flameGeo = new THREE.ConeGeometry(0.16, 0.6, 8);
  flameGeo.translate(0, 0.3, 0);
  const FIRE_COLORS = ['#ff3d00', '#ff8a00', '#ffd23f'];
  // AdditiveBlending makes overlapping flames add up and look bright, like real fire.
  const flameMats = FIRE_COLORS.map((c) => new THREE.MeshBasicMaterial({
    color: c, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const scorchGeo = new THREE.CircleGeometry(FIRE_R, 16);
  const scorchMat = new THREE.MeshBasicMaterial({ color: 0x1a0a00, transparent: true, opacity: 0.55, depthWrite: false });

  function addFlame(group, x, y, z, size) {
    const f = new THREE.Mesh(flameGeo, flameMats[Math.floor(Math.random() * flameMats.length)]);
    f.position.set(x, y, z);
    f.userData.size = size;               // how big this flame is
    f.userData.ph = Math.random() * 10;   // so every flame flickers at a different time
    group.add(f);
    return f;
  }

  // Make one flame flicker: wobble its height up and down over time.
  function flicker(f, amount) {
    const k = (0.75 + Math.sin(st.time * 18 + f.userData.ph) * 0.25) * f.userData.size * amount;
    f.scale.set(k, k * 1.3, k);
  }

  // The flames all over whoever is IT (just for looks: they don't tag anyone).
  function makeFlames() {
    const g = new THREE.Group();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const r = 0.4 + (i % 2) * 0.08;
      addFlame(g, Math.cos(a) * r, 0.2 + (i % 3) * 0.4, Math.sin(a) * r, 0.8 + Math.random() * 0.6);
    }
    addFlame(g, 0, 1.6, 0, 1.6); // a big one on top of the head
    const light = new THREE.PointLight(0xff6a00, 1.6, 7);
    light.position.y = 1;
    g.add(light);
    return g;
  }

  // One patch of fire on the ground, left behind by IT.
  function makeFirePatch(x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const scorch = new THREE.Mesh(scorchGeo, scorchMat);
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = 0.03;
    g.add(scorch);
    for (let i = 0; i < 3; i++) addFlame(g, (Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6, 0.7 + Math.random() * 0.5);
    st.scene.add(g);
    return { g, x, y, z, born: st.time };
  }

  // Put out the whole fire trail. puff = show a little smoke where it was.
  function clearTrail(puff) {
    if (!st) return;
    st.trail.forEach((s, i) => {
      if (st.scene) st.scene.remove(s.g);
      if (puff && i % 3 === 0) burst(s.x, s.y + 0.4, s.z, ['#555555', '#888888'], 2, 2, -2);
    });
    st.trail = [];
    st.lastDrop = null;
  }

  function updateFire(dt) {
    const it = st.it && st.it.alive ? st.it : null;
    st.fireMark.visible = !!it;
    if (it) {
      const b = it.body;
      // the flames follow IT around (squashed down when crawling)
      st.fireMark.position.set(b.x, b.y, b.z);
      st.fireMark.scale.set(1, b.crawling ? 0.55 : 1, 1);
      for (const f of st.fireMark.children) if (f.userData.size) flicker(f, 1);
      // little sparks floating up (negative gravity makes them rise)
      st.emberT -= dt;
      if (st.emberT <= 0) {
        st.emberT = 0.05;
        burst(b.x + (Math.random() - 0.5) * 0.8, b.y + 1, b.z + (Math.random() - 0.5) * 0.8, FIRE_COLORS, 1, 1.5, -3);
      }
      // drop a fire patch every time IT has moved FIRE_GAP away from the last one
      if (st.phase === 'play' && b.grounded && b.frozen <= 0) {
        const L = st.lastDrop;
        if (!L || Math.hypot(b.x - L.x, b.z - L.z) >= FIRE_GAP || Math.abs(b.y - L.y) > 0.5) {
          st.trail.push(makeFirePatch(b.x, b.y, b.z));
          st.lastDrop = { x: b.x, y: b.y, z: b.z };
        }
      }
    }
    // make the trail flicker, and let old patches burn out
    for (let i = st.trail.length - 1; i >= 0; i--) {
      const s = st.trail[i];
      const age = st.time - s.born;
      if (age > FIRE_LIFE) { st.scene.remove(s.g); st.trail.splice(i, 1); continue; }
      const grow = Math.min(1, age * 4);                  // new flames pop up
      const fade = Math.min(1, (FIRE_LIFE - age) / 1);    // dying flames shrink in their last second
      for (const f of s.g.children) if (f.userData.size) flicker(f, grow * fade);
    }
  }

  // Is this player standing in the fire?
  function touchingFire(q) {
    const b = q.body, reach = FIRE_R + P.C.radius;
    for (const s of st.trail) {
      if (Math.hypot(b.x - s.x, b.z - s.z) <= reach && b.y >= s.y - 0.5 && b.y <= s.y + 1.2) return true;
    }
    return false;
  }

  // For bots: is there fire a little way ahead in this direction?
  function fireAhead(b, dx, dz) {
    for (const d of [0.9, 1.8]) {
      const x = b.x + dx * d, z = b.z + dz * d;
      for (const s of st.trail) {
        if (Math.hypot(x - s.x, z - s.z) < FIRE_R + 0.6 && Math.abs(b.y - s.y) < 1.5) return true;
      }
    }
    return false;
  }

  // ---------- HUD ----------
  let bannerT = 0, subT = 0;
  function banner(text, cls, dur) {
    const el = $('banner');
    el.textContent = text;
    el.className = 'show ' + (cls || '');
    bannerT = dur;
  }
  function sub(text, dur) {
    const el = $('subbanner');
    el.textContent = text;
    el.classList.toggle('show', !!text);
    subT = dur;
  }
  function refreshList() {
    $('hud-players').innerHTML = st.players.map((p) =>
      `<li class="${p.alive ? '' : 'out'} ${p === st.it ? 'it' : ''}" style="--c:${p.color}"><span class="dot"></span>${esc(p.name)}${p.human ? ' <em>you</em>' : ''}${p === st.it ? ' <b>IT</b>' : ''}</li>`).join('');
  }
  function updateHud(dt) {
    if (bannerT > 0 && (bannerT -= dt) <= 0) $('banner').className = '';
    if (subT > 0 && (subT -= dt) <= 0) $('subbanner').classList.remove('show');
    const t = Math.max(0, Math.ceil(st.timeLeft));
    $('hud-time').textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
    $('hud-time').classList.toggle('low', st.phase === 'play' && t <= 5);
    $('hud-round').textContent = `Round ${st.round}/${st.totalRounds}`;
    const me = st.human && st.human.alive ? st.human : null;
    $('game-ui').classList.toggle('you-it', !!me && me === st.it);
    $('hud-me').hidden = !me;
    if (me) {
      $('game-stamina').style.width = (me.body.stamina / P.C.stamina) * 100 + '%';
      $('game-stamina').classList.toggle('tired', me.body.exhausted);
      $('hud-role').textContent = me === st.it ? (me.body.frozen > 0 ? 'IT (wait...)' : 'You are IT! Touch someone!') : me.body.frozen > 0 && st.phase === 'play' ? 'Frozen!' : 'Runner';
    }
    $('hud-spectate').hidden = !(st.human && !st.human.alive && st.phase !== 'over');
  }

  TG.Game = { init, start, stop, update, render, resize, isActive: () => !!st, allMaps, debug: () => st };
})();
