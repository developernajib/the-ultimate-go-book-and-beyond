## Case Studies

The techniques covered in this chapter are not academic exercises. Production systems at scale depend on cache-friendly layouts, zero-copy I/O, and allocation-conscious design to meet their performance targets. The following three case studies show how real-world Go projects applied these patterns to solve concrete performance problems.

### Case Study 1: A Zero-Allocation HTTP Parser

**Problem**: A high-throughput Go proxy spends a quarter of its CPU in HTTP header parsing, dominated by string allocations for each header name-value pair. (This is the classic profile shape that fasthttp was built to eliminate.)

**Solution**: Custom zero-copy parser that returns `string` values pointing into the input buffer using `unsafe.String`. Header names are interned (deduplicated) using a 256-entry LRU.

**Techniques**:
- `unsafe.String(ptr, len)` to create strings from buffer without copying
- String interning for `Content-Type`, `Authorization`, `X-Forwarded-For`
- SIMD-based newline scanning using `bytes.IndexByte` (Go stdlib, uses SSE4.2)
- Radix trie for header name lookup instead of `switch` statement

**Result**: header parsing drops from a dominant share of the profile to a minor one, because the allocations it was doing are simply gone. The mechanism is what transfers, not a percentage: a parser that allocates per header does work proportional to header count, and a parser that returns sub-slices of the read buffer does not.

**The cost you are accepting**: `unsafe.String` over the read buffer means every returned header is only valid until that buffer is reused. Hand one to a goroutine that outlives the request and you have a data race that returns another connection's bytes, which is a security bug, not a performance bug. This trade is worth it only behind a documented lifetime contract.

### Case Study 2: Columnar (SoA) layout in a vectorized SQL engine

**Problem**: A vectorized execution engine for analytical queries (CockroachDB's is the well-known Go example) is bottlenecked by an Array-of-Structs row format: every row operation pulls whole rows into cache even when the query touches 2 of 20 columns. Cache lines fill with columns nobody asked for.

**Solution**: Struct-of-Arrays columnar layout per batch. Each batch of ~1024 rows stores each column as its own contiguous `[]int64` or `[][]byte`.

**Why it works**: a projection over 2 of 20 columns now reads only those two arrays, so essentially every byte pulled into cache is a byte the query wanted. The upper bound on the win is the ratio of columns touched to columns stored, which is the number to reason from for your own schema.

**One correction worth making loudly**, because this claim circulates widely and is wrong: this does *not* work by letting the Go compiler auto-vectorize the batch loops. **The gc compiler does not auto-vectorize.** No amount of loop simplification will make it emit AVX2. Engines that genuinely use SIMD get it from hand-written assembly, an assembly-backed library, or cgo. What the columnar layout buys in pure Go is cache efficiency and cheap, tight, branch-light loops over contiguous memory. That is a real and substantial win. It is just not the one the word "vectorized" implies to someone arriving from C++.

### Case Study 3: Prometheus TSDB mmap-based Index

**Problem**: Prometheus queries its on-disk index for every metric lookup. Served from disk, each lookup pays I/O latency and a deserialization pass.

**Solution**: Memory-mapped the entire index file (~4GB) using `syscall.Mmap`. Index pages are loaded into the OS page cache on first access, then served from RAM on subsequent accesses.

**Techniques**:
- `MADV_SEQUENTIAL` for scan operations (full index scan)
- `MADV_WILLNEED` for prefetching series blocks that will be needed
- `MADV_DONTNEED` after processing old time windows to free page cache
- Binary search over the mmap'd sorted index - no deserialization needed

**Result**: once the index is warm in the page cache, a lookup is a binary search over mapped memory: no syscall, no deserialization, and no allocation on the query path. The honest framing is that this converts a disk-latency problem into a memory-latency problem, and the size of the win is therefore whatever your storage-to-RAM latency gap is, which is a property of your hardware rather than of the technique.

**The caveat that matters operationally**: mmap does not make I/O free, it makes it invisible. A page fault on a cold index still goes to disk, but now it happens inside what looks like a memory read, with no error to handle and no timeout to configure. Warm, this is excellent. Cold, or when the page cache is under pressure, your p99 is at the mercy of the kernel's eviction decisions, and nothing in your Go code can see it happening.

### Case Study 4: VictoriaMetrics columnar compression

**Problem**: VictoriaMetrics ingests billions of time-series samples per day. Initial implementation stored each data point as a struct with timestamp and value, and the working set blew past L3 cache on any query that scanned more than a few minutes of data.

**Solution**: Switched to columnar representation with delta-of-delta encoding for timestamps and double-XOR-plus-control-byte encoding for values (the Gorilla paper). Each block stores ~8000 timestamps and ~8000 values in two contiguous `[]byte` buffers.

**Techniques**: Struct-of-arrays layout (timestamps and values in separate arrays, not interleaved), zero-allocation decompression writing into caller-provided `[]float64` and `[]int64` buffers, and bounds-check elimination via `_ = out[N-1]` hints in the hot decode loop. Note what is *not* in this list: auto-vectorization of the XOR-and-shift arithmetic. As in case study 2, the gc compiler does not auto-vectorize, and no simplification of the loop body will change that.

**Result**: the compression win here is the one number in these case studies worth quoting, because it comes from a published paper rather than from folklore. Facebook's Gorilla paper reports its delta-of-delta plus XOR scheme compressing 16-byte samples to an average of about 1.37 bytes, roughly 12x, on their production time-series workload. That is a property of the *encoding* applied to *slowly-changing time-series data*, which is why it transfers to systems that adopt the scheme, and why it would not transfer at all to data that lacks that structure. Random float64s compress to nothing.

The CPU side is more interesting than a ratio anyway: shrinking each sample by roughly an order of magnitude means an order of magnitude more samples per cache line, so a scan that previously streamed from RAM now runs from cache. The compression is not just saving disk, it is buying back memory bandwidth, and on a scan-heavy query that is usually where the real win lives. The codebase stayed readable because the optimizations were localized to the encode/decode functions behind well-defined interfaces.

### Case Study 5: Surgical Heap Reduction in a High-Volume Auth Service

**Problem**: An identity authentication microservice handling 2 million requests per day was experiencing high GC pause latency and erratic p99 spikes. Profiling revealed over 205 GB of unnecessary heap allocations generated daily, traced primarily to two standard defaults: Prometheus metrics scrape compression and logger slice append ladders.

**Solution**:
1. **Disable In-Cluster Metrics Gzip**: The standard `promhttp.Handler()` defaults to Gzip compression, instantiating a new `compress/flate.NewWriter` for every scrape. For a fleet with ~500,000 scrapes per day from an in-cluster Prometheus scraper on the local VPC, compression avoided zero meaningful network costs while consuming 28% of the service's total heap allocations. Replacing the default with `promhttp.HandlerOpts{DisableCompression: true}` reduced memory per scrape from 672 KB down to 261 KB (a 61.1% reduction), eliminating ~205 GB of daily GC pressure with a negligible 53μs latency delta.
2. **Pre-Sizing Structured Logging Slices**: Loggers repeatedly appended contextual metadata to a default slice (`append(defaultFields, ...)`), climbing the slice allocation ladder and triggering multiple backing array reallocations on every log call. Pre-calculating exact slice capacity upfront (`make([]zap.Field, 0, totalCapacity)`) reduced logger hot paths from 3 allocations per call down to 1.

**Result**: Heap allocation volume dropped by over 61%, substantially reducing GC CPU utilization and eliminating p99 tail latency spikes without changing hardware or adding caching tiers.

> [!NOTE]
> For a full case retrospective on profiling-driven microservice optimizations, see Vishesh Rawal's analysis in [*I Cut Go Microservice Heap Allocations by 61% (205 GB/Day Saved) With Two Surgical Changes*](https://medium.com/@visheshrawal).

### Cross-case patterns

Five case studies, five similar shapes. First, the wins came from changing data layout (columnar, SoA, mmap'd) more than from clever algorithms. The algorithms were known. The layout was the lever. Second, every success story had a clear profile-based motivation: header parsing dominating a proxy's CPU, memory-bandwidth saturation in a vectorized engine, disk latency on an index lookup, cache misses on a scan. Profile-driven work produces durable wins. Guess-driven work produces complexity. Third, each team kept the optimization localized. The un-optimized 90 percent of the codebase stayed idiomatic, which kept modification costs manageable. Fourth, every team published their story, and the industry benefits from that openness. The corollary: your team's performance work is most valuable when it is documented and shareable internally at minimum, externally when you can.

Fifth, and this is why most of the specific multipliers that used to decorate this page are gone: the numbers in a case study are the least portable part of it. Somebody's 20x came from their disk, their working set, their schema, and their year of hardware. Reproduce the *mechanism* (fewer bytes touched per unit of work, fewer allocations on the hot path, contiguous memory over pointer chasing) and then measure your own multiplier. If a case study, including this one, gives you a ratio without giving you the hardware and the workload that produced it, you have been handed a story rather than a number.

### Senior @ FAANG: the internal case-study document

For any service you own that does performance-sensitive work, maintain an internal case-study document. Update it quarterly. Include: the baseline metrics when the service was launched. The three most impactful optimizations and their measured effect. The three rejected optimizations and why. The open performance problems and who owns them. The three next optimizations on the roadmap with expected benefit. This document compounds in value over time. Engineers who join the team read it and onboard fast. Leadership reads it and understands the engineering investment. Future staff engineers inherit context that otherwise walks out with attrition. Writing it forces the clarity that separates "we made it faster" from "we understood why it was slow and what the trade-off was." The second sentence is the staff-level claim. The first is marketing.

---
