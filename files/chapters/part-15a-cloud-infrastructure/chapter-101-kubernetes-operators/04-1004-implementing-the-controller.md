## 101.4 Implementing the Controller

### Complete Controller Implementation

The reconciler's `Reconcile` method is the heart of the operator: it is called whenever a `WebApp` object (or any resource it owns) changes, and its job is to make the real world match the declared spec. Two design choices here are especially important. First, the finalizer pattern prevents the `WebApp` object from being deleted by the garbage collector until the controller has had a chance to clean up external resources, without it, a `kubectl delete` would remove the CR instantly and orphan anything that was provisioned outside Kubernetes. Second, `controllerutil.SetControllerReference` stamps every child `Deployment` and `Service` with an owner reference pointing back to the `WebApp`, so Kubernetes automatically cascades deletes and the controller's `Owns()` watch triggers a reconcile whenever a child drifts from the desired state.

```go
// controllers/webapp_controller.go
package controllers

import (
    "context"
    "fmt"

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
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"

    appsv1alpha1 "github.com/example/webapp-operator/api/v1alpha1"
)

const (
    webappFinalizer = "apps.example.com/finalizer"
)

// WebAppReconciler reconciles a WebApp object
type WebAppReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=apps.example.com,resources=webapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.example.com,resources=webapps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.example.com,resources=webapps/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete

func (r *WebAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    logger.Info("Reconciling WebApp", "namespace", req.Namespace, "name", req.Name)

    // Fetch the WebApp instance
    webapp := &appsv1alpha1.WebApp{}
    if err := r.Get(ctx, req.NamespacedName, webapp); err != nil {
        if errors.IsNotFound(err) {
            // Object deleted, nothing to do
            logger.Info("WebApp resource not found. Ignoring since object must be deleted")
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, err
    }

    // Check if being deleted
    if !webapp.DeletionTimestamp.IsZero() {
        return r.handleDeletion(ctx, webapp)
    }

    // Add finalizer if not present
    if !controllerutil.ContainsFinalizer(webapp, webappFinalizer) {
        controllerutil.AddFinalizer(webapp, webappFinalizer)
        if err := r.Update(ctx, webapp); err != nil {
            return ctrl.Result{}, err
        }
    }

    // Reconcile Deployment
    if err := r.reconcileDeployment(ctx, webapp); err != nil {
        return ctrl.Result{}, err
    }

    // Reconcile Service
    if err := r.reconcileService(ctx, webapp); err != nil {
        return ctrl.Result{}, err
    }

    // Update status
    if err := r.updateStatus(ctx, webapp); err != nil {
        return ctrl.Result{}, err
    }

    logger.Info("Successfully reconciled WebApp")
    return ctrl.Result{}, nil
}

func (r *WebAppReconciler) handleDeletion(ctx context.Context, webapp *appsv1alpha1.WebApp) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    if controllerutil.ContainsFinalizer(webapp, webappFinalizer) {
        // Run finalization logic
        logger.Info("Running finalizer for WebApp")

        // Add cleanup logic here
        // For example: delete external resources, send notifications, etc.

        // Remove finalizer
        controllerutil.RemoveFinalizer(webapp, webappFinalizer)
        if err := r.Update(ctx, webapp); err != nil {
            return ctrl.Result{}, err
        }
    }

    return ctrl.Result{}, nil
}

func (r *WebAppReconciler) reconcileDeployment(ctx context.Context, webapp *appsv1alpha1.WebApp) error {
    logger := log.FromContext(ctx)

    deployment := &appsv1.Deployment{}
    deploymentName := types.NamespacedName{
        Name:      webapp.Name,
        Namespace: webapp.Namespace,
    }

    err := r.Get(ctx, deploymentName, deployment)
    if err != nil && errors.IsNotFound(err) {
        // Create new Deployment
        deployment = r.deploymentForWebApp(webapp)
        logger.Info("Creating Deployment", "name", deployment.Name)

        if err := controllerutil.SetControllerReference(webapp, deployment, r.Scheme); err != nil {
            return err
        }

        return r.Create(ctx, deployment)
    } else if err != nil {
        return err
    }

    // Update existing Deployment if needed
    if needsUpdate := r.deploymentNeedsUpdate(deployment, webapp); needsUpdate {
        logger.Info("Updating Deployment", "name", deployment.Name)
        deployment.Spec.Replicas = &webapp.Spec.Replicas
        deployment.Spec.Template.Spec.Containers[0].Image = webapp.Spec.Image
        return r.Update(ctx, deployment)
    }

    return nil
}

func (r *WebAppReconciler) deploymentForWebApp(webapp *appsv1alpha1.WebApp) *appsv1.Deployment {
    labels := map[string]string{
        "app":        webapp.Name,
        "managed-by": "webapp-operator",
    }

    resources := corev1.ResourceRequirements{}
    if webapp.Spec.Resources != nil {
        resources = corev1.ResourceRequirements{
            Requests: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse(webapp.Spec.Resources.CPU),
                corev1.ResourceMemory: resource.MustParse(webapp.Spec.Resources.Memory),
            },
            Limits: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse(webapp.Spec.Resources.CPU),
                corev1.ResourceMemory: resource.MustParse(webapp.Spec.Resources.Memory),
            },
        }
    }

    return &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      webapp.Name,
            Namespace: webapp.Namespace,
            Labels:    labels,
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: &webapp.Spec.Replicas,
            Selector: &metav1.LabelSelector{
                MatchLabels: labels,
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: labels,
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            Name:      "webapp",
                            Image:     webapp.Spec.Image,
                            Ports: []corev1.ContainerPort{
                                {
                                    ContainerPort: webapp.Spec.Port,
                                    Protocol:      corev1.ProtocolTCP,
                                },
                            },
                            Resources: resources,
                            Env:       webapp.Spec.Env,
                            LivenessProbe: &corev1.Probe{
                                ProbeHandler: corev1.ProbeHandler{
                                    HTTPGet: &corev1.HTTPGetAction{
                                        Path: "/health",
                                        Port: intstr.FromInt32(webapp.Spec.Port),
                                    },
                                },
                                InitialDelaySeconds: 10,
                                PeriodSeconds:       10,
                            },
                            ReadinessProbe: &corev1.Probe{
                                ProbeHandler: corev1.ProbeHandler{
                                    HTTPGet: &corev1.HTTPGetAction{
                                        Path: "/ready",
                                        Port: intstr.FromInt32(webapp.Spec.Port),
                                    },
                                },
                                InitialDelaySeconds: 5,
                                PeriodSeconds:       5,
                            },
                        },
                    },
                },
            },
        },
    }
}

func (r *WebAppReconciler) deploymentNeedsUpdate(deployment *appsv1.Deployment, webapp *appsv1alpha1.WebApp) bool {
    if *deployment.Spec.Replicas != webapp.Spec.Replicas {
        return true
    }
    if deployment.Spec.Template.Spec.Containers[0].Image != webapp.Spec.Image {
        return true
    }
    return false
}

func (r *WebAppReconciler) reconcileService(ctx context.Context, webapp *appsv1alpha1.WebApp) error {
    logger := log.FromContext(ctx)

    service := &corev1.Service{}
    serviceName := types.NamespacedName{
        Name:      webapp.Name,
        Namespace: webapp.Namespace,
    }

    err := r.Get(ctx, serviceName, service)
    if err != nil && errors.IsNotFound(err) {
        // Create new Service
        service = r.serviceForWebApp(webapp)
        logger.Info("Creating Service", "name", service.Name)

        if err := controllerutil.SetControllerReference(webapp, service, r.Scheme); err != nil {
            return err
        }

        return r.Create(ctx, service)
    }

    return err
}

func (r *WebAppReconciler) serviceForWebApp(webapp *appsv1alpha1.WebApp) *corev1.Service {
    labels := map[string]string{
        "app":        webapp.Name,
        "managed-by": "webapp-operator",
    }

    return &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      webapp.Name,
            Namespace: webapp.Namespace,
            Labels:    labels,
        },
        Spec: corev1.ServiceSpec{
            Selector: labels,
            Ports: []corev1.ServicePort{
                {
                    Port:       80,
                    TargetPort: intstr.FromInt32(webapp.Spec.Port),
                    Protocol:   corev1.ProtocolTCP,
                },
            },
            Type: corev1.ServiceTypeClusterIP,
        },
    }
}

func (r *WebAppReconciler) updateStatus(ctx context.Context, webapp *appsv1alpha1.WebApp) error {
    logger := log.FromContext(ctx)

    // Get deployment to update status
    deployment := &appsv1.Deployment{}
    if err := r.Get(ctx, types.NamespacedName{
        Name:      webapp.Name,
        Namespace: webapp.Namespace,
    }, deployment); err != nil {
        return err
    }

    // Update status
    webapp.Status.Replicas = deployment.Status.Replicas
    webapp.Status.AvailableReplicas = deployment.Status.AvailableReplicas

    // Determine phase
    if deployment.Status.AvailableReplicas == webapp.Spec.Replicas {
        webapp.Status.Phase = appsv1alpha1.PhaseRunning
    } else if deployment.Status.Replicas > 0 {
        webapp.Status.Phase = appsv1alpha1.PhasePending
    } else {
        webapp.Status.Phase = appsv1alpha1.PhaseUnknown
    }

    // Update conditions
    condition := metav1.Condition{
        Type:               "Available",
        LastTransitionTime: metav1.Now(),
    }
    if webapp.Status.AvailableReplicas > 0 {
        condition.Status = metav1.ConditionTrue
        condition.Reason = "DeploymentAvailable"
        condition.Message = fmt.Sprintf("%d replicas available", webapp.Status.AvailableReplicas)
    } else {
        condition.Status = metav1.ConditionFalse
        condition.Reason = "DeploymentUnavailable"
        condition.Message = "No replicas available"
    }

    webapp.Status.Conditions = []metav1.Condition{condition}

    logger.Info("Updating status", "phase", webapp.Status.Phase, "replicas", webapp.Status.Replicas)
    return r.Status().Update(ctx, webapp)
}

// SetupWithManager sets up the controller with the Manager
func (r *WebAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&appsv1alpha1.WebApp{}).
        Owns(&appsv1.Deployment{}).
        Owns(&corev1.Service{}).
        Complete(r)
}
```

---

### Junior → FAANG: Reconcile Implementation Patterns That Scale

The reconcile function is the heart of an operator, and it needs to be written with specific correctness requirements. The most important: never assume the resource exists when the reconcile function is called. Deleted resources trigger a reconcile (with the resource missing from the API server), and the function must handle this case gracefully (typically by checking for deletion timestamp and handling finalizer cleanup).

The finalizer pattern is the mechanism for cleanup on deletion. Add a finalizer to the resource when you create external state (a cloud resource, a database record) that needs to be cleaned up when the custom resource is deleted. When the resource is deleted, Kubernetes sets the deletion timestamp but does not actually delete the resource until all finalizers are removed. The reconcile function detects the deletion timestamp, performs cleanup, removes the finalizer, and the resource is then garbage collected.

First-job habit: always use `controllerutil.SetControllerReference` to set owner references on resources your controller creates. Owner references enable automatic cascade deletion: when the parent custom resource is deleted, Kubernetes automatically deletes all child resources (Deployments, Services, ConfigMaps) without requiring the controller to handle them explicitly.

### Senior @ FAANG: Controller Design for High-Availability and Consistency

At staff level, the controller's reconcile logic needs to be designed for high availability (multiple controller replicas with leader election) and consistency (the controller may be interrupted mid-reconcile and must resume correctly).

The interruption resilience requirement: the reconcile function must be resumable at any point. If the controller crashes halfway through creating a set of resources, the next reconcile call must detect what was created, what was not, and complete the work correctly. The pattern is to check existence before creating, use `CreateOrUpdate` for idempotent resource management, and use the custom resource's status to track the reconcile progress for complex multi-step operations.

The validation webhook and the controller interact in a critical way: the webhook prevents invalid resources from being created, but the controller must still handle unexpected resource states gracefully (in case the webhook is updated to allow values that the current controller version does not support). Coupling the webhook validation too tightly to the controller's implementation makes controller upgrades harder. The architectural principle is that the webhook should validate the API contract (user-visible semantics), not the controller's implementation details.
