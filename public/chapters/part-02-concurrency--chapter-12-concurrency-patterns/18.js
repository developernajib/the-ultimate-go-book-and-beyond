export default `## Exercises

1. **Fan-Out Fan-In Pipeline**: Build a three-stage pipeline that (1) generates integers 1-100 on a source channel, (2) fans out to five concurrent worker goroutines each squaring their inputs, and (3) fans back in by merging all five output channels into a single result channel. Every stage must respect a \`context.Context\` for cancellation. Write a test that cancels the context after 20 results have been collected and asserts that all goroutines exit cleanly using \`runtime.NumGoroutine()\` before and after the pipeline.

2. **Context Cancellation Propagation**: Implement a three-level call chain - \`Level1\` calls \`Level2\`, which calls \`Level3\` - where each level spawns a goroutine that performs a simulated long-running operation via \`time.Sleep\`. Pass a single \`context.Context\` derived from \`context.WithCancel\` down through all levels. Cancel the context from the test after 50ms and assert that all three goroutines have exited within 200ms. Use a \`sync.WaitGroup\` to track goroutine completion and verify no leaks remain.

3. **Done Channel Pattern**: Without using \`context\`, implement a reusable \`done\` channel pattern for coordinating shutdown across multiple goroutines. Build a \`Supervisor\` struct that owns a \`done chan struct{}\` and exposes \`Shutdown()\` (closes the channel) and \`Done() <-chan struct{}\` (returns the channel). Launch five worker goroutines that each loop, selecting on \`Done()\` - and write a test that calls \`Shutdown()\`, then asserts all five workers exit within 100ms. Verify that \`Shutdown()\` is idempotent and does not panic on a second call.

4. **Bounded Parallelism**: Implement \`BoundedMap[T, R any](ctx context.Context, items []T, limit int, fn func(context.Context, T) (R, error)) ([]R, error)\` that processes items concurrently with at most \`limit\` goroutines in flight at once using a semaphore channel. Preserve input order in the output slice. Write tests with \`limit=3\` and 15 items where every third item returns an error, and assert that all errors are aggregated, the result slice length matches input, and no goroutines are leaked after the function returns.

5. **Heartbeat Goroutines for Monitoring**: Build a long-running \`Worker\` that, in addition to processing tasks from a job channel, emits a \`time.Time\` value on a heartbeat channel at a configurable interval (e.g., every 100ms). Write a \`Monitor\` function that receives from the heartbeat channel and raises an alert (returns an error or sends on an alert channel) if no heartbeat is received within twice the expected interval. Write a test that pauses the worker intentionally and confirms the monitor detects the missed heartbeat, then resumes the worker and confirms normal heartbeats restore the healthy state.

6. **Or-Done Channel**: Implement the \`OrDone[T any](done <-chan struct{}, in <-chan T) <-chan T\` combinator that transparently proxies values from \`in\` to the returned channel but stops as soon as either \`done\` is closed or \`in\` is closed. Write a test that pipelines three stages each wrapped with \`OrDone\`, sends 1,000 values, closes \`done\` after 200 values have passed through, and asserts the returned channel drains promptly, within 50ms, and that all goroutines spawned by \`OrDone\` have exited.

7. **Concurrent Rate Limiter**: Implement a token-bucket \`RateLimiter\` that allows a configurable burst size and a steady refill rate (tokens per second) using a goroutine that ticks at the appropriate interval. Expose \`Allow(ctx context.Context) error\` which blocks until a token is available or the context is cancelled. Write a benchmark that concurrently fires 500 requests at a limiter configured for 50 RPS with a burst of 10, records the per-request latency distribution, and asserts that the measured throughput does not exceed 50 RPS by more than 5% over a 2-second window.
- Package: golang.org/x/time/rate

### Senior at FAANG Track

8. **Composition case study.** Pick one production service you own. Document every concurrent pattern in use and how they compose. Identify one pattern that should be added (missing circuit breaker, missing rate limit, missing retry with jitter) or one that should be removed (unused pool, redundant pub/sub). Propose and land the change.

9. **Pattern review rubric.** Build a one-page review rubric for concurrent patterns: when each applies, when each is overkill, what the review question is for each. Apply it for one month. Measure the catches and misses. Publish.

### Staff / Principal Track

10. **Shared library consolidation.** Inventory all concurrent-pattern implementations across five services in your org. Produce a consolidation plan: one canonical implementation per pattern, migration timeline, ownership. Drive execution over two quarters.

11. **Pattern-aware postmortem template.** Author a postmortem template that requires naming the concurrent pattern involved in every incident. Apply it to three recent incidents retroactively. Extract the systemic patterns across the incidents. Present to the engineering leadership.

12. **Scaling-transition doc.** For one service, document the thresholds at which in-process patterns (worker pool, pub/sub, sharded map) need to become distributed (message broker, distributed cache, sharded database). Include signals, recommended architectures, and migration sequencing. Use this to inform the next round of service architecture reviews.

13. **Service-mesh integration.** If your org uses a service mesh, audit whether applications still carry redundant circuit breakers, retry logic, or rate limiters. Recommend migration to mesh-level features where appropriate. Document trade-offs per service.

14. **Teaching clinic.** Run a workshop covering the chapter's patterns with hands-on exercises. Measure comprehension via a follow-up quiz. Iterate on the workshop based on results. The deliverable is the workshop artifact, reusable for onboarding future engineers.
`;
