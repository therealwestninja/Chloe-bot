# Item D contract (FROZEN) — command + config buttons (effect wires via wrapper-local call())

Bounded scope: startBtn→'start' · stopBtn→'stop' · pollBtn→'poll.once'+{channelId} · refreshBtn→refresh() ·
setChannelsBtn→parseBox(//-strip)→config.setDmChannels+setAllChannels (guard: empty pub → log, NO call) ·
setTokenBtn→'token.prompt' · validateBtn→'token.validate'+15000ms ·
pinNoticeBtn→'mod.pinNotice' (guard: confirm when already pinned) ·
addModBtn→'mod.addMod' (guard: empty → log, NO call; //-strip).

Batch 2 (F5): refresh() fail path ALSO attempts `roster.get` (read-only) under the same
rosterBusy() guard (extracted helper — both paths share it so the guard can't drift).
Status-ok path byte-identical behavior. roster.get fail → silent no-op (same as before).

Constraint (named, Rule X §5): wrapper-local `call` is unstubbable from page_eval (window.call reassignment does not rebind handler closures — proven). So the SUCCESS branch (res.ok) is unreachable offline; it is DEFERRED to a live linked session. Offline we prove: (a) guard branches (fast, no transport), (b) the TIMEOUT/fail branch on the real path (batched clicks → real 8s+ timeouts → fail logs, no exceptions, link idle).
