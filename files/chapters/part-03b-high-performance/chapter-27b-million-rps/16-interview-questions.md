## Interview Questions

These questions reflect what senior and staff-level candidates encounter in system design and performance-focused interviews at large-scale companies. Each answer demonstrates the depth of reasoning expected: concrete numbers, specific Go APIs, and clear trade-off analysis.

**Q: How would you design a Go service to handle 1M RPS on a single 8-core machine?**

**What FAANG expects**: You arrive at the budget math before the API choices, name specific knobs (GOGC, GOMEMLIMIT, SO_REUSEPORT), and flag what you would measure before trusting any of it. Bonus points for saying "I would not start here, I would start with `net/http` + profiling."

A: Start with the constraint: 1M RPS on 8 cores equals 125K RPS per core, or roughly 8 microseconds per request of CPU budget. This forces:
1. Zero allocations in the hot path (sync.Pool, fixed-size buffers, `unique.Make` for repeated strings)
2. GOMAXPROCS = 8 (Go 1.25+ picks this automatically inside a cgroup), GOGC around 400 with a GOMEMLIMIT so the concurrent GC pause stays under 1ms
3. SO_REUSEPORT listener per core for kernel-level load distribution across accept queues
4. Lock-free MPMC ring (Vyukov) only if profiling proves channel contention dominates
5. Radix-tree router with O(k) lookup and zero allocations on match
6. Call `time.Now()` directly (vDSO, no syscall, single-digit nanoseconds). Cache the clock behind an atomic pointer only if a profile names `time.Now()`, which it almost never does (see 12.1)
7. HTTP/2 multiplexing to backends to reuse warm TCP+TLS
8. `gnet` v2 (an epoll-based event loop on Linux) only after `net/http` is proven insufficient

**Follow-ups**:
- "Your profile shows 30 percent CPU in `encoding/json`. What now?" (first ask whether you need to parse it all: skipping fields or using a streaming decoder beats a faster codec. Then benchmark `bytedance/sonic` or `goccy/go-json` on *your* payloads, since the gap depends on document size and shape. Quote no figure you have not measured, and verify with `benchstat`)
- "How do you know your p99 number is real?" (HDR histogram client-side, coordinated-omission-aware tool like `wrk2` or `vegeta`, not `ab`)
- "What if the machine has 2 NUMA nodes?" (run two processes, bind each with `numactl`, share traffic with SO_REUSEPORT)

**Q: Explain the GMP scheduler and how it affects throughput at 1M RPS.**

**What FAANG expects**: You can draw G, M, P on a whiteboard, explain work-stealing, and connect scheduler decisions to cache and memory traffic at scale.

A: GMP has Goroutines (G), OS Threads (M), and Processors (P). Each P has a local run queue of 256 goroutines with a global fallback. At 1M RPS:
- One goroutine per request means 1M goroutine creations per second. Allocation itself is cheap (around 2KB stack), but stack scan work during GC adds up
- Prefer a bounded worker pool for CPU-bound stages. Keep goroutine-per-request for I/O-bound handlers where the scheduler's parking is the whole point
- Work stealing fires when a P's local queue drains. On a many-core box this creates cross-socket cache traffic. `GOMAXPROCS` sized to a single socket reduces it

**Follow-ups**:
- "What does `runtime.LockOSThread` buy you?" (pins the M so you can safely call `SchedSetaffinity`, cgo with thread-local state, or `signalfd`)
- "How did Go 1.25 change this?" (container-aware `GOMAXPROCS` from cgroup `cpu.max`, removes a very common misconfiguration in Kubernetes)

**Q: When should you use lock-free structures vs mutexes?**

**What FAANG expects**: You default to mutexes and justify lock-free with profile evidence, not fashion.

A: Lock-free (atomics, RCU-style copy-on-write, Vyukov MPMC) for:
- Read-mostly hot paths (routing tables, feature flags) where writes are rare
- Single-writer, multi-reader
- Contended counters where `sync/atomic` typed forms suffice (`atomic.Uint64`, `atomic.Pointer[T]` from Go 1.19)

Mutexes for:
- Multi-field invariants needing atomicity across operations
- Low-contention paths under roughly 10K ops per second per lock
- Any write-heavy scenario, CAS loops are expensive under contention

`sync.Map` has very specific performance (good only for append-mostly or disjoint key sets), and a sharded `map[K]V` behind `sync.RWMutex` is faster for most workloads.

**Follow-ups**:
- "Show me how you would prevent false sharing in a counter array." (`cpu.CacheLinePad`, or per-P sharding using `runtime_procPin` through a helper)
- "What is the ABA problem and does Go have it?" (yes in hand-rolled lock-free with pointers. The GC makes it rarer than in C, but not impossible with `unsafe.Pointer`)

**Q: Explain why false sharing kills cache performance and how to prevent it.**

**What FAANG expects**: You name the cache line size (64B on x86-64, varies elsewhere), describe MESI invalidation, and use the right Go idiom.

A: False sharing occurs when two goroutines on different CPUs write to different variables that sit on the same cache line. Each write invalidates the line on the peer core, costing roughly 100ns of coherence traffic per invalidation. At 1M writes per second that is 100ms of wall time per second wasted on coherence alone.

Fix with `golang.org/x/sys/cpu.CacheLinePad` (it picks the right size per architecture) rather than a hard-coded `[56]byte`:

```go
import "golang.org/x/sys/cpu"

type paddedCounter struct {
    _ cpu.CacheLinePad
    v atomic.Uint64
    _ cpu.CacheLinePad
}
```

**Follow-ups**:
- "When is padding a waste of memory?" (low write rate, single-writer, or already per-P sharded)
- "How do you detect false sharing in production?" (`perf c2c` on Linux. In Go you can correlate with `sched_latency` and CPU profiles showing atomic ops dominating)

**Q: How does GOMAXPROCS interact with CPU affinity and NUMA?**

**What FAANG expects**: You know Go has no native NUMA support and propose a process-level strategy.

A: GOMAXPROCS controls how many Ps exist. Go's runtime has no NUMA awareness: an M can run any G, the allocator is not per-node, and there is no API to pin a G. For a 2-socket, 32-core box the practical options are:
- One Go process per NUMA node under `numactl --cpunodebind=N --membind=N`, join via SO_REUSEPORT
- `runtime.LockOSThread` + `golang.org/x/sys/unix.SchedSetaffinity` for long-lived workers that own node-local buffers
- Accept the remote-memory penalty (check the `node distances` matrix from `numactl --hardware` for your hardware - remote is meaningfully slower than local, not a different universe of slow) and set GOMAXPROCS to the full 32

Measure before choosing. For most services, container-level `cpuset` isolation and one process per pod is simpler and within a few percent of the hand-tuned version.

**Follow-ups**:
- "Why not implement NUMA-aware allocation in user code?" (you would need to shadow `mcache`, which requires runtime patches. Not worth it)
- "Does the Go scheduler prefer the local P when a goroutine unblocks?" (yes, it wakes on the same P when possible, which helps cache locality but not NUMA memory placement)

**Q: Walk me through what changes in Go 1.27 that matter for a 1M RPS service.**

**What FAANG expects**: Current knowledge of the runtime, not just textbook scheduler trivia.

A: Three items:
1. **Green Tea GC** is the default in Go 1.26. It restructures the mark phase around **span-based scanning** for locality, cutting GC CPU by a reported 10 to 40 percent on allocation-heavy workloads with no code change. Two precision points that separate a good answer from a repeated headline: it does **not** make allocation faster (it makes marking cheaper), and the tri-color algorithm, hybrid write barrier, and pacer are all unchanged. Opt out with `GOEXPERIMENT=nogreenteagc` for A/B comparison.
2. **The size-specialized allocator** in Go 1.27 is the change that actually makes allocation cheaper, up to 30 percent on small objects. Pairing this with item 1 correctly (two different halves of the memory system, two different releases) is the tell that you follow the runtime rather than the release-note headlines.
3. **PGO** is a 2 to 14 percent speedup depending on workload, and it works through **inlining and devirtualization** specifically. If asked how, say exactly that. It does not do branch hints, register allocation, or struct reordering, and claiming otherwise is a common and easily-caught error. Profiles must be refreshed from production, since stale profiles can regress.

**Follow-ups**:
- "What is `unique.Make` and when would you use it?" (Go 1.23, weakly referenced intern table, replaces hand-rolled leak-prone intern maps)
- "How does `weak.Pointer` help a high-throughput cache?" (Go 1.24, values become GC-eligible when no strong reference exists. Lets you build bounded caches without manual eviction)

**Q: A service that peaks at 200K RPS is seeing p99 spike from 5 ms to 120 ms once per minute. You have three minutes before the interviewer presses for the root cause. Walk me through your debugging.**

**What FAANG expects**: Structured thinking under time pressure, specific tools named in the right order, and willingness to declare "I do not have enough signal yet" rather than guess.

A: One-per-minute periodicity is the fingerprint of either GC (if it correlates with `go_gc_cpu_fraction` spikes) or a scheduled job (backup, metrics flush, cron), or an upstream dependency's refresh (token refresh, DNS TTL). I would grab four signals in parallel. First, `GODEBUG=gctrace=1` output to confirm or rule out GC. Second, a 30-second trace captured during a spike via `curl /debug/pprof/trace` and opened in `go tool trace` to look for long scheduler latencies or runnable goroutines blocked. Third, the per-request log of any cron-triggered work in this service or its peers. Fourth, the downstream latency dashboard to see if the spike is upstream or local. The common root causes, in my experience: a `time.Ticker` that runs a config reload holding a write-lock briefly (fix: lock-free snapshot), a Prometheus scrape that walks an expensive metric registry (fix: sampled metrics or separate admin port), or a DNS refresh in `net/http.Transport` stalling the dialer (fix: `net.Resolver` with a longer cache TTL). I would not guess which it is until I see the trace.

**Follow-ups**:
- "The trace shows a long STW pause matching the spike, but `gctrace` shows normal GC cycles. What is it?" (a stop-the-world that is not a GC cycle: `runtime.ReadMemStats` stops the world on every call, as does `runtime.GC()`, `debug.SetGCPercent`, and a full `runtime.Stack(buf, true)` goroutine dump. Audit anything that reads mem stats or dumps stacks on a timer, including your metrics exporter. Note that `runtime/metrics` is specifically NOT in this list, since it does not stop the world, which is the reason to prefer it)
- "The spike disappears when you set `GOMAXPROCS=1`. What does that tell you?" (likely false sharing or lock contention across cores. revisit atomic structures and padding)

**Q: Your team wants to adopt `fasthttp` to double throughput. You are the staff engineer. Write the decision memo.**

**What FAANG expects**: You can run a decision process, weigh trade-offs honestly, and write something that will still make sense to the next engineer in two years.

A: Structure: context (what workload, what is the measured bottleneck, what have we tried with `net/http`), options (stay with `net/http` + tuning, migrate to `fasthttp`, migrate to `gnet`, split the hot path into a separate binary), analysis per option (throughput delta, latency delta, maintenance cost, compatibility with existing middleware/tracing/metrics, rollback path), recommendation with explicit criteria ("we recommend X, and we will revisit if Y"), risks and mitigations (API incompatibility, `context.Context` loss, third-party package maintenance, Go version upgrade path), decision and sign-off. Include a dissenting view if one exists. For `fasthttp` specifically, I would push back unless the profile shows HTTP parsing above 20 percent of CPU, which is rare, because the operational tax (no `http.Request`, no `context.Context` propagation, custom middleware) costs years of team time. The memo is more valuable than the decision itself, because it becomes the artifact future engineers revisit when the trade-off shifts.

**Follow-ups**:
- "Who should sign off on this memo?" (tech lead, on-call rotation owner, and the SRE who owns the SLO for this service, at minimum)
- "What would change your mind?" (a measured regression in `net/http` that cannot be tuned away, a kernel upgrade that makes io_uring free, or a `net/http` bug that is not being fixed within an acceptable timeline)

**Q (Junior-track onramp): You have never profiled a Go service. Where do you start?**

**What FAANG expects**: Coachability and a structured first move, not encyclopedic knowledge.

A: I would add the `net/http/pprof` import to the service, expose the pprof endpoints on a separate admin port, run a load test against the service with `wrk`, capture a 30-second CPU profile and a heap profile, and open both in `go tool pprof -http=:6061`. Then I would take the top five functions by CPU time and the top five by alloc bytes, look up what each one is doing, and form a hypothesis about which one to optimize first. I would not touch code until I had this baseline. I would also ask a senior teammate to pair with me on the first round, because reading a flamegraph is a skill that transfers much faster in a 30-minute pairing session than from a textbook.

**Follow-ups**:
- "What if you cannot pair with anyone?" (I would write my interpretation of the profile in a doc, share it, and ask for written feedback, then iterate)
- "What if adding pprof in production is not allowed?" (capture profiles from a shadow replica, or from a load-tested staging environment that receives replayed production traffic)

---
