## 98.9 Production Pitfalls: Kubernetes Mistakes

### Pitfall 1: Confusing Liveness and Readiness Probes

**Real Incident Report**: A team set the liveness probe to check their database connection. When the database had a brief hiccup, Kubernetes killed all pods (liveness failed) at the same time, causing a complete outage. Liveness should check if the process is healthy, not if dependencies are available.

**The Anti-Pattern**:
```yaml
# WRONG: Liveness checks external dependencies
livenessProbe:
  httpGet:
    path: /health        # Checks DB, Redis, etc.
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
# DB goes down → All pods killed → Total outage
```

**The Better Approach**:
```yaml
# RIGHT: Separate concerns
livenessProbe:
  httpGet:
    path: /livez         # "Am I deadlocked?"
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
  # Only restarts if process is unhealthy

readinessProbe:
  httpGet:
    path: /readyz        # "Can I serve traffic?"
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
  # Removes from service if dependencies unavailable
```

```go
// Liveness: Is the process working?
func livezHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
}

// Readiness: Can I serve traffic?
func readyzHandler(w http.ResponseWriter, r *http.Request) {
    if err := db.Ping(); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
}
```

**Key Insight**: Liveness = "should I restart this?" Readiness = "should I route traffic here?" Different questions, different probes.

### Pitfall 2: Not Handling Graceful Shutdown

**Real Incident Report**: During deployments, users saw 502 errors. Pods were being terminated while still handling requests. The app wasn't catching SIGTERM and draining connections - it just died, dropping in-flight requests.

**The Anti-Pattern**:
```go
// WRONG: Ignores SIGTERM
func main() {
    http.ListenAndServe(":8080", handler)
    // Killed immediately on pod termination
}
```

**The Better Approach**:
```go
func main() {
    srv := &http.Server{Addr: ":8080", Handler: handler}

    // Start server
    go func() {
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()

    // Wait for SIGTERM
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM)
    <-quit

    // Graceful shutdown with timeout
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    log.Println("Shutting down gracefully...")
    if err := srv.Shutdown(ctx); err != nil {
        log.Fatal("Forced shutdown:", err)
    }
}
```

```yaml
# In deployment - give app time to drain
spec:
  terminationGracePeriodSeconds: 60
  containers:
  - name: app
    lifecycle:
      preStop:
        exec:
          command: ["sleep", "5"]  # Let endpoints update
```

**Key Insight**: Kubernetes sends SIGTERM, then waits `terminationGracePeriodSeconds`, then SIGKILL. Use that time to drain.

### Pitfall 3: No Resource Requests/Limits

**Real Incident Report**: One pod had a memory leak and consumed all node memory, causing the kubelet to OOM-kill other pods - including critical services. Setting memory limits would have contained the damage to the leaking pod.

**The Anti-Pattern**:
```yaml
# WRONG: No resource constraints
spec:
  containers:
  - name: app
    image: myapp:latest
    # No requests or limits
    # Can consume unlimited resources
    # Scheduler has no guidance
```

**The Better Approach**:
```yaml
# RIGHT: Proper resource management
spec:
  containers:
  - name: app
    image: myapp:latest
    resources:
      requests:
        cpu: "100m"       # Scheduling guarantee
        memory: "128Mi"   # Scheduling guarantee
      limits:
        cpu: "2"          # Hard CFS quota ceiling
        memory: "512Mi"   # Kernel cgroup OOM ceiling
    env:
    - name: GOMEMLIMIT
      value: "450MiB"     # 88% of container memory limit (Go 1.19+)
```

```go
// Match Go runtime scheduler to Linux CFS cgroup quota
import _ "go.uber.org/automaxprocs"
```

**Key Insight**: Requests are for scheduling, limits are for protection. Set both, match GOMAXPROCS to CPU limits, and configure `GOMEMLIMIT` below the container memory limit.

#### The CFS Quota Thrashing & GOMEMLIMIT Non-Heap Gotcha

As analyzed in [What running go in kubernates taught me the hard way](https://medium.com/@yaninyzwitty/what-running-go-in-kubernates-taught-me-the-hard-way) by Yaninyz witty, Go runtime internals interact with Linux cgroups in counter-intuitive ways:

1. **CFS Quota Scheduler Thrashing**: By default, `runtime.NumCPU()` and `runtime.GOMAXPROCS(0)` inspect the underlying node's hardware threads. On a 64-core node with a pod CPU limit of `2000m` (2 cores), Go spawns 64 logical processor threads (P in the GMP runtime model). All 64 threads contend for execution slices within the Linux Completely Fair Scheduler (CFS) period (`cpu.cfs_period_us`, typically 100ms). The 2-core budget (`cpu.cfs_quota_us = 200000`) is exhausted within the first 15ms of each window, causing severe CPU throttling and wasting up to 40% of runtime CPU time in thread context switching. Importing `go.uber.org/automaxprocs` dynamically binds `GOMAXPROCS` to the container's fractional quota floor(quota) (e.g. floor(2.5) = 2).
2. **The Memory Limit Non-Heap Allocation Trap**: `GOMEMLIMIT` (introduced in Go 1.19) informs the Go runtime garbage collector to become more aggressive as heap usage nears the specified target. However, `GOMEMLIMIT` only governs the managed Go heap. Stack allocations across tens of thousands of goroutines, OS thread memory, memory-mapped files (`mmap`), and Cgo memory (`malloc` within C libraries such as image decoders, sqlite, or rocksdb) are not tracked by the Go GC. If Cgo consumes 200MiB outside the Go heap, the container can still be OOM-killed by the Linux kernel while `pprof` reports heap memory well within limits.

### Pitfall 4: Storing Secrets in ConfigMaps or Code

**Real Incident Report**: A team stored database passwords in ConfigMaps. An intern with read-only Kubernetes access saw all production credentials in plaintext. ConfigMaps are not encrypted and are visible to anyone with cluster access.

**The Anti-Pattern**:
```yaml
# WRONG: Secrets in ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DATABASE_URL: "postgres://user:PASSWORD@host/db"
  # Visible to anyone with cluster access
```

**The Better Approach**:
```yaml
# RIGHT: Use Secrets (at minimum)
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
type: Opaque
stringData:
  DATABASE_URL: "postgres://user:PASSWORD@host/db"

# BETTER: External secrets management
# - AWS Secrets Manager
# - HashiCorp Vault
# - Kubernetes External Secrets
```

```yaml
# Using External Secrets Operator
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-secrets
spec:
  refreshInterval: "1h"
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: app-secrets
  data:
    - secretKey: DATABASE_URL
      remoteRef:
        key: prod/database/url
```

**Key Insight**: Secrets are base64 encoded, not encrypted. Use external secret managers for real security.

### Pitfall 5: Single Replica with No PodDisruptionBudget

**Real Incident Report**: A critical service ran with 1 replica and no PDB. During a node drain for maintenance, the pod was evicted, causing downtime. Even with 3 replicas, a drain could have evicted all of them simultaneously without a PDB.

**The Anti-Pattern**:
```yaml
# WRONG: Single replica, no PDB
spec:
  replicas: 1  # No redundancy
  # No PodDisruptionBudget
  # Node drain = downtime
```

**The Better Approach**:
```yaml
# Deployment with multiple replicas
spec:
  replicas: 3
  template:
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: myapp
---
# PodDisruptionBudget
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: myapp-pdb
spec:
  minAvailable: 2    # Or maxUnavailable: 1
  selector:
    matchLabels:
      app: myapp
```

**Key Insight**: PDBs protect against voluntary disruptions (drains, upgrades). Without them, all pods can be evicted simultaneously.

### Pitfall 6: Public Exposure of Diagnostics and Profiling Endpoints

**Real Incident Report**: A developer added `import _ "net/http/pprof"` to debug high latency in staging. In production, the default HTTP multiplexer bound `/debug/pprof/*` to port `8080`, exposing live goroutine stack traces, heap allocators, and server environment data to the public internet.

**The Anti-Pattern**:
```go
// WRONG: Registers pprof directly on DefaultServeMux used by public router
import _ "net/http/pprof"

func main() {
    http.HandleFunc("/api/v1/orders", orderHandler)
    http.ListenAndServe(":8080", nil) // /debug/pprof is accessible to anyone!
}
```

**The Better Approach**:
Isolate profiling to an internal diagnostic port bound strictly to localhost or an unexposed management port. Use `kubectl port-forward` for on-demand debugging:

```go
package main

import (
	"log"
	"net/http"
	"net/http/pprof"
)

func runDiagnosticsServer(addr string) {
	diagMux := http.NewServeMux()
	diagMux.HandleFunc("/debug/pprof/", pprof.Index)
	diagMux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	diagMux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	diagMux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	diagMux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	diagMux.Handle("/debug/pprof/goroutine", pprof.Handler("goroutine"))
	diagMux.Handle("/debug/pprof/heap", pprof.Handler("heap"))

	// Bind strictly to local internal interface
	log.Printf("internal diagnostics listening on %s", addr)
	if err := http.ListenAndServe(addr, diagMux); err != nil {
		log.Printf("diagnostic server failure: %v", err)
	}
}

func main() {
	// Start internal diagnostics on localhost only
	go runDiagnosticsServer("127.0.0.1:6060")

	// Start public API on distinct multiplexer
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("/api/v1/orders", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	_ = http.ListenAndServe(":8080", apiMux)
}
```

To collect production profiles securely without exposing ports to Kubernetes ingress:
```bash
# Securely profile the pod via Kubernetes control plane
kubectl port-forward pod/order-service-789bc-k9z21 6060:6060

# Capture 30s CPU profile locally
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Inspect live goroutine leak count
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | head -n 20
```

### Pitfall 7: High-Throughput Batch Compute Scheduling Fragmentation (Netflix Kueue Case Study)

**Real Incident Report**: At enterprise scale, running millions of containerized batch jobs alongside web services frequently causes severe cluster instability. Attempting to replace the default `kube-scheduler` with specialized batch schedulers (e.g., custom forks, YuniKorn, or Volcano) fragments scheduling decisions across node pools, breaking affinity rules and degrading web service placement.

**The Solution - Admission-Level Job Queueing with Kueue**:
In [How Netflix Simplified Batch Compute with Kueue](https://medium.com/@SamarthaChandrashekar/how-netflix-simplified-batch-compute-with-kueue-4458bcf70471), Alvin Bao, Alex Petrov, Jennifer Lai, Aidan Sherr, and Samartha Chandrashekar describe how Netflix migrated millions of batch jobs on their Titus container management platform from a bespoke batch manager (Compute Managed Batch - CMB) to [Kueue](https://kueue.sigs.k8s.io/).

```
Batch Workload (batch/v1.Job / RayJob)
                │
                ▼
      ┌──────────────────┐
      │   LocalQueue     │ (Namespace-scoped submission)
      └─────────┬────────┘
                │
                ▼
      ┌──────────────────┐
      │  ClusterQueue    │ (Nominal quota, resource flavors)
      └─────────┬────────┘
                │
         Shared │ Borrowing / Lending
                ▼
      ┌──────────────────┐
      │      Cohort      │ (Fair sharing across tenant hierarchies)
      └─────────┬────────┘
                │ Admitted
                ▼
      ┌──────────────────┐
      │  kube-scheduler  │ (Standard node placement without fragmentation)
      └──────────────────┘
```

Key Architectural Principles from the Netflix Migration:
1. **Separation of Job Queuing from Pod Scheduling**: Kueue does not replace `kube-scheduler`. Instead, it manages job admission, priorities, fair sharing, and queueing before workloads are handed to `kube-scheduler`. This avoids scheduler fragmentation across heterogenous GPU/CPU clusters.
2. **Preemption-Based Fair Sharing**: Tenants are organized into Hierarchical Cohorts. When a tenant's reserved capacity is idle, sibling tenants in the same Cohort can borrow it (`reclaimWithinCohort: Any`). When the reserving tenant submits high-priority jobs, Kueue preempts the borrowed workloads (`withinClusterQueue: LowerPriority`), maximizing cluster utilization while maintaining SLA guarantees:

```yaml
apiVersion: kueue.x-k8s.io/v1beta1
kind: ClusterQueue
metadata:
  name: "data-science-cq"
spec:
  cohort: "ml-platform-cohort"
  queueingStrategy: BestEffortFIFO
  preemption:
    reclaimWithinCohort: Any
    withinClusterQueue: LowerPriority
  resourceGroups:
  - coveredResources: ["cpu", "memory", "nvidia.com/gpu"]
    flavors:
    - name: "standard-x86"
      resources:
      - name: "cpu"
        nominalQuota: 128
        borrowingLimit: 64
      - name: "memory"
        nominalQuota: 512Gi
        borrowingLimit: 256Gi
```

3. **High-Throughput Controller Tuning**: Standard controller-runtime client configs throttle under massive batch bursts. Netflix scaled Kueue to millions of jobs by increasing controller client `QPS`, `Burst`, and `groupKindConcurrency` by an order of magnitude.

### Quick Reference: Kubernetes Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Wrong probe type | DB down → all pods killed | Liveness for process, readiness for deps |
| No graceful shutdown | 502s during deploys | Handle SIGTERM, drain connections, 3s iptables delay |
| CFS quota mismatch | 40% CPU spent in scheduler | `go.uber.org/automaxprocs` |
| Non-heap memory leaks | OOM-kill despite low Go heap | Monitor Cgo/stack memory, set `GOMEMLIMIT` buffer |
| Public pprof exposure | Sensitive memory/stack leaked | Bind pprof to `127.0.0.1:6060`, debug via port-forward |
| Secrets in ConfigMap | Credentials visible plaintext | Use Secrets or external secret store |
| Single replica, no PDB | Downtime during maintenance | Multiple replicas + PDB |
| Custom batch schedulers | Pod placement fragmentation | Admission-level queuing via Kueue + standard scheduler |

---

### Junior → FAANG: Using Pitfall Tables as Incident Prevention Checklists

The pitfall table is most valuable when you internalize it before an incident, not during one. Each row represents a failure mode that has caused real production outages at real companies. Reading through them before deploying a new service to production is a 5-minute investment that can prevent a 2-hour incident.

The most impactful pitfalls for junior engineers to memorize: liveness probe checking downstream services (causes cascading restarts during downstream outages), no PodDisruptionBudget (causes service interruption during node maintenance), and missing resource limits (allows a bad actor or buggy pod to starve all pods on the node). These three account for a large fraction of Kubernetes-related incidents at companies without a mature platform team enforcing standards.

First-job habit: after writing any new Kubernetes manifest, check it against a linter. `kube-linter` and `kubeconform` with policy rules that map to this pitfall table will catch most of these issues before they reach production.

### Senior @ FAANG: Converting Pitfall Knowledge Into Platform Policy

At staff level, the goal is to make these pitfalls impossible, not just documented. The enforcement mechanism for each pitfall:

Liveness probe checks downstream dependencies: enforced by a custom admission webhook or OPA policy that rejects pods with external HTTP endpoints (other than localhost) in liveness probe configuration. Missing resource limits: enforced by a LimitRange in each namespace that sets default requests and limits, combined with an admission webhook that rejects pods that exceed the namespace's resource quota. Single replica with no PDB: enforced by a policy that requires a PDB whenever a Deployment has fewer than 3 replicas. Missing topology spread: enforced by a defaulting admission webhook that injects a topology spread constraint for hostname into every Deployment that does not have one.

The audit and enforcement story for each of these policies needs to include: what happens when an exception is needed (a managed exception process with expiry and owner), how existing non-compliant resources are handled (a migration plan, not an immediate rejection that blocks production), and how compliance is tracked over time (a dashboard showing the percentage of compliant resources, improving over quarters). This is platform governance at scale.
