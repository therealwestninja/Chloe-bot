/* Auto-moderation rule list (#6). node harness-automod.js
 * Rule types (text/regex/confusables) act with no mod present; only REVERSIBLE actions are ever
 * applied (an irreversible rule action is downgraded — never an auto-permaban, F1); mods are exempt;
 * non-matching messages are untouched. */
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

var RULES = [
  { pattern: 'badword', type: 'text', action: 'ignore' },
  { pattern: 'free nitro', type: 'confusables', action: 'softban', reason: 'scam' },
  { pattern: '\\bspam\\d+', type: 'regex', action: 'timeout', durationMs: 60000 },
  { pattern: 'nukeword', type: 'text', action: 'permaban' },   // irreversible -> must be downgraded
  { pattern: 'grabfreestuff.ru', type: 'link', action: 'softban' }   // matches only inside a URL
];
var sends = [], q = [], clock = makeClock(1700000000000);
var e = ChloeT0.createEngine({ transport: makeTransport(q), store: makeStore(), clock: clock,
  config: { channelId: 'C', botUserId: 'BOT', botName: 'chloe', addressMode: 'both', modList: ['9'],
    autoMod: true, autoModRules: RULES, cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
    respond: function (ctx) { return Promise.resolve({ ok: true, value: 'reply to ' + ctx.addressedBy.name }); },
    send: function (cid, t) { sends.push(t); return Promise.resolve(true); } } });
function poll(b) { q.push(b || []); clock.advance(1); return e.pollOnce(); }
function stateOf(id) { return e.getRoster().then(function (r) { var u = r.filter(function (x) { return x.id === id; })[0]; return u ? u.state : null; }); }

console.log('auto-moderation:');
poll([msg('1', 'u1', 'ann', 'ugh this badword again')])
  .then(function () { return stateOf('u1'); })
  .then(function (s) { ok(s === 'ignored', 'text rule "badword" -> ignore'); })
  .then(function () { return poll([msg('2', 'u2', 'bea', 'grab fr\u0435\u0435 nitro now!!')]); })   // Cyrillic e's
  .then(function () { return stateOf('u2'); })
  .then(function (s) { ok(s === 'soft-ban', 'confusables rule catches "fr\u0435\u0435 nitro" (homoglyph evasion) -> softban'); })
  .then(function () { return poll([msg('30', 'lk1', 'liz', 'check this out www.grabfreestuff.ru/x now')]); })
  .then(function () { return stateOf('lk1'); })
  .then(function (s) { ok(s === 'soft-ban', 'link rule matches a domain inside a URL -> softban'); })
  .then(function () { return poll([msg('31', 'lk2', 'moe', 'i grabfreestuff sometimes, no link though')]); })
  .then(function () { return stateOf('lk2'); })
  .then(function (s) { ok(s === null || s === 'active', 'link rule does NOT fire on the bare word in prose (only inside a URL)'); })
  .then(function () { return poll([msg('3', 'u3', 'cas', 'spam123 spam123 spam123')]); })
  .then(function () { return stateOf('u3'); })
  .then(function (s) { ok(s === 'timeout', 'regex rule "\\bspam\\d+" -> timeout'); })
  .then(function () { return poll([msg('4', 'u4', 'dev', 'nukeword incoming')]); })
  .then(function () { return stateOf('u4'); })
  .then(function (s) { ok(s === 'ignored', 'an irreversible rule action (permaban) is downgraded to ignore \u2014 never an auto-permaban (F1)'); })
  .then(function () {
    console.log('\nexemptions + non-interference:');
    return poll([msg('5', '9', 'modder', 'here is badword and free nitro')]);   // a mod
  })
  .then(function () { return stateOf('9'); })
  .then(function (s) { ok(s === null || s === 'active', 'a moderator is exempt from auto-mod'); })
  .then(function () {
    var before = sends.length;
    return poll([msg('6', 'u5', 'eli', 'chloe what is up')])   // clean + addressed
      .then(function () { return poll([]); })
      .then(function () {
        ok(sends.some(function (t) { return t === 'reply to eli'; }), 'a clean message still gets a normal reply (auto-mod does not interfere)');
        return stateOf('u5');
      })
      .then(function (s) { ok(s === null || s === 'active', '...and the clean user is not moderated'); });
  })
  .then(function () {
    console.log('\n' + (failures ? ('RESULT: ' + failures + ' FAILURE(S)') : 'RESULT: all checks passed'));
    process.exit(failures ? 1 : 0);
  })
  .catch(function (e) { console.error('HARNESS ERROR', e); process.exit(2); });
