## Exercises

These exercises require real implementation. Do not use `std::chrono` for any latency measurement exercise, use `rdtsc`. Do not use `std::mutex` in any data structure exercise, use atomics.

---

### Exercise 1: `rdtsc`-Based Latency Histogram

Implement a latency measurement harness that measures the round-trip time of a function call using `rdtsc` and records results in a histogram. The histogram must correctly handle coordinated omission.

Requirements:

1. Write a `rdtsc_relaxed()` function using inline assembly.
2. Write a `tsc_to_ns(uint64_t delta) -> double` function using calibration from `clock_gettime`.
3. Implement a `LatencyHistogram` that stores counts in power-of-2 buckets covering 1 ns to 1 ms. Support at least p50, p99, p999, p9999 percentile queries.
4. Write a measurement loop that issues calls to a mock function at a fixed rate of 1 million calls per second. Use scheduled arrival times, not actual completion times, to correctly handle coordinated omission.
5. Inject a deliberate 100 μs delay every 10,000 calls. Verify that your p9999 reflects this delay, not the nominal p99.

```cpp
// Starter skeleton
void inject_occasional_delay(int iteration) {
    if (iteration % 10000 == 0) {
        // Busy-spin for ~100 μs
        uint64_t end = rdtsc_relaxed() + static_cast<uint64_t>(100'000 * tsc_per_ns());
        while (rdtsc_relaxed() < end) { __builtin_ia32_pause(); }
    }
}

void run_measurement_harness() {
    LatencyHistogram hist;
    double target_rate_hz = 1'000'000.0;
    uint64_t interval_tsc = static_cast<uint64_t>(tsc_per_ns() * 1e9 / target_rate_hz);
    uint64_t next_arrival = rdtsc_relaxed();

    for (int i = 0; i < 10'000'000; ++i) {
        while (rdtsc_relaxed() < next_arrival) { __builtin_ia32_pause(); }

        uint64_t t0 = rdtsc_relaxed();
        inject_occasional_delay(i);
        uint64_t t1 = rdtsc_relaxed();

        hist.record(static_cast<uint64_t>(tsc_to_ns(t1 - next_arrival)));
        next_arrival += interval_tsc;
    }

    hist.print_report();
    // Expected: p99 ~ 1 μs, p9999 ~ 100 μs
}
```

---

### Exercise 2: SPSC Ring Buffer for Feed Handler to Strategy

Implement a single-producer single-consumer (SPSC) lock-free ring buffer suitable for passing market data events from the feed handler core to the strategy core.

Requirements:

1. Template on element type `T` and size `N` (must be power of 2).
2. `push(const T&) -> bool`: non-blocking. Returns `false` if full. Called from producer thread only.
3. `pop(T&) -> bool`: non-blocking. Returns `false` if empty. Called from consumer thread only.
4. Use `std::atomic<size_t>` for head and tail. Use correct memory ordering (`release` for stores, `acquire` for loads).
5. Pad head and tail to separate cache lines to eliminate false sharing.
6. Write a benchmark: producer fills the ring at maximum speed, consumer drains it. Measure throughput in millions of messages per second and verify correct ordering of all elements.
7. Compare with a mutex-based equivalent. Quantify the latency difference at p50 and p99.

The correct memory ordering is not `seq_cst`. Explain in a comment why `acquire`/`release` is sufficient for the SPSC case.

---

### Exercise 3: ITCH Message Parser for Add Order and Delete Order

Implement a binary parser for NASDAQ ITCH 5.0 Add Order (`'A'`) and Delete Order (`'D'`) messages, including correct big-endian byte swapping.

Requirements:

1. Define `ITCHAddOrder` and `ITCHDeleteOrder` structs with `#pragma pack(push, 1)`.
2. Implement `be16`, `be32`, `be64`, and `be48` byte-swap helpers using `__builtin_bswap16/32/64` and bit shifting. Do not use `htons`/`ntohl`.
3. Implement `parse_add_order(const uint8_t* buf, uint16_t len, ParsedAddOrder& out) -> bool`.
4. Implement `parse_delete_order(const uint8_t* buf, uint16_t len, uint64_t& order_ref) -> bool`.
5. Write unit tests with the following hardcoded ITCH 5.0 byte sequences (from the NASDAQ ITCH 5.0 specification):
   - An Add Order message with `order_ref=12345`, `side='B'`, `shares=100`, `price=150.0000` (encoded as `1500000`).
   - A Delete Order message for `order_ref=12345`.
6. Benchmark: parse 10 million Add Order messages. Target: < 20 ns per message.

Verify that a naive implementation using `memcpy` + byte-swap outperforms `reinterpret_cast` with misaligned access on x86.

---

### Exercise 4: Token Bucket Rate Limiter Using Atomics

Implement a thread-safe token bucket rate limiter that does not use mutexes, does not allocate memory, and uses `rdtsc` for time measurement instead of `clock_gettime`.

Requirements:

1. Constructor takes `uint64_t max_rate_per_sec` and `uint64_t burst_capacity`.
2. `try_consume() -> bool`: atomically consume one token. Returns `false` if the bucket is empty. Must be safe to call from multiple threads concurrently (use `compare_exchange_weak` for CAS-based update or `fetch_sub` with overflow check).
3. Refill tokens based on elapsed TSC ticks since last refill. The refill itself must be atomic (use a CAS loop on a packed `{tokens, last_refill_tsc}` struct stored in a `std::atomic<uint64_t>`).
4. Measure the overhead of `try_consume()` with `rdtsc`. Target: < 50 ns per call on an uncontended hot path.
5. Stress test: 8 threads each calling `try_consume()` at 10x the configured rate. Verify that the total approved call rate does not exceed the configured limit by more than 1%.

Note: for the single-threaded HFT use case (risk engine), explain why a non-atomic implementation is valid and faster.

---

### Exercise 5: Fill Simulation and Risk Engine Position Tracking

Implement a complete fill simulation: generate a sequence of orders, run them through the risk engine, simulate fills, and verify that the risk engine's position tracking remains consistent.

Requirements:

1. Implement `RiskEngine` with at minimum: position limit check, fat finger check, and `on_fill()` callback.
2. Simulate 1 million order/fill cycles:
   - Each order has a random side (50/50 buy/sell), random quantity (1-1000 shares), and random price.
   - All orders are approved by the risk engine (configure limits generously).
   - Each approved order is immediately filled (call `on_fill`).
3. After all cycles, verify that `net_position()` equals the algebraic sum of all fills: `sum(buy_qty) - sum(sell_qty)`.
4. Add a position limit of 50,000 shares. Verify that no single order is approved that would push the position past this limit.
5. Measure the latency of `check_order()` for approved orders and rejected orders separately. Verify that both complete in < 500 ns at p99.
6. Simulate a P&L circuit breaker: after 500,000 cycles, inject a large loss (set `unrealized_pnl` to a large negative value). Verify that all subsequent calls to `check_order()` return `RiskResult::CircuitBreaker`.

---
