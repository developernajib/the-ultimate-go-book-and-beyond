## 102D.5 Rolling Updates

A rolling update replaces old pods with new ones incrementally without taking the service offline. Kubernetes controls the pace through `maxSurge` (how many extra pods can exist during the rollout) and `maxUnavailable` (how many pods can be absent at any point). Setting `minReadySeconds` prevents traffic from reaching a new pod until it has been passing health checks for a minimum duration, reducing the risk of partially-started containers receiving production requests.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shopapp-api
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2        # max pods ABOVE desired count during update (20%)
      maxUnavailable: 0  # zero-downtime: never reduce below desired count

  selector:
    matchLabels:
      app: shopapp-api

  template:
    spec:
      # Readiness gate: pod only receives traffic when probe succeeds
      containers:
        - name: api
          image: myorg/shopapp-api:v1.6.0
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10

      # Graceful shutdown: wait for in-flight requests
      terminationGracePeriodSeconds: 30

      # Allow pod to drain before termination
      lifecycle:
        preStop:
          exec:
            command: ["/bin/sh", "-c", "sleep 5"]
```

### PodDisruptionBudget - Protect During Updates

A `PodDisruptionBudget` (PDB) caps voluntary disruptions. Node drains, cluster upgrades, and rolling updates all respect it. Without a PDB, a node drain could terminate multiple pods simultaneously, collapsing availability below what `maxUnavailable` alone can guarantee, because `maxUnavailable` only constrains the Deployment controller, not the node drain path.

```yaml
# Ensure at least 80% of pods are always available
# during voluntary disruptions (node drains, rolling updates)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shopapp-api-pdb
spec:
  selector:
    matchLabels:
      app: shopapp-api
  minAvailable: "80%"  # or use maxUnavailable: "20%"
```

### Go Application - Graceful Shutdown

Kubernetes sends `SIGTERM` before killing a pod, but the kubelet removes the pod from `Endpoints` asynchronously. Traffic can still arrive for several seconds after the signal. The pattern below uses an `atomic.Bool` readiness flag to start refusing new requests immediately on `SIGTERM`, sleeps for 15 seconds to drain in-flight connections, then calls `http.Server.Shutdown` which waits for active handlers to finish before closing the listener.

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "sync/atomic"
    "syscall"
    "time"
)

type Server struct {
    httpServer *http.Server
    logger     *slog.Logger
    ready      atomic.Bool
}

func NewServer(addr string, logger *slog.Logger) *Server {
    s := &Server{logger: logger}

    mux := http.NewServeMux()
    mux.HandleFunc("/health", s.healthHandler)
    mux.HandleFunc("/ready", s.readinessHandler)
    mux.HandleFunc("/api/", s.apiHandler)

    s.httpServer = &http.Server{
        Addr:         addr,
        Handler:      mux,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    return s
}

func (s *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ok"))
}

func (s *Server) readinessHandler(w http.ResponseWriter, r *http.Request) {
    if !s.ready.Load() {
        http.Error(w, "not ready", http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ready"))
}

func (s *Server) apiHandler(w http.ResponseWriter, r *http.Request) {
    // Check readiness before processing (graceful shutdown)
    if !s.ready.Load() {
        http.Error(w, "shutting down", http.StatusServiceUnavailable)
        return
    }
    // Handle request...
    w.WriteHeader(http.StatusOK)
}

func (s *Server) Run(ctx context.Context) error {
    // Mark ready after initialization
    s.ready.Store(true)
    s.logger.Info("server ready", "addr", s.httpServer.Addr)

    // Listen for shutdown signals
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        if err := s.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            s.logger.Error("server error", "err", err)
        }
    }()

    select {
    case sig := <-quit:
        s.logger.Info("shutdown signal received", "signal", sig)
    case <-ctx.Done():
        s.logger.Info("context canceled")
    }

    // Mark not-ready: Kubernetes will stop sending new traffic
    // after readiness probe fails (5s * 3 = 15s drain time)
    s.ready.Store(false)
    s.logger.Info("marked not-ready, waiting for traffic drain")
    time.Sleep(15 * time.Second)

    // Graceful shutdown: wait for in-flight requests up to 30s
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := s.httpServer.Shutdown(shutdownCtx); err != nil {
        return fmt.Errorf("server shutdown: %w", err)
    }

    s.logger.Info("server stopped cleanly")
    return nil
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    srv := NewServer(":8080", logger)
    if err := srv.Run(context.Background()); err != nil {
        logger.Error("server run error", "err", err)
        os.Exit(1)
    }
}
```

### Junior → FAANG: Graceful Shutdown as a Production Habit

The graceful shutdown pattern in this file is something most junior engineers encounter only after causing a production incident. A common scenario: a pod receives SIGTERM, the process exits immediately, and in-flight requests return connection reset errors to users. The fix involves understanding why the race exists.

Kubernetes removes a pod from the Service endpoints list asynchronously: the kubelet sends SIGTERM at roughly the same time as the endpoints controller updates the Endpoints object, but neither action is guaranteed to complete first. Traffic can continue arriving for 2-5 seconds after SIGTERM. The `preStop` sleep buys time for the Endpoints update to propagate. The readiness flag failing immediately on SIGTERM tells the kube-proxy to stop routing new connections. Together they ensure no new requests arrive after the application starts shutting down.

The code pattern to memorize: `atomic.Bool` for the readiness flag (safe for concurrent reads from the readiness handler), `time.Sleep` in the preStop period (wait for traffic drain), then `http.Server.Shutdown` (wait for active handlers). Do not call `os.Exit`. Let the shutdown complete cleanly.

### Senior @ FAANG: Shutdown Sequencing as a Platform Contract

At senior level, graceful shutdown is a platform contract, not an individual application concern. If every service implements its own shutdown logic, the organization has 200 different shutdown behaviors, some of which are subtly wrong. The correct approach is to provide a shared shutdown helper in the organization's internal Go module that implements the correct sequence: receive signal, mark not-ready, sleep preStop duration from an environment variable, drain with configurable timeout, then exit cleanly.

The `terminationGracePeriodSeconds` value must be coordinated with the `preStop` sleep and the `http.Server.Shutdown` timeout. A common misconfiguration: `preStop` sleep of 15 seconds plus shutdown timeout of 30 seconds totals 45 seconds, but `terminationGracePeriodSeconds` is set to 30 seconds. Kubernetes kills the process with SIGKILL at 30 seconds, interrupting active requests mid-flight. The rule: `terminationGracePeriodSeconds` must be greater than `preStop` sleep plus `Shutdown` timeout, with at least 10 seconds of buffer for overhead.

PodDisruptionBudgets are a coordination primitive between the deployment controller and the cluster autoscaler. At scale, organizations run both rolling updates and cluster autoscaling simultaneously. Without a PDB, the autoscaler can drain a node containing 4 pods from a 10-pod Deployment while the rolling update is also removing pods, resulting in 6 simultaneous pod terminations when the maxUnavailable budget is only 2. The PDB is the only mechanism that prevents this combination from violating availability guarantees. Every production Deployment with a defined SLA must have a PDB as a platform requirement, enforced through Conftest policy in CI.

---
