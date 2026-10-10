## 101.3 Controller-Runtime Framework

### Project Structure

The controller-runtime scaffold follows a strict layout so that `controller-gen` can locate markers and generate CRD manifests, RBAC rules, and deep-copy methods automatically. Separating `api/` from `controllers/` enforces the open-closed principle: the API types can evolve independently of reconciliation logic, and the `config/` tree contains all the generated Kubernetes YAML that gets committed to Git and applied by your CD pipeline.

```
webapp-operator/
├── api/
│   └── v1alpha1/
│       ├── webapp_types.go      # CRD Go types
│       ├── groupversion_info.go # API registration
│       └── zz_generated.deepcopy.go
├── controllers/
│   └── webapp_controller.go     # Reconciliation logic
├── config/
│   ├── crd/                     # CRD manifests
│   ├── rbac/                    # RBAC rules
│   ├── manager/                 # Manager deployment
│   └── samples/                 # Sample CRs
├── main.go                      # Entry point
├── Dockerfile
└── Makefile
```

### API Types Definition

The Go structs in `webapp_types.go` are the single source of truth for the CRD schema. `+kubebuilder` marker comments are not documentation, they are machine-readable directives that `controller-gen` translates into OpenAPI v3 validation rules embedded in the CRD manifest. Validation markers like `+kubebuilder:validation:Minimum=1` are enforced by the Kubernetes API server at admission time, before your controller ever sees the object, which means invalid specs are rejected immediately rather than silently misbehaving at runtime.

```go
// api/v1alpha1/webapp_types.go
package v1alpha1

import (
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
    GroupVersion  = schema.GroupVersion{Group: "apps.example.com", Version: "v1alpha1"}
    SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
    AddToScheme   = SchemeBuilder.AddToScheme
)

// WebAppSpec defines the desired state of WebApp
type WebAppSpec struct {
    // Image is the container image to deploy
    // +kubebuilder:validation:Required
    Image string `json:"image"`

    // Replicas is the number of pods to run
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=10
    // +kubebuilder:default=1
    Replicas int32 `json:"replicas"`

    // Port is the container port to expose
    // +kubebuilder:default=8080
    Port int32 `json:"port,omitempty"`

    // Resources defines compute resources
    Resources *ResourceRequirements `json:"resources,omitempty"`

    // Env defines environment variables
    Env []corev1.EnvVar `json:"env,omitempty"`
}

type ResourceRequirements struct {
    CPU    string `json:"cpu,omitempty"`
    Memory string `json:"memory,omitempty"`
}

// WebAppStatus defines the observed state of WebApp
type WebAppStatus struct {
    // Phase represents the current phase of the WebApp
    Phase string `json:"phase,omitempty"`

    // Replicas is the actual number of replicas
    Replicas int32 `json:"replicas,omitempty"`

    // AvailableReplicas is the number of ready replicas
    AvailableReplicas int32 `json:"availableReplicas,omitempty"`

    // Conditions represent the latest available observations
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Image",type="string",JSONPath=".spec.image"
// +kubebuilder:printcolumn:name="Replicas",type="integer",JSONPath=".spec.replicas"
// +kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// WebApp is the Schema for the webapps API
type WebApp struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   WebAppSpec   `json:"spec,omitempty"`
    Status WebAppStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// WebAppList contains a list of WebApp
type WebAppList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []WebApp `json:"items"`
}

// DeepCopyObject implements runtime.Object for WebApp
func (in *WebApp) DeepCopyObject() runtime.Object {
    if in == nil {
        return nil
    }
    out := new(WebApp)
    *out = *in
    out.TypeMeta = in.TypeMeta
    in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
    out.Spec = in.Spec
    out.Status = in.Status
    return out
}

// DeepCopyObject implements runtime.Object for WebAppList
func (in *WebAppList) DeepCopyObject() runtime.Object {
    if in == nil {
        return nil
    }
    out := new(WebAppList)
    *out = *in
    out.TypeMeta = in.TypeMeta
    in.ListMeta.DeepCopyInto(&out.ListMeta)
    if in.Items != nil {
        out.Items = make([]WebApp, len(in.Items))
        copy(out.Items, in.Items)
    }
    return out
}

func init() {
    SchemeBuilder.Register(&WebApp{}, &WebAppList{})
}

// Phase constants
const (
    PhasePending  = "Pending"
    PhaseRunning  = "Running"
    PhaseFailed   = "Failed"
    PhaseUnknown  = "Unknown"
)
```

---

### Junior → FAANG: controller-runtime as the Right Abstraction Level

The `controller-runtime` framework provides the right abstraction level for building operators: it handles the informer machinery, work queue, leader election, and health server, and exposes a clean reconcile interface. Using it directly (without Kubebuilder's code generation) is feasible but requires more boilerplate. Using Kubebuilder for code generation is the standard approach for new operators.

The most important framework feature to understand is the rate-limited work queue. When the reconcile function returns an error, the framework requeues the item with exponential backoff. This means temporary failures (transient API errors, resource not yet available) are automatically retried without any application code. The application code only needs to: return an error for transient failures, and return `Result{}` without an error for permanent success.

First-job habit: understand the difference between `ctrl.Result{}` (done, no requeue), `ctrl.Result{RequeueAfter: 5 * time.Minute}` (requeue after delay), and returning an error (requeue with backoff). Using the wrong return type produces incorrect reconcile behavior that is hard to debug.

### Senior @ FAANG: controller-runtime Performance and Configuration at Scale

At staff level, controller-runtime configuration needs to be tuned for the operator's specific workload. The default cache sync period (10 hours) may be too long for fast-changing resources. The default reconcile concurrency (1 worker per controller) may be too low for an operator managing thousands of resources. The default rate limiter parameters may not match the API server's capacity.

The work queue rate limiter is the most important tuning surface. The default rate limiter (token bucket with exponential backoff) is appropriate for most cases, but operators with bursty reconcile patterns (many resources changing simultaneously) may need a higher token bucket rate to avoid artificial delays. The API server's rate limiting is the upstream constraint: increasing reconcile concurrency without regard for API server capacity can cause API priority fairness issues or throttling.

The leader election configuration requires explicit design for each operator deployment. What lease duration is appropriate (longer means slower failover, shorter means more frequent leader elections)? What renewal deadline is appropriate (how long can the leader be unavailable before being considered dead)? These parameters interact with the cluster's etcd performance characteristics and should be validated with load testing before production deployment.
