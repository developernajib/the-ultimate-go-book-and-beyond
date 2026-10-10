## The Linux Network Stack: A Baseline We Plan To Beat

Before we replace the kernel network stack we should understand what it does. The kernel stack is not slow because Linux engineers were careless. It is slow because it solves a much harder problem than a kernel-bypass application solves: it must be safe, multi-tenant, protocol-rich (TCP, UDP, SCTP, ICMP, IPv4, IPv6, IPSec, GRE, VXLAN), policy-aware (iptables, nftables, tc, eBPF), and correct under arbitrary adversarial input. The cost we are about to measure is the cost of that generality. When we strip it away in later chapters, we are also stripping away the protections it provides.

### The sk_buff and the Packet Path

The fundamental data structure of the Linux network stack is the socket buffer, `struct sk_buff` (often called skb). One skb represents one packet (or one fragment of a TSO/GSO super-packet). It carries:

- A pointer to the packet bytes (`->head`, `->data`, `->tail`, `->end`).
- Per-protocol header offsets (`->mac_header`, `->network_header`, `->transport_header`).
- A reference count, a list pointer, a destructor, an owner socket pointer.
- Roughly 200 bytes of metadata in addition to the packet itself.

The skb is allocated from the kernel slab cache on RX, threaded through the stack, and freed on consumption. Allocation and deallocation are major costs. The kernel has tried hard to reduce this (skb fast clones, frag_list, page_pool, build_skb) but the cost remains nontrivial.

The receive path on a modern driver looks like this:

```
NIC DMA-writes packet into a pre-posted buffer in a per-queue ring
NIC writes a descriptor saying "buffer N is now full"
NIC raises MSI-X interrupt to a target CPU (set by IRQ affinity)
hard IRQ handler in driver acks the interrupt, schedules NET_RX_SOFTIRQ
softirq runs (either inline on IRQ exit or on ksoftirqd) and calls napi_poll
napi_poll drains up to budget (default 64) descriptors:
    for each descriptor:
        build_skb wraps the DMA buffer
        eth_type_trans sets skb->protocol
        netif_receive_skb hands to GRO
GRO either coalesces with an in-progress flow or flushes
flushed skbs go to ip_rcv (IPv4) or ipv6_rcv
ip_rcv: checksum, route lookup (fib_lookup), netfilter PREROUTING/INPUT
tcp_v4_rcv: socket lookup (__inet_lookup), tcp_v4_do_rcv, tcp_rcv_established
tcp_rcv_established: in-order check, queue to sk->sk_receive_queue, schedule ack
sk_data_ready callback: wake up task in poll_wait or epoll_wait
user task scheduled, returns from epoll_wait, calls recv()
recv() syscall: lock_sock, copy skb data with skb_copy_datagram_iter -> copy_to_user
free skb, return bytes copied to user
```

That is the happy path. There are detours for fragmentation, retransmission, out-of-order, ACK generation, window updates, ECN, fast retransmit, SACK, all of which add cost and tail latency.

### NAPI and the IRQ-Throttling Model

NAPI was added in 2003 to solve the receive livelock problem: at high packet rates, raw interrupt-per-packet would saturate the CPU on IRQ entry alone, never allowing the rest of the stack to run. NAPI reverses the polarity: the first packet arrival raises an IRQ, but the IRQ handler immediately disables further interrupts on that queue and schedules a softirq poll. The poll loop drains packets in batches (up to `napi->weight`, typically 64) and re-enables interrupts only when the ring is empty.

This converts the model from interrupt-driven to hybrid interrupt-then-poll, which is the right answer for the kernel stack. But it is not free. Each softirq dispatch is roughly 500ns of work for scheduling, save/restore, and entering the poll. Under heavy load, ksoftirqd ends up scheduled as a regular kernel thread and you pay full process context switch cost.

`ethtool -c eth0` shows the coalescing parameters. Tuning `rx-usecs` and `rx-frames` is one of the levers operators reach for, but it trades off latency and throughput rather than removing cost.

### GRO, GSO, TSO, LRO

Hardware can do less work per packet if we batch:

- **TSO** (TCP Segmentation Offload): the OS hands the NIC a 64KB super-packet, the NIC splits it into MSS-sized segments. Kernel-side, this is one skb instead of 45.
- **GSO** (Generic Segmentation Offload): same idea but the kernel does the split late (just before tx) so it works for any NIC.
- **LRO** (Large Receive Offload): NIC merges incoming segments into one big skb. Largely deprecated because it breaks routing and forwarding.
- **GRO** (Generic Receive Offload): the NAPI poll merges adjacent same-flow segments in software just after RX.

For a server doing primarily local termination, GRO and TSO are pure win. For an HFT or middlebox doing per-packet timestamping and forwarding, GRO is harmful (it merges the very thing you are trying to measure). DPDK applications turn it off entirely, bypass paths see raw packets.

### RPS, RFS, XPS, aRFS

The kernel offers four flow-steering mechanisms to spread packet processing across cores:

- **RPS** (Receive Packet Steering): software hashing of the 4-tuple, picks a CPU to run the rest of the stack. Useful when the NIC has fewer queues than cores.
- **RFS** (Receive Flow Steering): RPS plus a flow table mapping flow to last-CPU-that-recvd, to keep cache locality.
- **XPS** (Transmit Packet Steering): map TX queue to CPU set on send.
- **aRFS** (Accelerated RFS): RFS pushed into hardware via `ndo_rx_flow_steer`, the NIC itself filters into the right queue.

These configurations live under `/sys/class/net/<dev>/queues/` and are the difference between a server that scales linearly to 64 cores and one that hits a softirq bottleneck at 16. Bypass paths replace this entire mechanism with rte_flow (DPDK) or XDP redirect (AF_XDP), which we cover in chapters 04 and 05.

### The qdisc Layer and mq

On TX, the kernel runs the queueing discipline (qdisc) layer between the socket send buffer and the driver's TX ring. The default since Linux 4.13 is `mq` plus `fq_codel` per queue, which is fine for most workloads. For HFT, even `noqueue` (the default for virtio devices) is too much: the qdisc lock alone is hundreds of nanoseconds. Look at `/proc/sys/net/core/default_qdisc` and prefer `pfifo_fast` for bypass-adjacent paths, or simply skip the qdisc by using the bypass path directly.

`fq` (Fair Queue) is what Google uses for its bulk traffic to enforce per-flow pacing for BBR. It is excellent for what it does and irrelevant for HFT.

### The Microsecond Budget, Annotated

Putting numbers next to each step on a Skylake-X 8268 with KPTI on, retpoline on, default kernel config, warm cache:

```
Step                           ns    Removable by bypass?
----                           --    -------------------
Hardware DMA + PCIe              50   No (physics)
MSI-X dispatch + APIC           300   Yes (busy poll)
Hard IRQ handler                200   Yes (no IRQ)
softirq schedule + entry        500   Yes (no softirq)
build_skb + slab alloc          400   Yes (mbuf pool, no skb)
GRO state lookup + merge        200   Yes (raw packets)
ip_rcv (route, netfilter)       300   Yes (no kernel routing)
tcp_v4_rcv (socket lookup)      300   Yes (no kernel TCP)
tcp_rcv_established             400   Yes (userspace TCP or none)
sk_data_ready (wakeup)          300   Yes (busy poll, no wakeup)
syscall entry (KPTI cost)       150   Yes (no syscall)
copy_to_user                    400   Yes (zero copy via DMA)
syscall return                  100   Yes
                              -----
Total                          3600
Removable                      3550
Floor (DMA + poll)               80
```

That table is the elevator pitch for this entire chapter. The kernel does roughly 3.5 microseconds of work that, for our workloads, we do not need. Bypass removes it. The remaining 80 nanoseconds is the cost of the hardware transferring the bits across the bus, which no software trick can avoid.

### A Quick Measurement Recipe

Before you rewrite anything, measure what you have. The minimum useful measurement is per-call kernel TCP latency on a quiet box.

```bash
# On the receiver
sudo perf record -e 'sched:sched_switch,irq:irq_handler_entry,irq:softirq_entry,syscalls:sys_enter_recvfrom,syscalls:sys_exit_recvfrom' -a -g -- sleep 10
sudo perf script | head -200
```

For a more direct number, use `bpftrace` to histogram the time between `tcp_recvmsg` entry and exit:

```bash
sudo bpftrace -e '
kprobe:tcp_recvmsg { @start[tid] = nsecs; }
kretprobe:tcp_recvmsg /@start[tid]/ {
    @ns = hist(nsecs - @start[tid]);
    delete(@start[tid]);
}'
```

Run a load generator (`iperf3 -c $RECEIVER -u -b 1G -l 64`) for 30 seconds and look at the histogram. On a quiet box you will see a tight cluster around 1500 to 3000 ns. On a loaded box you will see a long tail past 50 microseconds. That tail is where bypass earns its keep.

### When NOT To Bypass

A web service handling 10k requests per second per server, with p99 latency of 5 milliseconds, will not benefit from kernel bypass. The application is the bottleneck. Even a perfect zero-cost network stack would only shave 10 microseconds off a 5000 microsecond response.

A microservice mesh with mutual TLS and complex L7 routing is the wrong fit. The kernel stack gives you TCP correctness, congestion control, and TLS hardware offload via kTLS for free. Replicating that in userspace is months of engineering for marginal benefit.

A storage system with 100us NVMe latencies will benefit modestly from RDMA, mostly because of zero-copy and reduced CPU, not because of microsecond-level latency wins.

The litmus test: profile your application with `perf top`. If `__softirq_entry`, `tcp_rcv_established`, `_raw_spin_lock`, or `copy_user_enhanced_fast_string` are in the top ten, bypass is worth investigating. If they are not, fix your application first.

> Junior engineer pitfall: writing a DPDK prototype before measuring whether the kernel was actually the bottleneck.
> Senior FAANG move: produce a flame graph that quantifies kernel CPU and tail latency contribution, then justify the bypass investment with that data in a design doc.
