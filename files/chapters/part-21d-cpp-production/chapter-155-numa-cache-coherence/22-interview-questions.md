## 22. Interview Questions

These questions are calibrated for senior and staff systems engineering interviews at FAANG, HFT shops, and infrastructure-focused companies. Each one expects an answer that goes from the high-level concept to the underlying hardware mechanism.

### Question 1: MESI Walkthrough

**Two threads on different cores both read and modify the same `std::atomic<int>` repeatedly. Walk through the MESI state transitions for one full read-modify-write cycle on each core. What is the throughput limit and why?**

Expected answer: cover the I -> S -> M -> I sequence on each side, the invalidation messages, the snoop responses. Throughput limit: ~10 to 100 million RMW per second total across both cores, bounded by the cache-to-cache transfer rate (which is bounded by the interconnect, not by CPU speed). On a single contended line, no amount of CPU horsepower changes the answer.

### Question 2: False Sharing Detection

**A profiler shows your program has 0.3 IPC. CPU use is 100 percent. What hardware events would you sample to determine whether false sharing is the cause? What output would confirm or rule it out?**

Expected: `perf c2c record`, look at HITM hot lines, especially `mem_load_l3_miss_retired.remote_hitm` and `mem_load_l3_hit_retired.xsnp_hitm`. A confirmation would be a HITM hot line shared by writers from multiple cores, with the line offset identifying a specific data structure field. Rule-out: if HITM events are rare and the IPC issue is elsewhere (instruction mix, branch misprediction, cache misses unrelated to sharing).

### Question 3: NUMA Memory Placement

**A service starts up by loading 100 GB of data into memory in a single initialization thread. After startup, 4 worker threads (one per NUMA node) process the data. Why is performance bad? Two ways to fix it.**

Expected: first-touch placed all 100 GB on the init thread's node. Workers on other nodes pay remote DRAM latency on every access. Fixes: (1) parallelize loading with a thread per node, each pinned and using `numa_alloc_onnode`, (2) `numa_interleaved` for workloads that benefit from aggregate bandwidth. Migrate after the fact (`move_pages` or AutoNUMA) is an option but expensive.

### Question 4: Pinning Mechanics

**Explain `isolcpus`, `nohz_full`, `rcu_nocbs`, `sched_setaffinity`, and `taskset`. When would you use each, and what is the order of operations to dedicate a CPU to a single thread?**

Expected: `isolcpus` keeps the kernel from auto-scheduling tasks on the listed CPUs. `nohz_full` removes the periodic timer tick on those CPUs (sub-microsecond jitter). `rcu_nocbs` moves RCU callback processing off them. These are kernel boot parameters. `sched_setaffinity` is the runtime API, pin the thread to the isolated CPU. `taskset` is the command-line equivalent. Order: boot with the parameters, start the application, application calls `sched_setaffinity` to bind specific threads to the isolated CPUs.

### Question 5: Cache Line Padding

**Show me how to correctly pad a multi-field struct so that two fields written by different threads do not false-share. Explain why `alignas(64)` on the struct is not sufficient.**

Expected: `alignas(64)` on the struct aligns the start at 64 bytes but does not separate fields within. The fix is `alignas(64)` on each field (so each gets its own line), or explicit padding bytes between fields, or putting each field in its own struct. Demonstrate with code. Mention `std::hardware_destructive_interference_size` as the portable constant, with the caveat that it is currently 64 on libstdc++ even when targeting Apple's 128-byte lines.

### Question 6: Streaming Stores

**You are writing 1 MB of data that the same thread will read again 100 microseconds later. Should you use streaming stores? Why or why not?**

Expected: no. 1 MB will fit in L2 (or low-level L3) for 100 microseconds easily. Streaming stores would push the data to DRAM, and the read 100 microseconds later would be a DRAM access (~100 ns per line). With normal stores, the data stays in cache and the read is fast. Streaming stores are for write-once-and-forget patterns: logging, network buffers, video frames.

### Question 7: Cross-Socket Atomic Cost

**Estimate the latency of a single `fetch_add` on a `std::atomic<uint64_t>` when contended between threads on different sockets of a Sapphire Rapids dual-socket box. Estimate the same for an EPYC 9654 dual-socket. What is the bottleneck?**

Expected: 200 to 400 ns on Intel, 300 to 600 ns on AMD. Bottleneck: the cache-to-cache transfer over UPI (Intel) or xGMI (AMD), plus the coherence protocol overhead (directory lookup, snoop, invalidation acknowledge). The CPU is mostly stalled during this time, regardless of clock speed.

### Question 8: Hugepages Trade-Off

**A service has a 100 GB working set and is dTLB-miss-bound. You can use 2 MB or 1 GB hugepages. What are the trade-offs? Which would you use?**

Expected: 2 MB pages give ~4 GB TLB coverage with a 2048-entry L2 dTLB, 100 GB does not fit. 1 GB pages give ~2 TB coverage, the entire working set fits. 1 GB has higher reservation rigidity (each page is 1 GB, sparse usage wastes capacity), and they must be reserved at boot or shortly after. For a steady-state 100 GB working set, 1 GB pages are appropriate. Document the kernel parameters (`hugepages=N default_hugepagesz=1G`).

### Question 9: When to Use MPOL_INTERLEAVE

**Describe one workload that benefits from `MPOL_INTERLEAVE` and one that suffers. Defend each choice.**

Expected: benefits: a large analytic scan that touches all data evenly. Interleaving spreads the bandwidth across all DRAM controllers, maximizing aggregate throughput. Suffers: a per-shard OLTP workload where each request touches a small piece of data. Interleaving spreads each shard's data across all nodes, so every access has a (1 - 1/N) probability of being remote. First-touch with thread pinning is correct here.

### Question 10: AutoNUMA Decision

**A team disabled AutoNUMA balancing and saw a regression on a mixed workload. Another team disabled it on a pinned workload and saw a 15 percent improvement. Explain both outcomes.**

Expected: the mixed workload had pages whose access pattern shifted over time. AutoNUMA was migrating pages to the right node, gaining locality. The pinned workload had pages with stable placement, the AutoNUMA scanning was pure overhead (page-table walks, NUMA hint faults, useless migrations). The lesson: AutoNUMA is workload-dependent. Default-on is reasonable for general-purpose, default-off is correct for explicitly placed services.

### Question 11: NIC NUMA Alignment

**On a dual-socket box, the NIC is on socket 0's PCIe. Your application has 32 worker threads. How should you distribute them across sockets, and how should you configure IRQ affinity?**

Expected: pin RX/TX IRQs to socket 0's CPUs (the NIC's local node). Run all 32 workers on socket 0 if the workload fits, or 16 on socket 0 and 16 on socket 1 if you need to use both sockets, but accept the cross-socket cost on packets handled by socket 1 workers. Better: dual-NIC, one per socket. Check `cat /sys/class/net/eth0/device/numa_node` to confirm.

### Question 12: Designing for Future Hardware

**Your codebase will be deployed on hardware ranging from a single-socket EPYC 9554 (no CXL) to a dual-socket Granite Rapids with 1 TB of CXL.mem. How do you write the memory subsystem so it works well on both without conditional compilation?**

Expected: abstract the placement decision behind a memory resource interface (`std::pmr` or equivalent). At startup, build a topology map: enumerate NUMA nodes, classify each as local DRAM, remote socket DRAM, or CXL.mem (by checking `/sys/devices/system/node/N` for CPU presence and distance). Allocator returns the right tier based on access pattern hint. On the EPYC box without CXL, the "cold tier" maps to the same local DRAM. On the Granite Rapids box, it maps to CXL. Code is identical, topology answers the question.

---
