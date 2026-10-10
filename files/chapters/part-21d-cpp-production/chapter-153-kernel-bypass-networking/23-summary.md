## Chapter 153 Summary

Kernel bypass is the discipline of removing the operating system from the network data path because, for a class of workloads (HFT, CDN, DPU), the OS's contribution is overhead rather than value. The chapter walked through the full stack of techniques.

The kernel network stack costs roughly 3 microseconds per packet on a quiet box, much more under load. The cost decomposes into interrupts, NAPI scheduling, sk_buff allocation, GRO, TCP state machine, syscall entry, and copy_to_user. Bypass removes essentially all of it, leaving a 50-80 nanosecond physical floor.

DPDK is the dominant bypass framework: poll-mode drivers, hugepage-backed mempools, RX/TX rings, and an EAL runtime that pins lcores to physical CPUs. NUMA-aware port assignment and rte_flow-driven hardware steering produce 100 GbE line rate on a single NIC with 8-16 lcores. AF_XDP is the kernel-sanctioned alternative that takes one queue rather than the whole NIC, supports zero-copy on modern drivers, and integrates better with shared hosts and containers.

RDMA is a different model: per-connection memory-to-memory primitives via libibverbs. RC for one-sided RDMA_READ/WRITE on small peer counts. UD with software reliability (eRPC pattern) for scale. Production RDMA over Ethernet (RoCEv2) requires DCQCN congestion control, PFC priority flow control, and careful switch buffer tuning.

For HFT specifically, Solarflare's OpenOnload provides an LD_PRELOAD userspace TCP/UDP stack, and ef_vi exposes the raw NIC verbs for sub-500ns receive paths. The Cisco Nexus 3550 sub-100ns switch is the canonical baseline against which the rest of the latency budget makes sense.

CPU isolation matters as much as network bypass: isolcpus, nohz_full, rcu_nocbs, halted HT peers, IRQ affinity, cpuset cgroups, BIOS C-state and turbo settings. Without these, software wins are erased by jitter from kernel housekeeping. With them, a busy-poll core sees less than 100 ns of jitter over 24 hours.

Time matters: PTP with hardware-timestamped NICs (PHC), GPS-disciplined PHC via ts2phc, sub-100-nanosecond clock alignment across the rack. Without it, latency claims are not measurable.

Application-level patterns include the deterministic order book (tick-indexed price levels plus open-addressed order ID hash plus intrusive FIFO lists), shared memory IPC via SPSC/MPSC/SPMC rings (Aeron or hand-rolled), and feed handler / order entry hot paths that allocate nothing and parse zero-copy.

DPUs (BlueField, IPU, Pensando) shift infrastructure work off the host. Choose them at hyperscale, they add operational complexity at smaller scales.

QUIC is userspace-by-design, combine with AF_XDP for the cleanest CDN bypass path. msquic and quiche are the production-grade C/C++ stacks, integrate with sendmmsg+UDP GSO for kernel paths or with AF_XDP/DPDK for bypass.

Measurement is non-negotiable: HdrHistogram with coordinated-omission-aware load generation, hardware-timestamped pcap as ground truth, perf c2c for false sharing detection, flame graphs for hot paths.

Deployment combines BIOS settings (C-states, turbo, SMT, NUMA), kernel command line (isolcpus, nohz_full, hugepages, mitigations), tuned profiles, NIC ring depths, IRQ affinity, and continuous configuration drift detection.

The interview bar for this material at L5+ FAANG and senior HFT: explain every ns of the kernel tax, defend a choice of DPDK vs AF_XDP vs ef_vi vs RDMA in a design review, design a deterministic order book, configure a host for sub-microsecond jitter, and measure with rigor. The chapter, taken together with the labs, prepares for that bar.

---

| [◀ Chapter 152: Distributed Systems in C++](../chapter-152-distributed-systems-cpp/00-introduction.md) | [Chapter 153: Kernel-Bypass and Userspace Networking in C++](00-introduction.md) | [Chapter 154: ML Inference Engines in C++](../chapter-154-ml-inference-engines/00-introduction.md) ▶ |

