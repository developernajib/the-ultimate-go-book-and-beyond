## 44.3 Client Interceptors

### Client Logging Interceptor

Client-side logging interceptors record outgoing RPC calls, their target servers, durations, and status codes. The unary version wraps the `invoker` call with timing, while the streaming version returns a wrapped `ClientStream` that counts sent and received messages. Both log at `Debug` level to avoid flooding production logs with per-call entries.

```go
package interceptor

import (
    "context"
    "log/slog"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// ClientLoggingInterceptor logs client requests
func ClientLoggingInterceptor(logger *slog.Logger) grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        start := time.Now()

        logger.Debug("grpc client request",
            "method", method,
            "target", cc.Target(),
        )

        err := invoker(ctx, method, req, reply, cc, opts...)

        code := codes.OK
        if err != nil {
            if st, ok := status.FromError(err); ok {
                code = st.Code()
            }
        }

        logger.Debug("grpc client response",
            "method", method,
            "duration", time.Since(start),
            "code", code.String(),
        )

        return err
    }
}

// ClientStreamLoggingInterceptor logs streaming client requests
func ClientStreamLoggingInterceptor(logger *slog.Logger) grpc.StreamClientInterceptor {
    return func(
        ctx context.Context,
        desc *grpc.StreamDesc,
        cc *grpc.ClientConn,
        method string,
        streamer grpc.Streamer,
        opts ...grpc.CallOption,
    ) (grpc.ClientStream, error) {
        start := time.Now()

        logger.Debug("grpc client stream started",
            "method", method,
        )

        stream, err := streamer(ctx, desc, cc, method, opts...)
        if err != nil {
            return nil, err
        }

        return &loggingClientStream{
            ClientStream: stream,
            logger:       logger,
            method:       method,
            start:        start,
        }, nil
    }
}

type loggingClientStream struct {
    grpc.ClientStream
    logger    *slog.Logger
    method    string
    start     time.Time
    recvCount int
    sentCount int
}

func (s *loggingClientStream) SendMsg(m any) error {
    err := s.ClientStream.SendMsg(m)
    if err == nil {
        s.sentCount++
    }
    return err
}

func (s *loggingClientStream) RecvMsg(m any) error {
    err := s.ClientStream.RecvMsg(m)
    if err == nil {
        s.recvCount++
    }
    return err
}

func (s *loggingClientStream) CloseSend() error {
    err := s.ClientStream.CloseSend()
    s.logger.Debug("grpc client stream ended",
        "method", s.method,
        "duration", time.Since(s.start),
        "sent", s.sentCount,
        "received", s.recvCount,
    )
    return err
}
```

### Client Retry Interceptor

The retry interceptor re-invokes failed RPCs using exponential backoff with jitter. It only retries status codes that indicate transient failures (`Unavailable`, `ResourceExhausted`, `Aborted`) and respects context cancellation between attempts. The backoff multiplier doubles the delay each time, capped at `MaxBackoff`, and jitter prevents thundering-herd effects when many clients retry simultaneously.

```go
package interceptor

import (
    "context"
    "math/rand"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// RetryConfig holds retry configuration
type RetryConfig struct {
    MaxRetries     int
    InitialBackoff time.Duration
    MaxBackoff     time.Duration
    BackoffMult    float64
    RetryableCodes []codes.Code
}

func DefaultRetryConfig() RetryConfig {
    return RetryConfig{
        MaxRetries:     3,
        InitialBackoff: 100 * time.Millisecond,
        MaxBackoff:     5 * time.Second,
        BackoffMult:    2.0,
        RetryableCodes: []codes.Code{
            codes.Unavailable,
            codes.ResourceExhausted,
            codes.Aborted,
        },
    }
}

// RetryInterceptor retries failed requests
func RetryInterceptor(config RetryConfig) grpc.UnaryClientInterceptor {
    retryableCodes := make(map[codes.Code]bool)
    for _, code := range config.RetryableCodes {
        retryableCodes[code] = true
    }

    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        var lastErr error
        backoff := config.InitialBackoff

        for attempt := 0; attempt <= config.MaxRetries; attempt++ {
            if attempt > 0 {
                // Wait before retry
                select {
                case <-ctx.Done():
                    return ctx.Err()
                case <-time.After(backoff):
                }

                // Calculate next backoff with jitter
                backoff = time.Duration(float64(backoff) * config.BackoffMult)
                if backoff > config.MaxBackoff {
                    backoff = config.MaxBackoff
                }
                // Add jitter (0.8 to 1.2 of backoff)
                jitter := 0.8 + 0.4*rand.Float64()
                backoff = time.Duration(float64(backoff) * jitter)
            }

            err := invoker(ctx, method, req, reply, cc, opts...)
            if err == nil {
                return nil
            }

            lastErr = err

            // Check if error is retryable
            st, ok := status.FromError(err)
            if !ok {
                return err
            }

            if !retryableCodes[st.Code()] {
                return err
            }
        }

        return lastErr
    }
}
```

### Client Metadata Interceptor

gRPC metadata carries per-call key-value pairs outside the message payload, serving the same role as HTTP headers. Outgoing metadata is attached with `metadata.NewOutgoingContext`, and incoming metadata is extracted on the server with `metadata.FromIncomingContext`.

```go
package interceptor

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
)

// MetadataInterceptor adds metadata to outgoing requests
func MetadataInterceptor(pairs ...string) grpc.UnaryClientInterceptor {
    md := metadata.Pairs(pairs...)

    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Merge with existing metadata. Use a per-call variable: reassigning
        // the captured md would accumulate metadata across calls and race when
        // multiple RPCs run concurrently through this interceptor.
        outgoing := md
        if existingMD, ok := metadata.FromOutgoingContext(ctx); ok {
            outgoing = metadata.Join(existingMD, md)
        }

        ctx = metadata.NewOutgoingContext(ctx, outgoing)
        return invoker(ctx, method, req, reply, cc, opts...)
    }
}

// RequestIDInterceptor adds request ID to outgoing requests
func RequestIDInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Check if request ID exists in context
        requestID := GetRequestID(ctx)
        if requestID == "" {
            requestID = generateRequestID()
        }

        ctx = metadata.AppendToOutgoingContext(ctx, "x-request-id", requestID)

        return invoker(ctx, method, req, reply, cc, opts...)
    }
}

// AuthTokenInterceptor adds auth token to outgoing requests
func AuthTokenInterceptor(tokenProvider func() string) grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        token := tokenProvider()
        if token != "" {
            ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
        }

        return invoker(ctx, method, req, reply, cc, opts...)
    }
}
```

### Junior -> FAANG: Client Interceptors and the Discipline of Retry

Client interceptors are often an afterthought for junior engineers. The attitude is: "if the server fails, the caller can retry." The problem with this attitude is that without a shared retry interceptor, every caller implements retry differently. Some use a fixed three-second sleep. Others retry forever. Others never retry. The result is unpredictable system behavior under partial failure.

The most important thing to understand about the retry interceptor is the idempotency constraint. The code in this section checks `retryableCodes` but does not check whether the method is idempotent. In a real system, you must also check the method. `GetUser` is safe to retry. `CreateOrder` is not, because a retry after a server timeout (where the server received and processed the first attempt) creates a duplicate order. Idempotency keys (a UUID generated per logical operation and sent in metadata) solve this for mutations, but require server-side deduplication logic.

For FAANG interviews, be ready to explain the difference between retrying at the gRPC layer vs retrying at the application layer. gRPC's built-in retry policy (configured via service config) retries before the connection is established or when `Unavailable` is returned before the header is sent, meaning the server never processed the request. Client interceptor retries happen after the server may have processed the request. This distinction is critical for non-idempotent operations.

The `RequestIDInterceptor` example teaches an important habit: generate the request ID on the client and propagate it through the call. This means client-side logs, server-side logs, and downstream service logs all share the same request ID, enabling end-to-end request tracing even before OpenTelemetry spans are set up.

### Senior @ FAANG: Client Interceptor Infrastructure for Reliability

**Retry interceptor at platform level:** The retry interceptor above has a correct structure but is missing several production requirements.

First, it does not check whether the context deadline has enough budget for a retry attempt. If the deadline expires in 50ms and the next backoff is 200ms, the `select` on `ctx.Done()` handles this, but the jitter calculation might compute a backoff larger than the remaining budget. A clean implementation compares `time.Until(deadline)` against the next backoff before sleeping.

Second, it does not handle the case where the server returned a response header before failing. gRPC's `Unavailable` status can appear after the response header is sent (for streaming) or before (for connection failure). For unary calls, if the server returned `Unavailable` after sending the header, the server received and potentially processed the request. The interceptor should check `grpc.Header` to determine whether a header was received before deciding to retry.

Third, the jitter calculation `0.8 + 0.4*rand.Float64()` uses `math/rand` which is not cryptographically random but is sufficient for jitter. However, it is also not seeded in the example, which means in Go versions before 1.20 all goroutines in the same process use the same default seed and produce identical jitter, defeating the purpose. Go 1.20+ seeds automatically. In a shared library, document which Go version is the minimum requirement and why.

**Token refresh in `AuthTokenInterceptor`:** The `tokenProvider func() string` pattern is correct but incomplete. Tokens expire. A production implementation needs to handle token expiration transparently: call the invoker, check for `codes.Unauthenticated`, refresh the token, and retry once. This is the token refresh interceptor pattern used by every major gRPC client library. It requires care: the refresh itself must be serialized (one refresh at a time, not one per concurrent request) using a mutex or `singleflight`, and the retry must not loop if the refresh itself returns `Unauthenticated` (which would indicate the service account credentials are revoked, not just that the token expired).

**Metadata propagation and observability:** The `MetadataInterceptor` example merges static metadata with existing outgoing metadata. At platform scale, this is where baggage propagation lives: feature flags, A/B experiment assignments, tenant IDs, and correlation IDs travel in metadata from service to service. The platform should standardize metadata key names (with namespacing like `x-platform-tenant-id`) and provide a typed API for setting and reading these values so individual teams do not hardcode string literals in their interceptors.

---
