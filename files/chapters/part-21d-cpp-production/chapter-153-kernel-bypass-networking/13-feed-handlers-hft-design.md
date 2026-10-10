## Feed Handlers and HFT Order Book Design

The order book sits at the center of every HFT system. Market data arrives, the book is updated, the strategy queries the book, the strategy decides whether to trade. Wall-clock budget from packet wire arrival to strategy decision is typically 800 to 2000 nanoseconds. The book has to do its updates and queries in the small fraction of that budget left after parsing.

This chapter covers the production design: deterministic price-level vs order-id books, conflation, packet-loss recovery, and a working C++ implementation skeleton.

### The Two Book Architectures

There are exactly two correct designs for an exchange order book in C++:

- **Price-level book.** A sorted structure (intrusive doubly-linked list, or a flat array indexed by price ticks for instruments with bounded price range) of price levels, where each level has aggregate quantity. Updates: adjust qty at level. Top-of-book: read first level on each side. Used when the strategy cares only about prices and aggregate sizes.
- **Order-id book.** Hash table from order ID to (price, qty, side). Plus the price-level structure on top, derived. Updates touch both. Used when the strategy needs queue position (where am I in the FIFO at this level) or per-order analytics.

ITCH 5.0 is order-id-driven (every message carries an order reference). CME MDP 3.0 is mostly level-driven (Market By Level). Match the book design to the feed format.

### Price-Level Book: Tick-Indexed Array

For US equities priced in cents, with a price range of \$0.01 to \$1000, you have 100,000 distinct ticks. A flat array of 100,000 levels per side, indexed by price-in-ticks, gives O(1) updates and O(BBO-distance) top-of-book queries. Memory cost: 100,000 levels x 32 bytes = 3.2 MB per side. Easily L2-cacheable for the active range.

```cpp
struct alignas(32) PriceLevel {
    uint64_t total_qty;
    uint32_t order_count;
    uint32_t price_ticks;     // redundant, used for compaction passes
    uint64_t reserved;        // padding to 32B
};

class TickArrayBook {
public:
    static constexpr uint32_t kNumTicks = 100000;
    PriceLevel bids_[kNumTicks];   // indexed by tick
    PriceLevel asks_[kNumTicks];
    uint32_t best_bid_tick_;       // highest non-empty bid tick
    uint32_t best_ask_tick_;       // lowest non-empty ask tick

    void add(uint32_t tick, char side, uint64_t qty) {
        auto& arr = (side == 'B') ? bids_ : asks_;
        auto& lvl = arr[tick];
        lvl.total_qty   += qty;
        lvl.order_count += 1;
        lvl.price_ticks  = tick;
        if (side == 'B' && tick > best_bid_tick_) best_bid_tick_ = tick;
        if (side == 'S' && tick < best_ask_tick_) best_ask_tick_ = tick;
    }

    void remove(uint32_t tick, char side, uint64_t qty) {
        auto& arr = (side == 'B') ? bids_ : asks_;
        auto& lvl = arr[tick];
        lvl.total_qty   -= qty;
        lvl.order_count -= 1;
        if (lvl.order_count == 0) {
            if (side == 'B' && tick == best_bid_tick_) recompute_bb();
            if (side == 'S' && tick == best_ask_tick_) recompute_ba();
        }
    }

    void recompute_bb() {
        for (int t = best_bid_tick_; t >= 0; t--) {
            if (bids_[t].order_count > 0) { best_bid_tick_ = t; return; }
        }
        best_bid_tick_ = 0;
    }
    void recompute_ba() {
        for (uint32_t t = best_ask_tick_; t < kNumTicks; t++) {
            if (asks_[t].order_count > 0) { best_ask_tick_ = t; return; }
        }
        best_ask_tick_ = kNumTicks;
    }
};
```

`add` is ~10 cycles. `remove` is ~10 cycles. `recompute` is rare (only when the BBO empties). Top-of-book is one array index plus a value read.

### Order-ID Book: The Real ITCH Implementation

For ITCH 5.0 you also need O(1) lookup by order ID, because every Execute / Cancel / Replace message carries the order ID and not the price. The standard layout: an open-addressed hash table keyed by order_ref, with each entry holding a pointer back into a level's intrusive list.

```cpp
struct Order {
    uint64_t   order_ref;
    uint32_t   shares;
    uint32_t   price_ticks;
    char       side;          // 'B' or 'S'
    char       _pad[7];
    Order*     prev_at_level;
    Order*     next_at_level;
};

struct alignas(64) Level {
    uint64_t total_qty;
    Order*   first;          // FIFO head (oldest)
    Order*   last;           // FIFO tail (newest)
    uint32_t order_count;
    uint32_t price_ticks;
};

class OrderIdBook {
public:
    Order*  by_id_[1 << 22];   // 4M slots, open-addressed
    Level   bids_[kNumTicks];
    Level   asks_[kNumTicks];
    uint32_t best_bid_tick_;
    uint32_t best_ask_tick_;

    // Slab allocator for Order: pre-allocated, never malloc
    Order*  free_head_;
    Order*  pool_;

    Order* alloc_order() noexcept {
        Order* o = free_head_;
        free_head_ = o->next_at_level;
        return o;
    }
    void free_order(Order* o) noexcept {
        o->next_at_level = free_head_;
        free_head_ = o;
    }

    void on_add(uint64_t ref, char side, uint32_t shares,
                uint32_t price_ticks) {
        Order* o = alloc_order();
        o->order_ref = ref;
        o->shares    = shares;
        o->side      = side;
        o->price_ticks = price_ticks;

        Level& lvl = (side == 'B' ? bids_ : asks_)[price_ticks];
        // Append to end of level FIFO
        o->prev_at_level = lvl.last;
        o->next_at_level = nullptr;
        if (lvl.last) lvl.last->next_at_level = o;
        else          lvl.first = o;
        lvl.last = o;
        lvl.total_qty   += shares;
        lvl.order_count += 1;
        lvl.price_ticks  = price_ticks;

        by_id_[ref & (sizeof(by_id_)/sizeof(*by_id_) - 1)] = o;

        if (side == 'B' && price_ticks > best_bid_tick_) best_bid_tick_ = price_ticks;
        if (side == 'S' && price_ticks < best_ask_tick_) best_ask_tick_ = price_ticks;
    }

    void on_execute(uint64_t ref, uint32_t executed_shares) {
        Order* o = by_id_[ref & (sizeof(by_id_)/sizeof(*by_id_) - 1)];
        if (!o) return;
        o->shares -= executed_shares;
        Level& lvl = (o->side == 'B' ? bids_ : asks_)[o->price_ticks];
        lvl.total_qty -= executed_shares;
        if (o->shares == 0) erase(o, lvl);
    }

    void on_cancel(uint64_t ref, uint32_t cancel_shares) {
        Order* o = by_id_[ref & (sizeof(by_id_)/sizeof(*by_id_) - 1)];
        if (!o) return;
        o->shares -= cancel_shares;
        Level& lvl = (o->side == 'B' ? bids_ : asks_)[o->price_ticks];
        lvl.total_qty -= cancel_shares;
        if (o->shares == 0) erase(o, lvl);
    }

    void erase(Order* o, Level& lvl) noexcept {
        if (o->prev_at_level) o->prev_at_level->next_at_level = o->next_at_level;
        else                  lvl.first = o->next_at_level;
        if (o->next_at_level) o->next_at_level->prev_at_level = o->prev_at_level;
        else                  lvl.last  = o->prev_at_level;
        lvl.order_count -= 1;
        by_id_[o->order_ref & (sizeof(by_id_)/sizeof(*by_id_) - 1)] = nullptr;
        free_order(o);
        if (lvl.order_count == 0 && o->side == 'B' && o->price_ticks == best_bid_tick_) recompute_bb();
        if (lvl.order_count == 0 && o->side == 'S' && o->price_ticks == best_ask_tick_) recompute_ba();
    }
};
```

A few production-grade details visible in this skeleton:

- **No malloc.** Orders come from a slab. The slab is pre-sized to the maximum outstanding order count seen historically (typically a few million for active US equities).
- **Open-addressed hash table without collision handling.** This is a simplification, a real implementation handles collisions. The size is typically sized so collisions are rare for the active order set.
- **Intrusive list at each level.** Maintains FIFO order for queue-position queries. Adding to the end and removing from anywhere is O(1) thanks to the doubly-linked structure.
- **BBO recomputation is rare.** Only triggered when the BBO level empties.

Per-message latency on a warm cache: 50-150 ns for add/cancel/execute. The full pipeline from packet to book updated: ~300 ns plus parse cost.

### Conflation for Slow Consumers

Strategy A polls the book at 10us intervals. Strategy B polls every 100ms (or, more usefully, only when notified). Both must see consistent data. The seqlock pattern from chapter 10 applies: the writer increments a sequence number around each book mutation, readers retry on seeing an odd value.

For derived snapshots (BBO summary, top-N levels), publish via a per-symbol seqlock to a fanout shared memory ring. Slow consumers conflate by reading only the most recent snapshot.

### Packet-Loss Recovery

ITCH 5.0 carries strictly increasing sequence numbers per session. Detection of a gap is trivial. Recovery options:

- **Request retransmit from MoldUDP retransmission server.** Send a request for messages [n, m]. Server replies with a unicast burst of those messages. Latency: a few milliseconds.
- **Glimpse snapshot.** A point-in-time snapshot of the entire book is published periodically. After a major loss, drain the snapshot, then start applying live messages from the snapshot's sequence.
- **B-feed substitution.** ITCH publishes A and B feeds with the same content via different network paths. If A drops, B usually has it.

Production code maintains a small reorder buffer (typically 1-4 ms of messages worth) to absorb out-of-order arrivals on the dedupe path before declaring a true gap.

### Determinism

A deterministic book is one where, given the same input message stream, the book's state and emitted snapshots are bit-identical across runs. This matters for replay-based testing and post-trade reconciliation.

Sources of non-determinism to remove:

- **Iteration order over hash maps.** Use sorted iteration explicitly when emitting snapshots.
- **Floating point.** Avoid in book code. Use fixed-point integer math for prices.
- **Timestamping.** Either timestamp from message content (exchange-published timestamps) or be explicit that local timestamps are advisory.
- **Multi-threading.** A book is single-threaded by design. If you need multi-symbol parallelism, partition by symbol, never multi-thread a single book.

### Microbenchmark

```cpp
#include <chrono>
#include <random>

void benchmark() {
    OrderIdBook book{};
    init_book(book);
    std::mt19937_64 rng(42);

    constexpr int N = 10'000'000;
    auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < N; i++) {
        const uint64_t ref = i + 1;
        const uint32_t price = 5000 + (rng() % 200);
        book.on_add(ref, (i & 1) ? 'B' : 'S', 100, price);
    }
    auto end = std::chrono::steady_clock::now();
    const double ns_per = double((end - start).count()) / N;
    printf("avg add: %.1f ns\n", ns_per);
}
```

On a Sapphire Rapids 8480+ at 3.8 GHz, isolated core, this prints around 95 ns/add for a hot working set. On older Skylake-X, ~120 ns. These numbers determine your book's contribution to total tick-to-trade latency.

> Junior engineer pitfall: writing an order book with `std::map<double, std::deque<Order>>` and being surprised by 3-microsecond per-message latency.
> Senior FAANG move: tick-indexed array for price levels, open-addressed hash for order IDs, slab-allocated orders, intrusive lists at levels, seqlock-published snapshots for fanout, deterministic replay path validated against an exchange replay file.
