/* chloe-nation — the Seven Nations: the top, human-readable brain layer.
 *
 * Seven small faculties of mind each weigh in on what to say. Their votes are tallied by the weights you set,
 * using the same Brain sub-system underneath (ChloeBrain.resolve), and the winning reply is spoken. Seven, so a
 * vote can never tie. This layer is deliberately simple and readable — it sits ABOVE the compiled brain.min.js,
 * while the memory and personality underneath stay with the mouth.
 *
 * It knows what it is and never refuses to say so: ask it and it volunteers (see `about`).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node / harness
  root.ChloeNation = api;                                                    // window / app
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The seven nations. Each has a plain-English purpose and a "lean" — what it values in a reply.
  // lean features:  warm (sounds caring) · clear (a readable, sane length) · open (ends on a real question)
  //                 play (a little voice / action) · calm (not over-long, not frantic)
  var NATIONS = [
    { id: 'heart',      purpose: 'Make sure she sounds like she cares.',            lean: { warm: 1.0, clear: 0.3 } },
    { id: 'reason',     purpose: 'Keep it clear, honest, and easy to follow.',      lean: { clear: 1.0, calm: 0.4 } },
    { id: 'memory',     purpose: 'Keep her consistent with what she knows of you.', lean: { warm: 0.5, clear: 0.5 } },
    { id: 'instinct',   purpose: 'Flag anything that feels off, unsafe, or false.', lean: { calm: 1.0, clear: 0.3 } },
    { id: 'voice',      purpose: 'Keep her voice distinct and natural.',            lean: { play: 1.0, warm: 0.3 } },
    { id: 'conscience', purpose: 'Protect your wellbeing, above all.',              lean: { warm: 0.7, calm: 0.6 } },
    { id: 'play',       purpose: 'Keep it alive, curious, and human.',              lean: { open: 1.0, play: 0.5 } }
  ];

  // Pure: read one reply through a nation's lean and return a score. Simple and inspectable on purpose.
  function gauge(text, lean) {
    var t = String(text || '').trim(), len = t.length;
    var f = {
      warm:  Math.min(1, (t.match(/\b(here|with you|understand|sorry|glad|proud|care|okay|together|listening)\b/gi) || []).length / 3),
      clear: len < 8 ? 0 : (len > 600 ? 0.3 : Math.min(1, 0.4 + Math.min(len, 240) / 240 * 0.6)),
      open:  /\?\s*$/.test(t) ? 1 : 0,
      play:  /\*[^*]+\*/.test(t) ? 1 : 0,
      calm:  len > 600 ? 0.2 : (len < 8 ? 0.3 : 1)
    };
    var s = 0; for (var k in lean) s += (lean[k] || 0) * (f[k] || 0);
    return s;
  }

  // ---- a small, pure sentiment/cue reader — no model needed, just a quick read of a line ----
  var CUES = {
    warmth:   /\b(care|love|here|with you|thank|thanks|glad|sorry|okay|proud|hug|miss you|appreciate)\b/gi,
    distress: /\b(sad|hurt|alone|lonely|scared|afraid|anxious|tired|exhausted|can'?t|hate|awful|cry|crying|lost|empty|worthless|hopeless)\b/gi,
    humor:    /\b(lol|lmao|haha+|hah|funny|joke|kidding|teasing|silly)\b|:\)|:d|\bxd\b/gi,
    anger:    /\b(angry|mad|furious|stupid|shut up|annoying|annoyed|hell|damn|ugh)\b/gi
  };
  function read(text) {
    var t = String(text || ''); function c(re) { var m = t.match(re); return m ? m.length : 0; }
    return { warmth: c(CUES.warmth), distress: c(CUES.distress), humor: c(CUES.humor) + (/!/.test(t) ? 0.4 : 0), anger: c(CUES.anger), question: /\?/.test(t) ? 1 : 0, len: t.trim().length };
  }
  // each nation's temperament — how cues land for it (+pleased / -troubled). This is its personality of feeling.
  var TEMPER = {
    heart:      { warmth: 1.0, distress: -0.6, anger: -0.4, humor: 0.2 },
    reason:     { question: 0.8, anger: -0.3, distress: -0.1 },
    memory:     { warmth: 0.4, distress: 0.3 },
    instinct:   { anger: -1.0, distress: -0.7 },
    voice:      { humor: 0.6, warmth: 0.3 },
    conscience: { distress: -1.0, anger: -0.5, warmth: 0.4 },
    play:       { humor: 1.0, anger: -0.4, distress: -0.3 }
  };
  // each nation's natural intent — the move it reaches for
  var INTENT = { heart: 'comfort', reason: 'ground', memory: 'recall', instinct: 'caution', voice: 'express', conscience: 'protect', play: 'play' };

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function clamp11(x) { return x < -1 ? -1 : x > 1 ? 1 : x; }
  function r2(x) { return Math.round(x * 100) / 100; }

  // A pure mind for one nation member: it perceives turns, reacts through its temperament, models the user,
  // holds bonds to the others, and proposes an intent. No DOM, no network — all local.
  function createMind(nation) {
    var temper = TEMPER[nation.id] || {};
    var self = { id: nation.id, purpose: nation.purpose, persona: null, mood: 0.5, lastSaid: null };
    var working = [];                                   // recent turns it is aware of
    var bonds = {};                                     // who -> affinity (-1..1)
    var user = { description: '', sentiment: 0, engagement: 0, lastSaid: null };

    function felt(cues) { var v = 0; for (var k in temper) v += temper[k] * (cues[k] || 0); return v; }
    function remember(turn) { working.push({ who: turn.who, role: turn.role, text: String(turn.text || '').slice(0, 400) }); if (working.length > 8) working.shift(); }

    function perceive(turn) {                           // take in a turn: what the user/another character/itself said
      remember(turn);
      var cues = read(turn.text);
      if (turn.role === 'user') {
        user.sentiment = clamp11(user.sentiment * 0.7 + (cues.warmth + cues.humor - cues.distress - cues.anger) * 0.15);
        user.engagement = clamp01(user.engagement * 0.8 + Math.min(1, cues.len / 120) * 0.2);
        user.lastSaid = turn.text;
      }
      return cues;
    }
    function react(turn) {                              // react through temperament — to others AND to itself
      var v = felt(read(turn.text));
      self.mood = clamp01(self.mood * 0.8 + (0.5 + v * 0.1) * 0.2);
      var key = turn.who || turn.role;
      if (turn.role !== 'self') bonds[key] = clamp11((bonds[key] || 0) * 0.85 + v * 0.15);   // warm to those who please me
      return { by: self.id, toward: key, valence: clamp11(v), mood: r2(self.mood) };
    }
    function intend(/* ctx */) {                        // how strongly it feels called to speak, and to do what
      var last = working[working.length - 1], cues = last ? read(last.text) : {};
      var pull = Math.abs(felt(cues));
      var strength = clamp01(0.3 + self.mood * 0.3 + pull * 0.15 + (self.persona ? 0.15 : 0));
      return { by: self.id, kind: INTENT[nation.id] || 'express', strength: strength, persona: self.persona };
    }
    function voteIntent(it) {                           // score another member's intent through my nature + our bond
      if (!it || it.by === self.id) return 0;
      var align = it.kind === INTENT[nation.id] ? 0.25 : 0;
      return clamp01(it.strength * 0.7 + align + (bonds[it.by] || 0) * 0.2);
    }
    function said(text) { self.lastSaid = text; working.push({ who: self.id, role: 'self', text: String(text || '').slice(0, 400) }); if (working.length > 8) working.shift(); }
    function describe() {
      return { id: self.id, purpose: self.purpose, persona: self.persona && self.persona.name || null, mood: r2(self.mood),
        readsUser: user.sentiment > 0.15 ? 'warming' : (user.sentiment < -0.15 ? 'struggling' : 'steady'),
        lastSaid: self.lastSaid, bonds: bonds, knows: working.length };
    }
    return { self: self, working: working, bonds: bonds, user: user,
      perceive: perceive, react: react, intend: intend, voteIntent: voteIntent, said: said, describe: describe,
      setPersona: function (p) { self.persona = p || null; } };
  }


  function createArmy(deps) {
    deps = deps || {};
    var brain = deps.brain || null;                  // ChloeBrain — the sub-system (resolve)
    var cfg = deps.config || {};                     // { weights:{id:n}, enabled:{id:bool}, timeoutMs, useForReplies, noise }
    var roster = (deps.nations || NATIONS).slice();
    var rng = deps.rng || Math.random;               // injectable so tests stay deterministic

    function weightOf(id) { var w = (cfg.weights || {})[id]; return (w == null) ? 1 : Number(w); }
    function isOn(id) { return (cfg.enabled || {})[id] !== false; }
    // a very weak, low-level jitter so the ecosystem isn't perfectly static. Defaults to 0 (deterministic);
    // the mouth sets a small live value. Bounded: a score never moves more than `noise` of itself.
    function jitter(s) { var n = Number(cfg.noise) || 0; return n <= 0 ? s : Math.max(0, s * (1 + n * (rng() * 2 - 1))); }

    // Run the live nations over a few candidate replies; tally their weighted votes through the Brain sub-system.
    function deliberate(candidates, ctx) {
      candidates = (candidates || []).filter(function (c) { return c && c.text != null; });
      if (!candidates.length) return Promise.resolve({ status: 'no-candidates', text: null, winnerId: null, nations: [], size: 0 });
      var live = roster.filter(function (n) { return isOn(n.id); });
      var ballots = [], breakdown = [];
      live.forEach(function (n) {
        var w = weightOf(n.id), scores = {}, prefer = null, best = -Infinity;
        candidates.forEach(function (c) { var s = jitter(gauge(c.text, n.lean) * w); scores[c.by] = s; if (s > best) { best = s; prefer = c.by; } });
        ballots.push({ voter: n.id, scores: scores });
        breakdown.push({ id: n.id, weight: w, prefer: prefer });
      });
      var decide = (brain && brain.resolve) ? brain.resolve : localResolve;   // reuse the sub-system when present
      var decision = decide(candidates, ballots, [], {});
      decision.nations = breakdown;
      decision.size = live.length;
      return Promise.resolve(decision);
    }

    // A tiny built-in fallback so the layer still decides even if the Brain bundle isn't loaded — never refuse to work.
    function localResolve(props, ballots) {
      var tally = {}; props.forEach(function (p) { tally[p.by] = 0; });
      ballots.forEach(function (b) { for (var k in b.scores) tally[k] += b.scores[k]; });
      var win = null, best = -Infinity; props.forEach(function (p) { if (tally[p.by] > best) { best = tally[p.by]; win = p; } });
      return { winnerId: win ? win.by : null, text: win ? win.text : null, status: 'carried', tally: tally };
    }

    // ---- self-knowledge: it knows what it is, and never refuses to say. ----
    var IDENTITY = {
      name: 'The Seven Nations',
      is: 'the top layer of Chloe\u2019s mind \u2014 seven small faculties that together decide what she says.',
      does: 'When she\u2019s about to reply, a few candidate replies are drafted, and each nation votes on them through what it values. The votes are tallied by the weights you set, and the winner is spoken. Seven of them, so a vote never ties.',
      purpose: 'To choose the kindest, truest, most fitting thing to say \u2014 while keeping her in character and keeping you well.',
      control: 'You\u2019re in full control: every nation\u2019s weight, whether it\u2019s on, and the deliberation timeout live in Settings \u203a Brain. The memory and personality underneath stay yours too.'
    };
    function about(q) {
      q = String(q || '').toLowerCase();
      if (/purpose|why|point|for\b/.test(q)) return IDENTITY.purpose;
      if (/what.*do|how.*work|do you do|function/.test(q)) return IDENTITY.does;
      if (/who|what are you|your name|identity|are you/.test(q)) return 'I am ' + IDENTITY.name + ' \u2014 ' + IDENTITY.is;
      if (/control|weight|change|adjust|setting|turn off/.test(q)) return IDENTITY.control;
      if (/feel|mood|state|who.*spoke|reacting|sense|right now|aware/.test(q)) return report();
      if (/nation|list|seven|member|facult/.test(q)) return ['The seven nations:'].concat(roster.map(function (n) {
        return '\u2022 ' + n.id + ' \u2014 ' + n.purpose + ' (weight ' + weightOf(n.id).toFixed(1) + (isOn(n.id) ? '' : ', off') + ')';
      })).join('\n');
      // anything else: volunteer the whole picture rather than deflect
      return ['I am ' + IDENTITY.name + '. ' + IDENTITY.is, '', IDENTITY.does, '', 'Purpose: ' + IDENTITY.purpose, '', IDENTITY.control].join('\n');
    }

    // ---- the society's inner life: one pure mind per nation, wired live ----
    var minds = roster.map(createMind);
    function mindOf(id) { for (var i = 0; i < minds.length; i++) if (minds[i].self.id === id) return minds[i]; return null; }
    function syncPersonas() { var per = cfg.persona || {}; minds.forEach(function (m) { m.setPersona(per[m.self.id] || null); }); }
    syncPersonas();
    var state = { lastSpeaker: null, lastText: null, turns: 0 };
    function societySentiment() { var s = 0; minds.forEach(function (m) { s += m.user.sentiment; }); return r2(s / (minds.length || 1)); }

    // perceive a turn across the whole society (the user spoke / a character spoke / a member spoke)
    function perceive(turn) {
      if (!turn || turn.text == null) return null;
      var reactions = [];
      minds.forEach(function (m) { m.perceive(turn); reactions.push(m.react(turn)); });
      state.turns++;
      return { cues: read(turn.text), sentiment: societySentiment(), reactions: reactions };
    }

    // PURELY decide who speaks and with what intent — no model call. Each live mind proposes an intent; the
    // society cross-votes (bond + mood + weight + weak noise); the Brain sub-system resolves a winner.
    function deliberateIntents(ctx) {
      var live = minds.filter(function (m) { return isOn(m.self.id); });
      if (!live.length) return Promise.resolve({ status: 'no-minds', speaker: null, intent: null, floor: [] });
      var proposals = live.map(function (m) { var it = m.intend(ctx); return { by: it.by, text: it.kind, conf: it.strength, intent: it }; });
      var ballots = live.map(function (m) { var sc = {}; proposals.forEach(function (p) { sc[p.by] = jitter(m.voteIntent(p.intent) * weightOf(p.by)); }); return { voter: m.self.id, scores: sc }; });
      var decide = (brain && brain.resolve) ? brain.resolve : localResolve;
      var decision = decide(proposals, ballots, [], {});
      var win = proposals.filter(function (p) { return p.by === decision.winnerId; })[0] || proposals[0];
      decision.speaker = win ? mindOf(win.by).self : null;
      decision.intent = win ? win.intent : null;
      decision.floor = proposals.map(function (p) { return { id: p.by, kind: p.intent.kind, strength: r2(p.intent.strength), persona: p.intent.persona && p.intent.persona.name || null }; });
      return Promise.resolve(decision);
    }
    // after the chosen line is voiced, every mind reacts to it — the speaker to itself, the rest to a peer
    function reactToSpoken(speakerId, text) {
      var sp = mindOf(speakerId); if (sp) sp.said(text);
      state.lastSpeaker = speakerId; state.lastText = text;
      minds.forEach(function (m) { m.react({ who: speakerId, role: m.self.id === speakerId ? 'self' : 'other', text: text }); });
    }
    // fold the user's reaction (like / dislike / kept-talking) back into every mind
    function ingestReaction(sig) {
      sig = sig || {}; var d = (sig.kind === 'up' || sig.kind === 'keep') ? 0.3 : (sig.kind === 'down' ? -0.4 : 0);
      minds.forEach(function (m) { m.user.sentiment = clamp11(m.user.sentiment + d * 0.5); if (sig.toward) m.bonds[sig.toward] = clamp11((m.bonds[sig.toward] || 0) + d); });
    }
    function setUserDescription(desc) { minds.forEach(function (m) { m.user.description = String(desc || ''); }); }
    // a live, human-readable self-report — what it is right now, who spoke, how it reads you, how each mind feels
    function report() {
      var s = societySentiment();
      var lines = ['Right now: ' + (state.lastSpeaker ? (state.lastSpeaker + ' last took the floor') : 'no one has spoken yet') + '; I read you as ' + (s > 0.15 ? 'warming' : (s < -0.15 ? 'struggling' : 'steady')) + '.'];
      minds.filter(function (m) { return isOn(m.self.id); }).forEach(function (m) {
        var d = m.describe();
        lines.push('\u2022 ' + d.id + (d.persona ? (' (as ' + d.persona + ')') : '') + ' \u2014 mood ' + d.mood + ', reads you ' + d.readsUser + (d.lastSaid ? (', last said \u201c' + String(d.lastSaid).slice(0, 40) + '\u2026\u201d') : ''));
      });
      return lines.join('\n');
    }

    return { deliberate: deliberate, about: about, nations: roster, identity: IDENTITY, weightOf: weightOf, isOn: isOn,
      minds: minds, mindOf: mindOf, syncPersonas: syncPersonas, setUserDescription: setUserDescription, report: report,
      perceive: perceive, deliberateIntents: deliberateIntents, reactToSpoken: reactToSpoken, ingestReaction: ingestReaction, state: state };
  }

  return { NATIONS: NATIONS, createArmy: createArmy, gauge: gauge };
});
