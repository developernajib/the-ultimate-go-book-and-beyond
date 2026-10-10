## DPDK Advanced: rte_flow, RSS, Hardware Offloads, Building a 100Gbit Receiver

The bouncer in chapter 03 used a single RX queue and a single lcore. That works to about 14.88 Mpps (line rate of 10 GbE at 64 byte frames). To push 100 GbE we need parallelism: multiple RX queues, an RSS hash that distributes flows across them, and a worker lcore per queue. To keep CPU low, we offload as much per-packet work as possible to the NIC. This chapter is the practical guide.

### RSS: Receive Side Scaling

RSS is hardware support for hashing the packet 4-tuple (or 5-tuple, or 2-tuple, configurable) and indirecting to one of N RX queues. The hash is typically Toeplitz with a 40-byte key. The NIC has an indirection table (often 128 or 512 entries) mapping hash bucket to queue.

Symmetric RSS is important for any application that wants both directions of a flow on the same lcore (DPI, NAT, stateful firewall, TCP termination). Microsoft's symmetric Toeplitz key is the standard:

```cpp
static uint8_t kSymToeplitz[40] = {
  0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a,
  0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a,
  0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a,
  0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a,
  0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a, 0x6d, 0x5a,
};

rte_eth_conf conf{};
conf.rxmode.mq_mode = RTE_ETH_MQ_RX_RSS;
conf.rx_adv_conf.rss_conf.rss_key     = kSymToeplitz;
conf.rx_adv_conf.rss_conf.rss_key_len = sizeof(kSymToeplitz);
conf.rx_adv_conf.rss_conf.rss_hf =
    RTE_ETH_RSS_IP | RTE_ETH_RSS_TCP | RTE_ETH_RSS_UDP;
```

After `rte_eth_dev_configure`, you can rewrite the indirection table to balance more carefully:

```cpp
rte_eth_rss_reta_entry64 reta[8]{};
const uint16_t reta_size = 128; // dev_info.reta_size
for (uint16_t i = 0; i < reta_size; i++) {
    reta[i / RTE_ETH_RETA_GROUP_SIZE].mask = ~0ull;
    reta[i / RTE_ETH_RETA_GROUP_SIZE].reta[i % RTE_ETH_RETA_GROUP_SIZE]
        = i % NUM_RX_Q;
}
rte_eth_dev_rss_reta_update(port, reta, reta_size);
```

### rte_flow: The Real API

RSS is the simple case. Real production NICs support far richer steering via `rte_flow`, which exposes a generic match-action language. You describe a pattern (eth + ipv4 + udp + dst_port == 14310) and an action (queue 3, drop, mark, count, rss-over-subset). The hardware compiles this into TCAM entries (Mellanox), or table entries (Intel), or whatever the NIC supports.

A common HFT pattern: market data multicast lands on dedicated queues, order entry lands on a different queue, everything else drops:

```cpp
rte_flow_attr attr{};
attr.ingress = 1;
attr.priority = 1;

// Pattern: IPv4 multicast UDP destined to 224.0.0.0/4
rte_flow_item_eth   eth_spec{}, eth_mask{};
rte_flow_item_ipv4  ip_spec{},  ip_mask{};
ip_spec.hdr.dst_addr = rte_cpu_to_be_32(0xE0000000); // 224.0.0.0
ip_mask.hdr.dst_addr = rte_cpu_to_be_32(0xF0000000);
rte_flow_item_udp   udp_spec{}, udp_mask{};

rte_flow_item pattern[] = {
    {RTE_FLOW_ITEM_TYPE_ETH,  &eth_spec, nullptr, &eth_mask},
    {RTE_FLOW_ITEM_TYPE_IPV4, &ip_spec,  nullptr, &ip_mask},
    {RTE_FLOW_ITEM_TYPE_UDP,  &udp_spec, nullptr, &udp_mask},
    {RTE_FLOW_ITEM_TYPE_END,  nullptr,   nullptr, nullptr},
};

uint16_t md_queues[] = {0, 1};
rte_flow_action_rss md_rss{};
md_rss.types = RTE_ETH_RSS_UDP;
md_rss.queue_num = 2;
md_rss.queue = md_queues;

rte_flow_action actions[] = {
    {RTE_FLOW_ACTION_TYPE_RSS, &md_rss},
    {RTE_FLOW_ACTION_TYPE_END, nullptr},
};

rte_flow_error err{};
if (rte_flow_validate(port, &attr, pattern, actions, &err) != 0) {
    fprintf(stderr, "flow validate failed: %s\n", err.message);
}
rte_flow* flow = rte_flow_create(port, &attr, pattern, actions, &err);
```

Production HFT installs a default-drop rule at low priority and explicit allows at higher priority. This is a software firewall enforced by the NIC at line rate, with zero CPU cost.

### Hardware Offloads

Modern NICs offload more than steering. Useful offloads, in approximate order of value:

- **Checksum offload (RX and TX).** RX validates IPv4/TCP/UDP checksums and sets `PKT_RX_IP_CKSUM_GOOD` / `PKT_RX_L4_CKSUM_GOOD` flags. TX takes a partial checksum and finalizes it. Saves 50-150 ns per packet on the host.
- **TSO (TCP Segmentation Offload).** Application sends a 64KB blob marked TSO. NIC splits into MSS segments. Critical for bulk transfer at 100+ Gbit.
- **LRO (Large Receive Offload).** NIC merges incoming TCP segments. Only useful in middleboxes that do not retransmit, harmful elsewhere.
- **VLAN insertion / stripping.** Hardware adds or removes the 802.1Q tag.
- **Timestamp on RX.** PHC timestamp written into mbuf metadata. Critical for HFT and PTP, covered in chapter 12.
- **Flow Director / FDIR.** Predecessor to rte_flow on Intel. Still useful on older NICs.
- **DCB (Data Center Bridging).** PFC, ETS, DCBX for lossless Ethernet, mainly used with RoCE.

Enable per-port, after checking what the device supports:

```cpp
rte_eth_dev_info info;
rte_eth_dev_info_get(port, &info);

uint64_t rx_off = RTE_ETH_RX_OFFLOAD_CHECKSUM
                | RTE_ETH_RX_OFFLOAD_VLAN_STRIP
                | RTE_ETH_RX_OFFLOAD_TIMESTAMP;
uint64_t tx_off = RTE_ETH_TX_OFFLOAD_IPV4_CKSUM
                | RTE_ETH_TX_OFFLOAD_TCP_CKSUM
                | RTE_ETH_TX_OFFLOAD_UDP_CKSUM
                | RTE_ETH_TX_OFFLOAD_TCP_TSO;

if ((info.rx_offload_capa & rx_off) != rx_off) {
    fprintf(stderr, "requested RX offloads not supported, want %lx have %lx\n",
        rx_off, info.rx_offload_capa);
}
conf.rxmode.offloads = rx_off & info.rx_offload_capa;
conf.txmode.offloads = tx_off & info.tx_offload_capa;
```

For TSO, set per-mbuf offload flags and the L4 length:

```cpp
mbuf->ol_flags = RTE_MBUF_F_TX_IPV4
               | RTE_MBUF_F_TX_IP_CKSUM
               | RTE_MBUF_F_TX_TCP_SEG;
mbuf->l2_len   = sizeof(rte_ether_hdr);
mbuf->l3_len   = sizeof(rte_ipv4_hdr);
mbuf->l4_len   = sizeof(rte_tcp_hdr);
mbuf->tso_segsz = 1448;  // MSS
```

### A Realistic 100 Gbit/s Receiver

Pulling 100 Gbit/s of small packets is hard. At 64-byte frames it is 148 Mpps, more than any single core can absorb (a single ConnectX-6 RX queue tops out around 30 Mpps in practice). You need 8 to 16 queues, one lcore per queue, and a careful per-packet hot path that avoids cache misses.

Skeleton, with NUMA awareness, RSS, and per-lcore counters:

```cpp
struct LcoreCtx {
    uint16_t port;
    uint16_t queue;
    uint64_t rx_packets;
    uint64_t rx_bytes;
    uint64_t rx_drops;
    char pad[40];   // pad to a cache line
} __attribute__((aligned(64)));

static LcoreCtx g_ctx[RTE_MAX_LCORE];

static int rx_lcore(void* arg) {
    auto* ctx = static_cast<LcoreCtx*>(arg);
    rte_mbuf* burst[64];

    // Touch a TLS slot that the prefetch stride depends on
    while (!g_stop) {
        const uint16_t n = rte_eth_rx_burst(ctx->port, ctx->queue, burst, 64);
        if (n == 0) {
            rte_pause();   // PAUSE instruction to play nice with HT
            continue;
        }

        // Software prefetch the headers of the next batch's payloads
        for (uint16_t i = 0; i < n; i++) {
            rte_prefetch0(rte_pktmbuf_mtod(burst[i], void*));
        }

        ctx->rx_packets += n;
        for (uint16_t i = 0; i < n; i++) {
            ctx->rx_bytes += burst[i]->pkt_len;

            // Confirm hardware checksum was good - drop bad packets early
            const uint64_t fl = burst[i]->ol_flags;
            const bool ip_ok = (fl & RTE_MBUF_F_RX_IP_CKSUM_MASK)
                             != RTE_MBUF_F_RX_IP_CKSUM_BAD;
            const bool l4_ok = (fl & RTE_MBUF_F_RX_L4_CKSUM_MASK)
                             != RTE_MBUF_F_RX_L4_CKSUM_BAD;
            if (!ip_ok || !l4_ok) {
                ctx->rx_drops++;
                rte_pktmbuf_free(burst[i]);
                continue;
            }

            process_packet(burst[i]);   // your business logic
            rte_pktmbuf_free(burst[i]);
        }
    }
    return 0;
}
```

Configuration on the port side: 16 RX queues, 4096-deep ring, RSS over IPv4 + TCP + UDP, checksum and timestamp offload on:

```cpp
constexpr uint16_t NUM_RX_Q = 16;
constexpr uint16_t RING_DEPTH = 4096;

rte_eth_conf conf{};
conf.rxmode.mq_mode = RTE_ETH_MQ_RX_RSS;
conf.rxmode.offloads = RTE_ETH_RX_OFFLOAD_CHECKSUM
                     | RTE_ETH_RX_OFFLOAD_TIMESTAMP;
conf.rx_adv_conf.rss_conf.rss_key = kSymToeplitz;
conf.rx_adv_conf.rss_conf.rss_key_len = 40;
conf.rx_adv_conf.rss_conf.rss_hf =
    RTE_ETH_RSS_IP | RTE_ETH_RSS_TCP | RTE_ETH_RSS_UDP;

rte_eth_dev_configure(port, NUM_RX_Q, 1, &conf);
uint16_t nb_rxd = RING_DEPTH, nb_txd = 256;
rte_eth_dev_adjust_nb_rx_tx_desc(port, &nb_rxd, &nb_txd);

for (uint16_t q = 0; q < NUM_RX_Q; q++) {
    rte_eth_rx_queue_setup(port, q, nb_rxd,
        rte_eth_dev_socket_id(port), nullptr,
        per_socket_pool[rte_eth_dev_socket_id(port)]);
}
rte_eth_tx_queue_setup(port, 0, nb_txd,
    rte_eth_dev_socket_id(port), nullptr);

rte_eth_dev_start(port);
```

Then launch one rx_lcore per queue, on a CPU pinned to the port's NUMA node. With 16 cores at roughly 10 Mpps each, you absorb 160 Mpps, comfortably above 100 GbE's 148 Mpps line rate.

### Common Failures and Their Symptoms

- **`rx_q0_dropped` climbing.** Mempool empty. Increase `NUM_MBUFS` in the pool, or check that you free mbufs after processing.
- **`rx_out_of_buffer`.** RX ring filled before NAPI-equivalent could drain. Increase ring depth, or assign more lcores.
- **`rx_missed_errors`.** NIC dropped at the wire because no descriptor was available. Same fix.
- **Hash imbalance.** Some queues hot, others idle. Check RSS key, RETA configuration, and that the hash function actually covers the protocols you have. UDP-RSS requires explicit `RTE_ETH_RSS_UDP`.
- **Per-flow ordering broken.** Symmetric RSS not configured, both directions of a flow land on different queues. Use the Microsoft symmetric Toeplitz key.

### Hands-on Validation

Generate traffic from another box with `pktgen-dpdk` and watch counters:

```bash
sudo dpdk-testpmd -l 0-3 -n 4 -- -i --rxq=16 --txq=16
testpmd> set fwd rxonly
testpmd> start
testpmd> show port stats all
testpmd> show port xstats 0   # detailed per-queue counters
```

If `rx_q5_packets` is zero while q0 through q4 are saturated, your RSS distribution is broken. Time to look at RETA.

> Junior engineer behavior: setting up RSS once, watching pps go up, declaring success.
> Senior FAANG move: validating per-queue distribution under realistic flow mix, configuring symmetric RSS, installing default-drop rte_flow rules, and producing a per-queue latency histogram before claiming the receiver is production ready.
