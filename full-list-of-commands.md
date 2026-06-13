# Full List of Commands

Chloe is driven by text commands in Discord, by emoji reactions, and by the control panel.

**Prefixes.** Every command below works with the `!chloe` prefix. The operator can configure
additional prefixes in the panel (commonly `!c`, and a name form like `chloe,`); all configured
prefixes resolve to the same commands, so `!chloe help`, `!c help`, and `chloe, help` are equivalent
when those prefixes are enabled. Examples here use `!chloe`.

**Who can run what.** Commands are either open to everyone or restricted to moderators (the mod list is
managed from the panel). A few read-outs that might look like user commands — `help`, `status`,
`recap` — are **moderator-only** in the current build. The truly irreversible action, `permaban`, is
**not** a chat command at all: it can only be triggered from the control panel, with confirmation.

---

## Everyone

| Command | What it does |
| --- | --- |
| `!chloe time` | The current time, answered instantly with no AI call. Uses the operator's device clock when the panel is open; otherwise falls back to the most recent Discord message's timestamp (an approximate UTC reading). |
| `!chloe date` | Today's date, instant, no AI. Same clock sources as `time`. |
| `!chloe aboutme` | What Chloe currently remembers about you (facts, insights, goals). |
| `!chloe forget me` | Stop remembering you and erase what she's stored about you. Moderation records are kept. After this she ignores you for memory purposes until you say `remember me`. |
| `!chloe remember me` | Re-enable memory after `forget me`. She will not reach back and re-learn anything from before you asked to be forgotten. |
| `!chloe forget <a thing>` | Ask her to drop a specific remembered detail about you. |
| `!chloe goal <text>` | Tell her something you're working on; she keeps it as a lasting goal that follows you across channels and restarts. |
| `!chloe goal done <id>` / `!chloe goal drop <id>` | Close or remove one of your goals. |
| `!chloe goals` | List your open goals (moderators can list everyone's). |
| `!chloe lang <code>` | Set your own reply language (e.g. `fr`, `es`, `de`, `ja`). `!chloe lang off` returns to English; `!chloe lang` shows your current setting. |
| `!chloe remind <10m\|2h\|1d> <what>` | Set a personal reminder; she'll ping you when it's due. |
| `!chloe reminders` | List your pending reminders; `!chloe reminders clear` removes them. |
| `!chloe afk [reason]` | Mark yourself away; `!chloe back` clears it. |
| `!chloe highlight [note]` | Flag a message as notable (reply to it, or quote text). `!chloe highlights` lists them; `!chloe highlights clear` empties the list. |
| `!chloe reactions` | Show the reactions this room values most. |
| `!chloe image {json}` | Request an image with explicit options (prompt, resolution, guidanceScale, removeBackground, weights, dm). Most people just ask her in plain language ("draw me a fox in a raincoat") instead. |
| `!chloe mode` | Show the current engagement mode; `!chloe mode clear` (moderators) resets it. |

---

## Moderators

The mod list is managed from the panel. These also accept the configured short prefixes and, where
noted, an emoji alias used as a reaction.

| Command | What it does |
| --- | --- |
| `!chloe ignore @user` / `!chloe unignore @user` | Stop / resume engaging with someone. |
| `!chloe timeout @user 1h [reason]` | Temporarily ignore a user, with auto-expiry. `!chloe untimeout @user` ends it early. |
| `!chloe softban @user` / `!chloe unsoftban @user` | Persistent ignore (not a Discord ban). |
| `!chloe warn @user [reason]` | Add a strike on the escalating ladder (alias: react ⚠️). `!chloe warns @user` reports the count. |
| `!chloe block @user [reason]` / `!chloe unblock @user` | Permanently forget a user: blocked users are never scanned or remembered again, even if they keep talking, and any memory already formed is purged. Unblock lets memory form again. Reversible. |
| `!chloe note @user <text>` | Attach a moderator note to a user. |
| `!chloe clear @user` | Clean slate: reset Chloe's state and strikes for that user. |
| `!chloe forget-that` | Excise a specific message from her memory (reply to it, or `@user`). |
| `!chloe persona [clear]` | Show the active persona/style note, or clear it. |
| `!chloe lockdown` | Mods-only mode (aliases: `lock`, react 🔒). |
| `!chloe unlock` | End lockdown, restore normal operation (alias: react 🔓). |
| `!chloe open` | Reply-to-everyone mode (aliases: `openchat`, react 📢). |
| `!chloe recap` | Summary of recent channel activity (alias: react 📜). |
| `!chloe status` | Engine status (alias: react 📊). |
| `!chloe help` | Command list (aliases: `?`, react 🆘). |
| `!chloe poll <question> \| <a> \| <b> [...]` | Open a poll; `!chloe poll close` tallies it. |
| `!chloe do {json task}` | Run a structured task. |

---

## Panel-only actions (trusted surface)

These are not chat commands — they are run from the control panel, which is the trusted surface that
holds the bot token.

| Action | What it does |
| --- | --- |
| **Permaban** | Bans the user from the Discord server (requires the Ban Members permission) **and** purges Chloe's stored memory of them, with the deletion verified. Irreversible; requires explicit confirmation in the panel. Auto-moderation can never trigger this — it only ever applies reversible actions. |
| **Open a DM** (`dm.open`) | Start a one-to-one DM conversation with a user Chloe can message. |
| **Set bot token / Set channel / Backfill / Start / Stop / Spawn worker / etc.** | Setup and lifecycle controls. See the README. |

---

## Non-command interactions

| Interaction | What it does |
| --- | --- |
| `@chloe-bot <message>` | Directly address Chloe by mention. |
| `chloe, <message>` or `chloe <message>` | Address her by name (when the name prefix is enabled). |
| `📌` react to a message (moderator) | Anchor that message as the channel's active persona/style note. The newest mod-anchored message wins; `!chloe persona` shows it, `!chloe persona clear` removes it. Notes are tone guidance only — they can't change her rules or moderation. |
| `🗣️`, `❗`, or `🤖` react to your own message | Summon a reply if she chose not to answer (when "summon by reaction" is enabled). A summon is a request, not an override — all gates still apply. Moderators can summon her onto anyone's message. |
| 👍 / ❤️ / 😂 etc. on **her** messages | Positive reactions gently build her familiarity/warmth with you over time (capped, and they never loosen moderation). |

---

Made by [west-ninja](https://deviantart.com/west-ninja) · [therealwestninja](https://github.com/therealwestninja)
