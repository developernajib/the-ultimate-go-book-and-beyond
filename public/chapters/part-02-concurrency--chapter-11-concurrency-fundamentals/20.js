export default `## Further Reading

- **"Concurrency in Go" by Katherine Cox-Buday**, The most thorough treatment of Go concurrency patterns, covering everything from basic goroutines to advanced pipeline and error-handling strategies.
- **Go Blog: "Concurrency is not Parallelism" (Rob Pike)**, The original talk and post that explains the distinction between concurrency and parallelism with clear visual analogies.
- **Go Blog: "Go Concurrency Patterns"**, Covers the generator, fan-in, timeout, and quit-channel patterns with working code.
- **Go Blog: "Advanced Go Concurrency Patterns"**, Builds on the basics with feed reader examples demonstrating context-aware pipelines and bounded parallelism.
- **Go Memory Model specification** (go.dev/ref/mem), The authoritative reference for happens-before guarantees, channel synchronization semantics, and atomic operation ordering.
- **Package documentation: \`sync\`, \`context\`, \`golang.org/x/sync/errgroup\`**, Primary references for the synchronization and cancellation primitives used throughout this chapter.

### Modern Go Concurrency References (2022 and later)

- **\`golang.org/x/sync/semaphore\`, \`golang.org/x/sync/singleflight\`, \`golang.org/x/sync/errgroup\`**, The three canonical helpers every production Go service should use. Read their documentation and source. The implementations are short and instructive.
- **Go 1.25 \`testing/synctest\` documentation**, Deterministic testing of time-dependent concurrent code. Replaces hand-rolled clock interfaces for most test cases.
- **Go 1.26 \`GOEXPERIMENT=goroutineleakprofile\`**, Runtime detection of leaked goroutines. Opt-in today, likely default in Go 1.27.
- **\`go.uber.org/goleak\`**, Uber's goroutine leak detector. The standard in production Go test suites. Integrate into TestMain.
- **\`go.uber.org/automaxprocs\`**, Container-aware \`GOMAXPROCS\` for Go 1.24 and earlier. Obsolete on Go 1.25+.
- **"Go Data Race Detector" documentation (go.dev/doc/articles/race_detector)**, How to use \`-race\`, what it catches and what it does not.

### Talks and Deep Dives

- **Bryan Mills, "Rethinking Classical Concurrency Patterns"** (GopherCon 2018), A critique of several canonical patterns with modern replacements. Influential for how mature Go teams think about concurrency.
- **Kavya Joshi, "Understanding Channels"** (GopherCon 2017), The internals of Go channels. Useful for understanding performance characteristics.
- **Dave Cheney, "Two Go Programs, Three Different Profiling Techniques"**, Concrete techniques for diagnosing concurrent performance issues with pprof.
- **Roberto Clapis, "A whirlwind tour of Go's runtime environment variables"**, GOGC, GOMAXPROCS, GOMEMLIMIT and friends. Essential for production tuning decisions.

### Staff-Track Reading on Concurrent System Design

- **"Release It!" by Michael Nygard**, Not Go-specific, but the canonical reference for circuit breakers, bulkheads, timeouts, and other concurrent-system resilience patterns. Every staff engineer working on Go services should have read it.
- **"Designing Data-Intensive Applications" by Martin Kleppmann**, The concurrency chapter (Chapter 7, transactions) explains isolation levels and concurrent-access patterns at a level of rigor that applies to any distributed system including those built in Go.
- **Google SRE book, "Handling Overload"**, How large-scale systems shed load, backpressure upstream, and degrade gracefully. Concurrency patterns inform service architecture at this level.

---
`;
