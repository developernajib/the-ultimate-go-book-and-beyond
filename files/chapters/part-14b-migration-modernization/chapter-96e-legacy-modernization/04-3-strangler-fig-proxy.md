## 3. Strangler Fig Proxy

The Strangler Fig proxy is the heart of the migration. It intercepts all incoming requests and routes them to either the legacy or new service based on feature flags and routing rules. Think of it as a smart reverse proxy sitting between your clients and your backends. When a request arrives, the proxy checks if any routing rule matches the request path and HTTP method. If a rule matches, it extracts an entity ID (such as a user ID from the URL path) and asks the feature flag engine whether this entity should use the new service. If the flag is enabled, the request goes to the new Go service. Otherwise, it goes to the legacy system. Requests that match no rule always fall through to legacy, ensuring that unmigrated endpoints are never accidentally broken.

```go
// file: internal/proxy/strangler.go
package proxy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/example/gobook/internal/featureflags"
	"github.com/example/gobook/internal/metrics"
)

// RouteRule defines how a specific path pattern maps to feature flags.
type RouteRule struct {
	Pattern    *regexp.Regexp
	Methods    []string
	FlagName   featureflags.FlagName
	// EntityExtractor pulls the entity ID from the request for flag evaluation.
	EntityExtractor func(r *http.Request) string
}

// StranglerProxy routes requests between legacy and new services.
type StranglerProxy struct {
	legacyProxy *httputil.ReverseProxy
	newProxy    *httputil.ReverseProxy
	flags       *featureflags.Engine
	rules       []RouteRule
	logger      *slog.Logger
	metrics     *metrics.MigrationMetrics
}

// Config holds proxy configuration.
type Config struct {
	LegacyURL string
	NewURL    string
	Timeout   time.Duration
}

// NewStranglerProxy constructs the proxy with both upstream targets.
func NewStranglerProxy(
	cfg Config,
	flags *featureflags.Engine,
	rules []RouteRule,
	logger *slog.Logger,
	m *metrics.MigrationMetrics,
) (*StranglerProxy, error) {
	legacyURL, err := url.Parse(cfg.LegacyURL)
	if err != nil {
		return nil, fmt.Errorf("parse legacy URL: %w", err)
	}
	newURL, err := url.Parse(cfg.NewURL)
	if err != nil {
		return nil, fmt.Errorf("parse new service URL: %w", err)
	}

	transport := &http.Transport{
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		ResponseHeaderTimeout: cfg.Timeout,
	}

	return &StranglerProxy{
		legacyProxy: buildReverseProxy(legacyURL, transport),
		newProxy:    buildReverseProxy(newURL, transport),
		flags:       flags,
		rules:       rules,
		logger:      logger,
		metrics:     m,
	}, nil
}

// buildReverseProxy constructs a reverse proxy with standard modifications.
func buildReverseProxy(target *url.URL, transport http.RoundTripper) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = transport
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Header.Set("X-Forwarded-Host", req.Host)
		req.Host = target.Host
	}
	return proxy
}

// ServeHTTP implements http.Handler. This is the core routing logic.
func (s *StranglerProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	rule := s.matchRule(r)

	var target string
	if rule != nil {
		entityID := rule.EntityExtractor(r)
		ctx := featureflags.WithEntityID(r.Context(), entityID)
		r = r.WithContext(ctx)

		if s.flags.IsEnabled(ctx, rule.FlagName) {
			target = "new"
			s.logger.Debug("routing to new service",
				"path", r.URL.Path,
				"method", r.Method,
				"entity_id", entityID,
				"flag", rule.FlagName,
			)
			s.newProxy.ServeHTTP(w, r)
		} else {
			target = "legacy"
			s.legacyProxy.ServeHTTP(w, r)
		}
	} else {
		// No rule matches: always route to legacy (safe default).
		target = "legacy"
		s.legacyProxy.ServeHTTP(w, r)
	}

	elapsed := time.Since(start)
	s.metrics.RecordRequest(r.URL.Path, r.Method, target, elapsed)

	s.logger.Info("proxied request",
		"path", r.URL.Path,
		"method", r.Method,
		"target", target,
		"duration_ms", elapsed.Milliseconds(),
	)
}

// matchRule finds the first rule matching the request path and method.
func (s *StranglerProxy) matchRule(r *http.Request) *RouteRule {
	for i := range s.rules {
		rule := &s.rules[i]
		if !rule.Pattern.MatchString(r.URL.Path) {
			continue
		}
		if len(rule.Methods) == 0 {
			return rule
		}
		for _, m := range rule.Methods {
			if strings.EqualFold(m, r.Method) {
				return rule
			}
		}
	}
	return nil
}

// ExtractUserIDFromPath is a common entity extractor for paths like /users/{id}.
func ExtractUserIDFromPath(pattern *regexp.Regexp) func(r *http.Request) string {
	return func(r *http.Request) string {
		matches := pattern.FindStringSubmatch(r.URL.Path)
		if len(matches) > 1 {
			return matches[1]
		}
		return ""
	}
}

// ExtractUserIDFromHeader extracts entity ID from a request header.
func ExtractUserIDFromHeader(header string) func(r *http.Request) string {
	return func(r *http.Request) string {
		return r.Header.Get(header)
	}
}

// CapturedResponseWriter captures the status code and body for comparison.
type CapturedResponseWriter struct {
	http.ResponseWriter
	Status int
	Body   *bytes.Buffer
}

func NewCapturedResponseWriter(w http.ResponseWriter) *CapturedResponseWriter {
	return &CapturedResponseWriter{
		ResponseWriter: w,
		Body:           &bytes.Buffer{},
		Status:         http.StatusOK,
	}
}

func (c *CapturedResponseWriter) WriteHeader(code int) {
	c.Status = code
	c.ResponseWriter.WriteHeader(code)
}

func (c *CapturedResponseWriter) Write(b []byte) (int, error) {
	c.Body.Write(b)
	return c.ResponseWriter.Write(b)
}

// DrainAndRestore reads a request body and restores it so it can be read again.
func DrainAndRestore(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("drain request body: %w", err)
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
}

// CloneRequestWithBody creates a copy of the request with a new body.
func CloneRequestWithBody(r *http.Request, body []byte) *http.Request {
	clone := r.Clone(context.Background())
	clone.Body = io.NopCloser(bytes.NewReader(body))
	return clone
}
```

### Junior → FAANG: Proxy Implementation as Dependency-Inversion Applied to Routing

The strangler fig proxy is the most important component in the migration architecture because it is the only component that touches every request. Understanding how it works gives you the mental model for how the entire migration proceeds.

The key design insight: the proxy knows nothing about the business logic of the requests it routes. It only knows about routing rules, feature flags, and which backend to forward to. This separation of concerns makes the proxy independently deployable and testable, which is essential for a component that handles all production traffic.

For Go engineers specifically: the proxy uses `http.RoundTripper` and `http.ReverseProxy` from the standard library, which handle the HTTP-level forwarding correctly including header manipulation, body streaming, and error handling. Understanding these standard library types deeply is important because they have subtle behaviors (such as body streaming behavior and trailer handling) that affect correctness under load.

### Senior @ FAANG: Proxy Architecture Decisions and the Performance Envelope

At senior level, the strangler fig proxy is a performance-critical infrastructure component, not just a routing mechanism. Every request in the system passes through it, which means its latency profile, memory allocation patterns, and error handling behavior directly affect the production system's SLOs.

The governance analysis for proxy performance: at what request rate does the proxy's in-memory flag cache become a bottleneck, what is the GC pressure from the request cloning required for shadow mode, and what is the latency added by the flag evaluation at the 99th percentile. Each of these questions requires profiling data from load tests in a production-like environment before the proxy handles real traffic.

The proxy's behavior under partial failure is the most important operational consideration. If the new service returns errors for a subset of requests while the legacy service succeeds, the proxy needs to detect this pattern and either reduce the new service's traffic share or stop routing to it entirely. This adaptive behavior is what distinguishes a migration proxy that can be operated safely at scale from one that requires constant human oversight.

---
