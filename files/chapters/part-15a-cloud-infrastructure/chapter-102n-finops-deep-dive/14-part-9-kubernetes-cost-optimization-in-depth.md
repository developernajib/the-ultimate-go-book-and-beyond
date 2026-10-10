## 102N.12 Kubernetes Cost Optimization in Depth

### Namespace-Level Cost Allocation with OpenCost

[OpenCost](https://www.opencost.io/) (CNCF sandbox project) allocates Kubernetes costs to namespaces, deployments, labels, and teams. It exposes a REST API that Go services can query directly.

```go
package k8scost

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// OpenCostClient queries the OpenCost/Kubecost allocation API.
type OpenCostClient struct {
	baseURL    string
	httpClient *http.Client
}

func NewOpenCostClient(baseURL string) *OpenCostClient {
	return &OpenCostClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// AllocationResult represents the cost breakdown for one allocation unit.
type AllocationResult struct {
	Name             string  `json:"name"`
	CPUCost          float64 `json:"cpuCost"`
	MemoryCost       float64 `json:"memoryCost"`
	StorageCost      float64 `json:"storageCost"`
	NetworkCost      float64 `json:"networkCost"`
	TotalCost        float64 `json:"totalCost"`
	CPUEfficiency    float64 `json:"cpuEfficiency"`
	MemoryEfficiency float64 `json:"memoryEfficiency"`
}

// GetNamespaceCosts returns per-namespace costs for the given window (e.g. "7d", "1d").
func (c *OpenCostClient) GetNamespaceCosts(ctx context.Context, window string) (map[string]AllocationResult, error) {
	url := fmt.Sprintf("%s/model/allocation?window=%s&aggregate=namespace&accumulate=true", c.baseURL, window)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("opencost request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("opencost returned %d", resp.StatusCode)
	}

	var result struct {
		Code int                        `json:"code"`
		Data []map[string]AllocationResult `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if len(result.Data) == 0 {
		return nil, nil
	}

	return result.Data[0], nil
}

// TeamCostReport aggregates namespace costs by team label.
type TeamCostReport struct {
	Team      string
	WeeklyUSD float64
	TopNamespaces []struct {
		Namespace string
		CostUSD   float64
	}
}

// BuildTeamReport groups namespace allocations into per-team summaries.
// It expects namespaces to follow the naming convention "<team>-<env>" or
// be annotated with a "team" label (requires aggregate=label:team in the API call).
func BuildTeamReport(allocations map[string]AllocationResult) []TeamCostReport {
	teamTotals := map[string]float64{}
	teamNamespaces := map[string][]struct {
		Namespace string
		CostUSD   float64
	}{}

	for ns, alloc := range allocations {
		// Derive team name: take everything before the first "-".
		team := ns
		for i, ch := range ns {
			if ch == '-' {
				team = ns[:i]
				break
			}
		}
		teamTotals[team] += alloc.TotalCost
		teamNamespaces[team] = append(teamNamespaces[team], struct {
			Namespace string
			CostUSD   float64
		}{ns, alloc.TotalCost})
	}

	reports := make([]TeamCostReport, 0, len(teamTotals))
	for team, total := range teamTotals {
		reports = append(reports, TeamCostReport{
			Team:          team,
			WeeklyUSD:     total,
			TopNamespaces: teamNamespaces[team],
		})
	}
	return reports
}
```

### Bin Packing: Tuning Resource Requests to Increase Node Utilization

Kubernetes schedules pods based on `requests`, not actual usage. A typical cluster where developers set `requests: cpu: 1000m` but average 150m CPU runs at ~15% utilization - you are paying for 6× more node capacity than needed.

**Target**: increase average node utilization from 40% to 70%+ through right-sizing requests.

```yaml
# Before: over-provisioned requests
resources:
  requests:
    cpu: "1000m"
    memory: "2Gi"
  limits:
    cpu: "2000m"
    memory: "4Gi"

# After: right-sized based on 95th-percentile observed usage + 30% headroom
resources:
  requests:
    cpu: "200m"
    memory: "512Mi"
  limits:
    cpu: "800m"
    memory: "1Gi"
```

Use the Vertical Pod Autoscaler (VPA) in recommendation mode to compute correct requests:

```bash
kubectl apply -f https://github.com/kubernetes/autoscaler/releases/latest/download/vertical-pod-autoscaler.yaml

# Create VPA object in recommendation mode (does not mutate pods)
kubectl apply -f - <<EOF
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-service
  updatePolicy:
    updateMode: "Off"   # Recommendation only
EOF

# View recommendations
kubectl describe vpa my-service-vpa -n production
```

Applying VPA recommendations across a 50-node cluster typically reduces node count by 30-40% while maintaining equivalent headroom for traffic spikes.

### Spot Instance Interruption Handling in Go

Spot instances are reclaimed with a 2-minute warning. A well-written Go service can drain gracefully within that window.

```go
package spot

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const imdsInterruptionURL = "http://169.254.169.254/latest/meta-data/spot/interruption-action"

// WatchSpotInterruption polls the EC2 instance metadata service for
// a spot interruption notice and cancels the provided context when
// one is detected, giving the application time to drain.
func WatchSpotInterruption(ctx context.Context, cancel context.CancelFunc, logger *slog.Logger) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	client := &http.Client{Timeout: 2 * time.Second}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, imdsInterruptionURL, nil)
			resp, err := client.Do(req)
			if err != nil {
				continue // metadata service not reachable or no notice yet
			}
			resp.Body.Close()

			if resp.StatusCode == http.StatusOK {
				logger.Warn("SPOT INTERRUPTION NOTICE received - initiating graceful drain")
				cancel()
				return
			}
		}
	}
}

// GracefulServer wraps an http.Server and handles both OS signals and
// spot interruption notices for clean shutdown within the 2-minute window.
func GracefulServer(srv *http.Server, logger *slog.Logger) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Watch for spot interruption via IMDS.
	go WatchSpotInterruption(ctx, cancel, logger)

	// Also handle SIGTERM / SIGINT (from Kubernetes or manual stops).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		select {
		case sig := <-sigCh:
			logger.Info("OS signal received", "signal", sig)
			cancel()
		case <-ctx.Done():
		}
	}()

	// Start server.
	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	// Graceful shutdown: allow up to 90s to drain in-flight requests.
	// Spot instances give 2 minutes - 90s leaves margin for checkpointing.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer shutdownCancel()

	logger.Info("draining in-flight requests", "timeout_sec", 90)
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	logger.Info("server drained cleanly")
	return nil
}

// CheckpointState persists application state to S3 or a shared database
// before the instance is reclaimed. Call this during the drain phase.
type Checkpointer interface {
	Checkpoint(ctx context.Context) error
}

// NoOpCheckpointer satisfies the interface for stateless services.
type NoOpCheckpointer struct{}
func (n *NoOpCheckpointer) Checkpoint(_ context.Context) error { return nil }
```

### Cluster Autoscaler vs Karpenter

| Feature | Cluster Autoscaler | Karpenter |
|---|---|---|
| Node selection | Pre-defined node groups | Selects optimal instance type per workload |
| Provisioning speed | 3-5 minutes | ~30-60 seconds |
| Spot fallback | Manual node group ordering | Automatic fleet diversification |
| Bin packing | Basic | Consolidation controller merges underutilized nodes |
| Cost optimization | Node-group level | Instance-type level (chooses cheapest fitting type) |
| Configuration | `ClusterAutoscaler` CR + ASGs | `NodePool` + `EC2NodeClass` CRs |

Karpenter's `consolidationPolicy: WhenUnderutilized` will automatically merge pods from underutilized nodes onto fewer nodes and terminate the empty nodes - equivalent of running bin-packing continuously.

```yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: default
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
      nodeClassRef:
        name: default
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    budgets:
      - nodes: "20%"  # Never consolidate more than 20% of nodes simultaneously
```

### Node Pool Strategy

| Workload Type | Instance Strategy | Rationale |
|---|---|---|
| Stateless API servers | Spot (diversified) | Can tolerate interruptions with graceful drain |
| Stateful services (databases) | On-demand | Cannot checkpoint state in 2 minutes |
| Batch/ML training | Spot | Long-running but checkpointable |
| CI/CD runners | Spot | Ephemeral by nature |
| Monitoring/alerting | On-demand | Must be available during incidents |

### Weekly Kubernetes Cost Report via Slack

Sending a structured weekly summary to a shared Slack channel creates a passive feedback loop, engineering leads see their team's Kubernetes spend without needing to log into any dashboard. The reporter queries OpenCost for a rolling 7-day allocation window, aggregates by team using `BuildTeamReport`, and sorts teams by cost descending so the largest spenders appear at the top. Slack's Incoming Webhooks API accepts a plain JSON `text` payload, making the integration dependency-free beyond the standard library.

```go
package k8scost

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"time"
)

// SlackReporter sends weekly per-team Kubernetes cost summaries to Slack.
type SlackReporter struct {
	opencost   *OpenCostClient
	webhookURL string
	httpClient *http.Client
}

func NewSlackReporter(opencost *OpenCostClient, webhookURL string) *SlackReporter {
	return &SlackReporter{
		opencost:   opencost,
		webhookURL: webhookURL,
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
}

func (r *SlackReporter) SendWeeklyReport(ctx context.Context) error {
	allocations, err := r.opencost.GetNamespaceCosts(ctx, "7d")
	if err != nil {
		return fmt.Errorf("fetch namespace costs: %w", err)
	}

	reports := BuildTeamReport(allocations)

	// Sort by cost descending.
	slices.SortFunc(reports, func(a, b TeamCostReport) int {
		return cmp.Compare(b.WeeklyUSD, a.WeeklyUSD)
	})

	var buf bytes.Buffer
	buf.WriteString(fmt.Sprintf("*Kubernetes Weekly Cost Report* - week ending %s\n\n", time.Now().Format("2006-01-02")))
	buf.WriteString("```\n")
	buf.WriteString(fmt.Sprintf("%-20s %12s\n", "Team", "Weekly Cost"))
	buf.WriteString(fmt.Sprintf("%-20s %12s\n", "----", "-----------"))

	var total float64
	for _, rep := range reports {
		buf.WriteString(fmt.Sprintf("%-20s $%11.2f\n", rep.Team, rep.WeeklyUSD))
		total += rep.WeeklyUSD
	}
	buf.WriteString(fmt.Sprintf("%-20s $%11.2f\n", "TOTAL", total))
	buf.WriteString("```\n")
	buf.WriteString("_Source: OpenCost · Data refreshed hourly_")

	payload, _ := json.Marshal(map[string]string{"text": buf.String()})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.webhookURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("slack post: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("slack returned %d", resp.StatusCode)
	}
	return nil
}
```

### FinOps Case Study: When Kubernetes Overhead Outweighs Its Utility ($14,850/mo to $680/mo)

A central discipline of FinOps is evaluating total cost of ownership (TCO) rather than blindly equating architectural sophistication with engineering maturity. In production retrospectives such as [Our Kubernetes Cluster Was Costing $14,850/Month. We Moved to Fly.io for $680](https://medium.com/@adityasuryawanshi/our-kubernetes-cluster-was-costing-14-850-month-we-moved-to-fly-io-for-680-281b373fa580) by Aditya Suryawanshi, mid-sized engineering teams often find that the fixed structural overhead of a full Kubernetes deployment dwarfs the compute cost of the applications running on it.

#### The Cost Anatomy of Unexamined Infrastructure

For a typical CRUD API serving 10,000 to 100,000 active users, a multi-zone Kubernetes deployment incurs massive structural overhead before handling a single request:

| Cost Component | Monthly Cost (AWS EKS Stack) | Underlying Driver | Lean Alternative (Fly.io / PaaS / VPS) |
|---|---|---|---|
| Compute Nodes | $6,400 (12x `m5.large`) | Static over-provisioning to avoid OOMs; average cluster utilization sat at ~15% | $380 (Fly Machines autoscaling 2 to 10 lightweight VMs) |
| Relational Database | $4,200 (`db.r5.2xlarge`) | Provisioned for unverified future peak traffic rather than actual concurrency | $250 (Serverless autoscaling Postgres with connection pooling) |
| Observability | $1,200 (Datadog K8s) | Host-based agents, container metrics, and custom metrics for idle pods | $50 (Grafana Cloud + Prometheus metrics) |
| Networking & Gateways | $3,050 (3x NAT GWs, ALBs, Cross-AZ) | AWS charges $0.045/GB for NAT data processing + $0.01/GB cross-AZ inter-pod traffic | $0 (Global Anycast edge routing included in platform compute) |
| **Total Monthly Spend** | **$14,850 / month** | | **$680 / month (95.4% reduction)** |

#### Operational Metric Comparison

Beyond raw dollar expenditure, over-engineering infrastructure introduces substantial operational drag:

```
Metric                 Kubernetes (EKS)      Lean Platform (Fly.io / VPS)
──────────────────────────────────────────────────────────────────────────
P50 Latency            45 ms                 38 ms (Anycast edge routing)
P99 Latency            320 ms                180 ms
CI/CD Deploy Time      8 minutes             45 seconds
Configuration Volume   2,000+ lines (47 YAML) ~20 lines (single TOML)
Monthly Incidents      12 / month            2 / month
```

#### Decision Framework: Kubernetes vs. Lean Infrastructure

Engineering teams should apply a strict FinOps filter before adopting or retaining Kubernetes:

```
Does the system have:
├── > 50 microservices maintained by > 8 independent teams?
├── Strict multi-tenant compliance requiring network policies & air-gapped namespaces?
├── Heterogeneous batch compute workloads requiring Kueue / GPU orchestration?
└── Daily sustained traffic > 100,000 requests/sec requiring dynamic bin-packing?
```

- **If YES to two or more**: The control plane overhead and administrative complexity of Kubernetes are economically justified. Focus on OpenCost, Karpenter bin-packing, and Spot instance pools.
- **If NO**: Running a Go service on a lean platform (e.g., Fly.io, single large VPS with systemd/Docker, or managed ECS) eliminates NAT gateway surcharges, reduces configuration complexity from thousands of YAML lines to a single file, and avoids paying enterprise cluster management overhead for low-utilization idle nodes.

---

### Junior → FAANG: Kubernetes Cost Optimization as Requests and Limits Fundamentals

Kubernetes cost optimization starts with understanding requests and limits. A pod's resource request determines how much CPU and memory the scheduler reserves on the node. A pod's resource limit determines the maximum it can consume. The cost is determined by node capacity, which is driven by the sum of all requests (not limits). Pods with requests set too high (over-requesting) waste node capacity. Pods with requests set too low (under-requesting) risk OOM kills and CPU throttling.

The practical first step: check the actual CPU and memory usage of your pods against their requests. If a pod requests 500m CPU but consistently uses 50m CPU, the request is 10x the actual usage. Reducing the request to 75m (25th percentile actual usage with a 50% buffer) reduces the node capacity required and improves bin-packing efficiency. The `kubectl top pod` command and VPA recommendation reports are the data sources for this analysis.

OpenCost provides namespace-level cost attribution, which is the foundational data for Kubernetes FinOps. The cost per namespace per day, combined with the request count per namespace from Prometheus, gives cost per request per namespace, the unit economics metric that connects Kubernetes cost to service-level efficiency.

### Senior @ FAANG: Kubernetes FinOps as a Platform Engineering Program

At staff level, Kubernetes cost optimization is a fleet-wide program with four components: cost attribution (OpenCost or Kubecost providing namespace and workload-level cost allocation), request right-sizing (VPA recommendations or a custom analyzer enforcing request-to-usage ratios within organizational bounds), node efficiency (Karpenter or Cluster Autoscaler with bin-packing configuration that maximizes node utilization), and spot instance adoption (defining which workload classes are spot-eligible and automating spot instance request with on-demand fallback).

The organizational metric for Kubernetes cost efficiency is cluster CPU utilization: the ratio of CPU requests to node capacity, and the ratio of actual CPU usage to CPU requests. A well-tuned cluster has node capacity utilization above 70% (requests-to-capacity ratio) and actual usage above 50% of requests. Clusters below 40% utilization are significantly over-provisioned and represent an organizational cost reduction opportunity that requires no feature trade-offs.

The spot instance adoption pattern is the highest-ROI Kubernetes cost optimization for stateless workloads. Spot instances provide 60-90% cost reduction compared to on-demand, with the trade-off of 2-minute interruption notices when the spot capacity is reclaimed. Kubernetes workloads designed for rapid pod scheduling (small deployment units, fast container startup, proper PodDisruptionBudget configuration) handle spot interruptions gracefully. The platform team's contribution is defining the spot eligibility criteria (stateless workloads, no persistent local storage, minimum 3 replicas, PodDisruptionBudget configured) and providing the node selector labels and Karpenter NodePool configuration that implement the criteria without requiring each team to independently configure spot scheduling.
