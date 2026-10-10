## Market Data Feed Handlers

A feed handler is the component that converts raw exchange packets into structured market data updates that the strategy can consume. It sits at the exact boundary between the network and the trading logic, and it runs on the single hottest core in the entire system. Every nanosecond saved here is a nanosecond closer to the signal.

### Exchange Protocol Landscape

Different exchanges use different wire protocols. Understanding the protocol determines the design of the parser:

| Protocol | Exchange | Type | Characteristics |
|---|---|---|---|
| ITCH 5.0 | NASDAQ | Binary, UDP multicast | Fixed-size messages, ~20 types |
| PITCH | BATS/CBOE | Binary, UDP multicast | Similar to ITCH |
| XDP | NYSE | Binary, UDP multicast | Variable-length, complex |
| FIX 4.x | Most | ASCII text, TCP | Flexible but verbose and slow |
| FAST | Many | Compressed binary, UDP | FIX semantics, binary encoding |
| OPRA | US Options | Binary, UDP multicast | Very high message rate |

ITCH is the cleanest protocol for demonstrating HFT feed handler design: binary, fixed-size, sequenced, and well-documented. We will implement a full ITCH 5.0 parser.

### NASDAQ ITCH 5.0 Protocol

ITCH messages are delivered over UDP in a SoupBinTCP or MoldUDP64 framing. MoldUDP64 wraps multiple ITCH messages in a single UDP packet with a sequence number header:

```
MoldUDP64 Header (20 bytes):
  Session:       10 bytes (ASCII)
  Sequence:       8 bytes (uint64, big-endian)
  MessageCount:   2 bytes (uint16, big-endian)

Followed by MessageCount message blocks:
  MessageLength:  2 bytes (uint16, big-endian)
  MessageData:    MessageLength bytes
```

Key ITCH message types:

```cpp
#include <cstdint>
#include <cstring>

#pragma pack(push, 1)  // No padding -- fields are packed for wire format

struct MoldUDP64Header {
    char     session[10];
    uint64_t seq_no;        // Big-endian
    uint16_t message_count; // Big-endian
};

// Message type 'A': Add Order (No MPID)
struct ITCHAddOrder {
    char     msg_type;        // 'A'
    uint16_t stock_locate;    // Internal symbol ID
    uint16_t tracking_number;
    uint8_t  timestamp[6];   // Nanoseconds since midnight, big-endian 48-bit
    uint64_t order_ref;       // Unique order reference number
    char     side;            // 'B' = Buy, 'S' = Sell
    uint32_t shares;
    char     stock[8];        // Left-justified, space-padded
    uint32_t price;           // Price in 1/10000 USD
};

// Message type 'D': Delete Order
struct ITCHDeleteOrder {
    char     msg_type;        // 'D'
    uint16_t stock_locate;
    uint16_t tracking_number;
    uint8_t  timestamp[6];
    uint64_t order_ref;
};

// Message type 'E': Order Executed
struct ITCHOrderExecuted {
    char     msg_type;        // 'E'
    uint16_t stock_locate;
    uint16_t tracking_number;
    uint8_t  timestamp[6];
    uint64_t order_ref;
    uint32_t executed_shares;
    uint64_t match_number;
};

// Message type 'U': Order Replace
struct ITCHOrderReplace {
    char     msg_type;        // 'U'
    uint16_t stock_locate;
    uint16_t tracking_number;
    uint8_t  timestamp[6];
    uint64_t orig_order_ref;
    uint64_t new_order_ref;
    uint32_t shares;
    uint32_t price;
};

#pragma pack(pop)
```

### The ITCH Message Parser

Big-endian fields require byte-swapping on x86. Use `__builtin_bswap` for zero-overhead swaps:

```cpp
#include <arpa/inet.h>  // ntohs, ntohl

inline uint16_t be16(const void* p) {
    uint16_t v; std::memcpy(&v, p, 2);
    return __builtin_bswap16(v);
}
inline uint32_t be32(const void* p) {
    uint32_t v; std::memcpy(&v, p, 4);
    return __builtin_bswap32(v);
}
inline uint64_t be64(const void* p) {
    uint64_t v; std::memcpy(&v, p, 8);
    return __builtin_bswap64(v);
}
inline uint64_t be48(const uint8_t* p) {
    return (static_cast<uint64_t>(p[0]) << 40) |
           (static_cast<uint64_t>(p[1]) << 32) |
           (static_cast<uint64_t>(p[2]) << 24) |
           (static_cast<uint64_t>(p[3]) << 16) |
           (static_cast<uint64_t>(p[4]) <<  8) |
           (static_cast<uint64_t>(p[5]));
}

// Unified message dispatcher. Parses the message type byte and dispatches
// to the appropriate handler. Returns false on unknown message type.
bool dispatch_itch_message(
    const uint8_t*    buf,
    uint16_t          len,
    uint64_t          seq_no,
    uint64_t          hw_ts_ns,
    OrderBook&        book,
    OrderMap&         orders
) {
    if (len == 0) return false;
    char msg_type = static_cast<char>(buf[0]);

    switch (msg_type) {
    case 'A': {  // Add Order
        if (len < sizeof(ITCHAddOrder)) return false;
        const auto* m = reinterpret_cast<const ITCHAddOrder*>(buf);

        uint64_t order_ref = be64(&m->order_ref);
        uint32_t shares    = be32(&m->shares);
        int32_t  price     = static_cast<int32_t>(be32(&m->price));

        // Store for later cancel/modify lookup
        orders[order_ref] = {price, shares, m->side};

        // Update aggregated order book
        if (m->side == 'B') book.add_bid(price, shares);
        else                 book.add_ask(price, shares);

        return true;
    }
    case 'D': {  // Delete Order
        if (len < sizeof(ITCHDeleteOrder)) return false;
        const auto* m = reinterpret_cast<const ITCHDeleteOrder*>(buf);

        uint64_t order_ref = be64(&m->order_ref);
        auto it = orders.find(order_ref);
        if (it != orders.end()) {
            const auto& rec = it->second;
            if (rec.side == 'B') book.remove_bid(rec.price, rec.qty);
            else                  book.remove_ask(rec.price, rec.qty);
            orders.erase(it);
        }
        return true;
    }
    case 'E': {  // Order Executed (partial or full fill)
        if (len < sizeof(ITCHOrderExecuted)) return false;
        const auto* m = reinterpret_cast<const ITCHOrderExecuted*>(buf);

        uint64_t order_ref = be64(&m->order_ref);
        uint32_t exec_qty  = be32(&m->executed_shares);

        auto it = orders.find(order_ref);
        if (it != orders.end()) {
            auto& rec = it->second;
            if (rec.side == 'B') book.remove_bid(rec.price, exec_qty);
            else                  book.remove_ask(rec.price, exec_qty);
            rec.qty = (rec.qty > exec_qty) ? rec.qty - exec_qty : 0;
            if (rec.qty == 0) orders.erase(it);
        }
        return true;
    }
    case 'U': {  // Order Replace
        if (len < sizeof(ITCHOrderReplace)) return false;
        const auto* m = reinterpret_cast<const ITCHOrderReplace*>(buf);

        uint64_t orig_ref = be64(&m->orig_order_ref);
        uint64_t new_ref  = be64(&m->new_order_ref);
        uint32_t shares   = be32(&m->shares);
        int32_t  price    = static_cast<int32_t>(be32(&m->price));

        auto it = orders.find(orig_ref);
        if (it != orders.end()) {
            const auto& old = it->second;
            // Remove old order from book
            if (old.side == 'B') book.remove_bid(old.price, old.qty);
            else                  book.remove_ask(old.price, old.qty);

            // Insert new order
            OrderRecord new_rec{price, shares, old.side};
            orders[new_ref] = new_rec;
            orders.erase(it);

            if (new_rec.side == 'B') book.add_bid(price, shares);
            else                      book.add_ask(price, shares);
        }
        return true;
    }
    default:
        // System messages (S, R, H, Y, L, V, W, K, J) -- not relevant to order book
        return true;
    }
}
```

### Complete Feed Handler Architecture

`SPSCRingBuffer<T, N>` is a single-producer single-consumer lock-free ring buffer that uses a power-of-2 capacity so the modulo in index arithmetic becomes a bitmask operation. The feed handler core writes decoded market data into the ring buffer, and the strategy core reads from it without locks. The `static_assert` enforces the power-of-2 constraint at compile time because a non-power-of-2 N would silently produce incorrect bitmask wrap-around.
```cpp
#include <cstdint>
#include <cstring>

// Single-producer single-consumer lock-free ring buffer.
// Used to pass decoded market data from the feed handler core
// to the strategy core without blocking either.
template <typename T, size_t N>
class SPSCRingBuffer {
    static_assert((N & (N - 1)) == 0, "N must be power of 2");

    alignas(64) std::atomic<size_t> head_{0};
    alignas(64) std::atomic<size_t> tail_{0};
    T slots_[N];

public:
    // Producer: returns false if full
    bool push(const T& item) {
        size_t h = head_.load(std::memory_order_relaxed);
        size_t next_h = (h + 1) & (N - 1);
        if (next_h == tail_.load(std::memory_order_acquire)) return false;
        slots_[h] = item;
        head_.store(next_h, std::memory_order_release);
        return true;
    }

    // Consumer: returns false if empty
    bool pop(T& item) {
        size_t t = tail_.load(std::memory_order_relaxed);
        if (t == head_.load(std::memory_order_acquire)) return false;
        item = slots_[t];
        tail_.store((t + 1) & (N - 1), std::memory_order_release);
        return true;
    }
};

struct MarketDataEvent {
    uint8_t  msg_type;
    uint16_t stock_locate;
    uint64_t order_ref;
    int32_t  price;
    uint32_t qty;
    char     side;
    uint64_t hw_ts_ns;
    uint64_t seq_no;
};

class FeedHandler {
    MulticastReceiver     receiver_;
    OrderBook             books_[8192];  // One per stock_locate (symbol ID)
    OrderMap              orders_;
    SPSCRingBuffer<MarketDataEvent, 65536> ring_;
    uint64_t              next_seq_{1};

    uint8_t  recv_buf_[65536];

public:
    // Runs on a dedicated isolated core. Never returns.
    [[noreturn]] void run() {
        orders_.reserve(500'000);

        while (true) {
            uint64_t hw_ts_ns;
            ssize_t n = receiver_.receive(recv_buf_, sizeof(recv_buf_), hw_ts_ns);
            if (n <= 0) continue;

            // Parse MoldUDP64 header
            if (n < static_cast<ssize_t>(sizeof(MoldUDP64Header))) continue;
            const auto* hdr = reinterpret_cast<MoldUDP64Header*>(recv_buf_);

            uint64_t seq     = be64(&hdr->seq_no);
            uint16_t count   = be16(&hdr->message_count);

            if (seq != next_seq_) {
                // Gap: request retransmit. For now, skip (live systems handle this).
                next_seq_ = seq + count;
                continue;
            }

            const uint8_t* pos = recv_buf_ + sizeof(MoldUDP64Header);
            const uint8_t* end = recv_buf_ + n;

            for (uint16_t i = 0; i < count && pos + 2 <= end; ++i) {
                uint16_t msg_len = be16(pos);
                pos += 2;
                if (pos + msg_len > end) break;

                uint16_t stock_locate = (msg_len > 2) ? be16(pos + 1) : 0;
                OrderBook& book = books_[stock_locate % 8192];

                dispatch_itch_message(pos, msg_len, seq, hw_ts_ns, book, orders_);

                // Push event to strategy ring buffer (non-blocking)
                MarketDataEvent evt{};
                evt.msg_type     = pos[0];
                evt.stock_locate = stock_locate;
                evt.hw_ts_ns     = hw_ts_ns;
                evt.seq_no       = seq;
                ring_.push(evt);  // Drop if full -- strategy too slow

                pos += msg_len;
                ++seq;
            }

            next_seq_ = seq;
        }
    }

    SPSCRingBuffer<MarketDataEvent, 65536>& event_ring() { return ring_; }
    OrderBook& book(uint16_t stock_locate) { return books_[stock_locate % 8192]; }
};
```

### Go Comparison

Go is viable and used in production for non-HFT feed handlers, for example, writing exchange data to databases, calculating risk metrics, or feeding backtesting systems. The `quickfixgo` library provides a solid FIX protocol implementation. For ITCH and other binary protocols, Go's binary reading is straightforward with `encoding/binary`. The critical difference is throughput under tight latency constraints: Go's goroutine scheduler, escape analysis, and GC make it unsuitable for the hot path shown above, but perfectly adequate for the warm and cold paths that consume the same data at less aggressive latency targets.

---
