## Allocator Telemetry in Production

An allocator you cannot observe is an allocator you cannot trust. In production, memory bugs are silent: slow leaks, slow fragmentation growth, allocation-path latency regressions. Senior engineers instrument the allocator the same way they instrument RPC clients, and they export the metrics to the same dashboards.

### jemalloc's mallctl Interface

jemalloc exposes runtime introspection through `mallctl`, a sysctl-style API that returns metrics, tuning parameters, and profiling toggles. Every production service that links jemalloc should export these to its metrics pipeline.

```cpp
#include <jemalloc/jemalloc.h>
#include <cstdint>
#include <cstddef>
#include <string>

template <typename T>
T je_read(const char* name) {
    T out{};
    std::size_t out_len = sizeof(out);
    if (::mallctl(name, &out, &out_len, nullptr, 0) != 0) {
        throw std::runtime_error(std::string("mallctl read: ") + name);
    }
    return out;
}

void refresh_je_epoch() {
    std::uint64_t epoch = 1;
    std::size_t len = sizeof(epoch);
    ::mallctl("epoch", &epoch, &len, &epoch, len);
}

struct AllocatorSnapshot {
    std::uint64_t allocated;    // bytes currently live
    std::uint64_t active;       // bytes in active pages
    std::uint64_t mapped;       // bytes mapped from the OS
    std::uint64_t resident;     // bytes touched (RSS attributable to jemalloc)
    std::uint64_t retained;     // bytes held back from the OS for reuse
};

AllocatorSnapshot sample_jemalloc() {
    refresh_je_epoch();  // required: jemalloc caches stats
    return {
        je_read<std::uint64_t>("stats.allocated"),
        je_read<std::uint64_t>("stats.active"),
        je_read<std::uint64_t>("stats.mapped"),
        je_read<std::uint64_t>("stats.resident"),
        je_read<std::uint64_t>("stats.retained"),
    };
}
```

Export `allocated`, `resident - allocated` (external fragmentation overhead), and `retained` (memory the allocator refuses to return to the OS). A growing `retained` is not a leak, but a growing `allocated` while request rate is constant almost always is.

### Continuous Heap Profiling

jemalloc's sampling heap profiler records the stack trace of every Nth allocation, where N is configured by `lg_prof_sample` (default 2^19 bytes). At low sample rates (1 in 512 KB), the overhead is under 1%. Dump profiles periodically and analyze with `jeprof`.

```bash
# Start process with profiling enabled
MALLOC_CONF="prof:true,prof_active:true,prof_prefix:/var/log/app/heap,\
prof_gdump:true,lg_prof_sample:19" ./server

# On-demand dump via signal
kill -USR1 $(pgrep server)

# Analyze the most expensive allocation sites
jeprof --text ./server /var/log/app/heap.*.heap | head -40
jeprof --svg ./server /var/log/app/heap.*.heap > heap.svg

# Diff two heap snapshots to find growth
jeprof --text --base=heap.T0.heap ./server heap.T1.heap
```

In a leak investigation, the diff mode is what you want. It shows which allocation sites grew between two snapshots, collapsing the noise from steady-state allocations.

### Latency of the Allocation Path Itself

`allocator.allocate()` is a function call. Measuring its latency is a one-liner with `std::chrono::steady_clock` plus an LFENCE for accuracy. At scale, histogram it.

```cpp
#include <chrono>
#include <prometheus/histogram.h>

prometheus::Histogram* alloc_latency_us;  // buckets: 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100

void* traced_allocate(std::size_t n) {
    auto t0 = std::chrono::steady_clock::now();
    void* p = ::malloc(n);
    auto t1 = std::chrono::steady_clock::now();
    double us = std::chrono::duration<double, std::micro>(t1 - t0).count();
    alloc_latency_us->Observe(us);
    return p;
}
```

Tracing every allocation is too expensive. Sample at 1:1000 using a thread-local counter, or use `__rdtsc` for the measurement itself to reduce overhead to ~20 cycles.

### Attributing Memory to Subsystems

A monolithic binary has dozens of components. When the heap grows, knowing "the heap grew by 500 MB" is useless without "and 480 MB of it is in the RPC buffer cache." Attribution comes from either (a) per-subsystem `std::pmr::memory_resource` instances with counters, or (b) jemalloc arenas, one per subsystem.

```cpp
#include <memory_resource>
#include <atomic>

class TrackedResource : public std::pmr::memory_resource {
    std::pmr::memory_resource* upstream_;
    std::atomic<std::size_t> bytes_in_use_{0};
    const char* name_;

public:
    TrackedResource(const char* name, std::pmr::memory_resource* up)
        : upstream_(up), name_(name) {}

    std::size_t bytes_in_use() const noexcept {
        return bytes_in_use_.load(std::memory_order_relaxed);
    }

protected:
    void* do_allocate(std::size_t bytes, std::size_t align) override {
        bytes_in_use_.fetch_add(bytes, std::memory_order_relaxed);
        return upstream_->allocate(bytes, align);
    }
    void do_deallocate(void* p, std::size_t bytes, std::size_t align) override {
        bytes_in_use_.fetch_sub(bytes, std::memory_order_relaxed);
        upstream_->deallocate(p, bytes, align);
    }
    bool do_is_equal(const std::pmr::memory_resource& o) const noexcept override {
        return this == &o;
    }
};
```

Export `bytes_in_use` per subsystem. When RSS grows, the dashboard answers "which subsystem" in one click. This is what separates a team that can debug a production memory regression in 20 minutes from a team that spends three days bisecting.
