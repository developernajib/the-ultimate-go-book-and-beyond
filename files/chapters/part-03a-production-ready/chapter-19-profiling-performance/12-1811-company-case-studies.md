## 19.11 Company Case Studies

### Google: Profiling at Scale

Google runs continuous profiling across their entire fleet, collecting CPU, heap, and contention profiles from every Go service at low sampling rates. Their internal profiling system, which eventually became Google Cloud Profiler, directly influenced the design of Go's `pprof` format and the `net/http/pprof` endpoint. The patterns below reflect how Google integrates profiling into everyday development.

**Key practices from Google:**

```go
// 1. Cloud Profiler Integration
// Google Cloud Profiler for Go
import "cloud.google.com/go/profiler"

func main() {
    cfg := profiler.Config{
        Service:        "my-service",
        ServiceVersion: "1.0.0",
        ProjectID:      "my-gcp-project",

        // Profile types to enable
        MutexProfiling: true,
    }

    if err := profiler.Start(cfg); err != nil {
        log.Fatalf("Failed to start profiler: %v", err)
    }

    // Application runs normally
    runApplication()
}

// 2. Flame Graph Analysis
// Google popularized flame graphs for profile visualization
// Key insight: Width = time spent, stack depth = call hierarchy

/*
+------------------------------------------------------------------+
|                        main.handleRequest                         |
+------------------------------------------------------------------+
|          db.Query (40%)        |     json.Marshal (30%)          |
+--------------------------------+----------------------------------+
|  sql.Open  |   sql.Exec       |  reflect.Value  |   bytes.Buff   |
+------------+------------------+-----------------+-----------------+

Reading flame graphs:
- Look for wide blocks (time consumers)
- Identify unexpected depth (excessive recursion)
- Find flat areas (functions that could be parallelized)
*/

// 3. Production Sampling Strategy
type SamplingProfiler struct {
    cpuRate    float64 // 0.01 = 1% of instances profile CPU
    heapRate   float64 // 0.05 = 5% of instances profile heap
    traceRate  float64 // 0.001 = 0.1% of instances trace
}

func (s *SamplingProfiler) ShouldProfile(profileType string) bool {
    switch profileType {
    case "cpu":
        return rand.Float64() < s.cpuRate
    case "heap":
        return rand.Float64() < s.heapRate
    case "trace":
        return rand.Float64() < s.traceRate
    }
    return false
}
```

**Google's profiling principles:**

| Principle | Implementation |
|-----------|----------------|
| Always-on profiling | Low overhead (<2%) continuous collection |
| Fleet-wide aggregation | Profiles from all instances combined |
| Version comparison | Automatic regression detection |
| Root cause analysis | Link profiles to metrics and traces |
| Actionable insights | Focus on top 3 bottlenecks |

### Uber: Performance at Massive Scale

Uber processes millions of requests per second across Go services that handle dispatch, pricing, and routing. Their performance work focuses on eliminating allocations in hot request paths, building custom memory pooling for latency-sensitive handlers, and tracking tail latency with high-resolution histograms.

```go
// 1. Zero-Allocation Hot Paths
// Uber avoids allocations in their hottest code paths

// BAD: allocates a UUID string on every request. Note the bare string key is
// a second, unrelated bug: context keys must be an unexported named type to
// avoid collisions across packages.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx := context.WithValue(r.Context(), "request_id", uuid.New().String())
    // ...
}

// GOOD: Use sync.Pool for request contexts
var ctxPool = sync.Pool{
    New: func() any {
        return &RequestContext{}
    },
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx := ctxPool.Get().(*RequestContext)
    defer func() {
        ctx.Reset()
        ctxPool.Put(ctx)
    }()

    ctx.RequestID = h.idGen.Next() // Pre-allocated ID generator
    // ...
}

// 2. Custom Memory Allocators for Hot Paths
type ArenaAllocator struct {
    buf    []byte
    offset int
}

func (a *ArenaAllocator) Alloc(size int) []byte {
    if a.offset+size > len(a.buf) {
        a.buf = make([]byte, max(size, 4096))
        a.offset = 0
    }

    // Three-index slice: cap == len, so a caller's append() allocates a new
    // array instead of silently overwriting the next arena allocation.
    end := a.offset + size
    result := a.buf[a.offset:end:end]
    a.offset = end
    return result
}

// Reset makes the arena's memory available for reuse. Every slice previously
// returned by Alloc must be considered invalid after this call.
func (a *ArenaAllocator) Reset() {
    a.offset = 0
}

// 3. Latency Histogram for P99 Tracking
type LatencyHistogram struct {
    // Power-of-two microsecond buckets: bucket i covers durations whose
    // microsecond count has bit-length i, so i=10 is roughly 1ms.
    buckets []int64
    count   int64
    sum     int64
}

func (h *LatencyHistogram) Record(d time.Duration) {
    bucket := bits.Len64(uint64(d.Microseconds()))
    if bucket < len(h.buckets) {
        atomic.AddInt64(&h.buckets[bucket], 1)
    }
    atomic.AddInt64(&h.count, 1)
    atomic.AddInt64(&h.sum, int64(d))
}

func (h *LatencyHistogram) P99() time.Duration {
    threshold := atomic.LoadInt64(&h.count) * 99 / 100

    var cumulative int64
    for i := range h.buckets {
        // Index the slice directly. Ranging over values would copy each
        // counter non-atomically before the atomic load could apply.
        cumulative += atomic.LoadInt64(&h.buckets[i])
        if cumulative >= threshold {
            return time.Duration(1<<i) * time.Microsecond
        }
    }
    return 0
}
```

Two details in that histogram are worth dwelling on, because both are easy to get wrong in exactly the way that looks right.

**The buckets are microseconds, not milliseconds.** `bits.Len64` of the microsecond count means bucket `i` holds durations near 2^i microseconds, so a 1ms observation lands in bucket 10 and `P99` reports it as 1.024ms. That rounding to the next power of two is inherent to the design and is the tradeoff you accept for a lock-free `Record` that costs a couple of atomic adds. If you need tighter buckets, this is the wrong structure. Reach for an HDR histogram or your metrics library's native histogram instead of widening this one.

**The `P99` loop must index the slice, not range over its values.** Writing it the natural-looking way introduces a data race that survives casual review because it appears to use atomics:

```go
for i, count := range h.buckets {
    cumulative += atomic.LoadInt64(&count)  // WRONG
}
```

`range` copies each element into `count` before the loop body runs. That copy is an ordinary unsynchronized read of `h.buckets[i]`, racing with every concurrent `Record`. The `atomic.LoadInt64` then dutifully performs an atomic load of a *local variable that nothing else can see*, which is real machine work accomplishing nothing. The code reads as thread-safe and is not.

`go vet` does not flag it. Running the concurrent test under `go test -race`, however, reports `WARNING: DATA RACE` on the range line immediately. This is the general lesson: an atomic operation only protects the memory it is actually applied to, and taking the address of a loop copy silently moves the atomic off the shared memory it was supposed to guard. When in doubt about a lock-free structure, do not reason about it, run it under `-race`.

### Netflix: GC Optimization

Netflix operates Go services where GC pauses directly affect stream startup latency and API response times. Their approach combines `GOGC` tuning, `GOMEMLIMIT` (Go 1.19+), aggressive object pooling for large buffers, and batch processing to reduce allocation frequency. The following patterns illustrate their GC-aware coding style.

```go
// 1. GOGC Tuning
// Netflix often increases GOGC for lower latency

func init() {
    // Set GOGC higher to reduce GC frequency
    // Trade memory for CPU
    debug.SetGCPercent(200) // 200% instead of default 100%

    // Or use GOMEMLIMIT (Go 1.19+)
    debug.SetMemoryLimit(4 << 30) // 4GB limit
}

// 2. Object Pooling for Large Objects
type LargeBuffer struct {
    Data    []byte
    Scratch [64]byte // Small scratch space
}

var largeBufferPool = sync.Pool{
    New: func() any {
        return &LargeBuffer{
            Data: make([]byte, 0, 1<<20), // 1MB capacity
        }
    },
}

func GetLargeBuffer() *LargeBuffer {
    buf := largeBufferPool.Get().(*LargeBuffer)
    buf.Data = buf.Data[:0] // Reset length, keep capacity
    return buf
}

func PutLargeBuffer(buf *LargeBuffer) {
    if cap(buf.Data) > 10<<20 { // Don't pool buffers > 10MB
        return
    }
    largeBufferPool.Put(buf)
}

// 3. Batch Processing to Reduce GC Pressure
type BatchProcessor struct {
    batchSize  int
    pending    []Task
    mu         sync.Mutex
    processNow chan struct{}
}

func (bp *BatchProcessor) Add(task Task) {
    bp.mu.Lock()
    bp.pending = append(bp.pending, task)

    if len(bp.pending) >= bp.batchSize {
        select {
        case bp.processNow <- struct{}{}:
        default:
        }
    }
    bp.mu.Unlock()
}

func (bp *BatchProcessor) worker() {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-bp.processNow:
        case <-ticker.C:
        }

        bp.mu.Lock()
        tasks := bp.pending
        bp.pending = make([]Task, 0, bp.batchSize)
        bp.mu.Unlock()

        if len(tasks) > 0 {
            bp.processBatch(tasks) // Single allocation for batch
        }
    }
}

// 4. GC Metrics Monitoring
func monitorGC(ctx context.Context) {
    // debug.GCStats.NumGC is an int64, so track it as one.
    var lastNumGC int64

    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            var stats debug.GCStats
            debug.ReadGCStats(&stats)

            if stats.NumGC > lastNumGC && len(stats.Pause) > 0 {
                pause := stats.Pause[0] // most recent pause
                if pause > 10*time.Millisecond {
                    log.Printf("WARNING: Long GC pause: %v", pause)
                }

                metrics.Histogram("gc.pause_ms").Record(float64(pause.Milliseconds()))
                lastNumGC = stats.NumGC
            }
        }
    }
}
```

### Stripe: Latency-Critical Optimization

Stripe's payment processing pipeline requires sub-millisecond internal latencies because every additional millisecond of delay compounds across the multi-step transaction flow. Their Go services apply pre-computed data structures to eliminate runtime lookups, zero-copy parsing to avoid allocations in JSON-heavy hot paths, and request coalescing to batch duplicate lookups into a single operation.

```go
// 1. Pre-computed Data Structures
// Stripe pre-computes frequently accessed data at startup

type PaymentMethodCache struct {
    // Pre-indexed by multiple keys
    byID       map[string]*PaymentMethod
    byCustomer map[string][]*PaymentMethod
    byType     map[string][]*PaymentMethod

    // Bloom filter for quick negative lookups
    bloom      *BloomFilter
}

func NewPaymentMethodCache(methods []*PaymentMethod) *PaymentMethodCache {
    cache := &PaymentMethodCache{
        byID:       make(map[string]*PaymentMethod, len(methods)),
        byCustomer: make(map[string][]*PaymentMethod),
        byType:     make(map[string][]*PaymentMethod),
        bloom:      NewBloomFilter(len(methods)*10, 3),
    }

    for _, m := range methods {
        cache.byID[m.ID] = m
        cache.byCustomer[m.CustomerID] = append(cache.byCustomer[m.CustomerID], m)
        cache.byType[m.Type] = append(cache.byType[m.Type], m)
        cache.bloom.Add([]byte(m.ID))
    }

    return cache
}

func (c *PaymentMethodCache) Get(id string) (*PaymentMethod, bool) {
    // Fast negative check
    if !c.bloom.MayContain([]byte(id)) {
        return nil, false
    }

    m, ok := c.byID[id]
    return m, ok
}

// 2. Zero-Copy JSON Parsing
// Stripe uses custom JSON parsing for hot paths

type FastPayment struct {
    ID       []byte // Points into original JSON
    Amount   int64
    Currency []byte
}

func ParsePaymentZeroCopy(data []byte) (*FastPayment, error) {
    p := &FastPayment{}

    // Find fields without allocating strings
    idStart := bytes.Index(data, []byte(`"id":"`))
    if idStart == -1 {
        return nil, errors.New("missing id")
    }
    idStart += 6
    idEnd := bytes.IndexByte(data[idStart:], '"') + idStart
    p.ID = data[idStart:idEnd] // Zero-copy slice

    // Parse amount as integer directly
    amountStart := bytes.Index(data, []byte(`"amount":`))
    if amountStart != -1 {
        amountStart += 9
        p.Amount = parseIntFast(data[amountStart:])
    }

    return p, nil
}

func parseIntFast(data []byte) int64 {
    var n int64
    for _, c := range data {
        if c < '0' || c > '9' {
            break
        }
        n = n*10 + int64(c-'0')
    }
    return n
}

// 3. Connection Pool Optimization
type OptimizedPool struct {
    conns    chan *Conn
    maxConns int

    // Metrics
    acquired atomic.Int64
    released atomic.Int64
    timeouts atomic.Int64
}

func (p *OptimizedPool) Acquire(ctx context.Context) (*Conn, error) {
    // Fast path: try non-blocking first
    select {
    case conn := <-p.conns:
        p.acquired.Add(1)
        return conn, nil
    default:
    }

    // Slow path: wait with context
    select {
    case conn := <-p.conns:
        p.acquired.Add(1)
        return conn, nil
    case <-ctx.Done():
        p.timeouts.Add(1)
        return nil, ctx.Err()
    }
}

// 4. Adaptive Request Coalescing
type RequestCoalescer struct {
    pending    map[string]*coalescedRequest
    mu         sync.Mutex
    maxWait    time.Duration
    maxBatch   int
}

type coalescedRequest struct {
    key      string
    waiters  []chan *Result
    timer    *time.Timer
}

func (c *RequestCoalescer) Do(ctx context.Context, key string) (*Result, error) {
    c.mu.Lock()

    if req, ok := c.pending[key]; ok {
        // Coalesce with existing request
        ch := make(chan *Result, 1)
        req.waiters = append(req.waiters, ch)
        c.mu.Unlock()

        select {
        case result := <-ch:
            return result, nil
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }

    // Create new coalesced request
    ch := make(chan *Result, 1)
    req := &coalescedRequest{
        key:     key,
        waiters: []chan *Result{ch},
    }

    req.timer = time.AfterFunc(c.maxWait, func() {
        c.execute(key)
    })

    c.pending[key] = req
    c.mu.Unlock()

    select {
    case result := <-ch:
        return result, nil
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}
```

### Staff Lens: Case Studies Show the Value of Profiling Discipline

The patterns in this section share a shape worth naming. In each case the company did not guess its way to a faster service. It made profiling routine, which meant that when a regression appeared, the evidence for where it came from already existed. That is the difference between performance engineering as a discipline and performance engineering as a firefighting response.

Note what these case studies deliberately do not include: a table of headline percentages. Public engineering-blog numbers are real for the workload, hardware, and Go version that produced them, and they transfer to your service only as a direction, never as a target. A team that adopts arena allocation because someone else reported a large win, without profiling first, is guessing with extra steps. The transferable asset here is the technique and the discipline of measuring, not anyone else's numbers.

### Principal Lens: Your Org's Profiling Maturity

Principal engineers should assess the org's profiling maturity:

- **Level 1:** Profiling happens during incidents only.
- **Level 2:** Services expose pprof endpoints, and on-call knows how to use them.
- **Level 3:** Continuous profiling in production, performance metrics on dashboards.
- **Level 4:** Benchmarks in CI, PGO enabled for latency-critical services, performance SLOs per service.

Most orgs plateau at Level 2. Moving to Level 3 and 4 is principal-level work. The payoff is systematic performance gains across the service portfolio.

---
