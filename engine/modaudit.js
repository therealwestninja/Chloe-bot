// ─── ChloeModAudit — Moderation & Auth spine (A-scope foundation) ───
// Pure, parser-safe JS (no imports, no DOM, no Math.random, no wall-clock):
// FNV-1a content hashing, hash-chained modlog entries, grant matching,
// clearance tiers. Loaded BEFORE engine.js in the bundle.
// Rule R: every entry point rebuilds defensively — stored shapes are untrusted.
// A3 (chain) + A4 (grants) + A7 (tiers) data model; enforcement lands in
// Phase 1 (chain wiring) and Phase 2 (approvals + grants).
var ChloeModAudit = (function () {
  'use strict';

  // FNV-1a 32-bit (same substrate as Rook home/hash.mjs). Deterministic
  // across save/load: the hashed string is built field-by-field, never
  // JSON.stringify of an object (key order must not matter).
  function fnv1a(str) {
    var h = 0x811c9dc5;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  // ─── A3: hash-chained modlog ───
  // Entry: {at, by, action, targetId?, reason?, prev, digest}.
  // digest = fnv1a(prev \x1f at \x1f by \x1f action \x1f targetId \x1f reason).
  // First chained entry uses prev 'GENESIS'. Entries written before chaining
  // existed carry no digest and are reported as pre-chain, never verified.
  var GENESIS = 'GENESIS';
  function chainDigest(prev, e) {
    return fnv1a([prev, e.at, e.by, e.action, e.targetId || '', e.reason || ''].join(''));
  }
  function cleanEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var at = Number(raw.at);
    if (!isFinite(at) || at < 0) return null;
    var action = String(raw.action || '').slice(0, 40);
    if (!action) return null;
    // by = who did it: appends historically use `byModId` ('panel', a mod id,
    // or 'auto'), never `by` — map it so old + new entries hash identically.
    var e = { at: Math.floor(at), by: String(raw.byModId || raw.by || 'unknown').slice(0, 64), action: action };
    if (raw.targetId != null) e.targetId = String(raw.targetId).slice(0, 32);
    if (raw.reason != null) e.reason = String(raw.reason).slice(0, 280);
    // Display passthrough (never hashed): the panel modlog view reads name,
    // byModId and context — chaining must not eat them.
    if (raw.name != null) e.name = String(raw.name).slice(0, 64);
    if (raw.byModId != null) e.byModId = String(raw.byModId).slice(0, 64);
    if (Array.isArray(raw.context)) {
      e.context = raw.context.slice(0, 5).map(function (c) {
        return { text: String((c && c.text) || '').slice(0, 200) };
      });
    }
    if (typeof raw.prev === 'string' && raw.prev) e.prev = raw.prev.slice(0, 16);
    if (typeof raw.digest === 'string' && raw.digest) e.digest = raw.digest.slice(0, 16);
    return e;
  }
  function appendChained(log, raw) {
    var list = Array.isArray(log) ? log.slice() : [];
    var e = cleanEntry(raw);
    if (!e) return { ok: false, reason: 'bad entry (needs at + action)' };
    var prev = GENESIS;
    for (var i = list.length - 1; i >= 0; i--) {
      var c = cleanEntry(list[i]);
      if (c && c.digest) { prev = c.digest; break; }
    }
    e.prev = prev;
    e.digest = chainDigest(prev, e);
    list.push(e);
    return { ok: true, value: list, entry: e };
  }
  // -> {ok, chained, preChain, badIndex}. ok=false names the first broken link.
  function verifyChain(log) {
    if (!Array.isArray(log)) return { ok: false, chained: 0, preChain: 0, badIndex: -1, reason: 'not a list' };
    var chained = 0, preChain = 0, prev = GENESIS;
    for (var i = 0; i < log.length; i++) {
      var e = cleanEntry(log[i]);
      if (!e || !e.digest) { preChain++; continue; }   // pre-chain history: counted, never verified
      if (e.prev !== prev) return { ok: false, chained: chained, preChain: preChain, badIndex: i, reason: 'link broken at entry ' + i };
      if (chainDigest(e.prev, e) !== e.digest) return { ok: false, chained: chained, preChain: preChain, badIndex: i, reason: 'digest mismatch at entry ' + i };
      prev = e.digest;
      chained++;
    }
    return { ok: true, chained: chained, preChain: preChain, badIndex: -1 };
  }

  // ─── A4: grants ───
  // Grant: {action, resource, scope, at, until?}. action = output class
  // (beats|checkins|lull|images — replies stay always-on except lockdown);
  // resource = channelId or '*' (global); scope 'session' expires after 24h,
  // 'always' never expires. Stored per channel; validated on load.
  var GRANT_ACTIONS = ['beats', 'checkins', 'lull', 'images'];
  var SESSION_MS = 86400000;
  function cleanGrant(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var action = String(raw.action || '').toLowerCase();
    if (GRANT_ACTIONS.indexOf(action) < 0) return null;
    var resource = String(raw.resource || '');
    if (resource !== '*' && !/^\d{8,32}$/.test(resource)) return null;
    var scope = String(raw.scope || '');
    if (scope !== 'session' && scope !== 'always') return null;
    var at = Number(raw.at);
    if (!isFinite(at) || at < 0) return null;
    var g = { action: action, resource: resource, scope: scope, at: Math.floor(at) };
    if (raw.until != null) { var u = Number(raw.until); if (isFinite(u) && u > 0) g.until = Math.floor(u); }
    return g;
  }
  function validateGrants(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length && out.length < 64; i++) {
      var g = cleanGrant(raw[i]);
      if (g) out.push(g);
    }
    return out;
  }
  function grant(action, resource, scope, now) {
    var g = cleanGrant({ action: action, resource: resource, scope: scope, at: now });
    if (!g) return null;
    if (g.scope === 'session') g.until = now + SESSION_MS;
    return g;
  }
  // Does any live grant cover (action, resource)? now-gated; exact channel
  // beats global('*') — a global grant covers every channel, never the reverse.
  function granted(grants, action, resource, now) {
    var list = validateGrants(grants);
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (g.action !== action) continue;
      if (g.resource !== '*' && g.resource !== resource) continue;
      if (g.until != null && now >= g.until) continue;   // expired session
      return true;
    }
    return false;
  }
  function pruneGrants(grants, now) {
    var list = validateGrants(grants);
    return list.filter(function (g) { return g.until == null || now < g.until; });
  }

  // ─── A7: clearance tiers ───
  // Knowledge-based (no guild-role fetch in a userscript): admin = on the mod
  // list; resident = known (has a user partition / interaction history);
  // guest = stranger. Ordered guest < resident < admin. presentClearance =
  // highest tier among a set of present user ids. (Discord-role mapping is a
  // follow-up — needs member data the poll loop doesn't carry.)
  var TIERS = ['guest', 'resident', 'admin'];
  function tierOf(uid, mods, knownIds) {
    var id = String(uid || '');
    if (Array.isArray(mods) && mods.indexOf(id) >= 0) return 'admin';
    if (knownIds && typeof knownIds === 'object') {
      if (Array.isArray(knownIds)) { if (knownIds.indexOf(id) >= 0) return 'resident'; }
      else if (knownIds[id]) return 'resident';
    }
    return 'guest';
  }
  function tierRank(tier) { var i = TIERS.indexOf(tier); return i < 0 ? 0 : i; }
  function presentClearance(uids, mods, knownIds) {
    var top = 'guest', topRank = 0;
    (Array.isArray(uids) ? uids : []).forEach(function (uid) {
      var r = tierRank(tierOf(uid, mods, knownIds));
      if (r > topRank) { topRank = r; top = TIERS[r]; }
    });
    return top;
  }
  // Gate helper: does `present` meet a rule's {op, level}? (Rook if.clearance.)
  function clearanceMeets(present, op, level) {
    var p = tierRank(present), l = tierRank(level);
    if (op === '>=') return p >= l;
    if (op === '>') return p > l;
    if (op === '==') return p === l;
    return p >= l;   // unknown op fails closed toward the Rook default (>=)
  }

  // ─── A2: import classification (dry-run preview + quarantine split) ───
  // Pure: sanitizeImport output + current cfg in, {writes, quarantine} out.
  // Rule/behavior sets NEVER direct-write on import — incoming non-empty
  // arrays ride the quarantine stash until a mod releases them (admission
  // quarantine: tagged, held out of the live feed, reviewed before firing).
  var QUARANTINE_KEYS = ['beats', 'autoModRules', 'procRules'];
  function classifyImport(san, currentCfg) {
    var writes = [], quarantine = {}, skipped = [];
    var cur = (currentCfg && typeof currentCfg === 'object') ? currentCfg : {};
    var scfg = (san && typeof san.cfg === 'object' && san.cfg !== null && !Array.isArray(san.cfg)) ? san.cfg : {};
    Object.keys(scfg).forEach(function (k) {
      var v = scfg[k];
      if (QUARANTINE_KEYS.indexOf(k) >= 0) {
        if (Array.isArray(v) && v.length) quarantine[k] = v;
        else skipped.push(k);   // incoming empty: nothing to hold, live cfg untouched
        return;
      }
      writes.push({ k: k, before: Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : null, after: v });
    });
    return {
      writes: writes, quarantine: quarantine, skipped: skipped,
      dropped: (san && Array.isArray(san.dropped)) ? san.dropped : [],
      channels: (san && san.channels && typeof san.channels === 'object') ? Object.keys(san.channels) : [],
      topLevel: (san && san.topLevel && typeof san.topLevel === 'object') ? Object.keys(san.topLevel) : []
    };
  }

  return {
    fnv1a: fnv1a, GENESIS: GENESIS,
    chainDigest: chainDigest, cleanEntry: cleanEntry,
    appendChained: appendChained, verifyChain: verifyChain,
    GRANT_ACTIONS: GRANT_ACTIONS, SESSION_MS: SESSION_MS,
    cleanGrant: cleanGrant, validateGrants: validateGrants,
    grant: grant, granted: granted, pruneGrants: pruneGrants,
    TIERS: TIERS, tierOf: tierOf, tierRank: tierRank,
    presentClearance: presentClearance, clearanceMeets: clearanceMeets,
    QUARANTINE_KEYS: QUARANTINE_KEYS, classifyImport: classifyImport
  };
})();
