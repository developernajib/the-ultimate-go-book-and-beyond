## AutoFDO, BOLT, and Propeller: Post-Link and Sample-Based PGO

Classic PGO (`-fprofile-generate` / `-fprofile-use`) requires running an instrumented binary. The instrumentation is invasive (inserts counters into every basic block), slows the binary 2-5x, and forces you to maintain a separate PGO build pipeline. For a search engine or a database that cannot be instrumented in production, classic PGO is a non-starter. Two techniques replace it: AutoFDO (sample-based PGO at compile time) and BOLT or Propeller (post-link optimization on the already-compiled binary).

### AutoFDO

AutoFDO uses sampled profiles from the production binary, collected with `perf record -b` on the last-branch-record (LBR) hardware, converted to a format the compiler understands, and replayed at the second compile. Because it is sampled rather than instrumented, the overhead in production is under 1%.

```bash
# Collect samples from running production binary (on a canary)
perf record -b -e br_inst_retired.near_taken:pp -- ./server --duration=300

# Convert perf.data to AutoFDO format
create_llvm_prof --binary=./server --profile=perf.data --out=server.prof

# Rebuild with the sampled profile
clang++ -O3 -fprofile-sample-use=server.prof -o server server.cpp
```

AutoFDO typically recovers 60-80% of the speedup of classic PGO. The compiler uses the sample data for inlining decisions, block placement, and branch-hint generation. CSSPGO (context-sensitive sample PGO) in LLVM 15+ improves this further by tracking call stacks, allowing inlining decisions that depend on the caller, not just the callee frequency.

### BOLT: Rewriting the Compiled Binary

BOLT (Binary Optimization and Layout Tool, from Meta) takes an already-compiled binary and rewrites it using the same profile data. It operates after the linker, so it sees the final code layout and can reorder basic blocks across translation-unit boundaries that the compiler could not.

```bash
perf record -e cycles:u -j any,u -- ./server --duration=60
perf2bolt -p perf.data -o server.fdata ./server

llvm-bolt ./server -o ./server.bolt \
    -data=server.fdata \
    -reorder-blocks=ext-tsp \
    -reorder-functions=hfsort+ \
    -split-functions \
    -split-all-cold \
    -split-eh \
    -dyno-stats
```

Meta reports 5-15% additional performance on top of PGO for large binaries like HHVM. The win comes from:
1. **Function reordering** (`hfsort+`): hot functions are placed adjacently in the text segment, reducing iTLB and icache pressure.
2. **Basic block splitting**: cold blocks are moved to a separate cold section, so the hot path in `.text.hot` is dense.
3. **Jump table layout**: indirect jumps are reordered so the most frequent target is first.

### Propeller: Compiler-Integrated Post-Link

Propeller (from Google, integrated in LLVM 14+) solves the same problem as BOLT but does the work inside the compiler, not as a post-link rewriter. It requires two compiler invocations: the first generates a "basic block address map," the second re-compiles with profile data and emits a relinkable object file that the linker arranges optimally.

```bash
# Stage 1: build with labels
clang++ -O3 -fbasic-block-sections=labels -o server.labeled server.cpp

# Run under perf, extract branch samples
perf record -e cycles:u -j any,u -- ./server.labeled
create_llvm_prof --binary=./server.labeled --profile=perf.data \
    --format=propeller --out=cluster.txt --propeller_symorder=symorder.txt

# Stage 2: rebuild using propeller data
clang++ -O3 -fbasic-block-sections=list=cluster.txt -o server server.cpp
ld.lld --symbol-ordering-file=symorder.txt ...
```

Propeller typically matches BOLT's speedup and integrates more cleanly with hermetic build systems (Bazel, Buck2) because there is no separate post-link tool to invoke.

### Production Pipeline

At FAANG scale, the PGO loop looks like this:

1. Canary a small percentage of traffic on the current binary.
2. Collect `perf record -b` samples at low frequency (e.g., 1% sampling).
3. Aggregate samples across hosts for a 24-hour window.
4. Rebuild the binary at release cut with AutoFDO + Propeller + LTO.
5. A/B test the new binary against the previous one. Roll forward on improvement.

This loop runs continuously. The profile is always fresh, so the binary optimizes for the current workload mix, not for whatever trace was captured six months ago. Without sample-based PGO, this pipeline would require instrumenting production, which is unacceptable for latency-sensitive services. Senior engineers invest in this pipeline early, because the compounding speedup across a year of profile-driven releases is often 30-50% over the un-tuned baseline.
