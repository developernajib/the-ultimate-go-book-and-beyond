## 98.6 Scaling

### Horizontal Pod Autoscaler

The HPA controller polls resource metrics every 15 seconds and calculates the desired replica count as `currentReplicas × (currentMetric / targetMetric)`. The `behavior` block is critical for production workloads: without a `scaleDown.stabilizationWindowSeconds`, the HPA can rapidly shrink a Deployment after a traffic spike subsides, causing latency spikes as the next wave arrives before new Pods warm up. The configuration below sets an asymmetric policy, scale up aggressively (100% of current replicas per 15 seconds, no stabilization window) to absorb sudden load, but scale down conservatively (10% per minute with a 5-minute stabilization window) to avoid thrashing.

```yaml
# hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
```

### Junior → FAANG: Understanding HPA Behavior Before You Need It in an Incident

The HPA control loop has specific mechanics that engineers need to understand before relying on it during an incident. It polls metrics every 15 seconds by default, evaluates whether the current replica count satisfies the target utilization, and makes scale decisions. Scale-up is fast (responds within one or two polling intervals); scale-down is deliberately slow (by default, a 5-minute stabilization window prevents thrashing).

The most common junior mistake with HPA is configuring CPU targets without resource requests. HPA computes utilization as actual CPU usage divided by requested CPU. If `resources.requests.cpu` is not set, Kubernetes cannot compute utilization and the HPA will not function. Always set resource requests before enabling HPA.

Custom metrics HPA (scaling on request queue depth, active connections, or application-specific metrics) is the pattern that applies when CPU and memory do not correlate well with load. A Go service that does significant I/O may have low CPU utilization even when it is under heavy load. Scaling on request rate or queue depth is more accurate in these cases, but it requires a metrics adapter (Prometheus Adapter or KEDA) configured in the cluster.

### Senior @ FAANG: Autoscaling Architecture and Cluster Efficiency

At staff level, autoscaling is a multi-layer system with HPA (pod scaling), VPA (resource request tuning), and Cluster Autoscaler or Karpenter (node scaling) all interacting. Getting these layers to work together correctly requires understanding their independent behaviors and their interactions.

The most important interaction is HPA and Cluster Autoscaler. When HPA adds replicas and no nodes have capacity, pods become Pending. Cluster Autoscaler detects the pending pods, provisions new nodes, and the new replicas are scheduled. The time between the load spike and the new pods being ready to serve is the scale-out latency: typically 3-5 minutes for new node provisioning plus application startup. For services with spiky traffic, this latency may violate SLOs. The mitigation strategies are: over-provisioning (idle headroom that the cluster autoscaler maintains), predictive scaling (pre-warming based on historical traffic patterns), or keeping a minimum replica count that covers the expected traffic spike without autoscaling.

Karpenter (the replacement for Cluster Autoscaler on AWS) improves scale-out latency and cost efficiency by selecting the optimal instance type for each pending pod rather than using pre-configured node groups. The staff engineer concern with Karpenter is the provisioner configuration: which instance families are allowed, what the disruption budget is, and how spot instances are integrated with appropriate interruption handling. These decisions have direct cost implications and need to be reviewed quarterly against actual usage patterns.

---
