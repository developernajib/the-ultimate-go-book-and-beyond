## 102E.14 Kubernetes Operators in Go

Operators encode operational knowledge into software. When Helm charts manage stateless apps well, operators manage stateful, complex systems - databases, message brokers, certificate authorities - where human runbooks would otherwise be required.

### When to Write an Operator vs Use Helm

| Situation | Use Helm | Write an Operator |
|-----------|----------|-------------------|
| Stateless app deployment | Yes | No |
| Config + secrets management | Yes | No |
| Stateful system with complex lifecycle | No | Yes |
| Automated failover / self-healing | No | Yes |
| Day-2 operations (backup, restore, resize) | No | Yes |
| Team already knows Helm | Yes | Only if needed |

### operator-sdk Quickstart

The `operator-sdk` CLI bootstraps the project layout, generates boilerplate, and wires up the controller-runtime dependencies so you can focus on reconciliation logic rather than scaffolding. The three commands below initialize the Go module with your domain, then generate the CRD type and controller stubs for a `RedisCluster` resource.

```bash
# Install operator-sdk
brew install operator-sdk

# Scaffold a new operator
operator-sdk init \
  --domain mycompany.io \
  --repo github.com/mycompany/redis-operator

# Create the RedisCluster API
operator-sdk create api \
  --group cache \
  --version v1alpha1 \
  --kind RedisCluster \
  --resource --controller
```

### CRD Type Definition

The Go struct annotated with `+kubebuilder` markers becomes the source of truth for the Custom Resource Definition. `controller-gen` reads these markers to emit the JSON Schema, RBAC manifests, and `kubectl` printer columns automatically. The `Spec` captures the user's desired state (replica count, image, storage size), while `Status` reflects the operator's observed reality and is updated through a dedicated status subresource to prevent accidental overwrites.

```go
// api/v1alpha1/rediscluster_types.go
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

// RedisClusterSpec defines the desired state of a Redis cluster.
type RedisClusterSpec struct {
	// Replicas is the number of Redis replica nodes (not counting the master).
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=5
	Replicas int32 `json:"replicas"`

	// Image is the Redis container image. Defaults to redis:8-alpine.
	// +optional
	Image string `json:"image,omitempty"`

	// StorageSize is the PVC size per Redis node, e.g. "10Gi".
	StorageSize string `json:"storageSize"`

	// Password is the name of the Secret containing key "redis-password".
	// +optional
	PasswordSecretRef string `json:"passwordSecretRef,omitempty"`
}

// RedisClusterStatus defines the observed state of a Redis cluster.
type RedisClusterStatus struct {
	// Phase is the current phase: Pending, Running, Degraded, Failed.
	Phase string `json:"phase,omitempty"`

	// ReadyReplicas is the number of ready replica pods.
	ReadyReplicas int32 `json:"readyReplicas"`

	// MasterNode is the pod name of the current Redis master.
	MasterNode string `json:"masterNode,omitempty"`

	// Conditions contains the detailed status conditions.
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Master",type=string,JSONPath=`.status.masterNode`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// RedisCluster is the Schema for the redisclusters API.
type RedisCluster struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   RedisClusterSpec   `json:"spec,omitempty"`
	Status RedisClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// RedisClusterList contains a list of RedisCluster.
type RedisClusterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []RedisCluster `json:"items"`
}

var (
	GroupVersion  = schema.GroupVersion{Group: "cache.mycompany.io", Version: "v1alpha1"}
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
	AddToScheme   = SchemeBuilder.AddToScheme
)

func init() {
	SchemeBuilder.Register(&RedisCluster{}, &RedisClusterList{})
}
```

### Controller Reconcile Loop

The `Reconcile` method is called whenever the desired or observed state of a `RedisCluster` changes. It must be idempotent because Kubernetes may invoke it multiple times for the same event. The loop follows a standard pattern: fetch the resource, handle deletion via a finalizer that triggers a pre-delete backup, then drive each owned child resource (ConfigMap, headless Service, StatefulSet) toward its desired state before updating the CR's status subresource.

```go
// internal/controller/rediscluster_controller.go
package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	cachev1alpha1 "github.com/mycompany/redis-operator/api/v1alpha1"
)

const redisClusterFinalizer = "cache.mycompany.io/finalizer"

// RedisClusterReconciler reconciles a RedisCluster object.
type RedisClusterReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=cache.mycompany.io,resources=redisclusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=cache.mycompany.io,resources=redisclusters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=cache.mycompany.io,resources=redisclusters/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services;configmaps,verbs=get;list;watch;create;update;patch;delete

func (r *RedisClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// 1. Fetch the RedisCluster resource
	cluster := &cachev1alpha1.RedisCluster{}
	if err := r.Get(ctx, req.NamespacedName, cluster); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil // deleted - nothing to do
		}
		return ctrl.Result{}, fmt.Errorf("get RedisCluster: %w", err)
	}

	// 2. Handle deletion via finalizer
	if !cluster.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, cluster)
	}

	// 3. Add finalizer if missing
	if !controllerutil.ContainsFinalizer(cluster, redisClusterFinalizer) {
		controllerutil.AddFinalizer(cluster, redisClusterFinalizer)
		if err := r.Update(ctx, cluster); err != nil {
			return ctrl.Result{}, fmt.Errorf("add finalizer: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	// 4. Reconcile ConfigMap (redis.conf)
	if err := r.reconcileConfigMap(ctx, cluster); err != nil {
		logger.Error(err, "reconcile ConfigMap failed")
		return ctrl.Result{}, err
	}

	// 5. Reconcile headless Service (for StatefulSet DNS)
	if err := r.reconcileService(ctx, cluster); err != nil {
		logger.Error(err, "reconcile Service failed")
		return ctrl.Result{}, err
	}

	// 6. Reconcile StatefulSet
	if err := r.reconcileStatefulSet(ctx, cluster); err != nil {
		logger.Error(err, "reconcile StatefulSet failed")
		return ctrl.Result{}, err
	}

	// 7. Update status
	return r.updateStatus(ctx, cluster)
}

func (r *RedisClusterReconciler) reconcileStatefulSet(ctx context.Context, cluster *cachev1alpha1.RedisCluster) error {
	image := cluster.Spec.Image
	if image == "" {
		image = "redis:8-alpine"
	}

	replicas := cluster.Spec.Replicas + 1 // +1 for master

	desired := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      cluster.Name,
			Namespace: cluster.Namespace,
		},
		Spec: appsv1.StatefulSetSpec{
			Replicas:    &replicas,
			ServiceName: cluster.Name + "-headless",
			Selector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"app": cluster.Name},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{"app": cluster.Name},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "redis",
							Image: image,
							Ports: []corev1.ContainerPort{
								{Name: "redis", ContainerPort: 6379},
							},
							Command: []string{
								"redis-server",
								"/etc/redis/redis.conf",
							},
						},
					},
				},
			},
		},
	}

	// Set owner reference so StatefulSet is GC'd when RedisCluster is deleted
	if err := controllerutil.SetControllerReference(cluster, desired, r.Scheme); err != nil {
		return fmt.Errorf("set owner reference: %w", err)
	}

	existing := &appsv1.StatefulSet{}
	err := r.Get(ctx, types.NamespacedName{Name: desired.Name, Namespace: desired.Namespace}, existing)
	if errors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}

	// Update replicas if changed
	existing.Spec.Replicas = desired.Spec.Replicas
	existing.Spec.Template.Spec.Containers[0].Image = image
	return r.Update(ctx, existing)
}

func (r *RedisClusterReconciler) handleDeletion(ctx context.Context, cluster *cachev1alpha1.RedisCluster) (ctrl.Result, error) {
	if controllerutil.ContainsFinalizer(cluster, redisClusterFinalizer) {
		// Custom cleanup: snapshot Redis data before deleting PVCs
		log.FromContext(ctx).Info("running pre-delete cleanup", "cluster", cluster.Name)
		// ... trigger backup job ...

		controllerutil.RemoveFinalizer(cluster, redisClusterFinalizer)
		if err := r.Update(ctx, cluster); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{}, nil
}

func (r *RedisClusterReconciler) reconcileConfigMap(ctx context.Context, cluster *cachev1alpha1.RedisCluster) error {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      cluster.Name + "-config",
			Namespace: cluster.Namespace,
		},
		Data: map[string]string{
			"redis.conf": "save 60 1000\nloglevel notice\nmaxmemory-policy allkeys-lru\n",
		},
	}
	_ = controllerutil.SetControllerReference(cluster, cm, r.Scheme)
	existing := &corev1.ConfigMap{}
	if err := r.Get(ctx, types.NamespacedName{Name: cm.Name, Namespace: cm.Namespace}, existing); err != nil {
		if errors.IsNotFound(err) {
			return r.Create(ctx, cm)
		}
		return err
	}
	existing.Data = cm.Data
	return r.Update(ctx, existing)
}

func (r *RedisClusterReconciler) reconcileService(ctx context.Context, cluster *cachev1alpha1.RedisCluster) error {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      cluster.Name + "-headless",
			Namespace: cluster.Namespace,
		},
		Spec: corev1.ServiceSpec{
			ClusterIP: "None",
			Selector:  map[string]string{"app": cluster.Name},
			Ports: []corev1.ServicePort{
				{Name: "redis", Port: 6379},
			},
		},
	}
	_ = controllerutil.SetControllerReference(cluster, svc, r.Scheme)
	existing := &corev1.Service{}
	if err := r.Get(ctx, types.NamespacedName{Name: svc.Name, Namespace: svc.Namespace}, existing); errors.IsNotFound(err) {
		return r.Create(ctx, svc)
	} else {
		return err
	}
}

func (r *RedisClusterReconciler) updateStatus(ctx context.Context, cluster *cachev1alpha1.RedisCluster) (ctrl.Result, error) {
	cluster.Status.Phase = "Running"
	cluster.Status.MasterNode = cluster.Name + "-0"
	if err := r.Status().Update(ctx, cluster); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// SetupWithManager registers the controller and sets up watches.
func (r *RedisClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&cachev1alpha1.RedisCluster{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.ConfigMap{}).
		Complete(r)
}
```

### Testing Operators with envtest

`envtest` runs a real API server and etcd binary locally - no cluster needed:

```go
// internal/controller/rediscluster_controller_test.go
package controller_test

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	cachev1alpha1 "github.com/mycompany/redis-operator/api/v1alpha1"
)

var _ = Describe("RedisCluster Controller", func() {
	const (
		clusterName = "test-redis"
		namespace   = "default"
		timeout     = 10 * time.Second
		interval    = 250 * time.Millisecond
	)

	Context("When creating a RedisCluster", func() {
		It("Should create a StatefulSet with correct replica count", func() {
			ctx := context.Background()

			cluster := &cachev1alpha1.RedisCluster{
				ObjectMeta: metav1.ObjectMeta{
					Name:      clusterName,
					Namespace: namespace,
				},
				Spec: cachev1alpha1.RedisClusterSpec{
					Replicas:    2,
					StorageSize: "1Gi",
				},
			}
			Expect(k8sClient.Create(ctx, cluster)).To(Succeed())

			key := types.NamespacedName{Name: clusterName, Namespace: namespace}

			Eventually(func() string {
				c := &cachev1alpha1.RedisCluster{}
				_ = k8sClient.Get(ctx, key, c)
				return c.Status.Phase
			}, timeout, interval).Should(Equal("Running"))
		})
	})
})
```

### Junior → FAANG: Operators as the Entry Point to Go in Kubernetes

The operator pattern is where Go becomes the primary language for Kubernetes platform work rather than a secondary tool. YAML describes desired state. Go implements the reconciliation logic that drives the cluster toward that state. Understanding this division is the conceptual entry point.

The most important concept to internalize from the reconcile loop code: the `Reconcile` method is called for any change to the watched resource, including changes you made in the previous `Reconcile` call. This means the method must be idempotent: calling it ten times with the same input must produce the same result as calling it once. The `errors.IsNotFound(err)` check before creating a StatefulSet is an example of this: if it already exists, skip creation. If the check was missing and the code always called `Create`, it would fail with "already exists" errors on every subsequent reconcile.

The finalizer pattern is the second critical concept. Without a finalizer, deleting a custom resource immediately removes it from etcd, and the controller never gets a chance to clean up the real resources it created (cloud databases, external load balancers, DNS records). The finalizer holds the resource in a terminating state until the controller completes its cleanup and removes the finalizer. Practice explaining this verbally: "the deletion timestamp is set but the object is not deleted yet because it has a finalizer, which gives my controller time to run cleanup before Kubernetes garbage-collects it."

### Senior @ FAANG: Operators as Organizational Infrastructure

At staff level, the decision to write an operator is a significant organizational commitment, not a technical experiment. An operator requires ongoing maintenance, version compatibility testing against new Kubernetes releases, and an on-call rotation that understands its failure modes. The decision table at the top of this section (Helm vs Operator) is the practical output of that consideration: write an operator only when the operational complexity of the stateful system genuinely requires it.

The testing strategy for operators is more demanding than for regular Go services. Unit tests with mocked Kubernetes clients verify reconcile logic in isolation but miss the real behavior of the API server (optimistic locking, watch events, object versioning). Integration tests using `envtest` (as shown in the test file) run against a real API server and etcd binary and are the minimum bar for testing operator correctness. End-to-end tests in a `kind` cluster that verify the operator handles actual failure scenarios (pod crashes, PVC resize, rolling upgrades) are what separates a production-grade operator from a prototype.

The controller-runtime library hides significant complexity: the workqueue with exponential backoff, the informer cache that reduces API server load, the leader election mechanism that prevents split-brain in multi-replica controller deployments. At staff level, knowing what these components do and being able to reason about their failure modes is important. If the leader election lease expires (because the leader pod cannot reach etcd during a network partition), leadership transfer occurs and two controllers may briefly act simultaneously. The reconcile loop's idempotency is what prevents this from causing data corruption.

The CRD API versioning problem is the long-term governance challenge for any operator that becomes widely adopted. A `v1alpha1` CRD that grows into a `v1` stable API needs a conversion webhook that translates between versions transparently. Implementing conversion webhooks correctly is technically complex, and planning for them from the start (keeping the `v1alpha1` schema conservative, not adding semantically loaded optional fields that will be hard to deprecate) is a mark of experienced API design. The ADR for a new CRD should include the versioning strategy and the criteria for promoting from alpha to stable.

---
