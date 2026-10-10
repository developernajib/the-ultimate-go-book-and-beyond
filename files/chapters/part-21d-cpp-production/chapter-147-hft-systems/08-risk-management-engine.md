## Risk Management Engine

On August 1, 2012, Knight Capital Group deployed a buggy algorithm to production. It ran unchecked for 45 minutes and lost \$440 million, approximately four times Knight's annual profit. The bug bypassed pre-trade risk checks, allowing the algorithm to send tens of thousands of orders per minute into the market at the wrong prices and in the wrong direction. Knight filed for bankruptcy protection shortly after.

Pre-trade risk is the last line of defense between your algorithm and catastrophic loss. It must be correct, and it must be fast enough that it does not add meaningful latency to the critical path. The target: every risk check completes in under 500 nanoseconds.

### Risk Check Categories

A production pre-trade risk engine must enforce:

| Check               | Description                                                    | Typical Limit  |
| ------------------- | -------------------------------------------------------------- | -------------- |
| Position limit      | `abs(net_position + order_qty) <= max_position`                | Per instrument |
| Order rate limit    | No more than N orders per second                               | 100-500/sec    |
| Notional limit      | `order_qty * price <= max_notional_per_order`                  | \$1M - \$10M   |
| Fat finger          | `order_qty <= max_order_size`                                  | Firm-defined   |
| Price band          | `abs(price - last_trade_price) / last_trade_price <= band_pct` | 2-10%          |
| Net delta limit     | Total portfolio delta within bounds                            | Firm-defined   |
| P&L circuit breaker | Halt if realized + unrealized P&L < threshold                  | Firm-defined   |

### Design Constraints

The risk engine runs inline on the order submission path, every order passes through it before being sent to the exchange. The constraints are severe:

- **No locks**: a mutex can add 50-200 ns and introduces potential for priority inversion.
- **No heap allocation**: `new`/`malloc` on the hot path is banned.
- **No branchy code**: branch mispredictions are 15-20 cycles each.
- **All checks in one function**: minimize instruction count, keep everything in L1 cache.
- **Atomic counters**: position and order counts must be readable from a monitoring thread without locks.

### Full Risk Engine Implementation

The risk engine uses `std::atomic<int64_t>` for all counters so the order validation path is lock-free and can be called from multiple threads without a mutex. All position and exposure limits are checked with `compare_exchange` or atomic fetch-add operations that fail safely under concurrent order flow, ensuring the engine never approves an order that would breach a limit even when two orders for the same instrument arrive simultaneously.

```cpp
#include <atomic>
#include <cstdint>
#include <cmath>

enum class Side : uint8_t { Buy = 0, Sell = 1 };

enum class RiskResult : uint8_t {
    Approved      = 0,
    PositionLimit = 1,
    RateLimit     = 2,
    Notional      = 3,
    FatFinger     = 4,
    PriceBand     = 5,
    CircuitBreaker = 6
};

struct RiskLimits {
    int64_t  max_position;         // Max abs(net position) in shares
    int64_t  max_order_size;       // Max shares per order
    int64_t  max_notional;         // Max USD notional per order (in cents)
    uint32_t max_orders_per_sec;   // Token bucket capacity
    double   price_band_pct;       // Max deviation from last trade price (0.05 = 5%)
    int64_t  min_pnl;              // Circuit breaker: halt if P&L < this (in cents)
};

class alignas(64) RiskEngine {
    // Position and P&L -- written by fill callbacks, read by risk checks
    std::atomic<int64_t>  net_position_{0};    // Positive = long, negative = short
    std::atomic<int64_t>  realized_pnl_{0};    // Cents
    std::atomic<int64_t>  unrealized_pnl_{0};  // Cents

    // Token bucket for order rate limiting
    // Uses TSC for high-resolution timing without a syscall
    std::atomic<uint64_t> token_bucket_{0};    // Current tokens (scaled by 1000)
    uint64_t              last_refill_tsc_{0}; // TSC at last refill
    uint64_t              ticks_per_token_{0}; // TSC ticks per token (calibrated)

    // Last trade price for price band check
    std::atomic<int64_t>  last_trade_price_{0}; // Cents

    const RiskLimits limits_;
    const bool       circuit_breaker_active_{false};
    std::atomic<bool> halted_{false};

public:
    explicit RiskEngine(const RiskLimits& limits)
        : limits_(limits)
    {
        // Calibrate token bucket: max_orders_per_sec tokens per second
        double tsc_freq_hz = tsc_per_ns() * 1e9;
        ticks_per_token_   = static_cast<uint64_t>(tsc_freq_hz / limits.max_orders_per_sec);
        last_refill_tsc_   = rdtsc_serialized();
        token_bucket_.store(limits.max_orders_per_sec * 1000ULL, std::memory_order_relaxed);
    }

    // Called on the hot path before every order is sent to the exchange.
    // Returns RiskResult::Approved or the specific violation.
    // Must complete in < 500 ns. Inline to eliminate call overhead.
    [[nodiscard]] __attribute__((always_inline))
    RiskResult check_order(Side side, int64_t qty, int64_t price_cents) {
        // Circuit breaker: immediate rejection if halted
        if (unlikely(halted_.load(std::memory_order_acquire))) {
            return RiskResult::CircuitBreaker;
        }

        // --- Fat finger check (fastest: compare two integers) ---
        if (unlikely(qty > limits_.max_order_size)) {
            return RiskResult::FatFinger;
        }

        // --- Notional check ---
        int64_t notional = qty * price_cents;
        if (unlikely(notional > limits_.max_notional)) {
            return RiskResult::Notional;
        }

        // --- Position limit check ---
        int64_t current_pos = net_position_.load(std::memory_order_acquire);
        int64_t new_pos = (side == Side::Buy) ? current_pos + qty : current_pos - qty;
        if (unlikely(std::abs(new_pos) > limits_.max_position)) {
            return RiskResult::PositionLimit;
        }

        // --- Price band check ---
        int64_t last_px = last_trade_price_.load(std::memory_order_acquire);
        if (likely(last_px > 0)) {
            double deviation = std::abs(static_cast<double>(price_cents - last_px))
                             / static_cast<double>(last_px);
            if (unlikely(deviation > limits_.price_band_pct)) {
                return RiskResult::PriceBand;
            }
        }

        // --- Rate limit: token bucket ---
        if (unlikely(!consume_token())) {
            return RiskResult::RateLimit;
        }

        // --- P&L circuit breaker ---
        int64_t total_pnl = realized_pnl_.load(std::memory_order_acquire)
                          + unrealized_pnl_.load(std::memory_order_acquire);
        if (unlikely(total_pnl < limits_.min_pnl)) {
            halted_.store(true, std::memory_order_release);
            return RiskResult::CircuitBreaker;
        }

        return RiskResult::Approved;
    }

    // Called by the fill handler when an execution report arrives.
    // Updates position and P&L. Thread-safe (fill handler may be on a
    // different core from the order sender).
    void on_fill(Side side, int64_t qty, int64_t fill_price_cents) {
        if (side == Side::Buy) {
            net_position_.fetch_add(qty, std::memory_order_release);
        } else {
            net_position_.fetch_sub(qty, std::memory_order_release);
        }
        last_trade_price_.store(fill_price_cents, std::memory_order_release);
    }

    void update_unrealized_pnl(int64_t pnl_cents) {
        unrealized_pnl_.store(pnl_cents, std::memory_order_release);
    }

    // Kill switch: immediately halt all order sending.
    // Can be called from any thread (monitoring, ops, external signal).
    void kill() {
        halted_.store(true, std::memory_order_seq_cst);
    }

    bool is_halted() const {
        return halted_.load(std::memory_order_acquire);
    }

    int64_t net_position() const {
        return net_position_.load(std::memory_order_acquire);
    }

private:
    // Token bucket rate limiter using TSC.
    // Refills tokens based on elapsed TSC ticks since last refill.
    // Returns true if a token was consumed (order allowed).
    __attribute__((always_inline))
    bool consume_token() {
        uint64_t now_tsc     = rdtsc_relaxed();
        uint64_t elapsed     = now_tsc - last_refill_tsc_;
        uint64_t new_tokens  = (elapsed / ticks_per_token_) * 1000ULL;

        if (new_tokens > 0) {
            last_refill_tsc_ += (new_tokens / 1000) * ticks_per_token_;
            uint64_t current = token_bucket_.load(std::memory_order_relaxed);
            uint64_t cap     = static_cast<uint64_t>(limits_.max_orders_per_sec) * 1000ULL;
            uint64_t refilled = std::min(current + new_tokens, cap);
            token_bucket_.store(refilled, std::memory_order_relaxed);
        }

        uint64_t tokens = token_bucket_.load(std::memory_order_relaxed);
        if (tokens < 1000ULL) return false;  // 1000 = one token in scaled units

        token_bucket_.fetch_sub(1000ULL, std::memory_order_relaxed);
        return true;
    }
};
```

### Hardware Kill Switch

A software kill switch can be bypassed by a bug in the very code that should be checking it. Production HFT systems supplement software kill switches with hardware solutions:

- **FIX cancel-on-disconnect**: the exchange automatically cancels all open orders if the TCP session drops. Always enable this.
- **NIC-level kill**: some NICs (Solarflare, Mellanox) support hardware-level order cancellation triggered by a register write, bypassing the CPU entirely.
- **Out-of-band kill box**: a dedicated hardware device on the order submission path that can be remotely triggered to drop all packets.
- **Exchange kill switch API**: most exchanges provide an API to cancel all open orders for a session with a single message.

```cpp
// FIX cancel-on-disconnect: set in FIX logon message
// Most FIX engines expose this as a session-level setting.
// This is your last line of defense -- the exchange handles it.
void configure_cancel_on_disconnect(FIXSession& session) {
    session.set_cancel_orders_on_disconnect(true);
    session.set_max_order_rate(limits_.max_orders_per_sec);
}
```

### Monitoring Risk in Real Time

The risk engine's atomic counters are designed to be readable from a monitoring thread without locking or disrupting the trading path:

```cpp
class RiskMonitor {
    const RiskEngine& engine_;
    const RiskLimits& limits_;

public:
    void print_status() const {
        int64_t pos    = engine_.net_position();
        double  pct    = 100.0 * std::abs(pos) / limits_.max_position;
        bool    halted = engine_.is_halted();

        printf("[RISK] Position: %ld (%.1f%% of limit)  Halted: %s\n",
               pos, pct, halted ? "YES" : "no");
    }
};
```

### Go Comparison

Pre-trade risk engines in Go are common at non-HFT trading firms (market makers with 1-10 ms latency targets, hedge funds, banks). Go's atomic operations, `sync/atomic` package, and garbage collector (paused for < 1 ms in modern versions) are acceptable at millisecond latency targets. The risk engine logic, position limits, notional checks, rate limiting, translates directly. The gap opens at the nanosecond level: Go's garbage collector, even at its best, introduces occasional 100-500 μs pauses. For a risk engine that must complete in < 500 ns, those pauses are unacceptable. For a risk engine that must complete in < 1 ms, Go is a reasonable choice and results in simpler, more maintainable code.

---
