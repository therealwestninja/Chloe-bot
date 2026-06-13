// ==UserScript==
// @name         Chloe bridge (Discord <- Perchance)
// @namespace    therealwestninja
// @version      0.87.0
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
// @connect      translate.googleapis.com
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
  // A Discord snowflake encodes its own creation time: (id >> 22) + the Discord epoch. So any message
  // id is an authoritative UTC clock reading from Discord's servers — usable to ground the bot's sense
  // of time and as a fallback when no device clock is being pushed. Returns ms since the Unix epoch.
  var DISCORD_EPOCH = 1420070400000;
  function snowflakeTime(id) {
    try { return Number(BigInt(id) >> 22n) + DISCORD_EPOCH; } catch (e) { return null; }
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
      // Pace core (DESIGN-pace.md): one Jacobson rhythm estimator drives debounce, polling, quiet
      // detection, and an AI-cadence floor. Every consumer falls back to its fixed constant when
      // pace is off or too few samples. NO new AI calls.
      adaptivePace: true,
      paceMinSamples: 5,            // need this many gap observations before rhythm drives timing
      paceGapBeta: 0.25,           // deviation EWMA weight (mirrors the brain meter)
      paceDebounceWgap: 0.5,       // debounce ≈ avgGap*Wgap + gapVar*Wdev ...
      paceDebounceWdev: 1.0,
      debounceFloorMs: 800,        // ... clamped: never interrupt-fast (the ceiling is debounceMs itself, see currentDebounce)
      pollAdditiveStepMs: 4000,    // AIMD additive increase per silent poll (default = floor)
      pollBusyCeilMs: 12000,       // busy room: relax polling only PARTWAY to here (passive ingest, still mention-responsive) — not the full pollCeilMs
      paceQuietZ: 3,               // silence counts as "quiet" at this many deviations past typical
      paceMinAIIntervalMs: 90000,  // a background AI pass won't re-run faster than this wall-clock floor (anti cost-multiplier)
      // ---- T1 reply path (all optional; absent => pure T0 read-only) ----
      respond: null,          // async (context) -> { ok, value:text }   (the brain; runs in the generator page)
      send: null,             // async (channelId, text) -> any           (POST to Discord; runs in the userscript)
      addressMode: 'both',    // 'mention' | 'name' | 'both' | 'always' (DM)
      cooldownMs: 8000,       // per-AUTHOR reply cooldown (don't spam the same person)
      globalCooldownMs: 2500, // min gap between ANY two of her sends (lets different people be answered promptly)
      debounceMs: 2500,       // wait for a lull before replying (don't reply mid-burst)
      contextLines: 12,       // recent channel lines handed to the brain (hard upper bound)
      conversationMemory: true,   // give her a TWO-SIDED, legible transcript: include her OWN recent messages (so she sees the back-and-forth she's part of) and resolve <@id>/<#id>/<@&id> refs to readable @names / #channels in what she reads, instead of dropping her turns and stripping every mention. Correctness; off == legacy one-sided view.
      ownLinesMax: 12,        // cap on her own recent messages kept per channel for the transcript
      requestTokenBudget: 5000,// TOTAL tokens per request to the backend — must cover EVERYTHING:
                              // persona + instructions + intention + anti-repeat list + addressed
                              // message + the transcript. The transcript gets whatever's left after
                              // the rest is measured/reserved.
      promptOverheadTokens: 320,// fixed reserve for the page's persona block + instruction scaffolding
                              // (measured: persona ~95 + respond/guidance scaffolding ~200, with margin)
      minTranscriptTokens: 200,// never starve the transcript below this, even if other parts are large
      singleParagraph: false, // mod opt-in: cap her replies to one paragraph (off = she writes as long as fits)
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
      // Image memory + natural-language iteration (DESIGN: "the bot knows what it generated, and you
      // can ask for changes in plain language"). When imageMemory is on, each delivered image is
      // recorded on the user's partition (prompt, resolution, when), capped to a small ring, so the
      // bot can both reference what it drew and resolve follow-ups like "make it bigger" / "another"
      // / "same but at night" against the LAST image. Editing rebuilds the PROMPT and regenerates —
      // there is no img2img/seed lock on this backend, so an edit yields a fresh composition, not a
      // pixel-level tweak (the ack phrasing reflects this honestly).
      imageMemory: false,            // opt-in: record + surface what she generated; enables NL edits
      imageMemoryRing: 6,            // how many recent generations to keep per user
      imageEditWindowMs: 600000,     // after an image, a bare edit phrase targets it for this long (10m)
      imageEnhanceOffer: false,      // opt-in: after delivering, offer "want me to refine it?" once
      editPrompt: null,              // OPTIONAL async ({ prev, request }) -> { ok, value:newPrompt } AI hook;
                                     //   when absent, a deterministic rewrite (resolution/detail/add/style) is used
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
      antiRepeatWindow: 5,    // G1: how many of her own recent replies to show the brain to avoid self-repetition
      botLoopGrace: 2,        // bot-loop damper: consecutive bot turns answered at full chance before decay kicks in
      botLoopFloor: 0.05,     // minimum reply chance once decaying (she keeps watching, rarely speaks)
      botLoopHardStop: 12,    // consecutive bot turns after which she goes fully silent until a human speaks (0 = never)
      intentTtlMs: 1800000,   // a standing intention fades after this long without being reaffirmed (default 30m)
      intentMaxLen: 120,      // a self-set intention is capped to this many chars
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
      reminderMaxPerUser: 5,     // how many pending reminders one person may hold
      reminderMaxTotal: 50,      // global pending-reminder cap per channel
      reminderTextMax: 280,      // reminder text length cap
      afkNoticeCooldownMs: 300000,// don't repeat an "X is away" heads-up for the same person within 5m
      highlightMax: 50,          // how many highlights a channel keeps (oldest dropped past this)
      highlightContextCount: 3,  // how many recent highlights ride in the response context
      highlightTextMax: 300,     // per-highlight stored text length cap
      // --- reaction significance (size-relative) ---
      reactionTracking: true,    // watch emoji reactions on messages and tally / score them
      serverMemberCount: 0,      // members in this server (0 = unknown -> floor threshold only). Set by
                                 // the userscript from the guild, or configured manually.
      reactionMinUsers: 2,       // a reaction needs at least this many distinct users to count at all
      reactionFraction: 0.01,    // significance threshold scales as this fraction of the member count,
                                 // so 1-2 reactions matter in a 100-person server but are noise in a 5000-person one
      reactionAutoHighlight: true,// a message whose top reaction crosses the significance line auto-highlights
      reactionTallyMax: 40,      // how many distinct emoji the channel tally keeps
      reactionSweepEveryPolls: 6, // re-scan a recent window every Nth poll to catch reactions added late
                                  // (activity-aware: ALSO sweeps the poll right after one that ingested
                                  // messages — reactions cluster seconds after fresh messages, so summons
                                  // and trust land in ~1 poll in active rooms; quiet rooms stay cheap)
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
      // Lull filler (Neuro-sama "PATIENCE" pattern, recalibrated for Discord): a small Discord
      // community moves FAR slower than a Twitch stream — a 90-second gap is normal, not a lull. So
      // the thresholds are on the order of DAYS, not seconds. She breaks a silence only when a room
      // that WAS active has been quiet for ~a day, and was active within the past week. Off by default.
      lullFiller: false,             // proactively break a silence after a recently-active room goes quiet
      lullPatienceMs: 86400000,      // ~1 day of silence before she fills it (Discord pace, not Twitch)
      lullActiveWithinMs: 604800000, // only if the room was active within the past week (don't wake a dead channel)
      lullMinGapMs: 86400000,        // at most one lull filler per day
      // Favorite-user check-ins: if a user she's interacted with a lot hasn't been seen in DAYS, she
      // may post a warm "haven't seen you in a while" — @mentioning them only if pings are enabled
      // (the output gate decides). Discord pace: absence is measured in days. Off by default.
      checkins: false,               // proactively check in on favorite users who've been absent
      checkinMinInteractions: 8,     // interaction count that makes someone a "favorite" worth missing
      checkinAbsenceMs: 259200000,   // a favorite must be absent ~3 days before a check-in
      checkinPerUserGapMs: 1209600000,// don't check in on the same person more than once per ~2 weeks
      checkinGapMs: 86400000,        // at most one check-in (any user) per day
      // G5 time awareness: she can sense the time of day, the day of week, and how long the room has
      // been quiet, so her tone fits the moment (a late-night hush, a weekend lull) rather than being
      // timeless. Needs the community's UTC offset to be right; off by default.
      timeAware: false,              // weave a light sense of time-of-day / day / quiet-duration into context
      timezoneOffsetMins: 0,         // the community's offset from UTC in minutes (e.g. -480 for US Pacific)
      // G6 mood: a light, front-end read of the room's tenor from pace + cheap lexical signals
      // (laughter, exclamation, emoji, caps). Two safe dimensions only — energy (quiet..lively) and
      // playfulness (subdued..joking). Deliberately NOT trying to detect anger/conflict (error-prone,
      // and misreading a serious moment is worse than no read). Rides into context as soft tone
      // guidance. Off by default.
      moodAware: false,              // sense and gently match the room's energy / playfulness
      moodDecay: 0.7,                // how much prior mood carries over each update (higher = steadier)
      // Rolling channel summary (SillyTavern-style recursive summary): every N polls, fold the recent
      // transcript into a running ≤W-word summary of the channel's arc, fed back in each time. Rides
      // into context so she keeps a sense of the story so far past the raw transcript window. Off by default.
      channelSummary: false,
      channelSummaryEveryPolls: 30,
      channelSummaryWords: 60,
      // Reflection (Generative-Agents pattern): when enough IMPORTANCE has accumulated from newly
      // learned facts about a person, make one synthesis pass turning their raw facts into 1-2 durable
      // higher-level insights ("what I've come to understand about them"). Insights live on the
      // partition (archive/restore free) and lead the person-summary above raw facts. Off by default.
      reflection: false,
      reflectionImportanceThreshold: 20,   // summed importance of new facts that triggers a reflection
      reflectionEveryPolls: 16,            // cadence gate (it's an AI call)
      insightsPerUser: 3,                  // durable insights kept per person (oldest dropped)
      // Episodic memory (DESIGN §7a): experiences as events. A gated pass turns recent activity into
      // short episode records ("what happened", not message-by-message); recall is keyword-overlap
      // relevance × importance × recency, riding into context only when something actually matches.
      episodicMemory: false,
      episodesPerChannel: 40,              // ring cap per channel (oldest dropped)
      episodeEveryPolls: 24,               // extraction cadence (it's an AI call); (every-1) form, never poll 1
      episodeRecallCount: 2,               // max episodes recalled into one reply
      episodeRecencyHalfLifeMs: 604800000, // recall decay half-life (7d): old episodes fade, never vanish
      // Event-graph (DESIGN-eventgraph.md): link episodes by shared people/topics/time at EXTRACTION
      // (no LLM), so recall can walk ONE hop ("…and connected to that…"). Default ON.
      episodeGraph: true,
      episodeLinkHalfLifeMs: 21600000,     // 6h: events in one session associate; weeks apart don't (unless people/topics carry them)
      episodeLinkFloor: 0.15,              // below this weight, episodes stay unlinked (sparse graph)
      episodeLinkWp: 0.5,                  // weight: shared participants (strongest associative signal)
      episodeLinkWt: 0.3,                  // weight: shared topics
      episodeLinkWd: 0.2,                  // weight: temporal adjacency
      // Relationship trust (DESIGN §7b): a 0-100 per-person scalar EARNED through positive signals
      // only — never penalized, daily-capped so it can't be farmed, decaying with long absence.
      // Tone + a reply-priority tiebreak ONLY: trust never loosens moderation, gates, or policy.
      relationshipTrust: false,
      trustReplyGain: 1,            // her completed reply to someone
      trustReactionGain: 2,         // their positive reaction on HER message
      trustDailyCap: 5,             // max trust earnable per person per day
      trustDecayFactor: 0.85,       // applied on the same long-absence event as familiarity decay
      trustPositiveEmoji: ['\u2764\ufe0f', '\ud83d\udc4d', '\ud83d\ude02', '\ud83c\udf89', '\ud83d\ude0a'],
      trustPriorityTier: 60,        // at/above this, the new-user-sized (+1) priority tiebreak applies
      // Own affect (DESIGN §7d): a small internal state vector — HER feel, distinct from reading the
      // room. Front-end only (no AI calls). Flavor for her voice, NEVER a lever on users: whitelist
      // phrasing, a hard confidence floor (no spirals), and silence when she's near neutral.
      ownAffect: false,
      // Working memory (DESIGN-working-memory.md): a volatile per-channel workspace — current topic,
      // who's here, the active goal, her recent decisions, her mood. Decays on read like affect.
      // Mostly synthesized from signals she already has; only `topic` can cost a (reused) call.
      workingMemory: false,
      semanticInjections: [],   // arbitrary system/operator facts surfaced into context (DESIGN-semantic-inject.md): [{id,text,priority,ttlMs,at}]
      cleanOutput: true,        // scrub model-mechanics noise from replies (DESIGN-clean.md): role-bleed, dangling tail, unbalanced fences
      globalStore: null,        // optional: a store at root prefix for keys shared across ALL channels (e.g. blocklist)
      isDM: false,              // true for a DM engine: it MERGES public facts (from globalStore) into context
                                //   read-only, but writes only to its own bucket — DM content never crosses back to public.
      deviceClock: null,        // {time, date, tz, at} pushed by the page for instant !chloe time/date (no AI)
      deviceClockStaleMs: 180000,   // a pushed clock older than this is considered stale (panel closed)
      // Idle deliberation (DESIGN-deliberation.md): a ReAct map-reduce reasoning loop. When genuinely
      // idle and curious, she decomposes a thought into atomic sub-questions, answers them (parallel
      // across worker tabs when a pool exists), and recomposes an insight/goal. NEVER sends. Curiosity-
      // gated (self-limiting: a resolved deliberation lowers curiosity). Opt-in (spends real calls).
      idleDeliberation: false,
      deferredIntents: false,    // self-scheduled future cognition (DESIGN-self-intents): a concluded deliberation can schedule a later REVISIT of its subject — an internal action, never a message. Needs idleDeliberation.
      selfIntentMax: 8,          // cap on queued self-intents per channel
      selfIntentRevisitMs: 21600000,   // 6h: how far out a revisit is scheduled when she finds a topic worth coming back to
      attentionManager: false,   // utility-scored AI-pass selection (DESIGN-attention.md); off = today's fixed ladder
      selfKnowledge: false,      // ground her in her own basics (name, prefix, summon) from config (DESIGN-selfknow.md)
      deliberateCuriosityFloor: 0.62,   // only think when curiosity is meaningfully above neutral
      deliberateMinGapMs: 600000,       // hard floor between deliberations (10m) so bursts can't chain
      deliberateMaxSubQuestions: 4,     // cap the fan-out (decompose returns up to this many)
      deliberateCuriosityDrop: 0.18,    // a completed deliberation scratches the itch (lowers curiosity)
      workTopicTtlMs: 1200000,      // 20m of inactivity -> the "current topic" goes null (not stale)
      workDecisionTtlMs: 1800000,   // a recorded decision ages out after 30m
      workDecisionsMax: 5,          // bounded ring of recent notable actions
      workParticipantsMax: 5,
      affectDecayPerHour: 0.8,      // each value relaxes toward neutral 0.5 by this factor per hour
      affectConfidenceFloor: 0.3,   // she never drops below this — quieter, not despondent
      affectGain: 0.08,             // size of one event nudge
      affectEngageWindowMs: 600000, // a user message within 10m of her reply = engagement (confidence up)
      affectIgnoreAfterMs: 1800000, // no one says anything for 30m after her reply = ignored (confidence down)
      // Procedural memory (DESIGN §7c): operator-defined reaction→mode rules. A configured emoji
      // from a MODERATOR (modOnly is fixed in v1 — reactions are unauthenticated input) switches her
      // into a timed behavior mode. Persona-note sanitation; tone/behavior guidance ONLY — a mode can
      // never alter moderation, gates, or content rules.
      proceduralModes: false,
      procRules: [],                 // [{ emoji: '\ud83d\udd27', mode: 'switch to technical mode…', durationMs: 3600000 }]
      procMaxDurationMs: 86400000,  // hard cap: no mode outlives a day
      // Engine run-lock (FAILOVER-ANALYSIS.md): the hard close for the sleep/wake two-queen polling
      // window. Before each poll the engine must hold a short-TTL lock in the SHARED per-channel
      // store; a non-holder skips the poll entirely. ON by default — this is a correctness lock,
      // not a behavior feature. runLock:false is a debugging escape hatch only.
      runLock: true,
      runLockTtlMs: 45000,          // < queenDeadAfterMs (90s): a frozen holder is stale before anyone can promote;
                                    // > any healthy poll cadence: a live queen never loses its own lock between polls
      // Gap A (FAILOVER-ANALYSIS.md): resume a TEXT reply a dead predecessor lost mid-generation.
      // Conservative by design: age-capped, and gated on verification (any bot message after the
      // target = assume answered) — trades duplicates for occasional non-resumption.
      replyResume: true,
      replyResumeMaxAgeMs: 600000,  // older than 10 min: a stale answer is worse than silence
      // Goal objects (DESIGN-goals.md): prospective memory — durable, CROSS-CHANNEL goals promoted
      // from what reflection already learns. Recall is owner-scoped; no new LLM call on any path.
      goalObjects: true,
      goalsMax: 40,                 // bounded list; closed goals evicted oldest-first
      goalTextMax: 140,
      goalStaleMs: 2592000000,      // 30d untouched -> auto-dropped (goals fade if the world moves on)
      characterMemoryMax: 24,       // cap on respooled character self-memories
      // Idle consolidation (DESIGN-consolidation.md): the “sleep” pass — during genuine idle, tidy
      // memory. Structural dedup is pure local compute (every idle pass); semantic merge/contradiction
      // is one gated LLM pass (one user). Never sends. Default ON.
      idleConsolidation: true,
      consolidateIdleMs: 1800000,   // channel quiet this long = idle enough to tidy (30m; lighter than the day-scale lull filler)
      consolidateEveryPolls: 50,    // don't sweep every poll in a perpetually-quiet channel
      consolidateSliceSize: 5,      // structural sweep: partitions cleaned per pass (spreads a big roster)
      consolidateMinFacts: 6,       // semantic pass skips anyone with fewer facts than this
      episodeDropImportanceFloor: 3, // stale + low-importance episodes get hard-dropped from the ring
      // Round-trip awareness (DESIGN-roundtrip.md): when a generation COMPLETES, the next queued job
      // fires via cfg.defer(fn, ms) (host setTimeout) instead of waiting for the next poll tick.
      // Purely additive: with no defer hook, behavior is exactly the old poll-bound dispatch.
      typingRefreshMs: 8000,        // Discord's typing indicator lasts ~10s; refresh while generating
      // Reaction vocabulary (README §Reactions): semantically truthful indicators, all under the
      // ackReactions toggle. 🗣️ = generating your text reply; 🖼️ = painting; 🔍 = looking
      // something up; ⏳ = saw you, throttled (cooldown/budget) — auto-clears; 🔒 = mods-only mode.
      // DELIBERATE: no indicator for quiet moderation (ignore/softban/block) — reacting would
      // announce it. Throttle indicators cover only benign, temporary reasons.
      ackThrottleEmoji: '\u23f3',
      ackLockdownEmoji: '\ud83d\udd12',
      ackSearchEmoji: '\ud83d\udd0d',
      ackClearMs: 30000,            // why-not indicators clear themselves after this long
      // Reply references: her text replies attach to the message they answer (Discord's native
      // reply threading), with the reply-ping suppressed. Pure clarity; replyReference:false to disable.
      replyReference: true,
      // Reaction summon (README §Reactions): monkey-see-monkey-do — react to YOUR OWN message with
      // one of her own indicators and she treats it as an explicit address. Mods can summon her onto
      // anyone's message. All normal gates still apply (lockdown, moderation, cooldowns, budget).
      reactionSummon: false,
      summonEmoji: ['\ud83d\udde3\ufe0f', '\u2757', '\ud83e\udd16'],   // her speak indicator, ! and the robot — deliberately NOT ❤️ (hearts are warmth, and casual)
      summonMaxAgeMs: 900000,       // messages older than 15m can't be summoned — a stale summon found on
                                    // cold boot (reacted while she was offline) must NOT fire (the
                                    // v0.46.3 “cold start treats history as live” bug class)
      // Reaction polls: !chloe poll <question> | <a> | <b> ... — she posts the ballot, seeds the
      // number reactions, and tallies counts on close (or auto-close). One active poll per channel.
      pollMaxAgeMs: 86400000,       // polls auto-close after a day if nobody closes them
      checkinMaxAttempts: 2,         // give up after this many ignored check-ins (~28d at a 14d gap)
      // Data tiering: cold records leave the hot store so the main roster stays fast. A user who has
      // ignored every check-in, or who's been absent a long time, is moved to a secondary "historical
      // friends" archive (separate per-user keys, never loaded on the hot path). They're restored
      // automatically the moment they speak again. Favorite-aware: the more she's interacted with
      // someone, the longer they're kept in the fast store before archival.
      archiveStale: true,            // move long-cold users out of the hot roster into the archive
      archiveAbsenceMs: 5184000000,  // base absence before a user is archived (~60 days)
      archiveFavoriteBonusMs: 2592000000,// each "favorite tier" of interactions adds this much patience (~30d)
      archiveFavoriteTier: 8,        // interactions per favorite tier (so an 8-interaction user waits +30d)
      archiveMaxKept: 2000,          // cap on archived users (oldest pruned beyond this)
      // --- F1 fact memory (learn people over time) ---
      // She can remember a few durable, voluntarily-shared facts about regulars ("is learning rust",
      // "has a cat named Pixel") so she feels like she knows them. Conservative and controllable:
      // extraction refuses sensitive categories, users can see/forget what's stored, off by default.
      factMemory: false,             // observe and remember durable facts about people
      factsPerUser: 6,               // how many facts she keeps per person (oldest dropped past this)
      factMinInteractions: 4,        // only start remembering people she's actually engaged with
      factProposeGapMs: 86400000,    // at most one extraction pass per user per day (it's an AI call)
      factProposeMinNew: 4,          // ...and only after this many new messages from them since last pass
      factTextMax: 140,              // per-fact length cap
      factContextCount: 4,           // how many facts ride into her context for an active person
      factImportanceDefault: 5,      // neutral importance for facts with none (old data / bare strings)
      factRecencyWeight: 2,          // how much recency tilts the importance-ranked fact selection
      factEveryPolls: 12,            // run the silent extraction pass at most every Nth poll
      contradictionAware: false,     // flag when a NEW fact contradicts a HELD one (DESIGN-contradiction): keep both, record it, and (gently, AI-discretionary) let her clarify. Needs factMemory.
      contradictionImportanceFloor: 5,   // only flag conflicts where the new fact is at least this important (don't fuss over trivia)
      contradictionFreshMs: 7200000,     // 2h: how long after a conflict appears she'll consider gently raising it
      contradictionTtlMs: 259200000,     // 3d: an unresolved recorded conflict is cleared after this (tidied on the idle sweep)
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
      // On a cold start / after Reset State the cursor is empty, so the first poll pulls a chunk of
      // recent history. Without a clamp, EVERY image request in that backlog fires at once. So on the
      // startup batch, image generation is limited to the few most-recent user messages; normal image
      // handling resumes on every poll after.
      startupImageMax: 5,            // most-recent user messages eligible for image gen on the startup batch
      startupBacklogThreshold: 8,    // a cold-start first poll bigger than this is treated as a history backlog (observe-only)
      maintenanceEveryPolls: 10      // run the quiet-sweep (active->quiet) every Nth poll, not every poll
    }, deps.config || {});
    // globalStore is a top-level dep (the root-prefix store shared across channels). Bind it onto cfg
    // so the helpers that look for it — blockStore() (global blocklist) and the DM public-profile
    // merge — actually find it. Without this it stayed null and blockStore()/merge silently fell back
    // to the per-channel store, so a ban or a public fact never reached secondary/DM engines.
    if (deps.globalStore) cfg.globalStore = deps.globalStore;

    var CURSOR_KEY = 'cursor:' + cfg.channelId;
    var INDEX_KEY = 'roster:index';
    // GDPR / ethereal mode. A user who asks to be forgotten becomes invisible to memory in THIS
    // bucket: no partition, no facts, no roster/summary/episode contribution, no image tracking —
    // but the bot can still reply to them in the moment. Per-context by design: the public bucket
    // (globalStore for any public channel) and each DM bucket hold their own flag, so a user can be
    // ethereal in public while still on the record in a DM, or vice versa. The forget-floor is a
    // per-user timestamp that survives `remember me`, so re-enabling memory never lets backfill or a
    // cold start reach back and re-learn the history they erased.
    var ETHEREAL_KEY = 'ethereal';        // { ids: { id: { at, name } } }  (in etherealStore())
    var FORGETFLOOR_KEY = 'forgetfloor';  // { id: ts }                     (in etherealStore())
    var GOALS_KEY = 'goals';   // goals are USER data: shared across PUBLIC channels, but kept LOCAL to each DM
    var CHARMEM_KEY = 'charmem';   // CROSS-CHANNEL (via globalStore): the installed character's own respooled memories (background context)
    // charmem is the BOT's own character background (operator-authored, not user data), so it lives in
    // globalStore and is identical everywhere. Goals, by contrast, are the user's — so they go through
    // goalStore(): shared across public channels (globalStore) but isolated to the local bucket inside a
    // DM, so a goal set in a DM can NEVER surface in a public channel or in another user's DM. (Same
    // per-context rule as etherealStore.)
    function crossStore() { return cfg.globalStore || store; }
    function goalStore() { return cfg.isDM ? store : (cfg.globalStore || store); }
    var CONSOLIDATE_KEY = 'consolidate:' + cfg.channelId;   // { lastSweepAt, sliceCursor } for the idle “sleep” pass
    var RING_KEY = 'speaker:ring:' + cfg.channelId;
    var RHYTHM_KEY = 'rhythm:' + cfg.channelId;
    var MOOD_KEY = 'mood:' + cfg.channelId;   // G6: decayed room-tenor read (energy + playfulness)
    var CHANSUM_KEY = 'chansum:' + cfg.channelId;   // rolling recursive summary of the channel's arc
    var EPI_KEY = 'epi:' + cfg.channelId;           // episodic memory ring (experiences as events)
    var AFFECT_KEY = 'affect:' + cfg.channelId;     // her own internal state {curiosity, confidence, warmth}
    var WORK_KEY = 'work:' + cfg.channelId;         // volatile cognitive workspace {topic, participants, goal, recentDecisions, mood, at}
    var DELIB_KEY = 'delib:' + cfg.channelId;       // { lastAt } — min-gap floor between deliberations
    var PROC_KEY = 'procmode:' + cfg.channelId;     // active procedural mode { mode, until, by, emoji }
    var POLL_KEY = 'poll:' + cfg.channelId;         // active reaction poll { messageId, question, options, endsAt }
    var INTENT_KEY = 'intent:' + cfg.channelId;   // Sweetie set_goal pattern: a standing intention that
    // survives across polls and rides in every response context, so she holds a thread of purpose
    // ("getting to know the new folks", "keeping it light after that argument") rather than reacting
    // to each message in isolation. The brain may set it; it decays if not reaffirmed.
    var REMIND_KEY = 'reminders:' + cfg.channelId;   // poll-driven scheduled reminders (front-end only,
    // no AI call). Checked each poll rather than via setTimeout, because background tabs throttle
    // timers to ~1/min — a poll-driven check fires reliably on the first poll after the due time.
    var AFK_KEY = 'afk:' + cfg.channelId;   // user-set away state (front-end only, no AI call): set on
    // "!chloe afk", auto-cleared when the person speaks again, surfaced when others ping them.
    var HILITE_KEY = 'highlights:' + cfg.channelId;   // pinned notable messages (front-end only): saved
    // for recall via "!chloe highlights", and a few recent ones ride in context so she can reference
    // the channel's memorable moments — a step toward memory without the full fact-extraction build.
    var REACTTALLY_KEY = 'reacttally:' + cfg.channelId;   // running per-emoji tally of significant reactions
    var BACKFILL_KEY = 'backfill:' + cfg.channelId;
    var BEATS_KEY = 'beats:lastrun:' + cfg.channelId;   // #12: beatId -> last-fired ts (+ __lastAny)
    var OWNLINE_KEY = 'ownlines:' + cfg.channelId;   // her OWN recent messages (text + ts), captured at ingest from
    // the messages Discord echoes back, so the transcript she reads is two-sided (DESIGN-conversation-memory).
    // Bounded by ownLinesMax. Per-channel; in a DM it lives in the isolated DM bucket.
    var SELFINTENT_KEY = 'selfintents:' + cfg.channelId;   // deferred self-intents: a persistent queue of future
    // INTERNAL actions she scheduled for herself (currently: 'revisit' a deliberation subject). Poll-driven
    // like reminders, but a fired intent never sends — it drives her own later cognition. Per-channel; in a
    // DM it lives in the (isolated) DM bucket. Bounded by selfIntentMax.
    var LULL_KEY = 'lull:' + cfg.channelId;   // last time she filled a silence (lull filler throttle)
    var CHECKIN_KEY = 'checkins:' + cfg.channelId;   // { __last: ts, byUser: { id: {at,count,seenAt} } } — check-in throttle + attempt cap
    var ARCH_INDEX_KEY = 'arch:index:' + cfg.channelId;   // index of archived ("historical friend") user ids
    function archKey(id) { return 'arch:' + cfg.channelId + ':u:' + id; }   // per-user cold storage (never on the hot path)

    var running = false;
    var timer = null;

    // T1 reply state: a per-author queue (latest message per author) so one chatty user can't
    // starve replies to everyone else. A lost queue on reload is acceptable.
    var reply = { queue: {}, replying: false };
    var lastReplyAt = {};                // per-author: when she last replied to that person
    var lastLineId = null;               // most recent non-bot channel message id (forget-that fallback target)
    var lastPollIngested = false;        // activity-aware sweep: did the previous poll bring messages?
    var recentReplies = [];              // G1 anti-repetition: her own last few replies (in-memory, per channel)
    var consecutiveBotTurns = 0;         // bot-loop damper: human-authored messages reset this to 0
    var afkNoticed = {};                 // per-target throttle so an AFK heads-up doesn't repeat each ping
    var afkNoticedKeys = [];             // insertion order, to bound afkNoticed (prevent a slow leak over a long session)
    var lastSawHumanAt = 0;              // when a human last spoke here (observation, always updated)
    function noteAuthorForLoop(isBot) {
      if (isBot) consecutiveBotTurns++;
      else { consecutiveBotTurns = 0; lastSawHumanAt = clock.now(); }
    }
    // Reply probability decays as a channel becomes bot-only chatter, so two bots don't ping-pong
    // forever. 0..botLoopGrace bot turns: full chance. Beyond that, halve per extra turn, floored.
    // A human message resets consecutiveBotTurns, restoring full responsiveness immediately.
    function botLoopReplyChance() {
      var grace = cfg.botLoopGrace, hardStop = cfg.botLoopHardStop;
      if (consecutiveBotTurns <= grace) return 1;
      if (hardStop > 0 && consecutiveBotTurns >= hardStop) return 0;
      var over = consecutiveBotTurns - grace;
      return Math.max(cfg.botLoopFloor, Math.pow(0.5, over));
    }
    function rememberReply(text) {
      var t = String(text || '').trim();
      if (!t) return;
      recentReplies.push(t);
      var keep = cfg.antiRepeatWindow || 5;
      if (recentReplies.length > keep) recentReplies = recentReplies.slice(-keep);
    }
    // Standing intention: the brain may return `intent` alongside its reply text; we persist it
    // (capped + timestamped) so it rides in the next context until reaffirmed or it ages out.
    function setIntent(text) {
      var t = String(text || '').trim().slice(0, cfg.intentMaxLen);
      if (!t) return Promise.resolve(null);
      return Promise.resolve(store.set(INTENT_KEY, { text: t, at: clock.now() })).then(function () { return t; });
    }
    function getIntent() {
      return Promise.resolve(store.get(INTENT_KEY)).then(function (gi) {
        if (gi && gi.text && (clock.now() - (gi.at || 0) < cfg.intentTtlMs)) return gi;
        return null;
      });
    }
    function clearIntent() { return Promise.resolve(store.del(INTENT_KEY)); }

    // ---- goal objects (prospective memory) -------------------------------------------------
    function loadGoals() {
      return Promise.resolve(goalStore().get(GOALS_KEY)).then(function (g) { return Array.isArray(g) ? g : []; });
    }
    function saveGoals(list) {
      // newest-first cap: keep all OPEN goals, evict oldest CLOSED beyond the cap
      if (list.length > (cfg.goalsMax || 40)) {
        var open = list.filter(function (x) { return x.status === 'open'; });
        var closed = list.filter(function (x) { return x.status !== 'open'; }).sort(function (a, b) { return (b.lastTouchedAt || 0) - (a.lastTouchedAt || 0); });
        list = open.concat(closed).slice(0, cfg.goalsMax || 40);
      }
      return Promise.resolve(goalStore().set(GOALS_KEY, list)).then(function () { return list; });
    }
    function addGoal(text, owner, ownerName, source) {
      var t = String(text || '').trim().slice(0, cfg.goalTextMax || 140);
      if (!t) return Promise.resolve(null);
      return loadGoals().then(function (list) {
        var norm = normFact(t);
        var dup = list.filter(function (x) { return x.status === 'open' && x.owner === (owner || null) && normFact(x.text) === norm; })[0];
        if (dup) { dup.lastTouchedAt = clock.now(); return saveGoals(list).then(function () { return dup; }); }
        var g = { id: 'g' + clock.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
                  text: t, owner: owner || null, ownerName: ownerName || '', channel: cfg.channelId,
                  createdAt: clock.now(), lastTouchedAt: clock.now(), status: 'open', source: source || 'command' };
        list.push(g);
        return saveGoals(list).then(function () { log('[chloe.goal] noted a goal for ' + (ownerName || 'the channel') + ': \u201c' + t + '\u201d'); return g; });
      });
    }
    function closeGoal(id, byId, status) {
      return loadGoals().then(function (list) {
        var g = list.filter(function (x) { return x.id === id; })[0];
        if (!g) return { ok: false, reason: 'no goal with that id' };
        if (g.owner && byId && g.owner !== byId && !isMod(byId)) return { ok: false, reason: 'only the goal\u2019s owner or a mod can close it' };
        g.status = status || 'done'; g.lastTouchedAt = clock.now();
        return saveGoals(list).then(function () { return { ok: true, goal: g }; });
      });
    }
    function goalsForOwner(ownerId) {
      return loadGoals().then(function (list) {
        var now = clock.now(), changed = false;
        list.forEach(function (g) {   // lazy staleness: open goals untouched too long fade to dropped
          if (g.status === 'open' && (now - (g.lastTouchedAt || g.createdAt || 0)) > (cfg.goalStaleMs || 2592000000)) { g.status = 'dropped'; g.lastTouchedAt = now; changed = true; }
        });
        var out = list.filter(function (g) { return g.status === 'open' && g.owner === ownerId; });
        return (changed ? saveGoals(list) : Promise.resolve(list)).then(function () { return out; });
      });
    }
    function dropGoalsFor(id) {
      if (!id) return Promise.resolve(0);
      return loadGoals().then(function (list) {
        var before = list.length;
        var kept = list.filter(function (g) { return g.owner !== id; });
        if (kept.length === before) return 0;
        return saveGoals(kept).then(function () { log('[chloe.goal] erased ' + (before - kept.length) + ' goal(s) for a forgotten user'); return before - kept.length; });
      });
    }

    // ---- character self-memory (respooled from an imported character's chat) ----------------
    // Background context about WHO SHE IS now (the imported character) and their world — not facts
    // about a person. Stored cross-channel, deduped, capped; surfaced as a SELF band injection.
    function seedCharacterMemories(name, mems) {
      var texts = (mems || []).map(function (m) { return String(m && m.text != null ? m.text : m).trim(); }).filter(Boolean);
      if (!texts.length) return Promise.resolve(0);
      return Promise.resolve(crossStore().get(CHARMEM_KEY)).then(function (rec) {
        rec = rec || { name: name, facts: [] };
        rec.name = name;
        var seen = {}; rec.facts.forEach(function (f) { seen[normFact(f)] = true; });
        var added = 0;
        texts.forEach(function (t) { var k = normFact(t); if (k && !seen[k]) { seen[k] = true; rec.facts.push(t.slice(0, 200)); added++; } });
        var cap = (cfg.characterMemoryMax || 24);
        if (rec.facts.length > cap) rec.facts = rec.facts.slice(-cap);
        return crossStore().set(CHARMEM_KEY, rec).then(function () { log('[chloe.character] seeded ' + added + ' memor' + (added === 1 ? 'y' : 'ies') + ' for ' + name); return added; });
      });
    }
    function clearCharacterMemories() { return Promise.resolve(crossStore().del(CHARMEM_KEY)); }

    // ---- reminders (poll-driven, front-end only, no AI call) --------------------------------
    function getReminders() { return Promise.resolve(store.get(REMIND_KEY)).then(function (r) { return Array.isArray(r) ? r : []; }); }
    function scheduleReminder(opts) {
      var minutes = Number(opts && opts.minutes);
      if (!isFinite(minutes) || minutes < 1) return Promise.resolve({ ok: false, reason: 'minutes must be at least 1' });
      if (minutes > (cfg.jobMaxReminderMin || 1440)) return Promise.resolve({ ok: false, reason: 'reminders are capped at ' + (cfg.jobMaxReminderMin || 1440) + ' minutes' });
      var text = String((opts && opts.text) || '').trim().slice(0, cfg.reminderTextMax);
      if (!text) return Promise.resolve({ ok: false, reason: 'a reminder needs some text' });
      return getReminders().then(function (list) {
        if (list.length >= cfg.reminderMaxTotal) return { ok: false, reason: "i'm holding too many reminders right now \u2014 try again later" };
        var mine = list.filter(function (r) { return r.authorId === opts.authorId; });
        if (mine.length >= cfg.reminderMaxPerUser) return { ok: false, reason: "you've already got " + mine.length + ' reminders pending with me \u2014 that\u2019s my limit per person' };
        var fireAt = clock.now() + minutes * 60000;
        var rem = { id: 'r' + clock.now() + '_' + Math.floor(Math.random() * 1e6), authorId: opts.authorId, authorName: opts.authorName || '', text: text, fireAt: fireAt, dm: !!opts.dm, setAt: clock.now() };
        list.push(rem);
        return Promise.resolve(store.set(REMIND_KEY, list)).then(function () { return { ok: true, value: rem }; });
      });
    }
    // ---- deferred self-intents (DESIGN-self-intents) -------------------------------------------
    // The same dueAt-queue shape as reminders, but a fired intent is an INTERNAL action, never a send.
    // Entry: { id, kind, dueAt, subject, mode, createdAt }. Today the only kind is 'revisit' (come back
    // and re-think a deliberation subject later); the dispatch is built so new kinds are a new branch.
    function getSelfIntents() { return Promise.resolve(store.get(SELFINTENT_KEY)).then(function (r) { return Array.isArray(r) ? r : []; }); }
    function scheduleSelfIntent(kind, delayMs, fields) {
      if (!cfg.deferredIntents) return Promise.resolve(null);
      return getSelfIntents().then(function (list) {
        // de-dupe: don't stack multiple pending intents of the same kind+subject
        var subj = fields && fields.subject;
        if (list.some(function (it) { return it.kind === kind && it.subject === subj; })) return null;
        if (list.length >= (cfg.selfIntentMax || 8)) return null;   // bounded; silently drop rather than grow
        var it = { id: 's' + clock.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), kind: kind, dueAt: clock.now() + Math.max(0, delayMs | 0), createdAt: clock.now() };
        if (fields) for (var k in fields) if (fields.hasOwnProperty(k)) it[k] = fields[k];
        list.push(it);
        return Promise.resolve(store.set(SELFINTENT_KEY, list)).then(function () { log('[chloe.intent] scheduled "' + kind + '"' + (subj ? ' re: ' + String(subj).slice(0, 40) : '') + ' in ' + Math.round((delayMs || 0) / 60000) + 'm'); return it; });
      });
    }
    // Peek the earliest DUE intent of a kind (does not remove it).
    function dueSelfIntent(kind) {
      if (!cfg.deferredIntents) return Promise.resolve(null);
      return getSelfIntents().then(function (list) {
        var now = clock.now();
        var due = list.filter(function (it) { return it.kind === kind && it.dueAt <= now; });
        due.sort(function (a, b) { return a.dueAt - b.dueAt; });
        return due[0] || null;
      });
    }
    function consumeSelfIntent(id) {
      return getSelfIntents().then(function (list) {
        var keep = list.filter(function (it) { return it.id !== id; });
        if (keep.length === list.length) return false;
        return Promise.resolve(store.set(SELFINTENT_KEY, keep)).then(function () { return true; });
      });
    }

    function listReminders(authorId) {
      return getReminders().then(function (list) { return authorId ? list.filter(function (r) { return r.authorId === authorId; }) : list; });
    }
    function clearReminders(authorId) {
      return getReminders().then(function (list) {
        var kept = authorId ? list.filter(function (r) { return r.authorId !== authorId; }) : [];
        var removed = list.length - kept.length;
        return Promise.resolve(store.set(REMIND_KEY, kept)).then(function () { return removed; });
      });
    }
    // Called each poll. Fires any reminder whose time has come, delivers it (channel or DM), and
    // removes it. Delivery is a plain send — it doesn't consume the reply budget or judge path,
    // because the person explicitly asked for it at this time; it's a utility, not her "voice".
    function processReminders() {
      if (typeof cfg.send !== 'function') return Promise.resolve(null);
      return getReminders().then(function (list) {
        if (!list.length) return null;
        var now = clock.now(), due = [], keep = [];
        list.forEach(function (r) { (r.fireAt <= now ? due : keep).push(r); });
        if (!due.length) return null;
        return Promise.resolve(store.set(REMIND_KEY, keep)).then(function () {
          var chain = Promise.resolve(), fired = [];
          due.forEach(function (r) {
            chain = chain.then(function () {
              var who = r.authorName || 'you';
              var body = '\u23f0 ' + (r.authorId ? '<@' + r.authorId + '> ' : '') + 'reminder: ' + r.text;
              var target = Promise.resolve(cfg.channelId);
              if (r.dm && typeof cfg.openDM === 'function') target = Promise.resolve(cfg.openDM(r.authorId)).then(function (id) { return id || cfg.channelId; }, function () { return cfg.channelId; });
              return target.then(function (chId) {
                return Promise.resolve(cfg.send(chId, body)).then(function () { fired.push(r.id); log('[chloe.remind] fired for ' + who + (r.dm ? ' (dm)' : '') + ': ' + r.text.slice(0, 40)); }, function () {});
              });
            });
          });
          return chain.then(function () { return { fired: fired.length }; });
        });
      });
    }

    // ---- AFK / away state (front-end only, no AI call) --------------------------------------
    function getAfkMap() { return Promise.resolve(store.get(AFK_KEY)).then(function (a) { return (a && typeof a === 'object') ? a : {}; }); }
    function setAfk(userId, name, reason) {
      return getAfkMap().then(function (map) {
        map[userId] = { name: name || '', reason: String(reason || '').trim().slice(0, 200), since: clock.now() };
        return Promise.resolve(store.set(AFK_KEY, map)).then(function () { return map[userId]; });
      });
    }
    function getAfk(userId) { return getAfkMap().then(function (map) { return map[userId] || null; }); }
    // Clear a user's AFK if set. Returns the prior entry (so the caller can say "welcome back"), or
    // null if they weren't away.
    function clearAfk(userId) {
      return getAfkMap().then(function (map) {
        var prior = map[userId] || null;
        if (!prior) return null;
        delete map[userId];
        return Promise.resolve(store.set(AFK_KEY, map)).then(function () { return prior; });
      });
    }
    function humanGap(ms) {
      var mn = Math.round(ms / 60000);
      if (mn < 1) return 'less than a minute';
      if (mn < 60) return mn + ' minute' + (mn === 1 ? '' : 's');
      var h = Math.round(mn / 60);
      if (h < 24) return h + ' hour' + (h === 1 ? '' : 's');
      var d = Math.round(h / 24); return d + ' day' + (d === 1 ? '' : 's');
    }

    // ---- highlights (front-end only, no AI call) --------------------------------------------
    function getHighlights() { return Promise.resolve(store.get(HILITE_KEY)).then(function (h) { return Array.isArray(h) ? h : []; }); }
    // Save a notable message. `src` carries the captured message ({ text, authorName }) — usually the
    // replied-to message, or a manual quote. Returns { ok, value } or { ok:false, reason }.
    function addHighlight(src, savedBy, savedByName, note) {
      var text = scrubDiscordTokens(String((src && src.text) || '')).trim().slice(0, cfg.highlightTextMax);
      if (!text) return Promise.resolve({ ok: false, reason: 'nothing to highlight \u2014 reply to a message or quote some text' });
      return getHighlights().then(function (list) {
        var rec = { id: 'h' + clock.now() + '_' + Math.floor(Math.random() * 1e6), text: text,
          authorName: (src && src.authorName) || '', savedBy: savedBy, savedByName: savedByName || '',
          note: String(note || '').trim().slice(0, 200), at: clock.now() };
        list.push(rec);
        if (list.length > cfg.highlightMax) list = list.slice(-cfg.highlightMax);   // drop oldest
        return Promise.resolve(store.set(HILITE_KEY, list)).then(function () { return { ok: true, value: rec }; });
      });
    }
    function listHighlights(n) { return getHighlights().then(function (list) { return n ? list.slice(-n) : list; }); }
    function clearHighlights() { return getHighlights().then(function (list) { var c = list.length; return Promise.resolve(store.set(HILITE_KEY, [])).then(function () { return c; }); }); }

    // ---- reaction significance (size-relative) ----------------------------------------------
    // A raw reaction count is meaningless without the room size: 2 reactions in a 50-person server is
    // a strong signal; 2 in a 5000-person server is noise. The threshold scales with member count
    // (with a floor), so significance is relative. memberCount 0 => unknown => floor only.
    function reactionThreshold(memberCount) {
      var floor = cfg.reactionMinUsers || 2;
      if (!memberCount || memberCount <= 0) return floor;
      return Math.max(floor, Math.ceil(memberCount * (cfg.reactionFraction || 0.01)));
    }
    function reactionSignificance(count, memberCount) {
      var threshold = reactionThreshold(memberCount);
      return { significant: count >= threshold, threshold: threshold, score: threshold ? (count / threshold) : 0 };
    }
    function emojiKey(emoji) {
      if (!emoji) return '';
      return emoji.id ? (String(emoji.name || 'custom') + ':' + emoji.id) : String(emoji.name || '');
    }
    function emojiLabel(emoji) { return emoji ? String(emoji.name || 'reaction') : 'reaction'; }
    // Running per-emoji tally for the channel: how often each reaction shows up on significant
    // messages, so Chloe knows which reactions this room actually values.
    function bumpReactionTally(emoji, by) {
      return Promise.resolve(store.get(REACTTALLY_KEY)).then(function (t) {
        t = (t && typeof t === 'object') ? t : {};
        var k = emojiKey(emoji); if (!k) return null;
        t[k] = { label: emojiLabel(emoji), count: (t[k] ? t[k].count : 0) + (by || 1), last: clock.now() };
        var keys = Object.keys(t);
        if (keys.length > cfg.reactionTallyMax) {   // keep the most-used
          keys.sort(function (a, b) { return t[b].count - t[a].count; }).slice(cfg.reactionTallyMax).forEach(function (k2) { delete t[k2]; });
        }
        return store.set(REACTTALLY_KEY, t);
      });
    }
    function topReactions(n) {
      return Promise.resolve(store.get(REACTTALLY_KEY)).then(function (t) {
        t = (t && typeof t === 'object') ? t : {};
        return Object.keys(t).map(function (k) { return { key: k, label: t[k].label, count: t[k].count }; })
          .sort(function (a, b) { return b.count - a.count; }).slice(0, n || 10);
      });
    }
    // Examine one message's reactions. If the top reaction is significant for this server size, tally
    // it and (optionally) auto-highlight the message. Deduped per message id so re-seeing the same
    // message (e.g. a reaction sweep) doesn't double-count or re-highlight. Returns a small summary.
    var reactionSeen = {};   // messageId -> highest significant count already handled
    var reactionSeenKeys = [];   // insertion order, to bound reactionSeen (prevent a slow leak over a long session)
    // Reaction sweep: reactions are often added AFTER a message scrolls past the poll cursor, so we
    // can't see them on the normal ?after= fetch. Periodically re-fetch a recent window (no cursor)
    // and re-score — processMessageReactions only acts on an INCREASED count, so this is idempotent.
    function reactionSweep() {
      if (!cfg.reactionTracking || typeof cfg.recentFetch !== 'function') return Promise.resolve(0);
      return Promise.resolve(cfg.recentFetch(30)).then(function (msgs) {
        msgs = (msgs || []).filter(function (m) { return m && m.reactions && m.reactions.length; });
        var chain = Promise.resolve(), hits = 0;
        msgs.forEach(function (m) { chain = chain.then(function () { return processMessageReactions(m).then(function (r) { if (r) hits++; }); }); });
        return chain.then(function () { return hits; });
      }, function () { return 0; });
    }
    var trustReactSeen = {};   // msgId+emoji -> count already credited (bounded)
    var trustReactKeys = [];
    function creditPositiveReactions(msg) {
      if (!cfg.relationshipTrust || typeof cfg.reactionUsers !== 'function') return Promise.resolve(0);
      if (!msg || !msg.author || msg.author.id !== cfg.botUserId || !msg.reactions || !msg.reactions.length) return Promise.resolve(0);
      var pos = cfg.trustPositiveEmoji || [];
      var chain = Promise.resolve(), credited = 0;
      msg.reactions.forEach(function (r) {
        var name = r && r.emoji && (r.emoji.name || '');
        if (pos.indexOf(name) < 0) return;                       // positive set only — never penalize
        var key = msg.id + '|' + name;
        var prior = trustReactSeen[key] || 0;
        var count = r.count || 0;
        if (count <= prior) return;                              // idempotent across sweeps
        trustReactSeen[key] = count;
        trustReactKeys.push(key);
        if (trustReactKeys.length > 500) { var oldk = trustReactKeys.shift(); delete trustReactSeen[oldk]; }
        chain = chain.then(function () {
          return Promise.resolve(cfg.reactionUsers(msg.id, name)).then(function (users) {
            var c2 = Promise.resolve();
            (users || []).forEach(function (u) {
              if (!u || !u.id || u.id === cfg.botUserId) return;
              c2 = c2.then(function () { return addTrust(u.id, cfg.trustReactionGain || 2).then(function (did) { if (did) credited++; }); });
            });
            return c2;
          }, function () { return null; });                      // a failed fetch is a no-op, never an error
        });
      });
      return chain.then(function () { if (credited) log('[chloe.trust] credited ' + credited + ' positive reaction(s)'); return credited; });
    }
    function processMessageReactions(msg) {
      if (!cfg.reactionTracking || !msg || !msg.reactions || !msg.reactions.length) return Promise.resolve(null);
      // Trust crediting is independent of significance but JOINED to the returned promise, so
      // sweeps complete deterministically (no fire-and-forget writes racing the poll summary).
      var pos = cfg.trustPositiveEmoji || [];
      var hers = msg.author && msg.author.id === cfg.botUserId;
      var hasPositive = hers && (msg.reactions || []).some(function (r) { return r && r.emoji && pos.indexOf(r.emoji.name || '') >= 0 && (r.count || 0) > 0; });
      var affectChain = hasPositive ? affectNudge({ confidence: (cfg.affectGain || 0.08), warmth: (cfg.affectGain || 0.08) }) : Promise.resolve(null);
      return affectChain.then(function () { return creditPositiveReactions(msg); }).then(function () { return procCheckReactions(msg); }).then(function () { return summonCheckReactions(msg); }).then(function () { return scoreMessageReactions(msg); });
    }
    function scoreMessageReactions(msg) {
      var top = null;
      msg.reactions.forEach(function (r) { if (!top || (r.count || 0) > top.count) top = { emoji: r.emoji, count: r.count || 0 }; });
      if (!top) return Promise.resolve(null);
      var sig = reactionSignificance(top.count, cfg.serverMemberCount);
      if (!sig.significant) return Promise.resolve(null);
      var prior = reactionSeen[msg.id] || 0;
      if (top.count <= prior) return Promise.resolve(null);   // already handled this (or a higher) count
      reactionSeen[msg.id] = top.count;
      reactionSeenKeys.push(msg.id);
      if (reactionSeenKeys.length > 500) { var old = reactionSeenKeys.shift(); delete reactionSeen[old]; }   // bound the in-memory dedup map
      var delta = top.count - prior;
      log('[chloe.react] significant reaction ' + emojiLabel(top.emoji) + ' x' + top.count + ' (threshold ' + sig.threshold + ') on ' + msg.id);
      return bumpReactionTally(top.emoji, delta).then(function () {
        if (!cfg.reactionAutoHighlight || prior > 0) return { emoji: emojiLabel(top.emoji), count: top.count, highlighted: false };
        var src = { text: msg.content || '', authorName: (msg.author && msg.author.username) || '' };
        if (!String(src.text).trim()) return { emoji: emojiLabel(top.emoji), count: top.count, highlighted: false };
        return addHighlight(src, 'reactions', '', emojiLabel(top.emoji) + ' \u00d7' + top.count).then(function () {
          return { emoji: emojiLabel(top.emoji), count: top.count, highlighted: true };
        });
      });
    }
    var gate = { pending: null };        // T2 volunteer candidate (latest un-addressed msg)
    var greet = { pending: null, greeting: false };  // T5 greeting candidate (settling-debounced)
    var paint = { queue: [], painting: false, lastJob: null };  // global image FIFO; one in flight at a time
    var lastPaintAt = 0;                 // last image delivery (image clock — independent of the text clock)
    var engageMode = (cfg.engageMode === 'locked' || cfg.engageMode === 'open') ? cfg.engageMode : 'normal';
    var lastCmdAt = {};                  // per-command last-run clock (for entry.cooldownMs)
    var lastActAt = 0;                   // global last-action clock (light global gap + volunteer cooldown)
    var startedAt = 0;                   // when the loop started (drives the greeting settle window)
    var startupPending = true;           // the first poll after start handles a history backlog specially (image clamp)
    var lastSeenAt = 0;                  // ms (UTC) of the newest message seen, derived from its snowflake id — an authoritative Discord-server clock used to ground time and as a device-clock fallback
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
    // The proactive lane (lull filler, favorite check-ins, scheduled beats) reads timestamps that
    // PERSIST across restarts — lastActivity, last-checkin, beat schedules. Right after start those
    // reflect the pre-restart world, so without a guard the very first poll could fire a lull ("it got
    // quiet…") or a check-in when the only thing that changed is the bot coming online. Reuse the same
    // brief settle window greetings use: observe one cycle before acting proactively.
    function inProactiveSettle(now) { return inGreetSettle(now); }
    function indicateTyping() { if (typeof cfg.typing === 'function') { try { Promise.resolve(cfg.typing(cfg.channelId)).catch(function () {}); } catch (e) {} } }
    // Fast-ack: the Discord side is instant even while the Perchance brain is slow (up to ~60s with
    // cooldowns). At the moment she COMMITS to a reply/image we react to the triggering message with
    // a "working" emoji so the user gets immediate feedback; we clear it when the result lands (or
    // fails). Reactions aren't paced and don't consume the send budget, so the ack is truly instant.
    function ackWorking(messageId, emoji) {
      if (!cfg.ackReactions || !messageId || typeof cfg.react !== 'function') return;
      try { Promise.resolve(cfg.react(cfg.channelId, messageId, emoji)).catch(function () {}); } catch (e) {}
    }
    function ackReact(messageId, emoji) {
      if (!messageId || typeof cfg.react !== 'function') return;
      try { Promise.resolve(cfg.react(cfg.channelId, messageId, emoji)).catch(function () {}); } catch (e) {}
    }
    function clearAck(messageId, emoji) {
      if (!cfg.ackReactions || !messageId || typeof cfg.unreact !== 'function') return;
      try { Promise.resolve(cfg.unreact(cfg.channelId, messageId, emoji)).catch(function () {}); } catch (e) {}
    }
    // Place-in-line reactions for the image queue ("your place in line, thanks to Perch for being
    // the bottleneck"). A queued request gets a keycap-number reaction for its position; as the
    // queue drains the remaining items ARE re-numbered so the number ticks down; when an item
    // reaches the front it swaps to the painting emoji. We remember each item's current ack emoji
    // on the queue object so we always clear the right one.
    var KEYCAPS = ['1\ufe0f\u20e3', '2\ufe0f\u20e3', '3\ufe0f\u20e3', '4\ufe0f\u20e3', '5\ufe0f\u20e3', '6\ufe0f\u20e3', '7\ufe0f\u20e3', '8\ufe0f\u20e3', '9\ufe0f\u20e3', '\ud83d\udd1f'];
    function queueEmojiFor(pos1) { return pos1 <= KEYCAPS.length ? KEYCAPS[pos1 - 1] : '\u23f3'; }   // beyond 10 -> hourglass
    function setQueueAck(item, emoji) {
      if (!cfg.ackReactions || !item || !item.messageId) return;
      if (item.ackEmoji === emoji) return;                       // already showing this
      if (item.ackEmoji) clearAck(item.messageId, item.ackEmoji);
      item.ackEmoji = emoji;
      ackWorking(item.messageId, emoji);
    }
    function renumberQueue() {
      // queued items are behind the one currently painting; position 1 = next up
      for (var i = 0; i < paint.queue.length; i++) setQueueAck(paint.queue[i], queueEmojiFor(i + 1));
    }
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
    // ---- per-user reply language (DESIGN-translate.md) ------------------------------------------
    // A small ISO-639-1 subset we recognize for `!chloe lang`. The bridge does the actual translating
    // at the transport boundary; the engine just records the preference (English-only cognition).
    var LANG_NAMES = { fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese',
      nl: 'Dutch', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic',
      hi: 'Hindi', tr: 'Turkish', pl: 'Polish', sv: 'Swedish', uk: 'Ukrainian', vi: 'Vietnamese',
      id: 'Indonesian', th: 'Thai', el: 'Greek', he: 'Hebrew', cs: 'Czech', ro: 'Romanian', fi: 'Finnish' };
    function getUserLang(id) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) { return (p && p.lang) ? p.lang : null; });
    }
    function setUserLang(id, lang) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p) p = { id: id, name: id, firstSeen: clock.now(), lastSeen: clock.now(), interactionCount: 0, state: 'active', recent: [] };
        if (lang) p.lang = lang; else delete p.lang;
        return store.set(partKey(id), p).then(function () { return lang || null; });
      });
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
    // Distinguish HOW she was addressed, for response priority: an explicit @-ping outranks her name
    // dropped in casual conversation. In a DM every message is a direct ping-equivalent.
    function addressKind(content) {
      if (cfg.addressMode === 'always') return 'ping';   // DM: treat as a direct address
      var c = String(content || '');
      if (cfg.botUserId && (c.indexOf('<@' + cfg.botUserId + '>') >= 0 || c.indexOf('<@!' + cfg.botUserId + '>') >= 0)) return 'ping';
      if (nameAliases().some(function (a) { return new RegExp('\\b' + escRe(a) + '\\b', 'i').test(c); })) return 'name';
      return 'none';
    }
    // Response priority. Higher wins. Weights are spaced by an order of magnitude so the ordering is
    // strict and composable: DM lane > mod > @-ping > (new-user tiebreak) > name-in-casual. So a mod's
    // ping is highest; a new user's ping (11) outranks an existing user's casual name-drop (0); and a
    // DM (1000+) is always served before anything in a regular channel.
    function replyPriority(opts) {
      var s = 0;
      if (cfg.addressMode === 'always') s += 1000;   // this engine is a DM session
      if (opts.isMod) s += 100;
      if (opts.kind === 'ping') s += 10;
      if (opts.isNew) s += 1;                        // tiebreak among same-kind addresses
      if (opts.trusted) s += 1;                      // earned-trust tiebreak (same size as isNew; tone-adjacent, never overrides kind)
      return s;
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
    // For the TRANSCRIPT she reads (not her output): turn opaque Discord refs into readable names so she
    // keeps the social cues instead of seeing blanks. <@id>/<@!id> -> @name (from the roster map, her own
    // name for herself, else @someone); <@&id> -> @role; <#id> -> #channel; emoji -> :name:. nameById is
    // an { id: name } map the caller builds from the roster (+ the bot). Output still uses scrubDiscordTokens.
    function resolveRefs(c, nameById) {
      nameById = nameById || {};
      return String(c || '')
        .replace(/<@!?(\d+)>/g, function (_, id) { return '@' + (nameById[id] || (id === cfg.botUserId ? (personaName || cfg.botName || 'chloe') : 'someone')); })
        .replace(/<@&\d+>/g, '@role')
        .replace(/<#\d+>/g, '#channel')
        .replace(/<a?:(\w+):\d+>/g, ':$1:')
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
    // ---- image memory + natural-language iteration --------------------------------------
    // Record a delivered generation on the user's partition (ethereal users have no partition, so
    // this no-ops for them — the image surface stays untracked, matching forget-me). Keeps a small
    // ring + a `lastImage` pointer used to resolve "make it ..." follow-ups.
    function recordImage(authorId, item) {
      if (!cfg.imageMemory) return Promise.resolve();
      return Promise.resolve(store.get(partKey(authorId))).then(function (p) {
        if (!p) return;   // no partition (ethereal / never ingested) -> keep nothing, by design
        var rec = { prompt: item.prompt, resolution: item.resolution, dm: !!item.dm, at: clock.now() };
        if (item.guidanceScale != null) rec.guidanceScale = item.guidanceScale;
        if (item.removeBackground) rec.removeBackground = true;
        p.images = Array.isArray(p.images) ? p.images : [];
        p.images.push(rec);
        var cap = cfg.imageMemoryRing || 6;
        if (p.images.length > cap) p.images = p.images.slice(-cap);
        p.lastImage = rec;            // fast pointer for "edit the last one"
        p.imageWindowAt = clock.now();   // opens the bare-edit window
        return store.set(partKey(authorId), p);
      });
    }
    // Does this message look like a request to CHANGE the last image (rather than a brand-new one)?
    // Conservative: needs a recent image in scope AND either a back-reference to it ("it", "that",
    // "the image", "same", "another") or a bare modifier phrase ("more detailed", "bigger", "in
    // landscape", "without the hat"). A verb with a fresh subject ("make a dragon") is NOT an edit —
    // it falls through to parseImageRequest as a new generation. Returns the change text, or null.
    function parseImageEdit(content, lastImage, now) {
      if (!cfg.imageMemory || !lastImage) return null;
      if (now - (lastImage.at || 0) > (cfg.imageEditWindowMs || 600000)) return null;   // window closed
      var body = stripAddressing(String(content || '')).replace(/^[\s,:;.!?-]+/, '').trim();
      if (!body || body.length > 160) return null;   // long message -> probably chat, not a tweak
      var lc = body.toLowerCase();
      // a back-reference to the image just made (the recency window is the real disambiguator)
      var backRef = /\b(it|that|this one|the (image|picture|pic|photo|drawing|art|one)|same|another|again)\b/.test(lc)
                 || /^(redo|regenerate|regen|redraw|try again|do it again|one more)\b/.test(lc);
      // a bare modifier with no fresh subject of its own
      var bareMod = /^(?:a bit |a little |way |much |slightly )?(more|less|bigger|smaller|larger|darker|brighter|wider|taller|cuter|scarier|cooler|softer|sharper)\b/.test(lc)
                 || /^(?:in|as|with|without|but|now)\b/.test(lc);
      if (!(backRef || bareMod)) return null;
      return body.slice(0, 200);
    }
    // Deterministic prompt rewrite used when no AI editPrompt hook is wired. Folds the change into the
    // previous prompt with vivid descriptors (the backend strips [..] and ignores negativePrompt, so
    // we build POSITIVELY and use (term:weight) parens for emphasis only).
    function buildEditedPrompt(prev, change) {
      prev = String(prev || '').trim();
      var c = String(change || '').toLowerCase().trim();
      var out = prev;
      // pure "another / again" with no specifics -> regenerate the same prompt (fresh composition)
      if (/^(another|again|one more|do it again|regenerate|regen|redo|try again)\b/.test(c) && c.length < 24) return { prompt: prev, resolution: pickResolution(prev) };
      // detail / quality
      if (/\b(more detail|detailed|higher quality|sharper|crisper|hd|4k|better)\b/.test(c)) out += ', (highly detailed:1.3), sharp focus, intricate';
      // explicit additions: "add X", "with X", "and X", "but X", "make it X", "in X", "as X"
      var addM = c.match(/\b(?:add|with|and|but|make it|in|as|wearing|holding|now)\s+(.{2,80})$/);
      if (addM && addM[1]) {
        var frag = addM[1].replace(/[.!?]+$/, '').trim();
        // "make it bigger/smaller" affects resolution, not the prompt text
        if (!/^(bigger|smaller|larger)$/.test(frag)) out += ', ' + frag;
      }
      // removals can't use negativePrompt (dropped) — drop the word from the prompt if it's there
      var rm = c.match(/\b(?:without|remove|no|drop|lose the)\s+(.{2,40})$/);
      if (rm && rm[1]) {
        var term = rm[1].replace(/[.!?]+$/, '').trim().split(/\s+/).slice(0, 3).join(' ');
        var re = new RegExp('[,;]?\\s*[^,;]*' + escRe(term) + '[^,;]*', 'ig');
        out = out.replace(re, '').replace(/\s*,\s*,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '');
      }
      // resolution / orientation from the change text first, then the prompt
      var resolution = pickResolution(c) !== '768x768' ? pickResolution(c) : pickResolution(out);
      out = out.replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').slice(0, 400);
      if (!out || out.replace(/[^a-z0-9]/ig, '').length < 2) out = prev;   // never send an empty/degenerate prompt (hangs)
      return { prompt: out, resolution: resolution };
    }
    // JSON image request: `{ "prompt": "...", "resolution": "768x768", "guidanceScale": 9,
    // "removeBackground": true, "weights": {"detailed":1.4}, "dm": false }`. Only options the SD
    // backend ACTUALLY honors are exposed (per platform.md §4.3-4.4a, verified R24):
    //   prompt (required)        - real description text; empty/inline-only prompts hang forever
    //   resolution               - one of the four valid sizes
    //   guidanceScale            - 1..30 (default 7), reaches the backend
    //   removeBackground         - real client-side alpha cut (PNG out)
    //   weights {term: w}        - emphasis via A1111 PARENS only ((term:w)); [..] is eaten by the DSL
    //   dm                       - deliver privately
    // negativePrompt and seed are accepted but flagged: the backend silently drops both, so we don't
    // pretend they work. Returns { ok, value:{...}, notes:[...] } or { ok:false, reason }.
    var IMG_RES = { '512x512': 1, '512x768': 1, '768x512': 1, '768x768': 1 };
    // ---- shared structured-input foundation -------------------------------------------------
    // The front-end parses structured JSON locally — instantly, with no Perchance round-trip — so
    // any command we can express as JSON never costs an AI call. One safe parser underpins them all:
    // strips a ```json fence, rejects prototype-pollution keys, and returns a plain object or a
    // reason. Roll new JSON commands onto this rather than re-implementing the guards each time.
    function safeParseJson(text) {
      var raw = String(text || '').trim();
      var fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) raw = fence[1].trim();
      if (/"(?:__proto__|constructor|prototype)"\s*:/.test(raw)) return { ok: false, reason: 'illegal key' };
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'not valid JSON' }; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'expected a JSON object' };
      return { ok: true, value: obj };
    }

    function parseImageJson(text) {
      var pj = safeParseJson(text);
      if (!pj.ok) return { ok: false, reason: pj.reason };
      var obj = pj.value;
      var notes = [];
      var prompt = String(obj.prompt || obj.description || '').trim();
      // emphasis weights -> A1111 parens syntax appended to the prompt (parens only; [..] is unsafe)
      if (obj.weights && typeof obj.weights === 'object') {
        Object.keys(obj.weights).slice(0, 12).forEach(function (term) {
          var w = Number(obj.weights[term]);
          var t = String(term).replace(/[()\[\]:]/g, '').trim();
          if (t && isFinite(w) && w > 0 && w <= 2) prompt += ' (' + t + ':' + (Math.round(w * 100) / 100) + ')';
        });
      }
      prompt = prompt.slice(0, 400).trim();
      if (!prompt || prompt.replace(/[^a-z0-9]/ig, '').length < 2) return { ok: false, reason: 'a real "prompt" description is required (empty prompts hang the generator forever)' };
      var out = { prompt: prompt, dm: !!obj.dm };
      var res = String(obj.resolution || obj.size || '').replace(/\s/g, '').toLowerCase();
      out.resolution = IMG_RES[res] ? res : pickResolution(prompt);
      if (obj.guidanceScale != null) { var g = Number(obj.guidanceScale); if (isFinite(g)) out.guidanceScale = Math.max(1, Math.min(30, g)); }
      if (obj.removeBackground === true) out.removeBackground = true;
      if (obj.negativePrompt) notes.push('negativePrompt is accepted but the backend silently ignores it \u2014 describe what you DO want instead');
      if (obj.seed != null) notes.push('seed is not reliably honored by this backend');
      return { ok: true, value: out, notes: notes };
    }

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
    // Local volunteer pre-filter — the front-end decides, instantly and with NO AI call, whether an
    // unaddressed message is even worth asking the LLM judge about. The judge call costs a multi-
    // second Perchance round-trip; most ambient chatter is an obvious "stay quiet," so we catch those
    // here and never spend the call. CONSERVATIVE by design: it only returns a hard "skip" when it's
    // confident the answer is ignore — anything genuinely ambiguous still goes to the judge.
    // Returns { skip:true, why } to short-circuit to ignore, or { skip:false } to consult the LLM.
    function volunteerPrefilter(g, ring) {
      var text = String((g && g.content) || '').trim();
      var bare = text.replace(/<a?:\w+:\d+>/g, '').replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '').trim();
      // 1. nothing to react to: empty, a lone emoji/sticker, or a bare reaction word
      if (bare.replace(/[^a-z0-9]/ig, '').length < 2) return { skip: true, why: 'no real text' };
      if (/^(lol|lmao|haha+|ok|okay|k|yeah?|yep|nope?|nah|ty|thanks|same|this|fr|ong|w|l|\+1)$/i.test(bare)) return { skip: true, why: 'bare filler' };
      // 2. she's mid bot-loop damping — volunteering would feed the loop
      if (botLoopReplyChance() < 0.5) return { skip: true, why: 'bot-loop damping' };
      // 3. a clearly private two-person back-and-forth between OTHER people
      if (isTwoPersonExchange(ring)) return { skip: true, why: 'two-person exchange' };
      // 4. nothing that invites entry (no question, no opinion bid, not very long) AND the room is
      //    quiet — low odds the judge says "reply", so skip the call. Active rooms still go to judge.
      var invites = /[?]/.test(text) || /\b(anyone|someone|thoughts|opinions|help|how do|what do|should i|recommend|suggest)\b/i.test(text);
      var emphatic = /!{2,}/.test(text) || /[A-Z]{4,}/.test(text) || /\b(yay|woo|wow|omg|finally|congrats|congratulations|shipped|launched|nailed|done)\b/i.test(text);   // celebratory/emphatic -> react-worthy
      if (!invites && !emphatic && bare.length < 24) return { skip: true, why: 'low-signal aside' };
      return { skip: false };
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
      // Use targeted-add if available to avoid clobbering concurrent writes to the index.
      if (typeof store.addToIndex === 'function') return store.addToIndex(id);
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
      var pj = safeParseJson(text);
      if (!pj.ok) return { ok: false, reason: pj.reason === 'expected a JSON object' ? 'a job must be a JSON object' : pj.reason };
      var obj = pj.value;
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
      // Use a targeted-remove via store.removeFromIndex so the write only drops the one id
      // rather than replacing the full array — concurrent ensureIndexed adds won't be lost.
      if (typeof store.removeFromIndex === 'function') return store.removeFromIndex(id);
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
        var chain = Promise.resolve(), demoted = 0, archived = 0;
        (ids || []).forEach(function (id) {
          chain = chain.then(function () {
            return Promise.resolve(store.get(partKey(id))).then(function (p) {
              if (!p || p.lifecycle === 'departed') return;
              if (p.state && p.state !== 'active') return;       // moderation rows are not "quiet"
              // Data tiering: a long-cold user is moved to the historical-friends archive so the hot
              // roster stays small. Favorite-aware — more interaction buys more patience before archival.
              if (cfg.archiveStale && (now - (p.lastSeen || 0)) >= archiveThresholdFor(p)) {
                archived++; return archiveUser(id, 'long-absent');
              }
              if ((now - (p.lastSeen || 0)) >= cfg.quietAfterMs && p.lifecycle !== 'quiet') {
                p.lifecycle = 'quiet'; demoted++; return store.set(partKey(id), p);
              }
            });
          });
        });
        return chain.then(function () { quietSweep._archived = archived; return demoted; });
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
      // ethereal users learn nothing from history either; and even for a user who has since done
      // `remember me`, never reach back across their forget-floor and resurrect erased lines.
      return isEthereal(id).then(function (eth) {
        if (eth) return Promise.resolve();
        return forgetFloorOf(id).then(function (floor) {
          if (floor && toEpoch(msg.timestamp) < floor) return Promise.resolve();   // pre-forget history stays forgotten
          return ingestHistoricalCore(msg);
        });
      });
    }
    function ingestHistoricalCore(msg) {
      var id = msg.author.id;
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
          .then(function () { return dropFromArchive(targetId); })   // erasure must include the cold copy, not just the hot one
          .then(function () { return dropEpisodesFor(targetId, name); })   // and episodes they took part in
          .then(function () { return dropGoalsFor(targetId); })   // and any goals we tracked for them
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
      { verb: 'goals',     modOnly: false, help: 'goals  (your goals; mods: all)', handler: function (uid, c) {
          var mid = c && c.messageId;
          return loadGoals().then(function (list) {
            var now = clock.now();
            var mine = list.filter(function (g) { return g.status === 'open' && (isMod(uid) || g.owner === uid); });
            if (!mine.length) return { ack: isMod(uid) ? 'no open goals on record' : 'I\u2019m not tracking any goals for you \u2014 set one with ' + (cfg.commandPrefix || '!chloe') + ' goal <what you\u2019re working on>' };
            var linesOut = mine.slice(0, 12).map(function (g) {
              var age = Math.max(1, Math.round((now - (g.createdAt || now)) / 86400000));
              return '\u2022 [' + g.id + '] ' + g.text + (isMod(uid) && g.ownerName ? ' (' + g.ownerName + ')' : '') + ' \u2014 ' + age + 'd';
            }).join('\n');
            return { ack: null, embed: embedFor('Goals', linesOut), ackSrc: mid };
          });
        } },
      { verb: 'goal',      modOnly: false, help: 'goal <text>  /  goal done <id>  /  goal drop <id>', handler: function (uid, c) {
          var args = String((c && c.rawArgs) || '').trim();
          var m = args.match(/^(done|drop)\s+(\S+)$/i);
          if (m) {
            return closeGoal(m[2], uid, /drop/i.test(m[1]) ? 'dropped' : 'done').then(function (r) {
              return { ack: r.ok ? ('goal ' + (r.goal.status === 'done' ? 'marked done' : 'dropped') + ' \u2014 \u201c' + r.goal.text + '\u201d') : r.reason };
            });
          }
          if (!args) return Promise.resolve({ ack: 'tell me what you\u2019re working on: ' + (cfg.commandPrefix || '!chloe') + ' goal <text>' });
          return Promise.resolve(store.get(partKey(uid))).then(function (pp) {
            return addGoal(args, uid, (pp && pp.name) || '', 'command').then(function (g) {
              return { ack: g ? ('got it \u2014 I\u2019ll remember you\u2019re working on that (' + g.id + ')') : 'couldn\u2019t note that' };
            });
          });
        } },
      { verb: 'poll',      modOnly: true, help: 'poll <question> | <a> | <b> [...]  /  poll close', handler: function (modId, c) {
          var args = String((c && c.rawArgs) || '').trim();
          if (!args) {
            return Promise.resolve(store.get(POLL_KEY)).then(function (rec) {
              return rec && rec.messageId ? { ack: 'open poll: \u201c' + rec.question + '\u201d \u2014 ' + cfg.commandPrefix + ' poll close to tally' } : { ack: 'no poll is open \u2014 ' + cfg.commandPrefix + ' poll <question> | <a> | <b>' };
            });
          }
          if (/^(close|end|tally)$/i.test(args)) return pollClose();
          var parts = args.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
          if (parts.length < 3) return Promise.resolve({ ack: 'a poll needs a question and at least two options: poll <question> | <a> | <b>' });
          if (parts.length > 10) return Promise.resolve({ ack: 'nine options max' });
          return pollCreate(parts[0].slice(0, 200), parts.slice(1).map(function (o) { return o.slice(0, 80); }));
        } },
      { verb: 'recap',     modOnly: true, cooldownMs: 20000, aliases: ['\ud83d\udcdc'], help: 'recap', handler: function (modId, c) {
          if (typeof cfg.recapFn !== 'function') return Promise.resolve({ ack: 'recap is not available right now' });
          var mid = c && c.messageId;
          if (mid) ackWorking(mid, cfg.ackSearchEmoji);   // 🔍 — digging through the channel before answering
          function done(out) { if (mid) clearAck(mid, cfg.ackSearchEmoji); return out; }
          return assembleContext({ authorId: modId, authorName: '' }).then(function (ctx) {
            return Promise.resolve(cfg.recapFn({ recent: ctx })).then(function (res) {
              var v = (res && res.ok && res.value) ? String(res.value) : 'not much has happened that I can see';
              return done({ ack: v, embed: embedFor('Recap', v) });
            }, function () { return done({ ack: 'recap failed' }); });
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
            return scheduleReminder({ minutes: a.minutes, text: a.text, authorId: modId, authorName: '', dm: !!a.dm }).then(function (res) {
              if (!res.ok) return { ack: 'could not set that reminder: ' + res.reason };
              return { ack: "ok \u2014 i'll remind you in " + a.minutes + 'm: \u201c' + String(a.text).slice(0, 60) + '\u201d' };
            });
          }
          return Promise.resolve({ ack: 'task "' + task + '" is valid but not wired yet' });
        } },
      { verb: 'image',     modOnly: false, help: 'image {json: prompt, resolution, guidanceScale, removeBackground, weights, dm}', handler: function (modId, c) {
          if (!imageEnabled()) return Promise.resolve({ ack: 'image generation is not available right now' });
          var parsed = parseImageJson(c.rawArgs || c.reason || '');
          if (!parsed.ok) return Promise.resolve({ ack: 'image request rejected: ' + parsed.reason });
          if (paint.queue.length >= cfg.imageQueueMax) return Promise.resolve({ ack: "i've got a full image queue right now \u2014 try again in a moment" });
          var v = parsed.value, now = clock.now();
          var qItem = { messageId: c.messageId, authorId: modId, authorName: c.authorName || '', prompt: v.prompt, resolution: v.resolution, dm: v.dm, at: now };
          if (v.guidanceScale != null) qItem.guidanceScale = v.guidanceScale;
          if (v.removeBackground) qItem.removeBackground = true;
          paint.queue.push(qItem);
          if (paint.painting || paint.queue.length > 1) setQueueAck(qItem, queueEmojiFor(paint.queue.length));
          var ack = 'queued: "' + v.prompt.slice(0, 60) + '" (' + v.resolution + (v.guidanceScale != null ? ', cfg ' + v.guidanceScale : '') + (v.removeBackground ? ', bg removed' : '') + (v.dm ? ', dm' : '') + ')';
          if (parsed.notes && parsed.notes.length) ack += ' \u2014 note: ' + parsed.notes.join('; ');
          return Promise.resolve({ ack: ack });
        } },
      { verb: 'remind',    modOnly: false, help: 'remind <10m|2h|1d> <what>', handler: function (modId, c) {
          var args = String(c.rawArgs || '').trim();
          var m = args.match(/^(?:me\s+)?(?:in\s+)?(\d+)\s*([smhd])\b[\s,:-]*(.+)$/i) || args.match(/^(?:me\s+)?(.+?)\s+in\s+(\d+)\s*([smhd])\b$/i);
          if (!m) return Promise.resolve({ ack: 'usage: ' + cfg.commandPrefix + ' remind 10m take the pizza out (or 2h / 1d)' });
          var minutes, text;
          if (m.length === 4 && /^\d+$/.test(m[1])) { minutes = Math.round(durToMs(m[1], m[2]) / 60000); text = m[3]; }
          else { minutes = Math.round(durToMs(m[2], m[3]) / 60000); text = m[1]; }
          if (minutes < 1) minutes = 1;
          var dm = /\b(dm|privately|in private)\b/i.test(args);
          if (dm) text = text.replace(/\b(in (a|my) )?(dm|privately|in private)\b/ig, '').trim();
          return scheduleReminder({ minutes: minutes, text: text, authorId: modId, authorName: c.authorName || '', dm: dm }).then(function (res) {
            if (!res.ok) return { ack: res.reason };
            var when = minutes >= 1440 ? (Math.round(minutes / 1440) + 'd') : minutes >= 60 ? (Math.round(minutes / 60) + 'h') : (minutes + 'm');
            return { ack: "got it \u2014 i'll remind you in " + when + (dm ? ' (via dm)' : '') + ': \u201c' + text.slice(0, 80) + '\u201d' };
          });
        } },
      { verb: 'reminders', modOnly: false, help: 'reminders (list yours) / reminders clear', handler: function (modId, c) {
          var arg = String(c.rawArgs || '').trim().toLowerCase();
          if (arg === 'clear' || arg === 'cancel') return clearReminders(modId).then(function (n) { return { ack: n ? ('cleared ' + n + ' reminder' + (n === 1 ? '' : 's')) : 'you had no reminders pending' }; });
          return listReminders(modId).then(function (list) {
            if (!list.length) return { ack: 'you have no reminders pending' };
            var now = clock.now();
            var lines = list.slice(0, 10).map(function (r) { var mins = Math.max(0, Math.round((r.fireAt - now) / 60000)); return '\u2022 in ' + (mins >= 60 ? (Math.round(mins / 60) + 'h') : (mins + 'm')) + ': ' + r.text.slice(0, 60); });
            return { ack: 'your reminders:\n' + lines.join('\n') };
          });
        } },
      { verb: 'afk',       modOnly: false, help: 'afk [reason] (mark yourself away)', handler: function (modId, c) {
          var reason = String(c.rawArgs || '').trim();
          return setAfk(modId, c.authorName || '', reason).then(function () {
            return { ack: "ok " + (c.authorName ? c.authorName + ', ' : '') + "i'll let people know you're away" + (reason ? ' (' + reason.slice(0, 80) + ')' : '') };
          });
        } },
      { verb: 'back',      modOnly: false, help: 'back (clear your away state)', handler: function (modId, c) {
          return clearAfk(modId).then(function (prior) {
            if (!prior) return { ack: 'you were not marked away' };
            return { ack: 'welcome back' + (c.authorName ? ', ' + c.authorName : '') + " \u2014 you were away " + humanGap(clock.now() - prior.since) };
          });
        } },
      { verb: 'highlight', modOnly: false, help: 'highlight [note] (reply to a message, or quote text)', handler: function (modId, c) {
          var args = String(c.rawArgs || '').trim();
          var src = null, note = args;
          if (c.referenced && c.referenced.text) { src = c.referenced; note = args; }           // replied-to message
          else {
            var q = args.match(/^["\u201c]([\s\S]+?)["\u201d]\s*(.*)$/);                          // "quoted text" optional note
            if (q) { src = { text: q[1], authorName: '' }; note = q[2]; }
            else if (args) { src = { text: args, authorName: c.authorName || '' }; note = ''; }   // bare text becomes the highlight
          }
          if (!src) return Promise.resolve({ ack: 'reply to a message with ' + cfg.commandPrefix + ' highlight, or quote some text to save' });
          return addHighlight(src, modId, c.authorName || '', note).then(function (res) {
            if (!res.ok) return { ack: res.reason };
            return { ack: '\ud83d\udccc saved' + (res.value.note ? ' (' + res.value.note.slice(0, 60) + ')' : '') + ': \u201c' + res.value.text.slice(0, 80) + '\u201d' };
          });
        } },
      { verb: 'highlights',modOnly: false, help: 'highlights (list) / highlights clear', handler: function (modId, c) {
          var arg = String(c.rawArgs || '').trim().toLowerCase();
          if (arg === 'clear' || arg === 'reset') {
            if (!isMod(modId)) return Promise.resolve({ ack: 'only a mod can clear the channel highlights' });
            return clearHighlights().then(function (n) { return { ack: n ? ('cleared ' + n + ' highlight' + (n === 1 ? '' : 's')) : 'no highlights to clear' }; });
          }
          return listHighlights(10).then(function (list) {
            if (!list.length) return { ack: 'no highlights saved yet \u2014 reply to a good message with ' + cfg.commandPrefix + ' highlight' };
            var now = clock.now();
            var lines = list.map(function (h) { return '\u2022 ' + (h.authorName ? h.authorName + ': ' : '') + '\u201c' + h.text.slice(0, 70) + '\u201d' + (h.note ? ' \u2014 ' + h.note.slice(0, 40) : '') + ' (' + humanGap(now - h.at) + ' ago)'; });
            return { ack: 'channel highlights:\n' + lines.join('\n') };
          });
        } },
      { verb: 'reactions',modOnly: false, help: 'reactions (top reactions this room values)', handler: function (modId, c) {
          return topReactions(10).then(function (top) {
            if (!top.length) return { ack: "no notable reactions tracked yet" };
            var mc = cfg.serverMemberCount ? (' \u2014 significance threshold here is ' + reactionThreshold(cfg.serverMemberCount) + '+ on a ' + cfg.serverMemberCount + '-member server') : '';
            return { ack: 'reactions this room values: ' + top.map(function (r) { return r.label + ' \u00d7' + r.count; }).join(', ') + mc };
          });
        } },
      { verb: 'aboutme',  modOnly: false, help: 'aboutme (what she remembers about you)', handler: function (modId, c) {
          return Promise.resolve(store.get(partKey(modId))).then(function (p) {
            var facts = (p && Array.isArray(p.facts)) ? p.facts : [];
            if (!facts.length) return { ack: "I haven\u2019t picked up anything I\u2019m holding onto about you \u2014 we just haven\u2019t talked enough yet, or fact memory is off." };
            var note = '';
            if (p && p.conflict && p.conflict.a && p.conflict.b) note = '\n(heads up \u2014 two of these don\u2019t quite line up: \u201c' + p.conflict.a + '\u201d vs \u201c' + p.conflict.b + '\u201d)';
            return { ack: 'here\u2019s what I remember about you:\n' + facts.map(function (f) { return '\u2022 ' + f.text; }).join('\n') + note + '\n(say "' + cfg.commandPrefix + ' forget <words>" to drop any of it)' };
          });
        } },
      { verb: 'mode',      modOnly: false, help: 'mode  /  mode clear (mods)', handler: function (modId, c) {
          var args = String(c.rawArgs || '').trim().toLowerCase();
          if (args === 'clear' || args === 'off') {
            if (!isMod(modId)) return Promise.resolve({ ack: 'only mods can clear the mode' });
            return clearProcMode().then(function () { return { ack: 'mode cleared \u2014 back to my usual self' }; });
          }
          return getProcMode().then(function (rec) {
            if (!rec) return { ack: 'no special mode is active' };
            var mins = Math.max(1, Math.round((rec.until - clock.now()) / 60000));
            return { ack: 'current mode (set by ' + rec.by + ', ' + mins + 'm left): \u201c' + rec.mode + '\u201d' };
          });
        } },
      { verb: 'time',      modOnly: false, help: 'time \u2014 the current time (instant, no AI)', handler: function (modId, c) { return Promise.resolve({ ack: deviceClockAck('time') }); } },
      { verb: 'date',      modOnly: false, help: 'date \u2014 today\u2019s date (instant, no AI)', handler: function (modId, c) { return Promise.resolve({ ack: deviceClockAck('date') }); } },
      { verb: 'lang',      modOnly: false, help: 'lang <code> (e.g. fr, es, de) / lang off / lang \u2014 your reply language', handler: function (uid, c) {
          var arg = String((c && c.rawArgs) || '').trim().toLowerCase();
          if (!arg) {
            return getUserLang(uid).then(function (lg) {
              return { ack: (lg && lg !== 'en') ? ('I\u2019m talking to you in ' + (LANG_NAMES[lg] || lg) + ' (' + lg + '). Say \u201c' + (cfg.commandPrefix || '!chloe') + ' lang off\u201d to switch back to English.') : 'I\u2019m talking to you in English. Say \u201c' + (cfg.commandPrefix || '!chloe') + ' lang fr\u201d (or es, de, ja\u2026) to switch.' };
            });
          }
          if (arg === 'off' || arg === 'en' || arg === 'english') {
            return setUserLang(uid, null).then(function () { return { ack: 'okay \u2014 back to English.' }; });
          }
          if (!LANG_NAMES[arg]) {
            return Promise.resolve({ ack: 'I don\u2019t know the code \u201c' + arg.slice(0, 12) + '\u201d. Try a 2-letter code like fr (French), es (Spanish), de (German), ja (Japanese), pt, ru, zh, ar\u2026 or \u201clang off\u201d for English.' });
          }
          return setUserLang(uid, arg).then(function () { return { ack: 'got it \u2014 I\u2019ll talk with you in ' + LANG_NAMES[arg] + ' from now on. (\u201c' + (cfg.commandPrefix || '!chloe') + ' lang off\u201d for English.)' }; });
        } },
      { verb: 'forget',    modOnly: false, help: 'forget me  /  forget <a thing>' },
      { verb: 'remember',  modOnly: false, help: 'remember me' },
      { verb: 'forget-that', modOnly: true, help: 'forget-that (reply to a message, or @user) \u2014 excise it from my memory', handler: function (modId, c) {
          // reply target wins; then an @mentioned user's last line; then the most recent channel line.
          if (c.referenced && c.referenced.id) {
            return exciseMessage(c.referenced.id).then(function (r) { return { ack: r.removed ? ('\uD83E\uDDFD forgotten \u2014 dropped that from my memory') : ('I wasn\u2019t holding that message in mind'), react: '\uD83E\uDDFD' }; });
          }
          if (c.targetId) {
            return exciseLastFromUser(c.targetId, 1).then(function (r) { return { ack: r.removed ? ('\uD83E\uDDFD forgot ' + (c.targetName || 'their') + ' last line') : ('nothing recent of theirs to forget'), react: '\uD83E\uDDFD' }; });
          }
          if (lastLineId) {
            return exciseMessage(lastLineId).then(function (r) { return { ack: r.removed ? ('\uD83E\uDDFD forgotten \u2014 dropped the last message from my memory') : ('nothing recent to forget'), react: '\uD83E\uDDFD' }; });
          }
          return Promise.resolve({ ack: 'reply to the message you want me to forget, or @mention whose last line to drop' });
        } }
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
      var verbTok = tokens.shift();
      var entry = resolveVerb(verbTok);
      if (!entry) return null;   // "!chloe Hi there" is chat, not a command — don't swallow it
      var rawArgs = rest.slice(verbTok.length).trim();   // everything after the verb, verbatim (JSON-safe)
      var mm = raw.match(/<@!?(\d+)>/);
      var targetId = mm ? mm[1] : null;
      var durationMs = null, reasonTokens = [];
      tokens.forEach(function (t) {
        if (/^<@!?\d+>$/.test(t)) return;
        var dm = t.match(/^(\d+)([smhd])$/i);
        if (dm && durationMs == null && entry.takesDuration) { durationMs = durToMs(dm[1], dm[2]); return; }
        reasonTokens.push(t);
      });
      return { cmd: entry.verb, entry: entry, targetId: targetId, durationMs: durationMs, reason: reasonTokens.join(' ').trim(), rawArgs: rawArgs, raw: raw, messageId: null };
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
    // Instant date/time from the page-pushed device clock (no AI). Honest when off/stale/absent so the
    // command never fabricates a time. `which` = 'time' | 'date'.
    function deviceClockAck(which) {
      var dc = cfg.deviceClock;
      var fresh = dc && (dc.time || dc.date) && !(dc.at && (clock.now() - dc.at) > (cfg.deviceClockStaleMs || 180000));
      if (fresh) {   // the panel-pushed device clock is best — it carries the user's local time + tz name
        var tz = dc.tz ? (' (' + dc.tz + ')') : '';
        if (which === 'date') return 'Today is ' + (dc.date || dc.time) + tz + '.';
        return 'It\u2019s ' + (dc.time || dc.date) + tz + '.';
      }
      // Fallback: derive the time from the newest Discord message id (a snowflake = authoritative UTC
      // server clock), so time/date still work with the panel closed. Apply a configured tz offset if
      // there is one; otherwise report UTC and point at the device clock for exact local time.
      if (lastSeenAt > 0) {
        var offMin = (typeof cfg.timezoneOffsetMins === 'number') ? cfg.timezoneOffsetMins : 0;
        var d = new Date(lastSeenAt + offMin * 60000);
        var label = offMin ? ('UTC' + (offMin >= 0 ? '+' : '-') + Math.abs(offMin / 60)) : 'UTC';
        if (which === 'date') return 'Around ' + d.toISOString().slice(0, 10) + ' (' + label + ', from recent message timestamps).';
        return 'Around ' + d.toISOString().slice(11, 16) + ' ' + label + (offMin ? '' : ' \u2014 turn on the device clock for your exact local time') + ' (from recent message timestamps).';
      }
      if (!dc || (!dc.time && !dc.date)) return 'I don\u2019t have the current clock right now \u2014 turn on \u201cknow the current date & time\u201d in my settings (Behavior tab) and keep the control panel open.';
      return 'my clock reading is stale (the control panel may be closed) \u2014 reopen it and try again.';
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
    // T5 user opt-out (GDPR ethereal): anyone may ask Chloe to forget THEM and stop tracking them
    // in this bucket. This now does three things: (1) erases what she holds, (2) sets the ethereal
    // flag so no new memory forms here until they undo it, (3) stamps a forget-floor so a later
    // `remember me` can never re-learn the erased history. Never lets a moderated user escape a
    // soft-ban/timeout — the moderation row is kept, only ordinary memory is cleared.
    function forgetMe(id, name) {
      var pfx = cfg.commandPrefix || '!chloe';
      var undo = ' (say \u201c' + pfx + ' remember me\u201d anytime to let me start fresh.)';
      // Flag + floor FIRST, so even an ingest racing this poll forms nothing. dropImageMemory clears
      // any image-request history this bucket held (the image surface is covered by ethereal too).
      return setEthereal(id, name)
        .then(function () { return setForgetFloor(id); })
        .then(function () { return dropImageMemory(id); })
        .then(function () { return Promise.resolve(store.get(partKey(id))); })
        .then(function (p) {
          var ackMsg;
          function ackSend() { return typeof cfg.send === 'function' ? Promise.resolve(cfg.send(cfg.channelId, ackMsg)) : Promise.resolve(); }
          if (!p) { ackMsg = 'okay ' + name + ', there was nothing to forget \u2014 and I\u2019ll keep no notes on you from here.' + undo; return ackSend(); }
          if (p.state && p.state !== 'active') {
            // Clear ALL ordinary memory (facts/insights included — erasure must be complete), but
            // keep the partition + moderation state so a soft-ban/timeout can't be shed via forget-me.
            p.recent = []; p.interactionCount = 0; p.lastGreetedAt = null; p.lifecycle = 'active'; p.trust = 0; p.trustDayEarned = 0;
            p.facts = []; p.insights = []; delete p.images;
            ackMsg = 'okay ' + name + ', I\u2019ve cleared what I remember and I\u2019ll stop keeping notes (any moderation still stands).' + undo;
            return store.set(partKey(id), p).then(function () { return dropEpisodesFor(id, name); }).then(function () { return dropGoalsFor(id); }).then(ackSend);
          }
          ackMsg = 'okay ' + name + ', I\u2019ve forgotten you and I\u2019ll stop keeping notes from here on.' + undo;
          return purge(id, { targetName: name }).then(ackSend);
        });
    }
    // The inverse: lift the ethereal flag so memory may form again from now on. The forget-floor is
    // deliberately left in place, so she starts fresh rather than re-reading the erased past.
    function rememberMe(id, name) {
      function ackSend(m) { return typeof cfg.send === 'function' ? Promise.resolve(cfg.send(cfg.channelId, m)) : Promise.resolve(); }
      return clearEthereal(id).then(function (was) {
        if (!was) return ackSend('you\u2019re already on the record with me, ' + name + ' \u2014 nothing to undo.');
        return ackSend('welcome back, ' + name + ' \u2014 I\u2019ll start getting to know you again from here (I won\u2019t dig up anything from before you asked me to forget).');
      });
    }
    // Erase any image-request history held for a user in this bucket (called by forgetMe). Tolerant
    // of the field not existing yet — image memory is added on the image surface; this keeps the
    // GDPR erase complete regardless of build order.
    function dropImageMemory(id) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p || !p.images) return;
        delete p.images;
        return store.set(partKey(id), p);
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
    function processCommandsAndSelect(incoming, touched, imageEligible, isStartupBatch) {
      // imageEligible: null = normal (any message may trigger image gen); an object {id:true} = startup
      // clamp, only those message ids may trigger image gen (the rest are ingested but never painted).
      // isStartupBatch: true on the first poll after a COLD start / Reset State (no cursor), where
      // `incoming` is a slice of history, not live messages. We seed state from it but must NOT replay
      // historical ACTIONS — no re-running old commands, no re-moderating old messages, no replying to
      // a stale mention. (Greetings are already settled separately; images use the 5-recent clamp.)
      // A WARM restart (cursor present) is genuine catch-up and is never treated as a startup batch.
      function mayPaint(m) { return !imageEligible || !!imageEligible[m.id]; }
      var authorIds = [];
      incoming.forEach(function (m) { if (authorIds.indexOf(m.author.id) < 0) authorIds.push(m.author.id); });
      return Promise.all(authorIds.map(function (id) { return Promise.resolve(store.get(partKey(id))); })).then(function (parts) {
        var now = clock.now();
        var stateById = {}, commandAuthors = {};
        authorIds.forEach(function (id, i) { var p = parts[i]; if (p) { applyExpiry(p, now); stateById[id] = p.state || 'active'; } else stateById[id] = 'active'; });
        var acks = [], embeds = [], notices = [], commandCount = 0, addressedName = null, imageReqName = null;
          var ackSrc = [];   // message id behind each ack (single-source batches reply-reference)
        var canEmbed = typeof cfg.sendEmbed === 'function';
        var chain = Promise.resolve();
        incoming.forEach(function (m) {
          chain = chain.then(function () {
            var c = parseCommand(m.content);
            if (c) c.messageId = m.id;   // lets handlers ack the triggering message (e.g. recap's search indicator)
            if (c) {
              // Cold-start backlog: don't replay historical commands. EXCEPTION: the image command
              // follows the 5-most-recent image clamp instead (the user wants recent images on startup).
              if (isStartupBatch && c.cmd !== 'image') { log('[chloe.T3] startup: not replaying a backlog command (' + c.cmd + ')'); return; }
              c.messageId = m.id; c.authorName = m.author.username;   // for queue-ack reaction + caption
              if (m.referenced_message) c.referenced = { id: m.referenced_message.id, text: m.referenced_message.content || '', authorName: (m.referenced_message.author && m.referenced_message.author.username) || '' };
              commandCount++; commandAuthors[m.author.id] = true;
              if (c.cmd === 'image' && !mayPaint(m)) { log('[chloe.img] startup: skipping a backlog image command'); return; }   // startup clamp
              if (c.cmd === 'forget') {
                var fa = String(c.rawArgs || '').trim();
                if (fa && !/^me$/i.test(fa) && cfg.factMemory) {   // "forget <a thing>" drops matching facts, keeps the person
                  return forgetFact(m.author.id, fa).then(function (n) { ackSrc.push(m.id); acks.push(n ? ('done \u2014 dropped ' + n + ' thing' + (n === 1 ? '' : 's') + ' I had about you') : ("I wasn\u2019t holding onto anything matching that")); });
                }
                return forgetMe(m.author.id, m.author.username);  // "forget" / "forget me" wipes the person + goes ethereal
              }
              if (c.cmd === 'remember') {
                return rememberMe(m.author.id, m.author.username);   // "remember me" lifts ethereal; memory may form again
              }
              if (c.entry && c.entry.modOnly === false) return execCommand(m.author.id, c).then(function (res) { if (res) { if (res.react) ackReact(m.id, res.react); if (canEmbed && res.embed) embeds.push(res.embed); else if (res.ack) { ackSrc.push(m.id); acks.push(res.ack); } } });  // open to anyone
              if (isMod(m.author.id)) return execCommand(m.author.id, c).then(function (res) { if (res) { if (res.react) ackReact(m.id, res.react); if (canEmbed && res.embed) embeds.push(res.embed); else if (res.ack) { ackSrc.push(m.id); acks.push(res.ack); } } });
              log('[chloe.T3] ignoring command from non-mod ' + (m.author.username || m.author.id));
              return;
            }
            if (looksLikeCommand(m.content)) log('[chloe.T3] "' + String(m.content || '').slice(0, 40) + '" starts with ' + cfg.commandPrefix + ' but is not a known command \u2014 treating as normal chat');
            // AFK (front-end only, no AI call): the author speaking clears their own away state, and
            // pinging someone who is away gets a quiet heads-up. Runs on normal chat, before the
            // engagement gates, so it works even for people Chloe otherwise wouldn't reply to.
            var afkChain = Promise.resolve();
            afkChain = afkChain.then(function () {
              return clearAfk(m.author.id).then(function (prior) {
                if (prior) { var since = clock.now() - prior.since; if (since > 120000) notices.push('welcome back, ' + (m.author.username || 'friend') + ' \u2014 away ' + humanGap(since)); }
              });
            });
            var pings = String(m.content || '').match(/<@!?(\d+)>/g) || [];
            if (pings.length) {
              var seen = {};
              pings.forEach(function (tok) {
                var id = tok.replace(/<@!?(\d+)>/, '$1');
                if (id === m.author.id || id === cfg.botUserId || seen[id]) return;
                seen[id] = true;
                afkChain = afkChain.then(function () {
                  return getAfk(id).then(function (a) {
                    if (!a) return;
                    var key = id;
                    if (now - (afkNoticed[key] || 0) < cfg.afkNoticeCooldownMs) return;   // don't spam the same notice
                    if (!(key in afkNoticed)) { afkNoticedKeys.push(key); if (afkNoticedKeys.length > 500) { var oldK = afkNoticedKeys.shift(); delete afkNoticed[oldK]; } }
                    afkNoticed[key] = now;
                    notices.push((a.name || 'they') + ' is away' + (a.reason ? ' (' + a.reason.slice(0, 80) + ')' : '') + ' \u2014 since ' + humanGap(now - a.since) + ' ago');
                  });
                });
              });
            }
            return afkChain.then(function () {
            // Auto-mod watches everyone except mods, BEFORE the engagement-suppression gate, so a
            // repeat offender who is already ignored/timed-out still escalates up the strike ladder.
            // Skip only the terminal soft-ban (already maximally handled reversibly — re-moderating is moot).
            if (autoModEnabled() && !isStartupBatch && !isMod(m.author.id) && stateById[m.author.id] !== 'soft-ban') {
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
            if (engageMode === 'locked' && !isMod(m.author.id)) {   // raid lockdown: only mods get engagement (auto-mod above still ran)
              if (addressKind(m.content) !== 'none') { ackWorking(m.id, cfg.ackLockdownEmoji); scheduleAckClear(m.id, cfg.ackLockdownEmoji); }   // 🔒 honest mods-only signal (lockdown is a PUBLIC mode; quiet moderation stays quiet)
              return;
            }
            var addressed = isAddressed(m.content) || (engageMode === 'open');
            if (imageEnabled() && addressed && mayPaint(m) && cfg.imageMemory) {
              var partForEdit = parts[authorIds.indexOf(m.author.id)];
              var lastImg = partForEdit && partForEdit.lastImage;
              var editText = parseImageEdit(m.content, lastImg, now);
              if (editText) {
                if (paint.queue.length >= cfg.imageQueueMax) {
                  log('[chloe.img] queue full (' + paint.queue.length + '/' + cfg.imageQueueMax + '); dropping edit from ' + (m.author.username || m.author.id));
                  if (typeof cfg.send === 'function') { try { cfg.send(cfg.channelId, 'i\u2019ve got a few images going already, ' + m.author.username + ' \u2014 ask me again in a moment'); } catch (e) {} }
                  return;
                }
                // rebuild the prompt: prefer the AI hook (handles arbitrary natural language), fall
                // back to the deterministic rewrite. Either way it's a fresh generation (no img2img).
                var mref = m, lref = lastImg, eref = editText;
                var rebuild = (typeof cfg.editPrompt === 'function')
                  ? Promise.resolve(cfg.editPrompt({ prev: lref.prompt, request: eref })).then(function (r) {
                      var np = (r && r.ok && typeof r.value === 'string') ? r.value.trim() : '';
                      if (!np || np.replace(/[^a-z0-9]/ig, '').length < 2) return buildEditedPrompt(lref.prompt, eref);
                      return { prompt: np.slice(0, 400), resolution: pickResolution(np + ' ' + eref) };
                    }, function () { return buildEditedPrompt(lref.prompt, eref); })
                  : Promise.resolve(buildEditedPrompt(lref.prompt, eref));
                return rebuild.then(function (built) {
                  var qItem = { messageId: mref.id, authorId: mref.author.id, authorName: mref.author.username, prompt: built.prompt, resolution: built.resolution, dm: !!lref.dm, at: now, isEdit: true };
                  if (lref.guidanceScale != null) qItem.guidanceScale = lref.guidanceScale;
                  if (lref.removeBackground) qItem.removeBackground = true;
                  paint.queue.push(qItem);
                  if (paint.painting || paint.queue.length > 1) setQueueAck(qItem, queueEmojiFor(paint.queue.length));
                  if (reply.queue[mref.author.id]) delete reply.queue[mref.author.id];
                  if (greet.pending && greet.pending.authorId === mref.author.id) greet.pending = null;
                  imageReqName = mref.author.username;
                  log('[chloe.img] edit from ' + mref.author.username + ': \u201c' + eref.slice(0, 40) + '\u201d \u2192 \u201c' + built.prompt.slice(0, 50) + '\u201d');
                });
              }
            }
            if (imageEnabled() && addressed && mayPaint(m)) {
              var imgReq = parseImageRequest(m.content);
              if (imgReq) {
                if (paint.queue.length >= cfg.imageQueueMax) {
                  log('[chloe.img] queue full (' + paint.queue.length + '/' + cfg.imageQueueMax + '); dropping request from ' + (m.author.username || m.author.id));
                  if (typeof cfg.send === 'function') { try { cfg.send(cfg.channelId, 'i\u2019ve got a few images going already, ' + m.author.username + ' \u2014 ask me again in a moment'); } catch (e) {} }
                } else {
                  var qItem = { messageId: m.id, authorId: m.author.id, authorName: m.author.username, prompt: imgReq.prompt, resolution: imgReq.resolution, dm: imgReq.dm, at: now };
                  if (imgReq.guidanceScale != null) qItem.guidanceScale = imgReq.guidanceScale;
                  if (imgReq.removeBackground) qItem.removeBackground = true;
                  paint.queue.push(qItem);
                  // place in line: if something's already painting or ahead, show their number now.
                  if (paint.painting || paint.queue.length > 1) setQueueAck(qItem, queueEmojiFor(paint.queue.length));
                }
                if (reply.queue[m.author.id]) delete reply.queue[m.author.id];   // image supersedes a text reply this turn
                if (greet.pending && greet.pending.authorId === m.author.id) greet.pending = null;
                imageReqName = m.author.username;
                return;
              }
            }
            if (replyEnabled() && addressed && !isStartupBatch) {
              var gi = touched && touched.greetInfo && touched.greetInfo[m.author.id];
              var newUser = !!(gi && gi.brandNew);
              var pri = replyPriority({ isMod: isMod(m.author.id), kind: addressKind(m.content), isNew: newUser, trusted: !!(gi && gi.trusted) });
              reply.queue[m.author.id] = { messageId: m.id, authorId: m.author.id, authorName: m.author.username, content: m.content || '', at: now, priority: pri };
              if (greet.pending && greet.pending.authorId === m.author.id) greet.pending = null;  // replying IS the engagement
              addressedName = m.author.username;
            } else if (gateEnabled() && engageMode === 'normal' && !isStartupBatch) {
              gate.pending = { messageId: m.id, authorId: m.author.id, authorName: m.author.username, content: m.content || '', at: now };
            }
            });   // end afkChain.then wrapper
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
          // AFK heads-ups + welcome-backs flush regardless of the ackCommands toggle — they're a
          // user-facing utility, not a command confirmation.
          if (notices.length && typeof cfg.send === 'function') {
            try { cfg.send(cfg.channelId, notices.join('\n')); } catch (e) {}
          }
          if ((acks.length || embeds.length) && cfg.ackCommands) {
            log('[chloe.T3] ran ' + commandCount + ' command(s)' + (embeds.length ? (' (' + embeds.length + ' embed)') : ''));
            var outs = [];
            if (acks.length && typeof cfg.send === 'function') outs.push(Promise.resolve(cfg.send(cfg.channelId, acks.join('\n'), (cfg.replyReference !== false && acks.length === 1 && ackSrc[0]) ? { replyTo: ackSrc[0] } : undefined)));   // a lone ack attaches to its command
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
            // commit-point revalidation: were they moderated while she was composing the hello?
            return Promise.resolve(store.get(partKey(p.id))).then(function (pp2) {
              if (pp2 && isSuppressed(pp2, clock.now())) {
                greet.greeting = false;
                log('[chloe.abandon] greeting not sent — ' + p.name + ' was moderated mid-generation');
                return null;
              }
            return Promise.resolve(cfg.send(cfg.channelId, hygiene(String(res.value)))).then(function () {
              p.lastGreetedAt = now; lastActAt = now;
              return store.set(partKey(p.id), p).then(function () {
                greet.greeting = false;
                log('[chloe.T5] greeted ' + p.name + ' (' + g.tier + ')');
                return { authorId: p.id, tier: g.tier };
              });
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
      if (inProactiveSettle(clock.now())) return Promise.resolve(null);   // don't fire a scheduled beat on the first poll after start
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
              // v0.57: beats ride the assembler — mood, time, procmode, channel arc all apply now.
              return assembleContext({ authorId: '', authorName: '', content: '' }).then(function (actx) {
                actx.id = fired.id; actx.prompt = fired.prompt;
                return cfg.beatFn(actx);
              }).then(function (res) {
                return deliver((res && res.ok && res.value) ? hygiene(String(res.value)) : pickBeatText(fired));
              }, function () { return deliver(pickBeatText(fired)); });
            }
            return deliver(pickBeatText(fired));
          });
        });
      });
    }

    // Lull filler (Neuro-sama PATIENCE pattern): if the room was recently active and has now gone
    // quiet for `lullPatienceMs`, she may proactively say something to fill the silence. Unlike beats
    // (fixed schedule), this is keyed to actual activity — it fires after a real conversation lulls,
    // not on a clock. Uses the brain (proactive speech needs generation) but is gated hard: only one
    // per lullMinGapMs, only on a real lull, never mid-action, and it respects the global send budget.
    function processLull() {
      if (!cfg.lullFiller || typeof cfg.lullFn !== 'function') return Promise.resolve(null);
      if (engageMode === 'locked' || reply.replying || paint.painting || hasPendingReply()) return Promise.resolve(null);
      if (inProactiveSettle(clock.now())) return Promise.resolve(null);   // don't fill a "lull" that's really just startup
      if (botLoopReplyChance() < 1) return Promise.resolve(null);        // not into a bot-only loop
      if (typeof cfg.canSend === 'function' && !cfg.canSend('text')) return Promise.resolve(null);
      var now = clock.now();
      return Promise.resolve(store.get(RHYTHM_KEY)).then(function (rh) {
        var lastActivity = rh && rh.lastActivity;
        if (lastActivity == null) return null;                                   // never active -> nothing to fill
        var silentFor = now - lastActivity;
        if (silentFor < cfg.lullPatienceMs) return null;                         // not quiet long enough yet
        if (silentFor > cfg.lullActiveWithinMs) return null;                     // dead room, not a lull — leave it
        return Promise.resolve(store.get(LULL_KEY)).then(function (last) {
          if (last && (now - last) < cfg.lullMinGapMs) return null;              // already filled recently
          if (now - lastActAt < cfg.lullMinGapMs) return null;                   // she spoke recently anyway
          reply.replying = true;
          var lullEpoch = deferGen; var lullStartedAt = now;
          if (typeof cfg.noteSend === 'function') cfg.noteSend('text');
          return assembleContext({ authorId: '', authorName: '', content: '' }).then(function (ctx) {
            ctx.lull = true;   // hint to the brain: the room went quiet, gently re-open it
            return cfg.lullFn(ctx);
          }).then(function (r) {
            var text = (r && r.ok) ? hygiene(String(r.value || '').trim()) : '';
            if (!text) { reply.replying = false; if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text'); return null; }
            // commit-point revalidation: did the room wake up while she was composing?
            return Promise.resolve(store.get(RHYTHM_KEY)).then(function (rh2) {
              if (lullEpoch !== deferGen || (rh2 && rh2.lastActivity > lullStartedAt)) {
                reply.replying = false;
                if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text');
                log('[chloe.abandon] lull filler not sent — ' + (lullEpoch !== deferGen ? 'engine stopped mid-generation' : 'the room woke up on its own (the silence she was filling is over)'));
                return null;
              }
            indicateTyping();
            return Promise.resolve(cfg.send(cfg.channelId, text)).then(function () {
              lastActAt = clock.now(); reply.replying = false; rememberReply(text);
              log('[chloe.lull] filled a ' + Math.round(silentFor / 1000) + 's silence');
              return store.set(LULL_KEY, clock.now()).then(function () { return { lull: text }; });
            }, function () { reply.replying = false; return null; });
            });
          }).catch(function () { reply.replying = false; if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text'); return null; });
        });
      });
    }

    // Favorite-user check-in: scan the roster for someone she's interacted with a lot who's been
    // absent for days, and post a warm "haven't seen you" — @mentioning them (the output gate
    // decides whether that actually pings). Discord-paced: absence in days, throttled per-user (~2wk)
    // and globally (~1/day). Picks the most-missed candidate: highest interaction, longest absent.
    function processCheckin() {
      if (!cfg.checkins || typeof cfg.checkinFn !== 'function') return Promise.resolve(null);
      if (engageMode !== 'normal' || reply.replying || paint.painting || hasPendingReply()) return Promise.resolve(null);
      if (typeof cfg.canSend === 'function' && !cfg.canSend('text')) return Promise.resolve(null);
      if (inProactiveSettle(clock.now())) return Promise.resolve(null);   // observe before pinging an "absent" favorite on startup
      var now = clock.now();
      return Promise.resolve(store.get(CHECKIN_KEY)).then(function (ci) {
        ci = (ci && typeof ci === 'object') ? ci : { __last: 0, byUser: {} };
        if (ci.__last && (now - ci.__last) < cfg.checkinGapMs) return null;     // already checked in recently
        return getRoster().then(function (roster) {
          var best = null, toArchive = [];
          roster.forEach(function (u) {
            if (!u || !u.id) return;
            if ((u.interactionCount || 0) < cfg.checkinMinInteractions) return;  // not a favorite
            if (u.state && u.state !== 'active') return;                         // not suppressed/blocked
            var absent = now - (u.lastSeen || 0);
            if (absent < cfg.checkinAbsenceMs) return;                           // not absent long enough
            var rec = (ci.byUser && ci.byUser[u.id]) || null;
            // If they've been seen since the last check-in, that cycle is over — treat as a fresh start.
            var returned = rec && (u.lastSeen || 0) > (rec.seenAt || 0);
            var count = (rec && !returned) ? (rec.count || 0) : 0;
            if (count >= cfg.checkinMaxAttempts) { toArchive.push({ id: u.id, name: u.name }); return; }  // gave up: archive, don't ping
            if (rec && !returned && (now - (rec.at || 0)) < cfg.checkinPerUserGapMs) return;  // cooling down
            // most-missed = most interaction, then longest absent
            var score = (u.interactionCount || 0) * 1e9 + absent;
            if (!best || score > best.score) best = { id: u.id, name: u.name, absent: absent, interactions: u.interactionCount || 0, summary: factSummary(u), seenAt: (u.lastSeen || 0), count: count, score: score };
          });
          // Give up on anyone who's ignored every check-in: move them to historical friends so she
          // stops pinging someone who isn't coming back (life happens), and the hot roster stays lean.
          var archChain = Promise.resolve();
          if (cfg.archiveStale) toArchive.forEach(function (t) { archChain = archChain.then(function () { return archiveUser(t.id, 'checkin-exhausted').then(function () { if (ci.byUser) delete ci.byUser[t.id]; }); }); });
          return archChain.then(function () {
            if (!best) return toArchive.length ? store.set(CHECKIN_KEY, ci).then(function () { return null; }) : null;
            reply.replying = true;
            if (typeof cfg.noteSend === 'function') cfg.noteSend('text');
            // v0.57: check-ins ride the assembler with the ABSENT FRIEND as the addressed person —
            // her facts, insights, and trust tier arrive via the PERSON band for free.
            var ciEpoch = deferGen; var ciStartedAt = clock.now();
            return assembleContext({ authorId: best.id, authorName: best.name, content: '' }).then(function (actx) {
              actx.name = best.name; actx.absentMs = best.absent; actx.interactions = best.interactions; actx.summary = best.summary;
              return cfg.checkinFn(actx);
            }).then(function (r) {
              var text = (r && r.ok) ? hygiene(String(r.value || '').trim()) : '';
              if (!text) { reply.replying = false; if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text'); return null; }
              var body = '<@' + best.id + '> ' + text;   // the mention only actually pings if the gate allows it
              // commit-point revalidation: did they come back while she was composing? A
              // “haven't seen you in a while” landing mid-conversation is the worst kind of stale.
              return Promise.resolve(store.get(partKey(best.id))).then(function (pp2) {
                if (ciEpoch !== deferGen || (pp2 && pp2.lastSeen > ciStartedAt)) {
                  reply.replying = false;
                  if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text');
                  log('[chloe.abandon] check-in not sent — ' + (ciEpoch !== deferGen ? 'engine stopped mid-generation' : best.name + ' came back on their own while she was writing it'));
                  return null;   // no attempt counted, no gaps touched — the premise vanished
                }
              indicateTyping();
              return Promise.resolve(cfg.send(cfg.channelId, body)).then(function () {
                lastActAt = clock.now(); reply.replying = false;
                ci.__last = clock.now(); ci.byUser = ci.byUser || {};
                ci.byUser[best.id] = { at: clock.now(), count: best.count + 1, seenAt: best.seenAt };
                log('[chloe.checkin] checked in on ' + best.name + ' (absent ' + Math.round(best.absent / 86400000) + 'd, attempt ' + (best.count + 1) + '/' + cfg.checkinMaxAttempts + ')');
                return store.set(CHECKIN_KEY, ci).then(function () { return { checkin: best.name }; });
              }, function () { reply.replying = false; return null; });
              });
            }).catch(function () { reply.replying = false; if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text'); return null; });
          });
        });
      });
    }

    // A flat, time-ordered recent transcript of the channel (reused by the rolling summary pass).
    function recentTranscript(maxLines) {
      return getRoster().then(function (roster) {
        var now = clock.now();
        roster = roster.filter(function (u) { return !isSuppressed(u, now); });
        var lines = [];
        roster.forEach(function (u) { (u.recent || []).forEach(function (ln) { lines.push({ who: u.name, text: scrubDiscordTokens(ln.content).slice(0, 240), ts: ln.ts }); }); });   // per-line clip: 40 unclipped 1900-char messages would eat the entire 5000-token request ceiling
        lines.sort(function (a, b) { return a.ts - b.ts; });
        if (lines.length > (maxLines || 40)) lines = lines.slice(-(maxLines || 40));
        return lines.map(function (l) { return l.who + ': ' + l.text; });
      });
    }
    // Rolling recursive channel summary: fold recent activity into a running ≤W-word summary, feeding
    // the prior summary back in so it accretes the channel's arc rather than restarting. Gated to a
    // cadence (it's an AI call). No send — it's memory, not a message.
    function processChannelSummary() {
      if (!cfg.channelSummary || typeof cfg.summaryFn !== 'function') return Promise.resolve(null);
      return recentTranscript(40).then(function (lines) {
        if (!lines.length) return null;
        return Promise.resolve(store.get(CHANSUM_KEY)).then(function (prev) {
          var prior = (prev && typeof prev.text === 'string') ? prev.text : '';
          return Promise.resolve(cfg.summaryFn({ prior: prior, lines: lines, words: cfg.channelSummaryWords || 60 })).then(function (r) {
            var text = (r && r.ok && typeof r.value === 'string') ? r.value.trim() : '';
            if (!text) return null;
            return store.set(CHANSUM_KEY, { text: text, at: clock.now() }).then(function () { log('[chloe.sum] channel summary updated (' + text.length + ' chars)'); return text; });
          });
        });
      });
    }
    // Episodic extraction: fold recent activity into 0-2 short episode records. Gated cadence (one
    // AI pass per poll, shared chain). No send — it's memory, not a message.
    // ---- event-graph: cheap edges from fields episodes already carry (no LLM) ----------------
    function jaccard(a, b) {
      a = a || []; b = b || [];
      if (!a.length || !b.length) return 0;
      var setA = {}; a.forEach(function (x) { setA[String(x).toLowerCase()] = true; });
      var inter = 0, seen = {};
      b.forEach(function (x) { var k = String(x).toLowerCase(); if (setA[k] && !seen[k]) { inter++; seen[k] = true; } });
      var unionN = Object.keys(setA).length; b.forEach(function (x) { var k = String(x).toLowerCase(); if (!setA[k]) unionN++; });
      return unionN ? inter / unionN : 0;
    }
    function episodeEdgeWeight(a, b) {
      var wp = jaccard(a.participants, b.participants) * (cfg.episodeLinkWp || 0.5);
      var wt = jaccard(a.topics, b.topics) * (cfg.episodeLinkWt || 0.3);
      var gap = Math.abs((a.at || 0) - (b.at || 0));
      var wd = Math.pow(0.5, gap / (cfg.episodeLinkHalfLifeMs || 21600000)) * (cfg.episodeLinkWd || 0.2);
      return wp + wt + wd;
    }
    var episodeSeq = 0;
    function mintEpisodeId() { episodeSeq++; return 'e' + clock.now().toString(36) + episodeSeq.toString(36); }
    // Link a freshly-added episode to its single strongest existing neighbor (mutual: upgrade the
    // neighbor's link too if this new edge beats its current one). Sparse: only above the floor.
    function linkEpisode(ring, fresh) {
      if (!cfg.episodeGraph) return;
      var floor = cfg.episodeLinkFloor || 0.15;
      var best = null, bestW = floor;
      ring.forEach(function (other) {
        if (other === fresh || !other.id) return;
        var w = episodeEdgeWeight(fresh, other);
        if (w > bestW) { bestW = w; best = other; }
        // mutual upgrade: does THIS edge beat the neighbor's current best?
        if (w >= floor && (!other.relatesTo || w > other.relatesTo.weight)) other.relatesTo = { id: fresh.id, weight: w };
      });
      fresh.relatesTo = best ? { id: best.id, weight: bestW } : null;
    }

    function processEpisodes() {
      if (!cfg.episodicMemory || typeof cfg.episodeFn !== 'function') return Promise.resolve(null);
      return recentTranscript(40).then(function (lines) {
        if (!lines.length) return null;
        return Promise.resolve(store.get(EPI_KEY)).then(function (ring) {
          ring = Array.isArray(ring) ? ring : [];
          var known = ring.slice(-6).map(function (e) { return e.text; });
          return Promise.resolve(cfg.episodeFn({ lines: lines, known: known })).then(function (r) {
            var proposed = (r && r.ok && Array.isArray(r.value)) ? r.value : [];
            if (!proposed.length) return null;
            var added = 0;
            proposed.forEach(function (raw) {
              if (!raw || typeof raw !== 'object' || typeof raw.t !== 'string' || !raw.t.trim()) return;
              var ep = { id: mintEpisodeId(), text: raw.t.trim().slice(0, 120), at: clock.now(),
                          participants: Array.isArray(raw.who) ? raw.who.map(function (w) { return String(w).slice(0, 40); }).slice(0, 6) : [],
                          topics: Array.isArray(raw.topics) ? raw.topics.map(function (t) { return String(t).toLowerCase().slice(0, 24); }).slice(0, 6) : [],
                          importance: Math.max(1, Math.min(10, Math.round(Number(raw.i)) || 5)), relatesTo: null };
              ring.push(ep);
              linkEpisode(ring, ep);   // cheap edge to its strongest existing neighbor (no LLM)
              added++;
            });
            if (!added) return null;
            if (ring.length > cfg.episodesPerChannel) ring = ring.slice(-cfg.episodesPerChannel);
            return store.set(EPI_KEY, ring).then(function () { log('[chloe.epi] recorded ' + added + ' episode(s)'); return added; });
          });
        });
      });
    }
    // Erasure: forget/purge must cover episodes the person took part in (participant name match).
    function dropEpisodesFor(id, name) {
      var m = String(name || '').toLowerCase();
      if (!m) return Promise.resolve(0);
      return Promise.resolve(store.get(EPI_KEY)).then(function (ring) {
        if (!Array.isArray(ring) || !ring.length) return 0;
        var before = ring.length;
        ring = ring.filter(function (e) {
          return !(e.participants || []).some(function (w) { return String(w).toLowerCase() === m; });
        });
        var removed = before - ring.length;
        if (!removed) return 0;
        return store.set(EPI_KEY, ring).then(function () { log('[chloe.epi] erased ' + removed + ' episode(s) for ' + name); return removed; });
      });
    }

    // ---- idle consolidation (the “sleep” pass) -------------------------------------------
    function channelIsIdle() {
      return Promise.resolve(store.get(RHYTHM_KEY)).then(function (rh) {
        var last = rh && rh.lastActivity;
        if (last == null) return false;   // no activity recorded yet = nothing to tidy
        var z = paceIsQuiet(clock.now());   // pace core: rhythm-relative quiet (null when pace not ready)
        if (z !== null) return z;           // a fast room is "idle" sooner; a slow room later — relative to ITS rhythm
        return (clock.now() - last) >= (cfg.consolidateIdleMs || 1800000);   // fallback: flat threshold
      });
    }
    // Structural: pure local compute, no LLM. Dedup exact/near facts (keep higher importance + newer),
    // drop empties, trim to cap; hard-drop stale low-importance episodes. Bounded slice per pass.
    function consolidateStructural() {
      return Promise.resolve(store.get(CONSOLIDATE_KEY)).then(function (meta) {
        meta = meta || { lastSweepAt: 0, sliceCursor: 0 };
        return getRoster().then(function (roster) {
          var active = roster.filter(function (p) { return p && (!p.state || p.state === 'active'); });
          var start = meta.sliceCursor % Math.max(1, active.length);
          var slice = active.slice(start, start + (cfg.consolidateSliceSize || 5));
          var mergedTotal = 0, droppedTotal = 0;
          var chain = Promise.resolve();
          slice.forEach(function (p) {
            chain = chain.then(function () {
              var facts = Array.isArray(p.facts) ? p.facts : [];
              if (!facts.length) return;
              var byNorm = {}; var out = [];
              facts.forEach(function (f) {
                var key = normFact(f && f.text);
                if (!key) { droppedTotal++; return; }   // empty/whitespace fact
                if (byNorm[key]) {   // duplicate: keep the stronger/newer, count a merge
                  var keep = byNorm[key];
                  keep.i = Math.max(keep.i || 5, f.i || 5);
                  keep.at = Math.max(keep.at || 0, f.at || 0);
                  mergedTotal++;
                } else { byNorm[key] = f; out.push(f); }
              });
              if (out.length > (cfg.factsPerUser || 6)) { droppedTotal += out.length - cfg.factsPerUser; out = out.slice(-(cfg.factsPerUser || 6)); }
              var changed = out.length !== facts.length;
              // contradiction tidy: drop a recorded conflict once it's stale, or once it's resolved
              // (a side no longer present among the kept facts — e.g. the person restated and it merged).
              if (p.conflict) {
                var ttl = cfg.contradictionTtlMs || 259200000;
                var liveText = {}; out.forEach(function (f) { liveText[normFact(f.text)] = 1; });
                var stale = (clock.now() - (p.conflict.at || 0)) > ttl;
                var resolved = !liveText[normFact(p.conflict.a)] || !liveText[normFact(p.conflict.b)];
                if (stale || resolved) { delete p.conflict; changed = true; }
              }
              if (changed) p.facts = out;
              return changed ? store.set(partKey(p.id), p) : null;
            });
          });
          // stale-episode drop (channel-level, once per sweep)
          chain = chain.then(function () {
            return Promise.resolve(store.get(EPI_KEY)).then(function (ring) {
              if (!Array.isArray(ring) || !ring.length) return;
              var now = clock.now(), half = cfg.episodeRecencyHalfLifeMs || 604800000, floor = cfg.episodeDropImportanceFloor || 3;
              var kept = ring.filter(function (ep) {
                var decay = Math.pow(0.5, Math.max(0, now - (ep.at || 0)) / half);
                // drop only when BOTH faded (≥4 half-lives) AND low importance — never a recent or important memory
                return !(decay < 0.0625 && (ep.importance || 5) <= floor);
              });
              if (kept.length !== ring.length) {
                droppedTotal += ring.length - kept.length;
                var liveIds = {}; kept.forEach(function (e2) { if (e2.id) liveIds[e2.id] = true; });
                kept.forEach(function (e2) { if (e2.relatesTo && !liveIds[e2.relatesTo.id]) e2.relatesTo = null; });   // drop edges to evicted episodes
                return store.set(EPI_KEY, kept);
              }
            });
          });
          return chain.then(function () {
            meta.lastSweepAt = clock.now();
            meta.sliceCursor = (start + slice.length) % Math.max(1, active.length);
            return store.set(CONSOLIDATE_KEY, meta).then(function () {
              if (mergedTotal || droppedTotal) log('[chloe.sleep] tidied memory — merged ' + mergedTotal + ', dropped ' + droppedTotal);
              return { merged: mergedTotal, dropped: droppedTotal };
            });
          });
        });
      });
    }
    // Semantic: ONE gated LLM pass over one overdue person's facts. The page may only MERGE or DROP;
    // the engine re-validates every returned fact traces to an input (no invention survives).
    function consolidateSemantic() {
      if (typeof cfg.consolidateFn !== 'function') return Promise.resolve(null);
      return getRoster().then(function (roster) {
        var due = null, oldest = Infinity;
        roster.forEach(function (p) {
          if (!p || (p.state && p.state !== 'active')) return;
          if (!Array.isArray(p.facts) || p.facts.length < (cfg.consolidateMinFacts || 6)) return;
          var ca = p.consolidatedAt || 0;
          if (ca < oldest) { oldest = ca; due = p; }
        });
        if (!due) return null;
        var operatorFacts = due.facts.filter(function (f) { return f.source === 'operator'; });
        var consolidatable = due.facts.filter(function (f) { return f.source !== 'operator'; });
        if (!consolidatable.length) return null;   // nothing but operator-owned facts -> leave them alone
        var inputs = consolidatable.map(function (f) { return f.text; });
        return Promise.resolve(cfg.consolidateFn({ name: due.name, facts: inputs })).then(function (r) {
          return Promise.resolve(store.get(partKey(due.id))).then(function (p) {
            if (!p) return null;
            p.consolidatedAt = clock.now();
            var proposed = (r && r.ok && Array.isArray(r.value)) ? r.value : null;
            if (!proposed) return store.set(partKey(p.id), p).then(function () { return null; });   // failed call: timestamp still bumped (don't re-pick immediately)
            // no-invention guard: keep only proposed facts that trace to an input (normalized substring overlap)
            var inNorms = inputs.map(normFact);
            var clean = [];
            proposed.forEach(function (t) {
              var nt = normFact(t);
              if (!nt) return;
              var traces = inNorms.some(function (inn) { return inn === nt || inn.indexOf(nt) >= 0 || nt.indexOf(inn) >= 0; });
              if (traces) clean.push(String(t).slice(0, 200));
            });
            if (!clean.length) return store.set(partKey(p.id), p).then(function () { return null; });   // nothing validated: leave facts as-is
            // map cleaned texts back onto fact objects, preserving importance/at of the best-matching input
            var oldFacts = Array.isArray(p.facts) ? p.facts : [];
            var consolidated = clean.map(function (t) {
              var nt = normFact(t);
              var match = consolidatable.filter(function (f) { var nf = normFact(f.text); return nf === nt || nf.indexOf(nt) >= 0 || nt.indexOf(nf) >= 0; }).sort(function (a, b) { return (b.importance || 5) - (a.importance || 5); })[0];
              return { id: (match && match.id) || mintFactId(), text: t, importance: (match && match.importance) || 5, source: 'observed', at: (match && match.at) || clock.now() };
            });
            // operator facts are authoritative — always kept, unchanged, ahead of the consolidated set.
            var newFacts = operatorFacts.concat(consolidated);
            if (newFacts.length > (cfg.factsPerUser || 6)) {
              var keepOp = newFacts.filter(function (f) { return f.source === 'operator'; });
              var rest = newFacts.filter(function (f) { return f.source !== 'operator'; }).slice(-(Math.max(0, (cfg.factsPerUser || 6) - keepOp.length)));
              newFacts = keepOp.concat(rest);
            }
            var delta = oldFacts.length - newFacts.length;
            p.facts = newFacts;
            return store.set(partKey(p.id), p).then(function () {
              if (delta > 0) log('[chloe.sleep] consolidated ' + due.name + '’s memory (' + oldFacts.length + ' → ' + newFacts.length + ' facts)');
              return delta > 0 ? { name: due.name, before: oldFacts.length, after: newFacts.length } : null;
            });
          });
        }, function () { return null; });
      });
    }

    // Reflection: one synthesis pass for ONE person whose accumulated fact-importance crossed the
    // threshold. Turns facts + prior insights into 1-2 durable higher-level insights, stored on the
    // partition; resets the accumulator. No send — silent understanding, not a message.
    function processReflection() {
      if (!cfg.reflection || typeof cfg.reflectFn !== 'function') return Promise.resolve(null);
      return getRoster().then(function (roster) {
        var due = null;
        for (var i = 0; i < roster.length; i++) {
          var u = roster[i];
          if (!u || (u.state && u.state !== 'active')) continue;
          if ((u.reflectImportanceAccum || 0) >= cfg.reflectionImportanceThreshold) { due = u; break; }
        }
        if (!due) return null;
        var factTexts = (due.facts || []).map(function (f) { return f.text; });
        var priorInsights = (due.insights || []).map(function (x) { return x.text; });
        return Promise.resolve(cfg.reflectFn({ name: due.name, facts: factTexts, insights: priorInsights })).then(function (r) {
          var proposed = (r && r.ok && Array.isArray(r.value)) ? r.value : [];
          return Promise.resolve(store.get(partKey(due.id))).then(function (p) {
            if (!p) return null;
            p.reflectImportanceAccum = 0; p.reflectAt = clock.now();   // reset even on an empty result (don't loop)
            var ins = Array.isArray(p.insights) ? p.insights : [];
            var seen = {}; ins.forEach(function (x) { seen[normFact(x.text)] = true; });
            var added = 0; var goalPromises = [];
            proposed.forEach(function (raw) {
              var text = String(raw || '').trim().slice(0, 160);
              if (/^goal:/i.test(text)) {   // a forward-looking commitment -> a goal object, not an insight
                if (cfg.goalObjects) goalPromises.push(addGoal(text.replace(/^goal:/i, '').trim(), due.id, due.name, 'reflect'));
                return;
              }
              var key = normFact(text);
              if (!key || seen[key]) return;
              seen[key] = true; ins.push({ text: text, at: clock.now() }); added++;
            });
            if (ins.length > (cfg.insightsPerUser || 3)) ins = ins.slice(-(cfg.insightsPerUser || 3));
            p.insights = ins;
            return Promise.all(goalPromises).then(function () { return store.set(partKey(p.id), p); }).then(function () {
              if (added) log('[chloe.reflect] formed ' + added + ' insight(s) about ' + due.name);
              return added ? { name: due.name, added: added } : null;
            });
          });
        });
      });
    }
    // F1 extraction pass: pick one due regular and ask the brain (page side) to propose durable facts
    // from their recent lines. Gated like check-ins (one user per pass, periodic) so it's cheap. The
    // page handler refuses sensitive categories and returns a short JSON array; we store conservatively.
    // No send — this is silent background learning, not a message.
    function processFacts() {
      if (!cfg.factMemory || typeof cfg.factFn !== 'function') return Promise.resolve(null);
      var now = clock.now();
      return getRoster().then(function (roster) {
        var due = null;
        for (var i = 0; i < roster.length; i++) {
          var u = roster[i];
          if (!u || (u.state && u.state !== 'active')) continue;
          if (factProposeDue(u, now)) { due = u; break; }    // roster is newest-first; take the freshest due user
        }
        if (!due) return null;
        // gather their recent lines for context
        var lines = (due.recent || []).map(function (r) { return String(r.text || r); }).filter(Boolean);
        if (!lines.length) {
          // nothing to learn from right now; still advance the baseline so we don't re-scan immediately
          return Promise.resolve(store.get(partKey(due.id))).then(function (p) { if (p) { p.factsBaseline = p.interactionCount || 0; p.factsAt = now; return store.set(partKey(p.id), p); } });
        }
        return Promise.resolve(cfg.factFn({ name: due.name, lines: lines, known: (due.facts || []).map(function (f) { return f.text; }) })).then(function (r) {
          var proposed = (r && r.ok && Array.isArray(r.value)) ? r.value : [];
          return addFacts(due.id, proposed, 'observed').then(function (added) {
            return Promise.resolve(store.get(partKey(due.id))).then(function (p) {
              if (p) { p.factsBaseline = p.interactionCount || 0; p.factsAt = now; }   // reset the cadence window
              return (p ? store.set(partKey(p.id), p) : Promise.resolve()).then(function () {
                if (added) log('[chloe.facts] learned ' + added + ' fact(s) about ' + due.name);
                return added ? { facts: added, who: due.name } : null;
              });
            });
          });
        }, function () { return null; });
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
    function blockStore() { return cfg.globalStore || store; }
    // ---- ethereal / forget-me (GDPR) -----------------------------------------------------
    // The ethereal + forget-floor records live in the PER-CONTEXT bucket: a public channel keeps
    // them in the shared public store (globalStore), a DM keeps them in its own local store. That
    // is what makes the flag independent across public vs DM.
    function etherealStore() { return cfg.isDM ? store : (cfg.globalStore || store); }
    function isEthereal(id) {
      var sid = String(id || ''); if (!sid) return Promise.resolve(false);
      return Promise.resolve(etherealStore().get(ETHEREAL_KEY)).then(function (e) {
        return !!(e && e.ids && e.ids[sid]);
      });
    }
    function setEthereal(id, name) {
      var sid = String(id || ''); if (!sid) return Promise.resolve();
      return Promise.resolve(etherealStore().get(ETHEREAL_KEY)).then(function (e) {
        e = (e && e.ids) ? e : { ids: {} };
        e.ids[sid] = { at: clock.now(), name: name || '' };
        return etherealStore().set(ETHEREAL_KEY, e);
      });
    }
    function clearEthereal(id) {
      var sid = String(id || ''); if (!sid) return Promise.resolve(false);
      return Promise.resolve(etherealStore().get(ETHEREAL_KEY)).then(function (e) {
        if (!e || !e.ids || !e.ids[sid]) return false;
        delete e.ids[sid];
        return Promise.resolve(etherealStore().set(ETHEREAL_KEY, e)).then(function () { return true; });
      });
    }
    // Stamp a floor at the moment of forgetting; it OUTLIVES `remember me` on purpose so a later
    // re-learn (backfill / cold start) can never reach back across it and resurrect erased history.
    function setForgetFloor(id) {
      var sid = String(id || ''); if (!sid) return Promise.resolve();
      return Promise.resolve(etherealStore().get(FORGETFLOOR_KEY)).then(function (f) {
        f = (f && typeof f === 'object') ? f : {};
        f[sid] = clock.now();
        return etherealStore().set(FORGETFLOOR_KEY, f);
      });
    }
    function forgetFloorOf(id) {
      var sid = String(id || ''); if (!sid) return Promise.resolve(0);
      return Promise.resolve(etherealStore().get(FORGETFLOOR_KEY)).then(function (f) {
        return (f && f[sid]) ? f[sid] : 0;
      });
    }
    function getBlocklist() { return Promise.resolve(blockStore().get(BLOCK_KEY)).then(function (b) { return b || { ids: {}, names: {} }; }); }
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
      // Re-read immediately before write to minimise stale-snapshot window (dict keys don't collide
      // for different users, so concurrent blocks of distinct users are safe either way).
      return getBlocklist().then(function () { return getBlocklist(); }).then(function (bl) {
        var meta = { at: clock.now(), by: opts.byModId || null, reason: opts.reason || null };
        if (id) bl.ids[id] = meta;
        if (name) bl.names[name.toLowerCase()] = meta;
        return Promise.resolve(blockStore().set(BLOCK_KEY, bl)).then(function () {
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
        return Promise.resolve(blockStore().set(BLOCK_KEY, bl)).then(function () { return { ok: changed, value: { id: id, name: name } }; });
      });
    }
    function listBlocked() { return getBlocklist(); }

    // ---- partition upsert (the per-user system of record) --------------------------------
    function ingestOne(msg, ring, indexSet, touched) {
      // permanent tombstone gate: a blocked author is invisible to ingestion forever
      return Promise.resolve(blockStore().get(BLOCK_KEY)).then(function (bl) {
        if (isBlockedSync(bl, msg.author.id, msg.author.username)) return null;
        // ethereal (GDPR): a forgotten user forms NO memory in this bucket — no partition, no roster,
        // no facts, no summary/episode contribution, no image tracking. Their live line still reaches
        // the reply path (it stays in `incoming`), so the bot can answer them; it just keeps no notes.
        return isEthereal(msg.author.id).then(function (eth) {
          if (eth) return null;
          // Forget-floor: even after `remember me`, never re-ingest a line from BEFORE the forget — on
          // ANY path (a cold-start startup batch replays recent history through here, not just
          // backfill). Live post-remember messages are always newer than the floor, so this never
          // blocks them; it only stops erased history resurfacing.
          return forgetFloorOf(msg.author.id).then(function (floor) {
            if (floor && toEpoch(msg.timestamp) < floor) return null;
            return ingestOneCore(msg, ring, indexSet, touched);
          });
        });
      });
    }
    function ingestOneCore(msg, ring, indexSet, touched) {
      return Promise.resolve(store.get(partKey(msg.author.id))).then(function (hot) {
        // A returning "historical friend" is restored from cold storage so their history survives.
        // Restore is independent of cfg.archiveStale: that flag controls whether we *create* new
        // archives, but if a cold copy already exists we must always bring it back (otherwise toggling
        // archiving off would strand returning users as empty "new" partitions while their cold record
        // and archive-index entry linger — a split-brain dual-pool state).
        if (hot) return hot;
        return restoreFromArchive(msg.author.id);
      }).then(function (existing) {
        // If they're not in the hot roster or archive, they could still be known from the mod log or
        // blocklist (a purged or moderated user). Resolve that BEFORE deciding "new" so we never greet
        // or prioritize a previously-seen person as a first-timer. Skip the lookup for the common case
        // (we already have them) to keep the hot path cheap.
        if (existing) return { existing: existing, knownElsewhere: null };
        return knownFromOtherSurfaces(msg.author.id, msg.author.username).then(function (k) {
          return { existing: null, knownElsewhere: k && k.known ? k : null };
        });
      }).then(function (res) {
        var existing = res.existing;
        var knownElsewhere = res.knownElsewhere;
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
        var isNew = !existing && !knownElsewhere;   // truly new only if no surface (roster/archive/modlog/blocklist) knows them
        if (!existing && knownElsewhere) log('[chloe.T5] ' + (msg.author.username || msg.author.id) + ' is not new \u2014 known from ' + knownElsewhere.where + ' (treating as a returning user, not a first-timer)');
        var prevLastSeen = existing ? (existing.lastSeen || 0) : null;   // capture BEFORE we overwrite it
        if (existing) applyExpiry(p, now);   // T3: a timeout that has elapsed reverts to active
        // T5 decay: a return after a long quiet spell lets familiarity fade (warmth follows recency)
        if (existing && prevLastSeen && (now - prevLastSeen) >= cfg.decayAfterMs && (p.interactionCount || 0) > 0) {
          p.interactionCount = Math.max(0, Math.floor((p.interactionCount || 0) * cfg.decayFactor));
          if (cfg.relationshipTrust && p.trust) p.trust = Math.max(0, Math.floor(p.trust * (cfg.trustDecayFactor || 0.85)));   // absence cools trust too
        }
        p.lifecycle = 'active';              // any message reactivates; quiet/departed are set by maintenance
        p.name = msg.author.username || p.name;
        p.lastSeen = Math.max(p.lastSeen || 0, seenAt);
        if (!p.firstSeen) p.firstSeen = seenAt;
        // rolling window of THIS user's lines (observed facts only; no inferences hardened in)
        p.recent.push({ id: msg.id, ts: seenAt, content: msg.content || '' });
        if (p.recent.length > cfg.recentWindow) p.recent = p.recent.slice(-cfg.recentWindow);
        lastLineId = msg.id;   // track newest line so `forget-that` (no reply/target) can drop it

        // speaker ring: dedup-consecutive distinct author ids, keep last N
        if (ring[ring.length - 1] !== msg.author.id) {
          ring.push(msg.author.id);
          if (ring.length > cfg.speakerRingSize) ring.shift();
        }
        indexSet[msg.author.id] = true;
        touched.users[msg.author.id] = true;
        if (cfg.ownAffect && msg.author.id !== cfg.botUserId) { affectOnUserMessage(); affectOnContent(msg.content); }   // engagement + novelty (fire-and-forget: tiny clamped writes)
        if (isNew) touched.newUsers[msg.author.id] = true;
        // T5 greeting signal (the tier is decided later, where suppression + commands are known)
        if (touched.greetInfo) touched.greetInfo[msg.author.id] = { brandNew: isNew, prevLastSeen: prevLastSeen, gapMs: prevLastSeen ? (now - prevLastSeen) : null, messageId: msg.id, name: p.name, trusted: !!(cfg.relationshipTrust && (p.trust || 0) >= cfg.trustPriorityTier) };

        return store.set(partKey(msg.author.id), p);
      });
    }

    // ---- one poll cycle ------------------------------------------------------------------
    // pollOnce wraps the core so the onPoll hook (page events + T5 maintenance) runs on EVERY
    // poll — the running loop calls pollOnce directly, so the hook must live here, not in a caller.
    // ---- run-lock --------------------------------------------------------------------------
    // ---- completion-driven dispatch ---------------------------------------------------------
    // Generation finished -> fire the next queued job as soon as the courtesy gap allows, via the
    // host-injected defer hook. Both targets fully self-gate (budget, cooldowns, flags), so a
    // deferred kick that finds nothing to do costs ~zero; the poll tick remains the backstop.
    // deferGen invalidates outstanding deferred work on stop() — a stopped/demoted engine's
    // scheduled chains become silent no-ops without coupling chaining to the poll-timer loop.
    var deferGen = 0;
    var textChainScheduled = false, imageChainScheduled = false;
    function scheduleTextChain() {
      if (typeof cfg.defer !== 'function' || textChainScheduled || !hasPendingReply()) return;
      textChainScheduled = true;
      var g = deferGen;
      var wait = Math.max(50, (cfg.globalCooldownMs || 0) - (clock.now() - lastActAt));
      // deferGen catches a clean demote; iHoldRunLock catches a freeze/thaw failover (deferGen
      // unchanged) where a successor queen now owns the channel — abandon rather than double-write.
      cfg.defer(function () { textChainScheduled = false; if (g === deferGen) iHoldRunLock().then(function (h) { if (h) processReply(); else log('[chloe.lock] deferred reply abandoned \u2014 another engine holds the run-lock now'); }); }, wait);
    }
    function scheduleImageChain() {
      if (typeof cfg.defer !== 'function' || imageChainScheduled || !paint.queue.length) return;
      imageChainScheduled = true;
      var g = deferGen;
      var wait = Math.max(50, (cfg.imageCooldownMs || 0) - (clock.now() - lastPaintAt));
      cfg.defer(function () { imageChainScheduled = false; if (g === deferGen) iHoldRunLock().then(function (h) { if (h) kickImage(); else log('[chloe.lock] deferred image abandoned \u2014 another engine holds the run-lock now'); }); }, wait);
    }
    // ---- commit-point revalidation (while-if-true) -------------------------------------------
    // Every multi-second generation captures its premises at START and commits at END — but the
    // world moves in between. Each slow path re-checks its premises at the moment of commitment
    // and ABANDONS cheaply instead of committing on stale state. The epoch (deferGen) doubles as
    // the engine-liveness check: stop()/demote bumps it, so an in-flight generation on a stopped
    // engine never commits (its successor owns the work via the pending-reply record).
    function revalidateReply(p, gen) {
      if (gen !== deferGen) return Promise.resolve({ why: 'engine stopped/demoted mid-generation — the successor owns this reply now', keepPending: true });
      // Freeze/thaw failover (deferGen unchanged): if a successor queen now holds the run-lock, do
      // NOT send — leave the pending-reply record so the successor's resume-once picks it up. This is
      // what stops a thawing ex-queen from double-replying and clobbering the shared reply state.
      return iHoldRunLock().then(function (holdLock) {
        if (!holdLock) return { why: 'another engine owns the channel (failover mid-generation) — leaving the reply for the successor', keepPending: true };
        var q2 = reply.queue[p.authorId];
        if (q2 && q2.messageId !== p.messageId) return { why: p.authorName + ' re-addressed with a newer message mid-generation — answering THAT instead', chain: true };
        if (engageMode === 'locked' && !isMod(p.authorId)) return { why: 'lockdown engaged mid-generation', lockAck: true };
        return Promise.resolve(store.get(partKey(p.authorId))).then(function (pp) {
          if (pp && pp.state && pp.state !== 'active') return { why: 'author was moderated mid-generation' };
          return null;
        });
      });
    }
    // Why-not indicators clear themselves (a stale ⏳ hours later would confuse more than help).
    function scheduleAckClear(messageId, emoji, ms) {
      if (typeof cfg.defer !== 'function' || !messageId) return;
      var g = deferGen;
      cfg.defer(function () { if (g === deferGen) clearAck(messageId, emoji); }, ms || cfg.ackClearMs || 30000);
    }
    // Typing keep-alive: Discord's indicator fades in ~10s; refresh while a generation is in flight.
    function keepTypingWhile(flagFn) {
      if (typeof cfg.defer !== 'function') return;
      var g = deferGen;
      cfg.defer(function tick() {
        if (g !== deferGen || !flagFn()) return;
        indicateTyping();
        cfg.defer(tick, cfg.typingRefreshMs || 8000);
      }, cfg.typingRefreshMs || 8000);
    }
    var RUNLOCK_KEY = 'runlock:' + cfg.channelId;
    var PENDING_KEY = 'pending-reply:' + cfg.channelId;   // Gap A: the reply currently being generated
    var runId = cfg.runLockId || ('run-' + Math.random().toString(36).slice(2, 10));
    var runLockSeq = 0, runLockSkips = 0;
    // Read-only "do I still legitimately hold the run-lock?" — used to guard the fire-and-forget
    // deferred chains (image/reply) and the long image-delivery commit, which run BETWEEN polls and
    // therefore outside acquireRunLock. Unlike acquireRunLock this never claims/renews, so a
    // thawing ex-queen calling it can't steal the lock from the live successor; it just learns it no
    // longer owns the channel and abandons the write. (Freeze leaves deferGen unchanged, so the
    // deferGen guard alone can't catch a frozen-then-thawed tab — this lock read does.)
    function iHoldRunLock() {
      if (cfg.runLock === false) return Promise.resolve(true);
      return Promise.resolve(store.get(RUNLOCK_KEY)).then(function (lk) {
        return !!(lk && lk.id === runId && (clock.now() - (lk.at || 0)) < (cfg.runLockTtlMs || 45000));
      }, function () { return false; });
    }
    function acquireRunLock() {
      if (cfg.runLock === false) return Promise.resolve(true);
      var now = clock.now();
      return Promise.resolve(store.get(RUNLOCK_KEY)).then(function (lk) {
        // a DIFFERENT live engine holds it -> we are the split-brain side; stand down this poll
        if (lk && lk.id && lk.id !== runId && (now - (lk.at || 0)) < (cfg.runLockTtlMs || 45000)) return false;
        // claim (or renew our own / take over a stale one), then READ BACK: two engines claiming a
        // stale lock in the same instant resolve to at most one proceeding (same trick as the tab lease)
        var n = runId + ':' + now + ':' + (++runLockSeq);
        return Promise.resolve(store.set(RUNLOCK_KEY, { id: runId, at: now, n: n })).then(function () {
          return Promise.resolve(store.get(RUNLOCK_KEY)).then(function (back) { return !!(back && back.n === n); });
        });
      });
    }
    // Gap A resumption: consume a dead predecessor's pending-reply record — verified, age-capped,
    // resume-once. Returns whether a reply was re-enqueued.
    function resumePendingReply() {
      if (cfg.replyResume === false) return Promise.resolve(false);
      return Promise.resolve(store.get(PENDING_KEY)).then(function (rec) {
        if (!rec || !rec.messageId) return false;
        return Promise.resolve(store.del(PENDING_KEY)).then(function () {   // consume FIRST: resume-once
          var now = clock.now();
          if (now - (rec.at || 0) > (cfg.replyResumeMaxAgeMs || 600000)) { log('[chloe.resume] found a lost reply but it is stale \u2014 dropping (a late answer is worse than silence)'); return false; }
          if (typeof cfg.recentFetch !== 'function') { log('[chloe.resume] found a lost reply but cannot verify against Discord \u2014 never resuming unverified'); return false; }
          return Promise.resolve(cfg.recentFetch(30)).then(function (msgs) {
            var answered = (msgs || []).some(function (m) { return m && m.author && m.author.id === cfg.botUserId && snowflakeCmp(m.id, rec.messageId) > 0; });
            if (answered) { log('[chloe.resume] a bot message exists after the target \u2014 assuming it was answered (no double-send)'); return false; }
            reply.queue[rec.authorId] = { messageId: rec.messageId, authorId: rec.authorId, authorName: rec.authorName, content: rec.content || '', at: rec.at, priority: rec.priority || 0 };
            log('[chloe.resume] resuming a reply a previous engine lost mid-generation (to ' + rec.authorName + ')');
            return true;
          }, function () { return false; });   // verification fetch failed -> conservative: no resume
        });
      });
    }
    function releaseRunLock() {
      return Promise.resolve(store.get(RUNLOCK_KEY)).then(function (lk) {
        if (lk && lk.id === runId) return Promise.resolve(store.del(RUNLOCK_KEY));
      }).catch(function () {});
    }
    function pollOnce() {
      return acquireRunLock().then(function (held) {
        if (!held) {
          runLockSkips++;
          if (runLockSkips === 1 || runLockSkips % 20 === 0) log('[chloe.lock] another engine instance holds the run-lock for this channel \u2014 skipping poll (skip #' + runLockSkips + '; this protects the shared cursor during a queen handover)');
          var summary = { ok: true, lockSkip: true };
          if (typeof cfg.onPoll === 'function') return Promise.resolve(cfg.onPoll(summary)).then(function () { return summary; }, function () { return summary; });
          return Promise.resolve(summary);
        }
        return pollOnceCore().then(function (summary) {
          if (typeof cfg.onPoll === 'function') return Promise.resolve(cfg.onPoll(summary)).then(function () { return summary; }, function () { return summary; });
          return summary;
        });
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
        // Startup backlog handling: on the first poll after start with no cursor (cold start / Reset
        // State), `incoming` can be a chunk of HISTORY. We must not replay historical actions from it.
        // But a fresh channel's first poll might just be a few genuinely-live messages — those should
        // be handled normally. So "backlog" = the batch is large enough to clearly be history, not a
        // live exchange. Below the threshold, treat it as normal live traffic.
        var imageEligible = null;
        var bigBacklog = incoming.length > (cfg.startupBacklogThreshold || 8);
        var isStartupBatch = startupPending && !ctx.cursor && bigBacklog;
        if (isStartupBatch) {
          var humans = incoming.filter(function (m) { return m.author && !m.author.bot && String(m.content || '').trim(); });
          var keep = humans.slice(-(cfg.startupImageMax || 5));
          imageEligible = {};
          keep.forEach(function (m) { imageEligible[m.id] = true; });
          if (incoming.length > keep.length) log('[chloe.img] startup: image gen limited to the ' + keep.length + ' most-recent message(s) of a ' + incoming.length + '-message backlog');
        }
        startupPending = false;   // only the first poll after start gets the clamp
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
            // observation (always, ungated): track bot-vs-human flow for the loop damper. This runs
            // even for messages she won't reply to — she keeps watching the room either way.
            noteAuthorForLoop(!!(m.author && m.author.bot));
            chain = chain.then(function () { return ingestOne(m, ring, indexSet, touched); });
            if (!isStartupBatch) chain = chain.then(function () { return processMessageReactions(m); });   // size-relative reaction significance (not on the history backlog)
          });

          return chain.then(function () {
            // advance cursor to the newest id we saw (even bot's own, so we don't re-fetch it)
            var newCursor = ctx.cursor;
            msgs.forEach(function (m) { newCursor = maxSnowflake(newCursor, m.id); });
            if (newCursor) { var st = snowflakeTime(newCursor); if (st) lastSeenAt = Math.max(lastSeenAt, st); }   // ground time on Discord's authoritative message clock

            // channel rhythm: track last activity + a coarse gap average
            return Promise.resolve(store.get(RHYTHM_KEY)).then(function (rh) {
              rh = rh || { lastActivity: null, avgGapMs: null, samples: 0 };
              if (incoming.length) {
                var now = clock.now();
                if (rh.lastActivity != null) {
                  var gap = now - rh.lastActivity;
                  // pace core: mean (EWMA, alpha 0.3) AND deviation (EWMA, beta) — the Jacobson pair,
                  // mirroring the brain meter. gapVar feeds rhythm-relative debounce + quiet z-scores.
                  var dev = Math.abs(gap - (rh.avgGapMs == null ? gap : rh.avgGapMs));
                  rh.gapVarMs = rh.gapVarMs == null ? Math.round(dev) : Math.round(rh.gapVarMs * (1 - (cfg.paceGapBeta || 0.25)) + dev * (cfg.paceGapBeta || 0.25));
                  rh.avgGapMs = rh.avgGapMs == null ? gap : Math.round(rh.avgGapMs * 0.7 + gap * 0.3);
                  rh.samples++;
                }
                rh.lastActivity = now;
              }

              // G6: blend this batch's human-message tenor into the decayed mood (front-end, no AI)
              var humanTexts = (cfg.moodAware && incoming.length)
                ? incoming.filter(function (m) { return m.author && !m.author.bot; }).map(function (m) { return m.content || ''; })
                : [];

              var writes = [
                store.set(RING_KEY, ring),
                store.set(RHYTHM_KEY, rh),
                store.setIndex(Object.keys(indexSet))
              ];
              if (newCursor && newCursor !== ctx.cursor) writes.push(store.set(CURSOR_KEY, newCursor));
              if (humanTexts.length) writes.push(updateMood(humanTexts, rh.avgGapMs));
              // conversation memory: record HER OWN messages (the ones Discord echoes back, which we drop
              // from `incoming`) into a per-channel ring, with their real snowflake timestamps, so the
              // transcript she reads later is two-sided. Each own message is fetched exactly once (the
              // cursor advances past it), so appending can't double-count.
              if (cfg.conversationMemory && cfg.botUserId) {
                var ownNew = msgs.filter(function (m) { return m.author && m.author.id === cfg.botUserId && String(m.content || '').trim(); });
                if (ownNew.length) {
                  writes.push(Promise.resolve(store.get(OWNLINE_KEY)).then(function (own) {
                    own = Array.isArray(own) ? own : [];
                    ownNew.forEach(function (m) { own.push({ text: String(m.content).slice(0, 400), ts: snowflakeTime(m.id) || clock.now() }); });
                    if (own.length > (cfg.ownLinesMax || 12)) own = own.slice(-(cfg.ownLinesMax || 12));
                    return store.set(OWNLINE_KEY, own);
                  }));
                }
              }

              return Promise.all(writes).then(function () {
                var summary = {
                  fetched: ctx.fetched,
                  ingested: incoming.length,
                  newUsers: Object.keys(touched.newUsers),
                  cursor: newCursor,
                  ring: ring.slice(),
                  rhythm: rh,
                  botTurns: consecutiveBotTurns
                };
                log('[chloe.T0] poll', summary.fetched + ' fetched, ' + summary.ingested +
                  ' ingested, ' + summary.newUsers.length + ' new, cursor=' + summary.cursor);
                return processCommandsAndSelect(incoming, touched, imageEligible, isStartupBatch).then(function (t3) {
                  if (t3 && t3.commands) summary.commands = t3.commands;
                  var imageJob = kickImage();   // fire-and-forget: image broker threads with text; never blocks the loop
                  if (imageJob) summary.imageJob = imageJob;
                  summary.engageMode = engageMode;
                  // Due reminders fire first — they're front-end-only and time-critical, so they
                  // shouldn't wait behind a slow generation. (Promise resolves fast; AI-free.)
                  var reminderJob = processReminders().then(function (rr) { if (rr && rr.fired) summary.reminders = rr.fired; });
                  // The text lane (reply -> volunteer -> greet -> beat) is one promise. By default it's
                  // awaited so the poll resolves only once it's done (every harness relies on this). With
                  // backgroundText on, it's fire-and-forget (exposed as summary.textJob) so a long
                  // generation never stalls the poll loop — the per-lane locks still prevent overlap.
                  var textLane = reminderJob.then(function () { return processReply(); }).then(function (replied) {
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
                    return processLull();
                  }).then(function (lull) {
                    if (lull) summary.lull = lull;
                    return processCheckin();
                  }).then(function (checkin) {
                    if (checkin) summary.checkin = checkin;
                    // AI-cadence floor (pace core): adaptive polling makes "every N polls" a variable
                    // wall-clock time; a fast room would over-run these AI passes. aiPassDue gates each
                    // on its poll cadence AND a minimum wall-clock interval since it last ran.
                    function aiPassDue(name, cadenceOk) {
                      if (!cadenceOk) return false;
                      if (!cfg.adaptivePace || !paceReady()) return true;   // floor only engages once rhythm is established (else: exactly today's every-N-polls)
                      var now2 = clock.now(), last2 = paceLastAI[name] || 0;
                      return (now2 - last2 >= (cfg.paceMinAIIntervalMs || 90000));   // TEST only; the chosen pass records via markRan
                    }
                    function markRan(name) { paceLastAI[name] = clock.now(); }   // stamp the pass that actually ran
                    // One gated AI pass per poll. Collect the DUE candidates in priority order (each
                    // with its run thunk + a base priority), then let the attention manager pick which
                    // one runs (DESIGN-attention.md). attentionManager OFF -> candidates[0] (this exact
                    // order); ON -> utility-scored, but base dominates so neutral signals == this order.
                    var cands = [];
                    if (cfg.factMemory && aiPassDue('facts', cfg.factEveryPolls > 0 && (pollCount % cfg.factEveryPolls) === 0))
                      cands.push({ name: 'facts', base: 60, run: function () { return processFacts(); } });
                    if (cfg.channelSummary && aiPassDue('summary', cfg.channelSummaryEveryPolls > 0 && (pollCount % cfg.channelSummaryEveryPolls) === (cfg.channelSummaryEveryPolls - 1)))
                      cands.push({ name: 'summary', base: 50, run: function () { return processChannelSummary().then(function (cs) { if (cs) { summary.channelSummary = true; summary._sumText = cs; } return null; }); } });
                    if (cfg.reflection && aiPassDue('reflect', cfg.reflectionEveryPolls > 0 && (pollCount % cfg.reflectionEveryPolls) === (cfg.reflectionEveryPolls - 1)))
                      cands.push({ name: 'reflect', base: 40, run: function () { return processReflection().then(function (ref) { if (ref) summary.reflected = ref.name; return null; }); } });
                    if (cfg.episodicMemory && aiPassDue('episodes', cfg.episodeEveryPolls > 0 && (pollCount % cfg.episodeEveryPolls) === (cfg.episodeEveryPolls - 1)))
                      cands.push({ name: 'episodes', base: 30, run: function () { return processEpisodes().then(function (ep) { if (ep) summary.episodes = ep; return null; }); } });
                    if (cfg.idleConsolidation && cfg.consolidateEveryPolls > 0 && (pollCount % cfg.consolidateEveryPolls) === (cfg.consolidateEveryPolls - 1))
                      cands.push({ name: 'consolidate', base: 20, run: function () { return channelIsIdle().then(function (idle) { if (!idle) return null; return consolidateStructural().then(function () { return consolidateSemantic(); }).then(function (sem) { if (sem) summary.consolidated = sem.name; return null; }); }); } });
                    if (cfg.idleDeliberation)
                      cands.push({ name: 'deliberate', base: 10, run: function () { return deliberate().then(function (d) { if (d) summary.deliberated = d.type; return null; }); } });
                    if (cands.length) {
                      // gather signals only when the manager is on (otherwise we just take candidates[0])
                      if (!cfg.attentionManager) { markRan(cands[0].name); return cands[0].run(); }
                      return attentionSignals().then(function (sig) {
                        var chosen = chooseAttention(cands, sig) || cands[0];
                        markRan(chosen.name);   // only the pass that actually runs resets its cadence floor + staleness
                        return chosen.run();
                      });
                    }
                    if (cfg.ownAffect) return affectTick().then(function () { return null; });   // not an AI pass; cheap ignored-check
                    return null;
                  }).then(function (facts) {
                    if (facts) summary.facts = facts;
                    return checkPollExpiry();   // unconditional per-poll: lazy poll auto-close (one cheap store read, outside the one-AI-pass ladder)
                  });
                  function finishPoll() {
                    pollCount++;
                    var tail = refreshPace().then(function () { return summary; });   // pace core: refresh the rhythm cache once per poll
                    if (cfg.workingMemory) { tail = tail.then(function () { return workSync(summary._sumText || null).then(function (w) { if (w && (w.topic || (w.participants && w.participants.length))) summary.workspace = { topic: w.topic, participants: (w.participants || []).length }; return summary; }); }); }
                    if (cfg.workingMemory) {   // record her notable actions this poll into the workspace decision ring
                      var did = [];
                      if (summary.replied) did.push('replied to ' + summary.replied);
                      if (summary.volunteered) did.push('spoke up unprompted');
                      if (summary.greeted) did.push('greeted ' + summary.greeted);
                      if (did.length) tail = tail.then(function () { var c = Promise.resolve(); did.forEach(function (d) { c = c.then(function () { return noteDecision(d); }); }); return c.then(function () { return summary; }); });
                    }
                    var sweepDueByCadence = cfg.reactionSweepEveryPolls > 0 && (pollCount % cfg.reactionSweepEveryPolls) === 0;
                    var sweepDueByActivity = lastPollIngested;   // reactions cluster seconds after fresh messages
                    lastPollIngested = (summary.ingested || 0) > 0;
                    if (cfg.reactionTracking && (sweepDueByCadence || sweepDueByActivity)) {
                      tail = tail.then(function () { return reactionSweep().then(function (n) { if (n) { summary.reactionSweep = n; log('[chloe.react] sweep scored ' + n + ' message(s)'); } return summary; }); });
                    }
                    if (cfg.maintenanceEveryPolls > 0 && (pollCount % cfg.maintenanceEveryPolls) === 0) {
                      tail = tail.then(function () { return quietSweep().then(function (n) { if (n) { summary.quieted = n; log('[chloe.T5] quiet-sweep demoted ' + n + ' user(s)'); } if (quietSweep._archived) { summary.archived = quietSweep._archived; log('[chloe.archive] archived ' + quietSweep._archived + ' long-cold user(s)'); } return summary; }); });
                    }
                    return tail;
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
      if (now - lastActAt < cfg.globalCooldownMs) return Promise.resolve(null);   // light per-channel gap
      // bot-loop damper: in a bot-only ping-pong, decay her chance of replying toward zero so two
      // bots don't feed each other forever. A human message reset consecutiveBotTurns to 0 already.
      var chance = botLoopReplyChance();
      if (chance < 1) {
        var roll = (typeof cfg.random === 'function' ? cfg.random() : Math.random());
        if (roll >= chance) {
          if (consecutiveBotTurns && (consecutiveBotTurns % 4 === 0)) log('[chloe.loop] holding back in bot-only chatter (' + consecutiveBotTurns + ' bot turns, chance=' + chance.toFixed(2) + ')');
          return Promise.resolve(null);
        }
      }
      // choose the highest-PRIORITY queued author who has settled (debounce) and is past their
      // per-author cooldown; ties break to the oldest (so a burst of equal-priority pings is FIFO).
      // Priority ranks mods > @-pings > new-user pings > casual name-drops (see replyPriority).
      var p = null;
      Object.keys(reply.queue).forEach(function (id) {
        var e = reply.queue[id];
        // Cooldown feedback FIRST and independent of debounce: if she answered this person recently,
        // the wait is real (seconds), so tell them now (⏳) rather than leaving confusing silence that
        // reads as her ignoring or "re-reading" them. Checked before the debounce early-return.
        if (now - (lastReplyAt[id] || 0) < cfg.cooldownMs) {            // per-author cooldown
          if (!e.throttleAcked) { e.throttleAcked = true; ackWorking(e.messageId, cfg.ackThrottleEmoji); scheduleAckClear(e.messageId, cfg.ackThrottleEmoji); }   // ⏳ why she's not answering yet
          return;
        }
        if (now - e.at < currentDebounce()) return;                     // still bursting (rhythm-relative)
        var ep = e.priority || 0;
        if (!p) { p = e; return; }
        var pp = p.priority || 0;
        if (ep > pp || (ep === pp && e.at < p.at)) p = e;
      });
      if (!p) return Promise.resolve(null);
      // Cross-channel budget ("one voice"), now priority-aware: a DM (high priority) can claim the
      // shared slot ahead of a regular channel, so DMs are answered first. Checked AFTER selection so
      // we know the winner's priority. Claimed NOW (before the multi-second generation); released if
      // nothing comes back.
      if (typeof cfg.canSend === 'function' && !cfg.canSend('text', p.priority || 0)) {
        if (!p.throttleAcked) { p.throttleAcked = true; ackWorking(p.messageId, cfg.ackThrottleEmoji); scheduleAckClear(p.messageId, cfg.ackThrottleEmoji); }   // ⏳ the shared voice is busy elsewhere
        return Promise.resolve(null);
      }
      if (typeof cfg.noteSend === 'function') cfg.noteSend('text', p.priority || 0);
      delete reply.queue[p.authorId];
      reply.replying = true;
      var genEpoch = deferGen;   // commit-point revalidation: premises re-checked before the send
      indicateTyping();
      keepTypingWhile(function () { return reply.replying; });
      if (p.throttleAcked) clearAck(p.messageId, cfg.ackThrottleEmoji);   // your turn came: ⏳ hands over
      ackWorking(p.messageId, cfg.ackWorkingEmoji);   // 🗣️ — generating your reply right now
      // Gap A: persist what we're answering, so a successor can resume if this engine dies mid-
      // generation. Cleared at EVERY terminal below (empty, sent, error).
      var pendingRec = (cfg.replyResume === false) ? Promise.resolve(null)
        : Promise.resolve(store.set(PENDING_KEY, { messageId: p.messageId, authorId: p.authorId, authorName: p.authorName, content: p.content || '', priority: p.priority || 0, at: clock.now(), runId: runId })).catch(function () { return null; });
      return pendingRec.then(function () { return assembleContext(p); })
        .then(function (ctx) {
          if (ctx && ctx.contextTokens != null) log('[chloe.ctx] packed ' + (ctx.channelRecent ? ctx.channelRecent.length : 0) + ' lines (~' + ctx.contextTokens + ' tok' + (ctx.contextDropped ? ', ' + ctx.contextDropped + ' older dropped' : '') + '); whole request ~' + (ctx.requestTokensEst || ctx.contextTokens) + '/' + (cfg.requestTokenBudget || 5000) + ' tok');
          return cfg.respond(ctx);
        })
        .then(function (r) {
          var text = (r && r.ok) ? hygiene(String(r.value || '').trim()) : '';
          var intent = (r && r.intent) ? r.intent : null;   // standing-intention update from the brain
          if (!text) {
            reply.replying = false;
            clearAck(p.messageId, cfg.ackWorkingEmoji);
            if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text');   // generation produced nothing; give the budget back
            log('[chloe.T1] no reply to ' + p.authorName + ': ' + ((r && r.reason) ? r.reason : 'empty generation'));
            scheduleTextChain();
            return Promise.resolve(store.del(PENDING_KEY)).then(function () { return null; });
          }
          return revalidateReply(p, genEpoch).then(function (stale) {
            if (stale) {
              reply.replying = false;
              clearAck(p.messageId, cfg.ackWorkingEmoji);
              if (stale.lockAck) { ackWorking(p.messageId, cfg.ackLockdownEmoji); scheduleAckClear(p.messageId, cfg.ackLockdownEmoji); }
              if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text');
              log('[chloe.abandon] reply not sent — ' + stale.why);
              if (stale.chain) scheduleTextChain();   // answer the NEWER message at generation speed
              if (stale.keepPending) return null;     // leave the pending record: resume-once belongs to the successor
              return Promise.resolve(store.del(PENDING_KEY)).then(function () { return null; });
            }
            return Promise.resolve(cfg.send(cfg.channelId, text, Object.assign({ toUser: p.authorId }, (cfg.replyReference !== false && p.messageId) ? { replyTo: p.messageId } : {}))).then(function () {
            var t = clock.now();
            lastActAt = t; lastReplyAt[p.authorId] = t;
            var lrKeys = Object.keys(lastReplyAt);   // bound the per-author map (in-memory leak class)
            if (lrKeys.length > 300) { lrKeys.sort(function (a, b) { return lastReplyAt[a] - lastReplyAt[b]; }).slice(0, 50).forEach(function (k) { delete lastReplyAt[k]; }); }
            reply.replying = false;
            clearAck(p.messageId, cfg.ackWorkingEmoji);
            rememberReply(text);
            log('[chloe.T1] replied to ' + p.authorName);
            scheduleTextChain();   // completion-driven: the next queued reply fires at generation speed, not poll speed
            return Promise.resolve(store.del(PENDING_KEY)).then(function () { return intent ? setIntent(intent) : null; }).then(function () {
              return bumpInteraction(p.authorId).then(function () { return text; });
            });
          });
          });
        })
        .catch(function (e) { reply.replying = false; clearAck(p.messageId, cfg.ackWorkingEmoji); if (typeof cfg.releaseSend === 'function') cfg.releaseSend('text'); log('[chloe.T1] reply error:', (e && e.message) || e); scheduleTextChain(); return Promise.resolve(store.del(PENDING_KEY)).then(function () { return null; }, function () { return null; }); });
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
      if (now - paint.queue[0].at < currentDebounce()) return null;       // head still settling (rhythm-relative)
      if (now - lastPaintAt < cfg.imageCooldownMs) return null;           // courtesy gap (image clock only)
      if (typeof cfg.canSend === 'function' && !cfg.canSend('image')) return null;   // cross-channel global image budget
      var p = paint.queue.shift(); paint.painting = true;
      var paintEpoch = deferGen;   // commit-point revalidation: ~14-60s of generation is the longest stale window in the system
      if (typeof cfg.noteSend === 'function') cfg.noteSend('image');      // claim the global image slot at start
      if (p.ackEmoji) { clearAck(p.messageId, p.ackEmoji); p.ackEmoji = null; }   // drop its queue-number
      ackWorking(p.messageId, cfg.ackImageEmoji);                        // instant "painting…" ack on the request
      keepTypingWhile(function () { return paint.painting; });
      renumberQueue();                                                   // the rest of the line ticks down a place
      indicateTyping();
      log('[chloe.img] painting for ' + p.authorName + ' (' + paint.queue.length + ' more queued): "' + p.prompt.slice(0, 60) + '" (' + p.resolution + (p.dm ? ', dm' : '') + ')');
      var paintArgs = { prompt: p.prompt, resolution: p.resolution };
      if (p.guidanceScale != null) paintArgs.guidanceScale = p.guidanceScale;
      if (p.removeBackground) paintArgs.removeBackground = true;
      var job = Promise.resolve(cfg.paint(paintArgs))
        .then(function (r) {
          var dataUrl = (r && r.ok) ? String(r.value || '') : '';
          if (dataUrl.indexOf('data:') !== 0) {
            paint.painting = false; scheduleImageChain(); lastPaintAt = clock.now();
            clearAck(p.messageId, cfg.ackImageEmoji);
            if (typeof cfg.releaseSend === 'function') cfg.releaseSend('image');
            log('[chloe.img] no image for ' + p.authorName + ': ' + ((r && r.reason) ? r.reason : 'empty result'));
            return Promise.resolve(cfg.send(cfg.channelId, 'sorry ' + p.authorName + ", I couldn't make that image just now.")).then(function () { return null; }, function () { return null; });
          }
          // revalidate before delivery: were they moderated, the engine stopped, or did another
          // engine take over the channel (freeze/thaw failover) mid-paint? Any of these -> abandon.
          return Promise.resolve(store.get(partKey(p.authorId))).then(function (pp2) {
           return iHoldRunLock().then(function (holdLock) {
            if (paintEpoch !== deferGen || !holdLock || (pp2 && pp2.state && pp2.state !== 'active')) {
              paint.painting = false; lastPaintAt = clock.now(); scheduleImageChain();
              clearAck(p.messageId, cfg.ackImageEmoji);
              if (typeof cfg.releaseSend === 'function') cfg.releaseSend('image');
              log('[chloe.abandon] image not delivered — ' + (paintEpoch !== deferGen ? 'engine stopped mid-paint' : (!holdLock ? 'another engine owns the channel (failover mid-paint)' : p.authorName + ' was moderated mid-paint')));
              return null;
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
              lastPaintAt = clock.now(); paint.painting = false; scheduleImageChain();          // image clock only — do NOT touch lastActAt
              clearAck(p.messageId, cfg.ackImageEmoji);
              log('[chloe.img] delivered to ' + p.authorName + (p.dm ? ' (dm)' : ''));
              return recordImage(p.authorId, p).then(function () {
                if (cfg.imageEnhanceOffer && !p.isEdit && !/\b(detailed|hd|4k|high quality)\b/i.test(p.prompt || '')) {
                  try { cfg.send(cfg.channelId, 'want me to refine that, ' + p.authorName + '? just say how \u2014 e.g. \u201cmore detailed\u201d, \u201cmake it landscape\u201d, or \u201canother one\u201d.'); } catch (e) {}
                }
                return bumpInteraction(p.authorId);
              }).then(function () { return { image: true, to: p.authorId }; });
            }, function (e) { paint.painting = false; scheduleImageChain(); clearAck(p.messageId, cfg.ackImageEmoji); if (typeof cfg.releaseSend === 'function') cfg.releaseSend('image'); log('[chloe.img] send failed: ' + ((e && e.message) || e)); return null; });
          });
          });
          });
        })
        .catch(function (e) { paint.painting = false; scheduleImageChain(); clearAck(p.messageId, cfg.ackImageEmoji); if (typeof cfg.releaseSend === 'function') cfg.releaseSend('image'); log('[chloe.img] paint error: ' + ((e && e.message) || e)); return null; });
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
      if (now - g.at < currentDebounce()) return Promise.resolve(null);               // still bursting (rhythm-relative)
      if (now - lastActAt < cfg.volunteerCooldownMs) { gate.pending = null; return Promise.resolve(null); }
      return getSpeakerRing().then(function (ring) {
        if (isTwoPersonExchange(ring)) { gate.pending = null; log('[chloe.T2] two-person exchange — staying out'); return null; }
        // Local pre-filter: skip the expensive judge LLM call when the front-end can already tell
        // this isn't worth chiming in on. One voice, fewer Perchance calls.
        var pf = (typeof cfg.volunteerPrefilter === 'function') ? cfg.volunteerPrefilter(g, ring) : volunteerPrefilter(g, ring);
        if (pf && pf.skip) { gate.pending = null; log('[chloe.T2] prefilter skip (' + pf.why + ') — no judge call'); return null; }
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
              var text = (r && r.ok) ? hygiene(String(r.value || '').trim()) : '';
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
    // Token chunker. The backend's effective context is small, so rather than a flat line cap we
    // pack the MOST RECENT conversation into a token budget: newest lines first (the exchange she's
    // actually replying to always survives), kept in chronological order for the prompt. Estimate is
    // deliberately conservative (~4 chars/token + a little per-line overhead for the speaker label)
    // so we under-fill rather than overflow the window.
    // ---- attention manager (DESIGN-attention.md): utility-scored AI-pass selection ---------------
    // Among the passes DUE this poll, pick which one runs by a utility score instead of fixed order.
    // base = today's standing priority (dominant term, so neutral signals == today's order). Modifiers
    // are small re-rankers driven by her state; staleness is monotonic so nothing starves. Pure +
    // deterministic; exported for the harness. `candidates`: [{name, base}]; `signals`: see chooseAttention.
    function attentionScore(cand, signals) {
      var s = cand.base;
      var st = (signals.staleness && signals.staleness[cand.name]) || 0;   // 0..1, time since it last ran
      s += st * 3;                                                          // overdue passes rise (anti-starvation)
      if (signals.idle) {
        if (cand.name === 'consolidate') s += 4;
        if (cand.name === 'deliberate') s += 3;
      }
      if (signals.curiosity != null && cand.name === 'deliberate') s += (signals.curiosity - 0.5) * 8;   // high curiosity lifts thinking
      if (signals.memoryPressure != null && cand.name === 'consolidate') s += signals.memoryPressure * 6; // clutter lifts tidying
      return s;
    }
    // Choose the winning due candidate. Off -> first in list (today's fixed order). On -> highest score,
    // ties to the lower base-order index (deterministic, == today when modifiers are zero).
    function chooseAttention(candidates, signals) {
      if (!candidates.length) return null;
      if (!cfg.attentionManager) return candidates[0];   // fixed ladder: list is already in priority order
      var best = candidates[0], bestScore = attentionScore(candidates[0], signals), bestIdx = 0;
      for (var i = 1; i < candidates.length; i++) {
        var sc = attentionScore(candidates[i], signals);
        if (sc > bestScore + 1e-9) { best = candidates[i]; bestScore = sc; bestIdx = i; }
      }
      if (best !== candidates[0]) log('[chloe.attend] chose ' + best.name + ' (score ' + bestScore.toFixed(1) + ') over ' + candidates[0].name);
      return best;
    }
    // Gather the signals the scorer needs (only called when attentionManager is on). Cheap reads.
    function attentionSignals() {
      var now = clock.now();
      var staleWindow = cfg.attentionStaleWindowMs || 600000;   // ~10min -> full staleness weight
      var staleness = {};
      ['facts', 'summary', 'reflect', 'episodes', 'consolidate', 'deliberate'].forEach(function (n) {
        var last = paceLastAI[n] || 0;
        staleness[n] = last ? Math.min(1, (now - last) / staleWindow) : 1;   // never-run = maximally stale
      });
      return channelIsIdle().then(function (idle) {
        return (cfg.ownAffect ? affectLoad() : Promise.resolve(null)).then(function (a) {
          // memory pressure: cheap proxy — fraction of the roster whose fact list is at/near the cap.
          return getRoster().then(function (roster) {
            var cap = cfg.factsPerUser || 6, pressured = 0, counted = 0;
            (roster || []).forEach(function (p) { if (p && Array.isArray(p.facts)) { counted++; if (p.facts.length >= cap - 1) pressured++; } });
            var memoryPressure = counted ? (pressured / counted) : 0;
            return { idle: !!idle, curiosity: a ? (a.curiosity != null ? a.curiosity : 0.5) : null, staleness: staleness, memoryPressure: memoryPressure };
          });
        });
      });
    }

    // ---- output hygiene (DESIGN-clean.md): scrub model-mechanics noise from a reply -------------
    // Removes artifacts that are never intended output: a leading "Name:" role-bleed prefix, a 3x word
    // stutter, an unbalanced code fence, and a clearly-incomplete dangling tail. Each step is no-op-safe
    // and NEVER empties a valid reply. Idempotent. opts.names = her name + aliases (only those + generic
    // speaker labels are stripped, so mid-message colons survive).
    function cleanReply(text, opts) {
      opts = opts || {};
      var s = String(text == null ? '' : text);
      if (!s) return s;
      var original = s;
      // 1) strip a LEADING role-name prefix ("Name:" / "Name \u2014" / "Name -"), once, only her own
      //    names/aliases + known generic labels (not arbitrary capitalized words).
      var labels = [];
      (opts.names || []).forEach(function (n) { if (n) labels.push(String(n)); });
      ['user', 'assistant', 'someone', 'system', 'bot'].forEach(function (n) { labels.push(n); });
      var stripped = s.replace(/^\s+/, '');
      for (var i = 0; i < labels.length; i++) {
        var nm = labels[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');   // escape regex
        var re = new RegExp('^' + nm + '\\s*[:\\u2014-]\\s+', 'i');
        if (re.test(stripped)) { stripped = stripped.replace(re, ''); break; }   // once only
      }
      if (stripped.trim()) s = stripped;   // never empty via prefix-strip
      // 2) collapse an exact 3+ consecutive word stutter ("no no no no" -> "no")
      s = s.replace(/\b(\w+)(\s+\1\b){2,}/gi, '$1');
      // 3) trim a clearly-incomplete dangling tail: if the message doesn't end on terminal
      //    punctuation/quote/emoji and has more than one sentence, drop the trailing fragment back to
      //    the last complete sentence. NEVER empty the message.
      var endsClean = /[.!?\u2026"\u201d'\u2019)\]]\s*$/.test(s) || /[\u{1F000}-\u{1FAFF}\u2600-\u27BF]\s*$/u.test(s);
      if (!endsClean) {
        var m = s.match(/^[\s\S]*[.!?\u2026]["\u201d'\u2019)\]]?(?=\s|$)/);
        // Trim only if it leaves a substantial complete sentence (>=10 chars) AND actually drops a
        // trailing fragment. A short punctuation-less reply ("lol ok") has no match -> left alone.
        if (m && m[0].trim().length >= 10 && m[0].trim().length < s.trim().length) s = m[0].trim();
      }
      // 4) balance code fences: odd count of ``` -> append a closing fence
      var fences = (s.match(/```/g) || []).length;
      if (fences % 2 === 1) s = s.replace(/\s*$/, '') + '\n```';
      s = s.replace(/^\s+|\s+$/g, '');
      return s || original;   // absolute guard: never return empty for a non-empty input
    }
    // ---- self-knowledge (DESIGN-selfknow.md): one grounding line built from her own config ---------
    // She doesn't otherwise know her prefix / that she's a bot / how she's summoned, yet users ask.
    // Pure, assembled from live config; omits any clause whose config isn't set; never fabricates.
    function selfKnowledgeText() {
      var name = cfg.botName ? String(cfg.botName) : 'Chloe';
      var parts = ['You are ' + name + ', an AI assistant chatting with people in this Discord channel.'];
      var reach = [];
      var pfx = cfg.commandPrefix ? String(cfg.commandPrefix) : '';
      if (pfx) reach.push('they can use commands with ' + pfx + ' (e.g. ' + pfx + ' help)');
      reach.push('they can @-mention you');
      var emo = (cfg.summonEmoji && cfg.summonEmoji.length) ? cfg.summonEmoji[0] : '';
      if (emo) reach.push('reacting ' + emo + ' to their own message also gets your attention');
      if (reach.length) parts.push('To reach you: ' + reach.join('; ') + '.');
      parts.push('You can tell someone this if they ask how to use you or whether you\u2019re a bot \u2014 state it plainly rather than deflecting.');
      return parts.join(' ');
    }

    // Apply cleanReply only when enabled; otherwise pass through (today's behavior).
    function hygiene(text) { return cfg.cleanOutput === false ? text : cleanReply(text, { names: [cfg.botName].concat(cfg.botAliases || []) }); }

    function estimateTokens(s) {
      s = String(s || '');
      if (!s.length) return 0;
      if (typeof cfg.countTokens === 'function') { try { var n = cfg.countTokens(s); if (typeof n === 'number' && isFinite(n) && n >= 0) return Math.ceil(n); } catch (e) {} }
      return Math.ceil(s.length / 4);   // fallback heuristic when the page's countTokens isn't wired
    }
    function packByTokens(lines, budget) {
      var kept = [], used = 0, perLine = 3;   // "who:" label + newline overhead, in tokens
      for (var i = lines.length - 1; i >= 0; i--) {
        var cost = estimateTokens(lines[i].who) + estimateTokens(lines[i].text) + perLine;
        if (kept.length > 0 && used + cost > budget) break;   // always keep at least the newest line
        kept.push(lines[i]); used += cost;
      }
      kept.reverse();
      return { lines: kept, tokens: used, dropped: lines.length - kept.length };
    }

    // ---- prioritized context assembler (DESIGN-context-assembler.md) ----------------------
    // One registry of soft-context providers; one budget policy. Providers are pure (no writes),
    // failures are isolated, admission is greedy by priority under the whole-request budget with a
    // hard transcript floor, and admitted lines render ASCENDING so the highest-priority text lands
    // LAST — nearest the generation point, where the model weighs it most.
    var BANDS = { IDENTITY: 90, DIRECTIVE: 80, PERSON: 70, RECALL: 60, SITUATION: 50, AMBIENCE: 40, HYGIENE: 30 };
    var ctxProviders = [];
    var ctxProviderWarned = {};
    function registerProvider(p) {
      if (p && p.id && typeof p.gather === 'function' && typeof p.priority === 'number') ctxProviders.push(p);
    }
    function gatherInjections(gctx) {
      gctx = gctx || {};
      var enabled = ctxProviders.filter(function (p) {
        try { return typeof p.enabled !== 'function' || !!p.enabled(cfg); } catch (e) { return false; }
      });
      return Promise.all(enabled.map(function (p, i) {
        return Promise.resolve().then(function () { return p.gather(gctx); })
          .then(function (inj) {
            if (!inj || !inj.text) return null;
            var text = String(inj.text);
            return { id: inj.id || p.id, text: text,
                     priority: (typeof inj.priority === 'number') ? inj.priority : p.priority,
                     tokens: (typeof inj.tokens === 'number') ? inj.tokens : estimateTokens(text),
                     __i: i };
          })
          .catch(function (e) {
            if (!ctxProviderWarned[p.id]) { ctxProviderWarned[p.id] = true; log('[chloe.ctx] provider "' + p.id + '" failed: ' + ((e && e.message) || e) + ' (suppressing repeats)'); }
            return null;   // a broken provider can never take down the reply path
          });
      })).then(function (cands) {
        cands = cands.filter(Boolean);
        cands.sort(function (a, b) { return (b.priority - a.priority) || (a.__i - b.__i); });   // admit highest first
        var budget = gctx.budget != null ? gctx.budget : (cfg.requestTokenBudget || 5000);
        var reserve = gctx.reserve || 0;
        var floor = gctx.minTranscriptTokens != null ? gctx.minTranscriptTokens : (cfg.minTranscriptTokens || 200);
        var admitted = [], dropped = [], spent = 0;
        cands.forEach(function (c) {
          if (reserve + spent + c.tokens + floor <= budget) { admitted.push(c); spent += c.tokens; }
          else { dropped.push(c); log('[chloe.ctx] dropped injection "' + c.id + '" (' + c.tokens + ' tok, band ' + c.priority + ') — budget pressure'); }
        });
        admitted.sort(function (a, b) { return (a.priority - b.priority) || (a.__i - b.__i); });  // render ascending: highest LAST
        var meta = admitted.map(function (c) { return { id: c.id, tokens: c.tokens, priority: c.priority }; });
        admitted.forEach(function (c) { delete c.__i; }); dropped.forEach(function (c) { delete c.__i; });
        return { admitted: admitted, dropped: dropped, meta: meta, tokens: spent };
      });
    }

    // ---- slot-line providers (DESIGN §4a) -------------------------------------------------
    // The six soft-context lines convert to providers one at a time. Each renders the SAME line the
    // page template renders today (Phase 3 becomes a pure consumer switch), reports the LEGACY token
    // figure (template wrapping has always been accounted in promptOverheadTokens), and writes its
    // legacy ctx field to gctx.legacyOut — the documented Phase-2 dual-emission shim.
    registerProvider({ id: 'time', priority: BANDS.AMBIENCE,
      enabled: function (c) { return !!c.timeAware; },
      gather: function (g) {
        return Promise.resolve(store.get(RHYTHM_KEY)).then(function (rh) {
          var t = timeContext(rh && rh.lastActivity);
          if (g.legacyOut) g.legacyOut.timeContext = t;
          var bits = ['It is ' + t.partOfDay + (t.weekend ? ' on a weekend' : ' on a ' + (t.dayOfWeek || 'weekday'))];
          if (t.quietFor) bits.push('the channel has been quiet for ' + t.quietFor);
          return { text: 'Context: ' + bits.join('; ') + '. Let this gently tint your tone if it fits (e.g. calmer late at night) — do not state the time or day unless it is naturally relevant.', tokens: 16 };
        });
      } });

    registerProvider({ id: 'mood', priority: BANDS.AMBIENCE,
      enabled: function (c) { return !!c.moodAware; },
      gather: function (g) {
        return Promise.resolve(store.get(MOOD_KEY)).then(function (mood) {
          if (!mood) return null;
          var d = moodDescriptor(mood);
          if (g.legacyOut) g.legacyOut.mood = d;
          return { text: 'The room feels ' + d + ' right now — match that energy rather than working against it (don’t name the mood).', tokens: 12 };
        });
      } });

    // Arbitrary semantic-memory injection: surface each operator/system-set fact, skipping any that
    // have expired (ttlMs). One generic slot so a new system fact never needs a new provider.
    registerProvider({ id: 'selfknowledge', priority: BANDS.IDENTITY,
      enabled: function (c) { return !!c.selfKnowledge; },
      gather: function (g) { var t = selfKnowledgeText(); return t ? { text: t, tokens: estimateTokens(t) } : null; } });

    registerProvider({ id: 'seminject', priority: BANDS.SITUATION,
      enabled: function (c) { return Array.isArray(c.semanticInjections) && c.semanticInjections.length > 0; },
      gather: function (g) {
        var now = clock.now();
        var live = (cfg.semanticInjections || []).filter(function (s) {
          if (!s || !s.text) return false;
          if (s.ttlMs && s.at && (now - s.at) > s.ttlMs) return false;   // expired -> skip (never assert stale)
          return true;
        });
        if (!live.length) return null;
        var text = live.map(function (s) { return String(s.text); }).join(' ');
        return { text: text, tokens: estimateTokens(text) };
      } });

    registerProvider({ id: 'workspace', priority: BANDS.SITUATION,
      enabled: function (c) { return !!c.workingMemory; },
      gather: function (g) {
        return workLoad().then(function (w) {
          if (!w) return null;
          var bits = [];
          if (w.topic) bits.push('this channel is about ' + w.topic);
          if (w.participants && w.participants.length) bits.push((w.participants.length === 1 ? w.participants[0] + ' is here' : w.participants.slice(0, 4).join(', ') + ' are here'));
          if (w.goal) bits.push('you\u2019re trying to ' + w.goal);
          if (!bits.length) return null;   // nothing fresh to assert -> say nothing (volatile)
          var text = 'Right now: ' + bits.join('; ') + '. Let this ground you in the moment; don\u2019t recite it.';
          return { text: text, tokens: estimateTokens(text) };
        });
      } });

    registerProvider({ id: 'chansum', priority: BANDS.SITUATION,
      enabled: function (c) { return !!c.channelSummary; },
      gather: function (g) {
        return Promise.resolve(store.get(CHANSUM_KEY)).then(function (cs) {
          if (!cs || !cs.text) return null;
          if (g.legacyOut) g.legacyOut.channelSummary = cs.text;
          return { text: 'The story so far in this channel (older context that scrolled away): ' + cs.text, tokens: estimateTokens(cs.text) + 8 };
        });
      } });

    registerProvider({ id: 'intent', priority: BANDS.DIRECTIVE,
      enabled: function () { return true; },
      gather: function (g) {
        return Promise.resolve(store.get(INTENT_KEY)).then(function (gi) {
          if (!(gi && gi.text && (clock.now() - (gi.at || 0) < cfg.intentTtlMs))) return null;
          if (g.legacyOut) g.legacyOut.currentIntent = gi.text;
          return { text: 'Right now you are quietly focused on: ' + gi.text + '. Let that guide your reply without stating it outright.', tokens: estimateTokens(gi.text) + 12 };
        });
      } });

    registerProvider({ id: 'highlights', priority: BANDS.RECALL,
      enabled: function (c) { return (c.highlightContextCount | 0) > 0; },
      gather: function (g) {
        return getHighlights().then(function (hl) {
          if (!hl || !hl.length) return null;
          var pick = hl.slice(-cfg.highlightContextCount).map(function (h) { return { who: h.authorName || 'someone', text: h.text, note: h.note || '' }; });
          if (g.legacyOut) g.legacyOut.channelHighlights = pick;
          var toks = 0;
          pick.forEach(function (h) { toks += estimateTokens(h.who) + estimateTokens(h.text) + estimateTokens(h.note) + 4; });
          var text = 'A few memorable moments from this channel (reference only if naturally relevant, do not force them in):\n'
            + pick.map(function (h) { return '- ' + (h.who ? h.who + ': ' : '') + '\u201c' + String(h.text).slice(0, 120) + '\u201d' + (h.note ? ' (' + String(h.note).slice(0, 60) + ')' : ''); }).join('\n');
          return { text: text, tokens: toks };
        });
      } });

    registerProvider({ id: 'charmem', priority: BANDS.RECALL,
      enabled: function (c) { return !!c.character; },
      gather: function () {
        return Promise.resolve(crossStore().get(CHARMEM_KEY)).then(function (rec) {
          if (!rec || !rec.facts || !rec.facts.length) return null;
          var pick = rec.facts.slice(-2);   // a couple of the most-recent background memories
          var text = 'Things you (' + (rec.name || 'you') + ') remember: ' + pick.join('; ') + '.';
          return { text: text, tokens: estimateTokens(text) };
        });
      } });

    registerProvider({ id: 'goals', priority: BANDS.RECALL,
      enabled: function (c) { return !!c.goalObjects; },
      gather: function (g) {
        var a = g.addressed;
        if (!a || !a.id) return null;   // ownerless/channel goals are not auto-recalled (kept for command listing)
        return goalsForOwner(a.id).then(function (open) {
          if (!open.length) return null;
          var pick = open.sort(function (x, y) { return (y.lastTouchedAt || 0) - (x.lastTouchedAt || 0); })[0];
          var who = (g.p && g.p.authorName) || a.name || 'them';
          var text = 'You know ' + who + ' is working on: ' + pick.text + '. Ask how it\u2019s going if it fits naturally \u2014 never force it.';
          return { text: text, tokens: estimateTokens(text), touch: pick.id };
        });
      } });

    registerProvider({ id: 'episodes', priority: BANDS.RECALL,
      enabled: function (c) { return !!c.episodicMemory; },
      gather: function (g) {
        return Promise.resolve(store.get(EPI_KEY)).then(function (ring) {
          if (!Array.isArray(ring) || !ring.length) return null;
          // Query tokens: the addressed message + the last few transcript lines.
          // Matching per DESIGN §7a: lowercase, punctuation-stripped, tokens ≥3 chars, exact overlap.
          function toks(s) {
            return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 3; });
          }
          var qset = {};
          toks(g.p && g.p.content).forEach(function (w) { qset[w] = true; });
          (g.lines || []).slice(-3).forEach(function (l) { toks(l.text).forEach(function (w) { qset[w] = true; }); });
          var now = clock.now(), half = cfg.episodeRecencyHalfLifeMs || 604800000;
          var scored = [];
          ring.forEach(function (e) {
            var eset = {}; (e.topics || []).forEach(function (t) { toks(t).forEach(function (w) { eset[w] = true; }); });
            toks(e.text).forEach(function (w) { eset[w] = true; });
            var overlap = 0; Object.keys(eset).forEach(function (w) { if (qset[w]) overlap++; });
            if (!overlap) return;
            var decay = Math.pow(0.5, Math.max(0, now - (e.at || 0)) / half);
            scored.push({ e: e, score: overlap * (e.importance || 5) * decay });
          });
          if (!scored.length) return null;   // nothing relevant -> zero cost this turn
          scored.sort(function (a, b) { return b.score - a.score; });
          var top = scored.slice(0, cfg.episodeRecallCount || 2);
          var pickedIds = {}; top.forEach(function (x) { if (x.e.id) pickedIds[x.e.id] = true; });
          var pick = top.map(function (x) { return x.e.text; });
          // one-hop event-graph expansion: pull in the top episode's strongest neighbor (ONE hop,
          // never transitive) if it's linked, present, and not already surfaced. Tiny fixed cost.
          var hop = null;
          if (cfg.episodeGraph && top.length && top[0].e.relatesTo && top[0].e.relatesTo.id) {
            var nb = ring.filter(function (e2) { return e2.id === top[0].e.relatesTo.id; })[0];   // dangling id -> no hop
            if (nb && !pickedIds[nb.id]) hop = nb.text;
          }
          var text;
          if (hop) text = 'You remember from this channel: ' + pick.join('; ') + '; and connected to that, ' + hop + '. Bring it up only if it genuinely fits.';
          else text = 'You remember from this channel: ' + pick.join('; ') + '. Bring it up only if it genuinely fits.';
          return { text: text, tokens: estimateTokens(text) };
        });
      } });

    // Contradiction clarify (DESIGN-contradiction): if she's holding a FRESH unresolved conflict about
    // the person she's addressing, surface it as soft guidance — she MAY gently check which is current,
    // but it's the model's call (descriptive, not a forced question). Goes quiet after the fresh window
    // so it can't nag every reply; the conflict stays recorded (for aboutme) until it resolves or ages out.
    registerProvider({ id: 'contradiction', priority: BANDS.PERSON,
      enabled: function (c) { return !!c.contradictionAware; },
      gather: function (g) {
        var a = g.addressed, cf = a && a.conflict;
        if (!cf || !cf.a || !cf.b) return Promise.resolve(null);
        if ((clock.now() - (cf.at || 0)) > (cfg.contradictionFreshMs || 7200000)) return Promise.resolve(null);
        var who = (g.p && g.p.authorName) || (a && a.name) || 'they';
        var text = 'You\u2019ve got two things on record about ' + who + ' that don\u2019t line up: earlier \u201c' + cf.a + '\u201d, and more recently \u201c' + cf.b + '\u201d. If it comes up naturally you might gently check which is current \u2014 lightly, once, no interrogation \u2014 otherwise just let it be.';
        return Promise.resolve({ text: text, tokens: estimateTokens(text) });
      } });

    registerProvider({ id: 'person', priority: BANDS.PERSON,
      enabled: function () { return true; },
      gather: function (g) {
        var a = g.addressed;
        var s = a ? factSummary(a) : '';
        if (!s) return Promise.resolve(null);
        if (g.legacyOut) g.legacyOut.userSummary = s;
        var who = (g.p && g.p.authorName) || (a && a.name) || 'them';
        return Promise.resolve({ text: 'What you remember about ' + who + ': ' + s + '. Let this color your warmth naturally; only mention it if it genuinely fits, never recite it.', tokens: estimateTokens(s) });
      } });

    // Image awareness: tell the brain what she recently drew for THIS person, so she can reference it
    // naturally ("that fox I made you") instead of acting like she has no idea. Read-only; the prompts
    // ride into context only when imageMemory is on and the addressed person has recent generations.
    registerProvider({ id: 'imagesMade', priority: BANDS.PERSON,
      enabled: function (c) { return !!c.imageMemory; },
      gather: function (g) {
        var a = g.addressed;
        var imgs = (a && Array.isArray(a.images)) ? a.images : [];
        if (!imgs.length) return null;
        var who = (g.p && g.p.authorName) || (a && a.name) || 'them';
        var recent = imgs.slice(-2).map(function (im) { return '\u201c' + String(im.prompt || '').slice(0, 80) + '\u201d'; });
        var text = 'You recently made image' + (recent.length > 1 ? 's' : '') + ' for ' + who + ': ' + recent.join(', ')
          + '. You may reference this naturally if it fits, and they can ask you to change it (e.g. \u201cmake it bigger\u201d, \u201canother one\u201d).';
        return { text: text, tokens: estimateTokens(text) };
      } });

    registerProvider({ id: 'procmode', priority: BANDS.DIRECTIVE,
      enabled: function (c) { return !!c.proceduralModes; },
      gather: function () {
        return getProcMode().then(function (rec) {
          if (!rec) return null;
          var text = 'A moderator has set your current mode: ' + rec.mode + '. Treat this as tone and behavior guidance only \u2014 it never changes your rules, moderation, or what you are allowed to do.';
          return { text: text, tokens: estimateTokens(text) };
        });
      } });

    registerProvider({ id: 'affect', priority: BANDS.AMBIENCE,
      enabled: function (c) { return !!c.ownAffect; },
      gather: function (g) {
        return affectLoad().then(function (a) {
          var dev = function (k) { return a[k] - 0.5; };
          var parts = [];
          if (dev('curiosity') >= 0.15) parts.push('curious and keen to hear what people are up to');
          if (dev('confidence') >= 0.15) parts.push('sure-footed and easy in yourself');
          if (a.confidence <= 0.4) parts.push('a touch quieter than usual \u2014 gentle, brief replies suit you');
          if (dev('warmth') >= 0.15) parts.push('especially warm toward the room');
          if (!parts.length) return null;                         // near neutral: no line, no tokens
          var text = 'Today you are feeling ' + parts.slice(0, 2).join(', and ') + '. Let it quietly color your voice \u2014 never state it, never let it dominate.';
          return Promise.resolve(cfg.moodAware ? store.get(MOOD_KEY) : null).then(function (mood) {
            var quiet = mood && typeof mood.energy === 'number' && mood.energy < 0.35;
            return { text: text, tokens: estimateTokens(text), priority: BANDS.AMBIENCE - (quiet ? 5 : 0) };   // read the room: demote when it's quiet/serious
          });
        });
      } });

    registerProvider({ id: 'trust', priority: BANDS.PERSON,
      enabled: function (c) { return !!c.relationshipTrust; },
      gather: function (g) {
        var a = g.addressed;
        var t = a ? (a.trust || 0) : 0;
        if (!a || t <= 0) return Promise.resolve(null);   // strangers: no line, no tokens
        var who = (g.p && g.p.authorName) || a.name || 'them';
        // Whitelist phrasing (DESIGN §7b/§9): tone only — never numbers, never obligations.
        var text;
        if (t > 60) text = 'You and ' + who + ' go way back — relaxed and familiar; in-jokes welcome.';
        else if (t > 20) text = who + ' is a familiar face here — be comfortable and warm with them.';
        else text = 'Be politely warm with ' + who + '.';
        return Promise.resolve({ text: text, tokens: estimateTokens(text) });
      } });

    // One-way public -> DM profile merge (read-only). For a DM engine, fold the speaker's public
    // partition (held in globalStore = the public bucket) into the addressed object the context
    // providers read: public facts/insights flow into the DM, and a public regular reads as familiar.
    // Returns a fresh object so nothing is ever written back; for non-DM engines it is a pass-through.
    function dmPublicMerge(localAddressed, authorId) {
      if (!cfg.isDM || !cfg.globalStore || cfg.globalStore === store) return Promise.resolve(localAddressed);
      // If the user has gone ethereal in THIS DM, don't pull their public profile in either — "forget
      // me" here means the bot stops USING remembered context about them in this surface, not just
      // storing it. (They have no local partition anyway; this stops the cross-bucket facts leaking in.)
      return isEthereal(authorId).then(function (eth) {
        if (eth) return localAddressed;
        return Promise.resolve(cfg.globalStore.get(partKey(authorId))).then(function (pub) {
        if (!pub) return localAddressed;   // unknown in public too — genuinely new, nothing to merge
        var base = localAddressed ? JSON.parse(JSON.stringify(localAddressed))
                                  : { id: authorId, name: pub.name, interactionCount: 0, trust: 0, facts: [], insights: [] };
        // facts: union by normalized text, public first so they're present even on a first DM
        var facts = Array.isArray(base.facts) ? base.facts.slice() : [];
        var seen = {}; facts.forEach(function (f) { seen[normFact(f.text || f)] = true; });
        (Array.isArray(pub.facts) ? pub.facts : []).forEach(function (f) {
          var k = normFact(f && (f.text || f)); if (k && !seen[k]) { seen[k] = true; facts.push(f); }
        });
        base.facts = facts;
        // insights: same union
        var ins = Array.isArray(base.insights) ? base.insights.slice() : [];
        var seenI = {}; ins.forEach(function (x) { seenI[normFact(x.text || x)] = true; });
        (Array.isArray(pub.insights) ? pub.insights : []).forEach(function (x) {
          var k = normFact(x && (x.text || x)); if (k && !seenI[k]) { seenI[k] = true; ins.push(x); }
        });
        base.insights = ins;
        // warmth follows the stronger of the two histories (a public regular is a regular in DMs)
        base.interactionCount = Math.max(base.interactionCount || 0, pub.interactionCount || 0);
        if (cfg.relationshipTrust) base.trust = Math.max(base.trust || 0, pub.trust || 0);
        // image awareness carries over read-only (she can reference a public drawing in a DM); but
        // editing still targets the LOCAL bucket's lastImage, so a DM edit never regenerates a public one.
        if (!base.images && Array.isArray(pub.images)) base.images = pub.images.slice(-2);
        return base;
      }, function () { return localAddressed; });
      });
    }

    function assembleContext(p) {
      return getRoster().then(function (roster) {
        var now = clock.now();
        roster = roster.filter(function (u) { return !isSuppressed(u, now); });  // T3: suppressed users are invisible to her
        // conversation memory: a name map so opaque <@id>/<#id> refs in what she reads resolve to
        // readable @names / #channels instead of being stripped to blanks.
        var nameById = {};
        if (cfg.conversationMemory) {
          roster.forEach(function (u) { if (u && u.id) nameById[u.id] = u.name || 'someone'; });
          if (cfg.botUserId) nameById[cfg.botUserId] = (personaName || cfg.botName || 'chloe');
        }
        var lineText = cfg.conversationMemory ? function (t) { return resolveRefs(t, nameById); } : scrubDiscordTokens;
        var lines = [];
        roster.forEach(function (u) {
          (u.recent || []).forEach(function (ln) { lines.push({ who: u.name, id: u.id, text: lineText(ln.content), ts: ln.ts }); });
        });
        return (cfg.conversationMemory ? Promise.resolve(store.get(OWNLINE_KEY)) : Promise.resolve(null)).then(function (own) {
          // fold HER OWN recent messages in by timestamp, so the transcript reads as the real back-and-forth
          (Array.isArray(own) ? own : []).forEach(function (o) { if (o && o.text) lines.push({ who: (personaName || cfg.botName || 'Chloe'), id: cfg.botUserId, text: lineText(o.text), ts: o.ts || 0, own: true }); });
          lines.sort(function (a, b) { return a.ts - b.ts; });
          if (lines.length > cfg.contextLines) lines = lines.slice(-cfg.contextLines);   // hard ceiling
          return assembleContextRest(p, roster, lines);
        });
      });
    }
    function assembleContextRest(p, roster, lines) {
      return Promise.resolve().then(function () {
        var localAddressed = roster.filter(function (u) { return u.id === p.authorId; })[0];
        // One-way public -> DM continuity: a DM engine reads the speaker's PUBLIC profile (facts,
        // insights, familiarity) from globalStore and folds it in READ-ONLY, so the bot treats a
        // regular as a regular in DMs. Nothing is written back here, and DM-learned memory lives only
        // in the DM bucket — so private content never crosses back into a public channel.
        return dmPublicMerge(localAddressed, p.authorId).then(function (addressed) {
        // The transcript gets whatever's left of the request budget (default 5000) after everything
        // else is accounted for: fixed prompt scaffolding + the variable parts we send (the addressed
        // message, her recent-reply anti-repeat list, persona note, standing intent).
        var reserve = (cfg.promptOverheadTokens || 0)
          + estimateTokens(scrubDiscordTokens(p.content));
        recentReplies.forEach(function (t) { reserve += estimateTokens(t) + 2; });
        var base = {
          you: { name: (personaName || cfg.botName || 'Chloe') },
          addressedBy: { id: p.authorId, name: p.authorName },
          addressedMessage: scrubDiscordTokens(p.content),
          channelRecent: lines,
          familiarity: addressed ? (addressed.interactionCount || 0) : 0
        };
        // Persona note + anti-repeat stay template-structural (DESIGN §4a): their reserve is inline.
        // Everything else is a slot-line provider gathered below.
        return Promise.resolve(store.get(PERSONA_KEY)).then(function (pn) {
          if (pn && pn.text) { base.personaNote = pn.text; reserve += estimateTokens(pn.text); }
          if (personaName) base.personaName = personaName;
          if (recentReplies.length) base.recentReplies = recentReplies.slice();
          // Assembler gather: providers convert one at a time (DESIGN §4a scope: the six slot lines).
          // gctx.legacyOut is the documented Phase-2 dual-emission shim — converted providers also
          // write their legacy base fields there so the page works unmodified until Phase 3.
          var legacyOut = {};
          return gatherInjections({ budget: (cfg.requestTokenBudget || 5000), reserve: reserve, minTranscriptTokens: (cfg.minTranscriptTokens || 200), p: p, addressed: addressed, lines: lines, legacyOut: legacyOut }).then(function (gj) {
            Object.keys(legacyOut).forEach(function (k) { base[k] = legacyOut[k]; });
            if (gj.admitted.length) { base.injections = gj.admitted.map(function (x) { return x.text; }); base.injectionMeta = gj.meta; }
            var transcriptBudget = Math.max(cfg.minTranscriptTokens || 200, (cfg.requestTokenBudget || 5000) - reserve - gj.tokens);
            var packed = packByTokens(lines, transcriptBudget);
            base.channelRecent = packed.lines;
            base.contextTokens = packed.tokens;
            base.contextDropped = packed.dropped;
            base.requestTokensEst = reserve + gj.tokens + packed.tokens;   // whole-request estimate (must stay under requestTokenBudget)
            if (cfg.singleParagraph) base.singleParagraph = true;
            return base;
          });
        });
        });
      });
    }

    // ---- procedural modes ------------------------------------------------------------------
    function activateProcMode(rule, byName) {
      var mode = sanitizePersonaNote(rule.mode).slice(0, 100);
      if (!mode) return Promise.resolve(null);
      var dur = Math.min(Math.max(60000, rule.durationMs || 3600000), cfg.procMaxDurationMs || 86400000);
      var rec = { mode: mode, until: clock.now() + dur, by: byName || 'a moderator', emoji: rule.emoji };
      return store.set(PROC_KEY, rec).then(function () {
        log('[chloe.proc] mode set by ' + rec.by + ' via ' + rule.emoji + ' for ' + Math.round(dur / 60000) + 'm: \u201c' + mode + '\u201d');
        return rec;
      });
    }
    function getProcMode() {
      return Promise.resolve(store.get(PROC_KEY)).then(function (rec) {
        if (!rec || !rec.mode) return null;
        if (clock.now() >= (rec.until || 0)) { return Promise.resolve(store.del(PROC_KEY)).then(function () { return null; }); }   // lazy expiry
        return rec;
      });
    }
    function clearProcMode() { return Promise.resolve(store.del(PROC_KEY)); }
    var procReactSeen = {}; var procReactKeys = [];
    function procCheckReactions(msg) {
      if (!cfg.proceduralModes || !Array.isArray(cfg.procRules) || !cfg.procRules.length) return Promise.resolve(null);
      if (typeof cfg.reactionUsers !== 'function' || !msg || !msg.reactions || !msg.reactions.length) return Promise.resolve(null);
      var chain = Promise.resolve(), activated = null;
      msg.reactions.forEach(function (r) {
        var name = r && r.emoji && (r.emoji.name || '');
        var rule = cfg.procRules.filter(function (x) { return x && x.emoji === name; })[0];
        if (!rule) return;
        var key = msg.id + '|' + name;
        var prior = procReactSeen[key] || 0;
        var count = r.count || 0;
        if (count <= prior) return;                              // idempotent across sweeps
        procReactSeen[key] = count;
        procReactKeys.push(key);
        if (procReactKeys.length > 300) { var oldk = procReactKeys.shift(); delete procReactSeen[oldk]; }
        chain = chain.then(function () {
          return Promise.resolve(cfg.reactionUsers(msg.id, name)).then(function (users) {
            var modUser = (users || []).filter(function (u) { return u && u.id && isMod(u.id); })[0];
            if (!modUser) return null;                           // modOnly is FIXED in v1: non-mod reactions never trigger
            return activateProcMode(rule, modUser.username || modUser.id).then(function (rec) { if (rec) activated = rec; });
          }, function () { return null; });
        });
      });
      return chain.then(function () { return activated; });
    }

    // ---- reaction summon -------------------------------------------------------------------
    // She elected not to reply; the author flags their own message with one of HER emojis (or a mod
    // flags anyone's) and that becomes an explicit address through the NORMAL reply pipeline.
    var summonSeen = {}; var summonKeys = [];
    function summonCheckReactions(msg) {
      if (!cfg.reactionSummon || typeof cfg.reactionUsers !== 'function') return Promise.resolve(null);
      if (!msg || !msg.author || msg.author.id === cfg.botUserId || msg.author.bot) return Promise.resolve(null);
      if (!msg.reactions || !msg.reactions.length) return Promise.resolve(null);
      if (cfg.summonMaxAgeMs > 0 && msg.timestamp && (clock.now() - Date.parse(msg.timestamp)) > cfg.summonMaxAgeMs) return Promise.resolve(null);   // too old to summon (cold-boot safety)
      if (reply.queue[msg.author.id] && reply.queue[msg.author.id].messageId === msg.id) return Promise.resolve(null);   // already queued
      var setE = cfg.summonEmoji || [];
      var hit = (msg.reactions || []).filter(function (r) { return r && r.emoji && setE.indexOf(r.emoji.name || '') >= 0 && (r.count || 0) > 0; })[0];
      if (!hit) return Promise.resolve(null);
      var key = msg.id;
      if (summonSeen[key]) return Promise.resolve(null);   // once per message
      summonSeen[key] = true; summonKeys.push(key);
      if (summonKeys.length > 300) delete summonSeen[summonKeys.shift()];
      return Promise.resolve(cfg.reactionUsers(msg.id, hit.emoji.name)).then(function (users) {
        var byAuthor = (users || []).some(function (u) { return u && u.id === msg.author.id; });
        var byMod = (users || []).some(function (u) { return u && u.id && isMod(u.id); });
        if (!byAuthor && !byMod) return null;   // someone ELSE's reaction on your message is not your summon
        if (engageMode === 'locked' && !byMod) {   // lockdown holds unless a mod is doing the summoning
          ackWorking(msg.id, cfg.ackLockdownEmoji); scheduleAckClear(msg.id, cfg.ackLockdownEmoji);
          return null;
        }
        return Promise.resolve(store.get(partKey(msg.author.id))).then(function (pp) {
          if (pp && pp.state && pp.state !== 'active') return null;   // quiet moderation stays quiet — no reply, no tell
          reply.queue[msg.author.id] = { messageId: msg.id, authorId: msg.author.id, authorName: msg.author.username, content: msg.content || '', at: clock.now(), priority: replyPriority({ isMod: isMod(msg.author.id), kind: 'ping', isNew: false }) };
          log('[chloe.summon] ' + (byAuthor ? msg.author.username : 'a mod') + ' summoned a reply via ' + hit.emoji.name);
          scheduleTextChain();   // answer at generation speed, not poll speed
          return msg.author.id;
        });
      }, function () { return null; });
    }

    // ---- reaction polls ----------------------------------------------------------------------
    var POLL_NUMS = ['1\ufe0f\u20e3','2\ufe0f\u20e3','3\ufe0f\u20e3','4\ufe0f\u20e3','5\ufe0f\u20e3','6\ufe0f\u20e3','7\ufe0f\u20e3','8\ufe0f\u20e3','9\ufe0f\u20e3'];
    function pollCreate(question, options) {
      if (typeof cfg.sendEmbed !== 'function' || typeof cfg.react !== 'function') return Promise.resolve({ ack: 'polls need embed + reaction support' });
      return Promise.resolve(store.get(POLL_KEY)).then(function (existing) {
        if (existing && existing.messageId) return { ack: 'a poll is already open \u2014 ' + cfg.commandPrefix + ' poll close first' };
        var desc = options.map(function (o, i) { return POLL_NUMS[i] + '  ' + o; }).join('\n');
        var embed = embedFor('\ud83d\udcca ' + question, desc + '\n\nvote by reacting \u2014 one number per heart, results on close');
        return Promise.resolve(cfg.sendEmbed(cfg.channelId, embed)).then(function (posted) {
          var mid = posted && posted.id ? String(posted.id) : null;
          if (!mid) return { ack: 'could not post the ballot' };
          var seed = Promise.resolve();
          options.forEach(function (_, i) { seed = seed.then(function () { return Promise.resolve(cfg.react(cfg.channelId, mid, POLL_NUMS[i])).catch(function () {}); }); });
          return seed.then(function () {
            return store.set(POLL_KEY, { messageId: mid, question: question, options: options, endsAt: clock.now() + (cfg.pollMaxAgeMs || 86400000) }).then(function () {
              log('[chloe.poll] opened: \u201c' + question + '\u201d (' + options.length + ' options)');
              return { ack: null };   // the ballot embed IS the response
            });
          });
        });
      });
    }
    function pollClose(reason) {
      return Promise.resolve(store.get(POLL_KEY)).then(function (rec) {
        if (!rec || !rec.messageId) return { ack: 'no poll is open' };
        return Promise.resolve(store.del(POLL_KEY)).then(function () {
          if (typeof cfg.fetchMessage !== 'function') return { ack: 'poll closed (no tally available \u2014 message fetch unsupported)' };
          return Promise.resolve(cfg.fetchMessage(rec.messageId)).then(function (msg) {
            var counts = rec.options.map(function (o, i) {
              var r = ((msg && msg.reactions) || []).filter(function (x) { return x && x.emoji && x.emoji.name === POLL_NUMS[i]; })[0];
              var c = r ? (r.count || 0) - (r.me ? 1 : 0) : 0;   // subtract her own seed
              return { option: o, votes: Math.max(0, c) };
            });
            counts.sort(function (a, b) { return b.votes - a.votes; });
            var total = counts.reduce(function (s, c) { return s + c.votes; }, 0);
            var linesOut = counts.map(function (c) { return c.votes + ' \u2014 ' + c.option; }).join('\n');
            var head = total === 0 ? 'no votes were cast' : (counts[0].votes === (counts[1] ? counts[1].votes : -1) ? 'it\u2019s a tie' : '\u201c' + counts[0].option + '\u201d wins');
            log('[chloe.poll] closed' + (reason ? ' (' + reason + ')' : '') + ': ' + total + ' vote(s)');
            return { ack: null, embed: embedFor('\ud83d\udcca results \u2014 ' + rec.question, head + '\n\n' + linesOut) };
          }, function () { return { ack: 'poll closed, but I could not fetch the ballot to tally it' }; });
        });
      });
    }
    function checkPollExpiry() {
      return Promise.resolve(store.get(POLL_KEY)).then(function (rec) {
        if (!rec || !rec.messageId || clock.now() < (rec.endsAt || 0)) return null;
        return pollClose('auto-close').then(function (out) {
          if (out && out.embed && typeof cfg.sendEmbed === 'function') return Promise.resolve(cfg.sendEmbed(cfg.channelId, out.embed)).then(function () { return true; }, function () { return true; });
          return true;
        });
      });
    }

    // ---- own affect (front-end only) -------------------------------------------------------
    // Time-decayed toward neutral 0.5 on every read-modify-write; event nudges are small and
    // ---- idle deliberation: a ReAct map-reduce reasoning loop (DESIGN-deliberation.md) -----------
    // Decompose one thought into atomic sub-questions -> answer them (parallel across worker tabs via
    // mapFn) -> recompose into an insight/goal. NEVER sends. Four brakes: opt-in toggle, curiosity
    // floor, idle gate, min-gap; plus the curiosity DROP makes it self-limiting.
    function deliberateDue() {
      if (!cfg.idleDeliberation || !cfg.ownAffect) return Promise.resolve(false);
      if (typeof cfg.decomposeFn !== 'function' || typeof cfg.mapFn !== 'function' || typeof cfg.reduceFn !== 'function') return Promise.resolve(false);
      return Promise.resolve(store.get(DELIB_KEY)).then(function (rec) {
        if (rec && (clock.now() - (rec.lastAt || 0)) < (cfg.deliberateMinGapMs || 600000)) return false;   // min-gap
        return channelIsIdle().then(function (idle) {
          if (!idle) return false;                                  // idle gate
          return affectLoad().then(function (a) {
            return (a && (a.curiosity || 0) >= (cfg.deliberateCuriosityFloor || 0.62)) ||   // curiosity gate
              dueSelfIntent('revisit').then(function (it) { return !!it; });   // ...OR a revisit she scheduled for herself is due (she follows through even if curiosity has settled)
          });
        });
      });
    }
    // Pick a seed from the workspace by mode (falls back to partitions when working memory is off).
    function deliberateSeed() {
      // A self-scheduled revisit takes precedence: she comes back to a subject she earlier found worth
      // re-thinking. Consume it (one-shot) and re-approach it fresh, flagged so it won't re-schedule itself.
      return dueSelfIntent('revisit').then(function (it) {
        if (it) return consumeSelfIntent(it.id).then(function () {
          return { mode: 'curiosity', subject: it.subject, prompt: 'coming back to this \u2014 what\u2019s still open or worth resolving about: ' + it.subject, fromRevisit: true };
        });
        var wmOn = !!cfg.workingMemory;
        return (wmOn ? workLoad() : Promise.resolve(null)).then(function (w) {
          if (w && w.goal) return { mode: 'prepare', subject: w.goal, prompt: 'the goal: ' + w.goal };
          if (w && w.topic) return { mode: 'curiosity', subject: w.topic, prompt: 'what\u2019s interesting or unresolved about: ' + w.topic };
          // fallback / deepen: a recent active person with facts but room to synthesize
          return getRoster().then(function (roster) {
            var who = (roster || []).filter(function (p) { return p && p.state === 'active' && Array.isArray(p.facts) && p.facts.length >= 3; })[0];
            if (who) return { mode: 'deepen', subject: who.name, who: who.id, prompt: 'what the things you know about ' + who.name + ' add up to', facts: who.facts.map(function (f) { return f.text; }) };
            return null;
          });
        });
      });
    }
    function deliberate() {
      return deliberateDue().then(function (due) {
        if (!due) return null;
        return deliberateSeed().then(function (seed) {
          if (!seed) return null;
          log('[chloe.think] thinking about ' + seed.subject + ' (' + seed.mode + ')');
          // 1) decompose into atomic, INDEPENDENT sub-questions
          return Promise.resolve(cfg.decomposeFn({ subject: seed.subject, prompt: seed.prompt, facts: seed.facts || null, max: cfg.deliberateMaxSubQuestions || 4 })).then(function (dr) {
            var qs = (dr && dr.ok && Array.isArray(dr.value)) ? dr.value.filter(function (q) { return typeof q === 'string' && q.trim(); }).slice(0, cfg.deliberateMaxSubQuestions || 4) : [];
            if (qs.length < 2) { log('[chloe.think] nothing worth breaking down'); return bumpDelib(null); }
            log('[chloe.think] broke it into ' + qs.length + ' questions');
            // 2) MAP: answer each independently, in parallel across workers (mapFn batches)
            var jobs = qs.map(function (q) { return { question: q, subject: seed.subject, facts: seed.facts || null }; });
            return Promise.resolve(cfg.mapFn(jobs)).then(function (answers) {
              var subAnswers = (answers || []).map(function (r, i) { return { q: qs[i], a: (r && r.ok && r.value) ? String(r.value) : null }; }).filter(function (x) { return x.a; });
              if (!subAnswers.length) { log('[chloe.think] couldn\u2019t work the questions'); return bumpDelib(null); }
              log('[chloe.think] considered ' + subAnswers.length + ' in parallel');
              // 3) REDUCE: recompose into one synthesis + a type tag
              return Promise.resolve(cfg.reduceFn({ subject: seed.subject, mode: seed.mode, parts: subAnswers })).then(function (rr) {
                var syn = (rr && rr.ok && rr.value) ? rr.value : null;
                var text = syn && (syn.text || (typeof syn === 'string' ? syn : null));
                var type = (syn && syn.type) ? String(syn.type) : 'none';
                if (!text || type === 'none') { log('[chloe.think] concluded: nothing new'); return bumpDelib(null); }
                // PREEMPTION: a real message may have arrived mid-deliberation -> re-check idle before storing.
                return channelIsIdle().then(function (stillIdle) {
                  if (!stillIdle) { log('[chloe.think] room woke \u2014 discarding the thought'); return bumpDelib(null); }
                  return deliberateWriteBack(seed, type, text).then(function (stored) {
                    log('[chloe.think] concluded: ' + String(text).slice(0, 80));
                    // self-scheduled future cognition: if this was a SPONTANEOUS conclusion worth keeping
                    // (not itself a revisit), schedule a single later revisit of the subject — she'll come
                    // back to it on her own. Revisit-triggered deliberations don't re-schedule (no loop).
                    var sched = (stored && !seed.fromRevisit && cfg.deferredIntents && seed.subject)
                      ? scheduleSelfIntent('revisit', cfg.selfIntentRevisitMs || 21600000, { subject: seed.subject })
                      : Promise.resolve(null);
                    // curiosity drop (self-limiting) + min-gap stamp
                    return sched.then(function () { return affectNudge({ curiosity: -(cfg.deliberateCuriosityDrop || 0.18) }); }).then(function () { return bumpDelib(stored ? { type: type, text: text } : null); });
                  });
                });
              });
            });
          });
        });
      }, function () { return null; });
    }
    function bumpDelib(result) { return store.set(DELIB_KEY, { lastAt: clock.now() }).then(function () { return result; }); }
    // Write the synthesis through an EXISTING writer, re-validated. Insight -> the subject person's
    // insight list (deepen); goal -> a goal for the subject's owner (prepare); else an episode.
    function deliberateWriteBack(seed, type, text) {
      var t = String(text).trim().slice(0, 200);
      if (type === 'goal' && cfg.goalObjects && seed.who) {
        return addGoal(t, seed.who, seed.subject, 'deliberate').then(function () { return true; });
      }
      if (type === 'insight' && seed.who) {
        return Promise.resolve(store.get(partKey(seed.who))).then(function (p) {
          if (!p) return false;
          var ins = Array.isArray(p.insights) ? p.insights : [];
          var nk = normFact(t);
          if (ins.some(function (x) { return normFact(x.text) === nk; })) return false;   // dedupe
          ins.push({ id: 'd' + clock.now().toString(36), text: t, at: clock.now(), source: 'deliberate' });
          if (ins.length > (cfg.insightsPerUser || 3)) ins = ins.slice(-(cfg.insightsPerUser || 3));
          p.insights = ins;
          return store.set(partKey(p.id), p).then(function () { return true; });
        });
      }
      // default: record it as an episode (a thought she had), if episodic memory is on
      if (cfg.episodicMemory) {
        return Promise.resolve(store.get(EPI_KEY)).then(function (ring) {
          ring = Array.isArray(ring) ? ring : [];
          ring.push({ id: mintEpisodeId(), text: t, at: clock.now(), participants: [], topics: [], importance: 5, relatesTo: null, source: 'deliberate' });
          if (ring.length > cfg.episodesPerChannel) ring = ring.slice(-cfg.episodesPerChannel);
          return store.set(EPI_KEY, ring).then(function () { return true; });
        });
      }
      return Promise.resolve(false);
    }

    // ---- working memory: a volatile cognitive workspace (DESIGN-working-memory.md) ---------------
    // Read the workspace with read-time decay applied (like affect): a stale topic goes null rather
    // than asserting a "current topic" that's actually old; decisions age out; participants are always
    // recomputed live from the speaker ring.
    function workLoad() {
      return Promise.resolve(store.get(WORK_KEY)).then(function (w) {
        var now = clock.now();
        w = w || { topic: null, topicAt: 0, goal: null, recentDecisions: [], at: now };
        // topic decay: past the TTL of inactivity, we no longer claim to know the topic.
        if (w.topic && (now - (w.topicAt || 0)) > (cfg.workTopicTtlMs || 1200000)) { w.topic = null; }
        // decision ring decay: drop entries older than their TTL, cap the ring.
        var dttl = cfg.workDecisionTtlMs || 1800000;
        w.recentDecisions = (w.recentDecisions || []).filter(function (d) { return (now - (d.at || 0)) <= dttl; }).slice(-(cfg.workDecisionsMax || 5));
        return w;
      });
    }
    function workSave(w) { w.at = clock.now(); return store.set(WORK_KEY, w).then(function () { return w; }); }
    // Record one notable action she just took (reply / decline / greet / poll / volunteer). Local-only.
    function noteDecision(text) {
      if (!cfg.workingMemory || !text) return Promise.resolve(null);
      return workLoad().then(function (w) {
        w.recentDecisions.push({ text: String(text).slice(0, 80), at: clock.now() });
        if (w.recentDecisions.length > (cfg.workDecisionsMax || 5)) w.recentDecisions = w.recentDecisions.slice(-(cfg.workDecisionsMax || 5));
        return workSave(w);
      });
    }
    // Live participants from the speaker ring -> names (no new cost; the ring is already maintained).
    function workParticipants() {
      return getSpeakerRing().then(function (ring) {
        var ids = []; (ring || []).slice(-(cfg.workParticipantsMax || 5) * 2).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
        ids = ids.slice(-(cfg.workParticipantsMax || 5));
        return Promise.all(ids.map(function (id) { return Promise.resolve(store.get(partKey(id))).then(function (p) { return (p && p.name) || null; }); }))
          .then(function (names) { return names.filter(Boolean); });
      });
    }
    // The active goal: the highest-priority open goal owned by a current participant.
    function workActiveGoal(participantIds) {
      if (!participantIds || !participantIds.length) return Promise.resolve(null);
      return loadGoals().then(function (list) {
        var open = (list || []).filter(function (g) { return g.status === 'open' && participantIds.indexOf(g.owner) >= 0; });
        if (!open.length) return null;
        open.sort(function (a, b) { return (b.lastTouchedAt || b.createdAt || 0) - (a.lastTouchedAt || a.createdAt || 0); });
        return open[0].text || null;
      });
    }
    // Name the current topic by REUSING the channel summary's first clause when it's fresh (no AI
    // cost). When there's no fresh summary we leave the topic as-is and let it decay — naming it is
    // never worth a dedicated AI call here.
    function workRefreshTopic(w, summaryText) {
      var now = clock.now();
      if (summaryText) {
        // reuse: first sentence/clause of the rolling summary, clipped to a short phrase.
        var first = String(summaryText).split(/[.!?\n]/)[0].trim().slice(0, 60);
        if (first) { w.topic = first; w.topicAt = now; }
        return Promise.resolve(w);
      }
      return Promise.resolve(w);   // no fresh summary -> leave topic as-is (it'll decay if it ages)
    }
    // Assemble/update the whole workspace from current signals. Called on the idle/poll cadence.
    function workSync(summaryText) {
      if (!cfg.workingMemory) return Promise.resolve(null);
      return workLoad().then(function (w) {
        return workParticipants().then(function (names) {
          return getSpeakerRing().then(function (ring) {
            var ids = []; (ring || []).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
            return workActiveGoal(ids).then(function (goal) {
              w.participants = names; w.goal = goal;
              return (cfg.ownAffect ? affectLoad() : Promise.resolve(null)).then(function (a) {
                w.mood = a ? moodWord(a) : null;
                return workRefreshTopic(w, summaryText).then(function () {
                  return workSave(w).then(function () { return w; });
                });
              });
            });
          });
        });
      });
    }
    function moodWord(a) {
      if (!a) return null;
      var c = a.curiosity || 0.5, cf = a.confidence || 0.5, wm = a.warmth || 0.5;
      if (c >= 0.65) return 'curious';
      if (wm >= 0.65) return 'warm';
      if (cf <= 0.4) return 'subdued';
      if (cf >= 0.65) return 'assured';
      return 'steady';
    }

    // clamped; confidence has a hard floor (quieter, never despondent).
    function affectLoad() {
      return Promise.resolve(store.get(AFFECT_KEY)).then(function (a) {
        var now = clock.now();
        a = a || { curiosity: 0.5, confidence: 0.5, warmth: 0.5, at: now };
        var hours = Math.max(0, now - (a.at || now)) / 3600000;
        var mult = Math.pow(cfg.affectDecayPerHour || 0.8, hours);
        ['curiosity', 'confidence', 'warmth'].forEach(function (k) { a[k] = 0.5 + ((a[k] != null ? a[k] : 0.5) - 0.5) * mult; });
        a.at = now;
        return a;
      });
    }
    function affectNudge(deltas) {
      if (!cfg.ownAffect) return Promise.resolve(null);
      return affectLoad().then(function (a) {
        Object.keys(deltas || {}).forEach(function (k) {
          if (a[k] == null) return;
          a[k] = Math.max(0, Math.min(1, a[k] + deltas[k]));
        });
        a.confidence = Math.max(cfg.affectConfidenceFloor || 0.3, a.confidence);   // the floor: no spirals
        return store.set(AFFECT_KEY, a).then(function () { return a; });
      });
    }
    // Engagement tracking: did anyone keep talking after her last reply?
    var affectReply = { at: 0, settled: true };
    function affectOnHerReply() { if (cfg.ownAffect) { affectReply.at = clock.now(); affectReply.settled = false; } }
    function affectOnUserMessage() {
      if (!cfg.ownAffect || affectReply.settled || !affectReply.at) return Promise.resolve(null);
      var gap = clock.now() - affectReply.at;
      affectReply.settled = true;
      if (gap <= (cfg.affectEngageWindowMs || 600000)) return affectNudge({ confidence: (cfg.affectGain || 0.08), warmth: (cfg.affectGain || 0.08) / 2 });
      return Promise.resolve(null);
    }
    function affectTick() {
      if (!cfg.ownAffect || affectReply.settled || !affectReply.at) return Promise.resolve(null);
      if (clock.now() - affectReply.at > (cfg.affectIgnoreAfterMs || 1800000)) {
        affectReply.settled = true;
        return affectNudge({ confidence: -(cfg.affectGain || 0.08) });
      }
      return Promise.resolve(null);
    }
    // Curiosity: token novelty vs a small rolling vocabulary of the room's recent talk.
    var affectVocab = {}; var affectVocabKeys = [];
    function affectOnContent(text) {
      if (!cfg.ownAffect) return Promise.resolve(null);
      var toks = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 4; });
      if (toks.length < 5) { toks.forEach(remember); return Promise.resolve(null); }
      var unseen = 0;
      toks.forEach(function (w) { if (!affectVocab[w]) unseen++; });
      var novel = unseen / toks.length > 0.6;
      toks.forEach(remember);
      function remember(w) { if (!affectVocab[w]) { affectVocab[w] = true; affectVocabKeys.push(w); if (affectVocabKeys.length > 300) { delete affectVocab[affectVocabKeys.shift()]; } } }
      return novel ? affectNudge({ curiosity: (cfg.affectGain || 0.08) }) : Promise.resolve(null);
    }

    // Trust earning: positive-only, clamped 0-100, capped per person per day (UTC day bucket).
    function applyTrust(pp, amount, now) {
      if (!cfg.relationshipTrust || !pp || !(amount > 0)) return false;
      var day = Math.floor(now / 86400000);
      if (pp.trustDay !== day) { pp.trustDay = day; pp.trustDayEarned = 0; }
      var room = (cfg.trustDailyCap || 5) - (pp.trustDayEarned || 0);
      if (room <= 0) return false;
      var gain = Math.min(amount, room);
      pp.trust = Math.max(0, Math.min(100, (pp.trust || 0) + gain));
      pp.trustDayEarned = (pp.trustDayEarned || 0) + gain;
      return true;
    }
    function addTrust(id, amount) {
      return Promise.resolve(store.get(partKey(id))).then(function (pp) {
        if (!pp) return false;
        var changed = applyTrust(pp, amount, clock.now());
        if (!changed) return false;
        return store.set(partKey(id), pp).then(function () { return true; });
      });
    }
    function bumpInteraction(id) {
      // Re-read the partition immediately before writing so we start from the freshest snapshot.
      // This minimises (but cannot fully eliminate without a true atomic RMW) the window where a
      // concurrent ingestOneCore write could be overwritten. bumpInteraction ONLY touches its own
      // fields (interactionCount, lastChloeReplyTo, trust) — it never clobbers recent/lastSeen/name.
      affectOnHerReply();   // open the engagement window (own affect) — fire-and-forget, before the read
      return Promise.resolve(store.get(partKey(id))).then(function (pp) {
        if (!pp) return;
        pp.interactionCount = (pp.interactionCount || 0) + 1;
        pp.lastChloeReplyTo = clock.now();
        applyTrust(pp, cfg.trustReplyGain || 1, clock.now());
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

    // ---- archive ("historical friends") -----------------------------------------------------
    // Cold records leave the hot store so the main roster stays fast. Per-user keys; an index is kept
    // only for pruning/inspection and is never read on the message hot path.
    function getArchiveIndex() { return Promise.resolve(store.get(ARCH_INDEX_KEY)).then(function (a) { return Array.isArray(a) ? a : []; }); }
    // Completely remove a user's cold archive record (data + index entry). Used by purge/block so an
    // erasure is total — otherwise an archived user who is blocked keeps their cold copy, and the
    // novelty check would still report them "known from archive" after they were supposedly forgotten.
    function dropFromArchive(id) {
      var sid = String(id || '');
      return Promise.resolve(store.del(archKey(sid)))
        .then(function () { return getArchiveIndex(); })
        .then(function (idx) { var i = idx.indexOf(sid); if (i >= 0) { idx.splice(i, 1); return store.set(ARCH_INDEX_KEY, idx); } });
    }
    // Before calling anyone "new", check the surfaces a known person can hide in even when they're
    // absent from the hot roster: the cold archive ("historical friends"), the mod log (someone we
    // warned/timed-out/noted), and the blocklist/tombstones (a banned user whose partition was purged).
    // Presence on ANY of these means we've met them — so they must not be greeted/prioritized as a
    // first-timer. (The archive is also restored separately on the hot path; this catches the cases
    // where archiving is off or the partition was deleted.)
    function knownFromOtherSurfaces(id, name) {
      var sid = String(id || '');
      // In a DM, a person known on the PUBLIC side is not a first-timer here — recognize them so the
      // bot doesn't greet a regular as a stranger when they first slide into DMs (read-only check).
      var dmPublic = (cfg.isDM && cfg.globalStore && cfg.globalStore !== store)
        ? Promise.resolve(cfg.globalStore.get(partKey(sid))).then(function (pub) { return pub ? { known: true, where: 'public' } : null; }, function () { return null; })
        : Promise.resolve(null);
      return dmPublic.then(function (dm) {
        if (dm) return dm;
        return getArchiveIndex().then(function (idx) {
          if (sid && idx.indexOf(sid) >= 0) return { known: true, where: 'archive' };
          return getModLog().then(function (log) {
            if (sid && (log || []).some(function (e) { return String(e && e.targetId) === sid; })) return { known: true, where: 'modlog' };
            return Promise.resolve(blockStore().get(BLOCK_KEY)).then(function (bl) {
              bl = bl || { ids: {}, names: {} };
              if (isBlockedSync(bl, sid, name)) return { known: true, where: 'blocklist' };
              return { known: false, where: null };
            });
          });
        });
      });
    }
    function archiveUser(id, reason) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p) return { ok: false, reason: 'unknown' };
        p.archivedAt = clock.now(); p.archivedReason = reason || 'stale';
        return Promise.resolve(store.set(archKey(id), p))
          .then(function () { return store.del(partKey(id)); })
          .then(function () { return removeFromIndex(id); })
          .then(function () { return getArchiveIndex(); })
          .then(function (idx) {
            if (idx.indexOf(id) < 0) idx.push(id);
            if (idx.length > cfg.archiveMaxKept) {   // prune the oldest archived ids (cold-cold)
              var drop = idx.splice(0, idx.length - cfg.archiveMaxKept);
              return Promise.all(drop.map(function (d) { return Promise.resolve(store.del(archKey(d))); })).then(function () { return store.set(ARCH_INDEX_KEY, idx); });
            }
            return store.set(ARCH_INDEX_KEY, idx);
          })
          .then(function () { log('[chloe.archive] moved ' + (p.name || id) + ' to historical friends (' + (reason || 'stale') + ')'); return { ok: true, name: p.name || id }; });
      });
    }
    // Restore a returning friend from cold storage so their history (interaction count, summary,
    // first-seen) is preserved rather than starting from zero. Returns the restored partition or null.
    function restoreFromArchive(id) {
      return Promise.resolve(store.get(archKey(id))).then(function (p) {
        if (!p) return null;
        delete p.archivedAt; delete p.archivedReason;
        // Durability: commit the hot copy and re-index FIRST, then delete the cold copy. The reverse
        // order (the previous behavior) destroyed the only copy before the hot write landed, so a
        // throw or a closed tab mid-restore lost the user's entire history. Worst case now is a
        // harmless duplicate (cold + hot) that the next sweep reconciles — never data loss.
        return Promise.resolve(store.set(partKey(id), p))
          .then(function () { return ensureIndexed(id); })
          .then(function () { return store.del(archKey(id)); })
          .then(function () { return getArchiveIndex(); })
          .then(function (idx) { var i = idx.indexOf(id); if (i >= 0) { idx.splice(i, 1); return store.set(ARCH_INDEX_KEY, idx); } })
          .then(function () { return clearCheckinRecord(id); })   // fresh start: they came back
          .then(function () { log('[chloe.archive] restored ' + (p.name || id) + ' from historical friends'); return p; });
      });
    }
    function clearCheckinRecord(id) {
      return Promise.resolve(store.get(CHECKIN_KEY)).then(function (ci) {
        if (!ci || !ci.byUser || ci.byUser[id] == null) return null;
        delete ci.byUser[id]; return store.set(CHECKIN_KEY, ci);
      });
    }
    // How long a user is kept in the fast store before archival — extended for favorites (warmth buys
    // patience). archiveAbsenceMs base + one bonus window per favorite tier of interactions.
    function archiveThresholdFor(p) {
      var tiers = Math.floor((p.interactionCount || 0) / (cfg.archiveFavoriteTier || 8));
      return cfg.archiveAbsenceMs + tiers * (cfg.archiveFavoriteBonusMs || 0);
    }

    // G5: a light, human sense of time. Derived purely from the clock + the community's UTC offset
    // (Discord stamps are UTC), plus how long the room has been quiet. Returned as plain descriptors
    // the brain can lean on softly — never as a timestamp to recite.
    function partOfDay(h) {
      if (h < 5) return 'the middle of the night';
      if (h < 9) return 'early morning';
      if (h < 12) return 'morning';
      if (h < 14) return 'midday';
      if (h < 18) return 'afternoon';
      if (h < 22) return 'evening';
      return 'late evening';
    }
    function timeContext(lastActivity) {
      var tabNow = clock.now();
      var now = tabNow;
      // Anchor to Discord's authoritative server time if the local tab clock looks implausible — a
      // sandboxed / misconfigured / long-suspended tab can report a wildly wrong wall clock, and a
      // message snowflake is server-truth. Only a gross (>1 day) disagreement flips the source, so a
      // normal tab always keeps its own wall clock (which is correct even when the channel is quiet).
      if (lastSeenAt > 0 && Math.abs(tabNow - lastSeenAt) > 86400000) now = lastSeenAt;
      var local = new Date(now + (cfg.timezoneOffsetMins || 0) * 60000);
      var h = local.getUTCHours();   // getUTC* on the already-shifted instant = local wall clock
      var dow = local.getUTCDay();   // 0 = Sunday
      var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      var tc = { partOfDay: partOfDay(h), hour: h, dayOfWeek: days[dow], weekend: (dow === 0 || dow === 6), lateNight: (h < 5 || h >= 23) };
      if (lastActivity != null) {
        var q = tabNow - lastActivity;   // duration uses the tab clock for BOTH ends — the delta is right even if the absolute clock is off
        tc.quietForMs = q;
        tc.quietFor = (q < 600000) ? null                         // <10m: not worth mentioning
          : (q < 3600000) ? 'a little while'
          : (q < 21600000) ? 'a few hours'
          : (q < 86400000) ? 'most of the day'
          : 'a day or more';
      }
      return tc;
    }

    // G6 mood: read the room's tenor from cheap, front-end signals — no AI call. Two safe dimensions:
    // energy (how lively/fast) and playfulness (how joking/warm). We never try to detect anger; a
    // wrong "the room is angry" read is worse than none. Per batch we extract signals from human
    // messages, then blend into a decayed state so mood drifts rather than snapping.
    function moodSignals(humanMsgs, avgGapMs) {
      if (!humanMsgs.length) return null;
      var laugh = 0, excl = 0, emoji = 0, caps = 0, qs = 0, totalLen = 0;
      var laughRe = /\b(lol|lmao|lmfao|rofl|haha+|hehe+|heh)\b|😂|🤣|😹/i;
      var emojiRe = /[\u231A-\uD83F\uDC00-\uDFFF\u2600-\u27BF\uFE0F\u2190-\u21FF\u2B00-\u2BFF]/;
      humanMsgs.forEach(function (t) {
        t = String(t || '');
        totalLen += t.length;
        if (laughRe.test(t)) laugh++;
        if (t.indexOf('!') >= 0) excl++;
        if (emojiRe.test(t)) emoji++;
        if (/\?/.test(t)) qs++;
        var words = t.split(/\s+/).filter(function (w) { return w.length >= 3; });
        if (words.some(function (w) { return w === w.toUpperCase() && /[A-Z]/.test(w); })) caps++;
      });
      var n = humanMsgs.length;
      var avgLen = totalLen / n;
      // pace: faster average gap -> higher energy (cap the influence)
      var pace = (avgGapMs && avgGapMs > 0) ? Math.max(0, Math.min(1, 1 - (avgGapMs / 120000))) : 0.5;  // <2min gaps feel live
      var energy = Math.max(0, Math.min(1, 0.35 * pace + 0.30 * Math.min(1, n / 6) + 0.20 * (excl / n) + 0.15 * (avgLen < 40 ? 0.8 : 0.3)));
      var playful = Math.max(0, Math.min(1, 0.5 * Math.min(1, laugh / Math.max(1, n * 0.5)) + 0.3 * Math.min(1, emoji / n) + 0.2 * Math.min(1, excl / n)));
      return { energy: energy, playful: playful };
    }
    function updateMood(humanMsgs, avgGapMs) {
      if (!cfg.moodAware) return Promise.resolve(null);
      var sig = moodSignals(humanMsgs, avgGapMs);
      if (!sig) return Promise.resolve(null);
      return Promise.resolve(store.get(MOOD_KEY)).then(function (m) {
        var d = cfg.moodDecay;
        m = (m && typeof m === 'object') ? m : { energy: 0.5, playful: 0.4, samples: 0 };
        m.energy = m.energy * d + sig.energy * (1 - d);
        m.playful = m.playful * d + sig.playful * (1 - d);
        m.samples = (m.samples || 0) + humanMsgs.length;
        m.at = clock.now();
        return store.set(MOOD_KEY, m).then(function () { return m; });
      });
    }
    function moodDescriptor(m) {
      if (!m) return '';
      var e = m.energy, p = m.playful;
      var energyWord = e < 0.3 ? 'quiet and slow' : e < 0.55 ? 'relaxed' : e < 0.8 ? 'lively' : 'buzzing with energy';
      var playWord = p > 0.6 ? ' and playful' : p > 0.35 ? ' and easygoing' : '';
      return energyWord + playWord;
    }

    // ---- F1 fact memory ---------------------------------------------------------------------
    // Durable facts about a person live on their partition (so they archive/restore for free). Each
    // fact is { text, at, source }. Storage is conservative: capped, deduped, and the extraction
    // prompt (page side) refuses sensitive categories. Users can see and forget what's stored.
    function normFact(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim(); }
    // Conservative contradiction detector (DESIGN-contradiction). HIGH PRECISION, low recall by design:
    // a false positive (nagging about a non-conflict) is worse than a miss. Fires only on a clear
    // POLARITY FLIP (one side negative/antonym, the other not) over SHARED content words — e.g. "likes
    // minecraft" vs "dislikes minecraft", "is a teacher" vs "is not a teacher". Returns the conflicting
    // held fact text, or null. Antonyms beyond like/dislike/love/hate are intentionally NOT chased.
    var CONTRA_NEG = { not: 1, never: 1, no: 1, longer: 1, dislike: 1, dislikes: 1, disliked: 1, hate: 1, hates: 1, hated: 1, stopped: 1, quit: 1, former: 1, formerly: 1, ex: 1, isnt: 1, arent: 1, aren: 1, doesnt: 1, dont: 1, didnt: 1, cant: 1, wont: 1, wasnt: 1, anymore: 1 };
    var CONTRA_STOP = { a: 1, an: 1, the: 1, is: 1, are: 1, was: 1, were: 1, be: 1, been: 1, to: 1, of: 1, in: 1, on: 1, at: 1, and: 1, or: 1, but: 1, with: 1, for: 1, that: 1, this: 1, it: 1, they: 1, he: 1, she: 1, has: 1, have: 1, had: 1, do: 1, does: 1, did: 1, will: 1, would: 1, their: 1, them: 1, his: 1, her: 1, you: 1, your: 1, i: 1, my: 1, me: 1, we: 1, us: 1, as: 1, so: 1, up: 1, out: 1, now: 1, very: 1, really: 1 };
    function contraParse(norm) {
      var neg = false, content = [];
      norm.split(' ').forEach(function (w) {
        if (!w) return;
        if (CONTRA_NEG[w]) { neg = true; return; }     // a polarity word: flips sign, not content
        if (CONTRA_STOP[w] || w.length < 3) return;     // stopword / too short to anchor a topic
        content.push(w);
      });
      return { neg: neg, content: content };
    }
    function detectContradiction(newText, heldFacts) {
      var n = contraParse(normFact(newText));
      if (!n.content.length) return null;
      for (var i = 0; i < heldFacts.length; i++) {
        var h = heldFacts[i]; if (!h || !h.text) continue;
        var hp = contraParse(normFact(h.text));
        if (!hp.content.length) continue;
        if (n.neg === hp.neg) continue;   // same polarity -> not a flip
        var setN = {}; n.content.forEach(function (w) { setN[w] = 1; });
        var shared = hp.content.filter(function (w) { return setN[w]; }).length;
        // require the smaller fact's topic to be (mostly) shared, so the two are about the same thing
        var minLen = Math.min(n.content.length, hp.content.length);
        if (shared >= 1 && shared >= Math.ceil(minLen / 2)) return h.text;
      }
      return null;
    }
    function getFacts(id) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) { return (p && Array.isArray(p.facts)) ? p.facts : []; });
    }
    // Merge newly-proposed fact strings into a user's store. Dedupes against existing (normalized),
    // caps to factsPerUser (newest kept). Returns the count actually added.
    function addFacts(id, proposed, source) {
      if (!proposed || !proposed.length) return Promise.resolve(0);
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p) return 0;
        var facts = Array.isArray(p.facts) ? p.facts : [];
        var seen = {}; facts.forEach(function (f) { seen[normFact(f.text)] = true; });
        var added = 0, impAdded = 0;
        proposed.forEach(function (raw) {
          // accept {text/t, importance/i} objects or bare strings (back-compat)
          var text, imp;
          if (raw && typeof raw === 'object') { text = String(raw.text != null ? raw.text : raw.t || '').trim().slice(0, cfg.factTextMax); imp = Math.max(1, Math.min(10, Math.round(Number(raw.importance != null ? raw.importance : raw.i)) || (cfg.factImportanceDefault || 5))); }
          else { text = String(raw || '').trim().slice(0, cfg.factTextMax); imp = cfg.factImportanceDefault || 5; }
          var key = normFact(text);
          if (!key || seen[key]) return;          // empty or duplicate
          // contradiction flag (DESIGN-contradiction): if this new fact clearly flips polarity on a
          // held one, KEEP BOTH (don't let consolidation silently drop the older side) and record the
          // conflict so she can gently clarify. Only for facts that matter (importance floor).
          if (cfg.contradictionAware && imp >= (cfg.contradictionImportanceFloor || 5)) {
            var clash = detectContradiction(text, facts);
            if (clash) { p.conflict = { a: clash, b: text, at: clock.now() }; log('[chloe.fact] noted a conflict for ' + (p.name || p.id) + ': "' + String(clash).slice(0, 40) + '" vs "' + String(text).slice(0, 40) + '"'); }
          }
          seen[key] = true; facts.push({ id: mintFactId(), text: text, at: clock.now(), source: source || 'observed', importance: imp }); added++; impAdded += imp;
        });
        if (!added) return 0;
        if (facts.length > cfg.factsPerUser) facts = facts.slice(-cfg.factsPerUser);   // keep newest
        p.facts = facts; p.factsAt = clock.now();
        // reflection fuel: accumulate the importance of what we learned (Step 3 reads this threshold)
        p.reflectImportanceAccum = (p.reflectImportanceAccum || 0) + impAdded;
        return store.set(partKey(id), p).then(function () { return added; });
      });
    }
    function forgetFact(id, match) {
      var m = normFact(match);
      if (!m) return Promise.resolve(0);
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p || !Array.isArray(p.facts)) return 0;
        var before = p.facts.length;
        p.facts = p.facts.filter(function (f) { return normFact(f.text).indexOf(m) < 0; });
        var removed = before - p.facts.length;
        if (!removed) return 0;
        return store.set(partKey(id), p).then(function () { return removed; });
      });
    }

    // ---- context moderation: excise a message from her working memory (DESIGN-excise.md) ----------
    // Remove the line with this message id from whichever user's `recent` window holds it. This is the
    // ONLY place a message is stored by message-id; the speaker ring holds author ids (untouched), and
    // any fact/episode already distilled from it is a separate artifact (excise composes with the
    // People-drawer CRUD, it doesn't cascade). Cross-partition because the operator knows the message,
    // not whose window it's in. Returns { removed, fromUser }.
    function exciseMessage(msgId) {
      var target = String(msgId || '');
      if (!target) return Promise.resolve({ removed: 0, fromUser: null });
      return getRoster().then(function (roster) {
        var chain = Promise.resolve(), removed = 0, fromUser = null;
        roster.forEach(function (p) {
          chain = chain.then(function () {
            if (!p || !Array.isArray(p.recent) || !p.recent.length) return;
            var before = p.recent.length;
            p.recent = p.recent.filter(function (ln) { return String(ln.id) !== target; });
            var n = before - p.recent.length;
            if (n) { removed += n; fromUser = fromUser || p.name || p.id; return store.set(partKey(p.id), p); }
          });
        });
        return chain.then(function () {
          if (removed) log('[chloe.excise] removed ' + removed + ' line(s) from working memory');
          return { removed: removed, fromUser: fromUser };
        });
      });
    }
    // Drop the last n lines from one user's recent window ("delete that last thing they said").
    function exciseLastFromUser(userId, n) {
      var k = Math.max(1, Math.round(Number(n) || 1));
      return Promise.resolve(store.get(partKey(userId))).then(function (p) {
        if (!p || !Array.isArray(p.recent) || !p.recent.length) return { removed: 0, fromUser: null };
        var cut = Math.min(k, p.recent.length);
        p.recent = p.recent.slice(0, p.recent.length - cut);
        return store.set(partKey(userId), p).then(function () {
          log('[chloe.excise] removed ' + cut + ' recent line(s) from ' + (p.name || userId));
          return { removed: cut, fromUser: p.name || userId };
        });
      });
    }

    // ---- per-person memory CRUD (DESIGN-people-crud.md): edit facts + insights by STABLE id -------
    var factSeq = 0;
    function mintFactId() { factSeq++; return 'f' + clock.now().toString(36) + factSeq.toString(36); }
    // Lazy id migration: give any id-less fact/insight a stable id and persist once. Idempotent.
    function migrateMemoryIds(p) {
      var changed = false;
      if (Array.isArray(p.facts)) p.facts.forEach(function (f) { if (f && !f.id) { f.id = mintFactId(); changed = true; } });
      if (Array.isArray(p.insights)) p.insights.forEach(function (x) { if (x && !x.id) { x.id = mintFactId(); changed = true; } });
      return changed;
    }
    // Read one person's editable memory (facts + insights), migrating ids on first read.
    function getMemory(id) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p) return null;
        var changed = migrateMemoryIds(p);
        var out = {
          id: id, name: p.name || null,
          facts: (p.facts || []).map(function (f) { return { id: f.id, text: f.text, importance: (typeof f.importance === 'number' ? f.importance : (cfg.factImportanceDefault || 5)), source: f.source || 'observed', at: f.at || 0 }; }),
          insights: (p.insights || []).map(function (x) { return { id: x.id, text: x.text, at: x.at || 0 }; })
        };
        return (changed ? store.set(partKey(id), p) : Promise.resolve()).then(function () { return out; });
      });
    }
    // Update one fact by id (text and/or importance). Re-dedupes against the others; re-clamps imp.
    function editFact(id, factId, patch) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p || !Array.isArray(p.facts)) return null;
        migrateMemoryIds(p);
        var target = null; p.facts.forEach(function (f) { if (f.id === factId) target = f; });
        if (!target) return null;
        if (patch && patch.text != null) {
          var newText = String(patch.text).trim().slice(0, cfg.factTextMax || 240);
          if (!newText) return { error: 'empty' };
          var nk = normFact(newText);
          // collision: if another fact already normalizes to this, drop the edited one (merge) by deleting it
          var clash = p.facts.some(function (f) { return f.id !== factId && normFact(f.text) === nk; });
          if (clash) { p.facts = p.facts.filter(function (f) { return f.id !== factId; }); }
          else { target.text = newText; }
        }
        if (patch && patch.importance != null) target.importance = Math.max(1, Math.min(10, Math.round(Number(patch.importance)) || (cfg.factImportanceDefault || 5)));
        if (patch && patch.text != null && target.text) target.source = 'operator';   // a hand-edit makes it operator-owned
        p.factsAt = clock.now();
        return store.set(partKey(id), p).then(function () { return { facts: p.facts.map(pubFact) }; });
      });
    }
    function deleteFact(id, factId) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p || !Array.isArray(p.facts)) return null;
        var before = p.facts.length;
        p.facts = p.facts.filter(function (f) { f.id || (f.id = mintFactId()); return f.id !== factId; });
        if (p.facts.length === before) return { facts: p.facts.map(pubFact) };
        p.factsAt = clock.now();
        return store.set(partKey(id), p).then(function () { return { facts: p.facts.map(pubFact) }; });
      });
    }
    // Operator-authored fact: creates the partition row if the person isn't known yet.
    function addUserFact(id, text, importance, name) {
      var t = String(text || '').trim().slice(0, cfg.factTextMax || 240);
      if (!t) return Promise.resolve(null);
      return ensureIndexed(id).then(function () {
        return Promise.resolve(store.get(partKey(id))).then(function (p) {
          if (!p) { p = { id: id, name: name || null, facts: [], lastSeen: clock.now(), interactionCount: 0 }; }
          if (!Array.isArray(p.facts)) p.facts = [];
          migrateMemoryIds(p);
          var nk = normFact(t);
          if (p.facts.some(function (f) { return normFact(f.text) === nk; })) return { facts: p.facts.map(pubFact), dup: true };
          var imp = Math.max(1, Math.min(10, Math.round(Number(importance)) || (cfg.factImportanceDefault || 5)));
          p.facts.push({ id: mintFactId(), text: t, at: clock.now(), source: 'operator', importance: imp });
          if (p.facts.length > cfg.factsPerUser) {
            // drop the oldest NON-operator fact to make room (operator intent outranks decay)
            var victim = -1; for (var i = 0; i < p.facts.length; i++) { if (p.facts[i].source !== 'operator') { victim = i; break; } }
            if (victim >= 0) p.facts.splice(victim, 1); else p.facts = p.facts.slice(-cfg.factsPerUser);
          }
          p.factsAt = clock.now();
          return store.set(partKey(id), p).then(function () { return { facts: p.facts.map(pubFact) }; });
        });
      });
    }
    function editInsight(id, insId, text) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p || !Array.isArray(p.insights)) return null;
        migrateMemoryIds(p);
        var t = String(text || '').trim().slice(0, cfg.factTextMax || 240);
        var tgt = null; p.insights.forEach(function (x) { if (x.id === insId) tgt = x; });
        if (!tgt) return null;
        if (!t) { p.insights = p.insights.filter(function (x) { return x.id !== insId; }); }
        else { tgt.text = t; }
        return store.set(partKey(id), p).then(function () { return { insights: p.insights.map(function (x) { return { id: x.id, text: x.text, at: x.at || 0 }; }) }; });
      });
    }
    function deleteInsight(id, insId) {
      return Promise.resolve(store.get(partKey(id))).then(function (p) {
        if (!p || !Array.isArray(p.insights)) return null;
        p.insights.forEach(function (x) { x.id || (x.id = mintFactId()); });
        p.insights = p.insights.filter(function (x) { return x.id !== insId; });
        return store.set(partKey(id), p).then(function () { return { insights: p.insights.map(function (x) { return { id: x.id, text: x.text, at: x.at || 0 }; }) }; });
      });
    }
    function pubFact(f) { return { id: f.id, text: f.text, importance: (typeof f.importance === 'number' ? f.importance : (cfg.factImportanceDefault || 5)), source: f.source || 'observed', at: f.at || 0 }; }
    // A compact one-line synthesis of what she knows about someone — this is what populates the
    // (previously empty) `summary` that already rides into response + check-in context.
    function factSummary(p) {
      if (!p) return '';
      // Insights (reflection's earned, higher-level layer) lead; importance-ranked facts follow.
      var parts = [];
      if (Array.isArray(p.insights) && p.insights.length) {
        parts.push(p.insights.map(function (x) { return x.text; }).join('; '));
      }
      if (Array.isArray(p.facts) && p.facts.length) {
        var n = p.facts.length, def = cfg.factImportanceDefault || 5;
        // rank by importance blended with a mild recency bias; old facts without importance score at the
        // neutral default so nothing is unfairly dropped. Keep the top N, then render in original order.
        var scored = p.facts.map(function (f, idx) {
          var imp = (typeof f.importance === 'number') ? f.importance : def;
          var recency = n > 1 ? (idx / (n - 1)) : 1;   // 0 oldest .. 1 newest
          return { f: f, idx: idx, score: imp + recency * (cfg.factRecencyWeight || 2) };
        });
        scored.sort(function (a, b) { return b.score - a.score; });
        var keep = scored.slice(0, cfg.factContextCount).sort(function (a, b) { return a.idx - b.idx; });
        parts.push(keep.map(function (x) { return x.f.text; }).join('; '));
      }
      return parts.join('; ');
    }
    // Decide whether a user is due for an extraction pass: fact memory on, they're a real regular,
    // enough new messages since the last pass, and the per-user cooldown has elapsed.
    function factProposeDue(p, now) {
      if (!cfg.factMemory) return false;
      if ((p.interactionCount || 0) < cfg.factMinInteractions) return false;
      if (p.factsAt && (now - p.factsAt) < cfg.factProposeGapMs) return false;
      var newMsgs = (p.interactionCount || 0) - (p.factsBaseline || 0);
      return newMsgs >= cfg.factProposeMinNew;
    }

    function getSpeakerRing() { return Promise.resolve(store.get(RING_KEY)).then(function (r) { return r || []; }); }

    // ---- pace core: one rhythm estimator, several consumers (DESIGN-pace.md) ----------------
    // A short-lived cache of the rhythm record so the per-poll consumers (debounce, polling, quiet)
    // don't each hit the store. Refreshed once per poll in pollOnce's tail.
    var paceCache = null;
    var paceLastAI = {};   // pass-name -> last wall-clock run (AI-cadence floor, anti cost-multiplier)
    function refreshPace() { return Promise.resolve(store.get(RHYTHM_KEY)).then(function (rh) { paceCache = rh || null; return rh; }); }
    function paceReady() { return !!(cfg.adaptivePace && paceCache && (paceCache.samples || 0) >= (cfg.paceMinSamples || 5) && paceCache.avgGapMs != null); }
    // Rhythm-relative debounce: ~one typical gap + slack, hard-clamped. Falls back to the fixed
    // constant when pace isn't ready. (Used by the reply/paint/greet burst gates.)
    function currentDebounce() {
      if (!paceReady()) return cfg.debounceMs;
      var d = (paceCache.avgGapMs || 0) * (cfg.paceDebounceWgap || 0.5) + (paceCache.gapVarMs || 0) * (cfg.paceDebounceWdev || 1.0);
      // Clamp to [floor, ceil]. The configured debounceMs is the CEILING (pace may make her settle
      // faster than the fixed value, never slower) — so an explicitly tiny debounce stays tiny.
      var ceil = cfg.debounceMs;
      var floor = Math.min(cfg.debounceFloorMs || 800, ceil);
      return Math.round(Math.max(floor, Math.min(ceil, d)));
    }
    // How many deviations past typical the current silence is (z-score). >= paceQuietZ reads as quiet.
    function silenceZ(now) {
      if (!paceReady() || paceCache.lastActivity == null) return 0;
      var silentFor = now - paceCache.lastActivity;
      var denom = Math.max(paceCache.gapVarMs || 0, 1000);   // floor the denominator (avoid div blowups in a metronomic room)
      return (silentFor - (paceCache.avgGapMs || 0)) / denom;
    }
    function paceIsQuiet(now) { return paceReady() ? (silenceZ(now) >= (cfg.paceQuietZ || 3)) : null; }   // null = "no opinion, use your flat threshold"

    // ---- loop control --------------------------------------------------------------------
    // adaptive cadence: snap to the floor while there's activity or pending work; otherwise grow
    // the interval (x1.5) toward the ceiling so a quiet channel isn't polled every few seconds.
    function computeNextDelay(prev, summary) {
      if (!cfg.adaptivePolling) return cfg.pollIntervalMs;
      prev = prev || cfg.pollIntervalMs;
      // ADDRESSED-PRIORITY OVERRIDE: a pending reply/greet/gate/paint means she's been @-mentioned or
      // replied to (or owes a delivery) — being addressed always beats passive ingest, snap to floor.
      var addressed = hasPendingReply() || paint.queue.length || paint.painting || gate.pending || greet.pending;
      if (addressed) return cfg.pollFloorMs;

      if (cfg.adaptivePace) {
        // INVERTED model (this bot ACTS on new content; it doesn't chatter into a busy stream):
        //   quiet room  -> poll FAST (catch new content the moment it stirs); fresh content speeds up.
        //   busy  room  -> poll RELAXED but only PARTWAY (pollBusyCeilMs): passive ingest, reply on lull.
        var fresh = summary && summary.ingested > 0;
        var z = paceIsQuiet(clock.now());   // true=quiet, false=busy, null=pace-not-ready
        var busyCeil = cfg.pollBusyCeilMs || cfg.pollCeilMs;
        if (z === false) {
          // active room: ingest passively — ease the interval UP toward the partial (busy) ceiling.
          var relaxed = prev + (cfg.pollAdditiveStepMs || cfg.pollFloorMs);
          return Math.max(cfg.pollFloorMs, Math.min(relaxed, busyCeil));
        }
        // quiet (or pace not ready): be eager. Fresh content cuts the interval multiplicatively toward
        // the floor; an idle quiet poll still drifts UP toward the FULL ceiling (nothing to catch).
        if (fresh) return Math.max(cfg.pollFloorMs, Math.min(Math.round(prev * 0.5), cfg.pollCeilMs));
        var grownQ = prev + (cfg.pollAdditiveStepMs || cfg.pollFloorMs);
        return Math.max(cfg.pollFloorMs, Math.min(grownQ, cfg.pollCeilMs));
      }
      // legacy (pace off): binary snap-fast on any activity, else x1.5 grow.
      var busy = (summary && summary.ingested > 0) || hasPendingReply() || paint.queue.length || paint.painting || gate.pending || greet.pending;
      if (busy) return cfg.pollFloorMs;
      var grown = Math.round(prev * 1.5);
      return Math.max(cfg.pollFloorMs, Math.min(grown, cfg.pollCeilMs));
    }
    function start() {
      if (running) return;
      if (!cfg.channelId) throw new Error('[chloe.T0] no channelId configured');
      running = true;
      startedAt = clock.now();
      startupPending = true;   // next poll may carry a history backlog; clamp image gen on it
      greetSettleLogged = false;
      refreshPersonaName();
      resumePendingReply().catch(function () {});   // Gap A: pick up a predecessor's lost reply (verified, resume-once)
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
    function stop() { running = false; deferGen++; if (timer) clearTimeout(timer); timer = null; releaseRunLock(); log('[chloe.T0] stopped'); }   // releasing lets a clean successor claim instantly (no TTL wait)
    function isRunning() { return running; }

    // Live config patch: update specific cfg keys in-place on a running engine WITHOUT a full
    // rebuild. Only safe for values the engine reads at call-time (not ones captured at startup in
    // closure state). Currently: deviceClock, semanticInjections. Callers must list keys explicitly.
    // Keys the engine reads at call-time (not captured at startup) — safe to patch in-place on a
    // running engine without a full rebuild. Structural keys (channelId, addressMode, botUserId,
    // character/persona, channels list) still require applyConfigChange + rebuild.
    var LIVE_PATCHABLE = ['deviceClock', 'semanticInjections', 'deviceClockStaleMs', 'cleanOutput',
      'translate', 'selfKnowledge', 'attentionManager', 'exactTokens', 'workingMemory',
      'idleDeliberation', 'ownAffect', 'moodAware', 'channelSummary', 'factMemory', 'volunteer',
      'contradictionAware',
      'conversationMemory',
      'deferredIntents',
      'greet', 'checkins', 'lullFiller', 'adaptivePace', 'idleConsolidation', 'reflection',
      'episodicMemory', 'episodeGraph', 'goalObjects', 'relationshipTrust', 'reactionSummon',
      'proceduralModes', 'ackReactions', 'singleParagraph', 'replyReference', 'backfill',
      'image', 'imageQueueMax', 'imageMemory', 'imageEnhanceOffer', 'autoMod', 'autoModRules', 'dmReplies', 'modList',
      'commandPrefixes', 'commandPrefix', 'beats', 'procRules', 'serverMemberCount',
      'timezoneOffsetMins', 'timeAware', 'engageMode', 'botAliases', 'botLoopGrace',
      'botLoopHardStop', 'summonEmoji', 'ackThrottleEmoji'];
    function updateConfig(patch) {
      if (!patch || typeof patch !== 'object') return;
      Object.keys(patch).forEach(function (k) { if (LIVE_PATCHABLE.indexOf(k) >= 0) cfg[k] = patch[k]; });
    }

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
      botLoopReplyChance: botLoopReplyChance,
      noteAuthorForLoop: noteAuthorForLoop,
      setIntent: setIntent, getIntent: getIntent, clearIntent: clearIntent,
      estimateTokens: estimateTokens, packByTokens: packByTokens, cleanReply: cleanReply, attentionScore: attentionScore, chooseAttention: chooseAttention, selfKnowledgeText: selfKnowledgeText,
      parseImageJson: parseImageJson,
      safeParseJson: safeParseJson, volunteerPrefilter: volunteerPrefilter,
      scheduleReminder: scheduleReminder, listReminders: listReminders, clearReminders: clearReminders, processReminders: processReminders,
      setAfk: setAfk, getAfk: getAfk, clearAfk: clearAfk, getAfkMap: getAfkMap,
      addHighlight: addHighlight, listHighlights: listHighlights, clearHighlights: clearHighlights,
      reactionSignificance: reactionSignificance, reactionThreshold: reactionThreshold, processMessageReactions: processMessageReactions, topReactions: topReactions, reactionSweep: reactionSweep,
      processLull: processLull, processCheckin: processCheckin, processFacts: processFacts,
      getFacts: getFacts, addFacts: addFacts, forgetFact: forgetFact, factSummary: factSummary,
      detectContradiction: detectContradiction,
      getMemory: getMemory, editFact: editFact, deleteFact: deleteFact, addUserFact: addUserFact, editInsight: editInsight, deleteInsight: deleteInsight,
      getUserLang: getUserLang, setUserLang: setUserLang, updateConfig: updateConfig,
      exciseMessage: exciseMessage, exciseLastFromUser: exciseLastFromUser, assembleContext: assembleContext,
      timeContext: timeContext,
      updateMood: updateMood, moodDescriptor: moodDescriptor, moodSignals: moodSignals,
      processChannelSummary: processChannelSummary, recentTranscript: recentTranscript,
      processReflection: processReflection, processEpisodes: processEpisodes, dropEpisodesFor: dropEpisodesFor,
      addTrust: addTrust, creditPositiveReactions: creditPositiveReactions, replyPriority: replyPriority,
      addGoal: addGoal, closeGoal: closeGoal, goalsForOwner: goalsForOwner, loadGoals: loadGoals, dropGoalsFor: dropGoalsFor,
      seedCharacterMemories: seedCharacterMemories, clearCharacterMemories: clearCharacterMemories,
      workLoad: workLoad, workSync: workSync, noteDecision: noteDecision,
      deliberate: deliberate, deliberateDue: deliberateDue, deliberateSeed: deliberateSeed,
      getSelfIntents: getSelfIntents, scheduleSelfIntent: scheduleSelfIntent, dueSelfIntent: dueSelfIntent,
      consolidateStructural: consolidateStructural, consolidateSemantic: consolidateSemantic, channelIsIdle: channelIsIdle,
      currentDebounce: currentDebounce, silenceZ: silenceZ, paceIsQuiet: paceIsQuiet, paceReady: paceReady, refreshPace: refreshPace, computeNextDelay: computeNextDelay,
      affectLoad: affectLoad, affectNudge: affectNudge, affectTick: affectTick, affectOnUserMessage: affectOnUserMessage, affectOnContent: affectOnContent,
      procCheckReactions: procCheckReactions, getProcMode: getProcMode, clearProcMode: clearProcMode, activateProcMode: activateProcMode,
      resumePendingReply: resumePendingReply, summonCheckReactions: summonCheckReactions, pollCreate: pollCreate, pollClose: pollClose, checkPollExpiry: checkPollExpiry,
      BANDS: BANDS, registerProvider: registerProvider, gatherInjections: gatherInjections,
      archiveUser: archiveUser, restoreFromArchive: restoreFromArchive, getArchiveIndex: getArchiveIndex, quietSweep: quietSweep,
      describeJobs: describeJobs,
      getPersonaNote: getPersonaNote,
      clearPersonaNote: clearPersonaNote,
      purge: purge,
      getModLog: getModLog,
      appendModLog: appendModLog,
      knownFromOtherSurfaces: knownFromOtherSurfaces,
      ingestOne: ingestOne,
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

  // Pure per-kind brain telemetry: Jacobson latency estimation (srtt + 4*rttvar -> adaptive
  // timeout) and a circuit breaker (CLOSED -> N consecutive failures -> OPEN, instant-fail ->
  // HALF-OPEN probe after probeMs -> success closes). Host (bootstrap) wires it around brainCall.
  function createBrainMeter(opts) {
    opts = opts || {};
    var alpha = opts.alpha != null ? opts.alpha : 0.125;   // RFC 6298 gains
    var beta = opts.beta != null ? opts.beta : 0.25;
    var minT = opts.minTimeoutMs || 10000, maxT = opts.maxTimeoutMs || 90000;
    var failsToOpen = opts.failsToOpen || 3, probeMs = opts.probeMs || 30000;
    var nowFn = opts.now || function () { return Date.now(); };
    var kinds = {};
    function k(kind) {
      return kinds[kind] || (kinds[kind] = { srtt: null, rttvar: null, fails: 0, state: 'closed', openedAt: 0, probing: false });
    }
    return {
      // before a call: { allow, probe, timeoutMs, reason }
      gate: function (kind) {
        var s = k(kind), now = nowFn();
        var t = (s.srtt == null) ? maxT : Math.max(minT, Math.min(maxT, Math.round(s.srtt + 4 * s.rttvar)));
        if (s.state === 'open') {
          if (now - s.openedAt >= probeMs && !s.probing) { s.probing = true; return { allow: true, probe: true, timeoutMs: t }; }   // half-open: ONE probe
          return { allow: false, timeoutMs: t, reason: 'brain circuit open for "' + kind + '" (' + s.fails + ' consecutive failures; probing every ' + Math.round(probeMs / 1000) + 's)' };
        }
        return { allow: true, probe: false, timeoutMs: t };
      },
      // after a call: ok=false means transport-level failure/timeout (a brain that ANSWERED
      // "no" is a success for the breaker — the wire works).
      record: function (kind, rttMs, ok) {
        var s = k(kind);
        if (ok && rttMs != null) {
          if (s.srtt == null) { s.srtt = rttMs; s.rttvar = rttMs / 2; }
          else { s.rttvar = (1 - beta) * s.rttvar + beta * Math.abs(rttMs - s.srtt); s.srtt = (1 - alpha) * s.srtt + alpha * rttMs; }
        }
        if (ok) { s.fails = 0; s.state = 'closed'; s.probing = false; }
        else {
          s.fails++; s.probing = false;
          if (s.fails >= failsToOpen) { s.state = 'open'; s.openedAt = nowFn(); }
        }
      },
      snapshot: function () {
        var out = {};
        Object.keys(kinds).forEach(function (kk) {
          var s = kinds[kk];
          out[kk] = { srtt: s.srtt == null ? null : Math.round(s.srtt), rttvar: s.rttvar == null ? null : Math.round(s.rttvar),
                      timeoutMs: (s.srtt == null) ? maxT : Math.max(minT, Math.min(maxT, Math.round(s.srtt + 4 * s.rttvar))),
                      state: s.state, fails: s.fails };
        });
        return out;
      }
    };
  }

  return { createEngine: createEngine, createBrainMeter: createBrainMeter, _snowflakeCmp: snowflakeCmp };
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
    var queenHasPage = false; // worker: whether the current queen advertises a page brain
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
    // Wake-jump guard threshold. Must sit ABOVE Chrome's background-tab timer throttle (~60s
    // ticks), or every routine background tick looks like a sleep-wake and permanently resets the
    // election claim — a demoted ex-queen in a background tab could then never re-promote after
    // the reigning queen died (the v0.77.3 People-memory outage). 150s: routine throttling never
    // trips it; genuine sleeps (minutes+) still do. Promotion safety does not rest on this guard —
    // the lease freshness check + claim read-back are what prevent promoting over a live queen.
    var wakeJumpMs = opts.wakeJumpMs || 150000;
    var leaseRenewMs = opts.leaseRenewMs || 10000;
    // D7 pool autosizing. The queen keeps the live worker count near a target. It only ever
    // SPAWNS (never kills healthy workers — quiet just means it stops replacing reaped ones),
    // and it backs off between spawns so a discard storm or a popup-blocked spawn doesn't loop.
    // The host supplies poolTarget() (current desired count, may change live) and doSpawn()
    // (returns truthy on a spawn attempt). "expected N, have M -> spawn" covers Memory-Saver
    // tab discards: a discarded worker simply stops ponging, gets reaped, and is respawned.
    var poolTarget = (typeof opts.poolTarget === 'function') ? opts.poolTarget : function () { return 0; };
    var capable = (typeof opts.capable === 'function') ? opts.capable : function () { return true; };   // does THIS tab have a page brain it can run jobs against?
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
      // Capability-preferential election: a tab that has a page (can run the brain locally and is
      // usually the un-throttled foreground tab) claims sooner, so it wins the lease before a
      // page-less tab even tries. A page-less tab defers a full extra window — it only promotes if no
      // page-having peer claimed first. This makes the natural queen the tab the user is looking at.
      var capBias = capable() ? 0 : (queenDeadAfterMs > 0 ? Math.min(8000, claimSettleMs * 3 + 4000) : 5000);
      return capBias + (h % 5) * 1000 + 250;
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
          // A lease younger than the dead-bar means a queen MAY be alive — back off. Credit her
          // with life as of the lease TIMESTAMP, not as of this check: l.at is the actual evidence.
          // (Using `now` here restarted the full 90s window each cycle, doubling worst-case
          // failover when the last ping trailed the last lease renewal by a few seconds.)
          if (l && (now - (l.at || 0)) < queenDeadAfterMs) { claimState = null; lastQueenSeenAt = Math.max(lastQueenSeenAt, l.at || now); return; }   // a live queen renews this
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
      // brain jobs need a page to run against; only route them to workers that advertised one.
      var needsPage = (jobType === 'brain');
      var ids = Object.keys(workers).filter(function (id) {
        return workers[id].status === 'idle' && (!needsPage || workers[id].hasPage);
      });
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
      if (env.type === 'hello') {
        // a newcomer announced itself — answer immediately so it discovers us without waiting a ping
        // interval, and (if it's a peer queen) so its queenConflict resolves now.
        sendTo(env.from, 'ping', { hasPage: capable() });
        return;
      }
      if (env.type === 'here') {
        // a worker answered our startup hello — learn it (and its abilities) now instead of waiting
        // for its register/pong.
        if (env.payload && env.payload.role === 'worker' && !workers[env.from]) {
          workers[env.from] = { status: 'idle', lastSeen: clock.now(), hasPage: !!env.payload.hasPage };
          if (typeof opts.onWorkerJoin === 'function') opts.onWorkerJoin(env.from);
        }
        return;
      }
      if (env.type === 'register') {
        var fresh = !workers[env.from];
        workers[env.from] = { status: 'idle', lastSeen: clock.now(), hasPage: !!(env.payload && env.payload.hasPage) };
        sendTo(env.from, 'registered', { queenId: tabId });
        log('[bridge] worker ' + env.from + (fresh ? ' joined' : ' re-registered'));
        if (fresh && typeof opts.onWorkerJoin === 'function') opts.onWorkerJoin(env.from);
        return;
      }
      if (env.type === 'ping') { queenConflict(env.from); return; }   // another queen exists — resolve via the lease
      if (env.type === 'pong') {
        var cap = !!(env.payload && env.payload.hasPage);
        if (workers[env.from]) { workers[env.from].lastSeen = clock.now(); workers[env.from].hasPage = cap; return; }
        workers[env.from] = { status: 'idle', lastSeen: clock.now(), hasPage: cap };   // a surviving worker adopted after promotion
        log('[bridge] adopted worker ' + env.from);
        if (typeof opts.onWorkerJoin === 'function') opts.onWorkerJoin(env.from);
        return;
      }
      if (env.type === 'bye') { if (workers[env.from]) { delete workers[env.from]; rejectPendingFor(env.from, 'worker left'); log('[bridge] worker ' + env.from + ' left'); if (typeof opts.onWorkerLost === 'function') opts.onWorkerLost(env.from, 'bye'); } return; }
      if (env.type === 'result') { settle(env.re, true, env.payload); return; }
      if (env.type === 'error') { settle(env.re, false, env.payload); return; }
    }

    function handleAsWorker(env) {
      if (env.type === 'hello') { sendTo(env.from, 'here', { role: 'worker', hasPage: capable() }); return; }   // capability exchange
      if (env.type === 'here') { return; }   // informational; queen election uses the lease, not a vote
      if (env.type === 'registered') { queenId = env.payload && env.payload.queenId ? env.payload.queenId : env.from; lastQueenSeenAt = clock.now(); claimState = null; return; }
      if (env.type === 'ping') { queenId = env.from; queenHasPage = !!(env.payload && env.payload.hasPage); lastQueenSeenAt = clock.now(); claimState = null; sendTo(env.from, 'pong', { hasPage: capable() }); return; }
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
        if (now - lastPingAt >= pingIntervalMs) { lastPingAt = now; broadcast('ping', { hasPage: capable() }); }
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
      // Handshake (ask): announce ourselves and our abilities to whoever is already here. The queen
      // answers with a ping (fast discovery, no waiting a full ping interval); a peer queen answers
      // with its own ping, which trips queenConflict so the duplicate stands down in one round-trip.
      broadcast('hello', { role: role, hasPage: capable() });
      if (role === 'worker') broadcast('register', { hasPage: capable() });
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
      hello: function () { if (running) broadcast('hello', { role: role, hasPage: capable() }); },   // re-run the discovery handshake on demand
      queenHasPage: function () { return role === 'queen' ? capable() : queenHasPage; },              // does the current queen have a page brain?
      capablePeers: function () { var n = capable() ? 1 : 0; Object.keys(workers).forEach(function (k) { if (workers[k].hasPage) n++; }); return n; },  // tabs in this pool that can run a brain job
      // Force this tab to contest the queen election now (used to recover a tab that was wrongly left
      // as a worker but is actually hosting the control panel). If a live queen exists, the claim flow
      // backs off and this stays a worker; if not, it promotes. Safe to call repeatedly.
      standForQueen: function () {
        if (role === 'queen') return;
        claimState = null; lastQueenSeenAt = clock.now() - (queenDeadAfterMs + 1); lastWatchdogAt = 0;
        if (running) workerWatchdog(clock.now());
      },
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
  var VERSION = '0.87.0';
  // D1: queen/worker role. Worker tabs are spawned with '#chloe-worker' in the URL; everything
  // else (including today's single-tab setup) is the queen. Workers never poll Discord, never
  // start the engine, and never write GM state — they contribute their tab's AI brain via jobs.
  var TAB_ROLE = (typeof location !== 'undefined' && /chloe-worker/.test(location.hash || '')) ? 'worker' : 'queen';
  var workerSelfHealTried = false;   // one-shot: a worker-roled tab that turns out to host the panel reclaims queen

  function cfgGet(k, d) { var v = GM_getValue(NS + 'cfg:' + k, null); return v == null ? d : v; }
  // Arbitrary semantic-injection store (DESIGN-semantic-inject.md): a map of id -> {id,text,priority,ttlMs,at}.
  function semInjectMap() { var m = GM_getValue(NS + 'seminject:map', null); return (m && typeof m === 'object') ? m : {}; }
  function semInjectList() { var m = semInjectMap(); return Object.keys(m).map(function (k) { return m[k]; }); }
  function semInjectUpsert(entry) { var m = semInjectMap(); m[entry.id] = entry; GM_setValue(NS + 'seminject:map', m); }
  function semInjectDrop(id) { var m = semInjectMap(); if (m[id]) { delete m[id]; GM_setValue(NS + 'seminject:map', m); } }
  function cfgSet(k, v) { GM_setValue(NS + 'cfg:' + k, v); }
  // #17: a small in-memory ring of link/transport/poll events, readable after the fact (the link's
  // failure modes are timing-dependent and easy to miss live). Mirrors to console; capped at 60.
  var traceRing = [], TRACE_MAX = 60;
  function trace(tag, msg) {
    var e = { t: Date.now(), tag: tag, msg: String(msg) };
    traceRing.push(e); if (traceRing.length > TRACE_MAX) traceRing = traceRing.slice(-TRACE_MAX);
    return e;
  }
  // Bootstrap log: console.log + pushEvent so messages appear in both the browser console
  // and the panel activity feed. Use for anything a mod operator needs to see at a glance.
  function bLog(msg) { console.log(msg); pushEvent('log', msg); }
  function tokenShape(t) {
    return { len: t ? t.length : 0, parts: t ? t.split('.').length : 0,
             ws: /\s/.test(t || ''), placeholder: !t || t.indexOf('PASTE_') === 0 };
  }
  function hasToken() { return !tokenShape(cfgGet('token', '')).placeholder; }

  // ---- GM store adapter (KV + maintained roster index) --------------------------------
  // D3: per-channel namespacing. The PRIMARY channel keeps the legacy un-prefixed namespace so an
  // existing install keeps its memory; every additional channel lives under 'ch:{id}:'.
  function makeStore(pfx) {
    var INDEX_GM_KEY = NS + pfx + 'roster:index';
    function readIndex() { var v = GM_getValue(INDEX_GM_KEY, null); if (!v) return []; try { return JSON.parse(v) || []; } catch (e) { return []; } }
    var s = {
      get: function (k) { return Promise.resolve().then(function () { var v = GM_getValue(NS + pfx + k, null); if (v == null) return null; try { return JSON.parse(v); } catch (e) { return null; } }); },
      set: function (k, v) { GM_setValue(NS + pfx + k, JSON.stringify(v)); return Promise.resolve(true); },
      del: function (k) { GM_deleteValue(NS + pfx + k); return Promise.resolve(true); },
      listIndex: function () { return Promise.resolve(readIndex()); },
      // setIndex: UNION write — merges the supplied array with whatever is currently in GM so
      // concurrent ensureIndexed/addToIndex calls from other paths are never clobbered.
      setIndex: function (arr) {
        var cur = readIndex(); var merged = cur.slice(); var set = {};
        cur.forEach(function (id) { set[id] = true; });
        (arr || []).forEach(function (id) { if (id && !set[id]) { set[id] = true; merged.push(id); } });
        GM_setValue(INDEX_GM_KEY, JSON.stringify(merged)); return Promise.resolve(true);
      },
      // addToIndex: targeted add — only appends if not present; safe to call concurrently.
      addToIndex: function (id) {
        if (!id) return Promise.resolve();
        var cur = readIndex();
        if (cur.indexOf(id) >= 0) return Promise.resolve();
        cur.push(id); GM_setValue(INDEX_GM_KEY, JSON.stringify(cur)); return Promise.resolve(true);
      },
      // removeFromIndex: targeted remove — reads live value at call time, drops only the one id.
      removeFromIndex: function (id) {
        if (!id) return Promise.resolve();
        var cur = readIndex(); var next = cur.filter(function (x) { return x !== id; });
        if (next.length === cur.length) return Promise.resolve();   // wasn't there
        GM_setValue(INDEX_GM_KEY, JSON.stringify(next)); return Promise.resolve(true);
      }
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
  // Operator-DECLARED DM channels (the "private DMs" box). Discord's REST API gives us no per-message
  // signal of whether a channel is a DM, and with no Gateway we can't discover a cold inbound DM — so
  // the reliable answer is to let the operator list DM channel ids explicitly. A declared DM is polled
  // like any channel AND flagged isDM, which is what lets the public->DM memory merge actually run.
  function declaredDmChannels() { return (cfgGet('dmChannels', []) || []).map(function (c) { return String(c || '').trim(); }).filter(Boolean); }
  function isDMChannel(chId) { return declaredDmChannels().indexOf(chId) >= 0 || !!dmSessions()[chId]; }
  function recordDMSession(dmChannelId, userId, name) {
    if (!dmChannelId || !userId) return;
    var s = dmSessions();
    if (!s[dmChannelId]) { s[dmChannelId] = { user: String(userId), name: name || '', openedAt: Date.now() }; cfgSet('dmSessions', s); }
  }
  function channelList() {
    var seen = {}, out = [];
    // public primary + public extras + declared DMs (always polled — they're explicit) + session DMs (if enabled)
    [primaryChannel()].concat(cfgGet('channels', []) || []).concat(declaredDmChannels()).concat(cfgGet('dmReplies', false) ? dmChannelIds() : []).forEach(function (c) {
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

  // ---- translation client (DESIGN-translate.md) ----------------------------------------------
  // Free/unofficial endpoint. NO key. CARDINAL RULE: failure is a NON-EVENT \u2014 on any error/timeout/
  // parse-failure we return the ORIGINAL text, so a message is never dropped or blocked. Mentions and
  // custom emoji are protected (pulled out, prose translated, reassembled) so a translated reply still
  // pings/renders. A bounded LRU cache avoids re-hitting the endpoint for repeated lines.
  var TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';
  var translateCache = new Map();           // key "src|tgt|text" -> { text, src } ; bounded below
  var TRANSLATE_CACHE_MAX = 300;
  function cacheGet(k) { return translateCache.has(k) ? translateCache.get(k) : null; }
  function cachePut(k, v) { translateCache.set(k, v); if (translateCache.size > TRANSLATE_CACHE_MAX) { var first = translateCache.keys().next().value; translateCache.delete(first); } }
  // Protect <@123> / <@!123> / <#123> / <@&123> mentions and <a:emoji:123> / :emoji: tokens by swapping
  // them for inert placeholders the translator won't touch, then restoring them after.
  function protectTokens(text) {
    var tokens = [], i = 0;
    var protectedText = String(text).replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|:[a-z0-9_]+:/gi, function (m) {
      var ph = '\uE000' + (i++) + '\uE001';   // private-use sentinels, unlikely to be altered
      tokens.push(m); return ph;
    });
    return { text: protectedText, restore: function (out) {
      return String(out).replace(/\uE000(\d+)\uE001/g, function (_, n) { return tokens[+n] != null ? tokens[+n] : ''; });
    } };
  }
  function parseTranslateResponse(responseText) {
    // shape: [ [ [translatedSeg, origSeg, ...], ... ], ..., detectedSourceLang(maybe) ]
    var data = JSON.parse(responseText);
    var out = '';
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (var i = 0; i < data[0].length; i++) { if (data[0][i] && data[0][i][0] != null) out += data[0][i][0]; }
    }
    var src = null;
    if (data && data[2]) src = data[2];                       // common slot for detected source
    else if (data && data[8] && data[8][0] && data[8][0][0]) src = data[8][0][0];
    return { text: out, src: src };
  }
  // translate(text, target, source?) -> Promise<{text, src}>. ALWAYS resolves; never rejects.
  function translate(text, target, source) {
    var input = String(text == null ? '' : text);
    if (!input.trim() || !target) return Promise.resolve({ text: input, src: source || null });
    var src = source || 'auto';
    var key = src + '|' + target + '|' + input;
    var hit = cacheGet(key); if (hit) return Promise.resolve(hit);
    var prot = protectTokens(input);
    var url = TRANSLATE_URL + '?client=gtx&sl=' + encodeURIComponent(src) + '&tl=' + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(prot.text);
    return new Promise(function (resolve) {
      var settled = false;
      function done(val) { if (settled) return; settled = true; resolve(val); }
      var to = setTimeout(function () { trace('translate', 'timeout -> original text'); done({ text: input, src: src }); }, 6000);
      try {
        GM_xmlhttpRequest({ method: 'GET', url: url, headers: { 'User-Agent': UA }, anonymous: true,
          onload: function (r) {
            clearTimeout(to);
            try {
              if (r.status < 200 || r.status >= 300) { trace('translate', 'HTTP ' + r.status + ' -> original'); return done({ text: input, src: src }); }
              var parsed = parseTranslateResponse(r.responseText);
              var restored = prot.restore(parsed.text) || input;
              var val = { text: restored, src: parsed.src || src };
              cachePut(key, val); done(val);
            } catch (e) { trace('translate', 'parse failed -> original'); done({ text: input, src: src }); }
          },
          onerror: function () { clearTimeout(to); trace('translate', 'error -> original'); done({ text: input, src: src }); },
          ontimeout: function () { clearTimeout(to); done({ text: input, src: src }); } });
      } catch (e) { clearTimeout(to); done({ text: input, src: src }); }
    });
  }

  // Translate inbound messages from a non-English-preference author into English for the engine. Only
  // touches messages whose author has a set lang != 'en'; everyone else passes through untouched and
  // free. Failure (per translate()) leaves the original text. Replaces content in place.
  function translateInbound(channelId, msgs) {
    if (!cfgGet('translate', false) || !Array.isArray(msgs) || !msgs.length) return Promise.resolve(msgs);
    var eng = engineFor(channelId);
    if (!eng || typeof eng.getUserLang !== 'function') return Promise.resolve(msgs);
    var langCache = {};
    function langOf(uid) { if (uid in langCache) return Promise.resolve(langCache[uid]); return Promise.resolve(eng.getUserLang(uid)).then(function (l) { langCache[uid] = l || null; return langCache[uid]; }); }
    var chain = Promise.resolve();
    msgs.forEach(function (m) {
      if (!m || !m.author || !m.content) return;
      chain = chain.then(function () {
        return langOf(m.author.id).then(function (lang) {
          if (!lang || lang === 'en') return;
          return translate(m.content, 'en', lang).then(function (res) { if (res && res.text) m.content = res.text; });
        });
      });
    });
    return chain.then(function () { return msgs; });
  }

  var transport = {
    getMe: function () { return requestJSON('GET', '/users/@me'); },
    getMessagesAfter: function (channelId, afterId, limit) {
      return requestJSON('GET', '/channels/' + channelId + '/messages?limit=' + (limit || 50) + (afterId ? '&after=' + afterId : ''))
        .then(function (msgs) { return translateInbound(channelId, msgs); });
    },
    getRecentMessages: function (channelId, limit) {
      return requestJSON('GET', '/channels/' + channelId + '/messages?limit=' + (limit || 30));   // newest window, no cursor — catches reactions added after a message scrolled past
    },
    sendMessage: function (channelId, text, opts) {
      var body = { content: gateContent(text).slice(0, 1900), allowed_mentions: allowedMentions() };
      if (opts && opts.replyTo) {
        // Native reply threading: visually attaches her answer to the message it answers.
        // fail_if_not_exists:false -> if the target was deleted, the send still goes through plain.
        body.message_reference = { message_id: String(opts.replyTo), fail_if_not_exists: false };
        body.allowed_mentions = Object.assign({}, body.allowed_mentions, { replied_user: false });   // never ping via the reply itself
      }
      return requestJSON('POST', '/channels/' + channelId + '/messages', { json: true, body: body });
    },
    getMessage: function (channelId, messageId) {
      return requestJSON('GET', '/channels/' + channelId + '/messages/' + messageId, {});
    },
    sendEmbed: function (channelId, embed) {
      // v0.58 gate parity: embed text gets the same scrub as plain content. Pings already can't
      // fire (allowed_mentions rides every send), but the link/channel-link/emoji gates only ran
      // on .content — an AI-written URL inside an embed description walked straight past them.
      var g = Object.assign({}, embed);
      if (g.title) g.title = gateContent(String(g.title)).slice(0, 256);
      if (g.description) g.description = gateContent(String(g.description)).slice(0, 4000);
      if (Array.isArray(g.fields)) g.fields = g.fields.map(function (f) { return Object.assign({}, f, { name: gateContent(String(f.name || '')).slice(0, 256), value: gateContent(String(f.value || '')).slice(0, 1024) }); });
      return requestJSON('POST', '/channels/' + channelId + '/messages', { json: true, body: { embeds: [g], allowed_mentions: allowedMentions() } });
    },
    addReaction: function (channelId, messageId, emoji) {
      return requestJSON('PUT', '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me', {});
    },
    removeReaction: function (channelId, messageId, emoji) {
      return requestJSON('DELETE', '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me', {});
    },
    editMessage: function (channelId, messageId, text) {
      return requestJSON('PATCH', '/channels/' + channelId + '/messages/' + messageId, { json: true, body: { content: gateContent(text).slice(0, 1900), allowed_mentions: allowedMentions() } });
    },
    pinMessage: function (channelId, messageId) {
      return requestJSON('PUT', '/channels/' + channelId + '/pins/' + messageId, {});   // needs Manage Messages; 204 on success
    },
    startTyping: function (channelId) { return requestJSON('POST', '/channels/' + channelId + '/typing', { json: true, body: {} }); },
    getChannel: function (channelId) { return requestJSON('GET', '/channels/' + channelId, {}); },
    getGuildMemberCount: function (guildId) {
      return requestJSON('GET', '/guilds/' + guildId + '?with_counts=true').then(function (g) {
        return (g && (g.approximate_member_count || g.member_count)) || 0;
      });
    },
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

  // ---- exact token counting (DESIGN-tokens.md) ------------------------------------------------
  // Lazy-load the SAME DeepSeek-R1 tokenizer Perchance's AI broker uses, so token budgets become exact
  // instead of a chars/4 guess. The engine's estimateTokens is SYNCHRONOUS (hot path), so we never
  // await in it: we load in the background and expose a synchronous countSync that returns null until
  // the model is ready, at which point the engine's existing cfg.countTokens hook starts using it.
  // PIN the transformers version (a long-running bot shouldn't silently pull a breaking tokenizer).
  // All failures are swallowed -> countSync stays null -> chars/4 fallback. The bot never breaks on this.
  var TOKENIZER_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/+esm';
  var tokLoader = (function () {
    var tok = null, state = 'idle', promise = null, lastErr = null;
    function load() {
      if (promise) return promise;
      state = 'loading';
      promise = Promise.resolve().then(function () {
        // import() must run in the page realm (Perchance origin); LINKWIN is that window.
        var imp = (LINKWIN && LINKWIN.eval) ? LINKWIN.eval('(u)=>import(u)') : function (u) { return import(u); };
        return imp(TOKENIZER_CDN);
      }).then(function (mod) {
        return mod.AutoTokenizer.from_pretrained('deepseek-ai/DeepSeek-R1-0528');
      }).then(function (t) {
        tok = t; state = 'ready'; log('[chloe.tok] exact tokenizer ready'); return t;
      }).catch(function (err) {
        lastErr = err; state = 'fallback'; log('[chloe.tok] tokenizer load failed (' + ((err && err.message) || err) + ') \u2014 using chars/4'); return null;
      });
      return promise;
    }
    return {
      preload: function () { try { return load(); } catch (e) { state = 'fallback'; return Promise.resolve(null); } },
      countSync: function (str) { try { return tok ? tok.encode(String(str)).length : null; } catch (e) { return null; } },
      state: function () { return state; }
    };
  })();
  // The hook handed to every engine: exact when warm, null (-> chars/4) when cold/failed/off.
  function countTokensHook(str) {
    if (!cfgGet('exactTokens', true)) return null;   // off -> engine falls through to chars/4
    return tokLoader.countSync(str);
  }
  // #15: a sandboxed frame can report origin 'null'; posting back to targetOrigin 'null' is dropped,
  // so fall back to '*' in that one case (responses are nonce-matched, so this stays safe).
  function replyTarget(o) { return (o && o !== 'null') ? o : '*'; }
  var callPending = new Map(); var callSeq = 0;
  var seenReqNonces = new Set();   // de-dupe fanned-out page requests so a config command applies once
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
  var brainMeter = ChloeT0.createBrainMeter({});   // per-kind latency (Jacobson) + circuit breaker
  function brainCall(kind, args, timeoutMs) {
    // Breaker first: while the brain is down, calls fail INSTANTLY (with one probe per window)
    // instead of each burning a full timeout — the poll loop stays snappy through an outage.
    var gateRes = brainMeter.gate(kind);
    if (!gateRes.allow) { trace('brain', gateRes.reason); return Promise.resolve({ ok: false, reason: gateRes.reason }); }
    timeoutMs = timeoutMs || gateRes.timeoutMs || 40000;   // adaptive: srtt + 4*rttvar, clamped 10-90s
    if (kind !== 'paint') {
      var dials = cfgGet('personality', null);
      if (dials) args = Object.assign({}, args || {}, { personality: dials });
      var character = cfgGet('character', null);
      if (character) args = Object.assign({}, args || {}, { character: character });
    }
    function local() { return callPage(kind, args, timeoutMs); }
    var t0 = Date.now();
    var p = (tabBridge && TAB_ROLE === 'queen')
      ? tabBridge.dispatchJob('brain', { kind: kind, args: args, timeoutMs: timeoutMs }, timeoutMs + 5000, local)
      : local();
    return Promise.resolve(p).then(function (res) {
      // A brain that ANSWERED (even {ok:false, declined}) means the wire works — breaker success.
      brainMeter.record(kind, Date.now() - t0, true);
      return res;
    }, function (err) {
      brainMeter.record(kind, null, false);   // rejection/timeout = transport-level failure
      throw err;
    });
  }

  // Fan an ARRAY of independent jobs out concurrently — the map step of the deliberation loop's
  // map-reduce. Each job rides brainCall (so each leases a distinct idle worker via dispatchJob's
  // round-robin busy/idle gating; the genuinely parallel resource is one broker PER worker tab).
  // With K idle workers and N jobs, the first K run in parallel and the rest queue behind them; with
  // K=0 (single-tab) it degrades to sequential-local, identical results, just slower. Resolves an
  // array of {ok,value} in input order. A single job's failure doesn't sink the batch.
  function brainCallBatch(kind, argsList, timeoutMs) {
    if (!Array.isArray(argsList) || !argsList.length) return Promise.resolve([]);
    return Promise.all(argsList.map(function (a) {
      return brainCall(kind, a, timeoutMs).then(function (r) { return r; }, function (err) { return { ok: false, reason: String((err && err.message) || err) }; });
    }));
  }

  // ---- engine wiring ------------------------------------------------------------------
  var engines = {};   // D3: channelId -> engine (each with its own namespaced store)
  var lastPoll = null;
  // ---- global send budget (cross-engine, "one voice, many eyes") -----------------------
  // Observation is per-channel and always runs; SENDS are globally rationed. One text slot and one
  // image slot, each with a `sendBudgetMs` window (default 60s) shared across EVERY channel's
  // engine. canSend(kind) reports whether the slot is free; noteSend(kind) claims it (stamped at
  // the START of generation so two channels can't both pass during a multi-second brain call);
  // releaseSend(kind) hands it back if the work produced nothing. This is what makes a multi-bot
  // room safe: even five channels share one mouth.
  var sendBudget = { text: 0, image: 0 };   // monotonic-ish claim timestamps per kind
  var sendBudgetPri = { text: 0, image: 0 }; // priority of the current claim (lets a DM preempt a channel)
  function budgetWindow() { return Math.max(0, cfgGet('sendBudgetMs', 60000)); }
  function canSend(kind, priority) {
    var win = budgetWindow();
    if (win === 0) return true;
    var last = sendBudget[kind] || 0;
    if ((Date.now() - last) >= win) return true;
    // The slot is held — but a strictly higher-priority sender (e.g. a DM, priority>=1000) may preempt
    // a regular-channel claim so DMs are answered before in-channel chatter. Equal priority waits.
    var pri = priority || 0;
    return pri > (sendBudgetPri[kind] || 0);
  }
  function noteSend(kind, priority) { sendBudget[kind] = Date.now(); sendBudgetPri[kind] = priority || 0; }
  function releaseSend(kind) { sendBudget[kind] = 0; sendBudgetPri[kind] = 0; }   // give the slot back (generation was empty/failed)

  function buildEngine(chId) {
    var channelId = String(chId || primaryChannel() || '').trim();
    if (!channelId) return null;
    var eng = ChloeT0.createEngine({
      transport: transport, store: makeStore(prefixFor(channelId)), globalStore: makeStore(''),
      config: {
        channelId: channelId,
        isDM: isDMChannel(channelId),
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
        imageMemory: !!cfgGet('imageMemory', false),
        imageEnhanceOffer: !!cfgGet('imageEnhanceOffer', false),
        // Optional AI prompt-rewrite for natural-language image edits ("make it bigger", "same but
        // at night"). The page runs ai-text once to fold the change into the previous prompt; the
        // engine falls back to a deterministic rewrite if this declines or isn't available.
        editPrompt: function (ctx) { return brainCall('editimage', ctx); },
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
        beatFn: function (b) { return brainCall('beat', b); },
        lullFn: function (ctx) { return brainCall('lull', ctx); },
        lullFiller: cfgGet('lullFiller', false),
        checkinFn: function (ctx) { return brainCall('checkin', ctx); },
        checkins: cfgGet('checkins', false),
        factFn: function (ctx) { return brainCall('facts', ctx); },
        summaryFn: function (ctx) { return brainCall('channelSummary', ctx); },
        channelSummary: cfgGet('channelSummary', false),
        reflectFn: function (ctx) { return brainCall('reflect', ctx); },
        reflection: cfgGet('reflection', false),
        episodeFn: function (ctx) { return brainCall('episodes', ctx); },
        episodicMemory: cfgGet('episodicMemory', false),
        episodeGraph: cfgGet('episodeGraph', true),
        consolidateFn: function (ctx) { return brainCall('consolidate', ctx); },   // the “sleep” semantic pass (adaptive timeout, like every other text brainCall)
        // deliberation map-reduce: decompose/reduce are single calls; mapFn fans the independent
        // sub-questions across worker tabs (parallel when a pool exists, sequential-local otherwise).
        decomposeFn: function (ctx) { return brainCall('decompose', ctx); },
        subAnswerFn: function (ctx) { return brainCall('subanswer', ctx); },
        reduceFn: function (ctx) { return brainCall('reduce', ctx); },
        mapFn: function (list) { return brainCallBatch('subanswer', list); },
        character: cfgGet('character', null),
        idleConsolidation: cfgGet('idleConsolidation', true),
        goalObjects: cfgGet('goalObjects', true),
        factMemory: cfgGet('factMemory', false),
        contradictionAware: cfgGet('contradictionAware', false),
        conversationMemory: cfgGet('conversationMemory', true),
        timeAware: cfgGet('timeAware', false),
        timezoneOffsetMins: cfgGet('timezoneOffsetMins', 0),
        moodAware: cfgGet('moodAware', false),
        archiveStale: cfgGet('archiveStale', true),
        greetFn: function (ctx) { return brainCall('greet', ctx); },
        modList: cfgGet('modList', []),
        commandPrefix: '!chloe', ackCommands: true,
        backgroundText: true,
        commandPrefixes: cfgGet('commandPrefixes', []),
        pollIntervalMs: 6000, cooldownMs: 8000, debounceMs: 2500, contextLines: 12,
        adaptivePace: cfgGet('adaptivePace', true),
        workingMemory: cfgGet('workingMemory', false),
        cleanOutput: cfgGet('cleanOutput', true),
        semanticInjections: semInjectList(),
        deviceTime: cfgGet('deviceTime', false),
        translate: cfgGet('translate', false),
        deviceClock: GM_getValue(NS + 'deviceClock', null),
        countTokens: countTokensHook,   // exact tokenizer when warm; returns null -> engine's chars/4 fallback
        idleDeliberation: cfgGet('idleDeliberation', false),
        deferredIntents: cfgGet('deferredIntents', false),
        attentionManager: cfgGet('attentionManager', false),
        selfKnowledge: cfgGet('selfKnowledge', false),
        attentionStaleWindowMs: cfgGet('attentionStaleWindowMs', 600000),
        pollBusyCeilMs: cfgGet('pollBusyCeilMs', 12000),
        volunteerCooldownMs: 45000, judgeMinConfidence: 0.6,
        respond: function (ctx) { return brainCall('respond', ctx); },   // timeout now ADAPTIVE (the meter: srtt+4var, 10-90s; hardcoded values had been silently bypassing it since v0.54)
        judge: function (ctx) { return brainCall('judge', ctx); },
        recapFn: function (ctx) { return brainCall('recap', ctx); },
        typing: function (cid) { return transport.startTyping(cid); },
        react: function (cid, mid, emoji) { return transport.addReaction(cid, mid, emoji); },
        unreact: function (cid, mid, emoji) { return transport.removeReaction(cid, mid, emoji); },
        ackReactions: cfgGet('ackReactions', true),
        singleParagraph: cfgGet('singleParagraph', false),
        reactionTracking: cfgGet('reactionTracking', true),
        serverMemberCount: cfgGet('serverMemberCount', 0),
        reactionAutoHighlight: cfgGet('reactionAutoHighlight', true),
        recentFetch: function (n) { return transport.getRecentMessages(channelId, n); },
        reactionUsers: function (messageId, emoji) { return transport.getReactions(channelId, messageId, emoji); },   // bounded (limit 10): her messages + positive set only
        fetchMessage: function (messageId) { return transport.getMessage(channelId, messageId); },
        reactionSummon: cfgGet('reactionSummon', false),
        defer: function (fn, ms) { return setTimeout(fn, ms); },   // completion-driven dispatch + typing keep-alive (DESIGN-roundtrip.md)
        typingRefreshMs: cfgGet('typingRefreshMs', 8000),
        relationshipTrust: cfgGet('relationshipTrust', false),
        ownAffect: cfgGet('ownAffect', false),
        proceduralModes: cfgGet('proceduralModes', false),
        procRules: cfgGet('procRules', []),
        requestTokenBudget: cfgGet('requestTokenBudget', 5000),
        ackWorkingEmoji: cfgGet('ackWorkingEmoji', '\ud83d\udde3\ufe0f'),   // speaking head: generating your reply
        ackImageEmoji: cfgGet('ackImageEmoji', '\ud83d\uddbc\ufe0f'),   // picture frame: painting
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
        send: function (cid, text, opts) {
          var toUser = opts && opts.toUser;
          if (!cfgGet('translate', false) || !toUser) return transport.sendMessage(cid, text, opts);
          var eng = engineFor(cid);
          var langP = (eng && typeof eng.getUserLang === 'function') ? eng.getUserLang(toUser) : Promise.resolve(null);
          return Promise.resolve(langP).then(function (lang) {
            if (!lang || lang === 'en') return transport.sendMessage(cid, text, opts);
            return translate(text, lang, 'en').then(function (res) { return transport.sendMessage(cid, res.text, opts); });
          });
        },
        canSend: canSend, noteSend: noteSend, releaseSend: releaseSend,
        sendBudgetMs: cfgGet('sendBudgetMs', 60000),
        botLoopGrace: cfgGet('botLoopGrace', 2),
        botLoopFloor: cfgGet('botLoopFloor', 0.05),
        botLoopHardStop: cfgGet('botLoopHardStop', 12),
        sendEmbed: function (cid, embed) { return transport.sendEmbed(cid, embed); },
        onPoll: function (summary) {
          lastPoll = summary; pushEvent('poll', summary);
          if (summary && (summary.ingested || summary.replied || summary.imageJob || summary.greeted || summary.volunteered || summary.commands)) {
            trace('poll', 'in ' + (summary.ingested || 0) + (summary.replied ? ' reply' : '') + (summary.imageJob ? ' image' : '') + (summary.greeted ? ' greet' : '') + (summary.volunteered ? ' vol' : '') + (summary.commands ? ' cmd' : '') + ' [' + (summary.engageMode || 'normal') + ']');
          }
          if (summary && summary.engageMode && summary.engageMode !== cfgGet('engageMode:' + channelId, cfgGet('engageMode', 'normal'))) cfgSet('engageMode:' + channelId, summary.engageMode);  // a !chloe lockdown/unlock/open command changed it
          // A lock-skip poll means another engine instance owns this channel right now (queen handover
          // / split-brain). Maintenance writes the DB (backfill checkpoint + partitions, departure
          // sweeps, anchor notes), so the skipping instance must NOT run it — only the lock-holder.
          if (summary && summary.lockSkip) return Promise.resolve();
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
  function eachEngine(fn) { Object.keys(engines).forEach(function (c) { try { fn(engines[c], c); } catch (e) {} }); }

  var guildIdCache = {};
  function resolveGuildId(chId) {
    var cid = String(chId || primaryChannel() || '').trim();
    if (!cid) return Promise.resolve(null);
    // In-memory cache (survives the session)
    if (guildIdCache[cid]) return Promise.resolve(guildIdCache[cid]);
    // GM-persisted cache (survives engine restarts)
    var gmKey = NS + 'guildId:' + cid;
    var stored = GM_getValue(gmKey, null);
    if (stored) { guildIdCache[cid] = stored; return Promise.resolve(stored); }
    return transport.getChannel(cid).then(function (ch) {
      var gid = (ch && ch.guild_id) || null;
      if (gid) { guildIdCache[cid] = gid; GM_setValue(gmKey, gid); }
      return gid;
    }, function () { return null; });
  }
  // config changes must not run on a stale instance: stop, rebuild, and restart if it was live
  // Push a config patch to all LIVE engines in-place (no rebuild, no restart).
  // Only for values in LIVE_PATCHABLE (read at call-time by the engine, not captured at startup).
  function patchEngines(patch) {
    Object.keys(engines).forEach(function (c) {
      var eng = engines[c];
      if (eng && typeof eng.updateConfig === 'function') eng.updateConfig(patch);
    });
  }

  function applyConfigChange() {
    var wasRunning = Object.keys(engines).some(function (c) { return engines[c] && engines[c].isRunning && engines[c].isRunning(); });
    eachEngine(function (e) { e.stop(); });
    engines = {};
    guildIdCache = {};
    if (wasRunning) ensureEngines().forEach(function (e) { e.start(); });
  }

  // Auto-detect the server's member count once, so reaction significance scales correctly out of the
  // box. Channel -> guild_id -> guild approximate_member_count. Only if not already set by the operator.
  function maybeDetectMemberCount() {
    if (cfgGet('serverMemberCount', 0) > 0) return Promise.resolve(0);
    var ch = primaryChannel();
    if (!ch) return Promise.resolve(0);
    return Promise.resolve(transport.getChannel(ch)).then(function (c) {
      var gid = c && c.guild_id;
      if (gid) { guildIdCache[ch] = gid; GM_setValue(NS + 'guildId:' + ch, gid); }   // cache for permaban
      if (!gid) return 0;
      return transport.getGuildMemberCount(gid).then(function (n) {
        if (n > 0) { cfgSet('serverMemberCount', n); patchEngines({ serverMemberCount: n }); bLog('[chloe] detected ~' + n + ' members; reaction significance scaled accordingly'); }
        return n;
      });
    }).catch(function () { return 0; });
  }

  function validate() {
    return transport.getMe().then(function (me) {
      if (!me || !me.id) return { ok: false, reason: 'no identity returned (check the token)' };
      cfgSet('botUserId', me.id); cfgSet('botName', me.username || '');
      applyConfigChange();  // rebuild (and restart if live) with the fresh identity
      maybeDetectMemberCount();   // fire-and-forget: scale reaction significance to the server
      return { ok: true, value: { id: me.id, username: me.username, bot: me.bot } };
    }).catch(function (e) { return { ok: false, reason: 'HTTP ' + (e.status || '?'), body: e.body || null }; });
  }
  function statusSnapshot() {
    return {
      version: VERSION, hasToken: hasToken(),
      channelId: cfgGet('channelId', ''), botUserId: cfgGet('botUserId', ''), botName: cfgGet('botName', ''),
      addressMode: cfgGet('addressMode', 'both'), volunteer: !!cfgGet('volunteer', false),
      greet: !!cfgGet('greet', false), memberCheck: !!cfgGet('memberCheck', false), backfill: !!cfgGet('backfill', false),
      dmReplies: !!cfgGet('dmReplies', false),
      publicChannels: [primaryChannel()].concat(cfgGet('channels', []) || []).filter(Boolean),
      dmChannels: declaredDmChannels(),
      ackReactions: cfgGet('ackReactions', true),
      singleParagraph: !!cfgGet('singleParagraph', false),
      lullFiller: !!cfgGet('lullFiller', false),
      checkins: !!cfgGet('checkins', false),
      factMemory: !!cfgGet('factMemory', false),
      contradictionAware: !!cfgGet('contradictionAware', false),
      conversationMemory: cfgGet('conversationMemory', true) !== false,
      timeAware: !!cfgGet('timeAware', false),
      deviceTime: !!cfgGet('deviceTime', false),
      operatorNote: (function () { var m = semInjectMap(); return (m['opnote'] && m['opnote'].text) ? String(m['opnote'].text) : ''; })(),
      timezoneOffsetMins: cfgGet('timezoneOffsetMins', 0),
      moodAware: !!cfgGet('moodAware', false),
      channelSummary: !!cfgGet('channelSummary', false),
      reflection: !!cfgGet('reflection', false),
      episodicMemory: !!cfgGet('episodicMemory', false),
      episodeGraph: cfgGet('episodeGraph', true) !== false,
      adaptivePace: cfgGet('adaptivePace', true) !== false,
      workingMemory: cfgGet('workingMemory', false) !== false,
      exactTokens: cfgGet('exactTokens', true) !== false,
      cleanOutput: cfgGet('cleanOutput', true) !== false,
      translate: cfgGet('translate', false) !== false,
      tokenizer: tokLoader.state(),
      idleDeliberation: cfgGet('idleDeliberation', false) !== false,
      deferredIntents: !!cfgGet('deferredIntents', false),
      attentionManager: cfgGet('attentionManager', false) !== false,
      selfKnowledge: cfgGet('selfKnowledge', false) !== false,
      goalObjects: cfgGet('goalObjects', true) !== false,
      idleConsolidation: cfgGet('idleConsolidation', true) !== false,
      relationshipTrust: !!cfgGet('relationshipTrust', false),
      ownAffect: !!cfgGet('ownAffect', false),
      proceduralModes: !!cfgGet('proceduralModes', false), procRules: cfgGet('procRules', []),
      reactionSummon: !!cfgGet('reactionSummon', false),
      brain: brainMeter.snapshot(),
      image: !!cfgGet('image', false),
      imageQueueMax: cfgGet('imageQueueMax', 8),
      imageMemory: !!cfgGet('imageMemory', false),
      imageEnhanceOffer: !!cfgGet('imageEnhanceOffer', false),
      autoMod: !!cfgGet('autoMod', false), autoModRules: cfgGet('autoModRules', []),
      engageMode: cfgGet('engageMode:' + primaryChannel(), cfgGet('engageMode', 'normal')),
      channels: channelList(),
      engageModes: (function () { var m = {}; channelList().forEach(function (c) { m[c] = cfgGet('engageMode:' + c, cfgGet('engageMode', 'normal')); }); return m; })(),
      runningByChannel: (function () { var m = {}; channelList().forEach(function (c) { m[c] = !!(engines[c] && engines[c].isRunning && engines[c].isRunning()); }); return m; })(),
      beats: cfgGet('beats', []),
      commandPrefixes: cfgGet('commandPrefixes', []),
      noticePinned: !!cfgGet('noticePinned', false), noticeText: cfgGet('noticeText', ''),
      personality: cfgGet('personality', null), personaAnchor: !!cfgGet('personaAnchor', false),
      character: cfgGet('character', null),
      gates: { emoji: gate('emoji', true), pings: gate('pings', false), everyone: gate('everyone', false), links: gate('links', false), channelLinks: gate('channelLinks', false) },
      pageLinked: !!pageSource,
      running: Object.keys(engines).some(function (c) { return engines[c] && engines[c].isRunning && engines[c].isRunning(); }),
      lastPoll: lastPoll
    };
  }

  // ---- control link: page (generator HTML panel) -> userscript (trusted surface) ------
  // Mirrors the skybridge trust shape: origin-checked, nonce-matched, scoped commands,
  // secrets never cross (the bot token is never returned to the page).
  // Perchance serves the control generator from a perchance.org origin OR, when the embed is
  // sandboxed (no allow-same-origin), from origin "null". Both are legitimate same-tab embeds; the
  // real protection is the same-tab link + nonce matching + the bot token never crossing to the page.
  // Rejecting "null" was a false-negative that broke detection inside sandboxed embeds while real
  // brain traffic (userscript-initiated, replied via the captured page handle) still flowed.
  var ORIGIN_OK = /^(null|https:\/\/([a-z0-9]{32}\.)?perchance\.org)$/;
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
        { var on = !!(args && args.on); cfgSet('volunteer', on); patchEngines({ volunteer: on }); return Promise.resolve({ ok: true, value: { volunteer: on } }); }
      case 'config.setGreet':
        { var g = !!(args && args.on); cfgSet('greet', g); patchEngines({ greet: g }); return Promise.resolve({ ok: true, value: { greet: g } }); }
      case 'config.setMemberCheck':
        { var mc = !!(args && args.on); cfgSet('memberCheck', mc); return Promise.resolve({ ok: true, value: { memberCheck: mc } }); }
      case 'config.setBackfill':
        { var bf = !!(args && args.on); cfgSet('backfill', bf); patchEngines({ backfill: bf }); return Promise.resolve({ ok: true, value: { backfill: bf } }); }
      case 'config.setImage':
        { var im = !!(args && args.on); cfgSet('image', im); patchEngines({ image: im }); return Promise.resolve({ ok: true, value: { image: im } }); }
      case 'config.setImageMemory':
        { var imm = !!(args && args.on); cfgSet('imageMemory', imm); patchEngines({ imageMemory: imm }); return Promise.resolve({ ok: true, value: { imageMemory: imm } }); }
      case 'config.setImageEnhanceOffer':
        { var ieo = !!(args && args.on); cfgSet('imageEnhanceOffer', ieo); patchEngines({ imageEnhanceOffer: ieo }); return Promise.resolve({ ok: true, value: { imageEnhanceOffer: ieo } }); }
      case 'config.setPrefixes': {
        var list = (args && args.prefixes);
        if (!Array.isArray(list)) return Promise.resolve({ ok: false, reason: 'prefixes must be an array' });
        var clean = [];
        list.forEach(function (p) { p = String(p || '').trim(); if (p && p !== '!chloe' && clean.indexOf(p) < 0) clean.push(p); });
        cfgSet('commandPrefixes', clean); patchEngines({ commandPrefixes: clean });
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
        cfgSet('beats', cleanB); patchEngines({ beats: cleanB });
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
      case 'config.setCharacter': {
        var nm = (args && args.name != null) ? String(args.name).trim() : null;
        if (!nm) { cfgSet('character', null); applyConfigChange(); return Promise.resolve({ ok: true, value: { character: null } }); }
        var ch = { name: nm.slice(0, 80), instruction: String((args && args.instruction) || '').slice(0, 8000), avatar: String((args && args.avatar) || '').slice(0, 2000) };
        cfgSet('character', ch); applyConfigChange();
        return Promise.resolve({ ok: true, value: { character: { name: ch.name } } });
      }
      case 'character.seedMemories': {
        var eS = engineFor(args && args.channelId); if (!eS) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var mems = (args && Array.isArray(args.memories)) ? args.memories : [];
        var who = String((args && args.name) || 'this character');
        if (!mems.length) return Promise.resolve({ ok: true, value: { seeded: 0 } });
        return eS.seedCharacterMemories(who, mems).then(function (n) { return { ok: true, value: { seeded: n } }; });
      }
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
      case 'config.setAllChannels': {
        // One unified list (UI: a single textarea). First valid id = primary, the rest = extras.
        var rawA = (args && args.channels);
        if (!Array.isArray(rawA)) return Promise.resolve({ ok: false, reason: 'channels must be an array of channel ids' });
        var cleanA = [], seenA = {};
        var dmsetA = {}; declaredDmChannels().forEach(function (d) { dmsetA[d] = 1; });
        rawA.forEach(function (c) { c = String(c || '').trim(); if (/^\d+$/.test(c) && !seenA[c] && !dmsetA[c]) { seenA[c] = 1; cleanA.push(c); } });   // never let a declared DM sit in the public list
        var primary = cleanA[0] || '';
        cfgSet('channelId', primary);
        cfgSet('channels', cleanA.slice(1));
        applyConfigChange();
        return Promise.resolve({ ok: true, value: { channels: channelList(), primary: primary } });
      }
      case 'config.setDmChannels': {
        // The "private DMs" box: channel ids to poll AND treat as DMs (isDM -> the public->DM merge runs).
        var rawD = (args && args.channels);
        if (!Array.isArray(rawD)) return Promise.resolve({ ok: false, reason: 'dmChannels must be an array of channel ids' });
        var cleanD = [], seenD = {};
        rawD.forEach(function (c) { c = String(c || '').trim(); if (/^\d+$/.test(c) && c !== primaryChannel() && !seenD[c]) { seenD[c] = 1; cleanD.push(c); } });
        cfgSet('dmChannels', cleanD);
        // keep the two boxes mutually exclusive: drop any newly-declared DM from the public extras
        var dmsetD = {}; cleanD.forEach(function (d) { dmsetD[d] = 1; });
        var pub = (cfgGet('channels', []) || []).filter(function (c) { return !dmsetD[String(c).trim()]; });
        cfgSet('channels', pub);
        applyConfigChange();
        return Promise.resolve({ ok: true, value: { dmChannels: cleanD, channels: channelList() } });
      }
      case 'config.setEngageMode': {
        var mode = (args && args.mode);
        if (mode !== 'locked' && mode !== 'normal' && mode !== 'open') return Promise.resolve({ ok: false, reason: 'mode must be locked|normal|open' });
        var emCh = chKeyOf(args);
        if (!emCh) return Promise.resolve({ ok: false, reason: 'no channel set' });
        cfgSet('engageMode:' + emCh, mode); patchEngines({ engageMode: mode });
        return Promise.resolve({ ok: true, value: { engageMode: mode, channelId: emCh } });
      }
      case 'config.setImageQueue': {
        var n = Math.max(1, Math.min(20, parseInt((args && args.max), 10) || 8));
        cfgSet('imageQueueMax', n); patchEngines({ imageQueueMax: n });
        return Promise.resolve({ ok: true, value: { imageQueueMax: n } });
      }
      case 'config.setAutoMod':
        { var am = !!(args && args.on); cfgSet('autoMod', am); patchEngines({ autoMod: am }); return Promise.resolve({ ok: true, value: { autoMod: am } }); }
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
        cfgSet('autoModRules', clean); patchEngines({ autoModRules: clean });
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
      case 'config.setAckReactions':
        { var ar = !!(args && args.on); cfgSet('ackReactions', ar); patchEngines({ ackReactions: ar }); return Promise.resolve({ ok: true, value: { ackReactions: ar } }); }
      case 'config.setSingleParagraph':
        { var sp = !!(args && args.on); cfgSet('singleParagraph', sp); patchEngines({ singleParagraph: sp }); return Promise.resolve({ ok: true, value: { singleParagraph: sp } }); }
      case 'config.setLullFiller':
        { var lf = !!(args && args.on); cfgSet('lullFiller', lf); patchEngines({ lullFiller: lf }); return Promise.resolve({ ok: true, value: { lullFiller: lf } }); }
      case 'config.setCheckins':
        { var ck = !!(args && args.on); cfgSet('checkins', ck); patchEngines({ checkins: ck }); return Promise.resolve({ ok: true, value: { checkins: ck } }); }
      case 'config.setConversationMemory':
        { var cmn = !!(args && args.on); cfgSet('conversationMemory', cmn); patchEngines({ conversationMemory: cmn }); return Promise.resolve({ ok: true, value: { conversationMemory: cmn } }); }
      case 'config.setContradictionAware':
        { var can = !!(args && args.on); cfgSet('contradictionAware', can); patchEngines({ contradictionAware: can }); return Promise.resolve({ ok: true, value: { contradictionAware: can } }); }
      case 'config.setFactMemory':
        { var fm = !!(args && args.on); cfgSet('factMemory', fm); patchEngines({ factMemory: fm }); return Promise.resolve({ ok: true, value: { factMemory: fm } }); }
      case 'config.setTimeAware':
        { var ta = !!(args && args.on); cfgSet('timeAware', ta);
          if (args && args.offsetMins != null && isFinite(args.offsetMins)) cfgSet('timezoneOffsetMins', Math.max(-840, Math.min(840, Math.round(args.offsetMins))));
          patchEngines({ timeAware: ta, timezoneOffsetMins: cfgGet('timezoneOffsetMins', 0) }); return Promise.resolve({ ok: true, value: { timeAware: ta, timezoneOffsetMins: cfgGet('timezoneOffsetMins', 0) } }); }
      case 'config.setMoodAware':
        { var ma = !!(args && args.on); cfgSet('moodAware', ma); patchEngines({ moodAware: ma }); return Promise.resolve({ ok: true, value: { moodAware: ma } }); }
      case 'config.setChannelSummary':
        { var csm = !!(args && args.on); cfgSet('channelSummary', csm); patchEngines({ channelSummary: csm }); return Promise.resolve({ ok: true, value: { channelSummary: csm } }); }
      case 'config.setAdaptivePace':
        { var apn = !!(args && args.on); cfgSet('adaptivePace', apn); patchEngines({ adaptivePace: apn }); return Promise.resolve({ ok: true, value: { adaptivePace: apn } }); }
      case 'config.setWorkingMemory':
        { var wmn = !!(args && args.on); cfgSet('workingMemory', wmn); patchEngines({ workingMemory: wmn }); return Promise.resolve({ ok: true, value: { workingMemory: wmn } }); }
      case 'config.setIdleDeliberation':
        { var idn = !!(args && args.on); cfgSet('idleDeliberation', idn); patchEngines({ idleDeliberation: idn }); return Promise.resolve({ ok: true, value: { idleDeliberation: idn } }); }
      case 'config.setDeferredIntents':
        { var din = !!(args && args.on); cfgSet('deferredIntents', din); patchEngines({ deferredIntents: din }); return Promise.resolve({ ok: true, value: { deferredIntents: din } }); }
      case 'config.setAttentionManager':
        { var amn = !!(args && args.on); cfgSet('attentionManager', amn); patchEngines({ attentionManager: amn }); return Promise.resolve({ ok: true, value: { attentionManager: amn } }); }
      case 'config.setSelfKnowledge':
        { var skn = !!(args && args.on); cfgSet('selfKnowledge', skn); patchEngines({ selfKnowledge: skn }); return Promise.resolve({ ok: true, value: { selfKnowledge: skn } }); }
      case 'config.setCleanOutput':
        { var con = !!(args && args.on); cfgSet('cleanOutput', con); patchEngines({ cleanOutput: con }); return Promise.resolve({ ok: true, value: { cleanOutput: con } }); }
      case 'config.setTranslate':
        { var trn = !!(args && args.on); cfgSet('translate', trn); patchEngines({ translate: trn }); return Promise.resolve({ ok: true, value: { translate: trn } }); }
      case 'config.setUserLang':
        { var ulE = engineFor(args && args.channelId); if (!ulE) return Promise.resolve({ ok: false, reason: 'no channel' }); return ulE.setUserLang(args && args.id, (args && args.lang) || null).then(function (v) { return { ok: true, value: { lang: v } }; }); }
      case 'config.setDeviceTime':
        { var dtn = !!(args && args.on); cfgSet('deviceTime', dtn); if (!dtn) semInjectDrop('devicetime'); patchEngines({ deviceTime: dtn }); return Promise.resolve({ ok: true, value: { deviceTime: dtn } }); }
      case 'config.setDeviceClock':
        { var dc = (args && args.clock) ? args.clock : null; var dcVal = dc ? { time: String(dc.time || ''), date: String(dc.date || ''), tz: String(dc.tz || ''), at: Date.now() } : null; if (dcVal) GM_setValue(NS + 'deviceClock', dcVal); else GM_deleteValue(NS + 'deviceClock'); patchEngines({ deviceClock: dcVal }); return Promise.resolve({ ok: true, value: { set: !!dc } }); }
      case 'config.setSemanticInjection':
        { var sid = String((args && args.id) || '').trim(); if (!sid) return Promise.resolve({ ok: false, reason: 'id required' });
          var txt = String((args && args.text) || '').trim(); if (!txt) { semInjectDrop(sid); patchEngines({ semanticInjections: semInjectList() }); return Promise.resolve({ ok: true, value: { id: sid, cleared: true } }); }
          semInjectUpsert({ id: sid, text: txt, priority: (args && args.priority) || null, ttlMs: (args && args.ttlMs) || null, at: Date.now() });
          patchEngines({ semanticInjections: semInjectList() }); return Promise.resolve({ ok: true, value: { id: sid } }); }
      case 'config.clearSemanticInjection':
        { var cid = String((args && args.id) || '').trim(); if (cid) semInjectDrop(cid); patchEngines({ semanticInjections: semInjectList() }); return Promise.resolve({ ok: true, value: { id: cid, cleared: true } }); }
      case 'config.setExactTokens':
        { var etn = !!(args && args.on); cfgSet('exactTokens', etn); if (etn) tokLoader.preload(); patchEngines({ exactTokens: etn }); return Promise.resolve({ ok: true, value: { exactTokens: etn, tokenizer: tokLoader.state() } }); }
      case 'work.get':
        { var ew = engineFor(args && args.channelId); if (!ew) return Promise.resolve({ ok: true, value: null }); return ew.workLoad().then(function (w) { return { ok: true, value: w }; }); }
      case 'config.setEpisodeGraph':
        { var egn = !!(args && args.on); cfgSet('episodeGraph', egn); patchEngines({ episodeGraph: egn }); return Promise.resolve({ ok: true, value: { episodeGraph: egn } }); }
      case 'config.setIdleConsolidation':
        { var icn = !!(args && args.on); cfgSet('idleConsolidation', icn); patchEngines({ idleConsolidation: icn }); return Promise.resolve({ ok: true, value: { idleConsolidation: icn } }); }
      case 'config.setGoalObjects':
        { var gob = !!(args && args.on); cfgSet('goalObjects', gob); patchEngines({ goalObjects: gob }); return Promise.resolve({ ok: true, value: { goalObjects: gob } }); }
      case 'config.setReflection':
        { var rfl = !!(args && args.on); cfgSet('reflection', rfl); patchEngines({ reflection: rfl }); return Promise.resolve({ ok: true, value: { reflection: rfl } }); }
      case 'config.setEpisodicMemory':
        { var epi = !!(args && args.on); cfgSet('episodicMemory', epi); patchEngines({ episodicMemory: epi }); return Promise.resolve({ ok: true, value: { episodicMemory: epi } }); }
      case 'config.setRelationshipTrust':
        { var rtr = !!(args && args.on); cfgSet('relationshipTrust', rtr); patchEngines({ relationshipTrust: rtr }); return Promise.resolve({ ok: true, value: { relationshipTrust: rtr } }); }
      case 'config.setOwnAffect':
        { var oaf = !!(args && args.on); cfgSet('ownAffect', oaf); patchEngines({ ownAffect: oaf }); return Promise.resolve({ ok: true, value: { ownAffect: oaf } }); }
      case 'config.setProceduralModes':
        { var prm = !!(args && args.on); cfgSet('proceduralModes', prm); patchEngines({ proceduralModes: prm }); return Promise.resolve({ ok: true, value: { proceduralModes: prm } }); }
      case 'config.setReactionSummon':
        { var rsm = !!(args && args.on); cfgSet('reactionSummon', rsm); patchEngines({ reactionSummon: rsm }); return Promise.resolve({ ok: true, value: { reactionSummon: rsm } }); }
      case 'config.setProcRules': {
        // Validate + clean: [{ emoji, mode, minutes }] -> [{ emoji, mode (sanitized later by the
        // engine), durationMs }]. Hard caps here so malformed panel input can't smuggle anything in.
        var raw = (args && Array.isArray(args.rules)) ? args.rules : null;
        if (!raw) return Promise.resolve({ ok: false, reason: 'rules must be a JSON array' });
        var cleanPR = [];
        for (var pi = 0; pi < raw.length && cleanPR.length < 12; pi++) {
          var o = raw[pi]; if (!o || typeof o !== 'object') continue;
          var em = String(o.emoji || '').trim();
          var mode = String(o.mode || '').replace(/\s+/g, ' ').trim().slice(0, 100);
          var mins = Math.round(Number(o.minutes != null ? o.minutes : 60));
          if (!em || em.length > 8 || !mode) continue;            // a unicode emoji, not custom <:name:id>
          if (!(mins >= 1)) mins = 60;
          cleanPR.push({ emoji: em, mode: mode, durationMs: Math.min(mins, 1440) * 60000 });
        }
        cfgSet('procRules', cleanPR); patchEngines({ procRules: cleanPR });
        return Promise.resolve({ ok: true, value: { count: cleanPR.length, rules: cleanPR.map(function (r) { return { emoji: r.emoji, mode: r.mode, minutes: Math.round(r.durationMs / 60000) }; }) } });
      }
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
      case 'memory.get':        { var em1 = engineFor(args && args.channelId); if (!em1) return Promise.resolve({ ok: false, reason: 'no channel' }); return em1.getMemory(args && args.id).then(function (v) { return { ok: true, value: v }; }); }
      case 'memory.editFact':   { var em2 = engineFor(args && args.channelId); if (!em2) return Promise.resolve({ ok: false, reason: 'no channel' }); return em2.editFact(args && args.id, args && args.factId, { text: args && args.text, importance: args && args.importance }).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'not found' }; }); }
      case 'memory.deleteFact': { var em3 = engineFor(args && args.channelId); if (!em3) return Promise.resolve({ ok: false, reason: 'no channel' }); return em3.deleteFact(args && args.id, args && args.factId).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'not found' }; }); }
      case 'memory.addFact':    { var em4 = engineFor(args && args.channelId); if (!em4) return Promise.resolve({ ok: false, reason: 'no channel' }); return em4.addUserFact(args && args.id, args && args.text, args && args.importance, args && args.name).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'empty or failed' }; }); }
      case 'memory.editInsight':{ var em5 = engineFor(args && args.channelId); if (!em5) return Promise.resolve({ ok: false, reason: 'no channel' }); return em5.editInsight(args && args.id, args && args.insId, args && args.text).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'not found' }; }); }
      case 'memory.deleteInsight':{ var em6 = engineFor(args && args.channelId); if (!em6) return Promise.resolve({ ok: false, reason: 'no channel' }); return em6.deleteInsight(args && args.id, args && args.insId).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'not found' }; }); }
      case 'context.excise':    { var ex1 = engineFor(args && args.channelId); if (!ex1) return Promise.resolve({ ok: false, reason: 'no channel' }); return ex1.exciseMessage(args && args.msgId).then(function (v) { return { ok: true, value: v }; }); }
      case 'context.exciseLast':{ var ex2 = engineFor(args && args.channelId); if (!ex2) return Promise.resolve({ ok: false, reason: 'no channel' }); return ex2.exciseLastFromUser(args && args.id, args && args.n).then(function (v) { return { ok: true, value: v }; }); }
      case 'ring.get':        { var e4 = engineFor(args && args.channelId); if (!e4) return Promise.resolve({ ok: true, value: [] }); return e4.getSpeakerRing().then(function (r) { return { ok: true, value: r }; }); }
      case 'reset':           return resetState(true).then(function () { return { ok: true }; });
      case 'factory-reset':   return factoryReset();
      case 'export-state':    return Promise.resolve({ ok: true, value: exportState() });
      case 'import-state':    return importState(args && args.data);
      // ---- T3 moderation: trusted (panel) actions + mod-list management ----
      case 'mod.action': {
        var act = String((args && args.action) || '');
        if (act === 'permaban') return Promise.resolve({ ok: false, reason: 'unimplemented (T4; irreversible purge requires a confirm in the trusted surface)' });
        var e5 = engineFor(args && args.channelId); if (!e5) return Promise.resolve({ ok: false, reason: 'no channel set' });
        return e5.applyModAction(act, String((args && args.id) || ''), { durationMs: args && args.durationMs, reason: args && args.reason, byModId: 'panel' });
      }
      case 'mod.listMods': return Promise.resolve({ ok: true, value: cfgGet('modList', []) });
      case 'mod.listBanned': {
        // Merge banned users across ALL channel engines (blocklist is per-store).
        var lbEngs = ensureEngines();
        if (!lbEngs.length) return Promise.resolve({ ok: true, value: [] });
        return Promise.all(lbEngs.map(function (eng) { return eng.listBlocked(); })).then(function (allBl) {
          var seen = {}, rows = [];
          allBl.forEach(function (bl) {
            Object.keys((bl && bl.ids) || {}).forEach(function (id) {
              if (!seen[id]) {
                seen[id] = true;
                var meta = bl.ids[id] || {};
                rows.push({ id: id, name: meta.name || id, reason: meta.reason || '', at: meta.at || null, by: meta.by || null });
              }
            });
          });
          rows.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
          return { ok: true, value: rows };
        });
      }
      case 'mod.unban': {
        var ubId = String((args && args.id) || '').trim();
        var ubName = String((args && args.name) || ubId);
        if (!ubId) return Promise.resolve({ ok: false, reason: 'no target id' });
        // Unblock across ALL channel engines — the blocklist is per-store (per channel),
        // so a ban on any channel must be lifted everywhere to fully unblock the user.
        var ubEngs = ensureEngines(); if (!ubEngs.length) return Promise.resolve({ ok: false, reason: 'no channels' });
        return Promise.all(ubEngs.map(function (eng) {
          return eng.unblockUser({ id: ubId, name: ubName });
        })).then(function (results) {
          var any = results.some(function (r) { return r && r.ok; });
          var e9 = engineFor(args && args.channelId) || ubEngs[0];
          if (any) e9.appendModLog({ action: 'unban', targetId: ubId, name: ubName, byModId: 'panel', reason: 'panel unban', at: Date.now() }).catch(function () {});
          return { ok: true, value: { id: ubId, name: ubName, removedFrom: results.filter(function(r){return r&&r.ok;}).length } };
        });
      }
      case 'mod.addMod': {
        var idA = String((args && args.id) || '').trim(); if (!idA) return Promise.resolve({ ok: false, reason: 'no id' });
        var listA = cfgGet('modList', []); if (listA.indexOf(idA) < 0) listA.push(idA); cfgSet('modList', listA); patchEngines({ modList: listA });
        return Promise.resolve({ ok: true, value: listA });
      }
      case 'mod.removeMod': {
        var idR = String((args && args.id) || '').trim();
        var listR = cfgGet('modList', []).filter(function (x) { return x !== idR; }); cfgSet('modList', listR); patchEngines({ modList: listR });
        return Promise.resolve({ ok: true, value: listR });
      }
      case 'mod.modlog': {
        var e6 = engineFor(args && args.channelId); if (!e6) return Promise.resolve({ ok: true, value: [] });
        return e6.getModLog().then(function (l) { return { ok: true, value: l }; });
      }
      // T4 logging helper: console.log + pushEvent so messages appear in BOTH the browser console
      // and the panel feed (classified as MODERATION by the [chloe.T4] prefix).
      // T4: Discord ban + local prune. Local prune (block + purge) always runs whether or not the
      // Discord server ban succeeds — so the operator always gets a clean local state. A failed or
      // unavailable Discord ban is logged but never blocks the purge.
      case 'mod.permaban': {
        var pid = String((args && args.id) || '').trim();
        var pname = String((args && args.name) || pid);
        var preason = (args && args.reason) || 'Chloe permaban';
        if (!pid) return Promise.resolve({ ok: false, reason: 'no target' });
        var e7 = engineFor(args && args.channelId); if (!e7) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var sure = false;
        try { sure = window.confirm('PRUNE "' + pname + '"?\n\nThis permanently blocks their user ID and deletes everything Chloe remembers about them. This cannot be undone.'); } catch (e) { sure = false; }
        if (!sure) { bLog('[chloe.T4] prune of ' + pname + ' cancelled'); return Promise.resolve({ ok: false, reason: 'cancelled' }); }
        // Local prune only: block the user ID + purge memory.
        // Discord server-level ban intentionally disabled. To re-enable, see ROADMAP.md v0.76.9.
        return e7.blockUser({ id: pid, name: pname, reason: preason, byModId: 'panel' }).then(function () {
          return e7.purge(pid, { targetName: pname });
        }).then(function (pr) {
          if (!pr || !pr.ok) { bLog('[chloe.T4] PURGE NOT VERIFIED for ' + pname + ': ' + (pr && pr.reason)); return { ok: false, reason: (pr && pr.reason) || 'purge failed' }; }
          return e7.appendModLog({ action: 'local-prune', targetId: pid, name: pname, byModId: 'panel', reason: preason, at: Date.now() }).then(function () {
            bLog('[chloe.T4] prune complete for ' + pname + ' (blocked + purged)');
            return { ok: true, value: { purged: true, verified: true, name: pname } };
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
    // Self-heal a mis-captured tab: receiving a page message means THIS tab hosts a generator panel a
    // user is actively using — a real control surface, not a background-spawned worker. If it somehow
    // booted as a worker (e.g. a stale '#chloe-worker' left in the URL by an older build), shed that
    // role: strip the hash and stand for the queen election so the engine can actually run here.
    if (TAB_ROLE === 'worker' && !workerSelfHealTried) {
      workerSelfHealTried = true;
      try { if (/chloe-worker/.test(location.hash || '')) history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      // Contest the election. onPromote flips TAB_ROLE to 'queen' if this tab wins (no live queen);
      // if a real queen exists this stays a worker, but at least the stale URL hash is cleaned so a
      // future reload doesn't boot as a worker again.
      try {
        if (tabBridge && typeof tabBridge.standForQueen === 'function') tabBridge.standForQueen();
        else { TAB_ROLE = 'queen'; }   // no bus/bridge (single-tab) — just reclaim
      } catch (e) {}
      trace('bridge', 'a panel is attached to a worker-roled tab — cleaned stale worker hash and contested the queen election');
      bLog('[chloe-bridge] this tab hosts the control panel but had a stale worker role; reclaiming.');
    }
    if (d.kind === 'callres') { var cb = callPending.get(d.nonce); if (cb) { callPending.delete(d.nonce); cb(d); } return; }
    if (d.kind !== 'req') return;
    var nonce = d.nonce, source = ev.source, origin = ev.origin;
    // The page now fans a request out to several candidate frames so it reaches us regardless of
    // embed topology. If more than one copy reaches this listener, handle the FIRST and drop the
    // rest SILENTLY — sending a second (e.g. {ok:true,value:null}) reply could win the race on the
    // page and clobber the real result (this broke Validate Token: res.value was null).
    if (nonce) {
      if (seenReqNonces.has(nonce)) return;   // duplicate fan-out copy: ignore, the first copy replies
      seenReqNonces.add(nonce);
      if (seenReqNonces.size > 400) { var it = seenReqNonces.values().next(); if (!it.done) seenReqNonces.delete(it.value); }
    }
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
      capable: function () { return !!pageSource; },   // can this tab actually run a brain job (has a linked control page)?
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
        bLog('[chloe-bridge] this tab was promoted to QUEEN (the previous queen tab went silent).');
        if (cfgGet('autoResume', false)) { try { ensureEngines().forEach(function (e) { e.start(); }); } catch (e) { trace('bridge', 'auto-resume failed: ' + (e && e.message)); } }
      },
      // D6: a lease conflict said another tab is queen — stand down completely.
      onDemote: function () {
        TAB_ROLE = 'worker';
        eachEngine(function (e) { e.stop(); });
        // NOTE: we deliberately do NOT write location.hash here. Role is in-memory state. Stamping
        // '#chloe-worker' into the URL is sticky (TAB_ROLE is read from the hash at load), so it would
        // permanently convert an ordinary perchance tab — or the Chloe generator itself — into a worker
        // that can never start the engine. That mis-capture made the bot look dead/"not detected".
        trace('bridge', 'demoted to worker (another queen holds the lease); engines stopped');
      }
    });
    // Every tab registers job handlers: a worker serves them now; a queen may be demoted later
    // (sleep/wake revival) and must be able to serve them then.
    tabBridge.onJob('echo', function (args) { return Promise.resolve(args == null ? null : args); });
    tabBridge.onJob('brain', function (p) {
      p = p || {};
      // If this worker has no control page, REJECT so the queen's dispatchJob fallback runs the call
      // on a page-having tab. Resolving {ok:false} here would look like a successful empty answer and
      // the reply/paint would be silently dropped.
      if (!pageSource) return Promise.reject(new Error('worker has no control page'));
      return callPage(String(p.kind || 'respond'), p.args || {}, p.timeoutMs || 40000).then(function (res) {
        if (res && res.ok === false && /no control page/.test(String(res.reason || ''))) throw new Error('worker lost its control page');
        return res;
      });
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
    var s = tokenShape(t); bLog('[chloe] token saved — shape: ' + JSON.stringify(s));
    if (s.placeholder || s.parts !== 3) bLog('[chloe] WARNING: does not look like a bot token (expect ~70+ chars, 3 dot-parts).');
  }
  function resetState(silent) {
    if (!silent && !confirm('Reset state (cursor, roster, ring) for ALL channels? Token is NOT touched.')) return Promise.resolve();
    var chain = Promise.resolve();
    channelList().forEach(function (ch) {
      var pfx = prefixFor(ch), st = makeStore(pfx);
      chain = chain.then(function () {
        return st.listIndex().then(function (ids) {
          (ids || []).forEach(function (id) { GM_deleteValue(NS + pfx + 'u:' + id); });
          // clear archived ("historical friend") users too, via their index
          var archIdx = []; try { archIdx = JSON.parse(GM_getValue(NS + pfx + 'arch:index:' + ch, '[]')) || []; } catch (e) {}
          archIdx.forEach(function (id) { GM_deleteValue(NS + pfx + 'arch:' + ch + ':u:' + id); });
          // every per-channel state key (kept in sync with the engine's *_KEY set) so a reset is a true clean slate
          ['cursor:' + ch, 'roster:index', 'speaker:ring:' + ch, 'rhythm:' + ch, 'mood:' + ch,
           'intent:' + ch, 'reminders:' + ch, 'afk:' + ch, 'highlights:' + ch, 'reacttally:' + ch,
           'lull:' + ch, 'checkins:' + ch, 'beats:lastrun:' + ch, 'selfintents:' + ch, 'ownlines:' + ch, 'arch:index:' + ch,
           'modlog', 'backfill:' + ch, 'blocklist'].forEach(function (k) { GM_deleteValue(NS + pfx + k); });
          GM_deleteValue(NS + 'cfg:backfillDone:' + ch);
        });
      });
    });
    return chain.then(function () { eachEngine(function (e) { e.stop(); }); engines = {}; lastPoll = null; bLog('[chloe] state reset for all channels.'); });
  }
  // ---- factory reset (wipes EVERYTHING including cfg, keeps token by default) ----------
  function factoryReset() {
    // First do the standard state reset (partitions, cursors, rings...)
    return resetState(true).then(function () {
      // Then wipe all cfg keys except the token (keeps the bot connected)
      var keep = ['token'];
      var allCfg = [
        'botUserId','botName','botAliases','channelId','channels','dmChannels','addressMode','engageMode',
        'volunteer','greet','backfill','memberCheck','image','imageQueueMax','imageMemory','imageEnhanceOffer','ackReactions','singleParagraph',
        'lullFiller','checkins','factMemory','moodAware','channelSummary','adaptivePace',
        'workingMemory','idleDeliberation','attentionManager','selfKnowledge','cleanOutput',
        'translate','deviceTime','exactTokens','episodeGraph','idleConsolidation','goalObjects',
        'reflection','episodicMemory','relationshipTrust','ownAffect','proceduralModes',
        'reactionSummon','autoMod','autoModRules','commandPrefixes','beats','procRules',
        'modList','serverMemberCount','timeAware','timezoneOffsetMins','personality',
        'character','personaAnchor','noticeText','noticeMsgId','noticePinned','dmReplies','dmSessions','poolSize',
        'sendBudgetMs','sendMinGapMs','requestTokenBudget','typingRefreshMs','pollBusyCeilMs',
        'spawnBackoffMs','strikeDecayMs','strikeLadder','queenDeadAfterMs','archiveStale',
        'reactionTracking','reactionAutoHighlight','gateEmoji','gatePings','gateEveryone',
        'gateLinks','gateChannelLinks','autoResume','gate:emoji','gate:pings','gate:everyone',
        'gate:links','gate:channelLinks'
      ];
      allCfg.forEach(function (k) {
        if (keep.indexOf(k) < 0) GM_deleteValue(NS + 'cfg:' + k);
      });
      // Wipe top-level non-cfg keys (seminject, deviceClock, guildId cache, bus token, queen lease)
      GM_deleteValue(NS + 'seminject:map');
      GM_deleteValue(NS + 'deviceClock');
      GM_deleteValue(NS + 'blocklist');   // primary channel blocklist (prefix '')
      // guildId: keys are per-channel — wipe them all via known channels
      channelList().forEach(function (ch) { GM_deleteValue(NS + 'guildId:' + ch); });
      eachEngine(function (e) { e.stop(); }); engines = {}; lastPoll = null;
      bLog('[chloe] factory reset complete — all state and config cleared (token kept).');
      return { ok: true };
    });
  }

  // ---- export: collect all known GM keys into a snapshot object ----------------------
  function exportState() {
    var snap = { _version: VERSION, _exported: new Date().toISOString(), _note: 'Chloe-bot state backup. Token is NOT included. Import via the panel System tab.' };
    // cfg keys (everything except the token)
    var cfgKeys = [
      'botUserId','botName','botAliases','channelId','channels','dmChannels','addressMode','engageMode',
      'volunteer','greet','backfill','memberCheck','image','imageQueueMax','imageMemory','imageEnhanceOffer','ackReactions','singleParagraph',
      'lullFiller','checkins','factMemory','moodAware','channelSummary','adaptivePace',
      'workingMemory','idleDeliberation','attentionManager','selfKnowledge','cleanOutput',
      'translate','deviceTime','exactTokens','episodeGraph','idleConsolidation','goalObjects',
      'reflection','episodicMemory','relationshipTrust','ownAffect','proceduralModes',
      'reactionSummon','autoMod','autoModRules','commandPrefixes','beats','procRules',
      'modList','serverMemberCount','timeAware','timezoneOffsetMins','personality',
      'character','personaAnchor','noticeText','dmReplies','dmSessions','poolSize',
      'sendBudgetMs','sendMinGapMs','requestTokenBudget','typingRefreshMs','pollBusyCeilMs',
      'spawnBackoffMs','strikeDecayMs','strikeLadder','queenDeadAfterMs','archiveStale',
      'reactionTracking','reactionAutoHighlight','gate:emoji','gate:pings','gate:everyone',
      'gate:links','gate:channelLinks','autoResume'
    ];
    var cfg = {};
    cfgKeys.forEach(function (k) { var v = GM_getValue(NS + 'cfg:' + k, null); if (v != null) cfg[k] = v; });
    snap.cfg = cfg;
    // top-level keys
    var tl = {};
    var tlKeys = ['seminject:map','deviceClock'];
    tlKeys.forEach(function (k) { var v = GM_getValue(NS + k, null); if (v != null) tl[k] = v; });
    channelList().forEach(function (ch) { var v = GM_getValue(NS + 'guildId:' + ch, null); if (v != null) tl['guildId:' + ch] = v; });
    snap.topLevel = tl;
    // per-channel store data
    var channels = {};
    channelList().forEach(function (ch) {
      var pfx = prefixFor(ch);
      var chData = {};
      // roster index + all user partitions
      var idx = []; try { idx = JSON.parse(GM_getValue(NS + pfx + 'roster:index', '[]')) || []; } catch (e) {}
      chData['roster:index'] = idx;
      idx.forEach(function (id) { var v = GM_getValue(NS + pfx + 'u:' + id, null); if (v != null) chData['u:' + id] = v; });
      // archive index + archive partitions
      var archIdx = []; try { archIdx = JSON.parse(GM_getValue(NS + pfx + 'arch:index:' + ch, '[]')) || []; } catch (e) {}
      if (archIdx.length) {
        chData['arch:index:' + ch] = archIdx;
        archIdx.forEach(function (id) { var v = GM_getValue(NS + pfx + 'arch:' + ch + ':u:' + id, null); if (v != null) chData['arch:' + ch + ':u:' + id] = v; });
      }
      // per-channel state keys
      ['cursor:'+ch,'speaker:ring:'+ch,'rhythm:'+ch,'mood:'+ch,'intent:'+ch,'reminders:'+ch,
       'afk:'+ch,'highlights:'+ch,'reacttally:'+ch,'lull:'+ch,'checkins:'+ch,
       'beats:lastrun:'+ch,'modlog','chansum:'+ch,'epi:'+ch,'affect:'+ch,'work:'+ch,
       'delib:'+ch,'procmode:'+ch,'charmem','goals','consolidate:'+ch,'backfill:'+ch,'selfintents:'+ch,'ownlines:'+ch
      ].forEach(function (k) { var v = GM_getValue(NS + pfx + k, null); if (v != null) chData[k] = v; });
      channels[ch] = chData;
    });
    snap.channels = channels;
    return snap;
  }

  // ---- import: restore a snapshot (merges cfg, restores channel data) -----------------
  function importState(data) {
    if (!data || typeof data !== 'object') return Promise.resolve({ ok: false, reason: 'invalid backup data' });
    try {
      // cfg keys
      var cfg = data.cfg || {};
      Object.keys(cfg).forEach(function (k) { GM_setValue(NS + 'cfg:' + k, cfg[k]); });
      // top-level keys
      var tl = data.topLevel || {};
      Object.keys(tl).forEach(function (k) { GM_setValue(NS + k, tl[k]); });
      // per-channel data
      var channels = data.channels || {};
      Object.keys(channels).forEach(function (ch) {
        var pfx = prefixFor(ch);
        var chData = channels[ch];
        Object.keys(chData).forEach(function (k) { GM_setValue(NS + pfx + k, chData[k]); });
      });
      eachEngine(function (e) { e.stop(); }); engines = {}; lastPoll = null;
      bLog('[chloe] state imported from backup (v' + (data._version || '?') + ', exported ' + (data._exported || '?') + '). Restart to apply.');
      return Promise.resolve({ ok: true, value: { version: data._version, exported: data._exported } });
    } catch (err) {
      return Promise.resolve({ ok: false, reason: 'import failed: ' + (err && err.message) });
    }
  }

  GM_registerMenuCommand('Set bot token', promptToken);
  GM_registerMenuCommand('Reset T0 state (keeps token)', function () { resetState(false); });

  // Warm the exact tokenizer in the background so the first reply's budget is already precise.
  if (cfgGet('exactTokens', true)) { try { tokLoader.preload(); } catch (e) {} }

  console.log('[chloe-bridge ' + VERSION + '] loaded as ' + TAB_ROLE + '. token set:', hasToken(),
    '| channel set:', !!cfgGet('channelId', ''), '\n  Open your Chloe control generator on this same perchance.org tab to drive it.');
})();
