## Connection Pooling and Backpressure

Every outbound RPC client that lives longer than a benchmark must answer four questions: how many connections, when do they idle out, when do they die, and what happens when callers want more than the pool can give. Get these wrong and you ship either p99 latency disasters (too few connections, queueing) or memory/conntrack disasters (too many connections, fd exhaustion). This chapter is the math and the C++ shape.

### 1. Pool sizing -- Little's law

Little's law: `L = lambda * W` where `L` is the average number of in-flight requests, `lambda` is the arrival rate, and `W` is the average service time. Your pool must satisfy `pool_size >= L` to avoid queueing.

Worked example: a payments service issues 5000 RPCs/s to a backend with p50 latency 4 ms and p99 latency 40 ms. At p50, `L = 5000 * 0.004 = 20`. At p99, `L = 5000 * 0.040 = 200`. Pool sized to 20 would be saturated 1% of the time, and during those moments p99 doubles or triples (queueing on top of latency). Pool sized to 200 covers the worst case but holds 200 idle connections in steady state.

Practical rule of thumb: provision for max(p99 * lambda * 1.5, p50 * lambda * 3). Set hard upper bound by ephemeral port range, conntrack table size, and the backend's accept queue.

### 2. The interface

```cpp
template <class Conn>
class Pool {
 public:
  // RAII handle: returns the connection on destruction.
  class Handle {
    Pool* p_ = nullptr;
    Conn* c_ = nullptr;
    bool poison_ = false;
   public:
    Handle(Pool* p, Conn* c) : p_(p), c_(c) {}
    Handle(Handle&& o) noexcept : p_(o.p_), c_(o.c_), poison_(o.poison_) {
      o.p_ = nullptr; o.c_ = nullptr;
    }
    ~Handle() { if (p_) p_->release(c_, poison_); }
    Conn* operator->() { return c_; }
    void poison() { poison_ = true; }    // do not return to pool
  };

  // Borrow with deadline - throws on timeout.
  Handle borrow(std::chrono::steady_clock::time_point deadline);

  // Stats for backpressure
  size_t in_use()  const;
  size_t idle()    const;
  size_t waiters() const;
};
```

Handle-based release via destructor is the only safe pattern: exception thrown mid-RPC must still return the connection. A naive `acquire`/`release` pair always leaks under exceptions.

### 3. Lifecycle policies

| Policy | Purpose | Typical default |
|-------------------|------------------------------------------------------|----------------------|
| `min_idle` | warm pool size | 0 or small |
| `max_size` | hard cap | sized via Little's law |
| `max_waiters` | how many can queue when pool is full | bounded, see s.6 |
| `idle_timeout` | close after N seconds idle | 60 s |
| `max_lifetime` | force-rotate connection at N minutes | 30 min |
| `health_check_idle` | ping if idle longer than X | 30 s |
| `borrow_timeout` | max wait when pool is exhausted | 250 ms |

`max_lifetime` matters because:

- TLS sessions accumulate kernel state, rotating breaks long-running cipher state and refreshes ECDHE.
- Server-side load balancers (Envoy with `max_connection_duration`) close connections, if your client is unaware, you take the close as an error.
- It naturally re-shards traffic when backend scale changes.

Without `max_lifetime` you pin connections to the backends that existed at startup, new backends added by autoscaling never receive traffic.

### 4. Implementation skeleton

```cpp
class TcpPool {
 public:
  struct Config {
    std::string host; uint16_t port;
    size_t max_size = 64;
    size_t min_idle = 4;
    std::chrono::milliseconds borrow_timeout{250};
    std::chrono::seconds idle_timeout{60};
    std::chrono::seconds max_lifetime{1800};
    std::chrono::seconds health_check_idle{30};
    size_t max_waiters = 256;
  };

  Handle borrow(std::chrono::steady_clock::time_point deadline) {
    std::unique_lock l(m_);
    while (true) {
      // Hand out an idle connection if any, after health filter.
      while (!idle_.empty()) {
        auto* c = idle_.back(); idle_.pop_back();
        if (is_healthy(c)) { ++in_use_; return {this, c}; }
        delete c;
      }
      // Open a new one if under cap.
      if (in_use_ + opening_ < cfg_.max_size) {
        ++opening_;
        l.unlock();
        Conn* c = nullptr;
        try { c = open_blocking_with_deadline(deadline); }
        catch (...) {
          l.lock(); --opening_; cv_.notify_one();
          throw;
        }
        l.lock(); --opening_; ++in_use_;
        return {this, c};
      }
      // Wait for a release.
      if (waiters_ >= cfg_.max_waiters)
        throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again),
                                "pool: too many waiters");
      ++waiters_;
      auto status = cv_.wait_until(l, deadline);
      --waiters_;
      if (status == std::cv_status::timeout)
        throw std::system_error(std::make_error_code(std::errc::timed_out), "pool: borrow timeout");
    }
  }

  void release(Conn* c, bool poisoned) {
    std::unique_lock l(m_);
    --in_use_;
    if (poisoned || past_max_lifetime(c) || too_many_idle()) {
      l.unlock();
      delete c;        // closes the fd
    } else {
      c->touch_idle();
      idle_.push_back(c);
    }
    cv_.notify_one();
  }
 private:
  Config cfg_;
  std::mutex m_;
  std::condition_variable cv_;
  std::vector<Conn*> idle_;
  size_t in_use_ = 0, opening_ = 0, waiters_ = 0;
};
```

Notes:

- The connect happens **with the lock dropped**. Holding it across a 50 ms TCP handshake serializes all borrowers behind one connect.
- `cv_.notify_one` on release is enough, broadcast wakes up unnecessary waiters (thundering herd inside the pool).
- Health check on borrow: cheap to test (`recv` with `MSG_PEEK | MSG_DONTWAIT`, expect `EAGAIN`), cheaper than handing out a half-closed connection.
- Idle reaper runs on a separate thread, walks `idle_` with the lock held, closes anything past `idle_timeout` or `max_lifetime`.

### 5. Health checks and connection draining

On long-lived pools, the backend may close a connection silently (TCP RST after firewall idle, Envoy `idle_timeout`, server restart). Detection options:

1. `MSG_PEEK | MSG_DONTWAIT` on borrow: if `recv` returns 0 (FIN), peer closed. Returns -1/EAGAIN if alive.
2. `getsockopt(SOL_SOCKET, SO_ERROR)`: cheap async check.
3. Application-level ping (gRPC keepalive, HTTP/2 PING frame): catches the case where the network stack thinks the connection is alive but the application is hung.

For HTTP/2 / gRPC, prefer ping. For raw TCP, `MSG_PEEK` is fine and almost free.

### 6. Backpressure and admission control

When the pool is exhausted, three options:

1. **Block until available** (with deadline). Fine for moderate bursts, awful if the deadline is large.
2. **Reject immediately with `Resource Exhausted` / 429**. Pushes backpressure upstream where the caller can shed load.
3. **Bounded queue with FIFO ordering.** Compromise between (1) and (2).

Production shops use (3) with very small queues (`max_waiters` = pool size / 4 or smaller) and a tight `borrow_timeout`. If the queue fills *and* the timeout expires, return an error and let the caller retry on a different pool / region.

The mistake to avoid: unbounded queue with no timeout. You buffer requests indefinitely, callers never get a clear "fail fast" signal, and your service's effective latency becomes unbounded under load. This pattern, "the queue of doom," is responsible for more datacenter incidents than any other single anti-pattern.

### 7. Tail-latency mitigation: hedged requests

For a service whose p50 is 2 ms and p99 is 50 ms, the hedging pattern (Jeff Dean, "The Tail at Scale", 2013) trades a small QPS overhead for a large p99 reduction:

1. Send the request on connection A.
2. After delay D (typically p95 of the operation, e.g., 10 ms), send a duplicate on connection B.
3. Return the first response to come back, cancel the loser (RST or `RST_STREAM` on HTTP/2).

```cpp
template <class F>
auto hedge(Pool& pool, F&& op, std::chrono::milliseconds delay) {
  using R = decltype(op(std::declval<Conn&>()));
  std::promise<R> p;
  auto fut = p.get_future();
  auto state = std::make_shared<std::atomic<bool>>(false);

  auto fire = [&pool, op, &p, state]() {
    auto h = pool.borrow(deadline);
    try {
      auto r = op(*h);
      if (!state->exchange(true)) p.set_value(std::move(r));
      else h.poison();   // we lost the race; drop conn so RST_STREAM is sent
    } catch (...) {
      // ignore unless the other one also failed
    }
  };

  std::thread t1(fire);
  if (fut.wait_for(delay) == std::future_status::timeout)
    std::thread(fire).detach();
  t1.join();
  return fut.get();
}
```

Real implementations integrate hedging into the RPC framework (gRPC's `hedgingPolicy`, Finagle's request hedging) so cancellation is first-class. Two operational guards:

- Cap hedge rate: if your hedge fires on every request, you have doubled your QPS. Limit to 5-10% with `hedgePolicy.maxAttempts` and `hedgingDelay`.
- Hedging is only safe for idempotent operations.

### 8. Observability

Every pool must expose:

- `pool_in_use`, `pool_idle`, `pool_waiters` (gauges)
- `pool_borrow_duration_seconds` (histogram)
- `pool_borrow_timeouts_total` (counter)
- `pool_connect_duration_seconds` (histogram)
- `pool_connect_failures_total` (counter, by errno)
- `pool_lifetime_rotations_total`, `pool_idle_evictions_total` (counters)
- `pool_health_check_failures_total` (counter)

If `pool_borrow_timeouts_total` is non-zero in steady state, your pool is undersized or your backend is misbehaving. If `pool_connect_failures_total` spikes, the backend is rejecting, if the backend's accept queue is full, watch for `LISTEN_OVERFLOWS` on its end.

### 9. Multi-host pools and load balancing

A single pool to one host is rare in production, usually you have N backends. Two layouts:

- **Per-host sub-pools**: one `TcpPool` per backend, plus a load-balancing layer that picks a sub-pool per request. Choices: round-robin, EWMA-of-latency (P2C), least-outstanding.
- **Single pool with mixed connections**: hash the connection's destination address, rotates across backends through `max_lifetime`. Simpler but harder to bias by latency.

Per-host sub-pools is the standard. Envoy, Finagle, and gRPC all use it. Pair with a circuit breaker per sub-pool: when failure rate crosses a threshold, the LB removes the pool from rotation for a cooldown period. See Proxies and Load Balancers in C++ for the LB algorithms.

### 10. Common bugs

- Returning a connection to the pool after a request error. The connection state may be undefined (half-read response, broken framing). Mark it poisoned on any I/O error.
- Releasing on a different thread than borrow. Most pool implementations are thread-safe, but if your `Conn` holds thread-local state (TLS context buffers, scratch space), be careful.
- Sharing one `Conn` between two simultaneous requests. HTTP/1.1 forbids it. HTTP/2 allows multiplexing. The pool's `Conn` type must encode this, do not let the type system silently accept HTTP/1.1 multiplex.
- Holding the borrow across an unbounded operation (waiting for a user input, a slow downstream call). The handle should live exactly as long as the network operation.
- Initializing `min_idle` connections on the request path on first call. Cold-start latency. Warm the pool at startup.

> Senior @ FAANG: read Finagle's connection pool source and Envoy's `ConnectionPool::Instance`. Both encode every lesson above. Your goal is not to invent a pool but to make sure the pool you use exposes the metrics, the lifecycle, and the cancel semantics. If it does not, replace it.

