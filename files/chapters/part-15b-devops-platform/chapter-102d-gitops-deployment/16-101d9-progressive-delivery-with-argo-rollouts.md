## 102D.14 Progressive Delivery with Argo Rollouts

Progressive delivery extends canary deployments with automated, metric-driven promotion and rollback. Where a basic canary manually shifts traffic, Argo Rollouts queries Prometheus, Datadog, or any HTTP endpoint to decide - without human involvement - whether to advance or abort.

### Traffic Splitting Architecture

Argo Rollouts manages traffic weight by updating the backing Service selectors or by integrating with an ingress controller (Nginx, Istio, AWS ALB). Each step is a gate: promotion only continues when the associated AnalysisRun passes.

The canonical traffic shift flow: start at 10% canary, run AnalysisRun against Prometheus checking p99 latency < 200 ms and error rate < 1%, advance to 25% on PASS, pause 2 minutes, re-analyze, advance to 50%, pause 5 minutes, run full analysis suite including Datadog success-rate check, advance to 100%. If any AnalysisRun fails at any step, Rollouts immediately aborts and returns all traffic to the stable revision. No human intervention required.

### Rollout YAML with Canary Steps

This Rollout manifest replaces a standard Kubernetes Deployment for the `shopapp` service and wires Nginx ingress-based traffic splitting so the stable and canary revisions each receive their own Service endpoint. The `steps` array defines the promotion ladder: pause at 10% for manual approval, then run increasingly thorough analysis suites at 25%, 50%, and 100%, with `abortScaleDownDelaySeconds` giving the platform time to shed in-flight connections before scaling down the failed canary.

```yaml
# rollout-shopapp.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: shopapp
  namespace: production
spec:
  replicas: 10
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: shopapp
  template:
    metadata:
      labels:
        app: shopapp
    spec:
      containers:
        - name: shopapp
          image: ghcr.io/acme/shopapp:v2.1.0
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "256Mi"
  strategy:
    canary:
      stableService: shopapp-stable
      canaryService: shopapp-canary
      trafficRouting:
        nginx:
          stableIngress: shopapp-ingress
      steps:
        - setWeight: 10
        - pause: {}
        - analysis:
            templates:
              - templateName: shopapp-latency-check
            args:
              - name: service-name
                value: shopapp-canary
        - setWeight: 25
        - pause: {duration: 2m}
        - analysis:
            templates:
              - templateName: shopapp-latency-check
              - templateName: shopapp-error-rate-check
            args:
              - name: service-name
                value: shopapp-canary
        - setWeight: 50
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: shopapp-latency-check
              - templateName: shopapp-error-rate-check
              - templateName: shopapp-success-rate-check
            args:
              - name: service-name
                value: shopapp-canary
        - setWeight: 100
      abortScaleDownDelaySeconds: 30
```

### AnalysisTemplate - p99 Latency (Prometheus)

This AnalysisTemplate queries Prometheus every 30 seconds for a total of 6 measurements and evaluates the p99 request latency against a graduated threshold: a result below 200 ms is an unconditional pass, above 300 ms is an unconditional fail, and any value in between is treated as inconclusive until the `failureLimit` of 1 is exhausted. The parameterized `service-name` argument makes the template reusable across different rollouts by injecting the concrete service label at analysis time.

```yaml
# analysis-latency.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: shopapp-latency-check
  namespace: production
spec:
  args:
    - name: service-name
  metrics:
    - name: p99-latency
      interval: 30s
      count: 6
      successCondition: result[0] < 0.200
      failureCondition: result[0] >= 0.300
      failureLimit: 1
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99,
              sum(rate(
                http_request_duration_seconds_bucket{
                  service="{{args.service-name}}"
                }[2m]
              )) by (le)
            )
```

### AnalysisTemplate - Error Rate (Prometheus)

This template computes the fraction of HTTP 5xx responses out of total requests over a 2-minute sliding window using Prometheus's `rate` function, providing a rate-of-change view that is resilient to traffic volume spikes. The dual-threshold design. Pass at ≤ 1%, fail at > 5%. Creates a tolerance band between acceptable degradation and critical failure, so that a single brief spike does not immediately abort the rollout while a sustained error elevation does.

```yaml
# analysis-error-rate.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: shopapp-error-rate-check
  namespace: production
spec:
  args:
    - name: service-name
  metrics:
    - name: error-rate
      interval: 30s
      count: 6
      successCondition: result[0] <= 0.01
      failureCondition: result[0] > 0.05
      failureLimit: 1
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(
              http_requests_total{
                service="{{args.service-name}}",
                status=~"5.."
              }[2m]
            )) /
            sum(rate(
              http_requests_total{
                service="{{args.service-name}}"
              }[2m]
            ))
```

### AnalysisTemplate - Success Rate (Datadog)

This template queries Datadog's APM trace metrics rather than Prometheus, demonstrating that Argo Rollouts supports multiple observability backends within the same rollout pipeline. The query divides HTTP 200 hit counts by total hit counts over the analysis window and multiplies by 100 to yield a percentage, requiring at least 99% success rate across 3 one-minute intervals before promotion is allowed to continue.

```yaml
# analysis-success-rate.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: shopapp-success-rate-check
  namespace: production
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate-datadog
      interval: 1m
      count: 3
      successCondition: result >= 99.0
      failureLimit: 1
      provider:
        datadog:
          apiVersion: v2
          query: |
            sum:trace.shopapp.request.hits{service:{{args.service-name}},
            http.status_code:200}.as_count() /
            sum:trace.shopapp.request.hits{service:{{args.service-name}}}.as_count() * 100
```

### Blue-Green with Instant Switchover and Post-Promotion Analysis

Blue-green deployment with Argo Rollouts maintains two fully provisioned replica sets. The active (blue) stack serving live traffic and the preview (green) stack receiving no production traffic. And switches between them by updating a single Kubernetes Service selector. This manifest disables automatic promotion (`autoPromotionEnabled: false`) so a human or CI gate must trigger the switch, runs a pre-promotion latency check against the preview stack, and then immediately validates the active stack post-switchover so that automatic revert is possible if the new version degrades under real traffic.

```yaml
# rollout-bluegreen.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: shopapp-bg
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: shopapp-bg
  template:
    metadata:
      labels:
        app: shopapp-bg
    spec:
      containers:
        - name: shopapp
          image: ghcr.io/acme/shopapp:v2.1.0
          ports:
            - containerPort: 8080
  strategy:
    blueGreen:
      activeService: shopapp-active
      previewService: shopapp-preview
      autoPromotionEnabled: false
      prePromotionAnalysis:
        templates:
          - templateName: shopapp-latency-check
        args:
          - name: service-name
            value: shopapp-preview
      postPromotionAnalysis:
        templates:
          - templateName: shopapp-error-rate-check
        args:
          - name: service-name
            value: shopapp-active
      scaleDownDelaySeconds: 300
```

The `prePromotionAnalysis` runs against the green (preview) stack before traffic is switched - catching latency regressions before any live user is affected. `postPromotionAnalysis` runs immediately after the switchover - if it fails, Rollouts automatically reverts the active service selector back to the old (blue) pods. `scaleDownDelaySeconds: 300` keeps the blue stack alive for 5 minutes post-switchover as a fast-revert safety net.

### Go: Rollout Manager - Promote, Abort, Wait

This `Manager` type wraps the Argo Rollouts clientset and exposes three focused operations. Promote, abort, and wait. So that Go-based deployment tooling or integration tests can programmatically control rollout lifecycle without shelling out to `kubectl`. `PromoteRollout` and `AbortRollout` use merge patches to mutate the minimal set of fields on the Rollout resource, while `WaitForHealthy` implements a context-aware polling loop that distinguishes between the `Healthy` terminal state and the `Degraded` error state, surfacing actionable error messages instead of timing out silently.

```go
// pkg/rollout/manager.go
package rollout

import (
	"context"
	"fmt"
	"time"

	rolloutsv1alpha1 "github.com/argoproj/argo-rollouts/pkg/apis/rollouts/v1alpha1"
	rolloutsclient "github.com/argoproj/argo-rollouts/pkg/client/clientset/versioned"
	"go.uber.org/zap"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Manager wraps the Argo Rollouts clientset with safe deployment helpers.
type Manager struct {
	client rolloutsclient.Interface
	log    *zap.Logger
}

// NewManager returns a Manager backed by the given Rollouts clientset.
func NewManager(client rolloutsclient.Interface, log *zap.Logger) *Manager {
	return &Manager{client: client, log: log}
}

// PromoteRollout advances a Rollout past the current pause step.
// This is the programmatic equivalent of: kubectl argo rollouts promote <name>
func (m *Manager) PromoteRollout(ctx context.Context, namespace, name string) error {
	patch := []byte(`{"metadata":{"annotations":{"argoproj.io/manual-resume":"true"}}}`)
	_, err := m.client.ArgoprojV1alpha1().Rollouts(namespace).
		Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("promote rollout %s/%s: %w", namespace, name, err)
	}
	m.log.Info("rollout promoted",
		zap.String("namespace", namespace),
		zap.String("name", name))
	return nil
}

// AbortRollout immediately aborts the in-progress rollout and reverts all
// traffic to the stable revision.
func (m *Manager) AbortRollout(ctx context.Context, namespace, name string) error {
	patch := []byte(`{"spec":{"abort":true}}`)
	_, err := m.client.ArgoprojV1alpha1().Rollouts(namespace).
		Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("abort rollout %s/%s: %w", namespace, name, err)
	}
	m.log.Warn("rollout aborted",
		zap.String("namespace", namespace),
		zap.String("name", name))
	return nil
}

// WaitForHealthy polls until the Rollout reaches Healthy phase or the
// context deadline is exceeded.
func (m *Manager) WaitForHealthy(
	ctx context.Context,
	namespace, name string,
	pollInterval time.Duration,
) error {
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for rollout %s/%s to become healthy", namespace, name)
		case <-time.After(pollInterval):
			rollout, err := m.client.ArgoprojV1alpha1().Rollouts(namespace).
				Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				return fmt.Errorf("get rollout %s/%s: %w", namespace, name, err)
			}
			m.log.Info("rollout status poll",
				zap.String("phase", string(rollout.Status.Phase)))
			switch rollout.Status.Phase {
			case rolloutsv1alpha1.RolloutPhaseHealthy:
				return nil
			case rolloutsv1alpha1.RolloutPhaseDegraded:
				return fmt.Errorf("rollout %s/%s is Degraded - check AnalysisRun logs", namespace, name)
			}
		}
	}
}
```

### Junior → FAANG: Reading Rollout YAML as a Promotion Script

The `steps` array in the Rollout manifest is a deployment runbook expressed as code. Each `setWeight` is a traffic shift, each `pause` is a wait gate, and each `analysis` is an automated quality check. Reading it this way, as a sequence of operations with decision points, makes the YAML easier to reason about and easier to debug when something goes wrong.

The `abortScaleDownDelaySeconds` field is easy to miss and important to understand. When a rollout is aborted, Argo Rollouts immediately returns traffic to the stable revision but waits this many seconds before scaling down the failed canary pods. This delay is for connection draining: in-flight requests to the canary that were in progress when the abort was triggered need time to complete before the pods can be terminated safely.

The `WaitForHealthy` Go function is the pattern to use when writing deployment automation that must block until a rollout completes. The polling loop with context cancellation is the correct approach: it respects timeout, handles degraded state as an error, and does not busy-wait. Apply this pattern to any situation where you need to wait for a Kubernetes resource to reach a terminal state.

### Senior @ FAANG: Progressive Delivery as a Platform Maturity Boundary

At L6, the introduction of Argo Rollouts into a platform represents a maturity boundary that requires organizational alignment, not just technical implementation. Three concerns dominate.

The first is the operator model for Rollout objects. Unlike Deployments, which every Kubernetes engineer understands, Rollouts are a domain-specific extension that require training and documented runbooks. The platform team must own the Rollout CRD installation and upgrade lifecycle, provide canonical Rollout manifests for common service archetypes (web API, worker, batch job), and maintain a troubleshooting guide that covers the most common failure modes: AnalysisRun failure, traffic routing misconfiguration, and canary pods failing readiness checks.

The second is the AnalysisTemplate governance model. Templates define what "healthy" means for a rollout. If application teams author their own templates, the definitions will be inconsistent and potentially incorrect. The platform team should own a library of organization-approved templates, document which templates are appropriate for which service types, and implement a CI check that validates Rollout manifests reference approved templates by name. New templates should go through a review process similar to API design review: the proposal must include the metric source, the success and failure thresholds with statistical justification, and the consequences of a false positive or false negative.

The third is rollout blast radius coordination across a multi-cluster fleet. When ApplicationSet's RollingSync pushes a new Rollout revision to 30 clusters sequentially, a canary that takes 30 minutes to complete means the fleet rollout takes 15 hours minimum. This is often acceptable for planned releases but incompatible with emergency hotfixes. The platform must have a mechanism to bypass the staged rollout for emergencies (typically a label that disables RollingSync for a specific ApplicationSet entry) and a post-emergency process to restore the staged rollout policy.

---
