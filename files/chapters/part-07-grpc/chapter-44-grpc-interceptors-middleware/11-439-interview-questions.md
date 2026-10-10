## 44.9 Interview Questions

### Question 1: Explain the difference between unary and streaming interceptors and when to use each

**Answer:**

```go
/*
UNARY vs STREAMING INTERCEPTORS

UNARY INTERCEPTORS:
- Handle single request/response RPCs
- Full access to request and response
- Can modify, log, or reject requests
- Simpler to implement

STREAMING INTERCEPTORS:
- Handle streaming RPCs (client, server, or bidirectional)
- Access stream object, not individual messages
- Must wrap stream to intercept messages
- More complex, need to handle stream lifecycle

KEY DIFFERENCES:

1. Request/Response Access:
   - Unary: Direct access to req and resp
   - Stream: Must override RecvMsg/SendMsg

2. Context Modification:
   - Unary: Modify ctx before calling handler
   - Stream: Must wrap stream and override Context()

3. Error Handling:
   - Unary: Return error directly
   - Stream: Error returned from handler or stream methods

4. Metrics Collection:
   - Unary: Easy - one request, one response
   - Stream: Must count messages via wrapped stream
*/

// Unary: Simple before/after pattern
func UnaryExample() grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any,
        info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {

        // BEFORE: Full access to request
        log.Printf("Request: %v", req)

        resp, err := handler(ctx, req)

        // AFTER: Full access to response
        log.Printf("Response: %v, Error: %v", resp, err)

        return resp, err
    }
}

// Streaming: Must wrap stream for message access
func StreamExample() grpc.StreamServerInterceptor {
    return func(srv any, ss grpc.ServerStream,
        info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {

        wrapped := &instrumentedStream{
            ServerStream: ss,
            method:       info.FullMethod,
        }

        err := handler(srv, wrapped)

        log.Printf("Stream ended: sent=%d, recv=%d, err=%v",
            wrapped.sent, wrapped.recv, err)

        return err
    }
}

type instrumentedStream struct {
    grpc.ServerStream
    method string
    sent   int
    recv   int
}

func (s *instrumentedStream) RecvMsg(m any) error {
    err := s.ServerStream.RecvMsg(m)
    if err == nil {
        s.recv++
        log.Printf("[%s] Received message %d", s.method, s.recv)
    }
    return err
}

func (s *instrumentedStream) SendMsg(m any) error {
    err := s.ServerStream.SendMsg(m)
    if err == nil {
        s.sent++
        log.Printf("[%s] Sent message %d", s.method, s.sent)
    }
    return err
}
```

### Question 2: How would you implement a timeout interceptor that allows per-method configuration?

**Answer:**

```go
/*
PER-METHOD TIMEOUT INTERCEPTOR

Requirements:
1. Allow different timeouts per method
2. Support default timeout for unconfigured methods
3. Respect existing deadlines (don't extend them)
4. Add timeout headers for client visibility
*/

// TimeoutConfig holds per-method timeout configuration
type TimeoutConfig struct {
    Default  time.Duration
    Methods  map[string]time.Duration
    // Optional: categories for groups of methods
    Prefixes map[string]time.Duration // e.g., "/admin." -> 60s
}

func TimeoutInterceptor(config TimeoutConfig) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Determine timeout for this method
        timeout := config.Default

        // Check exact method match
        if t, ok := config.Methods[info.FullMethod]; ok {
            timeout = t
        } else {
            // Check prefix matches
            for prefix, t := range config.Prefixes {
                if strings.HasPrefix(info.FullMethod, prefix) {
                    timeout = t
                    break
                }
            }
        }

        // Check if context already has a shorter deadline
        if deadline, ok := ctx.Deadline(); ok {
            existing := time.Until(deadline)
            if existing < timeout {
                // Existing deadline is shorter, use it
                timeout = existing
            }
        }

        // Create context with timeout
        ctx, cancel := context.WithTimeout(ctx, timeout)
        defer cancel()

        // Track if we hit the timeout
        done := make(chan struct{})
        var resp any
        var err error

        go func() {
            resp, err = handler(ctx, req)
            close(done)
        }()

        select {
        case <-done:
            return resp, err
        case <-ctx.Done():
            if ctx.Err() == context.DeadlineExceeded {
                return nil, status.Errorf(codes.DeadlineExceeded,
                    "request timeout after %v", timeout)
            }
            return nil, status.FromContextError(ctx.Err()).Err()
        }
    }
}

// Example configuration
func ExampleTimeoutConfig() TimeoutConfig {
    return TimeoutConfig{
        Default: 30 * time.Second,
        Methods: map[string]time.Duration{
            "/user.v1.UserService/CreateUser":  10 * time.Second,  // Fast
            "/report.v1.ReportService/Generate": 5 * time.Minute,  // Slow
        },
        Prefixes: map[string]time.Duration{
            "/admin.":  60 * time.Second, // Admin operations
            "/health.": 5 * time.Second,  // Health checks
        },
    }
}
```

### Question 3: How do you propagate trace context across gRPC calls?

**Answer:**

```go
/*
TRACE CONTEXT PROPAGATION

Components:
1. Server: Extract trace from incoming metadata
2. Client: Inject trace into outgoing metadata
3. Both: Use OpenTelemetry propagator

Key concepts:
- TraceID: Unique identifier for entire request flow
- SpanID: Identifier for individual operation
- TraceFlags: Sampling decisions
- TraceState: Vendor-specific data
*/

// Server interceptor: Extract trace context
func TracingServerInterceptor(tracer trace.Tracer) grpc.UnaryServerInterceptor {
    propagator := otel.GetTextMapPropagator()

    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Extract trace context from incoming metadata
        md, _ := metadata.FromIncomingContext(ctx)
        ctx = propagator.Extract(ctx, metadataCarrier(md))

        // Start server span as child of extracted context
        ctx, span := tracer.Start(ctx, info.FullMethod,
            trace.WithSpanKind(trace.SpanKindServer),
        )
        defer span.End()

        // Add attributes
        span.SetAttributes(
            attribute.String("rpc.system", "grpc"),
            attribute.String("rpc.method", info.FullMethod),
        )

        resp, err := handler(ctx, req)

        if err != nil {
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
        }

        return resp, err
    }
}

// Client interceptor: Inject trace context
func TracingClientInterceptor(tracer trace.Tracer) grpc.UnaryClientInterceptor {
    propagator := otel.GetTextMapPropagator()

    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Start client span
        ctx, span := tracer.Start(ctx, method,
            trace.WithSpanKind(trace.SpanKindClient),
        )
        defer span.End()

        // Inject trace context into outgoing metadata
        md, _ := metadata.FromOutgoingContext(ctx)
        if md == nil {
            md = metadata.MD{}
        }
        propagator.Inject(ctx, metadataCarrier(md))
        ctx = metadata.NewOutgoingContext(ctx, md)

        err := invoker(ctx, method, req, reply, cc, opts...)

        if err != nil {
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
        }

        return err
    }
}

// metadataCarrier adapts gRPC metadata for OpenTelemetry
type metadataCarrier metadata.MD

func (m metadataCarrier) Get(key string) string {
    values := metadata.MD(m).Get(key)
    if len(values) > 0 {
        return values[0]
    }
    return ""
}

func (m metadataCarrier) Set(key, value string) {
    metadata.MD(m).Set(key, value)
}

func (m metadataCarrier) Keys() []string {
    keys := make([]string, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    return keys
}

// Full tracing setup using OTLP (the Jaeger native exporter was retired - // export over OTLP to an OpenTelemetry Collector, which fans out to Jaeger,
// Tempo, Datadog, etc.)
func SetupTracing(ctx context.Context, serviceName string) (trace.Tracer, error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint("otel-collector:4317"),
        otlptracegrpc.WithInsecure(), // use TLS in production
    )
    if err != nil {
        return nil, err
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(serviceName),
        )),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp.Tracer(serviceName), nil
}
```

---

### What FAANG expects and follow-ups

**Q1 (Unary vs streaming interceptors):**
- *What FAANG expects:* Candidates must articulate that stream interceptors cannot observe individual messages without wrapping `ServerStream`/`ClientStream` and overriding `RecvMsg`/`SendMsg`, and that context modification on a stream requires wrapping `Context()` because the stream's context is created once at stream setup. Bonus points for mentioning that `stats.Handler` is often a cleaner observability path for streams than interceptors.
- *Follow-ups:*
  1. How would you propagate a mutated context (e.g., after auth injects a user) into a bidi stream, and why does a naive `context.WithValue` in a stream interceptor fail?
  2. How do you ensure the wrapped stream survives interceptor chaining - i.e., that metrics and logging both see the same wrapped stream?
  3. When a client cancels a long-lived server stream, which interceptor code paths run, and where do you observe the cancellation?

**Q2 (Per-method timeout interceptor):**
- *What FAANG expects:* Correctness on deadline semantics - never *extend* an existing deadline, always take the minimum of (config, inherited). The candidate should also flag that spawning a goroutine and racing against `ctx.Done()` does not actually cancel the handler goroutine - the handler still runs to completion in the background and may leak. A correct answer relies on the handler respecting the ctx it was given.
- *Follow-ups:*
  1. Why is launching `go func() { resp, err = handler(...) }()` and selecting on `ctx.Done()` a common anti-pattern? How would you fix the goroutine leak?
  2. How do you propagate the chosen timeout to the client (hint: `grpc-timeout` header)?
  3. A slow downstream dependency is making your p99 spike. Would you set the timeout in the gRPC interceptor, in the HTTP client calling the downstream, or both - and why?

**Q3 (Trace context propagation):**
- *What FAANG expects:* Clear separation between server (extract then start span as `SpanKindServer`) and client (start span as `SpanKindClient` then inject). Awareness that `otelgrpc` now uses `stats.Handler` rather than interceptors, and that the W3C Trace Context propagator is the default in 2026 (B3 is legacy-Zipkin). Mention of sampling decisions being propagated via `TraceFlags`.
- *Follow-ups:*
  1. If one service in the chain is not instrumented, what does the span tree look like and how do you detect the gap?
  2. How does head-based sampling differ from tail-based sampling, and which one needs the collector?
  3. A trace is missing spans from the database driver. Walk through how you would diagnose whether it is a propagation issue, an instrumentation gap, or a sampling issue.

### Junior -> FAANG: Preparing for These Exact Questions

The three questions in this section are representative of real FAANG screening and onsite rounds for Go backend engineering roles. Here is how to prepare for each.

**Question 1 (unary vs streaming):** The answer the interviewer wants has two parts: the conceptual difference (unary interceptors receive request and response, streaming interceptors receive a stream object and must wrap it to intercept messages) and the practical implication (context modification on a stream requires a wrapped stream with an overridden `Context()` method). Be able to write the `wrappedServerStream` struct from memory. If you can draw it on a whiteboard and explain why each method is overridden, you will pass this question.

**Question 2 (per-method timeout):** The critical subtlety is in the follow-up: why is launching a goroutine and racing against `ctx.Done()` an anti-pattern? The answer is that the goroutine is not canceled when the interceptor returns. It continues running the handler even after you have already returned a deadline exceeded error to the caller. For long-running handlers, this is a goroutine leak. The correct approach relies on the handler respecting the context it was given: `context.WithTimeout` on the context cancels all blocking operations inside the handler (database calls, downstream RPCs) automatically.

**Question 3 (trace context propagation):** Practice drawing the W3C `traceparent` header format: `00-{traceId}-{parentId}-{traceFlags}`. Be able to explain that the client interceptor writes this header into gRPC metadata, and the server interceptor reads it and calls `propagator.Extract()` to reconstruct the parent span context. Knowing that B3 (used by older Zipkin deployments) is legacy and W3C Trace Context is the current standard shows awareness of the ecosystem.

For all three questions, the FAANG interviewer is not looking for perfect syntax. They are looking for whether you understand the underlying mechanics well enough to reason about edge cases and failure modes.

### Senior @ FAANG: Bar-Raiser Signals Beyond the Answers

The "What FAANG expects" and follow-up sections after each question define the bar-raiser level. Here is what distinguishes an L5 answer from an L6/L7 answer for each question.

**Q1 follow-ups at L6/L7 level:**

For "how do you ensure the wrapped stream survives interceptor chaining?", the L5 answer describes the pattern. The L6/L7 answer identifies the problem: if interceptor A wraps the stream into `wrappedStreamA` and interceptor B also wraps the stream, B's wrapper wraps `wrappedStreamA`. Both `Context()` implementations are in the chain. `grpc.ChainStreamInterceptor` builds the chain so that B receives the stream as wrapped by A. This is correct behavior, and the candidate should confirm it by tracing through the chain implementation, not just asserting it. The L6/L7 candidate also mentions that this is a source of bugs in hand-written chain implementations that try to unwrap streams.

For "when a client cancels a long-lived server stream, which interceptor code paths run?", the L5 answer says "the handler returns an error, then the stream interceptors return." The L6/L7 answer explains: client cancellation sends a RST_STREAM frame. The server's gRPC transport marks the stream context as canceled. The handler's next `RecvMsg` or `SendMsg` returns an error with `codes.Canceled`. The handler returns this error to the stream interceptor chain. Each interceptor in the chain sees the error via its `err = handler(srv, wrapped)` return. The recovery interceptor specifically checks for `codes.Canceled` before deciding whether to log (cancellation is not a bug, it is normal operation and should not page on-call).

**Q2 follow-ups at L6/L7 level:**

For "how do you propagate the chosen timeout to the client?", the grpc-go framework sends the timeout in the `grpc-timeout` header automatically when you use `context.WithTimeout`. The server reads it. The L6/L7 candidate knows this is transparent and does not require manual header manipulation. The harder question is: should you echo the applied timeout back to the caller in response metadata so they can adjust their deadline for future calls? The answer requires weighing observability benefit against metadata overhead and the risk of clients using the echoed timeout as a configuration oracle rather than setting their own.

**Q3 follow-ups at L6/L7 level:**

For "a trace is missing spans from the database driver", the L6/L7 diagnostic approach is systematic: first verify that the database client library is instrumented (check the library docs or repo for OTel support). Second, check that the context carrying the span is passed to the database call (the most common gap). Third, check the sampler configuration (if the span is being created but not exported, sampling might be dropping it) - fourth, check the collector pipeline (spans might be created and sampled but dropped at the collector due to buffer overflow). This four-step diagnosis in the correct order demonstrates the candidate has debugged real tracing gaps, not just described the theory.

---
