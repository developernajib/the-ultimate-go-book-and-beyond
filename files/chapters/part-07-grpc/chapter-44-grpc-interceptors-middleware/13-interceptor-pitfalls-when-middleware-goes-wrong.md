## Interceptor Pitfalls: When Middleware Goes Wrong

### The Interceptor Order of Doom

**The Incident**: A team added interceptors for logging, recovery, and auth. They ordered them as: logging → auth → recovery. When an unauthenticated request caused a panic in the auth interceptor, the recovery interceptor never caught it (it ran before auth). The server crashed. Worse, the logging interceptor had already logged the request, exposing auth tokens in crash logs that were visible to the whole team.

```go
// WRONG: Interceptor order that causes cascading failures
server := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        loggingInterceptor,   // Logs BEFORE auth - may log sensitive data
        authInterceptor,       // Panics aren't recovered!
        recoveryInterceptor,   // Too late to catch auth panics
    ),
)

// CORRECT: Recovery first, logging last (after sanitization)
server := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        recoveryInterceptor,   // 1. Catch all panics first
        requestIDInterceptor,  // 2. Add request ID for tracing
        authInterceptor,       // 3. Auth - safe to panic now
        rateLimitInterceptor,  // 4. Rate limit authenticated users
        validationInterceptor, // 5. Validate request
        loggingInterceptor,    // 6. Log LAST - all sensitive data should be stripped
    ),
)

// Recovery interceptor should be first
func recoveryInterceptor(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
    defer func() {
        if r := recover(); r != nil {
            // Log the panic with stack trace
            log.Error("panic recovered in gRPC handler",
                "method", info.FullMethod,
                "panic", r,
                "stack", string(debug.Stack()))

            // Increment panic metric
            panicCounter.WithLabelValues(info.FullMethod).Inc()

            // Return internal error (don't expose panic details)
            err = status.Error(codes.Internal, "internal server error")
        }
    }()
    return handler(ctx, req)
}

// Logging interceptor should sanitize sensitive fields
func loggingInterceptor(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
    start := time.Now()

    // Sanitize request before logging
    sanitizedReq := sanitizeForLogging(req)

    resp, err := handler(ctx, req)

    duration := time.Since(start)

    // Sanitize response before logging
    sanitizedResp := sanitizeForLogging(resp)

    log.Info("grpc request",
        "method", info.FullMethod,
        "duration_ms", duration.Milliseconds(),
        "request", sanitizedReq,
        "response", sanitizedResp,
        "error", err)

    return resp, err
}

func sanitizeForLogging(msg any) any {
    // Use proto reflection to redact sensitive fields
    if m, ok := msg.(proto.Message); ok {
        return redactSensitiveFields(m)
    }
    return "[non-proto message]"
}
```

### The Context Value Loss

**The Incident**: An auth interceptor validated JWT tokens and stored user info in context. A tracing interceptor created a new context with tracing spans. The tracing interceptor replaced the context instead of deriving from it, losing the user info. All downstream handlers saw nil users. Authorization checks failed silently, and some requests leaked through because "nil user" was treated as "anonymous allowed."

```go
// WRONG: Creating new context loses values from previous interceptors
func tracingInterceptorBad(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
    // This loses ALL context values from previous interceptors!
    newCtx := context.Background()
    span := tracer.StartSpan(newCtx, info.FullMethod)
    defer span.End()

    return handler(span.Context(), req) // User info from auth interceptor is GONE
}

// CORRECT: Always derive from incoming context
func tracingInterceptor(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
    // Derive from incoming context - preserves all values
    ctx, span := tracer.Start(ctx, info.FullMethod)
    defer span.End()

    // Add span context, keeping existing values
    return handler(ctx, req) // User info is preserved
}

// Also verify context values in downstream handlers
func (s *Server) GetUserProfile(ctx context.Context, req *pb.GetUserProfileRequest) (*pb.UserProfile, error) {
    user := auth.UserFromContext(ctx)
    if user == nil {
        // Don't silently proceed - this indicates an interceptor bug!
        log.Error("user missing from context - interceptor chain broken?",
            "method", "GetUserProfile")
        return nil, status.Error(codes.Internal, "authentication context missing")
    }

    // ...
}

// Test that interceptor chain preserves context
func TestInterceptorChainPreservesContext(t *testing.T) {
    // Setup chain
    chain := grpc.ChainUnaryInterceptor(
        authInterceptor,
        tracingInterceptor,
        loggingInterceptor,
    )

    // Create server with chain
    server := grpc.NewServer(chain)

    // Make request with valid token
    ctx := metadata.NewIncomingContext(context.Background(),
        metadata.Pairs("authorization", "Bearer valid-token"))

    // Verify user is available in final handler
    var capturedCtx context.Context
    handler := func(ctx context.Context, req any) (any, error) {
        capturedCtx = ctx
        return nil, nil
    }

    // Run through chain
    chain(ctx, nil, &grpc.UnaryServerInfo{FullMethod: "/test"}, handler)

    // Assert user is in context
    user := auth.UserFromContext(capturedCtx)
    assert.NotNil(t, user, "user should be in context after interceptor chain")
}
```

### The Streaming Interceptor Wrapper Miss

**The Incident**: A team wrote a unary interceptor for auth. They forgot that streaming RPCs bypass unary interceptors. All unary endpoints were protected, but all streaming endpoints were completely open. An attacker discovered this and exfiltrated data through an unprotected streaming endpoint for 3 months before anyone noticed.

```go
// WRONG: Only unary interceptor, streams are unprotected
server := grpc.NewServer(
    grpc.UnaryInterceptor(authInterceptor),
    // Missing: grpc.StreamInterceptor(...)!
)

// CORRECT: Protect both unary and streaming
server := grpc.NewServer(
    grpc.ChainUnaryInterceptor(authInterceptor),
    grpc.ChainStreamInterceptor(streamAuthInterceptor),
)

// Stream interceptor needs to wrap the ServerStream
func streamAuthInterceptor(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
    ctx := ss.Context()

    // Validate auth (same logic as unary)
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return status.Error(codes.Unauthenticated, "missing metadata")
    }

    token := extractToken(md)
    user, err := validateToken(token)
    if err != nil {
        return status.Error(codes.Unauthenticated, "invalid token")
    }

    // Wrap stream with authenticated context
    wrappedStream := &authenticatedStream{
        ServerStream: ss,
        ctx:          context.WithValue(ctx, userKey, user),
    }

    return handler(srv, wrappedStream)
}

type authenticatedStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (s *authenticatedStream) Context() context.Context {
    return s.ctx
}

// Test that streaming endpoints are protected
func TestStreamingEndpointsRequireAuth(t *testing.T) {
    conn := setupTestConnection(t)

    // Try to call streaming endpoint without auth
    client := pb.NewAnalyticsClient(conn)
    stream, err := client.StreamMetrics(context.Background(), &pb.MetricsRequest{})

    if err == nil {
        _, err = stream.Recv()
    }

    // Should get unauthenticated error
    assert.Equal(t, codes.Unauthenticated, status.Code(err),
        "streaming endpoints should require authentication")
}
```

### Quick Reference: Interceptor Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Wrong interceptor order | Panics crash server, data leaks | Recovery first, logging last |
| Context replacement | Lost auth info, nil users | Always derive from incoming ctx |
| Unary-only auth | Streaming endpoints exposed | Add stream interceptors |
| Logging sensitive data | Credentials in logs | Sanitize before logging |
| Missing timeout | Requests hang forever | Add deadline interceptor |
| Error wrapping | Lost error details | Preserve original error codes |
| Blocking in interceptor | Slowdown, deadlocks | Use goroutines with care |
| Missing metrics | No visibility | Add prometheus interceptor |

### Junior -> FAANG: Incidents as Learning Accelerators

Each incident story in this section compresses months or years of production experience into a few paragraphs. Take them seriously.

**The Interceptor Order of Doom:** The ordering bug (logging before auth exposing tokens in logs, then recovery not catching auth panics) is a compound failure where two individually reasonable-looking decisions interact badly. The lesson is not "always put recovery first" in isolation but rather "the ordering of interceptors has correctness implications that you must analyze, not just convention implications." When you write a new interceptor, ask: what happens if an interceptor above me panics? What does an interceptor below me need me to have done first?

**The Context Value Loss:** Creating a new `context.Background()` in a tracing interceptor instead of deriving from the incoming context is a mistake that reveals a misunderstanding of Go's context model. The context is a chain of values: each `context.With*` call wraps the parent, adding one value or deadline. If you start from `context.Background()`, you discard every value added by every interceptor above you in the chain. The correct pattern is always: receive `ctx`, derive a new context from it with `context.With*`, pass the derived context forward.

**The Streaming Interceptor Wrapper Miss:** The fact that unary and streaming interceptors are registered separately and independently is the root cause of this security incident. A developer who wrote unary auth and assumed "interceptors apply to all RPCs" would never discover the gap through code review if the reviewer also assumed the same. The fix is a platform-level test that asserts: for every service, the number of registered stream interceptors equals the number of registered unary interceptors for security-critical concerns (auth, recovery). This test makes the oversight a CI failure rather than a three-month security gap.

### Senior @ FAANG: Converting Incidents into Systemic Fixes

**Postmortem to platform improvement pipeline:** Each incident in this section should trigger not just a fix but a systemic improvement. The table at the end of the section is a good starting point. For a staff engineer, the question after each incident is: "What process, tool, or platform change would have prevented this from being merged in the first place?"

For the interceptor order incident: the process fix is a code review checklist item. The tool fix is a test that verifies chain order. The platform fix is a server factory that enforces order without requiring teams to specify it.

For the context value loss: the process fix is a code review checklist item ("does any interceptor create a new root context?"). The tool fix is a static analysis rule that detects `context.Background()` inside interceptor functions. The platform fix is a lint rule enforced in CI that rejects interceptors that do not derive from the incoming context.

For the streaming wrapper miss: the process fix is explicit documentation that "every unary interceptor must have a streaming counterpart." The tool fix is the platform test described above. The platform fix is a scaffold that generates stub streaming interceptors alongside every unary interceptor so forgetting is structurally impossible.

**The compound failure pattern:** The "Order of Doom" incident is a compound failure (two individually correct decisions that interact badly). Compound failures are the hardest to prevent with process because each individual change looks safe in isolation. The defense is integration testing: a test that runs the full interceptor chain with a malformed request (one that would cause a panic in auth) and asserts that the recovery interceptor catches it. If recovery is in the wrong position, this test fails and the bug is caught before it reaches production.

**Security review for interceptor changes:** Any change that modifies the interceptor chain (adding, removing, or reordering interceptors) should go through a security review, not just a code review. The security reviewer checks: are all security-critical interceptors still present? Is the ordering still correct? Are there any new bypass conditions that could expose protected endpoints? This review should be a required approval gate in your CI pipeline for changes to the server setup file, and the gate should be implemented via code ownership (a security team must approve any change to files in the `cmd/server` or `internal/interceptors` directories).

---
