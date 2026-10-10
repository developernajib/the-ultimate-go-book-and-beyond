## Lock-Free Order Book

The order book is the central data structure of any trading system. It maintains the full state of bids and asks for a given instrument: every price level, every resting order, and their quantities. The feed handler writes to it thousands of times per second. The strategy reads the top of book on every tick. Getting the order book wrong, in correctness or performance, is catastrophic.

### What an Order Book Contains

An order book is two sorted collections:

- **Bids**: buy orders, sorted descending by price. The best bid is the highest buy price.
- **Asks**: sell orders, sorted ascending by price. The best ask is the lowest sell price.

Each price level has an associated total quantity (the sum of all resting orders at that price). For market microstructure purposes you also need the individual orders at each level (for cancel/modify), but for top-of-book trading signals you only need the aggregated quantities.

### Why `std::map` Is Too Slow

The obvious implementation uses `std::map<Price, Level>`:

```cpp
// NAIVE: O(log N) per update, dynamic allocation, cache-hostile
std::map<int32_t, uint64_t, std::greater<>> bids_;  // price → qty
std::map<int32_t, uint64_t>                 asks_;
```

On a 10-level book this is fine. On a full ITCH feed with 500,000 messages per second across hundreds of symbols, `std::map` fails on three counts: O(log N) updates, dynamic memory allocation per insert, and pointer-chasing data layout that destroys cache locality.

### Price-Indexed Array: O(1) Everything

The key insight for equity and futures order books: prices are quantized. They come in discrete ticks (e.g., 0.01 USD). If you know the price range of an instrument, you can allocate an array indexed by price tick, giving O(1) read and write with cache-friendly linear layout.

For a stock trading between \$100 and \$200 at \$0.01 tick size, that's 10,000 price levels, 80 KB for 64-bit quantities. This fits comfortably in L2 cache.

```cpp
#include <atomic>
#include <cstdint>
#include <climits>
#include <cassert>

static constexpr int32_t MAX_PRICE_LEVELS = 16384;  // 2^14 ticks
static constexpr int32_t PRICE_OFFSET     = 8192;   // Center of the array

// Aligned to cache line to prevent false sharing between bid and ask arrays.
// Each Level is one atomic 64-bit quantity, a single CAS or store/load.
struct alignas(64) Level {
    std::atomic<uint64_t> qty{0};
    // Pad to full cache line so adjacent levels don't share
    uint64_t pad[7];
};

class OrderBook {
    Level     bids_[MAX_PRICE_LEVELS];
    Level     asks_[MAX_PRICE_LEVELS];

    // Top-of-book tracked atomically for lock-free reads
    std::atomic<int32_t> best_bid_{INT32_MIN};
    std::atomic<int32_t> best_ask_{INT32_MAX};

    // Convert exchange price (e.g., 15000 cents) to array index
    static int32_t price_to_idx(int32_t price) {
        return price - PRICE_OFFSET;
    }

    static bool valid_idx(int32_t idx) {
        return idx >= 0 && idx < MAX_PRICE_LEVELS;
    }

public:
    // Single-writer: called only from the feed handler thread.
    // Readers (strategy thread) use acquire loads.
    void add_bid(int32_t price, uint64_t qty) {
        int32_t idx = price_to_idx(price);
        assert(valid_idx(idx));

        uint64_t prev = bids_[idx].qty.load(std::memory_order_relaxed);
        bids_[idx].qty.store(prev + qty, std::memory_order_release);

        // Update best bid if this price is better
        int32_t bb = best_bid_.load(std::memory_order_relaxed);
        if (price > bb) {
            best_bid_.store(price, std::memory_order_release);
        }
    }

    void remove_bid(int32_t price, uint64_t qty) {
        int32_t idx = price_to_idx(price);
        assert(valid_idx(idx));

        uint64_t prev = bids_[idx].qty.load(std::memory_order_relaxed);
        uint64_t next = (prev > qty) ? prev - qty : 0;
        bids_[idx].qty.store(next, std::memory_order_release);

        // If this level is now empty and was the best bid, scan downward
        if (next == 0 && price == best_bid_.load(std::memory_order_relaxed)) {
            recalc_best_bid(price);
        }
    }

    void add_ask(int32_t price, uint64_t qty) {
        int32_t idx = price_to_idx(price);
        assert(valid_idx(idx));

        uint64_t prev = asks_[idx].qty.load(std::memory_order_relaxed);
        asks_[idx].qty.store(prev + qty, std::memory_order_release);

        int32_t ba = best_ask_.load(std::memory_order_relaxed);
        if (price < ba) {
            best_ask_.store(price, std::memory_order_release);
        }
    }

    void remove_ask(int32_t price, uint64_t qty) {
        int32_t idx = price_to_idx(price);
        assert(valid_idx(idx));

        uint64_t prev = asks_[idx].qty.load(std::memory_order_relaxed);
        uint64_t next = (prev > qty) ? prev - qty : 0;
        asks_[idx].qty.store(next, std::memory_order_release);

        if (next == 0 && price == best_ask_.load(std::memory_order_relaxed)) {
            recalc_best_ask(price);
        }
    }

    // Lock-free reads from any thread
    int32_t  best_bid()     const { return best_bid_.load(std::memory_order_acquire); }
    int32_t  best_ask()     const { return best_ask_.load(std::memory_order_acquire); }
    uint64_t bid_qty(int32_t price) const {
        return bids_[price_to_idx(price)].qty.load(std::memory_order_acquire);
    }
    uint64_t ask_qty(int32_t price) const {
        return asks_[price_to_idx(price)].qty.load(std::memory_order_acquire);
    }

    // Spread in ticks
    int32_t spread() const {
        return best_ask() - best_bid();
    }

private:
    void recalc_best_bid(int32_t from_price) {
        for (int32_t p = from_price - 1; p >= PRICE_OFFSET; --p) {
            if (bids_[price_to_idx(p)].qty.load(std::memory_order_relaxed) > 0) {
                best_bid_.store(p, std::memory_order_release);
                return;
            }
        }
        best_bid_.store(INT32_MIN, std::memory_order_release);
    }

    void recalc_best_ask(int32_t from_price) {
        for (int32_t p = from_price + 1; p < PRICE_OFFSET + MAX_PRICE_LEVELS; ++p) {
            if (asks_[price_to_idx(p)].qty.load(std::memory_order_relaxed) > 0) {
                best_ask_.store(p, std::memory_order_release);
                return;
            }
        }
        best_ask_.store(INT32_MAX, std::memory_order_release);
    }
};
```

### Single-Writer Multiple-Reader Memory Model

The design above uses a single-writer multiple-reader pattern. The feed handler thread is the sole writer. Strategy threads are read-only. This eliminates the need for locks or CAS loops on the common path.

The memory ordering contract is simple:

- Writer uses **release stores** (`memory_order_release`) so that when a reader sees the new quantity, it also sees all the data written before that store.
- Readers use **acquire loads** (`memory_order_acquire`) to synchronize with the writer's release.

No mutex, no CAS failure loop, no ABA problem. The writer never retries and the readers never block. This is valid as long as the single-writer invariant is maintained, which it is because the feed handler runs on a dedicated pinned core.

### Order ID Map for Cancel/Modify

Top-of-book aggregated quantities are enough for signal generation, but order management requires tracking individual orders for cancel and modify:

```cpp
#include <cstdint>

struct OrderRecord {
    int32_t  price;
    uint64_t qty;
    char     side;   // 'B' or 'S'
};

// absl::flat_hash_map is 30-50% faster than std::unordered_map for this
// use case due to its open-addressing, SIMD-accelerated lookup.
// If Abseil is not available, use a hand-rolled open-addressing hash map
// with a power-of-2 table size and linear probing.
#include <absl/container/flat_hash_map.h>
using OrderMap = absl::flat_hash_map<uint64_t, OrderRecord>;
```

Pre-size the map at startup (`order_map.reserve(1'000'000)`) to avoid rehashing on the critical path.

### Cache Considerations

The `alignas(64)` on `Level` ensures each level occupies a full cache line. Without it, adjacent levels share a cache line, and a write to one level triggers a cache invalidation visible to cores accessing a neighboring level (false sharing). With separate 64-byte levels, writes to different price points are fully independent.

The bid and ask arrays are 16384 × 64 = 1 MB each, totaling 2 MB. This does not fit in L1 (typically 32-64 KB) or L2 (256 KB-1 MB). However, in practice trading is concentrated around the best bid/offer: the top 10 levels on each side represent 99% of activity. These 20 cache lines stay hot in L1 through repeated access.

### Go Comparison

The equivalent in Go uses `sync.RWMutex` with a map or sorted slice. For non-latency-critical use cases (backtesting, research, reporting) this works fine. Under production load at 10 million updates per second, `RWMutex` contention dominates because the lock itself requires an atomic operation even in the uncontended read path. The lock-free price-indexed array in C++ achieves the same safety guarantees with zero synchronization overhead on the write path and a single acquire load on the read path.

---
