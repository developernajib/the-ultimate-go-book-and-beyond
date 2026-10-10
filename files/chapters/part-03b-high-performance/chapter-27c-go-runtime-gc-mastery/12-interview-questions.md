## Interview Questions

**Q: Explain Go's tri-color mark-and-sweep GC. What guarantees correctness during concurrent marking?**

What FAANG expects: a crisp statement of the tri-color invariant, a correct description of the hybrid write barrier, and awareness that Green Tea (Go 1.26 default) changed the mark work distribution, not the algorithm.

A: The GC colors objects white (unvisited), gray (reachable but children unscanned), and black (fully scanned). The invariant is that a black object must not point directly to a white object. During concurrent marking, goroutines keep running and may create exactly that black-to-white pointer, which would let the collector free a live object. Go's **hybrid write barrier** (a Dijkstra insertion barrier combined with a Yuasa deletion barrier, since Go 1.8) shades on pointer writes so the invariant holds. The specific payoff of taking both halves is that it eliminated the stop-the-world stack rescan at mark termination, which is why Go's pauses no longer scale with the number of goroutines. Green Tea in Go 1.26 restructures the mark phase around span-based scanning for better locality. The invariant and the barrier are unchanged, and allocation is not made faster.

Do not quote a nanosecond cost for the barrier. It is a favorite trap, because every figure in circulation traces back to a blog post on an old runtime and none of them survive a re-measurement. The correct senior answer is that the cost depends on the CPU and on whether marking is even active, that the structural point is what matters (pointer-free fields never touch the barrier at all), and that you would measure it with `gctrace` and a CPU profile on the workload in question.

Follow-ups:
- What is the difference between a Dijkstra insertion barrier and a Yuasa deletion barrier, and why does Go combine them?
- If you disabled the write barrier, which specific scenario would produce a use-after-free?
- Why do Go's STW pauses remain sub-millisecond even on heaps of tens of gigabytes?

---

**Q: When would you use GOMEMLIMIT vs GOGC?**

What FAANG expects: you understand GOMEMLIMIT is a **soft** limit, not a hard cap, you can describe how the pacer reacts as memory approaches it, and you know that it is not container-aware, so someone has to set it from the cgroup limit explicitly.

A: Use both together. `GOGC` controls the ratio of live heap to GC trigger and governs GC frequency in the steady state. `GOMEMLIMIT` (Go 1.19+) is a soft memory limit: as the runtime-managed footprint approaches it, the pacer schedules GC more aggressively to stay under it. It is not a hard cap, so if the live heap genuinely exceeds the limit the runtime keeps allocating rather than crashing, and burns CPU trying.

The recipe: set `GOGC=100` (or higher if you are CPU-bound and have memory to spare), then set `GOMEMLIMIT` to roughly 85 to 90 percent of the container's cgroup memory limit, leaving the cgroup limit above it as the real OOM ceiling. You must set it explicitly. `GOMAXPROCS` reads the cgroup CPU quota as of Go 1.25, but `GOMEMLIMIT` has no equivalent, it defaults to effectively off (`math.MaxInt64`), and a proposal to make it container-aware is still open.

Two failure modes to name, because they are the follow-up: without `GOMEMLIMIT`, a large `GOGC` invites an OOMKill on a spike. And with `GOGC=off` plus `GOMEMLIMIT`, a live heap that grows toward the limit produces the **death spiral**, where the pacer collects continuously, makes no progress, and never OOMs, so nothing restarts and nothing pages. That is why leaving `GOGC` on is the right default: the ratio trigger keeps firing below the limit and the limit stays a backstop.

Follow-ups:
- A service is OOMKilled despite `GOMEMLIMIT` being set correctly, what are three possible causes?
- How does the pacer decide when to start a GC cycle, and how does `GOMEMLIMIT` change that decision?
- When would you set `GOGC=off` (`-1`) in production, and what must you pair it with?

---

**Q: How would you diagnose a service with high p99 latency that correlates with GC cycles?**

What FAANG expects: a methodical top-down approach, knowing which tool answers which question, and the discipline to measure before and after.

A: 1) Enable `GODEBUG=gctrace=1` to confirm GC is the cause and read the STW pause times and GC CPU fraction. 2) Run `go tool pprof /debug/pprof/heap` to find the top allocating call sites, and `-alloc_objects` for allocation counts versus `-alloc_space` for bytes. 3) Run `go tool trace` to correlate STW pauses with request latency and see goroutine scheduling delays. 4) Fix in priority order: reduce allocation rate at the top sites (pooling with `sync.Pool`, reusing buffers, pre-sizing slices and maps), reduce pointer density in hot types, consider `GOMEMLIMIT` and a higher `GOGC`. 5) Verify with a before and after p99 comparison using wrk2 or vegeta under the same load profile. On Go 1.27 also check whether Green Tea has already absorbed most of the cost, compare against a `GOEXPERIMENT=nogreenteagc` build to isolate its contribution.

Follow-ups:
- What does a GC CPU fraction above 25 percent in `gctrace` output tell you, and what is the first thing you look at?
- The top pprof site is `reflect.Value.Interface`, what is the likely root cause and fix?
- Your p99 improves but p99.9 does not, what else could be contributing?

---

**Q: What is the cost of SetFinalizer, and when should you avoid it?**

What FAANG expects: you know `runtime.SetFinalizer` is a last-resort tool, you know about the Go 1.24 replacements (`runtime.AddCleanup` and `weak.Pointer`), and you would never use finalizers for correctness.

A: `SetFinalizer` delays collection by one GC cycle, the object survives until the next GC after it becomes unreachable, and the finalizer runs on a dedicated goroutine where a panic crashes the program. Finalizers cannot be relied on for correctness, they are not run on `os.Exit`, their order is not specified, and circular references with finalizers prevent collection entirely. Go 1.24 added two better primitives: `runtime.AddCleanup` replaces `SetFinalizer` for resource cleanup (no resurrection, multiple registrations per object, the callback captures a value rather than the object itself), and `weak.Pointer[T]` is the correct tool for caches and interning, giving you a reference that does not keep the target alive. In new code, use `AddCleanup` for native resources and `weak.Pointer` for weak caches, and reserve `SetFinalizer` for maintaining legacy code.

Follow-ups:
- Why does `AddCleanup` not suffer from the object-resurrection problem that `SetFinalizer` has?
- Design a concurrent LRU cache using `weak.Pointer`, what stays strong and what goes weak?
- Your code has `runtime.SetFinalizer(obj, ...)` and `obj` still is not collected, list three root causes.

---

**Q: Walk me through the GMP scheduler. What happens when a goroutine makes a blocking syscall?**

What FAANG expects: correct mechanics, and above all the distinction between a *network* read and a genuinely blocking syscall. Candidates who say "a read blocks the thread" without qualification get marked down, because for the most common read in a Go service it is false.

A: The scheduler has Goroutines (Gs, user-space threads with 2 KB initial stacks), Ms (OS threads created as needed), and Ps (processors, one per `GOMAXPROCS`). A runnable G sits in its P's run queue, a bounded 256-entry ring plus a single `runnext` slot, with overflow flushed to a lock-guarded global queue.

The answer splits in two, and the split is the whole point of the question.

**Network I/O does not block an M.** A read on a socket goes through the **netpoller**. The fd is in non-blocking mode and registered with `epoll` (Linux), `kqueue` (BSD/macOS), or IOCP (Windows). If the data is not ready, the runtime parks *the goroutine only* and the M immediately picks up the next G from the run queue. When `epoll` reports readiness, the goroutine is made runnable again. This is why a Go service can hold hundreds of thousands of idle connections on 8 OS threads. The blocking-looking `conn.Read(buf)` in your handler is asynchronous underneath, and the synchronous appearance is the abstraction Go is selling.

**File I/O and cgo do block an M.** There is no portable way to poll a regular file (`epoll` on a regular file always reports ready), so a disk read is a real blocking syscall, and a cgo call is opaque to the runtime. Here the M does enter the kernel and stay there. `sysmon`, the runtime's monitoring **thread**, notices a P that has been in a syscall for roughly 20µs, retakes it, and hands it to another M (spawning one if none is idle, up to `debug.SetMaxThreads`, default 10,000) so the remaining goroutines on that P keep running. When the syscall returns, the original M tries to reacquire a P, and if none is free the G goes to the global queue and the M parks.

At scale this is why thread count can exceed `GOMAXPROCS`: it is driven by concurrent *blocking* syscalls, not by goroutine count. Ten thousand goroutines reading sockets cost you no extra threads. Ten thousand goroutines doing concurrent disk reads or cgo calls will try to, and since the default thread cap is 10,000 the program dies with "too many OS threads" rather than degrading gracefully. That is the practical reason heavy cgo or file workloads want a bounded worker pool in front of them.

Follow-ups:
- How does asynchronous preemption (Go 1.14+) interrupt a tight arithmetic loop without function calls?
- What is the difference between `runtime.Gosched()` and returning from a function, and why does it matter?
- Your service has 50,000 goroutines and only 8 Ps. How does the scheduler keep throughput up?

---

**Q: Your dashboard shows the GC consuming 15 percent of the service's CPU. Should you be worried?**

What FAANG expects: a judgment answer, not a yes/no. Staff engineers handle ambiguity without false precision. A strong candidate also questions the metric itself before reasoning from it.

A: Two things, and the first one is pedantic on purpose. I would check where that number comes from, because the commonly cited `go_gc_cpu_fraction` is not a real metric name, and the older `go_memstats_gc_cpu_fraction` (from `MemStats.GCCPUFraction`) is a **cumulative average since process start**, not a current rate. If someone is alerting on the lifetime average, a service that thrashed for ten minutes during a cold start and has been perfectly healthy for six hours still reads elevated, and conversely a regression that started an hour ago is diluted into invisibility. The number I want is a rate over a window, from the `runtime/metrics`-backed collector: `rate(go_cpu_classes_gc_total_cpu_seconds_total[5m])` over the CPU total.

Assuming the number is real: it depends on the SLO and the trade-off. Fifteen percent is high but not automatically wrong. If the service is memory-constrained and someone deliberately set a tight `GOMEMLIMIT` to trade CPU for RSS, this may be exactly the intended bargain. If it has ample memory and nobody chose it, it is a smell that usually means a high allocation rate against a default `GOGC`. My path: confirm `GOMEMLIMIT` and `GOGC` (reading `/gc/gogc:percent` and `/gc/gomemlimit:bytes`, not by calling `SetGCPercent`, which would change them), pull an allocation profile with `-sample_index=alloc_objects`, check `/gc/heap/live:bytes` for the working set, and ask whether this cost was a decision or an accident. I would not touch a knob without that context. The honest answer to "should I be worried" is "I need ten more minutes of data."

Follow-ups:
- What is wrong with alerting on a cumulative-average metric, and what do you alert on instead?
- The same service shows GC at 2 percent of CPU but p99 latency is regressing. Where do you look next?
- You lower `GOGC` to reduce RSS and GC CPU climbs above 30 percent. What tells you that you went too far, and what is the mechanism hurting latency?

---

**Q (Junior-track onramp): You have never read a `gctrace` line. Where do you start?**

What FAANG expects: coachability, willingness to look at one concrete line of output, and a structured first move.

A: I would run `GODEBUG=gctrace=1 ./service` on a local load test and copy one line into a document. I would open the Go runtime docs for the `gctrace` format and annotate each column with what it means. Then I would change one thing (increase load, change `GOGC`, increase `GOMEMLIMIT`) and see how the line changes. After ten iterations I would have a working vocabulary. I would also ask a senior teammate to review my annotated lines and correct my interpretation, because reading runtime telemetry is a skill that transfers much faster with feedback than alone.

Follow-ups:
- What if you do not have access to a senior teammate?
- Your `gctrace` shows `0+120+0 ms clock` for the mark phase, what does that tell you and what is the next profile to capture?

---

**Q (Staff-track): Your team inherits a service with `GOGC=25` hardcoded in an `init()` function, no ADR, the engineer who set it has left. What do you do?**

What FAANG expects: operator judgment, respect for mystery configurations, and a plan that does not destabilize production.

A: I would not revert the setting immediately. Someone set it for a reason, and reverting without understanding the reason is how incidents happen. My sequence: (1) measure the current baseline (RSS, GC CPU share as a rate, p99, allocation rate) and note it in a doc. (2) check the git history for the commit and the PR discussion, which often recovers the original motivation. (3) check the incident log for an incident that correlates with the change date. (4) run the service in a canary with `GOGC=100` for a few hours while comparing RSS and latency against baseline. If nothing regresses, promote to a fleet-wide rollout with a watch. If something regresses, I now know what the setting was protecting against and I can write the ADR the original engineer did not. The final artifact is either "the setting was obsolete, reverted, baseline unchanged" or "the setting is load-bearing for reason X, documented, and here is the monitoring we added so the next engineer does not repeat this exercise."

Follow-ups:
- The rollback plan needs to be automatic, how do you wire it?
- Midway through the canary, p99 regresses by 5 percent. Is that enough to revert?
- How do you decide whether to share this process with other teams as a platform standard?

