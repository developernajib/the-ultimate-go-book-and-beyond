## Exercises

1. **Identifying and Fixing a Goroutine Leak**: You are given a worker function that launches a goroutine to process jobs from a channel but never signals the goroutine to stop when the caller is done. Add `go.uber.org/goleak` to the test suite with `defer goleak.VerifyNone(t)`, reproduce the leak, then fix it by threading a `context.Context` through the worker so the goroutine exits when the context is canceled. Confirm the test passes cleanly after the fix with zero leaked goroutines.

2. **Diagnosing a Deadlock**: Given a bank-transfer program that acquires two account mutexes in inconsistent order, reproduce the deadlock, then diagnose it from the `all goroutines are asleep` stack dump. Now do the part that matters: add a single goroutine that does nothing but `time.Sleep` in a loop, as every real server has, and re-run. The runtime message disappears entirely and the program hangs in silence, because the detector fires only when *every* goroutine is blocked. Diagnose it again using a goroutine dump instead, which is the only technique that transfers to production. Fix by enforcing a canonical lock order (always lock the lower account id first), and remember to handle `from == to`, which deadlocks on a single non-reentrant mutex no matter how you order things. Add a test with `go test -timeout 5s` to assert the transfer completes.

3. **Fixing a Race Condition with Proper Synchronization**: A provided HTTP request counter increments a plain `int` from multiple goroutines, producing intermittent wrong totals. Run `go test -race` to confirm the data race, then evaluate three fixes: `sync/atomic`, `sync.Mutex`, and a single aggregator goroutine receiving counts over a channel. Implement the most appropriate one, justify the choice in a comment, and verify the race detector reports zero races. Then add the assertion that matters: that the final count equals the exact expected total. Convince yourself why a test asserting only "no race reported" would still pass if you replaced the increment with a check-then-act sequence that loses updates.

4. **Converting Mutex-Heavy Code to Channel-Based**: Refactor a shared-state cache that uses three separate mutexes (one each for data, stats, and expiry) into a design where a single owner goroutine manages all state and external callers communicate via request/response channels. Benchmark both implementations with `go test -bench` under concurrent load and document the throughput and latency trade-offs observed, noting when each design is preferable.

5. **Avoiding Premature Optimization with Goroutines**: A colleague has rewritten a simple slice-sorting function to distribute work across N goroutines, but benchmarks show it is slower than the sequential version for inputs under 100,000 elements due to goroutine-spawn and channel overhead. Profile both versions with `go test -bench -benchmem -cpuprofile`, identify the crossover point where parallelism becomes beneficial, add a threshold check inside the function so it falls back to sequential processing below that point, and update the benchmark to confirm the optimized hybrid version is never slower than sequential.

6. **Fixing a Channel Direction Anti-Pattern**: Refactor a pipeline in which every function accepts a bidirectional `chan int` parameter, making it unclear which stages own the channel and enabling accidental sends on receive-only stages. Rewrite all function signatures using directional channel types (`chan<- int` for senders, `<-chan int` for receivers), ensure the channel is created and closed only by the designated owner stage, and verify the compiler enforces directionality by attempting a disallowed operation and confirming the compile error.

7. **Implementing Safe Shutdown of a Goroutine Pool**: Build a worker pool that accepts jobs through a channel, processes them with a fixed number of goroutines, and supports a `Shutdown(ctx context.Context) error` method. Shutdown must: drain and complete all already-queued jobs, stop accepting new jobs, wait for all workers to finish, and return `ctx.Err()` if the context deadline is exceeded before all workers exit. Write tests covering normal shutdown, shutdown under active load, and shutdown timeout, verifying no goroutines leak after each scenario using `goleak`.

Each exercise targets a specific anti-pattern from this chapter. Work through them with the race detector enabled (`go test -race`) and verify leak freedom with `goleak` to build the debugging instincts that prevent these bugs from reaching production.

### Senior at FAANG Track

8. **Systematic antipattern audit.** For one production service, grep for signatures of each antipattern in this chapter (lock copied by value, `time.After` in loops, context stored in structs, unbounded goroutine spawns). Fix each. Document the findings.

9. **goleak rollout at team level.** Across every package your team owns, integrate `goleak.VerifyTestMain`. Fix every leak it catches. Report the pre/post counts.

10. **Production goroutine-leak detection.** Build a runbook for diagnosing goroutine leaks in your on-call rotation. Include specific pprof commands, dashboard links, and escalation paths. Test via simulated leak.

### Staff / Principal Track

11. **Concurrency-incident root-cause analysis.** For the last five concurrency incidents at your org, categorize by antipattern. Identify the top systemic gaps (tooling, process, training). Propose and land fixes.

12. **Org-wide linter rollout.** For each mechanically-detectable antipattern, author or adopt a linter rule. Wire into CI. Measure false-positive rate and catch rate.

13. **Team antipattern dashboard.** Build a dashboard that tracks antipattern-related incidents over time. Use it to guide investment priorities. Present quarterly to engineering leadership.

14. **Concurrency onboarding.** Design a one-week concurrency onboarding module for new Go engineers joining your team. Include hands-on debugging exercises, anti-pattern recognition drills, and a graded exercise to pass before working unsupervised on concurrent code.

15. **Incident postmortem library.** Compile the last twenty concurrency incidents into an internal library. Link from onboarding. Reference in every postmortem. This is the compounding investment that reduces incident rates over years.
