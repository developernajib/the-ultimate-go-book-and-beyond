## 102D.22 Building a Kubernetes GitOps Controller in Go

A custom GitOps controller uses `controller-runtime` to watch a `GitOpsApp` CRD, poll Git for changes, apply manifests to the cluster, and track synchronization status. This pattern is appropriate when ArgoCD is too heavyweight, when you need domain-specific reconciliation logic, or when you want to learn how GitOps tools are built internally.

### CRD Definition

The `GitOpsApp` CRD schema below captures all the fields the controller needs: a repository URL, the target revision to track, the manifest path within the repo, optional destination overrides, and a sync policy governing automated reconciliation. The `status` sub-resource exposes the current sync state and last synced commit so `kubectl get gitopsapps` can report health at a glance without querying the cluster directly.

```yaml
# config/crd/gitopsapp.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: gitopsapps.gitops.example.com
spec:
  group: gitops.example.com
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
              required: [repoURL, targetRevision, path]
              properties:
                repoURL:
                  type: string
                  format: uri
                targetRevision:
                  type: string
                  default: HEAD
                path:
                  type: string
                destination:
                  type: object
                  properties:
                    namespace:
                      type: string
                    server:
                      type: string
                syncPolicy:
                  type: object
                  properties:
                    automated:
                      type: boolean
                      default: false
                    selfHeal:
                      type: boolean
                      default: false
                    pollInterval:
                      type: string
                      default: "3m"
            status:
              type: object
              properties:
                syncStatus:
                  type: string
                  enum: [Unknown, Synced, OutOfSync, Syncing, Failed]
                lastSyncedRevision:
                  type: string
                lastSyncedAt:
                  type: string
                  format: date-time
                observedRevision:
                  type: string
                message:
                  type: string
                conditions:
                  type: array
                  items:
                    type: object
                    properties:
                      type: {type: string}
                      status: {type: string}
                      reason: {type: string}
                      message: {type: string}
                      lastTransitionTime: {type: string}
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Sync Status
          type: string
          jsonPath: .status.syncStatus
        - name: Revision
          type: string
          jsonPath: .status.lastSyncedRevision
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
  scope: Namespaced
  names:
    plural: gitopsapps
    singular: gitopsapp
    kind: GitOpsApp
    shortNames: [goa]
```

### Go Types

These Go structs mirror the CRD schema and are used by controller-runtime's generated client to deserialize `GitOpsApp` objects from the API server. The kubebuilder marker comments drive both CRD generation and RBAC manifest generation, keeping the schema definition and the Go types in sync automatically.

```go
// api/v1alpha1/gitopsapp_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "sigs.k8s.io/controller-runtime/pkg/scheme"
)

// GitOpsAppSpec defines the desired state of a GitOpsApp.
type GitOpsAppSpec struct {
    // RepoURL is the URL of the Git repository.
    RepoURL string `json:"repoURL"`

    // TargetRevision is the branch, tag, or commit SHA to track.
    // +kubebuilder:default="HEAD"
    TargetRevision string `json:"targetRevision"`

    // Path is the directory within the repository containing manifests.
    Path string `json:"path"`

    // Destination defines the target cluster and namespace.
    // +optional
    Destination Destination `json:"destination,omitempty"`

    // SyncPolicy controls automated sync behavior.
    // +optional
    SyncPolicy SyncPolicy `json:"syncPolicy,omitempty"`

    // SecretRef references a Secret containing Git credentials.
    // +optional
    SecretRef *SecretReference `json:"secretRef,omitempty"`
}

// Destination defines where manifests are applied.
type Destination struct {
    // +optional
    Namespace string `json:"namespace,omitempty"`
    // +optional
    Server string `json:"server,omitempty"`
}

// SyncPolicy controls automated synchronization.
type SyncPolicy struct {
    // +optional
    Automated bool `json:"automated,omitempty"`
    // +optional
    SelfHeal bool `json:"selfHeal,omitempty"`
    // +kubebuilder:default="3m"
    // +optional
    PollInterval string `json:"pollInterval,omitempty"`
}

// SecretReference points to a Secret for Git authentication.
type SecretReference struct {
    Name      string `json:"name"`
    Namespace string `json:"namespace,omitempty"`
}

// SyncStatus represents the synchronization state.
type SyncStatus string

const (
    SyncStatusUnknown   SyncStatus = "Unknown"
    SyncStatusSynced    SyncStatus = "Synced"
    SyncStatusOutOfSync SyncStatus = "OutOfSync"
    SyncStatusSyncing   SyncStatus = "Syncing"
    SyncStatusFailed    SyncStatus = "Failed"
)

// GitOpsAppStatus defines the observed state of a GitOpsApp.
type GitOpsAppStatus struct {
    // +optional
    SyncStatus SyncStatus `json:"syncStatus,omitempty"`
    // +optional
    LastSyncedRevision string `json:"lastSyncedRevision,omitempty"`
    // +optional
    LastSyncedAt *metav1.Time `json:"lastSyncedAt,omitempty"`
    // +optional
    ObservedRevision string `json:"observedRevision,omitempty"`
    // +optional
    Message string `json:"message,omitempty"`
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Sync Status",type=string,JSONPath=".status.syncStatus"
// +kubebuilder:printcolumn:name="Revision",type=string,JSONPath=".status.lastSyncedRevision"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// GitOpsApp is the Schema for the gitopsapps API.
type GitOpsApp struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec              GitOpsAppSpec   `json:"spec,omitempty"`
    Status            GitOpsAppStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// GitOpsAppList contains a list of GitOpsApp.
type GitOpsAppList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []GitOpsApp `json:"items"`
}

var (
    GroupVersion  = schema.GroupVersion{Group: "gitops.example.com", Version: "v1alpha1"}
    SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
    AddToScheme   = SchemeBuilder.AddToScheme
)

func init() {
    SchemeBuilder.Register(&GitOpsApp{}, &GitOpsAppList{})
}
```

### GitOps Reconciler

The reconciler is the heart of the controller: every time a `GitOpsApp` is created or updated, or when the poll interval fires, `Reconcile` is called with the object's namespaced name. It resolves the remote HEAD revision, clones the repository at that exact commit, diffs the manifests against the live cluster state, and applies changes only when drift is detected or when the desired revision has advanced. Keeping the loop efficient and idempotent.

```go
// internal/controller/gitopsapp_controller.go
package controller

import (
    "context"
    "fmt"
    "os"
    "path/filepath"
    "slices"
    "time"

    "github.com/go-git/go-git/v5"
    "github.com/go-git/go-git/v5/plumbing"
    githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
    corev1 "k8s.io/api/core/v1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/predicate"

    gitopsv1alpha1 "github.com/example/gitops-controller/api/v1alpha1"
)

const (
    conditionTypeSynced = "Synced"
    finalizerName       = "gitops.example.com/finalizer"
    workDirBase         = "/tmp/gitops-controller"
)

// ManifestApplier abstracts applying Kubernetes manifests.
// The interface enables unit testing without a live cluster.
type ManifestApplier interface {
    Apply(ctx context.Context, manifestDir string, namespace string) error
    Diff(ctx context.Context, manifestDir string, namespace string) (bool, error)
}

// GitOpsAppReconciler reconciles GitOpsApp objects.
type GitOpsAppReconciler struct {
    client.Client
    Applier ManifestApplier
}

// +kubebuilder:rbac:groups=gitops.example.com,resources=gitopsapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gitops.example.com,resources=gitopsapps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=gitops.example.com,resources=gitopsapps/finalizers,verbs=update
// +kubebuilder:rbac:groups="*",resources="*",verbs=get;list;watch;create;update;patch;delete

// Reconcile is the main reconciliation loop.
// It runs whenever a GitOpsApp object changes or after each poll interval.
func (r *GitOpsAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx).WithValues("gitopsapp", req.NamespacedName)

    var app gitopsv1alpha1.GitOpsApp
    if err := r.Get(ctx, req.NamespacedName, &app); err != nil {
        if apierrors.IsNotFound(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("get GitOpsApp: %w", err)
    }

    // Handle deletion: remove finalizer and allow the object to be garbage collected
    if !app.DeletionTimestamp.IsZero() {
        return r.handleDeletion(ctx, &app)
    }

    // Register our finalizer so we can run cleanup logic on deletion
    if !slices.Contains(app.Finalizers, finalizerName) {
        app.Finalizers = append(app.Finalizers, finalizerName)
        if err := r.Update(ctx, &app); err != nil {
            return ctrl.Result{}, fmt.Errorf("add finalizer: %w", err)
        }
        return ctrl.Result{Requeue: true}, nil
    }

    // Parse the poll interval from the spec (default: 3 minutes)
    pollInterval := 3 * time.Minute
    if app.Spec.SyncPolicy.PollInterval != "" {
        if d, err := time.ParseDuration(app.Spec.SyncPolicy.PollInterval); err == nil {
            pollInterval = d
        }
    }

    // Fetch the current HEAD revision from the remote repository
    revision, err := r.fetchRevision(ctx, &app)
    if err != nil {
        logger.Error(err, "failed to fetch git revision")
        r.setCondition(&app, conditionTypeSynced, metav1.ConditionFalse, "FetchFailed", err.Error())
        _ = r.updateStatus(ctx, &app, gitopsv1alpha1.SyncStatusFailed, err.Error())
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    app.Status.ObservedRevision = revision
    alreadySynced := app.Status.LastSyncedRevision == revision

    // Skip work if synced and self-heal is disabled
    if alreadySynced && !app.Spec.SyncPolicy.SelfHeal {
        return ctrl.Result{RequeueAfter: pollInterval}, nil
    }

    // Clone the repository at the target revision into a temporary directory
    workDir, err := r.cloneRepo(ctx, &app, revision)
    if err != nil {
        logger.Error(err, "failed to clone repository")
        r.setCondition(&app, conditionTypeSynced, metav1.ConditionFalse, "CloneFailed", err.Error())
        _ = r.updateStatus(ctx, &app, gitopsv1alpha1.SyncStatusFailed, err.Error())
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }
    defer os.RemoveAll(workDir)

    manifestDir := filepath.Join(workDir, app.Spec.Path)
    namespace := app.Spec.Destination.Namespace
    if namespace == "" {
        namespace = app.Namespace
    }

    // Compute diff between desired (Git) state and actual (cluster) state
    hasDrift, err := r.Applier.Diff(ctx, manifestDir, namespace)
    if err != nil {
        logger.Error(err, "failed to compute diff")
        r.setCondition(&app, conditionTypeSynced, metav1.ConditionFalse, "DiffFailed", err.Error())
        _ = r.updateStatus(ctx, &app, gitopsv1alpha1.SyncStatusFailed, err.Error())
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    // Revision is current and no drift - mark synced and wait for next poll
    if alreadySynced && !hasDrift {
        if app.Status.SyncStatus != gitopsv1alpha1.SyncStatusSynced {
            r.setCondition(&app, conditionTypeSynced, metav1.ConditionTrue, "Synced", "")
            _ = r.updateStatus(ctx, &app, gitopsv1alpha1.SyncStatusSynced, "")
        }
        return ctrl.Result{RequeueAfter: pollInterval}, nil
    }

    // Drift detected but automated sync is disabled - mark OutOfSync, alert, wait
    if !app.Spec.SyncPolicy.Automated && hasDrift {
        logger.Info("drift detected - automated sync disabled, marking OutOfSync",
            "revision", revision)
        r.setCondition(&app, conditionTypeSynced, metav1.ConditionFalse, "OutOfSync",
            fmt.Sprintf("cluster state differs from Git at revision %s", revision))
        _ = r.updateStatus(ctx, &app, gitopsv1alpha1.SyncStatusOutOfSync, "")
        return ctrl.Result{RequeueAfter: pollInterval}, nil
    }

    // Apply Git state to cluster
    logger.Info("syncing application",
        "revision", revision,
        "manifest_dir", manifestDir,
        "namespace", namespace)

    _ = r.updateStatus(ctx, &app, gitopsv1alpha1.SyncStatusSyncing, "")

    if err := r.Applier.Apply(ctx, manifestDir, namespace); err != nil {
        logger.Error(err, "failed to apply manifests")
        r.setCondition(&app, conditionTypeSynced, metav1.ConditionFalse, "ApplyFailed", err.Error())
        _ = r.updateStatus(ctx, &app, gitopsv1alpha1.SyncStatusFailed, err.Error())
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    // Record the successful sync
    now := metav1.Now()
    app.Status.LastSyncedRevision = revision
    app.Status.LastSyncedAt = &now
    r.setCondition(&app, conditionTypeSynced, metav1.ConditionTrue, "Synced",
        fmt.Sprintf("successfully synced revision %s", revision))
    _ = r.updateStatus(ctx, &app, gitopsv1alpha1.SyncStatusSynced, "")

    logger.Info("sync complete", "revision", revision)
    return ctrl.Result{RequeueAfter: pollInterval}, nil
}

// cloneRepo clones the repository at the given revision into a temp directory.
func (r *GitOpsAppReconciler) cloneRepo(
    ctx context.Context,
    app *gitopsv1alpha1.GitOpsApp,
    revision string,
) (string, error) {
    auth, err := r.gitAuth(ctx, app)
    if err != nil {
        return "", err
    }

    workDir, err := os.MkdirTemp(workDirBase, fmt.Sprintf("%s-", app.Name))
    if err != nil {
        return "", fmt.Errorf("create work dir: %w", err)
    }

    repo, err := git.PlainCloneContext(ctx, workDir, false, &git.CloneOptions{
        URL:      app.Spec.RepoURL,
        Auth:     auth,
        Depth:    1,
        Progress: nil,
    })
    if err != nil {
        os.RemoveAll(workDir)
        return "", fmt.Errorf("clone repo: %w", err)
    }

    wt, err := repo.Worktree()
    if err != nil {
        os.RemoveAll(workDir)
        return "", fmt.Errorf("get worktree: %w", err)
    }

    if err := wt.Checkout(&git.CheckoutOptions{
        Hash:  plumbing.NewHash(revision),
        Force: true,
    }); err != nil {
        os.RemoveAll(workDir)
        return "", fmt.Errorf("checkout %s: %w", revision, err)
    }

    return workDir, nil
}

// fetchRevision resolves the target branch to a concrete commit SHA.
func (r *GitOpsAppReconciler) fetchRevision(
    ctx context.Context,
    app *gitopsv1alpha1.GitOpsApp,
) (string, error) {
    auth, err := r.gitAuth(ctx, app)
    if err != nil {
        return "", err
    }

    // Clone with depth=1 to resolve the revision cheaply
    tmpDir, err := os.MkdirTemp("", "rev-")
    if err != nil {
        return "", err
    }
    defer os.RemoveAll(tmpDir)

    targetBranch := app.Spec.TargetRevision
    if targetBranch == "" || targetBranch == "HEAD" {
        targetBranch = "main"
    }

    repo, err := git.PlainCloneContext(ctx, tmpDir, false, &git.CloneOptions{
        URL:           app.Spec.RepoURL,
        Auth:          auth,
        Depth:         1,
        SingleBranch:  true,
        ReferenceName: plumbing.NewBranchReferenceName(targetBranch),
    })
    if err != nil {
        return "", fmt.Errorf("resolve revision for branch %q: %w", targetBranch, err)
    }

    head, err := repo.Head()
    if err != nil {
        return "", fmt.Errorf("get HEAD: %w", err)
    }
    return head.Hash().String(), nil
}

// gitAuth builds Git authentication from a referenced Secret, if provided.
func (r *GitOpsAppReconciler) gitAuth(
    ctx context.Context,
    app *gitopsv1alpha1.GitOpsApp,
) (*githttp.BasicAuth, error) {
    if app.Spec.SecretRef == nil {
        return nil, nil // public repository
    }
    ns := app.Spec.SecretRef.Namespace
    if ns == "" {
        ns = app.Namespace
    }
    var secret corev1.Secret
    if err := r.Get(ctx, types.NamespacedName{
        Name: app.Spec.SecretRef.Name, Namespace: ns,
    }, &secret); err != nil {
        return nil, fmt.Errorf("get git secret %s/%s: %w", ns, app.Spec.SecretRef.Name, err)
    }
    username := string(secret.Data["username"])
    if username == "" {
        username = "git"
    }
    return &githttp.BasicAuth{
        Username: username,
        Password: string(secret.Data["password"]),
    }, nil
}

func (r *GitOpsAppReconciler) handleDeletion(
    ctx context.Context,
    app *gitopsv1alpha1.GitOpsApp,
) (ctrl.Result, error) {
    app.Finalizers = slices.DeleteFunc(app.Finalizers, func(s string) bool { return s == finalizerName })
    if err := r.Update(ctx, app); err != nil {
        return ctrl.Result{}, fmt.Errorf("remove finalizer: %w", err)
    }
    return ctrl.Result{}, nil
}

func (r *GitOpsAppReconciler) updateStatus(
    ctx context.Context,
    app *gitopsv1alpha1.GitOpsApp,
    syncStatus gitopsv1alpha1.SyncStatus,
    message string,
) error {
    app.Status.SyncStatus = syncStatus
    app.Status.Message = message
    return r.Status().Update(ctx, app)
}

func (r *GitOpsAppReconciler) setCondition(
    app *gitopsv1alpha1.GitOpsApp,
    condType string,
    status metav1.ConditionStatus,
    reason, message string,
) {
    meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
        Type:               condType,
        Status:             status,
        Reason:             reason,
        Message:            message,
        LastTransitionTime: metav1.Now(),
    })
}

// SetupWithManager registers the controller with the controller-runtime manager.
func (r *GitOpsAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&gitopsv1alpha1.GitOpsApp{}).
        WithEventFilter(predicate.GenerationChangedPredicate{}).
        Complete(r)
}
```

### Manifest Applier Implementation

`KubectlApplier` wraps `kubectl apply --server-side` so that field ownership is tracked by the API server rather than the client-side last-applied annotation, preventing conflicts when multiple actors manage the same resource. The `Diff` method exploits `kubectl diff`'s conventional exit code of `1` for detected differences, turning a non-zero exit into a boolean drift signal rather than an error.

```go
// internal/applier/kubectl_applier.go
package applier

import (
    "bytes"
    "context"
    "fmt"
    "os/exec"
    "strings"

    "go.uber.org/zap"
)

// KubectlApplier applies Kubernetes manifests using kubectl server-side apply.
type KubectlApplier struct {
    logger     *zap.Logger
    kubeconfig string
}

// NewKubectlApplier creates a KubectlApplier.
func NewKubectlApplier(logger *zap.Logger, kubeconfig string) *KubectlApplier {
    return &KubectlApplier{logger: logger, kubeconfig: kubeconfig}
}

// Apply applies all manifests in manifestDir using server-side apply.
// Server-side apply tracks field ownership - concurrent managers don't fight.
func (a *KubectlApplier) Apply(ctx context.Context, manifestDir string, namespace string) error {
    args := []string{
        "apply",
        "--server-side",
        "--force-conflicts",
        "--field-manager", "gitops-controller",
        "-R",
        "-f", manifestDir,
    }
    if namespace != "" {
        args = append(args, "-n", namespace)
    }
    return a.runKubectl(ctx, args...)
}

// Diff returns true if the cluster state differs from the manifest state.
// kubectl diff exits 1 when differences exist (not an error condition).
func (a *KubectlApplier) Diff(ctx context.Context, manifestDir string, namespace string) (bool, error) {
    args := []string{
        "diff", "--server-side",
        "--field-manager", "gitops-controller",
        "-R", "-f", manifestDir,
    }
    if namespace != "" {
        args = append(args, "-n", namespace)
    }

    var stderr bytes.Buffer
    cmd := exec.CommandContext(ctx, "kubectl", args...)
    cmd.Stderr = &stderr
    if a.kubeconfig != "" {
        cmd.Env = append(cmd.Environ(), "KUBECONFIG="+a.kubeconfig)
    }

    err := cmd.Run()
    if err != nil {
        if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
            return true, nil // exit 1 = differences found
        }
        return false, fmt.Errorf("kubectl diff: %w\nstderr: %s", err, stderr.String())
    }
    return false, nil // exit 0 = no differences
}

func (a *KubectlApplier) runKubectl(ctx context.Context, args ...string) error {
    var stdout, stderr bytes.Buffer
    cmd := exec.CommandContext(ctx, "kubectl", args...)
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr
    if a.kubeconfig != "" {
        cmd.Env = append(cmd.Environ(), "KUBECONFIG="+a.kubeconfig)
    }
    if err := cmd.Run(); err != nil {
        return fmt.Errorf("kubectl %s: %w\nstdout: %s\nstderr: %s",
            strings.Join(args[:2], " "), err, stdout.String(), stderr.String())
    }
    a.logger.Debug("kubectl apply success",
        zap.String("manifest_dir", args[len(args)-1]))
    return nil
}
```

### Controller Entry Point

The `main` function bootstraps a controller-runtime manager, registers the `GitOpsApp` scheme, wires up the `GitOpsAppReconciler` with its `KubectlApplier` dependency, and starts the leader-election loop so multiple replicas can run safely without double-applying. Health and readiness probes are registered on a separate port, allowing Kubernetes to gate traffic on controller availability.

```go
// cmd/controller/main.go
package main

import (
    "flag"
    "os"

    "go.uber.org/zap/zapcore"
    "k8s.io/apimachinery/pkg/runtime"
    utilruntime "k8s.io/apimachinery/pkg/util/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

    gitopsv1alpha1 "github.com/example/gitops-controller/api/v1alpha1"
    "github.com/example/gitops-controller/internal/applier"
    "github.com/example/gitops-controller/internal/controller"
)

var scheme = runtime.NewScheme()

func init() {
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    utilruntime.Must(gitopsv1alpha1.AddToScheme(scheme))
}

func main() {
    var metricsAddr, probeAddr, kubeconfig string
    var enableLeaderElection bool

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "Metrics endpoint")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "Health probe endpoint")
    flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election for HA")
    flag.StringVar(&kubeconfig, "kubeconfig", "", "Path to kubeconfig (empty = in-cluster)")
    flag.Parse()

    opts := zap.Options{Development: false, TimeEncoder: zapcore.ISO8601TimeEncoder}
    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
    setupLog := ctrl.Log.WithName("setup")

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme:                 scheme,
        Metrics:                metricsserver.Options{BindAddress: metricsAddr},
        HealthProbeBindAddress: probeAddr,
        LeaderElection:         enableLeaderElection,
        LeaderElectionID:       "gitops-controller.example.com",
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    zapLogger, _ := zap.NewRaw(zap.UseFlagOptions(&opts))

    if err := (&controller.GitOpsAppReconciler{
        Client:  mgr.GetClient(),
        Applier: applier.NewKubectlApplier(zapLogger, kubeconfig),
    }).SetupWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create GitOpsApp controller")
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

    setupLog.Info("starting gitops controller manager")
    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        setupLog.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

**Sample GitOpsApp CR:**

```yaml
# config/samples/gitopsapp-sample.yaml
apiVersion: gitops.example.com/v1alpha1
kind: GitOpsApp
metadata:
  name: shopapp-staging
  namespace: default
spec:
  repoURL: https://github.com/org/fleet-config
  targetRevision: main
  path: applications/shopapp/overlays/staging
  destination:
    namespace: shopapp-staging
  syncPolicy:
    automated: true
    selfHeal: true
    pollInterval: "2m"
  secretRef:
    name: github-deploy-token
    namespace: default
```

### Junior → FAANG: Understanding Controller-Runtime Before Using It

The most common mistake when approaching a custom controller for the first time is treating `controller-runtime` as a framework to memorize rather than a pattern to understand. The reconciliation loop has one job: given the current state of a named object, bring the world closer to the desired state declared in that object. The loop is idempotent by design, meaning running it twice with the same object state produces the same result. If your `Reconcile` function is not idempotent, you have introduced a bug.

The `ManifestApplier` interface in this chapter is a deliberate design choice. Wrapping `kubectl` behind an interface means unit tests can supply a fake `ManifestApplier` that returns controlled responses, without needing a real Kubernetes cluster. This is the standard approach in production controllers at every Go-using organization. In your first job, when you encounter a controller that has no unit tests because "you need a real cluster to test it," that is the interface-segregation gap that this pattern solves.

The finalizer pattern is critical to understand. A finalizer prevents the object from being garbage-collected until your cleanup logic runs and removes the finalizer. If your controller crashes after adding the finalizer but before removing it, the object stays in a terminating state indefinitely. The correct mental model: adding a finalizer is a commitment to run cleanup before deletion. Do not add finalizers unless you have meaningful cleanup to perform.

Entry-level interview signal: be able to explain why `ctrl.Result{RequeueAfter: pollInterval}` is returned at the end of a successful reconciliation rather than `ctrl.Result{}`. The controller-runtime watch mechanism fires reconciliations on object changes, but for a pull-based GitOps loop you also need periodic reconciliation to detect upstream Git changes. `RequeueAfter` schedules the next check without relying on a watch event.

### Senior @ FAANG: Controller Design at Production Scale

Building a custom GitOps controller rather than adopting ArgoCD is a significant architectural decision that requires an Architecture Decision Record with clear justification. The valid reasons are narrow: you need reconciliation logic that is domain-specific and cannot be expressed in ArgoCD's generic manifest-apply model, you have strict regulatory requirements that prohibit third-party operators in the production data plane, or you are building a product that will be distributed to customers who cannot run ArgoCD. "We want more control" is not a sufficient reason: ArgoCD's codebase represents years of edge-case handling that your custom controller will rediscover the hard way.

When a custom controller is justified, the production concerns go well beyond the happy path shown in this chapter. The `fetchRevision` function performs a shallow clone to resolve the remote HEAD, which is an outbound network call in the hot path of the reconciliation loop. At scale, this becomes a latency and reliability concern: Git hosts rate-limit unauthenticated requests, network partitions cause spikes in requeue attempts, and slow Git servers can back up the controller's work queue. The production approach is to separate the revision-fetching concern into a dedicated polling goroutine that writes to a cache, and have the reconciler consume from the cache rather than calling Git synchronously.

The `kubectl` subprocess approach in `KubectlApplier` is acceptable for a prototype but has production problems. Each `Apply` call forks a process, which has memory and latency overhead. At high reconciliation frequency across many objects, this adds up. The production approach for organizations at scale is to use the Kubernetes dynamic client or `server-side apply` via the Go client library directly, eliminating the subprocess. The tradeoff is implementation complexity: the dynamic client requires you to resolve GVR (Group, Version, Resource) mappings and manage field ownership manually, which is work ArgoCD has already done.

Leader election is configured in `main.go` with a simple boolean flag. At staff level, the leader election design has operational implications. If the leader pod is evicted during a sync operation, the new leader will re-run the reconciliation from the beginning. If `Apply` is partially idempotent, this is safe. If your domain-specific logic has side effects that are not safe to repeat, you need to implement a checkpoint mechanism in the object status before each non-idempotent step. This is the same problem that makes distributed sagas difficult, and the solution is the same: make each step an independently observable and recoverable unit.

Metrics design for a controller follows the RED method at the controller level: rate of reconciliations per second, error rate of reconciliations, and duration distribution. The `gitops_sync_duration_seconds` histogram in Exercise 4 is the correct starting point. Staff-level additions include a `gitops_reconcile_queue_depth` gauge (signals that the controller cannot keep up with event volume), a `gitops_git_fetch_duration_seconds` histogram (isolates Git latency from apply latency), and a `gitops_apply_duration_seconds` histogram (isolates API server latency). Separating these dimensions allows you to attribute degradation to the right component during an incident.

---
