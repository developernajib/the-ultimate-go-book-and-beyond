## 14. Coherence-Related Performance Counters

Performance counters are how you turn vague performance complaints into specific hardware events. The counters relevant to NUMA and coherence sit in two places: the per-core PMU (programmable performance monitoring unit) and the uncore PMU (the off-core part of the chip: LLC slices, mesh, memory controllers, UPI/xGMI links).

### The Core Counters

`perf list` shows everything available on the current CPU. The most relevant for NUMA and coherence:

```
LLC-load-misses           [Hardware cache event]
LLC-store-misses          [Hardware cache event]
mem_load_l3_miss_retired.local_dram     [Intel-specific]
mem_load_l3_miss_retired.remote_dram    [Intel-specific]
mem_load_l3_miss_retired.remote_hitm    [Intel-specific]
mem_load_l3_miss_retired.remote_fwd     [Intel-specific]
offcore_response.demand_data_rd.l3_hit.snoop_hitm
```

A useful baseline command:

```bash
perf stat -e cycles,instructions,cache-references,cache-misses,\
LLC-load-misses,LLC-store-misses,\
mem_load_l3_miss_retired.local_dram,\
mem_load_l3_miss_retired.remote_dram,\
mem_load_l3_miss_retired.remote_hitm \
  -- ./your_program

# Output:
#   1,234,567,890 cycles
#     987,654,321 instructions               # 0.80 IPC
#       1,234,567 cache-references
#         345,678 cache-misses               # 28% of references
#         987,654 LLC-load-misses
#         123,456 LLC-store-misses
#         432,000 ...local_dram
#         555,654 ...remote_dram             # remote DRAM ratio: ~56%
#         234,567 ...remote_hitm             # cross-socket cache hit modified
```

Read this output:

- IPC of 0.80 is moderate. Below 1.0 suggests stalls. NUMA-related stalls are one cause.
- LLC misses split into local vs remote DRAM tells you if memory is on the right node. If `remote_dram` is more than 30 percent of misses, NUMA placement is wrong.
- `remote_hitm` is cross-socket coherence traffic: a line modified on socket A is being read by socket B. This is expensive (200+ cycles per event). Substantial counts here mean you have shared writable data crossing sockets.

### Uncore Counters

Uncore PMUs are not per-core. They live on the LLC slices, the mesh fabric, and the memory controllers. Different vendors expose them differently.

**Intel CHA (Caching/Home Agent):**

```bash
# List all uncore PMUs:
ls /sys/devices/ | grep uncore

# Sample a CHA event:
perf stat -e uncore_cha/event=0x35,umask=0x21/ -a sleep 5
```

CHA event 0x35 is `LLC_LOOKUP`. Combined with various umasks, it tells you LLC hit/miss rates by access type. The Intel software developer manual volume 3 has the full list.

**Intel iMC (memory controller):**

```bash
perf stat -e uncore_imc_0/event=0x04,umask=0x03/,uncore_imc_0/event=0x04,umask=0x0c/ \
  -a sleep 5
```

These give you read and write bandwidth on memory channel 0 of socket 0. Sum across channels for total bandwidth. Compare to peak (DDR5-4800 at 8 channels = 307 GB/s peak per socket).

**Intel UPI (cross-socket link):**

```bash
perf stat -e uncore_upi/event=0x2,umask=0x0f/ -a sleep 5
```

UPI traffic in flits. High UPI use is a sign of cross-socket coherence or memory traffic. If your application is supposed to be NUMA-local and UPI is at 50 percent, something is wrong.

**AMD Northbridge / Data Fabric:**

AMD's equivalent counters live in the Data Fabric (DF) and the Core Complex. Tools:

```bash
# AMD uProf:
amduprof-cli --collect timeline ./prog
amduprof-cli --report timeline.amduprof

# perf with raw events (AMD Zen 4):
perf stat -e r0xc0,r0xc1 ./prog
```

### AMD IBS (Instruction-Based Sampling)

IBS samples specific instructions and reports the full set of events for that instruction (cache hits/misses, latency, source). It is more precise than counter sampling.

```bash
perf record -e ibs_op/cnt_ctl=1/ -c 10000 -- ./prog
perf report
```

The output shows individual loads/stores with their cache hit/miss status and the latency observed by the OoO engine. For finding the exact instruction causing remote DRAM access, IBS beats event sampling.

### Intel PEBS (Precise Event-Based Sampling)

Intel's equivalent. Most `mem_load_*` events support PEBS. The benefit: the instruction pointer reported is exact, not skid by a few instructions like with regular sampling.

```bash
perf record -e mem_load_l3_miss_retired.remote_hitm:pp -- ./prog
perf report
```

`:pp` requests precise sampling. The output points at the exact load that hit remote modified.

### Reading a perf c2c Report

`perf c2c` post-processes load and store data with HITM detection:

```bash
sudo perf c2c record -F 99 -a sleep 30
sudo perf c2c report --stdio --stats
```

Sections to read in order:

1. **Total HITM count.** If low, false sharing is not your problem.
2. **Shared Data Cache Lines table.** Sorted by HITM count. The top entries are the offenders.
3. **Per-line breakdown.** For each hot line, shows readers, writers, addresses (decode with addr2line or symbol info).
4. **Per-thread breakdown.** Which threads are involved. Combined with affinity, tells you which sockets.

### Pinning Counters to a CPU

System-wide counter collection can mask per-thread behavior:

```bash
# Per-CPU:
perf stat -C 12 -e cycles,LLC-load-misses sleep 5

# Per-process:
perf stat -p $PID -e cycles,LLC-load-misses sleep 5
```

For a service with pinned threads, per-CPU stats give you per-thread behavior cleanly.

### Sampling Cycles vs Specific Events

`perf record` defaults to sampling on cycles. For NUMA debugging, you usually want to sample on a specific event:

```bash
# Where are remote_dram misses happening?
perf record -e mem_load_l3_miss_retired.remote_dram -c 10000 -- ./prog
perf report
```

Each sample is one occurrence of the event (modulo period). The report aggregates by function and source line. You see which code path is causing remote DRAM accesses.

### Worked Example: Tracking Down a NUMA Hotspot

1. `perf stat` shows `remote_dram` is 40 percent of LLC misses. NUMA placement issue.
2. `perf record -e mem_load_l3_miss_retired.remote_dram` and `perf report` show the hot function: `Index::lookup`.
3. Source review: `Index` is constructed in `init()`, run on a single thread. All allocations land on init's node.
4. Fix: parallelize index construction by node, allocate each node's slice with `numa_alloc_onnode`.
5. Re-measure: `remote_dram` drops to 4 percent, residual from cross-shard traffic.
6. p99 latency drops from 1.2 ms to 0.55 ms.

This workflow takes 15 to 30 minutes once you know it. The first time, it takes a day. After that, every NUMA bug looks the same.

### Junior to FAANG

A junior runs `perf stat` and reads cycle count. A FAANG engineer reads the L3-miss-by-source breakdown, knows which uncore counters to add, and can interpret a `perf c2c` report top to bottom.

### Senior at FAANG

Staff engineers build counter dashboards into the production monitoring. Per-host LLC miss rate, remote DRAM ratio, UPI use. When a deployment regresses, the dashboard shows which counter moved, narrowing the diagnosis from hours to minutes.

---
