# My Girl — Chloe

A free, self-contained AI roleplay companion that runs **entirely in your browser** — no Discord, no bridge, no
userscript, no bot token, no server, and no account. It's a single page that speaks through Perchance's free
**ai-text** and **image** plugins; everything else — memory, personality, the whole thinking apparatus — runs
locally, in your own browser storage. If the tab is open, she's alive. Nothing is sent to the author.

Talk to a single character, or craft an entire cast and let them interact in real time. Write naturally and jump
in whenever you like — you never have to wait your turn. Each character learns facts about you, forms its own
sense of who you are, keeps separate episodic and semantic memory, reflects, and can be shaped by your feedback.

## What it is

This is the standalone descendant of the old Discord bot, with the Discord surface removed entirely — no
commands-as-control, no moderation, no @-pings or channels. The chat is the simple face; underneath sits a
layered mind:

```
[ You ]
   ^   Perchance = the mouth (it only voices the result)
[ The Seven Nations ]   a readable top layer — seven faculties that perceive, react, and decide who speaks
   heart · reason · memory · instinct · voice · conscience · play
   ^   tallied through …
[ The Brain ]   a compiled, deterministic reasoning core (a Society of voting sub-minds with a watchdog)
   ^
[ the memory engine ]   facts, episodic & semantic memory, summary, reflection, FSRS-style forgetting, feedback learning
```

Two ideas run through it: the reasoning is **pure** (it runs the same with or without a model, and is testable),
and the model is only ever called at the very edge — to turn a decided intent into spoken words. The memory and
personality stay readable and fully under your control; only the reasoning core is compiled down for size.

## Getting started

1. Open the generator page on perchance.org. That's it — there's nothing to install and no account to make.
2. Say hello. She greets you and starts forming a sense of you.
3. Open **Settings › Character** to pick a built-in character, import one, or create your own.
4. Open **Thoughts** (top-right) to watch her think while you read.

## Characters & the cast

Everything about who you talk to lives in **Settings › Character**:

- **Pick or create.** A small built-in cast, plus anything you make or import. **Chat** talks with one (she
  greets you in character and the engine starts learning her); **+ scene** brings her in alongside the others.
- **Import.** Drop in an AI Character Chat export (`.json.gz` / `.cbor` / `.json`), a SillyTavern character
  card, a share link, a file id, or raw JSON. Personality, writing style, example dialogue, and saved memories
  come across.
- **A cast that interacts.** Add several characters; your primary answers when no one else is named, and others
  reply when you use their name (or `@name`). Characters can address each other. Each keeps its **own** private
  memory of everyone — they don't share a mind.
- **Portraits.** Generate a portrait of the primary from who they are now (it becomes their header avatar), and
  optional VN-style **reaction portraits** painted in the background that she wears to match her mood.

## Memory

Each character remembers you on their own — separate facts, mood, and conclusions, all in your browser's local
storage. You're in full control, **individually** and **globally**:

- Edit one character's memory (pick whose, remove single facts) in the Character tab.
- **Forget everything learned about you** clears it across the board without touching your saved characters or
  the conversation.
- The memory *systems* themselves — conversation memory, fact memory, episodic and semantic memory, reflection,
  idle consolidation, and more — are global on/off toggles in the **Brain** tab.

`/forget me` wipes what she's learned about you; `/mem` pins a durable fact; `/aboutme` shows what she holds.

## The Seven Nations (her top layer of mind)

In **Settings › Brain**, her highest layer is seven small faculties that decide what she says. Each is a tiny
mind in pure local code: it perceives each turn, reacts through its temperament, holds a running model of you and
bonds to the others, and proposes an *intent* (comfort, ground, recall, caution, express, protect, play). The
society votes — weighted by sliders you set — and the winner is voiced. Seven, so a vote never ties.

- **Tune them.** A weight slider and on/off for each, plus a **Spontaneity** control that adds a faint, bounded
  jitter so she's less static (at 0 it's fully deterministic).
- **Give a nation a face.** Assign any saved character to a nation with "Speaks as" — it then proposes and speaks
  in that voice, so personalities take the floor turn by turn.
- **Ask it about itself.** It knows what it is and never refuses to say. `/nation` (no prompt) — or "how do you
  feel?", "who spoke?" — reports who took the floor, how it reads you, and each mind's mood.

The deciding is all pure code; Perchance is called once per turn, only to voice the chosen intent.

## Talking to Chloe

Just write — she remembers, forms her own read of you, and thinks before she speaks. A few conveniences:

- `chloe, draw me a fox in a raincoat` — image replies, then refine in plain language ("make it bigger", "another
  one", "now at night"). With **image memory** on she understands those follow-ups.
- `/recap`, `/beat`, `/volunteer`, `/writeforme` — recap, a spontaneous beat, have her speak up, or have her draft
  *your* next message.
- `/remind 10m <text>`, `/goal <what you're working on>`, `/lang fr` — reminders, lasting goals, your reply language.
- Reply actions on her messages: 👍 / 👎 (she learns your style), ★ (save a line), 🔄 (regenerate), swipe between
  variants, ✕ (remove).

See `full-list-of-commands.md` for everything.

She also volunteers into the conversation when it helps (configurable), greets you proportionally to how well she
knows you, and can post spontaneous in-character "beats".

**Personality** lives in the Brain tab: six dials (kindness, sarcasm, curiosity, playfulness, formality,
verbosity) where the centre is neutral, plus her editable self-note (the same one `/persona` sets). When a
character note names someone — *"Name: Seraphina, regal and aloof"* — she **becomes** that character.

## Settings

Six tabs, distilled: **You** (your identity, what she remembers about you, pinned lines) · **Context** (live
device date/time, always-known facts, lorebook, her self-note, image looks) · **Character** (the whole character
& data layer, including save/load) · **Brain** (the Seven Nations, personality, cognitive toggles, expressions,
moderation, quick actions, and how she's adapted to you) · **Appearance** (theme & accent) · **About** (a plain
rundown with a "show more" technical expander).

## Gallery, Community & Thoughts

- **Gallery** — every image she's drawn, kept locally (IndexedDB) to browse and re-use.
- **Community** — a public comments thread for the page, shared by everyone who visits, separate from your
  private chat (served by Perchance's comments service; needs a connection to load).
- **Thoughts** — a side drawer that streams her cognition as it happens.

## Save / Load

In the Character tab: capture the whole session — every character's memory, the cast, and the transcript — as a
checkpoint you can roll back to, with optional rolling **auto-checkpoints**. **Backup** exports the whole session
as one JSON file to keep or move to another browser; **Start fresh** erases the conversation and what she's
learned (your saved Gallery images and checkpoints are kept). Only you drive any of this — settings and the
checkpoint system are never touched by the characters or the brain.

## Grounding (what she actually knows)

A few optional features feed her *true* facts rather than guesses, kept strictly as grounding:

- **Date & time** — read live from your device clock (timezone included; no IP, GPS, or address). `/time` and
  `/date` answer instantly with no AI.
- **Her own basics** — her name and how to use her, so "are you an AI?" gets a straight answer.
- **Always in context** — a card for short, true situational facts or world rules you want present in every reply.

## Privacy

Everything lives in your own browser — the conversation, every character's memory, your settings, the gallery.
There is no server, no account, and nothing is sent to the author. `/forget me` and **Forget everything learned
about you** prune what she's stored; **Start fresh** clears the session. The public Community thread is the only
thing that leaves your machine, and only what you choose to post there.

## How it's built (for the curious)

A single self-contained HTML page. The memory + personality engine (`engine.js`) and the readable top layer
(`nation.js`) stay human-readable; the reasoning core is compiled to a small `brain.min.js` and proven
behaviour-identical to its source by an automated test suite. It speaks only through Perchance's free ai-text and
image plugins — no other dependencies, no network beyond that.

---

Made by [west-ninja](https://deviantart.com/west-ninja) · [therealwestninja](https://github.com/therealwestninja)
