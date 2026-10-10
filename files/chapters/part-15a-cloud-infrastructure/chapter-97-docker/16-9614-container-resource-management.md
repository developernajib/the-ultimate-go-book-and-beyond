## 97.16 Container Resource Management

### GOMAXPROCS and CPU Limits

One of the most common Go-in-Docker issues is incorrect GOMAXPROCS:

```go
package main

import (
    "log"
    "runtime"

    _ "go.uber.org/automaxprocs" // Automatically sets GOMAXPROCS
)

func main() {
    // Without automaxprocs, GOMAXPROCS defaults to host CPU count
    // In a container limited to 1 CPU, Go might create 16 goroutines for
    // parallelism on a 16-core host, causing contention

    log.Printf("GOMAXPROCS: %d", runtime.GOMAXPROCS(0))
    // With automaxprocs: GOMAXPROCS: 1 (matching container limit)
    // Without: GOMAXPROCS: 16 (host CPUs)
}
```

```yaml
# docker-compose.yml with resource limits
version: '3.8'

services:
  api:
    image: myapp:latest
    environment:
      # Manual GOMAXPROCS if not using automaxprocs
      - GOMAXPROCS=2
    deploy:
      resources:
        limits:
          cpus: '2'      # 2 CPU cores max
          memory: 512M   # 512MB RAM max
        reservations:
          cpus: '0.5'    # Minimum 0.5 CPU
          memory: 128M   # Minimum 128MB RAM
```

### Memory Management in Containers

Go 1.19 introduced `GOMEMLIMIT`, a soft memory limit that tells the garbage collector to work harder to keep memory usage below a specified threshold. In a container with a 512MB memory limit, you should set `GOMEMLIMIT` to roughly 90% of that (about 460MB), leaving headroom for the operating system and other overhead. Without this setting, Go's garbage collector does not know about your container's memory limit and may allow heap growth that triggers an out-of-memory (OOM) kill from the container runtime.

```go
package main

import (
    "log"
    "os"
    "runtime"
    "runtime/debug"
    "strconv"
)

func configureRuntime() {
    // Read container memory limit
    memLimit := getContainerMemoryLimit()
    if memLimit > 0 {
        // Set GOMEMLIMIT (Go 1.19+) to ~90% of container limit
        // Leaves headroom for OS/system overhead
        goMemLimit := int64(float64(memLimit) * 0.9)
        debug.SetMemoryLimit(goMemLimit)
        log.Printf("GOMEMLIMIT set to %d bytes (%.0f%% of %d)",
            goMemLimit, 90.0, memLimit)
    }

    // Optionally adjust GC target
    // Higher = less GC, more memory - Lower = more GC, less memory
    debug.SetGCPercent(100) // Default is 100
}

func getContainerMemoryLimit() int64 {
    // Method 1: GOMEMLIMIT environment variable
    if limit := os.Getenv("GOMEMLIMIT"); limit != "" {
        if val, err := strconv.ParseInt(limit, 10, 64); err == nil {
            return val
        }
    }

    // Method 2: Read from cgroup (v2)
    if data, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
        if val, err := strconv.ParseInt(string(data[:len(data)-1]), 10, 64); err == nil {
            return val
        }
    }

    // Method 3: Read from cgroup (v1)
    if data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); err == nil {
        if val, err := strconv.ParseInt(string(data[:len(data)-1]), 10, 64); err == nil {
            // Check if not unlimited
            if val < 1<<62 {
                return val
            }
        }
    }

    return 0 // Unknown/unlimited
}

func main() {
    configureRuntime()

    log.Printf("Runtime stats: CPUs=%d, GOMAXPROCS=%d",
        runtime.NumCPU(), runtime.GOMAXPROCS(0))

    // ... rest of application
}
```

### Container Health Monitoring

A production-grade health check system in Go should distinguish between liveness (is the process alive and not deadlocked?) and readiness (is the application ready to handle traffic?). Kubernetes and other orchestrators use these two signals differently: a failed liveness probe triggers a container restart, while a failed readiness probe temporarily removes the container from the load balancer. The health checker below also reports memory statistics and dependency status, giving operators visibility into the container's internal state.

```go
package health

import (
    "context"
    "encoding/json"
    "net/http"
    "runtime"
    "sync/atomic"
    "time"
)

type HealthChecker struct {
    ready     atomic.Bool
    dbHealthy atomic.Bool
    checks    []HealthCheck
}

type HealthCheck struct {
    Name    string
    Check   func(context.Context) error
    Timeout time.Duration
}

type HealthStatus struct {
    Status    string            `json:"status"`
    Checks    map[string]string `json:"checks"`
    Uptime    string            `json:"uptime"`
    GoVersion string            `json:"go_version"`
    Memory    MemoryStats       `json:"memory"`
}

type MemoryStats struct {
    Alloc      uint64 `json:"alloc_mb"`
    TotalAlloc uint64 `json:"total_alloc_mb"`
    Sys        uint64 `json:"sys_mb"`
    NumGC      uint32 `json:"num_gc"`
}

var startTime = time.Now()

func NewHealthChecker() *HealthChecker {
    return &HealthChecker{}
}

func (h *HealthChecker) AddCheck(name string, check func(context.Context) error, timeout time.Duration) {
    h.checks = append(h.checks, HealthCheck{
        Name:    name,
        Check:   check,
        Timeout: timeout,
    })
}

func (h *HealthChecker) SetReady(ready bool) {
    h.ready.Store(ready)
}

// LivenessHandler - Is the container alive?
// Used by Kubernetes livenessProbe
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
    // Liveness = application not deadlocked
    // Simple response is enough
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

// ReadinessHandler - Is the container ready to receive traffic?
// Used by Kubernetes readinessProbe
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    if !h.ready.Load() {
        http.Error(w, "Not ready", http.StatusServiceUnavailable)
        return
    }

    // Check all dependencies
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    status := HealthStatus{
        Status:    "healthy",
        Checks:    make(map[string]string),
        Uptime:    time.Since(startTime).String(),
        GoVersion: runtime.Version(),
    }

    var memStats runtime.MemStats
    runtime.ReadMemStats(&memStats)
    status.Memory = MemoryStats{
        Alloc:      memStats.Alloc / 1024 / 1024,
        TotalAlloc: memStats.TotalAlloc / 1024 / 1024,
        Sys:        memStats.Sys / 1024 / 1024,
        NumGC:      memStats.NumGC,
    }

    healthy := true
    for _, check := range h.checks {
        checkCtx, checkCancel := context.WithTimeout(ctx, check.Timeout)
        if err := check.Check(checkCtx); err != nil {
            status.Checks[check.Name] = "unhealthy: " + err.Error()
            healthy = false
        } else {
            status.Checks[check.Name] = "healthy"
        }
        checkCancel()
    }

    if !healthy {
        status.Status = "unhealthy"
        w.WriteHeader(http.StatusServiceUnavailable)
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(status)
}
```

---

### Junior → FAANG: Resource Limits as a Correctness Requirement, Not an Optimization

Many engineers treat CPU and memory limits as optional performance tuning that can be added later. This is wrong. Without limits, a single misbehaving container can consume all CPU or memory on a host, causing other services to fail. In a Kubernetes cluster without resource limits, the scheduler cannot make informed placement decisions, and the cluster is effectively unmanaged.

The GOMAXPROCS issue is a concrete Go-specific correctness problem. By default, Go sets GOMAXPROCS to the number of logical CPUs visible to the process. Inside a container with a CPU limit of 0.5, the Go runtime sees all CPUs on the host (say, 32) and creates a goroutine scheduler with 32 Ps. This causes the scheduler to over-spin, burning CPU cycles on scheduling overhead and potentially causing the container to exceed its CPU limit and get throttled. The fix is to use `uber-go/automaxprocs` which reads the cgroup CPU quota and sets GOMAXPROCS accordingly.

The GOMEMLIMIT variable (available since Go 1.19) similarly addresses a GC correctness problem. Without it, the Go GC does not know the container's memory limit and may allow heap growth that triggers an OOM kill. Setting `GOMEMLIMIT` slightly below the container memory limit (to leave room for non-heap allocations) makes the GC more aggressive before the OOM threshold is reached.

### Senior @ FAANG: Resource Management as Cluster Efficiency Engineering

At staff level, resource management is a cost optimization and reliability problem simultaneously. Under-provisioning causes latency spikes and OOM kills. Over-provisioning wastes money. The goal is accurate sizing, which requires measurement over time rather than guesswork at service launch.

The platform-level tool for this is Vertical Pod Autoscaler (VPA) in recommendation mode: it analyzes actual CPU and memory usage over time and suggests right-sized resource requests and limits. Reviewing VPA recommendations across all services on a quarterly basis is a meaningful cost reduction activity, and documenting it as a periodic process in the platform team's operating procedures is an L6/L7 contribution.

The request/limit ratio is a subtle but important design decision. Setting requests equal to limits (Guaranteed QoS class in Kubernetes) gives predictable performance but wastes cluster capacity when the service is idle. Setting requests significantly lower than limits (Burstable QoS) allows better bin-packing but means the scheduler's placement decisions are based on a value that does not reflect peak usage. For latency-sensitive services, Guaranteed QoS is usually the right choice. For batch workloads, Burstable with careful limit setting is more cost-efficient. This is a per-workload-tier decision that should be documented in service tier standards rather than left to each team to decide independently.

Cluster-level bin-packing efficiency is a cost metric that staff engineers own. A cluster with 40% average CPU utilization across nodes is spending 60% of node cost on idle capacity. The levers are: accurate resource requests (from VPA recommendations), horizontal pod autoscaling tuned to scale down aggressively, and node autoscaling with appropriate bin-packing algorithms (Karpenter versus Cluster Autoscaler). The staff contribution is to design the autoscaling strategy, set the efficiency target, and build the monitoring that tracks progress against it.
