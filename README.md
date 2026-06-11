# Chloe-bot

A free, locally hosted, Perchance-backed Discord bot that runs entirely in your browser. A Tampermonkey userscript is the trusted bridge (it holds the bot token and talks to Discord's REST API); a Perchance generator page is the brain and control panel (AI text + image generation, persona, settings). No server, no hosting bill — if the tab is open, Chloe is alive.

Since v0.24.0 Chloe is **multi-tab**: the tab you set up is the *queen* (it owns the token, the Discord traffic, and all state), and you can spawn disposable *worker* tabs whose only job is lending their AI/image generators — so text replies and image generation run in parallel instead of queuing on one tab.

## Requirements

- Chrome (or any browser with a userscript manager)
- Tampermonkey (or a compatible userscript manager) with the `chloe-bridge.user.js` script installed
- The Chloe control generator page open on perchance.org

## Discord setup

1. Create an application + bot at the [Discord developer portal](https://discord.com/developers/applications).
2. **Enable "Message Content Intent"** under Bot → Privileged Gateway Intents. This is required — without it, Discord returns empty message content and Chloe will see people talking but never hear what they say.
3. Invite the bot to your server with at least: View Channel, Send Messages, Read Message History. Optional extras: Manage Messages (lets her pin the transparency notice), Ban Members (enables the human-confirmed permaban command), Attach Files (image replies).

## Bot setup

1. Install the userscript and open the Chloe control generator. The Tampermonkey menu on that page has **"Set bot token"** — the token is stored only in the userscript's storage and never crosses into the page.
2. In Discord, enable Developer Mode (Settings → Advanced), right-click the channel you want Chloe in, **Copy Channel ID**, paste it into the panel, and click **Set Channel**.
3. Tip: on a first run in an existing channel, click **Backfill history** so she starts with context instead of amnesia.
4. Set any options (greetings, volunteering, images, auto-mod, beats…), then click **Start**.

### Worker tabs (optional, new)

In the panel's Mods card, **Spawn worker tab** opens a second copy of the generator marked as a worker. Workers register with the queen within ~15 seconds and from then on AI and image jobs are scheduled onto whichever worker is idle (falling back to the queen's own tab automatically — including mid-job, if you close a worker while it's generating). Workers are disposable: close them whenever, shut them down from the panel, spawn more when the channel is busy. Only the queen talks to Discord; if the spawn does nothing, allow pop-ups for perchance.org.

**Failover:** if the queen tab dies (closed by accident, crashed, discarded), the worker tabs notice within a couple of minutes, elect exactly one of themselves as the new queen, and — if Chloe was running — resume her automatically. Closing your laptop lid is fine too: a machine waking from sleep is detected and does *not* trigger a false election. So with one worker tab open, "keep this exact tab alive" relaxes to "keep any one tab alive".

### Multiple channels

The Setup tab takes extra channel IDs (comma-separated). Each channel gets its own independent Chloe: separate memory of people, separate moderation state and strikes, separate engagement mode (`!chloe lockdown` in one channel doesn't lock the others), separate persona note — all served by one bot token and one worker pool. A selector appears in the command bar to scope the roster, mod log, and mode controls to a channel.

### The control panel

The panel is a small console: a sticky command bar (Chloe's heartbeat pulses while she runs) with Start/Stop and the channel selector, five tabs — Setup, Behavior, Moderation, People, System — and the live log always docked below.

## Talking to Chloe

Mention her or use her name — both work:

- `@chloe-bot how's it going?`
- `chloe, draw me a fox in a raincoat` (image replies, delivered as native attachments)
- `!chloe forget me` — anyone can ask her to prune their own conversation history (moderation records are kept)

She also volunteers into conversations she can help with (configurable), greets people proportionally to how well she knows them, and can post scheduled in-character "beats" when the room is active.

**Personality:** the panel has six dials (kindness, sarcasm, curiosity, playfulness, formality, verbosity) that shape her tone — 50 is neutral and silent. Mods can also anchor a style note straight from Discord: react &#128204; to any message (e.g. "Chloe should be more playful today") and, within a few polls, that message becomes her current style guidance for the channel. The newest mod-anchored message wins; `!chloe persona` shows it and `!chloe persona clear` removes it. Notes are sanitized, length-capped, and treated strictly as tone guidance — they can't change her rules or moderation.

## Moderator commands

Mods (managed from the panel) can use `!chloe <verb>` in-channel — or the `!c` short prefix, or emoji aliases:

| Verb | What it does |
| --- | --- |
| `ignore` / `unignore @u` | She stops/resumes engaging with someone |
| `timeout @u 1h [reason]` | Temporary ignore with auto-expiry |
| `softban` / `unsoftban @u` | Persistent ignore |
| `warn @u [reason]` | Adds a strike (see below); `warns @u` reports the count |
| `block @u [reason]` / `unblock @u` | Permanently forget a user: blocked users are never scanned or remembered again, even if they keep talking. Unblock lets memory form again. |
| `clear @u` | Clean slate — state and strikes reset |
| `note @u <text>` | Attach a mod note |
| `recap` / `status` / `help` | Channel summary, engine status, command list |
| `lockdown` / `unlock` / `open` | Mods-only mode / normal / reply-to-everyone |
| `permaban @u` | Irreversible: ban + verified memory purge, requires explicit confirmation |

## Auto-moderation and the strike ladder

Optional rule list (panel-editable): each rule matches by `text`, `regex`, `confusables` (catches homoglyph evasion like "fr\u0435\u0435 nitro"), or `link` (matches inside URLs only), and applies a reversible action — `ignore`, `timeout`, `softban`, or `warn`. A `warn` adds a strike: strikes walk an escalating ladder (default: ignore → 10-minute timeout → 1-hour timeout → soft-ban) and decay with good behavior (default: one strike forgiven per 24h). Auto-moderation never escalates to anything irreversible, mods are exempt, and every action (manual or automatic) is logged with the target's recent lines for audit.

## Output gates

Chloe is gated on what she's allowed to put in a message she sends, with five independent toggles in the Moderation tab (and safe defaults):

- **custom emoji** — `<:name:id>` emoji in her text *(default: allowed)*
- **pings (@user / @role)** — whether her messages resolve real pings *(default: blocked)*
- **@everyone / @here** — mass pings, a separate toggle *(default: blocked)*
- **links (URLs)** — http(s) links, which also prevents link auto-embeds *(default: blocked)*
- **channel links (#channel)** — `<#id>` channel references *(default: blocked)*

Pings use Discord's own `allowed_mentions` system — the platform itself decides what becomes a real notification, so even if a ping slips into her text it won't fire unless the gate is on. Emoji, links, and channel-links are scrubbed from her message content before it posts. Together these mean a jailbroken or prompt-injected Chloe still can't mass-ping the server, spam links, or @ channels unless a mod has explicitly allowed it.

## DMs

Chloe can hold a two-way DM conversation with anyone she's opened a DM with (`dm.open` from the panel, or any DM she initiates — e.g. a future away/paging feature). Once a DM is open she polls it like any channel and replies to **every** message there (no @-mention needed — a DM is one-to-one), with all the same moderation. Turn this on with the **DM replies** toggle. One Discord limit to know: she can't receive a *cold* DM from someone she's never messaged, because Discord only delivers those through the realtime Gateway, which this REST-polling bridge doesn't use — so DMs work for any conversation Chloe is part of, just not unsolicited inbound ones.

## Personalities

When a mod anchors a persona note (the 📌 reaction, or the Personality card) that names a character — e.g. *"Name: Seraphina, regal and aloof"* or *"you are Marcus the merchant"* — Chloe **becomes** that character: she answers to that name, speaks in first person as them, and won't narrate that she's Chloe playing a role. Clear the note and she's Chloe again.

## Privacy and transparency

- `forget me` lets anyone self-prune.
- The panel can post and pin an editable transparency notice in the channel.
- The mod log survives purges; user memory does not survive `forget me` or permaban.

## Troubleshooting

- **She replies to nothing / sees empty messages** → Message Content Intent is off (step 2 of Discord setup).
- **Spawn worker does nothing** → pop-up blocker; allow pop-ups for perchance.org.
- **She goes quiet when the computer sleeps** → the queen tab must be open and the machine awake; she resumes on wake, and rate limits (429s) are honored automatically.

---

Made by [west-ninja](https://deviantart.com/west-ninja) · [therealwestninja](https://github.com/therealwestninja)
