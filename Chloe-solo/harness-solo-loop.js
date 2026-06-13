/* Solo integration smoke test (roadmap #11, Phase 1). node harness-solo-loop.js
 * Proves the cognitive engine drives end-to-end as a standalone 1:1 chat with ZERO engine changes:
 * the SAME createEngine, fed a LocalTransport (a message queue) + a localStorage-shaped store + direct
 * brain hooks (no postMessage). A user message goes in; the engine ingests, decides, and calls send with
 * a reply; her own line is fed back so conversation-memory works. This is the architecture Solo's UI wraps. */
'use strict';
var ChloeT0 = require('./engine.js');
var failures = 0;
function ok(c, m) { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } }

// localStorage-shaped store (sync map behind the engine's async 5-method port) — exactly Solo's adapter
function makeStore() { var m = {}; return {
  get: function (k) { return Promise.resolve(k in m ? JSON.parse(m[k]) : null); },
  set: function (k, v) { m[k] = JSON.stringify(v); return Promise.resolve(true); },
  del: function (k) { delete m[k]; return Promise.resolve(true); },
  listIndex: function () { return Promise.resolve(m.__index__ ? JSON.parse(m.__index__) : []); },
  setIndex: function (a) { m.__index__ = JSON.stringify(a); return Promise.resolve(true); }, _raw: m }; }

// LocalTransport: a queue the UI pushes into; getMessagesAfter returns what's past the cursor
var SNOW_EPOCH = 1420070400000, seq = 0;
function snow(ms) { return String((BigInt(ms - SNOW_EPOCH) << 22n) + BigInt((seq++) % 4096)); }
function cmp(a, b) { var A = BigInt(a), B = BigInt(b); return A < B ? -1 : (A > B ? 1 : 0); }
var BOT_ID = 'chloe-bot', USER_ID = 'you';
function makeTransport(queue) { return {
  getMessagesAfter: function (chId, afterId, limit) {
    var out = queue.filter(function (msg) { return !afterId || cmp(msg.id, afterId) > 0; });
    return Promise.resolve(out.slice(0, limit || 50));
  },
  getMessagesBefore: function () { return Promise.resolve([]); } }; }
function userMsg(queue, text) { var ms = Date.now(); queue.push({ id: snow(ms), channelId: 'solo', author: { id: USER_ID, username: 'You', bot: false }, content: text, timestamp: new Date(ms).toISOString() }); }

(function () {
  var queue = [], sent = [], logs = [];
  var store = makeStore();
  var replyText = 'Hey — good to see you. What are you working on?';
  function buildCfg() { return {
    channelId: 'solo', botUserId: BOT_ID, botName: 'Chloe', isDM: true, commandPrefix: '!chloe',
    conversationMemory: true, selfKnowledge: true, episodicMemory: true,
    // snappy local pacing (Discord's 4s poll / 2.5s debounce feel sluggish 1:1)
    pollFloorMs: 700, pollCeilMs: 6000, debounceMs: 700, debounceFloorMs: 400, globalCooldownMs: 0,
    // brain hooks wired DIRECTLY (no postMessage) — here a mock that stands in for aiTextPlugin
    respond: function () { return Promise.resolve({ ok: true, value: replyText }); },
    judge: function () { return Promise.resolve({ ok: true, value: { action: 'reply', confidence: 1 } }); },
    factsFn: function () { return Promise.resolve({ ok: true, value: [] }); },
    // transport/scheduler hooks
    send: function (chId, body) { sent.push(body); var ms = Date.now(); queue.push({ id: snow(ms), channelId: 'solo', author: { id: BOT_ID, username: 'Chloe', bot: true }, content: body, timestamp: new Date(ms).toISOString() }); return Promise.resolve(true); },
    typing: function () { return Promise.resolve(true); },
    defer: function (fn, ms) { return setTimeout(fn, ms || 0); }
  }; }
  var engine = ChloeT0.createEngine({ transport: makeTransport(queue), store: store, clock: { now: Date.now }, log: function (line) { logs.push(line); }, config: buildCfg() });
  ok(engine && typeof engine.start === 'function', 'createEngine returned a running-capable engine with the Solo ports');

  userMsg(queue, 'hey chloe, i am building a chat app today');
  engine.start();

  // give the engine's own poll/debounce loop time to ingest -> decide -> respond
  setTimeout(function () {
    ok(sent.length >= 1, 'a user message drove the engine to call send() with a reply (' + sent.length + ' sent)');
    ok(sent[0] === replyText, 'the reply that went out is the brain hook output');
    ok(logs.some(function (l) { return /\[chloe\./.test(l); }), 'the engine emitted [chloe.*] thoughts for the mind drawer (' + logs.length + ' lines)');
    // her own line was fed back into the queue -> own-lines captured for conversation memory
    store_get('ownlines:solo').then(function (own) {
      ok(Array.isArray(own) && own.length >= 1, 'her own reply was captured into ownlines (conversation memory works)');
      engine.stop();
      console.log('\n' + (failures ? ('FAILURES: ' + failures) : 'ALL GREEN \u2014 the engine runs standalone as a 1:1 chat, unchanged'));
      process.exit(failures ? 1 : 0);
    });
  }, 6500);
  function store_get(k) { return store.get(k); }
})();
