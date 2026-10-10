## 51.6 API Aggregation

### Aggregating Multiple Services

A single client request often requires data from several backend services. Rather than forcing the client to make multiple round trips, the gateway can fan out requests to those services in parallel, collect the results, and return a merged response. The aggregator below supports dependency ordering (service B waits for service A's result before executing), distinguishes required calls from optional ones, and includes partial-failure information in the response so the client can degrade gracefully.

> **Senior track**: Aggregation composes availability multiplicatively. Five dependencies at 99.9% give you 99.5% aggregate availability and a p99 latency equal to the slowest branch. Mitigations: per-call timeouts shorter than the outer deadline, circuit breakers per upstream, required vs optional classification with partial-response fields, and aggressive caching at the aggregator. If your aggregation logic is non-trivial and client-specific, it belongs in a BFF (one per client channel), not in a shared gateway. KrakenD is a purpose-built declarative aggregation gateway if you want this without writing code.

```go
// pkg/gateway/aggregation.go
package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Aggregator combines responses from multiple services
type Aggregator struct {
	services map[string]ServiceClient
	timeout  time.Duration
}

// ServiceClient calls a backend service
type ServiceClient interface {
	Call(ctx context.Context, method, path string, body any) (json.RawMessage, error)
}

// AggregationConfig defines how to aggregate responses
type AggregationConfig struct {
	Name     string
	Calls    []ServiceCall
	Template string // Optional Go template for custom response
}

// ServiceCall defines a call to make
type ServiceCall struct {
	Name      string                 // Name for the response field
	Service   string                 // Service to call
	Method    string                 // HTTP method
	Path      string                 // URL path (supports template: /users/{{.user_id}})
	Body      map[string]any // Optional body
	Required  bool                   // If true, fail entire request on error
	DependsOn []string               // Wait for these calls first
	Transform func(json.RawMessage) json.RawMessage
}

// NewAggregator creates an aggregator
func NewAggregator(services map[string]ServiceClient, timeout time.Duration) *Aggregator {
	return &Aggregator{
		services: services,
		timeout:  timeout,
	}
}

// Aggregate executes multiple service calls and combines results
func (a *Aggregator) Aggregate(ctx context.Context, config AggregationConfig, params map[string]string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	results := make(map[string]json.RawMessage)
	errors := make(map[string]error)
	var mu sync.Mutex

	// Build dependency graph
	dependencies := make(map[string][]string)
	for _, call := range config.Calls {
		dependencies[call.Name] = call.DependsOn
	}

	// Track completed calls
	completed := make(map[string]bool)
	completedChan := make(chan string, len(config.Calls))

	// Execute calls respecting dependencies
	var wg sync.WaitGroup

	executeCall := func(call ServiceCall) {
		defer wg.Done()

		// Wait for dependencies
		for _, dep := range call.DependsOn {
			for {
				mu.Lock()
				done := completed[dep]
				mu.Unlock()
				if done {
					break
				}
				select {
				case <-ctx.Done():
					return
				case <-completedChan:
				}
			}
		}

		// Interpolate path with params
		path := interpolatePath(call.Path, params)

		// Get service client
		client, exists := a.services[call.Service]
		if !exists {
			mu.Lock()
			errors[call.Name] = fmt.Errorf("service not found: %s", call.Service)
			mu.Unlock()
			return
		}

		// Make call
		result, err := client.Call(ctx, call.Method, path, call.Body)

		mu.Lock()
		if err != nil {
			errors[call.Name] = err
		} else {
			if call.Transform != nil {
				result = call.Transform(result)
			}
			results[call.Name] = result
		}
		completed[call.Name] = true
		mu.Unlock()

		completedChan <- call.Name
	}

	for _, call := range config.Calls {
		wg.Add(1)
		go executeCall(call)
	}

	wg.Wait()

	// Check for required call failures
	for _, call := range config.Calls {
		if call.Required {
			if err, hasErr := errors[call.Name]; hasErr {
				return nil, fmt.Errorf("required call %s failed: %w", call.Name, err)
			}
		}
	}

	// Build response
	response := make(map[string]any)
	for name, data := range results {
		var parsed any
		if err := json.Unmarshal(data, &parsed); err != nil {
			response[name] = data
		} else {
			response[name] = parsed
		}
	}

	// Include errors for non-required calls
	if len(errors) > 0 {
		errMap := make(map[string]string)
		for name, err := range errors {
			errMap[name] = err.Error()
		}
		response["_errors"] = errMap
	}

	return response, nil
}

func interpolatePath(path string, params map[string]string) string {
	for key, value := range params {
		path = strings.ReplaceAll(path, "{{."+key+"}}", value)
	}
	return path
}


// Example: User Dashboard Aggregation
func UserDashboardAggregation() AggregationConfig {
	return AggregationConfig{
		Name: "user_dashboard",
		Calls: []ServiceCall{
			{
				Name:     "user",
				Service:  "user-service",
				Method:   "GET",
				Path:     "/users/{{.user_id}}",
				Required: true,
			},
			{
				Name:     "orders",
				Service:  "order-service",
				Method:   "GET",
				Path:     "/users/{{.user_id}}/orders?limit=5",
				Required: false,
			},
			{
				Name:      "recommendations",
				Service:   "recommendation-service",
				Method:    "GET",
				Path:      "/recommendations/{{.user_id}}",
				Required:  false,
				DependsOn: []string{"user"}, // Need user data first
			},
			{
				Name:     "notifications",
				Service:  "notification-service",
				Method:   "GET",
				Path:     "/users/{{.user_id}}/notifications?unread=true",
				Required: false,
			},
		},
	}
}

// AggregationHandler creates an HTTP handler for aggregation
func (a *Aggregator) AggregationHandler(config AggregationConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Extract params from URL and query
		params := make(map[string]string)

		// URL params (from router)
		if routeParams, ok := r.Context().Value(routeParamsKey).(map[string]string); ok {
			for k, v := range routeParams {
				params[k] = v
			}
		}

		// Query params
		for k, v := range r.URL.Query() {
			if len(v) > 0 {
				params[k] = v[0]
			}
		}

		result, err := a.Aggregate(r.Context(), config, params)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}
```

### Junior -> FAANG: Aggregation Basics for System Design Rounds

Aggregation is the concrete answer to the interview question "how would you reduce the number of round trips a mobile client makes?" The pattern: one gateway endpoint fans out to N services in parallel, collects results, and returns a merged response. The client makes one call instead of N.

Key concepts to articulate:

- Fan-out with `sync.WaitGroup` or `errgroup`: all calls start simultaneously, the response is built after all finish (or timeout).
- Required vs optional calls: user data failing should fail the whole request (you cannot show a dashboard without a user), while recommendation failures should degrade gracefully (show an empty section).
- Shared deadline: wrap the entire fan-out in `context.WithTimeout` so a slow optional service cannot hold the request open past the outer deadline.
- The `_errors` field in the response tells the client which optional sections failed so it can render a degraded UI without guessing.

Interviewers ask: "what happens if one of five parallel calls takes 9 seconds while the others take 200ms?" The correct answer is that the shared deadline (say, 5 seconds) fires, all pending calls are canceled, and the response is returned with whatever results arrived before the deadline. The 9-second call is abandoned. This is why the deadline must be set on the context before the fan-out, not per-call.

### Senior @ FAANG: Aggregation Architecture at Scale

**Availability compounding.** Five dependencies at 99.9% each give aggregate availability of 99.5% (`0.999^5`). Ten dependencies give 99%. This math should be in your head for any aggregation design conversation. The implication: the more services you aggregate, the harder it is to meet an SLO without aggressive per-call timeouts and optional classification.

**Dependency ordering correctness.** The `executeCall` function waits for dependencies by polling `completed[dep]` in a spin loop with `select`. This works but has a problem: if the dependency goroutine panics or the context is canceled before completion, the waiting goroutine spins until context cancellation. A more sound approach uses a per-call `chan struct{}` that is closed when the call completes (or fails), which allows dependents to unblock immediately via `select`. The `golang.org/x/sync/errgroup` package with a context models this cleanly.

**Cache at the aggregation layer.** The `UserDashboardAggregation` makes four service calls on every request. User profile data changes infrequently. Caching the user call with a short TTL (10-30 seconds) reduces upstream load dramatically for high-traffic users. The cache key should include the user ID and any relevant context (locale, version) but not request-specific fields. A stale-while-revalidate pattern (serve the cached value immediately, refresh in a background goroutine) further reduces p99 latency for cache misses.

**Aggregation in a BFF vs a shared gateway.** The `AggregationConfig` struct is flexible enough to express any composition. But as the number of aggregation patterns grows, the shared gateway becomes a monorepo for client-specific response shapes. This is the point at which a BFF makes sense: each client team owns a thin Go service that composes the services it needs, in the shape it needs, on the schedule it needs. The shared gateway routes to BFFs, and BFFs aggregate from services. The platform team owns the shared gateway, product teams own their BFFs.

**Partial failure signaling.** The `_errors` field is useful for developers but leaks internal service names to external clients in production. A more careful design maps internal service names to user-visible section names (`"recommendations"` instead of `"recommendation-service"`) and uses HTTP response codes to signal severity: 200 with `partial: true` for degraded responses, 206 for explicitly partial content, 503 when a required call fails. Define this contract in an API spec and enforce it in integration tests.

---
