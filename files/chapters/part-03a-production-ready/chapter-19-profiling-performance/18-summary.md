## Summary

Performance optimization workflow:

1. **Set clear goals**: Define specific metrics (P99 latency, allocations/request)
2. **Measure first**: Profile before optimizing, never guess
3. **Identify bottlenecks**: Use pprof to find the actual hot paths
4. **Apply targeted fixes**: Optimize only what matters
5. **Verify improvements**: Re-measure to confirm gains
6. **Monitor continuously**: Track performance over time

Key tools:
- `pprof`: CPU, memory, goroutine, and mutex profiling
- `trace`: Execution timeline with microsecond granularity
- `benchstat`: Statistical benchmark comparison
- `go build -gcflags="-m"`: Escape analysis inspection
- `GODEBUG=gctrace=1`: GC behavior logging

Common optimizations:
- **Reduce allocations**: sync.Pool, preallocate slices, avoid interface boxing
- **Improve cache locality**: Pack structs, sequential access patterns
- **Reduce GC pressure**: Fewer small allocations, higher GOGC, GOMEMLIMIT
- **Optimize hot paths**: Profile-guided optimization, zero-copy parsing

Remember: The best optimization is the one you don't need to make. Focus on algorithms and architecture first, micro-optimization last.

### For the Senior-at-FAANG Track

The discipline that compounds is evidence-based review: every performance-related PR must show profile evidence and benchmark improvement. Teams that enforce this ship optimizations that actually work. Teams that do not ship changes that sometimes help and sometimes hurt.

### For the Staff and Principal Track

The deliverable is the org's performance culture: continuous profiling in production, benchmarks in CI, PGO for critical services, performance SLOs per service. Teams that reach Level 3 and 4 on the profiling maturity model have measurable cost and latency advantages over teams at lower levels.

### Mental Model to Take Away

Performance is a discipline of measurement, not intuition. Every claim about performance must be backed by evidence. Every optimization must produce measurable improvement or be reverted. Every service has a cost structure that can be understood, monitored, and improved. Teams that internalize this ship fast services at sustainable engineering cost. Teams that do not ship either slow services or over-engineered ones.

---
