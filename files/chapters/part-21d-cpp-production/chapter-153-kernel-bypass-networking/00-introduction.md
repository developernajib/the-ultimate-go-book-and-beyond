# Chapter 153: Kernel-Bypass and Userspace Networking in C++

> "If your packet touches the kernel, you have already lost." Anonymous HFT engineer

The Linux network stack is one of the great engineering achievements of the past three decades. It is also, for a class of workloads that did not exist when it was designed, fundamentally too slow. When a market data feed handler at a Chicago trading firm needs to react to an ITCH 5.0 message in under 800 nanoseconds wall-clock time, when a Cloudflare edge node has to push 400 Gbit/s of TLS-terminated HTTP/3 traffic per server, when a Mellanox BlueField-3 DPU has to process 200 million packets per second of east-west datacenter traffic, the kernel stack is not an asset. It is a tax that must be removed.

This chapter is about removing that tax. It is written for the L5+ engineer who has been told to make a C++ system go ten times faster on the network and has discovered that the usual answers (better algorithms, more cores, faster CPUs) do not move the needle, because the bottleneck is not in the application. The bottleneck is the path between the wire and the application: interrupts, copies, syscalls, scheduling, qdisc, sk_buff allocation. We will measure that path, then replace it.

## Who This Chapter Is For

This chapter assumes you have already shipped a production C++ networking application using BSD sockets or epoll, that you have profiled it with perf, that you understand cache lines and NUMA, and that you have read at least once through the Linux kernel net/core directory. If those are not true, the material in chapters 130-132 (Linux internals) and 147 (HFT systems) is prerequisite.

The audience is L5+ at FAANG and senior at HFT (Citadel Securities, Jump Trading, Hudson River Trading, Two Sigma, Jane Street), CDN (Cloudflare, Fastly, Akamai), and DPU teams (Nvidia, AWS Nitro, Intel IPU). The expectation is that after reading this chapter you can sit in a design review where someone says "we need to take 1.5 microseconds off the order entry path" and contribute meaningfully to the conversation about whether to use DPDK, ef_vi, RDMA verbs, AF_XDP, or to push the work onto a DPU.

## When Kernel Bypass Is Justified

Kernel bypass is not free. It costs you dedicated CPU cores burning 100% in busy-poll loops, hugepage memory carved out of system RAM, a substantial software complexity budget (you are now operating without the kernel's safety nets: no TCP stack, no firewall, no congestion control, no routing table), and a operational complexity budget (your packet captures look different, your monitoring is different, your debugging tools are different). The decision to bypass should be driven by hard numbers, not enthusiasm.

The three workload classes where bypass is unambiguously justified:

**HFT and electronic trading.** Tick-to-trade latency budgets are quoted in nanoseconds. The Nasdaq TotalView ITCH feed runs at peak rates of 6+ million messages per second during market open. CME Globex iLink 3 order entry has p99 latencies that determine whether your strategy is profitable or not. A 2-microsecond floor from the kernel stack is 2000 nanoseconds of competitive disadvantage. Production HFT systems run on Solarflare/AMD Pensando NICs with OpenOnload or ef_vi, or on Mellanox NICs with VMA, achieving sub-microsecond UDP receive paths and sub-2-microsecond TCP send paths.

**CDN and L7 edge.** Aggregate throughput rather than tail latency is the constraint. A single Cloudflare server pushes hundreds of Gbit/s across hundreds of thousands of concurrent connections. The kernel stack syscalls (sendmsg, recvmsg, epoll_wait) become the primary CPU consumer. Cloudflare, Fastly, Netflix, and Meta all run userspace TCP stacks (or aggressive io_uring with AF_XDP) for the data plane.

**DPU and SmartNIC offload.** The Nvidia BlueField-3, AWS Nitro v5, and Intel IPU E2100 are full ARM Linux servers welded onto the NIC. They terminate VXLAN, run virtual switches, enforce security groups, and offload TLS, all without the host kernel knowing the packet ever existed. Programming them means writing C++ that runs either on DPDK with the DPU as a port, or directly on the DPU's ARM cores via the DOCA SDK.

Outside these three classes, bypass is usually the wrong tool. A web service with 1ms p99 latency does not need DPDK. It needs better SQL queries.

## The Linux Stack Tax: Where the Microseconds Go

A typical TCP `recv()` from a 10GbE NIC on a modern Skylake-X server, on a quiet machine with a warm cache, costs roughly 2 to 3 microseconds end to end. That number gets worse under load. Here is where the budget goes, measured in nanoseconds, on Linux 6.x with a reasonable kernel config:

```
Event                                      Approximate cost (ns)
-----                                      ---------------------
Packet arrives at NIC, DMA into ring        50  (hardware, unavoidable)
NIC raises MSI-X interrupt                  300  (PCIe + APIC dispatch)
Hard IRQ handler runs                       200  (mostly schedule softirq)
softirq / NAPI poll wakes up                500  (context, scheduling)
Driver allocates sk_buff                    400  (slab, cache miss)
GRO coalesces frames                        200  (lookup + merge)
ip_rcv -> tcp_v4_rcv                        300  (route lookup, hash)
tcp_data_queue + ack scheduling             400  (state machine)
sk_data_ready wakes user task               300  (wakeup, schedule)
recv() syscall entry                        150  (SYSCALL, swapgs, pti)
copy_to_user                                400  (memcpy + page fault path)
syscall return                              100
                                           ----
Total                                      ~3300 ns
```

The numbers above are best-case on a warm machine. With Spectre/Meltdown mitigations (KPTI, retpoline, IBRS) the syscall path alone doubles. With NAPI under load, softirq processing balloons. With cache misses in the hash table, TCP receive doubles. A real production server under real load is at 5 to 8 microseconds for a single recv, with high tail variance.

The same packet, received via DPDK or ef_vi:

```
Event                                      Approximate cost (ns)
-----                                      ---------------------
Packet arrives at NIC, DMA into ring        50  (hardware)
Application busy-polls RX descriptor        20  (PCIe MMIO read or memory poll)
Application reads packet from mbuf          80  (cache-warm if hot path)
                                           ----
Total                                      ~150 ns
```

The 20x improvement is not from a single optimization. It is from removing entire classes of work: no interrupt, no context switch, no sk_buff, no syscall, no copy_to_user, no scheduling. The CPU is already in the right place doing the right thing because it has been spinning there since the program started. That is the deal kernel bypass offers, and that is the deal we will study how to take.

## How To Read This Chapter

The chapter has four arcs. Chapters 02 to 05 cover the fundamentals: what the kernel stack does, then DPDK and AF_XDP as the two main bypass paths on commodity NICs. Chapters 06 to 09 cover specialized hardware paths: RDMA verbs, Solarflare ef_vi, Mellanox VMA. Chapters 10 to 14 cover application-level concerns: shared memory IPC, busy polling, time, feed handlers, order entry. Chapters 15 to 23 cover advanced topics, deployment, and assessment.

If you are preparing for an HFT interview, read 03, 06, 08, 11, 12, 13, 14, 18, 21 in that order. If you are building a CDN data plane, read 03, 05, 16, 17, 19, 20. If you are programming a SmartNIC, read 03, 04, 15, 18.

Every chapter contains real C++ code that compiles against current libraries (DPDK 23.11 LTS or 24.11 LTS, libxdp 1.4, rdma-core 50, msquic 2.3) and real shell commands tested on Ubuntu 24.04 with kernel 6.8. Where versions matter (DPDK API breaks across versions are not unusual), the version is called out explicitly.
