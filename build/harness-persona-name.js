/* Persona-name + image-prompt sanitizer. node harness-persona-name.js
 * (1) When a mod-anchored note names a character, Chloe answers to THAT name (added to her
 *     aliases) and the response ctx carries you.name = the character + a personaName field.
 * (2) sanitizePromptForCaption neutralizes mentions, mass-pings, links, and markdown so a
 *     generation prompt is safe to echo back as an image caption. */
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

var q = [], sends = [], ctxSeen = [], clock = makeClock(1700000000000), reactors = {};
var e = ChloeT0.createEngine({
  transport: { getMessagesAfter: function () { var b = q.shift() || []; return Promise.resolve(b.slice().reverse()); } },
  store: makeStore(), clock: clock,
  config: { channelId: 'C', botUserId: 'BOT', botName: 'chloe-bot', addressMode: 'name', modList: ['9'],
    cooldownMs: 1, globalCooldownMs: 1, debounceMs: 1,
    respond: function (ctx) { ctxSeen.push(ctx); return Promise.resolve({ ok: true, value: 'reply' }); },
    send: function (cid, t) { sends.push(t); return Promise.resolve(true); } } });
function poll(b) { q.push(b || []); clock.advance(1); return e.pollOnce(); }
function sweep(list) { return e.anchorSweep(function () { return Promise.resolve(list); }, function (mid) { return Promise.resolve(reactors[mid] || []); }); }

console.log('a named persona makes Chloe answer to that name:');
var M = anchored('301', '9', 'mod', 'Name: Seraphina. Be regal and a little aloof.');
reactors['301'] = [{ id: '9' }];
sweep([M])
  .then(function (r) { ok(r.changed && r.persona === 'Seraphina', 'anchored note with "Name: Seraphina" parses the character name'); })
  .then(function () { return poll([msg('100', 'u0', 'zed', 'warm up')]); })   // bootstrap
  .then(function () { clock.advance(3000); return poll([msg('101', 'u1', 'ann', 'Seraphina, are you there?')]); })   // addressed by NEW name
  .then(function () { return poll([]); })   // deferred reply
  .then(function () {
    ok(sends.length >= 1, 'she replies when addressed by the pinned character name (not just "chloe")');
    var last = ctxSeen[ctxSeen.length - 1];
    ok(last && last.you && last.you.name === 'Seraphina', 'response ctx.you.name is the character, not Chloe');
    ok(last && last.personaName === 'Seraphina', 'response ctx carries personaName for the prompt reframe');
  })
  .then(function () {
    console.log('\nclearing the note restores her real name:');
    return e.clearPersonaNote();
  })
  .then(function () {
    sends.length = 0;
    return poll([msg('110', 'u1', 'ann', 'Seraphina?')]).then(function () { return poll([]); });
  })
  .then(function () { ok(sends.length === 0, 'after clear, the old character name no longer addresses her'); })
  .then(function () { return poll([msg('111', 'u1', 'ann', 'chloe?')]).then(function () { return poll([]); }); })
  .then(function () { ok(sends.length >= 1, '...and her real name works again'); })

  .then(function () {
    console.log('\nvariant phrasings parse a name:');
    var cases = [
      ['you are Marcus the merchant', 'Marcus'],
      ['act as Detective Cole now', 'Detective Cole'],
      ['roleplay as Luna please', 'Luna'],
      ['just be normal today', null]   // no capitalized name -> no persona name
    ];
    var p = Promise.resolve();
    cases.forEach(function (cse, i) {
      p = p.then(function () {
        var id = '40' + i, mm = anchored(id, '9', 'mod', cse[0]); reactors[id] = [{ id: '9' }];
        return sweep([mm]).then(function (r) {
          ok((r.persona || null) === cse[1], '"' + cse[0] + '" -> ' + (cse[1] || 'no name'));
        });
      });
    });
    return p;
  })

  .then(function () {
    console.log('\nimage-prompt caption sanitizer:');
    var f = e.sanitizePromptForCaption;
    ok(typeof f === 'function', 'sanitizePromptForCaption is exported');
    if (typeof f === 'function') {
      ok(f('a cat <@123> <@&55> <#7> :smile:').indexOf('<@') < 0, 'strips mentions/role/channel/emoji tokens');
      ok(!/@everyone/.test(f('a dragon @everyone look')), 'defangs @everyone');
      ok(f('art https://evil.example.com/x nice').indexOf('http') < 0, 'removes links (no auto-embed)');
      ok(!/[*_`~|>#]/.test(f('**bold** _it_ `code` > quote # head')), 'strips markdown control chars');
      ok(f(new Array(400).join('x ')).length <= 221, 'caps length (<=220 + ellipsis)');
    }
  })
  .then(function () {
    console.log('\n' + (failures ? ('FAILURES: ' + failures) : 'ALL GREEN'));
    process.exit(failures ? 1 : 0);
  })
  .catch(function (err) { console.error(err); process.exit(2); });
