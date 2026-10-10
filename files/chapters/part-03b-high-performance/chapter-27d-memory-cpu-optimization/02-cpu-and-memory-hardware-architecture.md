## CPU and Memory Hardware Architecture

Optimizing Go code for speed requires understanding what the hardware actually does when your program runs. The diagram below shows the memory hierarchy of a typical modern CPU. Each level trades capacity for speed: L1 cache is tiny but responds in 4 cycles, while main memory holds gigabytes but takes 300 cycles to respond. Every optimization technique in this chapter targets one of these transitions, keeping data in the fast levels and avoiding trips to the slow ones.

```
┌────────────────────────────────────────────────────────────────────┐
│                  Modern CPU Memory Hierarchy                       │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  CPU Core 0                    CPU Core 1                          │
│  ┌──────────────────┐          ┌──────────────────┐                │
│  │  L1 Cache  32KB  │          │  L1 Cache  32KB  │                │
│  │  Latency:  ~4 cy │          │  Latency:  ~4 cy │                │
│  │  BW: 1TB/s       │          │  BW: 1TB/s       │                │
│  └────────┬─────────┘          └────────┬─────────┘                │
│           │                             │                          │
│  ┌────────▼─────────┐          ┌────────▼─────────┐                │
│  │  L2 Cache  256KB │          │  L2 Cache  256KB │                │
│  │  Latency: ~12 cy │          │  Latency: ~12 cy │                │
│  │  BW: 400GB/s     │          │  BW: 400GB/s     │                │
│  └────────┬─────────┘          └────────┬─────────┘                │
│           │                             │                          │
│  ┌────────▼─────────────────────▼───────┐                          │
│  │  L3 Cache (Shared)  8-32MB           │                          │
│  │  Latency: ~40 cycles                 │                          │
│  │  BW: 100GB/s                         │                          │
│  └────────────────────┬─────────────────┘                          │
│                       │                                            │
│  ┌────────────────────▼─────────────────┐                          │
│  │  Main Memory (DRAM)  GB-TB           │                          │
│  │  Latency: ~100ns (~300 cycles)       │                          │
│  │  BW: 50-100GB/s per channel          │                          │
│  └──────────────────────────────────────┘                          │
│                                                                    │
│  Cache line size: 64 bytes (x86, most ARM). Apple Silicon: 128B.   │
│  Prefetcher: detects sequential access, prefetches ~8 lines ahead  │
│  TLB: 64 entries for L1 (4KB pages), 1536 for L2                   │
└────────────────────────────────────────────────────────────────────┘
```

**Cache line width is not universal.** Intel, AMD, and most ARMv8 server parts use 64-byte cache lines. Apple Silicon (M1 and later) uses 128-byte lines. The `golang.org/x/sys/cpu` package handles this for you: its `CacheLinePad` type is sized per target architecture at compile time (64 bytes on x86-64, 128 on arm64 and ppc64, 256 on s390x), so the padding always matches the platform you build for. If you hand-pad structs to a fixed 64 bytes and later run the binary on an M-series Mac, false sharing can return silently. Prefer `cpu.CacheLinePad` over hand-rolled arithmetic.

**Key insight for Go developers**: A `map[string]int` lookup on a cold map costs several dependent loads that land on different cache lines. Since Go 1.24 the map is a Swiss Table, so the walk is the map header, then the directory, then a group's control word, then the slot itself, and finally the key bytes the string header points at. Each of those loads can be a cache miss, and a miss to DRAM costs on the order of 300 cycles. A linear scan over a `[]int` that is already in cache costs a handful of cycles per element and the prefetcher hides the rest. That is why for small N a linear scan often beats a hash map. Where the crossover sits depends on the key type and the machine, so measure it rather than trusting a remembered threshold.

> **Senior track**: Hardware counters measure this directly. `perf stat -e LLC-load-misses,LLC-loads` on a hot path gives you the LLC miss ratio. A cache-bound workload typically shows IPC under 1.0 and LLC miss rates above 1%. Pair the counter data with `pprof`'s flame graph to distinguish work-bound hot spots from memory-bound stalls. They look identical in wall clock but require different fixes.

### Junior → FAANG: the four numbers that unlock the chapter

Write these on a sticky note and put it on your monitor: **L1 is 1 ns, L2 is 4 ns, L3 is 15 ns, DRAM is 80 ns**. Every optimization in this chapter is trying to move a fetch up that hierarchy. When you read "flatten this struct to fit in a cache line," the translation is "convert a DRAM load (80 ns) into an L1 hit (1 ns)." When you read "avoid pointer chasing," the translation is "each pointer follow could be another DRAM load." When you read "struct-of-arrays beats array-of-structs," the translation is "the hot fields pack densely, the prefetcher sees a predictable stride, and one DRAM transfer feeds many operations." Note that in Go the win here is locality and prefetching, not vectorization: the gc compiler does not auto-vectorize loops. Memorize the numbers. The rest is vocabulary.

### Senior @ FAANG: mapping the hierarchy to observability

Every box in the hierarchy diagram corresponds to a `perf` counter or a `pprof` signal you should know how to read. L1/L2 pressure shows up in `L1-dcache-load-misses` and `L1-dcache-loads` ratio. L3 pressure shows up in `LLC-load-misses` and `LLC-loads`. DRAM bandwidth pressure shows up in `uncore_imc_*` counters on Intel or `memory.bandwidth.total` on AMD. TLB pressure shows up in `dTLB-load-misses`. Branch prediction shows up in `branch-misses`/`branches`. Knowing which counter answers which question is the staff-level skill. A PR that claims "I improved cache locality" without a before/after counter delta is a PR you should send back. The counters are how you keep the conversation honest, and maintaining that hygiene across a team is one of the most impactful things a senior engineer can do.

---

### Deep Dive: Modern Microarchitectures & Silicon Co-Design (Apple Silicon vs. x86-64)

In [Apple Chip Architecture From 1977 To 2026](https://medium.com/@jacob_73660/apple-chip-architecture-from-1977-to-2026-64c01d9f481c), Jacob Bartlett traces how half a century of microprocessor evolution culminated in modern systems-on-chip (SoC) architectures. Understanding these microarchitectural shifts explains why identical Go code exhibits radically different execution profiles across x86-64 and ARM64 silicon.

```
┌────────────────────────────────────────────────────────────────────────┐
│             TRADITIONAL DISCRETE X86 VS. UNIFIED SOC (UMA)             │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Traditional x86 Architecture (Discrete Bus Bottleneck):               │
│  [ CPU Core Pool ] ──DDR5 (60-90 GB/s)──► [ System DRAM ]              │
│         │                                                              │
│     PCIe Bus (16-32 GB/s, 400ns copy penalty)                          │
│         ▼                                                              │
│  [ Discrete GPU / Accelerator ] ────────► [ VRAM (GDDR6) ]             │
│                                                                        │
│  Modern Apple Silicon / ARM64 SoC (Unified Memory Architecture):       │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  [ CPU Cores ]    [ GPU Clusters ]    [ Neural / Vector Engine ] │  │
│  │         │                 │                       │              │  │
│  │         └─────────────────┼───────────────────────┘              │  │
│  │                           ▼                                      │  │
│  │              Ultra-Wide Memory Fabric                            │  │
│  │                   (100 - 800 GB/s)                               │  │
│  │                           ▼                                      │  │
│  │         [ Shared Unified LPDDR5 Pool on Substrate ]              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### 1. Unified Memory Architecture (UMA) and Zero-Copy I/O

In legacy server architectures, moving memory buffers between network interface cards (NICs), discrete GPUs, and CPU cores requires traversing PCIe interconnects. Even with DMA (Direct Memory Access), transferring a 1 GB payload incurs PCIe saturation and buffer replication.

On unified SoC architectures:
- **Shared Physical Substrate**: CPU execution units, GPU shaders, and media accelerators share a single pool of low-latency, high-bandwidth memory (ranging from 100 GB/s on base chips up to 800+ GB/s on Max/Ultra configurations).
- **Zero-Copy Inter-Device Pipelining**: In Go services performing ML inference, image encoding, or vector calculations, buffers can be passed directly from Go heap pointers to specialized accelerators without serialization or bus transfers.

#### 2. Reorder Buffer (ROB) Depth & Latency Hiding

Go's runtime and pointer-heavy idiom (such as slices of pointers `[]*T` or struct pointers across interface calls) introduce pointer dereference chains. How the CPU processes these chains depends on the Reorder Buffer (ROB):

| Architecture Dimension | Standard x86-64 Core (Intel Raptor Lake) | Apple Silicon Performance Core (M-Series) |
|---|---|---|
| **Instruction Decode Width** | 6-wide (hybrid 4+2) | 8-wide unified |
| **Reorder Buffer (ROB) Depth** | ~352 instructions | ~630 instructions |
| **Execution Ports** | 12 ports | 16 execution units |
| **L1 D-Cache Line Size** | 64 bytes | 128 bytes |
| **Memory Consistency** | Total Store Ordering (TSO) | Weakly Ordered + Hardware TSO Switch |

Because the M-series ROB holds over 600 instructions in flight simultaneously, the hardware out-of-order execution engine looks far down the instruction stream. When a Go program stalls waiting for an L2 cache miss, the CPU speculatively schedules dozens of subsequent independent arithmetic, branch, or prefetch operations. This effectively conceals memory latencies that would stall an x86 core with a shallower buffer.

#### 3. Concurrency Implications for Go Developers

1. **False Sharing at 128 Bytes**: On x86-64, two goroutines updating adjacent variables separated by 64 bytes execute without cache-line contention. On Apple Silicon, because cache lines are 128 bytes wide, two variables separated by 64 bytes occupy the **same** L1 cache line. Writes from core A invalidate the entire 128-byte line on core B, causing an immediate 5x throughput collapse. Always pad concurrent Go structures using `golang.org/x/sys/cpu.CacheLinePad`.
2. **Memory Ordering and `sync/atomic`**: ARM architectures use a weakly ordered memory model, where independent reads and writes can be reordered unless separated by memory barriers (`dmb ish`). However, Apple Silicon includes hardware support for Total Store Ordering (TSO) to enable fast x86 emulation under Rosetta 2. In Go, atomic loads and stores map to single load-acquire (`LDAR`) and store-release (`STLR`) instructions, providing sequentially consistent memory semantics with near-zero pipeline flushing penalties.
