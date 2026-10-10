## 19.13 Interview Questions

Profiling questions appear in every Go performance interview. Interviewers use them to check whether you can start from a real production symptom (latency spike, memory leak, GC churn) and walk a profile to the root cause, not recite pprof commands from memory.

> **What FAANG actually tests here**: a coherent debugging methodology (metrics → profile → code), knowledge of what each pprof profile type shows, familiarity with production tooling (Pyroscope, Parca, or Datadog continuous profiling), and a pragmatic view that cutting GC load often beats micro-optimizing CPU paths.

### Question 1: How would you diagnose a slow API endpoint?

**What FAANG expects**: the RED method or equivalent (rate, errors, duration) before any profiler, breakdowns by phase via OpenTelemetry spans, then a CPU or block profile only on a specific host or instance, not the whole fleet.

**Answer:**

1. **Start with metrics**: Check P50, P95, P99 latency
2. **Add timing**: Instrument key operations
3. **Profile**: Take CPU profile during load
4. **Trace**: Use execution trace for detailed analysis

```go
func (h *Handler) HandleRequest(w http.ResponseWriter, r *http.Request) {
    // Add timing for each phase
    ctx, span := tracer.Start(r.Context(), "HandleRequest")
    defer span.End()

    // Phase 1: Validation
    validationStart := time.Now()
    if err := h.validate(r); err != nil {
        span.RecordError(err)
        http.Error(w, err.Error(), 400)
        return
    }
    span.AddEvent("validation", trace.WithAttributes(
        attribute.Int64("duration_us", time.Since(validationStart).Microseconds()),
    ))

    // Phase 2: Database
    dbStart := time.Now()
    data, err := h.db.Query(ctx, query)
    span.AddEvent("database", trace.WithAttributes(
        attribute.Int64("duration_us", time.Since(dbStart).Microseconds()),
    ))
    if err != nil {
        span.RecordError(err)
        http.Error(w, "internal error", 500)
        return
    }

    // Phase 3: Response
    respStart := time.Now()
    json.NewEncoder(w).Encode(data)
    span.AddEvent("response", trace.WithAttributes(
        attribute.Int64("duration_us", time.Since(respStart).Microseconds()),
    ))
}
```

**Follow-ups**:
- Would you profile the whole fleet or a single canary? What are the tradeoffs?
- How does a block profile differ from a CPU profile, and when does each help?

### Question 2: What's the difference between -inuse_space and -alloc_space?

**What FAANG expects**: `inuse_space` for leak hunting, `alloc_space` for GC-pressure hunting, plus the knowledge that `alloc_objects` and `inuse_objects` (count-based siblings) are often more diagnostic than byte counts for finding allocation hotspots.

**Answer:**

- **-inuse_space**: Memory currently in use (live heap objects)
- **-alloc_space**: Total memory allocated over time (includes freed)

Use cases:
- `inuse_space`: Find memory leaks, understand steady-state memory
- `alloc_space`: Find allocation hotspots causing GC pressure

```bash
# Currently held memory (for leak detection)
go tool pprof -inuse_space http://localhost:6060/debug/pprof/heap

# Allocations over time (for GC optimization)
go tool pprof -alloc_space http://localhost:6060/debug/pprof/heap

# Count-based alternatives, often more useful for hunting hot spots
go tool pprof -inuse_objects http://localhost:6060/debug/pprof/heap
go tool pprof -alloc_objects http://localhost:6060/debug/pprof/heap
```

**Follow-ups**:
- When would an `inuse_objects` graph show a leak that `inuse_space` misses?
- What does `go tool pprof -base` do, and why is it critical for diff-profiling across two captures?

### Question 3: How do you reduce GC pressure?

**What FAANG expects**: practical allocation-cutting techniques (preallocation, `sync.Pool` for short-lived buffers, value types over pointers, `strings.Builder`), plus awareness that `GOMEMLIMIT` (Go 1.19+) and Green Tea GC (Go 1.26 default) change tuning considerations.

**Answer:**

1. **Reduce allocations**: Use sync.Pool, preallocate slices
2. **Reuse buffers**: bytes.Buffer, strings.Builder
3. **Avoid pointer-rich structures**: Use value types when possible
4. **Tune GOGC**: Higher value = less frequent GC

```go
// Before: High allocation rate
func processRequests(reqs []Request) []Response {
    responses := make([]Response, 0)
    for _, req := range reqs {
        resp := process(req) // Allocates each time
        responses = append(responses, resp)
    }
    return responses
}

// After: Reduced allocations
var responsePool = sync.Pool{
    New: func() any { return &Response{} },
}

func processRequests(reqs []Request) []Response {
    responses := make([]Response, len(reqs)) // Pre-allocate
    for i, req := range reqs {
        resp := responsePool.Get().(*Response)
        process(req, resp) // Reuse
        responses[i] = *resp
        resp.Reset() // Clear before returning to the pool
        responsePool.Put(resp)
    }
    return responses
}
```

A good candidate will notice that `responses[i] = *resp` copies the struct, which is what makes the `Put` on the next line safe. A better candidate will notice that the copy is **shallow**: if `Response` contains a slice, map, or pointer field, the copy shares that memory with the object now sitting in the pool, and you are back to the aliasing bug from earlier in this chapter. The struct copy protects you only when `Response` is made entirely of value types.

The strongest answer questions the premise. In this snippet the pool earns very little, because `responses` is already a preallocated `[]Response` and the real fix was the `make([]Response, len(reqs))`. Being able to say "the preallocation is the win here, the pool is complexity I would need a profile to justify" is exactly the judgment the question is testing.

Tuning knobs in 2026:
- `GOGC` (default 100) controls the heap-growth target before a GC cycle.
- `GOMEMLIMIT` (Go 1.19+) sets a soft memory cap. Pair with `GOGC=off` or a high value to use memory as the primary pacing signal.
- Go 1.26's Green Tea collector is default and cuts GC CPU 10 to 40 percent on allocation-heavy workloads with no code changes. If you are still seeing GC CPU above 10 percent on 1.26, the problem is allocation rate, not the collector.

**Follow-ups**:
- What does `GODEBUG=gctrace=1` print, and how do you read the output to decide between reducing allocation rate and raising `GOMEMLIMIT`?
- When does `sync.Pool` hurt rather than help? Give a workload profile.

### Question 4: How do you profile a production service?

**What FAANG expects**: continuous profiling with low-overhead sampling (Pyroscope, Parca, Datadog), locked-down `/debug/pprof` endpoints, and knowledge that the rewritten execution tracer in Go 1.22 cut tracing overhead enough to make always-on flight recording practical.

**Answer:**

1. **Enable pprof endpoint** (with authentication)
2. **Use sampling** to reduce overhead
3. **Collect continuously** and store
4. **Compare across versions** for regression detection

```go
// Secure pprof endpoint
func securedPprof(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Verify internal network or API key
        if !isAuthorized(r) {
            http.Error(w, "Unauthorized", 401)
            return
        }
        next.ServeHTTP(w, r)
    })
}

// Sampling profiler (1% of instances)
func shouldProfile() bool {
    h := fnv.New32()
    h.Write([]byte(hostname))
    return h.Sum32()%100 == 0
}
```

The modern default in 2026 is a continuous profiler that ingests pprof captures automatically. Grafana Pyroscope (open source) and Datadog Continuous Profiler are the most common choices, and Pyroscope uses the standard `runtime/pprof` format, so integration is a small dependency plus a push or pull agent.

For execution traces, use the flight recorder to keep a rolling window of trace data in memory, ready to dump the moment an anomaly fires. This solves the fundamental problem with tracing a rare event: by the time you notice the slow request, it is over. The flight recorder is always recording the recent past, so you dump the window *after* the symptom appears and still have the trace of it.

Since Go 1.25 this lives in the standard library as `runtime/trace.FlightRecorder`, so no external dependency is needed. Note that at most one flight recorder can be active at a time:

```go
fr := trace.NewFlightRecorder(trace.FlightRecorderConfig{})
if err := fr.Start(); err != nil {
    return err
}
defer fr.Stop()

// Later, when your anomaly detector fires:
if latency > threshold {
    f, err := os.Create("anomaly.trace")
    if err != nil {
        return err
    }
    defer f.Close()
    if _, err := fr.WriteTo(f); err != nil {
        return err
    }
}
```

**Follow-ups**:
- Walk through what Pyroscope actually does with a flamegraph diff between two deploys.
- Why is continuous profiling cheap enough to leave on? What is the typical overhead?

### Question 5: Explain escape analysis and how to control it.

**What FAANG expects**: the canonical escape triggers (returned pointer, boxing into an escaping interface, closure capture, channel send, compile-unknown size), the `-gcflags="-m"` workflow, and knowledge that in Go a "return by value" is often faster than a "return by pointer" for small structs because it avoids the heap allocation. A strong answer also knows the limits of the rules: boxing into an interface that does not itself escape allocates nothing, and the only authorities are `-gcflags=-m` and `b.ReportAllocs()`.

Escape analysis determines whether variables are allocated on stack (fast) or heap (requires GC).

Variables escape to heap when:
- Returned from function
- Stored in interface
- Captured by closure
- Too large for stack
- Size unknown at compile time

```bash
# View escape analysis decisions
go build -gcflags="-m" main.go
```

```go
// Escapes: returned pointer
func newInt() *int {
    x := 42
    return &x  // &x escapes
}

// Doesn't escape: caller provides buffer
func fillBuffer(buf []byte) int {
    // buf doesn't escape
    for i := range buf {
        buf[i] = 0
    }
    return len(buf)
}

// Escapes: stored in interface
func process(v int) any {
    return v // boxing causes escape
}

// Doesn't escape: concrete type
func processInt(v int) int {
    return v * 2 // stays on stack
}
```

**Follow-ups**:
- How would you read `-gcflags="-m=2"` (verbose) output to understand why a closure caused a local to escape?
- What is `//go:noinline` and why would you ever use it during profiling?

### Q (Staff track): Your service has P99 latency of 500ms. How do you reduce it to 100ms?

**Answer**: Structured investigation.

1. **Capture a CPU profile under realistic load.** Identify the functions that dominate.
2. **Capture a heap profile.** Identify top allocation sites, since allocation pressure often causes tail latency via GC pauses.
3. **Capture a trace for a slow request.** Identify where time is spent: CPU, GC, locks, downstream I/O.
4. **Categorize the bottleneck.** CPU-bound: optimize the hot function. Allocation-bound: reduce allocations. I/O-bound: parallelize or cache. Lock-bound: shard or remove lock.
5. **Fix the top contributor.** Measure again. Repeat.

A 5x latency improvement is normally the compounded result of several independent changes, not one heroic fix. Expect to find and remove a handful of moderate contributors rather than a single dominant one, unless the service contains an outright misuse (an accidental O(n²), a lock held across I/O, a missing index), in which case one change really can carry the whole win. That is the first thing worth ruling out, because it is cheap to check and it changes the plan entirely.

### Q (Staff track): When is PGO (profile-guided optimization) worth adopting?

**Answer**: For services where the 2-14% speedup matters. Criteria:

- Service is CPU-bound or latency-critical.
- Production profiles are representative of the workload (collected over sufficient time, spanning peak hours).
- Build infrastructure can handle PGO pipeline (collect profile, build with it, verify).

For memory-bound services, I/O-bound services, or services where build pipeline overhead outweighs the 2-14% gain, PGO is not worth the complexity. Evaluate per service.

---
