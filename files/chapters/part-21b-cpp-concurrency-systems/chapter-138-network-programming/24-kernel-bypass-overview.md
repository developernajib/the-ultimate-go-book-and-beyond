## Kernel Bypass: DPDK, AF_XDP, OpenOnload, RDMA

When the kernel networking stack is the bottleneck, you go around it. "Kernel bypass" is a family of techniques that move packet I/O out of `netif_receive_skb` and into userspace, paying with portability, debuggability, and ecosystem integration. This chapter is the orientation: what each option is, when to choose it, and the C++ shape of the API.

### 1. Why bypass at all

A 100 GbE NIC at line rate is roughly 14.88 Mpps with 64 B frames. The Linux network stack costs hundreds of nanoseconds per packet between IRQ, softirq, `netif_receive_skb`, IP/TCP processing, socket buffers, and `recvmsg`. At 100 ns/packet you cap around 10 Mpps single-core, at 1000 ns/packet you cap at 1 Mpps.

For:
- Trading systems that target sub-microsecond latency,
- Stateful firewalls / DDoS scrubbers with 10s of Mpps,
- 5G UPFs that need 200+ Gbps per node,
- Distributed storage with <10 us tail latency over the network,

the kernel cost is unaffordable. Bypass returns control of the NIC to the application.

### 2. DPDK

DPDK (Intel, 2010, now a Linux Foundation project) is the canonical userspace networking framework. It is C, BSD-licensed, supports every serious NIC vendor, and comes with poll-mode drivers (PMDs), memory pools (`rte_mempool`), packet buffers (`rte_mbuf`), ring queues, hash tables, ACLs, and a giant userspace TCP/IP stack ecosystem (mTCP, F-Stack, VPP).

#### Architecture

- The application boots, binds the NIC away from the kernel driver to `vfio-pci` (or `igb_uio`), and the PMD takes over.
- Each worker core runs a tight loop: `rte_eth_rx_burst` -> process -> `rte_eth_tx_burst`.
- Memory is huge-page-backed and statically allocated.
- No syscalls on the data path.

```cpp
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mempool.h>

int main(int argc, char** argv) {
  rte_eal_init(argc, argv);

  auto* pool = rte_pktmbuf_pool_create("MBUF", 8192, 256,
                                       0, RTE_MBUF_DEFAULT_BUF_SIZE,
                                       rte_socket_id());

  rte_eth_conf cfg{};
  cfg.rxmode.mq_mode = RTE_ETH_MQ_RX_RSS;
  cfg.rx_adv_conf.rss_conf.rss_hf = RTE_ETH_RSS_TCP | RTE_ETH_RSS_UDP;
  rte_eth_dev_configure(0, /*rx*/4, /*tx*/4, &cfg);

  for (int q = 0; q < 4; ++q) {
    rte_eth_rx_queue_setup(0, q, 1024, rte_socket_id(), nullptr, pool);
    rte_eth_tx_queue_setup(0, q, 1024, rte_socket_id(), nullptr);
  }
  rte_eth_dev_start(0);

  rte_eal_remote_launch([](void*) -> int {
    rte_mbuf* burst[32];
    while (true) {
      uint16_t n = rte_eth_rx_burst(0, /*queue*/0, burst, 32);
      for (uint16_t i = 0; i < n; ++i) {
        // process_packet(burst[i]);
      }
      rte_eth_tx_burst(0, /*queue*/0, burst, n);
    }
    return 0;
  }, nullptr, 1);  // pin to lcore 1
  rte_eal_mp_wait_lcore();
}
```

Throughput numbers: a single core can hit 10-20+ Mpps with DPDK, 4 cores saturate a 100 GbE link for typical workloads. Cost: you re-implement TCP/UDP/IP, ARP, ICMP yourself, or import a userspace stack.

#### When DPDK wins

- Pure packet processing (firewalls, NAT, DDoS scrubbing): you do not need TCP at all, just modify and forward.
- Stateless L4 load balancers (Katran's predecessor used DPDK. Katran moved to XDP).
- 5G UPF, telco workloads.
- Trading: DPDK + a custom TCP gives sub-microsecond latencies that no socket can match.

#### When DPDK loses

- You need the kernel's iptables / netfilter / tcpdump / network namespaces. None work. Some can be partially restored via `KNI` (Kernel NIC Interface) or VPP's host stack adapter, but you give up performance to do it.
- You want to share the NIC with regular kernel traffic. Possible via SR-IOV (give one VF to DPDK, another to kernel), but it is a hardware-coupled trick.
- Operability: `tcpdump` becomes "rebuild the binary with packet capture compiled in". Most teams cannot afford that.

### 3. AF_XDP

AF_XDP (Linux 4.18) is "DPDK-lite, in the kernel tree". You attach an XDP eBPF program at the NIC driver hook, the program decides per-packet whether to drop, pass to the kernel stack, redirect to another NIC, or steer to a userspace AF_XDP socket. The userspace socket exposes ring buffers in shared memory between kernel and user.

#### Architecture

```
NIC -> driver -> XDP program
                   |
    +--------------+--------------+
    |       |        |            |
   PASS    DROP   REDIRECT     XSK_REDIRECT (to AF_XDP socket)
    |                            |
  kernel stack                userspace XSK rings (rx, tx, fill, comp)
```

With `XDP_ZEROCOPY` and a supporting NIC (Mellanox ConnectX-5+, Intel i40e/ice/ixgbe), packets DMA directly into UMEM (user-allocated memory pool) without copies.

#### Code

```cpp
#include <xdp/xsk.h>

xsk_umem_config ucfg{
  .fill_size = 4096, .comp_size = 4096,
  .frame_size = 4096, .frame_headroom = 0
};
void* umem_area = std::aligned_alloc(getpagesize(), 4096 * 4096);
xsk_umem* umem;
xsk_ring_prod fill; xsk_ring_cons comp;
xsk_umem__create(&umem, umem_area, 4096 * 4096, &fill, &comp, &ucfg);

xsk_socket_config scfg{
  .rx_size = 2048, .tx_size = 2048,
  .xdp_flags = XDP_FLAGS_DRV_MODE,
  .bind_flags = XDP_ZEROCOPY,
};
xsk_socket* xsk;
xsk_ring_cons rx; xsk_ring_prod tx;
xsk_socket__create(&xsk, "eth0", 0, umem, &rx, &tx, &scfg);

// Pre-fill: tell kernel the addresses it can DMA into
uint32_t idx;
xsk_ring_prod__reserve(&fill, 2048, &idx);
for (uint32_t i = 0; i < 2048; ++i)
  *xsk_ring_prod__fill_addr(&fill, idx + i) = i * 4096;
xsk_ring_prod__submit(&fill, 2048);

while (true) {
  uint32_t ridx;
  uint32_t n = xsk_ring_cons__peek(&rx, 64, &ridx);
  for (uint32_t i = 0; i < n; ++i) {
    auto* desc = xsk_ring_cons__rx_desc(&rx, ridx + i);
    uint8_t* pkt = (uint8_t*)umem_area + desc->addr;
    // process(pkt, desc->len);
  }
  xsk_ring_cons__release(&rx, n);
}
```

XDP program (compiled with clang to BPF):

```c
SEC("xdp")
int redirect_to_xsk(struct xdp_md* ctx) {
  return bpf_redirect_map(&xsks_map, ctx->rx_queue_index, XDP_PASS);
}
```

#### When AF_XDP wins

- You want DPDK-class throughput but need to keep the NIC partially in the kernel.
- You need iptables or routing for some traffic, AF_XDP for the hot subset.
- You need a small, distro-shipped solution -- AF_XDP is in mainline Linux. DPDK is an out-of-tree dependency tree.
- Cilium service mesh fast path, Cloudflare's `udpgrm` family, modern QUIC ingress.

Throughput is generally 70-90% of DPDK on the same NIC. The 10-30% cost is the worth the operability win for many teams.

### 4. Solarflare / OpenOnload

Solarflare (acquired by Xilinx, then AMD) shipped NICs with TCP-direct features and an LD_PRELOAD library called OpenOnload that intercepts socket calls and runs the entire TCP/IP stack in userspace, bypassing the kernel for that process. Unmodified applications using `socket()`, `connect()`, `send()`, `recv()` can be accelerated by setting `LD_PRELOAD=libonload.so`.

Used heavily in financial trading because:

- No code changes -- legacy market-data feeds and order-entry stacks just get faster.
- Sub-microsecond loopback for kernel-bypass between two processes on the same box.
- Hardware timestamping for trade-clock correctness.

When it does not work: NIC-specific (only Solarflare/Xilinx NICs), proprietary, expensive licensing per box, no native support for io_uring or modern async patterns.

Modern alternative on AMD Pensando / Nvidia Bluefield DPUs: hardware-accelerated stacks that use AF_XDP or DPDK underneath but expose socket-like APIs.

### 5. RDMA (verbs API)

RDMA (Remote Direct Memory Access) is a fundamentally different shape: peer-to-peer NIC-to-NIC memory access without CPU involvement on either side after setup. Three transports:

- **InfiniBand**: dedicated lossless fabric, scales to thousands of nodes, used in HPC.
- **RoCE** (RDMA over Converged Ethernet): InfiniBand semantics over Ethernet, requires lossless DCB.
- **iWARP**: RDMA over TCP, lossy, no fabric requirements but lower performance.

The verbs API (`libibverbs`):

```cpp
ibv_context* ctx = ibv_open_device(devices[0]);
ibv_pd* pd = ibv_alloc_pd(ctx);

// Memory region: tell NIC about pages it may DMA
char buf[1 << 20];
ibv_mr* mr = ibv_reg_mr(pd, buf, sizeof(buf),
  IBV_ACCESS_LOCAL_WRITE | IBV_ACCESS_REMOTE_WRITE | IBV_ACCESS_REMOTE_READ);

// Completion queue + queue pair
ibv_cq* cq = ibv_create_cq(ctx, 1024, nullptr, nullptr, 0);
ibv_qp_init_attr qa{};
qa.send_cq = cq; qa.recv_cq = cq;
qa.qp_type = IBV_QPT_RC;
qa.cap = {.max_send_wr = 256, .max_recv_wr = 256, .max_send_sge = 1, .max_recv_sge = 1};
ibv_qp* qp = ibv_create_qp(pd, &qa);

// Out-of-band exchange QP numbers, GIDs, MR keys with peer.
// Then transition QP to INIT -> RTR -> RTS.

// Send: one-sided RDMA write to peer's memory at remote_addr
ibv_sge sge{.addr = (uintptr_t)buf, .length = 65536, .lkey = mr->lkey};
ibv_send_wr wr{};
wr.sg_list = &sge;
wr.num_sge = 1;
wr.opcode = IBV_WR_RDMA_WRITE;
wr.wr.rdma.remote_addr = peer_addr;
wr.wr.rdma.rkey = peer_rkey;
ibv_send_wr* bad;
ibv_post_send(qp, &wr, &bad);

// Poll completion
ibv_wc wc;
while (ibv_poll_cq(cq, 1, &wc) == 0) {}
```

RDMA characteristics:

- One-sided ops (READ/WRITE) consume zero CPU on the target. The remote NIC writes memory, no remote process is involved.
- Two-sided ops (SEND/RECV) require the receiver to have posted a recv buffer.
- Latency: half-microsecond range on InfiniBand, ~1-2 us on good RoCE.
- Bandwidth: 200+ Gbps on modern HDR/NDR InfiniBand and 200/400 GbE RoCE.

Used in:
- HPC (MPI over OFI / `libfabric` / `UCX`).
- Distributed databases (Microsoft FaRM, Oracle Exadata).
- Distributed storage (Lustre, BeeGFS, Ceph optional).
- Disaggregated memory / CXL prototypes.
- Very fast distributed key-value stores (Anuj Kalia's HERD, Pilaf).

RDMA is hard. Failure modes are exotic (queue pair errors, NIC fences, unreliable connection states). Most teams that adopt RDMA do so via a higher-level library: UCX (the OpenMPI/MPICH default), `libfabric`, or NVIDIA's NCCL for GPU collectives.

### 6. Decision matrix

| Scenario | Pick |
|-------------------------------------------|--------------------|
| Existing software, need 30% throughput | nothing -- tune kernel first |
| Stateless packet processing, 10 Mpps+ | DPDK or AF_XDP |
| Need iptables + bypass for hot subset | AF_XDP |
| Trading, microsecond latency, legacy code | OpenOnload (Solarflare NIC) |
| HPC, distributed memory | RDMA / UCX |
| Sub-microsecond storage, intra-DC | RDMA RoCE |
| L4 LB at line rate, kernel-friendly | XDP (not full bypass. XDP itself in kernel) |
| Kubernetes service mesh fast path | AF_XDP via Cilium |

### 7. Operational realities

- **Debugging**: `tcpdump` is gone for bypass paths. DPDK has `pdump`. AF_XDP exposes packets via the same XDP program (write to `xsks_map` for prod, redirect to `XDP_PASS` for capture). RDMA has `ibdump`. None as good as `tcpdump`.
- **Provisioning**: `vfio-pci` requires unbinding the NIC from the kernel driver and reserving huge pages. `numactl --membind` for NUMA correctness. RDMA needs `mlnx-ofed` or upstream `rdma-core` plus `ibstat` confirming the link is up.
- **Co-tenancy**: bypass usually means dedicating cores. Container schedulers (Kubernetes) need `cpu_pinning` / `cpuManagerPolicy: static`. SR-IOV gives each container a virtual function with its own queues.
- **Security**: bypass code runs with root or `CAP_SYS_RAWIO`-equivalent. Bugs are kernel-level in impact. Audit accordingly.
- **Cost**: an engineer-quarter to bring up a real DPDK app, a engineer-month for AF_XDP, a year-plus for production RDMA. Multiply by complexity of integration with existing services. Have a clear ROI.

### 8. Where this is heading

- **io_uring narrowing the gap**: with `IORING_SETUP_SQPOLL`, registered files and buffers, multishot accept/recv, io_uring is closing the per-syscall gap that drives kernel-bypass adoption. For workloads under ~3 Mpps per core, io_uring is competitive and has none of the operability cost.
- **DPU offload**: AMD Pensando, Nvidia Bluefield, Marvell DPUs run an Arm SoC on the NIC with programmable forwarding. The C++ networking surface stays mostly socket-shaped, the heavy lifting moves to the DPU. Long-term, this likely subsumes much of the kernel-bypass space for cloud workloads.
- **CXL** unifies memory and networking semantics, over the next 5 years expect "RDMA-like ops over CXL" to merge with traditional networking for intra-rack workloads.

> Senior @ FAANG: kernel bypass is a high-use hammer. Use it when the metric you cannot move (pps, latency tail, CPU per Gbps) is fundamentally limited by the kernel stack. Do not use it because it is impressive. The most senior signal in this domain is *not* writing a DPDK app, it is being able to argue clearly when the team should *not*.

