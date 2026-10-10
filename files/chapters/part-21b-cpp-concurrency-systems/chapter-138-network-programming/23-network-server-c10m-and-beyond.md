## C10M and Beyond: 10 Million Concurrent Connections

The C10K problem (Dan Kegel, 1999) asked how to handle 10,000 concurrent connections per server. By 2010 every modern OS solved it. The C10M problem (Robert Graham, Shmoocon 2013) asks for 10 million per server. C10M is no longer purely aspirational: Cloudflare, Google, and Facebook routinely run edge boxes with several million long-lived connections.

This chapter is the actual constraints and the actual numbers.

### 1. Where the kernel hits limits

Every connection costs:

- ~3-12 KiB kernel memory: `struct sock`, `struct tcp_sock`, send/recv buffers, netfilter conntrack entry.
- A file descriptor (8 bytes per open fd in the per-process table).
- A pseudo-file in `/proc/<pid>/fd/`.
- An entry in the conntrack table if iptables is loaded.
- Periodic timer wheel work for keepalive / retransmit.

At 10 M connections you are talking about ~80 GiB of kernel memory before user-space data, 10 M conntrack entries, and a NIC that must move millions of packets per second across these flows. This is not a single-knob problem.

### 2. Limits to raise (and how)

#### File descriptors

```bash
# system-wide
sysctl -w fs.file-max=20000000
# per-process (ulimit + systemd unit + container)
ulimit -n 20000000
# in a systemd unit:
LimitNOFILE=20000000
```

epoll watch limit:

```bash
sysctl -w fs.epoll.max_user_watches=20000000
```

#### Ephemeral ports

A server does not allocate ephemeral ports for incoming connections (those use the listener's port), so this affects clients and outbound traffic only:

```bash
sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sysctl -w net.ipv4.tcp_tw_reuse=1
```

For 10 M outbound to the same destination you need source IP diversification (multiple source IPs, or `SO_BINDTODEVICE` with multiple devices). One IP gives 64K ephemeral ports, do the math.

#### Conntrack

```bash
sysctl -w net.netfilter.nf_conntrack_max=20000000
sysctl -w net.netfilter.nf_conntrack_buckets=2500000
sysctl -w net.netfilter.nf_conntrack_tcp_timeout_established=86400
```

Or, the actually-fast option: do not load conntrack on the data-plane interface (`iptables -t raw -A PREROUTING -i eth0 -j NOTRACK`). For an edge proxy that does its own L4 state, conntrack is dead weight.

#### TIME_WAIT

```bash
sysctl -w net.ipv4.tcp_tw_reuse=1
# Do NOT set tcp_tw_recycle (removed in 4.12, breaks NATed clients)
```

If you have lots of short-lived outbound connections, this matters. For long-lived inbound (which is what C10M usually means) it does not.

#### Backlog

```bash
sysctl -w net.core.somaxconn=65535
sysctl -w net.ipv4.tcp_max_syn_backlog=65535
```

Plus call `listen(fd, 65535)` in code, remember `somaxconn` caps it.

#### Memory

```bash
# Total TCP memory (pages)
sysctl -w net.ipv4.tcp_mem="4194304 8388608 16777216"
# Per-socket maxima (autotuned)
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_rmem="4096 65536 16777216"
sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"
```

For 10 M idle-ish connections, autotuning settles each socket at low KiB, budget 4-8 KiB rmem + 4-8 KiB wmem + ~3 KiB struct = ~15 KiB/conn = 150 GiB. You need either a box with that much RAM or you need to make your data path stop allocating per-connection buffers.

### 3. Per-connection user-space cost

Even if you fix kernel limits, your user-space code may allocate:

- Per-connection state object: 64-256 B for a tight design, 4 KiB for a sloppy one.
- Per-connection send/recv buffer: 16-64 KiB if naive, near-zero with shared slab + io_uring fixed buffers.
- Per-connection TLS state: 16-32 KiB for OpenSSL, less for rustls / kTLS.

At 10 M connections, the difference between 64 B and 4 KiB per state object is 39 GiB of RAM. That is the ballgame. Real C10M designs use tightly packed state machines, intrusive containers (`boost::intrusive::list`), and slab allocators.

```cpp
// Tight per-connection state, ~40 bytes
struct alignas(8) ConnSlot {
  int fd;                    // 4
  uint32_t flags;            // 4
  std::chrono::steady_clock::time_point last_io;  // 8
  uint16_t in_off, in_end;   // 4
  uint16_t out_off, out_end; // 4
  uint64_t conn_id;          // 8
  ConnSlot* next_lru;        // 8
};   // 40 bytes
```

Buffers come from a shared slab keyed by `(slab_id, slot)`, we never store a pointer per connection. With 16 GiB of slab serving as a 16 KiB-each ring, ~1 M of those slots are simultaneously in flight at any moment, but never one slot per connection.

### 4. NUMA awareness

A two-socket 64-core box has memory bandwidth split across NUMA nodes. If a connection's softirq runs on node 0 but its user-space worker on node 1, every recv crosses the QPI/UPI link. At C10M, that link saturates.

Approach:

1. Pin NIC RX queues to specific cores (`set_irq_affinity.sh` or `ethtool -X`).
2. Pin worker threads to the same cores (`pthread_setaffinity_np`).
3. Use `SO_INCOMING_CPU` so the kernel records the CPU that received the packet, combined with `SO_REUSEPORT` + BPF reuseport, route the connection to the worker on that CPU.
4. Allocate per-worker memory from the local NUMA node (`numa_alloc_onnode`).

End state: each connection lives on one CPU/NUMA-node from accept to close, never touching the other socket.

### 5. NIC offloads

The NIC must hand off packets without per-packet CPU intervention:

- **RSS (Receive Side Scaling)**: hash 4-tuple, dispatch to N RX queues. Required.
- **RPS (Receive Packet Steering)**: software fallback when RSS is absent or coarse.
- **RFS (Receive Flow Steering)**: kernel records which CPU consumed a flow and asks the NIC to steer future packets there.
- **GRO (Generic Receive Offload)**: coalesce small segments into larger ones in software, fewer trips up the stack.
- **TSO/GSO (Transmit Segmentation Offload)**: NIC chops large send buffers, less syscall and less DMA setup overhead.
- **LRO**: receive equivalent of TSO. Disable for forwarding (it merges segments incorrectly for proxies).

```bash
ethtool -K eth0 rx-checksumming on tx-checksumming on tso on gso on gro on lro off
ethtool -L eth0 combined 32          # 32 RX/TX queue pairs
ethtool -X eth0 equal 32             # spread across all
```

### 6. softirq saturation

Even with RSS, a high-pps NIC can saturate one CPU's softirq budget. Symptoms: `ksoftirqd/N` at 100% on one core, packet drops in `/proc/net/softnet_stat`. Mitigations:

- More queues (up to NIC's ring count).
- `irqbalance` off, manual pinning -- one IRQ per CPU.
- `napi_defer_hard_irqs=2` and `gro_flush_timeout=20000` (20 us) -- deferred NAPI lets RX run later when the CPU is less busy.
- Move to AF_XDP / DPDK (see Kernel Bypass: DPDK, AF_XDP, OpenOnload, RDMA) when the kernel cannot keep up.

### 7. Real numbers

**WhatsApp (2012, "2 million connections per FreeBSD server")**: Erlang VM, kqueue, careful per-connection memory layout, `kern.ipc.maxsockets` and friends raised. Roughly 200 GB RAM per box.

**Cloudflare (2017 blog "How we built it: edge"): single edge box steady state 1.5-2 M concurrent TLS connections**, with a moving slate of techniques: SO_REUSEPORT, kTLS, BBR, compiled-static OpenSSL fork, `tcp_nopush`-style coalescing, BPF reuseport for shard awareness.

**Discord (2022 "How Discord stores billions of messages")**: a single Elixir presence box held 4-5 M websocket connections. Erlang's per-process cost (~3 KiB) makes this practical without C++ tricks, the C++ analog is doable but is harder work for a smaller team.

**Cloudflare DDoS edge (2023)**: 10 M+ packets-per-second per box, achieved via XDP at the NIC and a slim userspace filter. Connection count is decoupled from packet count, a SYN-flood absorbs at 10 Mpps without ever materializing connections.

### 8. Design checklist for a C10M-class server

1. Pinned per-core workers (1 thread/CPU, no oversubscription).
2. `SO_REUSEPORT` per-worker listener. BPF reuseport program for migration.
3. epoll(ET) or io_uring for I/O, never blocking syscalls on the data path.
4. Per-worker slab allocator, intrusive lists, no `malloc` in the hot path.
5. Tight `ConnSlot` (<= 64 B), shared buffer pool, not per-conn.
6. `TCP_USER_TIMEOUT`, `TCP_NOTSENT_LOWAT`, `TCP_NODELAY` set on every conn.
7. Conntrack disabled on data plane, iptables NOTRACK.
8. NIC RSS + RPS + RFS + GRO, manual IRQ pinning.
9. Stats per worker, merged periodically, never per-conn lock-protected counters.
10. Idle reaper running on a single thread, sharded by worker, so reap cost scales.

### 9. When you do NOT need C10M

If your service handles 10 K simultaneous connections, you are not in C10M territory. Use a well-configured Envoy or NGINX, default kernel knobs, and stop. The cost of C10M-class engineering is real: tighter code is harder to evolve, the obscure sysctl tweaks bite during incidents, and most teams cannot maintain it.

C10M makes sense for:
- L7 edge proxies serving millions of long-lived connections (CDN, push notifications, mobile keepalive).
- Real-time systems with WebSocket / SSE fan-out (chat, collaborative editing, gaming presence).
- L4 load balancers (those usually go further -- AF_XDP, kernel-bypass).

### 10. References worth reading

- Robert Graham, "C10M: The Coming HTTP Apocalypse" (Shmoocon 2013).
- Cloudflare blog series: "How we built our network", "Pingora: open sourcing our Rust framework", "Linux kernel network performance tuning", and "Why we chose pingora".
- Google Maglev paper (NSDI 2016).
- Facebook Katran (XDP-based L4 LB).
- Eric Dumazet's commits to Linux networking (search `git log --author=Eric.Dumazet`), essentially the master class on low-overhead TCP.
- The `bcc` and `bpftrace` cookbooks for measuring softirq, syscall, and IO behavior on a live box.

> Senior @ FAANG: the C10M skill set is mostly observability. Knowing that `softnet_stat` column 2 is "dropped because of RX backlog" is worth more than knowing how to write your own slab. Build the dashboards and the bpftrace one-liners before you tune anything.

