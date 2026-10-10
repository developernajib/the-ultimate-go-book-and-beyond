## 90K.7 Memory Management: Why Every Byte Matters

In spacecraft software, memory is the most precious resource after power. The Curiosity
rover has 256 MB of RAM. The Voyager probes have 68 KB. The James Webb Space Telescope
has 68 GB of solid-state storage but only a few hundred MB of operational RAM. There is
no swap space, no cloud auto-scaling, and no way to add more memory after launch.

NASA's approach to memory management is radically different from what most software
engineers practice:

1. **All memory is allocated at startup.** The flight software determines exactly how much
   memory it needs and allocates it during initialization. After init, `malloc` is never
   called again.

2. **Fixed-size memory pools.** Instead of a general-purpose heap allocator, NASA software
   uses pools of fixed-size blocks. Need a 256-byte buffer? Take one from the 256-byte
   pool. Need a 1024-byte buffer? Take one from the 1024-byte pool. No fragmentation.
   No variable-size allocation. O(1) allocation and deallocation.

3. **Stack analysis.** Every task's maximum stack usage is computed statically using WCET
   tools. The stack is allocated with a known margin (typically 25-50% above the computed
   maximum). Stack overflows are impossible because the analysis proves they cannot occur.

4. **Memory scrubbing.** Cosmic radiation can flip bits in RAM (single-event upsets). NASA
   software periodically reads all memory, checks it against ECC (error-correcting code)
   values, and corrects single-bit errors. This runs continuously in a background task.

### Go Memory Management for Reliability

Go's garbage collector makes deterministic memory management impossible, but you can
minimize GC pressure and bound memory usage with careful design.

```go
package nasa

import (
    "errors"
    "fmt"
    "runtime"
    "sync"
    "sync/atomic"
    "time"
    "unsafe"
)

// ErrPoolExhausted indicates that no free blocks remain in the pool.
var ErrPoolExhausted = errors.New("memory pool exhausted")

// Assert checks an invariant and panics if false.
func Assert(condition bool, message string) {
    if !condition {
        panic("assertion failed: " + message)
    }
}

// === Fixed-Size Memory Pool (NASA-Style) ===

// MemoryPoolStats tracks pool utilization for monitoring.
type MemoryPoolStats struct {
    TotalBlocks     int
    FreeBlocks      int
    AllocatedBlocks int
    BlockSize       int
    TotalBytes      int
    PeakUsage       int
}

// TypedPool is a generic fixed-size object pool that pre-allocates
// all objects at construction time. Zero allocations during operation.
type TypedPool[T any] struct {
    mu        sync.Mutex
    objects   []T
    free      []int
    allocated map[int]bool
    peakUsage int
}

// NewTypedPool creates a pool of N objects of type T.
// All memory is allocated here and never again.
func NewTypedPool[T any](count int) *TypedPool[T] {
    Assert(count > 0, "pool count must be positive")
    Assert(count <= 100000, "pool count exceeds safety limit")

    pool := &TypedPool[T]{
        objects:   make([]T, count),
        free:      make([]int, count),
        allocated: make(map[int]bool, count),
    }

    for i := 0; i < count; i++ {
        pool.free[i] = i
    }

    return pool
}

// Acquire gets an object from the pool. Returns its index for release.
func (p *TypedPool[T]) Acquire() (*T, int, error) {
    p.mu.Lock()
    defer p.mu.Unlock()

    if len(p.free) == 0 {
        return nil, -1, ErrPoolExhausted
    }

    idx := p.free[len(p.free)-1]
    p.free = p.free[:len(p.free)-1]
    p.allocated[idx] = true

    usage := len(p.allocated)
    if usage > p.peakUsage {
        p.peakUsage = usage
    }

    return &p.objects[idx], idx, nil
}

// Release returns an object to the pool.
func (p *TypedPool[T]) Release(idx int) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    if idx < 0 || idx >= len(p.objects) {
        return fmt.Errorf("invalid pool index: %d", idx)
    }

    if !p.allocated[idx] {
        return fmt.Errorf("double free at index %d", idx)
    }

    delete(p.allocated, idx)

    // Zero the object before returning to pool.
    var zero T
    p.objects[idx] = zero

    p.free = append(p.free, idx)
    return nil
}

// Stats returns current pool statistics.
func (p *TypedPool[T]) Stats() MemoryPoolStats {
    p.mu.Lock()
    defer p.mu.Unlock()

    var zero T
    blockSize := int(unsafe.Sizeof(zero))

    return MemoryPoolStats{
        TotalBlocks:     len(p.objects),
        FreeBlocks:      len(p.free),
        AllocatedBlocks: len(p.allocated),
        BlockSize:       blockSize,
        TotalBytes:      len(p.objects) * blockSize,
        PeakUsage:       p.peakUsage,
    }
}

// === Arena Allocator for Batch Processing ===

// Arena allocates from a pre-allocated byte slab.
// All allocations are O(1). Deallocation is all-or-nothing (Reset).
// This pattern is used when you process a batch of requests and
// can free all memory at once when the batch completes.
type Arena struct {
    buf    []byte
    offset int
}

// NewArena creates an arena with a fixed capacity.
func NewArena(capacity int) *Arena {
    Assert(capacity > 0, "arena capacity must be positive")
    return &Arena{
        buf: make([]byte, capacity),
    }
}

// Alloc reserves n bytes from the arena. Returns nil if full.
// O(1) - just bumps a pointer. No fragmentation.
func (a *Arena) Alloc(n int) []byte {
    // Align to 8 bytes for safety.
    aligned := (n + 7) &^ 7

    if a.offset+aligned > len(a.buf) {
        return nil // Arena full - caller must handle this.
    }

    start := a.offset
    a.offset += aligned
    return a.buf[start : start+n : start+aligned]
}

// Reset frees all allocations at once. O(1).
func (a *Arena) Reset() {
    // Zero the used portion for security.
    for i := 0; i < a.offset; i++ {
        a.buf[i] = 0
    }
    a.offset = 0
}

// Used returns bytes currently allocated.
func (a *Arena) Used() int {
    return a.offset
}

// Remaining returns bytes available.
func (a *Arena) Remaining() int {
    return len(a.buf) - a.offset
}

// === GC Pressure Monitoring ===

// GCMonitor tracks garbage collection frequency and pause times.
// In NASA terms, this monitors the "non-deterministic" behavior
// that disqualifies Go from flight software.
type GCMonitor struct {
    lastNumGC  uint32
    lastPauseNs uint64
    ticker     *time.Ticker
    stopCh     chan struct{}
    stats      atomic.Value // Stores *GCStats
}

// GCStats holds garbage collection statistics.
type GCStats struct {
    NumGCCycles     uint32
    LastPauseMs     float64
    TotalPauseMs    float64
    HeapAllocMB     float64
    HeapSysMB       float64
    GCCPUPercent    float64
    NextGCMB        float64
}

// NewGCMonitor starts monitoring GC behavior.
func NewGCMonitor(interval time.Duration) *GCMonitor {
    m := &GCMonitor{
        ticker: time.NewTicker(interval),
        stopCh: make(chan struct{}),
    }
    m.stats.Store(&GCStats{})
    go m.run()
    return m
}

func (m *GCMonitor) run() {
    for {
        select {
        case <-m.stopCh:
            return
        case <-m.ticker.C:
            m.collect()
        }
    }
}

func (m *GCMonitor) collect() {
    var memStats runtime.MemStats
    runtime.ReadMemStats(&memStats)

    stats := &GCStats{
        NumGCCycles:  memStats.NumGC,
        HeapAllocMB:  float64(memStats.HeapAlloc) / (1024 * 1024),
        HeapSysMB:    float64(memStats.HeapSys) / (1024 * 1024),
        GCCPUPercent: memStats.GCCPUFraction * 100,
        NextGCMB:     float64(memStats.NextGC) / (1024 * 1024),
    }

    if memStats.NumGC > 0 {
        lastPause := memStats.PauseNs[(memStats.NumGC-1)%256]
        stats.LastPauseMs = float64(lastPause) / 1e6
        stats.TotalPauseMs = float64(memStats.PauseTotalNs) / 1e6
    }

    m.stats.Store(stats)
}

// Stats returns the latest GC statistics.
func (m *GCMonitor) Stats() *GCStats {
    return m.stats.Load().(*GCStats)
}

// Stop terminates the monitor.
func (m *GCMonitor) Stop() {
    m.ticker.Stop()
    close(m.stopCh)
}

// === sync.Pool Usage: NASA-Inspired Buffer Recycling ===

// BufferRecycler uses sync.Pool to reduce GC pressure by recycling
// byte buffers. This is the closest Go gets to NASA's fixed pools.
// Note: sync.Pool objects can be collected by the GC at any time,
// so this is best-effort recycling, not guaranteed pool behavior.
type BufferRecycler struct {
    pool sync.Pool
    size int
}

// NewBufferRecycler creates a recycler for buffers of a specific size.
func NewBufferRecycler(bufferSize int) *BufferRecycler {
    return &BufferRecycler{
        pool: sync.Pool{
            New: func() any {
                buf := make([]byte, bufferSize)
                return &buf
            },
        },
        size: bufferSize,
    }
}

// Get retrieves a buffer, either recycled or newly allocated.
func (br *BufferRecycler) Get() []byte {
    buf := br.pool.Get().(*[]byte)
    // Zero the buffer before returning - defense in depth.
    b := *buf
    for i := range b {
        b[i] = 0
    }
    return b
}

// Put returns a buffer to the recycler.
func (br *BufferRecycler) Put(buf []byte) {
    if cap(buf) != br.size {
        return // Wrong size - don't pool it.
    }
    br.pool.Put(&buf)
}
```

---
