## Section 9: Complete 1M RPS Service Implementation

### 9.1 Service Architecture

The complete 1M-RPS service architecture integrates the optimizations from the preceding sections, zero-copy routing, GC tuning, pooled buffers, and lock-free counters, into a coherent service that can be deployed as a single binary. Note what is absent: HTTP/2 is not in this list, because as the introduction argued it is a semantics choice rather than a throughput optimization for server-to-server traffic. The architecture separates the hot request path from the cold management path (health checks, metrics export, graceful shutdown) so that administrative operations never compete with user-facing latency. The implementation below stitches together these components with an initialization sequence that validates config, warms caches, and confirms system readiness before accepting traffic.

```go
package service

import (
	"context"
	"expvar"
	"fmt"
	"io"
	"math/bits"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
)

// Config is the complete server configuration.
type Config struct {
	HTTPAddr      string
	AdminAddr     string
	Workers       int
	QueueSize     int
	GOGCPercent   int
	MemLimitBytes int64
	EnablePprof   bool
}

// DefaultConfig returns production defaults.
func DefaultConfig() Config {
	return Config{
		HTTPAddr:      ":8080",
		AdminAddr:     ":9090",
		Workers:       runtime.GOMAXPROCS(0) * 4,
		QueueSize:     512 * 1024,
		GOGCPercent:   400,
		MemLimitBytes: 12 * 1024 * 1024 * 1024, // 12GB
		EnablePprof:   true,
	}
}

// Server is the main application server.
type Server struct {
	cfg    Config
	log    *zap.Logger
	pool   *Pool
	router *Router

	// Metrics
	rps     RateTracker
	latency latencyRecorder

	// Admin server for /metrics, /pprof, /debug/vars.
	adminServer *http.Server
	mainServer  *http.Server
}

// latencyRecorder is a lock-free latency histogram sized for the hot path.
// Buckets are power-of-two microsecond ranges, so Record is a bit-scan plus one
// atomic add: no allocation, no lock, no time formatting. `LatencyHistogram`
// from section 8 is a *report* struct produced by a load test, so it has no
// Record method and is the wrong type to reach for here.
type latencyRecorder struct {
	buckets [32]atomic.Uint64
}

// Record files d into its power-of-two bucket.
func (l *latencyRecorder) Record(d time.Duration) {
	us := uint64(d.Microseconds())
	if us == 0 {
		us = 1
	}
	b := bits.Len64(us) - 1
	if b >= len(l.buckets) {
		b = len(l.buckets) - 1
	}
	l.buckets[b].Add(1)
}

// Quantile returns the upper bound of the bucket holding quantile q, so the
// true value is at most what this reports. Resolution is one power of two,
// which is enough to drive an alert and not enough to drive a tuning decision.
// When you need exact percentiles, use an HDR histogram or your metrics
// backend's native summary type.
func (l *latencyRecorder) Quantile(q float64) time.Duration {
	var counts [32]uint64
	var total uint64
	for i := range l.buckets {
		counts[i] = l.buckets[i].Load()
		total += counts[i]
	}
	if total == 0 {
		return 0
	}
	target := uint64(float64(total) * q)
	var seen uint64
	for i, c := range counts {
		seen += c
		if seen >= target {
			return time.Duration(uint64(1)<<uint(i+1)) * time.Microsecond
		}
	}
	return time.Duration(uint64(1)<<uint(len(counts))) * time.Microsecond
}

func NewServer(cfg Config, log *zap.Logger) (*Server, error) {
	s := &Server{
		cfg:  cfg,
		log:  log,
		pool: NewPool(cfg.Workers, cfg.QueueSize),
	}

	// Apply runtime tuning.
	debug.SetGCPercent(cfg.GOGCPercent)
	if cfg.MemLimitBytes > 0 {
		debug.SetMemoryLimit(cfg.MemLimitBytes)
	}

	// Build router.
	s.router = NewRouter()
	s.registerRoutes()

	// Build main server.
	s.mainServer = NewHighPerfServer(DefaultServerConfig(cfg.HTTPAddr), s.router)

	// Build admin server.
	adminMux := http.NewServeMux()
	s.registerAdminRoutes(adminMux)
	s.adminServer = &http.Server{
		Addr:    cfg.AdminAddr,
		Handler: adminMux,
	}

	return s, nil
}

func (s *Server) registerRoutes() {
	// Health check. The response body is hoisted out of the handler so it is
	// not rebuilt per call. This is not an allocation-free path: net/http
	// allocates per-response header state regardless of what the handler does.
	healthResp := []byte(`{"status":"ok"}`)
	s.router.GET("/health", func(w http.ResponseWriter, r *http.Request, _ Params) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write(healthResp)
	})

	s.router.GET("/api/v1/users/:id", s.handleGetUser)
	s.router.POST("/api/v1/users", s.handleCreateUser)
	s.router.GET("/api/v1/products/:id", s.handleGetProduct)
}

func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request, p Params) {
	userID := p.Get("id")
	if userID == "" {
		http.Error(w, "missing user id", http.StatusBadRequest)
		return
	}

	start := time.Now()
	s.rps.Record(1)

	// Process request. In production: cache lookup, then DB fallback.
	resp := s.getUserResponse(r.Context(), userID)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.WriteHeader(http.StatusOK)
	w.Write(resp)

	s.latency.Record(time.Since(start))
}

const maxBodyBytes = 1 << 20 // 1 MB

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request, _ Params) {
	// Parse body from pool. AcquireBuffer hands back a zero-length slice that
	// still has its capacity, so we must read into that capacity and re-slice.
	// Calling r.Body.Read(*buf) directly would pass a zero-length slice and
	// return n=0, err=nil immediately, silently accepting an empty body.
	buf := AcquireBuffer()
	defer ReleaseBuffer(buf)

	body, err := readAllInto(buf, http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}

	// Validate and process `body` here.
	_ = body

	w.WriteHeader(http.StatusCreated)
	w.Write([]byte(`{"id":"new-user-id"}`))
}

// readAllInto fills *buf from r, growing the buffer only when a request
// exceeds the pooled capacity. The common case reuses the pooled array and
// allocates nothing.
func readAllInto(buf *[]byte, r io.Reader) ([]byte, error) {
	for {
		if len(*buf) == cap(*buf) {
			*buf = append(*buf, 0)[:len(*buf)]
		}
		n, err := r.Read((*buf)[len(*buf):cap(*buf)])
		*buf = (*buf)[:len(*buf)+n]
		if err != nil {
			if err == io.EOF {
				return *buf, nil
			}
			return *buf, err
		}
	}
}

func (s *Server) handleGetProduct(w http.ResponseWriter, r *http.Request, p Params) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func (s *Server) getUserResponse(_ context.Context, userID string) []byte {
	// In production: L1 (ristretto) → L2 (Redis) → DB lookup.
	buf := AcquireBuffer()
	*buf = append(*buf, `{"id":"`...)
	*buf = append(*buf, userID...)
	*buf = append(*buf, `","name":"John Doe"}`...)
	result := make([]byte, len(*buf))
	copy(result, *buf)
	ReleaseBuffer(buf)
	return result
}

func (s *Server) registerAdminRoutes(mux *http.ServeMux) {
	// /debug/vars serves expvar metrics.
	mux.Handle("/debug/vars", expvar.Handler())

	// /metrics serves Prometheus format.
	mux.HandleFunc("/metrics", s.handleMetrics)

	// /health/ready is the readiness probe.
	mux.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ready"))
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	stats := CollectGCStats()
	fmt.Fprintf(w, "# HELP go_rps Requests per second\n")
	fmt.Fprintf(w, "go_rps %.2f\n", s.rps.RatePerSecond())
	fmt.Fprintf(w, "# HELP go_latency_seconds Upper bound of the bucket holding each quantile\n")
	fmt.Fprintf(w, "go_latency_seconds{quantile=\"0.5\"} %.6f\n", s.latency.Quantile(0.50).Seconds())
	fmt.Fprintf(w, "go_latency_seconds{quantile=\"0.99\"} %.6f\n", s.latency.Quantile(0.99).Seconds())
	fmt.Fprintf(w, "go_gc_num_gc %d\n", stats.NumGC)
	fmt.Fprintf(w, "go_heap_inuse_bytes %d\n", stats.HeapInuse)
	fmt.Fprintf(w, "go_heap_objects %d\n", stats.HeapObjects)
}

// Run starts the server and blocks until shutdown.
func (s *Server) Run(ctx context.Context) error {
	g, ctx := errgroup.WithContext(ctx)

	// Main HTTP server.
	g.Go(func() error {
		ln, err := ListenWithReusePort("tcp", s.cfg.HTTPAddr)
		if err != nil {
			return fmt.Errorf("listen: %w", err)
		}
		s.log.Info("HTTP server started", zap.String("addr", s.cfg.HTTPAddr))
		return s.mainServer.Serve(ln)
	})

	// Admin server.
	g.Go(func() error {
		s.log.Info("Admin server started", zap.String("addr", s.cfg.AdminAddr))
		return s.adminServer.ListenAndServe()
	})

	// Graceful shutdown on signal.
	g.Go(func() error {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		select {
		case sig := <-sigCh:
			s.log.Info("Shutting down", zap.String("signal", sig.String()))
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				s.mainServer.Shutdown(shutdownCtx)
			}()
			go func() {
				defer wg.Done()
				s.adminServer.Shutdown(shutdownCtx)
			}()
			wg.Wait()
			s.pool.Shutdown()
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})

	return g.Wait()
}
```

### 9.2 Main Entrypoint

The `main` function is the wiring harness that constructs dependencies in topological order, registers signal handlers for graceful shutdown, and starts the listener only after all components are initialized and healthy. Deferring listener creation to the last step prevents clients from connecting before the service is ready and eliminates the window during which requests would fail with half-initialized state. The entrypoint below also installs a panic handler that logs the stack trace and attempts a graceful shutdown before the process exits.

```go
package main

import (
	"context"
	"os"
	"strconv"

	"go.uber.org/zap"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

	cfg := DefaultConfig()

	// Override from environment variables.
	if addr := os.Getenv("HTTP_ADDR"); addr != "" {
		cfg.HTTPAddr = addr
	}
	if workers := os.Getenv("WORKERS"); workers != "" {
		if n, err := strconv.Atoi(workers); err == nil {
			cfg.Workers = n
		}
	}

	srv, err := NewServer(cfg, log)
	if err != nil {
		log.Fatal("create server", zap.Error(err))
	}

	ctx := context.Background()
	if err := srv.Run(ctx); err != nil && err != context.Canceled {
		log.Fatal("server error", zap.Error(err))
	}
}
```

### 9.3 The readiness contract

The code above splits main and admin servers, which is correct but not the whole story. A 1M RPS service must distinguish liveness from readiness and must wire both signals to something the LB and the orchestrator (Kubernetes, Nomad, ECS) actually consumes. Liveness answers "should you kill and restart me," which is almost never the right question outside of deadlock or fatal state corruption, and most services should implement a trivial always-ok liveness probe. Readiness answers "should you send me traffic right now," which is the expensive question. A proper readiness check validates downstream connectivity (can I reach Redis, Postgres, the auth service), validates warmup state (are my caches primed, is my JIT hot, have I preloaded my routing table), and returns not-ready with a short cool-down after a spike in 5xx. The difference matters at the LB layer. A slow or flapping readiness probe takes the pod out of rotation for 10 to 30 seconds, which is often the right answer during transient downstream trouble. A liveness probe that returns not-ok triggers a kill, which is almost always wrong under normal operating conditions. Encode the difference explicitly in the code, not as an afterthought.

### 9.4 Junior → FAANG: the first-90-days checklist for owning a high-throughput service

When you take over a service like the one in this section, do the following in order during your first 90 days. Week one, read the SLO and the runbook, and if either is missing, that is the highest-priority item. Week two, run `wrk` and `pprof` against a staging replica and produce a baseline report. Week three, inventory every tuning knob (GOGC, GOMEMLIMIT, GOMAXPROCS, pool sizes, timeouts) and write a one-line justification for each. Week four, read the last three incidents and the last three deploys that were rolled back. Week five onward, pair with whoever owns the upstream and downstream services and build a capacity model. Week twelve, write a one-page "state of the service" document that covers load, cost, SLO compliance, technical debt, and the next three things worth doing. Share it with your skip-level. This pattern, more than any specific performance technique, is what gets junior engineers promoted at FAANG.

### 9.5 Senior @ FAANG: the launch-review checklist for 1M RPS

Before this service goes live, a staff engineer should be able to answer yes to every item on this list. Capacity model exists and covers peak plus growth for the next two quarters. SLO is signed off by the business owner and wired to alerting. Load tests have been run at 2x projected peak and the service did not regress p99 by more than 20 percent. Chaos tests (a downstream outage, a config pusher deploying bad config, a node loss) have run and the service either degraded gracefully or failed fast with alerting. Rollback is documented and tested (not just "we can redeploy the old binary," but "we have a traffic shift plan that can move 100 percent of traffic back in under two minutes"). Dashboards exist for RPS, p50/p99/p999, error rate, GC CPU share, goroutine count, open file descriptors, and downstream pool saturation. On-call is trained, paged through the runbook, and has shadowed one real incident. Missing any single item is a launch-blocking risk. The time to find out is during the review, not during the first 3 AM page.

---
