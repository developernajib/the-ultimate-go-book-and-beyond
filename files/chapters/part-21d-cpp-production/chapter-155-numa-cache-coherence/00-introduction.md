# Chapter 155: NUMA, Cache Coherence, and Hardware-Aware C++

> "The First Rule of Performance Club: measure, don't guess.", Bryan Cantrill

A modern dual-socket server does not behave like a single computer. It behaves like two computers stitched together by a coherence fabric that pretends, very expensively, to be one. Once you put a thread on socket 0 and the memory it touches lives on socket 1, you have already lost. Cache lines bounce, the snoop filter lights up, and your p99 latency triples. The hardware did exactly what you asked it to do. You just did not know what you were asking.

This chapter is for engineers who already know that `std::vector` allocates on the heap and that `std::atomic<int>` is lock free on x86. It is for the engineer who has been handed a 96-core EPYC box, a 200 Gb/s NIC, and a budget of 4 microseconds end to end, and has been told to make it work. At that scale, the C++ language stops being the interesting variable. The interesting variable is the silicon underneath it.

## Why This Matters at FAANG Scale

Google's web search index does not run on a single machine. It runs on tens of thousands of dual-socket nodes, each holding a shard of the index in DRAM. A query touches dozens of shards in parallel, and the per-shard latency budget is in the low hundreds of microseconds. If a worker thread on socket 0 is reading posting lists pinned to socket 1's memory, the shard's latency moves from 80 microseconds to 240 microseconds, and the query as a whole misses its SLO. Google's solution is not subtle. They pin shard workers, allocate shard memory on the local node, and treat each socket as an independent unit with its own NIC queues, its own scheduler context, and its own copy of hot read-only data.

ScyllaDB took this idea further. Their entire architecture, the SeaStar framework, is shard per core. Every core owns its piece of the dataset, and there are no shared mutexes between cores. Communication between cores happens through lock-free message queues. Communication between sockets happens explicitly, with the developer aware of the cost. ScyllaDB regularly outperforms Cassandra by an order of magnitude on the same hardware, and almost all of that advantage comes from respecting the NUMA topology rather than fighting it.

In high frequency trading, the picture is even sharper. A market data handler at Jump Trading or Citadel pins itself to a specific physical core on the socket connected to the NIC. The kernel is configured with `isolcpus` to keep its hands off that core. The thread spins on a userspace ring buffer, and the order book lives in 1 GB hugepages allocated on the same NUMA node as the NIC. Crossing the UPI link to the other socket adds roughly 80 to 130 nanoseconds of latency per cache line, and at HFT speeds that is the difference between filling an order and missing it. These shops do not write portable code. They write code that is shaped by the exact topology of the box it runs on.

## The Hardware Is Moving Faster Than Your Mental Model

If your idea of a CPU is "lots of cores plus a big shared L3", you are running on 2017 hardware in your head. Today's parts look different. Intel's Sapphire Rapids and Granite Rapids use a mesh interconnect with distributed LLC slices, not a ring with a unified L3. AMD's Zen 4 and Zen 5 are chiplet designs where the L3 is local to each CCD (core complex die), and crossing CCDs is roughly equivalent to crossing a NUMA boundary even within a single socket. Apple's M-series uses 128-byte cache lines (not 64), unifies CPU and GPU memory, and does not expose NUMA at all in the traditional sense. Ampere's AmpereOne pushes 192 cores per socket with a custom mesh and no SMT.

CXL changes this picture again. CXL.mem lets you attach DRAM over a PCIe-class link, creating a third tier of memory between local DRAM and remote socket DRAM. CXL 3.0 fabrics will let multiple hosts share a coherent memory pool. The "two NUMA domains" mental model is being replaced by a topology with five or six tiers, each with its own bandwidth and latency profile, and your allocator needs to know which is which.

This chapter walks through the hardware, the Linux interfaces that expose it, and the C++ patterns that respect it. The goal is not to make you memorize cache sizes. The goal is to make you the engineer who, when the p99 spikes after a kernel upgrade, opens `perf c2c` instead of opening Stack Overflow.

## Junior to FAANG

A junior engineer reads "false sharing" on a blog post, adds `alignas(64)` to one struct, sees no change, and moves on. A FAANG senior engineer runs `perf c2c record` for thirty seconds, identifies the exact cache line where two cores are ping-ponging, computes the cost in cycles, decides whether the fix is padding, partitioning, or restructuring the algorithm, applies the fix, re-measures, and writes a postmortem explaining why the original code looked correct.

## Senior at FAANG

At staff level the question is not "is this NUMA aware?" The question is "is the NUMA awareness the right kind for this workload?" A scan-heavy analytics workload wants `MPOL_INTERLEAVE` to spread bandwidth. A point-lookup OLTP workload wants strict first-touch with thread pinning. A batch ML inference job might want neither and instead want huge pages with a CXL tier. Knowing which tool to reach for, and being able to defend the choice in a design review against another staff engineer who will push back, is the bar.

---
