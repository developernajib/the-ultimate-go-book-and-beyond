## Exercises

Six hands-on exercises. Each takes 4 to 12 hours. Together they cover the production-reliability surface from detection to operations. Do at least three of them.

---

### Exercise 1: Build a Crash-Reporting Pipeline

**Goal**: end-to-end crash capture for a C++ service running on Kubernetes.

**Tasks**:

1. Build a small C++ HTTP server (use cpp-httplib or similar). Add an endpoint that crashes (`std::abort` or null deref). Build it with `-g -gsplit-dwarf -fno-omit-frame-pointer`.
2. Configure `core_pattern` on the host (or in a kind/minikube cluster) to use systemd-coredump.
3. Trigger the crash. Retrieve the dump with `coredumpctl`. Open it in gdb. Confirm you see the original symbols.
4. Add Crashpad as an in-process handler. Configure it to write minidumps to a local directory. Re-trigger the crash. Confirm a minidump is generated.
5. Set up a minimal symbol-server (a directory served by nginx, indexed by build-id). Configure `DEBUGINFOD_URLS` and confirm gdb can fetch debug info on demand.
6. Document everything in a runbook.

**Stretch**: deduplicate crashes by stack-hash and write a small dashboard that counts unique stacks per day.

---

### Exercise 2: Sanitizer Canary in CI

**Goal**: catch a deliberate UAF before it reaches production.

**Tasks**:

1. Take a small C++ service of your own (or fork an open-source one). Verify the test suite is green.
2. Introduce a deliberate use-after-free in a code path that the regular test suite exercises lightly. Run the test suite. Confirm it passes (the bug escapes detection).
3. Add an ASan build to your CI. Run the test suite under ASan. Confirm ASan catches the bug.
4. Add a fuzz target for one of the public API functions. Run libFuzzer for 30 minutes. Did it find the same bug, or another?
5. Set up a regression corpus. Add the crashing input to it. Confirm the regression run reproduces the bug deterministically.
6. Fix the bug. Confirm the regression corpus now passes.

**Stretch**: add a "SAN canary" environment that runs your sanitized binary against shadow traffic and reports any diagnostics.

---

### Exercise 3: Implement a Circuit Breaker and Test It

**Goal**: a working circuit breaker library, tested for the failure modes.

**Tasks**:

1. Implement the circuit breaker from chapter 12 (closed, open, half-open with configurable thresholds and cooldown).
2. Write unit tests for: opens after threshold failures, transitions to half-open after cooldown, closes on half-open success, re-opens on half-open failure.
3. Write a stress test: spawn 64 threads, all calling a backend that has a configurable failure rate. Observe the breaker's state transitions. Confirm thread-safety (no torn states, no double-counting).
4. Add a metric for the state transitions (counts of open events, half-open probes, etc.) and expose them via prometheus-cpp.
5. Add a TSan run of the stress test. Confirm no races.

**Stretch**: integrate with a real HTTP client library (cpp-httplib, libcurl) and deploy in a small service.

---

### Exercise 4: Tail-Latency Reduction with Hedged Requests

**Goal**: empirically observe the effect of hedged requests on tail latency.

**Tasks**:

1. Build two backend processes that respond to a query. One responds in `Normal(50ms, 5ms)` (Gaussian latency). The other responds the same way most of the time but has a 1% chance of responding in 1000ms (the long tail).
2. Build a client that fans out to both backends and waits for both. Measure end-to-end latency at p50, p99, p99.9 over 10K requests.
3. Now build a hedged variant: send to one backend, wait 60ms, hedge to the other, return the first response and cancel the slow one. Measure again.
4. Compare the latency distributions. Plot histograms.
5. Compute the load multiplier (extra backend calls per request) of the hedged version.
6. Discuss the tradeoff in writing: when is the load multiplier acceptable, and when is it not?

---

### Exercise 5: Define an SLO and Build the Alert

**Goal**: a working SLO with multi-window burn-rate alerts.

**Tasks**:

1. Pick a service (yours, an open-source one, or a synthetic one). Define a user-facing SLI: typically availability and latency.
2. Pick an SLO: 99.9% availability over 28 days, 99.5% of requests under 200ms over 28 days.
3. Compute the error budget. Express it in minutes-equivalent.
4. Write Prometheus alerting rules for multi-window multi-burn-rate alerts (1h burn > 14.4 AND 5m burn > 14.4, etc.). Use the Google SRE workbook as reference.
5. Simulate an outage (use a load generator with a configurable failure rate). Observe the alerts firing. Confirm they fire at the expected burn rates.
6. Write a runbook for each alert.

**Stretch**: build the dashboard that visualizes the budget burn-down over the rolling 28-day window.

---

### Exercise 6: Run a Game Day

**Goal**: practice the incident-management process by injecting a real failure.

**Tasks**:

1. Pick a service (your own, or set up a small test service). Pick a failure to inject: kill a dependency, latency injection, disk fill, fault injection in code.
2. Schedule a game day: announce time, scope, expected impact. Get a small team (or a few engineers practicing solo) to run it.
3. Pre-game: write hypotheses. "We expect the service to gracefully degrade by serving cached responses." "We expect the on-call engineer to detect the failure within 5 minutes."
4. Run the chaos. Observe behavior. Run a mock incident response with an IC, an investigator, a scribe.
5. Post-game: write a postmortem in the format from chapter 20. Compare hypotheses to actual behavior. List action items.
6. Implement at least two of the action items.

**Stretch**: schedule a recurring game-day cadence (one per quarter). Track which areas have been covered and which remain.

---

### Bonus: Read a Real Postmortem

The Google SRE book includes anonymized postmortems. Read one. Identify:

- The proximate cause vs the contributing factors.
- The action items vs the lessons learned.
- The detection-time delta and what would have shortened it.
- One thing the team did well, one thing they would have changed.

This exercise is the cheapest reliability training that exists. Spend an evening on it.

---
