## 102E.4 Advanced Autoscaling

### HPA with Custom Prometheus Metrics

The default HPA scales on CPU and memory, but many real-world workloads should scale on domain-specific metrics such as message queue depth, active WebSocket connections, or request latency. The KEDA (Kubernetes Event-Driven Autoscaling) controller bridges Prometheus metrics to the Kubernetes custom metrics API so that HPAs can target any metric a Prometheus scrape can produce. The configuration below scales a worker deployment based on a Kafka consumer group lag query, adding replicas when messages are piling up and scaling back in once the queue clears.

```yaml
# hpa-custom-metrics.yaml - scale based on queue depth
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: shopapp-worker
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: shopapp-worker

  minReplicas: 2
  maxReplicas: 50

  metrics:
    # Scale based on CPU (standard)
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

    # Scale based on custom Prometheus metric (requires prometheus-adapter)
    - type: Pods
      pods:
        metric:
          name: kafka_consumer_lag  # registered in prometheus-adapter config
        target:
          type: AverageValue
          averageValue: "1000"  # 1000 messages lag per pod = scale out

    # Scale based on external metric (API call queue depth from external system)
    - type: External
      external:
        metric:
          name: sqs_queue_depth
          selector:
            matchLabels:
              queue: shopapp-jobs
        target:
          type: Value
          value: "500"  # total queue depth > 500 = scale out

  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # don't scale down for 5 minutes after scale-up
      policies:
        - type: Percent
          value: 25        # scale down by at most 25% at a time
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0  # scale up immediately
      policies:
        - type: Pods
          value: 4         # add up to 4 pods per period
          periodSeconds: 15
        - type: Percent
          value: 100       # or double the pods
          periodSeconds: 15
      selectPolicy: Max    # use whichever policy adds more pods
```

### KEDA - Event-Driven Autoscaling

KEDA (Kubernetes Event-Driven Autoscaling) extends HPA with over 60 built-in scalers for external event sources. Kafka consumer group lag, SQS queue depth, Redis list length, and many more. Its defining capability is scale-to-zero: when the queue is empty, KEDA scales the consumer Deployment to zero replicas entirely, eliminating idle pod costs. When new messages arrive, KEDA scales up from zero before the first message is processed.

```yaml
# keda-scaledobject.yaml - scale to zero based on Kafka lag
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: shopapp-worker-kafka
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: shopapp-worker

  minReplicaCount: 0  # scale to ZERO when no messages
  maxReplicaCount: 50

  pollingInterval: 15   # check Kafka every 15 seconds
  cooldownPeriod: 60    # wait 60s before scaling down after last event

  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.messaging:9092
        consumerGroup: shopapp-worker
        topic: shopapp-jobs
        lagThreshold: "100"       # 1 pod per 100 messages of lag
        activationLagThreshold: "5"  # start scaling from 0 when lag > 5
        offsetResetPolicy: latest
---
# KEDA for AWS SQS
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: shopapp-sqs-processor
spec:
  scaleTargetRef:
    name: shopapp-sqs-worker
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789/shopapp-jobs
        queueLength: "50"    # target 50 messages per pod
        awsRegion: us-east-1
      authenticationRef:
        name: keda-aws-credentials
```

### VPA - Vertical Pod Autoscaler

The Vertical Pod Autoscaler (VPA) automatically adjusts CPU and memory requests for pods based on observed usage, eliminating the need to manually tune resource requests after deployment. In `Auto` mode it evicts pods to resize them immediately. In `Off` mode it only makes recommendations, which is a safe starting point. VPA recommendations are particularly valuable when setting initial requests for new services where real-world usage patterns are unknown.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: shopapp-api-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: shopapp-api
  updatePolicy:
    updateMode: "Off"  # "Off" = just recommendations; "Auto" = apply automatically
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: 2000m
          memory: 2Gi
        controlledResources: [cpu, memory]
```

```bash
# Check VPA recommendations
kubectl describe vpa shopapp-api-vpa
# Look for: Container recommendations for "api":
#   Lower Bound: cpu=50m, memory=80Mi
#   Target:      cpu=200m, memory=300Mi  ← use these values in your deployment
#   Upper Bound: cpu=500m, memory=600Mi
```

### Junior → FAANG: Knowing Which Scaler to Reach For

The most common interview question in this area is a variant of "how would you scale a Kafka consumer service?" The wrong answer is "set replicas to N." The right answer distinguishes between the signal driving scale decisions and the mechanism doing the scaling.

For a Kafka consumer, the relevant signal is consumer group lag, not CPU. CPU-based HPA will scale correctly in some cases (high CPU means the consumer is working hard), but it scales too slowly when a batch of messages arrives all at once and CPU spikes only after lag is already large. KEDA with a Kafka trigger scales on lag directly, which is the correct signal.

Know the key differences before any interview: HPA minimum is 1 replica, KEDA minimum is 0 (scale-to-zero). VPA adjusts resource requests, not replica count. HPA and VPA should not both be in `Auto` mode on the same Deployment at the same time. KEDA and HPA can coexist because KEDA uses the external metrics API that HPA already understands. These distinctions come up in scenario questions, and confusing them is a clear signal that you have not operated autoscaling in production.

The `behavior` block in the HPA manifest above is worth studying. The scale-down stabilization window of 300 seconds (5 minutes) prevents thrashing when load oscillates around the threshold. The scale-up policy of "add up to 4 pods or double the count, whichever is larger" is a deliberate choice to respond aggressively to sudden load spikes. Being able to explain why these specific numbers exist, not just what they do, is the kind of depth that separates experienced candidates.

### Senior @ FAANG: Autoscaling as a Cost and Reliability Contract

At staff level, autoscaling configuration is not a one-time setup. It is an ongoing operational contract between the platform team, the application team, and the finance team. Getting it wrong in either direction has real cost: too-aggressive scale-up wastes money on idle capacity, and too-conservative scale-up causes latency spikes and SLO violations.

The VPA recommendation workflow is the best starting point for new services. Deploy in `Off` mode, collect recommendations for two to four weeks covering normal and peak traffic patterns, then use those recommendations to set explicit requests in the Deployment. This produces resource requests that are grounded in real data rather than developer guesses. The common mistake is setting requests in development against synthetic load and then being surprised when production workloads have different memory footprints due to JVM heap growth, Go garbage collection pressure, or caching behavior.

The KEDA scale-to-zero pattern has a real cost: cold start latency. For Pinterest-style async workloads where a 30-second cold start is acceptable, it is the right choice. For workloads where the first message processed at 3 AM needs to complete within 5 seconds, scale-to-zero is not acceptable. The architectural decision is: what is the acceptable cold start budget, and does scale-to-zero fit within it? This should be an explicit ADR for any KEDA-managed workload.

At cluster scale, the aggregate effect of autoscaling decisions matters as much as individual service decisions. When 50 services all scale up simultaneously because a downstream dependency experienced latency (causing CPU spikes across consumers), the cluster itself may not have capacity to schedule all the new pods. This is the "thundering herd at the cluster level" problem, and it is solved by a combination of cluster autoscaler configuration (scale-out ahead of demand via overprovisioning buffers), per-service behavior tuning (stagger scale-up windows), and capacity planning that accounts for peak aggregate load, not just individual service peaks.

---
