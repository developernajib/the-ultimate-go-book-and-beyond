## TMA in Practice: perf, Buckets, and Fix Patterns

Performance work without TMA is guesswork. You stare at IPC, see 1.2, and have no idea whether the bottleneck is the front-end, the load-store unit, or a mispredict storm. Intel's Top-Down methodology, originally described by Ahmad Yasin (2014), buckets every issue slot into one of four categories. Each cycle, the renamer either issues a uop (Retiring), drops it because no uop was available (Frontend Bound), drops it because the back-end said stop (Backend Bound), or issued a uop that later got squashed (Bad Speculation).

### The Four Buckets at Level 1

Issue slots per cycle = pipeline width (4 on Skylake, 5 on Sunny Cove / Icelake, 6 on Golden Cove / Sapphire Rapids, 8 on Zen 4 for some uops). Every slot is accounted for.

```
                  +---- Retiring (real work, includes microcode)
                  |
                  +---- Bad Speculation (squashed work + recovery bubbles)
slots/cycle ------+
                  +---- Frontend Bound (fetch, decode, uop cache misses)
                  |
                  +---- Backend Bound (memory, core execution)
```

A workload at 35% Retiring on a 4-wide machine is doing 1.4 uops/cycle of useful work. The other 65% is loss. The TMA tree tells you where.

### Level 2 Drill-Down

```
Frontend Bound
  |- Frontend Latency (icache miss, iTLB miss, branch resteer)
  |- Frontend Bandwidth (decoder stall, MITE vs DSB, LSD inactive)

Backend Bound
  |- Memory Bound
  |    |- L1 Bound (DTLB, L1 hit latency, store fwd, 4K aliasing)
  |    |- L2 Bound
  |    |- L3 Bound (LLC hit latency, contended access)
  |    |- DRAM Bound (LLC miss, bandwidth saturation)
  |    |- Store Bound (store buffer full)
  |- Core Bound (port saturation, divider, FP throughput)

Bad Speculation
  |- Branch Mispredict
  |- Machine Clears (memory ordering, SMC, MRN)

Retiring
  |- Light Operations
  |- Heavy Operations (microcode, FP_ARITH, divisions)
```

### Running TMA Without VTune: pmu-tools

Andi Kleen's pmu-tools is the canonical open-source TMA driver. It wraps `perf` and knows the events for every Intel uarch back to Nehalem and most AMD Zen variants.

```bash
git clone https://github.com/andikleen/pmu-tools
cd pmu-tools
./toplev.py --all -l3 -v --no-desc taskset -c 4 ./my_binary
```

Useful flags:

```
-l1 / -l2 / -l3 / -l4   level of drill-down
--nodes                 specific nodes to measure
--per-thread            per-thread breakdown
--ignore-errata         skip events flagged unsafe on this uarch
--xlsx out.xlsx         dump to spreadsheet
--global                system-wide
```

Sample output for a hot search-index lookup function on Sapphire Rapids:

```
FE             Frontend_Bound:                    18.4 %
   FE          Frontend_Bound.Frontend_Latency:   12.1 %
      FE       FE.Frontend_Latency.ICache_Misses:  9.6 % <==
BE             Backend_Bound:                     54.7 %
   BE/Mem      Backend_Bound.Memory_Bound:        41.2 %
      BE/Mem   Memory_Bound.L3_Bound:             22.8 % <==
      BE/Mem   Memory_Bound.DRAM_Bound:           14.7 % <==
   BE/Core     Backend_Bound.Core_Bound:          13.5 %
BAD            Bad_Speculation:                    7.1 %
RET            Retiring:                          19.8 %
```

This says: 9.6% icache, 22.8% L3 latency, 14.7% DRAM. Inlining will help icache (cuts code footprint? sometimes makes it worse). The real fix is data layout, not micro-optimization.

### perf top-down driver

Linux 5.8+ exposes the new `perf stat --topdown -l 2`, which uses the dedicated TMA fixed counters on Icelake and later (no event multiplexing).

```bash
perf stat -a --topdown -l 2 -- sleep 5
 #  retiring  bad spec   FE bound   BE bound   heavy ops  br mispred  fetch lat  mem bound
S0      27.8%      6.4%      19.1%      46.7%       8.2%        4.9%      14.0%     35.1%
```

The non-multiplexed reading is more accurate than legacy `--metric-only`. For old kernels, fall back to pmu-tools.

### VTune Top-Down View

VTune's "Microarchitecture Exploration" analysis is the same model with a GUI. The bottleneck column is what matters. Look for cells colored red. The `Bandwidth Utilization` histogram across DRAM channels is the killer feature you will not get from `perf` alone.

CLI for headless servers:

```bash
vtune -collect uarch-exploration -result-dir vt-out -- ./my_binary
vtune -report summary -r vt-out
vtune -report hotspots -r vt-out -group-by source-line -limit 30
```

### Diagnosing a Real Function at Each Level

#### Frontend Latency: an inlined templated dispatch

```cpp
template <Op O, Type T>
[[gnu::flatten]] inline Result dispatch(Ctx& c) noexcept {
    if constexpr (O == Op::Add) return add_impl<T>(c);
    else if constexpr (O == Op::Mul) return mul_impl<T>(c);
    // 30 more branches
}
```

After heavy `[[gnu::flatten]]` use across 12 call sites, the hot loop's code footprint blew past 32 KB L1i. TMA showed `Frontend_Latency.ICache_Misses` at 11%. The fix: stop flattening, let the indirect call live, since the BTB nailed it (mispredict was 0.3%).

```bash
# Before
ICache_Misses: 11.2%, IPC: 1.34
# After (remove flatten)
ICache_Misses:  1.4%, IPC: 2.61
```

#### Backend Memory L3 Bound: pointer-chasing graph walk

```cpp
for (Node* n = head; n; n = n->next) {
    sum += n->value;
}
```

`Memory_Bound.L3_Bound` at 28%, `DRAM_Bound` at 19%. Linked list, prefetcher is helpless. Replace with arena-allocated contiguous nodes plus index links. Gather loop becomes vectorizable.

```cpp
struct Node { int32_t value; uint32_t next_idx; };
std::vector<Node> arena; // contiguous
```

L3_Bound dropped to 4%, DRAM_Bound to 2%, IPC from 0.71 to 3.15.

#### Bad Speculation: branchy filter

```cpp
for (auto& r : rows) if (r.score > threshold) out.push_back(r);
```

`Branch_Mispredict` at 22% when threshold sits near the median (worst case for a predictor). Convert to branchless:

```cpp
for (auto& r : rows) {
    out[count] = r;
    count += (r.score > threshold);
}
```

Mispredict drops to 0.4%. Throughput on a 64-byte row at 50% selectivity went from 1.8 GB/s to 6.4 GB/s on a single Golden Cove core.

#### Core Bound: divider monopoly

```cpp
for (int i = 0; i < n; ++i) result[i] = a[i] / b[i];
```

`Core_Bound.Divider` at 38%. Replace with reciprocal multiply where precision allows:

```cpp
__m256 inv = _mm256_rcp14_ps(vb); // AVX-512 14-bit, refine with one Newton step if needed
__m256 r = _mm256_mul_ps(va, inv);
```

10x throughput on Skylake-X, free on Sapphire Rapids.

### TMA Level 3 and Level 4

At L3 you see things like `Memory_Bound.L1_Bound.DTLB_Load`. If that fires, either your working set spans more 4K pages than your dTLB has entries (64 on Skylake L1 dTLB), or you have a 4K aliasing problem. Solutions: hugepages, struct-of-arrays packing, reduce working set.

At L4 you reach individual events like `LD_BLOCKS.STORE_FORWARD`. This is for the 0.1%.

### What TMA Does Not Tell You

- Inter-core coherence storms. False sharing reads as `Memory_Bound.L3_Bound` because the line bounces. You need `perf c2c` to see it.
- Lock contention. Spins look like Retiring (the pause loop retires fine).
- Frequency throttling. TMA reports per-cycle, so a thermally-throttled core just runs slower with the same percentages.

Cross-reference TMA with `perf stat -e cycles,ref-cycles,task-clock` to detect frequency drops. Cross-reference with `perf c2c` for coherence pathologies.

### Junior to FAANG callout

Do not try to optimize anything until TMA tells you which bucket dominates. Optimizing for retiring (e.g. SIMD) when you are 50% DRAM Bound moves the needle by zero. The single biggest mistake is "I rewrote the inner loop in AVX-512 and it got 3% faster". You were not core bound. You were memory bound. Spend the day on data layout.

### Senior at FAANG callout

You should be running TMA on every benchmark in CI for hot binaries. Track Retiring %, DRAM_Bound %, and Branch_Mispredict % as time series. A 3% Retiring drop with no code change in your service means your sibling-core neighbor on the host changed and you are getting LLC pressure. File the noisy-neighbor ticket, do not bisect your own commits.

### Reference event sets

Skylake L1 events (manual TMA):

```
SLOTS                      = CPU_CLK_UNHALTED.THREAD * 4
RETIRING                   = UOPS_RETIRED.RETIRE_SLOTS / SLOTS
BAD_SPEC                   = (UOPS_ISSUED.ANY - UOPS_RETIRED.RETIRE_SLOTS
                              + 4 * INT_MISC.RECOVERY_CYCLES) / SLOTS
FE_BOUND                   = IDQ_UOPS_NOT_DELIVERED.CORE / SLOTS
BE_BOUND                   = 1 - (FE_BOUND + BAD_SPEC + RETIRING)
```

Icelake and later expose `PERF_METRICS` MSR (0x329) with all four percentages prepacked. That is what `perf --topdown` reads.
