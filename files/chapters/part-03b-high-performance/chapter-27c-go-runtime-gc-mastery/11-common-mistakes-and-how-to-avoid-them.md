## Common Mistakes and How to Avoid Them

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Default GOGC with a large live heap | High GC CPU and rising mark assist time charged to request goroutines. Not longer pauses | Raise GOGC to buy the markers headroom, and set `GOMEMLIMIT` as the backstop |
| No `GOMEMLIMIT` set in a container | OOMKill on a heap spike. It is not inherited from the cgroup, the default is effectively off | Set it yourself from the cgroup limit, minus 10 to 20 percent headroom |
| Per-request allocations on a hot path | Rising GC CPU and assist time | Remove the allocation first. Reach for `sync.Pool` only if the object is genuinely in flight and reused within a cycle |
| High pointer density in hot structs | Long concurrent mark phase, high `/gc/scan/heap:bytes` | Inline arrays, value slices instead of pointer slices, flat layouts |
| Goroutine leak | Goroutine count grows and never recovers | Context cancellation, and a `select` on `ctx.Done()` in every long-lived goroutine |
| Finalizer as primary cleanup | Resources leak on exit, since finalizers do not run at exit | Explicit `Close()` from a `defer`. Cleanup on GC is only a bug reporter |
| `fmt.Sprintf` in hot path | Unexpected allocs (measure with `-benchmem`, do not guess the size) | `strconv.AppendInt` and friends into a reused buffer |
| `SetFinalizer` on an interior pointer | Runtime panic: the argument must point to the start of an allocated object | Register the finalizer on the outermost object only, never on `&s.field` |
| Mutex on frequently read config | Contention visible in the mutex profile (after you enable it, default records 0) | RCU with `atomic.Pointer` |
| Timer not stopped | Goroutine parked on a channel that never fires | Always `Stop()` timers you abandon |
| `GOGC=off` in a long-running service | Heap grows unbounded until OOM | Never disable GC in a serving path. Use `GOMEMLIMIT` instead |
| `GOMEMLIMIT` set too close to the live heap | The death spiral: continuous GC, near-zero progress, and no OOM to restart it | Size it above the real working set, keep `GOGC` on, and alert on GC CPU share |
| Forcing `runtime.GC()` on a ticker | More total GC CPU. You added a mark phase, you did not remove one | Trust the pacer. Delete the ticker |
| `runtime.ReadMemStats` on a hot path or tight poll | It stops the world on every call, on every Go version, including current | Use `runtime/metrics`, which does not stop the world |
| `SetFinalizer` for resource cleanup | Object survives at least one extra cycle, order undefined, cycles may never run | `runtime.AddCleanup` (Go 1.24+), or explicit `Close` plus `defer` |
| `sync.Pool` used at too low a rate | Objects are dropped by the GC before reuse, so `New` runs anyway and the pool buys nothing | Measure the real hit rate by counting inside `New`. Delete pools that stay cold |
| `map[string]V` with millions of entries | Every key string is a pointer the collector follows on each cycle | Intern keys to integer IDs, or use `[]Entry` with a dense index |
| Goroutine per message on a high-fan-in channel | Goroutine count explodes, memory grows with the backlog | Bounded worker pool with a backpressure queue |
| Holding a mutex across a downstream RPC | Every slow call stalls every other caller | Release the lock before I/O, reacquire to apply the result |
| `time.Ticker` without `Stop()` | The ticker's runtime timer stays live and leaks | `defer ticker.Stop()`, including on normal completion paths |

### Junior → FAANG: the triage table

For each row of the table, learn three things: the symptom on a dashboard, the command that confirms the symptom, and the diff that fixes it.

Worked example for "default GOGC with a large live heap". The symptom is p99 latency correlating with GC cycles. The confirming command is `GODEBUG=gctrace=1`, and the field to read is the assist number in the CPU column (the first value in the `2.3/3.9/0.27` group), because assist time is GC work billed to your request goroutines and is therefore the part that lands in your latency. The diff is raising `GOGC`, setting `GOMEMLIMIT` as a backstop, and deploying with a rollback plan and a named metric to watch.

Note what the example deliberately does not say: it does not claim the pauses got shorter. If your explanation of a GC latency problem is "the pauses are milliseconds long," check your instrumentation before you change any knob, because Go's stop-the-world pauses are tens of microseconds and have been for years. Getting the mechanism right is what separates a diagnosis from a guess that happened to work.

If you can produce this trio for every row in the table, you are ready for a mid-level infrastructure interview on Go runtime diagnostics. Practice on a service you control rather than memorizing the table.

### Senior @ FAANG: the team-level anti-patterns

Beyond per-engineer mistakes, teams at scale accumulate systemic anti-patterns that no single PR can fix. Common ones: the tuning knobs across services drift out of consistency because each team picked their own numbers without a platform baseline. The runbook for "high GC CPU" has not been updated since 2022 and points at metrics that were renamed. The load test that validates GC behavior runs only in staging, which is not shaped like production. The capacity model does not include a column for RSS peak, so `GOMEMLIMIT` is guessed rather than computed. Each of these is a staff-engineer opportunity. Platform-level fixes (a shared `GOMEMLIMIT` formula, a runtime-tuning ADR template, a fleet dashboard) have leverage across every service and outlive any individual optimization. If your team has the per-service fixes in place but not these platform-level ones, that is where the next quarter of your impact is.

---
