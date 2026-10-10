## Latency Requirements and Measurement

Before you can reduce latency you must measure it correctly. This sounds obvious, but almost every naive latency measurement in HFT systems is wrong in a way that systematically hides the worst cases. Getting measurement right is a prerequisite for everything else in this chapter.

### The HFT Latency Hierarchy

Latency in an HFT system comes from physical and architectural sources. Knowing the theoretical floor at each layer tells you whether further optimization is worth pursuing.

| Layer | Typical Latency | Notes |
|---|---|---|
| Wire (speed of light) | 5 μs / 1000 km | Irreducible. Drives colocation |
| Kernel UDP socket | 50-200 μs | Context switches, copies, protocol stack |
| Kernel bypass (DPDK) | 1-5 μs | Polling directly from NIC memory |
| Software on CPU | 200-500 ns | Well-optimized hot path |
| FPGA PCIe | 100-500 ns | Pipelined, fully deterministic |
| FPGA optical | 10-50 ns | Direct optical I/O on FPGA |
| ASIC | 5-15 ns | Exchange matching engines |

The practical target for a software-only HFT system today is under 2 μs from packet arrival at the NIC to order transmitted. Achieving this requires DPDK or an equivalent kernel bypass solution, careful CPU affinity, and elimination of every unnecessary operation on the hot path.

### Measuring Latency with `rdtsc`

The standard POSIX clock functions, `clock_gettime(CLOCK_MONOTONIC)`, have overhead of 20-50 ns and may serialize the CPU pipeline. For latency measurement within a single machine, the x86 Time Stamp Counter is the right tool.

```cpp
#include <cstdint>
#include <cstring>

// Serialize the pipeline, then read TSC.
// Use rdtscp (read TSC + processor ID) for stronger ordering guarantees.
inline uint64_t rdtsc_serialized() {
    uint32_t lo, hi;
    // cpuid serializes: no instructions before this can execute after it
    __asm__ volatile (
        "cpuid\n\t"
        "rdtsc\n\t"
        : "=a"(lo), "=d"(hi)
        :: "rbx", "rcx"
    );
    return (static_cast<uint64_t>(hi) << 32) | lo;
}

// Lighter-weight: rdtsc without serialization. Suitable for timestamping
// events where exact ordering relative to surrounding code is less critical.
inline uint64_t rdtsc_relaxed() {
    uint32_t lo, hi;
    __asm__ volatile ("rdtsc" : "=a"(lo), "=d"(hi));
    return (static_cast<uint64_t>(hi) << 32) | lo;
}

// rdtscp: reads TSC and processor ID atomically. Prevents instructions
// after it from being reordered before it (but not before → after).
inline uint64_t rdtscp(uint32_t& proc_id) {
    uint32_t lo, hi, aux;
    __asm__ volatile ("rdtscp" : "=a"(lo), "=d"(hi), "=c"(aux));
    proc_id = aux;
    return (static_cast<uint64_t>(hi) << 32) | lo;
}
```

TSC counts CPU cycles. To convert to nanoseconds you need the TSC frequency:

```cpp
#include <chrono>
#include <thread>

// Calibrate TSC frequency by correlating with wall clock.
// Run at startup - call once. Returns TSC ticks per nanosecond.
double calibrate_tsc_frequency() {
    using namespace std::chrono;

    // Warm up
    volatile uint64_t warmup = rdtsc_relaxed();
    (void)warmup;

    auto wall_start = steady_clock::now();
    uint64_t tsc_start = rdtsc_serialized();

    std::this_thread::sleep_for(milliseconds(100));

    uint64_t tsc_end = rdtsc_serialized();
    auto wall_end = steady_clock::now();

    uint64_t tsc_delta = tsc_end - tsc_start;
    uint64_t wall_ns = duration_cast<nanoseconds>(wall_end - wall_start).count();

    return static_cast<double>(tsc_delta) / static_cast<double>(wall_ns);
}

// Singleton calibration
double tsc_per_ns() {
    static double freq = calibrate_tsc_frequency();
    return freq;
}

inline double tsc_to_ns(uint64_t tsc_delta) {
    return static_cast<double>(tsc_delta) / tsc_per_ns();
}
```

On modern Intel and AMD processors with invariant TSC (`/proc/cpuinfo` shows `constant_tsc` and `nonstop_tsc` flags), the TSC increments at a fixed rate regardless of CPU frequency scaling. Always verify these flags before relying on TSC for timing.

### Coordinated Omission: Why Naive Measurement Lies

Coordinated omission is the most insidious latency measurement bug. It occurs when the measurement system skips recording during periods of high load, precisely the periods that matter most.

Consider this naive latency measurement loop:

```cpp
// WRONG: suffers from coordinated omission
void measure_latency_wrong(OrderBook& book) {
    for (int i = 0; i < 1'000'000; ++i) {
        uint64_t t0 = rdtsc_relaxed();
        book.process_update(generate_update());
        uint64_t t1 = rdtsc_relaxed();
        record_sample(tsc_to_ns(t1 - t0));  // Only records when we get here
    }
}
```

When `process_update` takes 50 μs (due to a cache miss, scheduler preemption, or branch mispredict), the loop does not issue the next request until after that 50 μs latency event resolves. Requests that would have arrived during those 50 μs are never sent. The histogram looks great (p99 = 500 ns) but the real p99 under load is far worse.

The fix is to use expected arrival times:

```cpp
// CORRECT: use scheduled arrival times, not actual completion times
void measure_latency_correct(OrderBook& book, uint64_t interval_tsc) {
    uint64_t next_arrival = rdtsc_relaxed();

    for (int i = 0; i < 1'000'000; ++i) {
        // Wait until the scheduled arrival time
        while (rdtsc_relaxed() < next_arrival) { /* spin */ }

        uint64_t t0 = rdtsc_relaxed();
        book.process_update(generate_update());
        uint64_t t1 = rdtsc_relaxed();

        // Record against the scheduled arrival, not the actual start
        record_sample(tsc_to_ns(t1 - next_arrival));

        next_arrival += interval_tsc;  // Next arrival on schedule regardless
    }
}
```

This is what HdrHistogram was designed for. The latency recorded is "how long did this operation actually take, including the time it spent waiting because the previous operation was slow."

### Building a Latency Histogram Without Coordinated Omission

A minimal HDR-style histogram implementation for HFT measurement:

```cpp
#include <array>
#include <algorithm>
#include <cmath>
#include <cstdint>

// Power-of-2 bucketed histogram. Buckets cover [0, 2^20] nanoseconds
// (0 to ~1 ms) with sub-bucket resolution for fine-grained low-latency
// percentile accuracy.
class LatencyHistogram {
    static constexpr int kSubBucketCount = 512;
    static constexpr int kBucketCount    = 32;

    uint64_t counts_[kBucketCount][kSubBucketCount]{};
    uint64_t total_count_{0};
    uint64_t min_ns_{UINT64_MAX};
    uint64_t max_ns_{0};

public:
    void record(uint64_t latency_ns) {
        min_ns_ = std::min(min_ns_, latency_ns);
        max_ns_ = std::max(max_ns_, latency_ns);
        ++total_count_;

        if (latency_ns == 0) {
            ++counts_[0][0];
            return;
        }

        // Find bucket: floor(log2(latency_ns))
        int bucket = 63 - __builtin_clzll(latency_ns);
        bucket = std::min(bucket, kBucketCount - 1);

        // Sub-bucket index within this power-of-2 range
        int sub = static_cast<int>(
            (latency_ns * kSubBucketCount) >> (bucket + 1)
        ) % kSubBucketCount;

        ++counts_[bucket][sub];
    }

    // Returns the latency value at given percentile (0.0 - 100.0)
    uint64_t percentile(double pct) const {
        uint64_t target = static_cast<uint64_t>(
            (pct / 100.0) * static_cast<double>(total_count_)
        );
        uint64_t cumulative = 0;

        for (int b = 0; b < kBucketCount; ++b) {
            for (int s = 0; s < kSubBucketCount; ++s) {
                cumulative += counts_[b][s];
                if (cumulative >= target) {
                    // Reconstruct approximate value from bucket + sub-bucket
                    uint64_t base = (b == 0) ? 0 : (1ULL << b);
                    uint64_t step = base / kSubBucketCount;
                    return base + s * std::max(step, 1ULL);
                }
            }
        }
        return max_ns_;
    }

    void print_report() const {
        printf("Samples: %lu  Min: %lu ns  Max: %lu ns\n",
               total_count_, min_ns_, max_ns_);
        printf("p50:  %lu ns\n", percentile(50.0));
        printf("p90:  %lu ns\n", percentile(90.0));
        printf("p99:  %lu ns\n", percentile(99.0));
        printf("p999: %lu ns\n", percentile(99.9));
        printf("p9999: %lu ns\n", percentile(99.99));
    }
};
```

### Latency Sources to Eliminate

Once you can measure correctly, you can identify and eliminate sources of jitter:

**OS scheduling jitter** is the largest source in untuned systems. The kernel scheduler preempts threads every 1-4 ms by default. Solutions:

```bash
# Isolate CPUs from the scheduler -- no processes run here unless pinned
# Add to kernel boot parameters in /etc/default/grub:
# GRUB_CMDLINE_LINUX="isolcpus=2,3,4,5 nohz_full=2,3,4,5 rcu_nocbs=2,3,4,5"

# Pin a thread to an isolated core at runtime
#include <sched.h>
void pin_thread_to_core(int core_id) {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);
    pthread_setaffinity_np(pthread_self(), sizeof(cpuset), &cpuset);
}
```

**Memory allocation latency**: `malloc` and `new` can take anywhere from 50 ns to 50 μs depending on allocator state. On the critical path, allocate everything at startup. Use the arena allocators from Chapter 139.

**Branch mispredictions**: the CPU branch predictor is wrong about 5-15% of the time on unpredictable branches, costing 15-20 cycles each. Arrange hot paths so the common case is a predictable branch:

```cpp
// Hint to the compiler (and through it, the CPU)
#define likely(x)   __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)

// In the feed handler hot path:
if (likely(msg_type == MSG_ADD_ORDER)) {
    handle_add_order(msg);
} else {
    handle_rare_message(msg);
}
```

**Cache misses**: an L1 hit costs 4 cycles, an L2 hit 12 cycles, an LLC miss 40 cycles, a DRAM access 200+ cycles. The entire hot path, order book structures, ring buffer pointers, risk counters, must fit in L1/L2 cache. Profile cache misses with `perf stat -e cache-misses ./hft_binary`.

### Go Comparison

`time.Now()` in Go has overhead of approximately 20-50 ns, comparable to `clock_gettime`. Go provides no `rdtsc` intrinsic. Accessing the TSC requires inline assembly via CGo or a dedicated assembly file. More fundamentally, Go's goroutine scheduler introduces unpredictable preemption at any safe point, making the kind of deterministic tight-loop measurement shown above impossible without disabling the scheduler, which breaks Go's concurrency model. For latency-sensitive measurement in Go, use the `monotonic` reading embedded in `time.Time` values, but accept that p99+ measurements will reflect scheduler jitter.

---
