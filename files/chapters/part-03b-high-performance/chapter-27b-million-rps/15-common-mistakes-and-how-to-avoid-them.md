## Common Mistakes and How to Avoid Them

The following table collects the most frequent performance mistakes found in production Go services and the fix applied in the preceding sections. Each is individually minor at low request rates but becomes a dominant bottleneck when multiplied by a million operations per second.

Allocation counts below were measured with `testing.AllocsPerRun` on Go 1.27.1, linux/amd64. They are counts, not timings, so they reproduce exactly on your machine. Where this table once carried a nanosecond figure it now carries either a measured allocation count, a compiler fact you can check yourself, or nothing at all. Several of the numbers that used to live here were stale by several Go releases, which is the normal fate of a hardcoded nanosecond in a book.

| Mistake | Impact at 1M RPS | Fix |
|---------|-----------------|-----|
| Per-request allocations | Higher allocation rate means proportionally more frequent GC cycles and more GC CPU | Object pools, append-based reuse |
| `fmt.Sprintf` in hot path | 1 alloc/op for the result string, plus reflection-driven formatting | `strconv`, append-based formatting |
| Unbounded goroutines | 2 KB minimum stack each, so 200k goroutines is roughly 389 MB before they do any work | Bounded worker pool |
| `sync.Mutex` on a read-heavy map | Readers serialize against each other for no reason | `sync.RWMutex`, or `sync.Map` for the append-mostly case |
| `any` boxing | 1 alloc for values wider than a word. Ints 0-255, pointer-shaped types, and constant strings box with **0** allocs | Generics, type-specific structs |
| Missing `SO_REUSEPORT` | Single accept queue becomes the serialization point | `ListenWithReusePort` per CPU |
| Default `GOGC` (100) | GC at 2x live heap growth | `GOGC=400` + `GOMEMLIMIT` |
| `GOMAXPROCS` unaware of CFS quota (Go < 1.25) | P count follows host cores, not the container's quota, so the scheduler oversubscribes and the kernel throttles | Go 1.25+ reads the quota automatically. On older Go, set it explicitly or use `automaxprocs` |
| No connection reuse | TLS handshake per request | Keep-alives and a correctly sized idle pool |
| Large struct copying | Memory bandwidth and cache pressure | Pointer receivers |
| `MaxIdleConnsPerHost` left at the default of 2 | Idle conns above 2 are closed, so most calls re-handshake and concurrency collapses to a trickle | Raise it to match real per-host concurrency |
| `sync.Pool` of large buffers without a size cap | Per-P retention keeps one oversized buffer alive per P | Cap on `Put`, drop oversized buffers |
| Logging every request at INFO in hot path | Contention on the log writer, plus disk IO | Sampled logging, async ring buffer, or debug-only |
| Returning `[]byte` that aliases a pooled buffer | Use-after-free once the pool recycles it | Copy out before returning, or document the aliasing |
| Holding a mutex across `http.Client.Do` | Every slow downstream stalls every caller | Release the lock before I/O |
| `defer` **directly inside a `for` loop** | Falls off the open-coded path to `runtime.deferproc`, and worse, runs at *function* return rather than per iteration, so it leaks the resource it was meant to release | Wrap the body in a closure, or release manually |
| `context.WithTimeout` without `cancel()` | Holds a runtime timer and keeps the context attached to its parent until the deadline fires | Always `defer cancel()`, even on success |
| Panic in a `fasthttp` handler without recover | Worker loop crash affects many connections | Recover middleware |
| pprof on the main listener under load | Profiling traffic competes with user traffic | Separate admin listener |

Three rows deserve their evidence spelled out, because the conventional wisdom around them is wrong.

**`defer` is not slow.** Since Go 1.14 the compiler open-codes defers in a normal function body. Compile a function whose body is `mu.Lock(); defer mu.Unlock()` with `go build -gcflags=-S` and you will find no `CALL runtime.deferproc` at all: the unlock is emitted inline on the return path. The old "roughly 35 ns per defer" figure is from the pre-1.14 heap-allocated implementation and no longer describes the compiler. The one case that *does* still fall back to `runtime.deferproc` is a `defer` written directly inside a `for` loop, and there the performance cost is the least of your problems, because that defer will not run until the whole function returns.

**`time.Now()` is not a syscall.** On Linux the Go runtime resolves `clock_gettime` through the vDSO, which you can confirm on any Go binary with `go tool nm ./yourbinary | grep vdso` and seeing `runtime.vdsoClockgettimeSym`. There is no kernel transition and no ring switch. Caching the clock behind an atomic pointer is a real technique, but it buys single-digit nanoseconds against a call that costs single-digit nanoseconds, and it costs you monotonic-clock correctness. Reach for it only after a profile names it, which for the overwhelming majority of services it never will.

**Default `GOMAXPROCS` does not halve your CPU.** `GOMAXPROCS` has defaulted to `runtime.NumCPU()` since Go 1.5, so the old advice to "fix" it with `runtime.GOMAXPROCS(runtime.NumCPU())` is a no-op that has been copied between codebases for a decade. The real problem was always containers: before Go 1.25, `NumCPU()` reported the host's cores while the cgroup CFS quota allowed far fewer, so a 4-core-quota pod on a 64-core host span up 64 Ps and spent its life being throttled. Go 1.25 made the default quota-aware, which retires the `automaxprocs` dependency for most services. Note that `GOMEMLIMIT` received no such treatment: it is **not** container-aware, it is a soft limit, and you must still set it from the pod's memory limit yourself.

### Junior → FAANG diagnostic drill

For each mistake in the table, write down: the symptom in `pprof` or in a Grafana dashboard, the exact command that reveals it, and the line of code that fixes it. Example: unbounded goroutines show up as a steadily climbing `go_goroutines` metric and as a large `runtime.gopark` stack share in `pprof -http`. The command is `curl http://localhost:9090/debug/pprof/goroutine?debug=2 | head -n 200`. The fix is a bounded worker pool or a semaphore channel. If you can produce this trio for every row in the table, you have the troubleshooting fluency expected of a mid-level FAANG infra engineer.

### Senior @ FAANG: the team-level mistake catalog

Beyond per-engineer mistakes, organizations at 1M RPS accumulate systemic mistakes that no individual PR can fix. Common ones: the capacity model drifts out of sync with reality because nobody owns it, the SLO has not been reviewed in three quarters and no longer matches user expectations, the on-call runbook was written by an engineer who has since left and points at dashboards that were renamed, the load-test harness runs only in a staging environment that is shaped nothing like production, the tuning knobs are spread across six config systems with no single source of truth. A staff engineer's most impactful work is often to notice these systemic gaps, write them up, and own the fix or the handoff. Production performance is a property of the team and its artifacts, not of the code alone.

---
