## 118B.7 Production Agent Platform

A production agent platform manages agent registration, lifecycle, health monitoring, and request routing. The platform exposes an HTTP API for dispatching tasks to agents and uses OpenTelemetry for distributed tracing across agent interactions.

```go
package platform

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/yourorg/a2a"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// AgentPlatform manages the lifecycle of multiple agents
type AgentPlatform struct {
	registry *a2a.AgentRegistry
	logger   *slog.Logger
	tracer   trace.Tracer

	mu     sync.RWMutex
	agents map[string]*ManagedAgent
}

type ManagedAgent struct {
	agent  *a2a.Agent
	server *http.Server
	health *HealthChecker
}

type HealthChecker struct {
	mu     sync.RWMutex
	status HealthStatus
	checks []HealthCheck
}

type HealthStatus string

const (
	StatusHealthy   HealthStatus = "healthy"
	StatusDegraded  HealthStatus = "degraded"
	StatusUnhealthy HealthStatus = "unhealthy"
)

type HealthCheck struct {
	Name string
	Fn   func(ctx context.Context) error
}

func NewAgentPlatform() *AgentPlatform {
	return &AgentPlatform{
		registry: a2a.NewAgentRegistry(),
		logger:   slog.Default(),
		tracer:   otel.Tracer("agent-platform"),
		agents:   make(map[string]*ManagedAgent),
	}
}

// AddAgent registers and starts an agent
func (p *AgentPlatform) AddAgent(ctx context.Context, agent *a2a.Agent, listenAddr string) error {
	ctx, span := p.tracer.Start(ctx, "platform.add_agent",
		trace.WithAttributes(
			attribute.String("agent.id", agent.Card().ID),
			attribute.String("agent.name", agent.Card().Name),
		),
	)
	defer span.End()

	mux := agent.Routes()

	// Add health check endpoint
	hc := &HealthChecker{status: StatusHealthy}
	mux.HandleFunc("GET /health", hc.Handle)
	mux.HandleFunc("GET /ready", hc.Handle)

	server := &http.Server{
		Addr:         listenAddr,
		Handler:      p.middleware(mux),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	managed := &ManagedAgent{
		agent:  agent,
		server: server,
		health: hc,
	}

	p.mu.Lock()
	p.agents[agent.Card().ID] = managed
	p.mu.Unlock()

	// Start server in background
	go func() {
		p.logger.Info("agent starting", "id", agent.Card().ID, "addr", listenAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			p.logger.Error("agent server error", "id", agent.Card().ID, "error", err)
		}
	}()

	return nil
}

func (p *AgentPlatform) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Add tracing
		ctx, span := p.tracer.Start(r.Context(), r.Method+" "+r.URL.Path)
		defer span.End()

		// Add request ID
		reqID := r.Header.Get("X-Request-ID")
		if reqID == "" {
			reqID = generateID()
		}
		w.Header().Set("X-Request-ID", reqID)

		next.ServeHTTP(w, r.WithContext(ctx))

		p.logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"duration", time.Since(start),
			"request_id", reqID,
		)
	})
}

func (hc *HealthChecker) Handle(w http.ResponseWriter, r *http.Request) {
	hc.mu.RLock()
	status := hc.status
	hc.mu.RUnlock()

	if status == StatusHealthy {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	w.Write([]byte(string(status)))
}

// Shutdown gracefully shuts down all agents
func (p *AgentPlatform) Shutdown(ctx context.Context) error {
	p.mu.RLock()
	agents := make([]*ManagedAgent, 0, len(p.agents))
	for _, a := range p.agents {
		agents = append(agents, a)
	}
	p.mu.RUnlock()

	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		errs []error
	)
	for _, a := range agents {
		wg.Add(1)
		go func(managed *ManagedAgent) {
			defer wg.Done()
			// Collect the error rather than discarding it. A Shutdown that
			// times out means connections were still in flight when the
			// deadline hit, and returning nil regardless reports a clean
			// shutdown that did not happen.
			if err := managed.server.Shutdown(ctx); err != nil {
				mu.Lock()
				errs = append(errs, fmt.Errorf("agent %s: %w", managed.agent.Card().ID, err))
				mu.Unlock()
			}
		}(a)
	}
	wg.Wait()
	return errors.Join(errs...)
}

// generateID returns a unique request ID.
//
// Not time.Now().UnixNano(). Two requests arriving in the same nanosecond,
// which is routine under concurrency, would share a request ID, and correlated
// logs are worthless the moment the correlation key is not unique. Request IDs
// are also echoed to clients, so a timestamp leaks server timing.
func generateID() string {
	return uuid.New().String()
}
```

The `checks` field on `HealthChecker` above is declared but nothing runs it, which makes the health endpoint a liveness check that only ever reports the status somebody last set by hand. To actually monitor agents, run the registered checks on an interval and drive the status from their results:

```go
// RunChecks evaluates every registered check on an interval and updates status.
// Call it once per HealthChecker in its own goroutine - it returns when ctx ends.
func (hc *HealthChecker) RunChecks(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Bound each round so one hung check cannot stall the loop
			// forever and freeze the reported status at its last value.
			checkCtx, cancel := context.WithTimeout(ctx, interval/2)

			status := StatusHealthy
			for _, c := range hc.checks {
				if err := c.Fn(checkCtx); err != nil {
					status = StatusUnhealthy
					break
				}
			}
			cancel()

			hc.mu.Lock()
			hc.status = status
			hc.mu.Unlock()
		}
	}
}
```

---

### Junior → FAANG: Production Agent Platform as Observability Case Study

The production agent platform in this section is a case study in observability-first Go service design. OpenTelemetry distributed tracing is integrated at the task dispatch level so that every agent interaction is recorded as a span in the trace. This allows the full execution path of a complex multi-agent task (orchestrator receives task, delegates to agent A, agent A calls MCP tool, agent A delegates subtask to agent B, agent B returns result, orchestrator aggregates) to be visualized as a single trace in Jaeger or Zipkin. Understanding distributed tracing, including trace context propagation across HTTP boundaries, is an observability skill that FAANG infrastructure engineers are expected to have.

The health monitoring component (the platform periodically checks agent health endpoints and removes unhealthy agents from the registry) is the pattern that keeps the agent registry accurate. Without health monitoring, the registry accumulates stale entries for agents that have crashed, which causes task dispatch failures until the stale entry times out. Implementing health monitoring with a configurable check interval and failure threshold (remove from registry after N consecutive failures) is the production reliability practice that distinguishes a well-designed platform from a basic implementation.

### Senior @ FAANG: Agent Platform as Organizational Infrastructure Investment

At senior level, the production agent platform is the organizational infrastructure that enables teams to build and deploy agents without solving the registration, routing, health monitoring, and observability problems independently. The platform's ROI scales with the number of agent teams using it: a team of 2 engineers maintaining the platform infrastructure enables 10 agent teams to skip solving these problems themselves. This is the platform engineering multiplier that justifies the investment.

The OpenTelemetry integration in the platform is the foundation for the agent performance SLO: once every agent interaction is traced, the P50/P95/P99 latency for each agent type and each MCP tool can be computed from the trace data. These latency metrics, combined with error rate metrics from the health monitoring, define the agent platform SLO. The SLO, once defined and measured, drives the reliability engineering work: when P99 latency exceeds the threshold, the alert fires and the on-call engineer investigates which agent or tool is the bottleneck. Without the platform-level observability, this investigation requires manual log analysis across multiple agent services, which is significantly slower and less reliable. Senior engineers who design platforms with SLO-supporting observability built in enable the reliability engineering culture that FAANG production systems require.
