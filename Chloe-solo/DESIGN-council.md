# DESIGN — the Brain, layer by layer

Chloe's mind is built as nested layers, each using the layer below as a sub-system. Top to bottom:

```
[ User ]
   ^   Perchance = the mouth (voices the result; that is all it does)
[ The Seven Nations ]   readable top layer — seven minds that perceive, react, and decide   ← nation.js
   heart · reason · memory · instinct · voice · conscience · play
   ^   tallied through …
[ The Brain ]   compiled, deterministic reasoning (a Society of voting sub-minds + watchdog) ← brain.min.js
   ^
[ engine.js ]   the entire memory side + personality injection (mouth-owned, readable)
```

Two principles run through every layer: the reasoning is **pure** (no DOM, no network, deterministic given
its inputs), and **effects are injected at the edges** — a model call only ever happens at the very top (to
voice a result) or inside an injected member effect, never in the kernels.

---

## The nations' inner life (pure cognition; Perchance only voices)

The nations are not vote-lenses any more — each is a small **mind** in pure local code, so the brain perceives,
reacts, and decides who speaks and why without a single model call. Perchance is invoked exactly **once** per
turn, only to voice the winner.

Each mind (one per nation) holds:
- **self** — its id, purpose, an assigned persona, and a drifting **mood**.
- **working memory** — the recent turns it is aware of (what you said, what other characters said, what it said).
- **a model of you** — your description, a running read of your **sentiment** (warming / steady / struggling) and
  engagement, updated by a tiny pure cue-reader (warmth / distress / humor / anger / questions — no model).
- **bonds** — how it feels toward you and toward each other member, warming to whoever pleases it.

The turn loop, all pure except the last step:
1. **perceive(turn)** — every mind takes in the turn and reacts through its temperament (heart aches at distress,
   play lifts at humor, instinct and conscience alarm at pain or anger).
2. **deliberateIntents()** — each mind proposes an **intent** (comfort / ground / recall / caution / express /
   protect / play) with a strength from its mood and how the moment charges it; the society cross-votes by bond +
   mood + weight (+ the weak noise); the Brain sub-system resolves a **(speaker, intent)**. No model call.
3. **voice once** — Perchance renders that speaker's intent into one short line. The only external call.
4. **reactToSpoken()** — the speaker hears itself; the others react to a peer; bonds and moods shift. Your
   thumbs-up / thumbs-down folds back in via **ingestReaction**.

It is self-aware on demand: `report()` (and `/nation` "how do you feel?") says who last took the floor, how it
reads you, and each mind's mood, persona, and last line. On a struggling user the brain elects
**conscience → protect** with no model in the loop — proven in `harness-solo-nation`, deterministic at noise 0.

---

## The Seven Nations (the readable top layer)

Above the compiled Brain sits the Seven Nations — seven faculties (heart, reason, memory, instinct, voice,
conscience, play; odd, so a vote never ties). Where the Society was compiled into opaque code, this layer is
deliberately simple and human-readable (`nation.js`), because it is the part you reason about and tune.

- **Settings › Brain.** Each nation has a weight slider, an on/off, and a "Speaks as" picker that binds a saved
  character or built-in preset to it. A **Spontaneity** control adds a faint, bounded jitter (default 4%) so the
  vote is less static — injected with a swappable RNG, 0 means fully deterministic. The learned reply-weighting
  ("How I've adapted to you") lives here too. Everything persists in `state.nation`, owned by the mouth.
- **It explains itself, always.** `army.about(q)` knows what it is, what it does, and its purpose, and never
  refuses — for any question (even gibberish) it volunteers the full picture.
- **Never refuses to work.** If the compiled Brain isn't present, the army falls back to a built-in tally rather
  than failing. `harness-solo-nation` covers weighting, enable/disable, the odd roster, the fallback, the
  self-knowledge, the bounded noise, and the inner-life cognition above.

---

## The compiled Brain (lean artifact) + the Society

The pure reasoning (the nervous system + the Society deliberation kernel) is consolidated into one editable
source, **`brain.js`** (`createNervous, resolve, member, createCouncil, withTimeout`), and compiled to
**`brain.min.js`** — mangled, comment-free, roughly 44% of source, which is what the app ships. `build-brain.sh`
runs terser (compress passes=3, toplevel mangle, comments dropped); only internal names are mangled, so the
property API the mouth calls is preserved. The council harness runs against **both** `brain.js` and
`brain.min.js` to prove the compiled Brain is behaviour-identical.

The split: memory (facts, FSRS forgetting, episodic graph, embeddings, summary, reflection, consolidation) and
personality injection stay in the readable `engine.js` under the mouth's control; the Brain artifact is only the
reasoning, so it can be compiled hard without touching anything the mouth keeps editing. (Minification cuts
bytes and parse time, not algorithmic speed — the kernel was already pure and fast, and per-turn latency is
dominated by the model call at the mouth.)

---

## The Society — an odd body of emotion-minds

The council generalises into a Society: an odd roster of member-minds (default nine emotion-stances — joy,
sadness, fear, anger, disgust, anxiety, envy, ennui, embarrassment). Guarantees layered on the council kernel:

- **Odd by default** so the body never splits evenly — with `resolve()`'s deterministic tie-break still behind
  it, so a deadlock is impossible even on a score tie.
- **Mandatory participation.** Every member registers and always votes; a slow / stalled / sleeping member is
  timed out to a default vote, never an abstention.
- **Watchdog liveness.** A member that times out is put to sleep; the next round's `wakeStalled()` reawakens
  anyone asleep, idle past `idleMs`, or unregistered. Timeouts use an injected scheduler, so it stays testable.
- **A few propose, the many decide.** `deliberate(ctx, seed)` lets a handful of voices propose candidates while
  the whole Society votes/vetoes — the faithful emotion-council shape.

---

## The Council (a Brain made of Brains) — the pure kernel

The whole engine-Brain becomes a single neuron; a small council of them nominates, cross-votes, and can veto,
then resolves a winner.

- **`resolve(proposals, ballots, vetoes, opts)` is 100% pure** — deterministic, no DOM, no network, no model. It
  drops vetoed proposals, tallies cross-votes (no self-voting by default), and picks a winner (ties broken by
  confidence, then nomination order), reporting `status` (agreed / carried / tie-resolved / contested /
  no-proposals), consensus, dissent, and the full transcript. All-vetoed flags `contested` and still returns a
  least-bad winner rather than crashing.
- **Effects are injected at the member boundary.** A member's propose / vote / veto MAY call a model, but the
  kernel never does — Perchance sits only at the I/O edge.
- **The same protocol, one level up.** `nervous` was lifted out of the engine into a shared factory
  (`createNervous`); the council registers each member-Brain as a neuron of kind `brain` and talks to them over
  the bus. Recursion, not analogy.

### Honesty / tradeoffs
- More minds cost more generation per turn — which is why the higher layers keep voting pure and call the model
  as little as possible (the Seven Nations call it exactly once).
- Diversity is the point: identical minds agree trivially; value comes from real difference in stance, role, or
  temperament — and from the veto / wellbeing levers that can block an unkind or off-character line before it is
  ever spoken.
- Pure first: the kernels can be tested, replayed, and reasoned about without a model in the loop, and the
  expensive part stays at the edge, swappable.
