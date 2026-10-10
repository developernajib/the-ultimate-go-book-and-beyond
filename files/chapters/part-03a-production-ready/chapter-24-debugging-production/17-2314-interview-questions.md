## 24.14 Interview Questions

### Question 1: How do you debug a memory leak in a Go production service?

**What FAANG expects:** A structured playbook (confirm, compare, attribute, fix), awareness that "Go memory leak" means reachable-but-unreclaimed objects (not a runtime GC bug), and working knowledge of `inuse_space` vs `alloc_space`, `GOMEMLIMIT`, and the `runtime/metrics` package. Strong candidates also mention continuous profiling (Grafana Pyroscope, Datadog, Google Cloud Profiler) so they have pre-incident baselines instead of starting capture after the page fires.

**Answer:**

Memory leak debugging in Go production follows a four-step process: confirm the leak with runtime metrics, capture comparative heap profiles, identify the allocation source in pprof, and match it against known leak patterns.

**Step 1: Confirm the Leak**
```go
// Monitor heap growth over time
func monitorMemory(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    var baseline uint64

    for range ticker.C {
        var m runtime.MemStats
        runtime.ReadMemStats(&m)

        if baseline == 0 {
            baseline = m.HeapAlloc
        }

        // Convert to float BEFORE subtracting. MemStats fields are uint64
        // and HeapAlloc sawtooths down at every collection, so
        // float64(m.HeapAlloc-baseline) underflows to an enormous positive
        // number the first time the heap shrinks below the baseline.
        growth := (float64(m.HeapAlloc) - float64(baseline)) / float64(baseline) * 100
        log.Printf("Heap: %dMB (%.1f%% growth), Objects: %d, GC: %d",
            m.HeapAlloc/1024/1024, growth, m.HeapObjects, m.NumGC)
    }
}
```

**Step 2: Capture Comparative Heap Profiles**
```bash
# Capture baseline
curl -o heap1.prof http://localhost:6060/debug/pprof/heap

# Wait for leak to manifest (e.g., 10 minutes)
sleep 600

# Capture after leak
curl -o heap2.prof http://localhost:6060/debug/pprof/heap

# Compare profiles
go tool pprof -base=heap1.prof heap2.prof
(pprof) top10 -cum
```

**Step 3: Identify Allocation Sources**
- Look for growing allocations with `inuse_space`
- Check `alloc_space` for total allocations
- Focus on functions with high cumulative allocations

**Step 4: Common Leak Patterns to Check**
- Unbounded slices or maps
- Goroutines not being canceled
- Timer/ticker leaks
- Circular references preventing GC
- Caches without eviction

**Follow-up Questions:**
- "How would you distinguish between a memory leak and normal memory growth?" (Answer: leaked memory grows monotonically across GC cycles and does not correlate with traffic. Normal growth plateaus as caches warm and returns to baseline after off-peak GC cycles.)
- "What's the difference between `inuse_space` and `alloc_space` in pprof?" (Answer: `inuse_space` is live bytes at sample time, what the GC cannot reclaim. `alloc_space` is cumulative bytes ever allocated. Leaks show up in `inuse_space`. Allocation pressure shows up in `alloc_space`.)
- "How does `GOMEMLIMIT` change your leak response?" (Answer: under `GOMEMLIMIT`, a leak shows up as rising GC CPU percentage before it shows up as rising RSS, because the GC runs harder to stay under the soft limit. Alert on GC CPU fraction from `runtime/metrics` not just RSS.)

### Question 2: Your service has high latency. How do you identify the bottleneck?

**What FAANG expects:** Layered diagnosis that starts from user-visible symptoms (tail latency percentiles, span durations) and narrows down via CPU profile, block profile, and goroutine state analysis. The candidate should distinguish CPU-bound (fix with flame graph) from I/O-bound (fix with tracing) from contention-bound (fix with block/mutex profile) causes, and should know the Go 1.25 `runtime/trace.FlightRecorder` as the right tool for rare tail-latency events.

**Answer:**

**Step 1: Gather Distributed Tracing Data**
```go
// Check span durations in traces
// Look for the slowest spans in the critical path
func analyzeTrace(spans []Span) {
    for _, span := range spans {
        if span.Duration > 100*time.Millisecond {
            log.Printf("Slow span: %s in %s took %v",
                span.Operation, span.Service, span.Duration)
        }
    }
}
```

**Step 2: CPU Profile to Find Hot Functions**
```bash
# Capture CPU profile during high latency period
curl -o cpu.prof "http://localhost:6060/debug/pprof/profile?seconds=30"
go tool pprof -http=:8081 cpu.prof
```

**Step 3: Check for Lock Contention**
```bash
# Block profile shows where goroutines are blocked
curl -o block.prof http://localhost:6060/debug/pprof/block
go tool pprof block.prof
(pprof) top10
```

**Step 4: Analyze Goroutine States**
```go
// Many goroutines in same state = bottleneck
func analyzeGoroutines() {
    buf := make([]byte, 1024*1024)
    runtime.Stack(buf, true)

    states := make(map[string]int)
    // Parse and count states
    // High count of "chan receive" or "semacquire" = contention
}
```

**Step 5: Database/External Service Analysis**
- Check connection pool exhaustion
- Analyze slow query logs
- Review circuit breaker metrics

**Follow-up Questions:**
- "Your P50 is fine but P99 is terrible. Which profile do you pull first?" (Answer: execution trace via `runtime/trace`, not CPU profile. CPU profile shows average hot paths. Traces show scheduler latency, GC pauses, and syscall stalls that only affect tail.)
- "The flame graph is dominated by `runtime.gcBgMarkWorker`. What do you do?" (Answer: you are GC-bound, not logic-bound. Reduce allocation rate (sync.Pool, pre-size slices, avoid reflection in hot paths), raise `GOGC`, or set a larger `GOMEMLIMIT`. Profile with `alloc_space` to find the biggest allocators.)
- "Block profile is empty but latency is spiky. What next?" (Answer: block profile only records blocking events longer than `SetBlockProfileRate`. Lower the rate on a canary, or use the execution trace, scheduler-latency events do not show in block profile.)

### Question 3: How do you safely attach a debugger to a production Go service?

**What FAANG expects:** A candidate who says "you usually don't". The expected pattern at scale is drain-one-replica, take a core dump, analyze offline. Attaching Delve live pauses all goroutines and will drop traffic. Candidates who describe `gcore` + `dlv core` + secure symbol handling score much higher than those who jump to `dlv attach`.

**Answer:**

**Safety Considerations:**
1. Never attach to all replicas simultaneously
2. Use load balancer to drain traffic first
3. Set time limits on debug sessions
4. Have rollback plan ready

**Implementation:**

```go
// Build with debug symbols preserved
// go build -gcflags="all=-N -l" for full debugging
// Or use -gcflags="-N -l" for specific packages

// On the production server:
func enableRemoteDebugging(addr string) {
    // Only enable temporarily through config/feature flag
    if !config.GetBool("enable_remote_debug") {
        return
    }

    // Start Delve server.
    //
    // addr must be a loopback address such as "127.0.0.1:2345". Delve's API
    // has no auth and no TLS, so anything reachable here gets code execution
    // as this process. Reach it over an SSH tunnel.
    cmd := exec.Command("dlv", "attach",
        strconv.Itoa(os.Getpid()),
        "--headless",
        "--listen="+addr,
        "--api-version=2",
        "--accept-multiclient",
    )

    // Start first, and check the error. The timeout goroutine below
    // dereferences cmd.Process, which stays nil if Start fails, so
    // launching the watchdog before Start risks a nil dereference half an
    // hour later in a goroutine with no recover, taking the service with it.
    if err := cmd.Start(); err != nil {
        log.Printf("failed to start delve: %v", err)
        return
    }

    // Auto-detach after 30 minutes. Killing dlv releases the ptrace stop
    // and the target resumes.
    go func() {
        time.Sleep(30 * time.Minute)
        if err := cmd.Process.Kill(); err != nil {
            log.Printf("failed to kill delve: %v", err)
        }
    }()
}
```

**Best Practices:**
- Use SSH tunneling, never expose Delve directly
- Enable only on specific instance, not cluster-wide
- Log all debug sessions for audit
- Consider using conditional breakpoints to minimize impact

**Follow-up Questions:**
- "Why is `dlv attach` dangerous on a live replica?" (Answer: Delve uses `ptrace`, which suspends every goroutine while the debugger holds the process. A multi-second attach drops all in-flight requests and can trip upstream health checks, cascading into traffic loss.)
- "What's the safer alternative?" (Answer: `gcore <pid>` on a drained replica, then `dlv core` on a jumpbox, which gives you the same inspection surface with no debugger anywhere near live traffic. Be precise about why it is safer, because it is not free: `gcore` also attaches with `ptrace` and also stops the process. The difference is bounded duration. It suspends for as long as it takes to write the address space to disk and then detaches, rather than for as long as a human is typing at a REPL. That write scales with heap size, roughly 800ms of stall for a 600MB heap on local disk, so several seconds for a multi-gigabyte service. Long enough to fail a health check, which is exactly why you drain first.)
- "So is anything genuinely pause-free?" (Answer: the pprof endpoints. A heap profile is sampled and cheap, and a CPU profile costs a few percent while running. If you need state from a replica that must keep serving, that is the tool. Cores and debuggers are for replicas you have already taken out of rotation.)
- "How do you protect the secrets in that core file?" (Answer: cores contain env vars, tokens, in-memory keys. Ship to an encrypted bucket with narrow IAM, rotate any credentials that were live at capture time, and delete the core within an SLA window.)

### Question 4: Explain how you would implement a goroutine leak detector.

**What FAANG expects:** Understanding that `runtime.NumGoroutine()` alone is insufficient (you can leak in pairs), willingness to group by top-of-stack frame, and awareness of the GC-backed `/debug/pprof/goroutineleak` profile (experimental in Go 1.26, generally available in Go 1.27) which proves unreachability instead of guessing. Bonus for explaining the false-positive risk of count-based heuristics during traffic spikes.

**Answer:**

```go
type GoroutineLeakDetector struct {
    baseline       int
    threshold      float64 // Growth rate threshold, fraction of baseline per hour
    sampleInterval time.Duration // time between Check() calls
    samples        []int
    logger         *slog.Logger
}

// sampleInterval is how often Check is called, NOT the length of the
// window. The slope below is in goroutines per sample, so converting it to
// a per-hour figure requires the spacing between samples. Dividing by a
// window length instead is a units error that silently scales the reported
// rate by however many samples fit in the window.
func NewGoroutineLeakDetector(threshold float64, sampleInterval time.Duration) *GoroutineLeakDetector {
    return &GoroutineLeakDetector{
        baseline:       runtime.NumGoroutine(),
        threshold:      threshold,
        sampleInterval: sampleInterval,
        samples:        make([]int, 0, 60),
        logger:         slog.Default(),
    }
}

func (d *GoroutineLeakDetector) Check() *LeakReport {
    current := runtime.NumGoroutine()
    d.samples = append(d.samples, current)

    // Keep only recent samples
    maxSamples := 60
    if len(d.samples) > maxSamples {
        d.samples = d.samples[len(d.samples)-maxSamples:]
    }

    // Calculate growth rate using linear regression
    if len(d.samples) < 10 {
        return nil
    }

    // slope is goroutines gained per sample. Multiply by samples-per-hour
    // to get goroutines per hour.
    slope := d.calculateSlope()
    samplesPerHour := time.Hour.Seconds() / d.sampleInterval.Seconds()
    growthPerHour := slope * samplesPerHour

    if d.baseline == 0 {
        return nil // avoid dividing by zero on a process with no baseline
    }
    growthRate := growthPerHour / float64(d.baseline)

    if growthRate > d.threshold {
        return &LeakReport{
            CurrentCount:  current,
            BaselineCount: d.baseline,
            GrowthRate:    growthRate,
            Samples:       d.samples,
            Dump:          d.captureStacks(),
        }
    }

    return nil
}

func (d *GoroutineLeakDetector) calculateSlope() float64 {
    n := float64(len(d.samples))
    var sumX, sumY, sumXY, sumX2 float64

    for i, y := range d.samples {
        x := float64(i)
        sumX += x
        sumY += float64(y)
        sumXY += x * float64(y)
        sumX2 += x * x
    }

    return (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX)
}
```

**Follow-up Questions:**
- "Your count-based detector alerts every time traffic spikes. How do you fix it?" (Answer: track goroutine count per top-of-stack frame, not total. Legitimate traffic spikes grow many stacks briefly. Leaks grow one stack monotonically.)
- "When would you use the `goroutineleak` profile instead of this?" (Answer: by default, on 1.27 and later, where it needs no build flags at all. On 1.26 it required `GOEXPERIMENT=goroutineleakprofile` at build time. The GC-proven profile has no false positives for the reachability case and replaces most bespoke detectors, at the cost of running a leak-detecting GC cycle when you collect it, so it is an investigation tool rather than a 15-second scrape.)
- "What leak does the goroutineleak profile miss?" (Answer: leaked goroutines still reachable from a live object, like a background worker registered in a package-level map that never gets deregistered. For those you still need heap dominator analysis.)

### Question 5: How do you profile a Go service with minimal production impact?

**What FAANG expects:** Quantified overhead numbers (CPU profile a few percent during capture, block/mutex profiling has continuous cost and is off by default, goroutine dump at verbosity 2 is STW for the whole walk), a default-off posture for expensive profiles, and familiarity with continuous profilers (Grafana Pyroscope, Datadog, Google Cloud Profiler) that amortize cost via sampling. Strong candidates mention `pprof.Labels` for per-request attribution.

**Answer:**

**Key Strategies:**

1. **Statistical Sampling**: Profile only a percentage of requests
```go
type SampledProfiler struct {
    sampleRate float64
    rng        *rand.Rand
}

func (p *SampledProfiler) ShouldProfile() bool {
    return p.rng.Float64() < p.sampleRate
}

func profiledHandler(next http.Handler) http.Handler {
    profiler := &SampledProfiler{sampleRate: 0.01} // 1%

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if profiler.ShouldProfile() {
            // Profile this request
            pprof.Do(r.Context(), pprof.Labels("sampled", "true"), func(ctx context.Context) {
                next.ServeHTTP(w, r.WithContext(ctx))
            })
        } else {
            next.ServeHTTP(w, r)
        }
    })
}
```

2. **Continuous Profiling**: Use a tool like Grafana Pyroscope
```go
// Note the module path. The old `github.com/pyroscope-io/client` is the
// pre-acquisition client. Current code uses github.com/grafana/pyroscope-go.
import "github.com/grafana/pyroscope-go"

func initPyroscope() error {
    _, err := pyroscope.Start(pyroscope.Config{
        ApplicationName: "my-service",
        ServerAddress:   "http://pyroscope:4040",
        ProfileTypes: []pyroscope.ProfileType{
            pyroscope.ProfileCPU,
            pyroscope.ProfileAllocObjects,
            pyroscope.ProfileAllocSpace,
            pyroscope.ProfileInuseObjects,
            pyroscope.ProfileInuseSpace,
        },
        // Deliberately no SampleRate here. The field still exists but is
        // deprecated and ignored: the client's own docs say "SampleRate is
        // set to 100 and is not configurable". Setting it to some clever
        // low number does nothing at all, which is worse than not trying,
        // because you walk away believing you lowered your overhead.
        // 100Hz is also Go's own default, so the widely copied comment
        // "100 Hz instead of the default 1000 Hz" is wrong twice over.
    })
    return err
}
```

Note also that `pyroscope.Start` returns `(*Profiler, error)`. Discarding the error, as the copy-pasted version of this snippet usually does, means a service that cannot reach the Pyroscope server starts perfectly happily and simply produces no profiles. You find out during the incident you needed them for.

3. **On-Demand Profiling**: Enable only when investigating
```go
type OnDemandProfiler struct {
    enabled atomic.Bool
    expires time.Time
}

func (p *OnDemandProfiler) Enable(duration time.Duration) {
    p.enabled.Store(true)
    p.expires = time.Now().Add(duration)

    go func() {
        time.Sleep(duration)
        p.enabled.Store(false)
    }()
}
```

**Impact Measurements:**
- CPU profiling: ~1-2% overhead at default 100Hz sample rate, zero when idle
- Memory profiling: negligible at default `MemProfileRate = 512 KiB`
- Block profiling: continuous overhead proportional to contention events, default off
- Mutex profiling: continuous overhead, default off
- Goroutine dump (verbosity 2): brief STW pause, scales with goroutine count

**Follow-up Questions:**
- "How do you attribute a CPU profile to specific request types?" (Answer: wrap handlers with `pprof.Do(ctx, pprof.Labels("endpoint", name, "tenant", id), fn)`. Labels flow through to the profile and let you filter by tag in `go tool pprof -tagfocus`.)
- "The Go 1.25 FlightRecorder, where does it fit?" (Answer: when you need a trace of the seconds leading up to a rare event. It keeps a ring buffer of execution trace data with bounded overhead and dumps on demand, analogous to JVM JFR.)
- "When would you choose `runtime/metrics` over `runtime.ReadMemStats`?" (Answer: always for new code. `runtime/metrics` is the supported, extensible interface. `ReadMemStats` is frozen and takes a stop-the-world sample of the whole struct.)

### Question 6: A service is OOM-killed every few hours. Walk through your investigation.

**What FAANG expects:** Distinguish OOM from container-limit breach, know that Go's GC cannot help if live heap exceeds `GOMEMLIMIT`, and pull heap profiles from the previous replica before it died (either via continuous profiling or by grabbing `/debug/pprof/heap` on the survivors with similar uptime). Candidates who only say "pprof the heap" without addressing the container limit or `GOMEMLIMIT` tuning miss the systems angle.

**Answer:**

1. Confirm the signal. Check `kubectl describe pod` or dmesg for `OOMKilled` vs `signal: killed`. An OOMKill from the cgroup means RSS exceeded the limit. A signal: killed from the node OOM killer means the node overcommitted.
2. Check `GOMEMLIMIT`. If it is unset or equal to the container limit, the GC has no headroom. Set it to ~85% of the container limit.
3. Correlate with traffic. Steady heap growth under constant traffic = leak. Heap spike under traffic spike = allocation surge, fix with backpressure or pooling.
4. Pull the pre-crash heap profile. With continuous profiling (Pyroscope), go to the profile closest to kill time. Without, reproduce in staging with smaller `GOMEMLIMIT` and grab `/debug/pprof/heap` as the kill approaches.
5. Check goroutine count. A goroutine leak inflates stack memory (2 KiB minimum each), which is off-heap and does not show in `inuse_space`. Pull goroutine profile.
6. Audit `sync.Pool` and `[]byte` buffer reuse. Unbounded buffer pools are a classic Go OOM cause.

**Follow-up Questions:**
- "Heap profile is flat but RSS climbs. Why?" (Answer: off-heap sources, goroutine stacks, mmap'd files, cgo allocations, `sync.Pool` local caches. Check `runtime/metrics` for `/memory/classes/heap/stacks:bytes` and `/memory/classes/mspan/...`.)
- "Kubernetes sets memory.limit. Should you also set GOMEMLIMIT?" (Answer: yes. The kernel kills at the cgroup limit with no warning. `GOMEMLIMIT` set below it gives the GC a chance to reclaim before the kernel pulls the trigger.)
- "Your heap has 2 GiB of `[]byte`. How do you find the owner?" (Answer: `go tool pprof -inuse_space -cum`, then `list <top function>` to see the allocation site. Cross-reference with code to find what holds the slice alive.)

### Question 7: P99 latency jumps from 50ms to 2s intermittently. How do you diagnose?

**What FAANG expects:** The candidate should not reach for a CPU profile (wrong tool for intermittent tail events). They should reach for the execution tracer or FlightRecorder, and they should name the usual tail-latency suspects: GC pauses, scheduler latency from blocked syscalls, network IO, lock contention, cold caches.

**Answer:**

1. Check GC pause history. `debug.ReadGCStats` + `runtime/metrics` `/gc/pauses:seconds` histogram. Tail pauses of hundreds of ms point to a heap sizing or `GOGC`/`GOMEMLIMIT` misconfiguration.
2. Enable the FlightRecorder (Go 1.25) with a 30-second window. Wire an HTTP handler that dumps the buffer when P99 exceeds a threshold. Analyze in `go tool trace` to see scheduler delay, syscall blocking, and GC events on the hot request's goroutine.
3. Pull block and mutex profiles on a canary. Tail latency often traces back to a single contended mutex held by a slow path.
4. Check upstream dependencies. Tail latency frequently comes from a single backend (Redis eviction, Postgres autovacuum, DNS lookup) and not from Go at all.
5. Pin `GOGC` and `GOMEMLIMIT` explicitly. Default `GOGC=100` can be too loose for tight tail SLOs on hot-allocating services.

**Follow-up Questions:**
- "GC pause histogram shows a fat tail. What knobs do you turn?" (Answer: raise `GOMEMLIMIT` so the GC runs less often, lower `GOGC` so it runs more often with less work per cycle, or reduce allocation rate via `sync.Pool` and pre-sized slices. Measure before and after.)
- "Trace shows long `syscall` regions on the request goroutine. What does that mean?" (Answer: the goroutine is blocked in a blocking syscall without the scheduler handing off the P. Common causes are cgo calls, file IO on slow disks, and locked OS threads. Fix with non-blocking IO or by isolating cgo workers.)
- "When would you increase GOMAXPROCS beyond the container CPU limit?" (Answer: you should not. Go 1.25+ auto-detects cgroup CPU quotas. Setting GOMAXPROCS higher causes oversubscription and makes tail latency worse.)

### Question 8: Your service deadlocks silently (no runtime panic). How do you find it?

**What FAANG expects:** Awareness that Go's runtime only detects total deadlocks (all goroutines blocked). Partial deadlocks, the common case, require diffing two goroutine dumps taken minutes apart: if the same goroutine IDs are stuck on the same sync primitives, you have a partial deadlock. Bonus for mentioning `-race` to catch the bugs at test time.

**Answer:**

1. Capture two goroutine dumps 60 seconds apart from the affected replica.
2. Diff: goroutines present in both dumps with identical stack frames and `[semacquire]`, `[chan receive]`, or `[sync.Mutex.Lock]` state for the full window are stuck.
3. Group by the exact lock address or channel. Two goroutines blocked on the same mutex with one of them holding a different mutex the first needs is a classic lock-order inversion.
4. If you can reproduce in staging, run with `-race` to catch lock ordering bugs, and consider `sync.Mutex` replaced temporarily by a tracing mutex that logs acquire/release.
5. For channel deadlocks, look for unbuffered channels where both ends are blocked: one goroutine in `chan send`, the counterparty in `chan receive`, neither runnable.

**Follow-up Questions:**
- "Why doesn't Go detect partial deadlocks?" (Answer: the runtime deadlock detector only fires when zero goroutines are runnable. As long as one goroutine (the HTTP server accept loop, a health-check goroutine) can run, the runtime assumes progress is possible.)
- "What's a tool to catch lock-order bugs before prod?" (Answer: `go test -race` for data races, and third-party libraries like `github.com/sasha-s/go-deadlock` as a drop-in `sync.Mutex` replacement for tests that logs lock acquisition order and fails on cycles.)
- "A goroutine is stuck in `select` with a `default` branch, how is that possible?" (Answer: it is not stuck in select at all. Check the stack frame above. It likely blocked on something inside the default branch, commonly an unbuffered channel send in a helper function.)

### Question 9: CPU usage jumps to 100% on one replica. How do you investigate?

**What FAANG expects:** Differential diagnosis between application hot loop, GC thrashing, and runtime issues. The candidate should pull a 30-second CPU profile, read the flame graph, and recognize the top-frame pattern: user code (logic bug or input explosion), `runtime.gcBgMarkWorker` (GC pressure), `runtime.findRunnable` (scheduler overhead from too many goroutines), or `runtime.mapaccess2` (hash collision or oversized map).

**Answer:**

1. Pull a 30-second CPU profile from the hot replica: `curl -o cpu.prof http://hot:6060/debug/pprof/profile?seconds=30`.
2. Open as flame graph: `go tool pprof -http=:8081 cpu.prof`. The browser UI lands on the flame graph. Note that the interactive `(pprof) web` command is a different thing, it renders a dot callgraph as SVG, not a flame graph.
3. Read the top frames:
   - User function at top: logic bug, infinite loop, or input that triggers a pathological code path. `list <function>` to see line-level hot spots.
   - `runtime.gcBgMarkWorker`: GC thrashing. Check `alloc_space` profile and heap growth. Fix with pooling, `GOMEMLIMIT`, or `GOGC` tuning.
   - `runtime.findRunnable` / `runtime.schedule`: too many goroutines per P. Check `runtime.NumGoroutine()`.
   - `syscall.Syscall` or `runtime.cgocall`: blocking syscalls or cgo. Move to non-blocking IO.
4. Compare with a baseline profile from a healthy replica using `pprof -base=healthy.prof hot.prof` to see only the delta.
5. If the hot replica is specific (same pod every time), check for input skew: sticky sessions, a large customer, a misrouted batch job.

**Follow-up Questions:**
- "The flame graph shows `runtime.mapassign_faststr` as 40% of CPU. What's the fix?" (Answer: either the map is massively oversized causing cache misses, or you are racing to grow it. Pre-size with `make(map[string]T, n)` if `n` is known, or replace with a specialized structure like a radix tree for string keys.)
- "CPU is 100% but throughput dropped. What's happening?" (Answer: the CPU is spent in GC or scheduler overhead, not application work. Check `runtime/metrics` `/cpu/classes/gc/total:cpu-seconds` as a fraction of total. Above 25% is a red flag.)
- "How do you capture a profile when the process is crashing mid-capture?" (Answer: use the FlightRecorder or a continuous profiler so you have pre-crash data. In-process `pprof.StartCPUProfile` only gives data if the program survives to close the profile cleanly.)

### Q (Staff track): How do you improve your org's mean-time-to-recovery?

**Answer**: Invest in observability: every service exposes pprof, logs with correlation IDs, traces. Build shared runbooks. Train on-call via GameDays. Measure MTTR per incident category and improve the slowest. Principal-level work: treat debugging as infrastructure, not afterthought.

---
