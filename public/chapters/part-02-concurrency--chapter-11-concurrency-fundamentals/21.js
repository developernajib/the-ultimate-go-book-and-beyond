export default `## Exercises

1. **Goroutine Leak Detector**: Write a test harness that uses \`runtime.NumGoroutine()\` to detect goroutine leaks. Start a known number of goroutines that each read from a channel, then close the channel and assert, after a brief \`time.Sleep\` - that \`runtime.NumGoroutine()\` has returned to the baseline count recorded before the goroutines were launched. Intentionally introduce a leak (a goroutine blocked on a send to a full unbuffered channel) to confirm the detector catches it, then fix the leak and verify the test passes.

2. **Channel-Based Semaphore**: Implement a \`Semaphore\` type backed by a buffered channel of \`struct{}\`. It must expose \`Acquire()\` and \`Release()\` methods. Write a benchmark that launches 1,000 goroutines all competing to acquire the semaphore with a concurrency limit of 10, measures total throughput, and uses \`runtime.NumGoroutine()\` mid-run to confirm no more than \`10 + overhead\` goroutines are actively past the acquire point simultaneously.

3. **Generic Worker Pool**: Build a worker pool that accepts a configurable number of workers and a job channel of type \`func() error\`. Workers should process jobs concurrently, collect any errors, and return them all via an \`errgroup\`-style result once all jobs complete and the job channel is closed. Write integration tests that submit 100 jobs, some of which return errors, and assert the correct error count is returned without goroutine leaks.

4. **Select with Timeout and Fallback**: Implement a \`FetchWithTimeout[T any](fetch func() T, timeout time.Duration, fallback T) T\` function that launches \`fetch\` in a goroutine, uses \`select\` with a \`time.After\` case, and returns the fallback value if the timeout elapses before \`fetch\` completes. Add a second variant that accepts a \`context.Context\` and selects on \`ctx.Done()\` instead of \`time.After\`. Write table-driven tests covering fast completion, timeout expiry, and context cancellation.

5. **Channel Direction Enforcement**: Refactor a bi-directional pipeline into three strictly-typed functions: a producer \`func produce() <-chan int\`, a transformer \`func transform(in <-chan int) <-chan string\`, and a consumer \`func consume(in <-chan string)\`. The functions must use directional channel types in their signatures so that the compiler rejects any attempt to send on a receive-only channel or receive from a send-only channel. Write a test that composes all three functions and asserts the correct values flow end-to-end through the pipeline.

6. **Pub/Sub System with Channels**: Build a \`Broker[T any]\` struct that allows goroutines to \`Subscribe() <-chan T\` and allows a publisher to call \`Publish(msg T)\`. Each subscriber receives its own buffered channel so that a slow subscriber does not block others. Implement \`Unsubscribe(ch <-chan T)\` that removes the channel and closes it. Write tests with three concurrent subscribers, publish 50 messages, unsubscribe one subscriber mid-stream, and assert each remaining subscriber received all messages published after subscription opened and before it was closed.

7. **Data Race Detection with \`go test -race\`**: Write a struct \`Counter\` with an \`Increment()\` method and a \`Value() int\` method that are intentionally unprotected by a mutex. Write a test that launches 100 goroutines each calling \`Increment()\` 1,000 times and confirm the race detector flags it with \`go test -race\`. Then fix \`Counter\` using \`sync/atomic\` operations, re-run the test, and confirm the race detector reports no races and \`Value()\` returns exactly 100,000.

### Senior at FAANG Track

8. **goleak CI integration.** For one service in your team's ownership, add \`go.uber.org/goleak\` to TestMain in every package. Fix every leak it catches during the rollout. Document the time spent and the leaks fixed. Present the numbers to the team as the case for adopting goleak organisation-wide.

9. **Concurrency review checklist.** Based on the common mistakes and pitfalls sections, build a one-page review checklist. Apply it to the next five concurrent PRs your team reviews. Document the findings: what the checklist caught, what it missed, how long it took to apply. Refine and adopt.

10. **Goroutine metrics dashboard.** Instrument one production service with Prometheus metrics for goroutine count, goroutine lifetime histogram, panic counter, and goroutine-pool utilisation. Build a Grafana dashboard. Set alerts for goroutine-count monotonic growth. Document the SLOs.

11. **\`singleflight\` rollout.** Identify three places in your codebase where duplicate concurrent requests for the same expensive computation could be coalesced. Migrate each to \`golang.org/x/sync/singleflight\`. Measure the request-coalescing ratio in production. Document the capacity saved.

### Staff / Principal Track

12. **Concurrency design guide for the org.** Author the org-wide concurrency design guide. Cover: context propagation rules, bounded concurrency defaults, error propagation patterns, goroutine lifetime requirements, shutdown protocols, observability expectations. Socialise with the senior pool. Publish. Maintain quarterly.

13. **Shared concurrent helpers library.** Design and ship a shared internal Go package for your org with: \`safeGo\`, \`BoundedPool\`, \`Memoize\` (singleflight-backed), \`RetryWithJitter\`, \`CircuitBreaker\`, and a context-aware \`Clock\` (for testable time). Get three teams to adopt it in new code. Measure adoption six months later.

14. **Incident postmortem template for concurrency bugs.** Create a postmortem template specifically for concurrency incidents. Include sections for: which primitive failed, what detection should have caught it, what prevention would have blocked it. Apply the template to three historical incidents. Extract the systemic fixes. Drive their implementation.

15. **Concurrency maturity assessment.** Audit five services in your org against the four-level concurrency maturity model (from section 11.17). Produce a one-page scorecard per service. Recommend the next action to move each service up one level. Present to the engineering leadership.

16. **Go 1.26 leak-profile pilot.** Enable \`GOEXPERIMENT=goroutineleakprofile\` on one production service. Compare the leaks it surfaces against what \`goleak\` catches in CI. Document the coverage gap. Recommend org-wide adoption or rejection. This is principal-level technology evaluation work.

17. **Cross-service backpressure design.** Audit how your org's services handle backpressure from downstream. Identify the services that do not propagate backpressure upstream and therefore accumulate goroutines during downstream failures. Design the systemic fix (bounded queues at every edge, deadline propagation, shared rate-limiting primitives). Drive its rollout.
`;
