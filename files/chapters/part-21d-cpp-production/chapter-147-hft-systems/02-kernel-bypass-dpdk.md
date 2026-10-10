## Kernel Bypass: DPDK

The Linux kernel's network stack is an engineering masterpiece designed to handle arbitrary workloads fairly across thousands of concurrent processes. For HFT, that generality is the problem. Context switches, interrupt handlers, socket buffer copies, and the full TCP/IP protocol stack add 50-200 μs to packet processing. DPDK eliminates all of it.

### Why the Kernel Is the Bottleneck

When a packet arrives at a standard Linux NIC:

1. The NIC raises a hardware interrupt.
2. The kernel's interrupt handler runs, consuming cycles on whatever core it interrupts.
3. The packet is DMA'd into a kernel socket buffer.
4. The kernel processes the IP and UDP headers.
5. The application calls `recvfrom()`, triggering a context switch and a `memcpy` from kernel space to user space.

Each of these steps is cheap in isolation. Together they add up to 50-200 μs of latency and constant jitter. The context switch alone costs 1,000-10,000 cycles depending on cache state.

### DPDK Architecture

DPDK (Data Plane Development Kit) bypasses the kernel entirely. The application takes ownership of the NIC, reads packets directly from NIC descriptor rings in user space, and processes them with zero kernel involvement and zero copies.

Key concepts:

- **PMD (Poll Mode Driver)**: replaces interrupt-driven I/O with a polling loop. The CPU spins on the NIC descriptor ring, consuming 100% of one core but achieving < 1 μs latency.
- **Hugepages**: DPDK uses 2 MB or 1 GB hugepages for DMA buffers, reducing TLB pressure and eliminating page faults.
- **`rte_mempool`**: a lock-free pool of pre-allocated `rte_mbuf` structures. No allocation on the hot path.
- **`rte_mbuf`**: DPDK's packet buffer. Contains packet metadata and a pointer to the actual packet data in a hugepage-backed buffer.
- **CPU affinity**: `rte_eal_init` pins each RX queue worker to a dedicated isolated core.

### Setting Up Hugepages and DPDK EAL

DPDK requires 2 MB hugepages pre-allocated at boot time via `nr_hugepages` and mounted on `hugetlbfs` so the DPDK EAL can create large contiguous DMA buffers without TLB thrash. Binding the NIC to `vfio-pci` hands ownership of the physical device from the kernel's network stack to DPDK's poll-mode driver, which is what enables user-space packet I/O and eliminates the kernel interrupt and `copy_to_user` overhead that caps standard sockets at ~1 µs latency.
```bash
# Reserve 2 GB of 2 MB hugepages (adjust for your system)
echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Mount hugetlbfs
mkdir -p /mnt/huge
mount -t hugetlbfs nodev /mnt/huge

# Bind the NIC to DPDK's vfio-pci driver (unbind from kernel driver first)
# Find the PCI address with: dpdk-devbind.py --status
dpdk-devbind.py --bind=vfio-pci 0000:01:00.0

# Verify
dpdk-devbind.py --status-dev net
```

### The DPDK RX Loop

This is the core of a DPDK-based market data receiver. It receives raw UDP packets directly from the NIC, parses Ethernet/IP/UDP headers in-place, and dispatches market data payloads without a single copy or syscall:

```cpp
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_ether.h>
#include <rte_ip.h>
#include <rte_udp.h>
#include <rte_mempool.h>

static constexpr uint16_t RX_RING_SIZE    = 1024;
static constexpr uint16_t TX_RING_SIZE    = 1024;
static constexpr uint16_t BURST_SIZE      = 32;
static constexpr uint16_t NUM_MBUFS       = 8191;   // Must be (2^N - 1)
static constexpr uint16_t MBUF_CACHE_SIZE = 250;

// Configure a DPDK port (NIC) for receive
int configure_port(uint16_t port_id, rte_mempool* mbuf_pool) {
    rte_eth_conf port_conf{};
    // Disable all offloads for minimum latency - don't let the NIC
    // scatter-gather or reorder anything
    port_conf.rxmode.max_lro_pkt_size = RTE_ETHER_MAX_LEN;

    int ret = rte_eth_dev_configure(port_id, 1, 1, &port_conf);
    if (ret < 0) return ret;

    // Set up one RX queue
    ret = rte_eth_rx_queue_setup(
        port_id, 0, RX_RING_SIZE,
        rte_eth_dev_socket_id(port_id),
        nullptr,    // default RX config
        mbuf_pool
    );
    if (ret < 0) return ret;

    // Set up one TX queue (for order sending)
    ret = rte_eth_tx_queue_setup(
        port_id, 0, TX_RING_SIZE,
        rte_eth_dev_socket_id(port_id),
        nullptr     // default TX config
    );
    if (ret < 0) return ret;

    return rte_eth_dev_start(port_id);
}

// Inline header parsing -- no memcpy, parse packet data in-place
struct ParsedPacket {
    const uint8_t* payload;
    uint16_t       payload_len;
    uint32_t       src_ip;
    uint16_t       src_port;
    uint16_t       dst_port;
};

inline bool parse_udp_packet(rte_mbuf* mbuf, ParsedPacket& out) {
    const uint8_t* data = rte_pktmbuf_mtod(mbuf, const uint8_t*);
    uint16_t data_len   = rte_pktmbuf_data_len(mbuf);

    // Ethernet header: 14 bytes
    if (data_len < sizeof(rte_ether_hdr)) return false;
    const auto* eth = reinterpret_cast<const rte_ether_hdr*>(data);

    // Only handle IPv4
    if (rte_be_to_cpu_16(eth->ether_type) != RTE_ETHER_TYPE_IPV4) return false;

    // IPv4 header
    const auto* ip = reinterpret_cast<const rte_ipv4_hdr*>(
        data + sizeof(rte_ether_hdr)
    );
    uint16_t ip_hdr_len = (ip->version_ihl & 0x0F) * 4;
    if (ip->next_proto_id != IPPROTO_UDP) return false;

    // UDP header: 8 bytes
    const auto* udp = reinterpret_cast<const rte_udp_hdr*>(
        data + sizeof(rte_ether_hdr) + ip_hdr_len
    );

    out.src_ip      = rte_be_to_cpu_32(ip->src_addr);
    out.src_port    = rte_be_to_cpu_16(udp->src_port);
    out.dst_port    = rte_be_to_cpu_16(udp->dst_port);
    out.payload     = reinterpret_cast<const uint8_t*>(udp + 1);
    out.payload_len = rte_be_to_cpu_16(udp->dgram_len) - sizeof(rte_udp_hdr);

    return true;
}

// The main RX loop -- runs on a dedicated isolated core, never returns
[[noreturn]] void rx_loop(uint16_t port_id, MarketDataHandler& handler) {
    rte_mbuf* mbufs[BURST_SIZE];

    while (true) {
        // Poll for packets -- no interrupt, no context switch, no syscall
        uint16_t nb_rx = rte_eth_rx_burst(port_id, 0, mbufs, BURST_SIZE);

        for (uint16_t i = 0; i < nb_rx; ++i) {
            uint64_t arrival_tsc = rdtsc_relaxed();  // Timestamp immediately

            ParsedPacket pkt;
            if (likely(parse_udp_packet(mbufs[i], pkt))) {
                handler.on_packet(
                    pkt.payload,
                    pkt.payload_len,
                    arrival_tsc,
                    pkt.src_ip,
                    pkt.dst_port
                );
            }

            rte_pktmbuf_free(mbufs[i]);  // Return mbuf to pool
        }
        // No sleep, no yield -- we spin. This core is 100% dedicated to this.
    }
}
```

### Sending Orders with DPDK TX

For order submission, build the packet manually and transmit via `rte_eth_tx_burst`:

```cpp
void send_order(uint16_t port_id, rte_mempool* pool,
                uint32_t dst_ip, uint16_t dst_port,
                const void* order_payload, uint16_t payload_len)
{
    rte_mbuf* mbuf = rte_pktmbuf_alloc(pool);
    if (unlikely(!mbuf)) return;  // Pool exhausted -- should never happen

    uint16_t total_len = sizeof(rte_ether_hdr) +
                         sizeof(rte_ipv4_hdr)  +
                         sizeof(rte_udp_hdr)   +
                         payload_len;

    uint8_t* data = rte_pktmbuf_append(mbuf, total_len);

    // Fill Ethernet header
    auto* eth = reinterpret_cast<rte_ether_hdr*>(data);
    rte_ether_addr_copy(&kSrcMac, &eth->src_addr);
    rte_ether_addr_copy(&kDstMac, &eth->dst_addr);
    eth->ether_type = rte_cpu_to_be_16(RTE_ETHER_TYPE_IPV4);

    // Fill IP header
    auto* ip = reinterpret_cast<rte_ipv4_hdr*>(eth + 1);
    ip->version_ihl     = 0x45;  // IPv4, 20-byte header
    ip->type_of_service = 0x10;  // DSCP: low delay
    ip->total_length    = rte_cpu_to_be_16(total_len - sizeof(rte_ether_hdr));
    ip->next_proto_id   = IPPROTO_UDP;
    ip->src_addr        = kSrcIp;
    ip->dst_addr        = rte_cpu_to_be_32(dst_ip);
    ip->hdr_checksum    = rte_ipv4_cksum(ip);

    // Fill UDP header
    auto* udp = reinterpret_cast<rte_udp_hdr*>(ip + 1);
    udp->src_port   = rte_cpu_to_be_16(kSrcPort);
    udp->dst_port   = rte_cpu_to_be_16(dst_port);
    udp->dgram_len  = rte_cpu_to_be_16(sizeof(rte_udp_hdr) + payload_len);
    udp->dgram_cksum = 0;  // UDP checksum optional

    // Copy payload
    std::memcpy(udp + 1, order_payload, payload_len);

    // Transmit -- typically completes in < 1 μs
    uint16_t sent = rte_eth_tx_burst(port_id, 0, &mbuf, 1);
    if (unlikely(sent == 0)) rte_pktmbuf_free(mbuf);
}
```

### Alternatives to DPDK

**Solarflare OpenOnload** is a kernel bypass solution that works through the standard socket API. Applications link against OpenOnload and get kernel bypass with no code changes. It is simpler to deploy than DPDK but offers less control over the packet path. Latency is typically 1-2 μs, slightly higher than a carefully tuned DPDK application.

**Mellanox OFED + RDMA** (now NVIDIA RDMA) provides sub-500 ns message delivery via RDMA (Remote Direct Memory Access). The sender writes directly into the receiver's memory, bypassing both sender and receiver kernels. Used heavily for inter-process messaging within a colocation facility.

### Go Comparison

Go cannot use DPDK directly. DPDK is a C library that assumes full control over the NIC and uses C-specific memory models. A CGo bridge is technically possible but defeats the purpose: CGo calls take ~100 ns overhead per call, and the CGo thread model prevents Go from running goroutines on DPDK-owned cores. Some firms use DPDK in a dedicated C++ process and communicate with a Go strategy process via shared memory ring buffers, but the latency-critical path remains entirely in C++.

---
