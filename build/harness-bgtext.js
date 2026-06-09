/* Text-lane backgrounding (backgroundText). node harness-bgtext.js
 * With backgroundText on, a slow generation must NOT stall the poll: pollOnce resolves immediately
 * and exposes the in-flight lane as summary.textJob; the reply still lands once generation finishes. */
'use strict';
var ChloeT0 = require('./engine.js');
function makeStore() { var m = {}; return {
  get: function (k) { return Promise.resolve(k in m ? JSON.parse(m[k]) : null); },
  set: function (k, v) { m[k] = JSON.stringify(v); return Promise.resolve(true); },
  del: function (k) { delete m[k]; return Promise.resolve(true); },
  listIndex: function () { return Promise.resolve(m['roster:index'] ? JSON.parse(m['roster:index']) : []); },
  setIndex: function (a) { m['roster:index'] = JSON.stringify(a); return Promise.resolve(true); } }; }
function makeTransport(q) { return { getMessagesAfter: function () { var b = q.shift() || []; return Promise.resolve(b.slice().reverse()); } }; }
function makeClock(t0) { var t = t0; return { now: function () { return t; }, advance: function (ms) { t += ms; } }; }
function msg(id, uid, name, content) { return { id: id, author: { id: uid, username: name }, content: content, timestamp: new Date().toISOString() }; }
var failures = 0;
function ok(c, m) { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } }

var sends = [], resolvers = [], q = [], clock = makeClock(1700000000000);
var e = ChloeT0.createEngine({ transport: makeTransport(q), store: makeStore(), clock: clock,
  config: { channelId: 'C', botUserId: 'BOT', botName: 'chloe', addressMode: 'both',
    backgroundText: true, cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
    respond: function () { return new Promise(function (res) { resolvers.push(function () { res({ ok: true, value: 'hi there' }); }); }); },
    send: function (cid, t) { sends.push(t); return Promise.resolve(true); } } });
function poll(b) { q.push(b || []); clock.advance(1); return e.pollOnce(); }

console.log('text-lane backgrounding:');
poll([msg('1', 'u1', 'sam', 'chloe hi')])      // queues the reply (debounce)
  .then(function () { return poll([]); })       // text lane kicks; respond() parks (deferred)
  .then(function (s) {
    ok(sends.length === 0, 'the poll resolves without waiting for text generation (non-blocking)');
    ok(s && s.textJob && typeof s.textJob.then === 'function', 'the in-flight text lane is exposed as summary.textJob');
    ok(resolvers.length === 1, 'generation was actually started in the background');
    resolvers[0]();                              // let generation finish
    return s.textJob;
  })
  .then(function () {
    ok(sends.some(function (t) { return /hi there/.test(t); }), 'the reply is delivered once generation completes');
    console.log('\n' + (failures ? ('RESULT: ' + failures + ' FAILURE(S)') : 'RESULT: all checks passed'));
    process.exit(failures ? 1 : 0);
  })
  .catch(function (er) { console.error('HARNESS ERROR', er); process.exit(2); });
