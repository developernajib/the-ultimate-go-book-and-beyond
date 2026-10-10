## Real Postmortem Walkthroughs

Theory is cheap. Postmortems are the real teacher. This chapter walks through three anonymized incidents from real C++ services, with full timelines, root causes, and the lessons each team adopted. The shape of these incidents will repeat in your career, the patterns are worth absorbing.

---

### Postmortem 1: The Slow-Burn Memory Leak

#### Summary

A C++ recommendations service experienced gradual RSS growth over 11 days, culminating in OOM-kills across the fleet during a traffic spike. User-visible: 5xx error rate elevated for 38 minutes during the cascade.

#### The Service

A C++ binary running on Kubernetes, 800 pods globally, serving 80K QPS. Each pod has a 16GB memory limit. Normal RSS at steady state: 10-12GB. Restart cadence: weekly, scheduled, for deployments.

#### Timeline (UTC)

```
April 1, 14:30  v211 deployed. New tokenizer enabled.
April 1-11      RSS climbs from 11GB to 14GB across the fleet.
                No alerts (RSS was below 90% threshold).
April 12, 09:00 Daily traffic peak begins.
April 12, 09:18 First pod OOM-killed in us-east1.
April 12, 09:19 Restart, fresh pod takes traffic.
April 12, 09:20 Second pod OOM-killed (load shifted to it).
April 12, 09:22 Cascade begins. Pods OOM-kill each other due to load redirection.
April 12, 09:25 Service-level error rate above 1%. Alert fires.
April 12, 09:27 On-call paged.
April 12, 09:31 IC declared. Investigators dive in.
April 12, 09:38 Hypothesis: a slow leak (RSS dashboard shows the trajectory).
April 12, 09:42 Decision: rollback to v210 to remove the leak.
April 12, 09:55 Rollback complete in us-east1. Pods stable.
April 12, 10:03 Rollback complete globally. Errors stop.
April 12, 10:05 Incident mitigated. Investigation continues.
April 12, 14:00 Root cause confirmed. Postmortem drafted.
```

#### Root Cause

The new tokenizer added a `std::vector<TokenInfo>` to the connection-level state on each query, intended to be cleared between queries. The clear was inside an early-return path that was skipped for queries with empty results. The vector accumulated across queries on long-lived gRPC streams.

The leak rate was small: about 200 bytes per query on connections that hit the empty-result path. That path was rare (under 1% of queries). With 80K QPS and a steady fraction of long-lived streams, the leak amounted to roughly 250MB per day per pod. After 11 days, the average pod had 3GB of leaked memory.

#### Why the Detection Was Slow

- The 90% RSS threshold was too far in advance. By the time it fired, the leak was severe.
- Heap profiling was not enabled by default, the team had to turn it on after the incident.
- The RSS dashboard existed but was not in any alerting policy.
- The weekly restart cadence had been masking smaller leaks for months, the team had stopped looking at long-term RSS trends.

#### Action Items

- Add a long-window RSS-growth alert (rate of growth, not absolute level).
- Enable heap profiling in production with low overhead sampling.
- Set up a daily "long-running pod" report: the longest-uptime pods, their RSS, by service.
- Add a clang-tidy check that flags container members of long-lived state without explicit lifecycle management.
- The specific fix for the leak: move the `clear()` outside the conditional path, plus a unit test for the empty-result case.

#### Lessons

- A weekly restart hides small leaks. Without explicit RSS-rate monitoring, the leak never surfaced until it became severe.
- Threshold-based alerts on RSS are reactive, rate-based alerts are proactive.
- Production heap profiling pays for itself the first time it catches a leak. Enable by default.

---

### Postmortem 2: The Contention Regression at Scale

#### Summary

A C++ search index service shipped a `std::shared_mutex` change that increased tail latency by 40ms at p99.9. The change passed all tests but failed in production because the lock biased toward writers under sustained read traffic. Detection took 6 days. Mitigation took 10 minutes.

#### The Service

A C++ in-memory index, 200 pods, 50K QPS read, 100 QPS write. Read-write ratio: 500:1.

#### The Change

The change replaced a `absl::Mutex` with a `std::shared_mutex` to allow concurrent reads. The intent was to reduce tail latency on reads. Tests confirmed: under uniform load, reads were faster.

#### Timeline (UTC)

```
April 5         v158 deployed. Tail latency at p99.9 unchanged at first
                (within noise). Standard deploy proceeds.
April 6-10      Tail latency at p99.9 drifts up by 5-10%. Below alert threshold.
April 11        Customer escalation: a user reports specific queries are
                slower. Team investigates.
April 11, 11:00 Engineer notices the p99.9 latency dashboard has been red
                for several days.
April 11, 11:30 Bisects deploys. v158 looks suspect.
April 11, 11:45 Decision: rollback to v157.
April 11, 11:55 Rollback complete. p99.9 returns to baseline.
April 11-13     Investigation into root cause.
April 13        Root cause confirmed.
```

#### Root Cause

The `std::shared_mutex` (libstdc++ implementation, GCC 13) used a writer-preference policy: when a writer was waiting, new readers were blocked. With 500:1 read:write, the readers usually had no contention. But during the rare write, the queue of pending readers built up. By the time the writer released, hundreds of readers fired simultaneously, contending for the same cache lines and producing a small thundering herd.

This caused a 40ms tail spike on every write. With 100 writes per second and 50K reads per second, only the tiny fraction of reads that arrived during a write window felt the spike, but those reads landed at p99.9.

The bug was invisible in unit tests (no realistic read:write ratio), invisible in load tests (synthetic uniform load), and only visible at production scale.

#### Why Detection Was Slow

- The p99.9 alert had a 28-day SLO window, a 5% degradation took weeks to consume the budget meaningfully.
- The dashboard had p99 (unaffected) prominently displayed, p99.9 was a smaller chart few engineers noticed.
- The performance regression test in CI used uniform load, not the production read:write ratio.
- A canary did exist, but at 1% the absolute number of writes was too small to produce statistically significant regression in the canary window.

#### Action Items

- The specific fix: replace `std::shared_mutex` with `absl::Mutex` (which has a different fairness policy more suited to read-heavy workloads).
- Add a performance regression test that mirrors production read:write ratio (500:1, not uniform).
- Add a tail-latency dashboard (p99, p99.9, p99.99) to the canary signal evaluation. Alert on canary regression at p99.9.
- Document the writer-preference behavior of `std::shared_mutex` in the team's coding guide.

#### Lessons

- Synthetic load does not reproduce production. The performance test must mirror the actual read:write ratio.
- p99 can mask p99.9 issues. Always look at the higher percentiles too.
- A rollback is far cheaper than chasing the root cause. The team rolled back in 10 minutes, root cause took two days.

---

### Postmortem 3: The TSan Race That Escaped to Prod

#### Summary

A C++ payment processing service had a data race on an internal counter that produced incorrect transaction totals once per few million transactions. The bug went undetected for 4 months until reconciliation reports highlighted the discrepancy.

#### The Service

A C++ payment service, 50 pods, 5K transactions per second. Each transaction increments a per-merchant `running_total` counter, used for daily reconciliation.

#### The Bug

```cpp
class MerchantState {
    int64_t running_total_;  // not atomic
    std::mutex mu_;
public:
    void Apply(int64_t amount) {
        std::lock_guard<std::mutex> lock(mu_);
        running_total_ += amount;
    }
    int64_t Read() const {
        return running_total_;  // read without holding the lock
    }
};
```

The `Read()` did not hold the mutex. Most reads got a clean value, because the counter was 8 bytes and aligned, and a torn read on x86 is rare. But under specific scheduler interactions, a read could observe a partially-updated value, off by an incomplete-write delta.

#### Timeline

```
December: Code merged. Unit tests pass. Code review missed the missing lock.
December-March: Bug fires roughly once per 3 million transactions, producing
                a small discrepancy in reconciliation reports. Discrepancies
                are within the team's "rounding tolerance" and ignored.
March 12:       Finance team notices a sustained reconciliation drift.
                Escalates to engineering.
March 14:       Engineering investigation begins.
March 18:       TSan rerun on the codebase. TSan flags the race immediately.
March 18:       Fix landed (use atomic, drop the mutex for reads).
March 25:       Reconciliation drift gone.
```

#### Root Cause

The lock-free read was a microoptimization the original author had added to remove contention on the read path. TSan would have caught it instantly if TSan had been part of the CI gate.

#### Why TSan Was Not Catching It

- TSan was run nightly, not on every PR.
- The nightly TSan run used a small unit-test corpus that did not exercise this code path under concurrency.
- The code review missed the missing lock because the lock pattern was inconsistent across the file.

#### Action Items

- The specific fix: use `std::atomic<int64_t>` for `running_total_`, drop the mutex for the simple counter case.
- Move TSan from nightly to per-PR for files in the payment module.
- Add an integration test that exercises the `Apply`/`Read` race deliberately under concurrency.
- A clang-tidy check that flags member fields written under a lock and read without it.
- Reconciliation tolerance was masking the bug, tighten the tolerance.

#### Lessons

- A microoptimization that reads outside the lock is almost always wrong. The discipline: lock or atomic, never neither.
- TSan in CI should be aggressive enough to catch real races. Nightly is too late if the bug ships in the meantime.
- Reconciliation discrepancies "in tolerance" can hide real bugs. Investigate them, do not absorb them.
- Code review caught nothing here. Tools caught it. Lean on tools.

---

### The Patterns

Three different incidents, three different categories (memory leak, contention regression, data race), but common patterns:

- **Detection is the hardest part.** All three bugs were trivially fixable once identified. The challenge was noticing them.
- **Test environments do not match production.** Synthetic load, uniform read:write, small unit corpora. None of these caught what production did.
- **Telemetry that is not alerted on is decorative.** RSS dashboards, p99.9 latency, reconciliation reports: all existed before each incident, none were wired to alerting.
- **Tools beat reviews.** TSan, heap profiling, clang-tidy each could have caught these bugs. Code review caught none.

A senior engineer reads a postmortem and asks: "what tool would have caught this?" The answer is the action item.

---
