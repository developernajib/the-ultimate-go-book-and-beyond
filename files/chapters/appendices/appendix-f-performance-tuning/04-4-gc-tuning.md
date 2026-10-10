## 4. GC Tuning

The Go garbage collector automatically manages memory but can be tuned.

### 4.1 Understanding the Go GC

**GC Basics**:

```
Go uses a concurrent, tri-color, mark-sweep garbage collector.

┌─────────────────────────────────────────┐
│         GC Cycle (Simplified)           │
├─────────────────────────────────────────┤
│ 1. Mark Setup (STW)                     │
│    - Stop all goroutines                │
│    - Enable write barrier               │
│    - Duration: ~10-30μs                 │
├─────────────────────────────────────────┤
│ 2. Concurrent Mark                      │
│    - Mark reachable objects             │
│    - Application continues running      │
│    - Uses 25% CPU by default            │
├─────────────────────────────────────────┤
│ 3. Mark Termination (STW)               │
│    - Final marking                      │
│    - Disable write barrier              │
│    - Duration: ~10-100μs                │
├─────────────────────────────────────────┤
│ 4. Concurrent Sweep                     │
│    - Return memory to OS                │
│    - Application continues running      │
└─────────────────────────────────────────┘
```

### 4.2 GOGC Environment Variable

`GOGC` controls when GC runs (default: 100).

```bash
# Default: GC when heap doubles (100% growth)
GOGC=100 ./myapp

# More frequent GC (smaller heaps)
GOGC=50 ./myapp  # GC at 50% heap growth

# Less frequent GC (larger heaps)
GOGC=200 ./myapp # GC at 200% heap growth

# Disable GC (not recommended for production)
GOGC=off ./myapp
```

**GOGC Examples**:

```go
package main

import (
    "fmt"
    "runtime"
    "runtime/debug"
)

func printGCStats() {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    fmt.Printf("Heap Alloc: %d MB\n", m.Alloc/1024/1024)
    fmt.Printf("Total Alloc: %d MB\n", m.TotalAlloc/1024/1024)
    fmt.Printf("Num GC: %d\n", m.NumGC)
    fmt.Printf("GC CPU%%: %.2f%%\n", m.GCCPUFraction*100)
}

func setGOGC(percent int) {
    old := debug.SetGCPercent(percent)
    fmt.Printf("GC percent changed from %d to %d\n", old, percent)
}

// Example: Memory-intensive application
func processLargeDataset() {
    // Reduce GC frequency for batch processing
    setGOGC(200) // Allow heap to grow more
    defer setGOGC(100) // Restore default

    // Process data...
}

// Example: Latency-sensitive application
func handleRequest() {
    // More frequent GC for predictable latency
    setGOGC(50) // Smaller pauses, more frequent
    defer setGOGC(100)

    // Handle request...
}
```

### 4.3 GOMEMLIMIT (Go 1.19+)

`GOMEMLIMIT` sets a soft memory limit.

```bash
# Limit to 2GB
GOMEMLIMIT=2GiB ./myapp

# Combined with GOGC
GOGC=50 GOMEMLIMIT=4GiB ./myapp
```

**GOMEMLIMIT Best Practices**:

```go
package main

import (
    "fmt"
    "runtime/debug"
)

func configureMemoryLimit() {
    // Set memory limit programmatically
    limit := int64(2 * 1024 * 1024 * 1024) // 2GB
    old := debug.SetMemoryLimit(limit)

    fmt.Printf("Memory limit: %d -> %d bytes\n", old, limit)
}

// Container deployments
func configureForContainer() {
    // In Kubernetes, set to ~80% of container limit
    // If container limit is 4GB:
    // GOMEMLIMIT=3.2GiB
    //
    // This prevents OOM kills while allowing memory for:
    // - OS caches
    // - Stack memory
    // - Off-heap allocations (CGO, mmap)
}

// Scenarios:

// 1. High-throughput batch processing
//    GOGC=200 GOMEMLIMIT=8GiB
//    → Less frequent GC, use more memory

// 2. Latency-sensitive API
//    GOGC=50 GOMEMLIMIT=2GiB
//    → Frequent GC, predictable latency

// 3. Balanced web service
//    GOGC=100 GOMEMLIMIT=4GiB
//    → Default behavior with safety limit
```

### 4.4 Reducing Allocations

The best GC tuning is fewer allocations.

**Allocation Tracking**:

```go
package main

import (
    "fmt"
    "runtime"
    "testing"
)

func trackAllocations(fn func()) {
    var m1, m2 runtime.MemStats

    runtime.ReadMemStats(&m1)
    fn()
    runtime.ReadMemStats(&m2)

    fmt.Printf("Allocations: %d\n", m2.Mallocs-m1.Mallocs)
    fmt.Printf("Allocated: %d bytes\n", m2.TotalAlloc-m1.TotalAlloc)
}

// Example: Reduce allocations in hot path
type Cache struct {
    data map[string][]byte
}

// Bad: Allocates on every Get
func (c *Cache) GetBad(key string) []byte {
    if val, ok := c.data[key]; ok {
        // Returns copy
        result := make([]byte, len(val))
        copy(result, val)
        return result
    }
    return nil
}

// Good: Return slice reference (if safe)
func (c *Cache) GetGood(key string) []byte {
    // Caller must not modify
    return c.data[key]
}

// Better: Reuse buffer
func (c *Cache) GetBetter(key string, buf []byte) []byte {
    if val, ok := c.data[key]; ok {
        if cap(buf) < len(val) {
            buf = make([]byte, len(val))
        }
        buf = buf[:len(val)]
        copy(buf, val)
        return buf
    }
    return nil
}
```

### 4.5 Off-Heap Strategies

Allocating outside Go's heap avoids GC pressure.

**CGO Memory**:

```go
/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

type OffHeapBuffer struct {
    ptr unsafe.Pointer
    size int
}

func NewOffHeapBuffer(size int) *OffHeapBuffer {
    // Allocate with malloc (not tracked by GC)
    ptr := C.malloc(C.size_t(size))

    return &OffHeapBuffer{
        ptr:  ptr,
        size: size,
    }
}

func (b *OffHeapBuffer) Free() {
    if b.ptr != nil {
        C.free(b.ptr)
        b.ptr = nil
    }
}

func (b *OffHeapBuffer) Bytes() []byte {
    // Create Go slice backed by C memory
    return (*[1 << 30]byte)(b.ptr)[:b.size:b.size]
}

// Warning: Off-heap memory:
// - Not garbage collected
// - Must manually free
// - Can cause memory leaks
// - Use only when GC pressure is critical
```

**mmap for Large Buffers**:

```go
package main

import (
    "golang.org/x/sys/unix"
    "unsafe"
)

type MmapBuffer struct {
    data []byte
}

func NewMmapBuffer(size int) (*MmapBuffer, error) {
    // Allocate with mmap (minimal GC overhead)
    data, err := unix.Mmap(
        -1, 0, size,
        unix.PROT_READ|unix.PROT_WRITE,
        unix.MAP_ANON|unix.MAP_PRIVATE,
    )
    if err != nil {
        return nil, err
    }

    return &MmapBuffer{data: data}, nil
}

func (b *MmapBuffer) Free() error {
    return unix.Munmap(b.data)
}

// Use case: Large in-memory caches
// Benefits:
// - Not scanned by GC
// - OS manages paging
// - Can be huge (100s of GB)
```

---
