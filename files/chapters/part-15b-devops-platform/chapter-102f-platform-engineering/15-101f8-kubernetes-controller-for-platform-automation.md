## 102F.13 Kubernetes Controller for Platform Automation

Platform teams build custom Kubernetes controllers to automate provisioning. A controller watches custom resources and reconciles desired state - the same pattern used by ArgoCD, Crossplane, and cert-manager.

### Controller Architecture

```
ServiceOnboarding CR applied
         │
         ▼
  controller-manager watches
         │
         ▼
  Reconcile() called
    ├── ensureNamespace() ──► create {team}-{service} namespace
    ├── ensureRBAC()     ──► bind team's GitHub group to edit role
    ├── ensureDatabase() ──► create Crossplane PostgreSQLInstance
    └── ensureGitHubRepo()──► create repo from golden path template
         │
         ▼
  Status updated: Phase=Ready
```

### Custom Resource Definition

The `ServiceOnboarding` CRD is the API contract between platform teams and application teams. Instead of a developer opening a Jira ticket to request a namespace, RBAC binding, and database, they `kubectl apply` a single YAML object. The controller's `Reconcile` function is a state machine driven by `Status` flags. Each sub-step (namespace, RBAC, database) writes its own boolean before returning, so a controller restart or transient API error replays only the remaining steps rather than repeating work.

```go
package controller

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	kerrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

// ServiceOnboarding is the platform CRD for service provisioning.
// Teams apply this YAML - the controller creates namespace, RBAC, and databases.
type ServiceOnboarding struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              ServiceOnboardingSpec   `json:"spec"`
	Status            ServiceOnboardingStatus `json:"status,omitempty"`
}

type ServiceOnboardingSpec struct {
	ServiceName   string `json:"serviceName"`
	TeamName      string `json:"teamName"`
	Environment   string `json:"environment"` // dev, staging, prod
	NeedsDatabase bool   `json:"needsDatabase"`
	Owner         string `json:"owner"` // GitHub team slug
}

type ServiceOnboardingStatus struct {
	Phase            string       `json:"phase"` // Pending, Creating, Ready, Failed
	NamespaceCreated bool         `json:"namespaceCreated"`
	RBACCreated      bool         `json:"rbacCreated"`
	DatabaseCreated  bool         `json:"databaseCreated"`
	ReadyAt          *metav1.Time `json:"readyAt,omitempty"`
}

// DeepCopyObject implements runtime.Object for ServiceOnboarding.
func (in *ServiceOnboarding) DeepCopyObject() runtime.Object {
	out := *in
	return &out
}

type PostgreSQLInstance struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              PostgreSQLInstanceSpec `json:"spec"`
}

// DeepCopyObject implements runtime.Object for PostgreSQLInstance.
func (in *PostgreSQLInstance) DeepCopyObject() runtime.Object {
	out := *in
	return &out
}

type PostgreSQLInstanceSpec struct {
	StorageGB     int    `json:"storageGB"`
	EngineVersion string `json:"engineVersion"`
}

type GitHubClient interface {
	CreateFromTemplate(ctx context.Context, owner, serviceName string) error
}

// Reconcile advances the provisioning state machine one step per call.
// Each step is idempotent - safe to retry on controller restart.
type ServiceOnboardingReconciler struct {
	client.Client
	github GitHubClient
}

func (r *ServiceOnboardingReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	var o ServiceOnboarding
	if err := r.Get(ctx, req.NamespacedName, &o); err != nil {
		if kerrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}
	logger.Info("reconciling", "service", o.Spec.ServiceName)

	if !o.Status.NamespaceCreated {
		if err := r.ensureNamespace(ctx, &o); err != nil {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, err
		}
	}
	if !o.Status.RBACCreated {
		if err := r.ensureRBAC(ctx, &o); err != nil {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, err
		}
	}
	if o.Spec.NeedsDatabase && !o.Status.DatabaseCreated {
		if err := r.ensureDatabase(ctx, &o); err != nil {
			return ctrl.Result{RequeueAfter: 60 * time.Second}, err
		}
	}
	if err := r.github.CreateFromTemplate(ctx, o.Spec.Owner, o.Spec.ServiceName); err != nil {
		logger.Error(err, "github repo creation failed (non-fatal)")
	}

	now := metav1.Now()
	o.Status.Phase = "Ready"
	o.Status.ReadyAt = &now
	return ctrl.Result{}, r.Status().Update(ctx, &o)
}

func (r *ServiceOnboardingReconciler) ensureNamespace(ctx context.Context, o *ServiceOnboarding) error {
	name := fmt.Sprintf("%s-%s", o.Spec.TeamName, o.Spec.ServiceName)
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
			Labels: map[string]string{
				"team": o.Spec.TeamName, "service": o.Spec.ServiceName,
				"env": o.Spec.Environment, "managed-by": "platform-controller",
			},
		},
	}
	if err := r.Create(ctx, ns); err != nil && !kerrors.IsAlreadyExists(err) {
		return fmt.Errorf("create namespace: %w", err)
	}
	o.Status.NamespaceCreated = true
	return r.Status().Update(ctx, o)
}

func (r *ServiceOnboardingReconciler) ensureRBAC(ctx context.Context, o *ServiceOnboarding) error {
	ns := fmt.Sprintf("%s-%s", o.Spec.TeamName, o.Spec.ServiceName)
	rb := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "team-edit", Namespace: ns},
		Subjects:   []rbacv1.Subject{{Kind: "Group", Name: "github:" + o.Spec.Owner}},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "edit"},
	}
	if err := r.Create(ctx, rb); err != nil && !kerrors.IsAlreadyExists(err) {
		return fmt.Errorf("create rolebinding: %w", err)
	}
	o.Status.RBACCreated = true
	return r.Status().Update(ctx, o)
}

func (r *ServiceOnboardingReconciler) ensureDatabase(ctx context.Context, o *ServiceOnboarding) error {
	ns := fmt.Sprintf("%s-%s", o.Spec.TeamName, o.Spec.ServiceName)
	db := &PostgreSQLInstance{
		ObjectMeta: metav1.ObjectMeta{Name: o.Spec.ServiceName, Namespace: ns},
		Spec:       PostgreSQLInstanceSpec{StorageGB: 20, EngineVersion: "16"},
	}
	if err := r.Create(ctx, db); err != nil && !kerrors.IsAlreadyExists(err) {
		return fmt.Errorf("create database: %w", err)
	}
	o.Status.DatabaseCreated = true
	return r.Status().Update(ctx, o)
}

func (r *ServiceOnboardingReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).For(&ServiceOnboarding{}).Complete(r)
}
```

**Controller key patterns:**
- **Status-driven state machine**: each step writes its own status flag - safe to restart mid-provisioning
- **Idempotent creates**: always check `IsAlreadyExists` - reconcile can run dozens of times
- **RequeueAfter for async resources**: RDS takes minutes. Requeue rather than block the reconcile loop
- **Non-fatal steps**: GitHub repo creation errors don't block Kubernetes resource provisioning

### Junior → FAANG: Understanding the Controller Pattern Before Your First Platform Role

Kubernetes controllers are the backbone of modern platform automation, and many junior engineers encounter them without understanding why they are designed the way they are. The reconcile loop pattern feels different from the REST request-response pattern most engineers start with.

The key mental model: a controller does not handle events. It handles state. When `Reconcile` is called, the controller reads the current state of the world (from Kubernetes and from external systems) and takes whatever actions are needed to make the current state match the desired state. This is the same principle as a thermostat: it does not respond to a "start heating" event. It reads the current temperature and the desired temperature and decides what to do.

The `IsAlreadyExists` check on every `Create` call is mandatory because `Reconcile` can be called multiple times for the same object. A controller restart, a watch event, or a periodic resync will all trigger another reconcile call. If the controller tries to create a namespace that already exists without checking, it will log an error on every subsequent reconcile call, polluting logs and potentially masking real errors. Always check for `IsAlreadyExists` and treat it as a success case.

The `RequeueAfter: 60 * time.Second` in the database step is a critical pattern for async external resources. Creating an RDS instance takes five to fifteen minutes. If the controller blocks and polls for completion, it ties up a goroutine and blocks the work queue. Instead, the controller returns `RequeueAfter`, which schedules another reconcile call later. On the next call, the controller checks whether the database is ready (by checking the Crossplane resource status) and moves on if it is, or requeues again if it is not.

### Senior @ FAANG: Controller Design at Production Scale

The controller shown here is a good learning example but has several gaps that a senior engineer would address before shipping to production.

The first gap is rate limiting and exponential backoff. The current implementation uses a fixed `RequeueAfter: 30 * time.Second` for namespace and RBAC failures. If the Kubernetes API server is unavailable, every controller reconciling will retry every 30 seconds, creating a thundering herd. The `controller-runtime` manager provides a rate limiter via `ctrl.NewControllerManagedBy(mgr).For(&ServiceOnboarding{}).WithOptions(controller.Options{RateLimiter: ...}).Complete(r)`. The default rate limiter uses exponential backoff, which is the correct behavior for API server unavailability.

The second gap is owner references. When a `ServiceOnboarding` object is deleted, the controller does not clean up the namespace, RBAC, or database claim it created. The standard Kubernetes pattern for cascade deletion is to set the controller's created resources as owned by the `ServiceOnboarding` object using `ctrl.SetControllerReference`. When the owner is deleted, Kubernetes garbage collection automatically deletes all owned resources. Without owner references, deleting a `ServiceOnboarding` object leaves orphaned resources in the cluster.

The third gap is the status condition model. The current status uses simple boolean flags (`NamespaceCreated bool`). The Kubernetes ecosystem convention for controller status is to use a `[]metav1.Condition` slice with standard reason strings (Available, Progressing, Degraded). This makes the status machine-readable by standard tooling (kubectl describe, Backstage plugins, monitoring controllers) and provides structured event history for debugging.

At the governance level, the CRD itself is an API that product teams will take a dependency on. Once a team has a `ServiceOnboarding` YAML in their repository, you cannot remove or rename fields from the CRD schema without a versioned migration. Treat CRD schemas as public APIs: version them, document them in TechDocs, maintain backward compatibility for at least one year, and use conversion webhooks when breaking changes are unavoidable.
