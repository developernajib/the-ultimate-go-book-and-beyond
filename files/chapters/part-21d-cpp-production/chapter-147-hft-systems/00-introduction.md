# Chapter 147: High-Frequency Trading Systems

> "In HFT, the edge is measured in nanoseconds and lost in microseconds.", Unknown

High-frequency trading is the domain where C++ meets its absolute limits. Most software engineering operates in a world where a millisecond is fast and a microsecond is imperceptibly short. HFT engineers live in a world where a microsecond is catastrophically slow, a nanosecond matters, and the speed of light itself becomes a hard engineering constraint.

This chapter covers the complete HFT stack from wire to risk engine. Every technique here is drawn from real practice at firms like Citadel Securities, Jump Trading, Virtu Financial, IMC, and Flow Traders. Jane Street famously uses OCaml for strategy logic, but their C++ and FPGA infrastructure follows the same principles. The common thread is this: the market is a distributed system where latency determines profit, and every layer of the stack, operating system, network, memory, processor, introduces latency that must be measured, understood, and eliminated.

## What Makes HFT Different

A typical web server handles thousands of requests per second and considers sub-10ms response times acceptable. An HFT system handles millions of market data messages per second and cannot tolerate a single response that takes longer than 10 microseconds. The difference is not just quantitative. It requires a fundamentally different engineering philosophy.

In conventional software, the operating system scheduler, garbage collector, and memory allocator are invisible infrastructure. In HFT, each of these is a source of jitter that must be bypassed, pinned, or pre-allocated away. The kernel's TCP/IP stack, which processes millions of packets per second across the entire internet, is far too slow, you bypass it entirely with DPDK and poll the NIC directly from userspace. Dynamic memory allocation during the critical path is banned. System calls are eliminated. Interrupts are disabled on hot cores.

Go engineers transitioning to this domain face a conceptual shift. Go's garbage collector, goroutine scheduler, and runtime abstractions, all of which make Go excellent for networked services, are incompatible with sub-microsecond latency targets. A GC pause of even 100 microseconds, rare as it is in modern Go, would be a catastrophic outlier in an HFT system. This does not make Go useless at trading firms. It just means Go lives in a different layer of the stack. We will be explicit about where Go fits and where it cannot.

## The Latency Stack

Understanding HFT requires understanding the latency at each layer of the system:

- **Wire latency**: governed by the speed of light, roughly 5 μs per 1000 km in fiber. This is irreducible physics.
- **Kernel network stack**: adds 50-200 μs. Eliminated with kernel bypass (DPDK, Solarflare OpenOnload).
- **Kernel bypass NIC to application**: 1-5 μs. The baseline for software-only HFT systems.
- **FPGA processing**: 100-500 ns. Pre-parse protocols and pre-compute decisions in hardware.
- **ASIC**: 10-50 ns. Used by exchanges themselves and a handful of ultra-low-latency firms.

Each layer in this chapter corresponds to one of these levels. We start with measurement, because you cannot optimize what you cannot measure, and build up through kernel bypass networking, lock-free data structures, hardware timestamps, FPGA integration, colocation, feed handlers, and risk engines.

## Prerequisites

This chapter assumes you have read the previous chapters on SIMD, memory models, lock-free programming, and custom allocators. You should be comfortable with:

- C++17 atomics and memory ordering semantics
- Cache hierarchy and false sharing
- x86 assembly basics (`rdtsc`, memory barriers)
- Linux networking (sockets, `epoll`, `recvmsg`)
- Template metaprogramming for zero-cost abstractions

The code in this chapter compiles with GCC 12+ or Clang 15+ on Linux x86-64. Much of it requires specific hardware (Mellanox/Solarflare NICs, Intel DPDK-compatible NICs) or kernel configuration. Where hardware is required we note it explicitly.

---
