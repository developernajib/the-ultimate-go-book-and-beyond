## Audio Performance and Profiling

Profiling audio code is harder than profiling normal code because the audio thread cannot do the things profilers usually do (sample stack, write to disk, take locks, allocate). The senior engineer needs a separate set of techniques: hardware timestamp counters, lock-free reporting buffers, off-thread analysis, and platform-specific instrumentation.

### What You Cannot Do

The standard profiling toolbox is largely off-limits on the audio thread:

- `gprof`, `gprof2dot`: insert calls that allocate and write files. Forbidden.
- `perf record` (Linux): triggers an interrupt that may sample at the wrong moment, but actually safe to attach to a running thread.
- `Instruments` (macOS): mostly safe because it uses sampling at the kernel level, no instrumentation in the audio thread itself.
- `Visual Studio Profiler`: same, sampling at OS level is safe.
- Adding `printf` to time things: forbidden, syscalls.

The technique that works on every platform is **hardware timestamp counters plus off-thread analysis**.

### Reading the Cycle Counter

Every modern CPU has a high-resolution cycle counter. On x86 it is `rdtsc`. On ARM it is `mrs CNTVCT_EL0`. The cost of reading is a few cycles, deterministic, no syscall.

```cpp
#include <cstdint>

#if defined(__x86_64__) || defined(_M_X64)
inline uint64_t rdtsc() noexcept {
    uint32_t lo, hi;
    __asm__ __volatile__ ("rdtsc" : "=a"(lo), "=d"(hi));
    return (static_cast<uint64_t>(hi) << 32) | lo;
}
#elif defined(__aarch64__)
inline uint64_t rdtsc() noexcept {
    uint64_t v;
    __asm__ __volatile__ ("mrs %0, cntvct_el0" : "=r"(v));
    return v;
}
#endif
```

`rdtsc` returns cycle counts on x86, but with `constant_tsc` and `nonstop_tsc` features (universal on modern CPUs) it advances at a fixed nominal frequency regardless of frequency scaling. ARM's `cntvct_el0` is a counter advancing at a fixed frequency exposed via `cntfrq_el0`.

For converting to nanoseconds, calibrate once at startup:

```cpp
uint64_t calibrate() {
    auto t0 = std::chrono::steady_clock::now();
    uint64_t c0 = rdtsc();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    auto t1 = std::chrono::steady_clock::now();
    uint64_t c1 = rdtsc();
    double ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
    double cycles = static_cast<double>(c1 - c0);
    return static_cast<uint64_t>(cycles / ns * 1e9);  // cycles per second
}
```

### Instrumented Timing

Wrap each block of work in a timer, push results to a lock-free queue read by a non-realtime thread:

```cpp
struct TimingRecord {
    uint64_t blockStartTsc;
    uint32_t cyclesProcessBlock;
    uint32_t cyclesFilter;
    uint32_t cyclesFft;
};

class AudioProfiler {
    SpscRingBuffer<TimingRecord, 1024> records_;
public:
    void record(const TimingRecord& r) noexcept { records_.try_push(r); }
    void drainTo(std::vector<TimingRecord>& dest) {
        TimingRecord r;
        while (records_.try_pop(r)) dest.push_back(r);
    }
};

// Audio thread
void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override {
    TimingRecord rec;
    rec.blockStartTsc = rdtsc();

    uint64_t t0 = rdtsc();
    filter_.process(buf);
    rec.cyclesFilter = static_cast<uint32_t>(rdtsc() - t0);

    t0 = rdtsc();
    fft_.process(buf);
    rec.cyclesFft = static_cast<uint32_t>(rdtsc() - t0);

    rec.cyclesProcessBlock = static_cast<uint32_t>(rdtsc() - rec.blockStartTsc);
    profiler_.record(rec);
}
```

A reporter thread dequeues records, computes p50/p95/p99/max, and writes to a log or surfaces in the UI. The audio thread sees a single 8-byte enqueue per record, no allocations, no syscalls.

### Tracking the Worst Case

Audio CPU is reported as a percentage, but the metric that matters is the worst case. A plugin that averages 5% CPU but spikes to 120% on transients will dropout. Track p99 and max, not just mean:

```cpp
struct CpuStats {
    double mean = 0.0;
    double p50 = 0.0, p95 = 0.0, p99 = 0.0;
    double max = 0.0;
    int count = 0;
};

CpuStats compute(std::span<const uint32_t> cycles, double cyclesPerSecond, int blockSize, int sampleRate) {
    std::vector<uint32_t> sorted(cycles.begin(), cycles.end());
    std::sort(sorted.begin(), sorted.end());
    auto pct = [&](double p) {
        return sorted[static_cast<size_t>(p * (sorted.size() - 1))];
    };
    double blockDurationCycles = cyclesPerSecond * blockSize / sampleRate;
    auto toPct = [&](double c) { return 100.0 * c / blockDurationCycles; };
    CpuStats s;
    s.mean = toPct(std::accumulate(cycles.begin(), cycles.end(), 0ull) / static_cast<double>(cycles.size()));
    s.p50  = toPct(pct(0.50));
    s.p95  = toPct(pct(0.95));
    s.p99  = toPct(pct(0.99));
    s.max  = toPct(*std::max_element(cycles.begin(), cycles.end()));
    s.count = static_cast<int>(cycles.size());
    return s;
}
```

The "CPU" meter in Pro Tools and Logic shows worst-case percentage over a recent window precisely because mean would be misleading.

### Sampling Profilers

For figuring out where the cycles go (not just how many), sampling profilers attach from outside the audio thread:

- **macOS:** Instruments' "Time Profiler" attaches to a running process and samples kernel call stacks at 1ms intervals. Safe for audio.
- **Linux:** `perf record -F 999 -p $PID` samples at 999 Hz. Use `perf script` and `FlameGraph` for the visualization.
- **Windows:** Visual Studio Profiler in CPU Sampling mode, or Windows Performance Recorder.

The pattern: run a representative session for 30-60 seconds, capture the trace, analyze offline. The trace shows hot functions, cache miss rates, and branch misprediction rates, none of which the audio thread itself records.

### Hardware Performance Counters

Beyond cycle counts, modern CPUs expose counters for cache misses, branch mispredictions, instructions retired, and microarchitectural events. On Linux:

```cpp
#include <linux/perf_event.h>
#include <sys/syscall.h>

int openCacheMissCounter() {
    struct perf_event_attr pe{};
    pe.type = PERF_TYPE_HW_CACHE;
    pe.size = sizeof(pe);
    pe.config = (PERF_COUNT_HW_CACHE_LL << 0)
              | (PERF_COUNT_HW_CACHE_OP_READ << 8)
              | (PERF_COUNT_HW_CACHE_RESULT_MISS << 16);
    pe.disabled = 1;
    pe.exclude_kernel = 1;
    return syscall(SYS_perf_event_open, &pe, 0 /*self*/, -1, -1, 0);
}
```

`read()` from this fd returns the running count. For audio, you read the counter at the start and end of the callback (the `read` is a syscall, so do not do it inside the audio callback in production, use `mmap` + `rdpmc` for a syscall-free path).

On Apple silicon, `kpc` (kperf) provides similar access but is private API and requires entitlements. Apple's Instruments uses it.

### JUCE perftest

JUCE bundles `juce::PerformanceCounter`:

```cpp
juce::PerformanceCounter counter("ProcessBlock", 1000);
void processBlock(...) override {
    counter.start();
    // work
    counter.stop();
}
```

It accumulates timings and prints stats on destruction. Useful in development, never ship in production code (it allocates a string for printing).

### Audio Bench Tools

Independent benchmark tools for plugins:

- **Plugin Doctor (DDMF).** Loads a plugin, runs reference signals, measures THD, frequency response, latency, and CPU. The de facto standard plugin reviewer's tool.
- **PluginVal (Tracktion).** Open-source, batch-mode validation including stress tests.
- **AudioPluginCompanion.** Newer tool for measuring CPU under realistic loads.

Run all of them in CI for any commercial plugin.

### Real-Time Sanitizer (RTSan)

Released in 2024 as part of LLVM, RTSan instruments functions marked `[[clang::nonblocking]]` and traps when they call non-realtime-safe APIs (malloc, locks, syscalls):

```cpp
#include <sanitizer/realtime_sanitizer_interface.h>

[[clang::nonblocking]]
void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override {
    // Any malloc, lock, or syscall called from here triggers RTSan.
}
```

Build with `-fsanitize=realtime`. Run your test suite. Treat any RTSan trap as a P0 bug. This is the modern replacement for the older `RTAudit` and the various LD_PRELOAD-based tools.

### Cache and Memory Behavior

Audio buffers and filter state are accessed in tight loops. Cache misses hurt:

- **L1 d-cache miss** ~5 cycles.
- **L2 cache miss** ~12 cycles.
- **LLC (L3) miss** ~30 cycles.
- **Main memory** ~200 cycles.

For a 64-sample block with maybe 10 ns/sample budget per plugin, you can absorb a few main memory accesses but not many. Patterns to keep cache-friendly:

- Stride-1 access (loop linearly through arrays).
- Hot data in struct-of-arrays layout, not array-of-structs.
- Filter state per-channel together so SIMD over channels stays in cache.
- `__builtin_prefetch` for predictable future accesses (e.g., next partition in convolution).

### What "Optimized" Looks Like in Practice

A senior code review of audio code will check:

1. The inner loops are vectorized (verify by reading assembly or using compiler explorer).
2. Denormals are disabled.
3. Branches in inner loops are removed or branchless.
4. Allocations happen only outside the audio thread.
5. Memory layout is cache-friendly.
6. `noexcept` is everywhere on the audio thread.
7. The plugin reports its latency correctly to the host.
8. CPU p99 stays well below the block deadline under stress tests.
9. RTSan passes.
10. Plugin Doctor measurements match design specs.

If all ten check out, the code is ready to ship.

---
