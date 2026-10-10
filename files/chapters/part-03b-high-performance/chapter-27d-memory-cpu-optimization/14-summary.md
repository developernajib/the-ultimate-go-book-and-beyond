## Summary

Effective memory and CPU optimization in Go requires understanding three layers:

- **Hardware**: Cache hierarchy (L1 ~4 cycles, L2 ~12 cycles, L3 ~40 cycles, RAM ~300 cycles or ~100 ns), cache lines (64 bytes), SIMD width (256-bit AVX2 = 4 float64s), branch predictor behavior
- **Language**: Escape analysis (heap vs stack), inlining decisions, bounds check elimination, zero-copy techniques with unsafe. Note what is absent: the gc compiler does not auto-vectorize, so there are no "auto-vectorization conditions" to satisfy
- **Runtime**: GC write barrier overhead during marking, goroutine stack growth, allocator size classes, GOMAXPROCS and scheduler overhead

The optimization loop:
1. **Measure** with pprof CPU + heap profiles
2. **Find** the actual bottleneck (not guessed)
3. **Fix** with the minimum change (pool, layout, algorithm)
4. **Verify** improvement with benchmarks
5. **Repeat**

The levers, roughly in order of what they are worth. Deliberately without a tidy multiplier next to each one, because the multipliers that usually appear in a list like this are the most-copied and least-verified numbers in Go performance writing. Where this chapter re-measured something on its reference machine, the figure is labelled as such and belongs to that machine.

1. **Fix false sharing** where it exists. The one effect in this chapter big enough to survive a noisy box: measured ~4x to ~11x (median ~7.6x) on the padded-counter benchmark in section 1.1. Costs a few bytes of padding. Nothing else here has that ratio of payoff to effort.
2. **Eliminate per-request allocations.** Durable and deterministic, and `allocs/op` proves it without a quiet machine. But verify each case rather than assuming: a `sync.Pool` holding `[]byte` measured *slower and more allocating* than the code it replaced, because `Put(v any)` boxes a non-pointer-shaped value. Pool pointers, and confirm with `-benchmem`.
3. **Fix cache-unfriendly access patterns** (SoA, sequential access, smaller working sets). Real, workload-dependent, and the one whose size you must derive from your own data (how many bytes per unit of work do you actually touch?).
4. **Zero-copy I/O** (sendfile, mmap, unsafe string). Varies entirely with what fraction of your time is I/O, and each option carries a lifetime or page-fault caveat you are accepting along with the speed.
5. **Branch prediction.** Roughly a 2x effect at best (measured, section 1.2), and only on already-sorted data. Do not sort to get it: sorting inside the hot path measured **~200x slower** than the unsorted code it was meant to improve.

And one non-lever, listed because it is widely believed: **there is no auto-vectorization step.** The gc compiler does not auto-vectorize, so no loop rewriting will buy you SIMD. Verify in ten seconds with `go build -gcflags=-S`: you will find `MULSD` (Scalar), never `MULPD` (Packed).

### For the junior engineer on the FAANG track

Leave this chapter with four habits. First, memorize the latency numbers (L1 1 ns, L2 4 ns, L3 15 ns, DRAM 80 ns) so every optimization conversation grounds in real cost. Second, never report a performance change without `benchstat` evidence from ten runs each. Third, learn to distinguish `alloc_space` from `inuse_space` when reading heap profiles, and IPC above 2 from IPC below 1 when reading `perf stat`. Fourth, treat cache optimization as a last resort, not a first one. Most services are not cache-bound, and premature cache tuning creates code that is harder to read without moving the SLO. These four habits are what separate a junior engineer who has read about performance from one who practices it. Interviewers notice the difference immediately, and the habits compound over a career.

### For the senior engineer at FAANG

Leave this chapter with three artifacts per service you own. First, a benchmark suite in CI that asserts allocation budgets and catches regressions before they ship. Second, a dashboard that shows IPC or a close proxy, cache miss rate, GC CPU fraction, and RSS, so runtime behavior is visible at a glance. Third, an ADR trail that records every performance-motivated architectural decision, the baseline metrics, the measured effect, and the rollback criteria. The techniques in this chapter are ingredients. The artifacts are what let a team ship at performance and stay there. Performance engineering at the staff and principal level is not measured by the cleverness of your optimizations but by the durability of the team and the systems you leave behind. Write the documents. Mentor the juniors. Delete the optimizations that are no longer pulling their weight. The hardware will keep evolving. The habits and artifacts outlive any specific technique.

