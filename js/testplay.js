// "Test play": run around your map with the real moves, right from the map maker.
(function () {
  'use strict';
  const TG = (window.TG = window.TG || {});
  const P = TG.Physics, I = TG.Input;

  let st = null;
  const camTarget = new THREE.Vector3();
  const ui = {};

  function start(opts) {
    // opts: { scene, camera, map, canvas, onExit }
    const spawns = TG.MapFormat.spawnsOf(opts.map);
    const sp = spawns[0] || { x: 0, y: 4, z: 0 };
    const body = P.createBody(sp.x, sp.y + 0.05, sp.z);
    const ch = TG.makeCharacter(TG.COLORS[0].hex);
    opts.scene.add(ch.root);
    st = {
      opts, body, ch, spawn: sp,
      colliders: TG.MapFormat.collidersOf(opts.map),
      gravity: opts.map.settings.gravity,
      camYaw: Math.PI, camPitch: 0.35, camDist: 6.5,
      drag: false,
    };
    ui.root = document.getElementById('play-ui');
    ui.stamina = document.getElementById('stamina-fill');
    ui.status = document.getElementById('play-status');
    ui.root.hidden = false;
    I.clear();
  }

  function stop() {
    if (!st) return;
    st.opts.scene.remove(st.ch.root);
    st.ch.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    ui.root.hidden = true;
    const done = st.opts.onExit;
    st = null;
    I.clear();
    if (done) done();
  }

  function onPointer(type, e) {
    if (!st) return;
    if (type === 'down') st.drag = true;
    else if (type === 'up') st.drag = false;
    else if (type === 'move' && st.drag) {
      st.camYaw -= e.movementX * 0.006;
      st.camPitch = Math.max(-0.25, Math.min(1.25, st.camPitch + e.movementY * 0.004));
    }
  }

  function update(dt) {
    if (!st) return;
    if (I.pressed('Escape')) { stop(); return; }
    const b = st.body;

    if (I.down('KeyZ')) st.camYaw += 2.6 * dt;
    if (I.down('KeyX')) st.camYaw -= 2.6 * dt;

    const fx = -Math.sin(st.camYaw), fz = -Math.cos(st.camYaw); // camera forward
    const rx = Math.cos(st.camYaw), rz = -Math.sin(st.camYaw);  // camera right
    const ix = (I.down('KeyD') ? 1 : 0) - (I.down('KeyA') ? 1 : 0);
    const iz = (I.down('KeyW') ? 1 : 0) - (I.down('KeyS') ? 1 : 0);
    const combo = TG.Combos.read(dt);
    P.step(b, {
      mx: rx * ix + fx * iz,
      mz: rz * ix + fz * iz,
      run: I.down('ShiftLeft'),
      crawl: I.down('KeyC') || combo.crawl,
      jump: I.pressed('Space'),
      dash: I.pressed('KeyF') || combo.dash,
      back: I.pressed('KeyQ') || combo.back,
    }, { colliders: st.colliders, gravity: st.gravity }, dt);

    for (const e of b.events) {
      if (e === 'fell') {
        P.respawn(b, st.spawn.x, st.spawn.y + 0.05, st.spawn.z, 1);
        TG.Sound.play('fell');
      } else TG.Sound.play(e);
    }
    st.ch.update(b, dt);

    // follow camera, pulled in so it doesn't go inside walls
    const cam = st.opts.camera;
    camTarget.set(b.x, b.y + (b.crawling ? 0.8 : 1.4), b.z);
    const cp = Math.cos(st.camPitch);
    const d = [Math.sin(st.camYaw) * cp, Math.sin(st.camPitch), Math.cos(st.camYaw) * cp];
    const hit = P.rayBoxes(st.colliders, [camTarget.x, camTarget.y, camTarget.z], d, st.camDist);
    const dist = Math.max(0.6, Math.min(st.camDist, hit - 0.25));
    cam.position.set(camTarget.x + d[0] * dist, camTarget.y + d[1] * dist, camTarget.z + d[2] * dist);
    cam.lookAt(camTarget);

    ui.stamina.style.width = (b.stamina / P.C.stamina) * 100 + '%';
    ui.stamina.classList.toggle('tired', b.exhausted);
    const what = b.frozen > 0 ? 'Frozen!' : b.crawling ? 'Crawling' : b.dashT > 0 ? 'Dash!' : b.backT > 0 ? 'Back dash!' : !b.grounded ? (b.jumps >= 2 ? 'Double jump' : 'In the air') : b.running ? 'Running' : b.speed > 0.5 ? 'Walking' : 'Standing';
    ui.status.textContent = what;
  }

  TG.TestPlay = { start, stop, update, onPointer, isActive: () => !!st };
})();
