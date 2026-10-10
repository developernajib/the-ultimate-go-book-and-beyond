## Mellanox/Nvidia Fast Paths: VMA, ASAP2, SR-IOV, Exchange Feeds

Where Solarflare/AMD-Pensando dominates the trading-floor NIC market, Mellanox (Nvidia since 2019) dominates the cloud and AI fabric market. Mellanox's ConnectX-5, CX-6, CX-7 and the BlueField DPU family ship in hyperscaler clusters by the millions. The Mellanox userspace acceleration story is structurally similar to Solarflare's but with different names and a different architecture: VMA (the OpenOnload analogue), ASAP2 (the OVS offload), SR-IOV (the virtualization primitive), and direct rdma-core/DPDK access for the rest.

This chapter is the practitioner's guide for Mellanox-on-the-fast-path: what each acceleration option does, when to choose it, and what an exchange feed handler looks like sitting on top.

### VMA: Mellanox Messaging Accelerator

VMA (`libvma`) is the LD_PRELOAD socket bypass for Mellanox NICs. The model is the same as OpenOnload: intercept BSD socket calls, run UDP and TCP in userspace against the NIC ring. Performance is competitive: ~600 ns UDP recv, ~1.5us TCP recv on a CX-6 with the right tuning. VMA peaked in popularity around 2014-2018, when many HFT firms ran multicast feed handlers on it. It still ships and works.

```bash
LD_PRELOAD=libvma.so VMA_TRACELEVEL=3 ./feed_handler
```

The trace output dumps which sockets are accelerated and which fall back to the kernel. Common reasons for fallback: socket type not supported (raw, packet), socket option not accelerated, multicast group not in the offload list. Mismatch is silent unless you check.

Production tuning:

```bash
export VMA_RX_POLL=-1                 # infinite poll, no interrupts
export VMA_SELECT_POLL=-1
export VMA_SPEC=latency               # latency profile
export VMA_THREAD_MODE=2              # multi-thread no-lock
export VMA_RING_ALLOCATION_LOGIC_RX=20  # one ring per socket
export VMA_TIMESTAMP=ENABLED          # hw timestamps on recv
```

VMA is older than DPDK and increasingly Mellanox steers customers to use raw verbs or DPDK directly for new development. For a green-field project on Mellanox, DPDK or raw rdma-core is usually the right answer. VMA is the migration path for legacy BSD-socket apps that cannot be rewritten.

### ASAP2: Accelerated Switching and Packet Processing

ASAP2 is Mellanox's name for vSwitch offload. The kernel runs Open vSwitch (OVS) in slow path, the NIC enforces flow-table entries in hardware (TC flower or rte_flow rules). For a hypervisor host running tens of VMs with VXLAN encap, security group rules, and NAT, ASAP2 moves the per-packet work from the host CPU into the NIC, freeing roughly an entire core per 25 Gbit of traffic.

```bash
# Switch the NIC to "switchdev" mode
echo switchdev > /sys/class/net/eth0/compat/devlink/mode
# OVS uses tc-flower offload through ASAP2
ovs-vsctl set Open_vSwitch . other_config:hw-offload=true
```

ASAP2 matters for cloud and CDN deployments. It is unrelated to HFT latency tuning but worth knowing because every hyperscaler runs it and questions about its tradeoffs come up in network-track interviews.

### SR-IOV and Virtual Functions

SR-IOV (Single Root I/O Virtualization) is a PCIe feature that lets one physical NIC expose multiple Virtual Functions (VFs), each with its own PCI BDF, MAC, and queue set. The hypervisor binds each VF to a guest VM. The guest sees what looks like a dedicated NIC and can drive it with its own DPDK or kernel driver.

```bash
echo 8 > /sys/class/net/eth0/device/sriov_numfs
lspci | grep -i mellanox
# 81:00.0 Ethernet controller: Mellanox ConnectX-6
# 81:00.2 Ethernet controller: Mellanox ConnectX-6 Virtual Function
# ... (one per VF)
```

A VF is the right primitive for "give a guest VM kernel-bypass without giving it the whole NIC." Hyperscaler trading platforms (e.g., AWS-hosted HFT, Equinix bare metal in the cloud) use SR-IOV VFs assigned to guest VMs that then run DPDK, ef_vi, or rdma-core directly inside the guest.

### Exchange Feed Handlers: ITCH, OUCH, OPRA

The canonical low-latency networking workloads on Mellanox or Solarflare are exchange data feeds. The major formats:

- **Nasdaq ITCH 5.0** (TotalView). Multicast UDP, binary fixed-format messages, message-sequence-numbered. Around 6 Mpps peak globally, with bursts to 10 Mpps. Each message: 1 byte type, fixed layout following.
- **Nasdaq OUCH 5.0** (Order Entry). TCP, binary messages, used for placing and modifying orders. Stateful, needs full TCP semantics (reliability, ordering, retransmit).
- **CME iLink 3** (Order Entry to CME Globex). TCP, FIX SBE encoded messages. Same role as OUCH but for futures.
- **CME MDP 3.0** (Market By Order). UDP multicast, FIX SBE encoded. ~2 Mpps peak.
- **OPRA** (Options Price Reporting Authority). Multicast UDP, the highest pps feed in the industry, peaks at 50+ Mpps across roughly 50 lines.

A feed handler's job: consume the multicast UDP stream, parse the binary messages with zero copies and minimal branches, update an internal book or queue, hand off to strategy. Latency budget from packet arrival to strategy is typically 800 ns to 2 microseconds depending on firm.

### A Skeleton ITCH Feed Handler on DPDK

Wire format for a few ITCH 5.0 messages, big-endian:

```cpp
#pragma pack(push, 1)
struct ItchHeader {
    char     type;            // 'A' add, 'D' delete, 'E' execute, 'P' trade, ...
    uint16_t stock_locate;
    uint16_t tracking_number;
    uint8_t  timestamp[6];    // ns since midnight, 48-bit big-endian
};
struct ItchAdd {
    ItchHeader hdr;           // type 'A'
    uint64_t   order_ref;
    char       side;          // 'B' or 'S'
    uint32_t   shares;
    char       stock[8];
    uint32_t   price;         // fixed-point /10000
};
struct ItchExecute {
    ItchHeader hdr;           // type 'E'
    uint64_t   order_ref;
    uint32_t   shares;
    uint64_t   match_number;
};
#pragma pack(pop)
```

The hot path with DPDK and an ITCH-aware book object:

```cpp
#include <rte_mbuf.h>
#include <rte_byteorder.h>
#include "order_book.h"   // see chapter 13

static OrderBook g_book;

static inline uint64_t itch_ts(const uint8_t* p) {
    return (uint64_t(p[0]) << 40) | (uint64_t(p[1]) << 32)
         | (uint64_t(p[2]) << 24) | (uint64_t(p[3]) << 16)
         | (uint64_t(p[4]) <<  8) |  uint64_t(p[5]);
}

static inline void process_itch(const uint8_t* msg, uint16_t len) {
    if (len < sizeof(ItchHeader)) return;
    switch (msg[0]) {
    case 'A': {
        const auto* a = reinterpret_cast<const ItchAdd*>(msg);
        g_book.on_add(rte_be_to_cpu_64(a->order_ref),
                      a->side,
                      rte_be_to_cpu_32(a->shares),
                      a->stock,
                      rte_be_to_cpu_32(a->price),
                      itch_ts(a->hdr.timestamp));
        break;
    }
    case 'E': {
        const auto* e = reinterpret_cast<const ItchExecute*>(msg);
        g_book.on_execute(rte_be_to_cpu_64(e->order_ref),
                          rte_be_to_cpu_32(e->shares),
                          itch_ts(e->hdr.timestamp));
        break;
    }
    case 'D': /* ... */ break;
    case 'X': /* ... */ break;
    case 'P': /* ... */ break;
    }
}

static inline void rx_burst(rte_mbuf** burst, uint16_t n) {
    for (uint16_t i = 0; i < n; i++) {
        rte_mbuf* m = burst[i];
        // Skip Ethernet (14) + IPv4 (20) + UDP (8) = 42 bytes,
        // assuming no VLAN and no IP options. In production, parse properly
        const uint8_t* udp_payload =
            rte_pktmbuf_mtod_offset(m, const uint8_t*, 42);
        const uint16_t plen = m->pkt_len - 42;

        // ITCH is wrapped in MoldUDP64 framing - iterate messages
        const uint8_t* p   = udp_payload + 20;       // MoldUDP header
        const uint16_t cnt = rte_be_to_cpu_16(*reinterpret_cast<const uint16_t*>(udp_payload + 18));
        const uint8_t* end = udp_payload + plen;
        for (uint16_t k = 0; k < cnt && p < end; k++) {
            const uint16_t mlen = rte_be_to_cpu_16(*reinterpret_cast<const uint16_t*>(p));
            p += 2;
            process_itch(p, mlen);
            p += mlen;
        }
        rte_pktmbuf_free(m);
    }
}
```

What is happening at the speed-of-cache level:

- Single pass over each message, no allocations, no copies.
- Big-endian conversions vectorize on x86 via `bswap` / `movbe`.
- `process_itch` dispatches on a single byte. Because ITCH's 'A' is by far the most common, branch prediction nails it.
- The order book uses pre-allocated arrays and intrusive lists (chapter 13).
- MoldUDP framing is parsed inline, sequence-gap detection lives elsewhere and triggers a glance-recovery process.

### Recovery: Lost Packets in Multicast

Exchange feeds are UDP multicast over a redundant pair of A/B feeds. The expected operation: subscribe to both, dedupe by sequence number, only one path is needed. Real life: both paths drop, occasionally simultaneously. Recovery is via:

- **MoldUDP64 retransmission requests** (request server addresses published in the spec). Send sequence-number range, get unicast replay.
- **Glimpse** (point-in-time book snapshot). Subscribe at startup, consume snapshot then start applying live updates from a known sequence number.

A production feed handler implements both, with budget-aware fallback (do not stall the live path waiting on retransmit).

### What "Cisco" Means in This Context

"Cisco" here also refers to:

- **Cisco Nexus 3550** (chapter 08), the canonical sub-100ns switch.
- **Cisco Tools** like Pensando DSC (after the AMD Pensando acquisition the Cisco SiliconOne and Pensando lines aligned).
- The **Cisco Nexus 9000 series** with Tetration / Nexus Dashboard, common in CDN and cloud spines.

For HFT, the 3550 is what you cable to. For datacenter spine, Nexus 9000 (or Mellanox Spectrum, or Arista 7060) is the choice. The Mellanox/Spectrum and Cisco/Nexus debate is largely operational rather than performance.

> Junior engineer pitfall: implementing an ITCH feed handler that does `memcpy` and `std::string` per message and submits "we lose a few percent during open."
> Senior FAANG move: zero-copy parse, pre-allocated book, dual-feed dedupe, MoldUDP retransmit and Glimpse snapshot ready before market open, with HdrHistogram per-message latencies emitted to a separate observer process via shared memory ring (chapter 10).
