## Interview Questions

Fifteen production-reliability questions for senior C++ interviews. Each is the kind of question a staff-level interviewer at a FAANG-tier company will ask, and each has a depth of expected answer. The point is not to memorize the answers, the point is to know the depth.

---

#### 1. A C++ service in production crashes once per day with no log line and no coredump. Walk me through what you would set up to debug it.

**What the interviewer wants**: knowledge of `core_pattern`, `RLIMIT_CORE`, Crashpad/Breakpad, symbol servers, build-id-based debug info retrieval. Bonus points for noting that the absence of a log line might mean the crash is happening before the logger initializes, or the logger buffer is being lost on crash.

A senior answer covers:

- Verify `RLIMIT_CORE` is non-zero in the running process.
- Check `/proc/sys/kernel/core_pattern` and ensure dumps land somewhere reachable.
- For Kubernetes, confirm host-side `core_pattern` is configured and the dump directory is mounted.
- Add Crashpad as an in-process backstop.
- Ensure the symbol server has the build for the running binary's build-id.
- Add logging flush on signal handlers so the last log lines survive.

---

#### 2. Your service's p99 latency is fine. p99.9 is 10x p99. What might be going on, and how would you investigate?

The interviewer wants tail-latency thinking. Sources: GC pauses (less in C++, but allocator quiescence), TLB shootdowns, scheduler preemption, lock-holder preemption, slow disk pauses, network microbursts. Investigate with `perf record`, with eBPF tools (`runqlat`, `offcputime`), with allocator profiling. Mitigations: hedged requests, tied requests, micro-partitioning.

A junior answer says "look at the slow queries." A senior answer brings up Dean and Barroso's Tail at Scale paper.

---

#### 3. Walk me through the lifecycle of a `SIGTERM` to a C++ service running under Kubernetes. What needs to happen, in what order, to shut down gracefully?

The interviewer is looking for: readiness flip first, then drain, then accept-stop, then in-flight wait, then flush, then exit. Watchdog timer for force-exit. `terminationGracePeriodSeconds` interaction. PID 1 issue. The 30-second default is usually too short.

---

#### 4. You suspect a deadlock in production but cannot reproduce it. What do you do?

Heartbeat watchdog that crashes the process if it stops making progress. `eu-stack -p` or gdb-attach to dump every thread's stack. Look for circular waits in the stacks. If you have abseil mutexes, the deadlock detector would have caught it, if not, add it for the next deploy. Add lock-order documentation and a static check.

---

#### 5. Describe a circuit breaker state machine. What are the failure modes?

Three states (closed, open, half-open). Failure mode 1: stuck open because half-open probe never succeeds, mitigate by ensuring probe latency is well below cooldown. Failure mode 2: too sensitive, opens on transient blips, mitigate with sliding window and minimum-volume threshold. Failure mode 3: thundering herd on close, mitigate with gradual ramp.

---

#### 6. Your C++ service has a slow memory leak. RSS grows by 100MB per hour. How do you find it?

Enable jemalloc or tcmalloc heap profiling. Take periodic snapshots. Diff snapshots N hours apart with pprof or jeprof. The growing call site is the leak. Bonus: explain how to distinguish leak from fragmentation (compare `uordblks` vs RSS over time).

---

#### 7. You are deploying a new version of a critical service. Walk me through the rollout you would design, including what you would monitor and what would trigger automated rollback.

Canary at 1% for 30 minutes, then 5%, 25%, 50%, 100% with bake times. Monitor latency p99 and p99.9, error rate, restart rate, and any custom SLI. Auto-rollback on threshold (10% latency increase, 0.5% error increase, 2x restart rate) sustained for N minutes. Post-rollback, automatic notification to deployer.

---

#### 8. What is the difference between `CHECK` and `DCHECK`, and which would you use in a hot path that runs millions of times per second?

`CHECK` is always on. `DCHECK` is debug-only. A senior answer: use `CHECK` for cheap predicates (null check, comparison) even in hot paths, because the cost is invisible after branch prediction. Use `DCHECK` for expensive predicates (full structure validation). Profile if uncertain. The default should be `CHECK`, with `DCHECK` reserved for measured-expensive cases.

---

#### 9. A canary deployment shows healthy metrics. After 30 minutes you promote to 25%. Two hours later, p99 latency drifts up by 8%. What are the candidate explanations?

Caching, cache locality, allocator-pressure, thread-pool sizing, RSS growth that takes hours to hit pressure thresholds. The canary's small scale hid effects that only show at larger scale. The team's signal threshold was too loose. Mitigation: rollback now, then investigate.

A senior interviewer is looking for the awareness that small-canary signals are statistically weak.

---

#### 10. Design a feature-flag library for C++. What are the requirements?

Atomic reads on the hot path, non-blocking. Atomic updates without restart. Typed values. Consistent identity hashing for ramp-up. Audit trail. Owner and description per flag. Reload from a configurable source (file, etcd, internal config service) with a local fallback cache.

---

#### 11. Your service depends on a database that is down. What do you do at the code level so that this is not an outage?

Circuit breaker plus bulkhead plus fallback. The circuit breaker fails fast when the DB is down. The bulkhead bounds the threads tied up waiting. The fallback returns cached data, partial results, or a sensible default. Soft vs hard dependency classification.

---

#### 12. Describe an SLO and the math of an error budget. What does your team do when the budget is exhausted?

SLI, SLO, error budget. 99.9% over 28 days = 40 minutes equivalent. Error budget exhaustion: shift the team's priorities to reliability work. Multi-window multi-burn-rate alerts to detect fast and slow burns. Pre-agreed policy with product on what budget exhaustion triggers.

---

#### 13. What is the hedged-request pattern, and when would you use it?

A second redundant request issued after a delay (typically the p95 of the primary), with cancellation on whichever returns first. Trade: a small percentage extra load on the backend pool, dramatically lower tail latency. Useful when fan-out is wide and tail dominates user-facing latency.

---

#### 14. A new clang-tidy check is producing 200 false positives in your codebase. What do you do?

Triage. Decide which are real, which are false. For the false positives, suppress at the smallest scope (per-line) with a comment that includes a rationale. For the real positives, fix them or accept them with documentation. Do not turn the check off globally, because that loses the value of the check entirely. If the check is genuinely buggy, file an upstream issue and consider a custom matcher with better precision.

---

#### 15. Describe the structure of a good blameless postmortem. What sections should it have, and how do you keep it from becoming theater?

Sections: title, summary, impact (quantified), timeline, root cause, contributing factors, detection time, mitigation steps, action items (owned and prioritized), lessons learned, what went well. Keep it from being theater by: blameless language, weekly review of action items, follow-through tracking, public visibility within the org.

A senior interviewer is looking for the awareness that a postmortem document is the input to a process, not the end product.

---

### How to Prepare for These Questions

Read this chapter twice. Read the Google SRE book. Read the Tail at Scale paper. Have an opinion about every category: detection, prevention, recovery, debugging, operations.

The interviewer is testing whether you have lived through these problems, not whether you can recite a blog post. Ground every answer in a specific tool, a specific configuration, a specific tradeoff. "I would use a circuit breaker" is junior. "I would use a circuit breaker with a sliding-window failure threshold of 50% over 100 requests, a 30-second cooldown, and 5 half-open probes, with the state machine implemented over `std::atomic` with relaxed memory ordering on the hot path" is senior.

That level of specificity is the bar.

---
