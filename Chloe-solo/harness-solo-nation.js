/* The Seven Nations — the readable top layer (DESIGN-council.md). node harness-solo-nation.js
 * Pure gauge, weighted deliberation through the Brain sub-system, enable/disable, odd roster, and the
 * self-knowledge that never refuses. */
'use strict';
var N = require('./nation.js');
var B = require('./brain.min.js');                       // the compiled sub-system
var fail = 0; function ok(c, m){ if (c) console.log('  ok   ' + m); else { fail++; console.log('  FAIL ' + m); } }

ok(N.NATIONS.length === 7, 'seven nations — odd, so a vote never ties');

// gauge is a pure lens: a warm line reads higher through a warm lean than a terse one
var warmS = N.gauge('I\'m here with you, I understand.', { warm: 1 });
var terseS = N.gauge('ok.', { warm: 1 });
ok(warmS > terseS, 'gauge reads warmth: a caring line outscores a terse one on a warm lean');

var cands = [
  { by: 'warm',  text: 'I\'m here with you, and I understand. We\'ll be okay, together.' },
  { by: 'spark', text: 'Ooh wait *leans in* what happened next?' } ];

// default weights: deterministic winner via the Brain sub-system (resolve)
var army = N.createArmy({ brain: B, config: { weights: {}, enabled: {} } });
army.deliberate(cands, {}).then(function (d) {
  ok(d.size === 7 && d.winnerId != null, 'all seven nations vote; a winner is chosen through ChloeBrain.resolve');

  // weighting 'play' heavily should swing the verdict toward the playful candidate
  var playful = N.createArmy({ brain: B, config: { weights: { play: 5, voice: 5 }, enabled: {} } });
  return playful.deliberate(cands, {}).then(function (d2) {
    ok(d2.winnerId === 'spark', 'heavy play/voice weight swings the winner to the spark candidate');

    // disabling nations shrinks the body (and never crashes)
    var fewer = N.createArmy({ brain: B, config: { weights: {}, enabled: { heart: false, play: false } } });
    return fewer.deliberate(cands, {});
  });
}).then(function (d3) {
  ok(d3.size === 5, 'disabled nations are excluded from the vote');

  // works even without the Brain bundle (built-in fallback) — never refuse to work
  var solo = N.createArmy({ config: { weights: {}, enabled: {} } });
  return solo.deliberate(cands, {});
}).then(function (d4) {
  ok(d4.winnerId != null, 'still decides with no Brain bundle present (local fallback)');

  // self-knowledge: it knows what it is and never refuses
  var a = N.createArmy({ config: {} });
  ok(/seven nations/i.test(a.about('who are you')), 'knows its identity');
  ok(a.about('what is your purpose').length > 0 && /kind|fitting|well/i.test(a.about('purpose')), 'states its purpose');
  ok(/heart[\s\S]*conscience/i.test(a.about('list the nations')), 'can name the seven nations');
  ok(a.about('').length > 0 && a.about('asdfqwer').length > 0, 'volunteers an answer to anything — never blank, never refuses');

  // weak noise: bounded, deterministic with an injected rng, and never flips a clear winner
  var seq = [0, 1, 0.5, 0.9, 0.1, 0.7, 0.3], i = 0, rng = function (){ return seq[(i++) % seq.length]; };
  var noisy = N.createArmy({ brain: B, config: { weights: {}, enabled: {}, noise: 0.05 }, rng: rng });
  var clear = [{ by: 'good', text: 'I\'m here with you, and I understand. We\'ll be okay, together.' }, { by: 'bad', text: 'k' }];
  return noisy.deliberate(clear, {}).then(function (dn) {
    ok(dn.winnerId === 'good', 'weak noise perturbs scores but does not flip a clear winner');
    var z = N.createArmy({ brain: B, config: { noise: 0 } });   // noise 0 -> fully deterministic
    return Promise.all([z.deliberate(cands, {}), z.deliberate(cands, {})]);
  });
}).then(function (pair) {
  ok(JSON.stringify(pair[0].tally) === JSON.stringify(pair[1].tally), 'noise:0 is exactly reproducible (kernel stays deterministic)');

  // ---- the inner life: perception, the user model, reaction, intent, self-awareness ----
  var mind = N.createArmy({ brain: B, config: { noise: 0 } });
  mind.perceive({ who: 'You', role: 'user', text: 'I feel so alone and tired tonight.' });
  ok(mind.report().indexOf('struggling') >= 0, 'a distressed turn is perceived — the society reads you as struggling');
  var warm = N.createArmy({ brain: B, config: { noise: 0 } });
  warm.perceive({ who: 'You', role: 'user', text: 'haha thank you, this is lovely, I appreciate you :)' });
  ok(warm.report().indexOf('warming') >= 0, 'a warm turn lifts the read to warming');

  return mind.deliberateIntents({}).then(function (d) {
    ok(d.speaker && d.speaker.id === 'conscience' && d.intent.kind === 'protect', 'on a struggling user, conscience takes the floor to protect — decided with no model call');
    ok(d.floor.length === 7, 'every mind proposes an intent to the floor');

    mind.reactToSpoken('conscience', 'I am here. You are not alone.');
    var c = mind.mindOf('conscience').describe();
    ok(c.lastSaid && /here/.test(c.lastSaid), 'the speaker is aware of what it just said');

    var before = mind.mindOf('heart').user.sentiment;
    mind.ingestReaction({ kind: 'up', toward: 'conscience' });
    ok(mind.mindOf('heart').user.sentiment > before, 'a thumbs-up lifts every mind\'s read of you');
    ok(mind.mindOf('heart').bonds.conscience > 0, 'and warms their bond toward the one you liked');

    var a1 = N.createArmy({ brain: B, config: { noise: 0 } }), a2 = N.createArmy({ brain: B, config: { noise: 0 } });
    [a1, a2].forEach(function (a) { a.perceive({ who: 'You', role: 'user', text: 'why does this keep happening?' }); });
    return Promise.all([a1.deliberateIntents({}), a2.deliberateIntents({})]);
  }).then(function (pair2) {
    ok(pair2[0].speaker.id === pair2[1].speaker.id, 'intent deliberation is reproducible at noise 0');
  });
}).then(function () {
  console.log('\n' + (fail ? ('FAILURES: ' + fail) : 'ALL GREEN — the nations perceive, react, intend, and decide who speaks — in pure code'));
  process.exit(fail ? 1 : 0);
}).catch(function (e){ console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
