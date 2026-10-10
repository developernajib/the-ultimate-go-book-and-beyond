# Capstone Project 13: High-Performance Trading System

**Difficulty**: Expert
**Estimated Time**: 4 weeks
**Target**: Ultra-low-latency Limit Order Book (LOB) matching engine and trading gateway
**Tech Stack**: Go 1.27+, CPU cache line padding, Lock-free Ring Buffers, Sync Memory Arenas, Hugepages, FIX Protocol

---

### Project Overview & Architecture

High-frequency trading (HFT) and quantitative exchange infrastructure represent the most demanding performance domain in software engineering. In financial matching engines, latencies are measured not in milliseconds, but in microseconds and nanoseconds. A single garbage collection pause or cache miss can mean millions of dollars in slippage.

In this capstone project, you will build a complete, deterministic, ultra-low-latency Limit Order Book (LOB) matching engine in Go. You will engineer the core matching algorithm using price-time priority (FIFO), implement cache-conscious data structures that fit entirely in L1/L2 CPU caches, eliminate heap allocations on the critical trading path using custom memory arenas, and implement lock-free ring buffers for multi-core order dispatching.

```
┌──────────────────────────────────────────────────────────────┐
│                    Market Participants                       │
│                                                              │
│       Trading Bots / Broker Gateways (Binary / FIX Protocol) │
└──────────────────────────────┬───────────────────────────────┘
                               │ TCP / Kernel Bypass Socket
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                   Trading Gateway & Ingestion                │
│                                                              │
│   Lock-Free SPSC / MPMC Ring Buffers (Disruptor Pattern)     │
│   ├─ Microsecond Parsing & Pre-Trade Risk Checks             │
│   └─ Zero-Allocation Order Factory (Memory Pooling)          │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│              Deterministic Matching Engine Core              │
│                                                              │
│   CPU-Pinned Single-Threaded Event Loop (Zero Locks)         │
│   ├─ Limit Order Book (Bid / Ask Doubly Linked Lists)        │
│   ├─ Price-Level Radix Tree / Direct Array Indexing          │
│   ├─ Continuous Price-Time Priority Matching Engine          │
│   └─ Execution Reports & Market Data Feed (UDP Multicast)    │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│              Audit & Deterministic Replay Log                │
│                                                              │
│   Memory-Mapped Append-Only Binary Journal (Sequential I/O)  │
└──────────────────────────────────────────────────────────────┘
```

### What You Will Build and Learn Across Sections

- **Part 1 & 2 (Core Types & Lock-Free Structures)**: Define order representations with explicit cache line padding to prevent false sharing, and build lock-free ring buffers using atomic primitives.
- **Part 3 (Zero-Allocation Memory Arenas)**: Build custom order memory pools and arena allocators to ensure 0 allocations per trade on the hot execution path.
- **Part 4 & 5 (Matching Engine & Limit Order Book)**: Implement a high-performance double-sided order book supporting limit orders, market orders, cancel requests, and fill events with price-time priority.
- **Part 6 (Pre-Trade Risk Engine)**: Implement lightning-fast risk controls (max position limits, price collars, fat-finger checks) evaluated in <50 nanoseconds.
- **Part 7 (Market Data Feed & Gateway)**: Build an asynchronous order entry gateway and an incremental L2/L3 market data multicast feed.
- **Part 8 (Microbenchmarking & Profiling)**: Measure tick-to-trade latency distributions (p50, p99, p99.9) using hardware performance counters and pprof.

### Junior → FAANG: Mechanical Sympathy in Go

- **Eliminating the Garbage Collector on Hot Paths**: Go is a garbage-collected language, but in high-frequency trading, you write Go code that *never triggers the GC*. Master escape analysis: keeping structs on the stack or in pre-allocated static slabs, avoiding `interface{}` allocations, and avoiding string-to-byte slice copies.
- **Cache Lines and False Sharing**: On modern multicore CPUs, memory is read in 64-byte cache lines. If two goroutines on different CPU cores modify adjacent fields in the same struct, the CPU cores constantly invalidate each other's caches (false sharing). Master padding structs with `_ [56]byte` to guarantee isolation.

### Senior @ FAANG: Determinism, Sequencing & Exchange Compliance

- **Single-Threaded Pinned Execution**: The most counterintuitive lesson in ultra-low-latency engineering is that multithreading is often slower than single-threading due to lock contention and context switching. Discover why industry leaders pin the matching engine loop to a single isolated CPU core (`runtime.LockOSThread`), eliminating all synchronization locks entirely.
- **Deterministic Replay for Regulatory Auditing**: Financial exchanges are legally required to reproduce identical order books in the event of disputes. Learn how append-only binary journal logging ensures that replaying sequential order streams yields the exact same execution results down to the microsecond.
