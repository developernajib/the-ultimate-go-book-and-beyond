## 101.5 Main Entry Point

The `main` function is responsible for wiring every component together into a single runnable process. The `scheme` registered in `init()` is the codec the manager uses to serialize and deserialize Kubernetes objects, both the built-in types from `client-go` and the operator's own `appsv1alpha1` types must be registered here, otherwise the API client will refuse to decode responses for unknown kinds. Leader election (controlled by the `--leader-elect` flag) is critical in production: when multiple replicas of the operator pod run for high availability, only the elected leader executes reconcile loops, preventing split-brain scenarios where two controllers simultaneously mutate the same resources.

```go
// main.go
package main

import (
    "flag"
    "os"

    "k8s.io/apimachinery/pkg/runtime"
    utilruntime "k8s.io/apimachinery/pkg/util/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
    "sigs.k8s.io/controller-runtime/pkg/webhook"

    appsv1alpha1 "github.com/example/webapp-operator/api/v1alpha1"
    "github.com/example/webapp-operator/controllers"
)

var (
    scheme   = runtime.NewScheme()
    setupLog = ctrl.Log.WithName("setup")
)

func init() {
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    utilruntime.Must(appsv1alpha1.AddToScheme(scheme))
}

func main() {
    var metricsAddr string
    var enableLeaderElection bool
    var probeAddr string

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address the metric endpoint binds to.")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
    flag.BoolVar(&enableLeaderElection, "leader-elect", false, "Enable leader election for controller manager.")
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: metricsserver.Options{
            BindAddress: metricsAddr,
        },
        WebhookServer: webhook.NewServer(webhook.Options{
            Port: 9443,
        }),
        HealthProbeBindAddress: probeAddr,
        LeaderElection:         enableLeaderElection,
        LeaderElectionID:       "webapp-operator.example.com",
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    if err = (&controllers.WebAppReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create controller", "controller", "WebApp")
        os.Exit(1)
    }

    // Add health checks
    if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up health check")
        os.Exit(1)
    }
    if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up ready check")
        os.Exit(1)
    }

    setupLog.Info("starting manager")
    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        setupLog.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

---

### Junior → FAANG: Understanding the main Function as the Operator's Assembly

The operator's `main` function is the dependency injection root: it creates all the shared resources (scheme, manager, clients) and wires the controllers together. Understanding what each component does in `main` helps you debug startup failures and understand the operator's runtime behavior.

The scheme registration step is the most commonly forgotten. If a type is not registered in the scheme, the API client cannot decode responses of that type. The error message ("no kind is registered for the type X in scheme") is clear but requires understanding scheme registration to fix. The pattern is: register all API group schemes in `init()` functions (one per package) and let the manager pick them up automatically.

The `--leader-elect` flag and the manager's leader election configuration should be on by default for any production operator. The only legitimate case for disabling leader election is local development with a single operator instance. In any environment with multiple controller replicas, leader election is mandatory for correctness.

### Senior @ FAANG: Operator Deployment Architecture and Health Properties

At staff level, the operator's main function encodes the operator's deployment and health architecture. The health server (`healthz` and `readyz` endpoints) that the manager starts automatically should have meaningful checks: readiness should fail until the cache is synced (ensuring the controller has a complete view of cluster state before reconciling), liveness should pass as long as the manager goroutines are running without deadlock.

The metrics endpoint (served by the manager's metrics server) should expose standard controller-runtime metrics (reconcile duration histogram, reconcile total count, work queue depth) plus operator-specific metrics (resources managed count, cloud API call rates). These metrics, scraped by Prometheus, are the foundation of operator observability.

The operator's Deployment spec in Kubernetes needs the same production readiness treatment as any other service: resource limits, non-root security context, read-only root filesystem, liveness and readiness probes pointing to the manager's health endpoints, and a PodDisruptionBudget that prevents both operator replicas from being evicted simultaneously. Operators that are not treated as production-grade services produce operational surprises.
