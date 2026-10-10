## 02. The Memory Hierarchy

No single memory technology simultaneously achieves high speed, high capacity, and low cost. The physics will not allow it. Faster memory uses more transistors per cell, takes more silicon area, and consumes more power. Storage that holds its data without power is slow to write. The tradeoffs are fundamental, not engineering oversights.

The solution is a hierarchy: small, fast, expensive memory sits close to the CPU, large, slow, cheap storage sits farther away. Data moves up the hierarchy when it is needed and falls back down when it is not. The entire memory system, from L1 cache to HDD, is built around this principle.

### The Full Pyramid

```
                    +-----------+
                    | Registers |   < 1 ns    ~1 KB
                    +-----------+
                   /             \
              +--------+
              |  L1 $  |   1-4 ns     32-64 KB per core
              +--------+
             /          \
          +--------+
          |  L2 $  |   5-12 ns    256 KB - 2 MB per core
          +--------+
         /          \
       +--------+
       |  L3 $  |   20-40 ns   8-64 MB shared
       +--------+
      /          \
   +------+
   |  DRAM |   60-100 ns   16-256 GB
   +------+
  /        \
+----------+
| NVMe SSD |   50,000-200,000 ns    1-8 TB
+----------+
|          |
+----------+
|   HDD    |   3,000,000-10,000,000 ns    1-20 TB
+----------+
```

### Latency, Bandwidth, and Cost Table

| Level | Typical Latency | Bandwidth | Cost per GB (2025) | Capacity (typical) |
|---|---|---|---|---|
| Registers | ~0.3 ns | ~10 TB/s | N/A | ~1 KB |
| L1 Cache | 1-4 ns | 1-5 TB/s | N/A | 32-64 KB/core |
| L2 Cache | 5-12 ns | 500 GB/s-2 TB/s | N/A | 256 KB-2 MB/core |
| L3 Cache | 20-40 ns | 200-800 GB/s | N/A | 8-64 MB |
| DRAM (DDR5) | 60-100 ns | 50-100 GB/s | ~\$3-5/GB | 16-256 GB |
| NVMe SSD | 50-200 µs | 5-14 GB/s | ~\$0.08-0.15/GB | 1-8 TB |
| SATA SSD | 100-400 µs | 500 MB/s | ~\$0.05-0.10/GB | 500 GB-4 TB |
| HDD | 3-10 ms | 100-250 MB/s | ~\$0.02/GB | 4-20 TB |

Note: latency numbers are unloaded, single-access figures. Under a queued workload, NVMe SSDs can sustain lower effective latency through command queuing.

### Registers

Registers live inside the CPU die and are implemented in SRAM. The CPU can read or write a register in a single clock cycle, roughly 0.3 nanoseconds at 3 GHz. A typical x86-64 core has 16 general-purpose 64-bit registers plus floating-point, SIMD, and control registers.

The compiler allocates registers. You do not address them directly in Go or C++ (unless you write inline assembly). The key point is that register allocation is the fastest memory access possible, and the compiler works hard to keep hot variables in registers.

### L1 Cache

L1 is the first level of SRAM cache, split on modern cores into L1i (instruction) and L1d (data). It is physically close to the execution units on the CPU die. L1 latency is 1-4 clock cycles. A cache miss in L1 initiates a lookup in L2.

Cache lines are 64 bytes on x86. When the CPU loads a single byte from memory, it loads the entire 64-byte cache line containing that byte. This is why sequential access is efficient: the first access loads 64 bytes, and the next 7 accesses to adjacent int64s are free L1 hits.

### L2 Cache

L2 is larger than L1 but slower. It is still per-core. L2 latency is 5-12 nanoseconds. A cache miss in L2 initiates a lookup in L3.

### L3 Cache

L3 is the last-level cache (LLC), shared across all cores on a socket. It is the buffer between per-core caches and DRAM. L3 latency is 20-40 nanoseconds. On NUMA systems with multiple sockets, accessing L3 on a remote socket costs more than accessing local DRAM.

L3 capacity matters for workloads with working sets in the tens of megabytes. A database in-memory B-tree index that fits in L3 will perform very differently from one that spills to DRAM.

### DRAM (Main Memory)

DRAM is the main memory addressable by the OS and your programs. Access latency is 60-100 nanoseconds for a random access. Sequential access benefits from prefetching and burst modes, bringing effective latency down, but random access is always expensive relative to cache.

DRAM requires refresh (every 64ms per row), has limited bandwidth compared to cache, and is sensitive to access patterns that cause bank conflicts or row misses. See Section 3 for DRAM internals.

### NVMe SSD

NVMe SSDs connect via PCIe and use NAND flash storage. Access latency for a 4KB random read is 50-200 microseconds (50,000 to 200,000 nanoseconds), about 1000x slower than DRAM. Write latency is similar or higher due to the need to erase blocks before writing.

Modern NVMe SSDs use a command queue (NVMe supports up to 65,535 queues with 65,535 commands each), which allows the controller to reorder and parallelize access, reducing effective latency under load. SATA SSDs are constrained by the SATA protocol to one command queue of 32 entries, which is a significant bottleneck.

### HDD

Spinning hard disk drives have a 7,200 RPM disk that must physically rotate to the correct sector. A random seek takes 3-10 milliseconds. Sequential reads can sustain 100-250 MB/s because the disk head does not move, but any random access kills throughput.

A spinning disk doing 200 random IOPS is not a failure. That is near the physical limit of the mechanical actuator arm. For random-access workloads, SSDs are the only viable option.

### The Programmer's Frame of Reference

Think about time in these terms: if a CPU cycle is 1 second, then:
- L1 cache hit: 4 seconds.
- L2 cache hit: 12 seconds.
- L3 cache hit: 40 seconds.
- DRAM access: 4 minutes.
- NVMe SSD: 3 days.
- HDD: 4 months.

This analogy (scaled from actual nanosecond counts) makes clear why cache misses matter. A program that fits its working set in L3 operates in a fundamentally different performance regime from one that is constantly hitting DRAM.

### Practical Code: Measuring Cache Effects in Go

```go
package main

import (
    "fmt"
    "time"
    "unsafe"
)

const cacheLineSize = 64

func benchmarkStride(data []int64, stride int) time.Duration {
    n := len(data)
    iterations := 1 << 24 // 16M accesses
    start := time.Now()
    sum := int64(0)
    idx := 0
    for i := 0; i < iterations; i++ {
        sum += data[idx]
        idx = (idx + stride) % n
    }
    _ = sum
    return time.Since(start)
}

func main() {
    // Allocate 256MB to exceed L3 cache on most laptops
    size := 256 * 1024 * 1024 / int(unsafe.Sizeof(int64(0)))
    data := make([]int64, size)
    for i := range data {
        data[i] = int64(i)
    }

    strides := []int{1, 2, 4, 8, 16, 64, 128, 512}
    for _, stride := range strides {
        d := benchmarkStride(data, stride)
        fmt.Printf("stride=%4d  elapsed=%v\n", stride, d)
    }
}
```

As stride increases past the cache line size (8 int64s = 64 bytes), each access lands in a new cache line. As stride increases further past L1, L2, and L3 capacity, each access requires a DRAM fetch. You will see the elapsed time increase sharply at these boundaries.

**Watch:** [RAM Explained. Random Access Memory](https://www.youtube.com/watch?v=PVad0c2cljo), recommended for visual learners.

**Watch:** [How does Computer Memory Work](https://youtu.be/7J7X7aZvMXQ?si=CFkYLVO_tEKeVf5O), recommended for visual learners.
