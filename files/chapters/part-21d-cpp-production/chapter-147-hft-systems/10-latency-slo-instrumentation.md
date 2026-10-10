## Latency SLO Instrumentation for HFT and Low-Latency Services

An SLO that says "p99 under 500us" is meaningless without measurement discipline. The default tools lie by omission. Histograms with exponential buckets lose fidelity in the tail. Single samples at request completion miss coordinated omission. Wall-clock timestamps are not monotonic. A senior engineer builds instrumentation that survives all three failure modes.

### Monotonic timestamps

Never measure latency with `gettimeofday` or `std::chrono::system_clock`. NTP slews and leap seconds will invert timestamps. Use `CLOCK_MONOTONIC_RAW`:

```cpp
inline uint64_t NowNs() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC_RAW, &ts);
    return uint64_t(ts.tv_sec) * 1'000'000'000ull + ts.tv_nsec;
}
```

For sub-microsecond work, read the TSC directly (`__rdtsc()` on x86) after pinning the thread and calibrating against `CLOCK_MONOTONIC_RAW` at startup. TSC read is sub-10ns on modern CPUs, and the `invariant TSC` feature guarantees linearity across P-states. Verify with `cat /proc/cpuinfo | grep constant_tsc`.

### HDR histogram over exponential buckets

A Prometheus histogram with 10 exponential buckets cannot resolve a p99.9 regression from 450us to 500us. HDR histograms (High Dynamic Range) maintain precision across many orders of magnitude at fixed memory cost.

```cpp
#include <hdr/hdr_histogram.h>

struct LatencyRecorder {
    hdr_histogram* h;
    LatencyRecorder(int64_t max_ns, int sig) {
        hdr_init(1, max_ns, sig, &h);
    }
    void Record(int64_t ns) { hdr_record_value(h, ns); }
    int64_t P(double q) { return hdr_value_at_percentile(h, q); }
};

// 3 significant digits from 1ns to 1s: ~185KB per histogram.
static LatencyRecorder order_ack{1'000'000'000, 3};
```

Export percentiles (p50, p90, p99, p99.9, p99.99, max) every second. Do not average across windows, percentiles do not average.

### Coordinated omission avoidance

If a request stalls 50ms and then the server resumes, naive instrumentation records one 50ms latency and skips the 5000 requests that would have been made during the stall. The real user-facing latency distribution has a 50ms tail affecting 5000 requests, not one.

The fix is Gil Tene's "intended rate" correction. Record the expected inter-arrival time, and when a sample exceeds it, backfill synthetic samples at the intended rate:

```cpp
void RecordCorrected(LatencyRecorder& rec, int64_t latency_ns,
                     int64_t intended_interval_ns) {
    rec.Record(latency_ns);
    for (int64_t v = latency_ns - intended_interval_ns;
         v > intended_interval_ns;
         v -= intended_interval_ns) {
        rec.Record(v);
    }
}
```

This single correction typically raises reported p99.9 by an order of magnitude on a stalled system, and that is the honest number.

### Per-queue time accounting

Total latency decomposes into queue time + service time. Record both separately. The request carries a `enqueue_ns` stamped at arrival, and the worker computes `service_ns = now - dequeue_ns` and `queue_ns = dequeue_ns - enqueue_ns`. Queue time spikes are almost always the actual problem when service time looks stable, and merging them hides the signal.

### Critical-section budgets

Every mutex held for longer than 100us on a latency-sensitive path is a bug. Wrap mutexes with a timing guard in debug builds:

```cpp
class TimedLock {
    std::mutex& m_;
    uint64_t start_;
    const char* where_;
public:
    TimedLock(std::mutex& m, const char* where)
        : m_(m), start_(NowNs()), where_(where) { m_.lock(); }
    ~TimedLock() {
        uint64_t held = NowNs() - start_;
        if (held > 100'000) {
            LOG(WARNING) << "lock held " << held << "ns at " << where_;
        }
        m_.unlock();
    }
};
```

In release builds this compiles to a plain lock. In staging it fires on every regression, which is when a reviewer catches the change that introduced the blocking call.

### SLI definition

An SLI is a ratio of good events to total events. For a trading venue:

```
SLI_latency = count(order_ack_ns < 500'000) / count(order_ack_ns)
```

The SLO is the threshold on the SLI (e.g., 99.9% of orders under 500us over a 30-day window). The error budget is `1 - SLO` of events, and when the budget is burning twice as fast as nominal, the on-call is paged. Burn-rate alerts over multiple windows (5min at 14x, 1h at 6x) are the standard SRE recipe, and they apply unchanged to C++ services.

### Error budget policy

When budget is exhausted, the organization has agreed in advance to stop feature deploys and focus on reliability. This is a written policy, not an improvisation during the incident. In C++ systems where deploy is annual and hotfixes are expensive, the policy typically adds: freeze non-reliability PRs, rerun sanitizer + fuzzer jobs at higher coverage, and require an SLO review before the next release.

### What to ship to the dashboard

Per service, per endpoint: count, error rate, queue p99, service p99, total p99, p99.9, p99.99, max over 1s/1min/5min/1h windows. Plus histograms as native Prometheus or OTel histograms, not summaries. Summaries cannot be aggregated across instances, which makes fleet-wide analysis impossible.
