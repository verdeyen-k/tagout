// The 8 hats, name tags, and gamepad reading.
(function () {
  'use strict';
  const TG = (window.TG = window.TG || {});

  TG.HATS = [
    { id: 'none', label: 'No hat' },
    { id: 'hardhat', label: 'Hard hat' },
    { id: 'propeller', label: 'Propeller hat' },
    { id: 'icecream', label: 'Ice cream cone' },
    { id: 'flowerpot', label: 'Flower pot' },
    { id: 'snowy', label: 'Snowy hat' },
    { id: 'banana', label: 'Banana peel' },
    { id: 'turtle', label: 'Turtle' },
    { id: 'headphones', label: 'Headphones' },
  ];

  const M = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.6 }, o || {}));
  function add(g, geo, m, x, y, z) {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x || 0, y || 0, z || 0);
    o.castShadow = true;
    g.add(o);
    return o;
  }
  const dome = (r, a, b) => new THREE.SphereGeometry(r, 24, 12, a || 0, b || Math.PI * 2, 0, Math.PI / 2);
  const up = new THREE.Vector3(0, 1, 0);

  // The hat's group sits on top of the head (head radius 0.34, so the head's center is 0.34 below).
  TG.makeHat = function (id) {
    const g = new THREE.Group();
    let height = 0, spin = null;
    switch (id) {
      case 'hardhat': {
        const y = M('#ffcc1a', { roughness: 0.35 });
        add(g, dome(0.37), y, 0, -0.12, 0);
        add(g, new THREE.CylinderGeometry(0.47, 0.47, 0.04, 28), y, 0, -0.11, 0.05);
        const ridge = add(g, new THREE.TorusGeometry(0.37, 0.035, 8, 24, Math.PI), y, 0, -0.12, 0);
        ridge.rotation.y = Math.PI / 2;
        height = 0.3;
        break;
      }
      case 'propeller': {
        ['#ff4b4b', '#ffd93b', '#3d8bff'].forEach((c, i) => add(g, dome(0.36, (i * Math.PI * 2) / 3, (Math.PI * 2) / 3), M(c), 0, -0.1, 0));
        add(g, new THREE.CylinderGeometry(0.03, 0.03, 0.16, 8), M('#555'), 0, 0.31, 0);
        spin = new THREE.Group();
        spin.position.y = 0.39;
        add(spin, new THREE.BoxGeometry(0.8, 0.02, 0.11), M('#2fd0c0'));
        add(spin, new THREE.SphereGeometry(0.045, 10, 8), M('#ff4b4b'));
        g.add(spin);
        height = 0.42;
        break;
      }
      case 'icecream': {
        const pink = M('#ff9ccf', { roughness: 0.45 });
        const scoop = add(g, new THREE.SphereGeometry(0.31, 24, 16), pink, 0, 0.02, 0);
        scoop.scale.y = 0.75;
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2 + 0.3;
          const d = add(g, new THREE.SphereGeometry(0.07, 10, 8), pink, Math.cos(a) * 0.28, -0.1 - (i % 3) * 0.04, Math.sin(a) * 0.28);
          d.scale.y = 1.7;
        }
        const cols = ['#ff4b4b', '#ffd93b', '#4fd16a', '#3d8bff', '#ffffff', '#9b5cff'];
        for (let i = 0; i < 16; i++) {
          const a = Math.random() * Math.PI * 2, el = 0.35 + Math.random() * 0.55;
          const s = add(g, new THREE.BoxGeometry(0.06, 0.018, 0.018), M(cols[i % cols.length]),
            Math.cos(a) * Math.cos(el) * 0.31, 0.02 + Math.sin(el) * 0.31 * 0.75, Math.sin(a) * Math.cos(el) * 0.31);
          s.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        }
        add(g, new THREE.ConeGeometry(0.25, 0.62, 20), M('#d9a35b', { roughness: 0.8 }), 0, 0.5, 0);
        height = 0.82;
        break;
      }
      case 'flowerpot': {
        const terra = M('#c8643b', { roughness: 0.85 });
        add(g, new THREE.CylinderGeometry(0.3, 0.22, 0.36, 20), terra, 0, 0.1, 0);
        add(g, new THREE.CylinderGeometry(0.33, 0.33, 0.07, 20), terra, 0, 0.29, 0);
        add(g, new THREE.CylinderGeometry(0.29, 0.29, 0.02, 20), M('#4a3020'), 0, 0.33, 0);
        const green = M('#3e9b3a');
        add(g, new THREE.CylinderGeometry(0.025, 0.025, 0.42, 8), green, 0, 0.54, 0);
        const leaf = add(g, new THREE.SphereGeometry(0.08, 10, 8), green, 0.08, 0.5, 0);
        leaf.scale.set(1.4, 0.4, 0.7);
        add(g, new THREE.SphereGeometry(0.07, 12, 10), M('#ffd93b'), 0, 0.78, 0.02);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          add(g, new THREE.SphereGeometry(0.065, 10, 8), M('#ff7fc8'), Math.cos(a) * 0.12, 0.78 + Math.sin(a) * 0.12, 0);
        }
        height = 0.92;
        break;
      }
      case 'snowy': {
        const b = add(g, dome(0.37), M('#9fd3ff'), 0, -0.1, 0);
        b.scale.y = 1.15;
        const white = M('#ffffff', { roughness: 0.9 });
        add(g, new THREE.CylinderGeometry(0.39, 0.39, 0.12, 28), white, 0, -0.06, 0);
        add(g, new THREE.SphereGeometry(0.11, 12, 10), white, 0, 0.36, 0);
        for (const [x, z] of [[0.12, 0.05], [-0.1, 0.1], [0, -0.12]]) {
          const s = add(g, new THREE.SphereGeometry(0.13, 12, 8), white, x, 0.24, z);
          s.scale.y = 0.35;
        }
        height = 0.48;
        break;
      }
      case 'banana': {
        const yel = M('#ffe14d', { roughness: 0.5 });
        const cap = add(g, new THREE.SphereGeometry(0.17, 16, 10), yel, 0, 0.02, 0);
        cap.scale.y = 0.5;
        // the peeled banana sticks up out of the peel, with a little curve
        const fruit = new THREE.Group();
        fruit.rotation.z = 0.18;
        const cream = M('#fff1bf', { roughness: 0.7 });
        add(fruit, new THREE.CylinderGeometry(0.1, 0.13, 0.5, 16), cream, 0, 0.27, 0);
        add(fruit, new THREE.SphereGeometry(0.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), cream, 0, 0.52, 0);
        add(fruit, new THREE.CylinderGeometry(0.025, 0.035, 0.06, 8), M('#6b4a1a'), 0, 0.64, 0);
        g.add(fruit);
        // 4 peel strips: each one bends over the top of the head, then hangs down and flares out a bit.
        const spot = M('#6b4a1a');
        const L1 = 0.3, L2 = 0.26;
        for (let i = 0; i < 4; i++) {
          const pivot = new THREE.Group();
          pivot.rotation.y = (i * Math.PI) / 2 + Math.PI / 4;
          const h1 = new THREE.Group();
          h1.position.set(0, 0, 0.13);
          h1.rotation.x = -0.96; // top part lies along the head (~55° from straight down)
          add(h1, new THREE.BoxGeometry(0.17, L1, 0.04), yel, 0, -L1 / 2, 0);
          const h2 = new THREE.Group();
          h2.position.set(0, -L1, 0);
          h2.rotation.x = 0.61; // bottom part hangs down, flaring out ~20°
          add(h2, new THREE.BoxGeometry(0.15, L2, 0.04), yel, 0, -L2 / 2, 0);
          add(h2, new THREE.BoxGeometry(0.13, 0.05, 0.05), spot, 0, -L2, 0);
          h1.add(h2);
          pivot.add(h1);
          g.add(pivot);
        }
        height = 0.68;
        break;
      }
      case 'turtle': {
        const shellY = -0.12, R = 0.38, sy = 0.75;
        const shell = add(g, dome(R), M('#3f8f3a'), 0, shellY, 0);
        shell.scale.y = sy;
        add(g, new THREE.TorusGeometry(R, 0.04, 8, 28), M('#2d6b2a'), 0, shellY, 0).rotation.x = Math.PI / 2;
        const plate = M('#79c66a');
        const hex = new THREE.CylinderGeometry(0.1, 0.1, 0.04, 6);
        const put = (x, y, z) => {
          const n = new THREE.Vector3(x / R, (y - shellY) / (R * sy * sy), z / R).normalize();
          const m = add(g, hex, plate, x, y, z);
          m.quaternion.setFromUnitVectors(up, n);
        };
        put(0, shellY + R * sy, 0);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2, el = 0.85;
          put(Math.cos(a) * Math.sin(el) * R, shellY + Math.cos(el) * R * sy, Math.sin(a) * Math.sin(el) * R);
        }
        const skin = M('#9bd77f');
        add(g, new THREE.SphereGeometry(0.1, 12, 10), skin, 0, -0.07, 0.44);
        for (const s of [-1, 1]) add(g, new THREE.SphereGeometry(0.02, 6, 6), M('#111'), s * 0.045, -0.04, 0.53);
        for (const [x, z] of [[0.28, 0.26], [-0.28, 0.26], [0.28, -0.26], [-0.28, -0.26]]) {
          const l = add(g, new THREE.SphereGeometry(0.075, 10, 8), skin, x, -0.13, z);
          l.scale.set(1, 0.6, 1.3);
        }
        add(g, new THREE.ConeGeometry(0.04, 0.12, 8), skin, 0, -0.12, -0.42).rotation.x = -Math.PI / 2;
        height = 0.2;
        break;
      }
      case 'headphones': {
        add(g, new THREE.TorusGeometry(0.39, 0.035, 8, 28, Math.PI), M('#222'), 0, -0.34, 0);
        for (const s of [-1, 1]) {
          const cup = add(g, new THREE.CylinderGeometry(0.14, 0.14, 0.1, 20), M('#ff4b4b', { roughness: 0.4 }), s * 0.39, -0.34, 0);
          cup.rotation.z = Math.PI / 2;
          const pad = add(g, new THREE.CylinderGeometry(0.115, 0.115, 0.04, 20), M('#111'), s * 0.33, -0.34, 0);
          pad.rotation.z = Math.PI / 2;
        }
        height = 0.08;
        break;
      }
    }
    return { group: g, height, update(dt) { if (spin) spin.rotation.y += dt * 14; } };
  };

  // ---------- name tags (canvas sprites) ----------
  function roundRect(x, X, Y, w, h, r) {
    x.beginPath();
    x.moveTo(X + r, Y);
    x.arcTo(X + w, Y, X + w, Y + h, r);
    x.arcTo(X + w, Y + h, X, Y + h, r);
    x.arcTo(X, Y + h, X, Y, r);
    x.arcTo(X, Y, X + w, Y, r);
    x.closePath();
  }
  TG.makeNameTag = function (text, color, isIt) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const x = c.getContext('2d');
    x.font = '900 54px Nunito, sans-serif';
    const tw = Math.min(480, x.measureText(text).width + 56);
    const X = (512 - tw) / 2;
    roundRect(x, X, 22, tw, 84, 40);
    x.fillStyle = isIt ? '#e3242b' : 'rgba(12, 14, 28, 0.78)';
    x.fill();
    x.lineWidth = 8;
    x.strokeStyle = isIt ? '#ffd23f' : color;
    x.stroke();
    x.fillStyle = isIt ? '#ffffff' : color;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(text, 256, 66, 460);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: !isIt });
    const s = new THREE.Sprite(mat);
    s.scale.set(2.2, 0.55, 1);
    if (isIt) s.renderOrder = 999;
    return s;
  };

  // ---------- gamepads (pad 0 = you; pad 1 kept for later) ----------
  const prev = [[], []], state = [null, null];
  const dz = (v) => (Math.abs(v || 0) < 0.2 ? 0 : v);
  TG.Pad = {
    poll() {
      let pads = [];
      try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { pads = []; }
      for (let i = 0; i < 2; i++) {
        const g = pads && pads[i];
        if (!g) { state[i] = null; prev[i] = []; continue; }
        const btn = g.buttons.map((b) => b.pressed || b.value > 0.5);
        state[i] = { lx: dz(g.axes[0]), ly: dz(g.axes[1]), rx: dz(g.axes[2]), ry: dz(g.axes[3]), btn, old: prev[i] };
        prev[i] = btn;
      }
    },
    get: (i) => state[i],
    down: (i, b) => !!(state[i] && state[i].btn[b]),
    pressed: (i, b) => !!(state[i] && state[i].btn[b] && !state[i].old[b]),
  };
})();
