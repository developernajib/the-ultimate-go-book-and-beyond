## Summary

Common anti-patterns and their solutions:

| Anti-Pattern | Detection | Fix |
|--------------|-----------|-----|
| Data race | `go run -race` | Mutex, atomic, channels |
| Logic race (check-then-act) | **Invariant assertions**, not `-race` | Make check and act one operation |
| Deadlock | Goroutine dump, **idle CPU**. The runtime's "all goroutines are asleep" almost never fires in a real service | Lock ordering by a stable id, plus a guard for the self-case |
| Goroutine leak | `NumGoroutine` trend, `goleak`, `pprof/goroutineleak` | Context, done channels, **buffered result channels** |
| Starvation | Profiling, tail-latency metrics | Segregate work, shorten critical sections |
| Livelock / retry storm | **Full CPU**, no progress | Random backoff, pessimistic fallback |
| Channel misuse | Panic, code review | Single ownership: the sender closes, or nobody does |
| Lock across blocking op | Block profile, mutex profile | Copy under lock, release, then do the slow work |
| Context misuse | Code review | Propagate, never store, `WithoutCancel` for cleanup |

**Debugging tools, and what each actually covers:**
- Race detector (`-race`): finds data races it observes executing. Not logic races, and not paths your tests skip. Costs roughly 2-20x CPU and 5-10x memory.
- `go vet`: its `copylocks` check catches mutex copying, which review reliably misses.
- Goroutine dumps (`runtime.Stack`): grow the buffer, or it truncates exactly when it matters.
- pprof (`/debug/pprof/goroutine`): non-destructive on a live process, unlike `SIGQUIT`.
- pprof mutex and block profiles: **off by default**. Call `SetMutexProfileFraction` and `SetBlockProfileRate` at startup or the endpoints return nothing.
- `goroutineleak` profile: GA in Go 1.27, reachability-based.
- Trace tool (`go tool trace`), Delve (`dlv`), scheduler tracing (`GODEBUG=schedtrace`).

**Prevention strategies:**
1. Always run tests with `-race`, **and assert invariants**. A test that only checks for race reports cannot fail on a check-then-act bug.
2. Use `goleak` in test suites.
3. Monitor goroutine count in production, and alert on sustained growth rather than absolute count.
4. Review for lock ordering, and for locks held across blocking operations.
5. Design with the "share memory by communicating" principle, without treating it as a ban on mutexes.
6. Use higher-level primitives when possible: `errgroup`, `semaphore.Weighted`, `singleflight`.

### For the Senior-at-FAANG Track

The real value is review discipline: recognizing anti-patterns on sight, citing them by name, and providing the fix in the PR comment. Consistent application prevents the vast majority of concurrency incidents from reaching production.

### For the Staff and Principal Track

The deliverables are the tooling and culture: `-race` and `goleak` in CI as blocking gates, mutex and goroutine profiles available in production, postmortem discipline that treats every concurrency incident as teaching material. Over years, this culture compounds into dramatically lower incident rates and faster diagnosis when incidents do happen.

### Mental Model to Take Away

Concurrency bugs are expensive to find in production and cheap to catch at review or CI time. The teams that ship reliable concurrent Go invest in the cheap layers. The teams that skimp pay the expensive costs repeatedly. The difference is cultural, not technical. Make prevention the default. Every anti-pattern in this chapter has a preventable signature. Catch them early and save the company dollars, hours, and sanity.

---
