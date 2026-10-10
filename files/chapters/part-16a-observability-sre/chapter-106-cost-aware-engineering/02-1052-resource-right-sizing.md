## 106.2 Resource Right-Sizing

### Kubernetes Resource Optimization

Right-sizing starts with comparing what a deployment requests against what its pods actually use. The following analyzer reads current resource requests from the Deployment spec, pulls live usage from the Kubernetes metrics API, and produces a recommendation with a 20% safety buffer, along with a set of baseline resource profiles for common Go workload types.

```go
package optimization

import (
    "context"
    "fmt"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/metrics/pkg/client/clientset/versioned"
)

type ResourceRecommendation struct {
    Namespace       string
    Deployment      string
    CurrentCPU      string
    CurrentMemory   string
    RecommendedCPU  string
    RecommendedMem  string
    PotentialSavings float64
}

type ResourceAnalyzer struct {
    k8sClient     kubernetes.Interface
    metricsClient versioned.Interface
}

func (a *ResourceAnalyzer) AnalyzeDeployment(ctx context.Context, namespace, name string) (*ResourceRecommendation, error) {
    // Get current resource requests
    deployment, err := a.k8sClient.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
    if err != nil {
        return nil, err
    }

    container := deployment.Spec.Template.Spec.Containers[0]
    currentCPU := container.Resources.Requests.Cpu().String()
    currentMemory := container.Resources.Requests.Memory().String()

    // Get actual usage from metrics
    pods, err := a.k8sClient.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
        LabelSelector: fmt.Sprintf("app=%s", name),
    })
    if err != nil {
        return nil, err
    }

    var totalCPU, totalMemory int64
    for _, pod := range pods.Items {
        metrics, err := a.metricsClient.MetricsV1beta1().PodMetricses(namespace).Get(ctx, pod.Name, metav1.GetOptions{})
        if err != nil {
            continue
        }
        for _, container := range metrics.Containers {
            totalCPU += container.Usage.Cpu().MilliValue()
            totalMemory += container.Usage.Memory().Value()
        }
    }

    podCount := len(pods.Items)
    if podCount == 0 {
        return nil, fmt.Errorf("no pods found")
    }

    avgCPU := totalCPU / int64(podCount)
    avgMemory := totalMemory / int64(podCount)

    // Recommend with 20% buffer
    recommendedCPU := fmt.Sprintf("%dm", int64(float64(avgCPU)*1.2))
    recommendedMemory := fmt.Sprintf("%dMi", int64(float64(avgMemory)*1.2)/1024/1024)

    return &ResourceRecommendation{
        Namespace:       namespace,
        Deployment:      name,
        CurrentCPU:      currentCPU,
        CurrentMemory:   currentMemory,
        RecommendedCPU:  recommendedCPU,
        RecommendedMem:  recommendedMemory,
    }, nil
}

// Go-specific resource guidelines
var GoResourceGuidelines = map[string]struct {
    MinCPU    string
    MinMemory string
    Notes     string
}{
    "api-light": {
        MinCPU:    "50m",
        MinMemory: "32Mi",
        Notes:     "Simple API handlers, minimal processing",
    },
    "api-standard": {
        MinCPU:    "100m",
        MinMemory: "64Mi",
        Notes:     "Standard API with database access",
    },
    "api-heavy": {
        MinCPU:    "250m",
        MinMemory: "128Mi",
        Notes:     "Complex processing, multiple dependencies",
    },
    "worker": {
        MinCPU:    "100m",
        MinMemory: "64Mi",
        Notes:     "Background job processing",
    },
    "worker-memory-intensive": {
        MinCPU:    "100m",
        MinMemory: "256Mi",
        Notes:     "Large data processing, caching",
    },
}
```

### Junior → FAANG: The Three Right-Sizing Numbers Every Engineer Should Know

For any service you own, know these three numbers before any planning or design review: the current CPU request and actual p95 CPU utilization, the current memory request and actual p95 memory usage, and the current replica count and HPA range. A service running at 15% of its CPU request is over-provisioned by approximately 6x. A service running at 95% of its memory request is a risk for OOMKill during traffic spikes. These numbers determine whether a right-sizing exercise will save money or whether the current configuration is appropriately cautious.

The most dangerous misconfiguration is setting CPU requests too high while setting memory requests accurately. Kubernetes schedules pods based on requests, not actual utilization. An over-requested CPU means the scheduler places fewer pods per node, increasing node count and cost, even though the CPUs on those nodes are sitting idle most of the time.

### Senior @ FAANG: VPA as a Platform Tool, Not a Complete Solution

At L6, the Vertical Pod Autoscaler is a recommendation engine, not an autonomous right-sizing system. Running VPA in `Auto` mode without review is dangerous: VPA can recommend reducing memory limits for a service that has occasional but predictable memory spikes (batch processing jobs, end-of-quarter reports), leading to OOMKills during peak load. The safe operational model is VPA in `Off` mode (collecting recommendations but not applying them automatically) with a weekly platform report that surfaces the top 10 services with the largest gap between requested and recommended resources. Service teams review the recommendations and apply them with deliberate testing, not automatic rollout.

The workload profile taxonomy in this chapter's code is a governance tool: it establishes named profiles (api-light, api-standard, api-heavy, worker, worker-memory-intensive) with minimum resource floors. Services that fall below the floor are flagged for review because they may be under-resourced rather than efficiently right-sized. Services that request far more than is typical for their profile are candidates for right-sizing. This taxonomy prevents the "race to zero" pathology where teams compete to minimize resource requests to reduce their cost allocation, creating services that are technically underprovisioned and prone to latency spikes under unexpected load.

---
