## Top-Down Microarchitecture Analysis: The Method

Flat profilers tell you which function is hot. They do not tell you why that function is slow. Two functions can both show up as 30% of CPU and have completely different root causes. One is frontend-bound (the CPU cannot fetch instructions fast enough because of icache misses or branch mispredictions), the other is backend-bound (the CPU is stalling on memory or on long-latency arithmetic). The fix for each is different, and the top-down method, developed by Intel's Ahmad Yasin, is how a senior performance engineer separates them.

### The Four Categories

Every CPU cycle on a modern out-of-order core falls into exactly one of four buckets, measured using hardware performance counters.

1. **Retiring**: a useful micro-op was retired. This is what you want.
2. **Bad Speculation**: the pipeline was flushed because of branch misprediction or machine clear.
3. **Frontend Bound**: the pipeline had no micro-ops to issue because the fetch/decode/uop cache path stalled.
4. **Backend Bound**: micro-ops were ready but the backend (execution units, load/store, reorder buffer) could not accept them.

For a well-tuned kernel, Retiring dominates (>60%). If Bad Speculation is high, work on branches. If Frontend is high, reduce code size and reorder hot paths. If Backend is high, it splits further into Memory Bound (cache, DRAM, TLB) and Core Bound (execution port contention).

### Running It with perf

Intel CPUs since Skylake expose top-down metrics directly. Linux `perf` 5.13+ supports them.

```bash
# Top-level breakdown
perf stat -a --topdown ./my_server --duration=30

# Drill into backend -> memory boundedness
perf stat -e cycles,instructions,\
cycle_activity.stalls_l1d_miss,\
cycle_activity.stalls_l2_miss,\
cycle_activity.stalls_l3_miss,\
cycle_activity.stalls_mem_any \
./my_server

# Frontend detail (fetch latency vs fetch bandwidth)
perf stat -e frontend_retired.dsb_miss,\
frontend_retired.l1i_miss,\
frontend_retired.itlb_miss \
./my_server
```

A typical reading for a trading engine:

| Category | Reading |
| --- | --- |
| Retiring | 45% |
| Bad Speculation | 8% |
| Frontend Bound | 12% |
| Backend Bound | 35% |
| `_ Memory Bound` | 30% |
| `_ Core Bound` | 5% |

The verdict: this code is memory-bound. Before touching SIMD or branchless tricks, fix the data layout.

### Programmatic Access via perf_event_open

For long-running production services, you want to sample counters in-process rather than running `perf` externally. C++26 wraps `perf_event_open` in libraries like `PAPI` and Google's `perftools`.

```cpp
#include <linux/perf_event.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <cstring>
#include <stdexcept>
#include <span>

class PmuCounter {
    int fd_{-1};
public:
    PmuCounter(std::uint32_t type, std::uint64_t config) {
        perf_event_attr pea{};
        pea.type = type;
        pea.size = sizeof(pea);
        pea.config = config;
        pea.disabled = 1;
        pea.exclude_kernel = 1;
        pea.exclude_hv = 1;
        fd_ = static_cast<int>(::syscall(SYS_perf_event_open, &pea, 0, -1, -1, 0));
        if (fd_ < 0) throw std::runtime_error("perf_event_open failed");
    }
    ~PmuCounter() { if (fd_ >= 0) ::close(fd_); }

    void start() { ::ioctl(fd_, PERF_EVENT_IOC_RESET, 0); ::ioctl(fd_, PERF_EVENT_IOC_ENABLE, 0); }
    void stop()  { ::ioctl(fd_, PERF_EVENT_IOC_DISABLE, 0); }

    std::uint64_t read_value() const {
        std::uint64_t v{};
        if (::read(fd_, &v, sizeof(v)) != sizeof(v)) throw std::runtime_error("read");
        return v;
    }
};

// Usage inside a hot loop under load test:
PmuCounter branch_miss(PERF_TYPE_HARDWARE, PERF_COUNT_HW_BRANCH_MISSES);
branch_miss.start();
process_batch(events);
branch_miss.stop();
log_metric("branch_misses", branch_miss.read_value());
```

Export these counters to your metrics pipeline (Prometheus, internal Monarch) and alert when branch-miss rate per instruction crosses a threshold on canary hosts. This is how senior performance engineers catch regressions before they reach production, not by reading `perf` output after a complaint.

### When Top-Down Lies

Top-down is a model. Two scenarios break it. First, workloads with heavy kernel time (networking, syscalls): measure with `--all-cpus` and separately analyze kernel traces. Second, heterogeneous cores (Alder Lake P/E, ARM big.LITTLE): pin the process to one core class or report per-core-type breakdowns, otherwise the aggregated numbers average unrelated behaviors and mislead.
