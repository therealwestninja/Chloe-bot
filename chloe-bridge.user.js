// ==UserScript==
// @name         Chloe bridge (Discord <- Perchance)
// @namespace    therealwestninja
// @version      0.28.0
// @description  Adapter-A bridge: polls a Discord channel via GM_xmlhttpRequest and builds a durable per-user roster in GM storage. T0 = read-only presence (no replies, no moderation yet).
// @author       therealwestninja
// @match        https://*.perchance.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @connect      discord.com
// @run-at       document-idle
// ==/UserScript==

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
      addressMode: 'both',    // 'mention' | 'name' | 'both' | 'always' (DM)
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
      // D4 persona anchoring: a mod reacting with anchorEmoji to a message makes that message the
      // channel's style note (newest mod-anchored message wins; sanitized + capped before use).
      anchorEmoji: '\ud83d\udccc',
      personaNoteMaxLen: 200,
      // D5: declarative job grammar. ONLY these verbs are accepted from chat-submitted JSON;
      // there is NO code path — a job is a validated plain object, never evaluated. Each verb
      // lists its allowed arg keys and which are required; anything else is rejected.
      jobVerbs: {
        summarize: { args: { lines: 'int' }, required: [] },
        recap:     { args: {}, required: [] },
        roster:    { args: {}, required: [] },
        remindme:  { args: { minutes: 'int', text: 'str' }, required: ['minutes', 'text'] }
      },
      jobMaxReminderMin: 1440,   // 24h cap on remindme
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
    var personaName = null;              // D4+: if a pinned note names a character, she answers to THAT name
    // Pull an optional character name out of an anchored note. Supports a leading "Name:" label,
    // or "you are X" / "you're X" / "be X" / "act as X" / "play X" / "roleplay as X". Returns a
    // trimmed name (<=40 chars, letters/spaces/-/' only) or null. The note text is used as-is for
    // style; the name only adds an alias + reframes the prompt so she doesn't narrate "Chloe as X".
    function parsePersonaName(text) {
      var t = String(text || '').trim();
      var m = t.match(/^\s*(?:name|character|persona)\s*[:=]\s*([A-Za-z][A-Za-z .'\-]{1,39}?)\s*(?:[.,;!?\n]|$)/i)
           || t.match(/\b(?:you(?:'re| are)|be|act as|play|roleplay as|become)\s+([A-Z][A-Za-z'\-]*(?:\s+[A-Z][A-Za-z'\-]*)?)/);
      if (!m) return null;
      var n = m[1].replace(/[.\s'\-]+$/, '').trim();
      // drop a trailing lowercase filler word the second pattern may catch ("Marcus the" -> "Marcus")
      n = n.replace(/\s+(the|a|an|now|please|today|here)$/i, '').trim();
      return (n && n.length >= 2) ? n : null;
    }
    function refreshPersonaName() {
      return Promise.resolve(store.get('persona:note')).then(function (pn) {
        personaName = (pn && pn.text) ? parsePersonaName(pn.persona || pn.text) : null;
        return personaName;
      }, function () { personaName = null; });
    }
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
      if (personaName) { out.push(personaName); var ps = String(personaName).split(/[-_ ]/)[0]; if (ps && ps.length >= 2 && ps !== personaName) out.push(ps); }
      return out;
    }
    function isAddressed(content) {
      if (cfg.addressMode === 'always') return true;   // DM channel: every message is to her
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
    function sanitizePromptForCaption(prompt, maxLen) {
      var t = scrubDiscordTokens(prompt);
      t = t.replace(/@(everyone|here)/gi, '$1');
      t = t.replace(/https?:\/\/\S+/gi, '');
      t = t.replace(/[*_`~|>#\\]/g, '');
      t = t.replace(/\s+/g, ' ').trim();
      var cap = maxLen || 220;
      if (t.length > cap) t = t.slice(0, cap - 1).replace(/\s\S*$/, '') + '\u2026';
      return t;
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

    // ---- D4: per-channel persona note (mod-anchored style guidance) ----------------------
    var PERSONA_KEY = 'persona:note';
    function sanitizePersonaNote(text) {
      var t = scrubDiscordTokens(String(text || ''));
      t = t.replace(/<a?:\w+:\d+>/g, '').replace(/<[@#][!&]?\d+>/g, '').replace(/\s+/g, ' ').trim();
      var max = cfg.personaNoteMaxLen || 200;
      if (t.length > max) t = t.slice(0, max);
      return t;
    }
    // Sweep recent messages (REST gives reaction COUNTS inline; WHO reacted needs a second fetch)
    // for the newest message a moderator has anchored. getRecent() -> newest-first messages;
    // getReactors(msgId, emoji) -> users who reacted.
    function anchorSweep(getRecent, getReactors) {
      var emoji = cfg.anchorEmoji || '\ud83d\udccc';
      return Promise.resolve(getRecent()).then(function (msgs) {
        var candidates = (msgs || []).filter(function (m) {
          return m && m.author && !m.author.bot && (m.reactions || []).some(function (r) {
            return r && r.emoji && r.emoji.name === emoji && r.count > 0;
          });
        });
        var chain = Promise.resolve(null);
        candidates.forEach(function (m) {        // newest-first: the first mod-anchored hit wins
          chain = chain.then(function (found) {
            if (found) return found;
            return Promise.resolve(getReactors(m.id, emoji)).then(function (users) {
              return (users || []).some(function (u) { return u && isMod(u.id); }) ? m : null;
            }, function () { return null; });
          });
        });
        return chain;
      }).then(function (m) {
        if (!m) return { changed: false };
        return Promise.resolve(store.get(PERSONA_KEY)).then(function (cur) {
          if (cur && cur.msgId === m.id) return { changed: false, note: cur.text };
          var note = sanitizePersonaNote(m.content);
          if (!note) return { changed: false };
          var rec = { msgId: m.id, text: note, by: (m.author && m.author.username) || '', at: clock.now() };
          rec.persona = parsePersonaName(note) || null;
          return Promise.resolve(store.set(PERSONA_KEY, rec)).then(function () {
            personaName = rec.persona;
            log('[chloe.persona] anchored style note from ' + rec.by + ': "' + note.slice(0, 60) + '"' + (rec.persona ? ' (character: ' + rec.persona + ')' : ''));
            return { changed: true, note: note, persona: rec.persona };
          });
        });
      });
    }
    function getPersonaNote() { return Promise.resolve(store.get(PERSONA_KEY)).then(function (v) { return v || null; }); }
    function clearPersonaNote() { personaName = null; return Promise.resolve(store.del(PERSONA_KEY)); }

    // ---- D5: declarative job grammar (validate-only; NO eval, ever) ----------------------
    // parseJob(text) -> { ok, job } | { ok:false, reason }. Accepts a JSON object (or a fenced
    // ```json block). Rejects unknown verbs, unknown/missing/mistyped args, and anything that
    // isn't a plain object. This is the ONLY bridge between chat input and the job system.
    function coerceArg(type, v) {
      if (type === 'int') { var n = parseInt(v, 10); return isFinite(n) ? n : null; }
      if (type === 'str') { var t = String(v == null ? '' : v).trim(); return t ? t : null; }
      return null;
    }
    function parseJob(text) {
      var raw = String(text || '').trim();
      var m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) raw = m[1].trim();
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'not valid JSON' }; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'a job must be a JSON object' };
      // Reject dangerous keys outright (defense in depth — we never assign from src into a real
      // object, but a job that names these is malformed by definition).
      if (/"(__proto__|constructor|prototype)"\s*:/.test(raw)) return { ok: false, reason: 'illegal key in job object' };
      var verb = String(obj.task || obj.verb || '').toLowerCase();
      var spec = (cfg.jobVerbs || {})[verb];
      if (!spec) return { ok: false, reason: 'unknown task "' + verb + '" (allowed: ' + Object.keys(cfg.jobVerbs || {}).join(', ') + ')' };
      var args = {}, src = (obj.args && typeof obj.args === 'object') ? obj.args : obj;
      var keys = Object.keys(src).filter(function (k) { return k !== 'task' && k !== 'verb' && k !== 'args'; });
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!(k in spec.args)) return { ok: false, reason: 'task "' + verb + '" does not accept "' + k + '"' };
        var cv = coerceArg(spec.args[k], src[k]);
        if (cv == null) return { ok: false, reason: '"' + k + '" must be a ' + (spec.args[k] === 'int' ? 'number' : 'string') };
        args[k] = cv;
      }
      for (var j = 0; j < spec.required.length; j++) {
        if (!(spec.required[j] in args)) return { ok: false, reason: 'task "' + verb + '" requires "' + spec.required[j] + '"' };
      }
      if (verb === 'remindme' && args.minutes != null) {
        if (args.minutes < 1) return { ok: false, reason: 'minutes must be at least 1' };
        if (args.minutes > (cfg.jobMaxReminderMin || 1440)) return { ok: false, reason: 'minutes is capped at ' + (cfg.jobMaxReminderMin || 1440) };
      }
      return { ok: true, job: { task: verb, args: args } };
    }
    function describeJobs() {
      return Object.keys(cfg.jobVerbs || {}).map(function (v) {
        var a = cfg.jobVerbs[v].args, keys = Object.keys(a);
        return v + (keys.length ? (' {' + keys.map(function (k) { return k + ':' + a[k]; }).join(', ') + '}') : '');
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
      { verb: 'block',     modOnly: true, needsTarget: true, help: 'block @u [reason]', handler: function (modId, c) {
          if (!c.targetId) return Promise.resolve({ ack: 'block needs an @mention of the user' });
          return blockUser({ id: c.targetId, name: c.targetName, byModId: modId, reason: c.reason })
            .then(function (r) { return { ack: r.ok ? ('blocked ' + (c.targetName || c.targetId) + " \u2014 they're forgotten and will never be scanned again") : ('failed: ' + r.reason) }; });
        } },
      { verb: 'unblock',   modOnly: true, needsTarget: true, help: 'unblock @u', handler: function (modId, c) {
          if (!c.targetId) return Promise.resolve({ ack: 'unblock needs an @mention of the user' });
          return unblockUser({ id: c.targetId, name: c.targetName })
            .then(function (r) { return { ack: r.ok ? ('unblocked ' + (c.targetName || c.targetId) + ' \u2014 she can form memory of them again') : ((c.targetName || c.targetId) + ' was not on the blocklist') }; });
        } },
      { verb: 'warns',     modOnly: true, needsTarget: true, help: 'warns @u', handler: function (modId, c) {
          if (!c.targetId) return Promise.resolve({ ack: 'warns needs an @mention of the user' });
          return Promise.resolve(store.get(partKey(c.targetId))).then(function (p) {
            if (!p) return { ack: 'I have no record of that user' };
            var n = p.strikes || 0;
            return { ack: (p.name || c.targetId) + ': ' + n + ' strike' + (n === 1 ? '' : 's') + (p.state && p.state !== 'active' ? ' \u2014 currently ' + p.state : '') };
          });
        } },
      { verb: 'persona',   modOnly: true, help: 'persona [clear]', handler: function (modId, c) {
          if (/^clear\b/i.test(c.reason || '')) return clearPersonaNote().then(function () { return { ack: 'persona note cleared' }; });
          return getPersonaNote().then(function (pn) {
            return { ack: (pn && pn.text) ? ('current persona note (anchored by ' + (pn.by || 'a mod') + '): ' + pn.text) : ('no persona note anchored \u2014 a mod can react ' + (cfg.anchorEmoji || '\ud83d\udccc') + ' to a message to set one') };
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
      { verb: 'do',        modOnly: true, help: 'do {json task}', handler: function (modId, c) {
          var parsed = parseJob(c.reason || '');
          if (!parsed.ok) return Promise.resolve({ ack: 'job rejected: ' + parsed.reason + '. Allowed: ' + describeJobs().join('; ') });
          var task = parsed.job.task, a = parsed.job.args;
          if (task === 'roster') {
            return getRoster().then(function (r) {
              var names = r.slice(0, 20).map(function (u) { return u.name + (u.state && u.state !== 'active' ? ' (' + u.state + ')' : ''); });
              return { ack: r.length + ' here: ' + (names.join(', ') || '\\u2014') };
            });
          }
          if (task === 'recap' || task === 'summarize') {
            if (typeof cfg.recapFn !== 'function') return Promise.resolve({ ack: 'summaries are not available right now' });
            return assembleContext({ authorId: modId, authorName: '', content: '' }).then(function (ctx) {
              var lines = (ctx && ctx.channelRecent) ? ctx.channelRecent : [];
              if (task === 'summarize' && a.lines) lines = lines.slice(-a.lines);
              return Promise.resolve(cfg.recapFn({ recent: lines })).then(function (res) {
                return { ack: (res && res.ok) ? res.value : 'could not summarize right now' };
              });
            });
          }
          if (task === 'remindme') {
            return Promise.resolve({ ack: 'reminders are coming soon (validated: ' + a.minutes + 'm \\u2014 "' + a.text + '")' });
          }
          return Promise.resolve({ ack: 'task "' + task + '" is valid but not wired yet' });
        } },
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

    // ---- permanent blocklist (tombstones) ------------------------------------------------
    // "Forgotten" must mean forgotten FOREVER: a blocked author is never re-scanned, never
    // re-added to the roster, ever. The blocklist lives at its own top-level key, independent of
    // any partition, so purge()/forgetMe() cannot remove it — purging clears memory, blocking
    // prevents memory from ever forming again. Structured as { ids:{id:meta}, names:{lcname:meta} }
    // so future *fetchable* markers can slot in (account-age, guild-verification gates); note that
    // Discord does NOT expose IP, 2FA, or phone to bots, so those markers are intentionally absent.
    var BLOCK_KEY = 'blocklist';
    function getBlocklist() { return Promise.resolve(store.get(BLOCK_KEY)).then(function (b) { return b || { ids: {}, names: {} }; }); }
    function isBlockedSync(bl, id, name) {
      if (!bl) return false;
      if (id && bl.ids && bl.ids[String(id)]) return true;
      var ln = String(name || '').trim().toLowerCase();
      if (ln && bl.names && bl.names[ln]) return true;
      return false;
    }
    function blockUser(opts) {
      opts = opts || {};
      var id = opts.id ? String(opts.id) : null;
      var name = opts.name ? String(opts.name).trim() : null;
      if (!id && !name) return Promise.resolve({ ok: false, reason: 'need a user id or username to block' });
      return getBlocklist().then(function (bl) {
        var meta = { at: clock.now(), by: opts.byModId || null, reason: opts.reason || null };
        if (id) bl.ids[id] = meta;
        if (name) bl.names[name.toLowerCase()] = meta;
        return Promise.resolve(store.set(BLOCK_KEY, bl)).then(function () {
          // blocking also purges any memory that already formed
          if (id) return purge(id, { targetName: name || id }).then(function () { return { ok: true, value: { id: id, name: name } }; }, function () { return { ok: true, value: { id: id, name: name } }; });
          return { ok: true, value: { id: id, name: name } };
        });
      });
    }
    function unblockUser(opts) {
      opts = opts || {};
      var id = opts.id ? String(opts.id) : null;
      var name = opts.name ? String(opts.name).trim().toLowerCase() : null;
      return getBlocklist().then(function (bl) {
        var changed = false;
        if (id && bl.ids[id]) { delete bl.ids[id]; changed = true; }
        if (name && bl.names[name]) { delete bl.names[name]; changed = true; }
        return Promise.resolve(store.set(BLOCK_KEY, bl)).then(function () { return { ok: changed, value: { id: id, name: name } }; });
      });
    }
    function listBlocked() { return getBlocklist(); }

    // ---- partition upsert (the per-user system of record) --------------------------------
    function ingestOne(msg, ring, indexSet, touched) {
      // permanent tombstone gate: a blocked author is invisible to ingestion forever
      return Promise.resolve(store.get(BLOCK_KEY)).then(function (bl) {
        if (isBlockedSync(bl, msg.author.id, msg.author.username)) return null;
        return ingestOneCore(msg, ring, indexSet, touched);
      });
    }
    function ingestOneCore(msg, ring, indexSet, touched) {
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
            var promptCap = sanitizePromptForCaption(p.prompt, 220);
            var lead = p.dm ? ('here you go, ' + p.authorName + ' \u2014 ') : ('here you go, ' + p.authorName + '! ');
            var caption = lead + (promptCap ? ('\u201c' + promptCap + '\u201d') : '');
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
        var base = {
          you: { name: (personaName || cfg.botName || 'Chloe') },
          addressedBy: { id: p.authorId, name: p.authorName },
          addressedMessage: scrubDiscordTokens(p.content),
          channelRecent: lines,
          userSummary: (addressed && addressed.summary) ? addressed.summary : null,
          familiarity: addressed ? (addressed.interactionCount || 0) : 0
        };
        return Promise.resolve(store.get(PERSONA_KEY)).then(function (pn) {
          if (pn && pn.text) base.personaNote = pn.text;
          if (personaName) base.personaName = personaName;
          return base;
        });
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
      refreshPersonaName();
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
          var code = e && (e.status || (e.body && e.body.code));
          var unknownChannel = (e && e.status === 404) || (e && e.body && e.body.code === 10003);
          log('[chloe.T0] poll error:', (e && e.message) || e);
          if (unknownChannel && typeof cfg.onChannelGone === 'function') {
            try { cfg.onChannelGone(cfg.channelId); } catch (e2) {}
            running = false;   // stop this engine's loop; the bootstrap decides whether to drop the channel
            return;
          }
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
      blockUser: blockUser, unblockUser: unblockUser, listBlocked: listBlocked,
      anchorSweep: anchorSweep,
      parseJob: parseJob,
      sanitizePromptForCaption: sanitizePromptForCaption,
      describeJobs: describeJobs,
      getPersonaNote: getPersonaNote,
      clearPersonaNote: clearPersonaNote,
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
/* chloe-bridge — tab bridge (D1, pure logic).
 *
 * Queen/worker messaging over an injected same-origin bus (BroadcastChannel in production,
 * a GM value-change adapter as fallback, an in-memory hub in tests). Like engine.js this file
 * is deliberately free of GM_*, DOM, and network code: it takes a `bus` and a `clock`, so it
 * runs identically under Node and inside the userscript.
 *
 * Design decisions (from the distributed-tab spec review):
 *  - EVENT-DRIVEN heartbeat: the queen pings, workers pong in the message handler. Workers own
 *    NO timers — background tabs get their timers clamped to ~1/min by Chrome's intensive
 *    throttling, so a worker-initiated 10s heartbeat would falsely die the moment the tab is
 *    backgrounded. Message *delivery* is not throttled, so reply-on-ping survives backgrounding.
 *  - The host drives time: call tick() periodically (queen tab is the foreground tab, so its
 *    interval is reliable). tick() sends due pings, reaps silent workers, expires requests.
 *  - Token-authenticated envelopes: the bus token lives in GM storage (script-scoped — page
 *    code on perchance.org cannot read it), so only our userscript instances can speak on the
 *    channel. Envelopes with a missing/wrong token are dropped silently.
 *  - Workers are stateless; all durable state stays with the queen (single-writer GM rule).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node / harness
  root.ChloeTabBridge = api;                                                 // userscript / window
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTabBridge(opts) {
    opts = opts || {};
    var role = opts.role === 'worker' ? 'worker' : 'queen';
    var tabId = String(opts.tabId || ('tab-' + Math.random().toString(36).slice(2, 10)));
    var token = String(opts.token || '');
    var bus = opts.bus;                      // { post(env), onMessage(fn) }
    var clock = opts.clock || { now: function () { return Date.now(); } };
    var log = typeof opts.log === 'function' ? opts.log : function () {};
    var pingIntervalMs = opts.pingIntervalMs || 15000;
    var deadAfterMs = opts.deadAfterMs || 45000;
    var requestTimeoutMs = opts.requestTimeoutMs || 30000;

    var running = false;
    var workers = {};        // queen: id -> { status, lastSeen, jobs }
    var pending = {};        // request id -> { resolve, reject, deadline, to }
    var jobHandlers = {};    // worker: jobType -> fn(args) -> Promise
    var queenId = null;      // worker: learned from the queen's 'registered' ack / pings
    var lastPingAt = 0;
    var seq = 0;

    // D6 queen failover. Enabled only when a lease adapter is injected ({get, set} over a shared,
    // script-scoped value — GM storage in production, an in-memory cell in tests). A worker that
    // hasn't heard the queen for queenDeadAfterMs claims the lease after a rank-jittered delay,
    // waits a settle period, and promotes ONLY if the read-back still shows its own claim
    // (last-write-wins resolves simultaneous claims to one winner). A clock jump between watchdog
    // ticks means the machine slept — the watchdog resets instead of electing a second queen.
    // If two queens ever coexist (revival after sleep), the lease is the tiebreaker: the queen
    // that doesn't hold it demotes back to worker.
    var lease = opts.lease || null;
    var queenDeadAfterMs = opts.queenDeadAfterMs || 90000;
    var claimSettleMs = opts.claimSettleMs || 1500;
    var wakeJumpMs = opts.wakeJumpMs || 30000;
    var leaseRenewMs = opts.leaseRenewMs || 10000;
    // D7 pool autosizing. The queen keeps the live worker count near a target. It only ever
    // SPAWNS (never kills healthy workers — quiet just means it stops replacing reaped ones),
    // and it backs off between spawns so a discard storm or a popup-blocked spawn doesn't loop.
    // The host supplies poolTarget() (current desired count, may change live) and doSpawn()
    // (returns truthy on a spawn attempt). "expected N, have M -> spawn" covers Memory-Saver
    // tab discards: a discarded worker simply stops ponging, gets reaped, and is respawned.
    var poolTarget = (typeof opts.poolTarget === 'function') ? opts.poolTarget : function () { return 0; };
    var doSpawn = (typeof opts.doSpawn === 'function') ? opts.doSpawn : null;
    var spawnBackoffMs = opts.spawnBackoffMs || 20000;
    var lastSpawnAt = 0;
    var lastQueenSeenAt = 0;
    var lastWatchdogAt = 0;
    var lastLeaseAt = 0;
    var claimState = null;   // null | { phase: 'waiting'|'claimed', dueAt, nonce }
    function rankDelay() {
      var h = 0, str = tabId;
      for (var i = 0; i < str.length; i++) h = ((h * 31) + str.charCodeAt(i)) >>> 0;
      return (h % 5) * 1000 + 250;
    }
    function promoteSelf() {
      role = 'queen'; workers = {}; claimState = null; lastPingAt = 0;
      log('[bridge] PROMOTED to queen (' + tabId + ')');
      if (typeof opts.onPromote === 'function') opts.onPromote();
      broadcast('ping');   // adopt surviving workers immediately (they pong; pong-from-unknown registers them)
    }
    function demoteSelf() {
      role = 'worker'; queenId = null; claimState = null; lastQueenSeenAt = clock.now();
      log('[bridge] demoted to worker (' + tabId + ') \u2014 another queen holds the lease');
      if (typeof opts.onDemote === 'function') opts.onDemote();
      broadcast('register');
    }
    function workerWatchdog(now) {
      if (lastWatchdogAt && (now - lastWatchdogAt) > wakeJumpMs) { lastQueenSeenAt = now; claimState = null; lastWatchdogAt = now; return Promise.resolve(); }
      lastWatchdogAt = now;
      if (!lease) return Promise.resolve();
      if (claimState && claimState.phase === 'claimed') {
        if (now < claimState.dueAt) return Promise.resolve();
        var myNonce = claimState.nonce; claimState = null;
        return Promise.resolve(lease.get()).then(function (l) {
          if (l && l.id === tabId && l.nonce === myNonce) promoteSelf();
          else lastQueenSeenAt = now;   // lost the race — give the winner a full window
        });
      }
      if (now - lastQueenSeenAt < queenDeadAfterMs) { if (claimState) claimState = null; return Promise.resolve(); }
      if (!claimState) { claimState = { phase: 'waiting', dueAt: now + rankDelay() }; return Promise.resolve(); }
      if (claimState.phase === 'waiting' && now >= claimState.dueAt) {
        return Promise.resolve(lease.get()).then(function (l) {
          if (l && (now - (l.at || 0)) < queenDeadAfterMs) { claimState = null; lastQueenSeenAt = now; return; }   // a live queen renews this
          var nonce = tabId + ':' + now + ':' + (++seq);
          claimState = { phase: 'claimed', dueAt: now + claimSettleMs, nonce: nonce };
          return lease.set({ id: tabId, at: now, nonce: nonce });
        });
      }
      return Promise.resolve();
    }
    function queenLeaseTick(now) {
      if (!lease) return Promise.resolve();
      if (now - lastLeaseAt < leaseRenewMs) return Promise.resolve();
      lastLeaseAt = now;
      return Promise.resolve(lease.set({ id: tabId, at: now, nonce: 'reign:' + tabId }));
    }
    function autosize(now) {
      if (!doSpawn) return;
      var target = poolTarget() | 0;
      if (target <= 0) return;
      var have = Object.keys(workers).length;
      if (have >= target) return;
      if (now - lastSpawnAt < spawnBackoffMs) return;   // backoff: one spawn per window
      lastSpawnAt = now;
      var r = doSpawn();
      log('[bridge] autosize: ' + have + '/' + target + ' workers \u2014 spawning' + (r ? '' : ' (spawn declined)'));
    }
    function queenConflict(otherId) {
      if (!lease) { if (tabId > otherId) demoteSelf(); return Promise.resolve(); }
      return Promise.resolve(lease.get()).then(function (l) {
        if (l && l.id === tabId) return;                 // we hold the lease; the other will demote
        if (l && l.id === otherId) { demoteSelf(); return; }
        if (tabId < otherId) return Promise.resolve(lease.set({ id: tabId, at: clock.now(), nonce: 'tiebreak:' + tabId }));
        demoteSelf();
      });
    }

    function envelope(to, type, payload, re) {
      return { b: 'chloe-bus', v: 1, tok: token, from: tabId, to: to || '*', type: type, id: tabId + ':' + (++seq), re: re || null, payload: payload == null ? null : payload, ts: clock.now() };
    }
    function post(env) { try { bus.post(env); } catch (e) { log('[bridge] post failed: ' + (e && e.message)); } }
    function broadcast(type, payload) { post(envelope('*', type, payload)); }
    function sendTo(to, type, payload, re) { post(envelope(to, type, payload, re)); }

    // queen: promise-based RPC. request(workerId, jobType, args) -> Promise(result)
    function request(to, jobType, args, timeoutMs) {
      var env = envelope(to, 'job', { jobType: jobType, args: args == null ? null : args });
      return new Promise(function (resolve, reject) {
        pending[env.id] = { resolve: resolve, reject: reject, to: to, deadline: clock.now() + (timeoutMs || requestTimeoutMs) };
        if (workers[to]) workers[to].status = 'busy';
        post(env);
      });
    }

    function settle(re, ok, value) {
      var p = pending[re];
      if (!p) return;
      delete pending[re];
      if (workers[p.to]) workers[p.to].status = 'idle';
      if (ok) p.resolve(value); else p.reject(new Error(String(value || 'job failed')));
    }
    // a worker that died mid-job should fail its requests NOW, not at the request deadline —
    // the caller's fallback (e.g. run the brain locally) can start immediately.
    function rejectPendingFor(workerId, why) {
      Object.keys(pending).forEach(function (rid) { if (pending[rid].to === workerId) settle(rid, false, why); });
    }

    // D2 scheduler: route a job to an idle worker (round-robin); if there are no idle workers,
    // or the chosen worker fails/times out/dies mid-job, run the injected fallback instead.
    var rr = 0;
    function dispatchJob(jobType, payload, timeoutMs, fallback) {
      var ids = Object.keys(workers).filter(function (id) { return workers[id].status === 'idle'; });
      if (role !== 'queen' || !ids.length) {
        if (fallback) return Promise.resolve().then(fallback);
        return Promise.reject(new Error('no idle workers and no fallback'));
      }
      var id = ids[rr++ % ids.length];
      return request(id, jobType, payload, timeoutMs).catch(function (err) {
        log('[bridge] job "' + jobType + '" on ' + id + ' failed (' + ((err && err.message) || err) + ')' + (fallback ? ' \u2014 falling back' : ''));
        if (fallback) return fallback();
        throw err;
      });
    }

    function handleAsQueen(env) {
      if (env.type === 'register') {
        var fresh = !workers[env.from];
        workers[env.from] = { status: 'idle', lastSeen: clock.now() };
        sendTo(env.from, 'registered', { queenId: tabId });
        log('[bridge] worker ' + env.from + (fresh ? ' joined' : ' re-registered'));
        if (fresh && typeof opts.onWorkerJoin === 'function') opts.onWorkerJoin(env.from);
        return;
      }
      if (env.type === 'ping') { queenConflict(env.from); return; }   // another queen exists — resolve via the lease
      if (env.type === 'pong') {
        if (workers[env.from]) { workers[env.from].lastSeen = clock.now(); return; }
        workers[env.from] = { status: 'idle', lastSeen: clock.now() };   // a surviving worker adopted after promotion
        log('[bridge] adopted worker ' + env.from);
        if (typeof opts.onWorkerJoin === 'function') opts.onWorkerJoin(env.from);
        return;
      }
      if (env.type === 'bye') { if (workers[env.from]) { delete workers[env.from]; rejectPendingFor(env.from, 'worker left'); log('[bridge] worker ' + env.from + ' left'); if (typeof opts.onWorkerLost === 'function') opts.onWorkerLost(env.from, 'bye'); } return; }
      if (env.type === 'result') { settle(env.re, true, env.payload); return; }
      if (env.type === 'error') { settle(env.re, false, env.payload); return; }
    }

    function handleAsWorker(env) {
      if (env.type === 'registered') { queenId = env.payload && env.payload.queenId ? env.payload.queenId : env.from; lastQueenSeenAt = clock.now(); claimState = null; return; }
      if (env.type === 'ping') { queenId = env.from; lastQueenSeenAt = clock.now(); claimState = null; sendTo(env.from, 'pong'); return; }
      if (env.type === 'shutdown') {
        log('[bridge] shutdown received');
        broadcast('bye');
        running = false;
        if (typeof opts.onShutdown === 'function') opts.onShutdown();
        return;
      }
      if (env.type === 'job') {
        lastQueenSeenAt = clock.now();
        var jobType = env.payload && env.payload.jobType;
        var fn = jobHandlers[jobType];
        if (!fn) { sendTo(env.from, 'error', 'no handler for job type "' + jobType + '"', env.id); return; }
        Promise.resolve().then(function () { return fn(env.payload.args); }).then(
          function (res) { sendTo(env.from, 'result', res == null ? null : res, env.id); },
          function (err) { sendTo(env.from, 'error', (err && err.message) || String(err), env.id); }
        );
        return;
      }
    }

    function onBusMessage(env) {
      if (!running || !env || env.b !== 'chloe-bus') return;
      if (env.tok !== token) { log('[bridge] dropped envelope with bad token from ' + env.from); return; }
      if (env.from === tabId) return;                          // own echo (GM fallback path)
      if (env.to !== '*' && env.to !== tabId) return;          // not for us
      if (role === 'queen') handleAsQueen(env); else handleAsWorker(env);
    }

    // host calls this on its own interval (queen tab = foreground tab = reliable timers)
    function tick() {
      if (!running) return Promise.resolve();
      var now = clock.now();
      var duty = Promise.resolve();
      if (role === 'queen') {
        if (now - lastPingAt >= pingIntervalMs) { lastPingAt = now; broadcast('ping'); }
        Object.keys(workers).forEach(function (id) {
          if (now - workers[id].lastSeen > deadAfterMs) {
            delete workers[id];
            rejectPendingFor(id, 'worker lost (no heartbeat)');
            log('[bridge] worker ' + id + ' presumed dead (no pong in ' + deadAfterMs + 'ms)');
            if (typeof opts.onWorkerLost === 'function') opts.onWorkerLost(id, 'timeout');
          }
        });
        duty = queenLeaseTick(now);
        autosize(now);
      } else {
        duty = workerWatchdog(now);
      }
      Object.keys(pending).forEach(function (id) {
        if (now > pending[id].deadline) settle(id, false, 'request timed out');
      });
      return duty;
    }

    function start() {
      if (running) return;
      running = true;
      bus.onMessage(onBusMessage);
      lastQueenSeenAt = clock.now(); lastWatchdogAt = 0;
      if (role === 'worker') broadcast('register');
      log('[bridge] started as ' + role + ' (' + tabId + ')');
    }
    function stop() { running = false; }

    return {
      role: role,                                     // role at creation (legacy)
      getRole: function () { return role; },          // live role (changes on promote/demote)
      tabId: tabId,
      start: start,
      stop: stop,
      tick: tick,
      broadcast: broadcast,
      sendTo: sendTo,
      request: request,
      dispatchJob: dispatchJob,
      onJob: function (jobType, fn) { jobHandlers[jobType] = fn; },
      workers: function () { var out = {}; Object.keys(workers).forEach(function (k) { out[k] = { status: workers[k].status, lastSeen: workers[k].lastSeen }; }); return out; },
      shutdownWorker: function (id) { sendTo(id, 'shutdown'); },
      isRunning: function () { return running; }
    };
  }

  return { createTabBridge: createTabBridge };
});
// ===================================================================================
// chloe-bridge — GM transport + store adapters, control link, and menu (T0).
// Appended AFTER the verified engine.js (which defines `ChloeT0`).
// Runs only in the TOP frame; in Perchance sub-frames (the panel iframe) it no-ops,
// so the control generator's own page code is the only thing running there.
// This is plain userscript JS — NOT subject to the Perchance panel parser — so normal
// object indexing / template style is fine here (unlike the generator files).
// ===================================================================================
(function () {
  'use strict';
  if (window.top !== window) return;   // engine + link live in the top frame only

  var API = 'https://discord.com/api/v10';
  var UA = 'DiscordBot (https://github.com/therealwestninja, 1.0)';
  var NS = 'chloe:';
  var VERSION = '0.28.0';
  // D1: queen/worker role. Worker tabs are spawned with '#chloe-worker' in the URL; everything
  // else (including today's single-tab setup) is the queen. Workers never poll Discord, never
  // start the engine, and never write GM state — they contribute their tab's AI brain via jobs.
  var TAB_ROLE = (typeof location !== 'undefined' && /chloe-worker/.test(location.hash || '')) ? 'worker' : 'queen';

  function cfgGet(k, d) { var v = GM_getValue(NS + 'cfg:' + k, null); return v == null ? d : v; }
  function cfgSet(k, v) { GM_setValue(NS + 'cfg:' + k, v); }
  // #17: a small in-memory ring of link/transport/poll events, readable after the fact (the link's
  // failure modes are timing-dependent and easy to miss live). Mirrors to console; capped at 60.
  var traceRing = [], TRACE_MAX = 60;
  function trace(tag, msg) {
    var e = { t: Date.now(), tag: tag, msg: String(msg) };
    traceRing.push(e); if (traceRing.length > TRACE_MAX) traceRing = traceRing.slice(-TRACE_MAX);
    return e;
  }
  function tokenShape(t) {
    return { len: t ? t.length : 0, parts: t ? t.split('.').length : 0,
             ws: /\s/.test(t || ''), placeholder: !t || t.indexOf('PASTE_') === 0 };
  }
  function hasToken() { return !tokenShape(cfgGet('token', '')).placeholder; }

  // ---- GM store adapter (KV + maintained roster index) --------------------------------
  // D3: per-channel namespacing. The PRIMARY channel keeps the legacy un-prefixed namespace so an
  // existing install keeps its memory; every additional channel lives under 'ch:{id}:'.
  function makeStore(pfx) {
    var s = {
      get: function (k) { return Promise.resolve().then(function () { var v = GM_getValue(NS + pfx + k, null); if (v == null) return null; try { return JSON.parse(v); } catch (e) { return null; } }); },
      set: function (k, v) { GM_setValue(NS + pfx + k, JSON.stringify(v)); return Promise.resolve(true); },
      del: function (k) { GM_deleteValue(NS + pfx + k); return Promise.resolve(true); },
      listIndex: function () { return s.get('roster:index').then(function (a) { return a || []; }); },
      setIndex: function (arr) { return s.set('roster:index', arr); }
    };
    return s;
  }
  var store = makeStore('');
  function primaryChannel() { return String(cfgGet('channelId', '') || '').trim(); }
  // DM sessions: once Chloe opens a DM channel (she gets the channel id back), that channel is
  // pollable like any other — Discord lets a bot read messages in a DM it's part of. We can't
  // DISCOVER a cold inbound DM (no Gateway), but any DM Chloe opens becomes two-way. Stored as
  // { dmChannelId: { user, name, openedAt } }.
  function dmSessions() { return cfgGet('dmSessions', {}) || {}; }
  function dmChannelIds() { return Object.keys(dmSessions()); }
  function isDMChannel(chId) { return !!dmSessions()[chId]; }
  function recordDMSession(dmChannelId, userId, name) {
    if (!dmChannelId || !userId) return;
    var s = dmSessions();
    if (!s[dmChannelId]) { s[dmChannelId] = { user: String(userId), name: name || '', openedAt: Date.now() }; cfgSet('dmSessions', s); }
  }
  function channelList() {
    var seen = {}, out = [];
    [primaryChannel()].concat(cfgGet('channels', []) || []).concat(cfgGet('dmReplies', false) ? dmChannelIds() : []).forEach(function (c) {
      c = String(c || '').trim();
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    return out;
  }
  function prefixFor(chId) { return chId === primaryChannel() ? '' : ('ch:' + chId + ':'); }
  function chKeyOf(args) { var c = String((args && args.channelId) || '').trim(); var list = channelList(); return (c && list.indexOf(c) >= 0) ? c : (list[0] || ''); }

  // ---- Discord transport (anonymous + bot UA + 429 honor) -----------------------------
  function dataUrlToBlob(dataUrl) {
    var s = String(dataUrl);
    var comma = s.indexOf(',');
    var meta = s.slice(0, comma), data = s.slice(comma + 1);
    var mime = (meta.match(/data:([^;]+)/) || [null, 'image/jpeg'])[1];
    var bytes;
    if (/;base64/i.test(meta)) {
      var bin = atob(data); var n = bin.length; bytes = new Uint8Array(n);
      for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(data));
    }
    return new Blob([bytes], { type: mime });
  }
  function rawRequest(method, path, opts) {
    opts = opts || {};
    var token = cfgGet('token', '');
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method, url: API + path,
        headers: Object.assign({ 'Authorization': 'Bot ' + token, 'User-Agent': UA },
                               opts.json ? { 'Content-Type': 'application/json' } : {},
                               opts.headers || {}),
        data: opts.formData ? opts.formData : (opts.body != null ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined),
        anonymous: true,
        onload: function (r) { resolve(r); },
        onerror: function () { reject(new Error('transport error')); },
        ontimeout: function () { reject(new Error('transport timeout')); }
      });
    });
  }
  function requestJSON(method, path, opts, _tries) {
    _tries = _tries || 0;
    return rawRequest(method, path, opts).then(function (r) {
      if (r.status === 429 && _tries < 4) {
        var retry = 1; try { retry = (JSON.parse(r.responseText).retry_after) || 1; } catch (e) {}
        var hdr = /retry-after:\s*([\d.]+)/i.exec(r.responseHeaders || ''); if (hdr) retry = parseFloat(hdr[1]);
        trace('http', '429 on ' + method + ' ' + path + '; retry in ' + retry + 's');
        return new Promise(function (res) { setTimeout(res, Math.ceil(retry * 1000) + 50); })
          .then(function () { return requestJSON(method, path, opts, _tries + 1); });
      }
      var body = null; try { body = JSON.parse(r.responseText); } catch (e) {}
      if (r.status < 200 || r.status >= 300) { trace('http', 'HTTP ' + r.status + ' on ' + method + ' ' + path); var err = new Error('HTTP ' + r.status + (body ? ' ' + JSON.stringify(body) : '')); err.status = r.status; err.body = body; throw err; }
      return body;
    });
  }
  // ---- output gates (mod-toggleable) ---------------------------------------------------
  // What Chloe is allowed to put in an outgoing message. PINGS use Discord's own input-sanitation
  // (the allowed_mentions object — the platform itself decides what resolves to a real ping);
  // EMOJI / LINKS / CHANNEL-LINKS have no such API for your own messages, so Chloe scrubs them
  // from her content before posting. Each gate is independently mod-toggleable. Safe defaults:
  // emoji on (harmless, expressive); pings / @everyone / links / channel-links off.
  function gate(k, d) { return !!cfgGet('gate:' + k, d); }
  function allowedMentions() {
    var parse = [];
    if (gate('pings', false)) { parse.push('users'); parse.push('roles'); }
    if (gate('everyone', false)) parse.push('everyone');
    return { parse: parse };   // parse:[] = Discord resolves NO mentions to real pings
  }
  function gateContent(text) {
    var t = String(text || '');
    if (!gate('emoji', true)) t = t.replace(/<a?:\w+:\d+>/g, '');           // custom/animated emoji
    if (!gate('channelLinks', false)) t = t.replace(/<#\d+>/g, '');          // channel mentions
    if (!gate('links', false)) t = t.replace(/https?:\/\/\S+/gi, '');        // URLs (also kills auto-embeds)
    return t.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').trim(); // tidy, preserve newlines
  }

  var transport = {
    getMe: function () { return requestJSON('GET', '/users/@me'); },
    getMessagesAfter: function (channelId, afterId, limit) {
      return requestJSON('GET', '/channels/' + channelId + '/messages?limit=' + (limit || 50) + (afterId ? '&after=' + afterId : ''));
    },
    sendMessage: function (channelId, text) {
      return requestJSON('POST', '/channels/' + channelId + '/messages', { json: true, body: { content: gateContent(text).slice(0, 1900), allowed_mentions: allowedMentions() } });
    },
    sendEmbed: function (channelId, embed) {
      return requestJSON('POST', '/channels/' + channelId + '/messages', { json: true, body: { embeds: [embed], allowed_mentions: allowedMentions() } });
    },
    addReaction: function (channelId, messageId, emoji) {
      return requestJSON('PUT', '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me', {});
    },
    pinMessage: function (channelId, messageId) {
      return requestJSON('PUT', '/channels/' + channelId + '/pins/' + messageId, {});   // needs Manage Messages; 204 on success
    },
    startTyping: function (channelId) { return requestJSON('POST', '/channels/' + channelId + '/typing', { json: true, body: {} }); },
    getChannel: function (channelId) { return requestJSON('GET', '/channels/' + channelId, {}); },
    getReactions: function (channelId, messageId, emoji) { return requestJSON('GET', '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '?limit=10', {}); },
    getMember: function (guildId, userId) { return requestJSON('GET', '/guilds/' + guildId + '/members/' + userId, {}); },
    getMessagesBefore: function (channelId, beforeId, limit) {
      return requestJSON('GET', '/channels/' + channelId + '/messages?limit=' + (limit || 100) + (beforeId ? '&before=' + beforeId : ''));
    },
    banUser: function (guildId, userId, reason) {
      var h = reason ? { 'X-Audit-Log-Reason': encodeURIComponent(String(reason)).slice(0, 480) } : {};
      return requestJSON('PUT', '/guilds/' + guildId + '/bans/' + userId, { json: true, body: {}, headers: h });
    },
    // post an image as a native file attachment (multipart). content-type/boundary are set by
    // the request layer from the FormData, so we must NOT set Content-Type ourselves.
    sendImage: function (channelId, dataUrl, caption) {
      var blob = dataUrlToBlob(dataUrl);
      var ext = blob.type.indexOf('png') >= 0 ? 'png' : 'jpg';
      var fd = new FormData();
      fd.append('payload_json', JSON.stringify({ content: gateContent(caption).slice(0, 1900), allowed_mentions: allowedMentions() }));
      fd.append('files[0]', blob, 'chloe.' + ext);
      return requestJSON('POST', '/channels/' + channelId + '/messages', { formData: fd });
    },
    openDM: function (userId) {
      return requestJSON('POST', '/users/@me/channels', { json: true, body: { recipient_id: String(userId) } })
        .then(function (ch) { return ch && ch.id; });
    }
  };
  // #3: outbound send cap. The engine already spaces text sends, but greet/reply/image/beat lanes and
  // multi-ack batches can still bunch up; this serializes ALL outbound posts through one queue with a
  // minimum gap, a hard floor that keeps bursts under Discord's per-channel rate (429s stay the backstop).
  var SEND_MIN_GAP = cfgGet('sendMinGapMs', 1100), sendQueue = Promise.resolve(), lastSendAt = 0;
  function paced(fn) {
    return function () {
      var args = arguments;
      var run = function () {
        var wait = Math.max(0, SEND_MIN_GAP - (Date.now() - lastSendAt));
        return new Promise(function (res) { setTimeout(res, wait); }).then(function () { lastSendAt = Date.now(); return fn.apply(transport, args); });
      };
      var ret = sendQueue.then(run, run);   // run regardless of the previous send's outcome
      sendQueue = ret.catch(function () {}); // keep the chain alive for the next caller
      return ret;
    };
  }
  ['sendMessage', 'sendEmbed', 'sendImage'].forEach(function (k) { var orig = transport[k]; transport[k] = paced(orig); });

  // ---- bidirectional link plumbing: userscript -> page (brain) ------------------------
  // The page (generator HTML panel) is the only context that can run aiTextPlugin, so the
  // engine asks it to generate over a reverse call. Page window ref is captured on any
  // valid inbound message and refreshed on reload.
  var pageSource = null, pageOrigin = null;
  // #14: some userscript managers sandbox `window` so the page's postMessages miss a listener bound
  // to the wrapped window; bind to the real page window when available (Tampermonkey works either way).
  var LINKWIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  // #15: a sandboxed frame can report origin 'null'; posting back to targetOrigin 'null' is dropped,
  // so fall back to '*' in that one case (responses are nonce-matched, so this stays safe).
  function replyTarget(o) { return (o && o !== 'null') ? o : '*'; }
  var callPending = new Map(); var callSeq = 0;
  function callPage(method, args, timeoutMs) {
    return new Promise(function (resolve) {
      if (!pageSource) { resolve({ ok: false, reason: 'no control page linked (open the Chloe generator tab)' }); return; }
      var nonce = 'u' + (++callSeq) + '_' + Date.now();
      var t = setTimeout(function () { callPending.delete(nonce); resolve({ ok: false, reason: 'page timeout' }); }, timeoutMs || 30000);
      callPending.set(nonce, function (res) { clearTimeout(t); resolve(res); });
      try { pageSource.postMessage({ __chloe: 1, kind: 'call', nonce: nonce, method: method, args: args || null }, replyTarget(pageOrigin)); }
      catch (e) { clearTimeout(t); callPending.delete(nonce); resolve({ ok: false, reason: 'post failed' }); }
    });
  }
  function pushEvent(name, value) { if (!pageSource) return; try { pageSource.postMessage({ __chloe: 1, kind: 'event', name: name, value: value }, replyTarget(pageOrigin)); } catch (e) {} }

  // ---- D2: brain offload --------------------------------------------------------------
  // Every brain call goes through here: if this is the queen and an idle worker exists, the job
  // runs on that worker's tab (its own AI/image brokers — the genuinely parallel resource);
  // otherwise, or on any worker failure/loss mid-job, it runs locally via callPage. The engine
  // never knows the difference: same promise, same {ok, value} shape.
  function brainCall(kind, args, timeoutMs) {
    timeoutMs = timeoutMs || 40000;
    if (kind !== 'paint') {
      var dials = cfgGet('personality', null);
      if (dials) args = Object.assign({}, args || {}, { personality: dials });
    }
    function local() { return callPage(kind, args, timeoutMs); }
    if (tabBridge && TAB_ROLE === 'queen') {
      return tabBridge.dispatchJob('brain', { kind: kind, args: args, timeoutMs: timeoutMs }, timeoutMs + 5000, local);
    }
    return local();
  }

  // ---- engine wiring ------------------------------------------------------------------
  var engines = {};   // D3: channelId -> engine (each with its own namespaced store)
  var lastPoll = null;
  function buildEngine(chId) {
    var channelId = String(chId || primaryChannel() || '').trim();
    if (!channelId) return null;
    var eng = ChloeT0.createEngine({
      transport: transport, store: makeStore(prefixFor(channelId)),
      config: {
        channelId: channelId,
        botUserId: cfgGet('botUserId', ''),
        botName: cfgGet('botName', ''),
        botAliases: cfgGet('botAliases', []),
        addressMode: isDMChannel(channelId) ? 'always' : cfgGet('addressMode', 'both'),
        volunteer: !!cfgGet('volunteer', false),
        greet: !!cfgGet('greet', false),
        backfill: !!cfgGet('backfill', false),
        image: !!cfgGet('image', false),
        imageQueueMax: cfgGet('imageQueueMax', 8),
        imageCooldownMs: cfgGet('imageCooldownMs', 2000),
        autoMod: !!cfgGet('autoMod', false),
        autoModRules: cfgGet('autoModRules', []),
        strikeLadder: cfgGet('strikeLadder', [
          { action: 'ignore' },
          { action: 'timeout', durationMs: 600000 },
          { action: 'timeout', durationMs: 3600000 },
          { action: 'softban' }
        ]),
        strikeDecayMs: cfgGet('strikeDecayMs', 86400000),
        engageMode: cfgGet('engageMode:' + channelId, cfgGet('engageMode', 'normal')),
        beats: cfgGet('beats', []),
        beatFn: function (b) { return brainCall('beat', b, 30000); },
        greetFn: function (ctx) { return brainCall('greet', ctx, 40000); },
        modList: cfgGet('modList', []),
        commandPrefix: '!chloe', ackCommands: true,
        backgroundText: true,
        commandPrefixes: cfgGet('commandPrefixes', []),
        pollIntervalMs: 6000, cooldownMs: 8000, debounceMs: 2500, contextLines: 12,
        volunteerCooldownMs: 45000, judgeMinConfidence: 0.6,
        respond: function (ctx) { return brainCall('respond', ctx, 40000); },
        judge: function (ctx) { return brainCall('judge', ctx, 40000); },
        recapFn: function (ctx) { return brainCall('recap', ctx, 45000); },
        typing: function (cid) { return transport.startTyping(cid); },
        react: function (cid, mid, emoji) { return transport.addReaction(cid, mid, emoji); },
        paint: function (req) { return brainCall('paint', { prompt: req.prompt, resolution: req.resolution }, 120000); },
        sendImage: function (cid, dataUrl, caption) { return transport.sendImage(cid, dataUrl, caption); },
        openDM: function (uid) { return transport.openDM(uid).then(function (dmId) { if (dmId) recordDMSession(dmId, uid, ''); return dmId; }); },
        onChannelGone: function (chId) {
          if (isDMChannel(chId)) {
            var s = dmSessions(); if (s[chId]) { delete s[chId]; cfgSet('dmSessions', s); }
            trace('poll', 'DM channel ' + chId + ' is gone (recipient closed it) \u2014 dropped from polling');
          } else {
            trace('poll', 'channel ' + chId + ' returned Unknown Channel (404) \u2014 paused. Check the channel id / bot permissions, then Start again.');
            console.warn('[chloe] channel ' + chId + ' is unreachable (404 Unknown Channel). Polling for it is paused; verify the channel id and that the bot can see it.');
          }
          delete engines[chId];
          pushEvent('channelGone', { channelId: chId });
        },
        send: function (cid, text) { return transport.sendMessage(cid, text); },
        sendEmbed: function (cid, embed) { return transport.sendEmbed(cid, embed); },
        onPoll: function (summary) {
          lastPoll = summary; pushEvent('poll', summary);
          if (summary && (summary.ingested || summary.replied || summary.imageJob || summary.greeted || summary.volunteered || summary.commands)) {
            trace('poll', 'in ' + (summary.ingested || 0) + (summary.replied ? ' reply' : '') + (summary.imageJob ? ' image' : '') + (summary.greeted ? ' greet' : '') + (summary.volunteered ? ' vol' : '') + (summary.commands ? ' cmd' : '') + ' [' + (summary.engageMode || 'normal') + ']');
          }
          if (summary && summary.engageMode && summary.engageMode !== cfgGet('engageMode:' + channelId, cfgGet('engageMode', 'normal'))) cfgSet('engageMode:' + channelId, summary.engageMode);  // a !chloe lockdown/unlock/open command changed it
          return presenceMaintenance(channelId);
        }
      },
      log: function () { console.log.apply(console, arguments); }
    });
    engines[channelId] = eng;
    return eng;
  }

  // T5: transport-backed maintenance, run after each poll. Backfill walks history one bounded page
  // at a time; the departure sweep 404-checks a bounded, prioritized set on a slow cadence.
  var maintTick = 0;
  function presenceMaintenance(chId) {
    var eng = engines[chId];
    if (!eng) return Promise.resolve();
    var jobs = Promise.resolve();
    if (cfgGet('backfill', false) && !cfgGet('backfillDone:' + chId, false)) {
      jobs = jobs.then(function () {
        return eng.backfillStep(function (before, limit) { return transport.getMessagesBefore(chId, before, limit); })
          .then(function (r) { if (r) { if (!r.done) pushEvent('backfill', r); else { cfgSet('backfillDone:' + chId, true); var allDone = channelList().every(function (c) { return cfgGet('backfillDone:' + c, false); }); if (allDone) cfgSet('backfill', false); console.log('[chloe.T5] backfill complete (' + chId + '): ' + r.ingested + ' msgs over ' + r.pages + ' page(s)'); pushEvent('backfill', r); } } }, function () {});
      });
    }
    maintTick++;
    if (cfgGet('memberCheck', false) && (maintTick % 10 === 0)) {
      jobs = jobs.then(function () {
        return resolveGuildId(chId).then(function (gid) {
          if (!gid) return;
          return eng.dueForMemberCheck(5).then(function (due) {
            var c = Promise.resolve();
            due.forEach(function (d) {
              c = c.then(function () {
                return transport.getMember(gid, d.id).then(
                  function () { return eng.noteMemberPresent(d.id); },
                  function (err) { if (err && err.status === 404) { console.log('[chloe.T5] ' + d.name + ' is no longer a member; marking departed'); return eng.markDeparted(d.id); } return eng.noteMemberPresent(d.id); }
                );
              });
            });
            return c;
          });
        }).catch(function () {});
      });
    }
    if (cfgGet('personaAnchor', false) && (maintTick % 10 === 3)) {
      jobs = jobs.then(function () {
        return eng.anchorSweep(
          function () { return transport.getMessagesAfter(chId, null, 20); },
          function (mid, emoji) { return transport.getReactions(chId, mid, emoji); }
        ).then(function (r) { if (r && r.changed) { trace('persona', 'new anchored note (' + chId + ')'); pushEvent('persona', r); } }, function () {});
      });
    }
    return jobs;
  }
  function ensureEngines() { return channelList().map(function (c) { return engines[c] || buildEngine(c); }).filter(Boolean); }
  function engineFor(chId) { var c = chKeyOf({ channelId: chId }); if (!c) return null; return engines[c] || buildEngine(c); }
  function ensureEngine() { return engineFor(''); }
  function eachEngine(fn) { Object.keys(engines).forEach(function (c) { try { fn(engines[c], c); } catch (e) {} }); }

  var guildIdCache = {};
  function resolveGuildId(chId) {
    var cid = String(chId || primaryChannel() || '').trim();
    if (!cid) return Promise.resolve(null);
    if (guildIdCache[cid]) return Promise.resolve(guildIdCache[cid]);
    return transport.getChannel(cid).then(function (ch) {
      guildIdCache[cid] = (ch && ch.guild_id) || null;
      return guildIdCache[cid];
    }, function () { return null; });
  }
  // config changes must not run on a stale instance: stop, rebuild, and restart if it was live
  function applyConfigChange() {
    var wasRunning = Object.keys(engines).some(function (c) { return engines[c] && engines[c].isRunning && engines[c].isRunning(); });
    eachEngine(function (e) { e.stop(); });
    engines = {};
    guildIdCache = {};
    if (wasRunning) ensureEngines().forEach(function (e) { e.start(); });
  }

  function validate() {
    return transport.getMe().then(function (me) {
      cfgSet('botUserId', me.id); cfgSet('botName', me.username || '');
      applyConfigChange();  // rebuild (and restart if live) with the fresh identity
      return { ok: true, value: { id: me.id, username: me.username, bot: me.bot } };
    }).catch(function (e) { return { ok: false, reason: 'HTTP ' + (e.status || '?'), body: e.body || null }; });
  }
  function statusSnapshot() {
    return {
      version: VERSION, hasToken: hasToken(),
      channelId: cfgGet('channelId', ''), botUserId: cfgGet('botUserId', ''), botName: cfgGet('botName', ''),
      addressMode: cfgGet('addressMode', 'both'), volunteer: !!cfgGet('volunteer', false),
      greet: !!cfgGet('greet', false), memberCheck: !!cfgGet('memberCheck', false), backfill: !!cfgGet('backfill', false),
      image: !!cfgGet('image', false),
      imageQueueMax: cfgGet('imageQueueMax', 8),
      autoMod: !!cfgGet('autoMod', false), autoModRules: cfgGet('autoModRules', []),
      engageMode: cfgGet('engageMode:' + primaryChannel(), cfgGet('engageMode', 'normal')),
      channels: channelList(),
      engageModes: (function () { var m = {}; channelList().forEach(function (c) { m[c] = cfgGet('engageMode:' + c, cfgGet('engageMode', 'normal')); }); return m; })(),
      runningByChannel: (function () { var m = {}; channelList().forEach(function (c) { m[c] = !!(engines[c] && engines[c].isRunning && engines[c].isRunning()); }); return m; })(),
      beats: cfgGet('beats', []),
      commandPrefixes: cfgGet('commandPrefixes', []),
      noticePinned: !!cfgGet('noticePinned', false), noticeText: cfgGet('noticeText', ''),
      personality: cfgGet('personality', null), personaAnchor: !!cfgGet('personaAnchor', false),
      gates: { emoji: gate('emoji', true), pings: gate('pings', false), everyone: gate('everyone', false), links: gate('links', false), channelLinks: gate('channelLinks', false) },
      pageLinked: !!pageSource,
      running: Object.keys(engines).some(function (c) { return engines[c] && engines[c].isRunning && engines[c].isRunning(); }),
      lastPoll: lastPoll
    };
  }

  // ---- control link: page (generator HTML panel) -> userscript (trusted surface) ------
  // Mirrors the skybridge trust shape: origin-checked, nonce-matched, scoped commands,
  // secrets never cross (the bot token is never returned to the page).
  var ORIGIN_OK = /^https:\/\/([a-z0-9]{32}\.)?perchance\.org$/;
  function dispatch(cmd, args) {
    switch (cmd) {
      case 'ping':            return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'status':          return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'config.setChannel':
        cfgSet('channelId', String((args && args.channelId) || '').trim()); applyConfigChange();
        return Promise.resolve({ ok: true, value: { channelId: cfgGet('channelId', '') } });
      case 'config.setMode':
        { var mode = String((args && args.mode) || 'both'); if (mode !== 'mention' && mode !== 'name' && mode !== 'both') mode = 'both'; cfgSet('addressMode', mode); applyConfigChange(); return Promise.resolve({ ok: true, value: { addressMode: mode } }); }
      case 'config.setVolunteer':
        { var on = !!(args && args.on); cfgSet('volunteer', on); applyConfigChange(); return Promise.resolve({ ok: true, value: { volunteer: on } }); }
      case 'config.setGreet':
        { var g = !!(args && args.on); cfgSet('greet', g); applyConfigChange(); return Promise.resolve({ ok: true, value: { greet: g } }); }
      case 'config.setMemberCheck':
        { var mc = !!(args && args.on); cfgSet('memberCheck', mc); return Promise.resolve({ ok: true, value: { memberCheck: mc } }); }
      case 'config.setBackfill':
        { var bf = !!(args && args.on); cfgSet('backfill', bf); applyConfigChange(); return Promise.resolve({ ok: true, value: { backfill: bf } }); }
      case 'config.setImage':
        { var im = !!(args && args.on); cfgSet('image', im); applyConfigChange(); return Promise.resolve({ ok: true, value: { image: im } }); }
      case 'config.setPrefixes': {
        var list = (args && args.prefixes);
        if (!Array.isArray(list)) return Promise.resolve({ ok: false, reason: 'prefixes must be an array' });
        var clean = [];
        list.forEach(function (p) { p = String(p || '').trim(); if (p && p !== '!chloe' && clean.indexOf(p) < 0) clean.push(p); });
        cfgSet('commandPrefixes', clean); applyConfigChange();
        return Promise.resolve({ ok: true, value: { commandPrefixes: clean } });
      }
      case 'mod.pinNotice': {
        var force = !!(args && args.force);
        if (cfgGet('noticePinned', false) && !force) return Promise.resolve({ ok: true, value: { already: true } });
        var nch = chKeyOf(args);
        if (!nch) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var ntext = (args && args.text) ? String(args.text) : 'Heads up: Chloe is a roleplay bot character, not a real person. She reads this channel and remembers regulars so she can chat in character. Mods can adjust or pause her at any time.';
        return transport.sendMessage(nch, ntext).then(function (m) {
          var mid = m && m.id;
          if (!mid) return { ok: false, reason: 'no message id returned' };
          return transport.pinMessage(nch, mid).then(function () {
            cfgSet('noticePinned', true); cfgSet('noticeMsgId', mid); cfgSet('noticeText', ntext);
            return { ok: true, value: { messageId: mid } };
          }, function (e) { return { ok: false, reason: 'posted, but pin failed (Manage Messages permission?): ' + ((e && e.message) || e) }; });
        }, function (e) { return { ok: false, reason: 'post failed: ' + ((e && e.message) || e) }; });
      }
      case 'config.setBeats': {
        var bl = (args && args.beats);
        if (!Array.isArray(bl)) return Promise.resolve({ ok: false, reason: 'beats must be an array' });
        var cleanB = [];
        bl.forEach(function (b) {
          if (!b || !b.id || !b.intervalMs) return;
          var o = { id: String(b.id), intervalMs: Number(b.intervalMs) || 0 };
          if (!o.intervalMs) return;
          if (Array.isArray(b.texts) && b.texts.length) o.texts = b.texts.map(String);
          else if (b.text) o.text = String(b.text);
          else if (b.prompt) o.prompt = String(b.prompt);
          else return;   // a beat with nothing to say is dropped
          if (b.activeWithinMs != null) o.activeWithinMs = Number(b.activeWithinMs) || 0;
          cleanB.push(o);
        });
        cfgSet('beats', cleanB); applyConfigChange();
        return Promise.resolve({ ok: true, value: { count: cleanB.length, beats: cleanB } });
      }
      case 'config.setPersonality': {
        var rawP = (args && args.personality);
        if (rawP == null) { cfgSet('personality', null); return Promise.resolve({ ok: true, value: { personality: null } }); }
        if (typeof rawP !== 'object') return Promise.resolve({ ok: false, reason: 'personality must be an object of 0..1 dials' });
        var DIALS = ['kindness', 'sarcasm', 'curiosity', 'playfulness', 'formality', 'verbosity'];
        var cleanP = {};
        DIALS.forEach(function (k) { if (rawP[k] != null && isFinite(rawP[k])) cleanP[k] = Math.max(0, Math.min(1, Number(rawP[k]))); });
        cfgSet('personality', cleanP);
        return Promise.resolve({ ok: true, value: { personality: cleanP } });
      }
      case 'config.setPersonaAnchor':
        { var paOn = !!(args && args.on); cfgSet('personaAnchor', paOn); return Promise.resolve({ ok: true, value: { personaAnchor: paOn } }); }
      case 'persona.get': {
        var eP = engineFor(args && args.channelId); if (!eP) return Promise.resolve({ ok: true, value: null });
        return eP.getPersonaNote().then(function (n) { return { ok: true, value: n }; });
      }
      case 'persona.clear': {
        var eC = engineFor(args && args.channelId); if (!eC) return Promise.resolve({ ok: false, reason: 'no channel set' });
        return eC.clearPersonaNote().then(function () { return { ok: true, value: { cleared: true } }; });
      }
      case 'config.setChannels': {
        var rawC = (args && args.channels);
        if (!Array.isArray(rawC)) return Promise.resolve({ ok: false, reason: 'channels must be an array of channel ids' });
        var cleanC = [], seenC = {};
        rawC.forEach(function (c) { c = String(c || '').trim(); if (/^\d+$/.test(c) && c !== primaryChannel() && !seenC[c]) { seenC[c] = 1; cleanC.push(c); } });
        cfgSet('channels', cleanC); applyConfigChange();
        return Promise.resolve({ ok: true, value: { channels: channelList() } });
      }
      case 'config.setEngageMode': {
        var mode = (args && args.mode);
        if (mode !== 'locked' && mode !== 'normal' && mode !== 'open') return Promise.resolve({ ok: false, reason: 'mode must be locked|normal|open' });
        var emCh = chKeyOf(args);
        if (!emCh) return Promise.resolve({ ok: false, reason: 'no channel set' });
        cfgSet('engageMode:' + emCh, mode); applyConfigChange();
        return Promise.resolve({ ok: true, value: { engageMode: mode, channelId: emCh } });
      }
      case 'config.setImageQueue': {
        var n = Math.max(1, Math.min(20, parseInt((args && args.max), 10) || 8));
        cfgSet('imageQueueMax', n); applyConfigChange();
        return Promise.resolve({ ok: true, value: { imageQueueMax: n } });
      }
      case 'config.setAutoMod':
        { var am = !!(args && args.on); cfgSet('autoMod', am); applyConfigChange(); return Promise.resolve({ ok: true, value: { autoMod: am } }); }
      case 'config.setAutoModRules': {
        var rules = (args && args.rules);
        if (!Array.isArray(rules)) return Promise.resolve({ ok: false, reason: 'rules must be an array' });
        var clean = [];
        rules.forEach(function (r) {
          if (!r || !r.pattern) return;
          var type = (r.type === 'regex' || r.type === 'confusables' || r.type === 'link') ? r.type : 'text';
          var action = (r.action === 'timeout' || r.action === 'softban' || r.action === 'clear' || r.action === 'warn') ? r.action : 'ignore';  // reversible only ('warn' = escalate)
          var o = { pattern: String(r.pattern), type: type, action: action };
          if (r.durationMs) o.durationMs = Number(r.durationMs) || undefined;
          if (r.reason) o.reason = String(r.reason);
          clean.push(o);
        });
        cfgSet('autoModRules', clean); applyConfigChange();
        return Promise.resolve({ ok: true, value: { count: clean.length, rules: clean } });
      }
      case 'bridge.status':
        return Promise.resolve({ ok: true, value: { role: TAB_ROLE, tabId: tabBridge ? tabBridge.tabId : null, bus: !!tabBus, poolSize: cfgGet('poolSize', 0), workers: (tabBridge && TAB_ROLE === 'queen') ? tabBridge.workers() : {} } });
      case 'config.setGate': {
        var GKEYS = { emoji: true, pings: false, everyone: false, links: false, channelLinks: false };
        var gk = String((args && args.key) || '');
        if (!(gk in GKEYS)) return Promise.resolve({ ok: false, reason: 'unknown gate "' + gk + '" (emoji, pings, everyone, links, channelLinks)' });
        cfgSet('gate:' + gk, !!(args && args.on));
        return Promise.resolve({ ok: true, value: { key: gk, on: !!(args && args.on) } });
      }
      case 'config.setDMReplies':
        { var dr = !!(args && args.on); cfgSet('dmReplies', dr); applyConfigChange(); return Promise.resolve({ ok: true, value: { dmReplies: dr } }); }
      case 'dm.open': {
        var duid = String((args && args.userId) || '').trim();
        if (!/^\d+$/.test(duid)) return Promise.resolve({ ok: false, reason: 'a numeric user id is required' });
        return transport.openDM(duid).then(function (dmId) {
          if (!dmId) return { ok: false, reason: 'could not open a DM (the bot must share a server with the user, and the user must allow DMs)' };
          recordDMSession(dmId, duid, (args && args.name) || '');
          if (cfgGet('dmReplies', false)) applyConfigChange();   // start polling the new DM
          var greeting = (args && args.message);
          if (greeting) return transport.sendMessage(dmId, String(greeting)).then(function () { return { ok: true, value: { dmChannelId: dmId, sent: true } }; });
          return { ok: true, value: { dmChannelId: dmId } };
        }, function (e) { return { ok: false, reason: 'openDM failed: ' + (e && e.message) }; });
      }
      case 'dm.list':
        return Promise.resolve({ ok: true, value: { dmReplies: !!cfgGet('dmReplies', false), sessions: dmSessions() } });
      case 'dm.forget': {
        var fch = String((args && args.dmChannelId) || '').trim();
        var s = dmSessions(); if (fch && s[fch]) { delete s[fch]; cfgSet('dmSessions', s); applyConfigChange(); }
        return Promise.resolve({ ok: true, value: { sessions: dmSessions() } });
      }
      case 'config.setPoolSize':
        { var ps = Math.max(0, Math.min(10, parseInt((args && args.size), 10) || 0)); cfgSet('poolSize', ps); return Promise.resolve({ ok: true, value: { poolSize: ps } }); }
      case 'bridge.spawn':
        { if (TAB_ROLE !== 'queen') return Promise.resolve({ ok: false, reason: 'only the queen spawns workers' }); return Promise.resolve(spawnWorker()); }
      case 'bridge.shutdown':
        { if (!tabBridge || TAB_ROLE !== 'queen') return Promise.resolve({ ok: false, reason: 'no bridge / not the queen' }); tabBridge.shutdownWorker(String((args && args.id) || '')); return Promise.resolve({ ok: true, value: { id: (args && args.id) || null } }); }
      case 'diag':
        { var snap = statusSnapshot(); console.log('[chloe] diag', snap); return Promise.resolve({ ok: true, value: snap }); }
      case 'diag.trace':
        return Promise.resolve({ ok: true, value: traceRing.slice() });
      case 'token.prompt':    promptToken(); return Promise.resolve({ ok: true, value: { hasToken: hasToken() } });
      case 'token.validate':  return validate();
      case 'start':           { if (TAB_ROLE === 'worker') return Promise.resolve({ ok: false, reason: 'this tab is a worker \u2014 the engine (and the Discord transport) runs only in the queen tab' }); var es1 = ensureEngines(); if (!es1.length) return Promise.resolve({ ok: false, reason: 'no channel set' }); es1.forEach(function (e) { e.start(); }); cfgSet('autoResume', true); return Promise.resolve({ ok: true, value: statusSnapshot() }); }
      case 'stop':            eachEngine(function (e) { e.stop(); }); cfgSet('autoResume', false); return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'poll.once':       { var e2 = engineFor(args && args.channelId); if (!e2) return Promise.resolve({ ok: false, reason: 'no channel set' }); return e2.pollOnce().then(function (s) { return { ok: true, value: s }; }).catch(function (err) { return { ok: false, reason: err.message }; }); }
      case 'roster.get':      { var e3 = engineFor(args && args.channelId); if (!e3) return Promise.resolve({ ok: true, value: [] }); return e3.getRoster().then(function (r) { return { ok: true, value: r }; }); }
      case 'ring.get':        { var e4 = engineFor(args && args.channelId); if (!e4) return Promise.resolve({ ok: true, value: [] }); return e4.getSpeakerRing().then(function (r) { return { ok: true, value: r }; }); }
      case 'reset':           return resetState(true).then(function () { return { ok: true }; });
      // ---- T3 moderation: trusted (panel) actions + mod-list management ----
      case 'mod.action': {
        var act = String((args && args.action) || '');
        if (act === 'permaban') return Promise.resolve({ ok: false, reason: 'unimplemented (T4; irreversible purge requires a confirm in the trusted surface)' });
        var e5 = engineFor(args && args.channelId); if (!e5) return Promise.resolve({ ok: false, reason: 'no channel set' });
        return e5.applyModAction(act, String((args && args.id) || ''), { durationMs: args && args.durationMs, reason: args && args.reason, byModId: 'panel' });
      }
      case 'mod.listMods': return Promise.resolve({ ok: true, value: cfgGet('modList', []) });
      case 'mod.addMod': {
        var idA = String((args && args.id) || '').trim(); if (!idA) return Promise.resolve({ ok: false, reason: 'no id' });
        var listA = cfgGet('modList', []); if (listA.indexOf(idA) < 0) listA.push(idA); cfgSet('modList', listA); applyConfigChange();
        return Promise.resolve({ ok: true, value: listA });
      }
      case 'mod.removeMod': {
        var idR = String((args && args.id) || '').trim();
        var listR = cfgGet('modList', []).filter(function (x) { return x !== idR; }); cfgSet('modList', listR); applyConfigChange();
        return Promise.resolve({ ok: true, value: listR });
      }
      case 'mod.modlog': {
        var e6 = engineFor(args && args.channelId); if (!e6) return Promise.resolve({ ok: true, value: [] });
        return e6.getModLog().then(function (l) { return { ok: true, value: l }; });
      }
      // T4 irreversible: the authoritative confirm lives HERE, in the trusted surface (top frame).
      // Ban FIRST; only purge if the ban succeeds, so we never leave a purged-but-present stranger (F1).
      case 'mod.permaban': {
        var pid = String((args && args.id) || '').trim();
        var pname = String((args && args.name) || pid);
        var preason = (args && args.reason) || 'Chloe permaban';
        if (!pid) return Promise.resolve({ ok: false, reason: 'no target' });
        var e7 = engineFor(args && args.channelId); if (!e7) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var sure = false;
        try { sure = window.confirm('PERMABAN + PURGE "' + pname + '"?\n\nThis bans them from the Discord server AND permanently deletes everything Chloe remembers about them. This cannot be undone.'); } catch (e) { sure = false; }
        if (!sure) { log('[chloe.T4] permaban of ' + pname + ' cancelled at confirm'); return Promise.resolve({ ok: false, reason: 'cancelled' }); }
        return resolveGuildId(chKeyOf(args)).then(function (gid) {
          if (!gid) return { ok: false, reason: 'could not resolve guild id from channel' };
          log('[chloe.T4] banning ' + pname + ' (' + pid + ') ...');
          return transport.banUser(gid, pid, preason).then(function () {
            log('[chloe.T4] ban ok; purging partition ...');
            return e7.purge(pid, { targetName: pname }).then(function (pr) {
              if (!pr.ok) { log('[chloe.T4] PURGE NOT VERIFIED for ' + pname + ': ' + pr.reason); return { ok: false, reason: pr.reason, value: { banned: true, purged: false, verified: false } }; }
              return e7.appendModLog({ action: 'permaban', targetId: pid, name: pname, byModId: 'panel', reason: preason, at: Date.now() }).then(function () {
                log('[chloe.T4] permaban complete for ' + pname + ' (banned + purge verified)');
                return { ok: true, value: { banned: true, purged: true, verified: true, name: pname } };
              });
            });
          }, function (err) {
            log('[chloe.T4] ban FAILED for ' + pname + ': ' + err.message + ' — partition NOT purged (no purged-but-present)');
            return { ok: false, reason: 'ban failed: ' + err.message + ' (purge aborted; bot likely lacks Ban Members)', value: { banned: false, purged: false } };
          });
        });
      }
      default:                return Promise.resolve({ ok: false, reason: 'unknown command: ' + cmd });
    }
  }
  LINKWIN.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__chloe !== 1) return;
    if (!ORIGIN_OK.test(ev.origin)) { trace('link', 'rejected chloe-shaped message from disallowed origin ' + ev.origin); return; }
    // capture/refresh the control page window so the engine can call its brain
    if (!pageSource) trace('link', 'control page connected from ' + ev.origin);
    pageSource = ev.source; pageOrigin = ev.origin;
    if (d.kind === 'callres') { var cb = callPending.get(d.nonce); if (cb) { callPending.delete(d.nonce); cb(d); } return; }
    if (d.kind !== 'req') return;
    var nonce = d.nonce, source = ev.source, origin = ev.origin;
    Promise.resolve().then(function () { return dispatch(d.cmd, d.args); })
      .then(function (res) { res = res || { ok: false, reason: 'no result' }; res.__chloe = 1; res.kind = 'res'; res.nonce = nonce; try { source.postMessage(res, replyTarget(origin)); } catch (e) {} })
      .catch(function (err) { trace('dispatch', '"' + d.cmd + '" failed: ' + String(err && err.message || err)); try { source.postMessage({ __chloe: 1, kind: 'res', nonce: nonce, ok: false, reason: String(err && err.message || err) }, replyTarget(origin)); } catch (e) {} });
  });

  // ---- D1: tab bridge (queen/worker) ---------------------------------------------------
  // Same-origin BroadcastChannel between userscript instances; GM value-change events as the
  // fallback bus (script-scoped, so it also survives exotic sandboxing). The bus token lives in
  // GM storage — page code on perchance.org cannot read it, so only our tabs can speak.
  function makeBroadcastBus() {
    if (typeof BroadcastChannel === 'undefined') return null;
    try {
      var ch = new BroadcastChannel('chloe_bridge_v1');
      return { post: function (e) { ch.postMessage(e); }, onMessage: function (fn) { ch.onmessage = function (ev) { fn(ev.data); }; } };
    } catch (e) { return null; }
  }
  function makeGmBus() {
    if (typeof GM_addValueChangeListener !== 'function') return null;
    var KEY = NS + 'bus:frame', fn = null;
    GM_addValueChangeListener(KEY, function (name, oldV, newV, remote) { if (remote && newV && newV.env && fn) fn(newV.env); });
    return { post: function (e) { GM_setValue(KEY, { n: Date.now() + Math.random(), env: e }); }, onMessage: function (f) { fn = f; } };
  }
  var busToken = GM_getValue(NS + 'bus:token', null);
  if (!busToken) { busToken = Math.random().toString(36).slice(2) + Date.now().toString(36); GM_setValue(NS + 'bus:token', busToken); }
  var tabBus = makeBroadcastBus() || makeGmBus();
  var tabBridge = null;
  // D6: the queen lease — the single source of truth for "who is queen" during failover.
  var queenLease = {
    get: function () { var v = GM_getValue(NS + 'queen:lease', null); if (v == null) return Promise.resolve(null); try { return Promise.resolve(JSON.parse(v)); } catch (e) { return Promise.resolve(null); } },
    set: function (v) { GM_setValue(NS + 'queen:lease', JSON.stringify(v)); return Promise.resolve(true); }
  };
  if (tabBus && typeof ChloeTabBridge !== 'undefined') {
    tabBridge = ChloeTabBridge.createTabBridge({
      role: TAB_ROLE, token: busToken, bus: tabBus,
      lease: queenLease,
      queenDeadAfterMs: cfgGet('queenDeadAfterMs', 90000),
      poolTarget: function () { return cfgGet('poolSize', 0) | 0; },   // D7: 0 = manual-only (default)
      doSpawn: function () { var r = spawnWorker(); return !!(r && r.ok); },
      spawnBackoffMs: cfgGet('spawnBackoffMs', 20000),
      log: function (m) { trace('bridge', m); },
      onWorkerJoin: function (id) { trace('bridge', 'worker joined: ' + id); },
      onWorkerLost: function (id, why) { trace('bridge', 'worker lost: ' + id + ' (' + why + ')'); },
      onShutdown: function () { try { window.close(); } catch (e) { trace('bridge', 'self-close blocked'); } },
      // D6: this tab won the election after the queen tab died.
      onPromote: function () {
        TAB_ROLE = 'queen';
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
        trace('bridge', 'PROMOTED to queen' + (cfgGet('autoResume', false) ? ' \u2014 resuming the engine(s)' : ''));
        console.log('[chloe-bridge] this tab was promoted to QUEEN (the previous queen tab went silent).');
        if (cfgGet('autoResume', false)) { try { ensureEngines().forEach(function (e) { e.start(); }); } catch (e) { trace('bridge', 'auto-resume failed: ' + (e && e.message)); } }
      },
      // D6: a lease conflict said another tab is queen — stand down completely.
      onDemote: function () {
        TAB_ROLE = 'worker';
        eachEngine(function (e) { e.stop(); });
        try { if (location.hash.indexOf('chloe-worker') < 0) location.hash = 'chloe-worker'; } catch (e) {}
        trace('bridge', 'demoted to worker (another queen holds the lease); engines stopped');
      }
    });
    // Every tab registers job handlers: a worker serves them now; a queen may be demoted later
    // (sleep/wake revival) and must be able to serve them then.
    tabBridge.onJob('echo', function (args) { return Promise.resolve(args == null ? null : args); });
    tabBridge.onJob('brain', function (p) {
      p = p || {};
      return callPage(String(p.kind || 'respond'), p.args || {}, p.timeoutMs || 40000);
    });
    tabBridge.start();
    setInterval(function () { tabBridge.tick(); }, 5000);   // host-driven time; the queen tab is the foreground tab
  } else {
    trace('bridge', 'no bus available (BroadcastChannel + GM listener both missing) \u2014 single-tab mode');
  }
  function spawnWorker() {
    var url = location.href.split('#')[0] + '#chloe-worker';
    try { GM_openInTab(url, { active: false, insert: true }); return { ok: true, value: { url: url } }; }
    catch (e) {
      try { window.open(url, '_blank'); return { ok: true, value: { url: url, via: 'window.open' } }; }
      catch (e2) { return { ok: false, reason: 'could not open a tab (popup blocked?)' }; }
    }
  }

  // ---- menu (fallback / token entry; token must be set in the trusted surface) --------
  function promptToken() {
    var t = prompt('Paste the BOT token (Developer Portal > Bot). Stored in this browser only.');
    if (t == null) return; t = t.trim(); cfgSet('token', t);
    var s = tokenShape(t); console.log('[chloe] token saved — shape:', s);
    if (s.placeholder || s.parts !== 3) console.log('[chloe] warning: does not look like a bot token (expect ~70+ chars, 3 dot-parts).');
  }
  function resetState(silent) {
    if (!silent && !confirm('Reset state (cursor, roster, ring) for ALL channels? Token is NOT touched.')) return Promise.resolve();
    var chain = Promise.resolve();
    channelList().forEach(function (ch) {
      var pfx = prefixFor(ch), st = makeStore(pfx);
      chain = chain.then(function () {
        return st.listIndex().then(function (ids) {
          (ids || []).forEach(function (id) { GM_deleteValue(NS + pfx + 'u:' + id); });
          ['cursor:' + ch, 'roster:index', 'speaker:ring:' + ch, 'rhythm:' + ch, 'modlog', 'backfill:' + ch].forEach(function (k) { GM_deleteValue(NS + pfx + k); });
          GM_deleteValue(NS + 'cfg:backfillDone:' + ch);
        });
      });
    });
    return chain.then(function () { eachEngine(function (e) { e.stop(); }); engines = {}; lastPoll = null; console.log('[chloe] state reset for all channels.'); });
  }
  GM_registerMenuCommand('Set bot token', promptToken);
  GM_registerMenuCommand('Reset T0 state (keeps token)', function () { resetState(false); });

  console.log('[chloe-bridge ' + VERSION + '] loaded as ' + TAB_ROLE + '. token set:', hasToken(),
    '| channel set:', !!cfgGet('channelId', ''), '\n  Open your Chloe control generator on this same perchance.org tab to drive it.');
})();
