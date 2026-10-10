## 13. Wire-Up: Complete Application Bootstrap

This section brings every component from the previous sections together into a single runnable `main.go`. You will see how the region registry, health checker, traffic shifter, geo router, chaos injector, failover controller, and replication engine are all wired up and started. In a real deployment you would replace the in-memory stubs (the in-memory Kafka bus and in-memory store at the bottom of this file) with actual Kafka clients, PostgreSQL connections, and Redis clusters. The stub implementations exist here so you can run and experiment with the full system locally without any external dependencies.

```go
// cmd/server/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"yourmodule/chaos"
	"yourmodule/failover"
	"yourmodule/health"
	"yourmodule/middleware"
	"yourmodule/region"
	"yourmodule/replication"
	"yourmodule/routing"
	"yourmodule/trafficmgr"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// ── Region Registry ────────────────────────────────────────────────────────
	reg := region.NewRegistry(region.TopologyActiveActive, "us-east-1", logger)

	regions := []*region.Region{
		{ID: "us-east-1", Name: "US East", Endpoint: "https://us-east.api.example.com",
			Lat: 37.9, Lon: -77.0, Priority: 1},
		{ID: "eu-west-1", Name: "EU West", Endpoint: "https://eu-west.api.example.com",
			Lat: 53.3, Lon: -6.3, Priority: 2},
		{ID: "ap-east-1", Name: "AP East", Endpoint: "https://ap-east.api.example.com",
			Lat: 22.3, Lon: 114.2, Priority: 3},
	}
	for _, r := range regions {
		r.UpdateHealth(1.0)
		r.SetRole(region.RolePrimary)
		reg.Register(r)
	}

	// ── Health Checking ────────────────────────────────────────────────────────
	checker := health.NewCompositeChecker(logger)
	checker.AddProbe("http", 0.6, health.NewHTTPHealthProbe(3*time.Second, "/health"))
	checker.AddProbe("replication_lag", 0.4,
		health.NewReplicationLagProbe(func(_ context.Context, _ string) (time.Duration, error) {
			return 200 * time.Millisecond, nil // stub; replace with real DB query
		}, 30*time.Second))

	healthLoop := health.NewHealthLoop(checker, reg, 15*time.Second, logger)
	go healthLoop.Run(ctx)

	// ── Traffic Management ─────────────────────────────────────────────────────
	shifter := trafficmgr.NewTrafficShifter(reg, logger)

	// ── Geo Routing ───────────────────────────────────────────────────────────
	geoLookup := routing.GeoLookupFunc(func(ip net.IP) (float64, float64, error) {
		// In production: MaxMind GeoIP2 lookup.
		return 40.7, -74.0, nil // stub: NYC coordinates
	})
	resolver := routing.NewHaversineResolver(reg, geoLookup, logger)
	latRouter := routing.NewLatencyRouter(100, logger)

	// ── Chaos Injector (disabled in production) ────────────────────────────────
	injector := chaos.NewInjector(reg, logger)
	if os.Getenv("CHAOS_ENABLED") != "true" {
		injector = nil
	}

	// ── Failover Controller ────────────────────────────────────────────────────
	fc := failover.NewController(
		failover.DefaultConfig(),
		reg,
		shifter,
		nil, // wire in a Slack/PagerDuty notifier here
		logger,
	)
	go fc.Run(ctx)

	// ── Replication Engine ─────────────────────────────────────────────────────
	// In production, replace InMemoryPublisher/Subscriber with Kafka adapters.
	bus := newInMemoryBus()
	engine := replication.NewEngine(
		"us-east-1",
		bus,
		bus,
		newInMemoryStore(),
		replication.NewVectorClockResolver(func(local, remote *replication.ReplicationEvent) (*replication.ReplicationEvent, error) {
			logger.Warn("true conflict detected - applying LWW fallback",
				"local_ts", local.Timestamp, "remote_ts", remote.Timestamp)
			if remote.Timestamp.After(local.Timestamp) {
				return remote, nil
			}
			return local, nil
		}),
		logger,
	)
	if err := engine.StartConsuming(ctx, []string{"users", "orders"}); err != nil {
		logger.Error("failed to start replication consumer", "err", err)
		os.Exit(1)
	}

	// ── HTTP Server ────────────────────────────────────────────────────────────
	regionMW := middleware.NewRegionRouter(resolver, latRouter, injector, logger)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","region":"us-east-1","score":1.0}`)
	})
	mux.HandleFunc("/api/demo", func(w http.ResponseWriter, r *http.Request) {
		targetRegion := middleware.RegionFromContext(r.Context())
		fmt.Fprintf(w, `{"routed_to":%q}`, targetRegion)
	})

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      regionMW.Middleware(mux),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		logger.Info("server starting", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	logger.Info("shutdown signal received")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "err", err)
	}
	logger.Info("server stopped")
}

// ── In-memory stubs for the demo wire-up ─────────────────────────────────────

type inMemoryBus struct {
	mu   sync.Mutex
	subs map[string][]chan *replication.ReplicationEvent
}

func newInMemoryBus() *inMemoryBus {
	return &inMemoryBus{subs: make(map[string][]chan *replication.ReplicationEvent)}
}

func (b *inMemoryBus) Publish(_ context.Context, topic string, event *replication.ReplicationEvent) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.subs[topic] {
		select {
		case ch <- event:
		default:
		}
	}
	return nil
}

func (b *inMemoryBus) Subscribe(_ context.Context, topic string) (<-chan *replication.ReplicationEvent, error) {
	ch := make(chan *replication.ReplicationEvent, 256)
	b.mu.Lock()
	b.subs[topic] = append(b.subs[topic], ch)
	b.mu.Unlock()
	return ch, nil
}

type inMemoryStore struct {
	mu   sync.RWMutex
	data map[string]*replication.ReplicationEvent
}

func newInMemoryStore() *inMemoryStore {
	return &inMemoryStore{data: make(map[string]*replication.ReplicationEvent)}
}

func (s *inMemoryStore) Get(_ context.Context, table, key string) (*replication.ReplicationEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	k := table + ":" + key
	if v, ok := s.data[k]; ok {
		return v, nil
	}
	return nil, fmt.Errorf("not found: %s", k)
}

func (s *inMemoryStore) Put(_ context.Context, event *replication.ReplicationEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[event.Table+":"+event.Key] = event
	return nil
}
```

> **Note:** The `net` package import is needed in `main.go`. Add `"net"` to the import block alongside the other imports.

---

### Junior -> FAANG: Reading Bootstrap Code as a System Map

The `main.go` bootstrap is a compact dependency graph of the entire system. Reading it teaches you which components depend on which others, in what order they must be initialized, and which ones run as background goroutines (health loop, failover controller) versus inline (HTTP server). This is a skill that transfers to every production codebase you join: read `main.go` first to understand the wiring.

The startup sequence in this file has an implicit ordering constraint: the registry must be populated before the health loop starts, because the health loop iterates `registry.All()`. If you start the health loop before registering any regions, it runs the first iteration against an empty list and does nothing useful. Production bootstrap code makes these ordering constraints explicit, either through documentation or by having each component's constructor accept its dependencies (which only exist if initialized earlier).

The `CHAOS_ENABLED` environment variable gate is worth studying. It sets `injector = nil` in production. This means all the `if rr.injector != nil` guards in the middleware are nil checks, and the production binary pays a small overhead for those checks on every request. An alternative is to use a `noopInjector` that implements the same interface with methods that always return safe defaults, eliminating the nil checks from the hot path.

### Senior @ FAANG: Bootstrap as an Architectural Contract

**Dependency injection versus global state.** The bootstrap explicitly passes each dependency to its consumers (the registry is passed to the health loop, shifter, and failover controller). This is correct dependency injection. The alternative, using package-level global variables, makes testing harder and creates hidden coupling between packages. At L6, you enforce the DI pattern in code review: any package that reads from a package-level global during tests is a red flag.

**Graceful shutdown sequencing.** The bootstrap listens for `SIGINT/SIGTERM`, cancels the root context, and calls `srv.Shutdown`. This triggers the HTTP server to stop accepting new connections and wait for in-flight requests to complete. However, the failover controller and health loop goroutines (`go healthLoop.Run(ctx)`, `go fc.Run(ctx)`) are also canceled by the same context. The shutdown sequencing matters: you want to stop the failover controller before stopping the health loop, and stop both before shutting down the HTTP server, so that the controller does not try to update traffic weights after the server has already drained. The code above relies on context propagation for coordination, which is correct but does not enforce this ordering. A production bootstrap uses a `sync.WaitGroup` to wait for each goroutine to exit before proceeding to the next shutdown phase.

**In-memory stubs as a testing entry point, not a production shortcut.** The `inMemoryBus` and `inMemoryStore` stubs at the bottom of `main.go` allow running the full system locally without Kafka or a database. This is valuable for integration testing and local development. But the comment "replace with real adapters" must be backed by a concrete plan in the project roadmap. At L6, you do not merge a `main.go` with in-memory stubs without an open task to replace them before the service goes to production, because stubs that make it to production are the leading cause of "we thought we were testing this but we weren't" incidents.

**Configuration management at bootstrap time.** All thresholds (health check interval: 15s, drain duration: 2min, failover thresholds: 0.4/0.7) are hardcoded in this file. In production, these come from a configuration service (AWS AppConfig, Google Cloud Runtime Config, or a Kubernetes ConfigMap) that supports hot reloading without redeployment. A staff engineer designs the configuration loading abstraction during bootstrap, not as an afterthought. The key capability is: can you change the failover threshold without redeploying the binary? If not, you cannot tune thresholds during an incident without a deployment cycle.

**Health endpoint completeness.** The `/health` handler returns a hardcoded `score:1.0`. A production health endpoint returns the actual composite health score from the checker, the current region role, current traffic weight, and replication lag. The load balancer and external health checks use this endpoint to make routing decisions. A hardcoded response defeats the purpose of the composite health check entirely.
