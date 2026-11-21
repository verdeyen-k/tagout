// Online rooms on the family Firebase database (kvgames), under tagout/rooms/<CODE>.
// Only game moves go through here: hats (from the fixed list), positions and tags.
// No names, no chat, no free text. Online, players are called by their color.
(function () {
  'use strict';
  const TG = window.TG;
  const VERSION = 1;
  const ROOMS = 'tagout/rooms';
  const MAX = 8;

  let db = null;
  try {
    if (window.firebase) {
      firebase.initializeApp({
        apiKey: 'AIzaSyAsJboNGVuESMhkivllUD0o8MUB5LUCMRQ',
        authDomain: 'kvgames.firebaseapp.com',
        databaseURL: 'https://kvgames-default-rtdb.firebaseio.com',
        projectId: 'kvgames',
        storageBucket: 'kvgames.firebasestorage.app',
        messagingSenderId: '463308384695',
        appId: '1:463308384695:web:5d57623ebd52101ad26032',
      });
      db = firebase.database();
    }
  } catch (e) { db = null; }

  const myId = 'p' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const HATS = () => TG.HATS.map((h) => h.id);
  const okHat = (h) => (HATS().includes(h) ? h : 'none');
  const okSlot = (s) => (Number.isInteger(s) && s >= 0 && s < MAX ? s : -1);
  const okKey = (k) => typeof k === 'string' && /^[a-z0-9]{1,24}$/i.test(k);
  const toArr = (v) => (!v ? [] : Array.isArray(v) ? v.filter((x) => x != null) : Object.keys(v).sort((a, b) => a - b).map((k) => v[k]));

  function genCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let s = '';
    for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  const NO_SERVER = "Can't reach the game server. Check the internet.";
  const friendly = (e, fallback) => (e && e.message && !/^FIREBASE|permission|PERMISSION/.test(e.message) ? e.message : fallback);

  // Clean what other computers sent us: only known hats, slots and settings get through.
  function cleanPlayers(raw) {
    const out = [];
    for (const [id, p] of Object.entries(raw || {})) {
      if (!okKey(id) || !p) continue;
      const slot = okSlot(p.slot);
      if (slot < 0) continue;
      out.push({ id, slot, hat: okHat(p.hat) });
    }
    return out.sort((a, b) => a.slot - b.slot);
  }
  function cleanCfg(c) {
    c = c || {};
    return {
      roundLen: [30, 45, 60, 90].includes(c.roundLen) ? c.roundLen : 60,
      mapMode: typeof c.mapMode === 'string' && /^(rotate|random|map:[A-Za-z0-9_-]{1,60})$/.test(c.mapMode) ? c.mapMode : 'rotate',
      bots: Number.isInteger(c.bots) ? Math.max(0, Math.min(7, c.bots)) : 0,
      skill: ['easy', 'normal', 'hard'].includes(c.skill) ? c.skill : 'normal',
      mode: ['burning', 'treasure'].includes(c.mode) ? c.mode : 'classic',
    };
  }

  // A room you're in. Lobby state comes in through onChange; the game uses the channel methods below.
  function Room(code, ref, isHost) {
    const R = {
      code, ref, isHost, myId,
      players: [], cfg: cleanCfg(null), phase: 'lobby', gameId: null, gone: false,
      onChange: null, onGone: null, onGame: null,
      _offs: [],
    };
    const on = (r, ev, fn) => { r.on(ev, fn); R._offs.push(() => r.off(ev, fn)); };
    const changed = () => { if (R.onChange) R.onChange(R); };

    on(ref.child('v'), 'value', (s) => {
      if (s.val() == null && !R.gone) { R.gone = true; if (R.onGone) R.onGone(); }
    });
    on(ref.child('players'), 'value', (s) => { R.players = cleanPlayers(s.val()); changed(); });
    on(ref.child('cfg'), 'value', (s) => { R.cfg = cleanCfg(s.val()); changed(); });
    // When the host presses GO, the phase turns to 'game': read the game and start it.
    on(ref.child('phase'), 'value', (s) => {
      R.phase = s.val() === 'game' ? 'game' : 'lobby';
      changed();
      if (R.phase !== 'game') return;
      ref.child('game').once('value').then((g) => {
        const game = cleanGame(g.val());
        if (!game || game.id === R.gameId || R.gone) return;
        R.gameId = game.id;
        if (R.onGame) R.onGame(game);
      }).catch(() => {});
    });

    R.me = () => R.players.find((p) => p.id === myId) || null;
    R.setHat = (hat) => ref.child(`players/${myId}/hat`).set(okHat(hat)).catch(() => {});
    R.setCfg = (cfg) => { if (isHost) ref.child('cfg').set(cleanCfg(cfg)).catch(() => {}); };

    // host: start a game for everyone in the room
    R.startGame = (spec) => ref.update({ phase: 'game', game: spec, log: null, tags: null, pos: null });
    R.backToLobby = () => { if (isHost) ref.update({ phase: 'lobby', log: null, tags: null, pos: null }).catch(() => {}); };

    // ----- game channel -----
    let gameOffs = [];
    R.openGame = (h) => {
      R.closeGame();
      const add = (r, ev, fn) => { r.on(ev, fn); gameOffs.push(() => r.off(ev, fn)); };
      add(ref.child('log'), 'child_added', (s) => { const v = s.val(); if (v && typeof v.t === 'string') h.event(v); });
      const pos = (s) => {
        const v = s.val();
        if (!okKey(s.key) || !v || typeof v !== 'object') return;
        h.pos(s.key, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => v[i]));
      };
      add(ref.child('pos'), 'child_added', pos);
      add(ref.child('pos'), 'child_changed', pos);
      ref.child(`pos/${myId}`).onDisconnect().remove().catch(() => {});
      if (isHost) {
        add(ref.child('tags'), 'child_added', (s) => { const v = s.val(); if (v) h.claim(v); });
        add(ref.child('players'), 'child_removed', (s) => { if (okKey(s.key)) h.left(s.key); });
      }
    };
    R.closeGame = () => { for (const f of gameOffs) f(); gameOffs = []; };
    R.send = (ev) => ref.child('log').push(ev).catch(() => {});
    R.claim = (c) => ref.child('tags').push(c).catch(() => {});
    R.sendPos = (obj) => { if (!R.gone) ref.child('pos').update(obj).catch(() => {}); };

    R.leave = () => {
      R.closeGame();
      for (const f of R._offs) f();
      R._offs = [];
      R.gone = true;
      if (isHost) ref.remove().catch(() => {});
      else ref.child(`players/${myId}`).remove().catch(() => {});
      ref.onDisconnect().cancel().catch(() => {});
      ref.child(`players/${myId}`).onDisconnect().cancel().catch(() => {});
    };
    return R;
  }

  function cleanGame(g) {
    if (!g || typeof g.id !== 'string') return null;
    const roster = toArr(g.roster).filter((p) => p && okKey(p.key) && okSlot(p.slot) >= 0).map((p) => ({
      key: p.key, slot: p.slot, hat: okHat(p.hat), bot: !!p.bot,
      skill: ['easy', 'normal', 'hard'].includes(p.skill) ? p.skill : 'normal',
    }));
    const cfg = cleanCfg(g.cfg);
    let cmap = null;
    if (g.cmap && typeof g.cmap === 'object') {
      try { cmap = TG.MapFormat.fixMap(g.cmap); cmap.name = 'Custom map'; } catch (e) { cmap = null; }
    }
    return { id: g.id, roster, cfg, cmap };
  }

  async function createRoom(hat) {
    if (!db) throw new Error(NO_SERVER);
    try {
      let code, ref;
      for (let i = 0; i < 10; i++) {
        code = genCode();
        ref = db.ref(`${ROOMS}/${code}`);
        if (!(await ref.child('v').get()).exists()) break;
      }
      await ref.set({
        v: VERSION, host: myId, created: firebase.database.ServerValue.TIMESTAMP, phase: 'lobby',
        cfg: cleanCfg({ roundLen: 60, mapMode: 'rotate', bots: 2, skill: 'normal' }),
        players: { [myId]: { slot: 0, hat: okHat(hat) } },
      });
      ref.onDisconnect().remove();
      return Room(code, ref, true);
    } catch (e) {
      throw new Error(friendly(e, "Couldn't make a room. Ask your parent to check that Tag Out is turned on in the game server."));
    }
  }

  async function joinRoom(code, hat) {
    if (!db) throw new Error(NO_SERVER);
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) throw new Error('Room codes have 4 letters.');
    const ref = db.ref(`${ROOMS}/${code}`);
    try {
      const st = (await ref.get()).val();
      if (!st || !st.host) throw new Error(`There's no room ${code}.`);
      if (st.v !== VERSION) throw new Error('That room is using a different version of Tag Out. Everyone should refresh the page.');
      if (st.phase === 'game') throw new Error('That game already started. Wait for it to finish.');
      const res = await ref.child('players').transaction((cur) => {
        if (!cur) return;
        const taken = new Set(Object.values(cur).filter(Boolean).map((p) => p.slot));
        let slot = -1;
        for (let i = 0; i < MAX; i++) if (!taken.has(i)) { slot = i; break; }
        if (slot < 0) return;
        cur[myId] = { slot, hat: okHat(hat) };
        return cur;
      });
      if (!res.committed) throw new Error('That room is full (8 players).');
      ref.child(`players/${myId}`).onDisconnect().remove();
      return Room(code, ref, false);
    } catch (e) {
      throw new Error(friendly(e, "Couldn't join. Check the code and the internet."));
    }
  }

  TG.Net = { available: () => !!db, createRoom, joinRoom, myId, MAX };
})();
