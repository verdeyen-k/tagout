// Map data format: maps are plain JSON so the editor, the game and (later) online play share them.
// A piece's x/z is its center and y is its BOTTOM. w = size on x, h = height, d = size on z.
(function () {
  'use strict';
  const TG = (window.TG = window.TG || {});

  const THEMES = {
    day:   { label: 'Sunny day',  sky: '#8fc9ff', fogDensity: 0.006, floor: true,  floorColor: '#5fae55', walls: true,  gravity: 30, ambient: 0.75, sun: 1.0,  stars: false, grid: false },
    cave:  { label: 'Cave',       sky: '#0b0a12', fogDensity: 0.04,  floor: true,  floorColor: '#3b3542', walls: true,  gravity: 30, ambient: 0.4,  sun: 0.3,  stars: false, grid: false },
    space: { label: 'Space',      sky: '#04050d', fogDensity: 0,     floor: false, floorColor: '#4a4f63', walls: false, gravity: 14, ambient: 0.55, sun: 1.1,  stars: true,  grid: false },
    city:  { label: 'City',       sky: '#a9c8e8', fogDensity: 0.008, floor: true,  floorColor: '#4b4f57', walls: true,  gravity: 30, ambient: 0.65, sun: 1.0,  stars: false, grid: false },
    fall:  { label: 'Fall farm',  sky: '#f3c98b', fogDensity: 0.01,  floor: true,  floorColor: '#8a7a3a', walls: true,  gravity: 30, ambient: 0.7,  sun: 1.0,  stars: false, grid: false },
    neon:  { label: 'Neon arena', sky: '#090616', fogDensity: 0.012, floor: true,  floorColor: '#16122b', walls: true,  gravity: 30, ambient: 0.5,  sun: 0.6,  stars: false, grid: true },
  };

  const PIECES = {
    box:    { label: 'Block',        w: 4, h: 2,   d: 4, color: '#8d939e' },
    stairs: { label: 'Stairs',       w: 2, h: 2,   d: 4, color: '#b9a98c', dir: 0 },
    tunnel: { label: 'Crawl tunnel', w: 4, h: 2.4, d: 4, color: '#7d6e63', dir: 0 },
    pad:    { label: 'Jump pad',     w: 2, h: 0.3, d: 2, color: '#35e0ff', power: 17 },
    spawn:  { label: 'Spawn',        w: 1, h: 0.1, d: 1, color: '#ffd23f' },
  };

  const CRAWL_GAP_H = 1.1, CRAWL_GAP_W = 1.6, MAX_RISE = 0.4;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, def) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def);
  const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

  let counter = 0;
  function makeId(prefix) {
    counter++;
    return (prefix || 'p') + Date.now().toString(36) + counter.toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }

  function fixPiece(p) {
    const def = PIECES[p.type];
    if (!def) return null;
    const out = { id: typeof p.id === 'string' && p.id ? p.id : makeId(), type: p.type };
    out.x = clamp(num(p.x, 0), -500, 500);
    out.y = clamp(num(p.y, 0), -100, 300);
    out.z = clamp(num(p.z, 0), -500, 500);
    out.w = clamp(num(p.w, def.w), 0.2, 200);
    out.h = clamp(num(p.h, def.h), 0.1, 200);
    out.d = clamp(num(p.d, def.d), 0.2, 200);
    out.color = isHex(p.color) ? p.color : def.color;
    if ('dir' in def) out.dir = ((Math.round(num(p.dir, 0)) % 4) + 4) % 4;
    if ('power' in def) out.power = clamp(num(p.power, def.power), 5, 40);
    if (p.type === 'tunnel') {
      out.h = Math.max(out.h, CRAWL_GAP_H + 0.3);
      if (out.dir % 2 === 0) out.w = Math.max(out.w, 2); else out.d = Math.max(out.d, 2);
    }
    if (p.type === 'spawn') { out.w = 1; out.h = 0.1; out.d = 1; }
    return out;
  }

  function newPiece(type, pos, base) {
    const def = PIECES[type];
    const p = { type, w: def.w, h: def.h, d: def.d, color: def.color, dir: def.dir, power: def.power };
    if (base) for (const k of ['w', 'h', 'd', 'color', 'dir', 'power']) if (base[k] !== undefined) p[k] = base[k];
    Object.assign(p, pos);
    p.id = makeId();
    return fixPiece(p);
  }

  function defaultSettings(themeKey) {
    const t = THEMES[themeKey] || THEMES.day;
    const s = Object.assign({}, t, { theme: THEMES[themeKey] ? themeKey : 'day', size: 60 });
    delete s.label;
    return s;
  }

  function fixSettings(s) {
    const base = defaultSettings(s && s.theme);
    s = s || {};
    return {
      theme: base.theme,
      sky: isHex(s.sky) ? s.sky : base.sky,
      floorColor: isHex(s.floorColor) ? s.floorColor : base.floorColor,
      fogDensity: clamp(num(s.fogDensity, base.fogDensity), 0, 0.08),
      floor: typeof s.floor === 'boolean' ? s.floor : base.floor,
      walls: typeof s.walls === 'boolean' ? s.walls : base.walls,
      gravity: clamp(num(s.gravity, base.gravity), 6, 45),
      ambient: clamp(num(s.ambient, base.ambient), 0, 2),
      sun: clamp(num(s.sun, base.sun), 0, 2),
      stars: typeof s.stars === 'boolean' ? s.stars : base.stars,
      grid: typeof s.grid === 'boolean' ? s.grid : base.grid,
      size: clamp(Math.round(num(s.size, 60)), 20, 200),
    };
  }

  function fixMap(m) {
    m = m && typeof m === 'object' ? m : {};
    const seen = new Set();
    const pieces = [];
    for (const raw of Array.isArray(m.pieces) ? m.pieces : []) {
      if (!raw || typeof raw !== 'object') continue;
      const p = fixPiece(raw);
      if (!p) continue;
      if (seen.has(p.id)) p.id = makeId();
      seen.add(p.id);
      pieces.push(p);
      if (pieces.length >= 3000) break;
    }
    return {
      version: 1,
      id: typeof m.id === 'string' && m.id ? m.id : makeId('m'),
      name: (typeof m.name === 'string' && m.name.trim() ? m.name.trim() : 'My Map').slice(0, 30),
      settings: fixSettings(m.settings),
      pieces,
    };
  }

  function newMap(themeKey) {
    return fixMap({
      name: 'My Map',
      settings: defaultSettings(themeKey),
      pieces: themeKey === 'space'
        ? [{ type: 'box', x: 0, y: -1, z: 0, w: 16, h: 1, d: 16, color: '#6a7088' }, { type: 'spawn', x: 0, y: 0, z: 0 }]
        : [{ type: 'spawn', x: 0, y: 0, z: 0 }],
    });
  }

  // ---------- collision boxes ----------
  function box(minX, minY, minZ, maxX, maxY, maxZ, extra) {
    return Object.assign({ minX, minY, minZ, maxX, maxY, maxZ }, extra || {});
  }

  function pieceBoxes(p) {
    const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, z0 = p.z - p.d / 2, z1 = p.z + p.d / 2, y0 = p.y, y1 = p.y + p.h;
    switch (p.type) {
      case 'box': return [box(x0, y0, z0, x1, y1, z1)];
      case 'pad': return [box(x0, y0, z0, x1, y1, z1, { kind: 'pad', power: p.power })];
      case 'spawn': return [];
      case 'stairs': {
        const n = Math.max(1, Math.ceil(p.h / MAX_RISE - 1e-6));
        const alongZ = p.dir % 2 === 0, len = alongZ ? p.d : p.w, start = alongZ ? z0 : x0;
        const rising = p.dir < 2; // 0: up toward +z, 1: +x, 2: -z, 3: -x
        const out = [];
        for (let i = 0; i < n; i++) {
          const top = y0 + (p.h * (i + 1)) / n;
          const a = rising ? start + (len * i) / n : start + len - (len * (i + 1)) / n;
          const b = rising ? start + (len * (i + 1)) / n : start + len - (len * i) / n;
          out.push(alongZ ? box(x0, y0, a, x1, top, b, { step: i }) : box(a, y0, z0, b, top, z1, { step: i }));
        }
        return out;
      }
      case 'tunnel': {
        const alongZ = p.dir % 2 === 0;
        const cross = alongZ ? p.w : p.d;
        const gw = Math.min(CRAWL_GAP_W, cross - 0.4);
        const gy = y0 + CRAWL_GAP_H;
        if (alongZ) {
          const c = p.x;
          return [box(x0, y0, z0, c - gw / 2, y1, z1), box(c + gw / 2, y0, z0, x1, y1, z1), box(c - gw / 2, gy, z0, c + gw / 2, y1, z1)];
        }
        const c = p.z;
        return [box(x0, y0, z0, x1, y1, c - gw / 2), box(x0, y0, c + gw / 2, x1, y1, z1), box(x0, gy, c - gw / 2, x1, y1, c + gw / 2)];
      }
    }
    return [];
  }

  function settingsColliders(s) {
    const c = [], h = s.size / 2, H = 80, t = 3;
    if (s.floor) c.push(box(-h, -3, -h, h, 0, h, { floor: true }));
    if (s.walls) {
      c.push(box(-h - t, -3, -h - t, h + t, H, -h));
      c.push(box(-h - t, -3, h, h + t, H, h + t));
      c.push(box(-h - t, -3, -h, -h, H, h));
      c.push(box(h, -3, -h, h + t, H, h));
    }
    return c;
  }

  function collidersOf(map) {
    const out = settingsColliders(map.settings);
    for (const p of map.pieces) for (const b of pieceBoxes(p)) out.push(b);
    return out;
  }

  function spawnsOf(map) {
    return map.pieces.filter((p) => p.type === 'spawn').map((p) => ({ x: p.x, y: p.y, z: p.z }));
  }

  // ---------- 3D building (needs THREE) ----------
  const matCache = new Map();
  function mat(color, extra) {
    const key = color + (extra ? JSON.stringify(extra) : '');
    let m = matCache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85, metalness: 0.05 }, extra || {}));
      matCache.set(key, m);
    }
    return m;
  }
  function shade(hex, f) {
    const c = new THREE.Color(hex);
    c.multiplyScalar(f);
    return '#' + c.getHexString();
  }

  function addBoxMesh(group, b, material) {
    const geo = new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
    const m = new THREE.Mesh(geo, material);
    m.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  }

  function buildPieceGroup(p, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    g.userData.pieceId = p.id;
    if (p.type === 'spawn') {
      g.userData.editorOnly = true;
      if (!opts.editor) return g;
      const glow = mat(p.color, { emissive: p.color, emissiveIntensity: 0.7 });
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.1, 24), glow);
      disc.position.set(p.x, p.y + 0.05, p.z);
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.6, 16), glow);
      arrow.position.set(p.x, p.y + 1.2, p.z);
      arrow.rotation.x = Math.PI;
      g.add(disc, arrow);
      return g;
    }
    const boxes = pieceBoxes(p);
    if (p.type === 'pad') {
      const b = boxes[0];
      addBoxMesh(g, b, mat('#2b2f3c'));
      addBoxMesh(g, { minX: b.minX + 0.2, maxX: b.maxX - 0.2, minZ: b.minZ + 0.2, maxZ: b.maxZ - 0.2, minY: b.maxY - 0.01, maxY: b.maxY + 0.04 },
        mat(p.color, { emissive: p.color, emissiveIntensity: 0.9 }));
      return g;
    }
    boxes.forEach((b, i) => {
      const c = p.type === 'stairs' && i % 2 === 1 ? shade(p.color, 0.88) : p.color;
      addBoxMesh(g, b, mat(c));
    });
    return g;
  }

  function disposeGroup(g) {
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  function buildEnvironment(s) {
    const g = new THREE.Group();
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404050, s.ambient);
    g.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, s.sun);
    const half = s.size / 2;
    sun.position.set(half * 0.5, Math.max(40, s.size), half * 0.35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -half - 10; sc.right = half + 10; sc.top = half + 10; sc.bottom = -half - 10;
    sc.near = 1; sc.far = s.size * 3 + 100;
    sun.shadow.bias = -0.0005;
    g.add(sun, sun.target);

    if (s.floor) {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(s.size, s.size), mat(s.floorColor, { roughness: 0.95 }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      g.add(floor);
    }
    if (s.grid) {
      const grid = new THREE.GridHelper(s.size, Math.round(s.size / 2), 0xff2fd6, 0x2fe9ff);
      grid.position.y = 0.015;
      grid.material.transparent = true;
      grid.material.opacity = 0.55;
      g.add(grid);
    }
    if (s.walls) {
      const trim = mat(shade(s.floorColor, 0.6));
      const t = 0.5, H = 0.6;
      addBoxMesh(g, box(-half - t, 0, -half - t, half + t, H, -half), trim);
      addBoxMesh(g, box(-half - t, 0, half, half + t, H, half + t), trim);
      addBoxMesh(g, box(-half - t, 0, -half, -half, H, half), trim);
      addBoxMesh(g, box(half, 0, -half, half + t, H, half), trim);
    }
    if (s.stars) {
      const n = 1500, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 350 + Math.random() * 100;
        const q = Math.sqrt(1 - u * u);
        pos[i * 3] = r * q * Math.cos(th); pos[i * 3 + 1] = r * u; pos[i * 3 + 2] = r * q * Math.sin(th);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: true, fog: false })));
    }
    return g;
  }

  function applySky(scene, s) {
    scene.background = new THREE.Color(s.sky);
    scene.fog = s.fogDensity > 0 ? new THREE.FogExp2(s.sky, s.fogDensity) : null;
  }

  TG.MapFormat = {
    THEMES, PIECES, CRAWL_GAP_H, CRAWL_GAP_W,
    newMap, fixMap, newPiece, fixPiece, defaultSettings, makeId,
    pieceBoxes, collidersOf, spawnsOf,
    buildPieceGroup, buildEnvironment, applySky, disposeGroup,
  };

  // ---------- saving custom maps in this browser ----------
  const KEY = 'tagout.maps.v1';
  TG.Store = {
    all() {
      try {
        const r = JSON.parse(localStorage.getItem(KEY) || '{}');
        return r && typeof r === 'object' ? r : {};
      } catch (e) { return {}; }
    },
    save(map) {
      try {
        const all = this.all();
        all[map.id] = map;
        localStorage.setItem(KEY, JSON.stringify(all));
        return true;
      } catch (e) { return false; }
    },
    remove(id) {
      try {
        const all = this.all();
        delete all[id];
        localStorage.setItem(KEY, JSON.stringify(all));
      } catch (e) { /* ignore */ }
    },
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };
})();
