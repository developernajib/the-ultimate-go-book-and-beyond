## 3. Cache Coherence Protocols

Coherence is the property that, from the programmer's perspective, every load returns the most recently written value. The hardware enforces this by passing messages between caches. The protocol that governs those messages decides how expensive a shared write is, and at what scale the design stops working.

### MESI: The Baseline

MESI tracks each cache line in one of four states:

- **Modified (M)**: this cache has the only valid copy, and it differs from memory. Must write back on eviction.
- **Exclusive (E)**: this cache has the only valid copy, and it matches memory. No write back needed.
- **Shared (S)**: multiple caches have valid copies, all matching memory.
- **Invalid (I)**: this cache's copy is stale or absent.

A write to a line in S state must invalidate the line in every other cache. That invalidation is a broadcast in a snoop-based system. The latency of the write is the time from issue to the moment all other caches acknowledge the invalidation. On a 60-core mesh, this can be 30 to 80 cycles.

Read miss to a line in M state in another cache: the other cache must supply the data (cache-to-cache transfer) and either invalidate or downgrade to S. This is faster than going to DRAM but slower than a local L1 hit.

### MOESI (AMD)

MOESI adds:

- **Owned (O)**: this cache has the most recent value, which differs from memory, but other caches may also have copies in S state. The owner is responsible for writing back if evicted, and for supplying data on remote read misses.

The benefit of MOESI is that a line modified by core A and then read by core B does not require a write back to memory. Core A keeps the line in O state and serves it to B from cache. AMD has used MOESI variants since the K6 era. Modern Zen extends it with directory metadata.

### MESIF (Intel)

MESIF adds:

- **Forward (F)**: like S, but exactly one cache holds the line in F state and is responsible for forwarding it on remote requests. This avoids the "all S sharers respond" pile-up that pure MESI suffers under high read sharing.

Intel uses MESIF (with extensions) on QuickPath and UPI links. The F state is what makes a popular read-only line cheap to share across many cores.

### Snooping vs Directory Protocols

**Snooping**: every coherence request is broadcast on a shared interconnect (a bus or a ring). Every cache examines every request and responds if it has the line. This works up to roughly 8 to 16 cores. Past that, the bus becomes the bottleneck and the broadcast traffic dominates useful work.

**Directory-based**: a directory at each memory controller (or distributed at LLC slices) tracks which caches hold each line. When a core wants a line, it asks the directory, the directory forwards to the current owner or sharers, and only the relevant caches participate in the transaction.

Skylake-X and later Intel server parts use a distributed coherence directory across the mesh. The directory entries are stored in the LLC slices, alongside the data. AMD EPYC uses a similar approach with directory state stored in the L3 and an additional Probe Filter at the IO die for cross-CCD coherence.

### Cross-Socket Coherence: UPI and Infinity Fabric

When a thread on socket 0 reads a line cached on socket 1, the request crosses the socket-to-socket link.

- **Intel UPI (Ultra Path Interconnect)**: replaces QPI on Skylake-SP and later. Up to four UPI links per socket on Sapphire Rapids, each at 16 GT/s (newer parts at 20 GT/s and 24 GT/s). Latency for a cross-socket cache miss is in the 130 to 200 ns range.
- **AMD Infinity Fabric (xGMI)**: connects sockets in a multi-socket EPYC system. Bandwidth and latency depend on the link configuration (3 or 4 xGMI links, with the option to trade one for PCIe lanes). Cross-socket cache miss latency is in the 200 to 350 ns range, somewhat higher than Intel.

The implication: a cache line that lives on socket 1 but is read constantly by threads on socket 0 will burn UPI/xGMI bandwidth and add 100+ ns to every read. Worse, if both sockets are writing to the same line, that line ping-pongs across UPI, and throughput collapses to the link's invalidation rate (millions of operations per second, not billions).

### Worked Example: MESI State Transitions

Two cores, C0 and C1. Memory address X starts uncached.

```
1. C0 reads X.
   C0 cache: I -> E. Memory unchanged.

2. C1 reads X.
   C0 cache: E -> S. C1 cache: I -> S.

3. C0 writes X.
   C0 cache: S -> M. C1 cache: S -> I (invalidation message).

4. C1 reads X.
   C0 cache: M -> S (or O on AMD). C1 cache: I -> S.
   On MESI: data may be written back to memory before sharing.
   On MOESI: C0 stays in O, supplies data, no writeback yet.

5. C1 writes X.
   C1 cache: S -> M. C0 cache: S -> I.

6. C0 writes X again.
   C0 cache: I -> M (after invalidation of C1's copy).
   C1 cache: M -> I.
```

Steps 3, 5, and 6 each involve a coherence transaction. If C0 and C1 are on the same socket, this costs roughly 30 to 80 cycles each. If they are on different sockets, 200+ cycles each. This is the cost of false sharing or contended atomics.

### Measuring Coherence Traffic

```bash
# Intel Sapphire Rapids: snoop and HITM events
perf stat -e mem_load_l3_hit_retired.xsnp_hitm,mem_load_l3_miss_retired.remote_hitm \
  ./your_program

# Cache-to-cache analysis (Intel and recent AMD):
perf c2c record ./your_program
perf c2c report
```

`perf c2c` is the tool. It records load and store events with sampling, then post-processes to identify which cache lines are being shared (HITM = hit modified in another cache) and which threads are causing it. The output shows the line address, the offending source line in your code, and the cores involved.

### Junior to FAANG

A junior reads "MESI" on a hardware blog and remembers four letters. A FAANG engineer can sit in front of a `perf c2c` report, point at a HITM hot line, identify which `std::atomic` field is causing it, predict whether the fix is padding or partitioning, and predict the resulting cycles saved.

### Senior at FAANG

Staff engineers think about coherence at design time. The decision to use a single shared atomic counter vs a per-core counter with periodic aggregation is not a micro-optimization. It is an architectural decision that determines whether the system scales to 64 cores or melts at 16. The bandwidth ceiling on a single contended cache line is roughly 100 million updates per second cross-socket, regardless of how fast your CPU is, because the protocol bandwidth, not the CPU bandwidth, is the limit.

---
