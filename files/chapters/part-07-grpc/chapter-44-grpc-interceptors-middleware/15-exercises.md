## Exercises

1. **Structured Logging Interceptor**: Write a server-side unary interceptor that logs every RPC call using `slog` with structured fields: `method`, `duration_ms`, `status_code`, and `peer_addr`. Ensure the interceptor sanitizes any metadata key named `authorization` by replacing its value with `"[REDACTED]"` before logging. Write a test that captures log output and asserts the authorization value is never logged in plaintext.

2. **JWT Authentication Interceptor**: Implement a unary server interceptor that extracts a Bearer JWT from the `authorization` metadata key, validates it using `golang-jwt/jwt`, and injects the parsed claims into the context. Add a stream interceptor that performs the same check for streaming RPCs. Write tests for: valid token (passes), expired token (`codes.Unauthenticated`), missing token (`codes.Unauthenticated`), and tampered signature (`codes.Unauthenticated`).

3. **Rate Limiting Interceptor with Token Bucket**: Implement a server interceptor that applies per-method rate limiting using a token bucket (`golang.org/x/time/rate`). Configure `GetProduct` to allow 100 RPS and `CreateProduct` to allow 10 RPS. Return `codes.ResourceExhausted` when the bucket is exhausted. Write a test that fires 20 rapid `CreateProduct` calls and asserts at least some receive `codes.ResourceExhausted`.

4. **Retry Interceptor with Exponential Backoff**: Build a client-side unary interceptor that retries `codes.Unavailable` and `codes.DeadlineExceeded` errors up to 3 times with exponential backoff (100ms, 200ms, 400ms) and full jitter. Ensure it does NOT retry `codes.InvalidArgument` or `codes.NotFound`. Write a test using a fake server that fails twice then succeeds, asserting the final response is received and exactly 3 total attempts were made.

5. **Prometheus Metrics Interceptor**: Create a server interceptor that records the following Prometheus metrics for every RPC: `grpc_requests_total` (counter, labeled by method and status code) and `grpc_request_duration_seconds` (histogram). Register the metrics with a custom `prometheus.Registry`. Write a test that calls an RPC twice and uses `testutil.GatherAndCompare` to assert the counter value is 2.

6. **OpenTelemetry Tracing Interceptor**: Implement a client interceptor that starts an OpenTelemetry span for each outgoing RPC, injects the trace context into gRPC metadata, and records the span status based on the gRPC response code. On the server side, implement an interceptor that extracts the trace context from incoming metadata and creates a child span. Use the in-memory `sdktrace.NewSimpleSpanProcessor` to capture spans in tests and assert parent-child span relationships are correctly established.

7. **Interceptor Chain Ordering Audit**: Build a gRPC server with five interceptors chained in order: recovery, rate limiter, authentication, authorization (RBAC), and validation. Write a test matrix that triggers a panic, an unauthenticated call, an unauthorized call, an invalid request, and a valid request. Assert that each error is caught at the correct interceptor layer and that the wrong interceptor never handles the error (e.g., validation should never run before authentication succeeds).

### Junior -> FAANG: Exercise Strategy for Maximum Interview Readiness

These seven exercises cover the full spectrum of interceptor concerns. Do not treat them as optional homework. Each one corresponds to a class of interview question or take-home problem that FAANG uses in Go backend roles.

**Priority order if time is limited:** Start with exercises 2 (JWT auth), 4 (retry with backoff), and 7 (chain ordering audit). These three cover the questions interviewers ask most frequently. Exercise 2 tests your ability to work with gRPC metadata and context correctly. Exercise 4 tests your understanding of idempotency and backoff semantics. Exercise 7 tests your ability to reason about correctness constraints in a multi-interceptor system.

**Common mistakes on these exercises:**

For the caching interceptor (the worked solution in 44.10): using `req.String()` as the cache key (not stable), forgetting to clone the proto response before storing it (the stored pointer gets modified by the next response assignment), and failing to handle the case where the cache entry is present but expired (the current code deletes expired entries, but there is a race between the deletion and a concurrent read).

For exercise 3 (rate limiting): using `limiter.Wait()` instead of `limiter.Allow()` in the interceptor (causes request queuing, which is worse than shedding), creating one limiter per method instead of per key-per-method (a single limiter for `GetProduct` regardless of caller makes the limit global rather than per-caller), and forgetting to test the case where the rate limiter returns `false` and asserting the exact `codes.ResourceExhausted` status.

For exercise 5 (Prometheus metrics): registering metrics with `prometheus.DefaultRegisterer` in tests (causes conflicts when tests run in parallel, each test should use a fresh `prometheus.NewRegistry()`), and testing the counter value with a direct struct field access rather than `testutil.GatherAndCompare` (which validates the exposition format, not just the value).

### Senior @ FAANG: Extending the Exercises to Platform-Level Designs

**Exercise 1 extended (distributed caching):** Replace the in-process `sync.Map` with a Redis-backed cache using `go-redis`. Add cache key namespacing by service name to avoid collisions when multiple services share a Redis instance. Add a cache stampede protection using `singleflight` so that when a popular cache entry expires, only one request fetches the new value while concurrent requests wait for it. Benchmark the difference in p99 latency between the in-process and Redis-backed implementations under 1,000 concurrent requests.

**Exercise 4 extended (server-side retry policy):** Implement gRPC's built-in retry policy using service config (JSON configuration passed to `grpc.WithDefaultServiceConfig`) instead of a client interceptor. Compare the two approaches: service config retries happen at the transport level before the response header is received (safe for all operations), while interceptor retries happen at the application level after the transport completes (requires idempotency awareness). Write a test that demonstrates the difference in behavior when the server returns `Unavailable` after sending the response header.

**Exercise 7 extended (platform enforcement):** Extract the chain ordering test into a reusable test helper that accepts a server construction function and a list of expected interceptor names in order. Use reflection on the `grpc.Server` internals (or dependency injection with named interceptors) to verify the actual registered order matches the expected order. This helper should be part of your platform's test library so every team can include it in their server setup tests with three lines of code rather than rewriting the verification logic from scratch.
