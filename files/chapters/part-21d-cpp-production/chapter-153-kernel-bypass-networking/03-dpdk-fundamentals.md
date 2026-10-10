## DPDK Fundamentals: PMD, Mempool, mbuf, EAL, lcore

The Data Plane Development Kit (DPDK) is the dominant kernel-bypass framework in the Linux world. It started as an Intel project in 2010, became a Linux Foundation project in 2017, and as of the current LTS releases (23.11 and 24.11) supports more than 30 NIC families across Intel, Mellanox/Nvidia, Broadcom, AMD/Pensando, Marvell, and others. The model has remained stable for a decade: poll-mode drivers, hugepage-backed memory, ring queues, and an explicit core-pinning runtime called the EAL.

This chapter walks through the DPDK programming model and ends with a working C++ packet bouncer that initializes EAL, allocates a mempool, configures a port, and forwards packets between two ports at line rate.

### The Poll Mode Driver Model

DPDK NIC drivers do not use interrupts. They are linked into the application as `librte_net_<vendor>` (e.g., `librte_net_mlx5`, `librte_net_ixgbe`) and consist of two parts:

- A control-plane half that uses the kernel's vfio-pci or uio driver to claim ownership of the NIC's PCI BARs.
- A data-plane half (the PMD itself) that runs in userspace and reads/writes NIC descriptor rings via memory-mapped MMIO.

Once the EAL probes the NIC and the application calls `rte_eth_dev_start`, the kernel is no longer involved in moving packets. The NIC writes incoming packets into rings of buffers in hugepage-backed RAM that the application has pre-allocated and posted descriptors for. The application calls `rte_eth_rx_burst` in a tight loop, which reads up to N descriptors, returns them as `rte_mbuf*` array, and re-arms the ring. There is no syscall, no interrupt, no copy.

The cost: a CPU core spinning at 100% even when no packets arrive. This is the trade. Bypass means budgeting a core (or several) per port that you accept will pin to ceiling regardless of load.

### Hugepages: Why and How

NICs do DMA using physical addresses (or IOMMU-mapped DMA addresses on systems with VT-d/SMMU enabled). DPDK gives the NIC a pool of buffers and the NIC fills them. For DMA correctness, those buffers must be physically contiguous within each buffer (a single packet cannot straddle a 4KB page boundary in a way that crosses a discontinuity). For TLB efficiency, we want few mappings.

Hugepages solve both problems. On x86_64, 2 MiB and 1 GiB hugepage sizes are standard. A 1 GiB hugepage is one TLB entry covering 256 thousand 4 KiB pages worth of memory. DPDK requires hugepages and will refuse to start without them.

Allocate hugepages at boot via the kernel command line:

```
default_hugepagesz=1G hugepagesz=1G hugepages=8 hugepagesz=2M hugepages=2048
```

Or at runtime:

```bash
echo 8 | sudo tee /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
sudo mkdir -p /mnt/huge1G
sudo mount -t hugetlbfs -o pagesize=1G nodev /mnt/huge1G
```

Verify:

```bash
grep Huge /proc/meminfo
cat /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
```

NUMA matters. On a two-socket box, you need hugepages on each socket, and you need to allocate the mempool for a port on the same NUMA node that the port is electrically connected to. `lspci -vv -s <bdf> | grep NUMA` tells you which node a NIC is on. Mismatch costs roughly 100 to 150 ns per packet from the inter-socket QPI/UPI hop.

### mbuf and Mempool

The DPDK packet container is `struct rte_mbuf`. Compared to `sk_buff`, it is much smaller (128 bytes of metadata plus headroom, vs 200+ for skb) and aligned to a cache line. An mbuf carries a packet's data area, length, port number, RSS hash, offload flags, and chain pointers (for multi-segment packets larger than a single buffer).

Mbufs come from a `rte_mempool`, a per-NUMA pool of fixed-size objects backed by hugepages. The mempool has a multi-producer multi-consumer ring inside it, plus a per-lcore cache to avoid hitting the ring on every alloc/free.

```cpp
constexpr unsigned NUM_MBUFS  = 8191;          // power of two minus one is best
constexpr unsigned CACHE_SIZE = 250;
constexpr unsigned MBUF_DATA_ROOM = RTE_MBUF_DEFAULT_BUF_SIZE; // 2048 + headroom

rte_mempool* pool = rte_pktmbuf_pool_create(
    "mbuf_pool",            // name (unique per process)
    NUM_MBUFS,              // n elements
    CACHE_SIZE,             // per-lcore cache
    0,                      // private data size
    MBUF_DATA_ROOM,         // data room per mbuf
    rte_socket_id());       // NUMA socket
if (!pool) rte_panic("Cannot create mbuf pool: %s\n", rte_strerror(rte_errno));
```

Sizing the pool requires care. RX rings consume mbufs whenever the NIC fills a slot. TX rings consume them in flight. Application queues consume them while processing. A reasonable rule: `mempool_size >= (num_ports * (rx_ring_size + tx_ring_size) + num_lcores * burst_size + slack)`. Underflow shows up as RX drops with no obvious cause.

### RX and TX Rings

Each NIC port has one or more RX queues and one or more TX queues, each backed by a descriptor ring. The application configures ring depth (typically 512, 1024, or 2048 entries) and binds each queue to an lcore. Multiple lcores per port require multiple queues plus RSS for distribution.

Setup sequence:

```cpp
struct rte_eth_conf port_conf{};
port_conf.rxmode.mq_mode = RTE_ETH_MQ_RX_RSS;
port_conf.rxmode.offloads = RTE_ETH_RX_OFFLOAD_CHECKSUM;
port_conf.rx_adv_conf.rss_conf.rss_hf =
    RTE_ETH_RSS_IP | RTE_ETH_RSS_TCP | RTE_ETH_RSS_UDP;
port_conf.txmode.mq_mode = RTE_ETH_MQ_TX_NONE;

uint16_t nb_rxd = 1024, nb_txd = 1024;
rte_eth_dev_configure(port, NUM_RX_Q, NUM_TX_Q, &port_conf);
rte_eth_dev_adjust_nb_rx_tx_desc(port, &nb_rxd, &nb_txd);

for (uint16_t q = 0; q < NUM_RX_Q; q++) {
    rte_eth_rx_queue_setup(port, q, nb_rxd,
        rte_eth_dev_socket_id(port), nullptr, pool);
}
for (uint16_t q = 0; q < NUM_TX_Q; q++) {
    rte_eth_tx_queue_setup(port, q, nb_txd,
        rte_eth_dev_socket_id(port), nullptr);
}
rte_eth_dev_start(port);
rte_eth_promiscuous_enable(port);
```

`rte_eth_dev_adjust_nb_rx_tx_desc` clamps your requested ring depth into the driver's supported range. Skipping it gives confusing failures on different hardware.

### EAL Initialization and lcore Model

The Environment Abstraction Layer (EAL) is the runtime. It parses arguments, allocates hugepages, probes PCI devices, and pins threads to CPUs. It is initialized exactly once per process via `rte_eal_init(argc, argv)`. Typical command line:

```bash
sudo ./bouncer -l 0,2,4,6 -n 4 -a 0000:81:00.0 -a 0000:81:00.1 \
    --proc-type=primary --huge-dir=/mnt/huge1G --
```

The arguments mean: use cores 0, 2, 4, 6 (skipping HT siblings), 4 memory channels, allow these two PCI BDFs (everything else is invisible to DPDK), primary process, hugepages from this dir, double-dash separates EAL args from app args.

The lcore model: lcore 0 is the "main" lcore, by convention the control thread. Worker lcores are launched with `rte_eal_remote_launch(fn, arg, lcore_id)`. They run pinned to that physical CPU. The main lcore can also do work, many apps use 0 as control + RX, 2/4/6 as worker pipelines.

### A Working C++ Bouncer

The "hello world" of DPDK: receive on port A, send back out the same port (or to port B). This is enough to verify your setup.

```cpp
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_lcore.h>
#include <cstdio>
#include <cstdint>

constexpr uint16_t BURST = 32;
constexpr uint16_t RING_SIZE = 1024;
static volatile bool g_stop = false;

static int worker_loop(void* arg) {
    auto port = reinterpret_cast<uintptr_t>(arg);
    rte_mbuf* bufs[BURST];
    while (!g_stop) {
        const uint16_t n = rte_eth_rx_burst(port, 0, bufs, BURST);
        if (!n) continue;
        for (uint16_t i = 0; i < n; i++) {
            // swap mac addresses in place to make this a true echo
            auto* eth = rte_pktmbuf_mtod(bufs[i], rte_ether_hdr*);
            rte_ether_addr tmp = eth->dst_addr;
            eth->dst_addr = eth->src_addr;
            eth->src_addr = tmp;
        }
        const uint16_t sent = rte_eth_tx_burst(port, 0, bufs, n);
        for (uint16_t i = sent; i < n; i++) rte_pktmbuf_free(bufs[i]);
    }
    return 0;
}

int main(int argc, char** argv) {
    int ret = rte_eal_init(argc, argv);
    if (ret < 0) rte_panic("EAL init failed\n");
    argc -= ret; argv += ret;

    const uint16_t nb_ports = rte_eth_dev_count_avail();
    if (nb_ports == 0) rte_panic("no ethernet ports available\n");

    rte_mempool* pool = rte_pktmbuf_pool_create(
        "MBUF_POOL", 8191, 250, 0,
        RTE_MBUF_DEFAULT_BUF_SIZE, rte_socket_id());
    if (!pool) rte_panic("mempool create failed\n");

    uint16_t port_id;
    RTE_ETH_FOREACH_DEV(port_id) {
        rte_eth_conf cfg{};
        cfg.rxmode.mq_mode = RTE_ETH_MQ_RX_NONE;
        rte_eth_dev_configure(port_id, 1, 1, &cfg);
        uint16_t nb_rxd = RING_SIZE, nb_txd = RING_SIZE;
        rte_eth_dev_adjust_nb_rx_tx_desc(port_id, &nb_rxd, &nb_txd);
        rte_eth_rx_queue_setup(port_id, 0, nb_rxd,
            rte_eth_dev_socket_id(port_id), nullptr, pool);
        rte_eth_tx_queue_setup(port_id, 0, nb_txd,
            rte_eth_dev_socket_id(port_id), nullptr);
        rte_eth_dev_start(port_id);
        rte_eth_promiscuous_enable(port_id);
    }

    // launch one worker per port on its own lcore
    uint16_t lcore = rte_get_next_lcore(-1, 1, 0);
    RTE_ETH_FOREACH_DEV(port_id) {
        rte_eal_remote_launch(worker_loop,
            reinterpret_cast<void*>(uintptr_t(port_id)), lcore);
        lcore = rte_get_next_lcore(lcore, 1, 0);
    }

    rte_eal_mp_wait_lcore();
    rte_eal_cleanup();
    return 0;
}
```

Build with a Makefile that includes DPDK's pkg-config:

```makefile
PKGCONF ?= pkg-config
CFLAGS  := -O3 -march=native $(shell $(PKGCONF) --cflags libdpdk)
LDFLAGS := $(shell $(PKGCONF) --libs libdpdk)

bouncer: bouncer.cpp
	g++ -std=c++20 $(CFLAGS) $< -o $@ $(LDFLAGS)
```

Run it on a host with two ports cabled together (or one port in loopback) and a packet generator on the other side:

```bash
sudo ./bouncer -l 0,2 -n 4 -a 0000:81:00.0 -a 0000:81:00.1 -- 
```

A 100 Gbit Mellanox ConnectX-6 with this code will forward 64-byte frames at roughly 90 Mpps per port. The ceiling depends on PCIe gen and CPU, on a Sapphire Rapids host with PCIe gen5 you can saturate the link.

### NUMA-Aware Port Assignment

The two costly mistakes new DPDK users make:

1. Allocating the mempool on socket 0 while the port lives on socket 1. Every packet pays a UPI crossing on RX and TX, roughly 100 ns each way.
2. Pinning the worker lcore to socket 0 while the mempool and port are on socket 1. Same problem, plus the descriptor ring writes are remote.

The right pattern: query `rte_eth_dev_socket_id(port)`, allocate the mempool on that socket, pick lcores from `rte_lcore_to_socket_id(lcore) == port_socket`. The skeleton:

```cpp
int port_numa = rte_eth_dev_socket_id(port_id);
auto* pool = rte_pktmbuf_pool_create("p0", 8191, 250, 0,
    RTE_MBUF_DEFAULT_BUF_SIZE, port_numa);
unsigned lcore;
RTE_LCORE_FOREACH_WORKER(lcore) {
    if (int(rte_lcore_to_socket_id(lcore)) == port_numa) {
        rte_eal_remote_launch(worker_loop, &port_id, lcore);
        break;
    }
}
```

> Junior engineer mistake: launching a DPDK app and being satisfied that it forwards packets, without checking NUMA placement.
> Senior FAANG move: instrument with `rte_eth_xstats_get`, check that `rx_q0_packets`, `rx_out_of_buffer`, and `tx_q0_packets` line up, look at PCIe use with `lspci -vv -s <bdf>`, and confirm the mempool is on the right NUMA node before declaring victory.

### Primary and Secondary Processes

DPDK supports multiple processes sharing the same hugepage memory. The "primary" process owns the EAL, allocates mempools, and drives the NIC. "Secondary" processes attach (`--proc-type=secondary`) and can lookup mempools by name, allocate their own rings, and run pipelines that the primary feeds via shared rings. This is how production data planes split (control plane in one process, fast path in another), and how observability works (a separate process attaches to dump per-mempool stats).
