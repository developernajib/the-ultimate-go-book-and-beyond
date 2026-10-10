## Clock Synchronization

Clocks are the silent destroyer of distributed correctness. Two C++ services running on adjacent VMs disagree about the current time by a few hundred microseconds. A leader thinks its lease is still valid, the cluster has already elected a successor. A read returns a value that was written after the read started. Every distributed bug that ends in "but the timestamps don't lie" lies in a clock that lied.

This section walks through the clocks available to a C++ service, the synchronization protocols that constrain them, and the application-level abstractions (HLC, TrueTime) that let you reason about time when the underlying clocks cannot be trusted to better than a few milliseconds.

### Clocks Available to std::chrono

C++ exposes three standard clocks plus several platform-specific ones.

```cpp
#include <chrono>

auto wall = std::chrono::system_clock::now();        // wall clock, can jump.
auto mono = std::chrono::steady_clock::now();        // monotonic, cannot jump backward.
auto hires = std::chrono::high_resolution_clock::now(); // platform-defined alias.
```

`system_clock` is wall-clock time. NTP can step it backward. Crossing a daylight savings boundary can step it forward (or backward) by an hour. Use it only when you need to communicate a human-meaningful timestamp.

`steady_clock` is monotonic. It never goes backward and is not adjusted by NTP. Use it for timeouts, latency measurement, and lease expiry calculations against a known anchor.

A common bug is using `system_clock` for timeouts.

```cpp
// Wrong: NTP step can make the timeout fire instantly or never.
auto deadline = std::chrono::system_clock::now() + std::chrono::seconds(30);
while (std::chrono::system_clock::now() < deadline) { ... }

// Right: monotonic clock for elapsed time.
auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
while (std::chrono::steady_clock::now() < deadline) { ... }
```

### NTP, chrony, PTP

**NTP** disciplines the wall clock to within roughly 1-50 ms of UTC over a public network, 100 microseconds to 1 ms inside a data center.

**chrony** is the modern NTP daemon. It converges faster than ntpd after large offsets, handles intermittent connectivity, and is the default on most cloud distributions. Configure it to slew (adjust gradually) rather than step (jump instantly), so that wall-clock time never jumps backward in a running process.

**PTP** (Precision Time Protocol, IEEE 1588) achieves sub-microsecond accuracy over a switched network with PTP-aware switches. Required for HFT, 5G base stations, and Spanner-class systems. The hardware tax is real: PTP-capable NICs and switches.

Before relying on a clock for distributed correctness, measure your offset. The `chronyc tracking` and `chronyc sources` commands report the current offset estimate. A C++ service can also expose a Prometheus metric for `offset_microseconds_estimate` so that alerts fire when synchronization degrades.

### Hybrid Logical Clocks (HLC)

Lamport's logical clocks give you happens-before but not wall-clock time. Wall clocks give you a number that humans recognize but no causality guarantee. The Hybrid Logical Clock, introduced by Kulkarni et al. (2014), gives you both.

An HLC is a (physical, logical) pair. On every event:

1. Read the wall clock (`pt`).
2. New HLC = `(max(pt, last.physical, recv.physical), 0)` if that max equals `pt`, else `(max, last.logical + 1)` or `(max, recv.logical + 1)` whichever applies.

The result is a 64-bit number that is monotonically increasing within and across nodes (assuming bounded clock skew), and that approximates wall-clock time to within the skew bound.

```cpp
struct HLC {
    int64_t physical;  // microseconds since epoch
    int64_t logical;   // counter
    auto operator<=>(const HLC&) const = default;
};

class HLCClock {
public:
    HLC Now() {
        std::lock_guard lock(mu_);
        auto pt = WallClockMicros();
        if (pt > last_.physical) { last_ = {pt, 0}; }
        else { last_.logical += 1; }
        return last_;
    }

    HLC Update(HLC recv) {
        std::lock_guard lock(mu_);
        auto pt = WallClockMicros();
        auto p = std::max({pt, last_.physical, recv.physical});
        int64_t l;
        if (p == last_.physical && p == recv.physical) l = std::max(last_.logical, recv.logical) + 1;
        else if (p == last_.physical) l = last_.logical + 1;
        else if (p == recv.physical) l = recv.logical + 1;
        else l = 0;
        last_ = {p, l};
        return last_;
    }

private:
    static int64_t WallClockMicros() {
        return std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }
    std::mutex mu_;
    HLC last_{};
};
```

CockroachDB uses HLCs as the basis for its serializable transactions. Yugabyte, FaunaDB, and many others followed. If you are designing a distributed database without TrueTime hardware, HLC is the default.

### TrueTime (Spanner)

Google's Spanner is the only widely deployed system that exposes a *bounded uncertainty interval* for the current time. The `TT.now()` API returns `TTinterval(earliest, latest)`, with `latest - earliest` typically under 7 ms. The implementation uses GPS receivers and atomic clocks per data center, plus the Marzullo intersection algorithm to bound the uncertainty of the local TrueTime daemon.

The algorithmic payoff is *external consistency*. To commit a transaction at timestamp `s`, Spanner waits until `TT.now().earliest > s`. That wait, called *commit-wait*, ensures that any subsequent transaction with a later TrueTime reading sees `s` in its past. The result is that the global commit order matches wall-clock order, observable to clients.

You cannot replicate TrueTime in software alone. AWS released a similar service (Time Sync Service) using PTP. CockroachDB approximates with HLC and accepts a weaker guarantee.

### Detecting Clock Skew in C++

If you cannot have TrueTime, you can at least detect when the local clock has gone wrong.

```cpp
// Compare wall clock against monotonic clock. A divergence indicates an NTP step.
class SkewDetector {
public:
    void Sample() {
        auto wall = std::chrono::system_clock::now().time_since_epoch();
        auto mono = std::chrono::steady_clock::now().time_since_epoch();
        if (samples_.empty()) {
            anchor_wall_ = wall;
            anchor_mono_ = mono;
        }
        auto wall_delta = wall - anchor_wall_;
        auto mono_delta = mono - anchor_mono_;
        auto skew = wall_delta - mono_delta;  // wall ran faster than mono?
        last_skew_ns_ = std::chrono::duration_cast<std::chrono::nanoseconds>(skew).count();
    }

    int64_t LastSkewNanos() const { return last_skew_ns_; }

private:
    std::chrono::system_clock::duration anchor_wall_{};
    std::chrono::steady_clock::duration anchor_mono_{};
    std::vector<int64_t> samples_;
    int64_t last_skew_ns_ = 0;
};
```

Log the skew once per second. When it exceeds a threshold (1 ms in a tightly synchronized cluster, 50 ms in a loose one), alert and refuse to issue any operation that depends on absolute timestamps.

### Leases and Clock Skew

Lease-based leadership (covered in detail in the leases section) depends on a clock-skew bound. If the leader and follower disagree by ε on the wall clock, then a lease of duration L is only safe to honor for `L - 2ε`. A common production bug: the bound was assumed to be 100 ms, the actual skew was 500 ms, and split-brain resulted.

Mitigation: derive lease durations from monotonic clocks at the leader, communicate remaining duration as a *delta*, and have the follower add the delta to its own monotonic clock at the moment of receipt.

```cpp
// Leader sends remaining lease as a delta, not an absolute deadline.
struct LeaseGrant {
    uint64_t epoch;
    std::chrono::milliseconds remaining_ms;
};

LeaseGrant g{epoch_, std::chrono::milliseconds(7000)};
SendToFollower(g);

// Follower converts to its own monotonic clock.
auto local_deadline = std::chrono::steady_clock::now() + g.remaining_ms;
```

The wire format never contains a wall-clock timestamp, so wall-clock skew between leader and follower is irrelevant. Only the *RTT* of the message matters, and that can be bounded by rejecting grants whose age exceeds a few RTTs.

### Junior at FAANG: The Clock Question

When asked "how do you generate a monotonically increasing timestamp across nodes?", do not say "we use NTP and trust the wall clock." Say: "if the workload tolerates millisecond skew, use HLC. If it requires external consistency, use TrueTime or a PTP-based equivalent. Inside a single host, use `steady_clock`. Never use `system_clock` for timeouts. The wall clock can step, the monotonic clock cannot."

That answer separates engineers who have read the Spanner paper from those who have not.

---
