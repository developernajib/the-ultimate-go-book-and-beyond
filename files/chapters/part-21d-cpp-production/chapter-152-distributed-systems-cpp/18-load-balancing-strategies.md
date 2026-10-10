## Load Balancing Strategies

A load balancer chooses which backend handles each request. The choice determines tail latency, capacity use, and resilience. Round-robin is the textbook default and almost never the best choice in production. This section covers the strategies a senior C++ engineer should know: power-of-2 choices, EWMA latency-based, adaptive concurrency limiting, and Maglev consistent hash.

### Round Robin and Its Failures

```cpp
class RoundRobin {
public:
    Backend* Next() { return backends_[counter_++ % backends_.size()]; }
private:
    std::vector<Backend*> backends_;
    std::atomic<size_t> counter_{0};
};
```

Round-robin assumes all backends are equally loaded and equally fast. Both assumptions break in production. A backend running on a noisy neighbor sees higher latency. A backend mid-GC stalls for hundreds of milliseconds. Round-robin keeps sending requests to it, magnifying the tail.

### Random Choice

Pick a random backend per request. Same expected load, much better worst-case behavior than round-robin under heterogeneous load. The classical paper (Mitzenmacher, 2001) shows random is asymptotically optimal in queue depth.

```cpp
class Random {
public:
    Backend* Next() { return backends_[rng_() % backends_.size()]; }
private:
    std::vector<Backend*> backends_;
    std::mt19937 rng_{std::random_device{}()};
};
```

The downside: with N backends, the expected maximum queue length is `O(log N / log log N)`. Some backend always has a small backlog.

### Power of Two Choices (Mitzenmacher, 1996)

Pick two random backends, send to the one with shorter queue. Astonishingly powerful: maximum queue length drops to `O(log log N)`, exponentially smaller than random.

```cpp
class PowerOfTwo {
public:
    Backend* Next() {
        auto a = backends_[rng_() % backends_.size()];
        auto b = backends_[rng_() % backends_.size()];
        return a->QueueLength() <= b->QueueLength() ? a : b;
    }
};
```

Used by HAProxy, Envoy, gRPC's pick-first-with-load-aware variant. Default load balancing for any distributed system that has a notion of "queue length" exposed by the backend.

The "queue length" can be:
- Number of in-flight requests at the LB (LB-side counter).
- Backend's reported in-flight count (requires backend to expose).
- EWMA of recent latency (a proxy for load).

### EWMA Latency-Based

Track an exponentially-weighted moving average of latency per backend. Send each request to the backend with the lowest EWMA.

```cpp
class EwmaLatency {
public:
    Backend* Next() {
        Backend* best = nullptr;
        double best_lat = std::numeric_limits<double>::infinity();
        for (auto* b : backends_) {
            auto l = b->EwmaMicros();
            if (l < best_lat) { best_lat = l; best = b; }
        }
        return best;
    }

    void OnComplete(Backend* b, std::chrono::microseconds lat) {
        // EWMA with alpha=0.1 over recent observations.
        double cur = b->EwmaMicros();
        b->SetEwma(0.9 * cur + 0.1 * lat.count());
    }
};
```

The trap: every client picks the same "fastest" backend, overwhelming it. Mitigations:
- Tiebreak randomly among the top K backends.
- Combine with power-of-two: pick two random, choose the lower EWMA.
- Add jitter to the EWMA to prevent stampede.

Twitter's Finagle library uses an EWMA-based variant called *p2c with peak EWMA*. Netflix's Ribbon library used a similar design.

### Adaptive Concurrency Limiting

Even smarter: don't decide which backend, decide *how many* concurrent requests to allow per backend. The Netflix `concurrency-limits` library (originally Java, ports exist for several languages including C++) implements TCP-Vegas-style adaptive limits.

The principle: each backend has a current concurrency limit. The LB measures latency at the current limit. If latency stays low, increase the limit. If latency spikes, decrease.

```cpp
class AdaptiveLimit {
public:
    bool TryAcquire() {
        auto cur = inflight_.fetch_add(1);
        if (cur >= limit_) { inflight_.fetch_sub(1); return false; }
        return true;
    }

    void OnComplete(std::chrono::microseconds rtt) {
        UpdateLimit(rtt);
        inflight_.fetch_sub(1);
    }

private:
    void UpdateLimit(std::chrono::microseconds rtt) {
        // Vegas-like: target a queueing delay of D.
        auto base = base_rtt_.count();
        auto excess = rtt.count() - base;
        if (excess < D_low_) limit_++;
        else if (excess > D_high_) limit_ = std::max(min_limit_, limit_ * 9 / 10);
    }

    std::atomic<int> inflight_{0};
    int limit_ = 10;
    int min_limit_ = 1;
    std::chrono::microseconds base_rtt_{1000};
    int64_t D_low_ = 500;
    int64_t D_high_ = 5000;
};
```

When the backend slows (GC, noisy neighbor, partial failure), the limit drops, the LB sends fewer requests there, and other backends pick up the load. When the backend recovers, the limit grows back. This is *adaptive* in the way that round-robin is not.

Production note: pair adaptive limiting with rejection at the backend (chapter 19) so that if the LB does send too many, the backend says no rather than dying.

### Maglev (Consistent Hash for L4 LB)

Google's Maglev paper (2016) describes a consistent-hash-based L4 load balancer that runs in user-space at line rate. Key properties:
1. Sticky sessions: same client goes to the same backend (subject to membership change).
2. Minimal disruption: adding/removing a backend remaps a small fraction of flows.
3. Even load: each backend gets roughly the same share.

Maglev's hash table is precomputed (chapter 13). Lookup is `O(1)`. Disruption on backend churn is `O(1/M)` where M is the table size.

When to use Maglev:
- L4 (per-flow) load balancing where session affinity matters.
- Any LB that fronts stateful backends (cache nodes that benefit from request locality).
- Public-facing edge LBs handling millions of QPS where the table-lookup speed matters.

When not to use Maglev:
- L7 with rich routing decisions (header-based, path-based). Use Envoy.
- Stateless backends with no affinity benefit. Power-of-two is simpler.

### Locality-Aware Load Balancing

In a multi-zone deployment, network latency between zones can be 10x intra-zone latency. A load balancer that ignores this sends 50 percent of traffic across zones unnecessarily.

The pattern (Envoy's `locality_weighted_lb_config`): partition backends by zone. Prefer same-zone backends until their use exceeds a threshold, then spill to other zones.

```cpp
class LocalityAware {
public:
    Backend* Next() {
        if (LocalUtilization() < 0.8) return PickLocal();
        return PickAnyZone();  // Spill to other zones.
    }
};
```

Cross-zone bandwidth is metered in cloud environments. Locality-aware balancing reduces cost as well as latency.

### Failure Detection in Load Balancers

Even the best strategy is wrong if it sends traffic to a dead backend. Production LBs combine:

- Active health checks: periodic probe per backend (configurable interval, timeout).
- Passive health detection: if a backend returns errors at high rate, mark it ejected.
- Outlier detection (Envoy): EWMA error rate, eject backends whose rate exceeds N standard deviations above the cluster mean.

The C++ pattern is straightforward: a per-backend `HealthState` updated by health-check responses and per-request error counters. The strategy queries the state before picking.

```cpp
class Backend {
public:
    bool IsHealthy() const { return state_.load() == State::Healthy; }
    void OnError() {
        if (++consecutive_errors_ > 5) state_ = State::Unhealthy;
    }
    void OnSuccess() { consecutive_errors_ = 0; state_ = State::Healthy; }

private:
    enum class State { Healthy, Unhealthy };
    std::atomic<State> state_{State::Healthy};
    std::atomic<int> consecutive_errors_{0};
};
```

### Choosing a Strategy

| Workload | Strategy |
|----------|----------|
| Heterogeneous backends, latency-sensitive | Power of two with EWMA |
| Backends that go through GC pauses | Adaptive concurrency limiting |
| Stateful backends with locality benefits | Maglev or rendezvous |
| Multi-zone with cross-zone cost | Locality-aware power of two |
| Public edge L4 at millions of QPS | Maglev |

The senior-engineer answer: power-of-two with adaptive concurrency is the default for most internal RPC traffic. Maglev for public L4 edges. Locality-aware for multi-zone cost optimization. Round-robin only as a baseline for comparison.

### Junior at FAANG: The Load Balancing Question

When asked "how would you balance load across 100 C++ backends?", do not say "round-robin." Say: "Power-of-two random choices with EWMA-adjusted weights, adaptive concurrency limit per backend, locality-aware preference, passive failure detection. Round-robin assumes uniform backends, production never has uniform backends. The Mitzenmacher result on power-of-two is the theoretical foundation, the Netflix concurrency-limits library is the practical implementation reference."

That answer demonstrates you understand load balancing as a control system, not a routing rule.

---
