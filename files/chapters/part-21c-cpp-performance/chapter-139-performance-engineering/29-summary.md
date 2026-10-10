## Summary

Performance engineering is a discipline that combines hardware knowledge, measurement methodology, and targeted optimization. The key takeaways:

1. **Understand the machine.** CPU pipelines, branch prediction, out-of-order execution, and the cache hierarchy determine where cycles are spent. Code that works with the hardware is fast. Code that fights it is slow.

2. **Data layout dominates.** The choice between AoS and SoA, between linked lists and vectors, between random and sequential access often matters more than algorithmic improvements. A cache miss costs 50-100x an L1 hit.

3. **Measure before optimizing.** Use Google Benchmark for micro-benchmarks, `perf stat` for hardware counters, flame graphs for hotspot identification, and VTune for microarchitectural analysis. Never optimize based on intuition alone.

4. **Use the compiler.** `-O3 -march=native -flto` with PGO captures 80% of potential optimization. Auto-vectorization, inlining, and branch layout optimizations are free if you write compiler-friendly code.

5. **SIMD is the nuclear option.** When auto-vectorization is not enough, intrinsics give 4-16x speedup on data-parallel workloads. Use them for inner loops of compute-bound code.

6. **C++ vs Go is workload-dependent.** C++ wins on compute-bound, latency-sensitive, memory-intensive workloads. Go wins on developer productivity, build times, and concurrent I/O. Both are legitimate choices depending on requirements.

The performance engineer's job is not to make everything fast. It is to make the right things fast, guided by measurement, grounded in hardware reality, and justified by business requirements.

---

| [◀ Chapter 138: Network Programming](../../part-21b-cpp-concurrency-systems/chapter-138-network-programming/00-introduction.md) | [Chapter 139: Performance Engineering](00-introduction.md) | [Chapter 140: Custom Memory Allocators](../chapter-140-custom-allocators/00-introduction.md) ▶ |

