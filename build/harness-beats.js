/* Scheduled proactive beats (#12). node harness-beats.js
 * Interval-based, heavily activity-gated: seeded (not fired) on first sight; fires after its interval
 * only when the room is active; never to a dead room; never during lockdown; one per poll; min gap. */
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

var sends = [], q = [], clock = makeClock(1700000000000);
var e = ChloeT0.createEngine({ transport: makeTransport(q), store: makeStore(), clock: clock,
  config: { channelId: 'C', botUserId: 'BOT', botName: 'chloe', addressMode: 'both', modList: ['9'],
    beats: [{ id: 'morning', intervalMs: 1000, text: 'morning everyone' }], beatActiveWithinMs: 5000, beatMinGapMs: 0,
    cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1, ackCommands: true,
    respond: function () { return Promise.resolve({ ok: true, value: 'hi' }); },
    send: function (cid, t) { sends.push(t); return Promise.resolve(true); } } });
function poll(b) { q.push(b || []); clock.advance(1); return e.pollOnce(); }
function fires() { return sends.filter(function (t) { return /morning everyone/.test(t); }).length; }

console.log('beat lifecycle + gating:');
poll([msg('1', 'u1', 'sam', 'hi')])
  .then(function () { ok(fires() === 0, 'a beat is seeded, not fired, the first time it is seen'); })
  .then(function () { clock.advance(1500); return poll([msg('2', 'u1', 'sam', 'hey')]); })
  .then(function () { ok(fires() === 1, 'after its interval, with the room active, the beat fires'); })
  .then(function () { clock.advance(6000); return poll([]); })   // interval elapsed but no fresh activity
  .then(function () { ok(fires() === 1, 'it does NOT fire into a dead room (activity gate)'); })
  .then(function () { return poll([msg('3', 'u1', 'sam', 'anyone around?')]); })
  .then(function () { ok(fires() === 2, 'once the room is active again, it fires'); })
  .then(function () { return poll([msg('4', '9', 'mod', '!chloe lockdown')]); })
  .then(function () { clock.advance(2000); return poll([msg('5', 'u1', 'sam', 'hello?')]); })
  .then(function () { ok(fires() === 2, 'beats do not fire during lockdown'); })
  .then(function () { return poll([msg('6', '9', 'mod', '!chloe unlock')]); })
  .then(function () { clock.advance(2000); return poll([msg('7', 'u1', 'sam', 'still here')]); })
  .then(function () { ok(fires() >= 3, 'after unlock, beats resume'); })

  .then(function () {
    console.log('\none-per-poll + global min gap:');
    var s2 = [], q2 = [], clock2 = makeClock(1700000000000);
    var e2 = ChloeT0.createEngine({ transport: makeTransport(q2), store: makeStore(), clock: clock2,
      config: { channelId: 'C', botUserId: 'BOT', botName: 'chloe', addressMode: 'both',
        beats: [{ id: 'a', intervalMs: 1000, text: 'beat-a' }, { id: 'b', intervalMs: 1000, text: 'beat-b' }],
        beatActiveWithinMs: 100000, beatMinGapMs: 5000, cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
        send: function (cid, t) { s2.push(t); return Promise.resolve(true); } } });
    function pollB(b) { q2.push(b || []); clock2.advance(1); return e2.pollOnce(); }
    function beatCount() { return s2.filter(function (t) { return /beat-/.test(t); }).length; }
    return pollB([msg('1', 'u1', 'sam', 'hi')])                                  // seed both
      .then(function () { ok(beatCount() === 0, 'both beats seeded, none fired'); })
      .then(function () { clock2.advance(1500); return pollB([msg('2', 'u1', 'sam', 'hey')]); })   // both eligible
      .then(function () { ok(beatCount() === 1, 'when two beats are due, only ONE fires per poll'); })
      .then(function () { clock2.advance(100); return pollB([msg('3', 'u1', 'sam', 'yo')]); })      // within the gap
      .then(function () { ok(beatCount() === 1, 'a second beat is held by the global min gap'); })
      .then(function () { clock2.advance(6000); return pollB([msg('4', 'u1', 'sam', 'hello')]); })  // gap elapsed
      .then(function () { ok(beatCount() === 2, 'after the min gap, the next beat fires'); })
      .then(function () {
        console.log('\ngenerated (in-character) beat via beatFn:');
        var s3 = [], gen = [], q3 = [], clock3 = makeClock(1700000000000);
        var e3 = ChloeT0.createEngine({ transport: makeTransport(q3), store: makeStore(), clock: clock3,
          config: { channelId: 'C', botUserId: 'BOT', botName: 'chloe', addressMode: 'both',
            beats: [{ id: 'gen', intervalMs: 1000, prompt: 'say good morning to the channel', text: 'morning (fallback)' }],
            beatActiveWithinMs: 100000, beatMinGapMs: 0, cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
            beatFn: function (b) { gen.push(b.prompt); return Promise.resolve({ ok: true, value: 'gm friends, hope today\u2019s good' }); },
            send: function (cid, t) { s3.push(t); return Promise.resolve(true); } } });
        function pollC(b) { q3.push(b || []); clock3.advance(1); return e3.pollOnce(); }
        return pollC([msg('1', 'u1', 'sam', 'hi')])
          .then(function () { clock3.advance(1500); return pollC([msg('2', 'u1', 'sam', 'hey')]); })
          .then(function () {
            ok(gen.length === 1 && /good morning/.test(gen[0]), 'a prompt-beat calls beatFn with its prompt');
            ok(s3.some(function (t) { return /gm friends/.test(t); }), '...and posts the generated line (not the fallback text)');
          });
      })
      .then(function () {
        console.log('\n' + (failures ? ('RESULT: ' + failures + ' FAILURE(S)') : 'RESULT: all checks passed'));
        process.exit(failures ? 1 : 0);
      });
  })
  .catch(function (er) { console.error('HARNESS ERROR', er); process.exit(2); });
