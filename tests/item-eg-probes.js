// Items E+G probes — populate direction (panel ← status value). Synthetic s.
// Covers: 31 TOGGLES + hand-wired defaults-on + gates + automod/beats/procRules +
// Reaction-notes card follow + noticeState + charCurrent + engage/prefix/imageQueue/tz.
// Restores inputs.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:EG]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const TOG_IDS = ['affectChk','deferredIntentsChk','contradictionChk','convMemChk','feedbackChk','semanticChk','userModelChk','attentionChk','autoModChk','backfillChk','chansumChk','checkinChk','dmChk','epiChk','factChk','greetChk','imageChk','imageEnhanceChk','imageMemoryChk','lullChk','memChk','moodChk','procChk','reflectChk','selfKnowChk','spChk','summonChk','trustChk','volChk','toolsChk'];
const EXTRA_IDS = ['ackChk','goalChk','sleepChk','paceChk','epiGraphChk','timeChk','deviceTimeChk','workChk','delibChk'];
const ALL = TOG_IDS.concat(EXTRA_IDS);
const beforeChk = {}; ALL.forEach(id => { const el = byId(id); beforeChk[id] = el ? el.checked : null; });
const beforeVals = {};
['procRules','autoModRules','beatsBox','opNoteInput','prefixInput','noticeInput','tzOffset','imageQueueInput','engageModeSel','modeSel'].forEach(id => { const el = byId(id); beforeVals[id] = el ? el.value : null; });
const beforeNotice = byId('noticeState').textContent, beforeChar = byId('charCurrent').textContent;
const beforeAnchor = byId('personaAnchorChk') ? byId('personaAnchorChk').checked : null;
const beforeApplied = (typeof lastApplied !== 'undefined') ? Object.assign({}, lastApplied) : null;
const STRIP = ['runDot','runTxt','sb_run_dot','sb_run'];
const beforeStrip = {}; STRIP.forEach(id => { const el = byId(id); beforeStrip[id] = el ? { t: el.textContent, c: el.className } : null; });
function restore() {
  ALL.forEach(id => { const el = byId(id); if (el && beforeChk[id] !== null) el.checked = beforeChk[id]; });
  STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b) { el.textContent = b.t; el.className = b.c; } });
  Object.keys(beforeVals).forEach(id => { const el = byId(id); if (el && beforeVals[id] !== null) el.value = beforeVals[id]; });
  byId('noticeState').textContent = beforeNotice; byId('charCurrent').textContent = beforeChar;
  if (byId('personaAnchorChk') && beforeAnchor !== null) byId('personaAnchorChk').checked = beforeAnchor;
  try { if (typeof lastApplied !== 'undefined' && beforeApplied) { Object.keys(lastApplied).forEach(k => { delete lastApplied[k]; }); Object.assign(lastApplied, beforeApplied); } } catch (e) {}
}
try {
  // E1 — all-true status lights every toggle
  const s = { running: false, volunteer: true, greet: true, memberCheck: true, dmReplies: true, ackReactions: true, singleParagraph: true, lullFiller: true, checkins: true, factMemory: true, conversationMemory: true, feedbackLearning: true, semanticRecall: true, userModeling: true, contradictionAware: true, timeAware: true, deviceTime: true, selfKnowledge: true, moodAware: true, channelSummary: true, reflection: true, goalObjects: true, idleConsolidation: true, adaptivePace: true, workingMemory: true, idleDeliberation: true, deferredIntents: true, attentionManager: true, episodicMemory: true, episodeGraph: true, relationshipTrust: true, ownAffect: true, proceduralModes: true, reactionSummon: true, image: true, imageMemory: true, imageEnhanceOffer: true, autoMod: true, backfill: true, toolsEnabled: true };
  try { applyStatus(s); } catch (e) { ck('E1-no-throw', false, String((e && e.message) || e)); }
  const off = ALL.filter(id => { const el = byId(id); return el && !el.checked; });
  ck('E1-all-on', off.length === 0, off.length ? 'unchecked: ' + off.join(',') : 'all ' + ALL.length + ' checked');
  // E2 — missing fields: TOGGLES default OFF, but ack/goal/sleep/pace/epiGraph default ON (!==false)
  try { applyStatus({ running: false }); } catch (e) {}
  const onNow = ALL.filter(id => { const el = byId(id); return el && el.checked; });
  ck('E2-defaults', onNow.sort().join(',') === 'ackChk,epiGraphChk,goalChk,paceChk,sleepChk', 'on-with-missing=' + onNow.sort().join(','));
  // E3 — gates mapping
  try { applyStatus({ running: false, gates: { emoji: true, pings: false, everyone: true, links: false, channelLinks: true } }); } catch (e) {}
  ck('E3-gates', byId('gate_emoji').checked && !byId('gate_pings').checked && byId('gate_everyone').checked && !byId('gate_links').checked && byId('gate_channelLinks').checked, 'gates map 1:1');
  // E4 — automod/beats/procRules JSON round-trip into textareas
  try { applyStatus({ running: false, autoModRules: [{ a: 1 }], beats: [{ b: 2 }], procRules: [{ emoji: 'x', mode: 'm', durationMs: 120000 }] }); } catch (e) {}
  ck('E4-json', byId('autoModRules').value.indexOf('"a": 1') >= 0 && byId('beatsBox').value.indexOf('"b": 2') >= 0 && byId('procRules').value.indexOf('"minutes": 2') >= 0, 'automod/beats/proc(minutes=120000/60000) render');
  // E5 — F6 Batch 3: an unfocused draft with an ABSENT status field is preserved.
  byId('autoModRules').value = 'NOT JSON {{{';
  try { applyStatus({ running: false }); ck('E5-draft-preserved', byId('autoModRules').value === 'NOT JSON {{{', 'draft kept: ' + JSON.stringify(byId('autoModRules').value).slice(0, 40)); } catch (e) { ck('E5-draft-preserved', false, 'threw'); }
  // E6 — Reaction-notes card: anchor checkbox follows status (dials tree-shook 2026-10-22).
  try { applyAnchorNote({ personaAnchor: true }); } catch (e) { ck('E6-anchor-on', false, 'threw: ' + ((e && e.message) || e)); }
  ck('E6-anchor-on', byId('personaAnchorChk') && byId('personaAnchorChk').checked === true, 'anchor on follows status');
  try { applyAnchorNote({ personaAnchor: false }); } catch (e) { ck('E6-anchor-off', false, 'threw'); }
  ck('E6-anchor-off', byId('personaAnchorChk') && byId('personaAnchorChk').checked === false && byId('personaNoteBox'), 'anchor off follows status + note box present');
  // G1 — noticeState + charCurrent + engage/prefix/queue/tz
  try { applyStatus({ running: false, noticePinned: true, character: { name: 'Aria' }, engageMode: 'open', commandPrefixes: ['!c', 'chloe,'], imageQueueMax: 5, timezoneOffsetMins: -480, operatorNote: 'hello' }); } catch (e) {}
  ck('G1-misc', byId('noticeState').textContent.indexOf('pinned') === 0 && byId('charCurrent').textContent === 'Aria' && byId('engageModeSel').value === 'open' && byId('prefixInput').value === '!c, chloe,' && String(byId('imageQueueInput').value) === '5' && String(byId('tzOffset').value) === '-480', 'notice/char/engage/prefix/queue/tz render');
  // G2 — force fail: applyStatus wrench (undefined channel lists) tolerated
  try { applyStatus({ running: true, publicChannels: null, dmChannels: null }); ck('G2-null-channels', true, 'tolerated null channel lists'); } catch (e) { ck('G2-null-channels', false, 'threw: ' + ((e && e.message) || e)); }
} finally { restore(); }
let ok = true; ALL.forEach(id => { const el = byId(id); if (el && el.checked !== beforeChk[id]) ok = false; });
ck('EG0-restored', ok, ok ? 'checks + inputs restored' : 'DRIFT in checkbox restore');
const pass = checks.every(c => c.ok);
return { pass, checks };
