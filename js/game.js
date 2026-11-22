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
  // Treasure Time: how close a runner must get to grab the treasure, and how many players are ITs.
  const TREASURE_R = 1.3;
  const itsFor = (n) => Math.max(1, Math.floor(n / 2)); // half are ITs: 2-3 players: 1 IT, 4-5: 2, 6-7: 3, 8: 4
  const treasureRounds = (n) => Math.max(2, n - 1);     // how many rounds a Treasure Time match has
  // Parasite: maps the parasite can't pick, and how long a friend online gets to pick before it's random
  const PARASITE_SKIP = ['official-space-stares'], PICK_TIME = 20;

  let renderer, canvas, camera;
  let st = null;
  const $ = (id) => document.getElementById(id);
  const view = { yaw: Math.PI, pitch: 0.35, dist: 7, drag: false };
  const tmpV = new THREE.Vector3();

  function init(r, cvs) {
    renderer = r; canvas = cvs;
    camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1500);
    // always running: no stamina bars, and no "Shift run" in the help
    if (P.C.alwaysRun) for (const el of document.querySelectorAll('.stamina, .run-key')) el.style.display = 'none';
    // Click the game to "lock" the mouse: the cursor hides and moving the mouse turns the camera.
    canvas.addEventListener('pointerdown', (e) => {
      if (!st) return;
      if (!isLocked()) lockMouse();
      view.drag = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    });
    canvas.addEventListener('pointerup', () => { view.drag = false; });
    canvas.addEventListener('pointercancel', () => { view.drag = false; });
    canvas.addEventListener('pointermove', (e) => {
      const locked = isLocked();
      // locked: any mouse move turns the camera. Not locked: only while dragging (the old way).
      if (!st || st.paused || !(locked || view.drag)) return;
      const k = locked ? 0.0035 : 0.006;
      view.yaw -= (e.movementX || 0) * k;
      view.pitch = Math.max(-0.2, Math.min(1.2, view.pitch + (e.movementY || 0) * k * 0.7));
    });
    // Esc gives the mouse back (the browser does that). When that happens mid-game, pause.
    document.addEventListener('pointerlockchange', () => {
      if (!isLocked() && st && !st.paused && st.phase !== 'over' && st.phase !== 'picking') setPaused(true);
    });
    $('btn-resume').addEventListener('click', () => setPaused(false));
    $('btn-quit').addEventListener('click', () => { stop(); TG.Main.showMenu(); });
    $('btn-again').addEventListener('click', () => {
      const s = st.setup, online = st.online;
      stop();
      if (online) TG.Main.showLobby(); else start(s);
    });
    $('btn-results-menu').addEventListener('click', () => { stop(); TG.Main.showMenu(); });
    $('picker-maps').addEventListener('click', (e) => {
      const id = e.target.closest('button') && e.target.closest('button').dataset.map;
      if (id) pickedMap(id);
    });
  }
  function resize(a) { camera.aspect = a; camera.updateProjectionMatrix(); }

  const isLocked = () => document.pointerLockElement === canvas;
  function lockMouse() {
    // the browser only allows this right after a click or key press, so it can fail: that's fine
    try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ok */ }
  }
  function unlockMouse() {
    if (isLocked()) try { document.exitPointerLock(); } catch (_) { /* ok */ }
  }

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
      const tagIt = TG.makeNameTag((setup.gameMode === 'werewolf' ? 'WEREWOLF · ' : setup.gameMode === 'parasite' ? 'PARASITE · ' : 'IT · ') + s.name, s.color, true);
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
      treasure: setup.gameMode === 'treasure', its: [], treasurePos: null, chest: null,
      werewolf: setup.gameMode === 'werewolf', wolfKey: null,
      parasite: setup.gameMode === 'parasite', picking: null,
    };
    if (st.treasure) st.totalRounds = treasureRounds(players.length);
    if (st.parasite) { // everyone starts with the parasite once, in a random order
      st.totalRounds = players.length;
      st.order = shuffle(players.map((p) => p.key));
    }
    for (const p of players) p.score = 0; // Treasure Time points, Parasite tags
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
    $('picker').hidden = true;
    $('btn-again').textContent = net ? 'Back to the room' : 'Play again';
    $('btn-quit').textContent = net ? 'Leave the room' : 'Quit to menu';
    I.clear();
    lockMouse(); // works when the game was started by clicking GO!
    if (st.host) hostStartRound();
  }

  function stop() {
    if (!st) return;
    unlockMouse();
    if (st.net) st.net.closeGame();
    clearScene();
    for (const p of st.players) p.ch.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map) o.material.map.dispose(); });
    st = null;
    $('game-ui').hidden = true;
    $('results').hidden = true;
    $('pause').hidden = true;
    $('picker').hidden = true;
  }

  function clearScene() {
    if (!st || !st.scene) return;
    for (const p of st.players) st.scene.remove(p.ch.root);
    if (st.mapGroup) MF.disposeGroup(st.mapGroup);
    for (const q of st.parts) st.scene.remove(q.m);
    st.parts = [];
    clearTrail(false);
    for (const p of st.players) if (p.ring) { p.ch.root.remove(p.ring); p.ring = null; }
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
    if (st.treasure) { hostStartTreasure(r, map); return; }
    if (st.parasite) { hostParasitePick(r); return; }
    const n = spawnsFor(map).length;
    const alive = alivePlayers();
    const order = shuffle([...Array(n).keys()]);
    const spots = {};
    alive.forEach((p, i) => { spots[p.key] = [order[i % n], i >= n ? 1 : 0]; });
    let it = alive[Math.floor(Math.random() * alive.length)];
    if (st.werewolf) { // Werewolf: the same werewolf for the whole game
      const w = st.byKey.get(st.wolfKey || st.setup.wolf); // round 1: the werewolf picked in setup (if any)
      if (w && w.alive) it = w;
    }
    setPending();
    send({ t: 'round', r, map: map.id, it: it.key, spots });
  }
  // fire = true when they got tagged by stepping in the fire trail
  // Treasure Time: pick the teams, where the treasure goes, and where everyone starts.
  function hostStartTreasure(r, map) {
    const sp = spawnsFor(map);
    const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    // the treasure goes on one of the lowest spawn points, so it's easy to reach
    const lowY = Math.min(...sp.map((s) => s.y));
    const low = sp.map((s, i) => i).filter((i) => sp[i].y <= lowY + 2.5);
    const ti = low[Math.floor(Math.random() * low.length)];
    const T = sp[ti];
    // the other spawn points, from closest to the treasure to farthest
    const near = sp.map((s, i) => i).filter((i) => i !== ti).sort((a, b) => dist(sp[a], T) - dist(sp[b], T));
    if (!near.length) near.push(ti);
    const far = near.slice().reverse();
    // New teams every round. The players who've been IT the fewest times go first, so everyone gets turns.
    st.itTurns = st.itTurns || {};
    const all = shuffle(alivePlayers().slice()).sort((a, b) => (st.itTurns[a.key] || 0) - (st.itTurns[b.key] || 0));
    const its = all.slice(0, itsFor(all.length)), runners = all.slice(its.length);
    for (const p of its) st.itTurns[p.key] = (st.itTurns[p.key] || 0) + 1;
    const spots = {};
    its.forEach((p, i) => { spots[p.key] = [ti, i % 2]; });   // ITs start right at the treasure
    runners.forEach((p, i) => { spots[p.key] = [far[i % far.length], i >= far.length ? 1 : 0]; }); // runners start far away
    setPending();
    send({ t: 'round', r, map: map.id, it: its[0].key, its: its.map((p) => p.key), treasure: ti, spots });
  }

  // ---------- Parasite: whoever starts with the parasite picks the level ----------
  function parasiteMaps() {
    const { official, custom } = allMaps();
    // your saved maps too, but not ones with the same name as an official map (no doubles!)
    const nm = (m) => String(m.name || '').trim().toLowerCase();
    const taken = new Set(official.map(nm));
    const mine = st.online ? [] : custom.filter((m) => !taken.has(nm(m)) && (taken.add(nm(m)), true));
    const list = official.filter((m) => !PARASITE_SKIP.includes(m.id)).concat(mine);
    return list.length ? list : [MF.newMap('day')];
  }
  function hostParasitePick(r) {
    const who = st.byKey.get(st.order[(r - 1) % st.order.length]) || alivePlayers()[0];
    if (who.kind === 'bot') { // bots just pick a random level
      const maps = parasiteMaps();
      hostParasiteRound(r, who, maps[Math.floor(Math.random() * maps.length)]);
      return;
    }
    st.picking = { r, who: who.key, until: who.kind === 'remote' ? st.time + PICK_TIME : Infinity };
    send({ t: 'pick', r, who: who.key });
  }
  function hostParasiteRound(r, who, map) {
    st.picking = null;
    for (const p of st.players) p.alive = true; // everyone comes back
    const n = spawnsFor(map).length;
    const order = shuffle([...Array(n).keys()]);
    const spots = {};
    alivePlayers().forEach((p, i) => { spots[p.key] = [order[i % n], i >= n ? 1 : 0]; });
    setPending();
    send({ t: 'round', r, map: map.id, it: who.key, spots });
  }
  // Everyone: someone is picking the level. If it's you, show the buttons.
  function showPick(ev) {
    const who = st.byKey.get(ev.who);
    if (!who) return;
    st.phase = 'picking';
    st.pickR = ev.r;
    st.timeLeft = st.setup.roundLen;
    if (who.kind === 'me') {
      $('picker-maps').innerHTML = parasiteMaps().map((m) => `<button class="big" data-map="${esc(m.id)}">${esc(m.name)}</button>`).join('');
      $('picker').hidden = false;
      unlockMouse();
      banner('🦠 You have the parasite!', '', 2.5);
      sub('Pick the level!', 99);
    } else {
      banner(`🦠 Round ${ev.r} of ${st.totalRounds}`, '', 2.5);
      sub(`${who.name} has the parasite and is picking the level...`, 99);
    }
  }
  // You clicked a level
  function pickedMap(id) {
    if (!st || st.phase !== 'picking' || !st.human) return;
    $('picker').hidden = true;
    sub('', 0);
    lockMouse();
    TG.Sound.play('click');
    if (st.host) {
      const m = parasiteMaps().find((x) => x.id === id);
      if (st.picking && m) hostParasiteRound(st.picking.r, st.human, m);
    } else st.net.claim({ pick: true, r: st.pickR, who: st.human.key, map: id });
  }

  function hostTag(by, who, fire) {
    setPending();
    send({ t: 'tag', r: st.round, by: by.key, who: who.key, fire: !!fire });
  }

  function applyEvent(ev) {
    if (!ev || typeof ev.t !== 'string') return;
    switch (ev.t) {
      case '_claim': {
        const c = ev.c || {};
        if (c.pick) { // Parasite: a friend picked the level
          if (!st.host || !st.picking || c.r !== st.picking.r || c.who !== st.picking.who) return;
          const m = parasiteMaps().find((x) => x.id === c.map);
          if (m) hostParasiteRound(st.picking.r, st.byKey.get(c.who), m);
          return;
        }
        if (c.treasure) { // Treasure Time: another computer says "I sent a runner home" or "I grabbed the treasure"
          if (!st.host || !st.treasure || st.pending || st.phase !== 'play' || c.r !== st.round) return;
          const by = st.byKey.get(c.by), who = st.byKey.get(c.who);
          if (c.t === 'home' && by && who && isIt(by) && !isIt(who)) { setPending(); send({ t: 'home', r: st.round, by: by.key, who: who.key }); }
          if (c.t === 'tend' && who && !isIt(who)) { setPending(); send({ t: 'tend', r: st.round, team: 'runners', who: who.key }); }
          return;
        }
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
        if (st.werewolf) wolfTag(by, who);
        else if (st.parasite) parasiteTag(by, who);
        else applyTag(by, who, !!ev.fire);
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
      case 'home': { // Treasure Time: an IT touched a runner
        const by = st.byKey.get(ev.by), who = st.byKey.get(ev.who);
        if (!st.treasure || ev.r !== st.round || !by || !who || st.phase !== 'play') return;
        st.pending = false;
        sendHome(by, who);
        return;
      }
      case 'tend': { // Treasure Time is over: team 'runners' (grabbed it) or 'its' (time ran out)
        if (!st.treasure || ev.r !== st.round || st.phase !== 'play') return;
        st.pending = false;
        endTreasureRound(ev.team === 'runners' ? 'runners' : 'its', st.byKey.get(ev.who) || null);
        return;
      }
      case 'pick': { // Parasite: someone is picking the level
        if (!st.parasite || ev.r !== st.round + 1 || st.phase === 'over') return;
        showPick(ev);
        return;
      }
      case 'pend': { // Parasite: time ran out
        if (!st.parasite || ev.r !== st.round || st.phase !== 'play') return;
        st.pending = false;
        st.phase = 'roundEnd';
        st.t = 3.2;
        TG.Sound.play('go');
        banner(ev.all ? '🦠 Got everyone!' : "Time's up!", '', 2.6);
        sub(st.round < st.totalRounds ? 'Next round, everyone is back and someone new gets the parasite!' : 'That was the last round!', 3);
        return;
      }
      case 'pover': { // Parasite: all the rounds are done
        if (!st.parasite || st.phase === 'over') return;
        st.pending = false;
        finishScoreGame('🦠 Most tags', 'tag');
        return;
      }
      case 'wend': { // Werewolf: time ran out
        if (!st.werewolf || ev.r !== st.round || st.phase !== 'play') return;
        st.pending = false;
        endWolfRound();
        return;
      }
      case 'tover': { // Treasure Time: all the rounds are done
        if (!st.treasure || st.phase === 'over') return;
        st.pending = false;
        finishScoreGame('💰 Final points', 'point');
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
    if (st.parasite) for (const p of st.players) p.alive = true; // Parasite: everyone comes back each round
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
      p.home = { x: sp.x + off, y: sp.y, z: sp.z + off }; // where you go back to when you're sent home
      p.body.yaw = Math.atan2(-sp.x, -sp.z);
      p.body.frozen = 999;
      p.ai = newAi(p.body);
      p.buf = [];
      scene.add(p.ch.root);
      p.ch.update(p.body, 0);
    });
    const it = st.byKey.get(ev.it);
    st.it = it && it.alive ? it : alive[0];
    st.picking = null;
    $('picker').hidden = true;
    if (st.parasite) { st.itRing.material.color.set(0x4fd16a); glow.color.set(0x4fd16a); }
    if (st.werewolf) {
      st.wolfKey = st.it.key;
      if (!st.it.wolfLook) { st.it.wolfLook = true; addWolfLook(st.it.ch); }
      st.itRing.material.color.set(0x9b5cff);
      glow.color.set(0x9b5cff);
      makeNight(scene);
    }
    st.its = [];
    st.chest = null;
    if (st.treasure) {
      // a whole team of ITs instead of just one
      st.its = (Array.isArray(ev.its) ? ev.its : []).map((k) => st.byKey.get(k)).filter((p) => p && p.alive);
      if (!st.its.length) st.its = [st.it];
      st.it = null;
      for (const p of st.its) { p.ring = makeItRing(); p.ch.root.add(p.ring); }
      const T = st.spawns[(Number(ev.treasure) || 0) % st.spawns.length];
      st.treasurePos = { x: T.x, y: T.y, z: T.z };
      st.chest = makeTreasure();
      st.chest.position.set(T.x, T.y, T.z);
      scene.add(st.chest);
    }
    st.noBack = null;
    st.phase = 'countdown';
    st.t = 3;
    st.lastCount = 4;
    st.timeLeft = st.setup.roundLen;
    st.lastTick = 99;
    const me = st.human && st.human.alive ? st.human : null;
    view.yaw = (me || st.it || st.its[0]).body.yaw + Math.PI;
    view.pitch = 0.35;
    updateTags();
    $('hud-map').textContent = (st.burning ? '🔥 ' : st.werewolf ? '🐺 ' : st.parasite ? '🦠 ' : '') + map.name;
    if (st.treasure) {
      banner(`💰 Round ${st.round} of ${st.totalRounds}`, '', 1.8);
      if (!st.human) sub('Runners: grab the treasure! ITs: guard it!', 4);
      else if (isIt(st.human)) sub("You're on the IT team. Guard the treasure! Touch runners to send them home.", 4);
      else sub("You're a runner. Follow the light and grab the treasure before time runs out!", 4);
    } else if (st.werewolf) banner(`🐺 Round ${st.round}`, '', 1.6);
    else if (st.parasite) banner(`🦠 Round ${st.round} of ${st.totalRounds}`, '', 1.6);
    else banner(`Round ${st.round} of ${st.totalRounds}`, '', 1.6);
    if (st.treasure) { /* messages above */ } else if (st.parasite) sub(st.it === st.human ? 'You have the PARASITE! Every tag = 1 point!' : `${st.it.name} has the parasite. Don't let them touch you!`, 3.5);
    else if (st.werewolf) sub(st.it === st.human ? "You're the WEREWOLF! Tag everyone to win!" : `${st.it.name} is the WEREWOLF! Don't get tagged or you're out!`, 3.5); else if (st.burning) sub(st.it === st.human ? "You're IT and ON FIRE! Your fire trail tags people too!" : `${st.it.name} is IT and ON FIRE! Don't touch the fire!`, 3);
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
    // Parasite: a friend took too long to pick the level (or left), so pick a random one
    if (st.host && st.picking) {
      const w = st.byKey.get(st.picking.who);
      if (!w || w.kind === 'bot' || st.time > st.picking.until) {
        const maps = parasiteMaps();
        hostParasiteRound(st.picking.r, w || alivePlayers()[0], maps[Math.floor(Math.random() * maps.length)]);
      }
    }
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
        if (st.host && !st.pending) {
          setPending();
          // Treasure Time: time ran out, so the ITs kept the treasure safe
          send(st.treasure ? { t: 'tend', r: st.round, team: 'its' } : st.werewolf ? { t: 'wend', r: st.round } : st.parasite ? { t: 'pend', r: st.round } : { t: 'out', r: st.round, who: st.it.key });
        }
      }
    } else if (st.phase === 'roundEnd') {
      st.t -= dt;
      if (st.t <= 0 && st.host && !st.pending) {
        const alive = alivePlayers();
        if (st.treasure) {
          if (st.round >= st.totalRounds) { setPending(); send({ t: 'tover' }); }
          else hostStartRound();
        } else if (st.parasite) {
          if (st.round >= st.totalRounds) { setPending(); send({ t: 'pover' }); }
          else if (!st.picking) hostStartRound();
        } else if (st.werewolf) {
          // 2 or more runners left: another round. 1 left: they win. None left: the werewolf wins.
          const runners = alive.filter((p) => p.key !== st.wolfKey);
          if (runners.length >= 2) hostStartRound();
          else { setPending(); send({ t: 'win', who: (runners[0] || st.byKey.get(st.wolfKey) || alive[0]).key }); }
        } else if (alive.length <= 1) { setPending(); send({ t: 'win', who: alive[0].key }); }
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
        const mul = (isIt(p) ? IT_BOOST : 1) * (p.human ? 1 : p.skill.speed);
        P.step(p.body, inp, { colliders: st.colliders, gravity: st.gravity, speedMul: mul }, dt);
        for (const e of p.body.events) {
          if (e === 'fell') {
            const sp = st.treasure && p.home ? p.home : st.spawns[Math.floor(Math.random() * st.spawns.length)];
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

    // Parasite: the parasite got everyone, so the round is over
    if (st.parasite && st.host && st.phase === 'play' && !st.pending && st.it && alivePlayers().length === 1) {
      setPending();
      send({ t: 'pend', r: st.round, all: true });
    }
    // Werewolf: everyone got tagged, so the werewolf wins
    if (st.werewolf && st.host && st.phase === 'play' && !st.pending && st.it && alivePlayers().length === 1) {
      setPending();
      send({ t: 'win', who: st.it.key });
    }

    // IT tags by touching someone (no button). The host checks bots; your computer checks you.
    st.claimT -= dt;
    if (st.treasure) treasureChecks();
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
    if (st.chest) { // the gem spins and bobs above the chest
      const gem = st.chest.userData.gem;
      gem.rotation.y += dt * 2;
      gem.position.y = 1.4 + Math.sin(st.time * 3) * 0.12;
    }
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
    if (v) unlockMouse(); else lockMouse(); // paused: give the cursor back so you can click the buttons
    if (v) $('hud-lock').hidden = true;
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
    $('results').querySelector('h2').textContent = 'Final ranking';
    const rank = [w].concat(st.elim.slice().reverse());
    for (const p of st.players) if (!rank.includes(p)) rank.push(p); // Werewolf: a werewolf who lost goes last
    $('results-list').innerHTML = rank.map((p, i) =>
      `<li style="--c:${p.color}"><b>${i + 1}</b><span class="dot"></span>${esc(p.name)}${p.human ? ' <em>(you)</em>' : ''}${i === 0 ? ' 🏆' : ''}</li>`).join('');
    setTimeout(() => { if (st && st.phase === 'over') { unlockMouse(); $('results').hidden = false; } }, 2200);
  }

  // ---------- Parasite ----------
  // The parasite touched someone: +1 point, and they're out until next round. The parasite stays the same.
  function parasiteTag(by, who) {
    by.score++;
    who.alive = false;
    st.scene.remove(who.ch.root);
    burst(who.body.x, who.body.y + 0.9, who.body.z, ['#4fd16a', '#a6ff4d', '#1f7a35', who.color], 40, 7);
    TG.Sound.play('tag');
    const left = alivePlayers().length - 1;
    if (who.human) { banner('🦠 The parasite got you!', 'out', 2.2); sub("You're out until next round.", 3); }
    else if (by.human) sub(`You got ${who.name}! +1 point. ${left} left.`, 2.2);
    else sub(`${by.name} got ${who.name}! ${left} left.`, 2);
    refreshList();
  }

  // ---------- Werewolf ----------
  // The werewolf touched someone: they're OUT right away.
  function wolfTag(wolf, who) {
    who.alive = false;
    st.elim.push(who);
    st.scene.remove(who.ch.root);
    burst(who.body.x, who.body.y + 0.9, who.body.z, [who.color, '#9b5cff', '#ffffff'], 50, 8);
    TG.Sound.play('elim');
    const left = alivePlayers().length - 1;
    if (who.human) { banner('The werewolf got you!', 'out', 2.4); sub("You're OUT. Watch the rest!", 3); }
    else if (wolf.human) sub(`You got ${who.name}! ${left} left.`, 2.2);
    else sub(`The werewolf got ${who.name}! ${left} left.`, 2.2);
    refreshList();
  }

  // Werewolf: time ran out. 2 or more runners left = another round, 1 left = they win.
  function endWolfRound() {
    const runners = alivePlayers().filter((p) => p !== st.it);
    st.phase = 'roundEnd';
    st.t = 3.2;
    TG.Sound.play('go');
    if (runners.length >= 2) {
      banner("Time's up!", '', 2.6);
      sub(`${runners.length} runners are still in. Another round!`, 3);
    } else {
      banner("Time's up!", '', 2.6);
      sub(runners.length ? `${runners[0].name} escaped the werewolf!` : '', 3);
    }
  }

  // Wolf ears, a snout and a tail. They stay on the whole game.
  function addWolfLook(ch) {
    const fur = new THREE.MeshStandardMaterial({ color: '#6b6b78', roughness: 0.8 });
    const pink = new THREE.MeshStandardMaterial({ color: '#ff9bb3', roughness: 0.6 });
    const black = new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.3 });
    const eye = new THREE.MeshBasicMaterial({ color: '#ffe14d' });
    const mesh = (geo, m, x, y, z, parent) => {
      const o = new THREE.Mesh(geo, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      parent.add(o);
      return o;
    };
    for (const s of [-1, 1]) {
      const ear = mesh(new THREE.ConeGeometry(0.11, 0.3, 4), fur, s * 0.2, 0.3, 0, ch.head);
      ear.rotation.z = -s * 0.35;
      const inner = mesh(new THREE.ConeGeometry(0.06, 0.18, 4), pink, s * 0.2, 0.29, 0.04, ch.head);
      inner.rotation.z = -s * 0.35;
      mesh(new THREE.SphereGeometry(0.05, 8, 6), eye, s * 0.12, 0.05, 0.365, ch.head); // glowing yellow eyes
    }
    const snout = mesh(new THREE.BoxGeometry(0.22, 0.15, 0.2), fur, 0, -0.08, 0.36, ch.head);
    mesh(new THREE.SphereGeometry(0.05, 8, 6), black, 0, 0, 0.11, snout);
    const tail = mesh(new THREE.ConeGeometry(0.1, 0.55, 8), fur, 0, 0.55, -0.48, ch.rig);
    tail.rotation.x = -2.1;
  }

  // Werewolf: it's night time, with a big full moon.
  function makeNight(scene) {
    const night = new THREE.Color(scene.background).multiplyScalar(0.3).lerp(new THREE.Color('#1a1440'), 0.5);
    scene.background = night;
    if (scene.fog) scene.fog.color = night;
    const moon = new THREE.Mesh(new THREE.SphereGeometry(18, 24, 16), new THREE.MeshBasicMaterial({ color: '#fff6d0', fog: false }));
    moon.position.set(-160, 140, -260);
    scene.add(moon);
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- Treasure Time ----------
  // Each frame: did an IT touch a runner? Did a runner reach the treasure?
  // Like tagging: the host checks the bots, and your computer checks you.
  function treasureChecks() {
    if (st.phase !== 'play' || st.pending) return;
    for (const it of st.its) {
      if (it.kind === 'remote' || it.body.frozen > 0) continue;
      for (const q of alivePlayers()) {
        if (isIt(q) || q.body.frozen > 0 || !inReach(it.body, q.body)) continue;
        hostOrClaim({ t: 'home', r: st.round, by: it.key, who: q.key });
        return;
      }
    }
    const T = st.treasurePos;
    for (const q of alivePlayers()) {
      if (q.kind === 'remote' || isIt(q)) continue;
      const b = q.body;
      if (Math.hypot(b.x - T.x, b.z - T.z) <= TREASURE_R && Math.abs(b.y - T.y) <= 1.6) {
        hostOrClaim({ t: 'tend', r: st.round, team: 'runners', who: q.key });
        return;
      }
    }
  }
  // The host sends the event to everyone. Other computers ask the host first.
  function hostOrClaim(ev) {
    if (st.host) { setPending(); send(ev); }
    else if (st.claimT <= 0) { st.claimT = 0.5; st.net.claim(Object.assign({ treasure: true }, ev)); }
  }

  // An IT touched a runner: the runner zaps back to their spawn point.
  function sendHome(by, who) {
    burst(who.body.x, who.body.y + 1, who.body.z, ['#ffd23f', '#ffffff', who.color], 24, 6);
    TG.Sound.play('tag');
    if (who.kind !== 'remote') { // the computer that moves this player puts them back home
      const h = who.home;
      P.respawn(who.body, h.x, h.y + 0.05, h.z, 1);
      who.rs++;
      who.ai = newAi(who.body);
    }
    if (who.human) { banner('Tagged!', 'it', 1.2); sub(`${by.name} sent you back to your spawn!`, 2); }
    else if (by.human) sub(`You sent ${who.name} home!`, 2);
    else sub(`${by.name} sent ${who.name} home!`, 1.6);
  }

  // A Treasure Time round is over: everyone on the winning team gets a point.
  function endTreasureRound(team, who) {
    const winners = st.players.filter((p) => isIt(p) === (team === 'its'));
    for (const p of winners) p.score++;
    const meWon = !!st.human && winners.includes(st.human);
    TG.Sound.play(meWon || !st.human ? 'win' : 'elim');
    if (team === 'runners') {
      const T = st.treasurePos;
      burst(T.x, T.y + 1, T.z, ['#ffd23f', '#fff3a0', '#ffffff'], 70, 10);
      banner(meWon ? 'YOUR TEAM WINS!' : 'THE RUNNERS WIN!', 'win', 2.8);
      sub(`${who ? who.name : 'A runner'} grabbed the treasure! +1 point for each runner.`, 3.2);
    } else {
      banner(meWon ? 'YOUR TEAM WINS!' : 'THE ITs WIN!', 'win', 2.8);
      sub('Time ran out. The treasure is safe! +1 point for each IT.', 3.2);
    }
    st.phase = 'roundEnd';
    st.t = 3.5;
    refreshList();
  }

  // All the rounds are done: most points wins. (Treasure Time and Parasite)
  function finishScoreGame(title, unit) {
    st.phase = 'over';
    const rank = st.players.slice().sort((a, b) => b.score - a.score);
    const top = rank[0].score;
    const champs = rank.filter((p) => p.score === top);
    st.winner = st.human && champs.includes(st.human) ? st.human : champs[0];
    st.its = []; // nobody is IT any more
    st.it = null;
    for (const p of st.players) if (p.ring) { p.ch.root.remove(p.ring); p.ring = null; }
    updateTags();
    TG.Sound.play('win');
    if (champs.length > 1) banner(champs.includes(st.human) ? 'YOU TIED!' : "IT'S A TIE!", 'win', 99);
    else banner(champs[0].human ? 'YOU WIN!' : `${champs[0].name} WINS!`, 'win', 99);
    sub(`${champs.map((p) => p.name).join(' and ')} got the most ${unit}s: ${top}`, 4);
    $('results').querySelector('h2').textContent = title;
    $('results-list').innerHTML = rank.map((p, i) =>
      `<li style="--c:${p.color}"><b>${p.score === top ? '🏆' : i + 1}</b><span class="dot"></span>${esc(p.name)} <small>${p.score} ${unit}${p.score === 1 ? '' : 's'}</small>${p.human ? ' <em>(you)</em>' : ''}</li>`).join('');
    refreshList();
    setTimeout(() => { if (st && st.phase === 'over') { unlockMouse(); $('results').hidden = false; } }, 2200);
  }

  // A red ring under each IT's feet.
  const ringGeo = new THREE.TorusGeometry(0.75, 0.07, 8, 36);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
  function makeItRing() {
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.06;
    return ring;
  }

  // The treasure chest, with a spinning gem and a tall beam of light so you can find it.
  function makeTreasure() {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: '#8b5a2b', roughness: 0.8 });
    const gold = new THREE.MeshStandardMaterial({ color: '#ffd23f', emissive: '#7a5a00', roughness: 0.3, metalness: 0.6 });
    const box = (w, h, d, m, x, y, z) => {
      const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      o.position.set(x, y, z);
      o.castShadow = true;
      g.add(o);
      return o;
    };
    box(1.1, 0.6, 0.75, wood, 0, 0.3, 0);        // the box
    box(1.14, 0.08, 0.79, gold, 0, 0.62, 0);     // gold rim
    box(0.08, 0.62, 0.8, gold, -0.35, 0.31, 0);  // gold bands
    box(0.08, 0.62, 0.8, gold, 0.35, 0.31, 0);
    box(0.16, 0.2, 0.06, gold, 0, 0.5, 0.4);     // the lock
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.375, 0.375, 1.1, 16, 1, false, 0, Math.PI), wood);
    lid.rotation.z = Math.PI / 2;                // half a cylinder on its side = a round lid
    lid.position.y = 0.66;
    g.add(lid);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), new THREE.MeshStandardMaterial({ color: '#ffe680', emissive: '#ffb300', emissiveIntensity: 0.8 }));
    gem.position.y = 1.4;
    g.add(gem);
    g.userData.gem = gem;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 40, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    beam.position.y = 20;
    g.add(beam);
    const light = new THREE.PointLight(0xffd23f, 1.5, 9);
    light.position.y = 1.5;
    g.add(light);
    return g;
  }

  // Is this player IT? (Treasure Time has a whole team of ITs.)
  const isIt = (p) => (st.treasure ? st.its.includes(p) : p === st.it);

  function updateTags() {
    for (const p of st.players) {
      p.tagN.visible = !isIt(p);
      p.tagIt.visible = isIt(p);
    }
  }

  // ---------- your controls ----------
  function humanInput(dt) {
    const pad = TG.Pad.get(0);
    const combo = TG.Combos.read(dt);
    if (I.down('KeyZ')) view.yaw += 2.6 * dt;
    if (I.down('KeyX')) view.yaw -= 2.6 * dt;
    if (pad) {
      view.yaw -= pad.rx * 3 * dt;
      view.pitch = Math.max(-0.2, Math.min(1.2, view.pitch + pad.ry * 2 * dt));
    }
    if (st.phase === 'roundEnd' || st.phase === 'picking') return {};
    const fx = -Math.sin(view.yaw), fz = -Math.cos(view.yaw);
    const rx = Math.cos(view.yaw), rz = -Math.sin(view.yaw);
    let ix = (I.down('KeyD') ? 1 : 0) - (I.down('KeyA') ? 1 : 0);
    let iz = (I.down('KeyW') ? 1 : 0) - (I.down('KeyS') ? 1 : 0);
    if (pad && (pad.lx || pad.ly)) { ix = pad.lx; iz = -pad.ly; }
    return {
      mx: rx * ix + fx * iz, mz: rz * ix + fz * iz,
      run: I.down('ShiftLeft') || TG.Pad.down(0, 7),
      crawl: I.down('KeyC') || combo.crawl || TG.Pad.down(0, 6),
      jump: I.pressed('Space') || TG.Pad.pressed(0, 0),
      dash: I.pressed('KeyF') || combo.dash || TG.Pad.pressed(0, 1),
      back: I.pressed('KeyQ') || combo.back || TG.Pad.pressed(0, 3),
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

  // Treasure Time, IT bot: chase runners who get close, otherwise stand guard by the treasure.
  function decideGuard(p) {
    const b = p.body, ai = p.ai, sk = p.skill, T = st.treasurePos;
    ai.run = true;
    ai.alert = false;
    let t = null, best = Infinity;
    for (const q of alivePlayers()) {
      if (isIt(q) || q.body.frozen > 0) continue;
      const toTreasure = Math.hypot(q.body.x - T.x, q.body.z - T.z);
      const toMe = Math.hypot(q.body.x - b.x, q.body.z - b.z);
      if ((toTreasure < 12 || toMe < 5) && toMe < best) { best = toMe; t = q; }
    }
    // if another IT is closer to that runner, let them chase it and stay on guard (unless it's right next to us)
    if (t && best > 6 && st.its.some((o) => o !== p && Math.hypot(t.body.x - o.body.x, t.body.z - o.body.z) < best)) t = null;
    if (t) {
      const tb = t.body;
      ai.alert = true; // a runner is coming: think faster
      if (best > 6) {
        // not close yet: block the way by standing between the runner and the treasure
        const rx = tb.x - T.x, rz = tb.z - T.z, rd = Math.hypot(rx, rz) || 1, k = Math.min(rd * 0.5, 4);
        setDir(ai, T.x + (rx / rd) * k - b.x, T.z + (rz / rd) * k - b.z);
        return;
      }
      const lead = sk.lead * Math.min(1, best / 8);
      setDir(ai, tb.x + tb.vx * lead - b.x, tb.z + tb.vz * lead - b.z);
      if (best < 5.5 && best > 2 && Math.random() < sk.dash) ai.wantDash = true;
      if (tb.y > b.y + 0.8 && best < 7 && b.grounded) ai.wantJump = true;
      return;
    }
    // each IT has its own guard spot in a circle around the treasure
    if (!ai.guard) ai.guard = findGuardSpot(st.its.indexOf(p));
    const g = ai.guard;
    if (Math.hypot(g.x - b.x, g.z - b.z) > 1) setDir(ai, g.x - b.x, g.z - b.z);
    else setDir(ai, 0, 0);
  }

  // A spot next to the treasure that's open ground (not inside a wall, not over a hole).
  function findGuardSpot(i) {
    const T = st.treasurePos, start = (i / Math.max(1, st.its.length)) * Math.PI * 2 + 0.6;
    for (const r of [2.5, 1.6]) {
      for (let k = 0; k < 12; k++) {
        const a = start + (k * Math.PI * 2) / 12;
        const x = T.x + Math.cos(a) * r, z = T.z + Math.sin(a) * r;
        if (!P.anyHit(st.colliders, x, T.y + 0.05, z, P.C.radius, P.C.standH) && groundAhead(x, T.y, z)) return { x, z };
      }
    }
    return { x: T.x, z: T.z };
  }

  // Treasure Time, runner bot: head for the treasure, swerving away from ITs.
  function decideRaider(p) {
    const b = p.body, ai = p.ai, sk = p.skill, T = st.treasurePos;
    ai.run = true;
    const l = Math.hypot(T.x - b.x, T.z - b.z) || 1;
    let fx = (T.x - b.x) / l, fz = (T.z - b.z) / l;
    const fear = sk.fear * 0.6, brave = Math.min(1, l / 6); // close to the treasure: just go for it!
    for (const it of st.its) {
      const dx = b.x - it.body.x, dz = b.z - it.body.z, d = Math.hypot(dx, dz);
      if (d < fear && d > 0.01) {
        const w = ((fear - d) / fear) * 1.8 * brave;
        fx += (dx / d) * w; fz += (dz / d) * w;
      }
    }
    setDir(ai, fx, fz);
    if (l < 5 && l > 2 && Math.random() < sk.dash * 0.5) ai.wantDash = true;
    if (T.y > b.y + 0.8 && l < 6 && b.grounded) ai.wantJump = true;
  }

  function decide(p) {
    const b = p.body, ai = p.ai, sk = p.skill;
    ai.run = false;
    if (st.treasure) { if (isIt(p)) decideGuard(p); else decideRaider(p); return; }
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
    if (ai.think <= 0) { ai.think = sk.react * (0.7 + Math.random() * 0.6) * (ai.alert ? 0.4 : 1); decide(p); }
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
      `<li class="${p.alive ? '' : 'out'} ${isIt(p) ? 'it' : ''}" style="--c:${p.color}"><span class="dot"></span>${esc(p.name)}${p.human ? ' <em>you</em>' : ''}${isIt(p) ? (st.werewolf ? ' <b>🐺</b>' : st.parasite ? ' <b>🦠</b>' : ' <b>IT</b>') : ''}${st.treasure ? ` <small>${p.score} pt${p.score === 1 ? '' : 's'}</small>` : st.parasite ? ` <small>${p.score} tag${p.score === 1 ? '' : 's'}</small>` : ''}</li>`).join('');
  }
  function updateHud(dt) {
    if (bannerT > 0 && (bannerT -= dt) <= 0) $('banner').className = '';
    if (subT > 0 && (subT -= dt) <= 0) $('subbanner').classList.remove('show');
    const t = Math.max(0, Math.ceil(st.timeLeft));
    $('hud-time').textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
    $('hud-time').classList.toggle('low', st.phase === 'play' && t <= 5);
    $('hud-round').textContent = st.werewolf ? `🐺 Round ${st.round}` : st.parasite ? `🦠 Round ${st.phase === 'picking' ? st.pickR : st.round}/${st.totalRounds}` : `${st.treasure ? '💰 ' : ''}Round ${st.round}/${st.totalRounds}`;
    const me = st.human && st.human.alive ? st.human : null;
    $('game-ui').classList.toggle('you-it', !!me && isIt(me));
    $('hud-me').hidden = !me;
    if (me) {
      $('game-stamina').style.width = (me.body.stamina / P.C.stamina) * 100 + '%';
      $('game-stamina').classList.toggle('tired', me.body.exhausted);
      if (st.parasite) $('hud-role').textContent = me === st.it ? (me.body.frozen > 0 ? 'Parasite (wait...)' : 'You have the PARASITE! Touch someone!') : me.body.frozen > 0 && st.phase === 'play' ? 'Frozen!' : 'Run from the parasite!';
      else if (st.werewolf) $('hud-role').textContent = me === st.it ? (me.body.frozen > 0 ? 'Werewolf (wait...)' : 'WEREWOLF! Tag everyone!') : 'Run from the werewolf!';
      else if (st.treasure) $('hud-role').textContent = isIt(me) ? 'IT team: guard the treasure!' : me.body.frozen > 0 && st.phase === 'play' ? 'Sent home!' : 'Runner: grab the treasure!';
      else $('hud-role').textContent = me === st.it ? (me.body.frozen > 0 ? 'IT (wait...)' : 'You are IT! Touch someone!') : me.body.frozen > 0 && st.phase === 'play' ? 'Frozen!' : 'Runner';
    }
    $('hud-spectate').hidden = !(st.human && !st.human.alive && st.phase !== 'over');
    $('hud-spectate').textContent = st.parasite ? "👀 Watching. You're back next round!" : "👀 Watching. You're out this game.";
    $('hud-lock').hidden = isLocked() || st.paused || st.phase === 'over' || st.phase === 'picking';
  }

  TG.Game = { init, start, stop, update, render, resize, isActive: () => !!st, allMaps, itsFor, treasureRounds, debug: () => st };
})();
