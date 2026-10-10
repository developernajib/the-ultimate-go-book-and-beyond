## 102F.19 Exercises (Supplemental)

### Exercise 4: Platform Provisioning API with Kubernetes Integration

**Task**: Build a Go HTTP service that provisions Kubernetes namespaces with all required platform defaults.

**Requirements**:
1. `POST /api/v1/namespaces` - create namespace with labels, ResourceQuota, default NetworkPolicy (deny-all), LimitRange
2. `GET /api/v1/namespaces/{name}` - return current quota usage vs. Limits
3. `DELETE /api/v1/namespaces/{name}` - require `X-Confirm: delete` header. Soft-delete (apply `lifecycle: terminating` label first)
4. Prometheus metrics: `platform_provisions_total{status}`, `platform_provision_duration_seconds`
5. Auth: validate `X-Platform-Token` header against tokens in a Kubernetes Secret

**Key implementation points**:
```go
package platform

// Use controller-runtime client for type-safe Kubernetes access
import (
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// ResourceQuota defaults for all platform-provisioned namespaces
func defaultQuota(namespace string) *corev1.ResourceQuota {
    return &corev1.ResourceQuota{
        ObjectMeta: metav1.ObjectMeta{Name: "platform-defaults", Namespace: namespace},
        Spec: corev1.ResourceQuotaSpec{
            Hard: corev1.ResourceList{
                corev1.ResourceRequestsCPU:    resource.MustParse("4"),
                corev1.ResourceRequestsMemory: resource.MustParse("8Gi"),
                corev1.ResourceLimitsCPU:      resource.MustParse("8"),
                corev1.ResourceLimitsMemory:   resource.MustParse("16Gi"),
                corev1.ResourcePods:           resource.MustParse("50"),
            },
        },
    }
}
```

**Testing**: Use `sigs.k8s.io/controller-runtime/pkg/envtest` - starts a real kube-apiserver+etcd in test. No mocking required.

### Exercise 5: Service Catalog CLI Tool

**Task**: Build a `platform` CLI in Go that interacts with the Backstage catalog API.

**Commands**:
```
platform list services --team=payments          # list all services owned by team
platform get service payment-api               # show full catalog entry
platform register --file=catalog-info.yaml     # register/update a catalog entry
platform health payment-api                    # show health from catalog + Grafana
```

**Key packages**: `github.com/spf13/cobra` for CLI structure, `net/http` for Backstage API calls, `github.com/fatih/color` for terminal output formatting.

### Junior → FAANG: Building Portfolio Projects That Demonstrate Platform Thinking

These supplemental exercises are more ambitious than the initial three. Completing even one of them gives you a substantial Go project to discuss in interviews that demonstrates real platform engineering work.

Exercise 4 (provisioning API with Kubernetes integration) is the exercise with the highest interview value for a junior Go engineer. The combination of an HTTP API, Kubernetes client calls, and Prometheus instrumentation is exactly what a platform team builds in production. The `envtest` package for testing (starting a real kube-apiserver in your test process) is a skill that experienced Kubernetes engineers rely on. Knowing it exists and how to use it is an early differentiator.

Exercise 5 (service catalog CLI) demonstrates the ability to build developer-facing tooling, not just backend services. A CLI that wraps the Backstage API is the kind of internal product that gets used daily by other engineers. Building it well requires thinking about UX (clear error messages, color-coded output, helpful next-steps guidance), which is a product thinking skill that platform engineers need in addition to backend engineering skills.

The pattern of defining an interface (`DORASource` in Exercise 7) before implementing it is test-driven interface design. By defining the interface first, you can write test cases against mock implementations before the real Prometheus client is integrated. This is the Dependency Inversion Principle applied at the exercise level, and practicing it habitually is one of the most valuable skills you can develop for production Go work.

### Senior @ FAANG: What These Exercises Reveal About Production Platform Challenges

The exercises in this section encode production platform engineering challenges in a compact, learnable form. Each one represents a real problem that platform teams face at scale.

Exercise 4's soft-delete requirement (`lifecycle: terminating` label before actual deletion) reflects a production concern: namespaces in Kubernetes cannot be fully deleted until all resources within them are removed. If a team's database PVC cannot be deleted because a PodDisruptionBudget is blocking eviction, the namespace hangs in `Terminating` state indefinitely. The soft-delete pattern (apply a label, trigger cleanup automation, monitor until empty, then delete) is the production-safe approach.

Exercise 8 (catalog sync controller) encodes the challenge of keeping two systems of record consistent. Backstage is the service catalog. Kubernetes is the deployment reality. These two systems can drift: a service deployed in Kubernetes may not be registered in Backstage (shadow IT), or a Backstage entity may refer to a service that was deleted from Kubernetes (stale catalog). The controller that bridges them must handle both directions of drift and do so idempotently on every reconcile call. The "mark deprecated, never hard-delete" policy on catalog entities is a data preservation principle: losing catalog history is worse than having stale entries.

Exercise 10 (SLA dashboard API) at production scale must address a subtle timing problem: when computing uptime from Prometheus blackbox exporter data, the Prometheus retention period determines how far back historical reports can reach. If the Prometheus instance retains only 15 days of data, the platform team cannot produce a 30-day SLA report from Prometheus alone. The production solution is to record SLA data in a separate time-series store (PostgreSQL with TimescaleDB, or InfluxDB) at the end of each reporting period, so that historical reports can reach arbitrarily far back even if Prometheus data has been purged.
