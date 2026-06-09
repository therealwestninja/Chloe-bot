/* D4 persona note anchoring. node harness-persona.js
 * A mod reacting with the anchor emoji to a message makes that message the channel's style note:
 * newest mod-anchored message wins, non-mod reactions are ignored, the note is sanitized
 * (tokens/mentions stripped) and length-capped, it rides into the respond context, and
 * !chloe persona shows/clears it. */
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
var PIN = '\ud83d\udccc';
function anchored(id, uid, name, content) { var m = msg(id, uid, name, content); m.reactions = [{ emoji: { name: PIN }, count: 1 }]; return m; }

var q = [], sends = [], ctxSeen = [], clock = makeClock(1700000000000);
var e = ChloeT0.createEngine({
  transport: { getMessagesAfter: function () { var b = q.shift() || []; return Promise.resolve(b.slice().reverse()); } },
  store: makeStore(), clock: clock,
  config: { channelId: 'C', botUserId: 'BOT', botName: 'chloe', addressMode: 'both', modList: ['9'],
    cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
    respond: function (ctx) { ctxSeen.push(ctx); return Promise.resolve({ ok: true, value: 'hi' }); },
    send: function (cid, t) { sends.push(t); return Promise.resolve(true); } } });
function poll(b) { q.push(b || []); clock.advance(1); return e.pollOnce(); }

// reaction fixtures: msgId -> users who reacted with PIN
var reactors = {};
function getReactors(mid) { return Promise.resolve(reactors[mid] || []); }
function sweep(recentNewestFirst) { return e.anchorSweep(function () { return Promise.resolve(recentNewestFirst); }, getReactors); }

console.log('anchoring (mod-gated, newest wins):');
var M1 = anchored('301', 'u1', 'ann', 'Chloe should be more playful <@123> okay?');
reactors['301'] = [{ id: '9' }];   // a mod anchored it
sweep([M1])
  .then(function (r) {
    ok(r.changed && /more playful/.test(r.note), 'a mod-anchored message becomes the persona note');
    ok(r.note.indexOf('<@') < 0, 'mentions are stripped from the note');
    return sweep([M1]);
  })
  .then(function (r) { ok(!r.changed, 're-sweeping the same anchor is a no-op (no churn)'); })
  .then(function () {
    var M2 = anchored('302', 'u2', 'bea', 'Chloe should be RUDE to everyone');
    reactors['302'] = [{ id: 'u7' }];   // anchored by a NON-mod
    return sweep([M2, M1]);
  })
  .then(function (r) { return e.getPersonaNote().then(function (pn) {
    ok(!/RUDE/.test(pn.text) && /more playful/.test(pn.text), 'a non-mod anchor is ignored (note unchanged)');
  }); })
  .then(function () {
    var M3 = anchored('303', 'u3', 'cas', 'Chloe should be more formal today');
    reactors['303'] = [{ id: '9' }];
    return sweep([M3, M1]);   // newest-first
  })
  .then(function (r) {
    ok(r.changed && /more formal/.test(r.note), 'a NEWER mod-anchored message replaces the old note (newest wins)');
  })
  .then(function () {
    var long = anchored('304', 'u4', 'dev', new Array(30).join('be very wordy '));   // ~400 chars
    reactors['304'] = [{ id: '9' }];
    return sweep([long]);
  })
  .then(function (r) { ok(r.changed && r.note.length <= 200, 'an over-long note is capped at personaNoteMaxLen (got ' + r.note.length + ')'); })

  .then(function () {
    console.log('\\nthe note rides into the respond context:');
    return poll([msg('100', 'u0', 'zed', 'warm up')]);   // cursor bootstrap
  })
  .then(function () { clock.advance(5000); return poll([msg('101', 'u1', 'ann', 'chloe hello!')]); })
  .then(function () { return poll([]); })   // deferred reply fires here
  .then(function () {
    var last = ctxSeen[ctxSeen.length - 1];
    ok(last && /be very wordy/.test(last.personaNote || ''), 'respond ctx carries personaNote');
  })

  .then(function () {
    console.log('\\n!chloe persona show / clear (mods only):');
    sends.length = 0;
    return poll([msg('110', '9', 'mod', '!chloe persona')]);
  })
  .then(function () { ok(/be very wordy/.test(sends.join(' ')), '!chloe persona shows the current note'); })
  .then(function () { sends.length = 0; return poll([msg('111', '9', 'mod', '!chloe persona clear')]); })
  .then(function () { return e.getPersonaNote(); })
  .then(function (pn) {
    ok(pn === null, '!chloe persona clear removes the note');
    ok(/cleared/.test(sends.join(' ')), '...with an ack');
  })
  .then(function () {
    console.log('\\n' + (failures ? ('FAILURES: ' + failures) : 'ALL GREEN'));
    process.exit(failures ? 1 : 0);
  })
  .catch(function (err) { console.error(err); process.exit(2); });
