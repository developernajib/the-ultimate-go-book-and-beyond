## 83C.16 Mock Interview Session 8: Apple Senior - Go Runtime Deep Dive

### Interviewer Briefing

**Company style:** Apple. Senior Software Engineer. Apple interviews for Go-focused roles include a deep dive into runtime internals, performance debugging, and production engineering. The interviewer expects the candidate to demonstrate hands-on experience with Go's runtime, not just textbook knowledge. Questions escalate from foundational to advanced, probing the boundaries of the candidate's practical experience.

**Level:** ICT4 (Senior Software Engineer)

**Interview duration:** 45 minutes

**Key evaluation criteria:** Depth of Go runtime knowledge, debugging methodology, performance optimization experience, ability to reason about system behavior under load.

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| [0:00]-[5:00] | GC Fundamentals | Baseline knowledge assessment |
| [5:00]-[15:00] | GC Tuning Scenario | Production debugging exercise |
| [15:00]-[25:00] | p99 Latency Deep Dive | Systematic diagnosis methodology |
| [25:00]-[35:00] | sync.Pool Optimization | Implementation and trade-offs |
| [35:00]-[45:00] | Advanced Runtime Internals | Scheduler, memory allocator, escape analysis |

### Interviewer Script & Candidate Response

**[0:00] Interviewer:** *"Let's start with Go's garbage collector. Can you walk me through how it works at a high level and what has changed in recent versions?"*

**[0:30] Candidate:** "Go uses a concurrent, tri-color mark-and-sweep garbage collector. Here's how it works:

**Phases:**
1. **Mark Setup (STW):** Brief stop-the-world to enable the write barrier and scan goroutine stacks. This is typically < 100 microseconds.
2. **Concurrent Marking:** GC goroutines run alongside application goroutines, tracing from roots (global variables, stacks, registers) through the object graph. Objects are colored:
 - White: not yet visited (potentially garbage)
 - Grey: visited but children not yet scanned
 - Black: visited and all children scanned
3. **Mark Termination (STW):** Another brief STW to disable the write barrier, finalize marking, and sweep setup. Also < 100 microseconds typically.
4. **Concurrent Sweeping:** Sweep goroutines reclaim white objects, running concurrently with the application.

**Write Barrier:** During concurrent marking, the write barrier ensures correctness. When a pointer is updated, the write barrier shades the old referent gray (Dijkstra-style) or the new referent gray, preventing the GC from missing live objects.

**Recent Changes:**
- **Go 1.19:** Introduced `GOMEMLIMIT` - a soft memory limit that replaces the old GOGC-only tuning. The GC now considers total memory usage, not just heap growth ratio. This was transformative for containerized deployments where OOM kills were common.
- **Go 1.20:** Improved GC pacer that better predicts when to trigger GC cycles, reducing over-triggering.
- **Go 1.21:** an `arena` experiment shipped behind GOEXPERIMENT for batch allocations that could be freed all at once, but it was later withdrawn and never graduated, so production code still hand-rolls bump allocators for that pattern.
- **Go 1.22+:** Continued improvements to the pacer and reduced STW latency through better stack scanning techniques."

**[3:00] Interviewer:** *"Good overview. Now let's get into a real scenario."*

**[5:00] Interviewer:** *"You're running a Go service in production. It handles 10,000 requests per second. You notice that every 2-3 minutes, the p99 latency spikes from 10ms to 200ms for about 500ms. You suspect GC. Walk me through exactly how you would diagnose and fix this."*

**[5:30] Candidate:** "I'd follow a systematic approach:

**Step 1: Confirm GC is the cause**

First, I'd enable GC tracing and look at the runtime metrics:

```go
package main

// Enable GC trace logging
// Set environment variable: GODEBUG=gctrace=1

// Or programmatically collect GC stats:
import (
    "context"
    "runtime"
    "runtime/debug"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// MetricsClient abstracts Prometheus metric emission.
type MetricsClient interface {
    Histogram(name string) prometheus.Observer
    Gauge(name string) prometheus.Gauge
}

// GCMonitor collects and reports GC statistics.
type GCMonitor struct {
    metrics MetricsClient
}

// Start begins periodic GC metric collection.
func (m *GCMonitor) Start(ctx context.Context) {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    var lastStats debug.GCStats
    var lastMemStats runtime.MemStats

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            var stats debug.GCStats
            debug.ReadGCStats(&stats)

            var memStats runtime.MemStats
            runtime.ReadMemStats(&memStats)

            // Report key GC metrics
            if len(stats.Pause) > 0 {
                m.metrics.Histogram("gc_pause_duration_ns").Observe(float64(stats.Pause[0].Nanoseconds()))
            }
            m.metrics.Gauge("gc_num_gc").Set(float64(stats.NumGC))
            m.metrics.Gauge("heap_alloc_bytes").Set(float64(memStats.HeapAlloc))
            m.metrics.Gauge("heap_sys_bytes").Set(float64(memStats.HeapSys))
            m.metrics.Gauge("heap_objects").Set(float64(memStats.HeapObjects))
            m.metrics.Gauge("goroutine_count").Set(float64(runtime.NumGoroutine()))
            m.metrics.Gauge("gc_cpu_fraction").Set(memStats.GCCPUFraction)

            // Track allocation rate (bytes/sec)
            if lastMemStats.TotalAlloc > 0 {
                allocRate := memStats.TotalAlloc - lastMemStats.TotalAlloc
                m.metrics.Gauge("alloc_rate_bytes_per_sec").Set(float64(allocRate))
            }

            _ = lastStats
            lastStats = stats
            lastMemStats = memStats
        }
    }
}
```

I'd look at `gctrace` output. A typical line looks like:
```
gc 1234 @120.000s 2%: 0.050+15.0+0.080 ms clock, 0.40+12.0/14.0/0+0.64 ms cpu, 180->195->95 MB, 190 MB goal, 8 P
```

Key things I'd check:
- STW pauses (0.050ms and 0.080ms above - these are fine)
- Concurrent mark time (15.0ms - this means marking is consuming CPU)
- Heap growth: 180→195→95 MB - growing from 180 to 195 before GC, then shrinking to 95 after

**Step 2: Profile the allocation pattern**

```go
// Profile allocations using pprof
import _ "net/http/pprof"

// In main():
go func() {
    log.Println(http.ListenAndServe(":6060", nil))
}()

// Then from command line:
// go tool pprof http://localhost:6060/debug/pprof/heap
// go tool pprof -alloc_space http://localhost:6060/debug/pprof/heap
```

I'd compare `inuse_space` (what's currently on the heap) vs `alloc_space` (total allocated since start). A high alloc_space with low inuse_space means lots of short-lived allocations that churn the GC.

**Step 3: Identify the hot allocation paths**

From the pprof output, I'd look for the top allocation sites. Common culprits in HTTP services:
- JSON marshaling/unmarshaling allocating per-request
- String concatenation in hot paths
- Slice growing via append without pre-allocation
- Creating closures that capture variables (heap escape)

**Step 4: Apply fixes based on diagnosis**

```go
func init() {
    // Fix 1: GOMEMLIMIT for containerized environments
    // If running in a 4GB container:
    debug.SetMemoryLimit(3 * 1024 * 1024 * 1024) // 3GB soft limit (75% of container)

    // Fix 2: GOGC tuning
    // Default GOGC=100 means GC triggers when heap doubles
    // For latency-sensitive services, lower GOGC trades CPU for lower latency
    debug.SetGCPercent(50) // GC triggers when heap grows 50% - more frequent but smaller pauses
}

// Fix 3: sync.Pool for frequently allocated objects (covered in detail later)

// Fix 4: Pre-allocate slices and buffers
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Bad: grows dynamically, multiple allocations
    // var result []byte

    // Good: pre-allocate based on expected size
    result := make([]byte, 0, 4096)
    _ = result

    parts := []string{"header", "body"}
    estimatedSize := 1024

    // Bad: string concatenation in loop
    // var s string
    // for _, part := range parts { s += part }

    // Good: strings.Builder pre-allocated
    var b strings.Builder
    b.Grow(estimatedSize)
    for _, part := range parts {
        b.WriteString(part)
    }
    _ = b.String()
}

// CacheEntry represents an item stored in cache.
type CacheEntry struct {
    Key   string
    Value []byte
}

// Fix 5: Reduce pointer-heavy data structures
// Pointers create work for the GC (it must follow them during marking)
// Use value types and flat structures where possible

// Bad: slice of pointers - each pointer is a GC root to follow
type BadCache struct {
    entries []*CacheEntry
}

// Good: slice of values - one contiguous allocation, fewer GC roots
type GoodCache struct {
    entries []CacheEntry
}
```

**Step 5: Validate the fix**

After applying fixes, I'd:
1. Run the same load test and compare `gctrace` output
2. Verify p99 latency is stable
3. Check that `GCCPUFraction` decreased
4. Monitor for a full day in production before declaring victory"

**[15:00] Interviewer:** *"Good systematic approach. Now let's talk about p99 latency more broadly. You have a Go service where p50 is 5ms but p99 is 500ms - a 100x gap. GC has already been tuned. What else could cause this?"*

**[15:30] Candidate:** "A 100x p50-to-p99 gap with GC ruled out points to several categories:

**1. Goroutine Scheduling Latency**

If the service creates more goroutines than GOMAXPROCS, some goroutines wait in the local run queues. Under contention, a goroutine might wait 100+ ms to be scheduled.

Diagnosis:
```go
// Check goroutine count vs GOMAXPROCS
runtime.NumGoroutine()  // If this is >> runtime.GOMAXPROCS(0) * 10, you have a problem
runtime.GOMAXPROCS(0)   // Default = num CPU cores

// Use runtime/trace to visualize scheduling
// go tool trace collects per-goroutine scheduling events
import "runtime/trace"

func startTrace(ctx context.Context) {
    f, _ := os.Create("trace.out")
    trace.Start(f)
    defer trace.Stop()
    // ... run workload ...
}
// Analyze: go tool trace trace.out
// Look at "Goroutine Analysis" → "Scheduler Wait" time
```

**2. Lock Contention**

A single mutex protecting a hot path can serialize goroutines:

```go
package runtime

import (
    "hash/fnv"
    _ "net/http/pprof"
    "sync"
)

// Common fix: shard the lock
type ShardedMap struct {
    shards    [256]shard
}

type shard struct {
    mu   sync.RWMutex
    data map[string]interface{}
}

func (m *ShardedMap) getShard(key string) *shard {
    h := fnv.New32a()
    h.Write([]byte(key))
    return &m.shards[h.Sum32()%256]
}

func (m *ShardedMap) Get(key string) (interface{}, bool) {
    s := m.getShard(key)
    s.mu.RLock()
    defer s.mu.RUnlock()
    v, ok := s.data[key]
    return v, ok
}
```

**3. Downstream Service Latency (Long Tail)**

The p99 of your service includes the p99 of every downstream call. If you call 5 services and each has 1% chance of being slow, your overall slow-path probability is ~5%.

Diagnosis:
```go
package runtime

import (
    "context"
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// Add per-dependency latency histograms
type InstrumentedClient struct {
    client    *http.Client
    histogram *prometheus.HistogramVec // labeled by target service
}

func (c *InstrumentedClient) Do(ctx context.Context, service string, req *http.Request) (*http.Response, error) {
    start := time.Now()
    resp, err := c.client.Do(req.WithContext(ctx))
    duration := time.Since(start)

    c.histogram.WithLabelValues(service).Observe(duration.Seconds())
    return resp, err
}
```

Fix: Set aggressive timeouts per dependency, use hedged requests for critical paths (send a second request after p90 deadline, use whichever returns first).

**4. Channel Contention / Unbuffered Channels**

Unbuffered channels force goroutines to synchronize, which can add latency under load:

```go
// Bad: unbuffered channel creates synchronization point
ch := make(chan Request)
_ = ch

// Better: buffered channel decouples producer and consumer
bufferedCh := make(chan Request, 1000)
_ = bufferedCh

// Best for high-throughput: use a ring buffer or batch channel
```

**5. Memory Allocator Contention**

Go's memory allocator uses per-P caches (mcache). If allocations are very large (> 32KB), they go directly to the central mheap with a lock. Under high concurrency:

Diagnosis: `go tool pprof -alloc_space` - look for large allocations. Fix: pool large allocations with `sync.Pool`."

**[25:00] Interviewer:** *"Let's talk about sync.Pool. Implement a production-grade buffer pool, explain the internals, and discuss the trade-offs."*

**[25:30] Candidate:** "Let me build a production buffer pool with monitoring:

```go
package bufferpool

import (
    "sync"
    "sync/atomic"
)

// Pool is a production-grade buffer pool with size classes and monitoring.
// It wraps sync.Pool to provide typed access, metrics, and size-class optimization.
type Pool struct {
    pools   []*sizeClassPool
    classes []int // size thresholds: 1KB, 4KB, 16KB, 64KB, 256KB, 1MB
    gets    atomic.Int64
    puts    atomic.Int64
    misses  atomic.Int64
    hits    atomic.Int64
}

type sizeClassPool struct {
    pool     sync.Pool
    size     int
    gets     atomic.Int64
    puts     atomic.Int64
    news     atomic.Int64
}

// New creates a buffer pool with predefined size classes.
func New() *Pool {
    classes := []int{
        1 << 10,  // 1 KB
        4 << 10,  // 4 KB
        16 << 10, // 16 KB
        64 << 10, // 64 KB
        256 << 10, // 256 KB
        1 << 20,  // 1 MB
    }

    p := &Pool{
        pools:   make([]*sizeClassPool, len(classes)),
        classes: classes,
    }

    for i, size := range classes {
        sz := size // capture for closure
        p.pools[i] = &sizeClassPool{
            pool: sync.Pool{
                New: func() interface{} {
                    buf := make([]byte, 0, sz)
                    return &buf
                },
            },
            size: sz,
        }
    }

    return p
}

// Get returns a buffer with at least the requested capacity.
// The buffer's length is reset to 0 - its capacity may exceed the request.
func (p *Pool) Get(size int) *[]byte {
    p.gets.Add(1)

    // Find the smallest size class that fits
    for _, sp := range p.pools {
        if sp.size >= size {
            sp.gets.Add(1)
            v := sp.pool.Get()
            if v != nil {
                buf := v.(*[]byte)
                *buf = (*buf)[:0] // Reset length, keep capacity
                p.hits.Add(1)
                return buf
            }
            // Pool was empty, New() was called
            sp.news.Add(1)
            p.misses.Add(1)
            buf := v.(*[]byte)
            *buf = (*buf)[:0]
            return buf
        }
    }

    // Requested size exceeds all size classes - allocate directly
    p.misses.Add(1)
    buf := make([]byte, 0, size)
    return &buf
}

// Put returns a buffer to the pool.
// Buffers larger than the maximum size class are not pooled (let GC collect them).
func (p *Pool) Put(buf *[]byte) {
    if buf == nil {
        return
    }

    p.puts.Add(1)
    capacity := cap(*buf)

    // Find the matching size class
    for _, sp := range p.pools {
        if sp.size >= capacity {
            *buf = (*buf)[:0] // Reset length
            sp.puts.Add(1)
            sp.pool.Put(buf)
            return
        }
    }

    // Buffer is too large for any pool - drop it (GC will collect)
}

// Stats returns current pool statistics.
type Stats struct {
    TotalGets   int64
    TotalPuts   int64
    CacheHits   int64
    CacheMisses int64
    HitRate     float64
}

func (p *Pool) Stats() Stats {
    gets := p.gets.Load()
    hits := p.hits.Load()

    var hitRate float64
    if gets > 0 {
        hitRate = float64(hits) / float64(gets)
    }

    return Stats{
        TotalGets:   gets,
        TotalPuts:   p.puts.Load(),
        CacheHits:   hits,
        CacheMisses: p.misses.Load(),
        HitRate:     hitRate,
    }
}
```

**sync.Pool Internals:**

sync.Pool works by maintaining per-P (per processor) local pools plus a shared victim cache:

1. **Per-P local storage:** Each P (logical processor, typically one per CPU core) has a private poolLocal with a single `private` slot and a `shared` ring buffer. Get() first checks the private slot (fastest, no synchronization), then the local shared list, then steals from other Ps' shared lists.

2. **Victim cache (since Go 1.13):** Before Go 1.13, every GC cycle cleared all pools. Now, pools use a two-generation scheme: current pools become victim pools at GC, and victim pools are cleared at the next GC. This means objects survive one GC cycle, dramatically improving hit rates for steady-state workloads.

3. **GC interaction:** Pool objects are not counted against the heap for GC triggering purposes. The pool is designed to shed objects under memory pressure - it's a cache, not permanent storage. Never store things in sync.Pool that must not be garbage collected.

**Trade-offs:**

| Factor | Advantage | Disadvantage |
|--------|-----------|--------------|
| **Memory usage** | Reduces allocation pressure | Pool itself holds memory even when idle |
| **GC pressure** | Fewer allocations = fewer GC cycles | Pool traversal during GC adds overhead |
| **Latency** | Eliminates allocation latency for hot paths | Pool Get/Put adds ~50ns overhead vs direct allocation |
| **Correctness risk** | N/A | Returning a buffer without resetting can leak data between requests |
| **Size classes** | Right-sized allocations reduce waste | Complexity of managing multiple pools |

**When NOT to use sync.Pool:**
- Objects are cheap to allocate (small structs without pointers)
- Objects have long lifetimes (pool is for short-lived, high-churn objects)
- Object initialization is expensive and can't be amortized (pool may clear objects at GC)
- The code path is not hot enough to justify the complexity"

**[35:00] Interviewer:** *"Let's go deeper into the runtime. Explain the GMP model and how goroutine scheduling works. What happens when a goroutine makes a system call?"*

**[35:30] Candidate:** "The GMP model is Go's goroutine scheduler architecture:

**G (Goroutine):** The unit of work. Contains the stack (starts at 2KB, grows dynamically up to 1GB default), program counter, and scheduling state. Goroutines are extremely lightweight - you can have millions.

**M (Machine/OS Thread):** The actual OS thread that executes Go code. M's are created on demand and cached when idle. Typically you'll have a few hundred M's at most.

**P (Processor):** A logical processor that acts as a resource context for executing Go code. The number of P's equals GOMAXPROCS (defaults to num CPU cores). Each P has:
- A local run queue (up to 256 goroutines)
- An mcache (per-P memory allocation cache)
- A timer heap (for time.Sleep, time.After, etc.)

**Scheduling flow:**
1. A G is placed on a P's local run queue (or the global run queue if the local queue is full)
2. An M picks up a P and runs goroutines from P's local queue
3. When a G blocks (channel op, mutex, I/O), the M can either:
 - Park the G and pick up another G from the queue (for Go-level blocking)
 - Or hand off the P to another M (for system call blocking)

**System call handling:**

When a goroutine makes a blocking system call:

1. **Before the syscall:** The runtime calls `entersyscall()` which:
 - Records the current P as in-syscall state
 - Increments a counter so the sysmon thread knows about it
 - Does NOT detach the P immediately (optimistic - most syscalls are fast)

2. **If the syscall takes too long (>20µs):** The `sysmon` thread (a special background goroutine) detects that a P has been in a syscall too long. It:
 - Detaches the P from the blocked M (called 'handoff')
 - Wakes up or creates a new M to pick up the now-free P
 - The P can now run other goroutines while the original M is stuck in the syscall

3. **When the syscall returns:** The original M calls `exitsyscall()` which:
 - Tries to re-acquire the same P (fast path if it's still available)
 - If that P was handed off, tries to acquire any idle P
 - If no P is available, the G is placed on the global run queue and the M parks itself

```go
// Demonstrating the impact of blocking syscalls on scheduling
package main

import (
    "fmt"
    "os"
    "runtime"
    "sync"
    "time"
)

func main() {
    runtime.GOMAXPROCS(2)

    var wg sync.WaitGroup
    start := time.Now()

    // Launch goroutines that make blocking syscalls
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()

            // os.Open/Read are blocking syscalls
            // The runtime will hand off the P after ~20µs
            f, err := os.Open("/dev/urandom")
            if err != nil {
                return
            }
            defer f.Close()

            buf := make([]byte, 1024*1024) // 1MB read
            f.Read(buf) // This blocks the M in a syscall

            fmt.Printf("Goroutine %d completed at %v\n", id, time.Since(start))
        }(i)
    }

    wg.Wait()
    fmt.Printf("Total time: %v\n", time.Since(start))
    fmt.Printf("OS threads used: check with runtime.NumCgoCall() or /proc/self/status\n")
}
```

**Work Stealing:**

When a P's local run queue is empty, it tries to steal work in this order:
1. Check the global run queue (every 61 scheduling ticks to prevent starvation)
2. Check the network poller (for goroutines waiting on I/O)
3. Steal half the goroutines from another random P's local queue

This ensures load balancing across processors without central coordination."

**[40:00] Interviewer:** *"Last question: how does escape analysis work, and how can you use it to reduce heap allocations in a hot path?"*

**[40:30] Candidate:** "Escape analysis is the compiler's decision about whether a variable can live on the stack (cheap, freed automatically when function returns) or must be allocated on the heap (requires GC).

**Rules that cause heap escape:**
1. Returning a pointer to a local variable
2. Assigning to a variable that outlives the function scope
3. Passing to an `interface{}` parameter (the compiler can't prove the lifetime)
4. Closures that capture local variables
5. Slices/maps that grow beyond a compiler-determined size threshold
6. Values too large for the stack

**How to check:**
```bash
go build -gcflags='-m -m' ./...
```

This produces output like:
```
./main.go:15:6: can inline makeUser
./main.go:16:10: &User{...} escapes to heap
./main.go:16:10:   flow: ~r0 = &{storage for &User{...}}:
./main.go:16:10:     from &User{...} (spill) at ./main.go:16:10
./main.go:16:10:     from return &User{...} (return) at ./main.go:16:2
```

**Production optimization example:**

```go
package runtime

import (
    "encoding/json"
    "fmt"
    "strconv"
)

type RequestItem struct {
    Name string
    ID   int
}

type Request struct {
    Items []RequestItem
}

var easyjson struct {
    Unmarshal func([]byte, any) error
}

func processItem(key string) []byte { return nil }
func processItemBytes(key []byte) []byte { return nil }

// BEFORE: Multiple heap escapes in hot path
func processRequest(data []byte) ([]byte, error) {
    // Escapes: json.Unmarshal takes interface{}, forces heap allocation
    var req Request
    if err := json.Unmarshal(data, &req); err != nil {
        return nil, err
    }

    // Escapes: result slice grows dynamically
    var result []byte
    for _, item := range req.Items {
        // Escapes: fmt.Sprintf allocates
        key := fmt.Sprintf("%s:%d", item.Name, item.ID)
        result = append(result, processItem(key)...)
    }

    return result, nil
}

// AFTER: Minimize heap escapes
func processRequestOptimized(data []byte, resultBuf *[]byte) error {
    // Use a stack-allocated decoder that doesn't require interface{}
    var req Request
    // json.Unmarshal still escapes, but we can use a pooled decoder
    // or use a code-generated unmarshaler (easyjson, jsoniter)
    if err := easyjson.Unmarshal(data, &req); err != nil {
        return err
    }

    // Pre-allocated buffer passed from caller (or from sync.Pool)
    *resultBuf = (*resultBuf)[:0]

    // Avoid fmt.Sprintf - use strconv and direct append
    var keyBuf [128]byte // Stack-allocated fixed buffer
    for _, item := range req.Items {
        // Build key without allocation
        n := copy(keyBuf[:], item.Name)
        keyBuf[n] = ':'
        n++
        n += copy(keyBuf[n:], strconv.AppendInt(keyBuf[n:n], int64(item.ID), 10))
        key := keyBuf[:n]

        *resultBuf = append(*resultBuf, processItemBytes(key)...)
    }

    return nil
}
```

**Key techniques for hot paths:**
1. Pass buffers as parameters instead of returning new allocations
2. Use `[N]byte` fixed-size arrays for small, bounded data (stays on stack)
3. Avoid `interface{}` parameters - use concrete types or generics (Go 1.18+)
4. Use `strconv.AppendInt/AppendFloat` instead of `fmt.Sprintf`
5. Pre-allocate slices with known capacity
6. Use code-generated JSON marshalers (easyjson, sonic) instead of reflect-based encoding/json
7. Verify with `-gcflags='-m'` that your changes actually prevent escapes"

### Scoring Rubric

| Dimension | 1 (Poor) | 3 (Meets Bar) | 5 (Exceptional) |
|-----------|----------|----------------|------------------|
| **GC Knowledge** | Cannot explain mark-and-sweep, confuses STW with concurrent phases | Explains tri-color marking, write barrier, STW phases | Discusses GOMEMLIMIT, pacer improvements, victim cache, generational aspects |
| **GC Tuning** | No systematic approach, guesses at fixes | Uses gctrace and pprof, identifies allocation hot spots | Complete methodology: diagnose → measure → fix → validate, knows GOGC/GOMEMLIMIT trade-offs |
| **p99 Diagnosis** | Only mentions GC, cannot think of other causes | Identifies 2-3 causes (lock contention, scheduling, downstream) | Systematic elimination with concrete tools and fixes for 5+ root causes |
| **sync.Pool** | Cannot explain internals, basic usage only | Correct implementation, understands per-P pools and GC interaction | Production-grade implementation with size classes, metrics, and clear explanation of victim cache |
| **GMP Model** | Cannot explain M, P, G relationship | Explains scheduling basics and system call handling | Deep knowledge of work stealing, handoff, sysmon, and practical implications |
| **Escape Analysis** | Does not know what escape analysis is | Can explain basic rules and use `-gcflags='-m'` | Demonstrates production optimization with concrete before/after, knows all escape triggers |

**Scoring thresholds:**
- **Strong Hire:** Average ≥ 4.0, demonstrates production experience (not just textbook knowledge)
- **Hire:** Average ≥ 3.0, no dimension below 2
- **Lean No Hire:** Average ≥ 2.5, gaps suggest textbook-only knowledge
- **No Hire:** Average < 2.5 or cannot explain fundamental concepts


### Junior → FAANG: Apple Senior Go Runtime Deep-Dive Mock Basics

An Apple senior Go runtime deep-dive interview tests production-grade knowledge of Go internals. Key topics: how the Go runtime schedules goroutines (the M:N model, work-stealing, the run queue structure), how garbage collection works (tri-color mark-and-sweep, write barriers, GC pacing), and how memory is allocated (mcache, mcentral, mheap, span classes). This kind of question distinguishes engineers who have debugged production issues from those who have only written Go programs.

### Senior @ FAANG: Go Runtime Deep-Dive at the Senior Bar: Production Debugging and Tuning

At the senior level, the Apple Go runtime interview evaluates your ability to translate runtime knowledge into production debugging skill. The bar-raiser probes: 'you are seeing unexplained high CPU usage in a Go service. Walk me through your debugging process'. The correct answer starts with pprof (CPU profile to identify hot functions, goroutine profile to detect scheduling anomalies, mutex profile to find lock contention) and works down to the runtime level if standard profiling is insufficient. Runtime tuning at the senior level includes GOGC and GOMEMLIMIT tuning (raising GOGC reduces GC frequency but increases memory usage between collections, GOMEMLIMIT prevents OOM kills at the cost of more frequent collections near the limit), and understanding when to use sync.Pool to reduce allocation pressure. The senior-level also includes knowledge of finalizers (why they are dangerous for resource cleanup and why the io.Closer pattern is the correct alternative) and cgo overhead (each cgo call requires crossing a goroutine stack boundary, which is significantly more expensive than a normal function call).

---
