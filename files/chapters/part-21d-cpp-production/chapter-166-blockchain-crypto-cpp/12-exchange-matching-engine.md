## Exchange Matching Engine

A matching engine is the core of a centralized exchange. It receives orders from clients, matches buy orders against sell orders according to a published priority rule, and emits fills, partial fills, and cancellations. Coinbase Exchange, Kraken, Binance, Bullish, and most institutional crypto venues run C++ matching engines on Linux with kernel-bypass networking.

This section walks through the architecture of a production-grade C++ matching engine.

### Order Types

A modern crypto exchange supports:

- **Limit orders**: trade at a specified price or better.
- **Market orders**: trade at the best available price.
- **Stop orders**: trigger a market order when a price level is reached.
- **Stop-limit orders**: trigger a limit order when a price level is reached.
- **Time-in-force flags**:
 - **GTC** (good-till-cancel): rest on the book until filled or canceled.
 - **IOC** (immediate-or-cancel): match immediately, cancel any unfilled remainder.
 - **FOK** (fill-or-kill): match the entire size immediately or cancel.
 - **POST_ONLY**: rest on the book, never take liquidity. Reject if the order would cross the spread.
- **Display flags**: iceberg orders that show only a fraction of size to the public book.
- **Self-trade prevention** flags: cancel the older or newer order if the same client would trade with itself.

The matching rule on most crypto exchanges is **price-time priority**: at a given price level, the order that arrived earliest matches first. Pro-rata matching (used in some derivatives) is rare in spot crypto.

### Data Structure: The Order Book

The order book is a map from price level to a queue of orders. The hot operations are:

- Insert at a price level (O(1) at the back of the queue, O(log N) to find the level).
- Match against the best price (O(1) at the front of the best queue).
- Cancel by order ID (O(1) given a hash table lookup).

The textbook data structure is a `std::map<Price, std::list<Order>>` plus a `std::unordered_map<OrderId, ListIterator>`. This is correct but slow. A production matching engine uses:

- **Flat array of price levels** indexed by price quantum, with a bitmap for non-empty levels. Best when the price range is bounded.
- **Intrusive doubly-linked list** at each level, avoiding `std::list`'s allocation per node.
- **Pool allocator** for orders and list nodes.

```cpp
struct Order {
    OrderId id;
    ClientId client;
    Side side;
    Price price;
    Quantity remaining;
    OrderFlags flags;
    Order* prev{nullptr};
    Order* next{nullptr};
    Timestamp arrived_ns;
};

class PriceLevel {
public:
    void push_back(Order* o) {
        if (!head_) head_ = o;
        if (tail_) tail_->next = o;
        o->prev = tail_;
        tail_ = o;
        total_qty_ += o->remaining;
    }

    void remove(Order* o) {
        if (o->prev) o->prev->next = o->next;
        else head_ = o->next;
        if (o->next) o->next->prev = o->prev;
        else tail_ = o->prev;
        total_qty_ -= o->remaining;
    }

    Order* head() const noexcept { return head_; }
    Quantity total_qty() const noexcept { return total_qty_; }

private:
    Order* head_{nullptr};
    Order* tail_{nullptr};
    Quantity total_qty_{0};
};

class OrderBookSide {
public:
    explicit OrderBookSide(Side s) : side_(s) {}

    // Best price level (highest for bids, lowest for asks)
    PriceLevel* best() {
        if (side_ == Side::Bid) {
            for (int i = max_level_; i >= 0; --i)
                if (levels_[i].head()) return &levels_[i];
        } else {
            for (int i = 0; i <= max_level_; ++i)
                if (levels_[i].head()) return &levels_[i];
        }
        return nullptr;
    }

private:
    Side side_;
    int max_level_;
    std::vector<PriceLevel> levels_;
};
```

For symbols with bounded price range and tick-aligned prices, the array index is `(price - min_price) / tick_size`. A 4-byte price level lookup is essentially free.

### The Match Function

```cpp
class MatchingEngine {
public:
    void on_order(NewOrder cmd) {
        Order* o = pool_.alloc();
        *o = make_order(cmd);
        auto& book = books_[cmd.symbol];
        auto& taker_side = (cmd.side == Side::Bid) ? book.bids : book.asks;
        auto& maker_side = (cmd.side == Side::Bid) ? book.asks : book.bids;

        // Match against existing orders
        while (o->remaining > 0) {
            PriceLevel* best = maker_side.best();
            if (!best) break;
            Price best_price = maker_side.price_of(best);
            if (!crosses(cmd.side, cmd.price, best_price)) break;

            Order* maker = best->head();
            Quantity match_qty = std::min(o->remaining, maker->remaining);
            emit_fill(o->id, maker->id, best_price, match_qty);
            o->remaining -= match_qty;
            maker->remaining -= match_qty;
            if (maker->remaining == 0) {
                best->remove(maker);
                pool_.free(maker);
            }
        }

        // Rest on the book if GTC and remaining
        if (o->remaining > 0 && cmd.tif == Tif::GTC) {
            taker_side.insert(o);
        } else {
            if (cmd.tif == Tif::IOC) emit_cancel(o->id, o->remaining);
            pool_.free(o);
        }
    }

private:
    OrderPool pool_;
    std::unordered_map<Symbol, OrderBook> books_;
};
```

The hot path is the inner `while` loop. On a Skylake-era core, this matches roughly 5 million orders per second per symbol when running single-threaded.

### Single-Threaded vs. Sharded

Most crypto matching engines are single-threaded per symbol. The reasons:

- **Determinism**. A single thread plus deterministic input order means deterministic output. This is what enables warm-standby replicas to stay in sync.
- **Cache locality**. The order book fits in L1/L2 cache. Multiple threads competing for the same book invalidates caches and crushes throughput.
- **Lock-free order books exist** but their complexity outweighs their benefit when single-threaded throughput already exceeds 1M orders per second.

To scale beyond one symbol, exchanges shard symbols across multiple matching engine processes. BTC-USD might run on engine 0, ETH-USD on engine 1, and so on. Cross-symbol arbitrage (e.g., BTC-USD vs BTC-EUR) is handled by a separate convergence layer.

### Deterministic Replay and Sequencer Redundancy

Every input to the matching engine (new orders, cancels, modifies, time ticks) is appended to a sequenced log. The matching engine's state is purely a function of this log. This enables:

- **Crash recovery**. Replay the log on restart to rebuild state.
- **Warm standby**. A second engine consumes the same log in parallel and is ready to take over.
- **Audit and dispute resolution**. Any fill can be traced to the exact log offset.

The sequencer is a separate component that assigns monotonic sequence numbers to incoming messages. A sequencer failure stops trading (a "marketwide halt"), so production exchanges run a primary plus one or two hot standbys with deterministic failover.

```cpp
class SequencedInputLog {
public:
    void append(InboundMessage m) {
        std::scoped_lock lock(mtx_);
        m.seq = next_seq_++;
        m.timestamp_ns = current_time_ns();
        log_.push_back(std::move(m));
        cv_.notify_all();
        replicate(log_.back());
    }

private:
    std::mutex mtx_;
    std::condition_variable cv_;
    std::vector<InboundMessage> log_;
    std::uint64_t next_seq_{0};
    Replicator replicator_;
};
```

For production deployments the log is replicated to a quorum (3 or 5 replicas) using Raft, with the sequence number advancing only after replication succeeds. This adds 50 to 200 microseconds of latency per message but is mandatory for durability.

### Self-Trade Prevention and Risk Checks

Before matching, a production engine runs:

- **Risk checks**: client has enough balance, does not exceed position limits, does not violate fat-finger checks.
- **Self-trade prevention**: if matching would cross the same client's own order, cancel one of them per the chosen STP mode.
- **Pre-trade compliance**: AML flags, jurisdiction restrictions.

These checks are typically run on a separate thread before the message reaches the matching engine, but the cancel and reject paths must be careful to preserve sequence ordering for replicas.

### Senior Track Notes

- **Matching engines that matter run on Linux with `SCHED_FIFO` real-time scheduling**, kernel-bypass NICs (Solarflare or Mellanox with OpenOnload or VMA), and isolated CPU cores (`isolcpus` boot parameter).
- **Latency targets** for top-tier crypto exchanges in 2025: median order-to-ack of 50 microseconds, p99 under 200 microseconds. This is comparable to first-tier equity exchanges and requires single-digit microsecond matching engine inner loops.
- **The "wire format" is FIX 4.4 or 5.0 over TCP** for institutional clients, and JSON over WebSocket for retail. Binary FIX (FAST or SBE) reduces parsing cost by 10x.
- **Fee model affects matching engine logic**. Maker rebates require the engine to record the role of each side (maker vs. taker) per fill. Tiered fees require lookups against a per-client volume table updated nightly.

The next section covers the market data feeds that this matching engine produces, and how they are consumed by clients.

---
