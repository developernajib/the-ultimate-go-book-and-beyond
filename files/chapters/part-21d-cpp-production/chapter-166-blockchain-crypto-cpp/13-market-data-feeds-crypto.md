## Market Data Feeds in Crypto

A trading firm consuming crypto market data faces a different problem from a traditional equities firm. There are dozens of exchanges, each with its own feed format, each with its own latency profile, each with its own reliability story. A senior C++ engineer building this infrastructure must normalize, validate, and replicate these feeds at microsecond timescales.

### Feed Sources

The major crypto exchange feeds:

- **Coinbase Exchange**: WebSocket JSON feed at `ws-feed.exchange.coinbase.com`. Channels include `level2` (full depth updates), `matches` (trades), `ticker`. JSON, no binary alternative.
- **Binance Spot**: WebSocket JSON feed at `wss://stream.binance.com:9443`. Streams include `<symbol>@depth`, `<symbol>@trade`, `<symbol>@bookTicker`. Updates throttled to 100ms or 1000ms.
- **Kraken**: WebSocket v2 API with structured JSON. Recently added unsolicited subscription error reporting.
- **OKX, Bybit, Bitfinex**: similar WebSocket JSON.
- **CME crypto futures**: native CME MDP 3.0 feed (binary FIX over multicast UDP). Used for institutional crypto derivatives.
- **Direct exchange ITCH feeds**: some institutional venues (Coinbase Prime, Bullish) offer binary feeds over private cross-connect.

### Normalized Data Model

A trading firm wants one internal representation regardless of source. The canonical model:

```cpp
enum class Side : std::uint8_t { Bid = 0, Ask = 1 };

struct PriceLevel {
    std::int64_t price_ticks;     // price in integer ticks
    std::int64_t quantity_units;  // quantity in integer units
};

struct BookUpdate {
    Symbol symbol;
    std::uint64_t exchange_seq;
    std::uint64_t local_recv_ns;
    std::uint64_t exchange_send_ns;
    std::vector<PriceLevel> bids;
    std::vector<PriceLevel> asks;
    bool is_snapshot;
};

struct Trade {
    Symbol symbol;
    std::int64_t price_ticks;
    std::int64_t quantity_units;
    Side aggressor;
    std::uint64_t exchange_ts_ns;
    std::uint64_t local_recv_ns;
};
```

Two design decisions matter:

1. **Use integer ticks and units**, never floating point. A USDT/USD trade reported as 1.0001 must round-trip exactly. Floats lose precision and create reconciliation nightmares.
2. **Always carry both timestamps**: when the exchange sent the message and when we received it. The difference is the network plus exchange queue latency, which is a key trading signal.

### WebSocket Parsing in C++

JSON parsing is the bottleneck for crypto market data ingestion. A naive `nlohmann::json` parse of a Coinbase L2 update takes 20 to 50 microseconds. With `simdjson`, the same parse takes 1 to 3 microseconds.

```cpp
#include <simdjson.h>

class CoinbaseFeedParser {
public:
    std::optional<BookUpdate> parse(std::string_view raw) {
        auto doc = parser_.iterate(raw);
        std::string_view type = doc["type"];
        if (type == "l2update") {
            BookUpdate u{};
            u.symbol = Symbol::from(doc["product_id"]);
            u.local_recv_ns = now_ns();
            for (auto change : doc["changes"]) {
                std::array<std::string_view, 3> fields;
                std::size_t i = 0;
                for (auto v : change) fields[i++] = v;
                Side side = (fields[0] == "buy") ? Side::Bid : Side::Ask;
                std::int64_t price = parse_price(fields[1]);
                std::int64_t qty = parse_qty(fields[2]);
                if (side == Side::Bid) u.bids.push_back({price, qty});
                else u.asks.push_back({price, qty});
            }
            return u;
        }
        return std::nullopt;
    }

private:
    simdjson::ondemand::parser parser_;
};
```

`simdjson` parses JSON in-place using SIMD instructions. The `iterate` API returns lazy iterators that defer field decoding until accessed.

### Order Book Reconstruction

A snapshot-then-incremental feed requires careful book maintenance. The protocol:

1. Subscribe.
2. Receive a snapshot (full bid and ask lists).
3. Receive a stream of incremental updates with monotonically increasing sequence numbers.
4. If a sequence number gap appears, resubscribe to a fresh snapshot.

```cpp
class DepthBook {
public:
    void apply(const BookUpdate& u) {
        if (u.is_snapshot) {
            bids_.clear();
            asks_.clear();
            for (const auto& l : u.bids) bids_[l.price_ticks] = l.quantity_units;
            for (const auto& l : u.asks) asks_[l.price_ticks] = l.quantity_units;
            last_seq_ = u.exchange_seq;
            return;
        }
        if (u.exchange_seq != last_seq_ + 1) {
            // Gap detected, request resubscribe
            request_resync();
            return;
        }
        last_seq_ = u.exchange_seq;
        for (const auto& l : u.bids) {
            if (l.quantity_units == 0) bids_.erase(l.price_ticks);
            else bids_[l.price_ticks] = l.quantity_units;
        }
        for (const auto& l : u.asks) {
            if (l.quantity_units == 0) asks_.erase(l.price_ticks);
            else asks_[l.price_ticks] = l.quantity_units;
        }
    }

    [[nodiscard]] std::optional<std::int64_t> best_bid() const {
        if (bids_.empty()) return std::nullopt;
        return bids_.rbegin()->first;
    }

    [[nodiscard]] std::optional<std::int64_t> best_ask() const {
        if (asks_.empty()) return std::nullopt;
        return asks_.begin()->first;
    }

private:
    std::map<std::int64_t, std::int64_t> bids_;
    std::map<std::int64_t, std::int64_t> asks_;
    std::uint64_t last_seq_{0};
};
```

For high performance, replace `std::map` with the same flat-array-of-price-levels structure used in the matching engine.

### FIX, FIXP, and Binary Protocols

Institutional crypto trading uses FIX (Financial Information eXchange). The two flavors:

- **FIX 4.4 over TCP**: text-based, tag-value format. Verbose, easy to debug, slow.
- **FIXP / SBE**: binary FIX with simple binary encoding. Used by CME, Cboe, and emerging crypto venues.

A FIX 4.4 message looks like:

```
8=FIX.4.4\x019=178\x0135=8\x0149=COINBASE\x0156=CLIENT1\x0152=20251225-12:00:00.000\x01...10=234\x01
```

Each field is `tag=value\x01`. Parsing is a state machine over the input bytes.

```cpp
class FixParser {
public:
    void feed(std::span<const std::uint8_t> data) {
        for (std::uint8_t b : data) {
            if (b == '\x01') {
                handle_field(current_tag_, current_value_);
                current_tag_.clear();
                current_value_.clear();
                in_value_ = false;
            } else if (b == '=') {
                in_value_ = true;
            } else {
                if (in_value_) current_value_.push_back(b);
                else current_tag_.push_back(b);
            }
        }
    }

private:
    std::string current_tag_;
    std::string current_value_;
    bool in_value_{false};
};
```

For SBE, the schema-aware parser generates C++ headers from XML schema definitions. CME ships an open-source SBE codec generator. The cost of parsing an SBE message is a few cache-line loads, no string handling.

### Cap'n Proto for Internal Replication

Inside a trading firm, the normalized internal feed is replicated from one process to many. Cap'n Proto (or FlatBuffers) is the standard choice for this internal hop because it has zero-copy reads.

```capnp
struct BookUpdate {
  symbol @0 :UInt32;
  exchangeSeq @1 :UInt64;
  exchangeSendNs @2 :UInt64;
  localRecvNs @3 :UInt64;
  bids @4 :List(Level);
  asks @5 :List(Level);
  isSnapshot @6 :Bool;
}

struct Level {
  priceTicks @0 :Int64;
  quantityUnits @1 :Int64;
}
```

The receiver memory-maps the message buffer and reads fields without parsing.

```cpp
auto reader = ::capnp::FlatArrayMessageReader(buf);
auto u = reader.getRoot<BookUpdate>();
auto seq = u.getExchangeSeq();
for (auto level : u.getBids()) {
    apply_bid(level.getPriceTicks(), level.getQuantityUnits());
}
```

The cost is one bounds check per field access. A typical update is processed in 100 to 500 nanoseconds.

### Multicast Replication

When the same data must reach 10 consuming processes on the same host or same rack, multicast (or shared memory ring buffers for in-process) beats unicast.

The standard pattern is a sequenced multicast channel: the publisher sends each message once with a sequence number, consumers detect gaps, and a separate gap-fill server provides recovery. Aeron is the leading open-source implementation. LMAX Disruptor patterns also apply.

### Senior Track Notes

- **Coinbase WebSocket reliability**. Coinbase's L2 feed has historically had occasional sequence gaps that require full resubscribe. Production firms run two parallel sessions and arbitrate between them.
- **Binance feed throttling**. The 100ms or 1000ms update windows mean you do not see every change. For depth-sensitive strategies, use the lower-latency ITCH-equivalent feed via Binance Connect (for institutional clients).
- **Cross-exchange clock skew**. Exchange timestamps are not synchronized. A trade timestamped at Coinbase 12:00:00.123 may have happened at the "real" wall-clock time of 12:00:00.118 because Coinbase's clock is ahead. Strategies that compare timestamps across exchanges must measure and subtract the per-exchange skew.
- **Decimal precision varies by symbol**. BTC-USD on Coinbase has 2 decimal places of price (0.01 ticks). DOGE-USDT on Binance has 5. Hard-coding tick sizes is a bug. Pull the symbol metadata from the exchange REST API at startup and cache it.

The next section moves into zero-knowledge proofs, the rapidly maturing technology that underlies Layer 2 scaling.

---
