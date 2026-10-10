## Exercises

1. **Graceful HTTP Server Shutdown with os.Signal**: Build an HTTP server that listens for `SIGINT` and `SIGTERM` using `signal.NotifyContext`. When a signal is received, call `server.Shutdown(ctx)` with a 30-second deadline context rather than `server.Close()`. Note that the deadline context must be rooted at `context.Background()`, not derived from the signal context, which is already canceled by the time you reach this code. Add a `/slow` endpoint that sleeps for 10 seconds to simulate in-flight work. Verify by sending a request to `/slow` and then immediately sending `SIGTERM`. The server must wait for the handler to finish before exiting. Log a clear message at each shutdown phase: signal received, shutdown initiated, shutdown complete. Then break it deliberately: pass the signal context to `Shutdown` instead and confirm it returns in microseconds with `context canceled`, killing the in-flight request.

2. **Draining In-Flight Requests**: Implement a `DrainMiddleware` that tracks active requests using `sync.WaitGroup`. On each incoming request, check a "still accepting" flag and call `wg.Add(1)` **under the same `RWMutex` read lock**, then defer `wg.Done()`. Expose a `Drain(ctx context.Context) error` method that calls `wg.Wait()` inside a goroutine and returns when all requests finish or the context deadline is exceeded.

    The ordering is the exercise. Sequence it as: stop accepting (close the listener via `http.Server.Shutdown`), *then* `Drain`. Prove to yourself why the reverse is wrong by writing the broken version first: with the listener still open and a client sending steady traffic, have `Drain` call `wg.Wait()` and log how many requests the server serves *after* `Drain` claims completion. You will find it returns almost immediately, because the counter hits zero in the idle gap between two requests rather than at the end of traffic. Draining a server that is still accepting is meaningless, and a `WaitGroup` at zero means "nothing in flight right now", never "nothing more is coming".

    Also confirm the `RWMutex` earns its place: remove it, run the test under `-race` with 200 concurrent requests racing a shutdown, and watch for the `WaitGroup` reuse misuse when an `Add` lands after `Wait` has already returned.

3. **Cleaning Up Database Connections on Shutdown**: Wrap `*sql.DB` in a `ManagedDB` struct that implements a `Shutdown(ctx context.Context) error` method. Inside `Shutdown`, stop accepting new queries, wait for all active queries to finish using a `sync.WaitGroup`, and then call `db.Close()`. The gate and the `Add` must be a single atomic step (an `RWMutex` around a bool, not a bare `atomic.Bool` checked separately from the `Add`), or a query can slip in after `Wait` has returned and run against a closed pool. Chain this into your server's shutdown sequence after `server.Shutdown` completes. Write a test using a real SQLite `database/sql` driver (or a small in-process fake driver) that verifies no new queries are accepted after shutdown is triggered and that in-progress queries complete normally.

    Worth confirming for yourself, since it is the reason this wrapper exists at all: `db.Close()` does **not** wait for in-flight queries. Start a slow query, call `db.Close()` from another goroutine, and time it. It returns immediately, leaving your query to fail. (It is, however, idempotent: calling it three times returns `nil` each time and panics nothing.)

4. **Coordinating Shutdown of Multiple Goroutines**: Design a `ShutdownGroup` type that manages an arbitrary number of named background workers (for example a Kafka consumer, a cache warmer, a metrics flusher). Each worker receives a `context.Context` and must return when it is canceled. `ShutdownGroup.Shutdown(timeout time.Duration)` must cancel all worker contexts simultaneously and block until all workers exit or the timeout elapses, whichever comes first. If the timeout is exceeded, log which workers are still running by name. Note that a plain `sync.WaitGroup` cannot tell you *which* workers are outstanding, only that some are, so you will need per-worker state to produce that log line. Write a test with three workers (one that exits immediately, one that exits after 100ms, and one that ignores cancellation entirely) and verify the timeout path reports only the stuck worker by name.

5. **Testing Shutdown Behavior**: Write a table-driven integration test suite for a complete graceful shutdown scenario. Each test case should: start a real `http.Server` on a random port, optionally register slow handlers, trigger shutdown by sending `syscall.SIGTERM` to the current process (using `syscall.Kill(os.Getpid(), syscall.SIGTERM)`), and assert the expected outcome (all in-flight requests completed, server port is no longer listening, exit was clean within deadline). Include test cases for: normal shutdown with no active requests, shutdown with active requests that finish within the deadline, and shutdown with a request that exceeds the deadline to verify the forced-exit path.

### Senior at FAANG Track

6. **Rolling deploy zero-downtime test.** Run a load generator against a service during a Kubernetes rollout. Assert zero 5xx and zero connection resets. Identify any configuration issues (preStop duration, terminationGracePeriodSeconds, readiness).

7. **Shutdown timing audit.** For each service you own, measure actual drain time under p99 load. Adjust `terminationGracePeriodSeconds` accordingly.

### Staff / Principal Track

8. **Service template with shutdown.** Ensure every new service has correct graceful shutdown via the shared template. Audit existing services and remediate gaps.

9. **Production readiness gate.** Add graceful-shutdown verification to the production readiness checklist. Require evidence before launch approval.

10. **Shared service manager.** Build and maintain the shared service-manager library. Drive adoption across the org.

11. **Shutdown chaos test.** Add shutdown chaos tests to the org's chaos engineering program. Regularly simulate SIGTERM in production-equivalent environments.

12. **Incident postmortem sweep.** Identify past incidents caused by bad shutdown. Extract systemic fixes. Publish teaching material.
