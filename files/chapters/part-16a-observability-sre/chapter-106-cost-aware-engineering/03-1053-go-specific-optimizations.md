## 106.3 Go-Specific Optimizations

### Memory Efficiency

Memory efficiency in Go services reduces pod memory requests and limits, which directly lowers Kubernetes scheduling costs and enables higher density on the same node pool. The following techniques demonstrate the allocation patterns with the highest cost-reduction potential in typical Go web service workloads.

```go
package efficiency

import (
    "strings"
    "sync"
)

type Item struct{}

// Object pooling for reduced allocations
var bufferPool = sync.Pool{
    New: func() any {
        buf := make([]byte, 4096)
        return &buf
    },
}

func ProcessRequest(data []byte) error {
    // Get buffer from pool
    bufPtr := bufferPool.Get().(*[]byte)
    defer bufferPool.Put(bufPtr)

    buf := *bufPtr
    // Use buffer...
    _ = buf

    return nil
}

// GOGC tuning for memory vs CPU tradeoff
func ConfigureGC() {
    // Higher GOGC = less frequent GC = more memory used
    // Lower GOGC = more frequent GC = less memory, more CPU

    // Default is 100 (collect when heap doubles)
    // For memory-constrained: GOGC=50
    // For CPU-constrained: GOGC=200

    // Can be set via environment: GOGC=75
    // Or programmatically:
    // debug.SetGCPercent(75)
}

// Memory-efficient struct design
// BAD: Padding wastes memory
type BadStruct struct {
    a bool   // 1 byte + 7 padding
    b int64  // 8 bytes
    c bool   // 1 byte + 7 padding
    d int64  // 8 bytes
}          // Total: 32 bytes

// GOOD: Ordered by size
type GoodStruct struct {
    b int64  // 8 bytes
    d int64  // 8 bytes
    a bool   // 1 byte
    c bool   // 1 byte + 6 padding
}          // Total: 24 bytes

// Pre-allocate slices when size is known
func ProcessItems(count int) {
    // BAD: Grows dynamically
    var bad []Item
    for i := 0; i < count; i++ {
        bad = append(bad, Item{})
    }

    // GOOD: Pre-allocated
    good := make([]Item, 0, count)
    for i := 0; i < count; i++ {
        good = append(good, Item{})
    }
}

// String building efficiency
func BuildString() string {
    // BAD: Creates many allocations
    // s := ""
    // for i := 0; i < 1000; i++ {
    //     s += "item"
    // }

    // GOOD: Single allocation
    var sb strings.Builder
    sb.Grow(4000) // Pre-allocate if size known
    for i := 0; i < 1000; i++ {
        sb.WriteString("item")
    }
    return sb.String()
}
```

### Connection Pooling

Connection reuse is one of the cheapest cost wins in a Go service. Every new database or TLS connection pays handshake latency and CPU, so pool sizing determines both tail latency and how much idle capacity you carry. The example below shows sensible defaults for `database/sql` and `http.Transport` pools, plus a bounded worker pool that caps concurrent background work.

```go
package efficiency

import (
    "database/sql"
    "net/http"
    "time"
)

// Database connection pool optimization
func ConfigureDBPool(db *sql.DB) {
    // Max connections should match your needs
    // Too many = wasted resources
    // Too few = contention
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)
    db.SetConnMaxIdleTime(1 * time.Minute)
}

// HTTP client pool optimization
func NewOptimizedHTTPClient() *http.Client {
    transport := &http.Transport{
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 10,
        IdleConnTimeout:     90 * time.Second,
        // Reuse connections
        DisableKeepAlives: false,
    }

    return &http.Client{
        Transport: transport,
        Timeout:   30 * time.Second,
    }
}

// Goroutine pool to limit concurrency
type WorkerPool struct {
    workers chan struct{}
}

func NewWorkerPool(size int) *WorkerPool {
    return &WorkerPool{
        workers: make(chan struct{}, size),
    }
}

func (p *WorkerPool) Submit(task func()) {
    p.workers <- struct{}{} // Acquire worker
    go func() {
        defer func() { <-p.workers }() // Release worker
        task()
    }()
}
```

### Junior → FAANG: Go Optimization Translates Directly to Cost Reduction

Go-specific optimizations are not micro-optimizations for their own sake. They translate directly to lower CPU and memory usage, which translates to lower cloud costs. Three patterns have the most impactful at the junior level.

Using `sync.Pool` for frequently allocated objects (request structs, buffers, JSON decoders) reduces GC pressure. GC pressure in Go manifests as CPU time spent in the runtime rather than in application code. A service that spends 15% of its CPU in GC is effectively 15% more expensive than it needs to be.

Pre-allocating slices with the expected capacity (`make([]T, 0, expectedLen)`) avoids the repeated allocation-and-copy cycle that happens when a slice grows beyond its capacity. In a hot path processing 100,000 items per second, the difference between pre-allocated and dynamically grown slices can be 2-3x in allocation rate.

The `WorkerPool` pattern bounds goroutine count for background work. Unbounded goroutine creation for incoming requests is a common mistake that creates memory pressure because each goroutine carries a stack that starts at 2-8 KB and grows. During traffic spikes, unbounded goroutine creation can exhaust available memory faster than the work completes, and a blocked goroutine never releases its stack.

### Senior @ FAANG: Profiling-Driven Optimization as an Engineering Practice

At L6, Go optimization decisions are driven by profiling data, not intuition. The `pprof` HTTP endpoint is a non-negotiable requirement for every production Go service. Before any optimization, run a CPU profile and an allocation profile under representative load. The CPU profile identifies which functions consume CPU time. The allocation profile identifies which call sites produce the most heap allocations. These two profiles together determine the optimization priority: CPU-bound services benefit from algorithmic improvements and reduced function call overhead. Allocation-bound services benefit from `sync.Pool`, pre-allocation, and reducing interface conversion (which often causes escape to heap).

The goroutine pool pattern is correct for CPU-bound work but inappropriate for I/O-bound work. A service that uses a goroutine pool for database queries will serialize parallel queries behind the pool semaphore, increasing latency under load. I/O-bound work should use per-request goroutines bounded by the downstream service's connection pool, not an application-level goroutine pool. The distinction matters: get it wrong and the "optimization" increases latency at scale.

Platform-level Go optimization governance means establishing benchmark suites for shared libraries that run in CI and fail when any benchmark regresses by more than 10% in CPU time or allocation rate. These benchmarks are the automated ratchet that prevents performance regressions from accumulating silently across dozens of commits. Without the ratchet, optimization wins from one quarter are routinely eroded by the next quarter's feature work, and the cost baseline creeps upward.

---
