## Learning Objectives

By the end of this chapter, you will be able to:
- Explain the Go runtime's GC algorithm (tri-color concurrent mark-and-sweep) in detail
- Measure and interpret GC pause times, heap growth, and allocation rates
- Apply GOGC, GOMEMLIMIT, and `runtime.AddCleanup` correctly for production systems
- Understand the Go scheduler (GMP model) and its impact on latency
- Diagnose and fix goroutine leaks, stack growth storms, and scheduler starvation
- Use runtime/trace, pprof, and GODEBUG to observe runtime internals
- Implement GC-friendly data structures that minimize GC scan time
- Design systems that stay within GC pause budgets at any scale

**Junior → FAANG track.** You should finish the chapter able to read a `GODEBUG=gctrace=1` line and explain every column, open a heap profile and distinguish `alloc_space` from `inuse_space` in one sentence, walk an interviewer through "what happens when you call `go f()` and then `f()` calls a blocking syscall," and translate "my service is slow" into a numeric claim before touching code. Note what a well-formed claim looks like, because it is usually not about pauses. Go's stop-the-world pauses are sub-millisecond, so a claim like "each GC pause is 4 ms" should make you re-check your instrumentation rather than reach for GOGC. The real claim reads more like "GC is burning 22 percent of our CPU at 12 cycles per second, and the p99 hit is mark assist time charged to the request goroutines," which points at the allocation rate instead.

**Senior @ FAANG track.** Beyond the mechanics, you should be able to write the one-page GC tuning ADR for a service (baseline metrics, chosen knob, monitoring plan, rollback criteria), facilitate a blameless post-incident review where the root cause was a GC regression, defend or reject a proposed `GOMEMLIMIT` in code review with a written trade-off table, and mentor a junior engineer through their first `pprof` investigation without holding the keyboard. Those are the staff-level artifacts the runtime knowledge in this chapter ultimately feeds into.

---
