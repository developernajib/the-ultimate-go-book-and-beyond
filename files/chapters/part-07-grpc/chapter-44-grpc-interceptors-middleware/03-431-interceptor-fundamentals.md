## 44.1 Interceptor Fundamentals

### Interceptor Types

Interceptors and middleware provide a clean mechanism for applying cross-cutting concerns (logging, authentication, metrics) across all operations without modifying individual handlers. They receive the full request context and can short-circuit the chain by returning an error.

```go
package main

import (
    "context"

    "google.golang.org/grpc"
)

/*
gRPC Interceptor Types:

1. Unary Server Interceptor
   - Intercepts unary (single request/response) RPCs on server
   - func(ctx, req, info, handler) (resp, error)

2. Stream Server Interceptor
   - Intercepts streaming RPCs on server
   - func(srv, stream, info, handler) error

3. Unary Client Interceptor
   - Intercepts unary RPCs on client
   - func(ctx, method, req, reply, cc, invoker, opts) error

4. Stream Client Interceptor
   - Intercepts streaming RPCs on client
   - func(ctx, desc, cc, method, streamer, opts) (stream, error)
*/

// UnaryServerInterceptor signature
type UnaryServerInterceptor func(
    ctx context.Context,
    req any,
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (any, error)

// StreamServerInterceptor signature
type StreamServerInterceptor func(
    srv any,
    ss grpc.ServerStream,
    info *grpc.StreamServerInfo,
    handler grpc.StreamHandler,
) error

// UnaryClientInterceptor signature
type UnaryClientInterceptor func(
    ctx context.Context,
    method string,
    req, reply any,
    cc *grpc.ClientConn,
    invoker grpc.UnaryInvoker,
    opts ...grpc.CallOption,
) error

// StreamClientInterceptor signature
type StreamClientInterceptor func(
    ctx context.Context,
    desc *grpc.StreamDesc,
    cc *grpc.ClientConn,
    method string,
    streamer grpc.Streamer,
    opts ...grpc.CallOption,
) (grpc.ClientStream, error)
```

### Basic Interceptor Structure

A unary server interceptor follows a before/after pattern: capture the start time, call the handler, then log the result. The interceptor receives the full method name from `grpc.UnaryServerInfo`, giving you enough context to identify which RPC is executing. You register it with `grpc.UnaryInterceptor` when creating the server.

```go
package interceptor

import (
    "context"
    "log/slog"
    "time"

    "google.golang.org/grpc"
)

// SimpleLoggingInterceptor demonstrates basic unary interceptor
func SimpleLoggingInterceptor(
    ctx context.Context,
    req any,
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (any, error) {
    // Before handling
    start := time.Now()
    slog.Info("request started",
        "method", info.FullMethod,
    )

    // Call the actual handler
    resp, err := handler(ctx, req)

    // After handling
    slog.Info("request completed",
        "method", info.FullMethod,
        "duration", time.Since(start),
        "error", err,
    )

    return resp, err
}

// Using the interceptor
func main() {
    server := grpc.NewServer(
        grpc.UnaryInterceptor(SimpleLoggingInterceptor),
    )
    // Register services...
}
```

### Junior -> FAANG: Grounding the Type Signatures

The four type signatures look intimidating the first time. A practical way to read them is to strip away the gRPC-specific names and see the pattern: each signature is a function that receives a "do the next thing" callable and returns the same shape as that callable. This is the classic middleware or decorator pattern.

For `UnaryServerInterceptor`: the `handler` parameter is "call the real RPC handler." The interceptor wraps it, does something before and after, and returns the same `(any, error)` that the handler would return. For `StreamServerInterceptor`: the `handler` parameter is "call the real streaming handler." The interceptor wraps it and returns an `error`.

The `SimpleLoggingInterceptor` example is the foundation of almost every real interceptor. The structure is always: capture start time, call `handler(ctx, req)`, then act on the result and duration. If you can write this from memory in an interview, you have demonstrated you understand the pattern.

Common first-job mistake: forgetting to return the handler's response and error. Writing `handler(ctx, req)` without `return` compiles fine (the results are silently discarded) but every RPC returns nil, nil. Always write `resp, err := handler(ctx, req)` followed by `return resp, err`.

### Senior @ FAANG: Interceptor Fundamentals as a Platform API

The type signatures are the public API of your interceptor platform. Once services depend on them, changing the signatures is a breaking change. This matters for two reasons.

First, if you wrap `grpc.UnaryServerInterceptor` in a type alias in your platform library (as the code shows), you can add platform-specific context or validation to the signature without breaking the underlying gRPC API. Keeping the raw type exposed directly means any grpc-go breaking change propagates immediately to all services.

Second, the `grpc.UnaryServerInfo` struct carries `FullMethod` and `Server`. `FullMethod` is the only stable identifier for routing decisions in interceptors. Teams sometimes try to inspect the `req any` parameter to determine which service or tenant is calling. This is fragile: it requires type assertions against generated proto types, breaks across proto schema changes, and couples observability to business logic. The correct approach is to encode routing decisions in gRPC metadata or in `FullMethod` prefix patterns, keeping interceptors decoupled from payload schemas.

At L6/L7 interviews, expect a follow-up after you explain the type signatures: "If you needed to add a fourth parameter to `UnaryServerInterceptor` for all interceptors in your platform to receive, how would you do it without breaking existing implementations?" The answer involves wrapping: define a platform-specific interceptor type that takes an additional parameter (for example, a `*RequestContext` struct carrying pre-computed tenant info), write an adapter that converts it to `grpc.UnaryServerInterceptor` for registration, and deprecate direct use of the raw grpc type in your platform. This is the same adapter pattern that allows grpc-go itself to evolve its API without forcing every user to rewrite their interceptors.

---
