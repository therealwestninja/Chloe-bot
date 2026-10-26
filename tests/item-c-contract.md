# Item C contract (unified timeline — split surfaces removed 2026-10-23)

- One surface: #chatLog holds chat lines (.chatline), activity rows (.ev) and debug rows (.dbg) in arrival order. No #feed, #feedEmpty, #debugBox, #log, #clearLogBtn, #debugHead.
- unifiedBox() → byId('chatLog'); killEmpty() removes #chatEmpty on first content; trimUnified() evicts oldest non-placeholder children while childNodes > UNIFIED_MAX (400).
- feedEvent(line,t): null-tolerant; row .ev.<cls> with .t/.tag/.msg; msg strips leading [chloe.xxx]; always killEmpty + trimUnified.
- feedType(line): error|fail|warn→WARNING; abandon→ABANDON(moderation color); chloe.img|paint→IMAGE; chloe.poll→POLL; mod|strike|gate|block|softban|timeout|lockdown→MODERATION; replied|lull|checkin|beat|greeted|summon|resume→RESPONSE; chloe.ctx|fact|episode|reflect|chansum|memor|recall|trust→MEMORY; packed|context|generating|thinking|chloe.work|chloe.think→THINKING; received|asks|new message→RECEIVED; else SYSTEM.
- debugLines: buffers EVERYTHING (cap 600, slice). debugAppend(line,t) = buffer + paint .dbg row. log(line) → debug-only ? debugAppend : (buffer + feedEvent) — each line renders ONCE.
- isDebugOnly(line): error-tier always reaches .ev; chloe-page|poll:|chloe.ctx|tok|lock|poll|loop|archive|cmd|persona|character|sleep stay .dbg-only.
- feedClearBtn ("Clear conversation"): debugLines=[] + clearBox + new div#chatEmpty.chatempty "Conversation cleared." (replaces initial "Say something below…" node). Idempotent.
- debugToggleChk: change → syncDbgVis() toggles .hide-dbg on #chatLog (CSS hides .dbg). State NOT restored by timeline-HTML restores (checkbox lives outside it) — probes snapshot it.
- resetBtn: confirm('Reset T0 state…') → call('reset'); cancel = silent, timeline untouched.
