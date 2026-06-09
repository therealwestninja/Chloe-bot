/* chloe-bridge — T0 presence engine (pure logic).
 *
 * Read-only presence: poll a channel, parse messages, build the roster (per-user partitions),
 * speaker ring, channel rhythm, and lastSeen. NO replies, NO moderation — T0 only.
 *
 * This file is the single source of truth for the loop logic. It is deliberately free of GM_*,
 * DOM, and network code: it takes a `transport`, a `store`, and a `clock` as dependencies, so it
 * runs identically under Node (mocks, for tests) and inside the userscript bridge (GM adapters).
 *
 * Data architecture (spec 3): the store is the system of record. Partitions are keyed `u:{authorId}`
 * and are prunable in one operation. The engine holds no durable state of its own — everything that
 * must survive a reload goes through `store`.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node / harness
  root.ChloeT0 = api;                                                        // userscript / window
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- snowflake helpers ------------------------------------------------------------------
  // Discord IDs are snowflakes: monotonically increasing, but longer than Number can hold, so
  // compare as BigInt. Ordering by id is the reliable chronological order.
  function snowflakeCmp(a, b) {
    var x = BigInt(a), y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function maxSnowflake(a, b) {
    if (a == null) return b;
    if (b == null) return a;
    return snowflakeCmp(a, b) >= 0 ? a : b;
  }

  // ---- engine -----------------------------------------------------------------------------
  // deps: { transport, store, clock, config, log }
  //   transport.getMessagesAfter(channelId, afterId|null, limit) -> Promise<Array<msg>>
  //     msg = { id, author: { id, username }, content, timestamp }
  //   store.get(key) / set(key, value) / del(key) / listIndex() / setIndex(arr)  (all async-ok)
  //   clock.now() -> ms epoch
  //   config = { channelId, botUserId, recentWindow, speakerRingSize, pollIntervalMs }
  //   log(...)  -> console-like
  function createEngine(deps) {
    var transport = deps.transport;
    var store = deps.store;
    var clock = deps.clock || { now: function () { return Date.now(); } };
    var log = deps.log || function () {};
    var cfg = Object.assign({
      channelId: null,
      botUserId: null,        // drop the bot's own messages by author id
      botName: null,          // for name-addressing ("chloe, ...")
      botAliases: [],         // extra nicknames she answers to (the short form of botName is added automatically)
      recentWindow: 25,       // rolling lines kept per user partition (distilled+window, spec dec #2)
      speakerRingSize: 8,     // last N distinct posters
      pollIntervalMs: 5000,
      onPoll: null,           // optional (summary) -> any; runs after EVERY poll (loop or manual)
      adaptivePolling: true,  // back off when quiet, snap to fast when active (spec 7.10)
      pollFloorMs: 4000,      // fastest cadence (active / pending work)
      pollCeilMs: 30000,      // slowest cadence (long quiet)
      // ---- T1 reply path (all optional; absent => pure T0 read-only) ----
      respond: null,          // async (context) -> { ok, value:text }   (the brain; runs in the generator page)
      send: null,             // async (channelId, text) -> any           (POST to Discord; runs in the userscript)
      addressMode: 'both',    // 'mention' | 'name' | 'both'
      cooldownMs: 8000,       // per-AUTHOR reply cooldown (don't spam the same person)
      globalCooldownMs: 2500, // min gap between ANY two of her sends (lets different people be answered promptly)
      debounceMs: 2500,       // wait for a lull before replying (don't reply mid-burst)
      contextLines: 12,       // recent channel lines handed to the brain (Tier C)
      // ---- image generation (off unless image + paint + sendImage supplied) ----
      image: false,           // master toggle: answer image requests
      paint: null,            // async ({prompt, resolution}) -> { ok, value:dataUrl }  (runs in the page; the plugin does the iframe song-and-dance)
      sendImage: null,        // async (channelId, dataUrl, caption) -> any            (multipart attachment; runs in the userscript)
      openDM: null,           // async (userId) -> channelId                            (for "dm me" delivery; userscript)
      imageVerbs: ['draw', 'paint', 'sketch', 'render', 'generate', 'make', 'imagine', 'create', 'show'],
      // Image generation runs on its OWN broker, so it threads with text. One image at a time
      // (broker concurrency is 1); imageCooldownMs is just a courtesy gap between images — the real
      // pace is generation time itself, so this is small, not a 30s artificial ceiling. Requests
      // beyond what's in flight wait in a global FIFO queue (no per-author cooldown for images).
      imageCooldownMs: 2000,  // courtesy gap between images (generation time is the real spacing)
      imageQueueMax: 8,       // global image queue depth (adjustable); extra requests are dropped with a note
      // ---- auto-moderation (off unless autoMod + rules supplied) ----
      autoMod: false,         // apply rule-based moderation with no mod present
      autoModRules: [],       // [{ pattern, type:'text'|'regex'|'confusables'|'link', action:'ignore'|'timeout'|'softban'|'warn', durationMs?, reason? }]
      // C1: strike ladder. A 'warn' action (rule or !chloe warn) increments a per-user strike count
      // that walks this reversible ladder by index (capped at the last step); strikes decay over time.
      strikeLadder: [
        { action: 'ignore' },
        { action: 'timeout', durationMs: 600000 },
        { action: 'timeout', durationMs: 3600000 },
        { action: 'softban' }
      ],
      strikeDecayMs: 86400000,  // one strike forgiven per ~24h of good behaviour
      // engagement mode: 'normal' (reply when addressed + volunteer gate), 'locked' (raid panic:
      // ignore everyone but mods; no greeting/volunteering; auto-mod still runs), 'open' (reply to
      // everyone in the channel — the "stream" mode; addressing no longer required).
      engageMode: 'normal',
      // #12: scheduled proactive beats — light, activity-gated time-based presence (lrrbot timers).
      // Each beat: { id, intervalMs, text? | texts?[] | prompt?, activeWithinMs? }. Fires at most one
      // per poll, only if the room has been active recently (won't talk to a dead/empty channel),
      // never during lockdown, never while she's already replying/painting.
      beats: [],
      beatActiveWithinMs: 1800000,  // a beat only fires if someone spoke within this window (30 min)
      beatMinGapMs: 600000,         // minimum gap between any two beats (10 min)
      beatFn: null,                 // optional (beat) -> {ok,value}; in-character generation for prompt-beats
      // ---- T2 volunteer gate (off unless volunteer + judge + react supplied) ----
      judge: null,            // async (context) -> { ok, value:{ action:'reply'|'react'|'ignore', confidence:0..1, emoji } }
      react: null,            // async (channelId, messageId, emoji) -> any
      volunteer: false,       // chime in on UN-addressed messages?
      volunteerCooldownMs: 45000,  // volunteering is rarer than answering
      judgeMinConfidence: 0.6,     // below this, a reply/react decays to ignore
      // ---- T3 reversible moderation ----
      modList: [],            // author.ids allowed to issue in-channel commands (seeded by trusted surface)
      commandPrefix: '!chloe',// text-prefix command grammar (no slash under Adapter A)
      commandPrefixes: [],    // optional extra prefixes (e.g. '!c', 'chloe,') — all resolve to the same commands
      ackCommands: true,      // post a brief in-channel confirmation when a command runs
      backgroundText: false,  // when on, the text lane is fire-and-forget (poll loop never blocks on generation)
      keepActionLog: true,    // T4: keep a separate, purge-surviving record of mod actions (decision #5)
      modLogContextLines: 5,  // #11: snapshot of the target's most recent lines captured with each mod action
      typing: null,           // optional async (channelId) -> POST typing; pulsed before a generation
      recapFn: null,          // optional async (ctx) -> { ok, value } channel summary for !chloe recap
      // ---- T5 presence depth ----
      greet: false,                  // opt-in: greet first-ever speakers and long-absent returners
      greetFn: null,                 // async (ctx) -> { ok, value } greeting line from the brain
      greetReturnAfterMs: 172800000, // gap >= 2d counts as "been a while" (shorter gaps stay silent)
      greetCooldownMs: 43200000,     // >=12h between greetings for one person (one per crossing, not per msg)
      greetDebounceMs: 4000,         // settle before greeting (people fire 2-3 lines on arrival)
      greetSettleMs: 60000,          // after Start, don't greet for this long (people already here aren't "arrivals")
      quietAfterMs: 86400000,        // active -> quiet once a user ages out of ~1d of attention
      decayAfterMs: 604800000,       // a return after >=7d quiet decays familiarity (warmth follows recency)
      decayFactor: 0.5,              // interactionCount *= this on a decayed return (never below 0)
      backfill: false,               // one-time: walk history backward to seed the roster
      backfillPageSize: 100, backfillMaxPages: 8,  // bounded + checkpointed; ingest only, never greets/replies
      maintenanceEveryPolls: 10      // run the quiet-sweep (active->quiet) every Nth poll, not every poll
    }, deps.config || {});

    var CURSOR_KEY = 'cursor:' + cfg.channelId;
    var INDEX_KEY = 'roster:index';
    var RING_KEY = 'speaker:ring:' + cfg.channelId;
    var RHYTHM_KEY = 'rhythm:' + cfg.channelId;
    var BACKFILL_KEY = 'backfill:' + cfg.channelId;
    var BEATS_KEY = 'beats:lastrun:' + cfg.channelId;   // #12: beatId -> last-fired ts (+ __lastAny)

    var running = false;
    var timer = null;

    // T1 reply state: a per-author queue (latest message per author) so one chatty user can't
    // starve replies to everyone else. A lost queue on reload is acceptable.
    var reply = { queue: {}, replying: false };
    var lastReplyAt = {};                // per-author: when she last replied to that person
    var gate = { pending: null };        // T2 volunteer candidate (latest un-addressed msg)
    var greet = { pending: null, greeting: false };  // T5 greeting candidate (settling-debounced)
    var paint = { queue: [], painting: false, lastJob: null };  // global image FIFO; one in flight at a time
    var lastPaintAt = 0;                 // last image delivery (image clock — independent of the text clock)
    var engageMode = (cfg.engageMode === 'locked' || cfg.engageMode === 'open') ? cfg.engageMode : 'normal';
    var lastCmdAt = {};                  // per-command last-run clock (for entry.cooldownMs)
    var lastActAt = 0;                   // global last-action clock (light global gap + volunteer cooldown)
    var startedAt = 0;                   // when the loop started (drives the greeting settle window)
    var pollCount = 0;                   // drives the periodic quiet-sweep cadence
    var warnedEmpty = false;             // one-time empty-content (Message Content Intent) notice
    var greetSettleLogged = false;       // one-time "suppressing greetings (just started)" notice
    function greetEnabled() { return cfg.greet && typeof cfg.greetFn === 'function' && typeof cfg.send === 'function'; }
    function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function replyEnabled() { return typeof cfg.respond === 'function' && typeof cfg.send === 'function'; }
    function hasPendingReply() { return Object.keys(reply.queue).length > 0; }
    function inGreetSettle(now) { return cfg.greetSettleMs > 0 && startedAt && (now - startedAt) < cfg.greetSettleMs; }
    function indicateTyping() { if (typeof cfg.typing === 'function') { try { Promise.resolve(cfg.typing(cfg.channelId)).catch(function () {}); } catch (e) {} } }
    function gateEnabled() { return cfg.volunteer && typeof cfg.judge === 'function' && replyEnabled(); }
    function nameAliases() {
      var out = [];
      if (cfg.botName) {
        out.push(String(cfg.botName));
        var short = String(cfg.botName).split(/[-_ ]/)[0];   // "chloe-bot" also answers to "chloe"
        if (short && short.length >= 2 && short !== cfg.botName) out.push(short);
      }
      (cfg.botAliases || []).forEach(function (a) { if (a) out.push(String(a)); });
      return out;
    }
    function isAddressed(content) {
      var c = String(content || '');
      var mentioned = cfg.botUserId && (c.indexOf('<@' + cfg.botUserId + '>') >= 0 || c.indexOf('<@!' + cfg.botUserId + '>') >= 0);
      var named = nameAliases().some(function (a) { return new RegExp('\\b' + escRe(a) + '\\b', 'i').test(c); });
      if (cfg.addressMode === 'mention') return !!mentioned;
      if (cfg.addressMode === 'name') return !!named;
      return !!(mentioned || named);
    }
    function imageEnabled() { return cfg.image && typeof cfg.paint === 'function' && typeof cfg.sendImage === 'function' && typeof cfg.send === 'function'; }
    function scrubDiscordTokens(c) {
      return String(c || '')
        .replace(/<@!?\d+>/g, ' ')       // user mentions
        .replace(/<@&\d+>/g, ' ')        // role mentions (the bot is often pinged by role)
        .replace(/<#\d+>/g, ' ')         // channel mentions
        .replace(/<a?:\w+:\d+>/g, ' ')   // custom/animated emoji
        .replace(/\s+/g, ' ').trim();
    }
    function stripAddressing(c) {
      c = scrubDiscordTokens(c);
      nameAliases().forEach(function (a) { if (a) c = c.replace(new RegExp('\\b' + escRe(a) + '\\b', 'ig'), ' '); });
      return c.replace(/\s+/g, ' ').trim();
    }
    function pickResolution(p) {
      if (/\b(portrait|selfie|headshot)\b/i.test(p)) return '512x768';
      if (/\b(landscape|wide.?angle|scenery|panorama|vista)\b/i.test(p)) return '768x512';
      return '768x768';
    }
    // Returns null, or { prompt, dm, resolution }. An image request is an addressed message whose
    // body opens with an image verb ("draw a cat") or names an image noun ("a picture of a cat").
    // Empty prompts hang the plugin forever, so we refuse anything without real description text.
    function parseImageRequest(content) {
      if (!imageEnabled()) return null;
      var raw = String(content || '');
      var body = stripAddressing(raw).replace(/^[\s,:;.!?-]+/, '');
      var verbs = (cfg.imageVerbs || []).map(escRe).join('|');
      if (!verbs) return null;
      var lead = new RegExp('^(?:can you |could you |would you |will you |please |pls |hey |go )*(?:' + verbs + ')\\b', 'i');
      var m = lead.exec(body);
      var hasNoun = /\b(image|picture|pic|photo|selfie|drawing|art|portrait)\b/i.test(body);
      if (!m && !hasNoun) return null;
      var prompt = m ? body.slice(m[0].length) : body;
      prompt = prompt
        .replace(/^[\s,:;.!?-]+/, '')
        .replace(/^(?:me |us |a |an |the |yourself |your |some )+/i, '')
        .replace(/^(?:of |for |with |showing |depicting )+/i, '')
        .replace(/\b(image|picture|pic|photo|drawing)\s+of\b/i, '')
        .replace(/^[\s,:;.!?-]+/, '')
        .replace(/[\s,:;.!?]+$/, '')
        .trim();
      var dm = /\b(dm|dms|privately|in private|direct message)\b/i.test(raw) || /\bin (a|my) dm\b/i.test(raw);
      if (dm) prompt = prompt.replace(/\b(in (a|my) )?(dm|dms|privately|in private|private|direct message)\b/ig, '').replace(/\s+/g, ' ').trim();
      if (!prompt || prompt.replace(/[^a-z0-9]/ig, '').length < 2) return null;  // no real description -> would hang
      return { prompt: prompt.slice(0, 400), dm: dm, resolution: pickResolution(prompt) };
    }
    function isTwoPersonExchange(ring) {
      var distinct = []; (ring || []).forEach(function (id) { if (distinct.indexOf(id) < 0) distinct.push(id); });
      return (ring || []).length >= 3 && distinct.length === 2 && distinct.indexOf(cfg.botUserId) < 0;
    }

    // ---- auto-moderation -----------------------------------------------------------------
    // Only ever applies REVERSIBLE actions (ignore/timeout/softban) — never an auto-permaban (F1).
    var REVERSIBLE_ACTIONS = { ignore: 1, timeout: 1, softban: 1, clear: 1 };
    // Compact homoglyph fold so "frее nitro" (Cyrillic е) can't dodge a "free nitro" rule. NFKD
    // handles fullwidth/compatibility forms; the map covers common Cyrillic/Greek look-alikes.
    var CONFUSABLES = { '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u043a': 'k', '\u043c': 'm', '\u0442': 't', '\u0432': 'b', '\u043d': 'h', '\u0456': 'i', '\u0455': 's', '\u0458': 'j', '\u03bf': 'o', '\u03c1': 'p', '\u03b5': 'e', '\u03b1': 'a', '\u03b9': 'i', '\u03ba': 'k', '\u03bd': 'v', '\u03c4': 't' };
    function confusablesNormalize(s) {
      s = String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      var out = '';
      for (var i = 0; i < s.length; i++) { var ch = s.charAt(i); out += (CONFUSABLES[ch] || ch); }
      return out.replace(/\s+/g, ' ');
    }
    function autoModEnabled() { return !!cfg.autoMod && (cfg.autoModRules || []).length > 0; }
    // Pull URL-ish tokens out of a message so a 'link' rule can target a domain precisely (and
    // confusables-folded), rather than matching the whole message. NOTE: we deliberately do NOT
    // follow redirects to canonicalize shorteners — that would mean the user's browser fetching
    // arbitrary URLs from chat (SSRF/tracking risk) and a wildcard @connect grant; not worth it here.
    function extractUrls(s) {
      var out = [], re = /((?:https?:\/\/|www\.)[^\s<>]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>]*)?)/gi, m;
      while ((m = re.exec(String(s || ''))) !== null) { out.push(m[1]); if (re.lastIndex === m.index) re.lastIndex++; }
      return out;
    }
    function matchAutoMod(content) {
      var raw = String(content || '');
      var rules = cfg.autoModRules || [];
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i]; if (!r || !r.pattern) continue;
        var type = r.type || 'text', hit = false;
        if (type === 'regex') { try { hit = new RegExp(r.pattern, r.flags || 'i').test(raw); } catch (e) { hit = false; } }
        else if (type === 'confusables') { hit = confusablesNormalize(raw).indexOf(confusablesNormalize(r.pattern)) >= 0; }
        else if (type === 'link') { var needle = confusablesNormalize(r.pattern); hit = extractUrls(raw).some(function (u) { return confusablesNormalize(u).indexOf(needle) >= 0; }); }
        else { hit = raw.toLowerCase().indexOf(String(r.pattern).toLowerCase()) >= 0; }
        if (hit) return r;
      }
      return null;
    }

    // ---- T3: moderation state ------------------------------------------------------------
    function isMod(id) { return (cfg.modList || []).indexOf(id) >= 0; }
    function applyExpiry(p, now) {
      if (p && p.state === 'timeout' && p.until && now >= p.until) { p.state = 'active'; p.until = null; return true; }
      return false;
    }
    function isSuppressed(p, now) {
      if (!p) return false;
      applyExpiry(p, now);
      return p.state === 'ignored' || p.state === 'soft-ban' || (p.state === 'timeout' && p.until && now < p.until);
    }
    function durToMs(n, u) {
      n = parseInt(n, 10); u = String(u).toLowerCase();
      var mult = u === 's' ? 1000 : u === 'm' ? 60000 : u === 'h' ? 3600000 : 86400000;
      return n * mult;
    }
    function fmtDur(ms) {
      if (ms >= 86400000) return Math.round(ms / 86400000) + 'd';
      if (ms >= 3600000) return Math.round(ms / 3600000) + 'h';
      if (ms >= 60000) return Math.round(ms / 60000) + 'm';
      return Math.round(ms / 1000) + 's';
    }
    function ensureIndexed(id) {
      return Promise.resolve(store.listIndex()).then(function (ids) {
        ids = ids || [];
        if (ids.indexOf(id) < 0) { ids.push(id); return store.setIndex(ids); }
      });
    }
    // The single state-mutation primitive. Used by both in-channel commands (after a mod-list
    // check) and trusted panel actions (no check — the operator's surface is already trusted).
    function applyModAction(action, targetId, opts) {
      opts = opts || {};
      if (!targetId) return Promise.resolve({ ok: false, reason: 'no target user' });
      return Promise.resolve(store.get(partKey(targetId))).then(function (p) {
        var now = clock.now();
        if (!p) p = { id: targetId, name: opts.targetName || targetId, firstSeen: now, lastSeen: now, interactionCount: 0, state: 'active', recent: [] };
        var ack;
        if (action === 'ignore') { p.state = 'ignored'; p.until = null; ack = 'ignoring ' + (p.name || targetId); }
        else if (action === 'timeout') { var dms = opts.durationMs || 3600000; p.state = 'timeout'; p.until = now + dms; ack = 'timed out ' + (p.name || targetId) + ' for ' + fmtDur(dms); }
        else if (action === 'softban') { p.state = 'soft-ban'; p.until = null; ack = 'soft-banned ' + (p.name || targetId); }
        else if (action === 'clear') { p.state = 'active'; p.until = null; p.strikes = 0; p.lastStrikeAt = null; ack = 'cleared state for ' + (p.name || targetId); }
        else if (action === 'note') { ack = 'noted ' + (p.name || targetId); }
        else return { ok: false, reason: 'unknown action: ' + action };
        if (opts.reason) p.modNote = String(opts.reason);
        p.byModId = opts.byModId || null;
        p.modAt = now;
        // #11: capture what this person was saying, so the mod (or the auto-mod audit trail) has context.
        var context = (p.recent || []).slice(-(cfg.modLogContextLines || 5)).map(function (ln) { return { ts: ln.ts, text: scrubDiscordTokens(ln.content || '') }; });
        return ensureIndexed(targetId).then(function () {
          return store.set(partKey(targetId), p).then(function () {
            return appendModLog({ action: action, targetId: targetId, name: p.name || targetId, byModId: opts.byModId || null, reason: opts.reason || null, at: now, state: p.state, context: context }).then(function () {
              return { ok: true, value: { action: action, targetId: targetId, state: p.state, until: p.until, ack: ack } };
            });
          });
        });
      });
    }

    // C1: a strike bumps a per-user counter (decayed first by elapsed good behaviour) and applies the
    // ladder step for the new level — escalating but always reversible (never an auto-permaban).
    function applyStrike(targetId, opts) {
      opts = opts || {};
      if (!targetId) return Promise.resolve({ ok: false, reason: 'no target user' });
      return Promise.resolve(store.get(partKey(targetId))).then(function (p) {
        var now = clock.now();
        if (!p) p = { id: targetId, name: opts.targetName || targetId, firstSeen: now, lastSeen: now, interactionCount: 0, state: 'active', recent: [] };
        var decayMs = cfg.strikeDecayMs || 0, prev = p.strikes || 0;
        if (decayMs > 0 && p.lastStrikeAt) { var forgiven = Math.floor((now - p.lastStrikeAt) / decayMs); if (forgiven > 0) prev = Math.max(0, prev - forgiven); }
        p.strikes = prev + 1; p.lastStrikeAt = now;
        return store.set(partKey(targetId), p).then(function () {
          var ladder = (cfg.strikeLadder && cfg.strikeLadder.length) ? cfg.strikeLadder : [{ action: 'ignore' }];
          var step = ladder[Math.min(p.strikes - 1, ladder.length - 1)] || { action: 'ignore' };
          var act = REVERSIBLE_ACTIONS[step.action] ? step.action : 'ignore';   // strikes never permaban (F1)
          var reason = (opts.reason ? opts.reason + ' ' : '') + '(strike ' + p.strikes + ')';
          return applyModAction(act, targetId, { durationMs: step.durationMs, reason: reason, byModId: opts.byModId || null }).then(function (res) {
            if (res && res.ok && res.value) res.value.strikes = p.strikes;
            return res;
          });
        });
      });
    }

    function removeFromIndex(id) {
      return Promise.resolve(store.listIndex()).then(function (ids) {
        var next = (ids || []).filter(function (x) { return x !== id; });
        return store.setIndex(next);
      });
    }
    // Separate, purge-surviving record of what mods DID (not a memory of the user) — spec 5.6/decision #5.
    function appendModLog(entry) {
      if (!cfg.keepActionLog) return Promise.resolve(false);
      return Promise.resolve(store.get('modlog')).then(function (log) {
        log = log || [];
        log.push(entry);
        if (log.length > 500) log = log.slice(-500);
        return store.set('modlog', log).then(function () { return true; });
      });
    }
    function getModLog() { return Promise.resolve(store.get('modlog')).then(function (l) { return l || []; }); }

    // ---- T5 lifecycle / departure / backfill ---------------------------------------------
    // active -> quiet: a user who has aged out of the attention window (not under moderation).
    function quietSweep() {
      var now = clock.now();
      return Promise.resolve(store.listIndex()).then(function (ids) {
        var chain = Promise.resolve(), demoted = 0;
        (ids || []).forEach(function (id) {
          chain = chain.then(function () {
            return Promise.resolve(store.get(partKey(id))).then(function (p) {
              if (!p || p.lifecycle === 'departed') return;
              if (p.state && p.state !== 'active') return;       // moderation rows are not "quiet"
              if ((now - (p.lastSeen || 0)) >= cfg.quietAfterMs && p.lifecycle !== 'quiet') {
                p.lifecycle = 'quiet'; demoted++; return store.set(partKey(id), p);
              }
            });
          });
        });
        return chain.then(function () { return demoted; });
      });
    }
    // Bounded, prioritized list of users worth a 404 membership check (transport runs the checks).
    function dueForMemberCheck(max) {
      max = max || 5; var now = clock.now();
      return Promise.resolve(store.listIndex()).then(function (ids) {
        return Promise.all((ids || []).map(function (id) { return Promise.resolve(store.get(partKey(id))); })).then(function (ps) {
          var cands = [];
          ps.forEach(function (p) {
            if (!p || p.lifecycle === 'departed') return;
            if ((now - (p.lastSeen || 0)) < cfg.quietAfterMs) return;           // only aged-out users
            if ((now - (p.lastMemberCheckAt || 0)) < cfg.quietAfterMs) return;  // don't re-check too often
            cands.push({ id: p.id, name: p.name, silentMs: now - (p.lastSeen || 0) });
          });
          cands.sort(function (a, b) { return b.silentMs - a.silentMs; });       // longest-silent first
          return cands.slice(0, max);
        });
      });
    }
    function noteMemberPresent(id) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) { if (!p) return; p.lastMemberCheckAt = clock.now(); return store.set(partKey(id), p); });
    }
    // 404-confirmed gone: clear ordinary memory, but KEEP any moderation row (a soft-ban must survive
    // a departure so it still applies if they return). Quiet adjustment only — never announced.
    function markDeparted(id) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p) return { ok: false, reason: 'unknown' };
        p.lifecycle = 'departed'; p.departedAt = clock.now();
        p.recent = []; p.interactionCount = 0; p.lastGreetedAt = null;
        return store.set(partKey(id), p).then(function () { return { ok: true, value: { id: id, name: p.name } }; });
      });
    }
    function ingestHistorical(msg) {
      var id = msg.author.id;
      if (cfg.botUserId && id === cfg.botUserId) return Promise.resolve();
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        var seenAt = toEpoch(msg.timestamp);
        if (!p) p = { id: id, name: msg.author.username, firstSeen: seenAt, lastSeen: seenAt, interactionCount: 0, state: 'active', lifecycle: 'quiet', recent: [] };
        p.name = p.name || msg.author.username;
        p.firstSeen = Math.min(p.firstSeen || seenAt, seenAt);
        if (p.recent.length < cfg.recentWindow) p.recent.push({ id: msg.id, ts: seenAt, content: msg.content || '' });
        return ensureIndexed(id).then(function () { return store.set(partKey(id), p); });
      });
    }
    // One bounded, checkpointed page of history per call (ingest only — never greets or replies).
    function backfillStep(fetchBefore) {
      return Promise.resolve(store.get(BACKFILL_KEY)).then(function (cp) {
        cp = cp || { before: null, pages: 0, done: false, ingested: 0 };
        if (cp.done) return { done: true, pages: cp.pages, ingested: cp.ingested };
        if (cp.pages >= cfg.backfillMaxPages) { cp.done = true; return store.set(BACKFILL_KEY, cp).then(function () { return { done: true, pages: cp.pages, ingested: cp.ingested, reason: 'maxPages' }; }); }
        var startP = cp.before ? Promise.resolve(cp.before) : Promise.resolve(store.get(CURSOR_KEY));
        return startP.then(function (before) {
          return Promise.resolve(fetchBefore(before || null, cfg.backfillPageSize)).then(function (msgs) {
            msgs = msgs || [];
            if (!msgs.length) { cp.done = true; return store.set(BACKFILL_KEY, cp).then(function () { return { done: true, pages: cp.pages, ingested: cp.ingested, reason: 'empty' }; }); }
            var oldest = msgs[0].id; msgs.forEach(function (m) { if (snowflakeCmp(m.id, oldest) < 0) oldest = m.id; });
            var chain = Promise.resolve(), n = 0;
            msgs.forEach(function (m) { chain = chain.then(function () { n++; return ingestHistorical(m); }); });
            return chain.then(function () {
              cp.before = oldest; cp.pages += 1; cp.ingested += n;
              if (msgs.length < cfg.backfillPageSize) cp.done = true;
              return store.set(BACKFILL_KEY, cp).then(function () { return { done: cp.done, pages: cp.pages, ingested: cp.ingested }; });
            });
          });
        });
      });
    }

    // T4: irreversible purge. Deletes the partition and de-indexes, then VERIFIES the delete
    // actually round-tripped (the partition is truly gone) — a silently-failed moderation delete
    // is the one bug that matters most, so we never *assume* it worked.
    function purge(targetId, opts) {
      opts = opts || {};
      if (!targetId) return Promise.resolve({ ok: false, reason: 'no target' });
      return Promise.resolve(store.get(partKey(targetId))).then(function (p) {
        var name = (p && p.name) || opts.targetName || targetId;
        return Promise.resolve(store.del(partKey(targetId)))
          .then(function () { return removeFromIndex(targetId); })
          .then(function () { return Promise.resolve(store.get(partKey(targetId))); })   // read back
          .then(function (after) {
            return store.listIndex().then(function (ids) {
              var gone = (after == null) && (ids || []).indexOf(targetId) < 0;
              if (!gone) return { ok: false, verified: false, name: name, reason: 'delete did NOT round-trip (partition still present in the store)' };
              return { ok: true, verified: true, name: name, targetId: targetId };
            });
          });
      });
    }

    // Command registry: one declarative table is the single source of truth for which verbs exist,
    // how their args parse, whether they need a target, and the help text. parseCommand + execCommand
    // + help are all generated from it (no more KNOWN_CMDS / CMD_ACTION / hand-written help drift).
    // aliases[] is supported (emoji/short forms) though none are defined yet — see roadmap #10.
    var COMMANDS = [
      { verb: 'ignore',    modOnly: true, needsTarget: true, action: 'ignore',  help: 'ignore @u' },
      { verb: 'unignore',  modOnly: true, needsTarget: true, action: 'clear' },
      { verb: 'timeout',   modOnly: true, needsTarget: true, takesDuration: true, action: 'timeout', help: 'timeout @u 1h [reason]' },
      { verb: 'untimeout', modOnly: true, needsTarget: true, action: 'clear' },
      { verb: 'softban',   modOnly: true, needsTarget: true, action: 'softban', help: 'softban @u' },
      { verb: 'unsoftban', modOnly: true, needsTarget: true, action: 'clear' },
      { verb: 'clear',     modOnly: true, needsTarget: true, action: 'clear',   help: 'clear @u' },
      { verb: 'note',      modOnly: true, needsTarget: true, action: 'note',    help: 'note @u <text>' },
      { verb: 'warn',      modOnly: true, needsTarget: true, action: 'warn',    aliases: ['\u26a0\ufe0f'], help: 'warn @u [reason]' },
      { verb: 'warns',     modOnly: true, needsTarget: true, help: 'warns @u', handler: function (modId, c) {
          if (!c.targetId) return Promise.resolve({ ack: 'warns needs an @mention of the user' });
          return Promise.resolve(store.get(partKey(c.targetId))).then(function (p) {
            if (!p) return { ack: 'I have no record of that user' };
            var n = p.strikes || 0;
            return { ack: (p.name || c.targetId) + ': ' + n + ' strike' + (n === 1 ? '' : 's') + (p.state && p.state !== 'active' ? ' \u2014 currently ' + p.state : '') };
          });
        } },
      { verb: 'recap',     modOnly: true, cooldownMs: 20000, aliases: ['\ud83d\udcdc'], help: 'recap', handler: function (modId) {
          if (typeof cfg.recapFn !== 'function') return Promise.resolve({ ack: 'recap is not available right now' });
          return assembleContext({ authorId: modId, authorName: '' }).then(function (ctx) {
            return Promise.resolve(cfg.recapFn({ recent: ctx })).then(function (res) {
              var v = (res && res.ok && res.value) ? String(res.value) : 'not much has happened that I can see';
              return { ack: v, embed: embedFor('Recap', v) };
            }, function () { return { ack: 'recap failed' }; });
          });
        } },
      { verb: 'status',    modOnly: true, cooldownMs: 5000, aliases: ['\ud83d\udcca'], help: 'status', handler: function () { return Promise.resolve({ ack: statusText(), embed: statusEmbed() }); } },
      { verb: 'lockdown',  modOnly: true, aliases: ['lock', '\ud83d\udd12'], help: 'lockdown', handler: function () { engageMode = 'locked'; log('[chloe.mode] lockdown (mods only)'); return Promise.resolve({ ack: 'locked down \u2014 I\u2019ll only respond to mods until you ' + cfg.commandPrefix + ' unlock.' }); } },
      { verb: 'unlock',    modOnly: true, aliases: ['\ud83d\udd13'], help: 'unlock', handler: function () { engageMode = 'normal'; log('[chloe.mode] back to normal'); return Promise.resolve({ ack: 'unlocked \u2014 back to normal.' }); } },
      { verb: 'open',      modOnly: true, aliases: ['openchat', '\ud83d\udce2'], help: 'open', handler: function () { engageMode = 'open'; log('[chloe.mode] open (reply to everyone)'); return Promise.resolve({ ack: 'open mode \u2014 I\u2019ll reply to everyone in here. ' + cfg.commandPrefix + ' unlock to stop.' }); } },
      { verb: 'help',      modOnly: true, cooldownMs: 5000, aliases: ['?', '\ud83c\udd98'], handler: function () { return Promise.resolve({ ack: helpText(), embed: helpEmbed() }); } },
      { verb: 'forget',    modOnly: false, special: 'forget', help: 'forget me' }
    ];
    function resolveVerb(word) {
      word = String(word || '').toLowerCase();
      for (var i = 0; i < COMMANDS.length; i++) {
        if (COMMANDS[i].verb === word) return COMMANDS[i];
        if (COMMANDS[i].aliases && COMMANDS[i].aliases.indexOf(word) >= 0) return COMMANDS[i];
      }
      return null;
    }
    function looksLikeCommand(content) {
      return matchedPrefix(String(content || '').trim()) !== null;
    }
    function prefixList() {
      var arr = [];
      if (cfg.commandPrefix) arr.push(String(cfg.commandPrefix));
      if (Array.isArray(cfg.commandPrefixes)) cfg.commandPrefixes.forEach(function (p) { if (p) arr.push(String(p)); });
      if (!arr.length) arr.push('!chloe');
      return arr;
    }
    function matchedPrefix(trimmed) {   // longest first so "!chloe" wins over a shorter "!c"
      var lc = String(trimmed || '').toLowerCase();
      var arr = prefixList().slice().sort(function (a, b) { return b.length - a.length; });
      for (var i = 0; i < arr.length; i++) { if (arr[i] && lc.indexOf(arr[i].toLowerCase()) === 0) return arr[i]; }
      return null;
    }
    function parseCommand(content) {
      var raw = String(content || '');
      var c = raw.trim();
      var pfx = matchedPrefix(c);
      if (pfx == null) return null;
      var rest = c.slice(pfx.length).trim();
      if (!rest) return { cmd: 'help', entry: resolveVerb('help'), targetId: null, durationMs: null, reason: '', raw: raw };
      var tokens = rest.split(/\s+/);
      var entry = resolveVerb(tokens.shift());
      if (!entry) return null;   // "!chloe Hi there" is chat, not a command — don't swallow it
      var mm = raw.match(/<@!?(\d+)>/);
      var targetId = mm ? mm[1] : null;
      var durationMs = null, reasonTokens = [];
      tokens.forEach(function (t) {
        if (/^<@!?\d+>$/.test(t)) return;
        var dm = t.match(/^(\d+)([smhd])$/i);
        if (dm && durationMs == null && entry.takesDuration) { durationMs = durToMs(dm[1], dm[2]); return; }
        reasonTokens.push(t);
      });
      return { cmd: entry.verb, entry: entry, targetId: targetId, durationMs: durationMs, reason: reasonTokens.join(' ').trim(), raw: raw };
    }
    function helpText() {
      var p = cfg.commandPrefix;
      var withHelp = COMMANDS.filter(function (c) { return c.help; });
      var mod = withHelp.filter(function (c) { return c.modOnly; }).map(function (c) { return p + ' ' + c.help; });
      var any = withHelp.filter(function (c) { return !c.modOnly; }).map(function (c) { return p + ' ' + c.help; });
      return 'Chloe mod commands: ' + mod.join(' | ') + '. Anyone: ' + any.join(' | ') + '.';
    }
    function statusText() {
      return 'Chloe here. mode=' + engageMode + ', replies=' + cfg.addressMode + (cfg.volunteer ? ' +volunteer' : '') + '. mods can ' + cfg.commandPrefix + ' help.';
    }
    // #8: rich embeds for help/status/recap (used when the transport offers sendEmbed; text is the fallback).
    var EMBED_COLOR = 0x8b5cf6;   // Chloe's accent
    function embedFor(title, desc, fields) {
      var e = { title: title, color: EMBED_COLOR, footer: { text: 'Chloe' } };
      if (desc) e.description = String(desc).slice(0, 4000);
      if (fields && fields.length) e.fields = fields;
      return e;
    }
    function helpEmbed() {
      var p = cfg.commandPrefix;
      var withHelp = COMMANDS.filter(function (c) { return c.help; });
      var mod = withHelp.filter(function (c) { return c.modOnly; }).map(function (c) { return '`' + p + ' ' + c.help + '`'; });
      var any = withHelp.filter(function (c) { return !c.modOnly; }).map(function (c) { return '`' + p + ' ' + c.help + '`'; });
      return embedFor('Chloe \u2014 commands', null, [
        { name: 'Mods', value: mod.join('\n') || '\u2014' },
        { name: 'Anyone', value: any.join('\n') || '\u2014' }
      ]);
    }
    function statusEmbed() {
      return embedFor('Chloe \u2014 status', null, [
        { name: 'engagement', value: engageMode, inline: true },
        { name: 'replies', value: String(cfg.addressMode) + (cfg.volunteer ? ' + volunteer' : ''), inline: true },
        { name: 'images', value: cfg.image ? 'on' : 'off', inline: true },
        { name: 'auto-mod', value: (cfg.autoMod && (cfg.autoModRules || []).length) ? ((cfg.autoModRules || []).length + ' rule(s)') : 'off', inline: true }
      ]);
    }
    function execCommand(modId, c) {
      var entry = c.entry || resolveVerb(c.cmd);
      if (!entry) return Promise.resolve({ ack: 'unknown command "' + c.cmd + '" \u2014 try ' + cfg.commandPrefix + ' help' });
      if (entry.cooldownMs) {
        var now = clock.now();
        if (now - (lastCmdAt[entry.verb] || 0) < entry.cooldownMs) { log('[chloe.cmd] "' + entry.verb + '" suppressed (per-command cooldown)'); return Promise.resolve({}); }
        lastCmdAt[entry.verb] = now;
      }
      if (typeof entry.handler === 'function') return Promise.resolve(entry.handler(modId, c));
      if (entry.action) {
        if (entry.needsTarget && !c.targetId) return Promise.resolve({ ack: c.cmd + ' needs an @mention of the user' });
        if (entry.action === 'warn') return applyStrike(c.targetId, { reason: c.reason, byModId: modId })
          .then(function (r) { return { ack: r.ok ? (r.value.ack + ' (strike ' + r.value.strikes + ')') : ('failed: ' + r.reason) }; });
        return applyModAction(entry.action, c.targetId, { durationMs: c.durationMs, reason: c.reason, byModId: modId })
          .then(function (r) { return { ack: r.ok ? r.value.ack : ('failed: ' + r.reason) }; });
      }
      return Promise.resolve({ ack: 'unknown command "' + c.cmd + '" \u2014 try ' + cfg.commandPrefix + ' help' });
    }
    // T5 user opt-out: anyone may ask Chloe to forget THEM (self-prune). Never lets a moderated
    // user escape a soft-ban/timeout — the moderation row is kept, only ordinary memory is cleared.
    function forgetMe(id, name) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        var ackMsg;
        function ackSend() { return typeof cfg.send === 'function' ? Promise.resolve(cfg.send(cfg.channelId, ackMsg)) : Promise.resolve(); }
        if (!p) { ackMsg = 'okay ' + name + ', there was nothing to forget'; return ackSend(); }
        if (p.state && p.state !== 'active') {
          p.recent = []; p.interactionCount = 0; p.lastGreetedAt = null; p.lifecycle = 'active';
          ackMsg = 'okay ' + name + ', I\u2019ve cleared what I remember (any moderation still stands).';
          return store.set(partKey(id), p).then(ackSend);
        }
        ackMsg = 'okay ' + name + ', I\u2019ve forgotten you.';
        return purge(id, { targetName: name }).then(ackSend);
      });
    }
    function greetTierFor(info, p, now) {
      if (info.brandNew) return 'intro';
      if (p && p.lastGreetedAt && (now - p.lastGreetedAt) < cfg.greetCooldownMs) return 'none';
      if (info.gapMs != null && info.gapMs >= cfg.greetReturnAfterMs) return 'return';
      return 'none';
    }

    // Process commands and select reply/volunteer/greeting candidates from the messages that are
    // NOT commands and NOT from suppressed users. State gates BEFORE judgment runs.
    function processCommandsAndSelect(incoming, touched) {
      var authorIds = [];
      incoming.forEach(function (m) { if (authorIds.indexOf(m.author.id) < 0) authorIds.push(m.author.id); });
      return Promise.all(authorIds.map(function (id) { return Promise.resolve(store.get(partKey(id))); })).then(function (parts) {
        var now = clock.now();
        var stateById = {}, commandAuthors = {};
        authorIds.forEach(function (id, i) { var p = parts[i]; if (p) { applyExpiry(p, now); stateById[id] = p.state || 'active'; } else stateById[id] = 'active'; });
        var acks = [], embeds = [], commandCount = 0, addressedName = null, imageReqName = null;
        var canEmbed = typeof cfg.sendEmbed === 'function';
        var chain = Promise.resolve();
        incoming.forEach(function (m) {
          chain = chain.then(function () {
            var c = parseCommand(m.content);
            if (c) {
              commandCount++; commandAuthors[m.author.id] = true;
              if (c.cmd === 'forget') return forgetMe(m.author.id, m.author.username);  // anyone, self only
              if (isMod(m.author.id)) return execCommand(m.author.id, c).then(function (res) { if (res) { if (canEmbed && res.embed) embeds.push(res.embed); else if (res.ack) acks.push(res.ack); } });
              log('[chloe.T3] ignoring command from non-mod ' + (m.author.username || m.author.id));
              return;
            }
            if (looksLikeCommand(m.content)) log('[chloe.T3] "' + String(m.content || '').slice(0, 40) + '" starts with ' + cfg.commandPrefix + ' but is not a known command \u2014 treating as normal chat');
            // Auto-mod watches everyone except mods, BEFORE the engagement-suppression gate, so a
            // repeat offender who is already ignored/timed-out still escalates up the strike ladder.
            // Skip only the terminal soft-ban (already maximally handled reversibly — re-moderating is moot).
            if (autoModEnabled() && !isMod(m.author.id) && stateById[m.author.id] !== 'soft-ban') {
              var rule = matchAutoMod(m.content);
              if (rule) {
                commandAuthors[m.author.id] = true;   // handled — don't also reply/greet this person this batch
                if (rule.action === 'warn') {   // C1: escalate along the strike ladder
                  log('[chloe.automod] rule "' + String(rule.pattern).slice(0, 30) + '" (' + (rule.type || 'text') + ') matched ' + (m.author.username || m.author.id) + ' \u2192 warn');
                  return applyStrike(m.author.id, { reason: rule.reason || ('auto-mod: ' + rule.pattern), byModId: 'auto' });
                }
                var act = REVERSIBLE_ACTIONS[rule.action] ? rule.action : 'ignore';   // never auto-permaban (F1)
                log('[chloe.automod] rule "' + String(rule.pattern).slice(0, 30) + '" (' + (rule.type || 'text') + ') matched ' + (m.author.username || m.author.id) + ' \u2192 ' + act);
                return applyModAction(act, m.author.id, { durationMs: rule.durationMs, reason: rule.reason || ('auto-mod: ' + rule.pattern), byModId: 'auto' });
              }
            }
            if (stateById[m.author.id] && stateById[m.author.id] !== 'active') return; // suppressed: invisible to engagement
            if (engageMode === 'locked' && !isMod(m.author.id)) return;   // raid lockdown: only mods get engagement (auto-mod above still ran)
            var addressed = isAddressed(m.content) || (engageMode === 'open');
            if (imageEnabled() && addressed) {
              var imgReq = parseImageRequest(m.content);
              if (imgReq) {
                if (paint.queue.length >= cfg.imageQueueMax) {
                  log('[chloe.img] queue full (' + paint.queue.length + '/' + cfg.imageQueueMax + '); dropping request from ' + (m.author.username || m.author.id));
                  if (typeof cfg.send === 'function') { try { cfg.send(cfg.channelId, 'i\u2019ve got a few images going already, ' + m.author.username + ' \u2014 ask me again in a moment'); } catch (e) {} }
                } else {
                  paint.queue.push({ messageId: m.id, authorId: m.author.id, authorName: m.author.username, prompt: imgReq.prompt, resolution: imgReq.resolution, dm: imgReq.dm, at: now });
                }
                if (reply.queue[m.author.id]) delete reply.queue[m.author.id];   // image supersedes a text reply this turn
                if (greet.pending && greet.pending.authorId === m.author.id) greet.pending = null;
                imageReqName = m.author.username;
                return;
              }
            }
            if (replyEnabled() && addressed) {
              reply.queue[m.author.id] = { messageId: m.id, authorId: m.author.id, authorName: m.author.username, content: m.content || '', at: now };
              if (greet.pending && greet.pending.authorId === m.author.id) greet.pending = null;  // replying IS the engagement
              addressedName = m.author.username;
            } else if (gateEnabled() && engageMode === 'normal') {
              gate.pending = { messageId: m.id, authorId: m.author.id, authorName: m.author.username, content: m.content || '', at: now };
            }
          });
        });
        return chain.then(function () {
          if (imageReqName) log('[chloe.img] image requested by ' + imageReqName + '; queued (debounce ' + cfg.debounceMs + 'ms)');
          if (addressedName) log('[chloe.T1] addressed by ' + addressedName + '; reply queued (debounce ' + cfg.debounceMs + 'ms)');
          // T5: pick at most one greeting candidate (intro beats return); never the person we're already
          // engaging, never a command author this batch, never a suppressed user — and not during the
          // settle window right after Start (people already in the room aren't fresh arrivals).
          if (greetEnabled() && engageMode !== 'locked' && touched && touched.greetInfo && !inGreetSettle(now)) {
            var pick = null;
            authorIds.forEach(function (id, i) {
              var info = touched.greetInfo[id]; if (!info) return;
              if (stateById[id] && stateById[id] !== 'active') return;
              if (commandAuthors[id]) return;
              if (reply.queue[id]) return;
              var tier = greetTierFor(info, parts[i], now);
              if (tier === 'none') return;
              if (!pick || (tier === 'intro' && pick.tier !== 'intro')) pick = { authorId: id, tier: tier, gapMs: info.gapMs, name: info.name, at: now };
            });
            if (pick) { greet.pending = pick; log('[chloe.T5] greeting queued for ' + pick.name + ' (' + pick.tier + ', settle ' + cfg.greetDebounceMs + 'ms)'); }
          }
          if (greetEnabled() && inGreetSettle(now) && !greetSettleLogged) {
            greetSettleLogged = true;
            log('[chloe.T5] greetings paused for ~' + Math.round(cfg.greetSettleMs / 1000) + 's after start (current speakers treated as already-present, not arrivals)');
          }
          if ((acks.length || embeds.length) && cfg.ackCommands) {
            log('[chloe.T3] ran ' + commandCount + ' command(s)' + (embeds.length ? (' (' + embeds.length + ' embed)') : ''));
            var outs = [];
            if (acks.length && typeof cfg.send === 'function') outs.push(Promise.resolve(cfg.send(cfg.channelId, acks.join('\n'))));
            embeds.forEach(function (em) { outs.push(Promise.resolve(cfg.sendEmbed(cfg.channelId, em))); });
            return Promise.all(outs.map(function (p) { return p.then(function () {}, function () {}); })).then(function () { return { commands: commandCount }; });
          }
          return { commands: commandCount };
        });
      });
    }

    // T5 greeting dispatch: fires after the settling debounce, re-checks suppression + cooldown at
    // fire time, asks the brain for a line, sends it, and records lastGreetedAt (one per crossing).
    function processGreet() {
      if (!greetEnabled() || !greet.pending || greet.greeting) return Promise.resolve(null);
      var g = greet.pending; var now = clock.now();
      if (now - g.at < cfg.greetDebounceMs) return Promise.resolve(null);   // still settling
      if (now - lastActAt < cfg.globalCooldownMs) return Promise.resolve(null);    // light global gap
      greet.pending = null; greet.greeting = true;
      return Promise.resolve(store.get(partKey(g.authorId))).then(function (p) {
        if (!p || isSuppressed(p, now) || (p.lastGreetedAt && (now - p.lastGreetedAt) < cfg.greetCooldownMs)) { greet.greeting = false; return null; }
        return assembleContext(p).then(function (context) {
          var gctx = { kind: g.tier, person: { id: p.id, name: p.name }, interactionCount: p.interactionCount || 0, gapMs: g.gapMs, recent: context };
          indicateTyping();
          return Promise.resolve(cfg.greetFn(gctx)).then(function (res) {
            if (!res || !res.ok || !res.value) { greet.greeting = false; return null; }
            return Promise.resolve(cfg.send(cfg.channelId, String(res.value))).then(function () {
              p.lastGreetedAt = now; lastActAt = now;
              return store.set(partKey(p.id), p).then(function () {
                greet.greeting = false;
                log('[chloe.T5] greeted ' + p.name + ' (' + g.tier + ')');
                return { authorId: p.id, tier: g.tier };
              });
            });
          });
        });
      }).catch(function (e) { greet.greeting = false; log('[chloe.T5] greet error: ' + e.message); return null; });
    }

    // #12: scheduled proactive beats. Interval-based (last_run + intervalMs), heavily activity-gated:
    // never to a dead room, never during lockdown, never while replying/painting, at most one per poll,
    // with a global min gap. A beat is seeded (not fired) the first time it's seen so nothing fires at boot.
    function beatsEnabled() { return Array.isArray(cfg.beats) && cfg.beats.length > 0; }
    function pickBeatText(b) {
      if (b.texts && b.texts.length) return String(b.texts[Math.floor(Math.random() * b.texts.length)]);
      if (b.text) return String(b.text);
      return null;
    }
    function processBeats() {
      if (!beatsEnabled() || engageMode === 'locked' || reply.replying || paint.painting) return Promise.resolve(null);
      var now = clock.now();
      return Promise.resolve(store.get(BEATS_KEY)).then(function (state) {
        state = state || {};
        if (state.__lastAny && (now - state.__lastAny) < (cfg.beatMinGapMs || 0)) return null;   // global gap
        return Promise.resolve(store.get(RHYTHM_KEY)).then(function (rh) {
          var lastActivity = rh && rh.lastActivity;
          var fired = null;
          for (var i = 0; i < cfg.beats.length; i++) {
            var b = cfg.beats[i]; if (!b || !b.id || !b.intervalMs) continue;
            if (state[b.id] == null) { state[b.id] = now; continue; }            // seed, don't fire on first sight
            if (now - state[b.id] < b.intervalMs) continue;                       // interval not elapsed
            var win = (b.activeWithinMs != null) ? b.activeWithinMs : (cfg.beatActiveWithinMs || 0);
            if (win > 0 && (lastActivity == null || (now - lastActivity) > win)) continue;   // dead room: skip
            fired = b; break;                                                     // one beat per poll
          }
          if (!fired) return store.set(BEATS_KEY, state).then(function () { return null; });
          state[fired.id] = now; state.__lastAny = now;
          return store.set(BEATS_KEY, state).then(function () {
            function deliver(text) {
              if (!text || typeof cfg.send !== 'function') return null;
              indicateTyping();
              return Promise.resolve(cfg.send(cfg.channelId, text)).then(function () {
                lastActAt = clock.now();
                log('[chloe.beat] fired "' + fired.id + '"');
                return { beat: fired.id };
              }, function () { return null; });
            }
            if (fired.prompt && typeof cfg.beatFn === 'function') {
              return Promise.resolve(cfg.beatFn({ id: fired.id, prompt: fired.prompt })).then(function (res) {
                return deliver((res && res.ok && res.value) ? String(res.value) : pickBeatText(fired));
              }, function () { return deliver(pickBeatText(fired)); });
            }
            return deliver(pickBeatText(fired));
          });
        });
      });
    }

    function partKey(id) { return 'u:' + id; }

    function toEpoch(ts) {
      if (!ts) return clock.now();
      var t = Date.parse(ts);
      return isNaN(t) ? clock.now() : t;
    }

    // ---- partition upsert (the per-user system of record) --------------------------------
    function ingestOne(msg, ring, indexSet, touched) {
      return Promise.resolve(store.get(partKey(msg.author.id))).then(function (existing) {
        var now = clock.now();
        var seenAt = toEpoch(msg.timestamp);
        var p = existing || {
          id: msg.author.id,
          name: msg.author.username,
          firstSeen: seenAt,
          lastSeen: seenAt,
          interactionCount: 0,        // T0 never engages, so this stays 0 until T1
          state: 'active',            // spec 5.4 ladder; T0 only ever sets 'active'
          recent: []
        };
        var isNew = !existing;
        var prevLastSeen = existing ? (existing.lastSeen || 0) : null;   // capture BEFORE we overwrite it
        if (existing) applyExpiry(p, now);   // T3: a timeout that has elapsed reverts to active
        // T5 decay: a return after a long quiet spell lets familiarity fade (warmth follows recency)
        if (existing && prevLastSeen && (now - prevLastSeen) >= cfg.decayAfterMs && (p.interactionCount || 0) > 0) {
          p.interactionCount = Math.max(0, Math.floor((p.interactionCount || 0) * cfg.decayFactor));
        }
        p.lifecycle = 'active';              // any message reactivates; quiet/departed are set by maintenance
        p.name = msg.author.username || p.name;
        p.lastSeen = Math.max(p.lastSeen || 0, seenAt);
        if (!p.firstSeen) p.firstSeen = seenAt;
        // rolling window of THIS user's lines (observed facts only; no inferences hardened in)
        p.recent.push({ id: msg.id, ts: seenAt, content: msg.content || '' });
        if (p.recent.length > cfg.recentWindow) p.recent = p.recent.slice(-cfg.recentWindow);

        // speaker ring: dedup-consecutive distinct author ids, keep last N
        if (ring[ring.length - 1] !== msg.author.id) {
          ring.push(msg.author.id);
          if (ring.length > cfg.speakerRingSize) ring.shift();
        }
        indexSet[msg.author.id] = true;
        touched.users[msg.author.id] = true;
        if (isNew) touched.newUsers[msg.author.id] = true;
        // T5 greeting signal (the tier is decided later, where suppression + commands are known)
        if (touched.greetInfo) touched.greetInfo[msg.author.id] = { brandNew: isNew, prevLastSeen: prevLastSeen, gapMs: prevLastSeen ? (now - prevLastSeen) : null, messageId: msg.id, name: p.name };

        return store.set(partKey(msg.author.id), p);
      });
    }

    // ---- one poll cycle ------------------------------------------------------------------
    // pollOnce wraps the core so the onPoll hook (page events + T5 maintenance) runs on EVERY
    // poll — the running loop calls pollOnce directly, so the hook must live here, not in a caller.
    function pollOnce() {
      return pollOnceCore().then(function (summary) {
        if (typeof cfg.onPoll === 'function') return Promise.resolve(cfg.onPoll(summary)).then(function () { return summary; }, function () { return summary; });
        return summary;
      });
    }
    function pollOnceCore() {
      var ctx = {};
      return Promise.resolve(store.get(CURSOR_KEY)).then(function (cursor) {
        ctx.cursor = cursor || null;
        return transport.getMessagesAfter(cfg.channelId, ctx.cursor, 50);
      }).then(function (msgs) {
        msgs = (msgs || []).slice().sort(function (a, b) { return snowflakeCmp(a.id, b.id); });
        ctx.fetched = msgs.length;
        // drop the bot's own messages by id (spec 2.1)
        var incoming = msgs.filter(function (m) {
          return !(cfg.botUserId && m.author && m.author.id === cfg.botUserId);
        });
        // diagnostic: if messages arrive but all have empty content, the Message Content Intent is off
        if (!warnedEmpty && incoming.length) {
          var withText = 0; incoming.forEach(function (m) { if (String(m.content || '').trim()) withText++; });
          if (withText === 0) { warnedEmpty = true; log('[chloe] NOTE: ingested ' + incoming.length + ' message(s) with EMPTY content. If those messages had text, enable the Message Content Intent (Discord Dev Portal \u2192 Bot \u2192 Privileged Gateway Intents). Without it she can\u2019t read non-mention messages.'); }
        }
        // (candidate selection happens after ingest, so it can be gated by mod state — see below)
        return Promise.all([
          Promise.resolve(store.get(RING_KEY)),
          Promise.resolve(store.listIndex())
        ]).then(function (st) {
          var ring = st[0] || [];
          var indexArr = st[1] || [];
          var indexSet = {};
          indexArr.forEach(function (id) { indexSet[id] = true; });
          var touched = { users: {}, newUsers: {}, greetInfo: {} };

          // ingest sequentially to keep last-write-wins deterministic per user
          var chain = Promise.resolve();
          incoming.forEach(function (m) {
            chain = chain.then(function () { return ingestOne(m, ring, indexSet, touched); });
          });

          return chain.then(function () {
            // advance cursor to the newest id we saw (even bot's own, so we don't re-fetch it)
            var newCursor = ctx.cursor;
            msgs.forEach(function (m) { newCursor = maxSnowflake(newCursor, m.id); });

            // channel rhythm: track last activity + a coarse gap average
            return Promise.resolve(store.get(RHYTHM_KEY)).then(function (rh) {
              rh = rh || { lastActivity: null, avgGapMs: null, samples: 0 };
              if (incoming.length) {
                var now = clock.now();
                if (rh.lastActivity != null) {
                  var gap = now - rh.lastActivity;
                  rh.avgGapMs = rh.avgGapMs == null ? gap : Math.round(rh.avgGapMs * 0.7 + gap * 0.3);
                  rh.samples++;
                }
                rh.lastActivity = now;
              }

              var writes = [
                store.set(RING_KEY, ring),
                store.set(RHYTHM_KEY, rh),
                store.setIndex(Object.keys(indexSet))
              ];
              if (newCursor && newCursor !== ctx.cursor) writes.push(store.set(CURSOR_KEY, newCursor));

              return Promise.all(writes).then(function () {
                var summary = {
                  fetched: ctx.fetched,
                  ingested: incoming.length,
                  newUsers: Object.keys(touched.newUsers),
                  cursor: newCursor,
                  ring: ring.slice(),
                  rhythm: rh
                };
                log('[chloe.T0] poll', summary.fetched + ' fetched, ' + summary.ingested +
                  ' ingested, ' + summary.newUsers.length + ' new, cursor=' + summary.cursor);
                return processCommandsAndSelect(incoming, touched).then(function (t3) {
                  if (t3 && t3.commands) summary.commands = t3.commands;
                  var imageJob = kickImage();   // fire-and-forget: image broker threads with text; never blocks the loop
                  if (imageJob) summary.imageJob = imageJob;
                  summary.engageMode = engageMode;
                  // The text lane (reply -> volunteer -> greet -> beat) is one promise. By default it's
                  // awaited so the poll resolves only once it's done (every harness relies on this). With
                  // backgroundText on, it's fire-and-forget (exposed as summary.textJob) so a long
                  // generation never stalls the poll loop — the per-lane locks still prevent overlap.
                  var textLane = processReply().then(function (replied) {
                    if (replied) summary.replied = replied;
                    return processGate();
                  }).then(function (acted) {
                    if (acted) summary.volunteered = acted;
                    return processGreet();
                  }).then(function (greeted) {
                    if (greeted) summary.greeted = greeted;
                    return processBeats();
                  }).then(function (beat) {
                    if (beat) summary.beat = beat;
                  });
                  function finishPoll() {
                    pollCount++;
                    if (cfg.maintenanceEveryPolls > 0 && (pollCount % cfg.maintenanceEveryPolls) === 0) {
                      return quietSweep().then(function (n) { if (n) { summary.quieted = n; log('[chloe.T5] quiet-sweep demoted ' + n + ' user(s)'); } return summary; });
                    }
                    return summary;
                  }
                  if (cfg.backgroundText) { summary.textJob = textLane; return finishPoll(); }
                  return textLane.then(finishPoll);
                });
              });
            });
          });
        });
      });
    }

    // ---- T1 reply path -------------------------------------------------------------------
    // Called at the end of every poll. Serves the per-author reply queue: a light global gap
    // keeps her from flooding, while a per-author cooldown keeps one person from monopolizing
    // her — so a different user is answered promptly even if she just replied to someone else.
    function processReply() {
      if (!replyEnabled() || reply.replying || !hasPendingReply()) return Promise.resolve(null);
      var now = clock.now();
      if (now - lastActAt < cfg.globalCooldownMs) return Promise.resolve(null);   // light global gap
      // choose the oldest-queued author who has settled (debounce) and is past their per-author cooldown
      var p = null;
      Object.keys(reply.queue).forEach(function (id) {
        var e = reply.queue[id];
        if (now - e.at < cfg.debounceMs) return;                        // still bursting
        if (now - (lastReplyAt[id] || 0) < cfg.cooldownMs) return;      // per-author cooldown
        if (!p || e.at < p.at) p = e;
      });
      if (!p) return Promise.resolve(null);
      delete reply.queue[p.authorId];
      reply.replying = true;
      indicateTyping();
      return assembleContext(p)
        .then(function (ctx) { return cfg.respond(ctx); })
        .then(function (r) {
          var text = (r && r.ok) ? String(r.value || '').trim() : '';
          if (!text) {
            reply.replying = false;
            log('[chloe.T1] no reply to ' + p.authorName + ': ' + ((r && r.reason) ? r.reason : 'empty generation'));
            return null;
          }
          return Promise.resolve(cfg.send(cfg.channelId, text)).then(function () {
            var t = clock.now();
            lastActAt = t; lastReplyAt[p.authorId] = t;
            reply.replying = false;
            log('[chloe.T1] replied to ' + p.authorName);
            return bumpInteraction(p.authorId).then(function () { return text; });
          });
        })
        .catch(function (e) { reply.replying = false; log('[chloe.T1] reply error:', (e && e.message) || e); return null; });
    }

    // ---- image path ----------------------------------------------------------------------
    // The page owns generation (only it can run text-to-image), so we hand it the prompt and
    // get back a data URL; the userscript posts it as a native attachment. Gated by its own
    // heavy cooldown (~14s gen) plus the shared global gap. On failure she says so in text
    // rather than leaving the request hanging.
    // ---- image lane (threaded) -----------------------------------------------------------
    // Image generation runs on a SEPARATE Perchance broker from text, so it threads with replies:
    // kickImage() is fire-and-forget — it never blocks the poll loop or a text reply. One image is
    // in flight at a time (paint.painting); the rest wait in the global FIFO (paint.queue) and drain
    // at generation pace. Timing is governed only by the image clock (lastPaintAt) — never the text
    // clock — so a long reply and an image proceed independently. Returns the in-flight job (so the
    // poll can surface it and harnesses can await it); callers do NOT await it in the poll chain.
    function kickImage() {
      if (!imageEnabled() || paint.painting || !paint.queue.length) return null;
      var now = clock.now();
      if (now - paint.queue[0].at < cfg.debounceMs) return null;          // head still settling
      if (now - lastPaintAt < cfg.imageCooldownMs) return null;           // courtesy gap (image clock only)
      var p = paint.queue.shift(); paint.painting = true;
      indicateTyping();
      log('[chloe.img] painting for ' + p.authorName + ' (' + paint.queue.length + ' more queued): "' + p.prompt.slice(0, 60) + '" (' + p.resolution + (p.dm ? ', dm' : '') + ')');
      var job = Promise.resolve(cfg.paint({ prompt: p.prompt, resolution: p.resolution }))
        .then(function (r) {
          var dataUrl = (r && r.ok) ? String(r.value || '') : '';
          if (dataUrl.indexOf('data:') !== 0) {
            paint.painting = false; lastPaintAt = clock.now();
            log('[chloe.img] no image for ' + p.authorName + ': ' + ((r && r.reason) ? r.reason : 'empty result'));
            return Promise.resolve(cfg.send(cfg.channelId, 'sorry ' + p.authorName + ", I couldn't make that image just now.")).then(function () { return null; }, function () { return null; });
          }
          var target = Promise.resolve(cfg.channelId);
          if (p.dm && typeof cfg.openDM === 'function') {
            target = Promise.resolve(cfg.openDM(p.authorId)).then(function (id) { return id || cfg.channelId; }, function () { return cfg.channelId; });
          }
          return target.then(function (chId) {
            var caption = p.dm ? ('here you go, ' + p.authorName + ' \u2014 ' + p.prompt.slice(0, 140)) : ('here you go, ' + p.authorName + '!');
            return Promise.resolve(cfg.sendImage(chId, dataUrl, caption)).then(function () {
              lastPaintAt = clock.now(); paint.painting = false;          // image clock only — do NOT touch lastActAt
              log('[chloe.img] delivered to ' + p.authorName + (p.dm ? ' (dm)' : ''));
              return bumpInteraction(p.authorId).then(function () { return { image: true, to: p.authorId }; });
            }, function (e) { paint.painting = false; log('[chloe.img] send failed: ' + ((e && e.message) || e)); return null; });
          });
        })
        .catch(function (e) { paint.painting = false; log('[chloe.img] paint error: ' + ((e && e.message) || e)); return null; });
      paint.lastJob = job;
      return job;
    }

    // T2: the volunteer gate. Cheap deterministic pre-filter first, then the AI judge only
    // for the survivors. Judge output is JSON-in-text, so anything unparseable / unknown
    // decays to 'ignore' (spec F4: the safe action). Addressed replies always take priority.
    // (Independent of the image lane — volunteering text can run while an image generates.)
    function processGate() {
      if (engageMode !== 'normal') return Promise.resolve(null);   // locked: silent; open: everyone gets a direct reply already
      if (!gateEnabled() || reply.replying || hasPendingReply() || !gate.pending) return Promise.resolve(null);
      var now = clock.now();
      var g = gate.pending;
      if (now - g.at < cfg.debounceMs) return Promise.resolve(null);                  // still bursting
      if (now - lastActAt < cfg.volunteerCooldownMs) { gate.pending = null; return Promise.resolve(null); }
      return getSpeakerRing().then(function (ring) {
        if (isTwoPersonExchange(ring)) { gate.pending = null; log('[chloe.T2] two-person exchange — staying out'); return null; }
        gate.pending = null;
        reply.replying = true;     // reuse the single action lock
        var heldCtx = null;
        return assembleContext(g)
          .then(function (ctx) { heldCtx = ctx; return cfg.judge(ctx); })
          .then(function (j) {
            var v = (j && j.ok && j.value) ? j.value : null;
            var action = (v && (v.action === 'reply' || v.action === 'react')) ? v.action : 'ignore';
            var conf = (v && typeof v.confidence === 'number') ? v.confidence : 0;
            var emoji = (v && v.emoji) ? String(v.emoji) : '\uD83D\uDC4D';
            if (action === 'ignore') { reply.replying = false; log('[chloe.T2] judge: ignore'); return null; }
            if (conf < cfg.judgeMinConfidence) { reply.replying = false; log('[chloe.T2] judge: ' + action + ' @ ' + conf + ' < ' + cfg.judgeMinConfidence + ' -> ignore'); return null; }
            if (action === 'react') {
              if (typeof cfg.react !== 'function') { reply.replying = false; return null; }
              return Promise.resolve(cfg.react(cfg.channelId, g.messageId, emoji)).then(function () {
                lastActAt = clock.now(); reply.replying = false; log('[chloe.T2] reacted ' + emoji); return { react: emoji };
              }).catch(function (e) { reply.replying = false; log('[chloe.T2] react error: ' + ((e && e.message) || e)); return null; });
            }
            // action === 'reply'
            indicateTyping();
            return Promise.resolve(cfg.respond(heldCtx)).then(function (r) {
              var text = (r && r.ok) ? String(r.value || '').trim() : '';
              if (!text) { reply.replying = false; log('[chloe.T2] volunteer reply empty'); return null; }
              return Promise.resolve(cfg.send(cfg.channelId, text)).then(function () {
                lastActAt = clock.now(); reply.replying = false; log('[chloe.T2] volunteered a reply'); return bumpInteraction(g.authorId).then(function () { return text; });
              });
            });
          })
          .catch(function (e) { reply.replying = false; log('[chloe.T2] gate error: ' + ((e && e.message) || e)); return null; });
      });
    }

    // Tier C: a shared view rebuilt every time, then discarded. Merges recent lines across
    // partitions (the channel flow) + who is addressing. Never persisted as a blob.
    function assembleContext(p) {
      return getRoster().then(function (roster) {
        var now = clock.now();
        roster = roster.filter(function (u) { return !isSuppressed(u, now); });  // T3: suppressed users are invisible to her
        var lines = [];
        roster.forEach(function (u) {
          (u.recent || []).forEach(function (ln) { lines.push({ who: u.name, id: u.id, text: scrubDiscordTokens(ln.content), ts: ln.ts }); });
        });
        lines.sort(function (a, b) { return a.ts - b.ts; });
        if (lines.length > cfg.contextLines) lines = lines.slice(-cfg.contextLines);
        var addressed = roster.filter(function (u) { return u.id === p.authorId; })[0];
        return {
          you: { name: cfg.botName || 'Chloe' },
          addressedBy: { id: p.authorId, name: p.authorName },
          addressedMessage: scrubDiscordTokens(p.content),
          channelRecent: lines,
          userSummary: (addressed && addressed.summary) ? addressed.summary : null,
          familiarity: addressed ? (addressed.interactionCount || 0) : 0
        };
      });
    }

    function bumpInteraction(id) {
      return Promise.resolve(store.get(partKey(id))).then(function (pp) {
        if (!pp) return;
        pp.interactionCount = (pp.interactionCount || 0) + 1;
        pp.lastChloeReplyTo = clock.now();
        return store.set(partKey(id), pp);
      });
    }

    // ---- roster read ---------------------------------------------------------------------
    function getRoster() {
      return Promise.resolve(store.listIndex()).then(function (ids) {
        return Promise.all((ids || []).map(function (id) { return Promise.resolve(store.get(partKey(id))); }));
      }).then(function (parts) {
        return parts.filter(Boolean).sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
      });
    }

    function getSpeakerRing() { return Promise.resolve(store.get(RING_KEY)).then(function (r) { return r || []; }); }

    // ---- loop control --------------------------------------------------------------------
    // adaptive cadence: snap to the floor while there's activity or pending work; otherwise grow
    // the interval (x1.5) toward the ceiling so a quiet channel isn't polled every few seconds.
    function computeNextDelay(prev, summary) {
      if (!cfg.adaptivePolling) return cfg.pollIntervalMs;
      var busy = (summary && summary.ingested > 0) || hasPendingReply() || paint.queue.length || paint.painting || gate.pending || greet.pending;
      if (busy) return cfg.pollFloorMs;
      var grown = Math.round((prev || cfg.pollIntervalMs) * 1.5);
      return Math.max(cfg.pollFloorMs, Math.min(grown, cfg.pollCeilMs));
    }
    function start() {
      if (running) return;
      if (!cfg.channelId) throw new Error('[chloe.T0] no channelId configured');
      running = true;
      startedAt = clock.now();
      greetSettleLogged = false;
      log('[chloe.T0] started; ' + (cfg.adaptivePolling ? ('adaptive polling ' + cfg.pollFloorMs + '\u2013' + cfg.pollCeilMs + 'ms') : ('polling every ' + cfg.pollIntervalMs + 'ms')));
      if (!cfg.botUserId && !cfg.botName) {
        log('[chloe] WARNING: no bot identity yet — click Validate. Until then she can\u2019t tell she\u2019s being @-mentioned or named, so EVERY message routes to the volunteer gate (and is likely ignored).');
      } else {
        log('[chloe] identity: ' + (cfg.botName || '?') + ' (' + (cfg.botUserId || 'no id') + '); answers to: ' + nameAliases().join(', ') + ' or @-mention; replies-when=' + cfg.addressMode);
      }
      var curDelay = cfg.pollIntervalMs;
      var tick = function () {
        if (!running) return;
        Promise.resolve(pollOnce()).then(function (summary) {
          curDelay = computeNextDelay(curDelay, summary);
          if (running) timer = setTimeout(tick, curDelay);
        }, function (e) {
          log('[chloe.T0] poll error:', e && e.message || e);
          if (running) timer = setTimeout(tick, cfg.pollIntervalMs);
        });
      };
      tick();
    }
    function stop() { running = false; if (timer) clearTimeout(timer); timer = null; log('[chloe.T0] stopped'); }
    function isRunning() { return running; }

    return {
      pollOnce: pollOnce,
      getRoster: getRoster,
      getSpeakerRing: getSpeakerRing,
      applyModAction: applyModAction,
      applyStrike: applyStrike,
      purge: purge,
      getModLog: getModLog,
      appendModLog: appendModLog,
      quietSweep: quietSweep,
      dueForMemberCheck: dueForMemberCheck,
      noteMemberPresent: noteMemberPresent,
      markDeparted: markDeparted,
      backfillStep: backfillStep,
      computeNextDelay: computeNextDelay,
      start: start,
      stop: stop,
      isRunning: isRunning,
      config: cfg
    };
  }

  return { createEngine: createEngine, _snowflakeCmp: snowflakeCmp };
});
