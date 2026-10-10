## Learning Objectives

By the end of this chapter, you will be able to:

1. **Master Go's profiling ecosystem** - Use pprof, trace, and benchmarks to identify bottlenecks
2. **Profile CPU usage** - Find and optimize CPU-intensive code paths
3. **Analyze memory allocation** - Reduce heap allocations and memory pressure
4. **Track goroutine behavior** - Identify leaks, contention, and scheduling issues
5. **Use execution traces** - Understand program behavior at microsecond granularity
6. **Write effective benchmarks** - Create reproducible, statistically significant benchmarks
7. **Apply common optimizations** - Use sync.Pool, reduce allocations, optimize data structures
8. **Understand escape analysis** - Predict and control stack vs heap allocation
9. **Monitor production systems** - Implement continuous profiling in production
10. **Build profiling tools** - Create custom profiling infrastructure for your organization

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    PERFORMANCE OPTIMIZATION WORKFLOW                             │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   │
│   │ 1. Set   │───►│ 2. Meas- │───►│ 3. Ident-│───►│ 4. Opti- │───►│ 5. Veri- │   │
│   │  Goals   │    │   ure    │    │   ify    │    │   mize   │    │    fy    │   │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘   │
│        │                                                               │         │
│        │              ◄────────────────────────────────────────────────┘         │
│        │                           Repeat until goals met                        │
│        ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │ GOALS EXAMPLES:                                                         │     │
│  │ • P99 latency < 50ms          • Allocations < 100 per request           │     │
│  │ • CPU usage < 70%             • Memory < 2GB                            │     │
│  │ • 10,000 QPS per instance     • GC pause < 1ms                          │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │ PROFILING TOOLS:                                                        │     │
│  │                                                                         │     │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐         │     │
│  │  │   pprof    │  │   trace    │  │ benchstat  │  │   expvar   │         │     │
│  │  │ CPU/Memory │  │ Execution  │  │ Benchmark  │  │  Metrics   │         │     │
│  │  │ Goroutines │  │  Timeline  │  │ Comparison │  │  Counters  │         │     │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────┘         │     │
│  │                                                                         │     │
│  │  Data Sources:                                                          │     │
│  │  • runtime/pprof - Programmatic profiling                               │     │
│  │  • net/http/pprof - HTTP endpoints                                      │     │
│  │  • runtime/trace - Execution tracing                                    │     │
│  │  • testing - Benchmarks with -cpuprofile/-memprofile                    │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  COMMON BOTTLENECKS:                                                             │
│  ├── CPU: Hot loops, JSON marshaling, regex, crypto                              │
│  ├── Memory: String concatenation, slice growth, interface boxing                │
│  ├── GC: Too many small allocations, large live heap                             │
│  ├── Blocking: Mutex contention, channel operations, syscalls                    │
│  └── Scheduler: Too many goroutines, long-running goroutines                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Outcomes

**Mid-level engineer**

- Capture and read CPU, heap, and goroutine profiles against a running service.
- Write benchmarks with `b.Loop()` or `b.N`, use `-benchmem`, compare with `benchstat`.
- Recognize the top five allocation sources (string concatenation, slice growth, interface boxing, reflection, map growth).

**Senior engineer**

- Drive profile-based optimization in code review: require evidence before approving "optimizations".
- Set performance SLOs (latency, throughput, memory) and track them over time.
- Enable continuous profiling in production and interpret profile trends.

**Staff or Principal**

- Establish the org's performance-engineering discipline: profile-driven decisions, benchmark gates in CI, continuous profiling in production.
- Drive adoption of PGO for latency-critical services.
- Own the cost-structure story: what runs hot, what can be optimized, what is acceptable overhead.
- Maintain awareness of language-level changes that affect performance (Go 1.21 PGO, Go 1.24 map improvements, runtime GC changes).

---
