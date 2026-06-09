/* D6 queen failover. node harness-failover.js
 * Election over an injected lease (in-memory here, GM storage in production), fake clock:
 * exactly one worker promotes when the queen dies; simultaneous claims resolve to one winner;
 * a sleep/wake clock jump resets the watchdog (no false election); a revived old queen loses the
 * lease tiebreak and demotes; a promoted queen adopts surviving workers via pong. */
'use strict';
var TB = require('./bridge.js');
var failures = 0;
function ok(c, m) { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } }
function makeHub() {
  var taps = [];
  return {
    join: function () {
      var mine = null;
      return {
        post: function (env) { var c = JSON.parse(JSON.stringify(env)); taps.forEach(function (t) { if (t !== mine) t(c); }); },
        onMessage: function (fn) { mine = fn; taps.push(fn); }
      };
    }
  };
}
function makeClock(t0) { var t = t0; return { now: function () { return t; }, advance: function (ms) { t += ms; } }; }
function makeLease() { var v = null; return { get: function () { return Promise.resolve(v ? JSON.parse(JSON.stringify(v)) : null); }, set: function (nv) { v = JSON.parse(JSON.stringify(nv)); return Promise.resolve(true); }, peek: function () { return v; } }; }
function flush() { return new Promise(function (r) { setImmediate(r); }); }
// drive everyone's tick, await all duties, flush microtasks
function ticks(bridges) { return Promise.all(bridges.map(function (b) { return Promise.resolve(b.tick()); })).then(flush).then(flush); }

var OPTS = { pingIntervalMs: 10000, deadAfterMs: 30000, queenDeadAfterMs: 60000, claimSettleMs: 1500, wakeJumpMs: 30000, leaseRenewMs: 10000 };

console.log('scenario 1: queen dies -> exactly one worker promotes; the other follows the new queen');
var hub = makeHub(), clock = makeClock(1700000000000), lease = makeLease();
var promoted = [], demoted = [];
function mk(role, id) {
  return TB.createTabBridge(Object.assign({ role: role, tabId: id, token: 't', bus: hub.join(), clock: clock, lease: lease,
    onPromote: function () { promoted.push(id); }, onDemote: function () { demoted.push(id); } }, OPTS));
}
var Q = mk('queen', 'Q'), W1 = mk('worker', 'W-aaa'), W2 = mk('worker', 'W-bbb');
var all = [Q, W1, W2];
Q.start(); W1.start(); W2.start();

ticks(all)
  .then(function () { clock.advance(10001); return ticks(all); })   // ping/pong + first lease renew
  .then(function () {
    Q.stop();                                                       // the queen tab is closed
    // walk past the silence threshold in watchdog-sized steps (no step exceeds wakeJumpMs)
    var p = Promise.resolve();
    for (var i = 0; i < 9; i++) p = p.then(function () { clock.advance(8000); return ticks([W1, W2]); });
    // rank delays differ; settle window passes; read-back; promotion
    for (var j = 0; j < 4; j++) p = p.then(function () { clock.advance(2000); return ticks([W1, W2]); });
    return p;
  })
  .then(function () {
    ok(promoted.length === 1, 'exactly ONE worker promoted (got: ' + promoted.join(',') + ')');
    var roles = [W1.getRole(), W2.getRole()].sort().join(',');
    ok(roles === 'queen,worker', 'one queen + one worker after failover (got: ' + roles + ')');
    var newQ = W1.getRole() === 'queen' ? W1 : W2, other = newQ === W1 ? W2 : W1;
    clock.advance(10001);
    return ticks([newQ, other]).then(function () {
      ok(!!newQ.workers()[other.tabId], 'the surviving worker was adopted by the new queen (ping -> pong -> register)');
    });
  })

  .then(function () {
    console.log('\\nscenario 2: simultaneous claims (same rank delay) -> last write wins, exactly one queen');
    var hub2 = makeHub(), clk2 = makeClock(1700000000000), lease2 = makeLease();
    var won = [];
    function mk2(id) {
      return TB.createTabBridge(Object.assign({ role: 'worker', tabId: id, token: 't', bus: hub2.join(), clock: clk2, lease: lease2,
        onPromote: function () { won.push(id); } }, OPTS));
    }
    var A = mk2('same'), B = mk2('same2');   // rank delays may or may not match; force the race by ticking in lockstep
    A.start(); B.start();
    var p = Promise.resolve();
    for (var i = 0; i < 9; i++) p = p.then(function () { clk2.advance(8000); return ticks([A, B]); });
    for (var j = 0; j < 6; j++) p = p.then(function () { clk2.advance(2000); return ticks([A, B]); });
    return p.then(function () {
      // even if both wrote a claim, read-back accepts only the surviving (last) write
      var queens = [A, B].filter(function (b) { return b.getRole() === 'queen'; });
      ok(queens.length === 1, 'exactly one winner under racing claims (queens: ' + queens.length + ')');
      ok(won.length === 1, 'exactly one onPromote fired');
    });
  })

  .then(function () {
    console.log('\\nscenario 3: sleep/wake clock jump resets the watchdog (no false election)');
    var hub3 = makeHub(), clk3 = makeClock(1700000000000), lease3 = makeLease();
    var prom3 = 0;
    var Q3 = TB.createTabBridge(Object.assign({ role: 'queen', tabId: 'Q3', token: 't', bus: hub3.join(), clock: clk3, lease: lease3 }, OPTS));
    var W3 = TB.createTabBridge(Object.assign({ role: 'worker', tabId: 'W3', token: 't', bus: hub3.join(), clock: clk3, lease: lease3,
      onPromote: function () { prom3++; } }, OPTS));
    Q3.start(); W3.start();
    return ticks([Q3, W3])
      .then(function () { clk3.advance(5000); return ticks([Q3, W3]); })          // watchdog has a baseline
      .then(function () { clk3.advance(3600000); return ticks([W3, Q3]); })       // the whole machine slept 1h; worker ticks first on wake
      .then(function () { clk3.advance(5000); return ticks([Q3, W3]); })          // queen resumes pinging
      .then(function () { clk3.advance(5000); return ticks([Q3, W3]); })
      .then(function () {
        ok(prom3 === 0 && W3.getRole() === 'worker', 'a 1h clock jump did NOT trigger an election (wake detected, watchdog reset)');
        ok(Q3.getRole() === 'queen', 'the original queen is undisturbed after wake');
      });
  })

  .then(function () {
    console.log('\\nscenario 4: revived old queen loses the lease tiebreak and demotes');
    var hub4 = makeHub(), clk4 = makeClock(1700000000000), lease4 = makeLease();
    var dem4 = [];
    function mk4(role, id) {
      return TB.createTabBridge(Object.assign({ role: role, tabId: id, token: 't', bus: hub4.join(), clock: clk4, lease: lease4,
        onDemote: function () { dem4.push(id); } }, OPTS));
    }
    var oldQ = mk4('queen', 'OLD'), newQ = mk4('queen', 'NEW');
    // NEW holds the lease (it was elected while OLD was suspended)
    return lease4.set({ id: 'NEW', at: clk4.now(), nonce: 'reign:NEW' })
      .then(function () {
        oldQ.start(); newQ.start();
        clk4.advance(10001);
        return ticks([newQ]);                       // NEW pings (and renews the lease)
      })
      .then(function () { return ticks([oldQ, newQ]); })
      .then(function () { clk4.advance(10001); return ticks([oldQ, newQ]); })   // OLD pings too; both hear a rival
      .then(function () { return ticks([oldQ, newQ]); })
      .then(function () {
        ok(oldQ.getRole() === 'worker' && dem4.indexOf('OLD') >= 0, 'the revived old queen demoted (lease says NEW)');
        ok(newQ.getRole() === 'queen' && dem4.indexOf('NEW') < 0, 'the lease holder kept the crown');
      });
  })

  .then(function () {
    console.log('\\n' + (failures ? ('FAILURES: ' + failures) : 'ALL GREEN'));
    process.exit(failures ? 1 : 0);
  })
  .catch(function (err) { console.error(err); process.exit(2); });
