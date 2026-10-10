## 12. HTTP Middleware: Region-Aware Request Routing

A production HTTP server needs middleware that annotates requests with region context, enforces routing decisions, and records latency per region. This middleware sits at the front of your HTTP handler chain and does three things for every incoming request. First, it extracts the client's real IP address from proxy headers (X-Real-IP, X-Forwarded-For, or CF-Connecting-IP) and uses the geo resolver to determine which region is closest to the user. Second, it filters out any regions that are currently partitioned by the chaos injector and picks the best remaining candidate based on observed latency. Third, it attaches the chosen region to the request context so downstream handlers can use it for data routing decisions, and records the response latency for future routing calculations.

```go
// middleware/region.go
package middleware

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"time"

	"yourmodule/chaos"
	"yourmodule/routing"
)

type contextKey string

const (
	ctxKeyRegion   contextKey = "target_region"
	ctxKeyClientIP contextKey = "client_ip"
)

// RegionFromContext extracts the target region ID from the context.
func RegionFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeyRegion).(string); ok {
		return v
	}
	return ""
}

// RegionRouter is HTTP middleware that resolves the best target region for
// each incoming request and attaches it to the context.
type RegionRouter struct {
	resolver      routing.GeoResolver
	latencyRouter *routing.LatencyRouter
	injector      *chaos.Injector // nil in production; set in testing
	logger        *slog.Logger
}

// NewRegionRouter constructs the middleware.
func NewRegionRouter(
	resolver routing.GeoResolver,
	latencyRouter *routing.LatencyRouter,
	injector *chaos.Injector,
	logger *slog.Logger,
) *RegionRouter {
	return &RegionRouter{
		resolver:      resolver,
		latencyRouter: latencyRouter,
		injector:      injector,
		logger:        logger,
	}
}

// Middleware returns an http.Handler wrapping next.
func (rr *RegionRouter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		clientIP := extractIP(r)
		ctx := context.WithValue(r.Context(), ctxKeyClientIP, clientIP)

		regions, err := rr.resolver.Resolve(ctx, net.ParseIP(clientIP))
		if err != nil || len(regions) == 0 {
			rr.logger.WarnContext(ctx, "region resolution failed - using default",
				"ip", clientIP, "err", err)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		// Filter out partitioned regions (chaos testing).
		var candidates []string
		for _, reg := range regions {
			if rr.injector != nil && rr.injector.IsPartitioned(reg.ID) {
				continue
			}
			candidates = append(candidates, reg.ID)
		}

		if len(candidates) == 0 {
			http.Error(w, "all regions unavailable", http.StatusServiceUnavailable)
			return
		}

		bestRegion := rr.latencyRouter.BestRegion(candidates)
		if bestRegion == "" {
			bestRegion = candidates[0]
		}

		// Simulate chaos latency if injector is active.
		if rr.injector != nil {
			if added := rr.injector.AddedLatency(bestRegion); added > 0 {
				time.Sleep(added)
			}
			if rr.injector.ShouldDrop(bestRegion) {
				http.Error(w, "request dropped (chaos)", http.StatusServiceUnavailable)
				return
			}
		}

		ctx = context.WithValue(ctx, ctxKeyRegion, bestRegion)
		w.Header().Set("X-Served-Region", bestRegion)

		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r.WithContext(ctx))

		elapsed := time.Since(start)
		rr.latencyRouter.RecordRTT(bestRegion, elapsed)

		rr.logger.InfoContext(ctx, "request served",
			"method", r.Method,
			"path", r.URL.Path,
			"region", bestRegion,
			"status", rw.status,
			"latency_ms", elapsed.Milliseconds())
	})
}

func extractIP(r *http.Request) string {
	// Check common proxy headers.
	for _, h := range []string{"X-Real-IP", "X-Forwarded-For", "CF-Connecting-IP"} {
		if ip := r.Header.Get(h); ip != "" {
			return ip
		}
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}
```

---

### Junior -> FAANG: Middleware as the Right Place for Cross-Cutting Concerns

Routing logic does not belong in individual request handlers. If every handler has to decide which region to use, the logic gets duplicated, diverges over time, and cannot be changed without touching every handler. Middleware is the correct abstraction: it runs once per request, makes the routing decision, stores the result in the context, and every downstream handler reads it uniformly from the context.

The `RegionFromContext` function is the public API of this middleware layer. Handlers call this function and get back a region ID without knowing anything about GeoDNS, haversine distance, or latency measurement. This is the information hiding principle applied to routing.

For interviews: when discussing HTTP middleware, know the chain model (each middleware wraps the next handler), the context propagation pattern (use typed keys to avoid collisions), and the observability obligation (middleware is the right place to record request duration per region, because it runs after the handler returns). All three appear in the code above.

### Senior @ FAANG: Middleware at Platform Scale and Trust Boundaries

**The X-Forwarded-For header is a security concern.** The `extractIP` function trusts the `X-Real-IP`, `X-Forwarded-For`, and `CF-Connecting-IP` headers without validating that they come from a trusted proxy. A client connecting directly (bypassing the proxy) can forge these headers and appear to be from any IP address, defeating geo-routing decisions and potentially bypassing IP-based rate limiting. A production implementation validates that the request arrived from a known proxy IP before trusting forwarded headers, and falls back to `r.RemoteAddr` for direct connections.

**The chaos injector in production versus testing.** The middleware accepts a `*chaos.Injector` that is `nil` in production and wired up in testing. This is the correct pattern for keeping chaos tooling out of the production binary's hot path, but it means chaos experiments in production require a different deployment (a separate chaos-enabled binary or a feature flag that enables the injector at runtime). A staff engineer designs this as a runtime toggle rather than a compile-time nil check, so that chaos experiments can be activated in production without redeployment.

**Latency recording in the middleware versus at the load balancer.** The middleware records `elapsed` as the time from request start to response completion, including handler execution time. This includes time spent in the handler, database queries, and outbound API calls. It is not a pure measure of network round-trip time to the region. For accurate latency-based routing between services, RTT should be measured at the network layer (TCP connection time to the region's endpoint) not at the application layer. The middleware RTT is useful for user-facing latency SLOs but not for intra-service routing optimization.

**The `responseWriter` wrapper and status code capture.** The `responseWriter` struct wraps `http.ResponseWriter` to capture the status code, because `net/http` does not expose the written status code through the standard interface after `WriteHeader` is called. This pattern is correct and widely used, but it has a subtlety: if the handler never calls `WriteHeader` (because it calls `Write` directly, which implicitly sends 200), the wrapper's `status` field stays at the initialized value of `http.StatusOK`. If the handler returns an error by calling `http.Error`, which calls `WriteHeader` before `Write`, the status is captured correctly. Verify this behavior in your test suite.

**Request context propagation to background goroutines.** The middleware adds region context to `r.Context()`. If any handler launches a goroutine to do async work (background task, event publication), that goroutine must not use `r.Context()` directly because it will be canceled when the HTTP response is sent. The pattern is to create a detached context at the handler boundary: `bgCtx := context.WithValue(context.Background(), ctxKeyRegion, RegionFromContext(r.Context()))`. This preserves the region information in the background goroutine without inheriting the request cancellation.
