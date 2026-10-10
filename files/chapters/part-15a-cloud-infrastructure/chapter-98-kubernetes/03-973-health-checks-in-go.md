## 98.3 Health Checks in Go

### Implementing Health Endpoints

Kubernetes uses two distinct probes for different failure modes: the liveness probe determines whether the process has deadlocked or crashed and should be restarted, while the readiness probe determines whether the Pod is healthy enough to receive traffic from a Service. Conflating them is a common mistake, a readiness failure that removes a Pod from load balancing rotation is far safer than a liveness failure that triggers a restart loop. The implementation below keeps them separate: the liveness handler always returns 200 as long as the Go process is alive, while the readiness handler actively pings the database and Redis within a 2-second deadline so that dependency outages pull the Pod out of rotation without killing it.

```go
package main

import (
    "context"
    "database/sql"
    "encoding/json"
    "net/http"
    "os"
    "sync/atomic"
    "time"

    "github.com/redis/go-redis/v9"
)

type HealthChecker struct {
    db      *sql.DB
    redis   *redis.Client
    ready   atomic.Bool
}

func NewHealthChecker(db *sql.DB, redis *redis.Client) *HealthChecker {
    return &HealthChecker{db: db, redis: redis}
}

func (h *HealthChecker) SetReady(ready bool) {
    h.ready.Store(ready)
}

// Liveness - Is the process alive?
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

// Readiness - Can we serve traffic?
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    if !h.ready.Load() {
        http.Error(w, "Not ready", http.StatusServiceUnavailable)
        return
    }

    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    // Check database
    if err := h.db.PingContext(ctx); err != nil {
        http.Error(w, "Database unavailable", http.StatusServiceUnavailable)
        return
    }

    // Check Redis
    if err := h.redis.Ping(ctx).Err(); err != nil {
        http.Error(w, "Redis unavailable", http.StatusServiceUnavailable)
        return
    }

    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
}

func appHandler(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("Hello, Kubernetes!"))
}

func main() {
    // Initialize dependencies
    db, _ := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    redisClient := redis.NewClient(&redis.Options{Addr: "redis:6379"})

    health := NewHealthChecker(db, redisClient)

    mux := http.NewServeMux()
    mux.HandleFunc("/health/live", health.LivenessHandler)
    mux.HandleFunc("/health/ready", health.ReadinessHandler)
    mux.HandleFunc("/", appHandler)

    // Mark ready after initialization
    health.SetReady(true)

    server := &http.Server{Addr: ":8080", Handler: mux}
    server.ListenAndServe()
}
```

---

### Junior → FAANG: Health Checks as the Kubernetes Safety Net

Health checks are how Kubernetes knows whether your service is working. Without them, a pod that is running but stuck in a deadlock or serving 500 errors will continue to receive traffic indefinitely. With correctly configured liveness and readiness probes, Kubernetes restarts stuck pods and removes unhealthy pods from the Service endpoint list.

The distinction between liveness and readiness is fundamental. Liveness answers: "should this container be restarted?" A liveness failure means the container is in an unrecoverable state. Readiness answers: "should this container receive traffic?" A readiness failure means the container is temporarily unable to serve (during startup, during a database reconnect, under heavy load). Failing readiness should not restart the container. It should just remove it from the load balancer until it recovers.

First-job mistake: making the liveness probe check too many dependencies. If the liveness probe checks the database connection and the database goes down, all pods fail their liveness checks and Kubernetes restarts all of them simultaneously, making the outage worse. Liveness probes should check only that the process itself is alive and responding, not downstream dependencies.

### Senior @ FAANG: Health Check Architecture and Probe Tuning

At staff level, health check design is a reliability engineering problem. The wrong probe configuration is a source of self-inflicted incidents: liveness probes that are too sensitive cause flapping (repeated restarts of otherwise healthy pods), and readiness probes that are too loose cause traffic to be routed to pods that are not ready to serve.

The startup probe is an underused feature that solves a specific problem: services with long initialization times (database schema migrations, loading large config files) that would fail liveness probes during startup. Setting `startupProbe.failureThreshold` to cover the maximum startup time and then relying on liveness and readiness probes for steady-state behavior is the correct pattern.

For high-traffic services, the readiness probe interacts with the HPA and cluster autoscaler in ways that require careful design. When the cluster autoscaler adds a new node and a new pod starts, the readiness probe determines when that pod begins receiving traffic. If the probe passes too early (before the application's connection pool is warmed up), the pod receives traffic it cannot handle efficiently, causing a latency spike during scale-out. Adding an intentional delay or a warm-up phase before passing readiness is the production pattern for latency-sensitive services. This is a service-specific decision that needs to be documented in the service's deployment guide.
