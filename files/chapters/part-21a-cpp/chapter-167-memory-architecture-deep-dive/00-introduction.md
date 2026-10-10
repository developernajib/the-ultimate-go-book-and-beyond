# Chapter 167: How Computer Memory Works Under the Hood

## Introduction. Why Programmers Must Understand Memory at the Hardware Level

Every time you write a variable declaration, call a function, or allocate a slice, the runtime is doing something concrete in hardware. Electrons are moving. Capacitors are charging. A transistor is switching. Most programmers treat memory as an infinite, uniform space, write to a pointer and data appears, read from it and data comes back. That model is wrong, and the wrongness costs real performance.

The gap between what programmers assume and what the hardware does is where bugs live and where performance dies. A Go program that GCs every 200ms on a loaded server is not a GC problem. It is a memory allocation pattern problem. A C++ application that performs well on a developer laptop but collapses under 100 concurrent users has a cache-miss pattern problem. These problems are invisible if you do not understand the layers between your source code and the silicon.

### The Cost of Ignorance

Consider a simple loop that reads a 64-bit integer from an array:

```go
sum := int64(0)
for i := 0; i < len(data); i++ {
    sum += data[i]
}
```

If `data` fits in L1 cache, each read costs roughly 1 nanosecond. If `data` is spread across cold DRAM pages, each read costs 70 to 100 nanoseconds. If `data` lives on an NVMe SSD and was not prefetched, each access costs 50,000 nanoseconds. The same loop, the same code, a 50,000x difference in latency. You cannot reason about this without knowing the memory hierarchy.

### What This Chapter Covers

This chapter builds a complete mental model of memory from the ground up:

1. How bits are physically stored in silicon, transistors, capacitors, and the latch.
2. The memory hierarchy, registers through NVMe SSD, with real latency numbers.
3. DRAM internals, banks, rows, sense amplifiers, refresh, DDR4 versus DDR5.
4. Virtual memory and paging, why the OS lies to every process about its address space.
5. Swap, OOM, and Linux memory pressure.
6. Process memory layout, text, data, BSS, heap, stack, and the mmap region.
7. Why the stack is fast and the heap is slow, not just intuitively but mechanically.
8. SSD and HDD storage. NAND flash, wear leveling, FTL, NVMe protocol.
9. Practical implications for Go and C++, escape analysis, sync.Pool, huge pages, pprof.

### Who This Is For

This chapter is for working programmers who already write Go or C++ and want to stop guessing why their programs are slow or unstable. You do not need an electrical engineering background. You do need to be willing to think in terms of nanoseconds, bytes, and hardware states rather than objects and functions.

By the end of this chapter you will be able to:

- Read a memory timing table and understand what CAS latency and tRCD mean for your workload.
- Look at `/proc/PID/maps` and know exactly what each region is for.
- Identify allocations that escape to the heap in Go using `go build -gcflags='-m'`.
- Write code that stays cache-hot by understanding spatial and temporal locality.
- Explain why a NUMA-unaware Go service degrades on a dual-socket server.

### A Note on Approximations

Hardware specifics vary by generation and vendor. The latency numbers in this chapter are representative values for modern server-class hardware. Treat them as order-of-magnitude guides, not specifications. The ratios between layers. L1 versus DRAM versus SSD, are stable across generations even when the absolute numbers shift.

**Watch:** [How computer memory works. Kanawat Senanan](https://www.youtube.com/watch?v=p3q5zWCw8J4), recommended for visual learners.
