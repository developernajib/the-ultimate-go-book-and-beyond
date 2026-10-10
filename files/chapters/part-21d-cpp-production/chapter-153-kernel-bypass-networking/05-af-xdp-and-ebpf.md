## AF_XDP and eBPF: The Kernel-Sanctioned Bypass

DPDK takes a NIC away from the kernel entirely. AF_XDP takes a single queue. That difference is the entire reason AF_XDP exists. With AF_XDP, the kernel still owns the NIC, still runs its TCP stack on the other queues, still enforces iptables, still answers ARP. One queue is carved off and redirected via an XDP program (an eBPF program that runs in the driver's RX path) to a userspace ring. The userspace process pulls packets directly without the rest of the stack. This makes AF_XDP a much better fit than DPDK for shared servers, container hosts, and any environment where you do not own the whole NIC.

AF_XDP shipped in kernel 4.18 (2018), zero-copy modes followed in 5.x. The standard userspace library is `libxdp` (split out of `libbpf` around 2021). Recent kernels (6.x) and current Mellanox/Intel drivers all support zero-copy on common NICs.

### The Pieces

The minimum AF_XDP setup involves four objects:

- **An XDP program**, an eBPF program loaded into the driver's RX hook. It inspects each packet as it arrives in the driver and decides among `XDP_PASS` (continue up the kernel stack), `XDP_DROP`, `XDP_TX` (echo), `XDP_REDIRECT` (push elsewhere, including AF_XDP).
- **An XSK map**, a BPF map of type `BPF_MAP_TYPE_XSKMAP` that maps queue index to an AF_XDP socket file descriptor. The XDP program does `bpf_redirect_map(&xsks_map, queue_id, 0)` to send the packet to the userspace socket on that queue.
- **A UMEM**, a userspace-allocated chunk of memory split into fixed-size frames. The kernel and userspace share it. Packets land in frames, userspace reads them, returns the frame back to the kernel.
- **Four rings** between userspace and kernel: FILL (UMEM frames userspace gives the kernel for RX), RX (descriptors describing received packets), TX (descriptors describing packets to send), COMPLETION (frames the kernel returns after TX done).

The XDP program is short and almost universal. Save as `xdp_redirect.c`:

```c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

struct {
    __uint(type, BPF_MAP_TYPE_XSKMAP);
    __type(key, __u32);
    __type(value, __u32);
    __uint(max_entries, 64);
} xsks_map SEC(".maps");

SEC("xdp")
int xdp_redirect(struct xdp_md* ctx) {
    int queue = ctx->rx_queue_index;
    if (bpf_map_lookup_elem(&xsks_map, &queue))
        return bpf_redirect_map(&xsks_map, queue, 0);
    return XDP_PASS;
}
char _license[] SEC("license") = "GPL";
```

Compile with clang:

```bash
clang -O2 -g -target bpf -c xdp_redirect.c -o xdp_redirect.o
```

### A C++ AF_XDP Receiver Using libxdp

`libxdp` provides `xsk_socket__create` which handles the dance of allocating the four rings, attaching the XSK to a queue, loading the XDP program if needed, and registering with the XSKMAP.

```cpp
#include <xdp/libxdp.h>
#include <xdp/xsk.h>
#include <bpf/bpf.h>
#include <sys/mman.h>
#include <net/if.h>
#include <unistd.h>
#include <cstdio>
#include <cstring>

constexpr unsigned NUM_FRAMES = 4096;
constexpr unsigned FRAME_SIZE = 4096;
constexpr unsigned RX_RING    = 2048;
constexpr unsigned TX_RING    = 2048;

struct Xsk {
    void*                umem_area;
    xsk_umem*            umem;
    xsk_socket*          sock;
    xsk_ring_prod        fill;
    xsk_ring_cons        comp;
    xsk_ring_cons        rx;
    xsk_ring_prod        tx;
};

static Xsk make_xsk(const char* ifname, uint32_t queue) {
    Xsk x{};

    // 1. Allocate UMEM as a contiguous chunk, then register
    const size_t umem_bytes = size_t(NUM_FRAMES) * FRAME_SIZE;
    x.umem_area = mmap(nullptr, umem_bytes, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
    if (x.umem_area == MAP_FAILED)
        x.umem_area = mmap(nullptr, umem_bytes, PROT_READ | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    xsk_umem_config ucfg{
        .fill_size      = RX_RING * 2,
        .comp_size      = TX_RING,
        .frame_size     = FRAME_SIZE,
        .frame_headroom = 0,
        .flags          = 0,
    };
    if (xsk_umem__create(&x.umem, x.umem_area, umem_bytes,
                         &x.fill, &x.comp, &ucfg) != 0) {
        perror("xsk_umem__create");
        std::exit(1);
    }

    // 2. Create the XSK socket - libxdp attaches the default XDP program
    xsk_socket_config scfg{
        .rx_size = RX_RING,
        .tx_size = TX_RING,
        .libxdp_flags = 0,
        .xdp_flags    = XDP_FLAGS_DRV_MODE,    // drv-mode, not generic
        .bind_flags   = XDP_ZEROCOPY,          // zero-copy if supported
    };
    if (xsk_socket__create(&x.sock, ifname, queue, x.umem,
                           &x.rx, &x.tx, &scfg) != 0) {
        perror("xsk_socket__create");
        std::exit(1);
    }

    // 3. Pre-fill the FILL ring so the driver has frames to write into
    uint32_t idx;
    if (xsk_ring_prod__reserve(&x.fill, RX_RING, &idx) != RX_RING) {
        fprintf(stderr, "fill reserve failed\n");
        std::exit(1);
    }
    for (unsigned i = 0; i < RX_RING; i++) {
        *xsk_ring_prod__fill_addr(&x.fill, idx++) = i * FRAME_SIZE;
    }
    xsk_ring_prod__submit(&x.fill, RX_RING);

    return x;
}

static void rx_loop(Xsk& x) {
    while (!g_stop) {
        uint32_t idx_rx = 0, idx_fq = 0;
        unsigned recvd = xsk_ring_cons__peek(&x.rx, 64, &idx_rx);
        if (!recvd) {
            // Driver-mode AF_XDP can use needs_wakeup to skip syscall
            if (xsk_ring_prod__needs_wakeup(&x.fill)) {
                recvfrom(xsk_socket__fd(x.sock), nullptr, 0,
                         MSG_DONTWAIT, nullptr, nullptr);
            }
            continue;
        }

        // Get FILL slots to return frames after we read them
        xsk_ring_prod__reserve(&x.fill, recvd, &idx_fq);

        for (unsigned i = 0; i < recvd; i++) {
            const xdp_desc* d = xsk_ring_cons__rx_desc(&x.rx, idx_rx + i);
            uint8_t* pkt = static_cast<uint8_t*>(x.umem_area) + d->addr;
            process_packet(pkt, d->len);
            *xsk_ring_prod__fill_addr(&x.fill, idx_fq + i) = d->addr;
        }

        xsk_ring_prod__submit(&x.fill, recvd);
        xsk_ring_cons__release(&x.rx, recvd);
    }
}
```

Build:

```bash
g++ -O3 -std=c++20 xsk_rx.cpp -o xsk_rx -lxdp -lbpf
sudo setcap cap_net_admin,cap_sys_admin,cap_net_raw,cap_bpf=eip ./xsk_rx
sudo ./xsk_rx eth0 0
```

### XDP Modes: Generic, Driver, Offload

XDP runs in three modes:

- **Generic (SKB) mode.** XDP program runs after `skb` allocation. Slowest, works on any device. About the same speed as a kernel netfilter hook.
- **Driver (Native) mode.** XDP program runs inside the driver's NAPI poll, before skb allocation. This is the fast common path, supported by ixgbe, i40e, ice, mlx4, mlx5, virtio_net, veth, and others.
- **Hardware offload mode.** The XDP program is JITted and uploaded into NIC firmware. Currently only Netronome / AMD-Pensando NFP support this in mainline. SmartNIC vendors expose more via DOCA or P4.

For AF_XDP zero-copy, you want driver mode plus a NIC that supports `XDP_ZEROCOPY` for the AF_XDP socket. Mellanox ConnectX-5 and newer, Intel ice and i40e, and recent virtio_net support it. Without zero-copy, the kernel falls back to copying packet contents into the UMEM frame, which is faster than the kernel TCP stack but slower than DPDK.

Check capability:

```bash
ethtool -i eth0           # confirm driver name
ip link show eth0
ethtool -S eth0 | grep -i xdp
```

### XDP Actions and the Drop Path

XDP excels at high-speed drop. A DDoS scrubber that gets hit with 50 Mpps of garbage UDP can drop in the XDP hook and never allocate an skb. Cloudflare's L3 DDoS pipeline famously absorbs hundreds of Mpps using XDP_DROP.

A classifier program looks like:

```c
SEC("xdp")
int xdp_classify(struct xdp_md* ctx) {
    void* data     = (void*)(long)ctx->data;
    void* data_end = (void*)(long)ctx->data_end;
    struct ethhdr* eth = data;
    if ((void*)(eth + 1) > data_end) return XDP_DROP;
    if (eth->h_proto != bpf_htons(ETH_P_IP)) return XDP_PASS;
    struct iphdr* ip = (void*)(eth + 1);
    if ((void*)(ip + 1) > data_end) return XDP_DROP;
    if (ip->protocol == IPPROTO_UDP) {
        // redirect to AF_XDP for userspace processing
        int q = ctx->rx_queue_index;
        return bpf_redirect_map(&xsks_map, q, 0);
    }
    return XDP_PASS;   // let kernel handle TCP normally
}
```

This program lets TCP stay in the kernel (where it works fine) and only fast-paths UDP into userspace.

### When AF_XDP Beats DPDK

- **Shared NIC.** You want bypass on one queue but the kernel still owns the rest. DPDK does not allow this without partitioning the NIC into VFs.
- **Container-friendly deployment.** AF_XDP works inside containers with `cap_net_raw` and `cap_bpf` only. DPDK needs hugepages and PCI device access mounted into the container.
- **Existing operational tooling works.** `ip`, `ethtool`, `tcpdump` still work because the kernel still owns the device.
- **Lower CPU cost when not at line rate.** AF_XDP can sleep on `recvfrom` with `XDP_USE_NEED_WAKEUP`, DPDK is always 100% CPU.

### When DPDK Still Wins

- **Maximum pps on a single core.** DPDK PMDs hand-tune RX/TX loops with explicit prefetch, vector instructions, and per-NIC tricks that AF_XDP's generic path cannot match. Realistic gap is roughly 30 to 50% on small packets.
- **Mature offload coverage.** rte_flow exposes more of the NIC than libxdp. RDMA-tied offloads (e.g., flow-tag / split-header on Mellanox) are easier in DPDK.
- **Multi-NIC, multi-vendor portability.** DPDK abstracts. AF_XDP is uniform but limited.

A common architecture in modern CDN: AF_XDP for ingress classification and DDoS, DPDK or a userspace stack for the actual data plane. Use the right tool per layer.

### Recent Developments (2024-2025)

- **Multi-buffer XDP.** XDP now supports jumbo frames split across multiple buffers. Required for large packet handling on NICs that scatter.
- **XDP_REDIRECT to CPU map (cpumap).** Push packets to a kernel kthread on a different CPU to balance work without going to userspace.
- **devmap.** Redirect to another netdevice. Used to build an XDP-only bridge or load balancer (Cilium, Katran).
- **libxdp dispatcher.** Multiple XDP programs chained on one interface, ordered by priority. Replaces the old "one program per interface" limit.

> Junior engineer trap: writing AF_XDP code and not noticing it fell back to copy mode because the driver did not support zero-copy on that queue.
> Senior FAANG move: confirm zero-copy with `ethtool -S` xdp_zc counters, measure copy CPU with `perf top` during sustained load, and pick AF_XDP vs DPDK based on a measured CPU and pps comparison rather than vendor allegiance.
