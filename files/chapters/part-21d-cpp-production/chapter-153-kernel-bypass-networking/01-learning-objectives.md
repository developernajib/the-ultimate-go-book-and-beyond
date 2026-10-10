## Learning Objectives

By the end of this chapter you will be able to:

1. **Decompose the Linux network stack tax** into its constituent costs (interrupt dispatch, NAPI scheduling, sk_buff allocation, GRO, TCP state machine, syscall entry, copy_to_user) and quantify each in nanoseconds for your specific hardware. You will be able to explain to a non-specialist why a `recv()` call takes 3 microseconds and why that floor cannot be moved by application-level changes.

2. **Build a production-grade DPDK packet processor in C++** using the Poll Mode Driver model, hugepage-backed mempools, RX/TX rings, the EAL lcore abstraction, and NUMA-aware port assignment. You will write code that initializes the EAL, configures rte_flow rules for RSS hashing, processes 100 Gbit/s of traffic on a single dual-port Mellanox ConnectX-6, and shuts down cleanly without leaking hugepages.

3. **Implement an AF_XDP zero-copy receiver** with a custom XDP eBPF redirect program, libxdp socket setup, UMEM frame management, and FILL/COMPLETION ring discipline. You will know the exact cases where AF_XDP beats DPDK (shared NIC with the kernel stack, container-friendly deployment) and where DPDK still wins (raw throughput, mature ecosystem).

4. **Program RDMA verbs directly** through libibverbs, including PD/MR/QP/CQ lifecycle, RC vs UD vs UC connection types, signaled vs unsignaled work requests, inline data, and one-sided RDMA_READ/WRITE semantics. You will be able to read FaRM, RAMCloud, HERD, and eRPC source code and reason about why each chose its specific verb pattern.

5. **Use Solarflare/Xilinx ef_vi and OpenOnload** to achieve sub-microsecond UDP receive on commodity hardware. You will understand the LD_PRELOAD model of OpenOnload, when to use ef_vi raw API instead, and what the Cisco Nexus 3550 baseline (the canonical sub-100ns exchange-grade switch) looks like in the latency chain.

6. **Configure a Linux host for kernel bypass** including BIOS settings (C-states off, turbo policy, hyperthreading decisions), kernel command line (isolcpus, nohz_full, rcu_nocbs, processor.max_cstate=1, intel_idle.max_cstate=0), tuned profiles, IRQ affinity, hyperthread peer halting, NUMA pinning, and hugepage allocation. You will be able to take a stock Ubuntu install and produce a tick-to-trade-grade host.

7. **Implement a deterministic limit order book** in C++ with both price-level and order-id indexing, conflation logic, packet loss recovery (retransmit request to the exchange), and microbenchmarks that demonstrate sub-200ns add/cancel/match operations. You will know why malloc is forbidden in this code path and what to do instead (slab allocator, intrusive lists, fixed-size pools).

8. **Design a kernel-bypass order entry fast path** using either FIX SBE, CME iLink 3 binary, or Nasdaq OUCH 5.0 wire formats, encoded directly into TX mbufs without intermediate copies, with batched MMIO doorbell writes and tradeoff-aware flushing strategies. You will be able to defend your choice of synchronous vs asynchronous send in a design review.

9. **Profile and benchmark a kernel-bypass system** using HdrHistogram for latency, hardware-timestamped pcap (PHC + tcpdump -j), TRex/MoonGen/pktgen-dpdk for synthetic load, and analyze tail latency without coordinated omission. You will produce p50, p99, p99.9, p99.99, and max latency numbers that are defensible in front of an exchange compliance audit.

10. **Reason about DPU and SmartNIC offload** including the Nvidia BlueField-3 DOCA programming model, AWS Nitro card boundaries, Intel IPU E2100 P4 pipelines, and eBPF-on-NIC. You will be able to sketch which parts of a stack (firewall, load balancer, TLS termination, telemetry) belong on the DPU versus the host, and why.
