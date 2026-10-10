## 101.7 Webhooks (Validation and Mutation)

Admission webhooks intercept API requests before objects are persisted, giving the operator two distinct opportunities to enforce correctness. The mutating webhook (`Default()`) runs first and sets safe defaults, for example, filling in the container port and resource limits, so users can submit minimal manifests without accidentally creating pods with no resource constraints. The validating webhook (`validateWebApp()`) runs after mutation and acts as the final guard: it rejects structurally invalid requests (empty image, out-of-range replicas) and surfaces non-fatal warnings (the `:latest` tag) that are returned to the caller without blocking the operation. The `failurePolicy=fail` annotation on both webhooks means that if the webhook server is unreachable, Kubernetes denies the request rather than allowing an unvalidated object through, a safe-by-default posture appropriate for production clusters.

```go
// api/v1alpha1/webapp_webhook.go
package v1alpha1

import (
    "context"
    "fmt"
    "strings"

    ctrl "sigs.k8s.io/controller-runtime"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

var webapplog = logf.Log.WithName("webapp-resource")

func (r *WebApp) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr, r).
        WithDefaulter(&WebAppCustomDefaulter{}).
        WithValidator(&WebAppCustomValidator{}).
        Complete()
}

// +kubebuilder:webhook:path=/mutate-apps-example-com-v1alpha1-webapp,mutating=true,failurePolicy=fail,sideEffects=None,groups=apps.example.com,resources=webapps,verbs=create;update,versions=v1alpha1,name=mwebapp.kb.io,admissionReviewVersions=v1

type WebAppCustomDefaulter struct{}

var _ admission.Defaulter[*WebApp] = &WebAppCustomDefaulter{}

// Default implements admission.Defaulter[*WebApp]
func (d *WebAppCustomDefaulter) Default(ctx context.Context, r *WebApp) error {
    webapplog.Info("default", "name", r.Name)

    // Set defaults
    if r.Spec.Port == 0 {
        r.Spec.Port = 8080
    }
    if r.Spec.Resources == nil {
        r.Spec.Resources = &ResourceRequirements{
            CPU:    "100m",
            Memory: "128Mi",
        }
    }
    return nil
}

// +kubebuilder:webhook:path=/validate-apps-example-com-v1alpha1-webapp,mutating=false,failurePolicy=fail,sideEffects=None,groups=apps.example.com,resources=webapps,verbs=create;update,versions=v1alpha1,name=vwebapp.kb.io,admissionReviewVersions=v1

type WebAppCustomValidator struct{}

var _ admission.Validator[*WebApp] = &WebAppCustomValidator{}

// ValidateCreate implements admission.Validator[*WebApp]
func (v *WebAppCustomValidator) ValidateCreate(ctx context.Context, r *WebApp) (admission.Warnings, error) {
    webapplog.Info("validate create", "name", r.Name)
    return r.validateWebApp()
}

// ValidateUpdate implements admission.Validator[*WebApp]
func (v *WebAppCustomValidator) ValidateUpdate(ctx context.Context, oldObj, newObj *WebApp) (admission.Warnings, error) {
    webapplog.Info("validate update", "name", newObj.Name)
    return newObj.validateWebApp()
}

// ValidateDelete implements admission.Validator[*WebApp]
func (v *WebAppCustomValidator) ValidateDelete(ctx context.Context, r *WebApp) (admission.Warnings, error) {
    webapplog.Info("validate delete", "name", r.Name)
    return nil, nil
}

func (r *WebApp) validateWebApp() (admission.Warnings, error) {
    var warnings admission.Warnings

    // Validate image
    if r.Spec.Image == "" {
        return warnings, fmt.Errorf("image cannot be empty")
    }

    // Warn about latest tag
    if strings.HasSuffix(r.Spec.Image, ":latest") {
        warnings = append(warnings, "Using :latest tag is not recommended for production")
    }

    // Validate replicas
    if r.Spec.Replicas < 1 || r.Spec.Replicas > 10 {
        return warnings, fmt.Errorf("replicas must be between 1 and 10")
    }

    return warnings, nil
}
```

---

### Junior → FAANG: Webhooks as the Admission Gate for Custom Resources

Admission webhooks are the validation and mutation mechanism that runs before any resource is persisted to etcd. Understanding when to use validation webhooks versus CRD-level schema validation is important: CRD schema validation is fast (built into the API server) and covers structural constraints (required fields, enum values, ranges). Webhook validation handles semantic constraints that require context (does this resource reference another resource that exists?) or business logic (is this configuration internally consistent?).

The `failurePolicy: Fail` setting is the safe default for webhooks that protect critical resources. If the webhook server is unavailable and the policy is `Ignore`, resources bypass validation entirely. For production clusters, validation webhooks for security-critical resources should always use `Fail`. The operational implication is that the webhook server must be highly available: a webhook server outage blocks all resource creation in the affected namespaces.

First-job habit: always configure a `timeoutSeconds` for webhooks. The default timeout is 10 seconds. A webhook that takes more than 10 seconds (due to an upstream API call or slow database query) times out and either blocks or bypasses validation. Keep webhook logic fast by avoiding network calls: validate only what can be validated from the submitted object, without external dependencies.

### Senior @ FAANG: Webhook Architecture and the Bootstrap Problem

At staff level, webhooks have a well-known operational problem: the webhook server must be running before the CRD objects can be created, but the webhook server is deployed as a Kubernetes resource (a Deployment) that requires the API server to create it. This circular dependency (the chicken-and-egg problem) requires careful bootstrapping.

The standard solutions: use a separate deployment sequence for the CRD and webhook configuration (install CRDs first with webhook configuration disabled, deploy the operator, then enable webhooks), or use cert-manager's CertificateRequest mechanism to provision the webhook's TLS certificate automatically. The webhook TLS certificate provisioning is often the most operationally fragile part of an operator deployment: the certificate must be valid, the API server must trust the CA, and the secret containing the certificate must be mounted into the webhook server's pod. Any mismatch in this chain causes all resource admission for the affected types to fail.

The webhook configuration itself (which resources and operations it intercepts, which namespaces it applies to) should be as narrow as possible. A webhook that intercepts all resource types in all namespaces is a cluster-wide blast radius when the webhook server fails. Scoping to specific resources, operations, and namespaces using `rules` and `namespaceSelector` reduces the failure domain significantly.
