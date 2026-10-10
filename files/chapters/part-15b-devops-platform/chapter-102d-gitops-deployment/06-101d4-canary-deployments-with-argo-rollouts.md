## 102D.4 Canary Deployments with Argo Rollouts

A canary deployment gradually shifts traffic from the stable version to the new one in configurable increments, pausing at each step to validate metrics before proceeding. Argo Rollouts implements this by splitting traffic between the stable and canary `ReplicaSet` using weighted Service or Ingress rules, running `AnalysisTemplate` queries against Prometheus at each step, and automatically aborting and rolling back if the error rate or latency exceeds the threshold. This gives you fine-grained risk control. A bad deployment affects only the canary percentage of users before being caught.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: shopapp-api
spec:
  replicas: 10
  selector:
    matchLabels:
      app: shopapp-api
  template:
    metadata:
      labels:
        app: shopapp-api
    spec:
      containers:
        - name: api
          image: myorg/shopapp-api:v1.6.0

  strategy:
    canary:
      # Stable service (old version)
      stableService: shopapp-api-stable
      # Canary service (new version)
      canaryService: shopapp-api-canary
      # Traffic routing (requires Istio, Nginx, or AWS ALB ingress)
      trafficRouting:
        nginx:
          stableIngress: shopapp-api

      steps:
        # Step 1: Route 10% traffic to canary
        - setWeight: 10
        # Step 2: Pause and run analysis for 5 minutes
        - pause:
            duration: 5m
        # Step 3: Automatic analysis
        - analysis:
            templates:
              - templateName: canary-analysis
            args:
              - name: service-name
                value: shopapp-api-canary
        # Step 4: Increase to 30%
        - setWeight: 30
        - pause:
            duration: 10m
        - analysis:
            templates:
              - templateName: canary-analysis
            args:
              - name: service-name
                value: shopapp-api-canary
        # Step 5: Increase to 60%
        - setWeight: 60
        - pause:
            duration: 5m
        # Step 6: Full rollout (100%)
        - setWeight: 100

      # Auto-rollback on analysis failure
      analysis:
        successfulRunHistoryLimit: 3
        unsuccessfulRunHistoryLimit: 3
---
# Analysis template: checks success rate and latency
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: canary-analysis
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 30s
      count: 5
      successCondition: result[0] >= 0.99  # 99% success rate
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(http_requests_total{
              service="{{args.service-name}}",
              status!~"5.."
            }[2m])) /
            sum(rate(http_requests_total{
              service="{{args.service-name}}"
            }[2m]))

    - name: p99-latency
      interval: 30s
      count: 5
      successCondition: result[0] < 500  # p99 < 500ms
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            histogram_quantile(0.99,
              sum(rate(http_request_duration_milliseconds_bucket{
                service="{{args.service-name}}"
              }[2m])) by (le)
            )
```

### Junior → FAANG: Understanding What Makes a Canary Actually Safe

A canary deployment without an AnalysisTemplate is a slow rolling update with extra steps. The safety comes entirely from the metric-based promotion gate. Before building your first canary, make sure you can answer: what metrics define success for this service? If you cannot identify at least one quantitative signal, the canary will always pass because there is nothing to fail it.

The practical starting point for a first production canary: pick error rate as the single metric, set the failure threshold at 5% to avoid false positives, and set `failureLimit: 1` so a single bad measurement causes an abort. After gaining confidence, tighten the threshold and add p99 latency as a second metric. Do not start with multiple metrics and tight thresholds: you will spend more time debugging false positive rollback events than shipping features.

Entry-level interview signal: when asked about canary, interviewers want to hear that you understand automated rollback. The phrase "the canary is aborted if metrics exceed the threshold" is not enough. Explain what happens: Argo Rollouts sets `spec.abort: true`, traffic returns to the stable ReplicaSet, the canary pods are eventually scaled down, and an alert fires with the specific metric that failed.

### Senior @ FAANG: Canary Analysis Design as a Signal Quality Problem

At senior level, the hardest part of canary deployment is not the tooling. It is designing analysis queries that have high signal-to-noise ratio. A poorly designed AnalysisTemplate causes one of two failure modes: it fails too often on variance (teams stop trusting it and disable it), or it passes regressions that are real but below the detection threshold (teams trust it incorrectly).

The Netflix Kayenta approach addresses this with statistical comparison rather than absolute thresholds. Instead of "error rate below 1%," the metric is "canary error rate is not significantly higher than the stable baseline error rate, using a Mann-Whitney U-test at 95% confidence." This approach is robust to traffic pattern changes: if both canary and stable show elevated error rates because a downstream dependency is degraded, the rollout is not aborted, because the canary is not worse than stable. An absolute threshold would abort the canary even though the new code is not the problem.

For FAANG-scale services, the analysis template library should be centrally owned by the platform team and versioned as a separate CRD collection in the fleet config repository. Application teams reference analysis templates by name, they do not author them. This ensures metric definitions are consistent across services, makes it possible to update thresholds fleet-wide, and creates a clear accountability boundary: the platform team owns "what does healthy mean," and the application team owns "what does the service do."

The `trafficRouting` field is a platform dependency that deserves explicit ADR documentation. Nginx canary annotations, Istio VirtualService weights, and AWS ALB target group weights have different precision characteristics. Nginx rounds traffic percentages to the nearest integer, Istio uses true weighted routing, and ALB uses connection-level weights that can behave unexpectedly at low traffic volumes. The choice of traffic routing backend should be documented as a platform-level decision, with a clear migration path if the backend changes.

---
