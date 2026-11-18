// The Map Maker: fly around in 3D, place blocks, stairs, crawl tunnels, jump pads and spawns.
(function () {
  'use strict';
  const TG = (window.TG = window.TG || {});
  const MF = TG.MapFormat, I = TG.Input;

  const TOOLS = [
    { id: 'select', label: 'Select', icon: '👆', key: 'Digit1' },
    { id: 'box', label: 'Block', icon: '🧱', key: 'Digit2' },
    { id: 'stairs', label: 'Stairs', icon: '📶', key: 'Digit3' },
    { id: 'tunnel', label: 'Crawl tunnel', icon: '🕳️', key: 'Digit4' },
    { id: 'pad', label: 'Jump pad', icon: '⏫', key: 'Digit5' },
    { id: 'spawn', label: 'Spawn', icon: '⭐', key: 'Digit6' },
    { id: 'erase', label: 'Eraser', icon: '🧽', key: 'Digit7' },
  ];
  const SWATCHES = ['#ff4b4b', '#ff9a2e', '#ffd93b', '#4fd16a', '#2fd0c0', '#3d8bff', '#9b5cff', '#ff7fc8',
    '#f4f1ea', '#8d939e', '#5b5f68', '#2a2d34', '#8b5a2b', '#c9a46a', '#5fae55', '#35e0ff'];
  const AUTOSAVE = 'tagout.editor.autosave';

  let renderer, canvas, scene, camera;
  let active = false, testing = false;
  let map = null, envGroup = null, grid = null, ground, ghost, selBox;
  const piecesRoot = new THREE.Group();
  const groups = new Map();
  let tool = 'box', selectedId = null, gridStep = 1;
  const lastProps = {};
  let undoStack = [], redoStack = [];
  const cam = { x: 0, y: 16, z: 26, yaw: 0, pitch: -0.55 };
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let mouseOver = false, looking = false, drag = null, ghostPos = null;
  const $ = (id) => document.getElementById(id);

  // ---------- setup ----------
  function init(r, cvs) {
    renderer = r; canvas = cvs;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1500);
    camera.rotation.order = 'YXZ';
    scene.add(piecesRoot);

    ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshBasicMaterial({ visible: false }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    ghost.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffffff })));
    ghost.visible = false;
    scene.add(ghost);

    selBox = new THREE.Box3Helper(new THREE.Box3(), 0xffd23f);
    selBox.visible = false;
    scene.add(selBox);

    buildToolbar();
    bindUI();
    bindPointer();
  }

  function resize(aspect) { camera.aspect = aspect; camera.updateProjectionMatrix(); }

  function enter() {
    active = true;
    $('editor-ui').hidden = false;
    if (!map) {
      const saved = TG.Store.get(AUTOSAVE);
      loadMap(saved ? MF.fixMap(saved) : MF.newMap('day'), true);
    }
    setTool(tool);
  }

  function exit() {
    if (testing) TG.TestPlay.stop();
    active = false;
    $('editor-ui').hidden = true;
  }

  // ---------- map building ----------
  function loadMap(m, keepView) {
    map = MF.fixMap(JSON.parse(JSON.stringify(m)));
    undoStack = []; redoStack = [];
    selectedId = null;
    rebuildEnv();
    rebuildAllPieces();
    if (!keepView) {
      cam.x = 0; cam.y = Math.max(12, map.settings.size * 0.3); cam.z = map.settings.size * 0.45;
      cam.yaw = 0; cam.pitch = -0.55;
    }
    $('ed-name').value = map.name;
    refreshPanel();
    autosave();
  }

  function rebuildEnv() {
    if (envGroup) { scene.remove(envGroup); MF.disposeGroup(envGroup); }
    envGroup = MF.buildEnvironment(map.settings);
    scene.add(envGroup);
    MF.applySky(scene, map.settings);
    if (grid) { scene.remove(grid); grid.geometry.dispose(); }
    const size = map.settings.size;
    grid = new THREE.GridHelper(size, Math.min(400, Math.round(size / gridStep)), 0xffffff, 0xffffff);
    grid.material.transparent = true;
    grid.material.opacity = 0.18;
    grid.position.y = 0.02;
    grid.visible = !testing;
    scene.add(grid);
  }

  function rebuildPiece(p) {
    removeGroup(p.id);
    const g = MF.buildPieceGroup(p, { editor: true });
    g.traverse((o) => { o.userData.pieceId = p.id; });
    piecesRoot.add(g);
    groups.set(p.id, g);
  }
  function removeGroup(id) {
    const old = groups.get(id);
    if (old) { piecesRoot.remove(old); MF.disposeGroup(old); groups.delete(id); }
  }
  function rebuildAllPieces() {
    for (const id of [...groups.keys()]) removeGroup(id);
    for (const p of map.pieces) rebuildPiece(p);
    updateSelBox();
  }

  const findPiece = (id) => map.pieces.find((p) => p.id === id) || null;
  const selected = () => (selectedId ? findPiece(selectedId) : null);

  // ---------- undo ----------
  function snapshot() { return JSON.stringify({ name: map.name, settings: map.settings, pieces: map.pieces }); }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 150) undoStack.shift();
    redoStack = [];
  }
  function restore(snap) {
    const s = JSON.parse(snap);
    map.name = s.name; map.settings = s.settings; map.pieces = s.pieces;
    if (selectedId && !findPiece(selectedId)) selectedId = null;
    $('ed-name').value = map.name;
    rebuildEnv();
    rebuildAllPieces();
    changed();
  }
  function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); TG.Sound.play('click'); } }
  function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); TG.Sound.play('click'); } }

  function commit(fn) { pushUndo(); fn(); changed(); }
  function changed() { autosave(); refreshPanel(); updateSelBox(); }
  function autosave() { TG.Store.set(AUTOSAVE, map); }

  // ---------- selection ----------
  function select(id) {
    selectedId = id;
    updateSelBox();
    refreshPanel();
  }
  function updateSelBox() {
    const p = selected();
    if (!p || testing) { selBox.visible = false; return; }
    const pad = 0.04;
    selBox.box.min.set(p.x - p.w / 2 - pad, p.y - pad, p.z - p.d / 2 - pad);
    selBox.box.max.set(p.x + p.w / 2 + pad, p.y + Math.max(p.h, p.type === 'spawn' ? 1.6 : 0) + pad, p.z + p.d / 2 + pad);
    selBox.visible = true;
  }
  function rememberProps(p) {
    lastProps[p.type] = { w: p.w, h: p.h, d: p.d, color: p.color, dir: p.dir, power: p.power };
  }

  function editSelected(fn) {
    const p = selected();
    if (!p) return;
    commit(() => {
      fn(p);
      Object.assign(p, MF.fixPiece(p));
      rememberProps(p);
      rebuildPiece(p);
    });
  }

  function rotateProps(o) {
    // turning swaps width and depth; stairs turn through 4 directions, tunnels through 2
    const w = o.w; o.w = o.d; o.d = w;
    if (o.type === 'stairs' || o.stairs) o.dir = ((o.dir || 0) + 1) % 4;
    else if (o.dir !== undefined) o.dir = ((o.dir || 0) + 1) % 2;
  }
  function rotate() {
    const p = selected();
    if (p) { if (p.type !== 'spawn') { editSelected(rotateProps); TG.Sound.play('click'); } return; }
    if (MF.PIECES[tool]) {
      const base = Object.assign({}, MF.PIECES[tool], lastProps[tool] || {});
      const o = { w: base.w, h: base.h, d: base.d, color: base.color, dir: base.dir, power: base.power, stairs: tool === 'stairs' };
      rotateProps(o);
      delete o.stairs;
      lastProps[tool] = o;
      TG.Sound.play('click');
      updateGhost();
    }
  }

  function deleteSelected() {
    const p = selected();
    if (!p) return;
    commit(() => {
      map.pieces = map.pieces.filter((q) => q !== p);
      removeGroup(p.id);
      selectedId = null;
    });
    TG.Sound.play('remove');
  }

  function duplicateSelected() {
    const p = selected();
    if (!p) return;
    commit(() => {
      const c = MF.fixPiece(Object.assign({}, p, { id: MF.makeId(), x: p.x + p.w }));
      map.pieces.push(c);
      rebuildPiece(c);
      selectedId = c.id;
    });
    TG.Sound.play('place');
  }

  function nudge(dx, dy, dz) {
    editSelected((p) => { p.x += dx; p.y = Math.round((p.y + dy) * 100) / 100; p.z += dz; });
  }

  // ---------- picking and placing ----------
  function pick() {
    syncCamera();
    scene.updateMatrixWorld();
    ray.setFromCamera(mouse, camera);
    const objs = [ground];
    piecesRoot.traverse((o) => { if (o.isMesh) objs.push(o); });
    const hits = ray.intersectObjects(objs, false);
    for (const h of hits) {
      if (h.object === ground) return { ground: true, point: h.point, normal: new THREE.Vector3(0, 1, 0) };
      const piece = findPiece(h.object.userData.pieceId);
      if (piece && h.face) return { piece, point: h.point, normal: h.face.normal.clone() };
    }
    return null;
  }

  function snapC(v, size) { return Math.round((v - size / 2) / gridStep) * gridStep + size / 2; }
  const r2 = (v) => Math.round(v * 100) / 100;

  function placementFor(hit, s) {
    const p = hit.point, n = hit.normal;
    if (hit.ground || n.y > 0.5) return { x: snapC(p.x, s.w), y: hit.ground ? 0 : r2(p.y), z: snapC(p.z, s.d) };
    if (n.y < -0.5) return { x: snapC(p.x, s.w), y: r2(p.y - s.h), z: snapC(p.z, s.d) };
    const q = hit.piece;
    if (Math.abs(n.x) > 0.5) {
      return { x: n.x > 0 ? q.x + q.w / 2 + s.w / 2 : q.x - q.w / 2 - s.w / 2, y: q.y, z: snapC(p.z, s.d) };
    }
    return { x: snapC(p.x, s.w), y: q.y, z: n.z > 0 ? q.z + q.d / 2 + s.d / 2 : q.z - q.d / 2 - s.d / 2 };
  }

  function newSize(type) {
    const def = MF.PIECES[type], lp = lastProps[type] || {};
    const p = MF.fixPiece(Object.assign({ type }, def, lp));
    return { w: p.w, h: p.h, d: p.d, color: p.color };
  }

  function updateGhost() {
    ghostPos = null;
    if (!active || testing || !mouseOver || looking || drag || !MF.PIECES[tool]) { ghost.visible = false; return; }
    const hit = pick();
    if (!hit) { ghost.visible = false; return; }
    const s = newSize(tool);
    const pos = placementFor(hit, s);
    const h = tool === 'spawn' ? 1.6 : s.h;
    ghost.scale.set(s.w, h, s.d);
    ghost.position.set(pos.x, pos.y + h / 2, pos.z);
    ghost.material.color.set(s.color);
    ghost.visible = true;
    ghostPos = pos;
  }

  function placeAtGhost() {
    if (!ghostPos) return;
    const pos = ghostPos;
    commit(() => {
      const p = MF.newPiece(tool, pos, lastProps[tool]);
      map.pieces.push(p);
      rebuildPiece(p);
      selectedId = p.id;
    });
    TG.Sound.play('place');
    updateGhost();
  }

  // ---------- pointer ----------
  function setMouse(e) {
    const r = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  function bindPointer() {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (!active) return;
      if (testing) { TG.TestPlay.onPointer('down', e); canvas.setPointerCapture(e.pointerId); return; }
      setMouse(e);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (e.button === 2 || e.button === 1) {
        looking = true;
        ghost.visible = false;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      if (MF.PIECES[tool]) { updateGhost(); placeAtGhost(); return; }
      const hit = pick();
      if (tool === 'erase') {
        if (hit && hit.piece) { selectedId = hit.piece.id; deleteSelected(); }
        return;
      }
      // select tool: click to pick, drag to slide it around
      if (hit && hit.piece) {
        select(hit.piece.id);
        drag = { id: hit.piece.id, y: hit.point.y, offX: hit.point.x - hit.piece.x, offZ: hit.point.z - hit.piece.z, moved: false };
        canvas.setPointerCapture(e.pointerId);
      } else select(null);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!active) return;
      if (testing) { TG.TestPlay.onPointer('move', e); return; }
      setMouse(e);
      mouseOver = true;
      if (looking) {
        cam.yaw -= e.movementX * 0.004;
        cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - e.movementY * 0.004));
        return;
      }
      if (drag) { dragMove(); return; }
      updateGhost();
    });
    const up = (e) => {
      if (testing) { TG.TestPlay.onPointer('up', e); return; }
      looking = false;
      if (drag) {
        if (drag.moved) { const p = findPiece(drag.id); if (p) rememberProps(p); changed(); }
        drag = null;
      }
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { mouseOver = false; ghost.visible = false; });
    canvas.addEventListener('wheel', (e) => {
      if (!active || testing) return;
      e.preventDefault();
      const f = forward3();
      const amt = -Math.sign(e.deltaY) * (I.down('ShiftLeft') ? 6 : 2.5);
      cam.x += f.x * amt; cam.y += f.y * amt; cam.z += f.z * amt;
      updateGhost();
    }, { passive: false });
  }

  const plane = new THREE.Plane(), tmp = new THREE.Vector3();
  function dragMove() {
    const p = findPiece(drag.id);
    if (!p) return;
    ray.setFromCamera(mouse, camera);
    plane.set(new THREE.Vector3(0, 1, 0), -drag.y);
    if (!ray.ray.intersectPlane(plane, tmp)) return;
    const nx = snapC(tmp.x - drag.offX, p.w), nz = snapC(tmp.z - drag.offZ, p.d);
    if (nx === p.x && nz === p.z) return;
    if (!drag.moved) { pushUndo(); drag.moved = true; }
    p.x = nx; p.z = nz;
    rebuildPiece(p);
    updateSelBox();
  }

  function forward3() {
    const cp = Math.cos(cam.pitch);
    return { x: -Math.sin(cam.yaw) * cp, y: Math.sin(cam.pitch), z: -Math.cos(cam.yaw) * cp };
  }
  // the world direction (snapped to x or z) closest to where the camera faces
  function axisDir(right) {
    let fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
    if (right) { const t = fx; fx = -fz; fz = t; }
    return Math.abs(fx) > Math.abs(fz) ? [Math.sign(fx), 0] : [0, Math.sign(fz)];
  }

  // ---------- per frame ----------
  function update(dt) {
    if (!active) return;
    if (testing) { TG.TestPlay.update(dt); return; }
    const ctrl = I.ctrl();

    if (ctrl) {
      if (I.pressed('KeyZ')) { if (I.down('ShiftLeft') || I.down('ShiftRight')) redo(); else undo(); }
      if (I.pressed('KeyY')) redo();
      if (I.pressed('KeyD')) duplicateSelected();
      if (I.pressed('KeyS')) saveMap();
    } else {
      // fly the camera
      const sp = (I.down('ShiftLeft') || I.down('ShiftRight') ? 36 : 14) * dt;
      const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
      const ix = (I.down('KeyD') ? 1 : 0) - (I.down('KeyA') ? 1 : 0);
      const iz = (I.down('KeyW') ? 1 : 0) - (I.down('KeyS') ? 1 : 0);
      const iy = (I.down('KeyE') ? 1 : 0) - (I.down('KeyQ') ? 1 : 0);
      if (ix || iz || iy) {
        cam.x += (fx * iz - fz * ix) * sp;
        cam.z += (fz * iz + fx * ix) * sp;
        cam.y += iy * sp;
        updateGhost();
      }
      for (const t of TOOLS) if (I.pressed(t.key)) setTool(t.id);
      if (I.pressed('KeyR')) rotate();
      if (I.pressed('KeyG')) { gridStep = gridStep === 1 ? 0.5 : 1; rebuildEnv(); toast('Grid: ' + gridStep); }
      if (I.pressed('Delete') || I.pressed('Backspace')) deleteSelected();
      if (I.pressed('Escape')) { select(null); setTool('select'); }
      if (I.pressed('KeyT')) startTest();
      if (selected()) {
        const step = gridStep;
        if (I.pressed('ArrowUp')) { const a = axisDir(false); nudge(a[0] * step, 0, a[1] * step); }
        if (I.pressed('ArrowDown')) { const a = axisDir(false); nudge(-a[0] * step, 0, -a[1] * step); }
        if (I.pressed('ArrowRight')) { const a = axisDir(true); nudge(a[0] * step, 0, a[1] * step); }
        if (I.pressed('ArrowLeft')) { const a = axisDir(true); nudge(-a[0] * step, 0, -a[1] * step); }
        if (I.pressed('PageUp')) nudge(0, 0.5, 0);
        if (I.pressed('PageDown')) nudge(0, -0.5, 0);
      }
    }
    syncCamera();
  }

  function syncCamera() {
    camera.position.set(cam.x, cam.y, cam.z);
    camera.rotation.set(cam.pitch, cam.yaw, 0);
    camera.updateMatrixWorld();
  }

  function render() { renderer.render(scene, camera); }

  // ---------- test play ----------
  function startTest() {
    if (testing) return;
    testing = true;
    for (const g of groups.values()) if (g.userData.editorOnly) g.visible = false;
    grid.visible = false; ghost.visible = false; selBox.visible = false;
    $('editor-ui').hidden = true;
    if (!MF.spawnsOf(map).length) toast('No spawn yet, so you start in the middle. Add a ⭐ Spawn!');
    TG.TestPlay.start({
      scene, camera, map,
      onExit() {
        testing = false;
        for (const g of groups.values()) g.visible = true;
        grid.visible = true;
        $('editor-ui').hidden = false;
        updateSelBox();
      },
    });
  }

  // ---------- UI ----------
  function buildToolbar() {
    const nav = $('ed-tools');
    nav.innerHTML = TOOLS.map((t, i) =>
      `<button data-tool="${t.id}" title="${t.label} (${i + 1})"><span class="ico">${t.icon}</span><span>${t.label}</span><kbd>${i + 1}</kbd></button>`).join('');
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tool]');
      if (b) { setTool(b.dataset.tool); b.blur(); }
    });
  }

  function setTool(id) {
    tool = id;
    for (const b of document.querySelectorAll('#ed-tools button')) b.classList.toggle('on', b.dataset.tool === id);
    canvas.style.cursor = id === 'erase' ? 'not-allowed' : id === 'select' ? 'pointer' : 'crosshair';
    updateGhost();
  }

  function toast(msg) {
    const t = $('ed-toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function saveMap() {
    map.name = $('ed-name').value.trim() || 'My Map';
    if (TG.Store.save(map)) { toast('Saved “' + map.name + '”!'); TG.Sound.play('place'); }
    else toast('Could not save in this browser. Try Export instead.');
  }

  function exportMap() {
    const blob = new Blob([JSON.stringify(map, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (map.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'map') + '.tagmap.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function openDialog() {
    const all = Object.values(TG.Store.all()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const list = $('ed-open-list');
    list.innerHTML = all.length
      ? all.map((m) => `<li><span>${esc(m.name)} <small>${(m.pieces || []).length} pieces</small></span>
          <span><button data-open="${esc(m.id)}">Open</button> <button class="danger" data-del="${esc(m.id)}">Delete</button></span></li>`).join('')
      : '<li class="empty">No saved maps yet. Click Save to keep one here.</li>';
    $('ed-open').showModal();
  }

  function newDialog() {
    $('ed-new-list').innerHTML = Object.entries(MF.THEMES).map(([k, t]) =>
      `<button data-theme="${k}" style="--sw:${t.sky};--fl:${t.floorColor}"><i></i>${t.label}</button>`).join('');
    $('ed-new').showModal();
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function bindUI() {
    $('ed-top').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      b.blur();
      const act = b.dataset.act;
      if (act === 'menu') TG.Main.showMenu();
      else if (act === 'new') newDialog();
      else if (act === 'open') openDialog();
      else if (act === 'save') saveMap();
      else if (act === 'export') exportMap();
      else if (act === 'import') $('ed-file').click();
      else if (act === 'undo') undo();
      else if (act === 'redo') redo();
      else if (act === 'test') startTest();
    });
    $('ed-name').addEventListener('change', () => {
      commit(() => { map.name = $('ed-name').value.trim().slice(0, 30) || 'My Map'; });
    });
    $('ed-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

    $('ed-file').addEventListener('change', () => {
      const f = $('ed-file').files[0];
      $('ed-file').value = '';
      if (!f) return;
      f.text().then((txt) => {
        const m = MF.fixMap(JSON.parse(txt));
        m.id = MF.makeId('m');
        loadMap(m);
        toast('Loaded “' + m.name + '”');
      }).catch(() => toast('That file is not a map.'));
    });

    $('ed-open').addEventListener('click', (e) => {
      const all = TG.Store.all();
      const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
      if (o && all[o.dataset.open]) { loadMap(all[o.dataset.open]); $('ed-open').close(); toast('Opened “' + map.name + '”'); }
      if (d && all[d.dataset.del] && confirm('Delete “' + all[d.dataset.del].name + '” forever?')) { TG.Store.remove(d.dataset.del); openDialog(); }
      if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
    });
    $('ed-new').addEventListener('click', (e) => {
      const t = e.target.closest('[data-theme]');
      if (t) { loadMap(MF.newMap(t.dataset.theme)); $('ed-new').close(); toast('New map! Start building.'); }
      if (e.target.closest('[data-close]')) $('ed-new').close();
    });

    const panel = $('ed-panel');
    panel.addEventListener('change', onPanelChange);
    panel.addEventListener('click', onPanelClick);
  }

  function field(label, key, val, step, min) {
    return `<label>${label}<input type="number" data-f="${key}" value="${+val.toFixed(2)}" step="${step}" ${min !== undefined ? `min="${min}"` : ''}></label>`;
  }

  function refreshPanel() {
    if (!map) return;
    const p = selected();
    let html = '';
    if (p) {
      const def = MF.PIECES[p.type];
      html += `<section class="card"><h3>${def.label}</h3>`;
      html += '<div class="grid3">' + field('X', 'x', p.x, gridStep) + field('Y (up)', 'y', p.y, 0.5) + field('Z', 'z', p.z, gridStep) + '</div>';
      if (p.type !== 'spawn') {
        html += '<div class="grid3">' + field('Width', 'w', p.w, 0.5, 0.2) + field('Height', 'h', p.h, 0.5, 0.1) + field('Depth', 'd', p.d, 0.5, 0.2) + '</div>';
        html += `<div class="swatches">${SWATCHES.map((c) => `<button class="sw${c === p.color ? ' on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
          <label class="sw custom" title="Pick any color"><input type="color" data-f="color" value="${p.color}"></label></div>`;
      }
      if (p.type === 'pad') html += `<label class="row">Bounce <input type="range" data-f="power" min="8" max="35" step="1" value="${p.power}"><b>${p.power}</b></label>`;
      if (p.type === 'stairs') html += '<p class="hint">Stairs go up toward the darker end. Steps are never taller than 0.4, so players can always walk up.</p>';
      if (p.type === 'tunnel') html += '<p class="hint">The hole is 1.1 tall, so you have to crawl (C) to get through.</p>';
      html += '<div class="btnrow">';
      if (p.type !== 'spawn') html += '<button data-pa="rotate">↻ Turn <kbd>R</kbd></button>';
      html += '<button data-pa="dup">⧉ Copy</button><button class="danger" data-pa="del">🗑 Delete</button></div>';
      html += '<p class="hint">Arrows move it · PgUp/PgDn raise or lower it</p></section>';
    } else {
      const tl = TOOLS.find((t) => t.id === tool);
      html += `<section class="card"><h3>${tl.icon} ${tl.label}</h3><p class="hint">${toolHint(tool)}</p></section>`;
    }
    const s = map.settings;
    const spawns = map.pieces.filter((q) => q.type === 'spawn').length;
    html += `<details class="card" ${refreshPanel.open ? 'open' : ''} id="ed-settings"><summary>🌍 Map settings</summary>
      <label class="row">Look <select data-s="theme">${Object.entries(MF.THEMES).map(([k, t]) => `<option value="${k}" ${k === s.theme ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
      <label class="row">Sky <input type="color" data-s="sky" value="${s.sky}"></label>
      <label class="row"><input type="checkbox" data-s="floor" ${s.floor ? 'checked' : ''}> Ground</label>
      <label class="row">Ground color <input type="color" data-s="floorColor" value="${s.floorColor}"></label>
      <label class="row"><input type="checkbox" data-s="walls" ${s.walls ? 'checked' : ''}> Edge walls (off = you can fall off)</label>
      <label class="row">Size <input type="range" data-s="size" min="20" max="200" step="10" value="${s.size}"><b>${s.size}</b></label>
      <label class="row">Gravity <input type="range" data-s="gravity" min="6" max="45" step="1" value="${s.gravity}"><b>${s.gravity}</b></label>
      <label class="row">Fog <input type="range" data-s="fogDensity" min="0" max="0.06" step="0.002" value="${s.fogDensity}"><b>${s.fogDensity}</b></label>
      <label class="row">Light <input type="range" data-s="sun" min="0" max="2" step="0.05" value="${s.sun}"><b>${s.sun}</b></label>
      <label class="row"><input type="checkbox" data-s="stars" ${s.stars ? 'checked' : ''}> Stars</label>
      <label class="row"><input type="checkbox" data-s="grid" ${s.grid ? 'checked' : ''}> Neon grid floor</label>
    </details>
    <p class="stats">${map.pieces.length} pieces · ${spawns} spawn${spawns === 1 ? '' : 's'}${spawns < 8 ? ' <span class="warn">(8 spawns is best for 8 players)</span>' : ''}</p>`;
    $('ed-panel').innerHTML = html;
    $('ed-settings').addEventListener('toggle', (e) => { refreshPanel.open = e.target.open; });
  }

  function toolHint(t) {
    return {
      select: 'Click a piece to pick it. Drag it to slide it around. Arrows move it, PgUp/PgDn lift it.',
      box: 'Click to put a block down. Click on top of a block to stack. Pick it after to change size and color.',
      stairs: 'Click to place stairs. Press R to turn them. Steps are always small enough to walk up.',
      tunnel: 'A block with a low hole through it. Players have to crawl (C) to get through. R turns it.',
      pad: 'Step on it to fly up high! Change Bounce to go higher.',
      spawn: 'Where players start. Put up to 8 around the map.',
      erase: 'Click a piece to delete it. Oops? Ctrl+Z.',
    }[t];
  }

  function onPanelChange(e) {
    const el = e.target;
    if (el.dataset.f) {
      const k = el.dataset.f;
      const v = k === 'color' ? el.value : parseFloat(el.value);
      if (k !== 'color' && !Number.isFinite(v)) { refreshPanel(); return; }
      editSelected((p) => { p[k] = v; });
    } else if (el.dataset.s) {
      const k = el.dataset.s;
      commit(() => {
        if (k === 'theme') {
          const keep = map.settings.size;
          map.settings = MF.defaultSettings(el.value);
          map.settings.size = keep;
        } else if (el.type === 'checkbox') map.settings[k] = el.checked;
        else if (el.type === 'color') map.settings[k] = el.value;
        else map.settings[k] = parseFloat(el.value);
        map.settings = MF.fixMap({ settings: map.settings }).settings;
        rebuildEnv();
      });
    }
  }

  function onPanelClick(e) {
    const c = e.target.closest('[data-color]');
    if (c) { editSelected((p) => { p.color = c.dataset.color; }); return; }
    const a = e.target.closest('[data-pa]');
    if (!a) return;
    if (a.dataset.pa === 'rotate') rotate();
    else if (a.dataset.pa === 'dup') duplicateSelected();
    else if (a.dataset.pa === 'del') deleteSelected();
  }

  TG.Editor = { init, enter, exit, update, render, resize, isActive: () => active, getMap: () => map, debug: () => ({ ghostPos, cam, tool }) };
})();
