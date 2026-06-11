/* DM two-way conversation. node harness-dm.js
 * A DM channel is just a channel with addressMode 'always' — Chloe replies to EVERY message there
 * (no @-mention or name needed), because a DM is 1:1 and every line is to her. Mod commands and
 * moderation still work; this only changes the "is she being addressed?" gate. */
'use strict';
var ChloeT0 = require('./engine.js');
var failures = 0;
function ok(c, m) { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } }
function makeStore() { var m = {}; return {
  get: function (k) { return Promise.resolve(k in m ? JSON.parse(m[k]) : null); },
  set: function (k, v) { m[k] = JSON.stringify(v); return Promise.resolve(true); },
  del: function (k) { delete m[k]; return Promise.resolve(true); },
  listIndex: function () { return Promise.resolve(m['roster:index'] ? JSON.parse(m['roster:index']) : []); },
  setIndex: function (a) { m['roster:index'] = JSON.stringify(a); return Promise.resolve(true); } }; }
function makeClock(t0) { var t = t0; return { now: function () { return t; }, advance: function (ms) { t += ms; } }; }
function msg(id, uid, name, content) { return { id: id, author: { id: uid, username: name }, content: content, timestamp: new Date().toISOString() }; }

function mkEngine(addressMode) {
  var q = [], sends = [], clock = makeClock(1700000000000);
  var e = ChloeT0.createEngine({
    transport: { getMessagesAfter: function () { var b = q.shift() || []; return Promise.resolve(b.slice().reverse()); } },
    store: makeStore(), clock: clock,
    config: { channelId: 'DM1', botUserId: 'BOT', botName: 'chloe', addressMode: addressMode, modList: ['9'],
      cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
      respond: function () { return Promise.resolve({ ok: true, value: 'hello!' }); },
      send: function (cid, t) { sends.push(t); return Promise.resolve(true); } } });
  return { e: e, sends: sends, clock: clock, poll: function (b) { q.push(b || []); clock.advance(1); return e.pollOnce(); } };
}

console.log("DM channel (addressMode 'always'): every message gets a reply:");
var dm = mkEngine('always');
dm.poll([msg('1', 'u1', 'ann', 'hi there')])           // bootstrap poll
  .then(function () { return dm.poll([]); })
  .then(function () { return dm.poll([msg('2', 'u1', 'ann', 'just chatting, no mention of her name')]); })
  .then(function () { return dm.poll([]); })            // deferred reply fires
  .then(function () { ok(dm.sends.length >= 1, 'she replies to a plain DM message with no @-mention and no name'); })
  .then(function () {
    console.log("\ncontrast: in a guild channel ('both'), the same message is ignored:");
    var g = mkEngine('both');
    return g.poll([msg('1', 'u1', 'ann', 'hi there')])
      .then(function () { return g.poll([]); })
      .then(function () { return g.poll([msg('2', 'u1', 'ann', 'just chatting, no mention of her name')]); })
      .then(function () { return g.poll([]); })
      .then(function () { ok(g.sends.length === 0, 'a guild channel ignores an unaddressed message (control)'); });
  })
  .then(function () {
    console.log('\nmoderation still applies inside a DM:');
    var d2 = mkEngine('always');
    return d2.poll([msg('1', 'u1', 'ann', 'hello')])
      .then(function () { return d2.poll([]); })       // flush the bootstrap message's deferred reply
      .then(function () { return d2.e.applyModAction('ignore', 'u1', { byModId: '9' }); })
      .then(function () { d2.sends.length = 0; d2.clock.advance(5000); return d2.poll([msg('2', 'u1', 'ann', 'still here?')]); })
      .then(function () { return d2.poll([]); })
      .then(function () { ok(d2.sends.length === 0, 'an ignored user gets no reply even in a DM (moderation overrides always-addressed)'); });
  })
  .then(function () {
    console.log('\n' + (failures ? ('FAILURES: ' + failures) : 'ALL GREEN'));
    process.exit(failures ? 1 : 0);
  })
  .catch(function (err) { console.error(err); process.exit(2); });
