## Interview Questions: Kernel-Bypass Networking

The interview questions in this chapter are written to the bar of an L5 or L6 networking-track candidate at FAANG, or a senior HFT engineer at Citadel Securities, Jump, HRT, Two Sigma, or Jane Street. Each question expects 5-10 minutes of detailed discussion. The "expected answer" sketches what an interviewer is listening for, a strong candidate goes deeper than the sketch.

---

#### 1. Walk me through every cost in a `recv()` call from a kernel TCP socket on Linux. Quantify each in nanoseconds.

Expected: NIC DMA, MSI-X interrupt dispatch, hard IRQ, NAPI softirq schedule, sk_buff alloc from slab, GRO coalesce, ip_rcv route + netfilter, tcp_v4_rcv socket lookup, tcp_rcv_established state machine, sk_data_ready wakeup, syscall entry (KPTI cost on modern kernels), copy_to_user, syscall return. Total ~3 microseconds warm cache, much worse under load. Candidate should know the KPTI/Spectre tax and how it changed post-2018.

#### 2. When would you choose AF_XDP over DPDK and vice versa?

Expected: AF_XDP for shared NIC (kernel still owns most queues), container-friendly (no hugepage mount), lower CPU when not at line rate (needs_wakeup), works with existing tooling (tcpdump, ethtool). DPDK for max pps on a single core, mature offload coverage (rte_flow), multi-vendor abstraction. Combined deployments are common (XDP for ingress/DDoS, DPDK for data plane). A candidate should know that AF_XDP requires zero-copy mode for performance parity, and that the driver must support it.

#### 3. Explain the symmetric Toeplitz RSS key. Why does it matter for stateful applications?

Expected: Microsoft's symmetric key (`0x6d 0x5a 0x6d 0x5a ...`) makes the Toeplitz hash output identical for `(src, dst)` and `(dst, src)` 4-tuples, ensuring both directions of a flow land on the same RX queue. Critical for stateful processing (NAT, TCP termination, DPI) so connection state is on one core. Without it, a connection's two directions arrive on different cores and cross-core synchronization is required.

#### 4. What is hugepage-backed memory, why does DPDK require it, and what is the IOMMU's role?

Expected: hugepages reduce TLB pressure (1 GiB page = 1 TLB entry covering 256K 4KB equivalents) and guarantee physical contiguity needed for DMA (or via IOMMU mappings). DPDK uses `vfio-pci` driver which sets up IOMMU domain-managed DMA mappings. The IOMMU prevents misaddressed DMA from corrupting host memory, providing a security isolation comparable to user-space syscalls. Without IOMMU (uio_pci_generic), DPDK still works but loses the safety net.

#### 5. Explain the difference between RDMA SEND, RDMA_WRITE, and RDMA_READ. When would you use each?

Expected: SEND/RECV is two-sided (receiver must post a RECV), analogous to TCP message. RDMA_WRITE is one-sided (writer pushes to a remote address using rkey), receiver CPU not involved unless WRITE_WITH_IMM is used. RDMA_READ is one-sided (reader pulls), zero remote CPU. Use SEND for control messages and complex stateful exchanges. Use RDMA_WRITE for high-throughput unidirectional pipes and lock-free data structure updates with versioning. Use RDMA_READ for read-mostly KV stores. Should mention that HERD found two-sided UD beats one-sided RC for many workloads because of QP-cache pressure.

#### 6. Why does HFT require disabling C-states, and what does it cost in power?

Expected: C-state exit latency (especially C6) is 30-100 microseconds, which dominates any sub-microsecond budget. Disabling C-states (or restricting to C0/C1) keeps cores at full power, ~150W per CPU. That power cost is acceptable in a colocation rack (the difference between \$300/month and \$400/month) but unacceptable for a phone or laptop. Also covers `processor.max_cstate=1` and `intel_idle.max_cstate=0` for the kernel to honor the request, and `idle=poll` to make idle cores spin rather than HLT.

#### 7. What is the purpose of `nohz_full`, and why is it not enough by itself?

Expected: `nohz_full` removes the periodic timer tick from a CPU when exactly one task is runnable there. Saves ~250ns per millisecond of jitter. But by itself it does not stop kworker threads, RCU callbacks, or system tasks from being scheduled there. Must be combined with `isolcpus`, `rcu_nocbs`, IRQ affinity, and cpuset cgroups for full isolation. Also: `nohz_full` requires `rcu_nocbs` to actually skip the tick, otherwise RCU still wakes up the core periodically.

#### 8. How would you achieve sub-100-nanosecond clock synchronization across hosts?

Expected: PTP IEEE 1588 with G.8275.1 telecom profile, hardware boundary-clocked switches (Cisco Nexus 3550, Mellanox SN), GPS-disciplined grandmaster, hardware-timestamped packets via PHC. `ts2phc` from the linuxptp package can sync the NIC's PHC directly to a 1PPS GPS input, bypassing PTP entirely on the host. Software clock is then disciplined from the PHC via `phc2sys`. Application reads PHC directly via `clock_gettime(CLOCK_PHC0, ...)` for the lowest-jitter timestamps.

#### 9. Design a deterministic limit order book in C++. What data structures do you use and why?

Expected: tick-indexed array for price levels (O(1) updates, O(BBO-distance) BBO recompute), open-addressed hash table for order_id lookup, intrusive doubly-linked FIFO list at each level for queue position. Slab-allocated Order objects, no malloc on hot path. BBO tracked as a tick index updated incrementally, recomputed only when the BBO level empties. Conflation snapshots published via seqlock. Replay determinism comes from sorting iteration when emitting snapshots.

#### 10. What is coordinated omission in latency benchmarking?

Expected: when a request is delayed, the next request is also delayed because the loop is stuck waiting, the second request's lateness is invisible. Naive benchmarks measure only completed requests' wait time, not the omitted ones. Fix: drive at a fixed rate independent of completion timing, which exposes the queue buildup as additional latency on subsequent requests. `wrk2` (Gil Tene's fork) and HdrHistogram are the standard tools.

#### 11. What is false sharing and how do you detect and fix it?

Expected: two threads writing different variables on the same cache line cause MESI coherence traffic that destroys parallel scaling. Detect with `perf c2c record/report`, which ranks lines by HITM events. Fix by padding each variable to a cache line (`alignas(std::hardware_destructive_interference_size)` or `alignas(64)`) or by interleaving thread-local data so different threads' working sets occupy different lines.

#### 12. Compare DOCA on BlueField-3, AWS Nitro, and Intel IPU programming models.

Expected: BlueField runs ARM Linux (DOCA OS), programmed with DOCA SDK in C/C++, includes DOCA Flow (rte_flow superset), DPDK, rdma-core, and access to ConnectX-7 hardware accelerators. AWS Nitro is not user-programmable, it is Amazon's internal hypervisor security boundary. Intel IPU has a P4-programmable pipeline (Tofino-derived) plus ARM cores, programmed with P4 for the dataplane and IPDK for slow path. Marvell OCTEON is similar to BlueField but more carrier-focused. Choose based on programming model preference, NIC vendor lock-in, and which functions you need to offload.

#### 13. Walk me through the QUIC + AF_XDP architecture.

Expected: XDP program installed in driver mode redirects UDP/443 traffic to AF_XDP socket on the appropriate queue. UMEM frames are pre-filled. Application reads packets from RX ring, hands payload to QUIC engine (msquic, lsquic, quiche), engine returns reply payload, application encapsulates in UDP/IP/Ethernet, writes to TX ring. Kernel still owns non-QUIC traffic on the same NIC. Performance ~3x kernel UDP at scale.

#### 14. What does it take to make the same C++ DPDK binary run identically on two different hardware models without performance variance?

Expected: confirm NUMA, NIC PCIe gen, hugepage size are the same, pin lcores to identical CPU IDs (which requires identical BIOS topology), validate that the same offload set is supported, check that ring depths and mempool sizes do not exceed firmware limits on the smaller box, reproduce BIOS settings (turbo policy, C-states), validate jitter test passes the same threshold. Containerized with VFIO mount but not full container abstraction.

#### 15. Why is `_mm_pause()` important in a busy-poll loop?

Expected: hints to the CPU that this is a spin-wait, releases execution slots to the HT peer, reduces the cost of the speculative memory ordering machinery (memory pipeline drain on lock-acquire patterns), and on Skylake-X+ specifically, increases pause latency to ~140 cycles which gives more time for the predicted store to land before the next iteration. Without it, a tight load-only loop trips the front-end and reduces overall IPC. PAUSE is part of the spin-wait idiom in every well-tuned ring buffer reader.
