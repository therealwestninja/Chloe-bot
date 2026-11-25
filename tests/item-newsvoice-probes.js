// News voice surface — apply fill/draft/null/absent, save mapping, prompt substitution.
// Restores boxes + lastApplied + aiTextPlugin stub (lived-in panel).
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:NEWSVOICE]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const pb = byId('newsPromptBox'), tb = byId('newsTemplateBox'), pcb0 = byId('newsPodcastBox');
const beforeP = pb ? pb.value : null, beforeT = tb ? tb.value : null, beforePP = pcb0 ? pcb0.value : null;
const beforeApplied = (typeof lastApplied !== 'undefined') ? Object.assign({}, lastApplied) : null;
const beforeAi = (typeof root !== 'undefined') ? root.aiTextPlugin : undefined;
const beforeCtx = byId('newsCtxChk') ? byId('newsCtxChk').checked : null;
function restore() {
  try {
    if (pb && beforeP !== null) pb.value = beforeP;
    if (tb && beforeT !== null) tb.value = beforeT;
    if (byId('newsPodcastBox') && beforePP !== null) byId('newsPodcastBox').value = beforePP;
    if (byId('newsCtxChk') && beforeCtx !== null) byId('newsCtxChk').checked = beforeCtx;
    if (typeof lastApplied !== 'undefined' && beforeApplied) { Object.keys(lastApplied).forEach(k => { delete lastApplied[k]; }); Object.assign(lastApplied, beforeApplied); }
    if (typeof root !== 'undefined') { if (beforeAi === undefined) delete root.aiTextPlugin; else root.aiTextPlugin = beforeAi; }
  } catch (e) {}
}
try {
  ck('NV0-tile-present', !!(pb && tb && byId('newsVoiceSaveBtn') && byId('newsVoiceResetBtn')), 'voice tile + boxes + buttons render');
  // NV1 — status with custom voice fills clean boxes.
  pb.value = ''; tb.value = '';
  if (typeof lastApplied !== 'undefined') { lastApplied.newsPrompt = ''; lastApplied.newsTemplate = ''; }
  try { applyStatus({ running: false, newsPrompt: 'Say it short: {items}', newsPostTemplate: '[{feed}]\n{body}' }); } catch (e) { ck('NV1-no-throw', false, String((e && e.message) || e)); }
  ck('NV1-status-fills', pb.value === 'Say it short: {items}' && tb.value === '[{feed}]\n{body}', 'prompt/template mirror status');
  // NV2 — a typed draft survives refreshes.
  pb.value = 'my draft prompt'; tb.value = 'my draft template';
  try { applyStatus({ running: false, newsPrompt: 'Say it short: {items}', newsPostTemplate: '[{feed}]\n{body}' }); } catch (e) { ck('NV2-no-throw', false, String((e && e.message) || e)); }
  ck('NV2-draft-preserved', pb.value === 'my draft prompt' && tb.value === 'my draft template', 'draft kept across refresh');
  // NV3 — null (engine default) shows the default text.
  if (typeof lastApplied !== 'undefined') { lastApplied.newsPrompt = 'x'; lastApplied.newsTemplate = 'x'; }
  pb.value = 'x'; tb.value = 'x';
  try { applyStatus({ running: false, newsPrompt: null, newsPostTemplate: null }); } catch (e) { ck('NV3-no-throw', false, String((e && e.message) || e)); }
  ck('NV3-null-shows-default', pb.value === DEFAULT_NEWS_PROMPT && tb.value === DEFAULT_NEWS_TEMPLATE, 'defaults shown when unset');
  // NV4 — keys absent (old engine): boxes untouched.
  pb.value = 'KeepMe'; tb.value = 'keep me';
  try { applyStatus({ running: false }); } catch (e) { ck('NV4-no-throw', false, String((e && e.message) || e)); }
  ck('NV4-absent-untouched', pb.value === 'KeepMe' && tb.value === 'keep me', 'old engine leaves boxes alone');
  // NV5 — save dispatch shape (DI, hermetic): custom passes through, default text maps to null.
  var got = null;
  pb.value = 'Custom {items}'; tb.value = 'T:{body}';
  try { saveNewsVoice(function (m, a) { got = { m: m, a: a }; return Promise.resolve({ ok: true, value: { prompt: 'Custom {items}', template: 'T:{body}' } }); }, function () {}); } catch (e) { ck('NV5-no-throw', false, String((e && e.message) || e)); }
  ck('NV5-save-custom', !!(got && got.m === 'config.setNewsVoice' && got.a && got.a.prompt === 'Custom {items}' && got.a.template === 'T:{body}'), JSON.stringify(got && got.a));
  got = null;
  pb.value = DEFAULT_NEWS_PROMPT; tb.value = DEFAULT_NEWS_TEMPLATE;
  try { saveNewsVoice(function (m, a) { got = { m: m, a: a }; return Promise.resolve({ ok: true, value: { prompt: null, template: null } }); }, function () {}); } catch (e) { ck('NV5b-no-throw', false, String((e && e.message) || e)); }
  ck('NV5-default-maps-null', !!(got && got.a && got.a.prompt === null && got.a.template === null), 'default text saves as null (engine default)');
  got = null;
  pb.value = ''; tb.value = '';
  try { saveNewsVoice(function (m, a) { got = { m: m, a: a }; return Promise.resolve({ ok: true, value: { prompt: '', template: '' } }); }, function () {}); } catch (e) { ck('NV5c-no-throw', false, String((e && e.message) || e)); }
  ck('NV5-empty-classic', !!(got && got.a && got.a.prompt === '' && typeof got.a.template === 'string'), 'empty prompt saves as empty (classic list)');
  // NV6 — prompt substitution into the brain instruction (stubbed AI, no real call).
  var captured = null;
  try { root.aiTextPlugin = function (opts) { captured = (opts && opts.instruction) || ''; return Promise.resolve('COMPOSED BODY'); }; } catch (e) {}
  var r6 = null;
  try { r6 = await newsRollup({ feed: 'Example News', date: '2026-11-02', items: [{ title: 'Rocket up', url: 'https://example.com/r' }], prompt: 'Voice for {feed} on {date}: {items}!' }); }
  catch (e) { ck('NV6-no-throw', false, String((e && e.message) || e)); }
  ck('NV6-substitution', !!captured && captured.indexOf('Voice for Example News on 2026-11-02: - Rocket up!') >= 0, String(captured).slice(0, 160));
  ck('NV6-composed-ok', !!(r6 && r6.ok && r6.value === 'COMPOSED BODY'), JSON.stringify(r6));
  // NV7 — empty prompt / no headlines decline without an AI call.
  captured = 'UNTOUCHED';
  var r7 = await newsRollup({ feed: 'F', date: 'd', items: [{ title: 't', url: 'u' }], prompt: '   ' });
  ck('NV7-empty-declines', !!(!r7.ok && captured === 'UNTOUCHED'), JSON.stringify(r7) + ' ai=' + captured);
  // NV8 — context toggle: present, status-driven, old-engine degrades to off (the default).
  var nc = byId('newsCtxChk');
  ck('NV8-tile-present', !!nc, 'context checkbox renders in the voice card');
  if (nc) {
    try { applyStatus({ running: false, newsInContext: true }); } catch (e) { ck('NV8-on-no-throw', false, String((e && e.message) || e)); }
    ck('NV8-on', nc.checked === true, 'status true checks it');
    try { applyStatus({ running: false, newsInContext: false }); } catch (e) { ck('NV8-off-no-throw', false, String((e && e.message) || e)); }
    ck('NV8-off', nc.checked === false, 'status false unchecks it');
    nc.checked = true;
    try { applyStatus({ running: false }); } catch (e) { ck('NV8-absent-no-throw', false, String((e && e.message) || e)); }
    ck('NV8-absent-off', nc.checked === false, 'old engine (no key) leaves it off = the default');
    ck('NV8-wired', typeof TOGGLES !== 'undefined' && TOGGLES.some(function (t) { return t[0] === 'newsCtxChk' && t[1] === 'config.setNewsInContext' && t[2] === 'newsInContext'; }), 'TOGGLES row owns populate+save');
  }
  // NV9 — podcast prompt: status fills, draft survives, null shows default, save carries both.
  const pcb = byId('newsPodcastBox');
  ck('NV9-tile-present', !!(pcb), 'podcast prompt box renders in the voice card');
  if (pcb) {
    pcb.value = '';
    if (typeof lastApplied !== 'undefined') lastApplied.newsPodcastPrompt = '';
    try { applyStatus({ running: false, newsPrompt: 'Say it short: {items}', newsPodcastPrompt: 'Say it ears-first: {item} {audio}', newsPostTemplate: '[{feed}]\n{body}' }); } catch (e) { ck('NV9-no-throw', false, 'threw'); }
    ck('NV9-status-fills', pcb.value === 'Say it ears-first: {item} {audio}', pcb.value.slice(0, 80));
    pcb.value = 'my podcast draft';
    try { applyStatus({ running: false, newsPrompt: 'Say it short: {items}', newsPodcastPrompt: 'Say it ears-first: {item} {audio}', newsPostTemplate: '[{feed}]\n{body}' }); } catch (e) { ck('NV9-no-throw', false, 'threw'); }
    ck('NV9-draft-preserved', pcb.value === 'my podcast draft', 'draft kept across refresh');
    if (typeof lastApplied !== 'undefined') lastApplied.newsPodcastPrompt = 'x';
    pcb.value = 'x';
    try { applyStatus({ running: false, newsPrompt: null, newsPodcastPrompt: null, newsPostTemplate: null }); } catch (e) { ck('NV9-no-throw', false, 'threw'); }
    ck('NV9-null-shows-default', pcb.value === DEFAULT_PODCAST_PROMPT, 'default podcast voice shown when unset');
    let got9 = null;
    pb.value = 'Custom {items}'; pcb.value = 'Pod {item} {duration}'; tb.value = 'T:{body}';
    try { saveNewsVoice(function (m, a) { got9 = { m: m, a: a }; return Promise.resolve({ ok: true, value: { prompt: 'Custom {items}', podcastPrompt: 'Pod {item} {duration}', template: 'T:{body}' } }); }, function () {}); } catch (e) { ck('NV9-no-throw', false, 'threw'); }
    ck('NV9-save-carries-both', !!(got9 && got9.m === 'config.setNewsVoice' && got9.a.prompt === 'Custom {items}' && got9.a.podcastPrompt === 'Pod {item} {duration}'), JSON.stringify(got9 && got9.a));
    let captured9 = null;
    try { root.aiTextPlugin = function (opts) { captured9 = (opts && opts.instruction) || ''; return Promise.resolve('EP BLURB'); }; } catch (e) {}
    let r9 = null;
    try { r9 = await newsRollup({ feed: 'Show', date: '2026-11-09', kind: 'podcast', duration: '34:12', audio: 'https://cdn.example.com/e.mp3', cadence: 'every 12 hours', items: [{ title: 'Big ep', url: 'https://example.com/e' }], itemText: '- Big ep (34:12)', prompt: 'Tell me about {feed} {kind} {duration} {audio} {cadence}: {item}' }); }
    catch (e) { ck('NV9-no-throw', false, 'threw'); }
    ck('NV9-ep-substitution', !!captured9 && captured9.indexOf('Tell me about Show podcast 34:12 https://cdn.example.com/e.mp3 every 12 hours: - Big ep (34:12)') >= 0, String(captured9).slice(0, 160));
    ck('NV9-ep-ok', !!(r9 && r9.ok && r9.value === 'EP BLURB'), JSON.stringify(r9));
    // NV10 — double-link guard: model-emitted links are stripped from the
    // blurb (engine attaches the canonical links), and the no-itemText
    // fallback feeds de-slugged words, never the URL.
    let r10 = null;
    try { root.aiTextPlugin = function () { return Promise.resolve('Great story https://example.com/r and www.evil.example.com/x plus [words](https://evil2.example.com/y)'); }; } catch (e) {}
    try { r10 = await newsRollup({ feed: 'F', date: 'd', items: [{ title: 'Rocket up', url: 'https://example.com/r' }], prompt: 'Voice: {item}' }); }
    catch (e) { ck('NV10-no-throw', false, 'threw'); }
    ck('NV10-links-stripped', !!(r10 && r10.ok && r10.value.indexOf('http') < 0 && r10.value.indexOf('www.') < 0 && r10.value.indexOf('words') >= 0), JSON.stringify(r10 && r10.value));
    let cap10 = null;
    try { root.aiTextPlugin = function (opts) { cap10 = (opts && opts.instruction) || ''; return Promise.resolve('OK'); }; } catch (e) {}
    try { await newsRollup({ feed: 'F', date: 'd', items: [{ title: 'sluggy_title-here', url: 'https://example.com/x/sluggy_title-here' }], prompt: 'Voice: {item}' }); }
    catch (e) { ck('NV10-no-throw', false, 'threw'); }
    ck('NV10-fallback-detached', !!cap10 && cap10.indexOf('http') < 0 && cap10.indexOf('sluggy title here') >= 0, String(cap10).slice(0, 160));
  }
} catch (e) {
  restore();
  ck('NVX-harness', false, String((e && e.message) || e));
}
restore();
ck('NV0-restored', pb.value === beforeP && tb.value === beforeT && (!pcb0 || byId('newsPodcastBox').value === beforePP), 'boxes restored');
const pass = checks.every(c => c.ok);
return { pass, checks };
