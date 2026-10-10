## Part 6: Leader Election

In production, you typically run multiple replicas of your operator for high availability. However, you only want one replica actively reconciling resources at any time to avoid conflicts and race conditions. Leader election solves this by having all replicas compete for a lock (stored as a Kubernetes Lease or ConfigMap), and only the winner processes events while the others stand by as hot backups. If the leader crashes, one of the standby replicas automatically takes over within seconds. This part configures the operator's `main.go` entrypoint with leader election support, health probes, and all the command-line flags needed for production deployment.

### Configure Leader Election

Leader election ensures that exactly one controller replica actively reconciles resources at any time, preventing split-brain conflicts when running multiple replicas for high availability. The leaderelection package from k8s.io/client-go implements this using a Kubernetes Lease object as a distributed lock.

```go
// cmd/main.go
package main

import (
    "flag"
    "os"
    "time"

    "k8s.io/apimachinery/pkg/runtime"
    utilruntime "k8s.io/apimachinery/pkg/util/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    _ "k8s.io/client-go/plugin/pkg/client/auth"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
    "sigs.k8s.io/controller-runtime/pkg/webhook"

    databasev1alpha1 "github.com/example/postgres-operator/api/v1alpha1"
    "github.com/example/postgres-operator/internal/controller"
)

var (
    scheme   = runtime.NewScheme()
    setupLog = ctrl.Log.WithName("setup")
)

func init() {
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    utilruntime.Must(databasev1alpha1.AddToScheme(scheme))
}

func main() {
    var metricsAddr string
    var enableLeaderElection bool
    var probeAddr string
    var leaderElectionID string
    var leaderElectionNamespace string
    var leaseDuration time.Duration
    var renewDeadline time.Duration
    var retryPeriod time.Duration

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address the metric endpoint binds to.")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
    flag.BoolVar(&enableLeaderElection, "leader-elect", false,
        "Enable leader election for controller manager. "+
            "Enabling this will ensure there is only one active controller manager.")
    flag.StringVar(&leaderElectionID, "leader-election-id", "postgres-operator-leader",
        "The name of the configmap that is used for holding the leader lock.")
    flag.StringVar(&leaderElectionNamespace, "leader-election-namespace", "",
        "The namespace in which the leader election configmap will be created.")
    flag.DurationVar(&leaseDuration, "leader-election-lease-duration", 15*time.Second,
        "The duration that non-leader candidates will wait to force acquire leadership.")
    flag.DurationVar(&renewDeadline, "leader-election-renew-deadline", 10*time.Second,
        "The duration that the acting master will retry refreshing leadership before giving up.")
    flag.DurationVar(&retryPeriod, "leader-election-retry-period", 2*time.Second,
        "The duration the LeaderElector clients should wait between tries of actions.")

    opts := zap.Options{
        Development: true,
    }
    opts.BindFlags(flag.CommandLine)
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

    // Determine leader election namespace
    if leaderElectionNamespace == "" {
        // Use the namespace where the operator is running
        leaderElectionNamespace = os.Getenv("POD_NAMESPACE")
        if leaderElectionNamespace == "" {
            leaderElectionNamespace = "default"
        }
    }

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
        LeaderElectionID:       leaderElectionID,
        LeaderElectionNamespace: leaderElectionNamespace,
        LeaseDuration:          &leaseDuration,
        RenewDeadline:          &renewDeadline,
        RetryPeriod:            &retryPeriod,
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    if err = (&controller.PostgresClusterReconciler{
        Client:   mgr.GetClient(),
        Scheme:   mgr.GetScheme(),
        Recorder: mgr.GetEventRecorderFor("postgres-controller"),
    }).SetupWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create controller", "controller", "PostgresCluster")
        os.Exit(1)
    }

    if err = (&databasev1alpha1.PostgresCluster{}).SetupWebhookWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create webhook", "webhook", "PostgresCluster")
        os.Exit(1)
    }

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
