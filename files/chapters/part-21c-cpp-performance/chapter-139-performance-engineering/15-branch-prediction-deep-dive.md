## Branch Prediction Deep Dive

A modern CPU at 4 GHz with a 15-stage pipeline pays roughly 15-20 cycles per mispredict. At 5% mispredict rate on a 1 IPC workload, mispredicts alone steal 75% of theoretical throughput. Branch prediction is the single most important microarchitectural feature for irregular code.

### Predictor Anatomy

Three structures matter:

1. **Direction predictor** (taken/not-taken). On modern Intel (Golden Cove, Redwood Cove) this is a TAGE-style predictor with multiple history-length tables. On Zen 4, AMD uses a hashed perceptron. Both reach >98% on common workloads.
2. **BTB (Branch Target Buffer)**. Holds the target address. Sapphire Rapids: 12K-entry BTB. Zen 4: 8K main + 1.5K L0. A BTB miss costs a fetch redirect (about 8 cycles) even if the direction is right.
3. **RSB (Return Stack Buffer)**. 16 to 32 deep. Mismatched call/ret patterns (longjmp, coroutine resume) cause RSB underflow and force the indirect predictor.

Indirect branches (vtables, function pointers, computed goto) hit the indirect predictor, which is correlated by path history. After Spectre v2 mitigations, indirect prediction is constrained on bare metal too: IBRS / eIBRS reduce cross-process leakage but cost prediction quality.

### Measuring with perf

```bash
perf stat -e branches,branch-misses,br_inst_retired.all_branches,br_misp_retired.all_branches \
    -e br_misp_retired.indirect,br_misp_retired.cond \
    ./binary
```

Per-PC mispredict heat-map:

```bash
perf record -e branch-misses:pp -- ./binary
perf report --sort=symbol,srcline
```

The `:pp` modifier requests precise sampling (PEBS on Intel, IBS on AMD). Without it, samples land on instructions that are not the actual branch.

LBR-driven analysis shows the path that led to each mispredict:

```bash
perf record -b -e branch-misses:pp -- ./binary
perf report --branch-history
```

This is what you use to find "this branch is unpredictable because of correlation with that other branch 5 hops back".

### __builtin_expect, [[likely]], [[unlikely]]

```cpp
if (__builtin_expect(error_path, 0)) { handle_error(); }

if (data.empty()) [[unlikely]] { return {}; }
for (auto& x : data) [[likely]] { process(x); }
```

These are hints to the compiler's block layout pass, not to the hardware predictor. The compiler arranges the hot path on the fall-through and pushes the cold path to a far block. This benefits:

- icache density (cold blocks evicted naturally)
- static prediction on first encounter (forward conditional branches predicted not-taken)
- decoder bandwidth (DSB / uop cache packs the hot block tighter)

Do NOT use `[[likely]]` to override a real predictor on a hot path with 50/50 distribution. It will not change runtime prediction, only layout. Wrong hints regress performance.

### Profile-Guided Branch Hints

PGO lets the compiler set edge weights based on observed counts. `__builtin_expect` with a profile is redundant. Profile data also drives:

- Block placement (Pettis-Hansen ordering)
- Function splitting (cold blocks moved to `.text.unlikely`)
- Inlining cost model (hot edges get inlined more aggressively)

```bash
clang++ -O2 -fprofile-instr-generate=prof.raw -o app.gen app.cc
./app.gen # representative load
llvm-profdata merge -output=app.profdata prof.raw
clang++ -O2 -fprofile-instr-use=app.profdata -o app app.cc
```

For sampled PGO (AutoFDO) see the BOLT/PGO file.

### Swapping if/else Order

Forward conditional branches that have never been seen are predicted **not-taken** by static heuristics on Intel. For a cold path:

```cpp
// Bad: hot path is the taken branch the first time through
if (uncommon_case) { common_work(); }
else { rare_work(); }

// Good: hot path is fall-through
if (!uncommon_case) [[likely]] { common_work(); }
else { rare_work(); }
```

After warmup the dynamic predictor takes over and order is irrelevant for prediction (still relevant for icache layout).

### Jump Tables vs Computed Goto vs Switch

A `switch` over a dense range with N cases compiles to three patterns:

1. **Jump table** (`indirect jmp [.LJTI+rax*8]`). One indirect branch, BTB-predicted.
2. **Binary search tree of compares** (chosen for sparse cases). N-1 conditional branches.
3. **Computed goto** (GCC extension, `&&label` and `goto *ptr`). Multiple indirect branches, one per dispatch site, which can train independently.

Threaded interpreters (CPython 3.11+, Lua, V8 ignition) use computed goto specifically because per-opcode indirect branches train the predictor with **per-opcode context**. A single switch dispatch shares one BTB entry across all opcodes, getting trained to predict whatever the most recent transition was.

```cpp
// Threaded dispatch
static const void* labels[] = {&&op_add, &&op_sub, &&op_mul, ...};
goto *labels[*pc++];
op_add: a = stack_pop() + stack_pop(); goto *labels[*pc++];
op_sub: ...
```

Measured on a small VM benchmark, switch dispatch on Skylake: 18% indirect mispredict. Threaded dispatch: 4%. Throughput went from 380 Mops/s to 720 Mops/s.

### Branchless Programming

When the predictor cannot win (random or near-50/50 data), eliminate the branch.

#### cmov

```cpp
int abs_branchy(int x) { return x < 0 ? -x : x; }
// compiles to: test, jge, neg, ret -> mispredicts on random input

int abs_cmov(int x) {
    int m = x >> 31;
    return (x ^ m) - m;
}
// no branch, constant 3 ops
```

Compilers emit `cmov` automatically at -O2 in most cases. `__builtin_expect` can pessimize this by re-introducing the branch. Verify in the disassembly.

#### Masking

```cpp
// Conditional add without branch
sum += (cond) ? value : 0;
// becomes: int m = -static_cast<int>(cond); sum += value & m;
```

#### Branchless filter

```cpp
size_t out_idx = 0;
for (size_t i = 0; i < n; ++i) {
    out[out_idx] = data[i];
    out_idx += (data[i] > threshold);
}
```

Throughput on uniform random data with 50% selectivity, Golden Cove, 1M ints:

```
branchy:    280 Mops/s, 22% mispredict
cmov-style:  920 Mops/s, 0% mispredict
SIMD pack:  3100 Mops/s (AVX-512 vpcompressd)
```

### Indirect Branch Costs

A vtable call with an unpredictable target on Sapphire Rapids: about 20 cycles for the resteer. With Spectre mitigations (eIBRS), add another 5 to 8 cycles for indirect calls across protection domains.

Devirtualization is your friend:

```cpp
class Handler { public: virtual void run(Req&) = 0; };
// Hot path: only ever calls one concrete type
auto* h = dynamic_cast<FastHandler*>(get_handler());
if (h) [[likely]] { h->FastHandler::run(req); } // direct call
else { get_handler()->run(req); }              // fallback
```

Or use `final` aggressively. `final` lets the compiler statically resolve the call.

### Junior to FAANG callout

Stop adding `[[unlikely]]` to error paths and patting yourself on the back. The compiler already lays out error paths cold, and the predictor learns the bias in a few iterations. The wins are in eliminating unpredictable branches, not annotating predictable ones.

### Senior at FAANG callout

For tail-latency-sensitive services, mispredicts at p99 dominate. A code path with 99% prediction rate has the 1% case running 15 cycles slow on the actual user requests that are slow (because slow paths correlate). Branchless code has flat latency. That is why search infra at scale prefers SIMD scan over branchy early-exit, even when the average case favors early-exit.

### Quick checklist

- `perf stat`: branch-miss rate above 2% is a smell
- `perf record -b -e branch-misses:pp` to find which branch
- `[[likely]]/[[unlikely]]` only when the bias is real and stable
- PGO before manual hints
- Branchless for 30 to 70 percent selectivity
- SIMD scan and pack (`vpcompressd`, `_pext_u64`) for high-throughput filtering
- Threaded dispatch for interpreters
