## 102E.3 Admission Webhooks in Go

Admission webhooks intercept all Kubernetes API calls and can validate or mutate resources before they're stored in etcd.

```go
// webhook/main.go
package main

import (
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "slices"
    "strings"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"
)

var (
    runtimeScheme = runtime.NewScheme()
    codecs        = serializer.NewCodecFactory(runtimeScheme)
    deserializer  = codecs.UniversalDeserializer()
)

// MutatingWebhook injects a sidecar and ensures security context
type MutatingWebhook struct {
    logger *slog.Logger
}

func (w *MutatingWebhook) Handle(rw http.ResponseWriter, r *http.Request) {
    body := make([]byte, r.ContentLength)
    r.Body.Read(body)

    var review admissionv1.AdmissionReview
    if _, _, err := deserializer.Decode(body, nil, &review); err != nil {
        http.Error(rw, fmt.Sprintf("decode error: %v", err), http.StatusBadRequest)
        return
    }

    review.Response = w.mutate(review.Request)
    review.Response.UID = review.Request.UID

    resp, err := json.Marshal(review)
    if err != nil {
        http.Error(rw, fmt.Sprintf("encode error: %v", err), http.StatusInternalServerError)
        return
    }

    rw.Header().Set("Content-Type", "application/json")
    rw.Write(resp)
}

func (w *MutatingWebhook) mutate(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
    // Only handle Pods
    if req.Kind.Kind != "Pod" {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Message: fmt.Sprintf("failed to unmarshal pod: %v", err),
            },
        }
    }

    patches := w.buildPatches(&pod)

    if len(patches) == 0 {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    patchBytes, err := json.Marshal(patches)
    if err != nil {
        return &admissionv1.AdmissionResponse{Allowed: false}
    }

    patchType := admissionv1.PatchTypeJSONPatch
    return &admissionv1.AdmissionResponse{
        Allowed:   true,
        Patch:     patchBytes,
        PatchType: &patchType,
    }
}

type jsonPatch struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value any `json:"value,omitempty"`
}

func (w *MutatingWebhook) buildPatches(pod *corev1.Pod) []jsonPatch {
    var patches []jsonPatch

    // 1. Inject Datadog APM sidecar if not already present
    hasDDAgent := false
    for _, c := range pod.Spec.Containers {
        if c.Name == "datadog-agent" {
            hasDDAgent = true
            break
        }
    }

    // Only inject if pod has annotation: inject-datadog-agent: "true"
    if !hasDDAgent && pod.Annotations["myorg.io/inject-datadog-agent"] == "true" {
        ddSidecar := corev1.Container{
            Name:  "datadog-agent",
            Image: "gcr.io/datadoghq/agent:latest",
            Env: []corev1.EnvVar{
                {Name: "DD_API_KEY", ValueFrom: &corev1.EnvVarSource{
                    SecretKeyRef: &corev1.SecretKeySelector{
                        LocalObjectReference: corev1.LocalObjectReference{Name: "datadog-secret"},
                        Key:                  "api-key",
                    },
                }},
            },
            Resources: corev1.ResourceRequirements{
                Requests: corev1.ResourceList{
                    corev1.ResourceCPU:    resource.MustParse("100m"),
                    corev1.ResourceMemory: resource.MustParse("128Mi"),
                },
                Limits: corev1.ResourceList{
                    corev1.ResourceCPU:    resource.MustParse("500m"),
                    corev1.ResourceMemory: resource.MustParse("256Mi"),
                },
            },
        }

        patches = append(patches, jsonPatch{
            Op:    "add",
            Path:  "/spec/containers/-",
            Value: ddSidecar,
        })
    }

    // 2. Ensure runAsNonRoot is set
    for i, container := range pod.Spec.Containers {
        if container.SecurityContext == nil || container.SecurityContext.RunAsNonRoot == nil {
            patches = append(patches, jsonPatch{
                Op:    "add",
                Path:  fmt.Sprintf("/spec/containers/%d/securityContext/runAsNonRoot", i),
                Value: true,
            })
        }
    }

    return patches
}

// ValidatingWebhook enforces policies
type ValidatingWebhook struct {
    logger *slog.Logger
}

func (w *ValidatingWebhook) Handle(rw http.ResponseWriter, r *http.Request) {
    body := make([]byte, r.ContentLength)
    r.Body.Read(body)

    var review admissionv1.AdmissionReview
    json.Unmarshal(body, &review)

    review.Response = w.validate(review.Request)
    review.Response.UID = review.Request.UID

    resp, _ := json.Marshal(review)
    rw.Header().Set("Content-Type", "application/json")
    rw.Write(resp)
}

func (w *ValidatingWebhook) validate(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
    if req.Kind.Kind != "Pod" {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    var pod corev1.Pod
    json.Unmarshal(req.Object.Raw, &pod)

    // Policy 1: All pods must have resource limits
    for _, container := range pod.Spec.Containers {
        if container.Resources.Limits == nil {
            return &admissionv1.AdmissionResponse{
                Allowed: false,
                Result: &metav1.Status{
                    Message: fmt.Sprintf("container %q must have resource limits defined", container.Name),
                },
            }
        }
    }

    // Policy 2: Image must come from approved registries
    approvedRegistries := []string{
        "123456789.dkr.ecr.us-east-1.amazonaws.com",
        "gcr.io/myorg",
        "k8s.gcr.io",
    }
    for _, container := range pod.Spec.Containers {
        approved := slices.ContainsFunc(approvedRegistries, func(registry string) bool {
            return strings.HasPrefix(container.Image, registry)
        })
        if !approved {
            return &admissionv1.AdmissionResponse{
                Allowed: false,
                Result: &metav1.Status{
                    Message: fmt.Sprintf("image %q is not from an approved registry", container.Image),
                },
            }
        }
    }

    return &admissionv1.AdmissionResponse{Allowed: true}
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    mutating := &MutatingWebhook{logger: logger}
    validating := &ValidatingWebhook{logger: logger}

    mux := http.NewServeMux()
    mux.HandleFunc("/mutate", mutating.Handle)
    mux.HandleFunc("/validate", validating.Handle)
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    server := &http.Server{
        Addr:    ":8443",
        Handler: mux,
    }

    logger.Info("starting webhook server", "addr", server.Addr)
    if err := server.ListenAndServeTLS("/certs/tls.crt", "/certs/tls.key"); err != nil {
        logger.Error("server error", "err", err)
        os.Exit(1)
    }
}
```

### Registering the Webhook

A `MutatingWebhookConfiguration` tells the Kubernetes API server which resource operations to intercept and where to route them. The `namespaceSelector` field restricts the webhook to namespaces carrying a specific label, preventing accidental interference with system workloads. Setting `failurePolicy: Ignore` ensures that a webhook outage never blocks pod scheduling, while `cert-manager`'s CA injection annotation keeps the TLS trust chain current without manual rotation.

```yaml
# mutating-webhook.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: myorg-sidecar-injector
  annotations:
    cert-manager.io/inject-ca-from: myorg/webhook-tls  # cert-manager injects CA bundle
webhooks:
  - name: sidecar-injector.myorg.io
    admissionReviewVersions: [v1]
    sideEffects: None
    rules:
      - operations: [CREATE, UPDATE]
        apiGroups: [""]
        apiVersions: [v1]
        resources: [pods]
    namespaceSelector:
      matchLabels:
        myorg.io/webhook: enabled  # only applies to labeled namespaces
    clientConfig:
      service:
        name: webhook-service
        namespace: myorg-system
        path: /mutate
      caBundle: ""  # filled by cert-manager
    failurePolicy: Ignore  # don't block pod creation if webhook is down
    timeoutSeconds: 5
```

### Junior → FAANG: Admission Webhooks as Your First Kubernetes Extension Point

Admission webhooks are the first Kubernetes extension that requires writing and deploying Go code rather than just applying YAML. That makes them an important signal in interviews: engineers who have built a webhook have crossed from "Kubernetes user" to "Kubernetes platform contributor."

The entry-point concept to have clear is the ordering guarantee: mutating webhooks fire first, in parallel with each other, and their result is the object that validating webhooks then inspect. This ordering is why a mutating webhook can inject a default label and a validating webhook can then require that label. If you misstate this order in an interview, it signals you have only read about webhooks, not debugged one.

The code above has two realistic policy checks: resource limits on every container and an approved image registry allowlist. Both are genuine first-job concerns. Practice explaining why each one matters: unlimited containers are a noisy-neighbor risk, and unapproved image registries are a supply-chain security gap. Being able to connect the code to the production risk it prevents is what distinguishes an experienced answer from a theoretical one.

A common junior mistake: forgetting TLS. The API server only calls webhook endpoints over HTTPS. Cert-manager with the `cert-manager.io/inject-ca-from` annotation is the production pattern shown here. Know that the CA bundle must be injected into the `WebhookConfiguration` so the API server trusts the webhook's certificate.

### Senior @ FAANG: Admission Webhooks as Policy Infrastructure

At staff level, a single webhook is not the goal. The goal is a webhook ecosystem that enforces organizational policy at every API server call, without becoming a reliability risk or a development bottleneck.

The `failurePolicy` decision is the first architectural concern. `Fail` (fail-closed) is the right choice for security-critical policies such as image registry enforcement or required security contexts. If the webhook is down and you allow the pod through anyway, you have silently bypassed your security control. `Ignore` (fail-open) is the right choice for convenience mutations like sidecar injection, where the cost of a missed injection is an incomplete feature, not a security violation. Each webhook needs its own `failurePolicy` ADR with an explicit justification. Defaulting everything to `Ignore` because it is operationally safer is a security posture decision, not a neutral choice.

High availability of webhooks is not optional for security-critical policies. A webhook that runs as a single replica and crashes during a deployment window will block all pod creation in matched namespaces. The production pattern is two or more replicas with a PodDisruptionBudget, a readiness probe that removes the pod from endpoint rotation before it becomes unresponsive, and a timeout of two to three seconds. Webhook latency adds to every API server operation in the matched path. At clusters with high pod churn (thousands of pod starts per minute), a slow webhook becomes a cluster-wide bottleneck.

Namespace exclusion is a safety valve, not a security boundary. Excluding `kube-system` via `namespaceSelector` is standard practice to prevent a webhook failure from blocking system pod recovery. But that exclusion means system namespaces do not get your security policy enforcement. The implication: cluster-level components need their own policy enforcement mechanism (typically Pod Security Standards at the namespace level) rather than relying on custom webhooks.

The long-term governance question at staff level: should the organization converge on OPA Gatekeeper or Kyverno for policy-as-code, or maintain custom Go webhooks? Custom webhooks give maximum flexibility and can encode complex business logic, but each one is a piece of software to maintain, test, deploy, and monitor. Policy engines trade some flexibility for a declarative policy language that operations teams can manage without Go expertise. The ADR for this choice should document the trade-offs and the criteria for adding a new policy category to each mechanism.

---
