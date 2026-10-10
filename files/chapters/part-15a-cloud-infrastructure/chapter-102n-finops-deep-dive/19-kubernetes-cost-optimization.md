## 102N.17 Kubernetes Cost Optimization Architecture

Kubernetes clusters routinely run at 15-40% actual CPU utilization due to over-provisioned resource requests. This section covers Go tooling to automate right-sizing, handle Spot instance interruptions, and generate Karpenter node pool manifests.

### VPA Recommendation Reader

Vertical Pod Autoscaler writes container sizing suggestions to `VerticalPodAutoscaler.status.recommendation.containerRecommendations`. The following tool reads them via the dynamic Kubernetes client and generates `kubectl set resources` commands.

```go
// cmd/vpa-rightsizer/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/clientcmd"
)

var vpaGVR = schema.GroupVersionResource{
	Group: "autoscaling.k8s.io", Version: "v1", Resource: "verticalpodautoscalers",
}

func main() {
	ns := os.Getenv("NAMESPACE")
	if ns == "" {
		ns = "default"
	}
	cfg, err := clientcmd.BuildConfigFromFlags("", os.Getenv("KUBECONFIG"))
	if err != nil {
		log.Fatalf("kubeconfig: %v", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("dynamic client: %v", err)
	}

	list, err := dyn.Resource(vpaGVR).Namespace(ns).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		log.Fatalf("list VPAs: %v", err)
	}

	for _, vpa := range list.Items {
		name := vpa.GetName()
		recs, found, _ := nestedGet(vpa.Object, "status", "recommendation", "containerRecommendations")
		if !found {
			fmt.Printf("VPA %s: no recommendation yet\n", name)
			continue
		}
		items, _ := recs.([]any)
		fmt.Printf("\n=== VPA: %s ===\n", name)
		for _, item := range items {
			m, _ := item.(map[string]any)
			container, _ := m["containerName"].(string)
			target, _ := m["target"].(map[string]any)
			cpu := fmt.Sprintf("%v", target["cpu"])
			mem := fmt.Sprintf("%v", target["memory"])
			fmt.Printf("  %-30s  cpu=%-10s  memory=%s\n", container, cpu, mem)
			fmt.Printf("  kubectl set resources deployment/%s -c %s --requests=cpu=%s,memory=%s\n",
				name, container, cpu, mem)
		}
	}

	b, _ := json.MarshalIndent(list.Items, "", "  ")
	_ = os.WriteFile("/tmp/vpa-recommendations.json", b, 0o644)
	fmt.Println("\nFull output: /tmp/vpa-recommendations.json")
}

func nestedGet(obj map[string]any, keys ...string) (any, bool, error) {
	var cur any = obj
	for _, k := range keys {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false, fmt.Errorf("not a map at key %q", k)
		}
		v, exists := m[k]
		if !exists {
			return nil, false, nil
		}
		cur = v
	}
	return cur, true, nil
}
```

### Spot Instance Graceful Shutdown Handler

AWS sends a Spot termination notice via IMDS 2 minutes before reclaiming an instance. The handler polls every 5 seconds and initiates HTTP server drain as soon as the notice arrives.

```go
// pkg/spot/handler.go
package spot

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	imdsURL      = "http://169.254.169.254/latest/meta-data/spot/termination-notice"
	pollEvery    = 5 * time.Second
	drainTimeout = 90 * time.Second // comfortably inside the 2-minute window
)

// RunWithSpotHandling starts the HTTP server and handles OS signals and Spot notices.
func RunWithSpotHandling(server *http.Server, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	srvErr := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			srvErr <- err
		}
	}()

	noticed := make(chan struct{}, 1)
	go func() {
		t := time.NewTicker(pollEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if spotTerminating() {
					noticed <- struct{}{}
					return
				}
			}
		}
	}()

	select {
	case err := <-srvErr:
		return fmt.Errorf("server: %w", err)
	case <-ctx.Done():
		log.Info("signal received, draining connections")
	case <-noticed:
		log.Warn("spot termination notice received, draining")
		writeTerminationSentinel(log)
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), drainTimeout)
	defer cancel()
	return server.Shutdown(shutCtx)
}

func spotTerminating() bool {
	c := &http.Client{Timeout: 2 * time.Second}
	r, err := c.Get(imdsURL)
	if err != nil {
		return false
	}
	defer r.Body.Close()
	_, _ = io.Copy(io.Discard, r.Body)
	return r.StatusCode == http.StatusOK
}

// writeTerminationSentinel creates a file that /health detects to return 503,
// causing the ALB to stop routing new connections to this instance.
func writeTerminationSentinel(log *slog.Logger) {
	f, err := os.Create("/tmp/spot-terminating")
	if err != nil {
		log.Error("sentinel write failed", "err", err)
		return
	}
	_ = f.Close()
	log.Info("sentinel written: /tmp/spot-terminating")
}
```

### Right-Sizing Automation Tool

Reads CloudWatch p95 CPU utilization over a 14-day window for all running EC2 instances, applies downsize rules, and prints a savings report sorted by projected monthly savings.

```go
// cmd/rightsizer/main.go
package main

import (
	"cmp"
	"context"
	"fmt"
	"log"
	"math"
	"slices"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	cwtypes "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// instancePricing maps instance type to approximate monthly on-demand cost (USD).
// In production, replace with live pricing from the AWS Price List API.
var instancePricing = map[string]float64{
	"t3.micro": 7.59, "t3.small": 15.18, "t3.medium": 30.37, "t3.large": 60.74,
	"m5.large": 70.08, "m5.xlarge": 140.16, "m5.2xlarge": 280.32, "m5.4xlarge": 560.64,
	"c5.large": 62.05, "c5.xlarge": 124.10, "c5.2xlarge": 248.20,
}

var downsizeMap = map[string]string{
	"m5.4xlarge": "m5.2xlarge", "m5.2xlarge": "m5.xlarge", "m5.xlarge": "m5.large",
	"c5.2xlarge": "c5.xlarge", "c5.xlarge": "c5.large",
	"t3.large": "t3.medium", "t3.medium": "t3.small",
}

type rec struct {
	ID, From, To           string
	P95CPU, Current, Saved float64
}

func main() {
	ctx := context.Background()
	cfg, _ := config.LoadDefaultConfig(ctx)
	ec2c, cwc := ec2.NewFromConfig(cfg), cloudwatch.NewFromConfig(cfg)

	resp, err := ec2c.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		Filters: []ec2types.Filter{
			{Name: aws.String("instance-state-name"), Values: []string{"running"}},
		},
	})
	if err != nil {
		log.Fatal(err)
	}

	var recs []rec
	for _, r := range resp.Reservations {
		for _, inst := range r.Instances {
			id, itype := aws.ToString(inst.InstanceId), string(inst.InstanceType)
			p95, err := getP95CPU(ctx, cwc, id)
			if err != nil || p95 >= 30 {
				continue
			}
			smaller, ok := downsizeMap[itype]
			if !ok {
				continue
			}
			cur := instancePricing[itype]
			recs = append(recs, rec{
				ID: id, From: itype, To: smaller,
				P95CPU: p95, Current: cur, Saved: cur - instancePricing[smaller],
			})
		}
	}

	slices.SortFunc(recs, func(a, b rec) int { return cmp.Compare(b.Saved, a.Saved) })

	var total float64
	fmt.Printf("%-22s %-14s %-14s %8s %12s %12s\n", "Instance", "Current", "Recommended", "P95 CPU", "Current/mo", "Savings/mo")
	fmt.Println("-------------------------------------------------------------------------------------")
	for _, r := range recs {
		fmt.Printf("%-22s %-14s %-14s %7.1f%%  $%9.2f  $%9.2f\n", r.ID, r.From, r.To, r.P95CPU, r.Current, r.Saved)
		total += r.Saved
	}
	fmt.Printf("\nMonthly: $%.2f  |  Annual: $%.2f\n", total, total*12)
}

func getP95CPU(ctx context.Context, c *cloudwatch.Client, id string) (float64, error) {
	end := time.Now()
	r, err := c.GetMetricStatistics(ctx, &cloudwatch.GetMetricStatisticsInput{
		Namespace:  aws.String("AWS/EC2"),
		MetricName: aws.String("CPUUtilization"),
		Dimensions: []cwtypes.Dimension{{Name: aws.String("InstanceId"), Value: aws.String(id)}},
		StartTime:          aws.Time(end.AddDate(0, 0, -14)),
		EndTime:            aws.Time(end),
		Period:             aws.Int32(3600),
		ExtendedStatistics: []string{"p95"},
	})
	if err != nil {
		return 0, err
	}
	var max float64
	for _, dp := range r.Datapoints {
		if v, ok := dp.ExtendedStatistics["p95"]; ok {
			max = math.Max(max, v)
		}
	}
	return max, nil
}
```

### Karpenter Node Pool Generator

The following function generates a Karpenter `NodePool` manifest programmatically - useful in GitOps pipelines that create per-team node pools from configuration data.

```go
// pkg/karpenter/nodepool.go
package karpenter

import (
	"encoding/json"
	"fmt"
)

// NodePoolSpec contains parameters for generating a Karpenter NodePool manifest.
type NodePoolSpec struct {
	Name                string
	TeamLabel           string
	InstanceFamilies    []string
	CapacityTypes       []string
	MaxNodeCount        int
	ConsolidationPolicy string
	ConsolidateAfter    string
}

// GenerateNodePoolManifest returns a Karpenter NodePool YAML manifest.
func GenerateNodePoolManifest(s NodePoolSpec) (string, error) {
	if len(s.InstanceFamilies) == 0 {
		return "", fmt.Errorf("InstanceFamilies is required")
	}
	families, err := json.Marshal(s.InstanceFamilies)
	if err != nil {
		return "", err
	}
	capacity, err := json.Marshal(s.CapacityTypes)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(`apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: %s
  labels:
    team: %s
spec:
  template:
    metadata:
      labels:
        team: %s
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: %s-nodeclass
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: %s
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: %s
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
  limits:
    cpu: %d
  disruption:
    consolidationPolicy: %s
    consolidateAfter: %s
`,
		s.Name, s.TeamLabel, s.TeamLabel, s.Name,
		string(capacity), string(families),
		s.MaxNodeCount*4, s.ConsolidationPolicy, s.ConsolidateAfter,
	), nil
}
```

---

### Junior → FAANG: Kubernetes Rightsizing as Hands-On Learning

The 15-40% CPU utilization range cited in this section is not a rare edge case. It is the industry norm for Kubernetes clusters where teams set resource requests conservatively (to avoid OOM kills) and never revisit them as the service stabilizes. The rightsizing tooling in this section automates the analysis that would otherwise require manual comparison of `kubectl top pod` output against resource specs across potentially hundreds of pods.

The spot instance interruption handler is the most operationally important Go code in this section. When a spot instance is interrupted, Kubernetes receives a SIGTERM on the node and begins evicting pods. The handler's job is to enable fast pod rescheduling by ensuring pods respond to termination signals quickly (within the 30-second spot interruption window). The three keys: a short `terminationGracePeriodSeconds` (30 seconds maximum for spot-eligible workloads), a preStop hook that allows connections to drain, and a readinessProbe that immediately fails on SIGTERM so the pod is removed from service endpoints before connections are terminated.

### Senior @ FAANG: Kubernetes Cost Optimization Program at Fleet Scale

At staff level, the Kubernetes rightsizing tooling is a component of a fleet-wide cost optimization program. The program has four stages: measurement (OpenCost or Kubecost providing namespace and workload-level cost attribution with daily granularity), analysis (the rightsizing analyzer computing request-to-usage ratios for all pods), recommendation delivery (sending prioritized recommendations to team channels with projected savings), and enforcement (VPA admission webhook that prevents new deployments from setting requests more than 3x the historical p95 usage).

The Karpenter NodePool manifest generation is the infrastructure abstraction that makes spot instance adoption safe at scale. Rather than each team configuring their own NodePool (which produces inconsistent configurations and allows teams to accidentally opt all their pods into spot), the platform team owns a small set of NodePool configurations (spot-eligible-stateless, on-demand-stateful, on-demand-spot-fallback) and teams select the appropriate configuration via a pod label. This abstraction separates the spot eligibility decision (made by the team, based on their workload characteristics) from the spot configuration implementation (owned by the platform team). The result is consistent, safe spot adoption across the fleet without requiring each team to understand Karpenter NodePool configuration.
