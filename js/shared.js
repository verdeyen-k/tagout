// Keyboard input, sounds and the character model, shared by every part of the game.
(function () {
  'use strict';
  const TG = (window.TG = window.TG || {});

  // ---------- keyboard ----------
  const down = new Set(), pressed = new Set();
  let ctrlHeld = false;
  const NO_SCROLL = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Enter', 'Tab']);
  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  window.addEventListener('keydown', (e) => {
    ctrlHeld = e.ctrlKey || e.metaKey;
    if (isTyping(e)) return;
    if (NO_SCROLL.has(e.code)) e.preventDefault();
    // stop the browser's own Ctrl shortcuts we use (save page, bookmark, etc.)
    if (ctrlHeld && ['KeyS', 'KeyD', 'KeyZ', 'KeyY'].includes(e.code)) e.preventDefault();
    if (!down.has(e.code)) pressed.add(e.code);
    down.add(e.code);
  });
  window.addEventListener('keyup', (e) => { ctrlHeld = e.ctrlKey || e.metaKey; down.delete(e.code); });
  window.addEventListener('blur', () => { down.clear(); ctrlHeld = false; });
  TG.Input = {
    down: (c) => down.has(c),
    ctrl: () => ctrlHeld,
    pressed: (c) => pressed.has(c),
    endFrame() { pressed.clear(); },
    clear() { down.clear(); pressed.clear(); },
  };

  // ---------- key combos ----------
  // W+S = dash, A+D = back dash, hold A+W+D = crawl.
  // Call read(dt) once per frame for the player using the keyboard.
  let wasWS = false, wasAD = false, backWait = -1;
  TG.Combos = {
    read(dt) {
      const w = down.has('KeyW'), s = down.has('KeyS'), a = down.has('KeyA'), d = down.has('KeyD');
      const ws = w && s, ad = a && d;
      const out = {
        dash: ws && !wasWS,   // only on the moment you press them together, not while holding
        back: false,
        crawl: ad && w,
      };
      // A+D is also part of A+W+D (crawl), so wait a tiny moment to see if W is coming before back dashing.
      if (ad && !wasAD) backWait = 0.08;
      if (!ad || w) backWait = -1;
      else if (backWait >= 0 && (backWait -= dt) < 0) out.back = true;
      wasWS = ws; wasAD = ad;
      return out;
    },
  };

  // ---------- sounds (little WebAudio beeps) ----------
  let ac = null;
  function ctx() {
    if (!ac) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(f0, f1, dur, type, vol, delay) {
    const c = ctx();
    if (!c) return;
    const t = c.currentTime + (delay || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const SOUNDS = {
    jump: () => tone(320, 640, 0.12, 'square', 0.05),
    djump: () => tone(480, 980, 0.14, 'square', 0.05),
    dash: () => tone(260, 90, 0.15, 'sawtooth', 0.05),
    backdash: () => tone(180, 360, 0.13, 'sawtooth', 0.045),
    pad: () => tone(200, 1100, 0.3, 'triangle', 0.08),
    land: () => tone(140, 90, 0.05, 'triangle', 0.04),
    fell: () => tone(600, 120, 0.4, 'sawtooth', 0.05),
    place: () => tone(520, 760, 0.06, 'triangle', 0.06),
    remove: () => tone(420, 160, 0.09, 'triangle', 0.06),
    click: () => tone(700, 700, 0.03, 'square', 0.03),
    burn: () => { tone(300, 60, 0.35, 'sawtooth', 0.07); tone(900, 200, 0.2, 'square', 0.04, 0.03); },
    tag: () => { tone(900, 300, 0.18, 'square', 0.07); tone(1200, 600, 0.12, 'square', 0.04, 0.05); },
    countdown: () => tone(440, 440, 0.15, 'square', 0.06),
    go: () => tone(880, 880, 0.3, 'square', 0.07),
    tick: () => tone(1000, 1000, 0.05, 'square', 0.04),
    elim: () => { tone(500, 100, 0.5, 'sawtooth', 0.07); },
    win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.18, 'square', 0.06, i * 0.13)); },
  };
  TG.Sound = { play(name) { try { if (SOUNDS[name]) SOUNDS[name](); } catch (e) { /* no sound */ } } };

  // ---------- character ----------
  TG.COLORS = [
    { name: 'Red', hex: '#ff4b4b' }, { name: 'Orange', hex: '#ff9a2e' }, { name: 'Yellow', hex: '#ffd93b' },
    { name: 'Green', hex: '#4fd16a' }, { name: 'Teal', hex: '#2fd0c0' }, { name: 'Blue', hex: '#3d8bff' },
    { name: 'Purple', hex: '#9b5cff' }, { name: 'Pink', hex: '#ff7fc8' },
  ];

  TG.makeCharacter = function (color) {
    const root = new THREE.Group();
    const rig = new THREE.Group();
    root.add(rig);
    const skin = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const darker = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.72), roughness: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
    const add = (geo, m, x, y, z, parent) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      (parent || rig).add(mesh);
      return mesh;
    };
    const body = add(new THREE.SphereGeometry(0.46, 24, 18), skin, 0, 0.72, 0);
    body.scale.set(1, 1.08, 1);
    const head = new THREE.Group();
    head.position.set(0, 1.3, 0);
    rig.add(head);
    add(new THREE.SphereGeometry(0.34, 24, 18), skin, 0, 0, 0, head);
    const eyeGeo = new THREE.SphereGeometry(0.085, 12, 10), pupilGeo = new THREE.SphereGeometry(0.045, 10, 8);
    for (const s of [-1, 1]) {
      add(eyeGeo, white, s * 0.12, 0.05, 0.28, head);
      add(pupilGeo, black, s * 0.12, 0.05, 0.355, head);
    }
    const hatAnchor = new THREE.Group();
    hatAnchor.position.set(0, 0.34, 0);
    head.add(hatAnchor);
    const handGeo = new THREE.SphereGeometry(0.13, 12, 10);
    const handL = add(handGeo, darker, -0.52, 0.7, 0.05), handR = add(handGeo, darker, 0.52, 0.7, 0.05);
    const footGeo = new THREE.SphereGeometry(0.16, 12, 10);
    const footL = add(footGeo, darker, -0.2, 0.09, 0.05), footR = add(footGeo, darker, 0.2, 0.09, 0.05);
    footL.scale.set(1, 0.6, 1.4); footR.scale.set(1, 0.6, 1.4);

    let phase = 0;
    const target = new THREE.Vector3(1, 1, 1);
    function update(b, dt) {
      root.position.set(b.x, b.y, b.z);
      root.rotation.y = b.yaw;
      const sp = b.speed || 0;
      phase += dt * sp * 1.7;
      const amt = b.grounded ? Math.min(1, sp / 6) : 0;
      const sw = Math.sin(phase) * 0.32 * amt;
      footL.position.z = 0.05 + sw; footR.position.z = 0.05 - sw;
      footL.position.y = 0.09 + Math.max(0, Math.cos(phase)) * 0.1 * amt;
      footR.position.y = 0.09 + Math.max(0, -Math.cos(phase)) * 0.1 * amt;
      handL.position.z = 0.05 - sw * 0.7; handR.position.z = 0.05 + sw * 0.7;
      const air = b.grounded ? 0 : 1;
      handL.position.y = handR.position.y = 0.7 + air * 0.25;
      target.set(1, 1, 1);
      if (b.crawling) target.set(1.15, 0.5, 1.15);
      if (b.dashT > 0 || b.backT > 0) target.set(target.x * 0.88, target.y * 0.88, 1.35);
      rig.scale.lerp(target, Math.min(1, dt * 18));
    }
    return { root, rig, head, hatAnchor, update };
  };
})();
