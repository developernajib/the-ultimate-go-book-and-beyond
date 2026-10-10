## 106.9 Cloud Provider Cost Comparison for Go Services

Understanding pricing differences between cloud providers helps make informed decisions about where to deploy Go services.

### Compute Cost Comparison

FinOps practices align engineering decisions with their infrastructure cost implications, enabling teams to balance reliability, performance, and budget constraints explicitly. The following analysis compares the cost profile of equivalent Go service deployments across major cloud providers and instance types.

```
┌──────────────────────────────────────────────────────────────────┐
│            COMPUTE COST COMPARISON (2024 PRICING)                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  VIRTUAL MACHINES (2 vCPU, 8GB RAM):                             │
│  ├── AWS EC2 m6i.large:     $0.096/hr = $69/month                │
│  ├── GCP e2-standard-2:     $0.067/hr = $48/month                │
│  ├── Azure D2s v5:          $0.096/hr = $69/month                │
│  └── Winner: GCP (30% cheaper)                                   │
│                                                                  │
│  CONTAINERS (MANAGED KUBERNETES):                                │
│  ├── AWS EKS:      $0.10/hr/cluster + node costs                 │
│  ├── GCP GKE:      $0.10/hr/cluster (free tier: 1 zonal)         │
│  ├── Azure AKS:    Free tier control plane + node costs          │
│  └── Winner: Azure (free control plane)                          │
│                                                                  │
│  SERVERLESS (1M requests, 1s duration, 256MB,                    │
│  before free tiers):                                             │
│  ├── AWS Lambda:        ~$4.40/month                             │
│  ├── GCP Cloud Run:     ~$0.90/month (concurrency amortizes      │
│  │                      instance time across requests)           │
│  ├── Azure Functions:   ~$4.20/month                             │
│  └── Winner: GCP Cloud Run (~80% cheaper)                        │
│                                                                  │
│  GO-SPECIFIC ADVANTAGE:                                          │
│  • Serverless benefits Go due to fast cold starts                │
│  • Small binaries reduce artifact storage costs                  │
│  • Low memory usage means smaller instance types viable          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Go-Optimized Cloud Run Configuration

Cloud Run's per-request billing model makes it cost-optimal for Go services with variable traffic, but requires tuning concurrency, minimum instances, and startup time to avoid cold-start latency at scale. The following configuration demonstrates the knobs that balance cost and latency for production Go services on Cloud Run.

```go
// Cloud Run is particularly cost-effective for Go services
// due to Go's fast startup and low memory usage

package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    // Cloud Run provides PORT environment variable
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/", handler)
    mux.HandleFunc("/health", healthHandler)

    server := &http.Server{
        Addr:         ":" + port,
        Handler:      mux,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Graceful shutdown for Cloud Run termination
    done := make(chan bool)
    go func() {
        sigint := make(chan os.Signal, 1)
        signal.Notify(sigint, syscall.SIGINT, syscall.SIGTERM)
        <-sigint

        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()

        if err := server.Shutdown(ctx); err != nil {
            log.Printf("HTTP server shutdown error: %v", err)
        }
        close(done)
    }()

    log.Printf("Starting server on port %s", port)
    if err := server.ListenAndServe(); err != http.ErrServerClosed {
        log.Fatalf("HTTP server error: %v", err)
    }
    <-done
}

func handler(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("Hello from Go on Cloud Run!"))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
}
```

```yaml
# cloud-run-service.yaml: cost-optimized configuration
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: go-service
spec:
  template:
    metadata:
      annotations:
        # Scale to zero when idle, a major cost saver
        autoscaling.knative.dev/minScale: "0"
        autoscaling.knative.dev/maxScale: "100"

        # CPU allocation only during requests
        run.googleapis.com/cpu-throttling: "true"

        # Fast startup boost
        run.googleapis.com/startup-cpu-boost: "true"

        # Use second-gen execution for better performance
        run.googleapis.com/execution-environment: gen2

    spec:
      containerConcurrency: 80  # Go handles high concurrency well
      timeoutSeconds: 300

      containers:
      - image: gcr.io/project/go-service:latest
        ports:
        - containerPort: 8080

        resources:
          limits:
            # Go services typically need less memory than Java/Node
            memory: 256Mi
            cpu: "1"

        env:
        - name: GOGC
          value: "50"  # More aggressive GC for lower memory

        startupProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 0
          periodSeconds: 1
          failureThreshold: 3

        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          periodSeconds: 10
```

### AWS Lambda vs Cloud Run Cost Analysis

Choosing between Lambda and Cloud Run is a numbers question, not a preference question. The calculator below models both providers' billing dimensions (GB-seconds and request count for Lambda, vCPU-seconds, GiB-seconds, and request count for Cloud Run) so the decision can be made from the workload's actual traffic shape.

```go
// Cost comparison calculator for Go serverless
package cost

import (
    "fmt"
    "math"
)

type ServerlessWorkload struct {
    RequestsPerMonth     int64
    AvgDurationMs        int64
    MemoryMB             int64
    IdleHoursPerDay      float64
    ConcurrentRequests   int64
}

type CostComparison struct {
    LambdaCost    float64
    CloudRunCost  float64
    Recommendation string
}

func CompareCosts(w ServerlessWorkload) CostComparison {
    // AWS Lambda pricing (2024)
    // $0.0000166667 per GB-second
    // $0.20 per 1M requests
    lambdaGBSeconds := float64(w.RequestsPerMonth) *
        (float64(w.AvgDurationMs) / 1000) *
        (float64(w.MemoryMB) / 1024)
    lambdaComputeCost := lambdaGBSeconds * 0.0000166667
    lambdaRequestCost := float64(w.RequestsPerMonth) / 1000000 * 0.20
    lambdaTotalCost := lambdaComputeCost + lambdaRequestCost

    // Cloud Run pricing (2024)
    // $0.00002400 per vCPU-second
    // $0.00000250 per GiB-second
    // $0.40 per 1M requests

    // Calculate active hours
    activeHoursPerDay := 24 - w.IdleHoursPerDay
    activeSecondsPerMonth := activeHoursPerDay * 3600 * 30

    // Assume 1 vCPU per instance
    cloudRunCPUCost := activeSecondsPerMonth * 0.00002400
    cloudRunMemCost := activeSecondsPerMonth *
        (float64(w.MemoryMB) / 1024) * 0.00000250
    cloudRunRequestCost := float64(w.RequestsPerMonth) / 1000000 * 0.40

    // Cloud Run free tier: 2M requests, 180k vCPU-seconds, 360k GiB-seconds
    freeCPUSeconds := 180000.0
    cloudRunTotalCost := math.Max(0, cloudRunCPUCost-freeCPUSeconds*0.00002400) +
        cloudRunMemCost + cloudRunRequestCost

    recommendation := "Lambda"
    if cloudRunTotalCost < lambdaTotalCost {
        recommendation = "Cloud Run"
    }

    // Consider other factors
    if w.IdleHoursPerDay > 20 {
        recommendation += " (scale-to-zero critical)"
    }
    if w.ConcurrentRequests > 1000 {
        recommendation = "Cloud Run (higher concurrency limits)"
    }

    return CostComparison{
        LambdaCost:     lambdaTotalCost,
        CloudRunCost:   cloudRunTotalCost,
        Recommendation: recommendation,
    }
}

// Example usage
func ExampleComparison() {
    workload := ServerlessWorkload{
        RequestsPerMonth:   10000000,  // 10M requests
        AvgDurationMs:      50,        // 50ms per request
        MemoryMB:           256,
        IdleHoursPerDay:    8,         // Idle overnight
        ConcurrentRequests: 100,
    }

    comparison := CompareCosts(workload)
    fmt.Printf("Lambda: $%.2f/month\n", comparison.LambdaCost)
    fmt.Printf("Cloud Run: $%.2f/month\n", comparison.CloudRunCost)
    fmt.Printf("Recommendation: %s\n", comparison.Recommendation)
}
```

### Junior → FAANG: The Compute Decision as a Cost and Latency Trade-Off

The serverless versus containerized versus VMs decision is a recurring FAANG interview question that requires reasoning through cost and latency simultaneously. Know the break-even points: Lambda/Cloud Run wins on cost for spiky, low-duty-cycle workloads (requests spread across the day with long idle periods). Kubernetes on reserved instances wins for steady-state workloads running above 40% utilization. The crossover point depends on the specific pricing and traffic shape, but the mental model (serverless for bursty, Kubernetes for steady) is the correct starting framework.

Go's fast cold start time is the single biggest advantage in the serverless comparison. A Go Lambda function cold starts in roughly 50-100ms versus 500-3000ms for JVM functions. For user-facing latency-sensitive workloads where cold starts are visible, Go's cold start advantage can make Lambda viable where it would be unacceptable in Java.

### Senior @ FAANG: Multi-Cloud Cost Arbitrage and Lock-In Trade-Offs

At L6, cloud provider cost comparison is not just a technical analysis but a strategic decision with multi-year consequences. AWS's Savings Plans and Reserved Instances provide up to 72% discount over on-demand pricing for 1-3 year commitments. Google Cloud's Committed Use Discounts offer similar discounts for GCE. These commitments create lock-in that makes future provider switches more expensive.

The senior engineer's role in this decision is to quantify the lock-in cost alongside the discount. A 1-year AWS Savings Plan commitment that saves $200K over the year has an implied migration cost of up to $200K if the decision to switch providers is made mid-term. This means the commitment is rational only if the probability-weighted cost of migration during the commitment period is less than $200K. For organizations with stable technical strategies and no active cloud migration plans, the commitment is almost always rational. For organizations in active M&A activity, growing rapidly into a multi-cloud architecture, or evaluating Kubernetes federation across clouds, the commitment math changes.

The `CompareCosts` function in this chapter's code is a starting point for this analysis, but a production cost comparison model must include egress costs (often the difference between AWS and GCP is not compute but egress pricing), committed discount options (not just on-demand pricing), and the engineering cost of migration (which is almost always underestimated in initial analyses).

---
