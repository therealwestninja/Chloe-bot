/* Output gates. node harness-gates.js
 * Verifies the gate logic that the bootstrap applies at every send: emoji / links / channel-links
 * are scrubbed from outgoing CONTENT when their gate is off; pings / @everyone are controlled via
 * Discord's allowed_mentions object. This mirrors bootstrap.js gateContent()/allowedMentions()
 * exactly (kept in sync by copy); if you change one, change the other. */
'use strict';
var failures = 0;
function ok(c, m) { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } }

// ---- mirror of bootstrap.js gate logic (cfg is a plain map here) ----
function mkGate(cfg) {
  function gate(k, d) { return (k in cfg) ? !!cfg[k] : d; }
  function allowedMentions() {
    var parse = [];
    if (gate('pings', false)) { parse.push('users'); parse.push('roles'); }
    if (gate('everyone', false)) parse.push('everyone');
    return { parse: parse };
  }
  function gateContent(text) {
    var t = String(text || '');
    if (!gate('emoji', true)) t = t.replace(/<a?:\w+:\d+>/g, '');
    if (!gate('channelLinks', false)) t = t.replace(/<#\d+>/g, '');
    if (!gate('links', false)) t = t.replace(/https?:\/\/\S+/gi, '');
    return t.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').trim();
  }
  return { gateContent: gateContent, allowedMentions: allowedMentions };
}

var SAMPLE = 'hey <:wave:123> check <#456> and https://example.com/x ok';

console.log('default posture (emoji on; pings/everyone/links/channelLinks off):');
var g = mkGate({});
ok(g.gateContent(SAMPLE).indexOf('<:wave:123>') >= 0, 'emoji kept by default (allowed)');
ok(g.gateContent(SAMPLE).indexOf('<#456>') < 0, 'channel link stripped by default');
ok(g.gateContent(SAMPLE).indexOf('http') < 0, 'url stripped by default');
ok(g.allowedMentions().parse.length === 0, "allowed_mentions parse is empty by default (no real pings) \u2014 Discord's own gate");

console.log('\nemoji gate off -> custom emoji stripped:');
ok(mkGate({ emoji: false }).gateContent(SAMPLE).indexOf('<:wave:123>') < 0, 'custom emoji removed when emoji gate is off');
ok(mkGate({ emoji: false }).gateContent('plain text only').length > 0, 'plain text survives emoji stripping');

console.log('\nlinks gate on -> urls preserved:');
ok(mkGate({ links: true }).gateContent(SAMPLE).indexOf('https://example.com/x') >= 0, 'urls kept when links gate is on');

console.log('\nchannel-links gate on -> channel refs preserved:');
ok(mkGate({ channelLinks: true }).gateContent(SAMPLE).indexOf('<#456>') >= 0, 'channel ref kept when channelLinks gate is on');

console.log('\npings via allowed_mentions (Discord-native):');
ok(mkGate({ pings: true }).allowedMentions().parse.indexOf('users') >= 0, 'pings on -> users + roles parseable');
ok(mkGate({ pings: true }).allowedMentions().parse.indexOf('everyone') < 0, 'pings on does NOT enable @everyone (separate gate)');
ok(mkGate({ everyone: true }).allowedMentions().parse.indexOf('everyone') >= 0, '@everyone gate independently enables everyone');
ok(mkGate({ pings: true, everyone: true }).allowedMentions().parse.length === 3, 'all ping gates on -> users, roles, everyone');

console.log('\ngating is independent + tidy:');
ok(mkGate({ emoji: false, links: true, channelLinks: true }).gateContent(SAMPLE) === 'hey check <#456> and https://example.com/x ok', 'mixed gates apply independently and tidy whitespace');
ok(mkGate({}).gateContent('multi\nline\nkept') === 'multi\nline\nkept', 'newlines are preserved (only horizontal runs collapse)');

console.log('\n' + (failures ? ('FAILURES: ' + failures) : 'ALL GREEN'));
process.exit(failures ? 1 : 0);
