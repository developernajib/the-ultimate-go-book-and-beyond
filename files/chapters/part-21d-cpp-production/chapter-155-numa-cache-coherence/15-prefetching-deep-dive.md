## 15. Prefetching Deep Dive

The CPU has hardware prefetchers that try to anticipate memory accesses and pull lines into cache before they are needed. They work for predictable patterns (sequential, strided) and miss for unpredictable patterns (pointer chasing, hash table probing). For the latter, software prefetch instructions are the tool.

### Hardware Prefetchers (Intel)

Modern Intel cores have four prefetchers, configurable per core via MSR 0x1A4:

- **L1 streamer (DCU)**: detects sequential access patterns within 4 KB pages and prefetches the next line.
- **L1 IP prefetcher**: detects access patterns based on instruction pointer history. Catches strided patterns like `a[i*K]`.
- **L2 streamer**: detects sequential patterns at L2 level, more aggressive (longer ranges).
- **L2 spatial (adjacent line)**: when fetching a line, also fetches the buddy line (forming a 128-byte pair).

```bash
# Read MSR 0x1A4 (requires root, msr-tools):
rdmsr -p 0 0x1a4
# Bits: 0=L2 streamer disable, 1=L2 spatial disable, 2=L1 DCU disable, 3=L1 IP disable

# Disable L2 spatial prefetcher on CPU 0:
wrmsr -p 0 0x1a4 0x2
```

Disabling prefetchers is rarely the answer. They are usually right. Disable them only when measuring "what would the cache miss rate look like without prefetching to set a worst-case baseline?"

### Hardware Prefetchers (AMD Zen 4 / Zen 5)

AMD has similar prefetchers, configured via different MSRs. Zen 4 added a region-based prefetcher that learns access patterns within 4 KB regions. AMD does not document the MSRs as openly as Intel, but BIOS options to disable specific prefetchers are usually available.

### When Hardware Prefetching Fails

The prefetcher fails on:

- Pointer chasing (linked lists, trees). The prefetcher cannot see two hops ahead.
- Hash table lookups. Each probe goes to a "random" location.
- Indirect indexing: `a[b[i]]`. The prefetcher sees `b` accesses but not where `a` will be touched.

For these patterns, software prefetch helps.

### __builtin_prefetch

GCC and Clang offer a portable intrinsic:

```cpp
__builtin_prefetch(addr, rw, locality);
// rw: 0=read, 1=write
// locality: 0=non-temporal, 1=low, 2=medium, 3=high
```

Translates to PREFETCHT0/T1/T2/NTA on x86, PRFM on ARM.

Example: prefetching the next node in a linked list traversal.

```cpp
struct Node { int v; Node* next; };

int sum_with_prefetch(Node* head) {
    int s = 0;
    while (head) {
        if (head->next) __builtin_prefetch(head->next, 0, 1);
        s += head->v;
        head = head->next;
    }
    return s;
}
```

Without the prefetch, each `head = head->next` waits for a cache miss (~100 ns local DRAM, more if remote). With the prefetch one node ahead, the miss for the next node overlaps with the work for the current node. On a long list, this can cut total time by 30 to 60 percent.

### Prefetch Distance

The right distance is workload-dependent. Too close, the prefetched line has not arrived when needed. Too far, it gets evicted before use.

Rule of thumb: distance = (memory latency) / (cycles per loop iteration). At 100 ns memory latency and 50 cycles per iteration on a 4 GHz CPU (12.5 ns per iteration), distance is 8 iterations.

For hash table probing where each probe is a fresh miss:

```cpp
const int kPrefetchDistance = 8;
for (size_t i = 0; i < n; ++i) {
    if (i + kPrefetchDistance < n) {
        size_t pi = hash(keys[i + kPrefetchDistance]) & mask;
        __builtin_prefetch(&table[pi], 0, 1);
    }
    size_t bi = hash(keys[i]) & mask;
    process(table[bi], keys[i]);
}
```

For a modern x86 CPU and a 16-byte hash table entry, distance 8 is a good starting point. Tune by measuring.

### Cache-Oblivious Algorithms

The cache-oblivious approach designs algorithms whose access pattern is friendly to any cache hierarchy without knowing the cache sizes. Examples:

- Recursive matrix multiplication (subdivide blocks until they fit in some cache).
- Funnel sort.
- Cache-oblivious B-trees (van Emde Boas layout).

These algorithms do not call `__builtin_prefetch` at all. They rely on the natural recursion to keep the working set small at each level. They are theoretically elegant. In practice, on modern CPUs with deep prefetchers, well-tuned cache-aware code often matches or beats cache-oblivious on real benchmarks. The cache-oblivious approach pays off most when the cache hierarchy is unknown at compile time, which is rare in production.

### Prefetch Anti-Patterns

**1. Prefetching the same line repeatedly.**

```cpp
for (int i = 0; i < n; ++i) {
    __builtin_prefetch(&array[0]);    // prefetching the same line every iteration
    process(array[i]);
}
```

The prefetch hits in cache after the first iteration, subsequent prefetches do nothing (or cost an L1 access for nothing).

**2. Prefetching too late.**

```cpp
for (int i = 0; i < n; ++i) {
    __builtin_prefetch(&array[i]);
    process(array[i]);    // we are using array[i] right after prefetching it
}
```

The prefetch and the use are too close. The prefetch instruction completes, but the line has not arrived. Useless. Move the prefetch many iterations ahead.

**3. Prefetching in tight loops without measurement.**

If the loop is already memory-bandwidth-bound, software prefetch adds work without increasing throughput. The hardware prefetcher was already saturating bandwidth. Always measure before and after.

### Non-Temporal Prefetch (PREFETCHNTA)

`__builtin_prefetch(addr, 0, 0)` translates to PREFETCHNTA. The "non-temporal" hint tells the CPU "I will use this line once, do not pollute the cache". The line is fetched into a streaming buffer or marked for early eviction.

Useful for streaming reads of large data that will not be reused (logging, video frames, network packet payloads). Without NTA, sequential reads of GB-sized data evict your hot working set.

### A Prefetch Win: Hash Probing in DBMS

Column-store databases (ClickHouse, DuckDB) batch-process rows in groups of 1024 or 4096. Each row triggers a hash lookup. The classic optimization:

```cpp
for (size_t i = 0; i < batch_size; i += 16) {
    // Issue prefetches for the next 16 rows.
    for (int j = 0; j < 16 && i + 16 + j < batch_size; ++j) {
        size_t bi = hash(keys[i + 16 + j]) & mask;
        __builtin_prefetch(&table[bi], 0, 1);
    }
    // Process the current 16 rows.
    for (int j = 0; j < 16 && i + j < batch_size; ++j) {
        size_t bi = hash(keys[i + j]) & mask;
        process(table[bi], keys[i + j]);
    }
}
```

This pattern is sometimes called "group prefetching" or "rolling prefetch window". DuckDB's hash join uses it. The speedup over a naive loop on a memory-bound hash join is typically 1.5x to 3x.

### Junior to FAANG

A junior sprinkles `__builtin_prefetch` and hopes. A FAANG engineer measures dTLB misses and L1d/L2 miss rates before and after, computes the prefetch distance from observed latency, and verifies that IPC actually went up.

### Senior at FAANG

Staff engineers know that hardware prefetchers handle 90 percent of cases. Software prefetch is for the 10 percent of pointer-chasing and hash-probing code paths where the hardware cannot help. They also know that software prefetch is fragile across CPU generations: an aggressive distance that helps on Sapphire Rapids may hurt on Granite Rapids if the L2 streamer changed. Production code should benchmark across target SKUs.

---
