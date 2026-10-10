## 98.11 Kubernetes Operators with Go

### Understanding Operators

A Kubernetes Operator encodes operational knowledge about a specific application into a software controller that runs inside the cluster. It combines a Custom Resource Definition (CRD), which extends the Kubernetes API with new object types, with a reconciliation loop that continuously drives the actual cluster state toward the desired state expressed in those custom objects. This pattern allows complex, stateful applications, databases, message brokers, certificate managers, to be managed with the same declarative model as native Kubernetes resources.

```
┌──────────────────────────────────────────────────────────────────┐
│                 KUBERNETES OPERATOR PATTERN                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  OPERATOR = Custom Controller + Custom Resource Definition       │
│                                                                  │
│  CRD (Custom Resource Definition):                               │
│  └── Extends Kubernetes API with new resource types              │
│                                                                  │
│  Controller:                                                     │
│  └── Watches CRDs and reconciles actual state to desired state   │
│                                                                  │
│  RECONCILIATION LOOP:                                            │
│  ┌─────────────┐                                                 │
│  │ Watch Event │ → Observe → Compare → Act → │ Watch Event │     │
│  │  (Create)   │    CRs      State    Fix    │  (Update)   │     │
│  └─────────────┘                             └─────────────┘     │
│                                                                  │
│  USE CASES:                                                      │
│  ├── Database provisioning (PostgreSQL, MySQL)                   │
│  ├── Certificate management (cert-manager)                       │
│  ├── Application lifecycle (Argo CD)                             │
│  └── Complex stateful applications                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Custom Resource Definition Example

Before writing any controller code, you must register the new resource type with the Kubernetes API server by applying a CRD manifest. The YAML below defines a `GoApp` resource in the `example.com` group, specifying the OpenAPI v3 schema that Kubernetes uses to validate every `GoApp` object at admission time. Notice how `spec.replicas` carries a minimum, maximum, and default value, API-level constraints that prevent invalid configurations from ever reaching the controller.

```yaml
# crd/goapp_crd.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: goapps.example.com
spec:
  group: example.com
  names:
    kind: GoApp
    listKind: GoAppList
    plural: goapps
    singular: goapp
    shortNames:
      - ga
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required:
                - image
              properties:
                image:
                  type: string
                replicas:
                  type: integer
                  minimum: 1
                  maximum: 100
                  default: 1
                port:
                  type: integer
                  default: 8080
                env:
                  type: array
                  items:
                    type: object
                    properties:
                      name:
                        type: string
                      value:
                        type: string
                resources:
                  type: object
                  properties:
                    cpu:
                      type: string
                      default: "100m"
                    memory:
                      type: string
                      default: "128Mi"
            status:
              type: object
              properties:
                availableReplicas:
                  type: integer
                conditions:
                  type: array
                  items:
                    type: object
                    properties:
                      type:
                        type: string
                      status:
                        type: string
                      lastTransitionTime:
                        type: string
                      reason:
                        type: string
                      message:
                        type: string
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Replicas
          type: integer
          jsonPath: .spec.replicas
        - name: Available
          type: integer
          jsonPath: .status.availableReplicas
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
```

### Go Controller Implementation

The controller is the heart of the operator: a Go struct that implements a `Reconcile` method called by controller-runtime whenever a watched object changes. The reconciler fetches the current `GoApp` instance, constructs the desired `Deployment` and `Service` objects, and either creates them or updates them if the live state diverges from the spec. Setting a controller reference on each owned object ensures Kubernetes garbage-collects the `Deployment` and `Service` automatically when the parent `GoApp` is deleted.

```go
// controllers/goapp_controller.go
package controllers

import (
    "context"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/apimachinery/pkg/util/intstr"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"

    examplev1alpha1 "github.com/myorg/goapp-operator/api/v1alpha1"
)

type GoAppReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=example.com,resources=goapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=example.com,resources=goapps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete

func (r *GoAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    // Fetch the GoApp instance
    goapp := &examplev1alpha1.GoApp{}
    err := r.Get(ctx, req.NamespacedName, goapp)
    if err != nil {
        if errors.IsNotFound(err) {
            // Object not found, might have been deleted
            logger.Info("GoApp resource not found, ignoring")
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, err
    }

    // Create or update Deployment
    deployment := r.deploymentForGoApp(goapp)
    if err := ctrl.SetControllerReference(goapp, deployment, r.Scheme); err != nil {
        return ctrl.Result{}, err
    }

    found := &appsv1.Deployment{}
    err = r.Get(ctx, types.NamespacedName{Name: deployment.Name, Namespace: deployment.Namespace}, found)
    if err != nil && errors.IsNotFound(err) {
        logger.Info("Creating Deployment", "name", deployment.Name)
        err = r.Create(ctx, deployment)
        if err != nil {
            return ctrl.Result{}, err
        }
    } else if err == nil {
        // Update if spec changed
        if needsUpdate(found, deployment) {
            logger.Info("Updating Deployment", "name", deployment.Name)
            found.Spec = deployment.Spec
            err = r.Update(ctx, found)
            if err != nil {
                return ctrl.Result{}, err
            }
        }
    }

    // Create or update Service
    service := r.serviceForGoApp(goapp)
    if err := ctrl.SetControllerReference(goapp, service, r.Scheme); err != nil {
        return ctrl.Result{}, err
    }

    foundSvc := &corev1.Service{}
    err = r.Get(ctx, types.NamespacedName{Name: service.Name, Namespace: service.Namespace}, foundSvc)
    if err != nil && errors.IsNotFound(err) {
        logger.Info("Creating Service", "name", service.Name)
        err = r.Create(ctx, service)
        if err != nil {
            return ctrl.Result{}, err
        }
    }

    // Update status
    deployment = &appsv1.Deployment{}
    if err := r.Get(ctx, types.NamespacedName{Name: goapp.Name, Namespace: goapp.Namespace}, deployment); err == nil {
        goapp.Status.AvailableReplicas = deployment.Status.AvailableReplicas
        if err := r.Status().Update(ctx, goapp); err != nil {
            return ctrl.Result{}, err
        }
    }

    return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *GoAppReconciler) deploymentForGoApp(goapp *examplev1alpha1.GoApp) *appsv1.Deployment {
    labels := map[string]string{"app": goapp.Name}
    replicas := int32(goapp.Spec.Replicas)

    return &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      goapp.Name,
            Namespace: goapp.Namespace,
            Labels:    labels,
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: &replicas,
            Selector: &metav1.LabelSelector{
                MatchLabels: labels,
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: labels,
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{{
                        Name:  "app",
                        Image: goapp.Spec.Image,
                        Ports: []corev1.ContainerPort{{
                            ContainerPort: int32(goapp.Spec.Port),
                        }},
                        Resources: corev1.ResourceRequirements{
                            Requests: corev1.ResourceList{
                                corev1.ResourceCPU:    resource.MustParse(goapp.Spec.Resources.CPU),
                                corev1.ResourceMemory: resource.MustParse(goapp.Spec.Resources.Memory),
                            },
                        },
                    }},
                },
            },
        },
    }
}

func (r *GoAppReconciler) serviceForGoApp(goapp *examplev1alpha1.GoApp) *corev1.Service {
    return &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      goapp.Name,
            Namespace: goapp.Namespace,
        },
        Spec: corev1.ServiceSpec{
            Selector: map[string]string{"app": goapp.Name},
            Ports: []corev1.ServicePort{{
                Port:       80,
                TargetPort: intstr.FromInt(goapp.Spec.Port),
            }},
        },
    }
}

func needsUpdate(current, desired *appsv1.Deployment) bool {
    return *current.Spec.Replicas != *desired.Spec.Replicas
}

func (r *GoAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&examplev1alpha1.GoApp{}).
        Owns(&appsv1.Deployment{}).
        Owns(&corev1.Service{}).
        Complete(r)
}
```

### Using the Custom Resource

Once the CRD is registered and the operator is running, users interact with their application through ordinary `kubectl` commands against the new `GoApp` resource type. The YAML manifest below declares a three-replica deployment of a custom image, passing environment variables and resource constraints directly in the spec rather than managing a separate Deployment object by hand. The subsequent bash commands show the full workflow: applying the CRD, creating the resource, and verifying that the operator has automatically provisioned the backing Deployment and Service.

```yaml
# example-goapp.yaml
apiVersion: example.com/v1alpha1
kind: GoApp
metadata:
  name: my-go-service
  namespace: default
spec:
  image: myregistry/myapp:v1.0.0
  replicas: 3
  port: 8080
  env:
    - name: LOG_LEVEL
      value: "info"
    - name: ENVIRONMENT
      value: "production"
  resources:
    cpu: "200m"
    memory: "256Mi"
```

```bash
# Apply the CRD
kubectl apply -f crd/goapp_crd.yaml

# Create a GoApp resource
kubectl apply -f example-goapp.yaml

# Check the resource
kubectl get goapps
# NAME            REPLICAS   AVAILABLE   AGE
# my-go-service   3          3           5m

# The operator automatically creates:
# - Deployment with 3 replicas
# - Service for load balancing
```

### Junior → FAANG: When Operators Are and Are Not the Right Tool

Operators are one of the most over-used patterns in Kubernetes. The core question is: does this problem require custom reconciliation logic running inside the cluster, or can it be solved with existing Kubernetes resources plus an external script or pipeline? Operators add significant operational burden (deployment, RBAC, leader election, versioning, testing), and that burden is only justified when the problem genuinely requires continuous in-cluster reconciliation.

The canonical use cases where operators make sense: managing stateful applications with complex lifecycle operations (databases with primary/replica failover, Kafka cluster management, certificate rotation), or exposing a higher-level domain abstraction that maps to multiple lower-level Kubernetes resources (a "WebApp" CRD that creates a Deployment, Service, HPA, and Ingress together). Operators are not the right tool for one-time setup tasks, periodic batch jobs, or simple configuration that can be expressed in standard Kubernetes resources.

For entry-level understanding, focus on the reconcile loop pattern: the controller watches for changes to its custom resources and continuously reconciles actual state with desired state. Understanding idempotency (the reconcile loop can be called many times with the same input and always produce the same result) is the key correctness requirement.

### Senior @ FAANG: Operator Architecture and Production Readiness Requirements

At staff level, writing an operator is a software product decision, not a scripting exercise. An operator that is used by multiple teams or in production clusters needs the same quality bar as any other critical platform component: versioned API (CRD schema with validation), migration strategy for breaking API changes, comprehensive test suite (unit tests for the reconciler, integration tests with envtest, e2e tests with a real cluster), observability (reconcile loop metrics, custom resource status conditions, structured logs), and runbooks for common operational scenarios (stuck reconciliation, leader election failure, CRD schema conflict during upgrade).

The leader election requirement is frequently forgotten. An operator Deployment with multiple replicas needs leader election to prevent multiple instances from running reconcile loops simultaneously and creating race conditions. The `controller-runtime` framework provides leader election built-in, but it needs to be explicitly configured.

CRD versioning is the most complex operational concern for operators at scale. When the API needs to change incompatibly (field rename, type change, new required field), you need a conversion webhook that translates between versions and a migration plan for existing resources. Getting this wrong can cause the API server to reject all resources of the affected type during a CRD upgrade, which is a cluster-wide incident. The ADR for any new CRD should include an explicit plan for how API evolution will be handled.

---
