## Learning Objectives

By the end of this chapter, you will be able to:
- Apply CPU cache hierarchy knowledge to write cache-friendly Go code
- Reduce heap allocations using escape analysis, inlining, and struct embedding
- Use cache-friendly algorithms and data layouts, and know that the gc compiler does not auto-vectorize, so real SIMD means assembly, an assembly-backed library, or the experimental `simd/archsimd`
- Optimize branch prediction with sorted data and branchless techniques
- Profile CPU utilization using hardware performance counters via perf
- Implement memory-mapped I/O for zero-copy large data processing
- Tune network I/O with sendfile, splice, and scatter-gather I/O
- Measure and interpret CPU flame graphs, IPC, and cache miss rates

**Junior → FAANG track.** You should finish the chapter able to run `perf stat -e cache-misses,cache-references,instructions,cycles ./binary` and explain what each number means in one sentence, read a flame graph and name the top 3 hot functions with a hypothesis for each, write a `testing.B` benchmark that uses `b.Loop()` (Go 1.24+) correctly, and explain cache lines, false sharing, and struct alignment to an interviewer using your hands as a whiteboard.

**Senior @ FAANG track.** Beyond the mechanics, you should be able to write the one-paragraph justification that accompanies any cache-oriented optimization PR (profile evidence, measured delta, maintenance cost), run a blameless post-incident review where the root cause was an unexpected cache miss regression after a struct field reorder, defend or reject a proposed SIMD-friendly refactor in code review with a written trade-off table, and mentor a junior engineer through their first `perf stat` investigation without holding the keyboard. Those are the staff-level artifacts the hardware knowledge in this chapter ultimately feeds into.

---
