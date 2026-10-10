## 103.3 HTTP Instrumentation

### HTTP Server Middleware

Middleware chains compose orthogonal concerns (authentication, logging, rate limiting) around a core handler without modifying its implementation. `OTelMiddleware` delegates to `otelhttp.NewHandler`, which automatically creates a server span per request and records `http.request.method`, `http.route`, `http.response.status_code`, and read/write message events, while `TracingMiddleware` shows how to augment those spans with service-specific attributes from the request context.

```go
package middleware

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

// OTelMiddleware wraps HTTP handlers with OpenTelemetry instrumentation
func OTelMiddleware(next http.Handler) http.Handler {
    return otelhttp.NewHandler(next, "http-server",
        otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
        otelhttp.WithSpanOptions(trace.WithAttributes(
            attribute.String("app.component", "http-server"),
        )),
    )
}

// Custom middleware with additional attributes
func TracingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        span := trace.SpanFromContext(ctx)

        // Add custom attributes
        span.SetAttributes(
            attribute.String("http.user_agent", r.UserAgent()),
            attribute.String("http.client_ip", r.RemoteAddr),
        )

        // Add user info if authenticated
        if userID := r.Header.Get("X-User-ID"); userID != "" {
            span.SetAttributes(attribute.String("user.id", userID))
        }

        next.ServeHTTP(w, r)
    })
}

// Example usage
func SetupServer() *http.Server {
    mux := http.NewServeMux()
    mux.HandleFunc("/api/users", handleUsers)
    mux.HandleFunc("/api/orders", handleOrders)

    // Wrap with OpenTelemetry middleware
    handler := OTelMiddleware(TracingMiddleware(mux))

    return &http.Server{
        Addr:    ":8080",
        Handler: handler,
    }
}
```

### HTTP Client Instrumentation

The client side matters just as much as the server side: without an instrumented transport, outbound calls appear as gaps in the trace. `otelhttp.NewTransport` wraps the client's `http.RoundTripper` so every outbound request gets a client span and the `traceparent` header is injected automatically, linking the caller's trace to the downstream service.

```go
package client

import (
    "context"
    "net/http"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

// NewHTTPClient creates an instrumented HTTP client
func NewHTTPClient() *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(http.DefaultTransport,
            otelhttp.WithSpanOptions(trace.WithAttributes(
                attribute.String("client.name", "my-service"),
            )),
        ),
        Timeout: 30 * time.Second,
    }
}

// Example usage
type OrderClient struct {
    client  *http.Client
    baseURL string
}

func NewOrderClient(baseURL string) *OrderClient {
    return &OrderClient{
        client:  NewHTTPClient(),
        baseURL: baseURL,
    }
}

func (c *OrderClient) GetOrder(ctx context.Context, orderID string) (*Order, error) {
    tracer := otel.Tracer("order-client")
    ctx, span := tracer.Start(ctx, "OrderClient.GetOrder",
        trace.WithAttributes(attribute.String("order.id", orderID)),
    )
    defer span.End()

    req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/orders/"+orderID, nil)
    if err != nil {
        return nil, err
    }

    resp, err := c.client.Do(req)
    if err != nil {
        span.RecordError(err)
        return nil, err
    }
    defer resp.Body.Close()

    // Process response...
    return nil, nil
}
```

### Junior → FAANG: HTTP Instrumentation as the Entry Point to Observability

HTTP instrumentation is often the first OTel code a junior engineer writes, and it is the best place to understand what auto-instrumentation actually does. When you wrap a `http.Handler` with `otelhttp.NewHandler`, the middleware extracts the incoming `traceparent` header, creates a server span, and stores the active span in the request context. Every subsequent call to `tracer.Start(r.Context(), ...)` inside the handler automatically becomes a child of that server span.

The key habit: always propagate the request context, not a background context, into downstream calls. Using `context.Background()` in a handler severs the trace chain and produces orphaned spans that appear as separate root traces in Jaeger. This is one of the most common bugs in newly instrumented services.

For interviews, be ready to explain the difference between server spans and client spans in HTTP tracing. A server span covers the time from receiving a request to sending a response. A client span covers the time from initiating an outbound request to receiving a response. Both are necessary to calculate true end-to-end latency.

### Senior @ FAANG: HTTP Span Cardinality, Route Normalization, and Security Boundaries

**Route normalization is a cardinality requirement.** If span names are set to the raw URL path, then `/users/123`, `/users/456`, and `/users/789` each create a distinct span name. In Jaeger, this produces thousands of unique operation names that make aggregate queries useless. In Prometheus (via exemplars), it creates unbounded label cardinality. `otelhttp.WithRouteTag` solves this by tagging spans and metrics with the route template (`/users/{id}`) via the `http.route` attribute rather than the concrete URL. Enforcing route normalization across all services is a platform requirement, not a per-team decision.

**Sensitive path parameters.** Route templates solve cardinality but not security. If a route like `/accounts/{account_id}/statements/{doc_id}` emits both the template and the resolved parameter values as span attributes, those values appear in the tracing backend. If the backend is a third-party SaaS tool, this is a data governance violation. A Collector attribute processor must scrub or hash known-sensitive attributes before export. Documenting the list of scrubbed attributes in the platform runbook is an L6-level responsibility.

**Middleware ordering and sampling interaction.** The OTel middleware must be the outermost middleware in the chain so that it can see the full request lifecycle, including authentication and authorization failures. If authentication middleware runs first and returns 401 before OTel creates a span, the authentication failure trace is lost. At scale, losing 401 traces means you cannot distinguish between a client misconfiguration and an attack pattern. The correct order: OTel middleware, then rate limiting, then authentication, then business logic.

**Client transport instrumentation and connection pooling.** `otelhttp.NewTransport` wraps `http.RoundTripper` to create client spans. A common senior-level mistake is wrapping the transport on every request instead of once at client initialization, which bypasses connection pooling by creating a new `http.Transport` each time. The correct pattern is to create the instrumented transport once and store it in the `http.Client` used across the service lifetime.

---
