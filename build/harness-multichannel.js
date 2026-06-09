/* D3 multi-channel. node harness-multichannel.js
 * Two engine instances over ONE shared physical key-value map, namespaced exactly the way the
 * bootstrap does it (primary channel = legacy un-prefixed keys, extra channel = 'ch:{id}:').
 * Proves: independent replies per channel, roster isolation, independent moderation state for
 * the SAME user id in different channels, and that the extra channel never writes a legacy key. */
'use strict';
var ChloeT0 = require('./engine.js');
var failures = 0;
function ok(c, m) { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } }

var physical = {};   // the one shared GM-like map
function makeStore(pfx) {
  return {
    get: function (k) { var kk = pfx + k; return Promise.resolve(kk in physical ? JSON.parse(physical[kk]) : null); },
    set: function (k, v) { physical[pfx + k] = JSON.stringify(v); return Promise.resolve(true); },
    del: function (k) { delete physical[pfx + k]; return Promise.resolve(true); },
    listIndex: function () { var kk = pfx + 'roster:index'; return Promise.resolve(kk in physical ? JSON.parse(physical[kk]) : []); },
    setIndex: function (a) { physical[pfx + 'roster:index'] = JSON.stringify(a); return Promise.resolve(true); }
  };
}
function makeClock(t0) { var t = t0; return { now: function () { return t; }, advance: function (ms) { t += ms; } }; }
function msg(id, uid, name, content) { return { id: id, author: { id: uid, username: name }, content: content, timestamp: new Date().toISOString() }; }

// one transport, routed by channel id (mirrors one Discord token serving N channels)
var queues = { A: [], B: [] };
var transport = { getMessagesAfter: function (cid) { var b = (queues[cid] || []).shift() || []; return Promise.resolve(b.slice().reverse()); } };
var sends = [];   // { cid, text }
var clock = makeClock(1700000000000);

function engineFor(cid, pfx) {
  return ChloeT0.createEngine({ transport: transport, store: makeStore(pfx), clock: clock,
    config: { channelId: cid, botUserId: 'BOT', botName: 'chloe', addressMode: 'both', modList: ['9'],
      cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
      respond: function (ctx) { return Promise.resolve({ ok: true, value: 'hi ' + ctx.addressedBy.name }); },
      send: function (cid2, t) { sends.push({ cid: cid2, text: t }); return Promise.resolve(true); } } });
}
var engA = engineFor('A', '');          // primary channel: legacy namespace
var engB = engineFor('B', 'ch:B:');     // extra channel: prefixed namespace

function pollA(b) { queues.A.push(b || []); clock.advance(1); return engA.pollOnce(); }
function pollB(b) { queues.B.push(b || []); clock.advance(1); return engB.pollOnce(); }
function rosterIds(eng) { return eng.getRoster().then(function (r) { return r.map(function (p) { return p.id; }).sort(); }); }

console.log('independent replies, shared transport (replies land on the poll AFTER ingest — debounce):');
pollA([msg('101', 'u1', 'ann', 'chloe hello from A')])
  .then(function () { return pollA([]); })
  .then(function () { return pollB([msg('201', 'u2', 'bea', 'chloe hello from B')]); })
  .then(function () { return pollB([]); })
  .then(function () {
    ok(sends.some(function (s) { return s.cid === 'A' && /ann/.test(s.text); }), 'channel A got its own reply');
    ok(sends.some(function (s) { return s.cid === 'B' && /bea/.test(s.text); }), 'channel B got its own reply');
  })
  .then(function () {
    console.log('\nroster isolation:');
    return Promise.all([rosterIds(engA), rosterIds(engB)]);
  })
  .then(function (rs) {
    ok(rs[0].join(',') === 'u1', "A's roster has only A's speaker");
    ok(rs[1].join(',') === 'u2', "B's roster has only B's speaker");
  })
  .then(function () {
    console.log('\nsame user, independent moderation state per channel:');
    clock.advance(5000);
    return pollA([msg('102', 'u3', 'cas', 'chloe hi')]).then(function () { return pollA([]); })
      .then(function () { clock.advance(5000); return pollB([msg('202', 'u3', 'cas', 'chloe hi')]); }).then(function () { return pollB([]); });
  })
  .then(function () { return engA.applyModAction('ignore', 'u3', { byModId: '9' }); })
  .then(function () { sends.length = 0; clock.advance(5000); return pollA([msg('103', 'u3', 'cas', 'chloe still there?')]); })
  .then(function () { return pollA([]); })
  .then(function () { clock.advance(5000); return pollB([msg('203', 'u3', 'cas', 'chloe still there?')]); })
  .then(function () { return pollB([]); })
  .then(function () {
    ok(!sends.some(function (s) { return s.cid === 'A'; }), 'u3 is ignored in channel A (no reply there)');
    ok(sends.some(function (s) { return s.cid === 'B' && /cas/.test(s.text); }), '...but the SAME user id still gets replies in channel B');
  })
  .then(function () {
    console.log('\nnamespacing on the shared physical map:');
    var keys = Object.keys(physical);
    var bKeys = keys.filter(function (k) { return k.indexOf('ch:B:') === 0; });
    var legacyUserKeys = keys.filter(function (k) { return k.indexOf('u:') === 0; });
    ok(bKeys.length > 0, "channel B's state lives under the ch:B: prefix");
    ok(bKeys.some(function (k) { return k === 'ch:B:u:u2'; }) && legacyUserKeys.indexOf('u:u2') < 0, "B's speaker never leaks into the legacy namespace");
    ok(legacyUserKeys.indexOf('u:u1') >= 0, "the primary channel keeps the legacy namespace (existing installs keep their memory)");
  })
  .then(function () {
    console.log('\n' + (failures ? ('FAILURES: ' + failures) : 'ALL GREEN'));
    process.exit(failures ? 1 : 0);
  })
  .catch(function (err) { console.error(err); process.exit(2); });
