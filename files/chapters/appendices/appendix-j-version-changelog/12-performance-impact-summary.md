## Performance Impact Summary

Every major Go release delivers continuous improvements to runtime throughput, compilation latency, garbage collection pause times, and memory efficiency. The following summary details the measured performance impact of key releases from Go 1.18 through Go 1.24.

---

### Go 1.18
- **Generics**: Initial implementation relied on gcshape stenciling and dictionary passing. Generic code executed within 0%–5% of hand-written concrete implementations.
- **Compiler**: Initial generics integration increased compilation times by ~15% on large codebases.
- **Binary Size**: Modest 5%–10% binary growth due to stenciled instantiations.

### Go 1.19
- **Memory Ceiling (`GOMEMLIMIT`)**: Prevented container OOM-kills in Kubernetes by triggering opportunistic GC cycles before reaching the cgroup limit, slashing container crash rates by over 90% across microservice fleets.
- **Dynamic Stack Allocation**: Optimized copying stack allocation, reducing allocation latency for deeply nested goroutines.

### Go 1.20
- **PGO Preview**: Introduced profile-guided optimization, delivering an immediate 3%–4% CPU throughput improvement on representative production services.
- **Compiler Recovery**: Optimized compiler data structures, recovering the 15% compile-time slowdown introduced in 1.18.

### Go 1.21
- **PGO Production GA**: Delivered 2%–7% typical CPU performance improvements across production web services by inlining hot call paths and devirtualizing interface dispatches based on real production traces.
- **Structured Logging (`log/slog`)**: Provided structured key-value logging with zero allocations on hot paths when using `slog.Attr`.

### Go 1.22
- **For-Loop Scoping**: The per-iteration variable fix was achieved with zero measurable performance degradation (<0.5%) due to compiler escape analysis optimizations.
- **Pattern Routing (`net/http`)**: Enhanced `ServeMux` added HTTP method and wildcard routing with negligible routing overhead, eliminating third-party routing dependencies in most microservices.

### Go 1.23
- **Timer / Ticker Channel Fixes**: Resolved the multi-decade issue where unreferenced `time.Timer` and `time.Ticker` objects could not be garbage collected until they expired. Channels are now unbuffered and garbage collected immediately when abandoned.
- **Iterators (`iter.Seq`)**: The compiler inlines range-over-func loops, resulting in zero overhead compared to traditional callback functions.
- **Value Interning (`unique`)**: Made string/value comparison an O(1) pointer equality check, cutting memory usage in large ASTs and symbol tables by up to 60%.

### Go 1.24
- **SwissMap Hash Table**: Replaced the classical 8-slot bucket hash map with a modern Swiss Table design (inspired by Google Abseil), delivering 15%–20% faster map lookups and inserts through superior CPU cache-line locality and SIMD group matching.
- **Weak Pointers**: Enabled canonical memory-safe caches that do not prevent objects from being reclaimed by the garbage collector.
- **Benchmark Loops (`b.Loop()`)**: Eliminated benchmark warm-up errors and manual reset calls, providing deterministic, repeatable benchmarking results.

---
