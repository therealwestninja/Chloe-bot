# Full List of Commands

**My Girl — Chloe** is a single-user app that runs entirely in your browser. There's no Discord, no bridge, no
bot token, no moderators, and no command prefix — it's just you and her. You drive her four ways: by **writing
naturally**, by **slash commands** in the message box, by **tapping the reply actions** on her messages, and from
the **Settings panel**. Most of the time you don't need a command at all — just talk, or ask her in plain
language ("draw me a fox in a raincoat", "make it night now", "another one").

---

## Everyday

| Command | What it does |
| --- | --- |
| `/img <prompt>` | Generate an image now. Then refine the last one in plain language — "make it landscape", "add a hat", "more moody", "another one". With image memory on, she remembers what she drew. |
| `/recap` | She summarises the conversation so far. |
| `/volunteer` | She speaks up on her own, right now. |
| `/beat [idea]` | A spontaneous, in-character message (optionally seeded with an idea). |
| `/writeforme` | She drafts *your* next message into the box, for you to edit before sending. |
| `/nar <text>` | Narrate a scene line she reacts to (e.g. `*the door creaks open*`). |
| `/sys <text>` | A standing directive that rides along in every reply. `/sys clear` resets it. |
| `/remind 10m <text>` | Set a reminder (use `m` / `h` / `d`); she pings you when it's due. `/remind clear` removes them. |
| `/goal <text>` | Give her a goal to keep and follow up on. |
| `/lang <code>` | Reply language (e.g. `fr`, `es`, `ja`). `/lang off` returns to English; `/lang` shows your setting. |
| `/time`  ·  `/date` | The current time / date — instant, read live from your device, no AI call. |

## Memory

| Command | What it does |
| --- | --- |
| `/mem <text>` | Remember a durable fact about you. |
| `/aboutme` | What she currently remembers about you. |
| `/forget <thing>` | Drop a specific remembered detail. `/forget me` wipes everything she's learned about you. |
| `/highlight [note]` | Save the last line to revisit; the newest few ride along in her context. |
| `/highlights` | List your saved lines. `/highlights clear` empties them. |
| `/persona <note>` | Set or show her self-note — a short sense of who she is, woven into every reply. `/persona clear` clears it. |

## Her mind — the Seven Nations and the Brain

| Command | What it does |
| --- | --- |
| `/nation [prompt]` | The seven faculties (heart, reason, memory, instinct, voice, conscience, play) perceive the moment in pure code, decide who should speak and with what intent, and she voices it. With **no prompt** it explains itself — what it is, how it works, and how it currently feels and reads you. Aliases: `/army`, `/whoami`. |
| `/society [prompt]` | A society of nine emotion-minds votes on the reply. Alias: `/emotions`. |
| `/council [prompt]` | Three stances (warm, grounded, spark) deliberate, then she replies. |
| `/neurons` | List the Brain's neurons; `/neurons <id>` inspects one. Alias: `/brain`. |
| `/status` | A quick diagnostic read-out. |

## Under the hood (for the curious)

These surface and gently poke the cognitive engine's internals. You rarely need them, but they make her
thinking visible: `/affect` · `/mood` (her inner weather), `/trust` (how the relationship sits), `/intent` ·
`/think` (her current reasoning), `/reflect` (run a reflection pass), `/consolidate` · `/sleep` (an idle
memory-consolidation pass), `/epi` (episodic memory), `/sum` · `/summary` (the rolling summary), `/ctx` (the
context budget — what goes into each prompt), `/excise` (remove a specific message from her memory), `/greet`,
`/checkin`, `/nudge`, `/lull`, `/archive`, `/feedback`. There's also `/do { …json }` to run a structured job
explicitly. `/help` shows the built-in list at any time.

---

## Reply actions (on each of her messages)

| Action | What it does |
| --- | --- |
| 👍 / 👎 | Tell her a reply landed or to ease off that style. This trains her reply-style learning and feeds back into how the nations read you. |
| ★ | Save that line to memory (it's pinned, and the newest few ride along in her context). |
| 🔄 | Regenerate — adds a fresh take as a new variant. |
| ‹ n/m › | Swipe between variants of a reply (text or image). |
| ✕ | Remove the message. |

## Toolbar (above the message box)

| Button | What it does |
| --- | --- |
| ✍️ Write for me | Drafts your next message, editable before you send. |
| 📜 Recap | Recaps the conversation so far. |
| 💬 Volunteer | She speaks up on her own right now. |
| ✨ Beat | A spontaneous in-character beat. |
| ⏰ Remind | Set a reminder. |
| ⌘ Commands | Opens the full slash-command palette. |

You can also add your own one-tap **Quick actions** (Settings › Brain) — a comfort line, a roleplay action, or a
question you ask a lot; `{1-20}` drops in a random number.

## Settings panel (top bar)

| Button | What it holds |
| --- | --- |
| 💬 Community | A public comments thread for the page, shared by everyone who visits — separate from your private chat. |
| 🖼 Gallery | Every image she's drawn, kept locally in your browser. |
| ⚙ Settings | Six tabs: **You** (your identity, what she remembers about you, pinned lines) · **Context** (live device context, always-known facts, lorebook, her self-note, image looks) · **Character** (the cast, importing & creating characters, portraits, per-character memory, save/load & backup) · **Brain** (the Seven Nations and their weights, personalities, spontaneity; personality dials; cognitive toggles; expressions; moderation; quick actions; how she's adapted to you) · **Appearance** (theme & accent) · **About** (a plain rundown, with a "show more" technical expander). |
| 🧠 Thoughts | A side drawer that shows her cognition as it happens. |

---

## Non-command interactions

| Interaction | What it does |
| --- | --- |
| Just write | Talk naturally. She remembers what you tell her, forms her own sense of you over time, and thinks before she speaks. |
| `@name` (or just a name) | In a multi-character scene, address a specific character; they reply when named, and characters can address each other. Each keeps its own private memory. |
| Paste a character file or JSON | Drop an AI Character Chat export, a SillyTavern card, a share link, or raw JSON into the Character tab to import a character. |

---

Made by [west-ninja](https://deviantart.com/west-ninja) · [therealwestninja](https://github.com/therealwestninja)
