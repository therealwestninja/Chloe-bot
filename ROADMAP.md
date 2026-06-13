# Chloe-on-Discord bridge — roadmap

Adapter A (Tampermonkey userscript ⇄ Perchance generator page over an origin-checked
postMessage link). Current shipped version: **v0.90.0**.

> **Reconstruction note (2026-06-11):** the live ROADMAP.md was zeroed by a write race during an
> I/O hiccup. This file = the operator's recovered v0.28-era copy (authoritative for v0.28 and the
> backlog/mine sections below) + entries v0.29–v0.48.0 rebuilt from session records. **Second
> reconstruction (2026-06-12):** zeroed again by a truncate-in-place crash in the entry script
> (see the v0.54.0 entry); recovered by replaying entry scripts verbatim from session transcripts,
> and the entry pipeline is now atomic (`roadmap_update.py`). Some backlog
> items below have since shipped (notably F1 facts → v0.44.0, G5 time → v0.45.0, G6 mood → v0.46.0,
> E1 highlights → v0.39.0, reaction significance → v0.40.0); they're left in place as history.

### Shipped in v0.90.0 (user-model register + operational self-state — the Discord bot is feature-complete)

The last buildable items on the roadmap. With this, every recommended-order item (#1–10, the §5b grounding
consumers) and the optional #5 are shipped — the Discord bot is feature-complete. (The only forward item
left is #11, "Chloe Solo," a separate standalone-Perchance product, not part of finishing this bot.)

**#5 — user-model register.** Facts and insights already model *what* a person is into; what they didn't
capture is *how the person writes*, which is what register-matching needs. A new `usermodel` provider infers
the addressed person's communication style — typical message length + tone — from their own recent messages
(reusing the `styleOf` machinery from feedback learning, so it's deterministic and adds no AI call), and
surfaces it as soft guidance: "Mo tends to write short, playful messages — match their register so you land
naturally." Needs a few messages before it'll guess (no register from one line), opt-in (`userModeling`,
default off), per the roadmap's "a few inferred tags, not a questionnaire."

**#5b — operational self-state.** Folded into the existing self-knowledge grounding: when that's on, she now
also knows her own version, roughly how long she's been running, and her current engagement mode — so "how
long have you been up?" / "what version are you?" / "what mode are you in?" get truthful answers instead of
guesses. Auto-built from runtime state like the device clock; grounding, never instructions; shared only if
asked. (The sibling #5b idea, browser-safe locale, was deliberately *not* built — `navigator.language`
reflects the operator's browser, not the remote Discord users', so it's meaningless for a Discord bot and was
reassigned to #11 Chloe Solo, where the chatter is the browser.)

**Cleanup.** Removed the long-standing `deviceTime` `patchEngines` no-op (deviceTime was never in
LIVE_PATCHABLE; its real effect is the 'devicetime' injection + a fresh config read). The wider-net symmetry
scan is now **fully clean** for the first time — patchEngines ⊆ LIVE_PATCHABLE with no exceptions, every
panel call has a handler, every status field the panel reads exists, every engine-API name is defined.

**Docs.** `full-list-of-commands.md` now lists `!chloe good` / `!chloe bad`.

Validation: new harness-usermodel (length/tone inference, the gated provider, silence when sparse or off);
98/98 + golden + audit clean; defined-once on the assembled build across all the session's additions
(userRegister, boundedEvict, cosine, fsrsRetrievability, styleOf, recordFeedback, resolveRefs,
assembleContext, detectContradiction, selfKnowledgeText, listReminders — all single).

---

**Feature-complete summary (v0.85 → v0.90).** Contradiction flag-and-clarify (#4) · conversation memory:
her own turns + resolved @mentions in the transcript · AICC Dexie `.json.gz` import + inline character
authoring · Activity/Debug log separation · feedback/preference learning (#7) · semantic recall + FSRS-lite
(#10) · transport full-jitter retry (#9) · unified bounded-store eviction (#8) · user-model register (#5) +
operational self-state (§5b). The forward roadmap's only remaining entry is #11 (Chloe Solo).

### Shipped in v0.89.2 (unify eviction — bounded store with pinned-protection)

Roadmap item #8. Partition fact caps, the two episode rings, and the operator-fact protection each
reimplemented "bounded store + eviction" by hand (`slice(-cap)` plus, for operator facts, a bespoke
carve-out that only existed in the consolidation path). Unified under one helper — and in doing so, fixed
a real inconsistency.

**Mined.** The bounded-store-with-pinned-protection pattern (lru-cache's "no-eviction" entries, weld.gallery's
bounded store) reduces to one primitive: keep all PINNED items + the newest unpinned ones up to `cap`,
evict oldest-unpinned first, preserve order, and let pins survive even if they alone exceed the cap.

`boundedEvict(items, cap, isPinned)` is that primitive. Migrated three sites: the per-user fact cap (pin =
`source === 'operator'`), and both episode rings (no pins — behaviorally identical to the old `slice(-cap)`).

**The fix it surfaced.** The fact cap was a plain `slice(-cap)` with NO operator protection — operator
facts were only shielded during *consolidation*, so a burst of new observed facts could silently evict an
operator-pinned fact ("this channel is in beta") at the cap. With the pin predicate, operator facts now
survive the cap, matching consolidation's intent. Pure debt-paydown turned into a correctness fix.

The next "protect this from eviction" need is now one predicate, not new bespoke code — e.g. pinning
high-stability (frequently-recalled) episodes from the v0.89.0 FSRS work becomes a one-liner if wanted.

Validation: new harness-eviction proves the helper's invariants (under-cap unchanged; no-pin == slice(-cap);
pins survive; pins-over-cap all kept; order preserved) AND the behavioral fix (an old operator fact survives
a flood of observed facts; without pins, byte-identical to the old behavior). 97/97 + golden + audit clean.

### Shipped in v0.89.1 (transport resilience: full-jitter retry)

Roadmap item #9. The AICC character fetch was a bare `fetch(url)` — one shot, so a transient 429 or a
momentary network blip failed the import outright with "Could not fetch that link". Hardened with a
reusable retry helper.

**Mined, not invented.** The canonical design is AWS's "Exponential Backoff and Jitter" — specifically
FULL JITTER: wait a random time in `[0, min(cap, base·2^attempt))`. AWS's own analysis found full jitter
minimizes both retries and completion time versus plain backoff (which synchronizes clients into
thundering retries), and it's what p-retry, cockatiel, and exponential-backoff all implement. Confirmed
the current packages on npm; reimplemented the (tiny) algorithm rather than pulling a dependency, since
the userscript ships as one file.

**`fetchRetry(url, opts)`** retries the transient classes — 429, 408, 5xx, and network rejects — up to a
bound (default 3), with full-jitter backoff (base 500ms, cap 8s). A `Retry-After` header is honored as a
floor (so a server that says "wait 2s" is obeyed, then jitter can only push it later, never sooner).
Non-retryable statuses (404 removed/quarantined, other 4xx) fail fast — the final non-ok response is handed
straight back to the caller, which already renders a helpful message. The character fetch now reports
progress between attempts ("Fetch hit HTTP 429 — retry 1/3 in ~1s…"). `fetchImpl` and `sleep` are
injectable, so the helper is fully testable and reusable for any future fetch (the "next fetch is trivial"
payoff).

Scoped precisely: a tree-wide scan found exactly one bare `fetch` (this one). The Discord transport already
honors 429 + `Retry-After` via its GM_xmlhttpRequest path, so it was intentionally left alone — adding
jitter where the server hands you an exact wait would only make it slower.

Validation: new harness-fetch-retry lifts the helper out of the panel and drives it with a scripted fake
fetch + recording sleep — retry-then-succeed (429/5xx/network), fail-fast on 404, exhaustion returns the
final non-ok, network exhaustion throws, Retry-After floored at ≥2000ms, and the full-jitter bound
(0 ≤ wait < min(cap, base·2^n)) held across 300 trials. 96/96 + golden + audit clean; extracted-page
`node --check`; no bare `fetch(` left in the tree.

---

**Roadmap status.** With #9 done, the only remaining forward-roadmap items are #8 (unify eviction — a pure
internal refactor, explicitly "do when touching that machinery anyway") and #5 (explicit user-model schema
— flagged "only if insights prove insufficient in practice"). Neither is a clear-value standalone build;
the recommended-order roadmap is complete.

### Shipped in v0.89.0 (semantic recall + FSRS-lite)

Roadmap item #10 — the highest-value/highest-effort memory upgrade, and the one item that lifts the
"no embeddings" constraint the research kept working around. Recall episodes by MEANING instead of
keyword overlap, and let memories she REVISITS stay sharp via a spaced-repetition forgetting curve.

**Mined, not invented.** The AICC export we imported earlier named its embedding model
(`Xenova/bge-base-en-v1.5`) — i.e. AI Character Chat already runs **transformers.js** with bge embeddings
in the browser on this same Perchance platform, and our own exact-tokenizer already loads transformers.js
the same way. So the embedder reuses that proven path: a small bge model (`Xenova/bge-small-en-v1.5`,
~33MB, 384-dim) loaded lazily via the page-realm `import()`, no new plumbing, no postMessage channel —
`embedFn` is a direct bootstrap hook exactly like `countTokens`. The scheduler reuses the published **FSRS**
forgetting curve (open-spaced-repetition): R(t) = (1 + 0.2346·t/S)^(−0.5), with the constants chosen so
retrievability hits 0.9 at t = stability. Two real, current tools (transformers.js 4.x, ts-fsrs 5.x) read
for the algorithm; reimplemented, not copied.

**What it does.** When `semanticRecall` is on, the episodes provider embeds the current query and ranks
stored episodes by cosine similarity to it (with a similarity floor) rather than token overlap — so "is the
server back up?" recalls "we got the minecraft server running" even with no shared keywords. Episodes are
embedded once at creation and the vector is cached on the record. The recency term becomes an FSRS
retrievability curve over each episode's own stability, and **recalling an episode strengthens it** (stability
× growth, clock reset) — the spacing effect, so memories she keeps returning to decay slowly while the rest
fade. The one-hop event-graph expansion is unchanged.

**Degrades at every layer.** No embedder loaded / load failed / model still downloading → the query embed
resolves null → keyword overlap (today's behavior). `semanticRecall` off → the original keyword × importance
× 7-day-half-life scoring, byte-for-byte, with no FSRS fields written. The model is the one heavy download,
so it's opt-in (default off) and preloads only when the toggle is switched on.

Fully wired: config + LIVE_PATCHABLE, `embedFn`/`semanticRecall`/`embedModel` into buildEngine, the lazy
`embedLoader` (mirroring `tokLoader`, same pinned transformers build), status (`embedder` state +
`semanticRecall`), `config.setSemanticRecall` (preloads on enable), and a panel checkbox that notes the
one-time model load. Episode vectors live in the existing `epi:` ring (already reset/exported).

Validation: new harness-semantic injects a deterministic bag-of-words embedder to exercise the real engine
paths — cosine correctness, the FSRS curve (R(S)=0.9 exactly, monotonic decay, higher stability = better
retention), strengthen-on-recall (4 → ~7.6, clock reset, capped), meaning-based ranking with the unrelated
filtered out, keyword fallback when the embedder is absent, and untouched behavior when the feature is off.
95/95 + golden + audit clean; wider-net symmetry scan clean; defined-once on the assembled build (cosine,
fsrsRetrievability, fsrsStrengthen, embedTexts all single).

**With this, the recommended-order roadmap is complete** (#1–4, #6, #7, #10, §5b all shipped). What remains
is genuinely optional: #5 (explicit user-model schema — only if insights prove insufficient), and #8/#9
(eviction-unify and transport jitter — opportunistic refactors to fold in when that machinery is next touched).

### Shipped in v0.88.0 (feedback / preference learning)

Roadmap item #7 — the research's "genuinely missing pillar": she OBSERVED (facts, mood, reactions) but
never ADAPTED from whether her own replies landed. Now she does, as a gentle nudge.

**The design (mined, then fit to her envelope).** The textbook shape for "learn which option works from
sparse feedback without training" is a multi-armed bandit. Used here in its lightest form: two style
"arms" — reply LENGTH (short / medium / long) and TONE (playful / measured) — each holding an EWMA reward
(recent feedback weighted heavier, since rooms drift) plus a sample count. No exploration schedule, no
model: she just leans toward the arm that's winning, exactly the "bandit-lite nudge, not training" the
research prescribed.

**Three free poll-side signals, all already available:**
- **Reaction-as-reward** — a reaction on HER message is scored right in `processMessageReactions` (which
  already had her message and content in hand): positives reuse the trust emoji set, negatives a small
  set (👎), counted once per emoji/message. The reply's style is read from its own text.
- **Continuation** — if the person she replied to keeps talking within a 10-minute window, that reply's
  style gets a soft positive. Silence is never penalized (someone going offline isn't negative feedback).
- **Explicit `!chloe good` / `!chloe bad`** (mod) — a strong ±1 on her last reply's style.

**Surfaced as a nudge, not a rule.** A new `feedback` context provider reads the per-channel arms and,
ONLY when one clearly leads (≥ minSamples and beating the runner-up by a margin), adds one soft line:
"In this channel lately, your shorter and more playful replies have landed best — lean that way when it
feels natural, not every time." AI-discretionary, goes quiet when the signal is weak or split. Per-channel
(in a DM, the isolated DM bucket).

Opt-in (`feedbackLearning`, default off — it's a behavior change), fully wired: LIVE_PATCHABLE, command,
status, buildEngine, a panel checkbox, `!chloe good/bad` verbs, and the `feedback:` key in reset + export.

**Scope honesty.** Length + tone are the two arms the research named; more dimensions (formality,
question-asking) are easy to add later under the same machinery if the two prove too coarse. This is a
deliberate v1 of a large surface, kept conservative.

Validation: new harness-feedback covers style classification, the EWMA update (right arms, sample counts),
continuation crediting (in-window only, unrelated speakers don't credit, silence never penalized), and the
nudge provider (fires with samples+margin, silent when too few / no clear winner / feature off). 94/94 +
golden + audit clean; wider-net symmetry scan clean; defined-once on the assembled build (styleOf,
recordFeedback, creditContinuation, fbBestBucket all single).

### Shipped in v0.87.0 (AICC Dexie import fix + inline character authoring)

Two things, prompted by an AICC `.json.gz` export the importer rejected.

**Bug — AICC's native export wasn't recognized.** An AI Character Chat "export characters" file is a
*Dexie database dump*: `{ formatName: "dexie", data: { tables, data: [ { tableName, rows } ] } }`, with the
character living at `data.data[].rows`. The importer's `charExtractStores` knew four shapes — `{stores}`,
`{addCharacter}`, `{characters:[…]}`, and a bare character object — but none matched the Dexie wrapper, so
every native AICC export fell through to "No characters found." Fixed by adding a Dexie branch (matched on
`formatName === 'dexie'` or a `data.data[]` table array) that pulls the `characters` / `threads` /
`messages` tables straight out. Verified against the actual uploaded file (RudBo): one character, ~1.8k of
persona, avatar extracted.

**Parity — fold in AICC's other persona fields.** `charNormalize` now also folds `generalWritingInstructions`
and `reminderMessage` into the persona when they're literal text, skipping `@preset` references (e.g.
`@roleplay1`) which are AICC-internal aliases that mean nothing outside it. So an imported character carries
more of its original behavior, not just `roleInstruction`.

**Feature — write a character without any file.** The Character tab gets an "Or write your own" card: a name
field and a multi-line personality box with a "Become this character" button that sets the persona directly
(via the same `config.setCharacter` path the importer uses). Users no longer *need* an export file or JSON to
give Chloe a personality — they can author one inline. The existing single-line input (links / file-IDs / raw
JSON) stays for quick paste-in.

**Toward the broader goal (AICC parity across Discord).** This covers import of the native format and inline
authoring. Still on the table for a fuller parity pass, noted not built: `initialMessages` (greetings) as
seedable openers, `imagePromptPrefix/Suffix/Triggers` wired into her image generation, `shortcutButtons`,
`loreBookUrls` (lorebooks), and `customCode`. Those are each their own feature; flagged for follow-up rather
than bundled here.

Validation: new harness-char-import lifts the two pure functions out of the panel and tests the Dexie format,
the literal-vs-@preset fold rule, every legacy shape (no regression), and junk-in/nothing-out; 93/93 + golden
+ audit clean; extracted-page `node --check`. The importer fix was proven against the real uploaded `.json.gz`.

### Shipped in v0.86.1 (bugfix: Activity vs Debug were mirrors)

Reported: the Activity feed was a mirror of the Debug log, and Debug wasn't showing the bot's text/image
generation, thoughts, dreams, or other console-only items.

Root cause (deeper than styling): the bootstrap relays the engine's entire `[chloe.*]` log stream to the
panel as `{kind:'event', name:'log'}`, but the panel's message handler only handled `name === 'poll'` and
**silently dropped every `'log'` event**. So the Debug box never received `[chloe.think]` (thoughts),
`[chloe.sleep]` (dreams), `[chloe.img]` (image generation), `[chloe.ctx]`, etc. — it only showed the few
panel-side `log()` calls (poll summaries, "replied", toggle changes), and those *also* fed the Activity
feed. Identical inputs to both surfaces = mirror, and Debug missing all the rich internal detail.

Fix, four parts:
- **Handle the dropped events.** The panel now routes `name === 'log'` events through `log()`, so the
  engine's full stream reaches Debug.
- **Pipe the console-only page traces in.** The page-side brain handlers (respond/paint/judge/…) logged
  generation detail via `dlog` to the browser console only; `dlog` now also appends to the Debug box
  (prefixed `[chloe-page]`), so text/image generation traces are visible there.
- **De-mirror Activity.** A new `isDebugOnly` keeps the mechanical/internal lines — context packing
  (`[chloe.ctx]`), tokenizer (`[chloe.tok]`), run-locks (`[chloe.lock]`), poll mechanics, loop backoff,
  archive, command dispatch, persona/clock grounding, idle "dream" passes (`[chloe.sleep]`), and the
  verbose `[chloe-page]` traces — in **Debug only**. Activity now shows her actual work (replies, images,
  moderation, memory milestones, thinking) and is a strict subset of Debug, not a copy.
- **Cap the Debug box.** It appended to `textContent` with no bound (an unbounded-growth legacy bug, made
  worse by the new page-trace volume); it now keeps the last 600 lines, and Clear resets the buffer.

The whole change is panel-side (one document/scope — the brain handlers and panel UI share it, so `dlog`
can reach `debugAppend` directly, no new postMessage channel). `isDebugOnly`'s tag list was written in the
same top-level-alternation style as the existing `feedType` to avoid the `[..|..]` DSL-list landmine — the
first draft used a `(a|b)` group between `[` and `]`, which the audit's bracket-pick check correctly caught;
rewritten and clean.

Validation: extracted-page `node --check`, audit clean (after the landmine fix), 92/92 + golden still green
(engine untouched), and a focused extraction test confirms the Activity/Debug split on real log lines —
img/think/summon/reflect/replied → Activity; page traces, ctx, tok, lock, poll, sleep, archive → Debug only.

### Shipped in v0.86.0 (conversation memory — she reads the whole conversation, legibly)

Two newly-identified gaps, neither in the roadmap or research notes — found by tracing what actually
reaches the brain at reply time. Both live in the transcript she reads, and together they meant she was
working from a one-sided, partially-blanked view of the room.

**Gap 1 — she couldn't see her own turns.** The transcript (`channelRecent`) was built entirely from the
roster's per-user `recent` lines, and her own messages are dropped at ingest (by author id). So the
dialogue handed to the brain had every one of *her* turns missing — she saw what people said *to* her but
not what she'd said back. The only echo of her own words was the in-memory `recentReplies` anti-repeat
list, framed as "don't repeat these," not as conversation. Fix: capture her own messages at ingest (the
ones Discord echoes back, with their real snowflake timestamps) into a per-channel `ownlines:` ring, and
fold them into the transcript interleaved by timestamp — so she now reads the actual back-and-forth
(kai → chloe → mo, in order). Each own message is fetched exactly once (the cursor advances past it), so
the ring can't double-count.

**Gap 2 — mentions and channel refs were blanked out.** `scrubDiscordTokens` *deleted* every `<@id>`,
`<@&id>`, and `<#id>`, so "hey @alice, check #support" reached her as "hey , check" — she lost who was
being addressed and which channel was meant. Fix: a new `resolveRefs` turns those into readable cues in
the transcript she reads — `<@id>` → `@name` (from the roster, her own name for herself, `@someone` for
strangers), `<@&id>` → `@role`, `<#id>` → `#channel`, custom emoji → `:name:`. Her *output* scrubbing is
unchanged (the output gates still strip), and the addressed message itself stays scrubbed for now (see
below), so this is purely about comprehension of history.

One config, `conversationMemory` (DEFAULT ON — this is a correctness fix, not a new behavior; off restores
the legacy one-sided/stripped view). Fully wired: LIVE_PATCHABLE (live toggle), `config.setConversationMemory`,
status, buildEngine, a panel checkbox via the generic toggle table, and `ownlines:` added to both the reset
and export key lists. In a DM the ring lives in the isolated DM bucket, so her own DM turns never cross into
a public channel.

`assembleContext` was split into `assembleContext` (builds the line set: roster lines + folded own lines,
ref-resolved, ts-sorted, capped) → `assembleContextRest` (the unchanged remainder: dm-merge, reserve, base,
injections, packing). Watched for the `listReminders`-class trap that bit an earlier build — the
defined-once grep on the assembled file confirms `resolveRefs`, `assembleContext`, and `assembleContextRest`
each appear once.

**Deferred (noted, not built):** resolving refs in the *addressed* message too would also help, but it would
change the golden fixture and several harness expectations, so it's left for a deliberate pass. Other
memory work still open in the forward roadmap is unaffected: #5 user-modeling schema, #7 feedback/preference
learning (does she adapt from whether replies landed), #10 semantic recall + spaced-repetition.

**Wider-net pass (no new bugs).** Re-ran all symmetry scans on the assembled build: patchEngines ⊆
LIVE_PATCHABLE (only the known-harmless `deviceTime` no-op), every panel `call()` resolves to a handler,
every `s.<field>` the panel reads is in the status snapshot, brain kinds ↔ page handlers paired, every
engine-API name defined. All clean.

Validation: 92/92 (new harness-conversation-memory) + golden + audit clean; `node --check` on engine,
bootstrap, the assembled userscript, and the extracted page script. The harness covers ref resolution in
the transcript, own-line folding by timestamp, own-message capture at ingest with snowflake timestamps,
and the off-switch restoring the legacy view.

### Shipped in v0.85.0 (contradiction flag-and-clarify)

Roadmap item #4. Until now, when a new fact conflicted with a held one, consolidation would eventually
drop the older side silently. The roadmap wanted the opposite for salient cases: notice the conflict,
keep both, and let her gently clarify rather than quietly overwrite. Mined from the existing fact
pipeline — ingestion (`addFacts`), the per-person context providers, the idle consolidation sweep, and
`aboutme` — and adapted rather than bolted on.

**Detection (conservative by design).** A new local `detectContradiction` fires only on a clear POLARITY
FLIP over a shared topic — one side carries a negation/antonym marker (not, never, no longer, dislikes,
hates, stopped, isn't…) and the other doesn't, while their content words overlap ("likes minecraft" vs
"dislikes minecraft"; "is a teacher" vs "is not a teacher"; "plays guitar" vs "stopped playing guitar").
High precision, low recall on purpose: a false flag that nags is worse than a quiet miss, so unrelated
topics and unmarked antonyms (introvert/extrovert) are deliberately not chased.

**Flag.** At fact ingestion, if `contradictionAware` is on and the new fact clears an importance floor,
a detected clash records `{ a: held, b: new, at }` on the person's partition and KEEPS BOTH facts — the
older side is no longer silently lost. Zero added risk; it's an internal note.

**Clarify (AI-discretionary, not a forced ping).** A new `contradiction` context provider surfaces a
FRESH conflict (within a 2h window) for the person she's addressing as soft guidance — she *may* gently
check which is current, once, lightly — and goes quiet after the window so it can't nag every reply. It's
descriptive context the model can use or ignore, never a deterministic proactive message. `aboutme` also
shows a recorded conflict when the user themself asks. Conflicts clear on the idle sweep once stale (TTL)
or resolved (a side no longer present among the facts). In a DM the conflict lives in the isolated DM
bucket, so it never crosses surfaces.

Fully wired: config + LIVE_PATCHABLE (live toggle), `config.setContradictionAware`, status, a panel
checkbox via the generic toggle table; conflicts live on the partition (cleared with the user, no new key).

**Wider-net pass (no new bugs found).** Re-ran the symmetry scans now that several toggles/providers were
added: patchEngines keys ⊆ LIVE_PATCHABLE (only the known-harmless `deviceTime` no-op remains), every
panel `call()` resolves to a handler, every `s.<field>` the panel reads is in the status snapshot, brain
kinds ↔ page handlers are paired, and every engine-API name is defined (the `listReminders`-class trap
that bit the previous build stays caught). All clean.

Validation: 91/91 (new harness-contradiction) + golden + audit clean; `node --check` on engine, bootstrap,
the assembled userscript, and the extracted page script; `detectContradiction`/`contraParse` defined once
in the assembled output. The harness covers the detector's true/false cases, keep-both-on-flip, the
importance floor and off-switch, fresh-vs-stale surfacing, and the resolved-conflict sweep cleanup.

### Shipped in v0.84.0 (deferred self-intents — self-scheduled future cognition)

Roadmap item #6 (the gdx-ai delayed-telegram pattern), built by mining what already existed and adapting
it rather than starting fresh. Reminders already provide a persistent dueAt-queue that fires each poll;
deliberation already provides gated, never-sending internal cognition that seeds itself. The new piece
threads them together so Chloe can schedule a **future internal action for herself** — not a message.

**The mechanism.** A new per-channel queue (`selfintents:<channel>`, opt-in via `deferredIntents`, off by
default, needs idle deliberation) holds entries `{ id, kind, dueAt, subject }`, bounded by `selfIntentMax`
and de-duped by kind+subject. Today's single kind is **revisit**: when a *spontaneous* deliberation
concludes with something worth keeping, she schedules a revisit of that subject ~6h out
(`selfIntentRevisitMs`). When that revisit comes due it becomes an alternative trigger for the next idle
deliberation — so she'll follow through and re-think the topic even if her curiosity has since settled
below the usual floor — and it supplies the seed for that pass. A revisit-triggered deliberation does
**not** schedule another revisit, so there's no loop: each topic she finds interesting gets exactly one
deliberate second look.

**Why it's low-risk.** A fired self-intent runs no AI of its own and never sends — it only lowers the bar
for, and seeds, the *next* deliberation, which still goes through every existing gate (idle, min-gap, the
one-AI-pass-per-quiet-moment budget) and the self-limiting curiosity drop. The durable part is the queue
in storage (so it survives rebuilds); the activation is the normal deliberation path. In a DM the queue
lives in the isolated DM bucket, so a DM-scheduled revisit never crosses into public or another DM.

The mechanism is built as a general queue with kind-dispatch, so future kinds (revisit a goal, follow up
a quiet newcomer) are a new branch, not a new subsystem.

Fully wired: config + LIVE_PATCHABLE (the toggle takes effect live), the `config.setDeferredIntents`
command, a status field, a panel checkbox ("follow her own train of thought (revisit topics later)") via
the generic toggle table, and the queue key added to both the reset and export lists.

_Build note:_ inserting the queue helpers accidentally dropped the `listReminders` definition — `node
--check` passed (it doesn't catch undefined references), but a defined-once grep on the assembled file
caught it before ship and it was restored; the reminders harness confirms it.

Validation: 90/90 (new harness-self-intents) + golden + audit clean; `node --check` on engine, bootstrap,
the assembled userscript, and the extracted page script; `snowflakeTime`/`getSelfIntents`/
`scheduleSelfIntent`/`dueSelfIntent`/`consumeSelfIntent`/`listReminders` each defined exactly once in the
assembled output. harness-self-intents covers schedule-on-conclusion, off==no-op, due-revisit triggering
below the curiosity floor, consume-once + no-reschedule, and dedupe + cap.

### Shipped in v0.83.0 (ambient time anchoring + free-form operator note)

**Her ambient sense of time is now anchored to Discord, not just the tab clock.** The `timeAware` provider already derived time-of-day from the tab's wall clock (so it never actually needed the device clock), but a sandboxed, misconfigured, or long-suspended tab can report a wildly wrong wall clock. `timeContext` now cross-checks against `lastSeenAt` (the newest message's snowflake time — authoritative Discord server truth): if the tab clock disagrees by more than a day, it anchors part-of-day and day-of-week to Discord's time instead. Only a gross (>1 day) disagreement flips the source, so a normal tab always keeps its own correct wall clock (right even when the channel is quiet). The quiet-duration still uses the tab clock for both ends, so the elapsed-time delta stays correct regardless of any absolute-clock offset. harness-time gained a wrong-tab-clock anchoring check (and a no-spurious-anchoring check); the golden fixture's message ids were made realistic snowflakes so ids and the wall clock agree as they do in production.

**Free-form operator note (roadmap §5b).** A new panel card — "Tell Chloe a fact about right now" — lets the operator inject a short, true situational fact she can't otherwise see ("#support is for bug reports", "the server is in beta this week", "community event Saturday 3pm"), with an optional expiry (1h / 6h / 1 day / 1 week / never). It rides the existing `seminject` slot that device-time already uses — id `opnote` via `config.setSemanticInjection` / `clearSemanticInjection`, no engine change — so it lands in the SITUATION (grounding) band: stated as truth when relevant, never as an instruction (it cannot loosen moderation or rules), and a timed note expires on its own. The note text is surfaced in the status snapshot so the textbox restores on panel refresh (and the refresh won't clobber it mid-type). The card's help text warns against putting anyone's location or private details there, keeping the same safe-subset discipline as device-time.

Validation: 89/89 + golden + audit clean (suite verified by process exit code); `node --check` on engine, bootstrap, the assembled userscript, and the extracted page script; operator-note wiring confirmed symmetric (one card owns the input, the populate-from-status, and both button handlers; status provides `operatorNote`).

### Shipped in v0.82.0 (message-timestamp time awareness + a lifecycle audit)

**Discord message ids are now used as a clock.** A Discord snowflake id encodes its own creation time (`(id >> 22) + the Discord epoch`), so every message carries an authoritative UTC server timestamp. A new `snowflakeTime(id)` helper reads it, and the engine tracks `lastSeenAt` — the time of the newest message it has seen — updated each poll from the cursor.

**`!chloe time` / `!chloe date` now work with the panel closed.** Previously, if the control panel wasn't open to push the device clock, these commands could only say "my reading is stale — reopen the panel." Now they fall back in order: the page-pushed device clock when it's fresh (best — it carries the user's *local* time and timezone name), otherwise the most recent message's snowflake timestamp, rendered as an approximate UTC reading (with a configured timezone offset applied if one is set) and clearly labeled "from recent message timestamps" so it's never mistaken for an exact local clock. Because the command itself arrives as a message, there is essentially always a timestamp to fall back on — the bot stays honest (labels the approximation) without going mute. This is the "verify local times/dates from messages, raw timestamps as a fallback" idea.

**Lifecycle audit — breakdowns/rebuilds, start/stop, the setter layer (no bugs found; documented why).** Went looking for the wiring-table class of bug (something that saves but silently never takes effect) across the restart/rebuild surface:
- The per-channel **cursor** (last-seen message id) is the bot's durable "New line" marker. It lives in GM storage, so a full rebuild (`applyConfigChange` stops every engine, drops the engine map, and restarts) leaves it untouched — the new engine resumes from the cursor and fetches only messages *after* it. So a rebuild does NOT re-scan or re-ingest old history. `resetState` wipes the cursor on purpose (an explicit clean slate); the bounded cold-start backlog is ingested for context only, never replayed.
- `start()` guards against double-start (`if (running) return`); `stop()` invalidates in-flight deferred work (`deferGen++`), clears the timer, and releases the run-lock so a clean successor can claim it immediately.
- Classified every `config.setX` by how it applies. Four (`setMemberCheck`, `setPersonality`, `setPersonaAnchor`, `setPoolSize`) neither patch live engines nor rebuild — but each is read **fresh** at its point of use (member-count and anchor sweeps via `cfgGet` in presence-maintenance; personality dials re-read per brain call; pool size via `poolTarget()` each tick), so they take effect on the next tick with no restart. Channel-topology setters correctly trigger a rebuild. No silent no-op found.

**Known latent edge case (left as a note, not fixed):** if the operator changes which channel is *primary*, that channel's store prefix changes, so its cursor moves to a different GM key and the new engine sees an empty cursor and re-scans once. Rare (only on a primary-channel swap) and self-correcting after one poll; a cursor-key migration would be the fix if it ever bites.

Validation: 89/89 + golden + audit clean; `node --check` on engine, bootstrap, the assembled userscript, and the extracted page script; `snowflakeTime` defined exactly once; harness-timecmd rewritten to drive realistic snowflake ids and assert the full fallback ladder (fresh clock preferred, message-timestamp fallback when closed, tz-offset applied, stale clock superseded by the message clock).

### Shipped in v0.81.0 (DM data isolation fix + generic toggle wiring table)

**Privacy fix — DM goals were leaking to public channels and other DMs.** When goals went cross-channel in v0.79.1 they were routed through `crossStore()` (= globalStore) for EVERY engine, including DM engines — so a goal a user set inside a DM surfaced in public channels and in other users' DMs. Split the storage: a new `goalStore()` is per-context (globalStore for public engines so goals still unify across public channels, but the LOCAL bucket inside a DM), exactly like `etherealStore`. Character memories (`crossStore`) stay global — they're the bot's own operator-authored persona background, not user data. Audited every shared-bucket write: after this, all DM USER data (partitions, facts, insights, images, goals, ethereal/forget state) is fully isolated to its DM bucket, and `dmPublicMerge` remains strictly read-only public→DM (never writes back). The only cross-surface writes left from a DM are the global blocklist (moderation; global bans were approved) and charmem (bot persona). New harness checks prove a DM goal is visible inside its own DM but NOT in a public channel or another user's DM, while public-channel goals still unify.

**Improvement — a generic toggle wiring table.** The panel had ~35 hand-wired feature toggles, each with a separate populate line (restore from status) and change handler (save to a command). That split is exactly what caused the v0.80.1 device-clock bug (one side wired, the other missing). Introduced a declarative `TOGGLES` table where one row — `[checkboxId, command, statusField]` — owns BOTH the populate and the save, so the two can never drift apart; that bug class is now structurally impossible. Migrated the 23 toggles that are provably plain (plain `!!s.field` populate + plain `call+log` handler) into the table via `applyToggleStates(s)` and `wireToggles()`, removing ~70 lines of boilerplate. Toggles with extra behavior — side-effects (working memory, exact-tokens, translate), default-on semantics (`goalObjects`/`idleConsolidation`/`adaptivePace`), or extra args (device time, time-of-day) — were deliberately left hand-wired rather than risk a big-bang migration of UI code that can't be runtime-tested here. New toggles are now a one-line table entry, and the remaining hand-wired ones can be folded in incrementally.

Validation: 89/89 + golden + audit clean; `node --check` on engine, bootstrap, the assembled userscript, and the extracted page script; assertion-guarded migration (exactly 23 populate lines and 23 handlers removed, each migrated checkbox now appearing once in the table) with the special/default-on toggles verified intact.

### Shipped in v0.80.1 (patch pass: dangling/incomplete wiring trees)
A systematic sweep for half-wired chains across the engine↔bootstrap↔panel boundary.

**Bug — the device-clock checkbox silently reset itself (and stopped the clock).** The panel restores the "know the current date & time" checkbox from `s.deviceTime`, but `statusSnapshot` never included `deviceTime`. So on every panel refresh/reopen the box read `undefined` → showed UNCHECKED even when enabled — and because the page-side clock push is gated on that checkbox, a refresh silently stopped device-time updates while the setting still said "on". Added `deviceTime` to the status snapshot; the box now restores and the push keeps running.

**Incomplete tree — image memory had no UI.** v0.79.0 shipped `imageMemory` / `imageEnhanceOffer` with config, commands, status, and LIVE_PATCHABLE, but no panel controls — so the feature could only be turned on by hand-calling the command. Added two checkboxes ("remember images & allow natural-language edits", "offer to refine after each image"), each with populate-from-status and a change handler wired to `config.setImageMemory` / `config.setImageEnhanceOffer`.

**Trees verified complete (no fix needed).** Cross-checks run this pass:
- Every `patchEngines({key})` key is in LIVE_PATCHABLE except `deviceTime`, which is a page-side UI-state flag the engine never reads — its `patchEngines` call is a harmless no-op (the real effect rides the `devicetime` semantic injection + `deviceClock`, both correctly patched). Left as-is.
- Every brain kind bootstrap requests (`respond`, `judge`, `paint`, `editimage`, …) has a page handler, and every page handler has a caller — no orphans either direction.
- Every panel `call(...)` method resolves to a bootstrap dispatch case — no dead controls.
- Every checkbox has both a populate and a save path (several use an IIFE-bound listener; the two character checkboxes are read at apply-time by design).
- The command-bar channel selector still reads the full `channels` list, so DM channels remain scopable for roster/mod-log/mode.

Validation: 89/89 + golden + audit clean, `node --check` on engine, bootstrap, the assembled userscript, and the extracted page script.

### Shipped in v0.80.0 (declared DM channels — two-box channel setup; fixes lost public→DM memory)
**The problem.** Discord's REST API (which is all we have without a Gateway) gives no per-message signal of whether a channel is a DM, and we can't discover a cold inbound DM at all. The only DMs the bot recognized were ones it OPENED itself (`dmSessions`). So a DM a user started — or any DM channel id an operator pasted into the channels box — was treated as a PUBLIC channel: built with `isDM:false`, which makes `dmPublicMerge` short-circuit, so the person's public memory was never carried into the DM. That's the "she forgets me in DMs" symptom.

**The fix — declare DMs explicitly.** The channel setup is now two boxes: **Public channels** and **Private DMs**. Any id in the DM box is polled like a normal channel AND flagged `isDM`, which is exactly what lets the public→DM memory merge run. `isDMChannel(id)` is now `declaredDmChannels().indexOf(id) >= 0 || dmSessions()[id]` (operator-declared OR bot-opened). The two boxes are kept mutually exclusive — saving a DM id removes it from the public extras, and a declared DM can never become the primary public channel.

**Wiring.** New `dmChannels` cfg key; `config.setDmChannels` (validates numeric ids, excludes the primary, dedups, and strips them from the public list); `channelList()` always polls declared DMs; status now exposes `publicChannels` (for the public box) and `dmChannels` (for the DM box) as clean separate lists, leaving `channels: channelList()` for the command-bar selector; `dmChannels` added to factory-reset and export. Panel: the single Channels textarea is split into "Public channels" and "Private DMs", with the save button persisting DMs first (so the public save's mutual-exclusion sees them) then public.

**Harness.** New `harness-dm-recognition.js` pins the invariant the config feeds: an unrecognized DM (`isDM:false`) carries NO public memory (the bug), a recognized DM (`isDM:true`) carries the public profile in. 89/89 + golden + audit clean.

**Still per-bucket (next step).** The merge pulls from the PRIMARY public bucket (globalStore). A person known only in a *secondary* public channel still won't have that context flow into a DM — unifying facts across several public channels is the remaining recall improvement.

### Shipped in v0.79.1 (bug-fix / unwired-code pass)
A sweep for dead config, unreferenced functions, and latent bugs after the image feature landed.

**Legacy bug — goals & character memories were siloed per channel despite being designed cross-channel.** `GOALS_KEY`/`CHARMEM_KEY` carry no channelId and are documented (DESIGN-goals.md, and their own comments) as "hers everywhere", but every access went through the per-channel `store`, so on a multi-channel bot a goal set in #general was invisible in #dev, and the character's respooled memories were re-seeded per channel. Routed all six access sites through a new `crossStore()` (= `cfg.globalStore || store`), exactly like `blockStore`. For a single-channel bot `globalStore === store`, so behavior is identical; for multi-channel it now genuinely unifies goals and character memory. (Heads-up: any goals a multi-channel bot had stored under a secondary channel's bucket become orphaned — they were a side effect of the bug.) New `harness-goals.js` checks prove a goal added in one channel is visible from another, both directions.

**Bug — `memberCheck` was never backed up.** The member-departure-sweep toggle (`config.setMemberCheck`) was missing from the export key list, so enabling it and exporting your config silently dropped the setting. Added to both the export and factory-reset lists. Also added `noticeMsgId`/`noticePinned` to the factory-reset list so a state wipe clears stale notice bookkeeping (they point at a Discord message that no longer exists after a reset).

**Unwired code removed.**
- `imageEditVerbs` config (added in v0.79.0) was dead — `parseImageEdit` uses regex back-reference/bare-modifier detection, never the verb list. Removed.
- `debounceCeilMs` config was orphaned: `currentDebounce()` deliberately uses `debounceMs` as the ceiling (and documents that), so a separate ceiling key silently did nothing. Removed; an operator setting it would have been misled.
- `workTopicEveryPolls` config gated an AI topic-naming cadence that was never implemented — `workRefreshTopic` only reuses the channel-summary clause (no AI call). Removed the key and corrected the function's comment to match the actual behavior.
- `ensureEngine()` (singular) in bootstrap was a never-called wrapper around `engineFor('')`. Removed.
- Dead `special:` metadata on the forget/remember command entries — the dispatch routes by verb name (`c.cmd === 'forget'`), never reads `.special`. Removed.

Validation: full sweep with a config-defaults-never-read scan (only the intentional `backfill` passthrough remains), a dead-function scan (none), a cfgSet-vs-export/reset cross-check (only the intentional `token` exclusion + transient notice ids remain), defined-once on the new `crossStore`, 88/88 + golden + audit clean, `node --check` on the assembled userscript.

### Shipped in v0.79.0 (image awareness + natural-language iteration)
The bot now knows what it generated and you can refine it in plain language. Opt-in via `imageMemory`.

**What it does.** When `imageMemory` is on, every delivered image is recorded on the user's partition (prompt, resolution, when), capped to a small ring (`imageMemoryRing`, default 6), with a `lastImage` pointer. Two payoffs:
- **Awareness** — a new `imagesMade` context provider surfaces her recent generations for the addressed person, so she can reference "that fox I drew you" instead of acting oblivious. Image history rides read-only through the public→DM merge (she can mention a public drawing in a DM), but editing always targets the local bucket's `lastImage`, so a DM edit never regenerates a public image.
- **Natural-language iteration** — within a window after an image (`imageEditWindowMs`, default 10m), a follow-up like "make it wider", "another one", "same but at night", or "without the hat" is recognized as an EDIT of the last image. The prompt is rebuilt and regenerated.

**Edit vs. new-request discrimination.** `parseImageEdit` only fires on a back-reference ("it", "that", "the one", "same", "another", "redo") or a bare modifier ("more detailed", "bigger", "in landscape", "without X") — so "make a dragon" stays a brand-new generation while "make it bigger" is an edit. The check runs BEFORE the new-image path (otherwise "make it bigger" would be parsed as a new image of "it bigger").

**Prompt rewrite.** Prefers a new optional AI hook, `editPrompt` → page-side `editimage` handler, which folds the change into the previous prompt via one `ai-text` call. Falls back to a deterministic rewrite (resolution/orientation, detail boost, additions, positive-only removals) when the hook declines or is absent. Honest about the backend: there's no img2img or seed lock here (per platform.md §4.3-4.4a), so an edit is a fresh composition, not a pixel-level tweak — and the rewrite builds POSITIVELY (the SD backend drops `negativePrompt`) using `(term:1.3)` parens, never `[...]` (eaten by the DSL).

**Ethereal-safe.** A forgotten user records nothing (no partition → `recordImage` no-ops), and `forget me` already erases `images`. **Optional enhance offer** (`imageEnhanceOffer`): after delivering, a one-time "want me to refine that?" nudge, skipped when the prompt was already high-detail.

**Wiring.** New keys are LIVE_PATCHABLE with `config.setImageMemory` / `config.setImageEnhanceOffer` toggles, surfaced in status, and included in reset/export. New harness `harness-image-iterate.js` (15 checks): record + ring, edit-vs-new discrimination, the AI hook, window expiry, ethereal no-record, and awareness-in-context. 88/88 + golden + audit clean.

Mined for this: the AI-Slideshow prompt-construction work and the image-test-rig A1111-compatibility findings (which proved the `[...]`/`negativePrompt`/seed limitations the rewrite is built around).

### Shipped in v0.78.1 (audit follow-up: three correctness/privacy bugs in the v0.78.0 ethereal/DM work)
A deeper race/clobber/erasure audit of the new surfaces turned up three real bugs (no new races — the run-lock + single-threaded, synchronous GM storage make the shared-key RMWs microtask-atomic within a tab and lock-gated across tabs; the index already uses union/targeted writes).

**1. Incomplete erasure for a moderated user.** `forget me` from a user in a non-active moderation state (soft-ban/timeout) cleared `recent`/`interactionCount`/`trust` but left `facts`, `insights`, and `images` intact — a GDPR hole, since those can hold the most sensitive data. Now the moderated branch clears facts/insights/images too (still keeping the partition + moderation row so a ban can't be shed via forget-me).

**2. DM-ethereal merge leak.** A user who went ethereal IN A DM still had their PUBLIC profile (facts/insights/familiarity) folded into their DM reply context by `dmPublicMerge` — because an ethereal user has no local partition, the merge synthesized one from the public bucket. "Forget me" in a surface should make the bot stop USING remembered context there, not just stop storing it. `dmPublicMerge` now short-circuits to no-merge when the user is ethereal in the current bucket.

**3. Forget-floor only enforced on backfill.** The floor (which blocks re-learning erased history after `remember me`) was checked in `ingestHistorical` but NOT in `ingestOne`. A cold-start startup batch replays recent history through `ingestOne`, so a user's pre-forget lines still in the recent window could be re-ingested after they came back. The floor check now lives in `ingestOne` too (one extra cheap GM read per message), so it holds on every ingest path — live, startup-batch, and backfill. Live post-`remember me` messages are always newer than the floor, so it never blocks them.

Harness `harness-dm-ethereal.js` extended to 23 checks (added: moderated-erase completeness via the merge gate, a DM-ethereal user gets no merged public facts, and a pre-floor message is rejected on the live/startup path). 87/87 + golden + audit clean.

### Shipped in v0.78.0 (GDPR ethereal mode + one-way public→DM memory + worker-failover clobber defenses)
Three interlocking pieces from the operator's privacy spec, plus a class of failover write-races found while auditing for them.

**1. Ethereal mode — `!chloe forget me` / `!chloe remember me` (anyone, not just mods).** A user can become invisible to memory in the bucket they ask in. `forget me` now does three things instead of just clearing data: it erases the partition (and any image history), sets an `ethereal` flag so NO new memory forms (no partition, no facts, no roster/summary/episode contribution, no image tracking), and stamps a per-user forget-floor. While ethereal the bot can still reply in the moment — it just keeps no notes. `remember me` lifts the flag; the forget-floor deliberately PERSISTS so a later re-learn (backfill / cold start) can never reach back across it and resurrect erased history. A single ingest chokepoint (`ingestOne`, beside the blocklist gate) makes this cascade for free: no partition → absent from roster → absent from transcript/summary/episodes/context/greeting/facts, and `bumpInteraction` already no-ops without a partition, so the image surface is covered too. The flag lives in the per-context bucket (`etherealStore()`: globalStore for any public channel, the local store for a DM), so a user can be ethereal in public while still on the record in a DM, or vice versa — exactly the per-context independence the operator asked for.

**2. One-way public → DM memory.** A DM engine now folds the speaker's PUBLIC profile (facts, insights, familiarity) into its reply context READ-ONLY (`dmPublicMerge`, from globalStore), and the DM novelty check recognizes a public regular so they aren't greeted as a stranger in DMs. Everything the DM learns is written ONLY to the DM bucket. The direction is enforced by construction: the public engine has no handle to any DM bucket, so private DM content can never surface in a public channel. Scoped to primary-public ↔ DM (facts unify across *several* public channels remains a noted follow-up).

**3. `createEngine` never bound `deps.globalStore` onto `cfg`.** Found while wiring (2): `cfg.globalStore` was always null, so `blockStore()` silently fell back to the per-channel `store` — meaning the v0.77.2 "global blocklist" only ever worked on the primary engine; secondary and DM engines had per-channel blocklists. One line (`if (deps.globalStore) cfg.globalStore = deps.globalStore;`) fixes the blocklist globally AND enables the DM merge. Correctness fix, default-on.

**4. Worker-failover write-race / clobber defenses.** The run-lock wraps `pollOnceCore` and is held continuously, so the exposure is the paths that run BETWEEN polls. The `deferGen` guard catches a clean demote but NOT a frozen-then-thawed tab (deferGen unchanged), so a thawing ex-queen could still write while a successor owns the channel. Closed three surfaces with a new read-only `iHoldRunLock()` (never claims, so it can't steal from the live owner):
  - **Deferred reply chain** + **`revalidateReply`**: a reply abandons if a successor holds the lock, leaving the pending-reply record for the successor's resume-once (no double-send, no reply-state clobber).
  - **Deferred image chain** + **image-delivery commit**: a paint abandons at delivery if the lock was taken mid-paint (the 14–60s paint is the longest stale window in the system).
  - **`presenceMaintenance` ran on EVERY poll including lock-skips** — backfill checkpoint + partition writes, departure sweeps, and anchor notes, all out-of-lock. A split-brain skipping engine was clobbering the backfill cursor and partitions. Now skipped when `summary.lockSkip` is set; only the lock-holder maintains.

**Harnesses (now 87 + golden).** `harness-dm-ethereal.js` (19 checks): public fact reaches DM context; DM-only fact NEVER reaches public context (the no-leak guarantee, asserted both directions); per-context ethereal independence; forget-floor persists across `remember me`; image surface stores nothing for an ethereal user. `harness-runlock-guards.js` (4 checks): a reply and an image both abandon when the lock is stolen mid-generation, and a lock-skip poll reports `lockSkip:true`. Validation: 87/87 + golden + audit clean, `node --check` on the assembled userscript, and a defined-once check on every new function (the v0.76.4 undefined-reference class).

### Shipped in v0.77.3 (bugfix: worker spawn+close killed the bot — election deadlock in throttled background tabs)
Operator repro: "spawn a worker, then close it, breaks People memory population." Root-caused with a
new full two-tab simulation harness (real `bridge.js` ×2 over a shared bus + GM-backed lease, real
`engine.js` ×2 over the shared GM store, the real `makeStore` evaluated verbatim from bootstrap.js
source, faithful `onDemote`/`onPromote` engine stop/start, and scripted per-tab clocks with realistic
Chrome throttling — foreground 5s ticks, background 60s, frozen).

**The real-world failure chain.** The People symptom is the visible tip of a full-bot outage:
1. With a worker spawned, the QUEEN tab eventually freezes >90s (Chrome Memory-Saver/intensive
   throttling — the queen tab is routinely backgrounded because the operator is on Discord). The
   worker's watchdog correctly claims the stale lease and promotes; `autoResume` starts its engines.
2. The original queen, on thaw, receives the worker-queen's pings → `queenConflict` → lease held by
   the worker → `demoteSelf` → **bootstrap's `onDemote` stops all engines** (correct: single-writer).
3. The operator closes the worker tab. The only running queen is now dead (its run-lock record
   expires harmlessly via the 45s TTL — verified in the harness).
4. The demoted ex-queen must re-elect itself — but its tab is in the BACKGROUND, so its
   `tick()` interval is throttled to ~60s. **The watchdog's wake-jump guard (`wakeJumpMs` = 30s)
   tripped on every throttled tick** (`now − lastWatchdogAt` = ~60s > 30s), each time faking
   `lastQueenSeenAt = now` and clearing `claimState`. The election claim could never even enter its
   waiting phase. The bot stayed dead — no polls, no ingest, no People updates — until the tab was
   focused or reloaded. The guard conflated "machine slept" with "tab throttled".

**Fixes (both in `bridge.js`; engine.js and bootstrap.js untouched).**
- `wakeJumpMs` default 30000 → **150000**: routine background throttling (~60s ticks) no longer
  looks like a sleep-wake; genuine sleeps (minutes+) still trip the guard. Promotion safety never
  rested on this guard — the lease freshness check plus the claim read-back settle are what prevent
  promoting over a live queen, and both are unchanged.
- Claim backoff now credits the queen with life **as of the lease timestamp**
  (`lastQueenSeenAt = max(lastQueenSeenAt, l.at)`), not as of the check (`now`). The old form
  restarted the full 90s window whenever the last ping trailed the last lease renewal by a few
  seconds (15s ping vs 10s renew cadence), doubling worst-case failover to ~190s. Now ≤~110s.

**New harness `harness-worker-clobber.js` (suite is now 86).** Five phases, 14 checks: live-queen
ingest; 5-minute sustained no-usurp/no-demote with a throttled background worker (the everyday
worker-pool steady state); queen-freeze failover (promotion asserted ≤130s, worker-queen ingest);
worker close leaving its run-lock record; and the demoted background ex-queen re-promoting on 60s
ticks, restarting engines via autoResume, lock-skipping ≤TTL, and ingesting new users — asserting
all five users present in BOTH the roster index and partitions (People-tab visibility), plus cursor
advance. Before the fix this final phase failed exactly as reported (role stuck at worker for 10
simulated minutes, users never ingested, cursor frozen).

Validation: 86/86 harnesses green, golden context green, audit clean, `node --check` on the
assembled userscript. Background-tab recovery time after the usurper dies: ~4–5 minutes (90s grace
+ claim cycle at 60s tick granularity); foreground recovery ~95s.

### Shipped in v0.77.2 (bugfix: blocklist was per-channel; self-ban blocked all channels; reset didn't clear it)
Three related bugs.

**1. Blocklist was per-channel-store, not global.** `BLOCK_KEY = 'blocklist'` is an unscoped key, but the engine’s store is created with a per-channel prefix (`ch:ID:` for secondary channels, empty for primary). So a ban on a secondary channel wrote to `chloe:ch:ID:blocklist` while the primary channel’s engine read `chloe:blocklist` — different keys. A ban on one channel didn’t gate others, and an unban from the wrong channel’s engine was a silent no-op. Fix: `blockStore()` helper in the engine returns `cfg.globalStore` when available, falling back to the own store. Bootstrap wires `globalStore: makeStore('')` (the root, un-prefixed store) to every engine, so all block reads/writes land at `chloe:blocklist` regardless of which channel’s engine handles them.

**2. `resetState` and `factoryReset` didn’t clear the blocklist.** A self-ban survived a full factory reset. Fixed: `'blocklist'` added to the per-channel key list in `resetState` (clears it for all channel prefixes), and `GM_deleteValue(NS + 'blocklist')` added to `factoryReset` for the root key.

**3. `mod.unban` and `mod.listBanned` only looked at one channel’s engine.** Fixed: both now operate across ALL channel engines (`ensureEngines()`), merging results and applying the unblock everywhere. 85/85 green, golden intact.

### Shipped in v0.77.1 (bugfix: channels textarea was pruning // comments on refresh)
The comment-strip-before-save worked correctly, but on every status refresh `cb.value = chans.join('\\n')` replaced the textarea with the bare stored IDs, wiping any `// notes` the user had typed. Fix: the reload now merges the stored IDs back into the existing textarea content — if a line already starts with a stored ID it’s left untouched (preserving its comment); IDs that were removed are dropped; any new IDs not yet in the textarea are appended as bare IDs. Comments survive refreshes, polling, tab switches, and page reloads. 85/85 green.

### Shipped in v0.77.0 (System tab: factory reset + export/import backup)
Three new controls in the Diagnostics card (System tab).

**Export backup:** snapshots the entire GM store to a `.json.gz` file (token excluded for security). Uses the browser’s native `CompressionStream` API for gzip — falls back to plain `.json` on older browsers. Captures: all cfg keys (bot name, channel IDs, behavior toggles, character, modList, etc.), per-channel state (all user partitions + archives, cursor, ring, rhythm, episodes, channel summary, goals, modlog, etc.), and top-level keys (seminject map, guildId cache, deviceClock). Filename: `chloe-backup-YYYY-MM-DD-HH-MM-SS.json.gz`.

**Import backup:** reads a `.json.gz` or `.json` backup, confirms with the operator, restores all keys to GM, stops the engine. Decompresses using `DecompressionStream` when available. After import the operator restarts the bot to apply.

**Factory reset:** wipes all state AND all cfg keys (the existing `reset` case only clears per-channel data). Token is kept so the bot stays connected. Prompts to confirm. Logs to the feed. The confirm dialog explicitly says “export a backup first.” Bootstrap: `factory-reset`, `export-state`, `import-state` cases added; `factoryReset()`, `exportState()`, `importState()` functions use explicit key lists (GM_listValues not needed/granted) so the export is comprehensive by construction. 85/85 green, golden intact.

### Shipped in v0.76.9 (Prune: Discord server ban disabled; local block+purge only)
By operator decision. The `mod.permaban` handler now only does the local prune: blocks the user ID in Chloe’s permanent blocklist and purges her memory. The `resolveGuildId` / `transport.banUser` path is removed (not just dead-code commented out inline — replaced cleanly). The confirm dialog and Moderation tab banner both updated to drop the Discord ban language. A comment in the handler notes where to look if it ever needs to be re-enabled. 85/85 green, golden intact.

### Shipped in v0.76.8 (bugfix: log is not defined in permaban + bootstrap logging to panel feed)
Two issues in one report.

**`log is not defined` (the immediate crash):** `log()` is an engine-internal function passed as a config callback — it’s only in scope inside the engine closure. The `localPrune7` inner function and all surrounding T4 code were calling it from the bootstrap case block where it doesn’t exist. Every permaban attempt threw a ReferenceError before any action was taken.

**Root fix:** a module-level `bLog(msg)` helper added to bootstrap (right after `trace()`). It does both `console.log(msg)` (browser console, always available) AND `pushEvent('log', msg)` (panel activity feed). The panel’s `feedType` classifier already handles `[chloe.T4]` strings — they land under the MODERATION badge, and anything containing `error|fail|warn` gets the WARNING badge. All T4 permaban/prune log calls converted to `bLog()`. No more silent failures in the panel.

**Broader logging sweep:** five other bootstrap operations that were `console.log`-only (invisible to the panel) also converted to `bLog()`:
- Tab reclaims queen role from stale worker
- Tab promoted to queen (previous queen went silent)
- Token saved (shape summary)
- Token shape warning (doesn’t look like a bot token)
- State reset for all channels
- Server member count detected

These are all things a mod operator needs to see at a glance rather than having to open browser devtools. 85/85 green, golden intact.

### Shipped in v0.76.7 (permaban: local prune always runs; Discord ban is best-effort)
The old permaban flow was: resolve guild ID → Discord ban → purge — and refused to proceed at all if the guild ID was unavailable. This meant a failed `GET /channels/:id` (permissions gap, transient error) left the user unpruned despite a mod explicitly requesting it.

New flow: **local prune (block + purge) always runs**, whether or not the Discord server ban succeeds. The Discord ban is best-effort — attempted when the guild ID is available, skipped gracefully when it isn’t. Three paths:
- Guild ID resolves + `banUser` succeeds → Discord ban + local prune (as before)
- Guild ID resolves + `banUser` fails (lacks Ban Members permission) → Discord ban skipped, local prune still runs
- Guild ID unavailable (permissions/transient) or DM channel → local prune still runs

Local prune = `blockUser` (adds the user ID to Chloe’s permanent blocklist) + `purge` (wipes the partition) + `appendModLog` (records `local-prune` vs `permaban` so the mod log reflects which path was taken). The confirm dialog and Moderation banner updated to reflect that the Discord ban is conditional on bot permissions, not guaranteed. Log line now reports `Discord banned + blocked + purged` or `blocked + purged (local only)` accordingly. 85/85 green, golden intact.

### Shipped in v0.76.6 (bugfix: permaban → could not resolve guild id from channel)
The permaban calls `resolveGuildId(channelId)` which fetches `GET /channels/:id` to get the `guild_id`. This was failing because: (a) `guildIdCache` is in-memory only — cleared on every engine restart (which v0.76.2 reduced to structural changes only, but still happens), so every permaban attempt after a restart needed a fresh live fetch; (b) if that fetch failed or the channel was a DM (no `guild_id`), the error was the unhelpful “could not resolve guild id from channel.”

Fix: `resolveGuildId` now uses a two-level cache: in-memory first, then a GM-persisted fallback (`guildId:<channelId>` key) so the value survives engine restarts. `maybeDetectMemberCount` (which already fetches the channel on `validate()`) now also writes the `guild_id` to both caches proactively, so the first `validate` click populates it for all future permabans without needing a separate fetch. Improved error messages distinguish the two genuine failure cases: a DM channel (no guild to ban from — actionable) vs. a permission/fetch failure (try Validate token first — actionable). 85/85 green, golden intact.

### Shipped in v0.76.5 (unban from panel + // comment support for ID fields)
Two operator UX improvements.

**Unban from the Moderation tab:** `unblockUser()` and `!chloe unblock @user` existed but there was no panel surface to see or lift bans — a mod had no way to know who was banned or reverse it without issuing an in-channel command. A “Banned users” card is now at the bottom of the Moderation tab. It lists everyone on Chloe’s blocklist (name, Discord ID, ban reason, timestamp), auto-loads when the Moderation tab opens, and has an **Unban** button per row with a confirm dialog that explicitly notes “This does NOT lift their Discord server ban — do that separately.” Bootstrap: `mod.listBanned` (returns sorted blocklist rows) and `mod.unban` (calls `unblockUser`, logs the action to the mod log) handlers added. The unban is logged so the mod log tracks the full ban→unban lifecycle.

**`// comment` support for channel ID and mod ID fields:** The channels textarea (one ID per line) now strips anything after `//` on each line before parsing, so a mod can write `123456789012345678  // #general` and have the comment ignored on save. The placeholder is updated to show the pattern. The single-line “Add mod” input does the same strip. Comments never reach the stored channel list — they live in the textarea only. The existing split-on-whitespace parser would previously have picked up `//`, `general`, `chat` etc. as junk channel IDs and silently added them. 85/85 green, golden intact.

### Shipped in v0.76.4 (hotfix: patchEngines not defined — ReferenceError in production)
The function body for `patchEngines()` was lost during the v0.76.2/v0.76.3 editing session — 40+ call sites referenced it but the definition was never written to bootstrap.js, causing a ReferenceError on every panel toggle. Restored the missing definition (identical to the intended implementation: iterates live engines and calls `eng.updateConfig(patch)` on each). 85/85 green, golden intact.

### Shipped in v0.76.3 (hardening: roster index clobber prevention + partition write-window reduction)
Follow-on to v0.76.1/v0.76.2. Systematic review of every store write path for last-writer-wins clobber risk. The v0.76.1 root cause (flat GM array overwritten by concurrent writers) was a pattern, not a one-off. Three categories addressed:

**1. roster:index — union writes + targeted ops (the confirmed clobber vector).**
`makeStore.setIndex()` now UNIONS the supplied array with whatever is currently in GM rather than replacing it, so a concurrent write from another path can’t lose entries it just added. Two new targeted operations added to the store interface: `addToIndex(id)` (appends only if not present, reads-live-before-write) and `removeFromIndex(id)` (drops only the one id, reads-live-before-write). The engine’s `ensureIndexed` and `removeFromIndex` use these when available, falling back to the old full-replace path for any store that doesn’t supply them. This covers the ensureIndexed vs batch-setIndex race (archiveUser, restoreFromArchive, applyModAction all call ensureIndexed outside the main poll chain).

**2. bumpInteraction partition write — read as late as possible.**
`bumpInteraction` (called at reply settle, outside the poll loop) does a read-modify-write on the user partition. If `ingestOneCore` writes the same partition between bump’s read and bump’s write, bump’s write drops the ingest’s `recent`/`lastSeen` update. Fix: re-read the partition as the last step before writing, minimising the stale-snapshot window to near-zero. `bumpInteraction` is also clarified to only touch its own fields (`interactionCount`, `lastChloeReplyTo`, trust) so even a simultaneous write won’t corrupt fields it doesn’t own.

**3. blockUser blocklist write — read as late as possible.**
Same pattern as bumpInteraction but for the unscoped `BLOCK_KEY`. The blocklist is a dictionary (`{ids:{},names:{}}`), so concurrent blocks of different users never collide, but same-user concurrent ops or a block+ingest overlap could clobber. Fix: re-read immediately before write.

**What was NOT changed and why:** `GOALS_KEY`, `CHARMEM_KEY`, `modlog` follow the same RMW pattern but are written only by AI-pass handlers (reflection, consolidation) that already run sequentially inside the poll chain and are guarded by their own cadence floors — the window is real but the frequency is very low. `partKey` writes from maintenance (quietSweep) and consolidation are inside `pollOnceCore`’s promise chain and therefore serialized by JS single-threadedness. 85/85 green, golden intact.

### Shipped in v0.76.2 (structural fix: 40 panel toggles no longer restart the engine)
Follow-on to v0.76.1. Even with the clock-push fix, 44 engine restarts in a session was identified as a bug in its own right. Root cause: every panel toggle (factMemory, ownAffect, greet, volunteer, beats, modList, commandPrefixes, autoMod — all 40+ of them) called applyConfigChange(), which stops all engines, clears the engine map, and rebuilds from scratch. These are all configuration values the engine reads at call-time (inside the poll loop body), not captured at engine startup, so they never needed a rebuild.

Fix: expanded the engine’s LIVE_PATCHABLE set to cover all non-structural keys, and converted 40 of the 51 applyConfigChange() calls in bootstrap to patchEngines() instead. patchEngines() calls updateConfig(patch) on each live engine, which mutates the live cfg object in-place for listed keys — no stop, no clear, no rebuild. The 11 remaining applyConfigChange() calls are all genuinely structural: channelId change (must restart polling on a new channel), addressMode (changes how ingest works at message-parse time), character/persona updates (changes the system prompt block), channels list, and dmReplies (actually adds/removes channels from the polling loop). 85/85 green, golden intact, audit clean. With this and v0.76.1 combined, a running session with the panel open should produce at most a handful of engine restarts (only on actual structural config changes) rather than one per toggle-flip or one every 60 seconds.

### Shipped in v0.76.1 (bugfix: People list not populating — engine rebuilt every 60s)
Reported: only 2 users appeared in the People list after hours of chatting with 6+ users. Log analysis confirmed she was replying to all of them (T1 replied-to lines for fuckdiskord69, camoakum, hornyyeen, zephyrspark, balthasar0456, therealwestninja) but only 2 appeared in the roster. Traced precisely from the logs.

Root cause: `config.setDeviceClock` and `config.setSemanticInjection` both called `applyConfigChange()`, which stops ALL engines, clears the engine map, and rebuilds from scratch. The device-time feature pushes the clock every 60 seconds (panel setInterval), so the engine was being destroyed and rebuilt every 60 seconds while the panel was open. This explains the 44 engine restart events in the logs. Because each fresh engine starts a new in-memory poll cycle, and each poll only picks up 1 message at a time (the cursor advances 1 per poll), many users' messages were ingested and their partition keys were written to GM — but under the constant restart churn, the roster index write (`store.setIndex`) of some users was being clobbered or their ingest cycle was interrupted before the index write committed. Result: partition data present in GM for all users, but roster index only stable for the 2 who had been seen by an engine instance that ran long enough to write their index entry cleanly.

Fix: `setDeviceClock` and `setSemanticInjection`/`clearSemanticInjection` now use `patchEngines()` instead of `applyConfigChange()`. `patchEngines()` calls a new `updateConfig(patch)` method on each live engine, which mutates the live `cfg` object in-place for a declared set of LIVE_PATCHABLE keys (those read at call-time rather than captured at startup). The engine is never restarted for these frequent value pushes. `applyConfigChange()` is still used for structural changes that require a rebuild (addressMode, botName, channelId, etc.). 85/85 green, golden intact.

### Shipped in v0.76.0 (self-knowledge injection: she knows her own basics)
Forward item #5b (self-knowledge), the recommended-next semantic-injection use. From the log analysis: she doesn’t actually know her own command prefix, that she’s a bot, or how people summon her — yet users ask, and with nothing in context she hallucinates or deflects (the same dodge we saw for the clock). Device-time fixed the clock by injecting a true fact; this does the same for her operating basics. Suite 85 green incl. golden; design in DESIGN-selfknow.md.

- **A `selfknowledge` context provider in the ENGINE** (IDENTITY band, near her name). Unlike device-time (a BROWSER value pushed from the panel), self-knowledge is ENGINE CONFIG she already holds — so it’s built INSIDE the engine by a pure `selfKnowledgeText()` rather than routed through the seminject slot. No page push, no GM storage, no TTL machinery: the facts are static config, always current, rebuilt each assembly. The seminject slot stays reserved for genuinely dynamic facts.
- **Assembled only from configured values, never fabricated:** “You are {name}, an AI assistant… To reach you: commands with {prefix} (e.g. {prefix} help); @-mention you; reacting {emoji} to your own message… You can tell someone this if they ask how to use you or whether you’re a bot — state it plainly rather than deflecting.” No prefix set → the prefix clause is omitted; no summon emoji → no summon clause. It can’t promise a prefix/summon that isn’t wired.
- **Grounding, not instructions** (same boundary as the SITUATION providers): it states facts, carries no “you must/always/never” behavioral command, and the harness asserts that. The honesty payoff is the persona fix from the log analysis — asked “how do I use you?” she now has the true answer in context and states it instead of deflecting.
- Default OFF; bridge setter + passthrough; panel toggle beside device-time (both are “ground her in true facts”); About paragraph. Harness (85th, harness-selfknow.js): name/prefix/@-mention/summon-emoji present, the “how to use / are you a bot” clause, grounding-not-directive, clause omission for unset config, and the provider’s on/off presence through assembleContext (off = zero context cost).

### Shipped in v0.75.0 (attention manager: utility-scored AI-pass selection)
Tier-2 item #3 from the forward roadmap (Utility AI, from the game-AI cross-discipline scan). She runs at most ONE background AI pass per quiet poll; the old ladder picked the first DUE pass in a fixed importance order (facts > summary > reflect > episodes > consolidate > deliberate). Now, when several are due, they’re SCORED and the highest wins — base priority dominant, with small re-ranking modifiers. SCOPED/SURGICAL, not a teardown: OFF (default) == today’s fixed ladder byte-for-byte; neutral signals == today’s order; still exactly one pass per poll (no new AI cost). Suite 84 green incl. golden; the pace/poll/staleness harnesses stay green UNCHANGED (the OFF==today proof). Design in DESIGN-attention.md.

- **Pure `attentionScore(cand, signals)`** (exported): base = today’s standing priority (dominant); modifiers are small re-rankers — staleness ×3 (anti-starvation), idle lifts consolidate(+4)/deliberate(+3), curiosity lifts deliberate ((cur-0.5)×8), memoryPressure lifts consolidate (×6). `chooseAttention` (exported): off → candidates[0]; on → highest score, ties to the lower base-order index (deterministic, == today when modifiers are zero). `attentionSignals()` gathers cheap reads: idle (channelIsIdle), curiosity (affectLoad), per-pass staleness (time since paceLastAI, never-run = maximally stale), memoryPressure (fraction of roster at/near the fact cap).
- **The ladder was refactored to a candidate list** {name, base, run}; each due pass is pushed, then off → run candidates[0]; on → attentionSignals().then(choose → markRan → run). Exactly one runs.
- **A real interaction bug the refactor exposed and fixed:** `aiPassDue` used to RECORD the run (paceLastAI[name]=now) at TEST time — so a due-but-not-chosen pass would wrongly reset its pace floor and zero its staleness. SPLIT into `aiPassDue` (tests only) + `markRan` (stamps paceLastAI); only the CHOSEN pass calls markRan. Golden + pace harnesses confirm the split is invisible to existing behavior.
- **Honest tuning note:** the modifier weights are conservative RELATIVE TO the 10-point base gaps — even maximally-favorable signals (idle + max curiosity + max staleness) lift deliberate only to ~20, below a fresh idle consolidate’s 24. So the manager re-ranks mainly at near-ties and provides anti-starvation among SIMILAR-base passes; it does NOT let, e.g., deliberation outrank consolidation across a full base tier (the roadmap’s illustrative example overstates this). That’s an intentional “base dominates / nothing erratic” stance; the weights can be widened later as a separate, reversible tuning pass if stronger re-ranking is wanted. Default OFF; bridge setter + passthrough; System-tab toggle + About. Harness (84th, harness-attention.js): OFF==today under extreme signals, neutral==base order, staleness monotonic + equal-base tie-break, idle/curiosity/memoryPressure lifts, deterministic tie-break, and the real conservative-value assertions.

### Shipped in v0.74.0 (per-user bidirectional translation)
*(Operator confirmed live: the translation pipeline works end-to-end in the browser — the free endpoint, transport wrappers, and per-user language all function against the real service.)*
Requested: route her replies through translation and remember a language per user. Built bidirectional — a user sets their language with !chloe lang <code>, then their messages are translated TO English before her brain sees them, and her replies are translated to THEIR language before Discord receives them. Suite 83 green incl. golden; design in DESIGN-translate.md.

- **The architecture decision that keeps it clean: translate at the TRANSPORT boundary, engine stays monolingual.** The two transport seams — getMessagesAfter (inbound) and the send wrapper (outbound) — are wrapped; the engine NEVER knows translation exists. So all memory, facts, summaries, matching, AND moderation stay in English (consistent, searchable, and safety decisions are made on text she actually reasoned about). Language is purely an edge concern.
- **Engine half:** a per-partition `lang` field + the `!chloe lang <code>` command (set / report / `off` / unknown-code help), open to anyone, validated against a 24-language ISO-639-1 set, covered by `forget`. getUserLang/setUserLang exported for the bridge. The addressee id is threaded through the reply send (opts.toUser) so outbound knows whose language to use.
- **The provider (free/unofficial endpoint) is engineered DEFENSIVELY — the cardinal rule is that translation failure is a NON-EVENT:** every translate() call has a 6s timeout and, on ANY error/timeout/parse-failure/HTTP-error, returns the ORIGINAL text — she sends untranslated rather than going silent or dropping a message. Mentions (<@id>, <#id>) and custom/animated emoji are protected (swapped for inert sentinels, prose translated, then restored) so a translated reply still pings and renders. A bounded LRU cache dedupes repeated lines. The free endpoint also auto-detects the source language (used for inbound).
- **Safety:** moderation/gates run engine-side (English) BEFORE outbound translation, which is the last step before POST; the 1900-char clamp applies after translation; no API key (free endpoint) so no secret to store. New `@connect translate.googleapis.com` grant (a permission the user approves once). Default OFF. Bridge: config.setTranslate + setUserLang; System-tab toggle with a permission note. Harnesses: harness-lang.js (the engine field + command, 82nd) and harness-translate.js (mention/emoji protection round-trip + response parsing + malformed-input fallback, 83rd). The live endpoint is browser-only, smoke-tested by the operator (like device-time).

### Shipped in v0.73.0 (instant !chloe time / !chloe date commands — no AI loop)
From the log analysis of the date-question bug: the running build had no way to know the time, so she truthfully (in character) said “temporal data remains elusive.” The v0.71 device-time injection makes her conversationally AWARE of the clock, but it still routes through the AI — which can dodge it (“date and time are irrelevant when you’re watching integers brawl”), hit the token budget, or be paced. A COMMAND answers from the bridge instantly and deterministically, outside the AI loop entirely. Complementary, not redundant. Suite 81 green incl. golden.

- **`!chloe time` and `!chloe date`** (open to anyone): instant `{ack}` replies that can’t be misread, rephrased, throttled, or budgeted out. The proof in the harness: the `respond` (AI) mock returns failure and the commands still answer — zero AI involvement.
- **Structured device clock:** the page already computed the clock for the conversational injection; it now ALSO pushes a structured `deviceClock` {time, date, tz, at} (separate time-only and date-only strings) via config.setDeviceClock, on the same 60s cadence and the same toggle. The engine’s deviceClockAck(which) reads it. Same safety boundary as v0.71: device clock + timezone NAME only, never IP/geo/address.
- **Honest degradation (never fabricates):** clock absent (feature off) → “I don’t have the current clock — turn on ‘know the current date & time’ and keep the panel open”; clock stale (panel closed > deviceClockStaleMs 3m) → “my reading is stale — reopen the panel”, and crucially does NOT assert the old time. Harnessed (81st, harness-timecmd.js): time + date answer from a fresh clock, date omits time-of-day, off → honest+no fabrication, stale → honest+no old time. Auto-listed in !chloe help.

Note: the date-question report was ultimately a DEPLOYMENT gap (the running instance predated v0.71 device-time, ~650 engine lines behind), not a pipeline bug — the v0.72.1 cooldown-ack fix was a real latent bug but not the cause. These commands make the capability robust regardless of whether the conversational injection is on.

### Shipped in v0.72.1 (bugfix: silent throttle when re-addressed within cooldown)
Reported: “chloe, what is the current date and time?” felt throttled/gated with no response, and she seemed to re-read the previous message. Root cause traced (not guessed): in the reply-queue selection, the sub-second DEBOUNCE gate was checked BEFORE the per-author COOLDOWN ack. So when someone addressed her shortly after she’d replied (within the 8s cooldown), the debounce early-return fired first and the ⏳ throttle ack never showed — the user got confusing silence while the poll kept surfacing the prior line as the freshest context, which reads as her “re-reading” the previous message. The date data itself was fine (the v0.71 device-time injection reaches the reply context correctly — verified); the defect was purely feedback ordering.

- **Fix:** the cooldown ack now fires independent of, and before, the debounce early-return. The moment she’s holding an addressed message because she answered that person recently, she shows ⏳ — so the user knows she heard them and is waiting, instead of silence. Selection/priority logic is otherwise unchanged; she still answers once the cooldown clears. Correctness fix, no toggle.
- Regression locked in harness-cooldown-ack.js (80th): a question 2s after a reply now produces the ⏳ ack while cooling, does not answer prematurely, and answers once the cooldown elapses. Suite 80 green incl. golden.

### Shipped in v0.72.0 (output hygiene: scrub model-mechanics noise at the seams)
Tier-1 item #2 from the forward roadmap (from weld.clean). She sent RAW model output — the only post-processing was INTENT-line extraction. Three common artifacts leaked through; now they’re cleaned at the spoken seams. Suite 79 green incl. golden; design in DESIGN-clean.md. Correctness plumbing, default ON.

- **A pure `cleanReply(text, opts)` in the engine** (mirrored from weld.clean, not a runtime dep), applied via `hygiene()` at EVERY spoken-text settle point — main reply, volunteer, lull, beat, greet (the `String(r.value).trim()` sites). Engine-side placement chosen for testability + uniformity (one tested function, every path) over scattering per-handler in the page. NOT applied to JSON-returning handlers (facts/decompose/reduce), which parse their own output.
- **Four no-op-safe steps:** (1) strip a LEADING role-name prefix (“Chloe:” / “Chloe —” / an alias / a generic “user:”/“someone:” label) — only her own names + known labels, only at the very start, so mid-message colons (“here’s the plan: …”) survive; (2) collapse an exact 3x+ word stutter; (3) trim a clearly-incomplete dangling tail back to the last complete sentence (the defensive counterpart to the unreliable stopReason truncation detection the memory notes flag); (4) balance an odd code-fence count so a cut-off ``` doesn’t render the rest of the channel as code.
- **Never empties a valid reply** (the load-bearing guard): a short punctuation-less message like “lol ok” survives untouched; a prefix-only or single-word string is kept as-is; an absolute final guard returns the original if cleaning ever produces empty. Idempotent (clean(clean(x))===clean(x)). The dangling-tail trim only fires when it leaves a substantial sentence (≥10 chars) AND actually drops a fragment.
- **Default ON** (it removes never-intended noise, doesn’t change what she says — like the boxed-String unwrap already there); `cleanOutput` escape hatch returns raw for debugging. Bridge: config.setCleanOutput + passthrough; System-tab toggle. Harness (79th, harness-clean.js): role-bleed strip + mid-colon survival, stutter collapse, dangling-tail trim + clean-end preservation, never-empty guards, fence balancing, idempotency.

### Shipped in v0.71.0 (semantic injection slot + device-time grounding)
A reported gap: Chloe couldn’t state the current date/time, and there was no general way to ground her in arbitrary system facts. Her old `time` provider only derived a vague part-of-day from message timestamps + a hand-typed offset and explicitly REFUSED to state the actual time. Two things built: a generic arbitrary-semantic-injection slot, and device-time grounding as its first consumer. Suite 78 green incl. golden; design in DESIGN-semantic-inject.md.

- **The general capability (`seminject`):** one generic provider surfaces a config-held list of `{id,text,priority,ttlMs,at}` facts into context, skipping any past their TTL (so time-sensitive facts never go stale). Any system truth (“the server is in beta”, “today is a holiday”) can now be injected without writing a new provider. Bridge: config.setSemanticInjection (upsert by id) / clearSemanticInjection, backed by a GM-stored map. This is the reusable slot; the clock is just its first use.
- **Device-time grounding (rides the slot):** the user’s device clock lives in the BROWSER, so the page reads it and pushes it as a `devicetime` injection on a 60s cadence with a ~2.5min TTL (so a closed panel’s stale clock is dropped, never asserted). The text states the date/time + timezone NAME so she CAN answer “what’s today’s date?” — unlike the old provider.
- **The safety boundary (the load-bearing requirement):** ONLY the device-clock subset is read — `Date.toLocaleString` (local date/time), `Intl.DateTimeFormat().resolvedOptions().timeZone` (timezone NAME), `Date.getTimezoneOffset` (offset). These read the device’s own clock/locale settings, NOT the network: navigator.geolocation, IP, physical address, and coordinates are NEVER touched. The injected text carries date/time/tz-name only and explicitly instructs her not to infer or mention the user’s location. The timezone name reveals at most a rough region the user already shares by chatting. The harness asserts the text contains no IPv4 / coordinates / street-address / location-inference phrasing.
- **Gating:** deviceTime toggle (default OFF — opt-in even though low-sensitivity, since it shares the timezone name); the old vague-tone `time` provider is untouched (tone tinting stays; this adds the factual layer). off/empty == today. Harness (78th): the slot surfaces a live entry, skips an expired one, joins multiple, is empty-safe, and the device-time safety invariant.

### Shipped in v0.70.0 (exact token counting: budgets stop being a guess)
Tier-1 item #1 from the consolidated forward roadmap, and the highest leverage-to-effort borrow on the board (from weld.tokens). `estimateTokens` already had a `cfg.countTokens` hook but it was wired NOWHERE, falling back to `chars/4` (±25%). Now the bridge loads the SAME DeepSeek-R1 tokenizer Perchance’s AI broker uses and feeds that hook, so every budget — context packing, the 5000-tok ceiling — is exact. Suite 77 green incl. golden; design in DESIGN-tokens.md.

- **Synchronous-safe by construction:** estimateTokens sits in the hot path (packByTokens calls it per line) and can’t await. So the bridge lazy-loads the tokenizer in the background (pinned transformers @3.0.2 via the page realm’s import(), since the engine runs in the Perchance origin) and exposes a SYNCHRONOUS countSync that returns null until ready. The engine’s hook uses it when warm and falls through to chars/4 during the ~1-2s cold window, when disabled, or if the CDN ever fails. No await enters the assembler; the bot never stalls on the tokenizer.
- **Found and fixed a real latent bug:** the hook guard was `if (n >= 0)`, but `null >= 0` is `true` in JS — so a cold/loading tokenizer returning null would have yielded Math.ceil(null)=0 tokens instead of the chars/4 fallback (silently under-counting during every cold start). Tightened to `typeof n === 'number' && isFinite(n) && n >= 0`. The harness caught this directly; golden confirms no real-world counts shifted (golden stays on chars/4, as designed).
- **Resilient + opt-outable:** version PINNED (a long-running bot shouldn’t silently pull a breaking tokenizer); ALL load errors swallowed (resilience over precision). `exactTokens` toggle (default ON) on the System tab with a live tokenizer-state readout (loading / ready / fallback); off == today’s chars/4 behavior exactly. Bridge: config.setExactTokens + preload() warmed at init. Harness (77th, harness-exacttokens.js): the hook is used when present, null/throw/negative all fall back to chars/4, and exact counts demonstrably change a packByTokens decision (word-exact packs 2 lines where chars/4 packs 4 at the same budget). The existing harness-tokens.js (the packer) is untouched.

### Shipped in v0.69.0 (idle deliberation: a ReAct map-reduce reasoning loop)
The roadmap’s “Internal Monologue” — and the operator’s original idea: treat idle time as a real reasoning engine, decomposing a thought into its smallest independent parts, working them across the worker pool, and recomposing. Built ON TOP of v0.68 working memory (the deliberate reorder paid off: it seeds from the workspace, not raw partitions). Suite 76 green incl. golden; design in DESIGN-deliberation.md. NEVER sends a message. Default OFF (spends real calls; opt-in).

- **Map-reduce, not a swarm (the platform reconciliation):** the AI broker is 1-concurrent-per-broker serial, but each WORKER TAB has its own broker and Chloe already runs a queen/worker pool. A single reasoning CHAIN can’t split across tabs (step 3 needs step 2) — but the atomic sub-questions from a decomposition are INDEPENDENT, so THEY fan out perfectly. The loop: decompose (1 call) → map the sub-questions across workers (N parallel via the new brainCallBatch) → reduce (1 call). Parallelism lives in the independent middle. A debating multi-agent swarm stays the documented NO; this is map-reduce over one mind’s sub-questions.
- **brainCallBatch (bootstrap):** fires an array of independent jobs concurrently; each rides the existing per-job dispatch (which round-robins + busy-marks a distinct idle worker), so with K idle workers the first K run in parallel and the rest queue; K=0 (single tab) degrades to sequential-local — identical results, just slower. One job failing doesn’t sink the batch. Wired as the engine’s mapFn (decompose/subAnswer/reduce are single brainCalls).
- **The loop (engine):** deliberateSeed reads the working-memory workspace by MODE — prepare (the active goal), curiosity (the current topic), or deepen (a regular with ≥3 facts, the partition fallback). decompose → mapFn → reduce → PREEMPTION re-check (channelIsIdle before write-back; a message landing mid-thought discards it) → write-back through EXISTING writers (insight on the subject / goal for the owner / else an episode), re-validated → curiosity DROP.
- **Four brakes + self-limiting:** opt-in toggle, curiosity floor (0.62), idle gate (channelIsIdle), and a 10m min-gap. Crucially, a completed deliberation LOWERS curiosity (it scratched the itch), so a burst of curiosity yields a few thoughts then settles — no runaway, no separate rate cap. Requires ownAffect on (it’s the gate). Self-gated inside deliberate() so it’s a cheap store-read each poll until the gates align.
- **Silent, visible as thinking:** never sends; logs staged [chloe.think] events (“thinking about X” → “broke it into N questions” → “considered N in parallel” → “concluded: …” / “nothing new”), rendered as the THINKING feed type. Results surface as insights/goals in the People tab. Page handlers: decompose (JSON array of sub-questions), subanswer (the isolated map step), reduce (JSON {text,type:insight|goal|none}). Bridge: config.setIdleDeliberation + passthrough. Harness (76th): the full loop shape, batch order + parallel width, sub-question ISOLATION, all four brakes, the curiosity drop, none-writes-nothing, and preemption.

### Shipped in v0.68.0 (working memory: a volatile cognitive workspace)
The uploaded cognitive-architecture roadmap’s #1 highest-priority item, and a genuine gap: Chloe had rich LONG-TERM memory (facts, episodes, goals, insights) but no volatile WORKING memory — a live scratchpad of what’s happening RIGHT NOW that decays and continuously updates (the roadmap’s prefrontal-cortex analog). Auditing Chloe against that roadmap, ~70% of its systems were already shipped (reflection, episodic, semantic, goals, affect, consolidation, relationships); working memory and an attention manager were the real gaps. This lays the first, and it’s also the substrate the in-progress deliberation loop will seed from. Suite 75 green incl. golden; design in DESIGN-working-memory.md.

- **A small `work:{ch}` blob, decaying on read** (mirrors the proven affect-state pattern): topic, participants, active goal, a recentDecisions ring, and her mood. workLoad() applies time-decay on every access so a stale topic goes NULL rather than asserting a “current topic” that’s actually old — the “volatile” requirement.
- **Mostly free — synthesized from signals she already has:** participants ← the speaker ring; active goal ← a current participant’s open goal; mood ← the affect state; recentDecisions ← a tiny ring appended at her existing action sites (replied/greeted/volunteered) as pure local writes. The ONLY field that can cost language is `topic`, and it REUSES the rolling channel summary’s first clause when fresh — so with channel-summary on, the topic is usually free.
- **Consumed three ways:** (1) a WORKSPACE context provider injects a compact “Right now: this channel is about X; A and B are here; you’re trying to Y” status line, grounding her replies in the live moment rather than only retrieved facts; (2) a System-tab card (“What she’s holding in mind”) shows the live workspace; (3) it’s the seed source the deliberation loop will read (next).
- **TTLs:** topic clears after 20m inactivity (→ null, not stale); decisions age out after 30m; participants recomputed live each read. Default OFF (adds a context line + an occasional reused-summary topic call; opt-in). off == today. Bridge: config.setWorkingMemory + work.get. Harness covers synthesis-from-signals, topic-TTL-decay, the decision ring (append/cap/age-out), the workspace injection (present on+fresh / absent off+stale), summary-reuse, and the off switch.

Roadmap audit recorded: most of the cognitive-architecture document is already shipped; the “Internal Monologue” item IS the deliberation loop (designed, deferred one step to seed from this workspace); remaining real gaps are the Attention Manager and explicit contradiction flag-and-clarify.

### Shipped in v0.67.0 (context moderation: excise a message from her memory)
The “she shouldn’t have seen that” tool, and the first of the promoted backend capabilities (reframed from the Weld survey: Chloe’s FRONT end isn’t a chat app, but her BACK end IS a session/context manager). A message lived in her working memory in each user’s `recent` window and shaped her replies until it aged out — deleting the Discord message did nothing to her brain. Excise removes ONE message from her working context, immediately. Suite 74 green incl. golden; design in DESIGN-excise.md.

- **Precise reach:** a message is stored by message-id ONLY in the per-user `recent` window (the speaker ring holds AUTHOR ids; facts/episodes are separate distilled artifacts). exciseMessage(msgId) scans partitions, removes the line from whoever’s window holds it, persists only what changed. The end-to-end harness proves the assembled transcript no longer contains an excised line.
- **Compose, don’t cascade:** excising a raw line does NOT retroactively unlearn a fact/episode distilled from it — that’s correct and honest, and the two tools compose: excise the line so she stops re-reading it, then delete the fact in the People drawer (v0.66.0) if needed. Harnessed: a distilled fact survives excising its source line.
- **Both triggers** (operator’s choice): (1) Panel — the People drawer’s recent-lines list gains a hover ✕ per line (excise this), with a stated compose-with-CRUD note. (2) Discord — `!chloe forget-that` (mod-only) excises the message it REPLIES to (via the referenced-message id, now captured), or an @mentioned user’s last line, or the most recent channel line (new lastLineId tracker); acks with a 🫧 sponge reaction (res.react wired into command dispatch via a new ackReact that fires regardless of the ambient ack-reaction setting).
- **Engine:** exciseMessage + exciseLastFromUser (drop last n from one user). Bridge: context.excise + context.exciseLast. assembleContext exported so the harness can prove the transcript effect. Idempotent (re-excising a gone id removes 0). Mod-gated on the command path. About updated (CRUD + excise + forget-that).

### Shipped in v0.66.0 (People memory CRUD: edit what she remembers, per-fact, in text boxes)
The People drawer now lets the operator fully edit what Chloe remembers about each person — facts and insights, each in its OWN text box (never raw JSON), with create / read / update / delete. Design in DESIGN-people-crud.md (3 decisions confirmed: edit both facts AND insights; operator edits protected from auto-expiry; autosave-on-blur with a saved indicator). Suite 73 green incl. golden; the weld-memory + weld-lorebook components were mined to confirm the stable-id + dedupe + operator-source shape (mirrored into Chloe's own partition store, not vendored).

- **Stable fact/insight ids** (the identity fix): facts were matched by fuzzy normalized-text before — wrong for a CRUD grid where two facts are similar or text gets edited. Each fact/insight now carries a minted `id` (like episodes in v0.64.0); id-less records get one via a lazy, idempotent, persisted migration on first read. All CRUD addresses memories by id, never by text.
- **Engine API** (additive; addFacts/forgetFact untouched): getMemory (read + migrate), editFact (text + importance by id, re-dedupes on collision so an edit that now matches another MERGES rather than duplicates), deleteFact (exact by id), addUserFact (creates the partition row for an unknown person, source 'operator', capped by evicting the OLDEST non-operator fact so hand-entered memory outranks decay), editInsight/deleteInsight. A hand-edit flips a fact's source to 'operator'.
- **Operator facts are protected:** semantic consolidation now excludes operator facts from the model input entirely and always preserves them unchanged (with id + source) ahead of the consolidated set — your hand-entered memories never get auto-dropped or rewritten by the idle 'sleep' pass.
- **UI:** expanding a person in People now shows three sections — What she remembers (facts: full CRUD, each an autosizing textarea + 1-10 importance + delete; a dashed 'add a memory' row), What she's concluded (insights: edit/delete only, italic), and Recent lines (read-only, unchanged). Autosave on blur with a 'saved' flash; emptying a box deletes it. Operator facts get an 'added by you' tag. Extends the v0.61.3 refresh-safety: a focused/dirty memory box pauses the 5s roster re-render so an edit is never clobbered. classList.contains used so the new 'udetail memedit' drawer still collapses + restores correctly.
- **Bridge:** 6 thin memory.* pass-throughs (get/editFact/deleteFact/addFact/editInsight/deleteInsight). Harness-people-crud covers id-migration idempotency, edit (text+importance+operator-flip), collision-merge, exact delete, add-with-cap-eviction, insight edit/delete, and the operator-fact consolidation exemption. End-to-end round-trip (get→edit→add→delete) verified standalone.

### Shipped in v0.65.1 (pace: INVERT polling — eager when quiet, passive-ingest when busy)
Correction to v0.65.0's polling consumer. The AIMD model (snap-fast on activity, back off when quiet) suited a Twitch-style chatter; this bot's job is the opposite — ACT on new content fast, and passively ingest a busy stream rather than chatter into it. Polling is now INVERTED; debounce (reply-on-lull) is unchanged. Suite 72 green incl. golden.

- **Quiet room → poll FAST.** A dead channel is where new content is most worth catching quickly, so she pounces the moment it stirs: fresh content cuts the interval multiplicatively toward the floor (AIMD-style eagerness). An idle quiet poll still drifts up toward the full ceiling (nothing to catch).
- **Busy room → poll RELAXED, but only PARTWAY** (new pollBusyCeilMs 12000, not the full 30000 ceiling): she passively ingests an active stream and lets context accumulate, replying on the lull. Partway — not full-ceil — so she stays reasonably responsive to mentions. “Busy vs quiet” is read from the rhythm z-score (paceIsQuiet).
- **Addressed-priority override:** a pending reply / greet / gate / paint job (she's been @-mentioned or replied to, or owes a delivery) ALWAYS snaps polling to the floor, regardless of room pace. Being addressed beats passive ingest, every time. Harnessed: a pending reply in a fast room still snaps to 4000.
- Legacy behavior (pace off) unchanged: binary snap-fast on activity, else x1.5 grow. When pace is on but not yet ready (no established rhythm), the controller uses its eager fallback (treat as quiet). harness-pace now covers quiet-eager, busy-relax-partway-capped-at-12000, and the addressed override; harness-poll relabeled for the not-ready fallback. About text + DESIGN-pace.md updated to the inverted model.

### Shipped in v0.65.0 (pace core: one rhythm estimator, many timing consumers)
From RESEARCH-ADAPTIVE.md build-order #1 (the operator's literal “adaptive timing” ask). The rhythm key already held avgGapMs (EWMA of inter-message gaps); the pace core adds the missing DEVIATION (the Jacobson pair, mirroring the brain meter) and routes both into timing constants that were fixed — so Chloe feels native to a fast room and frugal in a slow one. NO new AI calls; pure arithmetic over the gap stream she already records. Suite 72 green incl. golden.

- **Estimator:** rh.gapVarMs (EWMA mean-deviation, beta 0.25) alongside the existing mean; a paceReady() gate (≥ paceMinSamples 5) so cold-start and short rooms fall back to fixed constants.
- **Rhythm-relative debounce** (the most FELT change): debounce ≈ avgGap×0.5 + gapVar×1.0, floored at 800ms, with the configured debounceMs as the CEILING — pace may make her settle FASTER in a quick room, never slower than the operator's setting. (This ceiling semantics emerged from a real test regression: the original midpoint-clamp let an explicitly tiny debounce get overridden upward; corrected so debounceMs is a hard ceiling.)
- **AIMD polling** (replaces the binary x1.5 grow when pace is on): multiplicative cut toward the floor on activity (×0.5), additive increase each silent poll (+step) toward the ceiling — proportional + oscillation-resistant. Legacy x1.5 preserved for adaptivePace:false.
- **Silence as a z-score:** silenceZ() = (silentFor − avgGap) / max(gapVar, 1s); paceIsQuiet() reads ≥ paceQuietZ 3 deviations as quiet, so a fast room is “idle” sooner and a slow one later — relative to ITS rhythm. Wired into idle-consolidation's channelIsIdle (the safe first consumer; the day-scale lull FILLER stays on its flat threshold — changing when she SPEAKS is higher-stakes than when she tidies). Returns null when pace isn't ready, so consumers keep their flat fallback.
- **AI-cadence floor** (anti cost-multiplier): adaptive polling makes “every N polls” a variable wall-clock time; a fast room would over-run the fact/summary/reflect/episode passes. aiPassDue gates each on its poll cadence AND ≥ paceMinAIIntervalMs (90s) since it last ran — but ONLY once pace is ready, so existing every-N-polls behavior is unchanged until a room establishes rhythm.
- Default ON (adaptivePace:false → every consumer reverts to exactly today's fixed timing, harnessed). Toggle + About + bridge setter + status. harness-pace covers estimator math, debounce-as-ceiling (fast/slow/tiny), AIMD increase/decrease/clamps, z-score quiet, and the full off-switch fallback. One build note: the AI-floor + faster debounce initially broke 5 harnesses that assumed fixed timing; traced to (a) the debounce-ceiling bug above and (b) the AI floor needing the paceReady gate — both real fixes, plus harness-poll updated to test BOTH legacy x1.5 and AIMD explicitly.

Remaining electives (all independent, non-cognitive): FSRS-lite retrieval-strengthened memory (build-order #2, the most character-meaningful per the research), brain resilience (jittered retries), habituation + leaky volunteer, foraging give-up for check-ins, threads/webhook-personas/games, transport 429 full-jitter.

### Shipped in v0.64.1 (Character import: paste a link, clipboard, or raw JSON)
The v0.63.0 importer only accepted file drop/pick. Added a text field + Paste + Load so a character can come from a share link, a clipboard paste, or raw JSON — panel-only, engine untouched. The file-id extraction + fetch path is mined from aicc-recovery (the same generator the importer already vendors).

- **charLoadText routes three ways:** (1) an AICC share link (`?data=Name~FILEID.gz`), a direct `user.uploads.dev/file/…` link, or a bare hex file ID → normalized via charExtractFileId and fetched from user.uploads.dev in the user’s browser, then through the same decode pipeline; (2) raw character JSON (starts with brace/bracket) → parsed directly (JSON.parse, falling back to the brace-scavenger), skipping decompression; (3) anything else → a clear hint.
- **Paste button** reads the clipboard via navigator.clipboard.readText (with a graceful fallback message when the browser blocks it) and loads in one click; Enter in the field also loads.
- **Refactor:** file and URL paths now converge on shared charIngestBytes / charIngestObject sinks, so all sources share one decode+extract+render path (no duplicated logic). Verified standalone: share-link / direct-upload / bare-id all extract the right FILEID.gz, raw JSON routes to parse (not id-fetch), and garbage is rejected.
- Fetch runs in the user’s browser inside the generator (not blocked by any allowlist); still 100% local otherwise. Suite 71 green (sanity), panel node --check + audit clean.

### Shipped in v0.64.0 (light event-graph over episodes: one-hop associative recall)
From RESEARCH-COGNITIVE.md, cognitive-evolution step 3 (briefs' Phase 4 narrative + Phase 5 cognitive maps): episodes already carry participants + topics + time, but were islands. Link them so recall can walk ONE hop — “…and connected to that…” — turning flat keyword recall into a small associative landscape. NO new LLM call: edges are pure set arithmetic on fields that already exist. Suite 71 green incl. golden.

- **Edges computed at EXTRACTION** (not recall): when a new episode is recorded, its weight to each existing one = participantJaccard×0.5 + topicJaccard×0.3 + temporalAdjacency×0.2 (0.5^(gap/6h)). Keep only the single strongest neighbor above a 0.15 floor (a SPARSE graph, not a dense mesh): `relatesTo:{id,weight}` or null. Association is mutual — the neighbor’s link upgrades too if this edge beats its current best. Episodes now get a stable minted `id` so edges are referential (the ring slices; indices aren’t stable).
- **Recall walks ONE hop:** after the existing relevance×importance×recency scorer picks the top 1-2, if the top episode has a `relatesTo` neighbor that ISN’T already surfaced, append it as “…and connected to that, …”. Exactly one hop, never transitive (harnessed: a 3-stage chain surfaces stage-1 + its direct neighbor but NOT the second hop). The bridge only renders when the neighbor wasn’t independently relevant — no redundant double-surfacing. Token budget unchanged; still returns null (zero cost) when nothing matches.
- **Homeostasis:** dangling `relatesTo` ids (neighbor evicted from the ring) are silently ignored on read — a missing neighbor just means no hop (harnessed). The idle-consolidation episode-drop (v0.62.0) now also nulls out edges pointing at dropped episodes, so stale pointers don’t accumulate. Erasure already drops a person’s episodes; their inbound edges dangle harmlessly and get cleaned the same way.
- Default ON (`episodeGraph:false` escape), only active when episodicMemory is on; toggle + About + bridge setter. Harness covers edge weighting + floor, mutual upgrade, one-hop expansion, no-transitive-walk, dangling-id safety, and the off switch. One test-not-engine fix: the first one-hop scenario’s “neighbor” independently matched the query (so it surfaced via normal scoring, not the hop) — corrected to a genuinely edge-only-reachable neighbor, which is what proves the hop path.

Cognitive trajectory now: goal objects (v0.61.0) → idle consolidation (v0.62.0) → event-graph (this) — the three constraint-passing evolutions from the synthesis are all shipped. The blocked items (debating multi-agent workspace, stigmergy, full active inference) remain documented NOs under the 5000-token / one-brain envelope. Remaining electives are independent (pace core, FSRS-lite retrieval strengthening, threads/webhook-personas/games, transport 429 jitter).

### Shipped in v0.63.0 (Character tab: AICC import + respool + persona install)
New **Character** tab between Setup and Behavior. Imports a character from an AI Character Chat export, lets Chloe BECOME them (their personality replaces the default), and respools their remembered facts as context. Mines two of the operator’s own generators (aicc-recovery + respool) — vendored, not rebuilt. Suite 70 green incl. golden; panel node --check + audit clean; the vendored parser separately verified end-to-end on synthetic share-file AND full-db payloads.

- **Vendored parser (panel-side, pure in-browser):** aicc-recovery’s damage-tolerant pipeline — gunzip (fall-through to raw bytes) → decode (CBOR via the cbor-x CDN, then UTF-8/JSON, then brace-scavenge) → extractStores → normalizeCharacter — giving each character’s name + roleInstruction (the personality) + avatar. respool’s replay-from-file path (NO AI) pulls the timeless memories already stored on the character’s thread messages (memoriesEndingHere). Only the needed pieces vendored; no re-export, no repair UI, no live-AI respool.
- **Persona install = “replace default Chloe”:** the hardcoded PERSONA constant became personaBase(ctx) — when a character is installed (config.setCharacter), her base persona BECOMES that character’s role instruction wrapped in a minimal spine (stay in voice, openly a bot, concise), and her name becomes the character’s. Rides every prompt that already prepends PERSONA (respond/lull/greet/checkin/reflect/…) through one change point. CRITICAL: the instruction is voice/personality ONLY — the engine’s Tier-A safety, moderation, and output gates apply on top and are NOT overridable by an imported instruction.
- **Respooled memory as context:** engine seedCharacterMemories stores the memories cross-channel (charmem key), deduped via normFact + capped (characterMemoryMax 24); a new RECALL-band provider surfaces a couple as a SELF injection (“Things you (Name) remember: …”) — but ONLY while a character is installed (gated on cfg.character; harnessed dormant when none active). Nothing seeded silently: the UI previews the memories with a tickbox.
- **UI:** drop/pick a file → character list (name + personality size + memory count) → preview (instruction + memories) with two checkboxes (replace personality / seed memories) → Become this character; a Restore-default-Chloe button reverts. Status line + activity-feed log show who she is now. 100% in-browser, nothing uploaded (privacy note shown).
- Build notes: two array-literal DSL landmines ([obj], [arrayBuffer], [obj.addCharacter]) caught by audit’s [word] scan — reworked to variable-built arrays per the documented pattern. New bridge commands config.setCharacter + character.seedMemories; engine exports seedCharacterMemories/clearCharacterMemories; harness-character covers seed/dedup/cap, provider gating, and clear.

### Shipped in v0.62.0 (idle consolidation: the “sleep” pass — cognitive-evolution step 2)
From RESEARCH-COGNITIVE.md (briefs' instructions-1 §7 sleep/dreaming + Phase 11 homeostasis): during genuine idle, tidy memory so near-duplicates and contradictions don't accrete. Never sends — pure background. The design's key insight is splitting consolidation by COST (DESIGN-consolidation.md), suite 69 green incl. golden:

- **Structural (NO LLM, pure local compute, every idle pass):** dedup exact/near-duplicate facts via the existing normFact normalization (keep higher importance + newer), drop empty facts, trim to the per-user cap; hard-drop episodes that are BOTH faded (≥4 half-lives) AND low-importance (≤ episodeDropImportanceFloor 3) — never a recent or important memory. Bounded to consolidateSliceSize (5) partitions per pass via a sliceCursor, so a big roster spreads its cleanup instead of spiking one poll.
- **Semantic (ONE gated LLM pass, one user):** a new page `consolidate` handler reviews one overdue person's facts and may ONLY merge redundancies or drop the older side of a contradiction. Engine RE-VALIDATES every returned fact traces to an input (normalized substring overlap) — no invented fact survives, the same no-invention guard the extractor + reflection use. A failed call still bumps consolidatedAt so the user isn't re-picked immediately.
- **Trigger:** genuine idle (rhythm lastActivity quiet ≥ consolidateIdleMs 30m — much lighter than the day-scale lull FILLER, because this is silent), gated by consolidateEveryPolls (50) so a perpetually-quiet channel doesn't sweep every poll. Structural sweep rides the poll tick OUTSIDE the one-AI-pass ladder (local compute, like poll-expiry); the semantic pass joins the ladder LAST (housekeeping yields to learning). consolidateFn is a normal brainCall — adaptive timeout, no hardcoded value.
- Logs `[chloe.sleep] …` (a MEMORY event in the activity feed, so you can watch her tidy up). Default ON, idleConsolidation:false escape; toggle + About. Harness proves both directions end-to-end through the real poll ladder: switch OFF → 60 idle polls leave duplicates untouched; switch ON → an idle+due poll merges them. Plus structural dedup, stale-episode drop, semantic contradiction resolution, the no-invention guard, and idle-gating (nothing runs in an active room).
- One build note: a missing trailing comma on the last new config line (episodeDropImportanceFloor) broke node --check; caught immediately, fixed, re-verified. The safe-write discipline meant the file was never left half-written.

Cognitive trajectory: goal objects (v0.61.0) → idle consolidation (this) → light event-graph over episodes (next). The synthesis's constraint-blocked items (debating multi-agent workspace, stigmergy, full active inference) remain documented NOs under the 5000-token / one-brain envelope.

### Shipped in v0.61.3 (bugfix: People checkbox self-unchecking after ~5s)
The v0.61.1 roster checkboxes cleared themselves ~5s after being ticked. Cause: the 5s status poll calls refresh() → renderRoster(), which tears down and rebuilds every row from scratch — dropping all checkbox (and detail-expansion) state, because the rebuild had no knowledge of what the user had selected. Panel-only fix, two layers:
- renderRoster now CAPTURES the checked ids (and which detail rows are expanded) before teardown and restores them as it rebuilds — so even a re-render that does happen preserves selection.
- refresh() now SKIPS the periodic roster re-render entirely while the user has rows selected or is typing in the filter, so the list doesn't churn under them mid-interaction (manual Refresh and the next idle poll still update it). Defense in depth: the first layer makes selection survive a render, the second avoids the needless render at all.
Engine untouched; panel node --check + audit clean; suite 68 green (sanity).

### Shipped in v0.61.2 (UI: revert popover to tabs, consolidate controls, unify channel input)
Three follow-ups to the v0.60.0 refresh, all panel-only (engine untouched save the one new bridge command + a VERSION bump); panel <script> passes node --check, every removed id confirmed gone AND unreferenced, all six tab/pane pairs present, audit clean.

- **Reverted the slide-over to in-place tabs.** The modules rail + right-hand popover drawer is gone; a tab bar now switches the content of an inline panel box, exactly as before the refresh. The activity feed (the part of the refresh that worked) stays as the primary surface above the tabs; the collapsible Debug drawer moved below the panels. Removed all dead chrome (slideover/scrim/sobody/modrail/mod_* /moddot_* markup, CSS, and the open/close controller) — replaced with the simple tab switcher.
- **Consolidated duplicated controls.** The Mods management card (add-by-ID + mod list + mod log) moved from the Moderation tab to the People tab, co-located with the roster whose rows now also mod/unmod — all user+mod management in one place; Moderation keeps rules/gates/transparency. (The earlier duplicate id=log / reset-button pair was already de-duped in v0.60.0.)
- **Unified the Channels input.** The two separate inputs (primary “Set channel” + comma-separated “Set channels”) became ONE textarea, one ID per line: first line = primary, the rest = extras. New bridge command config.setAllChannels splits the list accordingly (reusing the existing channelId + channels config); the box round-trips from status (s.channels, primary-first). One save button replaces two.

### Shipped in v0.61.1 (People drawer redesign: router-style multi-select + mod/OP tools)
UI bug-fix detour. The People drawer's roster was a plain action-button table missing two things: OP/de-OP controls (the mod.addMod/removeMod targets existed but were never wired into the roster) and any way to act on users in bulk. Redesigned as a wireless-router-style management list — panel-only, engine UNTOUCHED, all four call() targets already existed:

- **Checkbox list** replacing the table: each user is a row with a select checkbox, name (+ a MOD badge when they're a moderator), state pill (color = state), id, last-seen/line-count, and a per-row action cluster. Click the name to expand recent lines (the old detail view, preserved).
- **Batch action bar** (appears only when ≥1 user is checked): select-all, live selected-count, and one-tap mass actions over every checked user — Mod / Unmod / Ignore / Timeout / Soft-ban / Clear / Prune (permaban). Each batch action chains the EXISTING single-user call (mod.addMod/removeMod for OP, mod.action for state, mod.permaban for prune), prompting once for shared duration/reason, with a confirm gate on the irreversible prune.
- **Mod/OP from the roster:** every row has a mod/unmod toggle; the mod-set is cached (renderMods rebuilds it and re-renders the roster) so badges + toggle labels stay live. A name/ID filter box narrows long rosters.
- Verified structurally (panel has no harness): panel <script> passes node --check, the old rosterBody id is fully replaced by rosterList with no orphan reference, and the four batch call() targets all pre-exist bootstrap-side. Engine/bridge/bootstrap untouched (only header/VERSION bump); suite 68 green as a sanity check; audit clean.

### Shipped in v0.61.0 (goal objects: prospective memory, the first cognitive-evolution step)
From RESEARCH-COGNITIVE.md (the synthesis of the two uploaded cognitive-architecture briefs): the standout next evolution, built almost entirely by PROMOTING existing parts — no new per-message LLM call on any path. Promotes the per-channel fading `intent` string into first-class, CROSS-CHANNEL goal records (the brief's “goals survive restarts / deferred execution / future commitments”, instructions-2 Phase 7).

- **Data:** `goals` key (cross-channel, like roster:index — a goal is hers everywhere), bounded list (40, closed-oldest evicted): {id, text, owner, ownerName, channel, createdAt, lastTouchedAt, status, source}.
- **Detection rides the EXISTING reflection pass** — the page-side reflect instruction now also surfaces one forward-looking commitment as a `GOAL:`-prefixed line; the engine's insight-ingestion loop peels those into goal records (owner = the reflected person) while ordinary insights stay insights. Zero added LLM calls, zero added cadence — goals are a byproduct of reflection she already runs.
- **Recall rides the assembler** (a goals provider in the RECALL band), OWNER-SCOPED by construction: she only ever surfaces a goal to its owner — never kai’s goal to mo. Cross-channel + owner-scoped together = the goal follows the person across channels but never leaks. Harnessed both directions.
- **Follow-up rides the check-in scheduler for free** — because v0.57 made check-ins ride the assembler with the absent friend as the addressed person, a check-in for someone with a goal already carries the goal line, becoming “how’s that project going?” with no new code. Deferred execution, gratis.
- **Commands:** `!chloe goal <text>` (set your own), `goals` (yours; mods see all, with ids + ages), `goal done|drop <id>` (owner or mod). Lifecycle: lastTouched bumps on recall/mention; lazy auto-drop after goalStaleMs (30d) untouched — goals fade if the world moves on. Erasure fan-out joined (forget/block/permaban drop the person’s goals, like episodes + trust).
- Default ON; `goalObjects:false` escape hatch; toggle + About + README command-table entry. Suite 68 green (golden untouched: no golden case has an addressed person with a goal, so the provider returns null across all 7). One assumed helper (getUserName) didn’t exist — caught at node --check, replaced with the partition name read.

This is step 1 of the cognitive synthesis’s recommended order. Next: idle consolidation (“sleep” — dedup/merge facts + compress episodes during the lull the detector already sees), then a light event-graph over episodes. The synthesis’s honest NOs (debating multi-agent workspace, stigmergy, full active inference) remain constraint-blocked by the 5000-token / ~6 tok⁄s / one-brain envelope and are documented as such.

### Shipped in v0.60.0 (UI refresh: activity feed center, modules over tabs, status bar, soft dark)
Full presentation-layer restructure per the uploaded brief (calmer, observation-first; IRC/Obsidian/devtools, not SOC/dashboard). Engine/bridge/bootstrap UNTOUCHED — panel-only. Decisions: full restructure, soft-dark base, feed-data my call. Verified structurally (no harness for the panel): every pre-refresh byId target and call() target still resolves (69 + 55, zero lost), all six panes intact, panel <script> passes node --check, audit clean.

- **Activity feed is now the primary surface.** Data source decision: re-render the EXISTING log stream — the engine already emits every meaningful action through log() with a [chloe.X] tag, so the feed is a pure presentation transform at the panel's log() boundary (classify by tag → typed timeline event: RECEIVED/MEMORY/THINKING/RESPONSE/MODERATION/IMAGE/POLL/ABANDON/WARNING/SYSTEM, each icon-less but state-colored). Zero engine changes, zero new plumbing, full behavior coverage because every path already logs. Ring-capped at 200 rows.
- **Modules over settings tabs.** The six tab panes (Setup/Behavior/Moderation/People/System/About) became a right-rail module list with state dots; clicking one opens its config in a slide-over (scrim + Esc + Close) instead of a permanent tab. The pane bodies moved VERBATIM into the slide-over — every id, listener, and call() reparented untouched. First-run auto-opens Setup so a new user isn't facing an empty feed.
- **Status bar replaces scattered reads:** one strip — online dot, bridge/token/bot, brain latency (from the v0.54 meter snapshot: ms / 'down' when the breaker's open / 'warming'), workers (queen-only), last poll — all from the SAME status + bridge.status polls already running.
- **Collapsible Debug** (collapsed by default) holds the raw verbatim log + reset; the old duplicate log card (a second id=log, a latent conflict) was removed in the process.
- **Visual weight cut:** soft-dark base (#0f1117), ONE surface elevation, no gradients, the radial dot-pattern and purple accent retired, hairline dividers, color = STATE only (green active / amber warn / red attention / blue selected). Light mode kept as a restrained prefers-color-scheme fallback. Retired the Chakra Petch display font (system sans for chrome, mono for feed/debug).
- DSL traps honored throughout (no braces in HTML body; entities pre-decoded; audit's brace scan + CSS balance + node --check all clean). DESIGN-ui-refresh.md captured the plan and the verification contract.

### Shipped in v0.59.0 (commit-point revalidation: while-if-true abandonment on every slow path)
Operator framing: logic should re-check its premises and ABANDON when the world changes (new input, moderation, expiry) rather than committing on stale data. Audit found the system already abandons well at the EDGES (deferGen kills zombie chains, run-lock skips polls, adaptive timeout + breaker drop brain calls, poll/procmode expire lazily) but almost nothing revalidated at the COMMIT point: every multi-second AI generation captured its premises at START and committed at END regardless of what moved between. Mined into one principle — *every slow operation re-checks its premises at the moment of commitment, and abandoning is cheap* — applied to all five generation paths (suite 67 green; the lull/check-in/greet harnesses staying green proves no FALSE abandons):

- **Replies** (`revalidateReply`, the shared gate): before the send, re-check the generation epoch (stopped/demoted engine → leave the pending record for the successor, NOT a double-send), supersession (a newer message from the same author mid-generation → drop the stale answer and CHAIN to the new one), lockdown engaged mid-generation (🔒 indicator), and author moderated mid-generation (silence). Harnessed all four; the engine-stopped case makes the Gap A handover airtight (no commit + record survives).
- **Lull filler:** re-reads the rhythm key before sending — if the room WOKE UP on its own while she composed, the silence she was filling is over, so she stays quiet. The worst stale message in the system, now impossible.
- **Check-ins:** re-reads the friend's partition — if they came BACK mid-composition, the “haven't seen you in a while” is abandoned with no attempt counted and no gaps touched (the premise vanished, so does the bookkeeping).
- **Greetings:** re-check suppression — moderated-mid-hello → no greeting.
- **Images** (the ~14–60s paint, the longest stale window in the system): re-check author state before delivery — a fox drawn for someone blocked mid-paint is abandoned, not delivered.
- The epoch check (`deferGen`) does double duty as the engine-liveness signal on every path, so stop()/demote abandons in-flight work uniformly. bridge.js + nonce de-dup re-confirmed clean from v0.58.

One test-not-engine note: the supersede assertion first checked a mock's content echo (mock-dependent); corrected to the verifiable invariant (the reply-reference targets the newer message).

### Shipped in v0.58.0 (wider-net legacy pass: page templates · sweep latency · embed gates)
Second integration audit, wider scope (bridge.js, all page templates, the gate layer). bridge.js and the nonce de-dup came back CLEAN (bounded, pruned). Six findings fixed (suite 66 green incl. golden):

- **Double-render I introduced in v0.57:** routing check-ins through the assembler made the PERSON band carry her facts — while the page still rendered the bespoke `summary` line. Her memories of you appeared TWICE in one prompt. Page now skips the bespoke line whenever assembler context is present.
- **Greetings and recaps ignored the assembler** (same lag class as v0.57's check-ins/beats): both nest the assembled context as `ctx.recent` but rendered only the transcript from it — mood, time, procedural modes, and the channel arc were dropped on the floor. Both templates now render `ctx.recent.injections`. Every AI template on the page now honors the soft context. (Judge already rode the assembler directly — audited clean.)
- **Activity-aware reaction sweep:** the fixed every-6th-poll sweep meant a 🗣️ summon could take up to ~3 minutes to land at the slow polling ceiling. Reactions cluster seconds after fresh messages, so the sweep now ALSO runs on the poll right after one that ingested — harnessed: sweep fires one poll after activity, and the next quiet poll does NOT (no fetch storm; quiet rooms keep the cheap cadence).
- **Embed gate parity:** the output gates (links, channel-links, emoji) ran only on plain `.content` — an AI-written URL inside a recap embed description or a poll option walked straight past them (pings were already safe: allowed_mentions rides every send). `sendEmbed` now scrubs title/description/fields with the same `gateContent`, plus Discord's length caps.
- **Beats lacked turn-marker stopSequences** — the only AI template without them (a v0.3x lesson); a beat could ramble into fake `[[`… dialogue. Added, matching every other template.
- Two build notes, honestly: the page-edit script crashed twice on non-unique anchors (the greet preamble line also lives in RECAP — which is how recap's missing injections were FOUND: the collision was the clue) and once on an over-escaped regex; the safe-write discipline left the file untouched all three times, and all six page edits landed in one verified atomic write.

### Shipped in v0.57.0 (legacy integration pass: six lag points, two real bugs)
Operator ask: find systems lagging behind the rest, tie them in properly, patch legacy bugs. Evidence-first audit found six, all fixed + pinned in harnesses (suite 66 green incl. golden):

- **The v0.54 adaptive brain timeout was DEAD in production** — every one of the 11 brainCall sites passed a hardcoded timeout, silently bypassing the Jacobson meter since the day it shipped. All text-kind sites now pass none (the meter governs: 90s cold, srtt+4·rttvar warm, clamped 10–90s); `paint` keeps its explicit 120s — image latency genuinely exceeds the meter's clamp.
- **Stale summons fired on cold boot** (the v0.46.3 “cold start treats history as live” class, reborn in v0.56): a 🗣️ reacted while she was offline would summon a reply to a days-old message on the first sweep. `summonMaxAgeMs` (15m) age-guards by message timestamp; harnessed.
- **Extractor transcripts were unclipped**: 40 lines × up to 1900 chars ≈ the entire 5000-token request ceiling. `recentTranscript` now clips each line to 240 chars — one fix covers facts, channel-summary, episodes, and reflection inputs; harnessed with a 2000-char wall message.
- **Check-ins and beats never joined the v0.50 assembler** — bespoke legacy context meant an active procedural mode, room mood, time awareness, and the channel arc were all IGNORED by proactive messages. Both now ride `assembleContext`; check-ins pass the ABSENT FRIEND as the addressed person, so her facts, insights, and trust tier arrive via the PERSON band for free. Page templates render the injections (backward compatible: old engines send none → byte-identical prompts). Harnessed end-to-end (a real provider line inside the check-in ctx) — and the first assertion draft was WRONG, not the engine: `injections` attaches only when non-empty by contract (the page's legacy fallback depends on absence), so the test now proves a real line flows instead of demanding an empty array exist.
- **Command acks were plain sends** — a lone ack now reply-references its command (multi-ack batches stay plain: one send can't reference two messages); harnessed.
- **`lastReplyAt` was an unbounded per-author map** (the v0.46.3 in-memory leak class) — bounded at 300 with oldest-first eviction.

### Shipped in v0.56.0 (reactions as an input channel: summon · polls · reply references)
Operator ask: a way to invoke a reply WITHOUT sending more text (reaction-based, monkey-see-monkey-do with her own emojis), reactions used in more systems for passing information, small games, and a survey of other Discord affordances (RESEARCH-DISCORD.md):

- **Reply references (clarity).** Her text replies now attach natively to the message they answer: `message_reference` with `replied_user:false` (the reply itself never pings) and `fail_if_not_exists:false` (deleted target degrades to a plain send). `cfg.send` grew an opts arg — backward compatible; `replyReference:false` escape hatch.
- **Reaction summon (opt-in toggle + About).** The AUTHOR reacting to their OWN message with one of her own indicators (🗣️ ❗ 🤖 — deliberately NOT ❤️: hearts are warmth and casual) makes it an explicit address through the NORMAL reply pipeline; mods can summon her onto anyone's message. A summon is a request, never an override — harnessed: lockdown holds (with the 🔒 indicator), quiet moderation stays quiet (a soft-banned summoner gets nothing, not even a reaction), bystander reactions don't count, one summon per message, her own messages can't be targets. Completion-chained, so a summon answers at generation speed.
- **Reaction polls (mod command).** `!chloe poll <q> | <a> | <b> […]` posts a ballot embed, seeds 1️⃣… number reactions, one active poll per channel; `poll close` (or auto-close after pollMaxAgeMs 24h, checked lazily once per poll tick OUTSIDE the one-AI-pass ladder — my first placement was unreachable behind the affect rung, caught in self-review) tallies from the counts the message object already carries, subtracting her own seeds via `reaction.me`, and posts ranked results with the winner or a tie called out. New `transport.getMessage` + `cfg.fetchMessage` for ballots older than the recent window.
- **RESEARCH-DISCORD.md:** the leverage-ordered map of what REST-only can still do — threads (games + long answers without channel spam), webhook personas (anchored characters get their own name+avatar), edit-streaming (perceived-latency collapse via editMessage), native Discord polls (the upgrade path), pins, scheduled events — and the honest impossibilities: buttons/selects/modals can be SENT but their clicks only arrive via Gateway/webhook, so reactions stay our input channel; reaction latency is sweep-bound, which scopes games to turn-based (RPS + trivia recommended first, in threads).
- README: §Reactions gained the summon contract + reply-reference note; the command table gained `poll`. Suite 66 green (harness-summon, harness-polls).

### Shipped in v0.55.0 (reaction vocabulary: truthful status indicators + README §Reactions)
Operator ask: replace the ambiguous 👀 “seen you” with indicators that say WHAT she's doing or WHY she didn't answer, and document the vocabulary in the README like the command table. New scheme (all under the existing ackReactions toggle):

- **🗣️ generating your text reply** — placed at generation start (the v0.54 enqueue-time ack is reverted: queueing alone places nothing; the indicator now means “speaking NOW”, not “noticed”). **🖼️ painting** replaces 🎨 (image queue numbers unchanged). **🔍 looking something up** — wired onto `recap` (the command context now carries the triggering messageId so handlers can ack).
- **Why-not indicators, auto-clearing (ackClearMs 30s):** ⏳ = saw you but throttled — placed on per-author-cooldown skips and send-budget denials, hands over to 🗣️ when the turn comes; 🔒 = mods-only lockdown, placed only on messages that actually ADDRESS her. **Deliberate scope:** no indicator for quiet moderation (ignore/softban/block) — reacting would announce it; only benign, temporary, or already-public reasons get a reaction.
- README gained a §Reactions table (what she places AND what she reads: 📌 persona anchor, mod mode rules, the positive set feeding relationship warmth) mirroring the command-table treatment.
- harness-dispatch-chain rewritten to the new semantics + two new scenario blocks (⏳ throttle with WHY + self-clear; 🔒 on the addressed message only, bystanders untouched). Suite 64 green.

**Also this cycle:** the surrogate bug class bit a THIRD time — my edit script's comment strings contained split-surrogate emoji and truncated engine.js to 0 bytes in place (restored from the verified delivered copy; `node --check` passes VACUOUSLY on an empty file — noted). All source edits now follow the roadmap_update discipline: encode-check before any file opens, temp-write + fsync + atomic os.replace, never truncate-in-place.

### Shipped in v0.54.0 (round-trip awareness: completion-driven dispatch · queue acks · brain telemetry + breaker)
Operator ask: know when the Perchance backend COMPLETES so the next request fires sooner; queue text like images with the emoji-ack treatment; hunt other waiting-on-round-trips. Investigation found replies and images were POLL-BOUND (a finished generation idled up to a full poll tick before the next queued job started), queued-but-waiting authors got no ack at all, and the typing indicator (~10s on Discord) went cold during long generations. RESEARCH-ADAPTIVE.md + DESIGN-roundtrip.md:

- **Completion-driven dispatch.** New host hook `cfg.defer(fn, ms)` (engine purity preserved — injected like clock; harnesses inject a manual queue). Every text/image terminal schedules the next kick at the earliest legal moment (remaining courtesy gap only). Both targets fully self-gate, so chaining is safe by construction; queues now drain at GENERATION speed — harnessed: three queued replies, three sends, ZERO additional polls. `deferGen` invalidates outstanding chains on stop()/demote (no zombie work). No defer hook ⇒ byte-identical legacy behavior.
- **Enqueue-time acks.** 👀 lands the moment a message is QUEUED (everyone knows they're seen), cleared at terminals; superseded entries (newer message, image-over-text) hand their ack over. Deliberate non-parity with image queue NUMBERS, documented: the reply queue is PRIORITY-ordered (DM > mod > ping), so place-numbers would lie as the line reorders — a steady 👀 is honest.
- **Brain telemetry + circuit breaker.** `createBrainMeter()` (pure, module-level, harnessed): per-kind Jacobson estimation (srtt + 4·rttvar → adaptive timeout clamped 10–90s — a ~12s respond kind earns a ~17s timeout instead of the blanket 40s) and a breaker: 3 consecutive TRANSPORT failures → OPEN (instant-fail with a clear reason; the poll loop stays snappy through a dead page) → one HALF-OPEN probe per 30s window → success closes. A brain that ANSWERED {ok:false} is breaker-SUCCESS (the wire works). Wired around the single brainCall funnel; per-kind stats in `status.brain`.
- **Typing keep-alive.** Re-typing every 8s while a generation is in flight; silent no-op after terminals.

Root-caused during the build (trace, don't patch): chains were first gated on `running`, forcing harnesses through start()'s REAL poll timer — replaced with the deferGen generation counter; the harness's zero-acks came from the un-set `ackReactions` gate, and its “chain delay” filter was catching the 8000ms typing keep-alive. Suite 64 green.

**Also this cycle (pipeline, the hard way — second roadmap loss):** the v0.54.0 roadmap script crashed on a UnicodeEncodeError (an emoji written as SPLIT SURROGATE HALVES in a heredoc) AFTER opening ROADMAP.md for writing — truncating it in place; deliver.sh then copied the 0 bytes (it verified size MATCH, not size SANITY). Recovered by replaying the entry scripts verbatim from session transcripts. Class killed: `roadmap_update.py` (the only sanctioned entry path — entry from a real UTF-8 FILE, built in memory, temp-write + fsync + size-verify + atomic os.replace; the original is never opened for writing), and deliver.sh v2 (refuses empty sources and catastrophic shrinks).

**Designed, building next (DESIGN-roundtrip.md §E + RESEARCH-ADAPTIVE.md):** the pace core — per-channel Jacobson estimation over inter-message gaps feeding rhythm-relative debounce, AIMD polling, z-score quiet detection, and time-floored AI-pass cadences. Later clusters: FSRS-lite retrieval-strengthened memory; habituation + leaky volunteer; foraging give-up.

### Shipped in v0.53.0 (Gap A: reply resumption with a no-double-send gate)
The last open item from the failover audit. A TEXT reply that was mid-generation when a queen died is no longer lost — and can never be doubled:

- The instant a reply job starts, `pending-reply:{ch}` ({messageId, author, content, priority, at, runId}) persists to the shared store; it is cleared at EVERY terminal (empty generation, send success, error).
- On `start()`, a successor consumes any record (resume-once — deleted BEFORE acting; if this attempt also dies, ITS run's record covers the next resumption). Resumption is age-capped (10 min — a stale answer is worse than silence) and gated on a VERIFICATION fetch: any bot-authored message with a snowflake newer than the target means “assume answered” — which deliberately also covers the send-then-crash window, because her just-sent reply IS a bot message after the target. No `recentFetch` hook → never resume unverified. Verified-clean → the record re-enters `reply.queue` at its original priority and the NORMAL pipeline (budget, gates, cooldowns) takes it from there.
- **The asymmetry is the design:** every double-send path is gated; some legitimately-resumable replies are dropped (e.g. she answered someone ELSE after the target). Correct side to err on. Images stay fire-and-forget (decorative; documented acceptable loss).
- Default ON (`replyResume: false` escape hatch) — correctness class, like the run-lock. `harness-reply-resume.js`: happy path leaves no record; crash mid-generation → successor resumes exactly once; bot-message-after-target blocks; stale dropped; unverifiable dropped; escape hatch. Suite 62 green. (The harness's own crash simulation initially awaited a poll that by design never resolves — fixed to fire detached.)

**The failover audit is now fully retired:** every lifecycle transition handled + tested, Gap B fixed (v0.47.3), handshake election (v0.48.0), run-lock (v0.52.0), Gap A resumption (v0.53.0).

### Shipped in v0.52.0 (engine run-lock: the hard close for the two-queen polling window)
The twice-deferred correctness sub-system from FAILOVER-ANALYSIS.md §6, now designed exactly and landed:

- Before EVERY poll the engine must hold `runlock:{ch}` in the shared per-channel store ({id, at, nonce}). A non-holder **skips the poll entirely** — no cursor read, no fetch, no sends (summary carries `lockSkip`; throttled log explains why). Claiming writes then READS BACK the nonce, so two engines grabbing a stale lock in the same instant resolve to at most one proceeding (the tab-lease trick, applied at the engine layer).
- **The TTL inequality that makes it safe (45s):** < queenDeadAfterMs (90s) so a frozen queen's lock is guaranteed stale before any worker can even promote — a corpse never blocks the successor; and > any healthy poll cadence so a live queen never loses its own lock between renewals (every successful acquire renews). Wake sequence: frozen queen stops renewing → worker promotes ≥ 90s later onto a stale lock → old queen wakes, sees a FRESH foreign lock, skips (cursor untouched) → the v0.48.0 handshake demotes it. The two-queen POLLING window is closed even while the two-queen TAB window briefly exists.
- `stop()` releases the lock if held, so a clean demote hands over instantly (no TTL wait). Default ON — a correctness lock, not a behavior feature; `runLock:false` is a debugging escape hatch.
- `harness-runlock.js`: solo claim+renew; intruder skips with ZERO side effects; stale takeover; the wake scenario; same-tick contention resolving to exactly ONE poller; instant clean handover; the escape hatch. Suite 61 green incl. golden — the lock is invisible to every single-engine path.
- Residual risk stated honestly in FAILOVER-ANALYSIS.md: GM propagation isn't transactional; the read-back bounds the worst case to one overlapping poll cycle (rare, idempotent-leaning), versus minutes of unbounded double-polling before.

This retires the last structural item from the failover audit. Still open there: Gap A (mid-generation reply lost on queen death — needs persisted intent + no-double-send resumption).

### Shipped in v0.51.0 (first wave on the keystone: episodes · trust · own affect · procedural modes)
The four DESIGN §7 systems, each a data-store → background-pass → provider unit on the v0.50.0 assembler, each default-off with a Behavior toggle + About doc + dedicated harness (suite now 60 green):

- **Episodic memory (§7a, RECALL band).** Gated extraction turns recent activity into short EVENT records ({text≤120, topics, participants, importance}, ring cap 40/channel, `epi:{ch}`); the page extractor refuses sensitive categories like facts. Recall = keyword-overlap × importance × 7-day-half-life recency, top-2, injected ONLY when the conversation relates (zero cost otherwise — harnessed both directions). `forget me`/purge erase episodes the person took part in, including the moderated branch.
- **Relationship trust (§7b, PERSON band).** `p.trust` 0–100, earned ONLY through positive signals: +1 per completed reply, +2 per positive reaction on HER message (attributed via the bounded `getReactions` fetch — her messages, positive set, increased counts only), daily cap 5, absence decay alongside familiarity, reset by forget. Tier-phrased tone hint (the number NEVER appears) + the new-user-sized priority tiebreak. Mods always outrank trust; never penalizes; never touches moderation/gates. Found+fixed in review: the crediting promise was fire-and-forget — split scoreMessageReactions out and JOINED the chain for deterministic sweeps.
- **Own affect (§7d, AMBIENCE band; reordered before §7c — self-contained).** {curiosity, confidence, warmth}, front-end only: positive reactions on her messages lift confidence+warmth; engagement within 10m of her reply lifts confidence; 30m of silence after she speaks lowers it to a HARD floor (0.3 — quieter, never despondent); vocabulary novelty lifts curiosity; everything relaxes toward neutral (0.8/hour). Provider: silent near neutral, whitelist phrasing with the never-state-it guard, self-demotes −5 when room mood reads quiet (visible in injectionMeta).
- **Procedural modes (§7c, DIRECTIVE band).** Operator-defined emoji→mode rules (panel JSON-textarea CRUD matching the auto-mod convention; bootstrap validates+caps: ≤12 rules, mode≤100ch, ≤1d). Only a MODERATOR's reaction triggers (modOnly fixed v1 — reactions are unauthenticated input); persona-note sanitation; lazy clock expiry; `!chloe mode` (anyone) / `mode clear` (mods); the injected line carries the it-never-changes-your-rules guard. The audit caught a brace parser-trap in the panel placeholder during the build (entities don't dodge the platform's pre-decode scan) — fixed with a brace-free placeholder.

With this, the GAP-ANALYSIS Tier-B first wave chosen by the operator is fully landed on the validated keystone.

### Shipped in v0.50.0 (keystone: prioritized context assembler)
The approved DESIGN-context-assembler.md keystone, executed in full with golden-parity discipline (PLAN-context-assembler.md):

- **Assembler core:** one provider registry + one budget policy inside the engine. Providers are pure ({id, priority, enabled(cfg), gather(gctx)}); failures are isolated to a logged null (a broken provider can never take down the reply path); admission is greedy by priority under the 5000-tok whole-request budget with whole-injection drops (every drop logged) and a hard transcript floor; admitted lines render ASCENDING so the highest-priority text lands LAST, nearest the generation point. Seven bands: IDENTITY 90 / DIRECTIVE 80 / PERSON 70 / RECALL 60 / SITUATION 50 / AMBIENCE 40 / HYGIENE 30. `harness-injections.js` (13 assertions).
- **Golden parity contract:** `harness-golden-context.js` + `golden-context.json` freeze every soft-context field + budget accounting across 7 toggle matrices, captured BEFORE the refactor and green after EVERY step — including the final state. The capture step itself caught two harness bugs (intent seeded past its 30-min TTL; wrong field names) before the contract froze.
- **Six slot-line conversions** (time, mood, channel-summary, intent, highlights, person-summary): each provider renders the page's exact line template, reports the LEGACY token figure, and dual-emits its legacy ctx field via gctx.legacyOut so the page worked unmodified throughout. Converted one at a time on a verified-inert flattened scaffold; golden + full 56-harness suite green after each.
- **DESIGN §4a scope finding:** persona note (identity preamble) and anti-repeat (post-transcript craft guidance) are template-STRUCTURAL, not slot lines — they keep their positions + inline accounting; band seats reserved for v2.
- **Page slot switch:** respond() now renders `ctx.injections` at the soft-context slot (the designed ascending reorder — intent now sits nearest the transcript), with the legacy per-field lines kept as fallback for older engines; engine keeps dual emission for older panels (one-version deprecation both directions).

Shipping decision: the keystone ships ALONE so the refactor validates in production before the first-wave systems (episodes, trust, procedural modes, own affect — designed in DESIGN §7) land as v0.51+.

### Shipped in v0.49.0 (Tier-1 memory cluster: importance · rolling summary · reflection)
The three reinforcing memory upgrades from RESEARCH-IMPROVEMENTS.md (Generative Agents + SillyTavern patterns), all opt-in/default-off, gated AI passes, harnessed:

- **Fact importance (poignancy).** The facts extractor now emits `{t, i}` with a 1–10 importance per fact (tolerant of bare strings; old facts default 5). `addFacts` stores it; `factSummary` ranks by importance + mild recency instead of recency-only — so a trim keeps what's CENTRAL to a person, not just what's newest (harnessed: a 9-importance older fact survives a flood of 1-importance newer ones). Importance also feeds the reflection accumulator. Rides the existing factMemory toggle.
- **Rolling channel summary.** Every `channelSummaryEveryPolls` (30) polls, fold the recent transcript into a running ≤`channelSummaryWords` (60) summary, feeding the PRIOR summary back in (recursive, SillyTavern-style) so the channel's arc accretes past the raw context window. Stored at `chansum:{ch}`; injected token-accounted as one soft line ("the story so far"). Cadence uses the (every−1) form — fires on the Nth poll, never the first (cold-start backlog). Behavior toggle + About doc. `harness-channel-summary.js`.
- **Reflection.** When a person's accumulated fact-importance crosses `reflectionImportanceThreshold` (20), one synthesis pass turns their facts (+ prior insights) into 1–2 durable higher-level insights, stored on the partition (archive/restore free, capped 3), accumulator reset even on empty results. Insights LEAD the person-summary above raw facts. Page `reflect` extractor grounds insights strictly in given facts, refuses sensitive categories. Behavior toggle + About doc. `harness-reflection.js`.

**Also this cycle (pipeline + recovery):** ROADMAP.md was zeroed by a write race — reconstructed from the operator's recovered v0.28-era copy + session records (see reconstruction note). Patched the class: `audit.py` leads with a critical-file integrity check; `deliver.sh` replaces blind cp with size-verified copies. (And this very entry initially failed to insert because an idempotency guard matched the bumped header version instead of the entry heading — caught by size-verification, guard fixed to match the heading.)

### Shipped in v0.48.0 (explicit, capability-aware handshake election)
Front-ended the queen/worker election with a real handshake: every tab broadcasts `hello` ({role, hasPage}) on start; the queen answers with a capability-bearing `ping` (newcomer discovers the queen in ONE round-trip); workers answer `here` so a fresh queen learns its pool immediately; a second-started queen stands down in a round-trip via queenConflict. `rankDelay` is now capability-preferential — a page-having tab claims the lease sooner, so the natural queen is the tab the user is looking at. New `queenHasPage()` / `capablePeers()` / `hello()` API. Shrinks (does not fully close) the sleep/wake two-queen window; hard close = the deferred engine run-lock (FAILOVER-ANALYSIS.md).

### Shipped in v0.47.3 (failover audit + Gap B: page-less workers swallowed brain calls)
Full lifecycle audit (FAILOVER-ANALYSIS.md). Fixed Gap B: dispatchJob only fell back on a REJECTED job, but a page-less worker RESOLVED `{ok:false, no control page}` — a successful-looking empty answer — silently dropping the reply/paint. Fix: workers advertise page-capability (capable() → hasPage) in register/pong and the queen routes brain jobs only to page-capable idle workers; the worker brain handler now REJECTS without a page so the local fallback fires. Deferred + documented: Gap A (reply mid-generation lost on queen death) and the sleep/wake two-queen polling window (engine run-lock).

### Shipped in v0.47.2 (fix: worker-role tab capture — a likely banner contributor)
`onDemote` wrote `location.hash = '#chloe-worker'` into the tab URL whenever a tab lost the election; since the userscript matches all of perchance.org, every non-queen perchance tab got stamped, and the hash is STICKY (TAB_ROLE reads it at load) — so the generator itself could boot as a worker that answers status but can never start the engine ("present but dead", and the two-cursors seen in logs). Fixes: onDemote never touches the URL (role is in-memory; only deliberate spawnWorker sets the hash); self-heal — a worker-roled tab that receives a page message strips a stale hash and contests the election via new `tabBridge.standForQueen()` (promotes if no live queen, backs off if one exists); harnessed incl. a bridge purity check (bridge.js never references location/URL).

### Shipped in v0.47.1 (archive-boundary race/durability fixes)
(A) restoreFromArchive deleted the COLD copy before the hot write landed → crash mid-restore lost the user's history; now hot-write + re-index FIRST, delete cold last (worst case a harmless duplicate). (B) Restore was gated on `archiveStale`, so toggling archiving off stranded returning users as empty "new" partitions while cold data lingered (split-brain); restore is now unconditional — archiveStale only gates CREATING archives. (C) purge/block never cleared the archive → blocking an archived user left their cold record (incomplete erasure, and the novelty check would cite it); added dropFromArchive(id) into purge. Audited clean: sweep-after-ingest ordering, single decay-on-return, index hygiene, reaction-sweep cursor safety, JSON degradation, no stuck reply/paint flags.

### Shipped in v0.47.0 (response priority + surface-aware novelty)
**Priority:** replyPriority with order-of-magnitude weights — DM lane (1000) > mod (100) > @-ping (10) > new-user tiebreak (1) > casual name-drop (0); processReply selects highest-priority settled author (oldest as tiebreak) instead of FIFO; the cross-channel send budget became priority-aware so a DM preempts a regular channel's slot. **Novelty (bug fix):** "new" was decided from hot roster + archive only; added knownFromOtherSurfaces(id,name) checking the MOD LOG and BLOCKLIST/tombstones before calling anyone new — a previously-moderated or purged-but-banned user reads as returning, not a first-timer (affects greetings + the priority bump). KNOWN LIMITATION: per-channel store namespacing means cross-CHANNEL novelty (known in A, new to B) needs a bootstrap-level shared index — not addressed.

### Shipped in v0.46.3 (startup observe-only hardening + Reset State completeness)
Generalized the v0.46.2 image-flood class ("cold start treats history as live"): auto-mod no longer re-moderates backlog; old !chloe commands don't replay (EXCEPT image, which keeps the 5-recent clamp); stale @mentions in backlog get no reply; reaction auto-highlights skip the backlog; lull/check-ins/beats respect a startup settle (reusing the greeting settle) so "it got quiet" isn't fired about the bot's own downtime; Reset State now clears the FULL per-channel key set incl. archived users (was leaving mood/intent/reminders/afk/highlights/reacttally/lull/checkins/beats/arch behind). Critical refinement (root-caused after 19 harness failures): a backlog is signalled by SIZE — startupBacklogThreshold (8) so a fresh channel's first live messages behave normally; warm restarts never clamped. Bounded reactionSeen + afkNoticed maps (slow leaks).

### Shipped in v0.46.2 (fix: image-gen flood on startup / after Reset State)
Cold start = empty cursor → first poll pulls a history backlog → every image request fired at once across all channels. Per-channel startup clamp: the first cursorless poll restricts image gen to the startupImageMax (5) most-recent USER messages; older backlog ingested but never painted; normal behavior resumes next poll; warm starts never clamped. Gates BOTH image sites (!chloe image + auto-request) via mayPaint(m).

### Shipped in v0.46.1 (fix: Validate Token threw — a v0.45.1 regression)
The fan-out de-dup replied to duplicate request copies with `{ok:true,value:null,dup:true}`; the page resolves on the FIRST reply, so the fake success could beat the real result → panel read res.value.username on null. Three-part fix: duplicates dropped SILENTLY (only the first copy replies); panel guards res.value; validate() guards a null/identity-less getMe. Locked in harness-origin.

### Shipped in v0.46.0 (disabled the false 'not detected' banner + G6 mood)
Banner disabled per operator call after two unverifiable fix attempts (logs showed the OLD build still running — line :3135 unchanged — so the fixes were never exercised); kept a quiet dot (green linked / amber waiting), brain calls are ground truth. **G6 mood:** front-end room-tenor read on two SAFE dimensions — energy (quiet..buzzing) + playfulness (subdued..joking) — from pace + lexical signals; decayed blend (moodDecay 0.7); deliberately NO anger/conflict dimension; soft tone guidance ("match the energy, don't name it"); off by default.

### Shipped in v0.45.1 (fix: 'not detected' banner — status ping lost in frame topology)
Bot fully worked but the page's status ping died: the panel posted ONLY to window.top, which in Perchance's embed can be the outer shell frame while the userscript listens elsewhere; brain calls worked because they're userscript-initiated. Fix: postToHosts() fans every request to window.top + window.parent + the frame chain with both the perchance origin and '*'; nonce-matched replies make duplicates harmless; userscript de-dupes inbound nonces. [The de-dup reply introduced the v0.46.1 regression — fixed there.]

### Shipped in v0.45.0 (G5 time awareness)
timeContext() derives part-of-day / day-of-week / weekend / quiet-duration from the clock + timezoneOffsetMins (panel input, clamped ±14h); rides into reply + lull context as soft guidance; off by default.

### Shipped in v0.44.1 (fix: false "userscript not detected" in sandboxed embeds)
Sandboxed iframes report postMessage origin "null"; ORIGIN_OK now accepts it; replyTarget maps null→'*'; 2-miss banner hysteresis; harness-origin.js.

### Shipped in v0.44.0 (F1 fact memory + panel fixes)
Per-user facts[] on the partition (archives/restores free); gated silent extraction processFacts (one due regular per pass, factMinInteractions 4, gap 1d, every 12 polls); page facts(ctx) extractor REFUSES sensitive categories, JSON-array primed; populates the previously-empty summary hook in reply + check-in context; !chloe aboutme / forget <words> / forget. Panel: text-align fix vs host-page centering; escaped curly braces in <code>; audit gained an HTML-body brace scan.

### Shipped in v0.43.0 (give-up + data tiering)
Check-ins cap at checkinMaxAttempts (2, ~28d) then archive the user; historical-friends archive (arch:{ch}:u:{id} cold keys + arch:index); quietSweep archives long-cold users with favorite-aware thresholds (archiveAbsenceMs ~60d + favorite bonus); restore on return in ingest (zero hot-path cost); emergent: returning friend's T5 decay softens familiarity (intended).

### Shipped in v0.42.0 (lull recalibrated to days + favorite check-ins)
Lull window moved to DAYS (Discord ≠ Twitch). processCheckin @mentions an absent favorite (interactionCount≥8, absent≥3d); per-user gap ~14d, global ~1d; pings only if the gate allows.

### Shipped in v0.41.0 (lull filler)
Neuro-sama PATIENCE pattern: proactively break silence after an active room goes quiet; gated; mod opt-in.

### Shipped in v0.40.0 (size-relative reaction significance)
Threshold = max(reactionMinUsers 2, ceil(memberCount × reactionFraction 0.01)); significant top reaction → tally + auto-highlight; idempotent (acts only on INCREASED counts); member count auto-detected (GET /guilds/{id}?with_counts=true); reaction sweep every 6th poll re-fetches recent 30.

### Shipped in v0.39.0 (E1 highlights)
!chloe highlight/highlights/highlights clear (mod-only clear); reply-capture via referenced_message, quoted text, or bare; a few recent highlights ride in context (token-accounted, cap 50/3).

### Shipped in v0.29.0–v0.38.x (reconstructed, condensed)
Agentic observe/act split; global send budget ("one voice, many eyes"); bot-loop damper; fast ack reactions 👀/🎨; image-queue place-in-line reactions; standing intention (INTENT:); whole-request 5000-tok chunker (operator-confirmed real ceiling, vs the docs' 6000); AICC turn-marker stopSequences; !chloe image {json}; local volunteer pre-filter; poll-driven reminders; AFK. (Full per-version detail for this stretch was lost with the original file; the feature set above is complete and live-confirmed.)

### Shipped in v0.28.0 (a batch of fixes + safety features from real-session logs)
- **DM sessions (two-way DMs).** Any DM Chloe opens registers as a pollable channel (`dmReplies` toggle); a DM channel runs with `addressMode:'always'` so she replies to every line without a mention. Cold inbound DMs remain Gateway-blocked (documented, not faked). `harness-dm.js`.
- **Permanent blocklist / tombstone.** `!chloe block @u` (and `unblock`) tombstones a user by id + username at a partition-independent key, checked at the top of `ingestOne` — a blocked user is never re-scanned or re-rostered again, and survives unrelated purges. Fixes the gap where `forget` left no tombstone. `harness-blocklist.js`.
- **Output gates (mod-toggleable).** Five independent toggles — emoji / pings / @everyone / links / channel-links — enforced at the single transport chokepoint. Pings use Discord's native `allowed_mentions`; the rest scrub outgoing content. Defaults: emoji on, the rest off. A jailbroken Chloe still can't mass-ping/spam/@channel without mod opt-in. `harness-gates.js`.
- **Persona NAME, not just style.** A pinned note that names a character makes Chloe answer to that name and speak as them in first person (parser + alias + prompt reframe). `harness-persona-name.js`.
- **Image prompt travels with the image,** sanitized for caption (mentions/mass-pings/links/markdown stripped, length-capped).
- **404 Unknown Channel self-heals.** A poll 404 pauses that engine via `onChannelGone` instead of spamming the log forever; dead DM channels auto-drop, guild channels warn. (This was the only Chloe-side error in the logs; the ~6,700 `.style` crashes were weld-companion operating on Chloe's frame — noted for the weld side.)
- **`allowed_mentions` on every send** (latent bug fix: captions/replies with `@everyone` could previously ping).


## Shipped (live-confirmed)
- **T0** read-only presence (poll → parse → per-user partitions → speaker ring → rhythm)
- **T1** reply when addressed (debounce + cooldown, Tier-C context)
- **T2** volunteer gate (deterministic pre-filter → AI judge, F4-safe ignore)
- **T3** reversible moderation (ignore / timeout / softban / clear / note; state gates *before* judgment; mod-list auth; `forget me` opt-out)
- **T4** irreversible permaban (human-confirmed ban → verified partition purge, F1 ordering, surviving modlog)
- **T5** presence depth (greeting tiers + cooldown + settling debounce, decay, lifecycle, 404 departure sweep, backfill)
- **Extras**: typing indicator, `!chloe recap`, page-side `[chloe-page]` diagnostics, adaptive polling, onPoll hook (fixes loop-bypass of page events + T5 maintenance), name aliasing (`chloe-bot`→`chloe`), greeting/reply de-dup, stable `@name` for clean Tampermonkey updates.
- **v0.9.0**: start-settling greeting guard (people already in the room at startup aren't greeted as arrivals; `greetSettleMs`) + per-author reply throttle (single pending slot → per-author queue, per-author `cooldownMs` + light `globalCooldownMs`, so one chatty user can't starve replies to others).
- **v0.10.0**: image generation. Ask her to "draw/paint ..." and the page generates via `text-to-image-plugin` (awaited `root.textToImagePlugin`, which runs the plugin's `$output` in the top-panel sandbox — the broker-iframe "song-and-dance" — and returns a `.dataUrl` across the bridge); the userscript posts it as a native Discord attachment to the channel/thread, or to a DM on request. Orientation→resolution, per-image cooldown, empty-prompt guard (an empty prompt hangs the plugin), text fallback on failure. `harness-image.js` pins it.
- **v0.10.1**: image gen corrected to run from the **top-panel DSL** (`paintImage` in `chloe-control-dsl.txt`) and hand the `.dataUrl` back via a shared-`window` Map — `.dataUrl` must be read inside the plugin's own scope before it crosses the `root` proxy.
- **v0.10.2 (code wins, mined from weld-companion + live logs)**: prompt hygiene — scrub all Discord tokens (user/**role**/channel mentions, custom emoji) + leading/trailing filler so the model gets "cat", not the raw `<@&role> , can you draw me a cat?` (live-log bug); storage hardening — `store.get` now try/catches `JSON.parse` so one corrupt key can't break a poll (weld `gget` pattern); clearer logging — image requests log as image, not "reply queued".
- **v0.11.0**: **command registry (#4)** — `KNOWN_CMDS` + the `execCommand` switch + `CMD_ACTION` + hand-written help collapsed into one declarative `COMMANDS` table (verb, modOnly, needsTarget, takesDuration, action|handler, help, optional aliases); `parseCommand`/`execCommand`/help all generate from it, killing the three-place drift and laying the groundwork for per-command throttle (#5) and emoji aliases (#10). Plus **context mention-scrub (#16)** — the Tier-C transcript and addressed message handed to the brain are now token-scrubbed, so she won't echo `<@123>` in text replies.
- **v0.12.0**: **per-command throttle (#5)** — `cooldownMs` per `COMMANDS` entry (recap 20s, help/status 5s), silently suppressed within the window (pump19 `Limiter`); moderation verbs stay unthrottled. **Auto-moderation (#6)** — optional, panel-editable rule list checked before reply/greet: types `text` / `regex` / **`confusables`** (Unicode homoglyph fold so "fr\u0435\u0435 nitro" can't dodge "free nitro"); first match halts → applies a **reversible action only** (ignore/timeout/softban — an irreversible rule action is downgraded, never an auto-permaban, F1); mods exempt; rules settable only from the trusted panel. `harness-commands.js` + `harness-automod.js` pin both.
- **v0.13.0**: **threaded image lane + real-world timings.** Text and images run on separate Perchance brokers, so the image lane is now **fire-and-forget** (`kickImage`) — a 15-30s generation no longer blocks the poll loop or text replies; the two proceed concurrently. Image timing is governed only by its **own clock** (`lastPaintAt`), fully decoupled from the text clock (`lastActAt`). Images use a **global FIFO queue** (`paint.queue`, depth `imageQueueMax`, default 8, adjustable in the panel 1-20) instead of a single latest-wins slot — bursts wait their turn instead of being dropped; one in flight at a time; overflow past the cap is turned away with a note. The per-image cooldown dropped from an artificial 30s ceiling to a 2s courtesy gap, since generation time itself (plus the one-at-a-time broker) is the real pace — no point gating shorter than, or stacking on top of, the actual generation time. `harness-image.js` extended with a deferred-paint queue test (FIFO drain + cap overflow). *Known follow-on:* the **text** lane is still awaited in-poll, so text replies to messages arriving mid-text-generation are briefly delayed; backgrounding the text lane too is possible but carries harness-timing risk and is left for later.
- **v0.14.0**: **lockdown + engagement mode (#7).** A single `engageMode` axis — `normal` (reply when addressed + volunteer gate), `locked` (raid panic: ignore everyone but mods, no greeting/volunteering, **auto-mod still runs**), `open` (reply to everyone in the channel — the stream toggle, addressing no longer required). Driven in-channel by mods (`!chloe lockdown` / `unlock` / `open`, with `lock`/`openchat` aliases) for mid-raid speed, or from a panel selector; command-driven changes persist through the `onPoll`→summary→`cfgSet` channel so they stick and the panel reflects them. `harness-engage.js` pins all three modes + authorization.
- **v0.15.0**: **emoji aliases + multi-prefix (#10).** The registry's `aliases[]` now carries emoji/short forms (🔒/🔓/📢 for lockdown/unlock/open, 📜 recap, 📊 status, 🆘 and `?` for help), and `commandPrefixes[]` lets extra prefixes like `!c` resolve to the same commands (matched longest-first so `!chloe` always wins over a shorter `!c`). Both editable from the panel. Built entirely on the v0.11.0 registry — no new command plumbing. `harness-commands.js` extended.
- **v0.16.0**: **mod-action context (#11).** `applyModAction` now logs *every* action (not just permaban) to the purge-surviving modlog, each entry carrying a snapshot of the target's most recent lines (`modLogContextLines`, default 5, scrubbed of Discord tokens) — so a mod reviewing the log sees what the person was actually saying, and auto-mod actions leave an audit trail tagged `auto`. The panel's Mod log renders the captured lines beneath each entry. Context stays in the mod-only panel, never posted in-channel. `harness-modcontext.js` pins it. *(The audit caught a `[auto]` panel parser-trap during this build — switched to `(auto)`.)*
- **v0.17.0**: **pinned transparency notice (#9).** A panel "Post & pin notice" button posts an editable disclosure and pins it (`transport.pinMessage` → `PUT /channels/{id}/pins/{id}`, needs Manage Messages). Idempotent — one-time unless re-pin is confirmed — with pinned state shown in the panel. Transport/panel only; no engine change.
- **v0.18.0**: **diagnostics trace ring (#17).** A 60-entry ring in the userscript captures link, transport, and poll events (origin rejects, HTTP errors + 429 back-offs, dispatch failures, compact per-poll lines tagged with the engagement mode); a panel "Diagnostics" button reads it via `diag.trace`, prints it, and copies it to the clipboard — so the link's timing-dependent failure modes are diagnosable after the fact instead of only live in the console.
- **v0.19.0**: **rich embeds (#8).** A `sendEmbed` path (`transport.sendEmbed` → POST messages with an `embeds` array) lets `help`, `status`, and `recap` render as Discord embeds — help as Mods/Anyone command fields, status as engagement/replies/images/auto-mod fields, recap as a titled body — with the plain-text ack kept as a fallback when the transport can't embed. Moderation acks stay plain text. `harness-embeds.js` pins both paths.
- **v0.20.0**: **scheduled proactive beats (#12).** Interval-based, heavily activity-gated time presence: a beat (`id` + `intervalMs` + `text`/`texts[]`/`prompt`) is seeded on first sight, then fires at most one per poll — only when the room has been active within a window (never into a dead channel), never during lockdown, never mid reply/image, with a global min gap. Last-run is persisted per-channel; beats are edited from a panel JSON editor. The engine's `prompt`+`beatFn` path is ready for in-character generation once a page `beat` brain handler is added; v1 ships fixed/random-`texts` beats. `harness-beats.js` pins the lifecycle and every gate.
- **v0.21.0**: **link/transport hardening.** Outbound send cap (#3) — a transport-level pacer serializes every post through one queue with a min gap, a hard floor under the engine cooldowns. `unsafeWindow` link binding (#14) and `'null'`-origin reply fallback (#15) make the postMessage link portable to userscript managers that sandbox `window` or report a `'null'` origin (Tampermonkey unaffected).
- **v0.22.0**: **backlog close-out.** A `link` auto-mod rule type (URL-token extraction + confusables-folded match; redirect-following deliberately declined for SSRF/permission reasons). In-character **generated beats** — a beat `prompt` now routes through a page `beat` brain handler. **Text-lane backgrounding** — opt-in `backgroundText` (on in production) makes the reply/volunteer/greet/beat lane fire-and-forget (exposed as `summary.textJob`) so a 15-30s generation never stalls the poll loop; the per-lane locks still prevent overlap, and all existing harnesses run with it off (default) so nothing regressed. `harness-bgtext.js` pins the backgrounded path. The backlog is now clear.

## Blocked
- **T6** Gateway features (live join/leave/ban events, real slash commands, push) — needs a Gateway transport for the in-page loop or a move to Adapter B (Node + discord.js). Architectural decision, not a build-now item.

## Backlog (prioritized)

### Near-term — small, engine-local, fix behaviors we've watched misfire
1. ~~**Start-settling greeting guard**~~ — ✓ **shipped v0.9.0**. *(lrrbot `join_filter.py`)*
2. ~~**Per-author throttle**~~ — ✓ **shipped v0.9.0** (per-author queue + per-author cooldown + light global gap; `harness-fairness.js` pins it). *(lrrbot `throttle_base`)*
3. ~~**Proactive outbound send cap**~~ — ✓ **shipped v0.21.0**. A transport-level pacer serializes ALL outbound posts (messages, embeds, image attachments) through one queue with a minimum gap (`sendMinGapMs`, default 1100ms) — a hard floor under the engine cooldowns so greet/reply/image/beat lanes and multi-ack batches can't burst past Discord's per-channel rate; 429 back-off (now traced) stays the backstop. *(lrrbot `twitch_throttle`, pump19 `Limiter`)*

### Mid — meatier, clear wins
4. ~~**Command registry — single source of truth**~~ — ✓ **shipped v0.11.0**. *(pump19 `command.py` + lrrbot)*
5. ~~**Per-command throttle**~~ — ✓ **shipped v0.12.0** (`cooldownMs` per `COMMANDS` entry; moderation verbs unthrottled). *(pump19 `Limiter`)*
6. ~~**Auto-moderation rule list**~~ — ✓ **shipped v0.12.0** (text/regex/confusables, reversible-only, mods exempt, panel-editable). v0.22.0 adds a **`link`** rule type (extracts URL tokens and matches the pattern inside them, confusables-folded) so a rule can target a domain precisely. Full redirect-following canonicalization is **declined**: it would mean the user's browser fetching arbitrary URLs from chat (SSRF/tracking) behind a wildcard `@connect`, not worth it for raid defense. *(lrrbot `spam.py` + `linkspam.py`)*
7. ~~**Lockdown + global access mode**~~ — ✓ **shipped v0.14.0**. `engageMode` ∈ locked/normal/open. `!chloe lockdown` (raid panic: ignore everyone but mods; greeting + volunteering off; auto-mod stays on), `!chloe unlock` (→ normal), `!chloe open` (reply to everyone — the stream toggle). Mods-only; settable in-channel or from the panel selector; command changes persist via the `onPoll`→summary channel. `harness-engage.js` pins it. *(lrrbot `commands/lockdown.py` + bot-wide `access`)*

### Polish
8. ~~**Rich embeds**~~ — ✓ **shipped v0.19.0**. `transport.sendEmbed` + `cfg.sendEmbed` added; `help` (Mods/Anyone fields), `status` (engagement/replies/images/auto-mod fields), and `recap` (title + body) render as embeds when the transport supports them, with the existing text ack as fallback. Moderation acks stay plain text. `harness-embeds.js` pins it. *(§7.3)*
9. ~~**Pinned transparency notice**~~ — ✓ **shipped v0.17.0**. Panel "Post & pin notice" button posts an editable disclosure ("Chloe is a roleplay bot character who remembers people here…") and pins it via `PUT /channels/{id}/pins/{id}` (needs Manage Messages); idempotent (one-time unless forced), state surfaced in the panel. *(§7.6)*
10. ~~**Emoji command aliases + multi-prefix**~~ — ✓ **shipped v0.15.0**. `aliases[]` populated with emoji/short forms (🔒 lockdown, 🔓 unlock, 📢 open, 📜 recap, 📊 status, 🆘/? help); `commandPrefixes[]` adds extra prefixes (e.g. `!c`) resolved longest-first alongside `!chloe`. Settable from the panel; `harness-commands.js` covers both. *(pump19)*
11. ~~**Mod-action context**~~ — ✓ **shipped v0.16.0**. Every mod action *and* every auto-mod action now writes a modlog entry that captures the target's most recent lines (capped at `modLogContextLines`, scrubbed of Discord tokens); the panel's Mod log renders the captured lines under each entry, and auto actions are tagged. Never dumped in-channel. `harness-modcontext.js` pins it. *(lrrbot `moderator_actions.py` / `chatlog.py`)*

### Later / bigger
12. ~~**Scheduled proactive beats**~~ — ✓ **shipped v0.20.0**. Interval-based beats (`{ id, intervalMs, text | texts[] | prompt, activeWithinMs? }`), seeded (not fired) on first sight, then fired at most one per poll — gated by recent room activity (never to a dead/empty channel), never during lockdown, never while replying/painting, with a global min gap. Panel JSON editor; persisted per-channel. In-character generation is wired (v0.22.0): a beat with a `prompt` calls a page `beat` brain handler; `text`/`texts` beats stay fixed/random. `harness-beats.js` pins lifecycle + gating. *(lrrbot `timers.py`, §7.11)*
13. ~~**Image posts**~~ — ✓ **shipped v0.10.0**. Resolved the top-panel routing: awaiting `root.textToImagePlugin` from the panel runs the plugin's `$output` in the top-panel context (attaching the broker iframe there), and `.dataUrl` crosses the bridge — no manual iframe injection (that's what hangs from the panel). Posted as a native multipart attachment rather than via upload-host + URL unfurl. *(§7.5)*

### Hardening (mined from weld-companion's skybridge anchor — portability, not bugs today)
14. ~~**`unsafeWindow` link binding**~~ — ✓ **shipped v0.21.0**. The message listener and outbound posts bind to `unsafeWindow` when present (`unsafeWindow || window`), so the link survives managers that sandbox the wrapped `window`. Added the `@grant unsafeWindow` header.
15. ~~**`'null'`-origin reply fallback**~~ — ✓ **shipped v0.21.0**. `replyTarget(o)` returns `'*'` only when the inbound origin is `'null'` (a sandboxed frame), else the exact origin; responses stay nonce-matched so this remains safe.
16. ~~**Context mention-scrub**~~ — ✓ **shipped v0.11.0** (transcript + addressed message scrubbed before the brain sees them).
17. ~~**Diagnostics trace ring**~~ — ✓ **shipped v0.18.0**. A 60-entry in-memory ring in the userscript records link (connect / disallowed-origin / dispatch-fail), transport (HTTP errors, 429 back-offs), and compact poll events; readable via the `diag.trace` dispatch and a panel "Diagnostics" button that dumps the ring to the log and copies it to the clipboard. *(weld skybridge trace ring)*

## Distributed tab bridge (Queen/worker) — design accepted with corrections
Spec reviewed and adopted with these binding decisions: (a) heartbeat is EVENT-DRIVEN — the queen pings, workers pong in the handler, because Chrome's intensive throttling clamps background-tab timers to ~1/min, so worker-owned heartbeat timers falsely die; (b) the Discord transport and bot token live ONLY in the queen tab — one token is one rate budget, and GM storage is script-global so the queen/worker split is a scheduling boundary, not a security boundary; (c) the genuinely parallel resource is each tab's AI/image brokers, so workers are brains; (d) envelopes are authenticated with a GM-stored bus token (page code can't read GM storage, so it can't join the channel); (e) **chat-submitted JavaScript execution is DECLINED permanently** — any eval surface in the userscript context can reach GM storage (the token) and GM_xmlhttpRequest; the declarative JSON job grammar (whitelisted verbs, no code) is the replacement.

D1. ~~**Tab bridge layer**~~ — ✓ **shipped v0.23.0**. `bridge.js`: pure queen/worker messaging module (engine.js pattern — injected bus + clock, Node-testable). Register / queen-initiated ping-pong / silent-worker reaping / `request()` RPC with timeouts and busy-idle tracking / clean shutdown+bye. Bootstrap wires it: role from `#chloe-worker` URL hash (default queen — today's single tab IS the queen), BroadcastChannel bus with GM value-change fallback, worker tabs refuse `start` (engine + transport stay queen-only), worker registers `echo` + `brain` jobs (`brain` → this tab's `callPage`), `bridge.status`/`bridge.spawn`/`bridge.shutdown` dispatches, spawn via `GM_openInTab` (+ grants). `harness-bridge.js` pins the contract.
D2. ~~**Brain offload scheduler**~~ — ✓ **shipped v0.24.0**. `bridge.dispatchJob(jobType, payload, timeoutMs, fallback)`: round-robin over idle workers (one-in-flight per worker via busy/idle), local fallback when none, and FAST failover — a worker lost mid-job rejects its pending requests on reap/bye, not at the request deadline, so the fallback completes the job promptly. Bootstrap `brainCall()` routes all six brain fns (`respond`/`judge`/`recap`/`greet`/`beat`/`paint`) through it; the engine sees the same promise + `{ok, value}` shape either way. Panel Tabs row: role display, Spawn worker, worker list with shut-down buttons. Harnessed in `harness-bridge.js` (D2 section).
D3. ~~**Multi-channel Chloe**~~ — ✓ **shipped v0.25.0**. One engine per channel in the queen (`engines{}` registry), each with a namespaced store: the PRIMARY channel keeps the legacy un-prefixed namespace (existing installs keep their memory — zero migration), extras live under `ch:{id}:`. Shared paced transport (one token, one send budget) + all brains through the D2 scheduler. Per-channel: cursor/roster/modlog/beats (via the store), engageMode (`engageMode:{ch}` keys, so `!chloe lockdown` in one channel doesn't lock the others), guild-id cache, backfill completion. `config.setChannels` dispatch; panel gets an extra-channels input + a channel selector (auto-hidden with one channel) scoping the roster, mod log, mode selector, mod actions, pin notice, and permaban. `forget me` and moderation are per-channel by construction. `harness-multichannel.js` pins isolation: independent replies over one transport, roster isolation, the same user id with independent moderation state per channel, and no legacy-namespace leakage. Known simplification: persona/rules/mods are shared across channels (per-channel overrides can come later if needed).
D4. ~~**Personality dials + mod reaction anchor**~~ — ✓ **shipped v0.27.0**. Six bounded dials (kindness/sarcasm/curiosity/playfulness/formality/verbosity, 0..1, clamped + key-whitelisted in the dispatch) attached at the `brainCall` seam for every text kind (never paint), so worker tabs always see fresh values; the page's `personaStyle(ctx)` renders only dials that deviate from neutral (0.45–0.55 silent) into the respond/beat/recap/greet prompts — `judge` is deliberately excluded so style can't bias the participation decision. Mod 📌-reaction anchoring: REST can't see reaction events, so a maintenance sweep (every ~10 polls, gated by `personaAnchor`) re-fetches the last 20 messages, finds 📌-bearing ones, fetches WHO reacted (`GET .../reactions/{emoji}`), and the newest MOD-anchored message becomes the channel's persona note — scrubbed (tokens/mentions/emoji codes), capped at 200 chars, stored per-channel, framed in the prompt as style-only guidance that never overrides rules. `!chloe persona` shows it, `!chloe persona clear` clears it; panel Personality card has the sliders, the anchor toggle, the current note, and a clear button. `harness-persona.js` pins anchoring (mod-gated, newest-wins, no-churn, sanitization, cap), ctx delivery, and the command.
D5. **JSON job grammar + lifecycle polish** — declarative user-submitted jobs validated against a whitelist of task verbs (summarize, monitor, recap...); spawn backoff; worker-mode panel banner.
D6. ~~**Queen failover (election)**~~ — ✓ **shipped v0.26.0**. Pure election in `bridge.js`, enabled by an injected lease adapter (GM `queen:lease` in production, in-memory in tests): a worker that hasn't heard the queen for `queenDeadAfterMs` (default 90s; coarse watchdog survives background-tab timer throttling) waits a rank-jittered delay, claims the lease, waits a settle window, and promotes ONLY if the read-back still shows its own claim (last-write-wins → one winner). Wake/sleep clock jumps between watchdog ticks RESET the watchdog (a suspended laptop must not elect a second queen). If two queens ever coexist (revival), the lease is the tiebreaker — the non-holder demotes, stops its engines, and re-registers as a worker. A promoted queen adopts surviving workers via ping→pong (pong-from-unknown auto-registers), strips `#chloe-worker` from its URL, and auto-resumes the engines iff `autoResume` (set true on `start`, false on `stop`). Every tab registers `echo`/`brain` handlers so a demoted ex-queen serves jobs immediately. `harness-failover.js` pins all four races; `harness-bridge.js` proves the feature is dormant without a lease (exact back-compat).
D7. **Pool autosizing + discard resilience** — `poolSize` target maintained on the queen's tick (spawn when busy, don't replace when quiet), spawn backoff for pop-up heuristics, and "expected N, have M → respawn" recovery from Memory-Saver tab discards. README note: exempt perchance.org from Memory Saver for a stable pool.
D-never. Chat-submitted JS execution, in any mode (see decisions above).

## Panel UI v2 — "mission console" (panel-only; no userscript change)
The control panel was reorganized from one long scroll of accreted cards into a console: a sticky **command bar** (Chloe wordmark with a heartbeat dot that pulses while she runs, link/run pills, the multi-channel selector, Start/Stop/Poll/Refresh) over a five-tab rail — **Setup** (channels, token), **Behavior** (engagement, abilities, beats, personality), **Moderation** (auto-mod rules, mods, transparency notice), **People** (roster), **System** (worker tabs, diagnostics) — with the log always docked below. Visual identity: deep-ink navy + the violet from her embed color (#8b5cf6), Chakra Petch display type over IBM Plex Sans, a faint dot-grid backdrop, and restrained micro-motion (heartbeat, tab underline glow, pane rise). Implementation was surgical: only the HTML/CSS region before the `<script>` was rewritten plus a small in-memory tab switcher appended to the script (it never touches `location.hash` — the worker role lives there); every one of the 65 original element ids was verified present so all existing JS wiring is untouched, and the parser audit stays clean (no square brackets in CSS selectors, no template literals).

## Backlog — Carl-bot mining (botlabs-gg/carlbot-docs)
Carl-bot is a Gateway/dashboard/slash bot, so most of it (slash commands, web config, leveling, starboard, reaction/auto roles, feeds, gateway-event logging, music/games) is out — wrong architecture or orthogonal to an AI-presence-plus-light-mod bot. These moderation ideas fit Chloe's reversible-first, human-in-loop model and refill the backlog:

C1. ~~**Strike ladder with escalation**~~ — ✓ **shipped v0.23.0**. Per-user `strikes` decays (`strikeDecayMs`, default 24h/strike) then increments; the count walks `strikeLadder` by index (default ignore → 10m timeout → 1h timeout → soft-ban), capped at the last step — an irreversible ladder step is downgraded (F1: strikes never permaban). A rule `action:'warn'` and `!chloe warn @u [reason]` both escalate; `!chloe warns @u` reports the count; any `clear` resets to a clean slate. Auto-mod now scans BEFORE the suppression gate (skipping only terminal soft-ban) so an already-ignored repeat offender still escalates. Strike counts shown in the panel roster. `harness-strikes.js` pins it. *(Carl warn-threshold)*
C2. **Rate / mention rule types** *(Carl message/mention/link spam)* — orthogonal to content patterns: `mentions` (≥N pings in one message → ping-raid) and `rate` (N messages within a window, read off the partition's `recent` timestamps). Both drop into the `autoModRules` array. Plus a cheap `caps` ratio heuristic.
C3. **`defer` action** *(Carl drama channel)* — instead of auto-acting on a borderline match, post the offender + captured context + a jump link to a mod channel; optionally poll for a mod ✅/❌ reaction to apply/dismiss. The most Chloe-aligned idea in the repo.
C4. **`delete` action + multi-action rules** *(Carl default-delete + comma punishments)* — add `DELETE /channels/{cid}/messages/{mid}` as an action (and "delete the triggering message"); allow a rule to carry an action *list* (e.g. delete + timeout + dm).
C5. **`report` + jump links** *(Carl report channel)* — `!chloe report <thing>` posts to a mod channel with a jump link; retrofit jump links (`/channels/{guild}/{chan}/{msg}`) into modlog / mod-action-context entries.
C6. **Smaller:** timestamped user-notes list (vs single `modNote`); per-rule allowlist beyond mods (trusted regulars exempt); raid `purge` via bulk-delete (gated by confirm like permaban); permission-based channel lockdown (distinct from engagement-lockdown).

## Not worth porting (from the mines)
- lrrbot's DB / web app / EventSub layers, and its command mega-regex (our prefix+verb model is simpler).
- Atomic file-rename save — GM storage is already per-key.

## Backlog — wide feature mine (Carl-bot, Dyno, MEE6, Red cogs, Shapes.inc, SillyTavern, Character.AI)
Mined against Chloe's hard constraints: REST-polling only (no Gateway events — no real-time reactions/edits/deletes/voice/member-joins), browser-only + free, safety-first (no user code, no non-mod behavior changes, reversible-by-default). Grouped by fit. Sources noted inline.

### E-batch — high-fit quick wins (each reuses the previous one's plumbing)
- **E1. Highlights / keyword paging** (Carl-bot `highlight`/`hl`, Dyno Highlights). Users register keywords; Chloe DMs them context + a jump link when the word appears while they were away. Anti-spam from both sources: ~5-min per-user notify cooldown + suppress if the subscriber posted in that channel recently (computable from polled history). Matching bounded to her already-polled batches (Dyno disabled theirs server-wide for perf — don't scan everything). Low complexity. Deepens "she's watching the room for you."
- **E2. AFK / away** (Red `away`, Seina `afk`). User marks away (+reason); on a ping Chloe answers in-character and optionally DMs the mention; auto-clears on their next post. Shares E1's "recently active?" calc + DM path. Low.
- **E3. Reminders** (Red `reminder`, near-universal). `remind me in 2h to…` → stored due-time checked on the poll tick. Reuses the scheduled-beats scheduler. Cap per-user (existing throttles). Low.
- **E4. Birthdays / anniversaries** (MEE6-alt standard). Opt-in date → daily tick → in-character greeting folded into the familiarity-greeting system. On-theme for a memory companion. Low.
- **E5. Image alt-text** (Discord `attachments[n].description`). Chloe wrote the image prompt, so she already knows the description — pass it as alt text. Trivial, pure accessibility win.
- **E6. "What did I miss?" recap-since-last-seen** (Red `convocompact`, brandons209 TLDR). Generalize the shipped recap embed to "since you left." Pairs with E1/E2 for a welcome-back moment. Low–med.

### F-batch — high-value character-depth builds (the real differentiator)
- **F1. Fact-extraction memory** (Mem0 ADD/UPDATE/DELETE/NOOP loop, arXiv 2504.19413; Google RecLLM salient-facts; MemBuilder). Enrich each roster entry with extracted enduring facts (plays guitar, writing a thesis), injected into prompts. Use summarization/fact-lists, NOT a vector DB (RecLLM + SillyTavern Qvink show pure-summary memory works and fits GM storage). Conflict-resolution is the hard part — adopt the four-op contract. Med–high. **Biggest privacy surface: must be transparent, user-viewable, and fully covered by the existing forget-me + permaban purge before shipping.**
- **F2. Hierarchical memory (short→long summaries)** (SillyTavern Qvink MessageSummarize; MemoryBooks scene→arc). Per-message rolling summaries, important ones promoted to durable memory; avoids "lost in the middle" whole-history summaries and unbounded prompt growth on long channels. Extends F1; mods can correct/anchor summaries via the existing 📌 mechanism. Med–high.
- **F3. Free Will / proactive presence — BOUNDED** (Shapes.inc Free Will: introverted/chill/outgoing tiers + interest keywords + hard rate limits; Dead-Chat-Reviver bots: inactivity threshold + Nightmode + timezone). Fusion of shipped AI-volunteering + beats + E1 keyword matching + familiarity check-ins. Intensity reuses the personality-dial architecture, **defaults to "chill" (wait until mentioned)**. Med. **Highest annoyance risk — hard per-channel/per-user caps, Nightmode window, respect lockdown/open, never DM-spam. If anyone says "stop," drop intensity immediately.**
- **F4. Poll-derived starboard / "Hall of Fame"** (Starboard ecosystem). No reaction events, but Chloe can REST-fetch reactions on a bounded set of recently-polled messages; promote ⭐≥N to a showcase channel as an embed + an in-character one-liner of praise. Needs a dedup ledger + reaction-fetch budgeting. Med. Proves the "re-fetch reactions on recent set" pattern.
- **F5. Polls / suggestions with tallies** (Carl-bot suggestions). Post a message, read reaction counts via REST (same pattern as F4), tally polled (slightly delayed, fine). Mod-gated approval, reversible. Med.
- **F6. Leveling / recognition — HOLD unless asked** (MEE6/Lurkr). XP from polled message counts is approximate (misses bursts between polls) — frame as "Chloe's sense of who's around," bias to *noticing/praising* over competitive grind; rank cards could use the browser **canvas** (no new network perms). Role rewards stay mod-gated. Med.

### G-batch — conversation quality / prompting (NO new infrastructure; do these alongside everything)
- **G1. Anti-repetition guard** (Antislop, arXiv 2510.15061; layered "prompt + recent-reply cache" approach). Inject "avoid your recent phrasings" + Chloe's last few replies; optional regen on n-gram overlap. Low. Biggest quality-per-effort win — do first.
- **G2. Lean character-card discipline (C.O.R.E.)** (HammerAI/ParasiticRogue; "lean cards beat lore-heavy"). Refactor the persona prompt into Core/Output/Rules/Examples with 2–3 short example exchanges. Low.
- **G3. In-character refusal / anti-OOC** (MegaNova OOC analysis; C.AI over-caution failures). Decline *as Chloe*, no "as an AI language model" boilerplate — but she's openly a bot (transparency notice), so don't deny it; just decline gracefully in-voice. Keep real moderation behavior. Low; improves safety UX.
- **G4. Multi-speaker handling + explicit silence policy** (C.AI group-chat guidance; Shapes "read the room"). Format polled history as labeled turns (`User: msg`); sharpen the shipped AI-volunteering with an explicit "stay quiet when not addressed / topic doesn't need you / you just spoke" policy. Low.
- **G5. Time-awareness callbacks** (companion episodic-recall design). Inject last-seen deltas + a recent fact (needs F1) into greetings — "you've been quiet three days," "how'd the exam go?" Low (high value once F1 exists). Keep warm, not surveillant.
- **G6. Mood continuity** (companion mood-state design; tempered by Princeton CITP / Frontiers over-reliance findings). Small mood/valence state injected into prompts, modulated by the trait dials. Low–med. Values call: warm but not attachment-maximizing; encourage real-world connection.

### Rejected from this mine (wrong architecture / safety / scope)
- Reaction-role self-service pickers (Carl/YAGPDB) — needs real-time reaction events; grants non-mod role changes (against our gating).
- Music / voice (Red, Rythm) — no voice, no Gateway. Hard wall.
- Real-time edit/delete "who deleted what" logging (brandons209) — needs edit/delete + audit-log events we can't see. Our poll-time mod-log context is the best approximation.
- Arbitrary custom commands / TagScript / code execution (YAGPDB, BotGhost) — permanent no; the planned whitelisted JSON job grammar is the safe substitute.
- Economy / virtual currency (vrt-cogs, OwO) — generic utility, grind dark-patterns, low character value. Skip unless asked.
- NSFW / "unfiltered" modes (Shapes unfiltered) — against safety philosophy + Discord policy.
- Auto-kick/ban on join via global lists (PhasecoreX BanCheck, Beemo) — needs join events + irreversible auto-ban; our human-confirmed permaban covers the safe case.
- Web config dashboard — requires hosting we deliberately avoid; config stays in-Discord + in-script.

### Cross-cutting notes for the whole mine
- REST budget: Discord caps 50 req/s; 10k invalid (401/403/429) per 10 min → 24h ban. Reaction-fetch features (F4/F5) must bound their re-check window and honor `Retry-After`.
- Browser advantages worth exploiting (no new network perms): **canvas** for rank/recap/birthday image cards; the **worker pool** to offload F1/F2/E6 AI work off the queen's poll loop (perfect "lend me your AI" jobs).
- Privacy: F1/F2 + memory are the biggest trust surface — transparent, user-viewable, purge-complete; resist attachment-maximizing design (companion over-reliance literature).
