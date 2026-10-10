## Circuit Breakers and Bulkheads

A failing dependency does two things to a healthy service. First, it serves slow or wrong responses. Second, it consumes the calling service's resources (threads, file descriptors, memory) waiting on those slow responses. The first is a failure. The second is a contagion. Without circuit breakers and bulkheads, a single dependency failure can take down the entire service, and from there propagate to the upstream services.

The circuit breaker stops the contagion. The bulkhead bounds the damage.

### The Circuit Breaker State Machine

The classical model has three states:

**Closed**: requests flow through to the dependency. Errors are counted.

**Open**: requests fail immediately, without touching the dependency. The dependency is considered down. After a cooldown, the breaker transitions to half-open.

**Half-open**: a small number of probe requests are allowed through. If they succeed, the breaker closes (back to normal). If they fail, the breaker re-opens.

```
       success rate ok
         <-----------
        /            \
   [Closed]          [Open] -- cooldown ---> [Half-open]
        \            /                          /
         ----------->                          /
         error rate above threshold           /
                                             /
                       <-- success ----------
                       <-- failure ---------- (back to Open)
```

### A C++ Implementation

The state needs to be visible from many threads. Mutating it needs to be cheap.

```cpp
#include <atomic>
#include <chrono>

class CircuitBreaker {
public:
    enum class State : uint8_t { kClosed, kOpen, kHalfOpen };

    struct Config {
        size_t failure_threshold = 20;       // failures before open
        size_t window_size = 100;            // sliding window count
        std::chrono::seconds cooldown{30};   // open -> half-open
        size_t half_open_probes = 5;         // allowed in half-open
    };

    explicit CircuitBreaker(Config c) : cfg_(c) {}

    bool TryAcquire() {
        State s = state_.load(std::memory_order_acquire);
        if (s == State::kClosed) {
            return true;
        }
        if (s == State::kOpen) {
            auto now = std::chrono::steady_clock::now();
            if (now < open_until_.load(std::memory_order_acquire)) {
                return false;
            }
            // Try transition to half-open
            State expected = State::kOpen;
            if (state_.compare_exchange_strong(expected, State::kHalfOpen)) {
                half_open_remaining_.store(cfg_.half_open_probes);
            }
            s = state_.load(std::memory_order_acquire);
        }
        if (s == State::kHalfOpen) {
            return half_open_remaining_.fetch_sub(1) > 0;
        }
        return false;
    }

    void RecordSuccess() {
        State s = state_.load();
        if (s == State::kHalfOpen) {
            // Success in half-open, close the breaker.
            state_.store(State::kClosed);
            failures_.store(0);
        }
    }

    void RecordFailure() {
        size_t f = failures_.fetch_add(1) + 1;
        State s = state_.load();
        if (s == State::kHalfOpen) {
            Open();
            return;
        }
        if (s == State::kClosed && f >= cfg_.failure_threshold) {
            Open();
        }
    }

private:
    void Open() {
        state_.store(State::kOpen);
        open_until_.store(std::chrono::steady_clock::now() + cfg_.cooldown);
    }

    const Config cfg_;
    std::atomic<State> state_{State::kClosed};
    std::atomic<size_t> failures_{0};
    std::atomic<size_t> half_open_remaining_{0};
    std::atomic<std::chrono::steady_clock::time_point> open_until_{};
};
```

Use:

```cpp
Status DatabaseClient::Query(const Q& q) {
    if (!breaker_.TryAcquire()) {
        return Status(StatusCode::kUnavailable, "circuit open");
    }
    auto status = real_query(q);
    if (status.ok()) {
        breaker_.RecordSuccess();
    } else if (IsRetryableError(status)) {
        breaker_.RecordFailure();
    }
    return status;
}
```

Note that not every error is a circuit-breaker signal. A 404 (not found) is a normal application response, not a dependency failure. Only count failures that indicate the dependency itself is unhealthy: 5xx, timeouts, connection refused.

### Sliding Window vs Rate-Based

The simple version above counts total failures. A better version uses a sliding window: failures in the last N seconds, or as a fraction of total requests in the window.

A rate-based breaker:

```cpp
// Roughly: open if error rate > 50% over last 1000 requests
if (window_.error_rate() > 0.5 && window_.total() > 100) {
    Open();
}
```

The minimum-volume guard (the `total() > 100` clause) prevents the breaker from opening on three consecutive failures during a low-traffic period.

### Token Bucket Throttling

A complementary pattern. Instead of binary open/closed, the breaker rate-limits requests to the dependency. When the dependency degrades, the rate ratchets down. When it recovers, the rate ratchets up.

```cpp
class TokenBucket {
    std::atomic<double> tokens_;
    double max_;
    double refill_per_sec_;
    std::atomic<std::chrono::steady_clock::time_point> last_refill_;
public:
    bool TryConsume(double cost = 1.0) {
        Refill();
        double current = tokens_.load();
        while (current >= cost) {
            if (tokens_.compare_exchange_weak(current, current - cost)) {
                return true;
            }
        }
        return false;
    }
};
```

A fallback pattern: combine a token bucket with a circuit breaker. The token bucket protects the dependency from too much load. The breaker protects the caller from waiting on a dead dependency.

### Bulkheads: Thread Pool Isolation

The bulkhead pattern: each dependency (or each tenant, or each priority class) gets its own resource pool. A failure in one dependency cannot exhaust the resources used to serve others.

A simple thread-pool bulkhead in C++:

```cpp
class Bulkhead {
public:
    Bulkhead(size_t max_concurrent) : sem_(max_concurrent) {}

    template <typename F>
    auto Submit(F&& fn) -> std::optional<decltype(fn())> {
        if (!sem_.try_acquire()) {
            return std::nullopt;  // bulkhead full, shed
        }
        auto guard = std::shared_ptr<void>(nullptr,
            [this](void*) { sem_.release(); });
        return fn();
    }

private:
    std::counting_semaphore<1024> sem_;
};
```

Each dependency gets its own bulkhead with a configured max concurrency. A misbehaving dependency consumes only its own bulkhead's slots, never starving the rest of the service.

The cap is a tradeoff. Too small, and you reject load even when the dependency is healthy. Too large, and a slow dependency consumes too many threads. Tune from baseline: P95 latency * RPS = required concurrency, plus 50% headroom.

### Per-Tenant Bulkheads

A multi-tenant service has additional risk: one noisy tenant exhausts shared resources, degrading service for everyone else. Per-tenant bulkheads bound the damage.

```cpp
class PerTenantBulkhead {
    absl::flat_hash_map<TenantId, std::unique_ptr<Bulkhead>> bulkheads_;
    absl::Mutex mu_;

public:
    Bulkhead* For(TenantId t) {
        absl::MutexLock lock(&mu_);
        auto& bh = bulkheads_[t];
        if (!bh) {
            bh = std::make_unique<Bulkhead>(GetTenantQuota(t));
        }
        return bh.get();
    }
};
```

The quota per tenant comes from configuration (a small tenant gets 10 concurrent slots, a large tenant gets 1000). The total of all quotas can exceed the absolute capacity (overcommit), because not all tenants will saturate at the same time.

### Hystrix-Style Patterns in C++

Netflix's Hystrix popularized the bundled pattern: each call is wrapped in a `HystrixCommand` that combines a circuit breaker, a timeout, a thread-pool bulkhead, and a fallback. The library is JVM-only, but the pattern translates.

A C++ equivalent:

```cpp
template <typename Result>
class GuardedCall {
public:
    GuardedCall(CircuitBreaker* cb, Bulkhead* bh,
                std::chrono::milliseconds timeout,
                std::function<Result()> fallback)
        : cb_(cb), bh_(bh), timeout_(timeout),
          fallback_(std::move(fallback)) {}

    template <typename F>
    Result Execute(F&& fn) {
        if (!cb_->TryAcquire()) return fallback_();

        auto bh_result = bh_->Submit([fn = std::forward<F>(fn), this]() {
            return RunWithTimeout(fn, timeout_);
        });

        if (!bh_result) {
            cb_->RecordFailure();
            return fallback_();
        }

        if (bh_result->ok()) {
            cb_->RecordSuccess();
            return *bh_result;
        }

        cb_->RecordFailure();
        return fallback_();
    }
};
```

The fallback is the most important part. It is what the caller sees when the dependency is down: cached data, default values, partial results. We will explore fallbacks in chapter 13.

### Common Failure Modes

- **Breaker stuck open.** The half-open probe path has a bug, no probe ever succeeds, the breaker never closes. Test the half-open path as carefully as the closed path.
- **Breaker too sensitive.** Three transient failures during a network blip open the breaker for 30 seconds, dropping legitimate traffic. Calibrate thresholds against baseline error rate.
- **Breaker opens during slow-start.** A cold dependency rejects the first burst of probes, and the breaker opens. Pair with exponential ramp-up on cold start.
- **Bulkhead too small.** Healthy traffic gets shed because the cap was set assuming worst-case latency. Measure latency, set the cap with headroom.

### Real Postmortem Flavor

A C++ ad-serving service had no circuit breaker on its bidder backends. One bidder went down. The connection pool to that bidder filled up with stuck connections. Worker threads serving requests for other bidders were blocked waiting for connections from the same shared pool. Within 90 seconds, the entire ad-serving fleet was effectively dead. Total revenue impact: seven figures.

Post-fix: per-bidder connection pools (bulkhead), per-bidder circuit breakers, fallback to "no ad" when a bidder is open. Subsequent bidder outages produced zero global impact.

### Senior at FAANG: The Defensive Posture

The senior frame: every external dependency is wrapped in a circuit breaker plus a bulkhead plus a timeout plus a fallback, by default. New dependencies inherit the pattern automatically. The decision to skip the pattern is explicit and rare. The result is a service that survives partner failures gracefully, which is what an SRE means by "resilient."

---
