## Interview Questions

These questions are representative of what you will encounter in C++ HFT infrastructure interviews at firms like Citadel Securities, Jump Trading, Virtu Financial, IMC, and Optiver.

---

### Q1: Why does kernel bypass matter? Give specific latency numbers.

The Linux kernel's network stack adds 50-200 μs of latency to packet processing. This comes from interrupt handling (the NIC raises a hardware interrupt. Whatever core handles it must context-switch), kernel socket buffers (the packet is copied from kernel to user space), and the protocol stack overhead (IP/UDP processing in kernel mode).

DPDK (Data Plane Development Kit) bypasses all of this. The application runs a poll-mode driver that reads packets directly from the NIC's descriptor ring in user space with no interrupts, no context switches, and no copies. The NIC to application latency drops from 50-200 μs to 1-5 μs.

At the extreme end, an FPGA with a direct optical connection to the NIC receives and processes packets in 100-500 ns, before the packet ever reaches a CPU. This is why firms that compete on latency use FPGAs for their market data parsing and early signal generation.

The practical answer for a software-only system: DPDK is the minimum required for latency-sensitive HFT. Anything using the kernel socket API is non-competitive for the critical path.

---

### Q2: Design a lock-free order book. What data structure do you use and why?

The canonical choice is a **price-indexed array**: a flat array where the index is the price in ticks.

```
bids_[price_tick] = atomic<uint64_t> qty
asks_[price_tick] = atomic<uint64_t> qty
best_bid_         = atomic<int32_t>
best_ask_         = atomic<int32_t>
```

Advantages: O(1) add, remove, and lookup by price. Contiguous memory for cache efficiency. No dynamic allocation. Lock-free reads with a single acquire load.

`std::map` is O(log N) and requires dynamic allocation. A sorted array with binary search is O(log N). A hash map has O(1) average but poor worst-case and requires collision handling. The price-indexed array beats all of them for instruments with bounded price ranges.

The single-writer multiple-reader property is critical: the feed handler is the only writer, so writes use `memory_order_release` stores. Strategy threads read with `memory_order_acquire` loads. No CAS loops, no ABA problem, no locking on the read path.

Cache line alignment: use `alignas(64)` on the Level struct. Without it, adjacent price levels share cache lines, and a write to one invalidates the cache for nearby levels accessed by reader threads (false sharing).

For order cancel/modify: maintain a parallel `absl::flat_hash_map<uint64_t, OrderRecord>` mapping order IDs to price/qty/side. Pre-allocate with `reserve()` at startup.

---

### Q3: What is coordinated omission and how do you avoid it in latency measurement?

Coordinated omission occurs when a latency measurement system stops issuing new requests during periods of high latency, effectively hiding the worst-case behavior from the histogram.

Example: you issue requests at 1 per millisecond. One request takes 100 ms. During those 100 ms, your loop is blocked, so no new requests are issued. When the 100 ms request completes, the histogram shows one sample at 100 ms and 99 missing samples that were never sent. The histogram's p99 reflects 99% of the requests that were sent without the 100 ms delay, not 99% of the requests that would have been sent at the target rate.

The fix: use **scheduled arrival times**. Before the loop starts, compute when each request should arrive based on the target rate. At each iteration, busy-wait until the scheduled time, then issue the request and record latency as `actual_completion_time - scheduled_arrival_time`. This way, if a request takes 100 ms, the next 99 requests are all recorded as waiting for 100 ms plus their own service time.

This is the methodology HdrHistogram was designed to support. In HFT latency testing, always use scheduled arrivals. Never use back-to-back measurement.

---

### Q4: FPGA vs CPU: when do you use each?

Use a CPU when:
- The logic changes frequently (algorithm updates happen weekly or monthly).
- The latency target is 1-10 μs (software on a tuned CPU with DPDK can achieve this).
- The logic is complex, branchy, or data-dependent in ways that resist pipelining.
- Developer iteration speed matters more than absolute latency.

Use an FPGA when:
- Latency target is < 500 ns, impossible in software.
- The protocol being decoded is stable (ITCH changes rarely).
- The trading signal is simple enough to implement in combinational logic.
- The firm can afford the development time: FPGA RTL development takes 10x longer than equivalent C++.
- Determinism matters more than average performance: FPGA latency is almost perfectly deterministic (no jitter from scheduler, GC, cache misses), which is valuable for strategies that need to guarantee response times.

The practical split: most firms use FPGAs for market data parsing and early risk pre-checks, then hand off to a CPU for the actual signal evaluation and order construction. Pure FPGA strategies (where the trading decision is also made in the FPGA) exist but are rare and require extensive verification.

---

### Q5: How do hardware timestamps differ from software timestamps? What is PTP?

A software timestamp is recorded by the CPU at the moment the application (or kernel) reads the packet. By this time, the packet has already spent time in the NIC buffer, the DMA descriptor ring, and the kernel socket queue. Software timestamps have jitter of 1-100 μs depending on system load.

A hardware timestamp is recorded by the NIC at the exact moment the first byte of the packet crosses the wire. It is generated by a counter on the NIC that increments at a fixed nanosecond rate, completely independent of the CPU and OS state. Hardware timestamp jitter is < 10 ns.

Hardware timestamps are accessed via `SO_TIMESTAMPING` with `SOF_TIMESTAMPING_RX_HARDWARE`. They are delivered as ancillary data in `recvmsg()` via a `scm_timestamping` struct. The raw hardware timestamp uses the NIC's internal clock domain.

PTP (Precision Time Protocol, IEEE 1588) synchronizes NIC hardware clocks across multiple machines to a common grandmaster clock. This allows comparing hardware timestamps from different machines, essential for measuring end-to-end latency from when the exchange sent a packet to when you received it. `ptp4l` runs on each host and synchronizes the NIC PHC (PTP Hardware Clock). `phc2sys` syncs the system clock to the NIC clock. With PTP-aware switches and GPS-disciplined grandmasters, synchronization accuracy of < 50 ns is achievable.

---

### Q6: Design a pre-trade risk engine that completes every check in under 500 ns.

Key design decisions:

**No locks.** A mutex acquisition costs 50-200 ns even uncontended. Use `std::atomic` for all shared state. The single-writer pattern (only the order submission thread calls `check_order`) allows relaxed or release/acquire ordering rather than `seq_cst`.

**No heap allocation.** `check_order()` must not call `new`, `malloc`, or any container operation that might allocate. All state is pre-allocated in the `RiskEngine` object at startup.

**Ordered checks: fastest first.** Put the cheapest check first (fat finger: two integer compares), most expensive last (price band: floating-point divide). If any check fails, the function returns immediately, saving the cost of remaining checks.

**Atomic position tracking.** `net_position_` is `std::atomic<int64_t>`. The check reads with `memory_order_acquire` (because the fill handler writes with `memory_order_release`). No CAS is needed for the read. Only the read-modify-write in `on_fill` needs to be atomic.

**Token bucket with TSC.** The order rate limiter uses `rdtsc` instead of `clock_gettime` to avoid a syscall (20-50 ns overhead). Token refill is computed from elapsed TSC ticks.

**Inline everything.** `check_order` is marked `__attribute__((always_inline))` to eliminate the function call overhead and allow the compiler to see across the call boundary.

**Circuit breaker with `[[unlikely]]`.** The halted flag is checked first but marked `unlikely`, in normal operation the branch is never taken. The CPU branch predictor learns this and the check costs approximately one cycle.

---

### Q7: Explain the microwave vs fiber latency advantage. How is it exploited?

Fiber uses total internal reflection to carry light through glass. Due to refraction, light travels at approximately 200,000 km/s in glass, about two-thirds the speed of light in vacuum (300,000 km/s).

Microwave radio signals travel through air at nearly the speed of light in vacuum. Over the same geographic distance, microwave arrives approximately 30% faster than fiber, but only if the microwave path follows the geographic straight line, and fiber always takes a longer route due to the need to follow roads and conduits.

For Chicago to New York (geographic distance ~1,200 km):
- Fiber (following roads, ~1,300 km): ~6.5 ms one-way
- Microwave network (near straight line): ~4.0-4.1 ms one-way
- Advantage: ~2.4 ms

This 2.4 ms matters because CME (Chicago) and NYSE/NASDAQ (New York) prices are linked. When a large trade happens in New York, Chicago prices should update to reflect it. A firm with microwave connectivity receives the New York signal 2.4 ms before fiber-connected competitors and can act on it in Chicago before those competitors.

Jump Trading, McKay Brothers, Vigilant Global, and Optiver operate microwave networks on this route. The towers require FCC licenses, tall structures with line-of-sight to the next tower, and careful maintenance. Rain and fog attenuate the signal. Engineering diversity (multiple paths, automatic failover) is required for reliability.

---

### Q8: What are DPDK hugepages, and why are they required?

Standard Linux memory management uses 4 KB pages. The CPU maintains a TLB (Translation Lookaside Buffer) that caches the mapping from virtual to physical addresses. The TLB has limited capacity (64-1024 entries for L1). For normal application memory, TLB misses are handled by the hardware page table walker, adding ~10-50 ns per miss.

DPDK requires large, physically contiguous memory regions for NIC DMA buffers. A single 10 GbE NIC processing 14 million packets per second at 64 bytes each uses hundreds of megabytes of packet buffer memory. With 4 KB pages, this requires tens of thousands of TLB entries, far exceeding TLB capacity and causing constant TLB misses on every DMA access.

Hugepages (2 MB or 1 GB pages) solve this: 1 GB of packet buffers requires only one TLB entry instead of 262,144. With hugepages, the DMA buffer region stays in the TLB permanently, eliminating TLB miss latency.

Additionally, hugepages are pinned (not swappable), which is required for DMA: the NIC's DMA engine uses physical addresses, and the page must not be remapped while a DMA transfer is in progress. Regular pages can be swapped out by the kernel. Hugepages cannot.

Configuration: `echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages` reserves 2 GB of 2 MB hugepages. DPDK's EAL (`rte_eal_init`) uses these for all packet pools.

---

### Q9: A firm is running at 2 μs latency and wants to improve to 500 ns. What do you change first?

Start with measurement: use hardware timestamps to decompose the 2 μs into its components. Typical breakdown:

- NIC to DPDK descriptor ring read: ~50 ns
- UDP header parsing: ~20 ns
- ITCH message parsing: ~100-300 ns (the largest software component)
- Order book update: ~50-100 ns
- Signal evaluation: ~100-500 ns
- Order construction + DPDK TX: ~200-300 ns

To get from 2 μs to 500 ns you need to move the market data parsing and at least the order book update to the FPGA. An FPGA can parse ITCH in a single clock cycle (4 ns at 250 MHz) and update an in-FPGA BRAM-based order book in 2-3 cycles.

The CPU retains the signal evaluation unless the strategy is simple enough to implement in FPGA logic (a dedicated FPGA team can implement common strategies like top-of-book momentum or statistical arbitrage in < 50 ns).

For the order submission path, FPGA-based order construction and transmission via a direct FPGA network port eliminates the CPU's 200-300 ns contribution.

After FPGA integration, the remaining latency is dominated by the PCIe communication overhead if the CPU is involved, or purely by the FPGA pipeline and optical network latency if the order goes directly from FPGA to NIC.

---
