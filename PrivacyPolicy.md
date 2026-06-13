# Chloe-bot — Privacy Policy

_Last updated for v0.83.0._

Chloe-bot is a free, self-hosted Discord bot that runs entirely inside the **operator's** own web
browser. There is no central server, and the author of Chloe-bot does not host, receive, or have any
access to your data. This document explains what data Chloe processes, where it lives, and how to
remove it.

Two roles are referenced below:

- **Operator** — the person who installs the userscript, supplies their own Discord bot token, and runs
  the bot in their browser. The operator is the data controller for their deployment.
- **User** — anyone in a Discord channel or DM where the operator has run Chloe.

> This policy describes how the software behaves. It is not legal advice. An operator deploying Chloe is
> responsible for meeting the privacy obligations of their own jurisdiction and Discord's terms.

## What data Chloe processes

When the bot is running in a channel or DM, it reads and may store:

- **Message content and metadata** in the channels/DMs it is configured to watch — text, author
  username and Discord user id, timestamps, and reactions.
- **Derived memory about users** — short "facts" and higher-level "insights" she infers, goals you tell
  her, notable "episodes", a rolling channel summary, a familiarity/warmth score, and a small working
  memory of the current moment. These are produced from the messages above.
- **Moderation records** — strikes/warnings, notes, ignore/timeout/softban/block state, and an action
  log of what moderators (and auto-moderation) did. The action log is kept separately and is designed to
  **survive** memory purges (it records moderator decisions, not a memory of the user).
- **Images** she generates on request, and a short history of recent images when image memory is on.
- **Per-user settings** you set yourself, e.g. your reply language (`!chloe lang`) and away state.

## Where data is stored

All of the above is stored **locally in the operator's browser**:

- The userscript's own storage (managed by the userscript manager, e.g. Tampermonkey) and the Perchance
  control page's browser storage on the operator's machine.
- Nothing is uploaded to the author of Chloe-bot. There is no Chloe-bot server, account, or database.
- The **Discord bot token** is held only in the userscript's storage and is never exposed to the
  Perchance page. Treat the token like a password; anyone with it can control the bot.

Data persists for as long as the operator keeps it (i.e. until it is deleted as described below, the
operator clears their browser storage, or the operator resets state).

## Third parties that necessarily receive data

Because of how the bot works, some data leaves the operator's browser to the services that make it
function:

- **Discord** — messages are read from and sent to Discord through Discord's REST API, governed by
  [Discord's Privacy Policy](https://discord.com/privacy).
- **Perchance.org** — Chloe's "brain" is a Perchance generator. To produce a reply or an image, the
  relevant conversation context and prompts are sent to Perchance's AI text and image plugins, which
  run the underlying models. This is subject to Perchance's own terms and the terms of the model
  providers it uses.
- **Translation service (only if you use `!chloe lang`)** — per-user translation uses a free public
  translation service; the text being translated is sent to it. Translation is off unless enabled, and
  is best-effort (she sends the original text if the service is unavailable).

## What Chloe does **not** collect

- **No location data.** The optional "date & time" feature reads only your device's clock and timezone
  setting; it does not read IP address, GPS, physical address, or any location beyond the timezone you
  implicitly share by chatting, and she is explicitly instructed never to infer or state where you are.
- **No analytics or telemetry** are sent to the author. There is no tracking across servers.
- The optional locale feature (if present) reads only the browser's coarse language/device-type
  setting, never location.

## DMs

If the operator has enabled and declared a DM, Chloe polls and replies in that one-to-one conversation
with the same moderation as a channel. What she knows about you from **public** channels can inform a DM
(a one-way carry-over so a DM isn't a cold start), but anything learned **inside** a DM stays in that DM
— it never flows back into public channels or into another user's DM.

## Your choices and how to delete data

- **`!chloe aboutme`** — see what Chloe currently remembers about you.
- **`!chloe forget me`** — erase what she's stored about you and stop remembering you going forward.
  Moderation records are intentionally retained. `!chloe remember me` re-enables memory later without
  resurrecting anything from before you asked to be forgotten.
- **`!chloe forget <a thing>`** — drop a specific remembered detail.
- **Moderator/operator actions** — `clear @user` resets a user's state and strikes; `block @user`
  permanently stops scanning/remembering them and purges existing memory (reversible with `unblock`);
  **permaban** (panel-only, confirmed) performs a Discord ban plus a verified memory purge.
- The operator can also reset all state or clear their browser storage, which removes everything.

Note that deletion affects the operator's local copy. Messages also exist in Discord itself and are
governed by Discord's policies; Chloe cannot delete anything from Discord on your behalf.

## Children

Chloe is intended to run on Discord, which requires users to be at least 13 (older in some regions).
It is not directed at children under 13.

## Changes

This policy may change as the software evolves; the "last updated" version above tracks that. Material
changes will accompany a release.

## Contact

For questions about the software itself, contact the author via
[github.com/therealwestninja](https://github.com/therealwestninja). For questions about a specific
deployment and the data it holds, contact that bot's operator — they control the data.

---

Made by [west-ninja](https://deviantart.com/west-ninja) · [therealwestninja](https://github.com/therealwestninja)
