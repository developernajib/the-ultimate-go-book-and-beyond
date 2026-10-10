## Section 9: gRPC Advanced Interceptors

### 9.1 Rate Limiting Interceptor with Token Bucket

Rate limiting protects APIs from abuse by capping request frequency per client. A token bucket algorithm, implemented with a `time/rate` limiter keyed by client IP or API key, allows short bursts while enforcing a sustained request rate.

```go
package interceptors

import (
	"context"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// perClientBucket is a simple token bucket per client identity.
type perClientBucket struct {
	mu       sync.Mutex
	tokens   float64
	maxToken float64
	refillHz float64 // tokens per second
	lastFill time.Time
}

func newBucket(maxTokens float64, refillHz float64) *perClientBucket {
	return &perClientBucket{
		tokens:   maxTokens,
		maxToken: maxTokens,
		refillHz: refillHz,
		lastFill: time.Now(),
	}
}

func (b *perClientBucket) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(b.lastFill).Seconds()
	b.tokens = min(b.maxToken, b.tokens+elapsed*b.refillHz)
	b.lastFill = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// PerClientRateLimiter creates an interceptor that rate-limits each caller separately.
func PerClientRateLimiter(maxTokens, refillHz float64) grpc.UnaryServerInterceptor {
	var (
		mu      sync.RWMutex
		buckets = make(map[string]*perClientBucket)
	)

	getBucket := func(clientID string) *perClientBucket {
		mu.RLock()
		b, ok := buckets[clientID]
		mu.RUnlock()
		if ok {
			return b
		}

		mu.Lock()
		defer mu.Unlock()
		// Double-checked locking.
		if b, ok = buckets[clientID]; ok {
			return b
		}
		b = newBucket(maxTokens, refillHz)
		buckets[clientID] = b
		return b
	}

	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		md, _ := metadata.FromIncomingContext(ctx)
		clientID := "anonymous"
		if ids := md.Get("x-client-id"); len(ids) > 0 {
			clientID = ids[0]
		}

		if !getBucket(clientID).Allow() {
			return nil, status.Errorf(codes.ResourceExhausted,
				"rate limit exceeded for client %q", clientID)
		}
		return handler(ctx, req)
	}
}
```

### 9.2 Tracing Interceptor (OpenTelemetry)

A tracing interceptor extracts the upstream span context from incoming metadata (via the OpenTelemetry propagator), starts a server span named after the full RPC method, records the gRPC status code, and ends the span on return. In production you would use the `otelgrpc` package directly rather than rolling your own, but the explicit implementation clarifies what the instrumentation actually does - and where to hook in custom attributes like `tenant_id` or `user_id` for slicing latency histograms.

```go
package interceptors

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	grpcstatus "google.golang.org/grpc/status"
)

// TracingUnaryInterceptor creates a new span for each unary RPC.
func TracingUnaryInterceptor(tracer trace.Tracer) grpc.UnaryServerInterceptor {
	if tracer == nil {
		tracer = otel.Tracer("grpc-server")
	}

	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		// Extract trace context from incoming metadata.
		ctx = extractTraceContext(ctx)

		spanName := info.FullMethod
		ctx, span := tracer.Start(ctx, spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				semconv.RPCSystemGRPC,
				semconv.RPCMethod(info.FullMethod),
			),
		)
		defer span.End()

		resp, err := handler(ctx, req)

		if err != nil {
			st, _ := grpcstatus.FromError(err)
			span.SetStatus(codes.Error, st.Message())
			span.SetAttributes(
				attribute.Int("rpc.grpc.status_code", int(st.Code())),
			)
		} else {
			span.SetAttributes(
				attribute.Int("rpc.grpc.status_code", int(grpccodes.OK)),
			)
		}

		return resp, err
	}
}

func extractTraceContext(ctx context.Context) context.Context {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ctx
	}
	// Real implementation uses otel propagator.Extract with a metadata carrier.
	_ = md
	return ctx
}
```

### 9.3 Circuit Breaker Interceptor

A circuit breaker monitors calls to a dependency and opens the circuit (failing fast) when the error rate exceeds a threshold. After a configurable cooldown period, the circuit transitions to half-open, allowing a probe request to test whether the dependency has recovered.

```go
package interceptors

import (
	"context"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type circuitState int

const (
	stateClosed   circuitState = iota // normal - requests pass through
	stateOpen                         // tripped - requests fail fast
	stateHalfOpen                     // recovery probe - one request allowed
)

// CircuitBreaker is an interceptor-level circuit breaker for gRPC clients.
type CircuitBreaker struct {
	mu           sync.Mutex
	state        circuitState
	failures     int
	threshold    int
	resetTimeout time.Duration
	lastFailure  time.Time
}

func NewCircuitBreaker(threshold int, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		threshold:    threshold,
		resetTimeout: resetTimeout,
	}
}

func (cb *CircuitBreaker) UnaryClientInterceptor() grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		if !cb.allow() {
			return status.Errorf(codes.Unavailable,
				"circuit breaker open for method %s", method)
		}

		err := invoker(ctx, method, req, reply, cc, opts...)
		cb.record(err)
		return err
	}
}

func (cb *CircuitBreaker) allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case stateClosed:
		return true
	case stateOpen:
		if time.Since(cb.lastFailure) > cb.resetTimeout {
			cb.state = stateHalfOpen
			return true // probe request
		}
		return false
	case stateHalfOpen:
		return true
	}
	return false
}

func (cb *CircuitBreaker) record(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if err == nil {
		if cb.state == stateHalfOpen {
			cb.state = stateClosed
			cb.failures = 0
		}
		return
	}

	st, _ := status.FromError(err)
	if st.Code() == codes.Unavailable || st.Code() == codes.DeadlineExceeded {
		cb.failures++
		cb.lastFailure = time.Now()
		if cb.failures >= cb.threshold {
			cb.state = stateOpen
		}
	}
}
```

---

### Junior → FAANG: Interceptor Composition and the Observability Baseline

The three interceptors in this section (rate limiting, tracing, circuit breaking) represent three distinct reliability concerns, and understanding which layer they belong to is important for code review and architecture discussions.

Rate limiting is a server-side concern: it protects the server from being overwhelmed by any single caller. It belongs in a server interceptor. Client-side rate limiting exists too (to avoid sending obviously retryable requests), but it is secondary.

Tracing is both a client-side and server-side concern: the client interceptor creates an outgoing span and injects trace context into metadata. The server interceptor extracts that context and creates a server span as a child. Without both sides, the trace is broken: you see the client call but not the server execution, or the server execution but not the client call. The `otelgrpc` package from the OpenTelemetry Go contrib packages handles both sides and is the production choice over rolling your own.

Circuit breaking is a client-side concern: it prevents a client from hammering a failing backend. It belongs in a client interceptor, applied to the `grpc.ClientConn` that calls the downstream service.

First-job habit: any gRPC client call to a downstream service should have at least a tracing interceptor and ideally a circuit breaker. Any gRPC server should have a recovery interceptor, a logging interceptor, and an auth interceptor from the first day it receives traffic. These are not premature optimizations. They are the minimum required to operate the service safely.

### Senior @ FAANG: Interceptor Library Strategy, Observability Contract, and Rate Limiting at Scale

At staff level, the question is not "how do I write a rate limiting interceptor" but "how does the platform ensure that every gRPC service has a consistent, correct set of interceptors without requiring every team to implement them independently." The answer is a shared interceptor library.

A well-designed interceptor library provides opinionated, pre-configured interceptors that teams opt into by importing the library. The auth interceptor extracts the service identity from mTLS peer credentials or a JWT in metadata and places a typed value in the context. The logging interceptor emits structured logs in the organization's standard format with the fields the log aggregation system expects. The tracing interceptor creates spans with the organization's standard attribute names so traces correlate correctly in the APM platform. The rate limiter is backed by a shared Redis cluster so limits are per-service-and-per-method across all instances, not per-instance.

The rate limiting design in this section uses an in-process token bucket, which means limits are per-instance rather than per-service. With 100 instances behind a load balancer, the effective global limit is 100 times the per-instance limit, which is not meaningful rate limiting for quota enforcement. Production rate limiting at scale is backed by a distributed counter: Redis with atomic increment-and-expire, or a purpose-built rate limiting service (Envoy's ext_authz with a token bucket policy, or a dedicated rate limiting sidecar). The trade-off is latency: every RPC must round-trip to the rate limiter before proceeding. This is typically 1-2ms for a local Redis instance, which is acceptable for most services but not for sub-millisecond latency requirements.

Circuit breaking in the example uses a simple failure count. Production circuit breakers use error rate over a sliding window (e.g., more than 50% of the last 100 calls failed) rather than absolute failure count, because absolute count is sensitive to traffic volume: 10 failures in 100 calls is a serious problem, but 10 failures in 10,000 calls may be normal background noise. Libraries like `sony/gobreaker` or `hystrix-go` implement sliding-window circuit breaking. The choice of error types that trigger the breaker matters: `codes.DeadlineExceeded` can be either a client-side timeout (not the server's fault) or a genuine server slowdown. Including it in the circuit breaker logic requires careful analysis of your deadline settings to avoid tripping the circuit on client-induced timeouts.
