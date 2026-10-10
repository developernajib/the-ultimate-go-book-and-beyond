## Order Entry Fast Path: FIX, OUCH, iLink, and Kernel-Bypass Send

The order entry path is the second-most-latency-sensitive code in any HFT system, and in many ways harder than the data path. Where data is read-mostly and stateless, order entry is stateful: every message has a TCP sequence implication, every send must be acknowledged, retransmits are real, and the regulatory audit trail is non-negotiable. Latency budget from "decision to send" to "first byte on wire" is 100 to 400 nanoseconds at the top firms.

This chapter covers wire formats, the kernel-bypass send path, batching tradeoffs, and the C++ structure of a production order gateway.

### The Three Wire Formats You Will Meet

- **Nasdaq OUCH 5.0.** TCP, fixed-binary, big-endian. Used to send orders into Nasdaq, BX, PHLX. Messages are short (40-60 bytes). The `O` (Enter Order) message is the hot path. SoupBinTCP framing wraps the OUCH payload with a session/heartbeat layer.
- **CME iLink 3.** TCP, FIX SBE encoded, with a custom session-layer (CME's own sequence/seqack semantics rather than FIX's standard one). Used for futures order entry into CME Globex.
- **FIX 4.x / 5.0 SP2 (text or SBE-encoded).** Tagged ASCII for legacy venues, SBE binary for modern ones. ICE, Eurex, LSE, and many others publish FIX SBE specs for their order entry.

For each, encoding to wire bytes must be allocation-free and ideally branch-free for the hot path. The strategy emits a small fixed-shape decision struct, the gateway converts it to wire bytes in 30-50 nanoseconds.

### OUCH 5.0 Enter Order Message

Wire layout (big-endian):

```cpp
#pragma pack(push, 1)
struct OuchEnterOrder {
    char     msg_type;          // 'O'
    char     order_token[14];   // ASCII, left-justified, space-padded
    char     side;              // 'B' Buy, 'S' Sell, 'T' Sell Short, 'E' Sell Short Exempt
    uint32_t shares;
    char     stock[8];
    uint32_t price;             // price * 10000, big-endian
    uint32_t time_in_force;     // 0 = day
    char     firm[4];
    char     display;           // 'Y' visible, 'N' non-display, 'A' attributable
    char     capacity;          // 'A' agency, 'P' principal, ...
    char     iss;               // 'Y' if intermarket sweep
    uint32_t min_qty;
    char     cross_type;        // 'N' continuous market
    char     customer_type;     // 'R' retail, ' ' default
};
#pragma pack(pop)
static_assert(sizeof(OuchEnterOrder) == 49, "wire format mismatch");
```

Build a frame at line speed:

```cpp
#include <cstring>
#include <cstdint>
#include <endian.h>

inline size_t encode_enter(uint8_t* buf,
                           const char (&token)[14],
                           char side,
                           uint32_t shares,
                           const char (&stock)[8],
                           uint32_t price_x10000,
                           const char (&firm)[4]) {
    OuchEnterOrder* m = reinterpret_cast<OuchEnterOrder*>(buf);
    m->msg_type = 'O';
    std::memcpy(m->order_token, token, 14);
    m->side    = side;
    m->shares  = htobe32(shares);
    std::memcpy(m->stock, stock, 8);
    m->price   = htobe32(price_x10000);
    m->time_in_force = htobe32(0);
    std::memcpy(m->firm, firm, 4);
    m->display       = 'Y';
    m->capacity      = 'P';
    m->iss           = 'N';
    m->min_qty       = 0;
    m->cross_type    = 'N';
    m->customer_type = ' ';
    return sizeof(OuchEnterOrder);
}
```

Wrap with SoupBinTCP packet header (`uint16_t length` + `'S'` packet type) and write to TCP. On a kernel TCP socket: ~3-5 microseconds. On Onload: ~1.0-1.5us. On ef_vi raw TCP-in-userspace: ~300-500 ns.

### Encoding to TX mbuf in DPDK

For a DPDK-based order entry, you write directly into a TX mbuf and submit it. No syscall, no copy:

```cpp
rte_mbuf* m = rte_pktmbuf_alloc(tx_pool);
uint8_t* data = rte_pktmbuf_mtod(m, uint8_t*);

// L2: ethernet
auto* eth = reinterpret_cast<rte_ether_hdr*>(data);
eth->src_addr = local_mac;
eth->dst_addr = gateway_mac;
eth->ether_type = rte_cpu_to_be_16(RTE_ETHER_TYPE_IPV4);
data += sizeof(*eth);

// L3: IPv4
auto* ip = reinterpret_cast<rte_ipv4_hdr*>(data);
ip->version_ihl = 0x45;
ip->type_of_service = 0;
ip->total_length = 0;       // fix up after L4
ip->packet_id  = 0;
ip->fragment_offset = 0;
ip->time_to_live = 64;
ip->next_proto_id = IPPROTO_TCP;
ip->src_addr = local_ip_be;
ip->dst_addr = exchange_ip_be;
data += sizeof(*ip);

// L4: TCP, with the session's current snd_nxt
auto* tcp = reinterpret_cast<rte_tcp_hdr*>(data);
tcp->src_port = local_port_be;
tcp->dst_port = exchange_port_be;
tcp->sent_seq = htobe32(session.snd_nxt);
tcp->recv_ack = htobe32(session.rcv_nxt);
tcp->data_off = 5 << 4;     // no options
tcp->tcp_flags = RTE_TCP_PSH_FLAG | RTE_TCP_ACK_FLAG;
tcp->rx_win   = htobe16(session.rcv_wnd);
tcp->cksum    = 0;
tcp->tcp_urp  = 0;
data += sizeof(*tcp);

// Payload: SoupBinTCP + OUCH
const size_t ouch_len = encode_enter(data + 3, token, 'B', 100, stock, 4500000, firm);
data[0] = 0;
data[1] = uint8_t(ouch_len + 1);  // length includes the 'S' byte
data[2] = 'S';
data += 3 + ouch_len;

// Fix lengths and checksum
const size_t total = data - rte_pktmbuf_mtod(m, uint8_t*);
m->pkt_len = m->data_len = total;
ip->total_length = htobe16(total - sizeof(rte_ether_hdr));
ip->hdr_checksum = rte_ipv4_cksum(ip);
m->ol_flags = RTE_MBUF_F_TX_IPV4 | RTE_MBUF_F_TX_TCP_CKSUM;
m->l2_len   = sizeof(rte_ether_hdr);
m->l3_len   = sizeof(rte_ipv4_hdr);
tcp->cksum  = rte_ipv4_phdr_cksum(ip, m->ol_flags);

session.snd_nxt += (total - sizeof(rte_ether_hdr) - sizeof(rte_ipv4_hdr) - sizeof(rte_tcp_hdr));

const uint16_t sent = rte_eth_tx_burst(port, queue, &m, 1);
if (sent != 1) rte_pktmbuf_free(m);
```

This needs your own userspace TCP state machine (or a library like F-Stack, mTCP, or Seastar's stack). The benefit: every TCP segment encodes the order without an OS round trip.

### Batched MMIO Doorbells

DPDK's `rte_eth_tx_burst` writes a doorbell (an MMIO write to the NIC's BAR) to tell the NIC "you have new work." MMIO writes are uncached and serialized, costing ~80-200 ns. Doing one per packet is fine for throughput but expensive for single-message latency. There are two strategies:

- **Single send, single doorbell.** Latency: one doorbell. Throughput: limited.
- **Batch and burst.** Accumulate small bursts of orders before flushing the doorbell.

For the latency-critical hot path (one order per decision), the first is correct. For high-rate quoting (cancel/replace storms), the second wins. Production systems often have a "hot send" path with one-doorbell-per-call and a "warm send" path that batches.

ef_vi PIO bypasses the doorbell entirely for small frames, which is one of its main latency advantages over DPDK on Mellanox.

### Send Path Latency Components

```
Component                              ns
---------                              --
encode message into buffer             20-40
encode TCP/IP headers                  10-20
checksum offload prep                   2
mbuf submit (rte_eth_tx_burst)         30
PMD ring write + doorbell              80-150
PCIe + NIC TX                          50-100
                                       ---
Total to wire                          200-350
```

For ef_vi with PIO, the "PMD ring write + doorbell" is replaced with a direct PIO write of the packet contents (~120 ns), saving ~80 ns.

For Solarflare Onload TCP_NODELAY-set userspace TCP, the wire-arrival is ~600 ns from the application's `send()` call (the userspace stack adds TCP state-machine work).

### Synchronous vs Asynchronous Send

Two design points:

- **Synchronous.** The strategy thread directly encodes and submits. The hot path is direct, but the strategy core spends time on protocol work.
- **Asynchronous.** The strategy enqueues a decision into an SPSC ring, a dedicated send-thread on a dedicated core pulls and emits. Adds ~50-100 ns of inter-core handoff but separates concerns.

For top-tier HFT (low single-digit microsecond budgets), synchronous wins because the handoff latency is too costly. For larger order-management systems with fan-in from many strategies, asynchronous with one or more send threads is the right structure.

### Audit and Drop Copy

Every order must be journaled before it goes on the wire (regulatory). The journal must be ordered, persistent, and recoverable. Two ways:

- **Pre-send journal.** Write to a memory-mapped file or shared-memory ring before submitting. Adds ~50-100 ns. Risk: if the host dies after journal, before send, the order is "in journal but not on wire." Recover by checking the exchange's drop copy.
- **Post-send journal.** Submit first, journal second. Lower latency on the hot path. Risk: order on wire but not journaled. The compliance audit failures from this are catastrophic. Generally not allowed.

Pre-send is the universal answer. Use a shared memory SPSC ring to a logger process so the journal write is non-blocking from the strategy's perspective.

### Drop Copy Validation

Every exchange publishes a "drop copy" feed: a copy of every order action you took. The order gateway should consume the drop copy, match it against its own journal, and assert at message boundaries. Discrepancies indicate either an exchange-side problem or, more often, a software bug. Catching mismatches in real time is the difference between a \$10M loss and a \$1M loss.

> Junior engineer pitfall: writing an order send path that calls `send()` directly and assumes a few microseconds is "fast."
> Senior FAANG move: the encode is allocation-free and branchless, the wire format is verified against the exchange's certification harness, the send is via DPDK or ef_vi with PIO if available, the journal is pre-send and shared-memory, and the drop copy reconciler runs continuously against the journal as a safety net.
