## 44.8 Common Mistakes

### Mistake 1: Not Wrapping Stream Context for Authentication

A stream interceptor cannot modify `ServerStream.Context()` directly, because the context is set at stream creation and is immutable. To attach authenticated user claims so stream handler code can read them, the interceptor must wrap the `ServerStream` in a custom struct that overrides `Context()` to return the enriched context.

```go
// WRONG: Context modification doesn't propagate to stream handlers
func AuthStreamInterceptor(validator TokenValidator) grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        ctx := ss.Context()

        // Validate and get user
        user, err := validateToken(ctx, validator)
        if err != nil {
            return err
        }

        // WRONG: This doesn't affect the stream's context!
        ctx = context.WithValue(ctx, userKey, user)

        // Handler still sees original context without user
        return handler(srv, ss)
    }
}

// CORRECT: Wrap stream to provide modified context
func AuthStreamInterceptor(validator TokenValidator) grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        ctx := ss.Context()

        user, err := validateToken(ctx, validator)
        if err != nil {
            return err
        }

        ctx = context.WithValue(ctx, userKey, user)

        // Wrap stream to provide modified context
        wrapped := &wrappedServerStream{
            ServerStream: ss,
            ctx:          ctx,
        }

        return handler(srv, wrapped)
    }
}

type wrappedServerStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (w *wrappedServerStream) Context() context.Context {
    return w.ctx
}
```

### Mistake 2: Incorrect Interceptor Order

The order in which you pass interceptors to `ChainUnaryInterceptor` determines which one runs first. Getting this wrong creates subtle bugs: if recovery runs after auth, a panic in the auth interceptor crashes the server. If metrics runs after auth, authentication failures are invisible to your dashboards. The correct order is recovery (outermost) through validation (innermost).

```go
// WRONG: Auth before recovery means panics in auth aren't caught
server := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        AuthInterceptor(config),     // 1. If this panics...
        RecoveryInterceptor(logger), // 2. ...this never catches it!
        LoggingInterceptor(logger),
    ),
)

// WRONG: Metrics after auth means auth failures aren't measured
server := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        AuthInterceptor(config),     // Auth failures return early...
        MetricsInterceptor(metrics), // ...and skip metrics!
    ),
)

// CORRECT: Proper order for production
server := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        RecoveryInterceptor(logger),     // 1. Catch ALL panics
        TracingInterceptor(),            // 2. Start tracing early
        MetricsInterceptor(metrics),     // 3. Measure everything
        LoggingInterceptor(logger),      // 4. Log all requests
        AuthInterceptor(config),         // 5. Authenticate
        RateLimitInterceptor(limiter),   // 6. Rate limit (per-user)
        ValidationInterceptor(),         // 7. Validate before handler
    ),
)
```

### Mistake 3: Retry Without Idempotency Check

Blindly retrying all failed RPCs will duplicate non-idempotent operations like `CreateOrder` or `ChargeCard`, causing double-charges or duplicate records. The retry interceptor must check the gRPC method path or a per-call option against an allowlist of idempotent methods before issuing a retry.

```go
// WRONG: Retrying non-idempotent operations
func UnsafeRetryInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        for attempt := 0; attempt < 3; attempt++ {
            err := invoker(ctx, method, req, reply, cc, opts...)
            if err == nil {
                return nil
            }

            // WRONG: Retrying CreateOrder could create duplicate orders!
            if isRetryable(err) {
                continue
            }
            return err
        }
        return errors.New("max retries exceeded")
    }
}

// CORRECT: Only retry idempotent operations
func SafeRetryInterceptor(idempotentMethods map[string]bool) grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // First attempt always happens
        err := invoker(ctx, method, req, reply, cc, opts...)
        if err == nil {
            return nil
        }

        // Only retry if method is idempotent
        if !idempotentMethods[method] {
            return err
        }

        // Only retry certain error codes
        if !isRetryable(err) {
            return err
        }

        // Retry with backoff
        for attempt := 1; attempt < 3; attempt++ {
            time.Sleep(time.Duration(attempt*100) * time.Millisecond)

            if ctx.Err() != nil {
                return ctx.Err()
            }

            err = invoker(ctx, method, req, reply, cc, opts...)
            if err == nil || !isRetryable(err) {
                break
            }
        }

        return err
    }
}

// Define which methods are safe to retry
var idempotentMethods = map[string]bool{
    "/user.v1.UserService/GetUser":    true,
    "/user.v1.UserService/ListUsers":  true,
    "/user.v1.UserService/DeleteUser": true, // Usually idempotent
    // CreateUser, UpdateUser - NOT idempotent without idempotency key
}
```

### Mistake 4: Blocking Interceptors Without Timeout

An interceptor that calls an external service (like a remote auth server) without its own timeout inherits the caller's deadline, or worse, blocks indefinitely if none is set. Every external call inside an interceptor needs a separate `context.WithTimeout` so a slow dependency does not stall all incoming requests.

```go
// WRONG: External call without timeout blocks forever
func SlowInterceptor(authService AuthClient) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // WRONG: If authService is slow, every request hangs
        _, err := authService.ValidateToken(ctx, getToken(ctx))
        if err != nil {
            return nil, status.Error(codes.Unauthenticated, "invalid token")
        }

        return handler(ctx, req)
    }
}

// CORRECT: Always set timeout for external calls
func SafeAuthInterceptor(authService AuthClient, timeout time.Duration) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Create separate context with timeout for auth call
        authCtx, cancel := context.WithTimeout(ctx, timeout)
        defer cancel()

        _, err := authService.ValidateToken(authCtx, getToken(ctx))
        if err != nil {
            if errors.Is(err, context.DeadlineExceeded) {
                // Log slow auth service
                return nil, status.Error(codes.Unavailable,
                    "authentication service timeout")
            }
            return nil, status.Error(codes.Unauthenticated, "invalid token")
        }

        return handler(ctx, req)
    }
}
```

### Mistake 5: Not Handling Streaming Interceptor Cleanup

Streaming interceptors often spawn background goroutines for heartbeats, periodic metric flushes, or progress tracking. If those goroutines are not tied to the stream's context, they leak when the stream ends abnormally (client disconnect, deadline exceeded). Always derive a cancellable context and call `cancel()` in a `defer` so background work stops when the handler returns.

```go
// WRONG: Resource leak in streaming interceptor
func LeakyStreamInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        // Start some background work
        done := make(chan struct{})
        go func() {
            ticker := time.NewTicker(time.Second)
            // WRONG: Never stops if stream ends abnormally!
            for range ticker.C {
                // Send heartbeat or collect metrics
            }
        }()

        return handler(srv, ss)
    }
}

// CORRECT: Always cleanup resources
func SafeStreamInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        ctx := ss.Context()

        // Create cancellable context for cleanup
        ctx, cancel := context.WithCancel(ctx)
        defer cancel() // Ensures goroutine stops

        done := make(chan struct{})
        go func() {
            defer close(done)
            ticker := time.NewTicker(time.Second)
            defer ticker.Stop()

            for {
                select {
                case <-ctx.Done():
                    return // Clean exit
                case <-ticker.C:
                    // Send heartbeat or collect metrics
                }
            }
        }()

        err := handler(srv, &wrappedServerStream{
            ServerStream: ss,
            ctx:          ctx,
        })

        // Wait for goroutine to finish
        cancel()
        <-done

        return err
    }
}
```

### Junior -> FAANG: Common Mistakes as Interview Topics

Each mistake in this section is a real incident that has occurred in production systems. Interviewers at FAANG use these exact scenarios because they reveal whether a candidate has production experience or has only worked with toy systems.

**Mistake 1 (stream context):** The wrong version compiles and passes unit tests if the test does not verify that the user is actually in the handler's context. This is why the mistake persists: it is invisible until an integration test or production request reveals that the handler receives a nil user. For interview preparation, be able to explain from memory why wrapping the stream is necessary and draw the correct struct embedding.

**Mistake 2 (interceptor order):** The correct-order mnemonic (recovery outermost, validation innermost) is the answer to the most common interceptor ordering interview question. But also be prepared for the follow-up: "You cannot change the registration order. How do you protect metrics from missing auth failures?" The answer is that you cannot fully solve it without changing the order, which demonstrates the candidate understands that ordering is a correctness requirement, not a style preference.

**Mistake 3 (retry idempotency):** This mistake has caused real financial losses: retried payment calls that resulted in double charges. The correct answer for interview involves three components: a safelist of idempotent methods, a retryable status code list, and an idempotency key mechanism for mutations that need at-most-once delivery guarantees.

**Mistake 4 (blocking without timeout):** The correct fix (a separate `context.WithTimeout` for the auth call) also introduces a subtlety: if the auth call times out, should you return `codes.Unavailable` or `codes.Unauthenticated`? The section returns `codes.Unavailable`, which tells the client "the auth service is slow, try again later." Returning `codes.Unauthenticated` would be incorrect because it implies the token is invalid. This distinction matters for client retry logic.

**Mistake 5 (goroutine leak):** Any goroutine that does not respect context cancellation is a goroutine leak waiting to happen. The pattern of `ctx, cancel := context.WithCancel(ctx); defer cancel()` followed by `select { case <-ctx.Done(): }` inside goroutines is the standard Go idiom for leak-free background work. Practice it until it is automatic.

### Senior @ FAANG: Systematizing Mistake Prevention

**Code review checklist for interceptors:** The mistakes in this section should become checklist items in your team's code review template for any new interceptor.

1. Does the interceptor implement both unary and streaming variants?
2. If the streaming variant modifies context, does it wrap the stream and override `Context()`?
3. Is the interceptor position in the chain documented and verified by a test?
4. Does any retry logic check method idempotency before retrying?
5. Does any external I/O in the interceptor have a timeout independent of the request deadline?
6. Does any goroutine spawned by the interceptor listen to a context for cancellation?

This checklist catches the five mistakes in this section before they reach production. At L6/L7, creating this kind of checklist and getting it adopted by the broader team is a concrete staff-level impact.

**Static analysis for goroutine leaks:** The mistake 5 pattern (goroutines that do not listen to context) is detectable by static analysis. The `goleak` package catches goroutine leaks in tests when used with `defer goleak.VerifyNone(t)`. `staticcheck` and `go vet` catch some common goroutine leak patterns. A platform-level CI requirement that every interceptor test runs with `goleak` catches this class of bug before it reaches production.

**Mistake recurrence and postmortems:** Each of these mistakes has likely occurred in your organization more than once. The correct staff-level response to a repeated incident is not to fix the specific instance but to prevent recurrence. For the "unary-only auth" mistake (which the pitfalls section covers in detail), the recurrence prevention is a test in the platform scaffolding that asserts every service with a unary auth interceptor also has a stream auth interceptor. This test runs in CI. If a team removes the stream interceptor accidentally during a refactor, CI fails. This is "paving the path to success" rather than relying on engineers to remember the requirement.

**The cost of correctness:** Each correct pattern in this section adds code complexity. The wrapped stream adds a type. The idempotency check adds a map lookup. The timeout adds a `context.WithTimeout`. Senior engineers must communicate to junior engineers that this complexity is not gold-plating: each piece prevents a specific class of production incident, and the cost of that incident (customer data exposure, financial loss, SLA breach) far exceeds the cost of the additional code.

---
