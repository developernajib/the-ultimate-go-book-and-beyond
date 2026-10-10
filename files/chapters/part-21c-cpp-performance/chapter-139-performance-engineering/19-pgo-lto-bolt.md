## PGO, LTO, and BOLT

Three orthogonal post-source optimizations. PGO uses runtime profiles to drive compiler decisions. LTO lets the compiler optimize across translation units. BOLT rewrites the linked binary using an even more accurate profile. They compose: PGO + LTO + BOLT on real services typically gives 20 to 35% throughput improvement.

### PGO Workflow (Instrumented)

GCC:

```bash
g++ -O2 -fprofile-generate=/tmp/prof -o app.gen app.cc
./app.gen <representative load>
g++ -O2 -fprofile-use=/tmp/prof -fprofile-correction -o app app.cc
```

Clang:

```bash
clang++ -O2 -fprofile-instr-generate=app-%p.profraw -o app.gen app.cc
LLVM_PROFILE_FILE="app-%p.profraw" ./app.gen <representative load>
llvm-profdata merge -output=app.profdata app-*.profraw
clang++ -O2 -fprofile-instr-use=app.profdata -o app app.cc
```

What PGO does:

- Edge frequencies drive block layout (hot path on fall-through, cold blocks moved to `.text.unlikely`)
- Inlining cost model: hot edges aggressive, cold edges suppressed
- Function splitting: cold blocks in cold sections improve icache density
- Indirect call promotion: turn `(*fn)()` into `if (fn == &foo) foo(); else (*fn)();` for hot targets
- Register allocation: hot variables prioritized
- Unrolling and vectorization decisions

Typical wins on C++ services: 8 to 15%. Lower (3 to 5%) for already heavily-optimized hot paths. Higher (20%+) for branchy interpreters and dispatchers.

### AutoFDO (Sampled PGO)

Instrumented PGO needs a special build that runs your workload (slowly, 2 to 4x slowdown). For production it is not viable. AutoFDO uses `perf record` LBR samples from the production build.

```bash
# Step 1: build with frame pointers and LBR-friendly layout
clang++ -O2 -fno-omit-frame-pointer -gline-tables-only -o app app.cc

# Step 2: collect in production
perf record -e cycles:u -j any,u -- ./app  # or attach with -p PID

# Step 3: convert to LLVM profile format
llvm-profgen --binary=./app --perfdata=perf.data \
    --output=app.afdo

# Step 4: rebuild with profile
clang++ -O2 -fprofile-sample-use=app.afdo -o app.opt app.cc
```

GCC equivalent uses `create_gcov` (Google's autofdo tool). Production-grade pipelines (Google's pipeline, Meta's HHVM) run this continuously, profiles refresh every few hours.

AutoFDO recovers about 70 to 85% of instrumented PGO's benefit, but with zero production overhead. For binaries you cannot afford to run instrumented (real services), this is the only option.

### LTO

Two flavors:

**Full LTO**: link-time merges all bitcode into one module, optimizes the whole program. Maximum optimization, slowest links (10 to 60 minutes for large binaries), high memory (64+ GB for huge codebases).

**Thin LTO**: parallelizable, summary-based. Each TU keeps its own bitcode, link does cheap summary import + parallel per-module optimization. 80 to 90% of full LTO's benefit, link times close to non-LTO.

```bash
# Full LTO
clang++ -O2 -flto=full -o app *.cc

# Thin LTO (recommended default)
clang++ -O2 -flto=thin -o app *.cc

# GCC
g++ -O2 -flto=auto -o app *.cc
```

What LTO unlocks:

- Cross-TU inlining
- Cross-TU devirtualization
- Cross-TU dead-code elimination
- Better whole-program register allocation for static functions
- Constant propagation across TU boundaries

For a 50 KLOC C++ service, LTO alone gives 3 to 7%. Combined with PGO it compounds (PGO inlining decisions become more accurate when more callees are visible).

### Combining PGO and LTO

```bash
# Generate
clang++ -O2 -flto=thin -fprofile-instr-generate -o app.gen *.cc
./app.gen <load>
llvm-profdata merge -o app.profdata default*.profraw

# Use
clang++ -O2 -flto=thin -fprofile-instr-use=app.profdata -o app *.cc
```

Order: PGO first, LTO second, in the same build invocation.

### BOLT (Binary Optimization and Layout Tool)

Open-sourced by Meta in 2018, now part of LLVM (since LLVM 16). Operates on the linked ELF binary using a more accurate profile (BB-level branch counts from LBR), and rewrites the binary with:

- Basic block reordering (Pettis-Hansen, ext-TSP)
- Function reordering (hot functions packed at the start of `.text`)
- Function splitting (cold blocks to `.text.cold`)
- Branch direction swapping (fall-through favored)
- Jump conversion (jne to je if better)
- Indirect call promotion
- ICF for cold functions

```bash
# Build with relocations preserved
clang++ -O2 -flto=thin -fprofile-instr-use=app.profdata \
    -Wl,--emit-relocs -o app *.cc

# Profile collection (perf record with LBR)
perf record -e cycles:u -j any,u -o app.perf.data -- ./app <load>

# Convert perf data to BOLT profile
perf2bolt -p app.perf.data -o app.fdata app

# Optimize
llvm-bolt app -o app.bolt -data=app.fdata \
    -reorder-blocks=ext-tsp -reorder-functions=hfsort+ \
    -split-functions -split-all-cold -split-eh \
    -dyno-stats
```

Real numbers Meta has published:

- Clang itself: 8% improvement after PGO+LTO+BOLT
- HHVM: 6 to 8% throughput
- Search-class workloads: 5 to 12% (the icache-bound ones)

BOLT works particularly well on large icache-bound binaries (>10 MB hot text). Smaller binaries already fit in icache, BOLT only saves a few percent there.

### Propeller (Google)

Google's alternative to BOLT, integrated into LLD. Instead of rewriting the binary, Propeller emits a layout file the linker uses on a final pass. Advantages:

- Plays nicely with debug info and profilers
- Avoids BOLT's "binary is now opaque to your tooling" problem
- Lower memory than BOLT for huge binaries

```bash
# Phase 1: build with -fbasic-block-sections=labels for fine-grained labeling
clang++ -O2 -flto=thin -fprofile-sample-use=app.afdo \
    -fbasic-block-sections=labels -o app.labeled *.cc

# Phase 2: profile
perf record -e cycles:u -j any,u -- ./app.labeled <load>
create_llvm_prof --binary=app.labeled --profile=perf.data \
    --format=propeller --out=app.propeller

# Phase 3: rebuild with layout
clang++ -O2 -flto=thin -fprofile-sample-use=app.afdo \
    -fbasic-block-sections=list=app.propeller_bb \
    -fuse-ld=lld -Wl,--symbol-ordering-file=app.propeller_func \
    -o app *.cc
```

Status: production at Google for many years, in upstream LLVM. Less polished than BOLT for non-Google users, but improving.

### Order in CI/CD

```
1. Source-level changes
2. Compile with PGO instrumentation
3. Run representative workload
4. Merge profile
5. Rebuild with PGO + LTO
6. Build with -Wl,--emit-relocs
7. Profile the built binary
8. BOLT or Propeller pass
9. Final binary
```

Cycle: profiles refresh weekly or monthly. Older profiles still help, miss-rate degrades slowly.

### Pitfalls

- PGO with a non-representative workload can pessimize cold paths (now genuinely slow because they were marked cold). Sample the real prod traffic mix.
- BOLT'd binaries break some symbolizers. Rebuild a debug-info-only sidecar.
- Thin LTO + PGO: ensure profile is loaded by the LTO link, not just compile.
- Profile staleness: use `-fprofile-correction` (GCC) or `-fprofile-sample-accurate` (Clang) to control behavior on mismatches.
- BOLT and ASAN do not mix.

### Junior to FAANG callout

If your service is in C++ and ships to a fleet, you are leaving 15% perf on the table without PGO+LTO. The CI complexity is real but the engineering payback is enormous compared to micro-optimizations. Build the pipeline once.

### Senior at FAANG callout

PGO/AutoFDO/BOLT must be part of the release process, not a one-time experiment. Profile freshness, profile correctness across versions, fallback when profile is missing or stale, and observability (which functions did BOLT actually move?) are real production concerns. Meta's BOLT, Google's Propeller, and the GCC AutoFDO pipeline all have years of operational lessons baked in. Read them.

### Quick stats reference

| Optimization | Typical gain on C++ service |
|--------------|------------------------------|
| LTO alone | 3 to 7 % |
| PGO alone | 8 to 15 % |
| PGO + LTO | 12 to 20 % |
| PGO + LTO + BOLT | 18 to 32 % |
| AutoFDO (vs no PGO) | 6 to 12 % |
