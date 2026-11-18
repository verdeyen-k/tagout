// Player movement and box (AABB) collisions. Pure math, no THREE, so it can run on a server later.
(function () {
  'use strict';
  const TG = (window.TG = window.TG || {});

  const C = {
    walk: 6.2, run: 9.8, crawl: 3.0,
    standH: 1.7, crawlH: 0.82, radius: 0.38,
    baseG: 30, jumpH: 2.0, djumpH: 1.5,
    dashSpeed: 24, dashTime: 0.18, dashCd: 1.4,
    backSpeed: 19, backTime: 0.16, backCd: 1.1,
    stamina: 3.0, staminaRefill: 2.5,
    stepUp: 0.45, fallY: -25, coyote: 0.1, maxFall: 45,
  };
  C.jumpV = Math.sqrt(2 * C.baseG * C.jumpH);
  C.djumpV = Math.sqrt(2 * C.baseG * C.djumpH);
  const EPS = 1e-4;

  function hits(c, x, y, z, r, h) {
    return x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ && y + h > c.minY && y < c.maxY;
  }
  function anyHit(cols, x, y, z, r, h) {
    for (let i = 0; i < cols.length; i++) if (hits(cols[i], x, y, z, r, h)) return cols[i];
    return null;
  }
  function groundUnder(cols, x, y, z, r) {
    let best = null;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ && c.maxY <= y + 0.02 && c.maxY >= y - 0.06) {
        if (!best || c.maxY > best.maxY) best = c;
      }
    }
    return best;
  }
  function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  function createBody(x, y, z) {
    return {
      x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, speed: 0,
      grounded: false, coyote: 0, jumps: 0, airDash: false,
      crawling: false, h: C.standH,
      dashT: 0, backT: 0, dashCd: 0, backCd: 0, dashX: 0, dashZ: 0,
      stamina: C.stamina, exhausted: false, running: false,
      frozen: 0, events: [],
    };
  }

  function respawn(b, x, y, z, freeze) {
    b.x = x; b.y = y; b.z = z;
    b.vx = b.vy = b.vz = 0;
    b.dashT = b.backT = 0;
    b.grounded = false; b.jumps = 0;
    b.frozen = freeze || 0;
  }

  function moveX(b, cols, dx) {
    const r = C.radius;
    b.x += dx;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!hits(c, b.x, b.y, b.z, r, b.h)) continue;
      const rise = c.maxY - b.y;
      if ((b.grounded || b.coyote > 0) && rise > 0 && rise <= C.stepUp && !anyHit(cols, b.x, c.maxY + EPS, b.z, r, b.h)) {
        b.y = c.maxY + EPS;
        continue;
      }
      b.x = dx > 0 ? c.minX - r - EPS : c.maxX + r + EPS;
      b.vx = 0;
    }
  }
  function moveZ(b, cols, dz) {
    const r = C.radius;
    b.z += dz;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!hits(c, b.x, b.y, b.z, r, b.h)) continue;
      const rise = c.maxY - b.y;
      if ((b.grounded || b.coyote > 0) && rise > 0 && rise <= C.stepUp && !anyHit(cols, b.x, c.maxY + EPS, b.z, r, b.h)) {
        b.y = c.maxY + EPS;
        continue;
      }
      b.z = dz > 0 ? c.minZ - r - EPS : c.maxZ + r + EPS;
      b.vz = 0;
    }
  }
  function moveY(b, cols, dy) {
    const r = C.radius * 0.98;
    b.y += dy;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!hits(c, b.x, b.y, b.z, r, b.h)) continue;
      if (dy <= 0) b.y = c.maxY;
      else b.y = c.minY - b.h - EPS;
      b.vy = 0;
    }
  }

  // inp: { mx, mz (world-space move dir), run, crawl (held), jump, dash, back (pressed this frame) }
  // world: { colliders, gravity, speedMul }
  function step(b, inp, world, dt) {
    const ev = b.events;
    ev.length = 0;
    const cols = world.colliders, g = world.gravity || C.baseG, mul = world.speedMul || 1;
    b.dashCd = Math.max(0, b.dashCd - dt);
    b.backCd = Math.max(0, b.backCd - dt);
    b.frozen = Math.max(0, b.frozen - dt);
    const frozen = b.frozen > 0;

    // crawl (can't stand up under a low ceiling)
    if (inp.crawl) {
      if (!b.crawling) { b.crawling = true; b.h = C.crawlH; }
    } else if (b.crawling && !anyHit(cols, b.x, b.y, b.z, C.radius * 0.98, C.standH)) {
      b.crawling = false; b.h = C.standH;
    }

    let mx = frozen ? 0 : inp.mx || 0, mz = frozen ? 0 : inp.mz || 0;
    let len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; len = 1; }
    const moving = len > 0.1;

    // running uses stamina; when it runs out you must fully recover
    const wantRun = inp.run && moving && !b.crawling && !b.exhausted;
    if (wantRun) {
      b.stamina -= dt;
      if (b.stamina <= 0) { b.stamina = 0; b.exhausted = true; }
    } else {
      b.stamina = Math.min(C.stamina, b.stamina + (dt * C.stamina) / C.staminaRefill);
      if (b.exhausted && b.stamina >= C.stamina) b.exhausted = false;
    }
    b.running = wantRun && !b.exhausted;
    const speed = (b.crawling ? C.crawl : b.running ? C.run : C.walk) * mul;

    if (moving && b.backT <= 0) b.yaw = lerpAngle(b.yaw, Math.atan2(mx, mz), Math.min(1, dt * 15));

    // dash (once per airtime) and back dash
    if (inp.dash && !frozen && !b.crawling && b.dashCd <= 0 && b.dashT <= 0 && b.backT <= 0 && (b.grounded || !b.airDash)) {
      let dx = Math.sin(b.yaw), dz = Math.cos(b.yaw);
      if (moving) { dx = mx / len; dz = mz / len; b.yaw = Math.atan2(dx, dz); }
      b.dashT = C.dashTime; b.dashCd = C.dashCd; b.dashX = dx; b.dashZ = dz;
      if (!b.grounded) b.airDash = true;
      ev.push('dash');
    }
    if (inp.back && !frozen && !b.crawling && b.backCd <= 0 && b.dashT <= 0 && b.backT <= 0) {
      b.backT = C.backTime; b.backCd = C.backCd;
      b.dashX = -Math.sin(b.yaw); b.dashZ = -Math.cos(b.yaw);
      ev.push('backdash');
    }

    // jump and double jump
    if (inp.jump && !frozen && !b.crawling) {
      if (b.grounded || b.coyote > 0) {
        b.vy = C.jumpV; b.grounded = false; b.coyote = 0; b.jumps = 1;
        ev.push('jump');
      } else if (b.jumps < 2) {
        b.vy = C.djumpV; b.jumps = 2;
        ev.push('djump');
      }
    }

    // horizontal velocity
    if (b.dashT > 0 || b.backT > 0) {
      const back = b.backT > 0;
      const sp = (back ? C.backSpeed : C.dashSpeed) * mul;
      b.vx = b.dashX * sp; b.vz = b.dashZ * sp; b.vy = 0;
      if (back) b.backT -= dt; else b.dashT -= dt;
      if (b.dashT <= 0 && b.backT <= 0) {
        const keep = back ? C.walk * mul : speed;
        b.vx = b.dashX * keep; b.vz = b.dashZ * keep;
        b.dashT = 0; b.backT = 0;
      }
    } else {
      const tx = mx * speed, tz = mz * speed, a = (b.grounded ? 60 : 24) * dt;
      const ex = tx - b.vx, ez = tz - b.vz, el = Math.hypot(ex, ez);
      if (el <= a) { b.vx = tx; b.vz = tz; } else { b.vx += (ex / el) * a; b.vz += (ez / el) * a; }
      b.vy = Math.max(-C.maxFall, b.vy - g * dt);
    }

    // move in small steps so fast dashes can't pass through thin walls
    const n = Math.max(1, Math.ceil(dt * 120)), s = dt / n;
    for (let i = 0; i < n; i++) {
      moveX(b, cols, b.vx * s);
      moveZ(b, cols, b.vz * s);
      moveY(b, cols, b.vy * s);
    }

    const was = b.grounded;
    const ground = b.vy <= 0 ? groundUnder(cols, b.x, b.y, b.z, C.radius * 0.98) : null;
    if (ground) {
      b.grounded = true; b.jumps = 0; b.airDash = false; b.coyote = C.coyote;
      if (b.vy < 0) b.vy = 0;
      if (ground.kind === 'pad' && !frozen) {
        b.vy = ground.power; b.grounded = false; b.coyote = 0; b.jumps = 1;
        ev.push('pad');
      } else if (!was) ev.push('land');
    } else {
      b.grounded = false;
      b.coyote = Math.max(0, b.coyote - dt);
    }
    if (b.y < C.fallY) ev.push('fell');
    b.speed = Math.hypot(b.vx, b.vz);
  }

  // Distance along a ray until it hits a box (used to pull the camera in front of walls).
  function rayBoxes(cols, o, d, maxT) {
    let best = maxT;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const mn = [c.minX, c.minY, c.minZ], mxv = [c.maxX, c.maxY, c.maxZ];
      let t0 = 0, t1 = best, inside = true, miss = false;
      for (let k = 0; k < 3; k++) {
        if (o[k] < mn[k] || o[k] > mxv[k]) inside = false;
        if (Math.abs(d[k]) < 1e-9) {
          if (o[k] < mn[k] || o[k] > mxv[k]) { miss = true; break; }
        } else {
          let a = (mn[k] - o[k]) / d[k], bb = (mxv[k] - o[k]) / d[k];
          if (a > bb) { const t = a; a = bb; bb = t; }
          if (a > t0) t0 = a;
          if (bb < t1) t1 = bb;
          if (t0 > t1) { miss = true; break; }
        }
      }
      if (!miss && !inside && t0 < best) best = t0;
    }
    return best;
  }

  TG.Physics = { C, createBody, respawn, step, rayBoxes, anyHit };
})();
