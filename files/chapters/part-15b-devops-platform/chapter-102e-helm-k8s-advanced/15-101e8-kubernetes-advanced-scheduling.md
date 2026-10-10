## 102E.13 Kubernetes Advanced Scheduling

The Kubernetes scheduler assigns pods to nodes. Beyond simple resource matching, advanced scheduling controls let you co-locate related pods, spread replicas for HA, isolate workloads to dedicated hardware, and protect against cascading failures during maintenance.

### Pod Affinity and Anti-Affinity

**Co-locate frontend with backend** (reduce latency - same node):

```yaml
# frontend/deployment.yaml
spec:
  template:
    spec:
      affinity:
        podAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 80
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: api-backend
                topologyKey: kubernetes.io/hostname
```

**Spread replicas across nodes** (hard anti-affinity - no two replicas on same node):

```yaml
spec:
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: payment-service
              topologyKey: kubernetes.io/hostname
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: payment-service
                topologyKey: topology.kubernetes.io/zone
```

### Taints and Tolerations

Taints repel pods from nodes unless the pod explicitly tolerates the taint. This is how you create dedicated GPU nodes, spot-only nodes, or compliance-isolated nodes.

**Taint GPU nodes** so only ML workloads land there:

```bash
kubectl taint nodes gpu-node-01 nvidia.com/gpu=true:NoSchedule
kubectl taint nodes gpu-node-02 nvidia.com/gpu=true:NoSchedule
```

**ML workload pod tolerates the taint** and requests GPU:

```yaml
spec:
  tolerations:
    - key: "nvidia.com/gpu"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
  nodeSelector:
    accelerator: nvidia-tesla-v100
  containers:
    - name: training-job
      resources:
        limits:
          nvidia.com/gpu: "2"
```

**Spot-only node pool** - cost savings for fault-tolerant batch jobs:

```bash
# Cloud provider labels spot nodes automatically - taint them:
kubectl taint nodes -l cloud.google.com/gke-spot=true \
  cloud.google.com/gke-spot=true:NoSchedule
```

```yaml
# Batch job that tolerates spot eviction
spec:
  tolerations:
    - key: "cloud.google.com/gke-spot"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
  terminationGracePeriodSeconds: 30   # handle SIGTERM from spot eviction
```

### Topology Spread Constraints

Topology spread constraints are more flexible than anti-affinity for even distribution across zones and nodes:

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: checkout-api
      minDomains: 3       # require at least 3 zones to exist
    - maxSkew: 2
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app: checkout-api
```

### Pod Disruption Budgets

PDBs protect applications during voluntary disruptions (node drain, cluster upgrades) by guaranteeing a minimum number of pods stay running:

```yaml
# Absolute minimum - at least 3 pods must be available at all times
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-api-pdb
  namespace: production
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: checkout-api
---
# Percentage - at most 20% can be unavailable
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: production
spec:
  maxUnavailable: "20%"
  selector:
    matchLabels:
      app: order-worker
```

During `kubectl drain node-01`, the drain operation will wait (or fail) if evicting a pod would violate the PDB. This is critical for payment services where you need at least N replicas serving traffic at all times.

### HPA with Custom Prometheus Metrics - Go Service

This Go service exposes a custom Prometheus metric (`queue_depth`) that KEDA/HPA uses to trigger scaling:

```go
// internal/metrics/queue_metrics.go
package metrics

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// QueueDepth is the number of unprocessed messages in the work queue.
	// HPA ScaleTargetRef uses this metric via prometheus-adapter.
	QueueDepth = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: "myapp",
		Name:      "queue_depth",
		Help:      "Number of unprocessed messages waiting in the work queue",
	})

	ProcessingLatencySeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Namespace: "myapp",
		Name:      "processing_latency_seconds",
		Help:      "End-to-end message processing latency in seconds",
		Buckets:   prometheus.ExponentialBuckets(0.001, 2, 14),
	})
)

// StartMetricsServer starts the /metrics HTTP endpoint on addr (e.g. ":9090").
func StartMetricsServer(ctx context.Context, addr string) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz/ready", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{Addr: addr, Handler: mux, ReadTimeout: 5 * time.Second}

	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("metrics server error", "err", err)
		}
	}()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
}
```

HPA manifest using `prometheus-adapter` to expose the custom metric:

```yaml
# HPA using custom metric from Prometheus
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-worker-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-worker
  minReplicas: 2
  maxReplicas: 50
  metrics:
    - type: Pods
      pods:
        metric:
          name: myapp_queue_depth        # exposed via prometheus-adapter
        target:
          type: AverageValue
          averageValue: "100"            # scale up when avg depth > 100/pod
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30    # react quickly to queue buildup
      policies:
        - type: Pods
          value: 5
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300   # wait 5 min before scaling down
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60
```

### Junior → FAANG: Scheduling as the Reliability Foundation

The concepts in this section are frequently tested in Kubernetes interviews because they have direct consequences for production reliability. Topology spread constraints are the most impactful because they prevent the single-AZ failure mode: if all replicas land in one availability zone and that zone has a network partition, your service goes completely down even though the cluster has healthy nodes in other zones.

The practical first-job habit: every stateless service with more than one replica should have a topology spread constraint on `topology.kubernetes.io/zone`. The `whenUnsatisfiable: DoNotSchedule` vs `ScheduleAnyway` distinction matters: use `DoNotSchedule` for zone distribution (a hard requirement for HA) and `ScheduleAnyway` for node distribution within a zone (a soft preference for resource efficiency).

Taints and tolerations are the mechanism for dedicated node pools. Know the two use cases by heart: GPU nodes tainted so that only GPU-requesting workloads land there, and spot nodes tainted so that only batch jobs that can tolerate eviction land there. The key detail is that a taint alone only repels pods. You also need a node selector or affinity to actively attract the right workload to the right node type.

Pod Disruption Budgets are the part of this section that most junior engineers skip until they experience a cluster upgrade outage. The practical rule: every production Deployment with more than one replica should have a PDB with `minAvailable` set to the number of replicas required to serve traffic during a drain event.

### Senior @ FAANG: Scheduling as a Cluster Economics and Safety Problem

At staff level, scheduling decisions aggregate across hundreds of services and the cluster autoscaler makes decisions about node provisioning based on those aggregate signals. Individual scheduling constraints that seem reasonable in isolation can combine to create pathological behavior at cluster scale.

The topology spread constraint interaction with the cluster autoscaler is the most important aggregate effect to understand. A `DoNotSchedule` constraint with `minDomains: 3` means that if one of three zones is temporarily unavailable (during a zone maintenance event), the autoscaler cannot schedule new pods because the zone constraint cannot be satisfied with only two zones. This can cause a cascading unavailability: zone issues prevent scale-out, which prevents the service from handling the traffic that was redirected away from the impaired zone. The mitigation is `minDomains` tuned to match the cluster's minimum guaranteed zone count, with monitoring that fires before the zone constraint prevents scheduling.

PDB configuration at scale has a cluster upgrade implication. A PDB with `minAvailable: N` where N equals the current replica count blocks node drain indefinitely. At FAANG scale with hundreds of services and regular cluster upgrades (for Kubernetes version bumps and node operating system patches), PDB misconfiguration is one of the most common reasons cluster upgrades stall. Platform teams at this scale maintain automated tooling that validates every PDB against the current replica count before initiating a drain operation, and they set organizational standards for the minimum gap between `minAvailable` and `replicaCount`.

The HPA plus topology spread interaction is a subtler problem. When HPA scales a Deployment from 6 to 12 replicas in response to a traffic spike, the new pods must satisfy the topology spread constraint. If one zone has fewer available nodes (perhaps because the autoscaler has not yet provisioned new nodes there), the pods may fail to schedule until the autoscaler responds. The result is that the HPA signals scale-out but the pods remain Pending for 30 to 90 seconds while nodes provision. For latency-sensitive services, this gap can translate to SLO violations. Overprovisioning (keeping 1 to 2 spare nodes per zone using pause pod patterns) reduces this scheduling latency at the cost of higher idle compute spend. Documenting this trade-off as an ADR, with the cost of overprovisioning weighed against the frequency and duration of scheduling delays, is a staff-level deliverable.

---
