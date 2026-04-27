export default `## Summary

Go's concurrency model is built on three pillars:

1. **Goroutines**: Lightweight threads (2KB stack) managed by the Go runtime, enabling millions of concurrent operations.

2. **Channels**: Typed conduits for safe communication between goroutines, with blocking semantics that enable synchronization.

3. **Select**: Multiplexing primitive for handling multiple channel operations, timeouts, and cancellation.

Key patterns to remember:
- Use **contexts** for cancellation propagation
- Apply **bounded concurrency** with semaphores or worker pools
- Build **pipelines** for data transformation
- Implement **fan-out/fan-in** for parallel processing
- Always consider **goroutine cleanup** to prevent leaks

Production considerations:
- Measure goroutine count in production
- Use errgroup for error handling
- Test for race conditions with \`-race\`
- Monitor channel lengths and blocking

Chapter 12 builds on these primitives with more sophisticated concurrency patterns, including advanced pipeline architectures, rate limiting strategies, and synchronization techniques using mutexes and atomics.

### What You Should Be Able to Do Now

- Explain goroutines, channels, and select without hedging, and predict the behaviour of code that combines them.
- Write a bounded worker pool with context cancellation in five minutes.
- Diagnose a goroutine leak from a pprof snapshot.
- Pick the right synchronisation primitive (channel, mutex, atomic, semaphore, errgroup) for the problem at hand, with profile evidence when it matters.
- Push back in review on unbounded goroutine spawns, missing context propagation, and hand-rolled primitives where stdlib or \`x/sync\` suffices.

### For the Junior-to-FAANG Track

The interview bar on Go concurrency is high. The candidates who pass are the ones who have written concurrent Go (not just read about it) and who can reason about goroutine interleavings, channel semantics, and the race detector with fluency. Build a toy concurrent project (chat server, rate limiter, web crawler) and use it as your reference implementation. When the interviewer asks "implement a rate limiter", you reach for a pattern you have used, not a pattern you have read.

### For the Senior-at-FAANG Track

The leverage is in review discipline. Every concurrent PR you touch is an opportunity to catch an unbounded goroutine, a missing context propagation, a raw WaitGroup that should be errgroup, a channel that no one owns. Over a year, this discipline prevents dozens of production incidents. Document the patterns you apply so the team internalises them. Build the shared helpers so new engineers use the right shape by default.

### For the Staff and Principal Track

Concurrency maturity is a cultural artifact, not a code artifact. The deliverables are:

1. **A concurrency design checklist** applied to every new service.
2. **Shared helpers** (\`safeGo\`, pools, rate limiters, circuit breakers) that encode the team's patterns.
3. **CI gates** (\`-race\`, \`goleak\`, custom linters) that block regressions.
4. **Runtime metrics** (goroutine count, queue depth, worker utilisation) with alerts.
5. **Postmortem discipline** that converts each concurrency incident into a systemic fix.

Teams that invest in these deliverables have an order-of-magnitude lower incident rate than teams that do not. The investment is unglamorous and compounds over years. It is also one of the clearest ways a principal engineer can leave a Go codebase measurably better than they found it.

### Mental Model to Take Away

Concurrent Go is the code you write correctly on Monday and debug on Wednesday when the race you could not reproduce locally fires in production under load. The primitives in this chapter are well-designed, but they do not protect you from bad design. Every concurrent design deserves a written lifetime story: who starts each goroutine, who cancels each goroutine, who owns each channel, who closes each channel, who observes each error. If you cannot answer these five questions at design time, the concurrent code is not ready to merge. This is the discipline that separates Go services that run for years from Go services that need quarterly restarts.

---
`;
