## 20.6 Health Checks

### Basic Health Endpoint

A well-designed health endpoint checks every critical dependency, databases, caches, downstream APIs, and reports their individual statuses rather than returning a single binary flag. The `HealthChecker` interface abstracts each dependency behind a `Check` method, making it straightforward to add new checkers without touching the handler logic. The handler runs each check under a short shared timeout and returns `503 Service Unavailable` if any check fails, giving orchestrators an accurate picture of service health.

```go
type HealthChecker interface {
    Check(ctx context.Context) error
}

type DatabaseHealthChecker struct {
    db *sql.DB
}

func (c *DatabaseHealthChecker) Check(ctx context.Context) error {
    return c.db.PingContext(ctx)
}

func healthHandler(checkers map[string]HealthChecker) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
        defer cancel()

        status := map[string]string{}
        healthy := true

        for name, checker := range checkers {
            if err := checker.Check(ctx); err != nil {
                // Log the detail, return only the verdict. See below.
                slog.ErrorContext(ctx, "health check failed",
                    "check", name, "error", err)
                status[name] = "unhealthy"
                healthy = false
            } else {
                status[name] = "healthy"
            }
        }

        w.Header().Set("Content-Type", "application/json")
        if !healthy {
            w.WriteHeader(http.StatusServiceUnavailable)
        }
        json.NewEncoder(w).Encode(status)
    }
}
```

### Do Not Put `err.Error()` in the Response Body

The tempting line is `status[name] = "unhealthy: " + err.Error()`, because it makes debugging easy. It also makes reconnaissance easy, and health endpoints are among the most commonly exposed endpoints in any deployment.

Dependency errors are unusually rich in exactly what an attacker wants: `dial tcp 10.0.3.47:5432: connect: connection refused` hands over your internal topology, your database port, and confirmation of what you run. Driver errors routinely echo back DSNs, and DSNs routinely contain usernames. The endpoint that reports "we are unhealthy" should not also report *why* to an anonymous caller.

Log the error with full detail, where your own engineers can see it and outsiders cannot, and return only the verdict. The pattern generalizes: internal detail goes to logs, verdicts go to responses.

Two other properties matter for a handler that gets called constantly:

**Cache the results.** As written, every request to `/health` pings every dependency. Kubernetes probes this on an interval, your load balancer probes it, your monitoring probes it, and anyone on the internet can probe it as fast as they like. That turns a public endpoint into an amplified denial-of-service against your own database. Run the checks on a background ticker and have the handler serve the last known result, or cache for a few seconds.

**Run the checks concurrently.** The loop above is sequential and every checker shares one 5-second budget, so with several slow dependencies the later checks can find the deadline already consumed and report failures caused by nothing but their position in the map. Run them in parallel with a `sync.WaitGroup` and give the whole set one deadline.

### Kubernetes Probes

Kubernetes distinguishes between two types of probes: liveness checks tell the kubelet whether the process is alive and should be restarted on failure, while readiness checks tell the scheduler whether the pod is ready to receive traffic. Keeping these endpoints separate means a pod can temporarily withdraw from the load-balancer rotation during initialization or a dependency outage without being unnecessarily killed and restarted.

```go
// Liveness: is the app running?
http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
})

// Readiness: can the app accept traffic?
http.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
    if !isReady() {
        w.WriteHeader(http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
})
```

### Liveness vs Readiness Discipline

Common mistake: making liveness dependent on downstream services. If the database is down, Kubernetes kills and restarts pods, which helps nothing (the database is still down). Liveness should return 200 if the process is alive, period. Readiness can depend on downstream, because failing readiness just removes the pod from load balancer until the downstream recovers.

### Staff Lens: Health Check Conventions

Standardize `/healthz` and `/readyz` across services. Expose them on a separate port if possible (admin port) so they are not accessible externally. Document the semantics: liveness checks are local, readiness checks include downstream.

---
