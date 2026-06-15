# Chloe Solo — changelog

## The built-in cast goes deeper

Every pre-built character was rewritten to be richer and to fit the project better — and each now ships with **example dialogue**, which the engine folds in as a style anchor so they sound like themselves from the first reply (previously only Chloe had this).

- **More interior life.** Each of the eight personas now carries a core wound, a real contradiction, a sense of what they notice and remember about *you*, and a distinct way of speaking — Chloe's quiet fear of being valued only for what she can do; Yume's watching as a lonely form of love; Kaede's duty as a shield against centuries of outliving people; Mona's bravado as the size of how badly she wants to be kept; Theo giving a whole city his attention and keeping none for himself; Soren's noticing as how he learned to love; Kazushi's autonomy-respecting tenderness built over an old grief; Rowan's stories as a way to stay a half-step ahead of the leaving.
- **Example dialogue for all eight.** Two exchanges each, showing range — a lighter beat and a tender/vulnerable one — and modelling how they treat you with warmth and respect.
- Names, genders, and the 4F/4M tonal pairing are unchanged; provenance/IP notes kept. DSL-safe (no `[[`, no `{import:`, no backticks in content). Validated: scripts compile, ids/CSS clean, 47/47 harnesses green, compiled Brain still equivalent.

## The nations get an inner life — pure cognition, Perchance only voices

Each nation is now a small **mind** in pure local code, so the brain perceives, reacts, and decides who speaks entirely without the model; Perchance is called **once** per turn, only to voice the winner (down from one call per candidate).

- **Per-member minds.** Each has a self-model and mood, working memory of recent turns, a running model of you (sentiment + engagement, read by a tiny pure cue-scanner — no model), and bonds to you and the other members.
- **Perceive → intend → decide, in pure code.** Minds react to each turn through their temperament, propose an intent (comfort / ground / recall / caution / express / protect / play), and the society resolves a (speaker, intent) through the Brain sub-system. On a struggling user it elects conscience → protect — no model call.
- **Perchance = the voice.** A single generation renders the chosen intent in the speaker's voice; then every mind reacts to the spoken line (the speaker to itself, the rest to a peer), and your 👍/👎 folds back into their read of you.
- **Self-aware on demand.** `/nation` ("how do you feel?", "who spoke?") and the Brain tab report live state: who took the floor, how it reads you, and each mind's mood, persona, and last line.
- A persistent army carries the minds' state across turns. `harness-solo-nation` covers perception, the user model, reaction/bonds, pure intent deliberation, self-awareness, and noise:0 determinism. 47/47 green; the compiled Brain stays deterministic and equivalent.

## Nations as characters, global memory, and a little noise

The Seven Nations can now wear faces, and the whole ecosystem breathes a little.

- **Assign a personality to a nation.** Each nation (Settings > Brain) gets a "Speaks as" picker — bind any saved character or built-in preset to it. When set, that nation *proposes in that character's voice*; the nation that wins the vote **speaks as its character** (its name and avatar on the reply), so the personalities interact in the chat. With fewer than two assigned, her own warm/grounded/spark stances round out the ballot. Cost scales with how many you assign (one draft each).
- **Memory, individual and global.** Per-character editing stays in the Character tab (pick whose memory, remove single facts); a new **"Forget everything learned about you"** clears all learned facts and inner state across the board without touching your saved characters or the conversation. The memory *systems* (what kinds of memory run at all) remain global toggles in the Brain tab.
- **User-only control, kept.** Settings and the rolling save/load checkpoint system are driven only from the UI — no nation, character, or noise path can change a setting or trigger a save.
- **A very weak noise.** A new "Spontaneity" control (default 4%) adds a faint, bounded jitter to the nations' votes so she's less static and deterministic. It's injected at the readable layer with a swappable RNG; at 0 the vote is exactly reproducible, and the compiled Brain stays deterministic and testable. `harness-solo-nation` proves the jitter is bounded (never flips a clear winner) and that noise:0 reproduces exactly. 47/47 green.

## Settings, reworked into clean components

The chrome was getting heavy, so it's distilled to four top-level buttons — **Community · Gallery · Settings · Thoughts** — and the two standalone modals are folded into Settings.

- **Top bar:** the separate Characters and Save/Load buttons are gone; both now live inside Settings.
- **New "Character" tab** consolidates the whole character & data layer: the cast, importing/creating characters, the picker, portraits, per-character memory, and save/load/backup/import/export — one place instead of two modals.
- **"Behavior" folded into "Brain."** Personality dials, cognitive toggles, expressions, moderation, and quick actions now sit under the Brain tab with the Seven Nations and the adaptation view — "her mind" in one tab. The Behavior tab is retired.
- **Final tabs:** You · Context · Character · Brain · Appearance · About.
- **About** keeps a plain-language rundown up top, with a **"Show more — how it works, in detail"** expander beneath it covering the four-layer architecture (mouth → Seven Nations → compiled Brain → memory engine), local-only storage, and `/nation`.
- Structural-only move: every id and binding preserved (id/byId audit clean), 47/47 harnesses green. `openCharacters()` / `openSaves()` now open Settings on the Character tab, so existing commands still work.

## The Seven Nations — the readable top brain layer (Settings > Brain)

Above the compiled Brain sits a new, deliberately human-readable layer (`nation.js`): seven faculties — heart,
reason, memory, instinct, voice, conscience, play — each a little society that votes on what she should say.
Votes are tallied by weights you control, through the same Brain sub-system (`ChloeBrain.resolve`); the winner
is spoken. Seven, so a vote never ties.

- **New Settings tab "Brain."** Each nation gets a weight slider and an on/off; plus a deliberation timeout and
  a "let the Seven Nations choose her replies" toggle. The "How I've adapted to you" card moved here (it's the
  brain deciding). Everything persists in `state.nation`, owned by the mouth and read live by the army.
- **It explains itself and never refuses.** `army.about(q)` knows what it is, what it does, and its purpose; for
  any question — even gibberish — it volunteers the full picture. Surfaced in the tab's "Ask it about itself"
  box and via `/nation` (no prompt), `/army`, `/whoami`.
- **It answers for real.** `/nation <prompt>` (or the reply toggle) drafts a few candidates and the nations vote
  purely; she speaks the winner with the per-nation breakdown. ~3 calls.
- **Never refuses to work:** a built-in tally fallback runs if the Brain bundle is absent. `harness-solo-nation`
  covers weighting, enable/disable, the odd roster, the fallback, and the self-knowledge. 47/47 green.

## The Brain, compiled — a lean, mangled, comment-free artifact

The pure reasoning is consolidated into one editable source, `brain.js` (nervous system + Society kernel:
`createNervous, resolve, member, createCouncil, withTimeout`), and compiled to **`brain.min.js`** — the
artifact the app ships — via `build-brain.sh` (terser: compress passes=3 + toplevel mangle + comments dropped,
~44% of source). Only internal names are mangled; the property API the mouth calls is preserved.

- **The split.** Memory (facts, FSRS, episodic graph, embeddings, summary, reflection, consolidation) and
  personality injection stay in the readable `engine.js` under the **mouth's** control; the Brain artifact is
  only the reasoning — deterministic, DOM-free, network-free — so it compiles down hard without touching
  anything the mouth keeps editing.
- **Proven identical.** `harness-solo-council` runs against both `brain.js` and `brain.min.js`
  (`BRAIN=./brain.min.js node harness-solo-council.js`) — same verdicts, same participation, same watchdog
  behaviour. 46/46 green; the app assembles from `brain.min.js`.
- `council.js` is retired into `brain.js`; the `__COUNCIL__` assembly marker now injects the minified Brain.
  (Honest note: minification cuts bytes/parse time, not algorithmic speed — the kernel was already pure and
  fast, and per-turn latency is dominated by the model calls at the mouth.)

## The Society — an odd body of emotion-minds (the council, abstracted up)

The council generalises into a **Society**: an odd roster of member-minds (default nine emotion-stances — joy,
sadness, fear, anger, disgust, anxiety, envy, ennui, embarrassment). The Society is the Brain; **Perchance is the
mouth** that speaks its verdict to the User.

- **Odd by default** so the body never splits evenly — with `resolve()`'s deterministic tie-break still behind
  it, so a deadlock is impossible even on a score tie.
- **Mandatory participation.** Every member registers and *always* votes: a slow / stalled / sleeping member is
  timed out to a default vote, never an abstention. No member can refuse to identify, register, or vote.
- **Watchdog liveness.** A member that times out is put to sleep; the next round's `wakeStalled()` reawakens
  anyone asleep, idle past `idleMs`, or unregistered — re-registering and reactivating it to work again. Timeouts
  use an injected scheduler (`withTimeout`), so the watchdog stays pure-testable.
- **A few propose, the many decide.** `deliberate(ctx, seed)` lets a handful of voices propose candidate replies
  while the whole Society votes/vetoes through its emotional lenses — the faithful emotion-council shape.
- **Live `/society [prompt]`** (alias `/emotions`): three voices (warm/grounded/spark) propose via the model;
  the nine emotions then vote *purely* and may veto; the verdict is spoken. ~3 calls, because the nine votes are
  pure. `harness-solo-council` now also covers timeout-to-default-vote, the asleep→watchdog→wake cycle, seeded
  candidates, and society size. 46/46 green. (Emotion words as labels; original stance logic — no film characters
  reproduced.) Design: DESIGN-council.md.

## The Council — a Brain made of three Brains (pure deliberation)

The architecture steps up a level: the whole engine-Brain becomes a single neuron, and three of them form a
**council** that nominates, cross-votes, and can veto, then resolves a verdict — agreeing, carrying a majority,
or flagging a contested round.

- **`council.js` — a pure kernel.** `resolve(proposals, ballots, vetoes)` is 100% deterministic (no DOM, no
  network, no model). The only effects — a member's propose / vote / veto — are *injected* at the member
  boundary, so Perchance/AI sits only at the very edge and the deliberation itself is pure code. (Per the
  "keep the Brain pure" direction.)
- **The same protocol, one level up.** `nervous` was lifted out of the engine into a shared factory
  `ChloeT0.createNervous(log)`; the council registers each member-Brain as a neuron of `kind:'brain'` and talks
  to them over the bus (`ask('warm',{type:'propose',ctx})`). Recursion, not analogy.
- **Live `/council [prompt]`.** Three stances (warm / grounded / spark) propose via the model (3 calls), then
  vote and veto *purely*; the council prints the deliberation (proposals, tallies, vetoes, dissent) and she
  speaks the winner. Opt-in, because three minds cost ~3× per turn.
- **`harness-solo-council`** covers the pure kernel (majority, veto, all-vetoed, tie-break, consensus, dissent,
  no self-voting) and a live round both directly and over the real nervous bus. 46/46 green; the nervous
  refactor keeps `harness-solo-nervous` green too. Design: DESIGN-council.md.

## The Brain's nervous system — neurons that know themselves and talk

The engine's internal subsystems ("neurons") were closure functions that called each other directly and had no
way to be discovered or addressed. They now register into a per-Brain **nervous system** (`engine.nervous`):

- **Registry + directory** — `register / list / describe / find`. The ~20 context providers auto-file manifests
  through `registerProvider`; the command table, the closure neurons (memory, summarizer, embeddings,
  reflection, deliberation, bandit, affect, consolidation, lorebook, poll) and the async organs (store,
  transport, voice) are hand-registered. Each manifest is `{id, kind, role, does[], state}`.
- **Synapse bus** — `send` (addressed), `ask` (request/reply), `publish`/`subscribe` (broadcast). The **memory**
  neuron is the live seam: `ask('memory',{type:'recall',id})` / `send('memory',{type:'remember',…})` hit the
  real fact store.
- **Lifecycle** — `wake / sleep / standby`; the idle consolidation pass flips its neuron active↔asleep.
- **Readiness, not keepalive** — organs carry a `ready` promise; `health()` is ready / pending / degraded. The
  networking metaphor was kept only where it maps to one thread (readiness for async organs); the keepalive
  heartbeat was dropped as ceremony.
- **Surfaced** — `/neurons` lists the directory live, `/neurons <id>` inspects one. New `harness-solo-nervous`
  covers registry, bus, lifecycle, and organ readiness. Design + plan: DESIGN-nervous-system.md. 45/45 green.

## Example dialogue — anchor a character's voice (mined from the canonical AICC)

Characters can now carry an **Example dialogue**: a short exchange that shows how they speak. The character
editor has a field for it, and it rides along in context each turn as a style reference ("match this voice and
rhythm; never quote it verbatim") via a new engine `examples` provider at the PERSON band — so replies stay in
character without it crowding out identity or directives. The built-in Chloe ships with a sample so the feature
is visible immediately.

- Carried through the whole pipeline: editor → `useCharacter` → `config.setCharacter` → `state.character` →
  `buildConfig`, and onto extra cast members via `addToScene`. Kept as a **separate field** from the persona so
  it never leaks into portrait prompts.
- `CharKit.normalizeCharacter` reads examples from our own field, SillyTavern's `mes_example`, or an AICC system
  example block; `characterToAICC` re-emits both a compatible `---start example---` system block and a plain
  field, so it round-trips and interoperates with other card apps.
- `harness-solo-examples` covers extraction from every source shape, the export→import round-trip, and the
  provider wiring. 44/44 suite green, ids clean, CSS balanced. (Mining notes: MINING-DESKTOP-2.md.)

## Pin to memory — a legible list of what she's keeping in mind

The ★ on a reply already saved it to the engine's highlights, and the most recent few ride along in her
context — but there was no way to *see* or *manage* them. Settings now has a **Pinned to memory** card: every
saved line, newest first, with the ones currently in her context flagged ("in her context now"), a per-item
**unpin** (✕), and a two-tap **Clear all**.

- New surgical engine method `removeHighlight(id)` (filters the stored list by id, persists, reports whether it
  removed anything) alongside the existing `addHighlight`/`listHighlights`/`clearHighlights`; exported and
  covered by `harness-solo-pin`.
- The card reuses the existing highlights backend end-to-end — saving (★ / `/highlight`), context injection
  (the newest `highlightContextCount`), and clear — so this is purely the missing *surface*, no new storage.
- 43/43 suite green, ids clean, CSS balanced.

## Per-message buttons — one inline row

The new 🔄 regenerate control and the ‹ n/m › variant nav now sit **inline with 👍 👎 ★**, and the **✕ delete**
moved out of the floating corner into that same row (pushed to the right). One `.acts` row per reply replaces
the old separate `.fb` / `.rgx` rows and the absolute `.msg-del`; the feedback reset was scoped to just the
👍/👎 pair so it no longer clears the star. User/system messages (which have no other buttons) keep their tight
corner ✕. Streamed replies get the ✕ at finalize so it lands in the row rather than the corner.

## Regenerate + swipe variants — every reply keeps a history (AICC-style)

Each of the character's replies now carries a **🔄 Regenerate** control and, once there's more than one take,
a **‹ n/m ›** navigator you can **swipe** between — text *or* image. Regenerate adds a fresh take as a new
variant (it never clobbers the old one); swiping left/right (or the arrows) moves through the history, and the
active variant becomes the message — so it persists with the transcript and rides into future context. Mirrors
the AICC `variants` model confirmed while mining the Weld/platform docs (a message carries `variants`, the
current one plus its alternates).

- **Text** regenerates from the recent transcript + the character's persona (a genuinely fresh wording of the
  same moment); **image** redraws from the prompt recovered out of its caption via the existing painter.
- Variants live on the message object, so the **history survives reload** (text) through the normal transcript
  persistence; the controls re-appear with the right count on load.
- Attached to streamed replies, non-streamed replies, and image replies alike; kept reachable on mobile (the
  hover-only affordance is forced visible on touch, per the 🔄-on-mobile ask).

New `harness-solo-regen` covers the variant-index clamping (no wrap at either end) that swipe + arrows rely on.
42/42 suite green, ids clean, CSS balanced.

## Quick actions — one-tap shortcut buttons (mined from ai-rpg-custom)

A small CRUD list in Settings → Behavior that renders one-tap buttons above the message box. Each either
**sends** a bit of text immediately or **pre-fills** the composer to edit first — a comfort line, a roleplay
action, a question you ask a lot — and `{1-20}` (any `{a-b}`) anywhere expands to a random number. The whole
feature rides on `CharKit.makeLibrary` unchanged (a shortcut is just another stored record), which is the
typed-library generalization doing exactly what it was built for. New `harness-solo-shortcuts` covers the dice
substitution (range, lossless passthrough, reversed range, null-safe). 41/41 suite green, ids clean, CSS
balanced. See MINING-DESKTOP.md for the full mine and what's ranked next (swipe variations, continue-reply).

## Character packs — the whole library in and out as one file

"Meet someone" gained **Import pack** and **Export all**: export every saved character as one
`chloe-solo-characters.json` (a small versioned envelope of AICC characters, + clipboard), and import a pack,
a bare array, or a single character file straight into the library. Two pure helpers on `CharKit`
(`exportLibrary` → versioned pack, `parsePack` → records from a pack/array/single, junk-safe) plus the glue
wrappers; `exportCharacter` and the pack exporter now share one `downloadJSON` helper. The fur-ai "expansion
pack" pattern, near-free on top of `makeLibrary`. Pack round-trip + lenient-parse cases added to
`harness-solo-charlib`; 40/40 green, ids clean.

## A character library — one CRUD pipeline for import, edit, and export

"Meet someone" is now a real library, not a static cast. Characters you import (link / file / paste) or create
land at the **top** of the picker under "Your characters," each with full CRUD — **Chat**, **+ scene**,
**Edit**, **Export**, **Delete** — above the built-in cast (which each gain **Save a copy** to fork an
editable version). A **+ New character** button opens an inline editor (name, tagline, pronoun, opening,
persona) for create and edit alike.

Under it, one pipeline replaces three near-duplicate paths. New `charlib.js` exposes `CharKit`:
- `makeLibrary(read, write)` — a generic CRUD store (list newest-first, get, add, update, remove, duplicate,
  clear) over an injected storage pair, so future preset types (lorebooks, style presets) reuse it unchanged —
  the fur-ai "typed-asset library" lesson, kept minimal. Solo instantiates it on `localStorage` (`chloeSolo:`,
  so it rides along in saves).
- `normalizeCharacter(src, source)` — any shape (editor fields, AICC `roleInstruction`/`initialMessages`, a
  prior record) → one canonical record; pulls the opening from the first AI message, flattens `avatar.url`.
- `characterToAICC(rec)` — serializes back to an AICC-shaped object, so **Export** produces a `.json`
  (download + clipboard) that re-imports here and in other AICC apps.

The glue adds the shared surface every tile and import path now routes through: `useCharacter(rec, mode)`
(chat vs. scene), `importCharacter(src, source)` (normalize → save → re-render, exposed on the bridge), and
`exportCharacter(rec)`. The AICC importer saves each picked character into the library on apply (de-duped per
pick), and the old separate "write your own" editor was removed — the inline editor supersedes it, which is
the de-duplication the pipeline was for. New `harness-solo-charlib` (CRUD, newest-first, normalize from both
shapes, AICC round-trip, corrupt-store-degrades-safely). 40/40 suite green, ids clean, CSS balanced.

See MINING-FUR-AI.md for the import/export surface this drew from (typed-asset registry, scoped share-link
export with a disclosure gate, character packs) and what's deferred.

## Smart-cropped cutouts — every reaction framed identically

The reaction portraits were painted at a fixed 512×768 but the subject sat wherever the model put her, so the
ten cutouts didn't line up when swapped by mood. After `removeBackground`, the painter now finds the cutout's
alpha bounding box, pads it ~6%, and widens it to a fixed 3:4 frame, then regenerates the dataUrl/blob from the
cropped pixels — so every emotion is framed the same way despite the backend ignoring seeds. `alphaCropRect`
is pure geometry (bounding box + pad + aspect); `cropCanvasToAlpha` reads the pixels and draws the crop, and
bails cleanly on a tainted canvas, a fully transparent result, or an already-tight frame (no-op). New
`harness-solo-smartcrop` covers containment, the aspect lock, transparency, threshold, and the no-aspect path.
39/39 suite green, scripts compile, ids clean.

## Mobile layout — top bar, headers, and menus made phone-safe

The app had essentially no phone CSS (one `@media` for the mind panel, one for dark mode), so on small
screens the six text-labelled top buttons overflowed and got clipped, the header name + subtitle got covered,
and modal content ran past the edges. Memory-Hero's lesson — keep everything trimmed-down — applied here:

- **Top buttons stay reachable.** The six were grouped and, under 640px, go **icon-only** (labels drop, all
  fit on a phone) with a horizontal-scroll fallback, each keeping a `title` for its name. The cryptic glyphs
  (◫ ⟲ ◧) became recognizable ones (🎭 Characters, 💾 Save/Load, 🧠 Thoughts) so icon-only reads clearly.
- **The cause of "running off the top."** `.app` was `height:100vh`; on mobile that extends under the browser
  chrome, hiding the top bar. Switched the app, modals, and lightbox to **`dvh`** so they fit the *visible*
  viewport.
- **Header never covered.** The name and subtitle now stack (name over "a companion who remembers") on phones,
  with the header given layout priority over the button cluster — both stay visible, neither is hidden.
- **Menus fit.** Modals go full-screen on mobile (`100dvh`, no radius, no backdrop padding) with trimmed
  head/panel/card padding and scrollable tab bars, so no menu or its content runs off-screen.
- **Less padding generally.** Trimmed `.btn` (8/14 → 7/12) and `.iconbtn` (7/12 → 6/11) everywhere, tighter
  again on mobile — the buttons read less bulky on every screen.

No JS touched; all top-button ids intact, ids clean, CSS balanced, scripts compile, 38/38 suite green.

## A built-in cast — eight companions from the AICC roster, healed and ported

Added a "Meet someone" picker to the Characters popup: a built-in roster of eight companions (`presets.js`,
injected via a new `/*__PRESETS__*/` marker). Tap **Chat** and she re-themes the bot and greets you in
character through the same `config.setCharacter` path the AICC importer uses — so the learning engine starts
adapting to her from the first message — or **Add to scene** to bring her in alongside whoever's already
there. No external avatar URLs: each is painted from her own description by the portrait pipeline.

Four women, four men, paired by tone:
- **Chloe (Original)** ↔ **Theo** — warm, brilliant, easy to be around.
- **Yume** ↔ **Soren** — uncanny, intensely perceptive, quietly devoted.
- **Kaede** ↔ **Kazushi** — a lonely guardian with a gentle streak under the duty/gruffness.
- **Mona** ↔ **Rowan** — a stray and a drifter, both quietly looking for somewhere to belong.

Adapted from the original Memory-Hero AICC cards, with two deliberate changes. **Provenance:** the old "Ganyu"
card was explicitly Genshin Impact IP (Vision/Cryo/Liyue/Rex Lapis), so she's rebuilt as an original
character — **Kaede**, same gentle-dutiful-guardian spirit — to keep the app shippable and IP-clean; the old
"Mona" was already an unrelated original (a stray catfolk), so she's kept, with one borrowed place-name
swapped out. **Wellbeing:** several source cards modelled controlling/possessive or deliberately-unsettling
dynamics; since the app exists to keep lonely people company, those are healed into warm, respectful,
three-dimensional companions — the version that actually helps, and the version that pairs best with the
learning engine. All are adults.

New `harness-solo-presets` (balance, clean personas, no placeholders, no external URLs, requested cast
present); 38/38 suite green, scripts compile, ids clean.

## The trainer, upgraded — exploration, an anti-bait guard, and a legible/correctable style surface

Solo's reply-style learner is a per-channel contextual bandit (EWMA arms over length {short,med,long} and tone
{playful,measured}, rewarded by continuation +0.3 and emoji / `good`|`bad` ±1). Three changes, planned and
designed in `PLAN-trainer-upgrade.md`, turn it from "logs a preference" into something that actually optimizes
— safely and in the open:

**Exploration (UCB).** Arm selection was pure argmax-with-margin, so an early leader locked in and
alternatives never got the data to prove themselves. Replaced with UCB (`fbPick`): an under-sampled arm gets a
`sqrt(ln N / n)` bonus, so the learner *probes* it (surfaced as "worth trying a longer reply occasionally")
instead of freezing. A clear, well-sampled winner is still exploited. Deterministic, so it's testable.

**Anti-engagement-bait guard.** Continuation is an engagement signal, and optimizing it naively teaches
question-baiting. Now a reply that ends on a question earns no continuation reward (`feedbackBaitDamping`,
default 0) — the question, not the style, is what kept them talking. Explicit emoji/`good`|`bad` are
unaffected. Paired with the fact that explicit ±1 already outweighs implicit +0.3, the trainer can't drift
toward manipulation.

**"How I've adapted to you" surface.** The bandit was invisible and uncorrectable. New `feedbackSnapshot()` /
`resetFeedback()` back a Settings card showing each arm's reward bar + sample count and the current lean
("leaning shorter" / "trying longer to learn"), with per-dimension and full reset — and a reset is the
cleanest correction signal a person can give the reward model.

Three new harnesses (`explore`, `bait`, `adapt`); 37/37 suite green, scripts compile, ids clean. Deferred to
future passes (in ROADMAP): consolidation→trait generalization, and fact confidence + active-learning
gap-filling.

## Episode-topic backfill — a curated handle when the model gives none

`processEpisodes` stored whatever `topics` the episode extractor proposed, and `[]` when it proposed none —
leaving keyword recall to match those episodes on their raw 120-char text alone. Now, when an episode comes
back with no topics, it gets 1-2 anchors derived from its own text via the labeler (`bestLabelCandidates`):
the proper-noun subject first ("kyoto"), then a salient word ("explored"). LLM-provided topics are never
touched. Small reuse of the labeler imported last change; it sharpens the same keyword-overlap path the
stopword and labeler work already improved. New `harness-solo-episode-topics` (backfill-when-empty,
proper-noun-first, provided-topics-preserved). 34/34 suite green, scripts compile, ids clean.

## Best of all worlds — two more Memory-Hero memory ports (topic labeler + summary loop guard)

Folded in the two remaining surgical wins from the Memory-Hero mine:

**Topic labeler.** The working-memory "current topic" was the rolling summary's opening clause, clipped to 60
chars — so it could read as "We reached Kyoto and explored the t". Imported Memory-Hero's proper-noun /
salient-word labeler (`bestLabel`): it prefers the actual subject — a name or place ("Kyoto", "Captain Vex")
— and falls back to the dominant content word, with the old clause kept as a final fallback when there's no
content to name. Sentence-initial capitals are skipped (ambiguous), and `extractSalientWords` reuses the
`STOPWORDS` set from the last change, so filler never wins. New `harness-solo-labeler` (6 checks).

**Summary loop guard.** `processChannelSummary` re-summarizes recursively, feeding each pass's output back in
— the classic setup for a summary that loops on one sentence, compounding every pass. Added
`collapseSummaryLoops` (§8.8, self-contained — no extra model call): it drops exact sentence-level repeats
within a sliding window before the summary is stored, so a loop can't reach storage to feed the next pass.
New `harness-solo-summary` (4 unit + 2 integration: a 4× looped sentence is stored once).

Both helpers are exported for the harnesses, matching the existing `processChannelSummary`/`recentTranscript`
convention. 33/33 suite green, scripts compile, ids clean.

## Sharper recall — stopwords out of the keyword-overlap path (ported from Memory-Hero)

When no text embedder loads (the common case for a self-contained build), episode recall scores memories by
shared-token overlap between the query and each episode. The tokenizer kept every word >=3 chars, so filler —
"that", "the", "with", "have", and roleplay staples like "looked"/"felt"/"thought" — counted as matches and
let an episode surface on shared *grammar* rather than shared *content*. Imported Memory-Hero's `STOPWORDS`
set (a ~120-word general list plus narrative-noise words, well-suited to RP transcripts) and folded it into the
recall tokenizer, so overlap now reflects what was actually said. Kept it separate from the existing
`CONTRA_STOP` set on purpose: the contradiction parser must preserve negation words (not/no/never), which
recall is free to drop. New `harness-solo-recall` proves a content-word match still surfaces while an episode
sharing only "that" no longer does (it would have, before); 31/31 suite green, ids clean.

(Embedder-agnostic, so it sharpens the path Solo actually runs on. Same set trivially applies to the topic
labeler's `toks` (length>=4, also unfiltered) — a clean follow-up. Next memory-mining targets: Memory-Hero's
salient-word/proper-noun labeler for better episode topics, and hierarchical summarization — though that one's
pinned to MH's per-message schema and isn't a surgical port.)

## Same path, next system — her self-note made legible

Extended the learn -> see -> correct treatment to her **persona / self-note**, which until now was only
reachable via the `/persona` command and invisible in the UI. Settings -> **How she sees herself** shows the
current note in an editable field; Save writes the exact record `/persona` and `assembleContext` use (via a
shared `personaNoteRecord`), and saving it empty clears it. So her self-description is now viewable, editable,
and clearable like the learned looks and the facts about you. New `harness-solo-persona` (6 checks: trimming,
attribution, the canonical record shape); 30/30 suite green, ids clean.

(Facts about you already had list + forget + teach; looks got it last change; this fills the remaining
command-only gap. Next candidates on the same path: the reply-style feedback signal — the one auto-learning
system still with no surface — and idle self-consolidation that folds durable learnings into this note.)

## Learning, made legible — the "looks she's learned" surface

The feedback loop learned image-style notes but kept them invisible and uncorrectable. Settings -> Images now
shows them: each learned look is a chip you can **forget** (x), and a **Teach** field lets you add one
directly (deduped case-insensitively, capped at 8) without going through a reaction edit. Notes fold into
every future portrait as before, so removing a wrong lesson or teaching a right one takes effect immediately.
`learnFromEdit` was refactored onto a shared `addStyleNote`/`removeStyleNote` core. `harness-solo-reactions`
+5 checks (add/dedup/cap/remove); 29/29 suite green, ids clean.

## "Erase everything" — corrected scope (keeps Gallery + checkpoints, resets VN history + avatar)

The wipe only cleared `chloeSolo:` localStorage, so all three IndexedDB stores survived a "full reset". Now it
matches intent:

- **Reset:** the conversation and everything learned (localStorage, including the learned image-style notes),
  the **VN reaction history** (`ReactionStore.clear()`), and the **profile avatar + character** back to
  default Chloe (via the state reset + `updateCharLabel`, which also drops the in-header reaction swap).
- **Kept (deliberately):** the **Gallery** of saved images (`chloe-solo-gallery`) and the **save/checkpoints**
  (`chloe-solo-saves`). Neither is touched by the wipe.

The confirm + the data-management note now say so. `harness-solo-reactions` gains a `clear()` check; 29/29 green.

## Blob-direct image storage

The painter now takes the Blob straight from the plugin's result canvas (`canvas.toBlob`) instead of decoding
the data URL when storing — PNG to preserve a cutout's alpha, JPEG (smaller) for opaque images. The data URL
is still carried alongside for display and avatar persistence; the Blob is what IndexedDB stores. Storage
consumers prefer it and fall back to decoding only when the plugin gives no canvas (older builds):
`renderReaction` -> the reaction store, and `persistImage` (via `soloSendImage` <- `doImage`) -> the gallery.
This trims the base64 round-trip on the batch-heavy reaction path and shrinks the JPEG gallery footprint.
Mined from ai-slideshow (#7). `harness-solo-imagequeue` extended (canvas-direct PNG/JPEG + data-URL fallback);
29/29 suite green.

## Image pipeline queue + hardening, and a background-generation toggle

The painter is now a queued, hardened pipeline (patterns mined from AI-Slideshow — see MINING-AI-SLIDESHOW.md):

- **Request queue.** Every paint request enqueues and drains through a concurrency gate (serial by default).
  A burst — many `/img` in a row, or the reaction worker overlapping a user request — lines up instead of
  contending for Perchance's single broker. The gate generalises to N (AI-Slideshow runs 1-4).
- **Empty / inline-only prompt guard.** Such a prompt passes client validation but hangs the backend forever;
  the painter now strips inline params and rejects an empty result before calling the plugin.
- **Per-generation timeout (90s)** so a hung gen frees its slot instead of blocking the queue.
- **Resolution clamp** to the four honored strings; junk values no longer pass through.
- **Auto-resolution** when the caller omits one: a portrait/selfie prompt frames tall (512x768), a
  landscape/wide prompt frames wide (768x512), otherwise the HD square. Explicit resolutions still win, so
  reactions (512x768) and portraits (512x512) are untouched; this mainly helps `/img`.

**Settings → Images** gains a "Generate reaction portraits in the background" toggle (state
`reactionPortraits`), synced with the same toggle in the Characters popup — one switch to stop all background
image generation.

`harness-solo-imagequeue` (9 checks: serialization, burst resolution, the empty-prompt rejection, resolution
clamp) added; full suite 29/29 green, no duplicate ids, all `byId` targets present.

## Reactive character portraits — phase 4 (the gallery + the feedback switch)

The set is now visible and editable, completing the feature. In the Characters popup, under Portrait, a
**Reaction portraits** card shows the 10 core (plus any in-season) cutouts as a grid. Each tile has the cutout
(or a "painting when idle…" placeholder), the emotion label, an editable appearance description, and a
**Regenerate** button. The emotion's expression is always added by the factory, so the edit field is
appearance only.

- **Per-emotion override (default).** Editing a tile's description and regenerating re-paints just that tile
  from the edit; the description is stored on the record so it survives.
- **Provide feedback (switch, default off).** When on, an edit *also* teaches her: the look is added to a
  deduped, capped `imageStyleNotes` list that the prompt factory folds into **every** future generation
  (reactions and the idle worker alike), and it's mirrored to the engine as a fact via `addFacts` so it
  surfaces in context too. A `[chloe.learn]` line narrates it. This is how she learns image preferences,
  facts about herself, and other data points from your edits.
- A second toggle controls idle generation (`reactionPortraits`). The grid refreshes live as the worker fills
  it, and opens with the Characters popup.

`harness-solo-reactions` now 29 checks (adds the desc-override storage and the learned-notes folding); full
28/28 suite green, no duplicate ids, all `byId` targets present. Reaction portraits phases 1-4 complete.

## Reactive character portraits — phase 3 (mood-driven avatar swap)

The reactions now show. `detectEmotion`'s taxonomy was realigned to the reaction set so a read mood maps
straight to a cutout: the keys are now normal (implicit), happy, excited, celebrate, shy, bored, worried,
lonely, sad, crying — replacing the old happy/sad/mischief/surprise/embarrassed/angry. The emotion-cue glyphs
were re-mapped to match, and the `?!`/`!?` tell now reads as excited.

- On each finalized reply, `showReaction(detectEmotion(text) || 'normal')` swaps the **header avatar** to the
  matching cutout (decision: reuse the header avatar). The base portrait (`state.herAvatar`) is untouched —
  only the displayed `<img>` changes — and object URLs are revoked as they rotate.
- Graceful fallbacks: a mood with no cutout yet falls back to the **normal** cutout, then to the **base
  portrait**, so it degrades cleanly while the idle worker is still filling the set.
- A character/name/avatar change clears the stale reaction so the next reply re-applies against the new one.

`harness-solo-emotion` rewritten for the realigned taxonomy + an alignment check (every detectable mood maps
to a real reaction); 28/28 suite green. Remaining: phase 4 — the reaction gallery UI (view / edit-description
/ regenerate) in the Characters area.

## Reactive character portraits — phase 2 (the 10+seasonal set + idle worker)

Decisions locked in: reactions are managed in the Characters area (phase 4), generation is idle-driven, the
core set is 10, and there's a seasonal day-of set; backgrounds are removed.

- **Factory expanded to 10 core emotions** — normal, happy, bored, worried, lonely, sad, crying, shy,
  excited, celebrate — each with its own VN expression phrase.
- **Seasonal set** — Easter, Halloween, Thanksgiving, Christmas, New Year's — themed variants with
  approximate date windows (`activeSeasonal(date)`, with New Year's wrapping the year end). Topped up only
  while in season.
- **Idle worker** — a 12s tick that, once the chat has been quiet for ~25s (and not in demo mode, not
  mid-reply), paints the next *missing* reaction one at a time (serial — the broker does one image at a time)
  and stores it. The store is the progress, so a refresh resumes; `nextReactionJob` picks the next gap. A
  `[chloe.react]` line narrates it in the mind drawer. Gated by a new `reactionPortraits` toggle (default on).

`harness-solo-reactions` now 25 checks (10-emotion set, seasonal date windows incl. wrap, selection, keyed
store); 28/28 suite green. Next: phase 3 (mood-driven avatar swap) and phase 4 (the reaction gallery UI in
the Characters area).

## Reactive character portraits — phase 1 (factory + store + pipeline)

Foundation for VN-style emotion cutouts that react to the chat. Built entirely on existing machinery:
`detectEmotion` (already maps each reply to an emotion), `paint({removeBackground:true})` (the painter already
cuts out backgrounds), `scrubImagePrompt`, `dataUrlToBlob`, and `Gallery`'s IndexedDB pattern. This phase adds
the reusable pieces with no behaviour change:

- `makeKvBlobStore` — a reusable keyed blob+meta IndexedDB primitive (the factory for keyed stores).
- `ReactionStore` — one cutout per (character, emotion), with the editable prompt kept for regeneration.
- The reaction factory — `REACTION_EXPRESSION` (7 emotions: neutral + the detectEmotion taxonomy),
  `reactionPrompt(desc, emotion)` (VN sprite prompt from the description), and `reactionJobs(character)`.
- `renderReaction(charId, job)` — the single-job pipeline: scrub → paint (cutout) → store.

`harness-solo-reactions` (12 checks); 28/28 harnesses green. Worker, mood-driven display, and the gallery UI
are phases 2–4 — see `REACTION-PORTRAITS.md` for the architecture and the open design decisions.

## Unified title + auto-matched reply language

**Title surfaces unified.** The about-panel title, the browser tab, and the DSL `$meta` now all read
"My Girl - `<name>`" (the per-character name flows in; for the default it's "My Girl - Chloe", matching the
generator title). Previously `updateCharLabel` overwrote the tab + about title with "`<name>` Solo", out of
step with the new branding. Also fixed three typos in the about-text ("craft an entire", "Each character will
learn", "separate").

**Auto-match reply language (Chloe-bot mining #1 — the locale the roadmap deferred to Solo).** Because Solo
*is* the browser, `navigator.language` is the actual chatter's language. On first run she now matches her
reply language to it: `autoMatchLang` fires once after the engine is ready, and — if the new "Match my device
language" toggle is on (default), the user hasn't already chosen a language, the locale isn't English, and the
code is one the engine can name — it calls the existing `setLang`. So a French user is answered in French
without typing `/lang fr`, while `/lang` and the toggle override it. The toggle lives in the "Live context
from your device" card (kept as a true app setting, not an engine-config key, so it doesn't reintroduce a
dead config). New `harness-solo-autolang` (9 checks); 27/27 harnesses green.

## Baseline merge ("My Girl - Chloe" branding) + plain-language mind drawer

**Adopted the new baseline.** Folded in the cosmetic pass — the "My Girl - Chloe" title, the rewritten
about-text, "Have fun!", and the renamed labels/DSL `$meta` — into the source pipeline. The uploaded baseline
had been taken just *before* the legacy-bug patch, so it reinstated the duplicate keys, dead-stores, and dead
`deviceTime`; rather than revert that work, the cosmetic changes were merged on top of the fixed source. The
reconciled build now equals the uploaded baseline minus exactly those (intended) fixes.

**Plain-language mind drawer (mining idea #1).** The drawer already tagged and categorized the engine's log
lines; what it showed was developer shorthand ("packed 12 lines (~340 tok)"). A new `prettifyThought` layer
translates the meaningful cognitive operations into plain language — "weighing 12 things from our talk",
"thinking it over", "drawing something", "reflecting on what I've learned", "learning from how that landed" —
so the stream reads like a mind at work rather than a log. Pure rendering transform: anything unmapped keeps
the engine's own words, and the raw developer line stays on hover (title). New `harness-solo-thoughts`
(13 checks); 25/25 existing harnesses green.

## Legacy-bug audit (ESLint + hand-verification)

Ran the same linter Perchance's editor uses across the glue, engine, and brain, then verified every hit
against the cross-block wiring and the harnesses. Full write-up in `LEGACY-BUGS.md`. Fixed five real items,
all proven no-ops or pure wins, 25/25 harnesses green:

- **`pageMaxContextTokens` dead store** (fixed in the prior pass) — the example that prompted the audit.
- **`deviceTime`** — config key passed to the engine and read nowhere; removed.
- **Duplicate `timeAware` key** in the engine config object — identical values, latent footgun; de-duped.
- **Duplicate `quietSweep` and `computeNextDelay` keys** in the engine's export object — merge cruft from
  later-appended exports; de-duped.

Left alone, with rationale in the report: six harmless engine dead-stores (cosmetic; the engine is
test-covered), one shared-brain function unused only in solo, and `renderFromStatus` (an intentional stub).
`viewName` *looked* dead but the director harness proved it's test-covered — restored. None of the findings
were Perchance bugs; all were residue from porting across surfaces.

**Follow-up:** cleared the six engine dead-stores too (`INDEX_KEY`, `lastSawHumanAt`, `bestIdx`, `caps`,
`qs`, and an unused error-`code` extraction — including their stray writes and one orphaned `words` local).
The engine now lints clean of unused-vars and duplicate keys; 25/25 harnesses green.

## Mined from the Perchance runtime: avatar favicon + a real token budget

Two improvements drawn from the editor-bundle dump's view of how the output page actually behaves.

**The browser tab now wears the character's face.** The output page watches `link[rel="icon"]` and relays
its href to the parent tab via a `changeFavicon` postMessage (alongside the `changePageTitle` it already
relays, which is why the title was working). The app set the title but never the favicon, even though it
had the avatar. `updateCharLabel` now pushes the avatar to a `<link rel="icon">` — center-cropped to 32px
on a canvas and cached, so a full portrait data-URL isn't shipped as the icon and repeat calls don't
re-render. Cross-origin avatars that taint the canvas fall back to the source href.

**The context budget is now the model's real one, not a guess.** `wireTokenizer` already pulled
`idealMaxContextTokens` from ai-text's `getMetaObject`, but the value was dead — the engine ran on a
hardcoded `requestTokenBudget: 5000`. It now budgets at `idealMaxContextTokens − 800`, the buffer the
plugin docs call out to keep a summary or memory write from busting DeepSeek's prefix cache on every send.
Off-Perchance (no plugin) it stays undefined and the engine keeps its safe default.

**Also surfaced, for context (not changed):**
- *No output iframe.* Confirmed again here — the generator is injected into `#output-container` via
  `innerHTML` in the main page DOM, so the app shares Perchance's cascade (this is why the Thoughts drawer
  hardening was needed). A corollary worth tracking: the app's global rules (`body{…}`, `*{box-sizing}`)
  apply to the host page. In production that page *is* the generator so it's benign, but it's the reason a
  future scoping pass might be worth it if anything ever bleeds.
- *The output observer is benign for us.* Perchance's MutationObserver on `#output-container` deliberately
  does **not** re-evaluate `{…}`/`[…]` template syntax in nodes we add at runtime (the author called that
  idea "very silly" and disabled it) — it only re-binds inline `on*` handlers. The app uses
  `addEventListener`, so it's entirely unaffected; this also confirms the brace errors never came from the
  DOM.
- *Parent-relay hooks available:* `changeFavicon`, `changePageTitle`, `changeHash`, `changeUrl` — the last
  two could back a future share/deep-link feature.

## Removable system/narration lines, auto-clearing draw status, and a hardened Thoughts drawer

Two fixes prompted by testing on Perchance, plus what the editor-bundle zip revealed about the runtime.

**Stuck lines are now removable.** The hover ✕ only went on `her`/`you` messages, so `system` and
`system.nar` lines (the `drawing: …` status, command confirmations, errors) had no way out. `attachRemove`
now runs for **every** message type. On top of that, the `drawing: …` placeholder from `/img`
**auto-clears** the moment the image resolves or fails, so it no longer lingers even without the ✕.

**Thoughts drawer colour, hardened.** The drawer text was already set to `#fff`, but it kept losing the
cascade on Perchance. The zip explains why this is even possible: **Perchance renders a generator with no
output iframe** — it injects the template into `#output-container` via `innerHTML` in the *main* page DOM
and hoists the template's `<body>` attributes onto the real body. So the app shares one cascade with
Perchance's page CSS; there's no isolation boundary. The drawer's text/background colours are now declared
`!important` with literal fallbacks (`var(--mind-bg,#1B1D26)`, `color:#fff!important`, etc.), so no
higher-up rule in that shared cascade can override them. (Note: the page's own CSS in the dump is just
normalize.css, which doesn't itself override `#fff` — so this is a deliberate belt-and-braces hardening
against the shared cascade rather than a single identified rule. If a specific override is still winning,
an inspector grab of the open drawer would pin it the way the `.msg.system.nar` tooltip did.)

**Also mined from the zip (noted, not built here):** the bulk of the archive is Perchance's *editor*
internals — it lints both panes with ESLint + htmlparser2 (`window.eslintInstances`, `window.htmlparser2`),
runs realtime collab over Yjs, and exposes creds-free `editor-copilot.perchance.org` bug-check/autocomplete
endpoints. That's material for the Companion userscript (a pre-Push lint gate, a Collaborate panel), not
Chloe — flagging it so it isn't lost.

## One image-prompt scrubber, routed everywhere + an input-surface audit

Consolidation pass after the random-syntax fix, plus a check of every place a user can type something.

**The audit.** Perchance only DSL-evaluates one runtime sink: the **image prompt** (its image layer owns
`{…}` and `[…]` — that's where `{sigil}` threw and where `{a|b}`/`[a|b]` are random-picks; `(…)` A1111
weights pass through untouched). Everything else a user types is safe as-is:
- ai-text takes its instruction as a **literal string** — chat messages, `/sys`, `/mem`, `/nar`, About-you,
  Context injections, persona, lorebook content, and imported character instructions all reach the model
  verbatim. Braces there are just text, so they are deliberately **not** scrubbed — a user discussing
  `{json}` or code keeps their braces, which is the correct "use Perchance as intended" behaviour for chat.
- Name/alias matching, the moderation banlist, and emotion keywords all build their regexes through an
  escape that covers `{ } ( ) [ ]`, so a brace-laden name can't throw. Lorebook keys match by plain
  substring (`indexOf`), not regex. Save labels and JSON jobs are literal storage/parse.

**The scrubber.** All image-prompt paths — engine draws, `/img`, and portrait generation — already funnel
through the brain's `paint()`, so that's the turnstile. The scrubber is now a **single function**
(`scrubImagePrompt`, defined once in the panel glue and exposed on `window`); the inlined brain and engine
reach it through a thin wrapper with a safe inline fallback, so there's one definition instead of three
copies. It now also resolves `[a|b|c]` / `[N-M]` (Perchance treats square brackets as random too) and
**preserves `(…)`** so A1111 emphasis like `(masterpiece:1.3)` still reaches the backend. Resolution still
happens once at the engine source so the image and its caption agree.

## Image prompts now resolve Perchance random syntax instead of being flattened

Follow-up to the brace fix below. The first pass stripped *all* braces from image prompts, which also
destroyed legitimate Perchance random syntax — `draw a {red|blue} fox` became `red|blue`. Perchance's
preprocessor only runs on the panel *source*, never on a string typed into the box at runtime, so that
syntax was never going to expand on its own. The pipeline now resolves it itself before painting:

- `{a|b|c}` → one option picked at random; `{N-M}` → a random number in range; nested `{a|{b|c}}` resolves
  innermost-first. Anything left in braces that isn't random syntax (`{sigil}`, `{import:x}`) keeps its
  inner text and loses the braces, so nothing brace-shaped ever reaches the backend.
- Resolution happens **once**, at the engine's paint-job source, so the generated image and the caption
  under it agree on the same pick (previously the caption could read `tinyhuge foxowl` because the
  caption-builder stripped the `|` before anything picked). The `/img` path, which bypasses the engine,
  is covered by the same expander in the brain's `paint()`.
- `/img {valid JSON}` is unaffected — it still parses as a job and pulls a clean `prompt` out. `/img {a|b}`
  (not valid JSON) falls through to being treated as a literal prompt, which now resolves the alternation
  rather than mangling it.

## Image multi-surface fix — curly braces, stuck images, and the gallery

Three linked symptoms around generated images, fixed at their respective sources.

- **Curly-brace prompts (the root cause).** Image prompts that carried `{` / `}` — from a request typed
  with braces, or `{{user}}` / `{{char}}` placeholders riding in from an imported character — were
  reaching the image backend and the cross-surface relay, where they trip a brace parse error. `paint()`
  now strips braces from the prompt before generation (`{}` → space, collapse, trim), so no brace ever
  crosses into the painter. This runs in the brain, so it covers the built-in painter and the optional
  DSL-side relay alike. I could not reproduce the brace error itself in a headless harness, so it appears
  specific to the Perchance runtime (image backend / top-panel relay) rather than the panel's own JS —
  but stripping at the source means the offending characters never get there regardless of which surface
  chokes on them.
- **Images stuck in chat with no way to remove them.** There was no per-message delete control at all.
  Every message now gets a hover ✕ (`.msg-del`) that removes it from the thread *and* from the persisted
  transcript by id, so a stuck image (or any message) can be cleared and won't come back on reload.
- **Not populated into the gallery.** The data-URL persist path was already correct; the gallery miss was
  the brace exception above aborting the image flow before the persist step ran. With braces stripped the
  flow completes and `persistImage` saves as expected. Captions are now also run through `cleanImageText`
  (substitutes `{{user}}` / `{{char}}` to real names, drops stray braces) so the line under an image reads
  cleanly.

Verified end to end in jsdom against the assembled build: brace prompt → painter receives a brace-free
prompt, caption is clean, the image saves to the gallery, the image carries a working ✕ that drops it from
both chat and the queue. No errors; all 25 harnesses green.

## Comment cleanup — removed AI smells, kept the operational facts

A pass over the source comments to strip the noise without losing the hard-won context.

- **Source-crediting parentheticals removed** — "(mined from fur-ai's detectBotEmotion)", "(mined from
  uminara's Gen-Context breakdown)", "(mined from Memory-hero…)", "(mined from aicc-recovery)". The
  comments now describe what the code does, not where the idea came from.
- **Porting/version history removed** — "survived the transplant", "the Bridge's Queen/worker failover
  machinery", "the same defaults the Discord app shipped", "the Discord build needed", and the `v0.57:` /
  `v0.58:` version tags in brain-block. The operational reason each line exists is kept; the history isn't.
- **Leftover plan markers removed** — stray `#4:` / `#6:` step numbers.
- **Editorializing trimmed** — "The whole point of the cast is…", "(the signature)", "(memory migrates for
  free)", and "every one now switchable" lost their flourishes.

The DSL/platform gotchas and the why-it's-configured-this-way notes (the genuinely valuable comments) are
untouched. Logic is byte-identical — all 25 harnesses green, syntax clean.

## Dark/light theming, per-character colours, and an accent re-theme (mined from Memory-hero)

- **The app honours your device's dark/light setting now.** Previously it was a fixed light theme that
  ignored the OS preference. Following Memory-hero's pattern, the full token set now has a dark variant
  behind `@media (prefers-color-scheme: dark)`, plus `color-scheme` so native controls and scrollbars
  follow suit. On a dark-mode device it comes up dark automatically.
- **Theme override (System / Light / Dark), saved.** A new **Appearance** tab in Settings lets you pin
  the theme. "System" follows the device (and live-updates if the device flips); Light/Dark force it via
  a `data-theme` attribute that overrides the media query. The choice is saved.
- **Accent re-theme, saved + reset.** Nine preset accent swatches plus a custom colour picker. The accent
  and its derived shades (ink/soft/line) are recomputed for the active light/dark mode using HSL math, so
  a chosen colour reads correctly in both. **Reset appearance** returns to System + the default indigo.
- **Per-character highlight colours in the Character picker.** Every roster row (including the default
  character) now has a colour swatch. It overrides the auto-assigned palette colour and applies to that
  character's name, accent border, and avatar — live, including already-rendered messages.

Ideas mined from Memory-hero are written up in `memory-hero-mining-report.md` (achievements excluded as
requested). All 25 harnesses green; theme modes, accent presets/custom/reset, and per-character colours
verified in a headless render with no errors.

## Gender-neutral command menu, and every command verified

- **Command palette degendered.** The group heading "Make her act" is now "Make them act," and the
  descriptions that read "she summarises…", "she speaks up on her own", "give her a goal", "what she
  remembers about you", "her style note", etc. are now neutral ("the character …", "their own").
- **Hover tooltips degendered.** The action-toolbar titles ("She recaps…", "She speaks up on her own",
  "Let her draft…") and the composer placeholder ("Write to her…") are neutral now too.
- **Handler messages degendered.** The stray pronouns in command responses — the language-model prompt,
  the "/mem" hint, and the "/forget me" confirmation — were rewritten neutrally.
- **All 27 commands verified working.** Each command was driven through the real composer in a headless
  render and confirmed to dispatch correctly with no errors: /img, /nar, /sys, /mem, /recap, /beat,
  /volunteer, /writeforme, /remind, /reminders, /goal, /goals, /aboutme, /highlight, /highlights, /forget,
  /persona (set + show), /lang (set + off), /time, /date, /status, /do, pasted-JSON jobs, /help, and the
  unknown-command fallback. /help opens the palette via Enter and the Commands button; palette rows draft
  their command into the composer.

All 25 harnesses green.

## A real character manager: add to scene, manage, and remove the default character

The Characters popup is now an actual manager rather than a read-only roster.

- **"Add to scene" works.** The importer/author runs in its own `<script>` IIFE and only sees the glue
  through a small shim bridge \u2014 and `addToScene` was never on that bridge, so every "Add to scene" click
  silently did nothing. It's now exposed, so importing a character or writing one and clicking **Add to
  scene** actually drops them into the cast.
- **Manage characters after adding.** Each roster row is now editable: rename inline, set nicknames it
  also answers to, toggle "in scene," and remove. The two "Make primary" labels in the importer (which
  *replace* the default character) were renamed **Set as default** to distinguish them from the roster's
  per-scene **Make primary**.
- **Make any character the lead.** Each non-primary row has **Make primary** \u2014 that character now answers
  when you don't name anyone. Backed by a new `primaryId` that routes the unaddressed turn and survives
  removals.
- **Remove the default character.** The default (Chloe) is now a removable roster member like any other,
  via a new `botActive` flag. Removing her takes her out of the scene (her engine stays built for internal
  reads but goes dormant \u2014 she never answers), reassigns the lead, and shows a **Bring back** control to
  restore her. Guarded so you can never empty the scene completely.

Solo behavior is unchanged when you have one character. All 25 harnesses green; full add \u2192 make-primary \u2192
remove-default \u2192 rename flow verified end to end.

## Context copy, About links, and readable Thoughts text

- **Context tab** rewritten to be neutral and general: "Live context from your device" (the live date/time/
  language hookup), "Always in context" (always-on facts/rules), and the Lorebook \u2014 framed around the feature
  rather than "the character," so it fits any use, not just a companion.
- **About tab** now credits the author with working links \u2014 DeviantArt (west-ninja) and GitHub
  (therealwestninja) \u2014 matching the social footer used across the Weld projects.
- **Thoughts text is now white.** On Perchance the drawer's `--mind-ink` variable was inheriting the app's
  dark `--ink` (the (35,38,45)-on-(27,29,38) you saw), leaving the thoughts nearly invisible. The thought
  text, the drawer body, and the side tab are now hardcoded white so they're readable regardless.

All 25 harnesses green.

## Menu reorganization + rebuilds, "Thoughts", drawer persistence, left-alignment

A big pass on structure and polish.

**Where things live now.** Everything about characters is in the **Characters** popup; everything about data
is in **Save/Load**; **Settings** is just preferences.
- **Character name** moved out of Settings\u2192Behavior to the top of the **Characters** popup (as "Primary name").
- The whole **per-character memory** view (whose-memory picker, what they remember, inner state, context
  budget) moved from the old Memory tab into the **Characters** popup.
- The leftover data stat ("what's stored") moved into **Save/Load**, which is where backup/erase already lived.
- The now-empty **Memory tab is gone**; Settings tabs are You / Context / Behavior / About.

**Rebuilt both popups** around how character-management and save screens work in games:
- **Characters** reads top-to-bottom as a cast screen \u2014 *The cast* (primary name + roster + director dials),
  *Add a character* (import + write-your-own, with the found/preview flow as nested sub-cards), *Portrait*,
  and *Memory*. Subsection headers and sub-cards give it real hierarchy instead of a flat stack.
- **Save/Load** leads with *Save now*, then the *Timeline* (the saves, front and center), then
  *Auto-checkpoints*, *Backup* (stats + export/import), and *Start fresh*. Copy is character-neutral throughout.

**"Her mind" \u2192 "Thoughts".** The drawer, its toolbar button, the side tab, and the front-page copy all now say
Thoughts (and read character-neutral).

**Drawer remembers its state.** The Thoughts drawer was re-opening on every refresh regardless of how you left
it. It now persists open/closed across refreshes (first run still defaults to open on wide screens).

**Left-alignment.** Perchance's panel centers text by default; forced left-alignment at the root so the popups
and copy read left-aligned (intentionally-centered bits \u2014 empty states, drop zones \u2014 keep their centering).

Verified end-to-end (every popup opens body-level, every moved control is in its new home and wired, all
Settings tabs switch, drawer persistence confirmed against real storage). All 25 harnesses green; no duplicate
or dangling element IDs.

## Neutralized the Settings + Save/Load copy

The app is general-purpose now (any cast of characters, any user), so the Settings popup no longer talks as
if there's one fixed "she." All user-facing copy across the Settings tabs — You, Context, Behavior, Memory,
About — and the Save/Load popup was rewritten to be character-neutral: "the character," "they/their," or
plain rephrasing ("What's stored," "Inner state," "Expressions," "Self-image"). This covers both the static
labels and the dynamically-rendered text (behavior-toggle descriptions, the inner-state sections, the empty
states, the add/confirm messages). The default name placeholder ("Chloe") and the engine credit on the About
tab are left as-is. All 25 harnesses green.

Note: the chat surface still has some gendered copy by design-of-default (the "Her mind" drawer label, the
emotion-cue tooltip, feedback-button hints, the command palette, and the Characters popup's default-Chloe
language). Those weren't in scope here; easy to neutralize next if you want the whole app degendered.

## Fix: Settings popup wouldn't open + UI/z-index audit

**The bug:** when the Save/Load popup was added, its markup was missing one closing `</div>`, so its
container never closed and every popup after it in the document — Settings, Gallery, Community — got nested
*inside* the (hidden) Save/Load popup. Clicking Settings did open it, but it was buried inside a closed
popup, so nothing showed (it was visible only with Save/Load open). Closing that tag puts all five popups
back as independent, body-level layers.

**Z-index:** restacked the layers so a popup always sits above the mind drawer. The mobile full-screen mind
drawer was at z-index 50 while popups were at 40, so an open drawer could cover a popup; popups are now 100,
the image lightbox 120, toasts above both. Order is now content < command palette < mind drawer < popups <
lightbox < toasts.

**Audit:** drove every user-facing surface (all five popups open as body-level siblings; all five Settings
tabs switch; every menu's controls are present — behavior toggles, context injections + lorebook, memory
facts + the whose-memory picker, the Characters roster/import/portrait/author, and Save/Load's save-now,
auto-checkpoint dials, timeline, and export/import/erase). No orphaned controls, no console errors. All 25
harnesses green.

## Save / Load — checkpoints, save slots, and a timeline

A new **Save/Load** button sits in the toolbar between Gallery and Settings, opening its own popup. The old
"Memory & data" tab is now just **Memory** (the inspection cards); everything about *data* moved here.

- **Manual saves** — "Save now," with an optional label ("before the argument"). Each save is a full snapshot
  of the session: every character's separate memory, the cast, the lorebook/settings, and the whole transcript.
- **Auto-checkpoints** — saves on a timer you set (**every N minutes**, default 10) and keeps a **rolling set**
  of the most recent ones (**keep N**, default 10); the oldest drops off automatically. It skips a tick when
  nothing's changed, so idle time doesn't churn checkpoints. Toggleable.
- **Timeline** — most recent at the top, auto vs. saved badges, timestamp and message count. **Load** rolls
  the entire session — conversation and all memory — back to that point (with a clear confirm, since it replaces
  current state). Each entry can also be **exported to a file** or deleted. **Manual saves are never auto-pruned.**
- **Storage** — all saves live in **IndexedDB** (roomy), so many large snapshots fit without touching the
  localStorage quota. The existing full Export / Import / Erase controls moved into this popup too.

`harness-solo-saves.js` covers the rules that protect your saves: newest-first ordering, the rolling keep-count,
the keep=0 floor, and that manual saves are never pruned. All 25 harnesses green.

## Characters popup split out from Settings (fur-ai-style)

The toolbar now has its own **Characters** button (◫) beside Settings, opening a dedicated Characters popup
— modeled on fur-ai's picker. It holds everything about the cast: the **Scene** roster (now with avatar
thumbnails — a real image if the character has one, otherwise a colored initial in their scene color),
in-scene toggles, aliases, the director dials, **Her portrait**, the AICC importer / share-link / write-your-own,
and reset-to-default. Settings keeps only what isn't about a character: **You, Context, Behavior, Memory & data,
About** (and now opens on You). Nothing was rewired — all the import/portrait/author controls kept their ids,
so their behavior is unchanged; they just live in their own home now. All 24 harnesses green.

## Multi-character — inspect any character's memory

The cast's whole point is that each character remembers you *separately* — now you can see it. The Memory &
data tab grows a **Whose memory** picker (shown only in a scene): tap the primary or any character and the
facts list, "what's on her mind" (mood, self-note, conclusions about you, follow-ups), and the context-budget
breakdown all switch to *that* character's own engine and store. Forgetting a fact acts on the character
you're viewing. The picker pills carry each character's color; a removed character falls back to the primary
(never a dangling view). Solo is unchanged — the picker stays hidden and everything targets the primary
exactly as before.

Also hardened: each character's store now gets its own `you` partition seeded at startup, so a newly added
character can remember you from the very first message (not only after its first ingest). `harness-solo-director.js`
covers the view-selection + fallback; all 24 harnesses green.

## Multi-character — per-character color & avatar (readability)

In a scene, every reply used to look the same but for the name label. Now each character has a stable
color (from a readable palette, by id) shown as a left accent on their messages, on their name, and on
their Scene roster row; if a character was imported with an avatar, a small avatar appears on their name
line. Your primary keeps the default accent. Solo is visually unchanged (the styling only applies in a
scene). `harness-solo-director.js` covers color stability.

## Multi-character — name addressing both ways

Addressing now works two ways, together: an explicit `@name`, and a plain scan for a character's name in
what you type. A character answers to their **full name**, their **personal name** (the first word that
isn't a title — so "Doctor Vane" answers to "Vane", but "the doctor said…" doesn't trigger them), and any
**aliases/nicknames** you give them in a new field on each Scene roster row. Names embedded inside other
words don't false-trigger. `harness-solo-director.js` covers all of it (personal name, title-skip,
aliases, `@name`, embedded-word safety).

## Multi-character — Stage 2: wired into the app (testable)

Patched the cast into the live app. You can now build a scene of several characters who each keep their
own private memory, talk to you, and talk to each other — all over the one shared transcript.

**How it works**
- **Primary + extras.** Your existing Chloe is the *primary* — she keeps the legacy `chloeSolo:` store, so
  all her memory carries forward untouched. Each character you add gets its own namespaced store
  (`chloeSolo:c:<id>:`) and its own engine; nobody can read anyone else's memory.
- **One tiny engine hook.** Added `cfg.engageDecide` to the engine's `isAddressed` (a no-op when absent,
  so solo is byte-for-byte unchanged). In a scene, the app's **director** uses it to decide who speaks
  per beat — so twelve engines don't all answer at once, and no AI call is wasted on a character who
  isn't speaking. Everyone still *ingests* every line, so all characters remember everything.
- **Director (the hybrid you'd expect).** Address a character by name or `@name` and they answer; address
  no one and your primary answers; a character can name another and they'll reply, chaining up to a
  **max back-and-forth** cap before control returns to you, with a **max speakers per beat** cap so a
  group never floods. Both caps are dials in the new Scene panel.

**UI** — the Character(s) tab now opens with a **Scene** roster: your primary, plus each added character
with an in-scene toggle and a remove button, and the two director dials. Every way you already make a
character (AICC import, share link, raw JSON, or "write your own") gained an **Add to scene** button
alongside the existing "Become this character."

**Notes / current limits (v1):** in a scene, replies render atomically (live streaming is solo-only, to
avoid two characters fighting over one bubble); extras are text-only (only the primary paints images) and
only the primary breaks silence on her own; the mind drawer shows the primary's thinking (extras think
silently). All sensible next steps, none blocking.

`harness-solo-director.js` drives the real in-app director: name/@address routing, primary fallback,
bounded character-to-character chaining, the speaker/follow-up caps, stale-beat rejection, and that solo
is untouched. Engine edit regression-clean: **all 24 harnesses green.**

## Multi-character — Stage 1: the engine core (proven)

A scene of many characters is just N engines over ONE shared transcript. fur-ai imports/manages a cast
and caps at 8; our shape has no such cap, because each engine already partitions memory per person it
talks to — point that at a group and every character forms its own private read of everyone else. Built
and proved the load-bearing layer first (`cast-core.js`), engine- and UI-agnostic so it could be tested
with the real ChloeT0 engine before any UI exists:

- **`makeStore(backend, prefix)`** — per-character namespaced memory (keys *and* the partition index), so
  one character's memory can never be read or clobbered by another. This is the one real prerequisite
  the single-character store didn't have.
- **`createCast`** — holds one engine per character over the shared transcript; add/remove never touches
  another character's memory. A `primary` character can keep the legacy un-prefixed namespace (so the
  existing Chloe's memory migrates for free in Stage 2).
- **`makeDirector`** — decides who speaks next: explicit `@address` > bare name mention > round-robin,
  never the character who just spoke, capped by `maxSpeakers`. This is what keeps a 12-character scene
  from stampeding a reply — relevant few speak, the rest just listen and remember.

`harness-solo-cast.js` proves it end-to-end with real engines: namespaced isolation, that Aria's facts
about you are invisible to Bram, one shared transcript all engines read, every director routing rule, and
clean scaling to **12 then 30 characters** with memory still isolated. **No hard cap** — roster size is
unlimited; the real ceiling is sequential AI latency, which is exactly what the director manages.

Next (Stage 2): wire the cast into a redesigned **Character(s)** tab (roster + picker, add/import/remove,
per-character active toggles, director settings), per-speaker send/render in the thread, turn pacing, and
migration of the current single Chloe onto the cast as the `primary`.

## Bug-fix pass + working Community comments

Adopted Davie's updated build (generator now titled "My Girl"; DSL imports `weld-comments-plugin`).

**Got the comments plugin working.** The 💬 Community panel was always falling back to the "needs a
plugin" note. Root cause: the panel looks for `window.weld.comments` in the *HTML panel*, but a top-panel
`{import:weld-comments-plugin}` installs into the top-panel window — it never reaches the HTML panel's
`window`. (This is the same reason the other five Weld plugins are self-hosted, and exactly what the
official weld.comments example does — it inlines the plugin into the panel.) Fix:
- **Self-hosted `weld.comments`** by extracting the real plugin installer into `weld-bundle.js`, so
  `window.weld.comments` now exists in the panel alongside the other five. It's fully self-contained:
  `inline()`/`open()` build an iframe to the real `comments-plugin.perchance.org/embed/` backend, keyed by
  a stable channel — no top-panel dependency. The DSL import is now optional (harmless to keep).
- **Made the embed usable:** gave the host a real height (60vh) so the iframe renders instead of
  collapsing, and reworded the fallback from "import the plugin" to a plain network-failure message
  (it's self-hosted now, so a missing plugin is no longer the failure mode).

**Hardened a hot-path crash risk.** The lorebook provider runs on *every* reply and did
`(e.keys || []).map(...)`. A lorebook entry whose `keys` is a comma-*string* (hand-edited state, or an
import that stored the wrong shape) would throw on `.map` and take down generation — the same bug class as
the Luminara `keys.split` crash. Added a `loreKeysArr()` coercion (array / comma-string / `key` singular /
missing → clean array) used by both the provider and the editor, so bad data degrades gracefully instead
of crashing.

**Audit, clean.** Both script blocks pass `node --check`; every `byId`/`getElementById` reference resolves
to a real element; no TODO/dead markers; every recently-added function (lorebook, emotion, budget, gallery,
moderation) is wired with a live call site. `harness-solo-weld.js` now also proves the self-hosted comments
plugin builds the correct embed; `harness-solo-lorebook.js` proves string-form keys are coerced, not
crashed on. All 22 harnesses green.

## Mined from fur-ai — per-reply expression cue

fur-ai swaps a character portrait between happy/sad/mischief/surprise/embarrassed/angry images by
reading the bot's own reply (`detectBotEmotion` + a keyword map). Chloe has a single portrait, not a
set of per-emotion sprites, so I ported the *detection*, not the sprite-swap: a small mood glyph appears
next to her name on each reply.

- Ported fur-ai's detector faithfully: word-boundary keyword matching (so "happy" never fires inside
  "unhappy"), **recency wins** (the last feeling in a reply is the one shown), longer-phrase tiebreak,
  and punctuation tells that override (`?!`/`!?` → surprised, `~` → playful). Enriched the keyword
  vocabulary with inflected forms (laughing/grinning/embarrassing…) since the match is exact.
- Display-only — it reads her finished words and never touches what she says. Works on both streamed
  and non-streamed replies; image messages are skipped (no spoken text).
- **Toggle** in the Behavior tab ("Show her mood on each reply"), on by default; turning it off clears
  the cues live.
`harness-solo-emotion.js` proves recency-wins, boundary safety, symbol overrides, and neutral-text → no cue.

## Mined from Luminara + fur-ai — a lorebook

Studied the updated **Luminara** (the grown-up uminara) and **fur-ai**. Both are mature roleplay
generators; the feature they share that Chloe lacked is a **lorebook** — background that surfaces only
when relevant, rather than sitting in every prompt. Other notable finds (logged for later, not built):
fur-ai's **emotion detection from replies** (keyword → expression, would drive a reacting portrait),
Luminara's **estimateLlamaTokens** (a BPE-ish fallback — Chloe already wires the *real* Perchance
tokenizer, so lower value), and tiered/ranked memory retrieval (Chloe's engine already ranks facts by
importance and recalls episodes by relevance).

Built the **lorebook**:
- Implemented as an **engine context provider** (`registerProvider`), so matched entries ride the same
  token-budgeted injection path as mood/time/world-directives — they're admitted by priority and dropped
  first under budget pressure, never blindly stuffed in.
- On each reply it scans the **current message + the last few lines** for an entry's trigger words
  (case-insensitive); only matching entries are injected, capped at ~1400 chars, framed as "use only if
  it fits naturally, never recite."
- **Lorebook editor** in the Context tab: add/edit/delete entries (trigger words + content), with
  **import/export** — import accepts Chloe's own JSON *and* SillyTavern / AICC world-info shape
  (`{entries:{…key,content}}`) for interop with the wider roleplay ecosystem.
`harness-solo-lorebook.js` proves matching (message + recent lines, case-insensitive, no-match → nothing)
and that a triggered entry actually reaches `ctx.injections` through the real engine.

## Mined from uminara — context-budget inspector

Studied the uminara generator's context-optimization code (it deals heavily with text/tokens/
compression). Its standout pieces: a **Gen-Context & Token Breakdown** modal, a **rolling
summarization** pass with two-stage compression (summarize → re-compress the summary when it grows),
**action-fluff pruning** (strip short `*gesture*` blocks from old roleplay turns but keep dialogue,
critical-verb actions, and rich prose), and a hand-rolled chars/3.7 token estimate.

What Chloe already had vs. what was worth taking:
- Her engine already does rolling channel summary (bounded per pass by a word limit, so it doesn't
  need uminara's two-stage re-compression) and real token-budgeted context packing with the *actual*
  tokenizer (`estimateTokens` → the wired `countTokens`, not a chars/3.7 guess).
- What it lacked was **visibility**. So I built a **Context budget** inspector (Memory & data tab):
  on open it prices each part of what goes into her next reply — character & persona, memory (facts +
  insights), world directives, and recent conversation — using her own tokenizer, shows the authoritative
  whole-request total against her ceiling (`requestTokensEst` / `requestTokenBudget`), and reports how
  many old lines were dropped to fit (`contextDropped`). Per-component bars + a budget bar.
  `harness-solo-budget.js` proves it reads the real tokenizer and the engine's authoritative totals.

Deliberately **not** taken: action-fluff pruning needs an engine hook (the engine has no
history-line transform point) and is lossy + roleplay-specific; flagged as an opt-in if wanted.

## Self-hosted Weld + toast notifications

**Weld is now self-hosted — no `{import:weld-*}` anywhere.** Instead of relying on the import feature,
the real Weld plugin source is extracted verbatim from its doc pages and inlined into the app via a new
`weld-bundle.js` (assembled through a `/*__WELD__*/` marker that runs *before* the engine, so
`window.weld.*` exists at boot). Bundled, all dependency-free: **weld.markdown, weld.banlist,
weld.gallery, weld.toast, weld.spamguard**. Consequences:
- Her replies now render through Davie's **real** `weld.markdown` (the inline subset stays as a safety
  fallback only).
- The content gate uses the **real** `weld.banlist` — the g→x rating ceiling works with no import.
- The 🖼 Gallery is backed by the **real** `weld.gallery`.
- The app is still a single self-contained file; the only remaining optional import is Perchance's own
  `comments-plugin` backend for the 💬 Community thread (a Perchance service, not a Weld plugin).
`generator-dsl.txt` updated accordingly. `harness-solo-weld.js` proves all five install and actually
work (markdown renders + stays safe, banlist blocks wildcards, gallery/toast/spamguard factories present).

**Toast confirmations (new, via self-hosted weld.toast).** Added a `toast()` helper and fired it at the
moments that were silent before: an image saved to the gallery, the gallery cleared, memory exported,
a character applied ("Now chatting as …"), and a portrait updated. No-ops safely if toast is ever absent.

## Weld mining — markdown replies, content moderation, community comments

Mined the Weld suite (90+ plugins) for things that improve a *smart chat app* specifically:

- **Markdown in her replies (QoL headline).** Her replies rendered as flat text, so `**bold**`, lists,
  `code`, and links showed as raw characters. Added a compact, **safe** markdown renderer (mirrors
  `weld.markdown`: escape-first, URL-sanitized — `javascript:`/`data:` neutered, no raw-HTML
  pass-through) covering bold/italic/strike, inline + fenced code, links, images, lists, blockquotes,
  and h1–h3. It renders her bubbles (and the finalized streamed reply); user/system lines stay literal.
  Prefers `window.weld.markdown` when that plugin is imported, else uses the built-in subset. New CSS
  styles every element inside her bubble. `harness-solo-markdown.js` proves formatting **and** that a
  model reply can never inject HTML/script.
- **Content moderation gate (weld.banlist pattern).** A new card in Behavior → blocks image prompts
  containing banned phrases (substring + `*` wildcard). Gated at `paintImage`, the single chokepoint for
  all image generation (natural-language requests *and* `/img`), so a blocked prompt makes her decline
  instead of drawing. Off by default; prefers `window.weld.banlist` when imported (which adds the
  g→x content-rating ceiling). `harness-solo-moderation.js` covers the inline and weld-preferred paths.
- **Community comments (weld.comments).** A new **💬 Community** button opens a moderated public thread
  for the page (separate from the private chat). Uses `weld.comments.inline` when the plugin is imported
  — the plugin handles posting and moderation (admin delete/ban via `adminPasswordHash`); a friendly
  panel explains how to enable it otherwise. Optional imports documented in `generator-dsl.txt`.

## Mining round — the full cognitive control surface

This round's finding was about *control*, not capability. Diffing the engine's exposed API against
Solo's usage showed the remaining unused surface is now almost entirely internal engine machinery or
Discord-only (moderation, AFK, polls, reactions, backfill, Bridge failover) — the cognition itself is
fully migrated. But cross-checking the Discord app's **control panel** revealed the real gap: it let the
operator switch *every* cognitive feature, while Solo had quietly **hardcoded ~13 of them on** and only
surfaced 7 toggles.

Surfaced the whole set in the Behavior tab, grouped into cards, each one **live** (every key is in the
engine's `LIVE_PATCHABLE` set, so flipping it takes effect immediately with no rebuild):
- **Memory** — conversation memory, remember facts, episodic memory, connect related memories
  (episodeGraph), running summary, tidy-when-idle (consolidation).
- **Understanding you** — reflect on what she learns, track what you're working on (goals), let
  familiarity grow (trust), match your register, learn what lands, notice contradictions, recall by meaning.
- **Inner life & thinking** — inner weather (own-affect), sense the mood, hold the moment (working
  memory), think things over when idle (deliberation), prioritise by relevance (attention manager).
- **Grounding & image** — self-knowledge, remember her images (imageMemory).

Defaults are unchanged (the previously-hardcoded features stay on; the four opt-ins — contradictions,
register-matching, feedback-learning, semantic recall — stay off, matching the Discord app's defaults).
Existing saved settings are honored (`!== false` semantics, so an older state without these keys still
defaults on). The toggle markup is now data-driven from a `TOGGLE_GROUPS` table and wired through
`updateConfig`, replacing the old static 7-checkbox block and its rebuild-on-change path.
`harness-solo-toggles.js` proves all 20 toggles are defaulted and live-patch the engine both ways.

## Mining round — smart image refine + clean reminders

Continuing the audit of the Discord app against the migration. Two more things were latent or rough:

- **Image refine, made smart.** Enabling `imageMemory` last round quietly activated the engine's
  `parseImageEdit` path — within ~10 minutes of an image, phrases like "make it landscape", "add a hat",
  or "another one" now retarget the *last* image instead of starting fresh. The engine prefers an
  `cfg.editPrompt` AI hook and only falls back to a deterministic rewrite. Solo provided no hook, so it
  was stuck on the deterministic patterns. Added an **`editPrompt` brain handler** that rewrites the
  previous prompt for *arbitrary* language — "more moody", "in the style of Van Gogh", "swap the fox for
  a wolf" — folding the change into what still fits. It's an internal pass (instruction-only, no
  `startWith`), so it never streams into chat, and the engine still falls back to its deterministic
  rewrite if the hook returns nothing. Documented in `/help` and the composer placeholder.
- **Reminders deliver clean.** `/remind` was wired and reminders do fire through `cfg.send`, but the
  engine builds the body with a Discord mention token (`⏰ <@you> reminder: …`). `soloSend` now strips
  leftover `<@id>`/`<#id>` tokens (there's no Discord surface here, so it's always safe), so a fired
  reminder reads "⏰ reminder: …".

Verified the chat-only gating does **not** drop reminders (soloSend always renders a non-empty body).
`harness-solo-refine.js` proves the prompt rewrite, the internal/no-stream property, the deterministic
fallback, and the token scrub.

**Not migrated (deliberately):** per-user **translation** — in the Discord build this lived in the
bridge, not the engine (the engine has no translate path), and a faithful port needs a network
translation service, which fights Solo's self-contained design. Flagged for a future round if wanted.

## Mining round — more brain features + an image gallery

### More cognition migrated from the Discord app
Audited every engine feature gate against Solo's config and turned on the ones that were silently
left off (the Discord-only gates — autoMod, backfill, T4, keepActionLog, replyReference — stay off by
design; `singleParagraph` is covered by the verbosity dial; `imageEnhanceOffer` is left off to keep
chat to replies + images):
- **`episodeGraph: true`** — she now links each recorded moment to its closest earlier one (shared
  people/topics/time), so a recalled memory can carry "…and that reminds me of when…". Needs episodic
  memory, which Solo already runs.
- **`imageMemory: true` (ring 12)** — she remembers the recent images she's drawn (prompt + resolution +
  time) on your partition, so "make another like that" / refine has something to anchor to. Records in
  the shared paint path right after each image is delivered.
- **`adaptivePolling: true`** — Solo set `pollFloorMs:100` / `pollCeilMs:700` but never turned on the
  flag that uses them, so it was polling at the fixed default. Now the cadence actually rides the band:
  snappy when there's activity or pending work, easing toward the ceiling when idle.
- **`cleanOutput: true`** — set explicitly (the reply path already hygienes via `cleanReply`, and Solo's
  streaming finalizes with that cleaned text; this pins it on).
`harness-solo-brain-enables.js` proves all four, including the adaptivePolling on/off cadence difference.

### Image gallery (IndexedDB) + viewer
Generated images used to be ephemeral — rendered in chat, lost on reload. Now every image she draws is
persisted and browsable.
- **Storage** mirrors Davie's **weld.gallery** exactly: a `blobs` IndexedDB store keyed by a generated
  id + a `meta` manifest of `{id, prompt, resolution, createdAt, favorited}`, with oldest-non-favorited
  eviction at 300. The dataUrl from the paint relay is converted to a Blob and stored on every send
  (`persistImage`); SVG demo placeholders are skipped. It's **self-contained** (raw IndexedDB, no import)
  but **prefers the real `weld-gallery-plugin`** if you import it (auto-detected via `window.weld.gallery`).
- **Viewer** — a new "🖼 Gallery" button in the header opens a responsive grid (`w-gallery`): sort
  newest/oldest/favorites, favorites-only filter, per-tile ★ favorite / ⬇ download / ✕ delete, click to
  open a lightbox with the full prompt, and Clear-all. Object URLs are revoked on close.
- `harness-solo-gallery.js` round-trips the real module against a fake IndexedDB (store, manifest,
  metadata, favorite, remove, clear, blob cleanup). The optional import is documented in `generator-dsl.txt`.

## Feature — personality dials in the Behavior tab
The dials existed in the brain (`personaStyle` bands `ctx.personality` into tone instructions) but were
**dormant** — the engine never threaded `cfg.personality` into `ctx`, so nothing reached them, and Solo had
no UI for them. Now wired end to end:
- **Two additive engine edits:** `assembleContext` threads `cfg.personality` into `ctx.personality`, and
  `personality` joined `LIVE_PATCHABLE` so changes apply via `updateConfig` with no engine rebuild.
- **Six sliders** in Behavior → Personality: kindness (blunt↔warm), sarcasm (earnest↔deadpan), curiosity
  (reserved↔inquisitive), playfulness (serious↔playful), formality (casual↔polished), verbosity
  (terse↔expansive). 0–100 in the UI, stored 0–1; the centre is neutral (no instruction emitted). Dragging
  a slider live-patches her tone immediately; the value persists on release. "Reset to neutral" included.
- On Perchance the model exposes no temperature, so there's no literal "heat" knob — that lives in the
  sarcasm + playfulness dials (noted in the card). `harness-solo-personality.js` proves the thread,
  the live-patch, and the 0.25/0.45/0.55/0.75 banding.

## Features — token budgeting · opening message on import · highlights · Discord→1:1 cleanup
- **Exact token budgeting.** `wireTokenizer()` pulls `countTokens` (and `idealMaxContextTokens`) from the
  ai-text plugin via `getMetaObject` and passes `countTokens` into the engine, so context is budgeted by
  real tokens instead of the `chars/4` fallback (AICC parity). Falls back cleanly when unavailable.
- **Opening message on import.** AICC characters carry `initialMessages`; the importer now captures them
  (`charNormalize`) and the `config.setCharacter` shim seeds them into the thread on import via
  `seedOpeningMessages()` — `ai`→her, `system`→a system line, `user`→you — and enqueues them so the opening
  rides into her context. So an imported character greets you in-character immediately.
- **Highlights.** `/highlight [note]` saves the last line (with an optional note), `/highlights` lists them
  (`/highlights clear` wipes), and a **★** button now sits beside 👍/👎 on each of her messages to save that
  line. Backed by the engine's `addHighlight`/`listHighlights`/`clearHighlights`.

### Cleanup — leftover Discord/Bridge code migrated to Solo's surface
Scanned the Solo bundle. The impactful leftovers were in the **brain prompts**, which told the model it was
"chatting in a Discord channel with several people" — wrong for a 1:1 and it shaped her replies. Migrated
`respond`, `greet`, and `deliberate`/volunteer to frame a **private one-on-one conversation**, dropped the
`@mention` directives, and neutralized Discord-flavoured prompt examples. Left as-is by design: the engine's
Discord machinery (moderation, reactions, mod commands, Bridge failover) is cleanly inert in Solo via config
— it's the shared engine, so it stays; and the importer's `call('config.setCharacter')` RPC vocabulary is a
working local adapter (the `call()` shim), not dead code. (Two remaining `@mention` mentions are in code
comments only.)

## Fix — channel summary leaked into chat · poll noise · auto-scroll QoL
- **Channel summary in chat.** After an image, her *channel summary* ("A user requested an image of a cat
  to be drawn… task-oriented") was rendering as a CHLOE message. Cause: `channelSummary` calls the model
  with **no `startWith`**, and the streaming gate treated `startWith == null` (undefined) as a reply. The
  six real reply handlers all pass an explicit `startWith: ''`; cognitive passes omit it or use `[`/`{`. The
  gate now requires the explicit empty string, so summaries (and any other no-`startWith` pass) can never
  stream into the thread. `harness-solo-extras.js` adds the exact regression: a no-`startWith` pass does not
  stream even mid-reply.
- **Poll spam.** The mind drawer was burying real cognition under `T0 poll` heartbeat lines (one per poll
  tick). Routine poll ticks are now filtered out of the drawer (poll *errors* still show). The poll itself
  is unchanged — it's a cheap local read that keeps her responsive — it just no longer narrates itself.
- **Auto-scroll.** Both the chat and the mind drawer now stick to the latest as content streams in, but
  **pause the moment you scroll up** to read back, surfacing a **"↓ New" pill** when something arrives while
  you're paused; clicking it (or scrolling back to the bottom) re-engages. Sending a message always snaps
  the chat to the bottom. Reusable `makeSticky(scrollEl, btn)` drives both panes.

## Fix — image generation never fired (no painter on Perchance)
Root cause, from the deployed generator + console log: the painter was installed **only inside
`installMockIfNeeded()`**, which returns early as soon as a real ai-text plugin is present — so on
Perchance `window.paintImage` was never set, `root.paintImage` was never defined, and `grabPaintImage()`
returned null. Every image silently failed before any plugin call (no image activity in the log, while
ai-text ran fine). The old `generator-dsl.txt` also left its relay commented out and read the wrong field
(`out.url`/`outputUrl` instead of `.dataUrl`).

- New `installPainter()` runs at boot **unconditionally**. It awaits the real `textToImagePlugin`
  (`root.` then `window.`) in the HTML panel — the same scope where ai-text's broker already attaches in
  this deployment — and posts `{ ok, dataUrl }` back on `window.__chloePaint` by `reqId`, reading the
  canonical `.dataUrl` off the awaited boxed String. `guidanceScale` and `removeBackground` are forwarded.
  A rejected generation reports `{ ok:false, reason }`; with no plugin at all (opened as a plain file) it
  falls back to the labelled SVG placeholder so the flow stays visible.
- `grabPaintImage()` now also accepts `window.paintImage` (it previously only looked at `root.paintImage`,
  so even the old demo painter was unreachable). A top-panel `root.paintImage` still takes precedence.
- **No DSL paste is required anymore.** The top panel just needs the two plugin imports (which the deployed
  generator already had). `generator-dsl.txt` rewritten to say so, with a corrected optional top-panel relay
  documented as a fallback for setups that can't attach the broker iframe in-panel.
- `harness-solo-relay.js` pins the whole contract: painter always installs, `grabPaintImage` finds it,
  `.dataUrl` is the field read, args reach the plugin, rejection surfaces a reason, no-plugin → SVG.

**To pick it up:** re-paste the new `solo-app.html` into the HTML editor. Nothing in the top panel changes.

## Command layer — action toolbar · slash commands · JSON jobs · write-for-me
Mined the Discord bot's command registry and AICC's compose model, then surfaced both in Solo.

- **Action toolbar** above the composer: **Write for me** (she drafts your next message into the input,
  editable before you send — AICC-style), **Recap**, **Volunteer** (she speaks up on her own), **Beat**
  (a spontaneous in-character line), **Remind**, and **⌘ Commands** (a grouped palette of every slash
  command; click one to stub it into the composer).
- **Slash commands** in the composer (`handleComposerCommand` runs before a message is treated as chat):
  `/img <prompt|json>` (paint now), `/nar <text>` (a scene line she reacts to), `/sys <text>` (a standing
  directive — reuses the semantic-injection path; `/sys clear` resets), `/mem <text>` (durable operator
  fact), `/recap`, `/beat [idea]`, `/volunteer`, `/writeforme`, `/remind 10m <text>` (m/h/d; `/remind
  clear|list`), `/goal`, `/goals`, `/forget <thing>|me`, `/aboutme`, `/persona <note>` (set/show/clear her
  style note), `/status`, `/lang <code>` (`/lang off`), `/time`, `/date`, `/do {json}`, `/help`.
- **JSON jobs** like the Discord bot: paste a bare `{ "type":"image", "prompt":"…" }` (or `/do {…}`) and
  it routes by `type` (image/remind/mem/goal/sys/nar); a bare `{prompt}` infers an image job.
- The proactive handlers (`recap`/`beat`) are fired by building `engine.assembleContext(...)` and calling
  the brain handler directly, then rendering via `soloSend`. `/img` calls `paint()` → `soloSendImage`.
- New `.msg.system` thread style for narration / directives / command acks (centered, muted; `.nar`
  variant for scene lines). `renderMessage` extended for the `system` role.
- These are all **user-initiated**, so the reply+image-only invariant still holds: nothing here fires on
  its own. `harness-solo-commands.js` verifies the parsing (verb/rest split, duration parse, JSON
  job-type inference) and that every command's engine effect lands (mem/goal/remind/lang/forget/aboutme/
  persona). Full 9-harness regression green.

### Still mineable from the bot (not yet surfaced — candidates for a later pass)
- **highlights** (`addHighlight` — save/revisit a message), **afk/back** (away state — niche for one user),
  **swipe/regenerate** (the engine has no "redo last reply" primitive — would need a new path),
  **excise/edit-memory** (`exciseMessage`/`exciseLastFromUser` are exposed — an "edit what she remembers"
  affordance). `/persona <note>` is supported by writing the same record the engine reads at assemble time
  (Solo has no mod-reaction anchor UI); full persona-*name* takeover still needs a reload to re-read.

## Fix — only replies + images belong in chat
- Her self-initiated SPEECH was reaching the thread: greet, lull, and checkin generate a message and the
  engine posts it to chat on its own during idle (recap/beats/volunteer/reminders/commands are already
  inert in Solo). Turned all three off (`greet:false, lullFiller:false, checkins:false`). Her self-initiated
  THINKING (deliberate/dream/plan, facts, summaries, mood) is untouched and still streams to the mind drawer.
- The streaming wrapper made it worse: it opened a chat bubble for *any* empty-`startWith` generation, so an
  abandoned greet/lull/checkin stranded an orphan bubble. Hardened it: a live bubble is now created only when
  a reply is actually expected (`replyExpected`, set when the user sends, cleared when her reply/image
  renders), and a reusable `dropLiveOrphan()` clears any half-open bubble on the next send. Nothing
  autonomous can open a chat bubble anymore.
- Audited every `renderMessage`/`cfg.send` path: chat now carries only the user's messages, her direct
  replies, and her images. `harness-solo-chat-only.js` pins that greet/lull/checkin never fire across a long
  idle stretch and the only thing sent is a reply, while the mind drawer keeps filling. `harness-solo-extras.js`
  updated for the `replyExpected` gate.

## Fix — Bridge run-lock stalled single-instance Solo
- The engine's Queen/worker run-lock (`cfg.runLock`, default on) protects a shared cursor across multiple
  instances. Solo is single-instance, so a `runlock:solo` key left in localStorage by a prior page load
  made the next session skip polling for the lock's 45s TTL — the "another engine instance holds the
  run-lock… skipping poll" message. Set `runLock: false` (the documented single-instance escape hatch) and
  `replyResume: false` (the matching failover path, which can never verify without a Discord `recentFetch`).
  Also clear any leftover `runlock:`/`pending:` key on boot. `harness-solo-lock.js` pins both sides:
  the Bridge default still skips on a stale lock; Solo no longer does.

## Beauty pass (AICC-like palette + left-aligned transcript)
- Recoloured from the warm cream/sepia theme to AICC's cooler neutral: cool light-gray ground, slate
  ink, and a cleaner indigo accent (`#5B62E0`). Synced the pulse/breathe glow and cooled the textarea
  placeholder + danger-button warmth so nothing reads sepia anymore.
- The whole conversation is now left-aligned, transcript style like ai-character-chat: user messages moved
  from right-aligned bubbles to the left (left-pointing corner), so both speakers read top-to-bottom on
  the left, human-readable. `text-align:left` set explicitly on `.thread`, `.id .name`, and `.thought .txt`.
- CSS braces balanced (133/133); all six harnesses still green.

## Quick-win batch (streaming · feedback · persistence · inner state)

Mined from the project knowledge, past-session archives, the ROADMAP, and the Solo source itself, then
built the four highest payoff-per-effort wins. The engine and brain are unchanged; every change is in the
Solo glue.

### #1 — Streaming replies (token-by-token)
- Her conversational replies now render as they generate instead of all-at-once. A wrapper around the
  ai-text handle (`wrapAiForStreaming`) intercepts only the six conversational handlers — respond, greet,
  lull, checkin, beat, recap — which are the *only* ai-text calls with an empty `startWith`; every
  cognitive pass uses `[` or `{` and is passed straight through untouched.
- The wrapper opens a live bubble on the first chunk, updates it on each chunk, and `soloSend` finalizes
  it with the engine's authoritative text (so any post-processing still wins). A blinking caret marks the
  in-flight reply; the typing dots hide once words start. Degrades gracefully to all-at-once if the
  backend doesn't stream. Re-wrapped post-engine to catch a late-loaded plugin.

### #2 — Feedback buttons (👍 / 👎)
- `feedbackLearning` was already on but nothing recorded a signal, so it was dead-wired. Her text replies
  now carry 👍/👎 (visible on hover) that call `engine.recordFeedback(engine.styleOf(text), ±1)` — the
  EWMA learning signal that tunes her length/tone over time.

### #4 — Persistent storage
- `requestPersistentStorage()` calls `navigator.storage.persist()` once at boot (guarded) so her memory —
  which lives entirely in localStorage — is less likely to be evicted under storage pressure.

### #6 — Her inner state, surfaced
- The Memory & data tab gained a "What's on her mind" card showing the structures her thinking builds, not
  just raw facts: current **mood** (`moodDescriptor`), how she sees herself (`getPersonaNote`), what she's
  **concluded** about you (`getMemory().insights`), what she means to **follow up on** (`goalsForOwner`),
  and what she's planning to **revisit** (`getSelfIntents`). Refreshes when settings open.

### Validation
- `python3 assemble.py` → `solo-app.html`; both `<script>` blocks pass `node --check`; DOM-wiring check clean.
- Regression: `harness-solo-{loop,brain,image,context,churn}.js` all green.
- New: `harness-solo-extras.js` — 11 checks across the streaming gate/plumbing, the feedback write, and
  every inner-state surface. All green.

### Not built this batch (recommended next)
- #3 wire `countTokens`/`idealMaxContextTokens` (getMetaObject) for exact context budgeting.
- #5 import character `initialMessages` (opening greeting) + `userCharacter` (auto-fill "You").
- #8 real semantic recall (embedFn via `window.embedTexts`) + #9 localStorage→IndexedDB/Dexie — the larger pair.
- #10 share-a-Chloe links; #11 lorebooks.
