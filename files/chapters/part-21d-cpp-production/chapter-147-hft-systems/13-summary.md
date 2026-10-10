## Key Takeaways

- **Kernel bypass is the foundation.** The Linux kernel network stack adds 50-200 μs. DPDK eliminates this by having the application poll the NIC directly in user space. No kernel-bypass means no competitive HFT on software alone. The DPDK poll-mode driver loop, `rte_eth_rx_burst` in a tight while(true), is the starting point for every serious HFT system.

- **Measurement must precede optimization.** Use `rdtsc` with pipeline serialization (`cpuid` + `rdtsc`) for sub-nanosecond overhead timing. Calibrate TSC frequency against `CLOCK_REALTIME` at startup. Never use naive back-to-back latency measurement, use scheduled arrival times to avoid coordinated omission, which will hide your actual p99 by an order of magnitude.

- **The lock-free order book is a price-indexed array.** O(1) updates, cache-friendly layout, no dynamic allocation. The single-writer multiple-reader pattern eliminates all synchronization on the hot path: the feed handler writes with release stores. Strategy threads read with acquire loads. `std::map` is 10-100x slower under production message rates.

- **Hardware timestamps are not optional.** Software timestamps have 1-100 μs jitter from OS scheduling. NIC hardware timestamps record packet arrival at the wire with < 10 ns precision. Use `SO_TIMESTAMPING` with `SOF_TIMESTAMPING_RX_HARDWARE` and PTP synchronization across machines. Without hardware timestamps, your latency analysis is noise.

- **FPGAs push the boundary from microseconds to nanoseconds.** An FPGA processes a market data packet and generates an order decision in 100-500 ns, before the packet would even finish traversing DPDK. FPGA development requires HLS tools or VHDL/Verilog expertise and significantly longer iteration cycles than C++, but it is the only path to sub-microsecond wire-to-wire latency.

- **Geographic proximity dominates at the macro scale.** No software optimization overcomes the speed-of-light disadvantage of being 100 km from the matching engine. Colocation (NY4 for NYSE, NY5 for NASDAQ) reduces round-trip latency from milliseconds to microseconds. Microwave networks (Chicago to New York: ~4 ms vs ~6.5 ms fiber) provide a 30% speed-of-light advantage for inter-market arbitrage.

- **Pre-trade risk must complete in under 500 ns.** Locks, heap allocation, and syscalls are banned on the critical path. Use `std::atomic` for position counters and circuit breakers, `rdtsc`-based token buckets for rate limiting, and `__attribute__((always_inline))` to eliminate function call overhead. Order checks fast to slow: fat finger → notional → position → price band → rate limit. The Knight Capital \$440M loss in 45 minutes is the canonical example of what happens when risk is bypassed.

- **The SPSC ring buffer is the correct inter-thread communication primitive.** Feed handler and strategy run on separate pinned cores. The SPSC ring buffer passes events between them with zero contention: producer uses release stores, consumer uses acquire loads, head and tail are on separate cache lines. No mutex, no condition variable, no atomic CAS failure loops.

- **Go belongs on the warm and cold paths.** GC pauses (even sub-millisecond ones), goroutine scheduler preemption, and lack of `rdtsc` intrinsics make Go incompatible with nanosecond latency targets. Go excels at order management systems, backtesting engines, risk dashboards, data pipelines, and infrastructure tooling, all components that exist at the same firm as the C++/FPGA hot path, just running at different latency tiers.

- **The HFT stack is a distributed system with physics constraints.** The speed of light, the PCI-E bus width, the DRAM access time, and the x86 cache hierarchy are all hard limits that determine what is possible. Understanding these limits, and which software techniques approach them, is the difference between engineering and guessing. Every nanosecond of unnecessary work is a nanosecond of competitive disadvantage.

---

| [◀ Chapter 146: Compiler and Interpreter Design](../chapter-146-compiler-interpreter-design/00-introduction.md) | [Chapter 147: High-Frequency Trading Systems](00-introduction.md) | [Chapter 148: GPU Programming (CUDA/Compute)](../chapter-148-gpu-programming/00-introduction.md) ▶ |
