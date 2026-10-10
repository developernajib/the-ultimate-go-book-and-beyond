## 105B.10 On-Call Best Practices for Go Services

### Design for Debuggability

Debuggability is a first-class design goal, not an afterthought. A service that is easy to debug has dramatically lower MTTR.

**Structured logging with correlation IDs:**

```go
package middleware

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
)

type contextKey string

const requestIDKey contextKey = "request_id"

// RequestIDMiddleware injects a unique request ID into every request context
// and adds it to all log lines and response headers.
// This enables reconstructing the full request path during incident investigation.
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Propagate from upstream or generate new
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = uuid.New().String()
		}

		// Inject into context for downstream use
		ctx := context.WithValue(r.Context(), requestIDKey, requestID)

		// Echo back to caller for correlation
		w.Header().Set("X-Request-ID", requestID)

		// Structured logger with request ID baked in
		logger := slog.With(
			slog.String("request_id", requestID),
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.String("remote_addr", r.RemoteAddr),
		)

		ctx = context.WithValue(ctx, loggerKey, logger)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

const loggerKey contextKey = "logger"

// LoggerFromContext retrieves the request-scoped structured logger.
// All service code should use this for log lines, not slog.Default().
func LoggerFromContext(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}
```

### Service Checklist: Every Go Service Must Have

This is the minimum bar. Non-negotiable. A service that does not meet this checklist is not production-ready.

```
PRODUCTION READINESS CHECKLIST - Go Service
============================================

OBSERVABILITY
[ ] /healthz endpoint (liveness): returns 200 if process is alive
[ ] /readyz endpoint (readiness): returns 503 if dependencies unavailable
[ ] /metrics endpoint: Prometheus metrics exported
[ ] /debug/pprof endpoints: profiling available (internal port only)
[ ] Structured logging (JSON) with request ID correlation
[ ] Distributed tracing (OpenTelemetry) with service name and version
[ ] Key business metrics exported (not just infrastructure metrics)
[ ] Error events include error type, status code, affected operation

ALERTING
[ ] SLO defined and documented
[ ] Multi-burn-rate alerts configured
[ ] Runbook URL in every alert annotation
[ ] Runbooks exist and were tested in the last 3 months
[ ] Alert fatigue review completed (no alert fires >5x/week without incident)

DEPLOYMENT SAFETY
[ ] Canary deployment configured (traffic split before full rollout)
[ ] Rollback tested and documented in runbook
[ ] Feature flags available for new functionality
[ ] Resource limits set (CPU requests/limits, memory limits)
[ ] Horizontal Pod Autoscaler configured
[ ] PodDisruptionBudget configured

SECURITY
[ ] Debug endpoints (pprof, vars) on internal-only port (not :8080)
[ ] No sensitive data in logs (PII, credentials, tokens)
[ ] Secrets loaded from secrets manager, not environment variables in plain text
[ ] Input validation on all external inputs
[ ] Dependency vulnerability scan in CI pipeline

RELIABILITY
[ ] Circuit breakers on all downstream dependencies
[ ] Timeouts on all outbound calls (HTTP, gRPC, DB, Redis)
[ ] Graceful shutdown handler (SIGTERM → drain → exit)
[ ] Retry with exponential backoff + jitter on transient failures
[ ] Bulkhead pattern for isolation between critical and non-critical paths
```

### Graceful Degradation Design

Services that degrade gracefully produce P2 incidents instead of P0 incidents when dependencies fail.

```go
package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/sony/gobreaker"
)

// RecommendationService fetches personalized recommendations with graceful
// degradation: if the recommendation engine is unavailable, returns a
// pre-cached "popular items" fallback instead of an error.
// This turns a dependency failure into a quality degradation, not a service failure.
type RecommendationService struct {
	engine      RecommendationEngine
	cache       FallbackCache
	breaker     *gobreaker.CircuitBreaker
	logger      *slog.Logger
	degradedMode bool
}

type Recommendation struct {
	ItemID    string
	Score     float64
	IsFallback bool // true when served from degraded mode
}

func NewRecommendationService(engine RecommendationEngine, cache FallbackCache, logger *slog.Logger) *RecommendationService {
	cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{
		Name:        "recommendation-engine",
		MaxRequests: 3,
		Interval:    60 * time.Second,
		Timeout:     10 * time.Second,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			// Open circuit after 5 failures in a row
			return counts.ConsecutiveFailures >= 5
		},
		OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
			logger.Warn("circuit breaker state change",
				slog.String("breaker", name),
				slog.String("from", from.String()),
				slog.String("to", to.String()),
			)
		},
	})

	return &RecommendationService{
		engine:  engine,
		cache:   cache,
		breaker: cb,
		logger:  logger,
	}
}

// GetRecommendations returns personalized recommendations with automatic
// fallback to popular items if the recommendation engine is unavailable.
func (s *RecommendationService) GetRecommendations(ctx context.Context, userID string, limit int) ([]Recommendation, error) {
	result, err := s.breaker.Execute(func() (any, error) {
		return s.engine.GetForUser(ctx, userID, limit)
	})

	if err == nil {
		return result.([]Recommendation), nil
	}

	// Breaker is open or engine failed: use fallback
	if errors.Is(err, gobreaker.ErrOpenState) {
		s.logger.Info("circuit breaker open, using fallback recommendations",
			slog.String("user_id", userID),
		)
	} else {
		s.logger.Error("recommendation engine error, using fallback",
			slog.String("user_id", userID),
			slog.String("error", err.Error()),
		)
	}

	// Fallback: return popular items (never fails)
	fallback, cacheErr := s.cache.GetPopular(ctx, limit)
	if cacheErr != nil {
		// Even the fallback failed: return empty, not error
		s.logger.Error("fallback cache also failed",
			slog.String("error", cacheErr.Error()),
		)
		return []Recommendation{}, nil
	}

	// Mark as fallback so callers can log/metric this
	for i := range fallback {
		fallback[i].IsFallback = true
	}
	return fallback, nil
}

type RecommendationEngine interface {
	GetForUser(ctx context.Context, userID string, limit int) ([]Recommendation, error)
}

type FallbackCache interface {
	GetPopular(ctx context.Context, limit int) ([]Recommendation, error)
}
```

### Feature Flags for Quick Mitigation

Feature flags are the fastest mitigation tool available during an incident. A feature that can be disabled in 30 seconds (flag flip) vs 3 minutes (rollback) is the difference between a 5-minute incident and a 20-minute incident.

```go
package flags

import (
	"context"
	"sync/atomic"
)

// FeatureFlag is a thread-safe boolean flag that can be toggled at runtime.
// In production, these values are backed by a feature flag system (LaunchDarkly,
// Unleash, custom Redis-based flags) that allows remote toggling without redeploy.
type FeatureFlag struct {
	name    string
	enabled atomic.Bool
}

// NewFeatureFlag creates a flag with the given default value.
func NewFeatureFlag(name string, defaultEnabled bool) *FeatureFlag {
	f := &FeatureFlag{name: name}
	f.enabled.Store(defaultEnabled)
	return f
}

// IsEnabled returns whether the feature is enabled.
func (f *FeatureFlag) IsEnabled() bool {
	return f.enabled.Load()
}

// Disable disables the feature. Thread-safe, takes effect immediately.
func (f *FeatureFlag) Disable() {
	f.enabled.Store(false)
}

// Enable enables the feature.
func (f *FeatureFlag) Enable() {
	f.enabled.Store(true)
}

// Example usage in a handler:
func processPaymentWithFlag(ctx context.Context, flags *ServiceFlags) error {
	if !flags.NewPaymentProcessor.IsEnabled() {
		// Fast path: use old processor (known stable)
		return legacyProcess(ctx)
	}
	// New path: may be disabled mid-incident if it is the cause
	return newProcess(ctx)
}

// ServiceFlags groups all feature flags for a service.
// Having them centralized makes on-call engineers' lives easier:
// they know exactly what can be toggled.
type ServiceFlags struct {
	NewPaymentProcessor *FeatureFlag
	EnhancedLogging     *FeatureFlag
	BetaRecommendations *FeatureFlag
}

func NewServiceFlags() *ServiceFlags {
	return &ServiceFlags{
		NewPaymentProcessor: NewFeatureFlag("new_payment_processor", true),
		EnhancedLogging:     NewFeatureFlag("enhanced_logging", false),
		BetaRecommendations: NewFeatureFlag("beta_recommendations", false),
	}
}

func legacyProcess(ctx context.Context) error { return nil }
func newProcess(ctx context.Context) error     { return nil }
```

### Junior → FAANG: Go-Specific On-Call Patterns Worth Memorizing

Three Go-specific patterns directly reduce MTTR for Go services:

**Context deadlines on all external calls.** Every database query, HTTP call, and gRPC call must have a context with a deadline. Without deadlines, a slow external dependency causes goroutines to pile up indefinitely, eventually exhausting memory or hitting goroutine limits. With deadlines, slow calls fail fast and the service degrades gracefully.

**Graceful shutdown.** A Go service that terminates abruptly on SIGTERM drops all in-flight requests. A graceful shutdown handler waits for in-flight requests to complete (up to a timeout) before exiting. This is a single block of code that prevents a deploy from causing a spike in error rate.

**pprof always on.** The pprof endpoint should be registered and accessible in every production Go service. The cost is negligible (an idle HTTP handler), and the benefit during incidents is enormous. Expose it on an internal port that is not accessible from the public internet.

### Senior @ FAANG: Go Service On-Call Best Practices as a Platform Requirement

At L6, these three patterns are not optional best practices: they are platform requirements enforced by a shared service framework. Any Go service that does not use the framework must be approved by the platform team and documented with the specific reason it deviates.

The feature flag integration (for gradual rollouts shown in the code above) is particularly important as a reliability tool. Feature flags enable instant rollback at the application level without a code deployment: if a new code path is causing incidents, the flag is toggled to the old path without a container restart. This capability reduces MTTR from "deploy duration + startup time" to "flag propagation time," which is typically under 30 seconds. An L6 engineer ensures the organization's feature flag infrastructure is reliable enough to be trusted as an incident mitigation tool, including having its own SLO and on-call alert.

---
