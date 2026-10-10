## 09. Practical Implications for Go and C++

The preceding chapters built a model of how memory works physically. This chapter connects that model to everyday programming decisions in Go and C++. Every technique here has a concrete mechanical justification rooted in the hardware behavior described earlier.

### Go: Escape Analysis in Practice

The Go compiler determines at compile time whether a variable can live on the goroutine's stack or must be heap-allocated. Variables that "escape" go to the heap and become GC work.

Run escape analysis output:

```bash
go build -gcflags='-m' ./...
```

Common escape triggers and how to fix them:

#### Interface Boxing

```go
// Escapes: value boxed in interface{} goes to heap
func logVal(v interface{}) {
    fmt.Println(v)
}

// Fix: use concrete type or constrain with generics
func logInt(v int) {
    fmt.Println(v)
}

// Go 1.18+: generic version avoids boxing for value types
func logAny[T any](v T) {
    fmt.Println(v)
}
```

#### Returning Pointers to Locals

```go
// Escapes: compiler sees pointer may outlive function
func newConfig() *Config {
    cfg := Config{Timeout: 30}
    return &cfg  // cfg escapes to heap
}

// Alternative: accept a pointer parameter, caller controls lifetime
func initConfig(cfg *Config) {
    cfg.Timeout = 30
}
// Caller can stack-allocate:
// var cfg Config - initConfig(&cfg)
```

#### Closures Capturing Variables

```go
// x escapes because the closure outlives the function
func makeAdder(x int) func(int) int {
    return func(y int) int { return x + y }  // x escapes
}

// For hot paths, avoid closure capture: use a struct
type Adder struct{ x int }
func (a Adder) Add(y int) int { return a.x + y }
```

#### Slice Backing Array Growth

```go
// If a slice grows beyond its initial capacity, the backing array
// is reallocated on the heap regardless of where it started.
func buildSlice() []int {
    s := make([]int, 0, 1024)  // pre-size to avoid reallocation
    for i := 0; i < 1000; i++ {
        s = append(s, i)
    }
    return s
}
```

### Go: sync.Pool to Reduce GC Pressure

`sync.Pool` provides a per-P (per-OS-thread in the Go scheduler) cache of reusable objects. Objects in the pool are not garbage-collected during a GC cycle but are cleared after it. This is the primary tool for reducing allocation rate on hot paths.

```go
package httphandler

import (
    "bytes"
    "net/http"
    "sync"
)

var responsePool = sync.Pool{
    New: func() interface{} {
        return &bytes.Buffer{}
    },
}

func handleRequest(w http.ResponseWriter, r *http.Request) {
    buf := responsePool.Get().(*bytes.Buffer)
    buf.Reset() // always reset before use
    defer responsePool.Put(buf)

    // Use buf for response building, no heap allocation per request
    buf.WriteString(`{"status":"ok"}`)
    w.Header().Set("Content-Type", "application/json")
    w.Write(buf.Bytes())
}
```

Pool rules:
- Always call `Reset()` or equivalent before reuse. Objects in the pool retain previous contents.
- Do not pool objects with finalizers.
- Pool is safe for concurrent use from multiple goroutines.
- Do not use Pool as a long-lived cache, objects may be reclaimed at any GC.

## Go: GOGC and GOMEMLIMIT

**GOGC** controls when GC runs. It is the target heap growth percentage since the last collection. `GOGC=100` (default) means GC when the heap is twice the size it was after the previous collection.

```bash
## Reduce GC frequency at the cost of higher peak memory:
GOGC=200 ./myserver

## Increase GC frequency to keep heap small:
GOGC=50 ./myserver

## Disable GC entirely (dangerous, only for batch jobs with bounded allocation):
GOGC=off ./mybatchjob
```

**GOMEMLIMIT** (Go 1.19+) sets a soft limit on total Go runtime memory. When memory approaches the limit, the GC becomes more aggressive. This prevents OOM kills in containerized environments better than GOGC alone.

```bash
GOMEMLIMIT=1GiB ./myserver
```

In code:

```go
import "runtime/debug"

func init() {
    // Set based on container memory limit read from cgroup:
    debug.SetMemoryLimit(800 * 1024 * 1024) // 800MB
    debug.SetGCPercent(100)                  // default
}
```

## Go: pprof Memory Profiling

The `net/http/pprof` package provides heap profiles showing where allocations are happening.

```go
import _ "net/http/pprof"
import "net/http"

func main() {
    go http.ListenAndServe(":6060", nil)
    // ... rest of program
}
```

Collect and analyze:

```bash
## Heap profile: allocation counts and bytes
go tool pprof http://localhost:6060/debug/pprof/heap

## Allocation profile: where are allocations happening?
go tool pprof -alloc_objects http://localhost:6060/debug/pprof/heap

## In pprof interactive mode:
(pprof) top20
(pprof) web        # requires graphviz
(pprof) list myFunc
```

Key metrics:
- `inuse_space`: memory currently live on the heap.
- `alloc_space`: cumulative bytes allocated since program start.
- `inuse_objects`: count of live objects.
- `alloc_objects`: cumulative object count.

`alloc_objects` is the most useful for finding GC pressure. A function that appears at the top of `alloc_objects` but not `inuse_space` is creating many short-lived objects.

### Go: Profiling Allocations in Benchmarks

```go
package mypackage_test

import (
    "testing"
)

func BenchmarkProcess(b *testing.B) {
    b.ReportAllocs()  // report allocations per iteration
    data := makeTestData()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        Process(data)
    }
}
```

```bash
go test -bench=BenchmarkProcess -benchmem ./...
# Output:
# BenchmarkProcess-8   1000000   1234 ns/op   128 B/op   3 allocs/op
```

A result showing "0 allocs/op" means the compiler allocated everything on the stack, that is the goal for hot paths.

### C++: Stack Allocation Patterns

C++ gives you direct control over stack vs heap allocation. Prefer stack-allocated objects when lifetime is bounded to the scope.

```cpp
#include <array>
#include <cstdint>
#include <cstring>

// Bad: heap allocation per call
std::vector<uint8_t> encryptBad(const uint8_t* src, size_t len) {
    std::vector<uint8_t> buf(len);  // heap allocation
    // ... encrypt into buf
    return buf;
}

// Better: caller provides stack buffer for small messages
template<size_t N>
struct StackBuf {
    std::array<uint8_t, N> data;
    size_t len = 0;
};

void encryptInPlace(StackBuf<4096>& buf, const uint8_t* src, size_t len) {
    if (len > buf.data.size()) return;  // too large for stack buffer
    std::memcpy(buf.data.data(), src, len);
    // ... encrypt in place
    buf.len = len;
}
```

#### Placement New for Reuse

For hot-path objects that would otherwise be heap-allocated:

```cpp
#include <new>
#include <cstdlib>

// Allocate a pool of aligned storage once
alignas(64) static uint8_t object_pool[sizeof(MyObject) * 64];
static int pool_idx = 0;

MyObject* allocFromPool() {
    if (pool_idx >= 64) return nullptr;
    void* mem = object_pool + pool_idx * sizeof(MyObject);
    pool_idx++;
    return new(mem) MyObject();  // placement new: no heap alloc
}
```

#### Huge Pages with mmap in C++

For large buffers (database buffer pools, ML model weights), use huge pages to reduce TLB pressure:

```cpp
#include <sys/mman.h>
#include <cstddef>
#include <cstdio>

// Allocate size bytes backed by 2MB huge pages.
// size must be a multiple of 2MB (2 * 1024 * 1024).
void* allocHugePages(size_t size) {
    void* ptr = mmap(
        nullptr,
        size,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
        -1, 0
    );
    if (ptr == MAP_FAILED) {
        // Fall back to regular pages with MADV_HUGEPAGE hint
        ptr = mmap(nullptr, size,
                   PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (ptr != MAP_FAILED) {
            madvise(ptr, size, MADV_HUGEPAGE);
        }
    }
    return ptr == MAP_FAILED ? nullptr : ptr;
}

void freeHugePages(void* ptr, size_t size) {
    munmap(ptr, size);
}
```

Huge pages require that the kernel has reserved huge pages:

```bash
# Reserve 512 x 2MB huge pages = 1GB
echo 512 > /proc/sys/vm/nr_hugepages

# Check availability:
grep HugePages /proc/meminfo
```

### C++: Cache-Aware Data Structures

#### False Sharing

False sharing occurs when two threads frequently write to different variables that happen to share a cache line (64 bytes on x86). The hardware coherence protocol invalidates the entire cache line on every write, causing the other thread to reload even though the variable it cares about has not changed.

```cpp
#include <atomic>
#include <thread>
#include <cstdint>

// BAD: counters share a cache line
struct BadCounters {
    std::atomic<uint64_t> a;  // bytes 0-7
    std::atomic<uint64_t> b;  // bytes 8-15
};

// GOOD: pad each counter to its own cache line
struct alignas(64) CacheLinePadded {
    std::atomic<uint64_t> value;
    char pad[64 - sizeof(std::atomic<uint64_t>)];
};

struct GoodCounters {
    CacheLinePadded a;  // cache line 1
    CacheLinePadded b;  // cache line 2
};
```

False sharing can cause 5-10x slowdowns in multi-threaded code without any apparent bug.

#### Structure of Arrays (SoA) vs Array of Structures (AoS)

For hot loops that access only some fields of a struct, SoA layout is more cache-efficient:

```cpp
// AoS: processing 'x' loads all fields into cache (wasteful)
struct Particle {
    float x, y, z;   // position (12 bytes)
    float vx, vy, vz; // velocity (12 bytes)
    float mass;       // (4 bytes)
    uint32_t id;      // (4 bytes)
    // Total: 32 bytes per particle
};
std::vector<Particle> particles;

// SoA: processing 'x' loads only x values (cache-efficient)
struct ParticlesSoA {
    std::vector<float> x, y, z;
    std::vector<float> vx, vy, vz;
    std::vector<float> mass;
    std::vector<uint32_t> id;
};
```

For a physics simulation that only updates positions using velocity, the SoA layout means 4 bytes of useful data per cache line fetch instead of 8 bytes of waste.

### Benchmark: Measuring True Allocation Cost

```go
package alloc_test

import (
    "sync"
    "testing"
)

type Request struct {
    ID   uint64
    Body [256]byte
}

var pool = sync.Pool{New: func() interface{} { return new(Request) }}

func BenchmarkNewAlloc(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        r := new(Request)
        r.ID = uint64(i)
        _ = r
    }
}

func BenchmarkPoolAlloc(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        r := pool.Get().(*Request)
        r.ID = uint64(i)
        pool.Put(r)
    }
}

func BenchmarkStackAlloc(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        var r Request
        r.ID = uint64(i)
        _ = r
    }
}
```

Expected results on a modern system:
- `BenchmarkNewAlloc`: ~100-200 ns/op, 1 alloc/op.
- `BenchmarkPoolAlloc`: ~20-50 ns/op, 0 allocs/op (after warmup).
- `BenchmarkStackAlloc`: ~5-15 ns/op, 0 allocs/op.

The stack version is 10-20x faster than heap allocation because the allocation is a SP arithmetic operation resolved at compile time.

### Summary Checklist

For a latency-sensitive Go or C++ service:

1. Run `go build -gcflags='-m'` and eliminate surprising escapes on hot paths.
2. Pre-size slices and maps to avoid growth-triggered reallocation.
3. Use `sync.Pool` for any object allocated more than 10,000 times per second.
4. Set `GOMEMLIMIT` based on your container's memory limit.
5. Profile with `pprof` under production load. `alloc_objects` shows GC pressure, `inuse_space` shows memory footprint.
6. Structure data for sequential access. If you must use a pointer-heavy structure, group hot fields together within the struct.
7. Pad concurrent data structures to avoid false sharing.
8. Use huge pages for large buffers (> 64MB) in C++ by default on NUMA servers.
9. Monitor `/proc/pressure/memory` in production and alert on `full avg10 > 1%`.
10. Avoid calling `fsync` inside per-request critical paths, use write-ahead logs with group commit instead.

**Watch:** [Stack vs Heap Memory. Simple Explanation](https://www.youtube.com/watch?v=5OJRqkYbK-4), recommended for visual learners.

**Watch:** [Memory Segments in C/C++](https://www.youtube.com/watch?v=2htbIR2QpaM), recommended for visual learners.

---

| [◀ Chapter 132B: Memory Safety and Exploitation](../chapter-132b-memory-safety-exploitation/00-introduction.md) | [Chapter 167: How Computer Memory Works Under the Hood](00-introduction.md) | [Chapter 168: CPU and OS Concurrency Foundations](../chapter-168-cpu-os-concurrency-foundations/00-introduction.md) ▶ |

