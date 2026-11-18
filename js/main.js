// Starts everything: the renderer, the menu + setup screen (with a 3D lineup) and the game loop.
(function () {
  'use strict';
  const TG = window.TG;
  const $ = (id) => document.getElementById(id);
  const canvas = $('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // ---------- setup (saved in this browser) ----------
  const SETUP_KEY = 'tagout.setup.v1';
  const SKILLS = ['easy', 'normal', 'hard'];
  function defaultSetup() {
    return {
      count: 4, roundLen: 60, mapMode: 'rotate',
      slots: TG.COLORS.map((c, i) => ({ name: i === 0 ? 'You' : c.name, hat: TG.HATS[(i % 8) + 1].id, ctrl: i === 0 ? 'you' : 'bot', skill: 'normal' })),
    };
  }
  function loadSetup() {
    const d = defaultSetup(), s = TG.Store.get(SETUP_KEY);
    if (!s || typeof s !== 'object') return d;
    d.count = Math.max(2, Math.min(8, Math.round(Number(s.count)) || d.count));
    if ([30, 45, 60, 90].includes(Number(s.roundLen))) d.roundLen = Number(s.roundLen);
    if (typeof s.mapMode === 'string') d.mapMode = s.mapMode;
    if (Array.isArray(s.slots)) s.slots.slice(0, 8).forEach((o, i) => {
      if (!o) return;
      if (typeof o.name === 'string' && o.name.trim()) d.slots[i].name = o.name.trim().slice(0, 12);
      if (TG.HATS.some((h) => h.id === o.hat)) d.slots[i].hat = o.hat;
      if (o.ctrl === 'you' || o.ctrl === 'bot') d.slots[i].ctrl = o.ctrl;
      if (SKILLS.includes(o.skill)) d.slots[i].skill = o.skill;
    });
    // only one "You" (online play with friends comes later)
    let seen = false;
    for (const sl of d.slots) { if (sl.ctrl === 'you') { if (seen) sl.ctrl = 'bot'; seen = true; } }
    return d;
  }
  let setup = loadSetup();
  const saveSetup = () => TG.Store.set(SETUP_KEY, setup);

  // ---------- menu lineup ----------
  const menuScene = new THREE.Scene();
  menuScene.background = new THREE.Color('#0e0f17');
  const menuCam = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  menuScene.add(new THREE.HemisphereLight(0xffffff, 0x303048, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(4, 8, 6);
  menuScene.add(sun);
  const stage = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 7.5, 0.3, 48), new THREE.MeshStandardMaterial({ color: '#1d2033', roughness: 0.9 }));
  stage.position.set(0, -0.15, 1.5);
  menuScene.add(stage);
  const lineup = TG.COLORS.map((c, i) => {
    const ch = TG.makeCharacter(c.hex);
    menuScene.add(ch.root);
    return { ch, hat: null, hatId: null, tag: null, tagText: null, body: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, grounded: true }, hop: i * 0.7 };
  });
  function refreshLineup() {
    const showAll = !$('setup').hidden ? setup.count : 8;
    lineup.forEach((L, i) => {
      const on = i < showAll;
      L.ch.root.visible = on;
      const s = setup.slots[i];
      const n = Math.max(1, showAll - 1);
      const a = ((i / n) - 0.5) * Math.PI * (showAll <= 2 ? 0.35 : 0.8);
      L.body.x = Math.sin(a) * 5.2;
      L.body.z = -Math.cos(a) * 5.2 + 5.2;
      if (L.hatId !== s.hat) {
        if (L.hat) L.ch.hatAnchor.remove(L.hat.group);
        L.hat = TG.makeHat(s.hat);
        L.ch.hatAnchor.add(L.hat.group);
        L.hatId = s.hat;
        L.tagText = null;
      }
      const text = s.name + (s.ctrl === 'bot' ? '' : ' ★');
      if (L.tagText !== text) {
        if (L.tag) { L.ch.root.remove(L.tag); L.tag.material.map.dispose(); }
        L.tag = TG.makeNameTag(text, TG.COLORS[i].hex, false);
        L.tag.position.y = 1.95 + L.hat.height;
        L.ch.root.add(L.tag);
        L.tagText = text;
      }
    });
  }

  // ---------- setup screen UI ----------
  function mapOptions() {
    const { official, custom } = TG.Game.allMaps();
    let h = `<optgroup label="Mix"><option value="rotate">All maps, one after another</option><option value="random">Random map each round</option></optgroup>`;
    if (official.length) h += `<optgroup label="Official maps">${official.map((m) => `<option value="map:${esc(m.id)}">${esc(m.name)}</option>`).join('')}</optgroup>`;
    if (custom.length) h += `<optgroup label="Your saved maps">${custom.map((m) => `<option value="map:${esc(m.id)}">${esc(m.name)}</option>`).join('')}</optgroup>`;
    return h;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function renderSetup() {
    $('su-count').textContent = setup.count;
    $('su-rounds').textContent = `${setup.count - 1} round${setup.count === 2 ? '' : 's'}`;
    $('su-len').value = String(setup.roundLen);
    $('su-map').innerHTML = mapOptions();
    $('su-map').value = setup.mapMode;
    if ($('su-map').value !== setup.mapMode) { setup.mapMode = 'rotate'; $('su-map').value = 'rotate'; }
    const hats = TG.HATS.map((h) => `<option value="${h.id}">${h.label}</option>`).join('');
    $('su-slots').innerHTML = setup.slots.slice(0, setup.count).map((s, i) => `
      <div class="slot" style="--c:${TG.COLORS[i].hex}">
        <span class="dot" title="${TG.COLORS[i].name}"></span>
        <input data-i="${i}" data-k="name" value="${esc(s.name)}" maxlength="12" spellcheck="false" aria-label="Name">
        <select data-i="${i}" data-k="hat" aria-label="Hat">${hats}</select>
        <select data-i="${i}" data-k="ctrl" aria-label="Who plays"><option value="you">You</option><option value="bot">Bot</option></select>
        <select data-i="${i}" data-k="skill" aria-label="Bot skill" ${s.ctrl === 'you' ? 'disabled' : ''}><option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option></select>
      </div>`).join('');
    setup.slots.slice(0, setup.count).forEach((s, i) => {
      $('su-slots').querySelector(`[data-i="${i}"][data-k="hat"]`).value = s.hat;
      $('su-slots').querySelector(`[data-i="${i}"][data-k="ctrl"]`).value = s.ctrl;
      $('su-slots').querySelector(`[data-i="${i}"][data-k="skill"]`).value = s.skill;
    });
    const anyYou = setup.slots.slice(0, setup.count).some((s) => s.ctrl === 'you');
    $('su-note').textContent = anyYou ? '' : 'No "You" player, so you will watch the bots play.';
    refreshLineup();
  }

  $('su-slots').addEventListener('change', (e) => {
    const el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
    if (!k) return;
    if (k === 'name') setup.slots[i].name = el.value.trim().slice(0, 12) || TG.COLORS[i].name;
    else if (k === 'ctrl') {
      if (el.value === 'you') setup.slots.forEach((s) => { if (s.ctrl === 'you') s.ctrl = 'bot'; });
      setup.slots[i].ctrl = el.value;
    } else setup.slots[i][k] = el.value;
    saveSetup();
    renderSetup();
  });
  $('su-slots').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('su-minus').addEventListener('click', () => { setup.count = Math.max(2, setup.count - 1); saveSetup(); renderSetup(); TG.Sound.play('click'); });
  $('su-plus').addEventListener('click', () => { setup.count = Math.min(8, setup.count + 1); saveSetup(); renderSetup(); TG.Sound.play('click'); });
  $('su-len').addEventListener('change', (e) => { setup.roundLen = Number(e.target.value); saveSetup(); });
  $('su-map').addEventListener('change', (e) => { setup.mapMode = e.target.value; saveSetup(); });
  $('su-back').addEventListener('click', () => { $('setup').hidden = true; $('home').hidden = false; refreshLineup(); });
  $('su-start').addEventListener('click', (e) => {
    e.target.blur();
    const players = setup.slots.slice(0, setup.count).map((s, i) => ({ name: s.name, hat: s.hat, ctrl: s.ctrl, skill: s.skill, color: TG.COLORS[i].hex }));
    TG.Sound.play('go');
    TG.Main.startGame({ players, roundLen: setup.roundLen, mapMode: setup.mapMode });
  });

  // ---------- modes ----------
  let mode = 'menu';
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    menuCam.aspect = w / h;
    menuCam.updateProjectionMatrix();
    TG.Editor.resize(w / h);
    TG.Game.resize(w / h);
  }

  TG.Main = {
    showMenu() {
      TG.Editor.exit();
      TG.Game.stop();
      mode = 'menu';
      $('menu').hidden = false;
      if (!$('setup').hidden) renderSetup();
    },
    showEditor() {
      mode = 'editor';
      $('menu').hidden = true;
      TG.Editor.enter();
    },
    startGame(s) {
      mode = 'game';
      $('menu').hidden = true;
      TG.Game.start(s);
    },
  };

  TG.Editor.init(renderer, canvas);
  TG.Game.init(renderer, canvas);
  window.addEventListener('resize', resize);
  resize();
  refreshLineup();

  $('btn-maker').addEventListener('click', (e) => { e.target.blur(); TG.Sound.play('click'); TG.Main.showEditor(); });
  $('btn-play').addEventListener('click', (e) => {
    e.target.blur();
    TG.Sound.play('click');
    $('home').hidden = true;
    $('setup').hidden = false;
    renderSetup();
  });

  let last = performance.now(), t = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    if (mode === 'editor') {
      TG.Editor.update(dt);
      TG.Editor.render();
    } else if (mode === 'game') {
      TG.Game.update(dt);
      TG.Game.render();
    } else {
      for (const L of lineup) {
        const ph = t * 2.2 + L.hop;
        L.body.y = Math.max(0, Math.sin(ph)) * 0.5;
        L.body.grounded = Math.sin(ph) <= 0.05;
        L.body.yaw = Math.sin(t * 0.6 + L.hop) * 0.5;
        L.ch.update(L.body, dt);
        if (L.hat) L.hat.update(dt);
      }
      const ang = Math.sin(t * 0.15) * 0.2;
      const wide = window.innerWidth > 760;
      menuCam.position.set(Math.sin(ang) * 13 - (wide ? 3.2 : 0), 4.6, Math.cos(ang) * 13 + 3);
      menuCam.lookAt(wide ? -3.2 : 0, 1.3, 1.5);
      renderer.render(menuScene, menuCam);
    }
    TG.Input.endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
