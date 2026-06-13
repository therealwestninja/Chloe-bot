# Chloe Solo

The whole of Chloe-bot, minus Discord and the Bridge — a standalone, in-browser AI companion you
open and talk to. The simple face is a wide, calm chat; the entire mind hides behind a drawer on the
right that streams her cognition in real time, with a slider to slow it to reading pace.

It is a **shell swap, not a rewrite.** The cognitive engine (`engine.js`) was built transport- and
storage-agnostic, so Solo reuses it **unchanged** and wraps it in three small new pieces: a
LocalTransport (the chat is the message stream), a localStorage-backed store (the engine's five-method
port), and the desktop UI + thinking drawer. The brain handlers (respond, judge, paint, facts, reflect,
consolidate, summary, episodes) are the same ones Chloe-bot uses — wired here as direct calls instead of
over postMessage, since the engine and the brain share one realm.

## What carries over from Chloe-bot

Everything above the transport: facts, insights, episodic memory, the rolling summary, semantic recall +
FSRS spaced-repetition, reflection, contradiction-noticing, feedback learning, register-matching, and the
self-knowledge grounding. All run locally in your browser.

**1:1 with AI Character Chat.** The settings popup's **Character** tab is Chloe-bot's AICC importer,
verbatim: drop AICC's native `.json.gz` export, a `.cbor.gz` / `.cbor` / `.json` file, a share link, a
`user.uploads.dev` link, a file ID, or raw character JSON. Personality, writing style, reminder, and the
character's saved memories all come across. You can also write your own character inline.

## The thinking drawer (the signature)

Open **Her mind**. Every `[chloe.*]` thought the engine emits, plus her page-side brain traces, stream in
as paced lines. The **Pace** slider throttles them: slide left to watch one thought at a time at reading
speed, right to let it run at full speed. This is the one bold element; everything else stays quiet.

## Running it

- **Standalone demo:** open `solo-app.html` in a desktop browser. With no language model wired in it runs
  in *demo mode* — the conversation, memory, and the mind drawer are all real; only her words are
  placeholders. Good for seeing the machine work.
- **For real, on Perchance:** create a generator, import `ai-text-plugin` and `text-to-image-plugin`
  (see `generator-dsl.txt`), paste `solo-app.html` into the HTML panel, and keep the image relay script.
  Text replies need no relay; image generation goes through the top-panel relay because text-to-image only
  resolves from the top-panel sandbox.

## Files

- `solo-app.html` — the assembled, self-contained app (engine + brain + importer + UI inlined). **This is
  the deliverable you run.**
- `solo.html` — the app template (markers for the three inlined blocks).
- `engine.js` — the Chloe cognitive engine, copied verbatim from Chloe-bot (zero changes).
- `brain-block.js` — the reused brain handlers (respond/judge/paint/facts/reflect/consolidate/summary/episodes).
- `charimport-block.js` — the reused AICC character importer.
- `assemble.py` — inlines the three blocks into `solo-app.html`.
- `generator-dsl.txt` — the Perchance top-panel (plugin imports + image relay).
- `harness-solo-loop.js` — headless proof the engine drives end-to-end as a 1:1 chat, unchanged.

## Settings — everything you can adjust

The popup has four tabs, all backed by real engine methods:

- **Character** — the AICC importer (1:1, above), write-your-own authoring, reset to default, and a
  *Generate portrait* button that paints her from who she currently is and uses it as her avatar.
- **You** — your name (what she calls you, remembered) and *Tell her about you*: pinned facts she keeps
  in mind. Backed by the engine's user partition + `addFacts`.
- **Behavior** — her name plus every part of her mind as a toggle: conversation memory, episodic memory,
  self-knowledge, contradiction-noticing, register-matching, feedback learning, and recall-by-meaning.
- **Memory & data** — a live **memory browser** showing everything she remembers about you (each with a
  forget button, backed by `getFacts`/`forgetFact`), plus export / import / erase.

## What's wired now vs. next

**Wired:** the full chat loop (her replies, conversation memory including her own lines); the thinking
drawer + speed slider; the whole settings popup above — AICC import and authoring, your identity, the
live memory browser, portrait generation, all feature toggles, and memory export/import/erase. The engine
runs every cognitive feature it has.

**Next (from roadmap #11):** wiring the heavy semantic-recall embedder + tokenizer hooks (currently
semantic recall is the one toggle that needs them); deciding which of Chloe-bot's timer-driven ambient
behaviors (volunteer, lull-fillers, check-ins) make sense for a user-initiated 1:1 and turning those on;
and moving the store from localStorage to IndexedDB/Dexie for larger histories.
