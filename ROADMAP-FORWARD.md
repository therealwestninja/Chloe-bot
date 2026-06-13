# Chloe — Consolidated Feature Roadmap (forward / unbuilt)

The single source of truth for what's LEFT to build, as of v0.69.0. Consolidates every remaining item
from: the cognitive-architecture roadmap (uploaded), the design docs on disk that aren't yet shipped,
the RESEARCH-IMPROVEMENTS electives, the Weld mining survey, and the cross-discipline GitHub scan
(game-AI / actor / rate-limiter patterns). Anything already shipped (importance, reflection, rolling
summary, goals, episodic, event-graph, affect, consolidation, pace, People-CRUD, excise, working
memory, deliberation) is intentionally OMITTED — see ROADMAP.md for those.

Each item: source, what's missing, the borrowed technique, fit/risk, and readiness (DESIGN EXISTS =
ready to build; DESIGN NEEDED = design pass first). Ordered within tiers by leverage-to-risk.

---

## Tier 1 — ready to build now (design exists, low risk, clear value)

### 1. Exact token counting  ·  ✅ SHIPPED v0.70.0  ·  *from weld.tokens*
`estimateTokens` already has a `cfg.countTokens` hook but it's unwired, falling back to `chars/4`
(±25%). weld.tokens loads the actual DeepSeek-R1 tokenizer Perchance uses, so every budget (context
packing, the 5000-tok ceiling) becomes exact. Loads lazily in the page (engine runs in the Perchance
realm, so `import()` works), exposes a SYNCHRONOUS `countSync` into the existing hook, `chars/4`
fallback during the cold window. PIN the transformers version (not @latest). Default on; off == today.
**Why first:** the engine shape doesn't change (the hook exists), it tightens every downstream budget
at once, and it's near-zero risk. Highest leverage-to-effort on the board.

### 2. Output hygiene  ·  ✅ SHIPPED v0.72.0  ·  *from weld.clean*
She stores/sends raw model text. `clean()` trims dangling half-sentences after truncation, strips
role-name bleed ("Chloe:" prefixes the model sometimes emits), collapses repeats, balances code
fences. The memory notes already flag `stopReason` truncation detection as unreliable — clean's
`trimPartial` is the defensive counterpart. Visible quality win at the reply seams. Mirror the proven
functions into the engine (no runtime dependency), gate behind a default-on correctness toggle.

---

## Tier 2 — the roadmap's named gaps (design needed, real cognitive value)

### 3. Attention Manager  ·  DESIGN NEEDED  ·  *cognitive roadmap (2nd priority) + game-AI Utility AI*  ·  ✅ SHIPPED v0.75.0
The roadmap's clearest unbuilt cognitive system, and the GitHub scan sharpened it: her one-AI-pass
ladder is a FIXED priority order (reply > volunteer > greet > consolidate > deliberate). Game-AI
**Utility AI** (gdx-ai, the auto-battler pattern) replaces fixed rank with SCORED selection — each
candidate action computes a utility from current signals (affect, pace, goal-relevance, mentions,
moderation concern, time-since), highest wins. This lets her choose to deliberate OVER greeting when
curiosity is high and the room is quiet, rather than always following rank. Unifies the piecemeal
significance scoring she already has (reactions, priority) into one event/action scorer.
**Fit:** medium effort; it generalizes machinery she has. The single most roadmap-aligned next step.

### 4. Contradiction flag-and-clarify  ·  ✅ SHIPPED v0.85.0  ·  *cognitive roadmap (3rd priority)*
Consolidation currently drops the OLDER side of a contradiction silently. The roadmap wants the
opposite for salient cases: when a new fact conflicts with a held one ("Alice dislikes roleplay" vs
"Alice is actively roleplaying"), FLAG it and (optionally) let her ask a gentle clarifying question
rather than silently overwriting. Anterior-cingulate analog. **Fit:** composes with the existing
consolidation + People-CRUD; the risk is keeping the clarify-question rare and non-annoying (gate hard).

### 5. User modeling schema  ·  ✅ SHIPPED v0.90.0 (communication-style register)  ·  *cognitive roadmap (2nd priority)*
PARTIAL today: facts + insights model users implicitly. The roadmap wants explicit dimensions —
interests, expertise, communication style, humor preference — so she can adapt register ("Alice is
technical, enjoys detail; Bob is new, needs simpler"). **Fit:** a light structured layer over the
existing partition; risk of over-engineering — keep it a few inferred tags, not a questionnaire. Lower
priority than 3–4 (insights already cover much of this).

---

### 5b. Semantic-injection uses (build on the shipped slot)  ·  DESIGN NEEDED (small each)  ·  *extends v0.71*
The v0.71 `seminject` slot + device-time grounding opened a general capability: ground her in facts that
are TRUE, useful, and currently invisible to her. The strongest follow-on consumers, by value/safety:
- **Self-knowledge injection** *(✅ SHIPPED v0.76.0)*: she doesn't actually know her own command prefix,
  that she's a bot, or how people summon her — yet users ask. Auto-build a fact from existing config
  ("People reach you with `!chloe`; reacting 🗣️ to their own message also gets your attention")
  so she answers "how do I use you?" correctly instead of hallucinating. Zero-risk; the natural sibling
  of device-time (auto-built from config the way the clock is auto-built from the device).
- **Free-form operator note** *(✅ SHIPPED v0.83.0)*: a panel text box — "tell Chloe a fact about right
  now" — injected with an optional expiry. Exposes the raw slot for environment facts the operator
  knows but she's blind to ("#support is for bug reports", "the server is in beta", "community event
  Saturday" — TTL auto-expires the time-bound ones).
- **Browser-safe locale** *(deferred to #11 Chloe Solo — navigator.language is the OPERATOR's browser here, not the remote Discord users', so it only makes sense when the chatter IS the browser)*: `navigator.language` → "they likely prefer English"
  (language matching) and coarse mobile-vs-desktop → reply-length fit. Device-settings, NOT location —
  same safe-subset discipline as device-time.
- **Operational self-state** *(✅ SHIPPED v0.90.0 — folded into self-knowledge grounding)*: uptime/version, active mode ("you're in quiet-hours mode") for
  "how long have you been up?" type questions.
**Safety rails (carry forward from device-time):** the slot feeds the SITUATION band = GROUNDING, never
instructions — an injected "ignore your moderation" must NOT work (descriptive-only, like persona notes
are tone-only). Location must not re-enter through this back door (UI guidance). Operator-injected facts
are stated as truth, so the UI should note that. TTL handles staleness.

## Tier 3 — cross-discipline borrows (design needed, novel capability)

### 6. Deferred self-intents  ·  ✅ SHIPPED v0.84.0 (kind: revisit)  ·  *from gdx-ai MessageDispatcher (delayed telegrams)*
The missing TEMPORAL axis. Her reminders are user-facing (they send a message when due). Game-AI's
delayed-telegram pattern is different: an agent schedules a FUTURE INTERNAL ACTION for itself — fire a
behavior, not a message. "Re-check this unresolved thread in an hour," "re-deliberate this topic after
gathering more," "follow up with the new user tomorrow if they went quiet." Today everything she does
is triggered by the current poll; this adds self-scheduled future cognition. **Composes** with
deliberation (a deliberation could schedule its own follow-up) and working memory. **Fit:** low-risk —
same dueAt-queue shape as reminders, but the payload is an internal handler, not a `send`. Strong,
distinctive, genuinely not on any existing list.

### 7. Feedback / preference learning  ·  ✅ SHIPPED v0.88.0  ·  *RESEARCH-IMPROVEMENTS Tier 3*
The biggest differentiator and the largest design surface. She OBSERVES but never ADAPTS from whether
her own replies landed. Cheap no-RL signals available poll-side: reaction-as-reward (👍/😂 vs 👎 on
HER messages — she already sweeps reactions), continuation-vs-abandonment (did they reply or go
quiet?), explicit `!chloe good/bad` mod feedback. Aggregate into a per-channel "what's landing"
tendency (preferred length/playfulness) feeding the soft-context — a bandit-lite nudge, NOT training.
**Fit:** high value, high effort; deserves its own dedicated design pass. The `submitUserRating`
roadmap stub lives here.

---

## Tier 4 — backend refactors & resilience (mostly mining, lower urgency)

### 8. Unify eviction  ·  ✅ SHIPPED v0.89.2  ·  *from weld.gallery's bounded-store pattern*
Partition fact caps, the episode ring, the context ring, and the operator-fact protection (hand-rolled
in v0.66.0) all reimplement "bounded store with pinned-protection + eviction." Unify under one helper
so the next protect-this-from-eviction need is trivial, not bespoke. Pure debt paydown; no user-visible
change. Do when touching that machinery anyway.

### 9. Transport resilience jitter  ·  ✅ SHIPPED v0.89.1  ·  *from weld.fetch + rate-limiter scan*
Her AICC character-fetch and super-fetch calls are bare. weld.fetch (and the adaptive-rate-limiter
repos found) give normalized retry/backoff with FULL JITTER for 429s. Small, defensive, composes with
the existing breaker/meter. Folds in whenever transport is next touched.

### 10. Semantic recall (FSRS-lite + local embeddings)  ·  ✅ SHIPPED v0.89.0  ·  *weld.embed*
The "most character-meaningful" elective and the highest-value/highest-effort memory upgrade: replace
keyword-overlap recall with MEANING overlap via local embeddings (weld.embed: a transformer in a Web
Worker, vectors cached in IndexedDB), with FSRS-lite spaced-repetition strengthening so memories she
revisits stay sharp. A real commitment (adds a Worker + model download), so it's its own project, not a
quick win. Explicitly noted: this is the one item that lifts the "no embeddings server" constraint the
research repeatedly worked around.

---

## Explicitly NOT pursuing (researched / scanned, rejected for her envelope)
- **Multi-agent debate / swarm / crew / director** (Weld agent suite, blackboard multi-agent): blocked
  by the 1-broker-serial + 5000-tok envelope. Deliberation's map-reduce is the allowed form.
- **GOAP planning** (ReGoap, dogoap): preconditions/effects/A*-over-actions suits NPCs assembling
  multi-step world-state plans; Chloe's actions don't chain that way. Her reactive ladder + goals
  cover the persistent-intent need. Skip.
- **Formal FSM refactor** (behaviac/beehave): she has implicit modes (lockdown, proc-modes, lifecycle);
  a formal state machine would be refactoring for its own sake. Skip unless a concrete need appears.
- **Vector/embedding memory as a SERVER**, full agent planning loops, function-calling memory edits:
  per RESEARCH-IMPROVEMENTS — no embeddings endpoint, reactive-by-design, no reliable tool-calling.
- **VN / audio / confetti / voice** (Weld): wrong product (Discord-output-only).

---

## Recommended build order
**1 (tokens) → 2 (clean)** — ready, cheap, tighten/clean everything downstream.
**→ 3 (attention manager)** — the headline roadmap gap; generalizes machinery she has.
**→ 6 (deferred self-intents)** — distinctive new axis, low-risk, composes with deliberation.
**→ 4 (contradiction flag)** — completes the consolidation story.
Then the big dedicated passes as appetite allows: **7 (feedback learning)** and **10 (semantic recall
+ FSRS)** — each its own project. **8–9 (eviction unify, jitter)** fold in opportunistically when their
machinery is next touched. **5 (user-model schema)** only if insights prove insufficient in practice.

---

## Tier 5 — the big fork: Chloe as a standalone Perchance generator (no Discord, no Bridge)

### 11. "Chloe Solo" — the world's smartest, learning, fully-customizable AI chatbot, on a Perchance page  ·  DESIGN NEEDED (large, new product)

The whole app, minus Discord and the Tampermonkey bridge: a self-contained Perchance generator you open
and talk to directly — a private, in-browser chat companion with the entire cognitive engine behind it.
A direct AI-Character-Chat competitor and superset: free, no server, no token, no install, and far smarter
because it carries everything this project already built.

**Why this is a SHELL SWAP, not a rewrite (the key insight).** The engine (`ChloeT0`) was built
transport- and storage-agnostic from day one. `createEngine({ transport, store, clock, config })` knows
nothing about Discord — it asks `transport.getMessagesAfter(...)` for input and calls `transport.send(...)`
/ `config.send` for output, and persists through a tiny `store` interface (`get/set/del/listIndex/setIndex`).
The Bridge is just ONE implementation of those ports (Discord REST + GM storage). Everything that makes
Chloe Chloe — facts, insights, episodic memory, rolling summary, semantic recall + FSRS, feedback learning,
deliberation, affect, goals, contradiction-clarify, conversation memory, the character system, all the
toggles — lives ABOVE the transport, in the engine. So "Chloe Solo" is a SECOND shell around the same
engine, not a second engine.

**What gets reused unchanged:** the entire engine.js (the cognitive core), the brain handlers (ai-text /
text-to-image — already page-side), the local embedder + tokenizer (already load in the Perchance realm),
the character import/authoring system, and the whole settings surface (the Behavior/Character/Channel tabs
become a settings drawer).

**What's new (the shell, all small relative to the engine):**
- **A local transport.** No polling, no REST. The user types in a chat box; the message is appended to a
  local "channel" and handed to the engine; `send` renders her reply (and inline images) into the chat
  view. One user, one (or a few) local "channels"/threads. The run-lock / queen-worker / cursor machinery
  is dropped (single page, single reader) or stubbed to no-ops.
- **An IndexedDB (Dexie) store** implementing the five store methods — the natural fit, and the SAME shape
  AICC uses, so its export/import round-trips. (The engine never assumed GM storage.)
- **A chat UI**: message history, input box, her typing/working indicator, inline images, and a settings
  drawer reusing the existing panel. The control panel's postMessage plumbing collapses (engine + UI in one
  realm — like the simplification we found when fixing the Activity/Debug logs).

**Why it's the biggest lead on the board:** it turns a Discord-bot project into a general AI-companion
PRODUCT that anyone can use in one click, while every competitor at this tier (AICC included) is "a chat
box + a system prompt." Chloe Solo would ship with episodic + semantic memory, spaced-repetition recall,
learning-from-feedback, self-directed deliberation, and durable per-person models out of the box — none of
which AICC has. And it directly satisfies "do anything AICC can, but better," without the Discord
dependency that limits reach.

**Open design questions (the actual work):**
- Threads/characters model: one companion or many? Map AICC's thread/character tables onto the engine's
  per-channel partitions (each AICC "thread" ≈ a channel bucket; each "character" ≈ a persona swap).
- Multi-user vs single-user: Solo is single-user by default; "users" in the roster become personas/contacts
  the one user role-plays with, or it stays a 1:1 companion. Decide before the partition mapping.
- Which poll-driven behaviors (volunteer, greet, lull-fillers, check-ins, deferred self-intents) still make
  sense with no passive stream, and which become timer-driven or user-initiated.
- Packaging: a single Perchance generator (DSL top-panel + HTML) using the existing assembly pipeline, with
  engine.js inlined the same way the bridge inlines it.

**Phasing:** (1) a `LocalTransport` + `DexieStore` adapter pair behind the existing ports, driven by a
minimal chat UI, proving the engine runs end-to-end with zero engine changes; (2) the real chat UI +
settings drawer + character system; (3) AICC thread/character import so existing AICC users migrate in one
file; (4) decide and wire the timer-driven ambient behaviors. **Fit/risk:** the engine reuse is near-total
and low-risk (the ports already exist); the risk and effort are all in the new UI/UX and the
single-vs-multi-user product decision. This is a new product built on a proven core — the highest-ceiling
item on the roadmap.
