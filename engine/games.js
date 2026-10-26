// ─── ChloeGames — modular game harness ───
// Registry + per-channel game index + per-game settings + shared stats.
// Parser-safe plain JS (no imports, no DOM, no Math.random, no wall-clock):
// loaded BEFORE engine.js in the bundle (see src/tools/build-engine.js).
// Store IO is injected by the engine (io.get/io.set return values or Promises).
// A future game ships as: one def object + ChloeGames.register(def) + its own
// state/stats keys via stateKey()/statsKey(). Wordle is the first def.
var ChloeGames = (function () {
  'use strict';
  var defs = {};
  function register(def) { if (def && def.id) defs[String(def.id)] = def; }
  function get(id) { return defs[String(id)] || null; }
  function list() {
    return Object.keys(defs).sort().map(function (id) { return defs[id]; });
  }
  // Per-channel keys. `games:<ch>` is the INDEX (active game + per-game
  // settings). Each game owns `stateKey` (current table) + `statsKey`
  // (leaderboard), so games never collide and export/import/reset can
  // enumerate them by prefix.
  function indexKey(ch) { return 'games:' + ch; }
  function stateKey(id, ch) { return String(id) + ':' + ch; }
  function statsKey(id, ch) { return String(id) + 'stats:' + ch; }

  function defaultIndex() { return { active: null, settings: {} }; }
  // Rule R: never trust the stored shape — a string where an object should be
  // substring-matches, arrays pass truthiness, numbers pass through. Rebuild.
  function sanitizeSettings(def, raw) {
    var clean = def.defaultSettings();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
    var sch = def.schema();
    Object.keys(sch).forEach(function (k) {
      if (raw[k] === undefined) return;
      var r = parseSettingValue(def, k, raw[k]);
      if (r.ok) clean[k] = r.value;   // invalid stored values fall back to default
    });
    return clean;
  }
  function validateIndex(raw) {
    var idx = defaultIndex();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return idx;
    if (typeof raw.active === 'string' && defs[raw.active]) idx.active = raw.active;
    if (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
      Object.keys(raw.settings).forEach(function (gid) {
        var d = defs[gid]; if (!d) return;   // unknown game: drop (a removed game never revives)
        idx.settings[gid] = sanitizeSettings(d, raw.settings[gid]);
      });
    }
    return idx;
  }
  function schemaKey(def, key) {
    var want = String(key == null ? '' : key).toLowerCase();
    var names = Object.keys(def.schema());
    for (var i = 0; i < names.length; i++) { if (names[i].toLowerCase() === want) return names[i]; }
    return null;
  }
  function getSettings(idx, id) {
    var d = defs[id]; if (!d) return null;
    var stored = (idx && idx.settings && idx.settings[id]) || {};
    var merged = d.defaultSettings();
    var sch = d.schema();
    Object.keys(sch).forEach(function (k) { if (stored[k] !== undefined) merged[k] = stored[k]; });
    return merged;
  }
  // rawStr accepts real values too (stored shapes, panel controls) — strings
  // from chat are just the common case. Always validates; never throws.
  function parseSettingValue(def, key, rawStr) {
    var canon = schemaKey(def, key);
    if (!canon) return { ok: false, reason: 'unknown setting "' + String(key).slice(0, 24) + '" (try: ' + Object.keys(def.schema()).join(', ') + ')' };
    key = canon;
    var sch = def.schema()[key];
    if (sch.type === 'bool') {
      if (rawStr === true || rawStr === 1) return { ok: true, value: true };
      if (rawStr === false || rawStr === 0) return { ok: true, value: false };
      var s = String(rawStr == null ? '' : rawStr).trim().toLowerCase();
      if (s === 'on' || s === 'true' || s === 'yes' || s === '1') return { ok: true, value: true };
      if (s === 'off' || s === 'false' || s === 'no' || s === '0') return { ok: true, value: false };
      return { ok: false, reason: '"' + key + '" wants on|off' };
    }
    if (sch.type === 'int') {
      var n = Math.floor(Number(rawStr));
      if (!isFinite(n)) return { ok: false, reason: '"' + key + '" wants a number (' + sch.min + '..' + sch.max + ')' };
      if (n < sch.min || n > sch.max) return { ok: false, reason: '"' + key + '" must be ' + sch.min + '..' + sch.max };
      return { ok: true, value: n };
    }
    if (sch.type === 'enum') {
      var v = String(rawStr == null ? '' : rawStr).trim().toLowerCase();
      if (sch.values.indexOf(v) >= 0) return { ok: true, value: v };
      return { ok: false, reason: '"' + key + '" must be ' + sch.values.join('|') };
    }
    return { ok: false, reason: 'bad schema for "' + key + '"' };
  }
  function setSetting(idx, id, key, rawStr) {
    var d = defs[id];
    if (!d) return { ok: false, reason: 'unknown game "' + String(id).slice(0, 24) + '" (try: game list)' };
    var canon = schemaKey(d, key);
    if (!canon) return { ok: false, reason: 'unknown setting "' + String(key).slice(0, 24) + '" (try: ' + Object.keys(d.schema()).join(', ') + ')' };
    var r = parseSettingValue(d, canon, rawStr);
    if (!r.ok) return r;
    if (!idx.settings || typeof idx.settings !== 'object') idx.settings = {};
    var cur = getSettings(idx, id); cur[canon] = r.value; idx.settings[id] = cur;
    return { ok: true, value: r.value, settings: cur };
  }
  function describeSettings(def, settings) {
    var sch = def.schema();
    return Object.keys(sch).map(function (k) { return k + ' ' + String(settings[k]) + ' (' + sch[k].blurb + ')'; }).join(' · ');
  }

  // Shared stats (leaderboard index): uid -> {name, played, won, streak, maxStreak, lastDay}.
  // `played` counts days with at least one guess; unfinished days don't break a streak.
  function validateStats(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (uid) {
      if (!/^\d{8,32}$/.test(uid)) return;
      var e = raw[uid];
      if (!e || typeof e !== 'object') return;
      function num(v) { v = Number(v); return (isFinite(v) && v >= 0) ? Math.floor(v) : 0; }
      out[uid] = {
        name: String(e.name || 'someone').slice(0, 32),
        played: num(e.played), won: num(e.won),
        streak: num(e.streak), maxStreak: num(e.maxStreak),
        lastDay: (typeof e.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.lastDay)) ? e.lastDay : ''
      };
    });
    return out;
  }
  function notePlayed(stats, uid, name, day) {
    var e = stats[uid] || (stats[uid] = { name: name, played: 0, won: 0, streak: 0, maxStreak: 0, lastDay: '' });
    e.name = String(name || e.name || 'someone').slice(0, 32);
    if (e.lastDay !== day) { e.played++; e.lastDay = day; }
  }
  function noteFinished(stats, uid, won) {
    var e = stats[uid] || (stats[uid] = { name: 'someone', played: 0, won: 0, streak: 0, maxStreak: 0, lastDay: '' });
    if (won) { e.won++; e.streak++; if (e.streak > e.maxStreak) e.maxStreak = e.streak; }
    else { e.streak = 0; }
  }
  function leaderboard(stats) {
    return Object.keys(stats).map(function (uid) { return stats[uid]; }).sort(function (a, b) {
      if (b.maxStreak !== a.maxStreak) return b.maxStreak - a.maxStreak;
      if (b.won !== a.won) return b.won - a.won;
      return b.played - a.played;
    });
  }

  // Promise IO over the engine's store (values or Promises both fine).
  function loadIndex(io, ch) {
    return Promise.resolve(io.get(indexKey(ch))).then(function (v) { return validateIndex(v); });
  }
  function saveIndex(io, ch, idx) { return Promise.resolve(io.set(indexKey(ch), idx)).then(function () { return idx; }); }

  return {
    register: register, get: get, list: list,
    indexKey: indexKey, stateKey: stateKey, statsKey: statsKey,
    defaultIndex: defaultIndex, validateIndex: validateIndex,
    getSettings: getSettings, setSetting: setSetting, describeSettings: describeSettings,
    parseSettingValue: parseSettingValue,
    validateStats: validateStats, notePlayed: notePlayed, noteFinished: noteFinished,
    leaderboard: leaderboard, loadIndex: loadIndex, saveIndex: saveIndex
  };
})();
