/* Permanent blocklist (tombstone). node harness-blocklist.js
 * A blocked user is never re-scanned, never re-added to the roster, ever — even after they speak
 * again, and even across a purge (the blocklist lives at its own key, independent of partitions).
 * Blocks by user id and by username. Unblock lets memory form again. */
'use strict';
var ChloeT0 = require('./engine.js');
var failures = 0;
function ok(c, m) { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } }
function makeStore() { var m = {}; return {
  _dump: m,
  get: function (k) { return Promise.resolve(k in m ? JSON.parse(m[k]) : null); },
  set: function (k, v) { m[k] = JSON.stringify(v); return Promise.resolve(true); },
  del: function (k) { delete m[k]; return Promise.resolve(true); },
  listIndex: function () { return Promise.resolve(m['roster:index'] ? JSON.parse(m['roster:index']) : []); },
  setIndex: function (a) { m['roster:index'] = JSON.stringify(a); return Promise.resolve(true); } }; }
function makeClock(t0) { var t = t0; return { now: function () { return t; }, advance: function (ms) { t += ms; } }; }
function msg(id, uid, name, content) { return { id: id, author: { id: uid, username: name }, content: content, timestamp: new Date().toISOString() }; }

var q = [], store = makeStore(), clock = makeClock(1700000000000);
var e = ChloeT0.createEngine({
  transport: { getMessagesAfter: function () { var b = q.shift() || []; return Promise.resolve(b.slice().reverse()); } },
  store: store, clock: clock,
  config: { channelId: 'C', botUserId: 'BOT', botName: 'chloe', addressMode: 'both', modList: ['9'],
    cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
    respond: function () { return Promise.resolve({ ok: true, value: 'r' }); },
    send: function () { return Promise.resolve(true); } } });
function poll(b) { q.push(b || []); clock.advance(1); return e.pollOnce(); }
function ids() { return e.getRoster().then(function (r) { return r.map(function (u) { return u.id; }).sort(); }); }

console.log('block by id: a blocked user never enters the roster, even after speaking again:');
poll([msg('1', 'u1', 'ann', 'hi'), msg('2', 'u2', 'bob', 'hello')])
  .then(function () { return ids(); })
  .then(function (r) { ok(r.join(',') === 'u1,u2', 'both speakers ingested normally first'); })
  .then(function () { return e.blockUser({ id: 'u2', name: 'bob', byModId: '9', reason: 'spam' }); })
  .then(function (res) { ok(res.ok, 'blockUser({id:u2}) succeeds'); })
  .then(function () { return ids(); })
  .then(function (r) { ok(r.indexOf('u2') < 0, 'blocking u2 purges them from the roster immediately'); })
  .then(function () { clock.advance(5000); return poll([msg('3', 'u2', 'bob', 'i am back and talking again')]); })
  .then(function () { return poll([]); })
  .then(function () { return ids(); })
  .then(function (r) { ok(r.indexOf('u2') < 0, 'u2 speaking again does NOT re-add them \u2014 never re-scanned'); })

  .then(function () {
    console.log('\nblock by username (no id on hand):');
    return e.blockUser({ name: 'carol', byModId: '9' });
  })
  .then(function () { clock.advance(5000); return poll([msg('4', 'u3', 'carol', 'hello it is carol')]); })
  .then(function () { return poll([]); })
  .then(function () { return ids(); })
  .then(function (r) { ok(r.indexOf('u3') < 0, 'a user whose USERNAME is blocked is never scanned (id u3 never appears)'); })

  .then(function () {
    console.log('\nthe blocklist survives a self-purge of an unrelated user:');
    // u1 forgets themselves; the blocklist for u2/carol must be untouched
    return e.purge('u1', { targetName: 'ann' });
  })
  .then(function () { clock.advance(5000); return poll([msg('5', 'u2', 'bob', 'still blocked?')]); })
  .then(function () { return poll([]); })
  .then(function () { return ids(); })
  .then(function (r) { ok(r.indexOf('u2') < 0, 'u2 stays blocked after an unrelated purge (tombstone is independent of partitions)'); })

  .then(function () {
    console.log('\nunblock lets memory form again:');
    return e.unblockUser({ id: 'u2', name: 'bob' });
  })
  .then(function (res) { ok(res.ok, 'unblockUser succeeds'); })
  .then(function () { clock.advance(5000); return poll([msg('6', 'u2', 'bob', 'am i back?')]); })
  .then(function () { return poll([]); })
  .then(function () { return ids(); })
  .then(function (r) { ok(r.indexOf('u2') >= 0, 'after unblock, u2 is scanned and re-enters the roster'); })

  .then(function () {
    console.log('\nlistBlocked reflects state:');
    return e.listBlocked();
  })
  .then(function (bl) { ok(bl && bl.names && bl.names.carol && !(bl.ids && bl.ids.u2), 'listBlocked shows carol still blocked, u2 cleared'); })

  .then(function () {
    console.log('\n' + (failures ? ('FAILURES: ' + failures) : 'ALL GREEN'));
    process.exit(failures ? 1 : 0);
  })
  .catch(function (err) { console.error(err); process.exit(2); });
