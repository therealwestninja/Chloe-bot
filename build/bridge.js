/* chloe-bridge — tab bridge (D1, pure logic).
 *
 * Queen/worker messaging over an injected same-origin bus (BroadcastChannel in production,
 * a GM value-change adapter as fallback, an in-memory hub in tests). Like engine.js this file
 * is deliberately free of GM_*, DOM, and network code: it takes a `bus` and a `clock`, so it
 * runs identically under Node and inside the userscript.
 *
 * Design decisions (from the distributed-tab spec review):
 *  - EVENT-DRIVEN heartbeat: the queen pings, workers pong in the message handler. Workers own
 *    NO timers — background tabs get their timers clamped to ~1/min by Chrome's intensive
 *    throttling, so a worker-initiated 10s heartbeat would falsely die the moment the tab is
 *    backgrounded. Message *delivery* is not throttled, so reply-on-ping survives backgrounding.
 *  - The host drives time: call tick() periodically (queen tab is the foreground tab, so its
 *    interval is reliable). tick() sends due pings, reaps silent workers, expires requests.
 *  - Token-authenticated envelopes: the bus token lives in GM storage (script-scoped — page
 *    code on perchance.org cannot read it), so only our userscript instances can speak on the
 *    channel. Envelopes with a missing/wrong token are dropped silently.
 *  - Workers are stateless; all durable state stays with the queen (single-writer GM rule).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node / harness
  root.ChloeTabBridge = api;                                                 // userscript / window
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTabBridge(opts) {
    opts = opts || {};
    var role = opts.role === 'worker' ? 'worker' : 'queen';
    var tabId = String(opts.tabId || ('tab-' + Math.random().toString(36).slice(2, 10)));
    var token = String(opts.token || '');
    var bus = opts.bus;                      // { post(env), onMessage(fn) }
    var clock = opts.clock || { now: function () { return Date.now(); } };
    var log = typeof opts.log === 'function' ? opts.log : function () {};
    var pingIntervalMs = opts.pingIntervalMs || 15000;
    var deadAfterMs = opts.deadAfterMs || 45000;
    var requestTimeoutMs = opts.requestTimeoutMs || 30000;

    var running = false;
    var workers = {};        // queen: id -> { status, lastSeen, jobs }
    var pending = {};        // request id -> { resolve, reject, deadline, to }
    var jobHandlers = {};    // worker: jobType -> fn(args) -> Promise
    var queenId = null;      // worker: learned from the queen's 'registered' ack / pings
    var lastPingAt = 0;
    var seq = 0;

    // D6 queen failover. Enabled only when a lease adapter is injected ({get, set} over a shared,
    // script-scoped value — GM storage in production, an in-memory cell in tests). A worker that
    // hasn't heard the queen for queenDeadAfterMs claims the lease after a rank-jittered delay,
    // waits a settle period, and promotes ONLY if the read-back still shows its own claim
    // (last-write-wins resolves simultaneous claims to one winner). A clock jump between watchdog
    // ticks means the machine slept — the watchdog resets instead of electing a second queen.
    // If two queens ever coexist (revival after sleep), the lease is the tiebreaker: the queen
    // that doesn't hold it demotes back to worker.
    var lease = opts.lease || null;
    var queenDeadAfterMs = opts.queenDeadAfterMs || 90000;
    var claimSettleMs = opts.claimSettleMs || 1500;
    var wakeJumpMs = opts.wakeJumpMs || 30000;
    var leaseRenewMs = opts.leaseRenewMs || 10000;
    var lastQueenSeenAt = 0;
    var lastWatchdogAt = 0;
    var lastLeaseAt = 0;
    var claimState = null;   // null | { phase: 'waiting'|'claimed', dueAt, nonce }
    function rankDelay() {
      var h = 0, str = tabId;
      for (var i = 0; i < str.length; i++) h = ((h * 31) + str.charCodeAt(i)) >>> 0;
      return (h % 5) * 1000 + 250;
    }
    function promoteSelf() {
      role = 'queen'; workers = {}; claimState = null; lastPingAt = 0;
      log('[bridge] PROMOTED to queen (' + tabId + ')');
      if (typeof opts.onPromote === 'function') opts.onPromote();
      broadcast('ping');   // adopt surviving workers immediately (they pong; pong-from-unknown registers them)
    }
    function demoteSelf() {
      role = 'worker'; queenId = null; claimState = null; lastQueenSeenAt = clock.now();
      log('[bridge] demoted to worker (' + tabId + ') \u2014 another queen holds the lease');
      if (typeof opts.onDemote === 'function') opts.onDemote();
      broadcast('register');
    }
    function workerWatchdog(now) {
      if (lastWatchdogAt && (now - lastWatchdogAt) > wakeJumpMs) { lastQueenSeenAt = now; claimState = null; lastWatchdogAt = now; return Promise.resolve(); }
      lastWatchdogAt = now;
      if (!lease) return Promise.resolve();
      if (claimState && claimState.phase === 'claimed') {
        if (now < claimState.dueAt) return Promise.resolve();
        var myNonce = claimState.nonce; claimState = null;
        return Promise.resolve(lease.get()).then(function (l) {
          if (l && l.id === tabId && l.nonce === myNonce) promoteSelf();
          else lastQueenSeenAt = now;   // lost the race — give the winner a full window
        });
      }
      if (now - lastQueenSeenAt < queenDeadAfterMs) { if (claimState) claimState = null; return Promise.resolve(); }
      if (!claimState) { claimState = { phase: 'waiting', dueAt: now + rankDelay() }; return Promise.resolve(); }
      if (claimState.phase === 'waiting' && now >= claimState.dueAt) {
        return Promise.resolve(lease.get()).then(function (l) {
          if (l && (now - (l.at || 0)) < queenDeadAfterMs) { claimState = null; lastQueenSeenAt = now; return; }   // a live queen renews this
          var nonce = tabId + ':' + now + ':' + (++seq);
          claimState = { phase: 'claimed', dueAt: now + claimSettleMs, nonce: nonce };
          return lease.set({ id: tabId, at: now, nonce: nonce });
        });
      }
      return Promise.resolve();
    }
    function queenLeaseTick(now) {
      if (!lease) return Promise.resolve();
      if (now - lastLeaseAt < leaseRenewMs) return Promise.resolve();
      lastLeaseAt = now;
      return Promise.resolve(lease.set({ id: tabId, at: now, nonce: 'reign:' + tabId }));
    }
    function queenConflict(otherId) {
      if (!lease) { if (tabId > otherId) demoteSelf(); return Promise.resolve(); }
      return Promise.resolve(lease.get()).then(function (l) {
        if (l && l.id === tabId) return;                 // we hold the lease; the other will demote
        if (l && l.id === otherId) { demoteSelf(); return; }
        if (tabId < otherId) return Promise.resolve(lease.set({ id: tabId, at: clock.now(), nonce: 'tiebreak:' + tabId }));
        demoteSelf();
      });
    }

    function envelope(to, type, payload, re) {
      return { b: 'chloe-bus', v: 1, tok: token, from: tabId, to: to || '*', type: type, id: tabId + ':' + (++seq), re: re || null, payload: payload == null ? null : payload, ts: clock.now() };
    }
    function post(env) { try { bus.post(env); } catch (e) { log('[bridge] post failed: ' + (e && e.message)); } }
    function broadcast(type, payload) { post(envelope('*', type, payload)); }
    function sendTo(to, type, payload, re) { post(envelope(to, type, payload, re)); }

    // queen: promise-based RPC. request(workerId, jobType, args) -> Promise(result)
    function request(to, jobType, args, timeoutMs) {
      var env = envelope(to, 'job', { jobType: jobType, args: args == null ? null : args });
      return new Promise(function (resolve, reject) {
        pending[env.id] = { resolve: resolve, reject: reject, to: to, deadline: clock.now() + (timeoutMs || requestTimeoutMs) };
        if (workers[to]) workers[to].status = 'busy';
        post(env);
      });
    }

    function settle(re, ok, value) {
      var p = pending[re];
      if (!p) return;
      delete pending[re];
      if (workers[p.to]) workers[p.to].status = 'idle';
      if (ok) p.resolve(value); else p.reject(new Error(String(value || 'job failed')));
    }
    // a worker that died mid-job should fail its requests NOW, not at the request deadline —
    // the caller's fallback (e.g. run the brain locally) can start immediately.
    function rejectPendingFor(workerId, why) {
      Object.keys(pending).forEach(function (rid) { if (pending[rid].to === workerId) settle(rid, false, why); });
    }

    // D2 scheduler: route a job to an idle worker (round-robin); if there are no idle workers,
    // or the chosen worker fails/times out/dies mid-job, run the injected fallback instead.
    var rr = 0;
    function dispatchJob(jobType, payload, timeoutMs, fallback) {
      var ids = Object.keys(workers).filter(function (id) { return workers[id].status === 'idle'; });
      if (role !== 'queen' || !ids.length) {
        if (fallback) return Promise.resolve().then(fallback);
        return Promise.reject(new Error('no idle workers and no fallback'));
      }
      var id = ids[rr++ % ids.length];
      return request(id, jobType, payload, timeoutMs).catch(function (err) {
        log('[bridge] job "' + jobType + '" on ' + id + ' failed (' + ((err && err.message) || err) + ')' + (fallback ? ' \u2014 falling back' : ''));
        if (fallback) return fallback();
        throw err;
      });
    }

    function handleAsQueen(env) {
      if (env.type === 'register') {
        var fresh = !workers[env.from];
        workers[env.from] = { status: 'idle', lastSeen: clock.now() };
        sendTo(env.from, 'registered', { queenId: tabId });
        log('[bridge] worker ' + env.from + (fresh ? ' joined' : ' re-registered'));
        if (fresh && typeof opts.onWorkerJoin === 'function') opts.onWorkerJoin(env.from);
        return;
      }
      if (env.type === 'ping') { queenConflict(env.from); return; }   // another queen exists — resolve via the lease
      if (env.type === 'pong') {
        if (workers[env.from]) { workers[env.from].lastSeen = clock.now(); return; }
        workers[env.from] = { status: 'idle', lastSeen: clock.now() };   // a surviving worker adopted after promotion
        log('[bridge] adopted worker ' + env.from);
        if (typeof opts.onWorkerJoin === 'function') opts.onWorkerJoin(env.from);
        return;
      }
      if (env.type === 'bye') { if (workers[env.from]) { delete workers[env.from]; rejectPendingFor(env.from, 'worker left'); log('[bridge] worker ' + env.from + ' left'); if (typeof opts.onWorkerLost === 'function') opts.onWorkerLost(env.from, 'bye'); } return; }
      if (env.type === 'result') { settle(env.re, true, env.payload); return; }
      if (env.type === 'error') { settle(env.re, false, env.payload); return; }
    }

    function handleAsWorker(env) {
      if (env.type === 'registered') { queenId = env.payload && env.payload.queenId ? env.payload.queenId : env.from; lastQueenSeenAt = clock.now(); claimState = null; return; }
      if (env.type === 'ping') { queenId = env.from; lastQueenSeenAt = clock.now(); claimState = null; sendTo(env.from, 'pong'); return; }
      if (env.type === 'shutdown') {
        log('[bridge] shutdown received');
        broadcast('bye');
        running = false;
        if (typeof opts.onShutdown === 'function') opts.onShutdown();
        return;
      }
      if (env.type === 'job') {
        lastQueenSeenAt = clock.now();
        var jobType = env.payload && env.payload.jobType;
        var fn = jobHandlers[jobType];
        if (!fn) { sendTo(env.from, 'error', 'no handler for job type "' + jobType + '"', env.id); return; }
        Promise.resolve().then(function () { return fn(env.payload.args); }).then(
          function (res) { sendTo(env.from, 'result', res == null ? null : res, env.id); },
          function (err) { sendTo(env.from, 'error', (err && err.message) || String(err), env.id); }
        );
        return;
      }
    }

    function onBusMessage(env) {
      if (!running || !env || env.b !== 'chloe-bus') return;
      if (env.tok !== token) { log('[bridge] dropped envelope with bad token from ' + env.from); return; }
      if (env.from === tabId) return;                          // own echo (GM fallback path)
      if (env.to !== '*' && env.to !== tabId) return;          // not for us
      if (role === 'queen') handleAsQueen(env); else handleAsWorker(env);
    }

    // host calls this on its own interval (queen tab = foreground tab = reliable timers)
    function tick() {
      if (!running) return Promise.resolve();
      var now = clock.now();
      var duty = Promise.resolve();
      if (role === 'queen') {
        if (now - lastPingAt >= pingIntervalMs) { lastPingAt = now; broadcast('ping'); }
        Object.keys(workers).forEach(function (id) {
          if (now - workers[id].lastSeen > deadAfterMs) {
            delete workers[id];
            rejectPendingFor(id, 'worker lost (no heartbeat)');
            log('[bridge] worker ' + id + ' presumed dead (no pong in ' + deadAfterMs + 'ms)');
            if (typeof opts.onWorkerLost === 'function') opts.onWorkerLost(id, 'timeout');
          }
        });
        duty = queenLeaseTick(now);
      } else {
        duty = workerWatchdog(now);
      }
      Object.keys(pending).forEach(function (id) {
        if (now > pending[id].deadline) settle(id, false, 'request timed out');
      });
      return duty;
    }

    function start() {
      if (running) return;
      running = true;
      bus.onMessage(onBusMessage);
      lastQueenSeenAt = clock.now(); lastWatchdogAt = 0;
      if (role === 'worker') broadcast('register');
      log('[bridge] started as ' + role + ' (' + tabId + ')');
    }
    function stop() { running = false; }

    return {
      role: role,                                     // role at creation (legacy)
      getRole: function () { return role; },          // live role (changes on promote/demote)
      tabId: tabId,
      start: start,
      stop: stop,
      tick: tick,
      broadcast: broadcast,
      sendTo: sendTo,
      request: request,
      dispatchJob: dispatchJob,
      onJob: function (jobType, fn) { jobHandlers[jobType] = fn; },
      workers: function () { var out = {}; Object.keys(workers).forEach(function (k) { out[k] = { status: workers[k].status, lastSeen: workers[k].lastSeen }; }); return out; },
      shutdownWorker: function (id) { sendTo(id, 'shutdown'); },
      isRunning: function () { return running; }
    };
  }

  return { createTabBridge: createTabBridge };
});
