## Rate Limiting and Backpressure

A service without rate limiting will, eventually, be served a request rate that exceeds its capacity. The choice between *rejecting*, *queueing*, and *hedging* under overload determines whether the service degrades gracefully or collapses. This section covers token bucket, leaky bucket, distributed limits, and the rejection-vs-queueing trade-off in C++.

### Token Bucket

A bucket holds up to B tokens. Tokens refill at rate R per second. Each request consumes one token, if the bucket is empty, the request is rejected (or queued, briefly).

```cpp
class TokenBucket {
public:
    TokenBucket(double rate_per_sec, double burst)
        : rate_(rate_per_sec), burst_(burst), tokens_(burst), last_refill_(Now()) {}

    bool TryAcquire() {
        std::lock_guard lock(mu_);
        Refill();
        if (tokens_ >= 1.0) { tokens_ -= 1.0; return true; }
        return false;
    }

private:
    void Refill() {
        auto now = Now();
        auto elapsed = std::chrono::duration<double>(now - last_refill_).count();
        tokens_ = std::min(burst_, tokens_ + elapsed * rate_);
        last_refill_ = now;
    }
    static auto Now() { return std::chrono::steady_clock::now(); }

    double rate_, burst_, tokens_;
    std::chrono::steady_clock::time_point last_refill_;
    std::mutex mu_;
};
```

Token bucket allows bursts up to B tokens, then enforces sustained rate R. Used by AWS API gateways, Envoy's local rate limiting, and Linux's `tc` traffic shaper.

### Leaky Bucket

A queue of size B drains at rate R. Each request enters the queue, if full, the request is rejected. The queue empties at constant rate, smoothing traffic.

The semantic difference from token bucket: token bucket allows a brief burst, leaky bucket does not. Leaky bucket's output is perfectly smooth, token bucket's output can match a burst.

```cpp
class LeakyBucket {
public:
    LeakyBucket(double rate_per_sec, size_t capacity)
        : rate_(rate_per_sec), capacity_(capacity), level_(0), last_(Now()) {}

    bool TryAcquire() {
        std::lock_guard lock(mu_);
        Drain();
        if (level_ + 1 > capacity_) return false;
        level_++;
        return true;
    }

private:
    void Drain() {
        auto now = Now();
        auto elapsed = std::chrono::duration<double>(now - last_).count();
        level_ = std::max(0.0, level_ - elapsed * rate_);
        last_ = now;
    }
    static auto Now() { return std::chrono::steady_clock::now(); }

    double rate_;
    size_t capacity_;
    double level_;
    std::chrono::steady_clock::time_point last_;
    std::mutex mu_;
};
```

### Distributed Rate Limiting

A token bucket per process is local. When you want a global rate limit (5 RPS per API key across 100 servers), you need shared state.

#### Centralized Counter

A Redis (or memcached) counter incremented atomically. Every request increments and checks the counter against the limit. The counter is reset every second.

```cpp
bool TryAcquire(std::string_view key, int limit) {
    auto window = SecondsSinceEpoch();
    auto redis_key = std::string(key) + ":" + std::to_string(window);
    auto count = redis_->Incr(redis_key);
    if (count == 1) redis_->Expire(redis_key, std::chrono::seconds(2));
    return count <= limit;
}
```

The simple version is fixed-window: a request at 0:00:00.999 and another at 0:00:01.001 are in different windows, allowing twice the rate at the boundary. Sliding-window counter algorithms (or interpolation between two adjacent windows) fix this.

#### Redis Cell

Redis CL.THROTTLE (the *Generic Cell Rate Algorithm* by Brandon Mintern) implements a sliding-window token bucket atomically inside Redis. One round trip per request, no race.

#### Count-Min Sketch

For workloads with millions of distinct rate-limit keys (per-IP, per-user-token), exact counters are too expensive. A count-min sketch is a probabilistic counter that uses constant memory. False positives (a counter inflated by hash collisions) bias toward over-limiting, false negatives are impossible. Acceptable for rate limiting where mistakes-on-the-side-of-rejection are tolerable.

```cpp
class CountMinSketch {
public:
    CountMinSketch(size_t depth, size_t width)
        : depth_(depth), width_(width), counts_(depth * width, 0) {}

    uint64_t Increment(std::string_view key) {
        uint64_t mn = std::numeric_limits<uint64_t>::max();
        for (size_t i = 0; i < depth_; ++i) {
            auto h = Hash(key, i) % width_;
            counts_[i * width_ + h]++;
            mn = std::min(mn, counts_[i * width_ + h]);
        }
        return mn;
    }

private:
    size_t depth_, width_;
    std::vector<uint64_t> counts_;
    static uint64_t Hash(std::string_view, size_t /*seed*/) { return 0; /* xxhash */ }
};
```

### Rejection vs Queueing

When traffic exceeds capacity, you have three options.

**Reject**. Return 503 immediately. Caller's responsibility to retry or fail. Bounded resource use.

**Queue**. Hold the request until capacity is available. Caller waits. Resource use grows with queue depth.

**Hedge**. Send the request to a second backend after a deadline elapses. Use the first response. Doubles average load but cuts tail latency.

The rule of thumb: **reject when the queue would not drain within the request's deadline**. Queueing for 50 ms when the client has a 100 ms deadline is fine. Queueing for 500 ms when the client has a 100 ms deadline wastes both client and server resources. Reject early.

A common production pattern is the *load shedder*: the server tracks its current concurrency and rejects new requests when concurrency exceeds a threshold. The threshold can be static (configured) or adaptive (learned from latency).

```cpp
class LoadShedder {
public:
    bool Admit(std::chrono::milliseconds deadline) {
        auto cur = inflight_.load();
        auto avg_lat = ewma_lat_.load();
        // Estimate completion time if admitted.
        auto est = avg_lat * cur / max_concurrency_;
        if (est > deadline.count()) return false;
        inflight_.fetch_add(1);
        return true;
    }

    void OnComplete(std::chrono::milliseconds lat) {
        inflight_.fetch_sub(1);
        UpdateEwma(lat);
    }

private:
    std::atomic<int> inflight_{0};
    std::atomic<double> ewma_lat_{1.0};
    int max_concurrency_ = 100;
    void UpdateEwma(std::chrono::milliseconds lat) { /* alpha=0.1 EWMA */ }
};
```

### Hedge Requests

Send the same request to two backends after a delay. Use the first response. Cuts tail latency (the slow backend's tail) at the cost of doubled total load (in the tail).

```cpp
template <typename F>
auto Hedge(F f, std::chrono::milliseconds hedge_after) -> decltype(f()) {
    using R = decltype(f());
    auto p = std::make_shared<std::promise<R>>();
    auto fut = p->get_future();

    std::thread([f, p] { try { p->set_value(f()); } catch (...) {} }).detach();
    std::this_thread::sleep_for(hedge_after);
    if (fut.wait_for(0s) == std::future_status::ready) return fut.get();

    auto p2 = std::make_shared<std::promise<R>>();
    std::thread([f, p2] { try { p2->set_value(f()); } catch (...) {} }).detach();

    // Race: take the first one.
    return RaceFirst(fut, p2->get_future());
}
```

The Tail at Scale paper (Dean & Barroso, 2013) recommends hedging for read-heavy workloads where the tail latency dominates. Cancellation is the production discipline: when one hedge wins, the other should be canceled to avoid wasted work. gRPC supports cancellation natively, if you build your own, propagate the cancellation through the request context.

When *not* to hedge: writes (would double-write), expensive computations (would double the cost), and any service running near capacity (the doubled load would tip it over).

### Adaptive Limits at the Backend

Section 18 covered adaptive concurrency at the LB. The same algorithm can run at the backend: track latency, tune the maximum concurrency, reject above the limit.

The LB-side and backend-side adaptive limits are complementary. The LB-side prevents one backend from being overloaded relative to others, the backend-side prevents the backend from accepting more load than it can handle in the configured time budget.

### Junior at FAANG: The Rate Limiting Question

When asked "how would you rate limit a public API?", do not say "use a token bucket." Say: "Token bucket at the edge for per-API-key limits, count-min sketch for high-cardinality keys, distributed rate limiting via Redis cell for global enforcement, plus a load shedder at each backend that rejects when latency would exceed the request deadline. Hedging on read-only paths to clip tail latency. Reject early when the queue would not drain within the deadline."

That answer demonstrates you understand rate limiting and overload protection as a coordinated system.

---
