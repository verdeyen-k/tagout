// The tag game: rounds, IT, tagging, eliminations, bots, camera and effects.
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
    $('btn-again').addEventListener('click', () => { const s = st.setup; stop(); start(s); });
    $('btn-results-menu').addEventListener('click', () => { stop(); TG.Main.showMenu(); });
  }
  function resize(a) { camera.aspect = a; camera.updateProjectionMatrix(); }

  // ---------- maps ----------
  function allMaps() {
    const custom = Object.values(TG.Store.all()).map((m) => MF.fixMap(m));
    return { official: (TG.OFFICIAL_MAPS || []).map((m) => MF.fixMap(m)), custom };
  }
  function pickMap() {
    const { official, custom } = allMaps();
    const list = official.length ? official : custom;
    const mode = st.setup.mapMode;
    if (mode && mode.startsWith('map:')) {
      const id = mode.slice(4);
      const m = official.concat(custom).find((x) => x.id === id);
      if (m) return m;
    }
    if (!list.length) return MF.newMap('day');
    if (mode === 'random') return list[Math.floor(Math.random() * list.length)];
    return list[(st.round - 1) % list.length];
  }

  // ---------- start / stop ----------
  function start(setup) {
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
      return {
        id: i, name: s.name, color: s.color, human: s.ctrl === 'you',
        skillName: s.skill, skill: SKILL[s.skill] || SKILL.normal,
        alive: true, ch, hat, tagN, tagIt, body: null, ai: {},
      };
    });
    st = {
      setup, players, round: 0, totalRounds: players.length - 1, elim: [],
      human: players.find((p) => p.human) || null,
      time: 0, phase: 'none', paused: false, parts: [],
      scene: null, mapGroup: null,
    };
    $('game-ui').hidden = false;
    $('results').hidden = true;
    $('pause').hidden = true;
    I.clear();
    startRound();
  }

  function stop() {
    if (!st) return;
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
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function startRound() {
    clearScene();
    st.round++;
    const map = pickMap();
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
    st.spawns = MF.spawnsOf(map);
    if (!st.spawns.length) for (let i = 0; i < 8; i++) st.spawns.push({ x: Math.cos(i) * 5, y: 3, z: Math.sin(i) * 5 });
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

    const alive = st.players.filter((p) => p.alive);
    const spots = shuffle(st.spawns.slice());
    alive.forEach((p, i) => {
      const sp = spots[i % spots.length];
      const off = i >= spots.length ? 1.2 : 0;
      p.body = P.createBody(sp.x + off, sp.y + 0.05, sp.z + off);
      p.body.yaw = Math.atan2(-sp.x, -sp.z);
      p.body.frozen = 999;
      p.ai = { think: 0, dirX: 0, dirZ: 0, sx: p.body.x, sz: p.body.z, stuckT: 0, detourT: 0, crawlT: 0, tagT: 0, wanderT: 0 };
      scene.add(p.ch.root);
      p.ch.update(p.body, 0);
    });
    st.it = alive[Math.floor(Math.random() * alive.length)];
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
    $('hud-map').textContent = map.name;
    banner(`Round ${st.round} of ${st.totalRounds}`, '', 1.6);
    sub(st.it === st.human ? "You're IT first! Touch someone to tag them!" : `${st.it.name} is IT. Run!`, 3);
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

  // ---------- per frame ----------
  function update(dt) {
    if (!st) return;
    TG.Pad.poll();
    if (st.phase !== 'over' && (I.pressed('Escape') || TG.Pad.pressed(0, 9))) setPaused(!st.paused);
    if (st.paused) return;
    st.time += dt;

    if (st.phase === 'countdown') {
      st.t -= dt;
      const n = Math.ceil(st.t);
      if (n !== st.lastCount && n > 0) { st.lastCount = n; banner(String(n), 'count', 0.9); TG.Sound.play('countdown'); }
      if (st.t <= 0) {
        st.phase = 'play';
        for (const p of alivePlayers()) p.body.frozen = p === st.it ? IT_HEADSTART : 0;
        banner('GO!', 'go', 0.9);
        TG.Sound.play('go');
      }
    } else if (st.phase === 'play') {
      st.timeLeft -= dt;
      const s = Math.ceil(st.timeLeft);
      if (s <= 5 && s > 0 && s !== st.lastTick) { st.lastTick = s; TG.Sound.play('tick'); }
      if (st.timeLeft <= 0) { st.timeLeft = 0; endRound(); }
    } else if (st.phase === 'roundEnd') {
      st.t -= dt;
      if (st.t <= 0) {
        if (alivePlayers().length <= 1) finish();
        else startRound();
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
      const inp = st.phase === 'over' ? {} : p.human ? humanInput(dt) : botInput(p, dt);
      const mul = (p === st.it ? IT_BOOST : 1) * (p.human ? 1 : p.skill.speed);
      P.step(p.body, inp, { colliders: st.colliders, gravity: st.gravity, speedMul: mul }, dt);
      for (const e of p.body.events) {
        if (e === 'fell') {
          const sp = st.spawns[Math.floor(Math.random() * st.spawns.length)];
          P.respawn(p.body, sp.x, sp.y + 0.05, sp.z, 1);
          if (p.human) { TG.Sound.play('fell'); sub('Whoops! You fell off.', 1.5); }
        } else if (p.human || (!st.human || !st.human.alive) && p === st.it) TG.Sound.play(e);
      }
      if (st.phase === 'over' && p === st.winner && p.body.grounded) { p.body.vy = 7; p.body.grounded = false; }
      p.ch.update(p.body, dt);
      p.hat.update(dt);
    }

    // IT tags by touching someone (no button)
    if (st.phase === 'play' && st.it && st.it.alive && st.it.body.frozen <= 0) tryTag(st.it);

    if (st.it && st.it.alive) {
      const b = st.it.body;
      st.itMark.visible = true;
      st.itMark.position.set(b.x, b.y + 0.06, b.z);
      const s = 1 + Math.sin(st.time * 8) * 0.08;
      st.itRing.scale.set(s, s, s);
    } else st.itMark.visible = false;

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
  function tryTag(p) {
    let best = null, bd = Infinity;
    for (const q of alivePlayers()) {
      if (!canTag(p, q) || !inReach(p.body, q.body)) continue;
      const d = Math.hypot(p.body.x - q.body.x, p.body.z - q.body.z);
      if (d < bd) { bd = d; best = q; }
    }
    if (!best) return false;
    st.it = best;
    best.body.frozen = TAG_FREEZE;
    st.noBack = { it: best, cannot: p, until: st.time + NO_TAG_BACK };
    burst(best.body.x, best.body.y + 1, best.body.z, ['#ff2a2a', '#ffd23f', '#ffffff'], 26, 6);
    TG.Sound.play('tag');
    if (best.human) { banner("You're IT!", 'it', 1.4); sub(`${p.name} got you. Go touch someone!`, 2.5); }
    else if (p.human) sub(`You tagged ${best.name}! Run!`, 2.5);
    else sub(`${p.name} tagged ${best.name}!`, 2);
    updateTags();
    refreshList();
    return true;
  }

  function endRound() {
    const out = st.it;
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

  function finish() {
    const w = alivePlayers()[0];
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

  TG.Game = { init, start, stop, update, render, resize, isActive: () => !!st, allMaps };
})();
