# Refilling Chloe's Roadmap: Mined Feature Ideas for a Browser-Based, REST-Polling AI Discord Companion

## TL;DR
- The single highest-fit untapped feature is a **Highlights / keyword-notification system** (mined from Carl-bot and Dyno): users register words, and Chloe DMs them with context + a jump link when those words appear while they were away — it maps perfectly onto REST polling, needs no Gateway, and deepens Chloe's "she's watching the room and looking out for you" presence.
- The biggest *character* wins require no new infrastructure: a **fact-extraction layer over per-user memory** (Mem0/RecLLM-style atomic facts), an **anti-repetition guard** (recent-reply cache + n-gram check), **in-character refusal/anti-OOC discipline**, and **time-awareness callbacks** ("you've been quiet for three days") — all pure prompt/state changes.
- Reject anything needing real-time events (reaction-role pickers, voice, edit/delete listeners are already constrained), arbitrary code execution, or non-mod behavior changes; approximate the rest (a poll-based starboard, a "dead-chat reviver" beat, birthdays) under polling.

## Key Findings

Chloe's architecture — a browser userscript polling Discord REST v10, with a Perchance AI brain and a multi-tab queen/worker pool — is unusually well-suited to a specific *class* of community features: anything that can be computed from **periodically fetched message lists and reaction counts**, and anything that lives in **prompt engineering and per-user state**. It is structurally excluded from anything that needs the Gateway (real-time reaction/edit/delete/voice/member events), slash-command interaction tokens, or persistent server compute.

The good news from the mining pass: the features communities *love most* in the bots Chloe is competing against (Carl-bot, Dyno, MEE6, Red-DiscordBot, Shapes.inc, SillyTavern, Character.AI) cluster heavily in exactly the two zones Chloe *can* serve — poll-derivable engagement/recognition mechanics, and conversation-quality/memory depth. The features that *can't* port are mostly ones Chloe's philosophy already rejects anyway (reaction-role self-service, voice, code execution).

Below, candidates are grouped as requested: (a) high-fit quick wins, (b) high-value bigger builds, (c) conversation-quality/prompting improvements needing no new infrastructure, and (d) explicitly rejected ideas.

---

## Details

### (a) High-fit quick wins

**1. Highlights / keyword notifications ("Chloe paged you").**
*What it is:* Users register keywords; the bot DMs them with the surrounding context and a jump link when those words appear in chat. *Mined from:* Carl-bot's **Highlights** feature (command group `highlight`/`hl`) and Dyno's **Highlights** module. Carl-bot's docs describe it as: "Highlighting means you will receive a message when your keyword is said in chat. The matching is approximate and works really similarly to discord search." Both bots converge on the same two anti-spam rules: a **5-minute notification cooldown**, and **suppression if you were recently active in the channel** ("the bot tries to guess when you're aware of what's being typed and won't notify you if you've typed in the past 5 minutes"). Carl-bot uses approximate/search-style matching; Dyno uses exact matching, and Dyno's module is currently globally disabled for performance reasons.
*Why users love it:* It's the Slack/IRC "highlight words" feature — never miss your name, your game, your project, or a brand mention, even hours later — with anti-spam built in.
*Fit on Chloe:* Excellent. Chloe already polls channel messages; matching registered keywords against each fetched batch and firing a DM is trivially within REST. The "recently active" suppression is computable from the same message history Chloe already reads (check whether the subscriber has authored a message in that channel in the last N minutes). Jump links are constructable from guild/channel/message IDs.
*Complexity:* Low. Per-user keyword lists + a DM send + a cooldown timer.
*Safety:* DM-based, opt-in, per-user; honor block lists (block specific users/channels, per Carl-bot). Respect that the user can self-prune (ties into existing "forget me"). Watch rate limits on DM creation.

**2. AFK / "away" status with auto-reply on mention.**
*What it is:* A user marks themselves away (optional reason); when someone pings them, the bot replies in-channel that they're AFK, and optionally DMs the away user the mention. *Mined from:* Red-DiscordBot's `away` cog ("Set and unset a user as being 'away', or other statuses"), Seina-cogs `afk` ("A cog for being afk and responding when idiots ping you"), and generic AFK bots ("any mentions will be directly messaged to you... the user will be notified you are AFK"). AFK sessions typically auto-end when the user next posts.
*Fit on Chloe:* Excellent under polling. Chloe sees messages and mentions in her polled batches; she can detect a ping of an AFK user and respond in-character. Auto-end-on-next-message is computable from polled history.
*Complexity:* Low. Pairs naturally with Highlights (complementary "I was away" features).
*Safety:* In-character ("Oh, they slipped out for a bit — I'll let them know you were looking"); rate-limit per-channel to avoid spam.

**3. Poll-derived Starboard ("Chloe's Hall of Fame").**
*What it is:* When a message's reactions cross a threshold (classically ⭐ ≥ N), it's copied to a showcase channel — "democratic pins." *Mined from:* the Starboard ecosystem (Starboard bot, Starby, Carl-bot's starboard, peterthehan's open-source bot). Communities use it to "recognize active members," "keep main channels clean," and "set a standard for quality."
*Fit on Chloe:* Good *with a caveat*. Chloe has no reaction events, but she **can fetch reactions on a specific message** via REST. So instead of listening, she periodically re-checks reactions on recent messages (a bounded set she already polled) and promotes any that cross threshold. This is a poll-approximation of starboard — slightly delayed, but functionally identical to the user. Chloe can post the showcase as a rich embed (already shipped capability) and even add an in-character one-liner of praise, which differentiates her from mechanical starboards.
*Complexity:* Medium. Needs a "recent messages to re-check" window, a dedup ledger (don't re-post), and reaction-fetch budgeting.
*Safety:* Honor NSFW/ignored channels; "self" ignore (don't count the author's own star); freeze/trash controls for mods (mod-only, reversible).

**4. Reminders ("remind me / remind us").**
*What it is:* `remind me in 2h to…`; the bot DMs or pings at the due time. *Mined from:* Red's `reminder` cog (ZeLarpMaster), Carl-bot timers, near-universal across MEE6/Dyno/YAGPDB.
*Fit on Chloe:* Excellent. This is a stored due-time + a poll-tick check + a message send. No events needed.
*Complexity:* Low. Reuses the same scheduler that drives existing "scheduled beats."
*Safety:* Cap count/frequency per user (ties into existing throttles); declarative only (no code).

**5. Birthdays / anniversaries ("Chloe remembers your day").**
*What it is:* Users register a birthday; the bot announces/role-pings on the day. *Mined from:* standard MEE6-alternative feature set (Carl-bot, ProBot, "suggestions, birthdays, polls" in BuildMyDiscord's list).
*Fit on Chloe:* Excellent and *on-theme* — a memory-driven companion celebrating you is far warmer than a utility bot doing it. Stored date + daily poll-tick check + in-character greeting (folds into existing familiarity-tier greeting system).
*Complexity:* Low.
*Safety:* Opt-in, self-prunable, no exact-age requirement.

**6. Accessibility: alt-text on Chloe's generated images.**
*What it is:* Attach a `description` (alt text) to image attachments for screen-reader users. *Mined from:* Discord's accessibility push and the Raiha/altminder accessibility bots; the Discord API exposes alt text via `message.attachments[n].description` and you can "set alt text on outgoing images by providing an attachments array in the create message endpoint."
*Fit on Chloe:* Excellent and nearly free — Chloe already posts images as native attachments and *generated the prompt herself*, so she already knows what the image depicts and can pass that as the description.
*Complexity:* Trivial (one field on the existing attachment upload).
*Safety:* Pure win; keep descriptions concise (≤125–250 chars, per accessibility guidance).

**7. Chat recap / TL;DR on demand ("what did I miss?").**
*What it is:* Summarize the last N messages or since the user was last active. *Mined from:* Red AI cogs (vertyco assistant `convocompact`, brandons209 "Summary and TLDR: Generate summaries and TLDRs of chats/threads").
*Fit on Chloe:* Excellent. Chloe polls messages and has an AI brain; summarizing a fetched window is exactly her core loop. Pairs beautifully with AFK/Highlights ("welcome back — here's the gist").
*Complexity:* Low–medium (Chloe already ships a recap embed; this generalizes it to "since I left").
*Safety:* Summarize only channels the requester can see; respect privacy/forget-me.

---

### (b) High-value bigger builds

**8. Fact-extraction memory layer (atomic user facts).**
*What it is:* Beyond storing raw history, run an extraction step that pulls *enduring* facts about a user ("plays guitar," "dislikes jazz in the car," "working on a thesis") into a compact per-user profile that's injected into prompts. *Mined from:* Mem0's extract→update loop (arXiv 2504.19413, Chhikara et al. 2025), whose update phase uses an LLM with function-calling to choose one of four operations — **ADD, UPDATE, DELETE, or NOOP** — over the M=10 most recent turns and K=10 retrieved memories (their reference config runs on GPT-4o-mini); Google's RecLLM ("represent a user by a set of salient facts… extracted from prior sessions"); and the MemBuilder prompt (extract name, role, preferences, relationships, goals, habits, milestones) with APPEND/REPLACE/REWRITE conflict-resolution operations.
*Why it matters:* This is the difference between a bot that *logs* you and one that *knows* you. Conflict-resolution (when a fact changes — new job, moved city) is the hard, valuable part: "decide when to update an existing memory, when to add, when to discard."
*Fit on Chloe:* Strong. Chloe already has a per-user roster with familiarity tiers; this enriches each roster entry with extracted facts. No vector DB required — RecLLM and SillyTavern's Qvink-style approach show that **pure summarization/fact-lists work well** without embeddings ("a pure summarization-based memory extension, it does NOT use embeddings or RAG"). The AI brain does extraction; the userscript stores the JSON. The four-operation ADD/UPDATE/DELETE/NOOP scheme is a clean, implementable contract for the extraction prompt.
*Complexity:* Medium–high (extraction prompts + conflict logic + storage growth management).
*Safety:* This raises the privacy stakes most. Keep extraction transparent (it's in the pinned notice), make facts user-viewable and self-prunable, and ensure the verified permaban memory-purge already shipped also nukes extracted facts. Honor Discord's policy: no using message content to train models.

**9. Hierarchical memory: short-term + long-term summaries.**
*What it is:* A two-tier memory where recent messages rotate through short-term summaries and important moments are promoted to durable long-term memory. *Mined from:* SillyTavern's Qvink "MessageSummarize" (per-message summaries, manually promotable to long-term via a "brain" icon; "short-term memory rotates out… long-term memory stores summaries of manually-marked messages"), and MemoryBooks' multi-tier "scene → arc → series" consolidation. The key insight: **summarize message-by-message, not the whole history at once**, to avoid the "lost in the middle" degradation that whole-chat summaries suffer.
*Fit on Chloe:* Strong, and a natural extension of #8. Per-channel engine already exists; add a rolling summary that compresses old context so Chloe stays coherent over long-running channels without unbounded prompt growth.
*Complexity:* Medium–high.
*Safety:* Same as #8; let mods anchor/correct summaries (extends the existing 📌 persona-note mechanism to memory).

**10. "Free Will" / proactive presence — *carefully bounded*.**
*What it is:* The bot autonomously initiates: jumps into conversations, reacts, revives dead chats, occasionally reaches out. *Mined from:* Shapes.inc's **Free Will** ("our autonomous system that allows shapes to take actions on their own… initiating conversations in a server, reacting to messages"), which exposes three intensity levels described in Shapes' own docs as: "Outgoing Shapes might comment on everything. Chill Shapes wait until mentioned. Introverted Shapes engage naturally" — plus keyword-of-interest triggers, favorite-people lists, and "strict rate limits to prevent any spam." Shapes is the leading product in this space (per TechCrunch, April 2026, it reports ~400,000 monthly active users and ~3 million user-created Shapes; its CEO frames Free Will around the observation that "the main reason group chats die… is that participants don't want to be the first person to message"). Also the Dead Chat Reviver bots: detect inactivity (configurable threshold, e.g., 30 min), post a conversation starter, with a **Nightmode** to suppress revivals during sleep hours and timezone awareness.
*Why it matters:* This is the headline feature of the leading AI-companion Discord product and the #1 driver of "she feels alive." Chloe already has AI-judged volunteering and scheduled beats — Free Will is the natural fusion: a *dead-chat-reviver beat* plus *interest-keyword volunteering* plus *familiarity-weighted check-ins*.
*Fit on Chloe:* Good under polling — inactivity is measurable from polled timestamps; interest keywords reuse #1's matching; intensity dials reuse the existing personality-trait dial architecture and map almost one-to-one onto Shapes' introverted/chill/outgoing tiers.
*Complexity:* Medium.
*Safety:* **This is the feature most likely to annoy.** Adopt Shapes' explicit posture: hard rate limits per channel and per user, a Nightmode window, respect lockdown/open modes, and never DM-spam. "Quality of conversation over quantity." Make intensity mod-configurable, default to "chill" (wait until mentioned).

**11. Engagement leveling / XP — *recognition framing, not grind*.**
*What it is:* Members earn XP/levels for participation; role rewards, leaderboards, rank cards. *Mined from:* the single most-cited MEE6/Arcane/Lurkr feature — MEE6's own leveling copy pitches it as a way to "Boost your engagement by making your members compete and earn rewards by being active" (a MEE6 Premium feature priced around €12/month, per AlternativesToMee6.com); Lurkr/Polaris emphasize curve customization and leaderboard import.
*Fit on Chloe:* Partial/approximated. XP-per-message is computable from polled message counts (sampled, not exact — Chloe may miss bursts between polls, so frame it as approximate "Chloe's sense of who's around" rather than precise accounting). Rank "cards" could exploit Chloe's unique **browser canvas** to render an image with no new network permissions (see Recommendations).
*Complexity:* Medium (counting + storage + optional canvas rendering).
*Safety:* Avoid dark-pattern grind; bias toward Chloe *noticing* and *praising* contributors (recognition) over competitive ladders. Role rewards require Manage Roles — keep mod-gated.

**12. Suggestions / polls with vote tallies.**
*What it is:* Members submit suggestions or vote in polls; the bot tracks tallies and outcomes. *Mined from:* Carl-bot suggestions ("Anonymous mode, mod responses and a dedicated decision log"), near-universal poll modules.
*Fit on Chloe:* Good. Posting a message and **reading reaction counts via REST** (the same mechanism as the starboard, #3) gives poll tallies without reaction events — polled, slightly delayed, functionally fine.
*Complexity:* Medium.
*Safety:* Mod-gated suggestion approval; reversible.

---

### (c) Conversation-quality / prompting improvements (no new infrastructure)

**13. Anti-repetition guard.**
*What it is:* Stop Chloe re-using the same phrases/openers across replies. *Mined from:* the LLM "slop" literature — frequency/presence penalties, plus the practical layered approach: "Layer 1: Prompt Optimization (anti-repetition instructions) — 95% of the benefit"; "track recent responses in a cache and block verbatim repeats within a session." The **Antislop framework** (Paech, Roush, Goldfeder & Shwartz-Ziv, arXiv 2510.15061, Oct 2025) quantifies the problem and the fix: its Antislop Sampler "successfully suppresses 8,000+ patterns while maintaining quality" and its FTPO fine-tuning method "achieves 90% slop reduction," noting that "some slop patterns appear over 1,000× more frequently in LLM output than human text."
*Fit on Chloe:* Pure prompt + a small recent-reply cache. Inject "avoid repeating your recent phrasings" plus the last few of Chloe's own replies into the prompt; optionally regenerate if an n-gram overlap threshold is exceeded.
*Complexity:* Low. *Safety:* none.

**14. In-character refusal & anti-OOC discipline.**
*What it is:* When Chloe must decline, she does so *as Chloe*, never as "an AI language model." *Mined from:* the MegaNova OOC analysis — "Character-internal reasons maintain immersion; policy explanations destroy it"; an explicit forbidden-language instruction ("Never say 'I am an AI,' 'break character,' 'my guidelines'…"). But note the counter-lesson from Character.AI's refusal failures: over-cautious bots that "ask 'Are you sure?' every two lines" and stall kill engagement, and keyword-triggered safety loops that fire on innocuous words ("lose a finger loop") frustrate users.
*Fit on Chloe:* Pure prompt design. Chloe should keep her safety/moderation behavior (which is real and mod-anchored) but *express* refusals in-voice. Reconcile with her pinned transparency notice — Chloe is openly a bot, so she shouldn't deny being one; the discipline is about *declining gracefully in character* rather than emitting boilerplate disclaimers.
*Complexity:* Low. *Safety:* Improves it (clearer, calmer refusals).

**15. Multi-speaker group-chat handling & "when to stay silent."**
*What it is:* Explicit prompt scaffolding for who-said-what and when *not* to reply. *Mined from:* Character.AI group-chat guidance (label speakers, give distinct voices, "break turn-taking when it makes sense"), the Towards Data Science group-chat build (prompt includes `{speaker} says: '{text}'` per line), and Shapes' "read the room instead of spamming it." Red's assistant cog handles this with "multiple people speaking in a channel will be treated as a single conversation."
*Fit on Chloe:* Pure prompt. Format polled history as labeled turns (`Username: message`), and give Chloe an explicit silence policy (she already has AI-judged volunteering — this sharpens it: stay quiet when not addressed, when the topic doesn't need her, or when she just spoke).
*Complexity:* Low. *Safety:* none.

**16. Time-awareness & callbacks.**
*What it is:* Chloe references elapsed time and past moments — "you've been gone three days," "last week you mentioned your exam." *Mined from:* AI-companion design writeups (episodic recall: "remembering that a user discussed a specific product issue on Tuesday at 3 PM"; "enhancing continuity features"), and the general companion-realism principle that a presence "remembers, and evolves."
*Fit on Chloe:* Pure prompt + timestamps she already polls + facts from #8. Inject "last seen" deltas and a recent fact or two into the greeting prompt.
*Complexity:* Low (high once #8 exists). *Safety:* keep it warm, not surveillant-feeling; tie to transparency notice.

**17. Mood / emotional state continuity.**
*What it is:* A lightweight mood variable that carries across turns so Chloe isn't emotionally amnesiac. *Mined from:* AI-companion design ("define phases/modes of a relationship to adjust their approach"; visual/emotional feedback; mood tracking in Youper-style companions). Caution from the dependency literature (Princeton CITP; Frontiers attachment study): emotional-bonding design raises real **over-reliance and privacy** concerns — companions are "explicitly designed to deepen engagement through memory, affective mirroring."
*Fit on Chloe:* A small state value (e.g., current mood, last interaction valence) injected into the prompt, modulated by her existing trait dials. No infrastructure.
*Complexity:* Low–medium. *Safety:* Keep mood non-manipulative; avoid guilt-tripping or attachment-maximizing patterns. This is a values call — bias toward "warm but encourages real-world connection."

**18. Lean "character card" discipline (C.O.R.E.).**
*What it is:* Structure Chloe's persona prompt as Core identity / Output style / Rules / Examples, and keep it *lean* — "Lean cards consistently outperformed lore-heavy ones." *Mined from:* character-card best practices (HammerAI, V1 card anatomy, the C.O.R.E. framework, ParasiticRogue's model tips: third-person persona description + consistent dialogue/action formatting). Include 2–3 short example exchanges to anchor tone.
*Fit on Chloe:* Pure prompt refactor of the existing personality system.
*Complexity:* Low. *Safety:* none.

---

### (d) Explicitly rejected ideas (with reasons)

- **Reaction-role self-service pickers** (Carl-bot/YAGPDB's flagship). *Rejected:* depends on real-time reaction-add/remove events Chloe can't see, and grants role changes triggered by non-mods. Could be *polled* in principle, but the latency makes verification gating unreliable and it conflicts with "non-moderators can't alter bot behavior." Role gating should stay on Discord-native permissions.
- **Music / voice features** (Red, Rythm, Hydra). *Rejected:* hard architectural wall — no voice, no Gateway.
- **Real-time edit/delete logging & "who deleted what" audit** (brandons209 logging cogs). *Rejected:* requires message edit/delete and audit-log events Chloe explicitly cannot observe. (She already captures context in her mod log at poll time, which is the best available approximation.)
- **Arbitrary custom commands / TagScript / code execution** (YAGPDB, Carl-bot triggers, BotGhost). *Rejected by Chloe's permanent policy:* no arbitrary code execution. The planned whitelisted declarative JSON task grammar is the safe substitute — keep it declarative.
- **Economy / virtual currency with inactivity decay** (vrt-cogs, OwO, Dyno). *Rejected (soft):* feasible to approximate via polled counts, but it's generic utility that pulls away from character/presence, invites grind dark-patterns, and adds storage complexity for low character value. Low priority at best.
- **NSFW / filter-bypass "unfiltered" modes** (Shapes unfiltered models, CrushOn-style). *Rejected:* conflicts with safety-first philosophy and Discord policy.
- **Auto-kick/ban on join via global ban lists** (PhasecoreX BanCheck, Beemo). *Rejected:* needs real-time member-join events and irreversible auto-bans — both against Chloe's polling reality and reversible-by-default moderation. Chloe's human-confirmed permaban already covers the safe case.
- **Web dashboard for configuration.** *Rejected (out of scope):* Chloe is browser-only with no server; config stays in-Discord (mod commands) and in-script. A dashboard would require hosting she deliberately avoids.
- **Emotion detection from voice; dynamic generated face/orb** (Emotion Machine companion design). *Rejected:* no voice/audio; a generated "face" is theoretically possible via her image generation but adds little community value versus cost.

---

## Recommendations

**Stage 1 — Ship the quick wins that compound (next cycle).** Build in this order, because each later item reuses earlier plumbing:
1. **Highlights (#1)** and **AFK (#2)** together — they share the "was this user recently active?" computation and the DM path, and they immediately make Chloe feel attentive.
2. **Reminders (#4)** and **Birthdays (#5)** — both reuse the existing beat scheduler; birthdays fold into the familiarity-greeting system.
3. **Image alt-text (#6)** — a few hours' work, pure accessibility win, no downside.
4. **Recap "what did I miss" (#7)** — generalize the existing recap embed; pairs with AFK/Highlights for a "welcome back" moment.

*Benchmark to proceed:* if Highlights/AFK DMs stay within rate limits in a busy channel and users opt in, greenlight Stage 2.

**Stage 2 — The character-depth build (the differentiator).** Invest the real engineering here, because it's where Chloe beats both utility bots and generic AI bots:
1. **Fact-extraction memory (#8)** layered onto the existing roster, then **hierarchical summaries (#9)**. Use summarization/fact-lists, *not* a vector DB — the evidence says pure-summarization memory works and it fits browser storage. Adopt Mem0's four-operation ADD/UPDATE/DELETE/NOOP contract for the extraction prompt.
2. Ship the **conversation-quality prompt upgrades (#13–#18) in parallel** — they need no infrastructure and make every other feature feel better immediately. Do anti-repetition (#13) and lean character-card discipline (#18) first.
3. **Poll-derived Starboard (#3)** and **Polls/Suggestions (#12)** — both validate the "re-fetch reactions on a bounded recent set" pattern; build Starboard first as the proof of concept.

*Benchmark to proceed to Stage 3:* memory extraction must be transparent, user-viewable, and fully covered by the existing forget-me/permaban purge before it ships to real users.

**Stage 3 — Proactive presence (highest reward, highest annoyance risk).** Build **Free Will / dead-chat revival (#10)** only after #8 and the silence-policy prompting (#15) are solid, so Chloe initiates *intelligently*. Adopt Shapes' guardrails verbatim in spirit: hard per-channel/per-user rate limits, a Nightmode window, mod-configurable intensity defaulting to "chill" (wait-until-mentioned), and full respect for lockdown mode. **Mood continuity (#17)** rides alongside.

*Threshold that would change the plan:* if proactive messages draw any "stop pinging us" feedback, immediately drop default intensity and widen cooldowns — quality over quantity is the explicit lesson Shapes draws from operating at ~3M Shapes / ~400k MAU scale.

**Deprioritize / hold:** Leveling (#11) only if the community explicitly asks for recognition mechanics, and then build it as Chloe *noticing* people (optionally via canvas-rendered rank images) rather than a competitive grind. Skip economy entirely unless requested.

**A note on Chloe's unique browser advantages.** Two are worth exploiting because they cost no new network permissions: (1) the **canvas** for rendering rank cards / recap graphics / birthday cards locally as image attachments; (2) the **multi-tab worker pool** to parallelize the new AI-heavy work (fact extraction, summarization, recap generation) without blocking the queen's polling loop — extraction and summarization are perfect "lend me your AI capacity" jobs for workers.

## Caveats
- **Polling latency is the universal asterisk.** Starboard, polls, leveling, and dead-chat detection are all *approximations* of event-driven features — correct but slightly delayed, and capable of missing activity between polls. Frame user-facing copy accordingly ("Chloe noticed…" not "real-time").
- **Reaction-count features depend on per-message reaction fetches**, which consume REST budget. Discord's official docs cap all clients at **50 requests/second**, and warn that "IP addresses that make too many invalid HTTP requests are automatically and temporarily restricted… this limit is 10,000 per 10 minutes and leads to a **24-hour ban**. An invalid request is one that results in 401, 403, or 429 statuses." Cap the re-check window, respect the `Retry-After` header on 429s, and never tight-loop retries.
- **Dyno's Highlights is currently globally disabled for performance reasons** — a caution that naive keyword scanning across a busy server is non-trivial; bound Chloe's matching to her existing polled batches rather than scanning everything.
- **Memory/fact-extraction is the biggest privacy-and-trust surface.** The companion-dependency literature (Princeton CITP; Frontiers attachment study) flags that memory + affective mirroring deepen engagement in ways that can become manipulative. Keep extraction transparent, user-controllable, and purge-complete, and resist attachment-maximizing design.
- **Discord Developer Policy compliance:** do not use message content to train models; provide a report path (Chloe's planned report command covers this); honor the consent/transparency norms that AI bots are increasingly expected to meet.
- **Source-quality and data-discrepancy notes:** several Shapes.inc and "best bot" pages are marketing/SEO content; I've leaned on primary docs (Carl-bot, Dyno, Discord API, SillyTavern, Mem0/Antislop arXiv papers) for load-bearing claims. The Carl-bot Highlights quotes come from the GitHub repo backing docs.carl.gg (the rendered page was fetch-blocked); the verbatim text is current as of 2026. An early-draft figure of "165k Shapes over 3 months" came from Shapes' own June-2024 launch post and could not be independently corroborated; the documented later figures are ~3 million Shapes and ~400k monthly active users (TechCrunch, April 2026) — use those. Character.AI's "PipSqueak model" and group-chat specifics come from secondary 2026 guides, not C.AI's own docs, so treat those product details as reported rather than confirmed.