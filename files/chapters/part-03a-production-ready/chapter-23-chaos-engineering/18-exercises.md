## Exercises

These exercises build on concepts from earlier in the chapter and challenge you to implement production-quality chaos infrastructure. Try to complete each exercise on your own before looking at the solution, and pay special attention to the safety controls in each implementation.

### Exercise 1: HTTP Chaos Middleware with Metrics

Build chaos middleware that tracks injection metrics and supports dynamic configuration.

Three traps are worth flagging before you start, because all three survive code review and one of them will take down your monitoring stack rather than the service you meant to test.

**Do not put a mutex in a struct you pass by value.** An `Update(newConfig DynamicFaultConfig)` method that takes the config struct by value copies the `sync.RWMutex` inside it. `go vet` fails the build with *passes lock by value: DynamicFaultConfig contains sync.RWMutex*, and it is right to: copying a lock silently gives you a second, unrelated lock guarding nothing. Separate the data from the thing that guards it, which is why the version below has a plain `FaultConfig` value type and a separate `DynamicFaultConfig` holder.

**Do not use unbounded label values.** A `CounterVec` with a `path` label creates one time series per distinct path, and paths contain IDs. `/orders/8f3a1`, `/orders/9c2b7`, and a million more each become a permanent series in Prometheus. This is the classic cardinality explosion, and the irony is sharp: your chaos experiment's own metrics take out the monitoring you were relying on to abort it. Use the routing pattern (`/orders/{id}`), never the raw path.

**Do not register metrics in a constructor with `promauto`.** `promauto.NewCounterVec` registers into the default registry and panics on a duplicate. A `NewChaosMiddleware` that calls it will work once and panic the second time, which means it panics in any test that constructs two, and in any process that has two instances. Take a `prometheus.Registerer` and use `promauto.With`.

**Solution**:

```go
package chaos

import (
    "context"
    "encoding/json"
    "math/rand/v2"
    "net/http"
    "strings"
    "sync/atomic"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// FaultConfig is an immutable value. No lock inside, so it is safe to copy
// and go vet stays quiet.
type FaultConfig struct {
    Enabled       bool          `json:"enabled"`
    Latency       time.Duration `json:"latency"`
    LatencyJitter time.Duration `json:"latency_jitter"`
    ErrorRate     float64       `json:"error_rate"`
    ErrorCode     int           `json:"error_code"`
    TargetPaths   []string      `json:"target_paths"`
    ExcludePaths  []string      `json:"exclude_paths"`
}

// DynamicFaultConfig publishes a FaultConfig to the request path. The swap is
// a single atomic pointer store, so an operator can arm or disarm the
// experiment while requests are in flight.
type DynamicFaultConfig struct {
    cfg atomic.Pointer[FaultConfig]
}

func NewDynamicFaultConfig() *DynamicFaultConfig {
    d := &DynamicFaultConfig{}
    d.Update(FaultConfig{})
    return d
}

func (c *DynamicFaultConfig) Update(next FaultConfig) { c.cfg.Store(&next) }
func (c *DynamicFaultConfig) Load() FaultConfig       { return *c.cfg.Load() }

// Disable is the abort switch: one atomic store, cannot fail.
func (c *DynamicFaultConfig) Disable() { c.Update(FaultConfig{}) }

func (c *DynamicFaultConfig) ShouldApply(path string) bool {
    cfg := c.Load()
    if !cfg.Enabled {
        return false
    }

    // Exclusions win over inclusions, always.
    for _, excluded := range cfg.ExcludePaths {
        if matchPath(path, excluded) {
            return false
        }
    }

    if len(cfg.TargetPaths) > 0 {
        for _, target := range cfg.TargetPaths {
            if matchPath(path, target) {
                return true
            }
        }
        return false
    }

    return true
}

// matchPath does simple prefix globbing. The empty pattern is handled first:
// indexing pattern[len(pattern)-1] on an empty string panics with
// "index out of range [-1]", and an empty string arrives easily, from a
// trailing comma in a YAML list or an unset env var. A panic here happens
// inside the request path of every request.
func matchPath(path, pattern string) bool {
    if pattern == "" {
        return false
    }
    if after, ok := strings.CutSuffix(pattern, "*"); ok {
        return strings.HasPrefix(path, after)
    }
    return path == pattern
}

// ChaosMiddleware with comprehensive metrics
type ChaosMiddleware struct {
    config *DynamicFaultConfig

    // Metrics
    requestsTotal     *prometheus.CounterVec
    latencyInjected   prometheus.Counter
    errorsInjected    prometheus.Counter
    injectionDuration prometheus.Histogram
}

// NewChaosMiddleware takes a Registerer rather than reaching for the global
// default registry. promauto.NewCounterVec panics on duplicate registration,
// so a constructor that uses it can only ever be called once per process,
// which breaks the second test you write.
func NewChaosMiddleware(config *DynamicFaultConfig, reg prometheus.Registerer) *ChaosMiddleware {
    f := promauto.With(reg)
    return &ChaosMiddleware{
        config: config,
        requestsTotal: f.NewCounterVec(prometheus.CounterOpts{
            Name: "chaos_requests_total",
            Help: "Total requests through chaos middleware",
        }, []string{"route", "injected", "type"}), // route, NOT path.
        latencyInjected: f.NewCounter(prometheus.CounterOpts{
            Name: "chaos_latency_injections_total",
            Help: "Total latency injections",
        }),
        errorsInjected: f.NewCounter(prometheus.CounterOpts{
            Name: "chaos_error_injections_total",
            Help: "Total error injections",
        }),
        injectionDuration: f.NewHistogram(prometheus.HistogramOpts{
            Name:    "chaos_injection_duration_seconds",
            Help:    "Duration of injected latency",
            Buckets: prometheus.ExponentialBuckets(0.01, 2, 10),
        }),
    }
}

// routeOf returns the bounded routing pattern ("/orders/{id}"), not the raw
// path ("/orders/8f3a1"). Since Go 1.22 the ServeMux pattern is available on
// the request, which makes the safe choice the easy one.
func routeOf(r *http.Request) string {
    if p := r.Pattern; p != "" {
        return p
    }
    return "other"
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
    t := time.NewTimer(d)
    defer t.Stop()
    select {
    case <-t.C:
        return true
    case <-ctx.Done():
        return false
    }
}

func (cm *ChaosMiddleware) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        route := routeOf(r)

        if !cm.config.ShouldApply(r.URL.Path) {
            cm.requestsTotal.WithLabelValues(route, "false", "none").Inc()
            next.ServeHTTP(w, r)
            return
        }

        // One load, one consistent view for the whole request.
        cfg := cm.config.Load()

        if cfg.Latency > 0 {
            d := cfg.Latency
            if cfg.LatencyJitter > 0 {
                d += rand.N(cfg.LatencyJitter)
            }

            cm.latencyInjected.Inc()
            cm.injectionDuration.Observe(d.Seconds())
            cm.requestsTotal.WithLabelValues(route, "true", "latency").Inc()

            // Respect cancellation. A bare time.Sleep keeps holding the
            // goroutine after the client has hung up.
            if !sleepCtx(r.Context(), d) {
                return
            }
            // Set headers BEFORE the body is written, or they are dropped.
            w.Header().Set("X-Chaos-Injected", "latency")
        }

        if cfg.ErrorRate > 0 && rand.Float64() < cfg.ErrorRate {
            code := cfg.ErrorCode
            if code == 0 {
                code = http.StatusInternalServerError
            }
            cm.errorsInjected.Inc()
            cm.requestsTotal.WithLabelValues(route, "true", "error").Inc()
            w.Header().Set("X-Chaos-Injected", "error")
            http.Error(w, "chaos: injected error", code)
            return
        }

        w.Header().Set("X-Chaos-Processed", "true")
        next.ServeHTTP(w, r)
    })
}

// ConfigHandler exposes the configuration API.
//
// This endpoint arms fault injection. It is an administrative control plane
// for breaking your own service, which makes an unauthenticated PUT here a
// remote denial-of-service primitive that anyone who can reach the pod may
// use. Bind it to a separate admin listener that is not exposed through the
// ingress, require authentication, and authorize the caller. The check below
// is the minimum, not a design.
func (cm *ChaosMiddleware) ConfigHandler(auth func(*http.Request) bool) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !auth(r) {
            http.Error(w, "forbidden", http.StatusForbidden)
            return
        }

        switch r.Method {
        case http.MethodGet:
            cfg := cm.config.Load()
            w.Header().Set("Content-Type", "application/json")
            json.NewEncoder(w).Encode(cfg)

        case http.MethodPut:
            // Bound the body. An unbounded decode on an admin endpoint is a
            // memory exhaustion vector.
            var next FaultConfig
            dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
            dec.DisallowUnknownFields()
            if err := dec.Decode(&next); err != nil {
                http.Error(w, err.Error(), http.StatusBadRequest)
                return
            }
            if next.ErrorRate < 0 || next.ErrorRate > 1 {
                http.Error(w, "error_rate must be between 0 and 1", http.StatusBadRequest)
                return
            }
            cm.config.Update(next)
            w.WriteHeader(http.StatusNoContent)

        case http.MethodDelete:
            // The abort switch, deliberately its own verb so it cannot fail
            // validation and cannot be confused with an update.
            cm.config.Disable()
            w.WriteHeader(http.StatusNoContent)

        default:
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        }
    })
}
```

The tests that pin these down are short and each targets one of the three traps:

```go
// promauto against the default registry panics the second time.
func TestTwoInstancesDoNotPanic(t *testing.T) {
    NewChaosMiddleware(NewDynamicFaultConfig(), prometheus.NewRegistry())
    NewChaosMiddleware(NewDynamicFaultConfig(), prometheus.NewRegistry())
}

// An empty pattern must not index pattern[-1].
func TestEmptyExcludePatternDoesNotPanic(t *testing.T) {
    c := NewDynamicFaultConfig()
    c.Update(FaultConfig{Enabled: true, ExcludePaths: []string{""}})
    if !c.ShouldApply("/api/orders") {
        t.Fatal("empty pattern should not match anything")
    }
}

// 500 distinct URL paths must not become 500 time series.
func TestRouteLabelIsBounded(t *testing.T) {
    reg := prometheus.NewRegistry()
    cm := NewChaosMiddleware(NewDynamicFaultConfig(), reg)

    mux := http.NewServeMux()
    mux.Handle("GET /orders/{id}", cm.Middleware(okHandler()))
    srv := httptest.NewServer(mux)
    defer srv.Close()

    for i := 0; i < 500; i++ {
        get(t, srv, fmt.Sprintf("/orders/%d", i))
    }

    if series := countSeries(t, reg, "chaos_requests_total"); series > 5 {
        t.Fatalf("cardinality explosion: %d series from 500 paths", series)
    }
}
```

That last test reports **1** series for 500 distinct paths with the route label, and would report 500 with the raw path. Add a fourth that arms and disarms the config from one goroutine while four others drive traffic, and run the package with `-race`.

### Exercise 2: Kubernetes Chaos Operator

Build a Kubernetes operator that manages chaos experiments as custom resources. The operator should watch for `ChaosExperiment` custom resource objects, inject the specified fault when one is created, monitor it for its declared duration, and clean up automatically when the duration expires. Support pausing, resuming, and failing experiments through status updates.

**Solution**:

Two things dominate the correctness of this exercise, and neither is about chaos.

The first is that a Kubernetes custom resource is not just a struct with JSON tags. `client.Object` requires `DeepCopyObject()`, which `controller-gen` normally generates into `zz_generated.deepcopy.go`. Omit it and the code does not compile: every `r.Get`, every `r.Status().Update`, and the `For(&ChaosExperiment{})` in `SetupWithManager` fails with *does not implement client.Object (missing method DeepCopyObject)*. The deepcopy methods are shown below in full, since you should be able to read what the generator produces even when you let it do the writing.

The second is the finalizer, and this one is the difference between an operator and an incident. Ask what `kubectl delete chaosexperiment api-latency` does to a *running* experiment. Without a finalizer: the API server removes the object, the next reconcile gets a NotFound, `client.IgnoreNotFound` turns that into a clean `nil`, and the reconciler returns happily. Meanwhile the fault is still injected. The pods are still being killed, the latency is still being added, and the one object in the cluster that knew which targets were affected no longer exists. You have created chaos with no off switch and no record, and the only way out is to find the affected targets by hand.

A finalizer inverts that. The API server marks the object for deletion, sets `deletionTimestamp`, and refuses to actually remove it while a finalizer remains. The reconciler sees the timestamp, removes the fault, and only then drops the finalizer and lets the object go. Note what the code below does when removal *fails*: it keeps the finalizer, requeues, and blocks deletion. That is deliberate. A stuck object in `Terminating` is annoying and visible. A silently orphaned fault is neither.

The same reasoning drives the rest of the corrections. The reconciler probes the steady state on every pass instead of sleeping through the duration with `RequeueAfter: duration`, so it can abort. `validate` refuses an empty `labelSelectors` or `namespaces`, because those do not match nothing, they match everything, up to and including `kube-system` and `coredns`. Phases are typed constants. And a cleanup failure reports `Failed`, never `Finished`.

**Types** (`api/v1/chaosexperiment_types.go`):

```go
package controller

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
)

type Phase string

const (
    PhasePending  Phase = "Pending"
    PhaseRunning  Phase = "Running"
    PhasePaused   Phase = "Paused"
    PhaseFinished Phase = "Finished"
    PhaseFailed   Phase = "Failed"
    PhaseAborted  Phase = "Aborted"
)

const chaosFinalizer = "chaos.example.com/cleanup-fault"

type Selector struct {
    Namespaces     []string          `json:"namespaces,omitempty"`
    LabelSelectors map[string]string `json:"labelSelectors,omitempty"`
    Percentage     int               `json:"percentage,omitempty"`
    MaxTargets     int               `json:"maxTargets"`
}

type PodFaultSpec struct {
    Action      string          `json:"action"`
    GracePeriod metav1.Duration `json:"gracePeriod,omitempty"`
}
type NetworkFaultSpec struct {
    Action    string `json:"action"`
    Latency   string `json:"latency,omitempty"`
    Jitter    string `json:"jitter,omitempty"`
    Loss      string `json:"loss,omitempty"`
    Direction string `json:"direction,omitempty"`
}
type StressFaultSpec struct {
    Workers    int    `json:"workers,omitempty"`
    MemorySize string `json:"memorySize,omitempty"`
}
type FaultSpec struct {
    Type         string            `json:"type"`
    PodFault     *PodFaultSpec     `json:"podFault,omitempty"`
    NetworkFault *NetworkFaultSpec `json:"networkFault,omitempty"`
    StressFault  *StressFaultSpec  `json:"stressFault,omitempty"`
}

type HealthCheckSpec struct {
    PrometheusURL string `json:"prometheusURL"`
    Query         string `json:"query"`
    Threshold     string `json:"threshold"`
}

type ChaosExperimentSpec struct {
    Duration    metav1.Duration  `json:"duration"`
    Selector    Selector         `json:"selector"`
    Fault       FaultSpec        `json:"fault"`
    Schedule    string           `json:"schedule,omitempty"`
    Paused      bool             `json:"paused,omitempty"`
    SteadyState *HealthCheckSpec `json:"steadyState"`
    ProbeEvery  metav1.Duration  `json:"probeEvery,omitempty"`
}

type ChaosExperimentStatus struct {
    Phase           Phase        `json:"phase"`
    StartTime       *metav1.Time `json:"startTime,omitempty"`
    EndTime         *metav1.Time `json:"endTime,omitempty"`
    AffectedTargets []string     `json:"affectedTargets,omitempty"`
    FailureReason   string       `json:"failureReason,omitempty"`
    LastProbeTime   *metav1.Time `json:"lastProbeTime,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
type ChaosExperiment struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   ChaosExperimentSpec   `json:"spec,omitempty"`
    Status ChaosExperimentStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type ChaosExperimentList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []ChaosExperiment `json:"items"`
}

// --- normally generated by controller-gen into zz_generated.deepcopy.go ---

func (in *ChaosExperiment) DeepCopyInto(out *ChaosExperiment) {
    *out = *in
    out.TypeMeta = in.TypeMeta
    in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
    in.Spec.DeepCopyInto(&out.Spec)
    in.Status.DeepCopyInto(&out.Status)
}
func (in *ChaosExperiment) DeepCopy() *ChaosExperiment {
    if in == nil {
        return nil
    }
    out := new(ChaosExperiment)
    in.DeepCopyInto(out)
    return out
}
func (in *ChaosExperiment) DeepCopyObject() runtime.Object {
    if c := in.DeepCopy(); c != nil {
        return c
    }
    return nil
}

func (in *ChaosExperimentList) DeepCopyInto(out *ChaosExperimentList) {
    *out = *in
    out.TypeMeta = in.TypeMeta
    in.ListMeta.DeepCopyInto(&out.ListMeta)
    if in.Items != nil {
        l := make([]ChaosExperiment, len(in.Items))
        for i := range in.Items {
            in.Items[i].DeepCopyInto(&l[i])
        }
        out.Items = l
    }
}
func (in *ChaosExperimentList) DeepCopy() *ChaosExperimentList {
    if in == nil {
        return nil
    }
    out := new(ChaosExperimentList)
    in.DeepCopyInto(out)
    return out
}
func (in *ChaosExperimentList) DeepCopyObject() runtime.Object {
    if c := in.DeepCopy(); c != nil {
        return c
    }
    return nil
}

func (in *ChaosExperimentSpec) DeepCopyInto(out *ChaosExperimentSpec) {
    *out = *in
    out.Duration = in.Duration
    in.Selector.DeepCopyInto(&out.Selector)
    in.Fault.DeepCopyInto(&out.Fault)
    if in.SteadyState != nil {
        s := *in.SteadyState
        out.SteadyState = &s
    }
}
func (in *Selector) DeepCopyInto(out *Selector) {
    *out = *in
    if in.Namespaces != nil {
        out.Namespaces = append([]string(nil), in.Namespaces...)
    }
    if in.LabelSelectors != nil {
        m := make(map[string]string, len(in.LabelSelectors))
        for k, v := range in.LabelSelectors {
            m[k] = v
        }
        out.LabelSelectors = m
    }
}
func (in *FaultSpec) DeepCopyInto(out *FaultSpec) {
    *out = *in
    if in.PodFault != nil {
        v := *in.PodFault
        out.PodFault = &v
    }
    if in.NetworkFault != nil {
        v := *in.NetworkFault
        out.NetworkFault = &v
    }
    if in.StressFault != nil {
        v := *in.StressFault
        out.StressFault = &v
    }
}
func (in *ChaosExperimentStatus) DeepCopyInto(out *ChaosExperimentStatus) {
    *out = *in
    if in.StartTime != nil {
        t := *in.StartTime
        out.StartTime = &t
    }
    if in.EndTime != nil {
        t := *in.EndTime
        out.EndTime = &t
    }
    if in.LastProbeTime != nil {
        t := *in.LastProbeTime
        out.LastProbeTime = &t
    }
    if in.AffectedTargets != nil {
        out.AffectedTargets = append([]string(nil), in.AffectedTargets...)
    }
}
```

**Reconciler** (`internal/controller/chaosexperiment_controller.go`):

```go
package controller

import (
    "context"
    "errors"
    "fmt"
    "time"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"
)

// MaxExperimentDuration is a hard ceiling. A CR that asks for 30 days is a
// typo, and an operator that honours it is an outage with YAML provenance.
const MaxExperimentDuration = 1 * time.Hour

type SteadyStateChecker interface {
    Check(ctx context.Context, spec *HealthCheckSpec) error
}

type FaultInjector interface {
    Inject(ctx context.Context, exp *ChaosExperiment, targets []string) error
    Remove(ctx context.Context, exp *ChaosExperiment, targets []string) error
}

type ChaosExperimentReconciler struct {
    client.Client
    Scheme   *runtime.Scheme
    Injector FaultInjector
    Steady   SteadyStateChecker
}

func (r *ChaosExperimentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    var exp ChaosExperiment
    if err := r.Get(ctx, req.NamespacedName, &exp); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Deletion. Without a finalizer, `kubectl delete chaosexperiment` makes
    // the object vanish while the fault stays injected, and nothing is left
    // in the cluster that knows how to remove it.
    if !exp.DeletionTimestamp.IsZero() {
        if controllerutil.ContainsFinalizer(&exp, chaosFinalizer) {
            logger.Info("experiment deleted, removing fault first", "name", exp.Name)
            if err := r.Injector.Remove(ctx, &exp, exp.Status.AffectedTargets); err != nil {
                // Do NOT drop the finalizer. Retry until the fault is gone.
                logger.Error(err, "fault removal failed, blocking deletion")
                return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
            }
            controllerutil.RemoveFinalizer(&exp, chaosFinalizer)
            if err := r.Update(ctx, &exp); err != nil {
                return ctrl.Result{}, err
            }
        }
        return ctrl.Result{}, nil
    }

    if exp.Spec.Paused {
        if exp.Status.Phase == PhaseRunning {
            return r.pauseExperiment(ctx, &exp)
        }
        return ctrl.Result{}, nil
    }

    switch exp.Status.Phase {
    case "", PhasePending:
        return r.startExperiment(ctx, &exp)
    case PhaseRunning:
        return r.checkExperiment(ctx, &exp)
    case PhasePaused:
        return r.resumeExperiment(ctx, &exp)
    case PhaseFinished, PhaseFailed, PhaseAborted:
        return ctrl.Result{}, nil
    }
    return ctrl.Result{}, nil
}

func (r *ChaosExperimentReconciler) validate(exp *ChaosExperiment) error {
    var errs []error
    if exp.Spec.Duration.Duration <= 0 {
        errs = append(errs, errors.New("spec.duration must be positive"))
    }
    if exp.Spec.Duration.Duration > MaxExperimentDuration {
        errs = append(errs, fmt.Errorf("spec.duration %v exceeds the %v ceiling",
            exp.Spec.Duration.Duration, MaxExperimentDuration))
    }
    if exp.Spec.SteadyState == nil {
        errs = append(errs, errors.New("spec.steadyState is required: without it there is no abort condition"))
    }
    if len(exp.Spec.Selector.LabelSelectors) == 0 {
        // An empty label selector matches EVERY pod. That is how a chaos
        // experiment aimed at one deployment takes out coredns.
        errs = append(errs, errors.New("spec.selector.labelSelectors must not be empty: an empty selector matches every pod in scope"))
    }
    if len(exp.Spec.Selector.Namespaces) == 0 {
        errs = append(errs, errors.New("spec.selector.namespaces must not be empty: an empty namespace list means all namespaces, including kube-system"))
    }
    if exp.Spec.Selector.MaxTargets <= 0 {
        errs = append(errs, errors.New("spec.selector.maxTargets must be set"))
    }
    return errors.Join(errs...)
}

func (r *ChaosExperimentReconciler) startExperiment(ctx context.Context, exp *ChaosExperiment) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    if err := r.validate(exp); err != nil {
        return r.failExperiment(ctx, exp, err)
    }

    // Baseline: never inject into an already-degraded system.
    if err := r.Steady.Check(ctx, exp.Spec.SteadyState); err != nil {
        return r.failExperiment(ctx, exp, fmt.Errorf("no baseline steady state, refusing to inject: %w", err))
    }

    targets, err := r.selectTargets(ctx, exp)
    if err != nil {
        return r.failExperiment(ctx, exp, err)
    }
    if len(targets) == 0 {
        return r.failExperiment(ctx, exp, errors.New("selector matched no targets"))
    }
    if len(targets) > exp.Spec.Selector.MaxTargets {
        return r.failExperiment(ctx, exp, fmt.Errorf(
            "selector matched %d targets, exceeding maxTargets %d: refusing",
            len(targets), exp.Spec.Selector.MaxTargets))
    }

    // Claim the finalizer BEFORE injecting. If the process dies between
    // injection and the finalizer write, nothing will clean up.
    if controllerutil.AddFinalizer(exp, chaosFinalizer) {
        if err := r.Update(ctx, exp); err != nil {
            return ctrl.Result{}, err
        }
    }

    if err := r.Injector.Inject(ctx, exp, targets); err != nil {
        return r.failExperiment(ctx, exp, err)
    }
    logger.Info("fault injected", "name", exp.Name, "targets", len(targets))

    now := metav1.Now()
    exp.Status.Phase = PhaseRunning
    exp.Status.StartTime = &now
    exp.Status.AffectedTargets = targets
    if err := r.Status().Update(ctx, exp); err != nil {
        return ctrl.Result{}, err
    }

    return ctrl.Result{RequeueAfter: r.probeEvery(exp)}, nil
}

func (r *ChaosExperimentReconciler) probeEvery(exp *ChaosExperiment) time.Duration {
    if d := exp.Spec.ProbeEvery.Duration; d > 0 {
        return d
    }
    return 10 * time.Second
}

// checkExperiment is the abort condition. It probes the hypothesis on every
// reconcile rather than sleeping through the whole duration.
func (r *ChaosExperimentReconciler) checkExperiment(ctx context.Context, exp *ChaosExperiment) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    if exp.Status.StartTime == nil {
        return r.failExperiment(ctx, exp, errors.New("running experiment has no start time"))
    }

    if err := r.Steady.Check(ctx, exp.Spec.SteadyState); err != nil {
        logger.Info("ABORTING: steady state lost", "name", exp.Name, "reason", err)
        return r.abortExperiment(ctx, exp, err)
    }

    now := metav1.Now()
    exp.Status.LastProbeTime = &now
    if err := r.Status().Update(ctx, exp); err != nil {
        return ctrl.Result{}, err
    }

    elapsed := time.Since(exp.Status.StartTime.Time)
    if elapsed >= exp.Spec.Duration.Duration {
        return r.finishExperiment(ctx, exp)
    }
    return ctrl.Result{RequeueAfter: min(r.probeEvery(exp), exp.Spec.Duration.Duration-elapsed)}, nil
}

func (r *ChaosExperimentReconciler) removeAndSettle(ctx context.Context, exp *ChaosExperiment, phase Phase, reason string) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    if err := r.Injector.Remove(ctx, exp, exp.Status.AffectedTargets); err != nil {
        // The fault is still live. Do NOT report Finished.
        logger.Error(err, "fault removal failed", "name", exp.Name)
        exp.Status.Phase = PhaseFailed
        exp.Status.FailureReason = fmt.Sprintf("cleanup failed, fault may still be live: %v", err)
        if uerr := r.Status().Update(ctx, exp); uerr != nil {
            return ctrl.Result{}, uerr
        }
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    }

    now := metav1.Now()
    exp.Status.Phase = phase
    exp.Status.EndTime = &now
    exp.Status.FailureReason = reason
    if err := r.Status().Update(ctx, exp); err != nil {
        return ctrl.Result{}, err
    }

    if controllerutil.RemoveFinalizer(exp, chaosFinalizer) {
        if err := r.Update(ctx, exp); err != nil {
            return ctrl.Result{}, err
        }
    }
    return ctrl.Result{}, nil
}

func (r *ChaosExperimentReconciler) finishExperiment(ctx context.Context, exp *ChaosExperiment) (ctrl.Result, error) {
    return r.removeAndSettle(ctx, exp, PhaseFinished, "")
}

func (r *ChaosExperimentReconciler) abortExperiment(ctx context.Context, exp *ChaosExperiment, cause error) (ctrl.Result, error) {
    return r.removeAndSettle(ctx, exp, PhaseAborted, cause.Error())
}

func (r *ChaosExperimentReconciler) pauseExperiment(ctx context.Context, exp *ChaosExperiment) (ctrl.Result, error) {
    if err := r.Injector.Remove(ctx, exp, exp.Status.AffectedTargets); err != nil {
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    }
    exp.Status.Phase = PhasePaused
    return ctrl.Result{}, r.Status().Update(ctx, exp)
}

func (r *ChaosExperimentReconciler) resumeExperiment(ctx context.Context, exp *ChaosExperiment) (ctrl.Result, error) {
    exp.Status.Phase = PhasePending
    if err := r.Status().Update(ctx, exp); err != nil {
        return ctrl.Result{}, err
    }
    return ctrl.Result{Requeue: true}, nil
}

func (r *ChaosExperimentReconciler) failExperiment(ctx context.Context, exp *ChaosExperiment, cause error) (ctrl.Result, error) {
    exp.Status.Phase = PhaseFailed
    exp.Status.FailureReason = cause.Error()
    if err := r.Status().Update(ctx, exp); err != nil {
        return ctrl.Result{}, err
    }
    // Terminal. Returning the error would requeue with backoff forever
    // against a spec that will never become valid on its own.
    return ctrl.Result{}, nil
}

func (r *ChaosExperimentReconciler) selectTargets(ctx context.Context, exp *ChaosExperiment) ([]string, error) {
    var out []string
    for _, ns := range exp.Spec.Selector.Namespaces {
        var pods corev1.PodList
        if err := r.List(ctx, &pods,
            client.InNamespace(ns),
            client.MatchingLabels(exp.Spec.Selector.LabelSelectors),
        ); err != nil {
            return nil, fmt.Errorf("listing pods in %s: %w", ns, err)
        }
        for _, p := range pods.Items {
            out = append(out, p.Namespace+"/"+p.Name)
        }
    }
    if pct := exp.Spec.Selector.Percentage; pct > 0 && pct < 100 {
        n := max(len(out)*pct/100, 1)
        out = out[:min(n, len(out))]
    }
    return out, nil
}

func (r *ChaosExperimentReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&ChaosExperiment{}).
        Complete(r)
}
```

Verify the finalizer with the fake client from `sigs.k8s.io/controller-runtime/pkg/client/fake`. The test that matters most is the one nobody writes:

```go
// Deleting the CR must not leave the fault injected.
func TestDeletingCRRemovesTheFault(t *testing.T) {
    inj := &fakeInjector{}
    r := setup(t, newExp(), inj, &fakeSteady{})

    // Start the experiment.
    if _, err := r.Reconcile(context.Background(), key); err != nil {
        t.Fatal(err)
    }
    if !inj.live {
        t.Fatal("fault should be injected")
    }

    var cur ChaosExperiment
    r.Get(context.Background(), key.NamespacedName, &cur)
    if len(cur.Finalizers) == 0 {
        t.Fatal("no finalizer: deleting the CR would strand the fault")
    }

    // kubectl delete chaosexperiment exp
    r.Delete(context.Background(), &cur)
    if _, err := r.Reconcile(context.Background(), key); err != nil {
        t.Fatal(err)
    }

    if inj.live {
        t.Fatal("CR deleted but the fault is STILL LIVE in the cluster")
    }
}
```

Write four more: a cleanup that fails must requeue and keep the object in `Terminating`, a steady-state loss mid-run must move the phase to `Aborted` and remove the fault, an empty `labelSelectors` must be refused before anything is injected, and a missing `steadyState` must be refused for the same reason.

### Exercise 3: GameDay Automation Platform

Build a platform for running automated GameDay exercises. The platform should support multiple teams competing against timed scenarios, inject faults through a pluggable `FaultRunner` interface, verify resolution through a `Verifier` interface, and produce a scored leaderboard with findings at the end.

The interesting bug in this exercise is not a crash or a race. It is that the competition does not compete.

Work through the naive data model. `ScenarioResult` carries a single `TeamID`, `runScenario` never sets it, and `Verify(ctx, verification)` has no team parameter, so it can only answer "is the scenario resolved" globally rather than "has *this* team resolved it". The caller then does the only thing left available to it:

```go
for j := range gameDay.Teams {
    if result.Completed {
        gameDay.Teams[j].Score += result.Points   // Everyone. Same points.
    }
}
```

Every team finishes on an identical score. The leaderboard is a constant, the "difficulty" and "points" fields are theatre, and no team can ever place above another. The unset `TeamID` field is the tell: the design intended per-team scoring and the implementation quietly dropped it, leaving a struct field that nothing writes and nothing reads.

Fix it in the types rather than the loop. Give `Verify` a `Team`, and make `ScenarioResult` a map keyed by team ID, so there is nowhere to record a score without naming whose it is. Once the model is right, the scoring loop has no way to express the bug.

**Solution**:

```go
package gameday

import (
 "cmp"
 "context"
 "encoding/json"
 "fmt"
 "log/slog"
 "slices"
 "sync"
 "time"
)

// sleepCtx waits for d and reports whether it slept the full duration.
func sleepCtx(ctx context.Context, d time.Duration) bool {
 t := time.NewTimer(d)
 defer t.Stop()
 select {
 case <-t.C:
  return true
 case <-ctx.Done():
  return false
 }
}

// GameDay represents a chaos engineering game day
type GameDay struct {
 ID string
 Name string
 Description string
 Duration time.Duration
 Teams []Team
 Scenarios []Scenario
 Status GameDayStatus
 StartTime *time.Time
 EndTime *time.Time
 Results *GameDayResults
}

type Team struct {
 ID string
 Name string
 Members []string
 Score int
}

type Scenario struct {
 ID string
 Name string
 Description string
 Difficulty int // 1-5
 Points int
 TimeLimit time.Duration
 Inject FaultInjection
 Verify Verification
 Hints []string
}

type FaultInjection struct {
 Type string `json:"type"`
 Config json.RawMessage `json:"config"`
}

type Verification struct {
 Type string `json:"type"`
 Config json.RawMessage `json:"config"`
 Timeout time.Duration `json:"timeout"`
}

type GameDayStatus string

const (
 StatusPending GameDayStatus = "pending"
 StatusRunning GameDayStatus = "running"
 StatusPaused GameDayStatus = "paused"
 StatusCompleted GameDayStatus = "completed"
)

type GameDayResults struct {
 TotalDuration time.Duration
 TeamResults []TeamResult
 Findings []Finding
}

type TeamResult struct {
 TeamID string
 TotalScore int
 ScenariosAttempted int
 ScenariosCompleted int
 AverageMTTR time.Duration
}

type Finding struct {
 Scenario string
 Severity string
 Description string
 Remediation string
}

// Platform manages GameDay exercises
type Platform struct {
 logger *slog.Logger
 mu sync.RWMutex
 activeGameDay *GameDay
 faultRunner FaultRunner
 verifier Verifier
 notifier Notifier
}

type FaultRunner interface {
 Inject(ctx context.Context, injection FaultInjection) error
 Cleanup(ctx context.Context) error
}

// Verifier answers "has THIS team resolved the scenario". The team argument
// is what makes per-team scoring possible - without it every team necessarily
// gets the same answer and the same score.
type Verifier interface {
 Verify(ctx context.Context, team Team, verification Verification) (bool, error)
}

type Notifier interface {
 NotifyTeams(ctx context.Context, message string) error
 NotifyScenarioStart(ctx context.Context, scenario Scenario) error
 NotifyScenarioEnd(ctx context.Context, scenario Scenario, result TeamScenarioResult) error
}

// TeamScenarioResult is one team's outcome on one scenario.
type TeamScenarioResult struct {
 TeamID string
 Completed bool
 Duration time.Duration
 Points int
}

// ScenarioResult holds the outcome for every team on one scenario.
//
// The single-TeamID version of this struct is the bug at the heart of the
// naive implementation: runScenario never sets it, and the caller then loops
// over every team awarding the same Points to each. Every team ends on an
// identical score, the leaderboard is a constant, and the whole competitive
// premise is decoration. A per-team map makes the omission impossible to
// write, because there is nowhere to put a score without naming its team.
type ScenarioResult struct {
 ScenarioID string
 ByTeam map[string]TeamScenarioResult
}

func NewPlatform(
 logger *slog.Logger,
 faultRunner FaultRunner,
 verifier Verifier,
 notifier Notifier,
) *Platform {
 return &Platform{
 logger: logger,
 faultRunner: faultRunner,
 verifier: verifier,
 notifier: notifier,
 }
}

// StartGameDay begins a new game day
func (p *Platform) StartGameDay(ctx context.Context, gameDay *GameDay) error {
 p.mu.Lock()
 if p.activeGameDay != nil {
 p.mu.Unlock()
 return fmt.Errorf("another game day is active: %s", p.activeGameDay.ID)
 }
 p.activeGameDay = gameDay
 p.mu.Unlock()

 p.logger.Info("Starting GameDay",
 "id", gameDay.ID,
 "name", gameDay.Name,
 "teams", len(gameDay.Teams),
 "scenarios", len(gameDay.Scenarios),
 )

 now := time.Now()
 gameDay.StartTime = &now
 gameDay.Status = StatusRunning
 gameDay.Results = &GameDayResults{
 TeamResults: make([]TeamResult, len(gameDay.Teams)),
 }

 // Release the platform on EVERY exit path. Clearing activeGameDay only
 // at the bottom of the function means a cancelled or failed GameDay
 // leaves the platform permanently convinced one is still running, and
 // every later StartGameDay is rejected until the process restarts.
 defer func() {
 p.mu.Lock()
 p.activeGameDay = nil
 p.mu.Unlock()
 }()

 // Notify teams
 p.notifier.NotifyTeams(ctx, fmt.Sprintf("GameDay %s is starting! Good luck!", gameDay.Name))

 // Run scenarios
 for i, scenario := range gameDay.Scenarios {
 select {
 case <-ctx.Done():
 return ctx.Err()
 default:
 }

 p.logger.Info("Starting scenario",
 "number", i+1,
 "name", scenario.Name,
 "difficulty", scenario.Difficulty,
 )

 result, err := p.runScenario(ctx, &scenario, gameDay.Teams)
 if err != nil {
 p.logger.Error("Scenario failed", "error", err)
 }

 // Update scores, PER TEAM. See the note below: awarding the same
 // points to every team makes the leaderboard a constant.
 p.mu.Lock()
 for teamID, tr := range result.ByTeam {
 for j := range gameDay.Teams {
 if gameDay.Teams[j].ID != teamID {
 continue
 }
 gameDay.Teams[j].Score += tr.Points
 gameDay.Results.TeamResults[j].TeamID = teamID
 gameDay.Results.TeamResults[j].TotalScore += tr.Points
 gameDay.Results.TeamResults[j].ScenariosAttempted++
 if tr.Completed {
 gameDay.Results.TeamResults[j].ScenariosCompleted++
 }
 }
 }
 p.mu.Unlock()

 // Brief pause between scenarios, cancellable. A bare time.Sleep here
 // means an operator who aborts the GameDay still waits two minutes
 // per remaining scenario.
 if !sleepCtx(ctx, 2*time.Minute) {
 return ctx.Err()
 }
 }

 // Complete game day
 endTime := time.Now()
 gameDay.EndTime = &endTime
 gameDay.Status = StatusCompleted
 gameDay.Results.TotalDuration = endTime.Sub(*gameDay.StartTime)

 p.logger.Info("GameDay completed",
 "duration", gameDay.Results.TotalDuration,
 )

 return nil
}

func (p *Platform) runScenario(ctx context.Context, scenario *Scenario, teams []Team) (*ScenarioResult, error) {
 result := &ScenarioResult{
 ScenarioID: scenario.ID,
 ByTeam: make(map[string]TeamScenarioResult, len(teams)),
 }
 for _, t := range teams {
 result.ByTeam[t.ID] = TeamScenarioResult{TeamID: t.ID}
 }

 // Notify teams of scenario start
 p.notifier.NotifyScenarioStart(ctx, *scenario)

 start := time.Now()

 // Create scenario context with time limit
 scenarioCtx, cancel := context.WithTimeout(ctx, scenario.TimeLimit)
 defer cancel()

 // Inject fault
 p.logger.Info("Injecting fault", "type", scenario.Inject.Type)
 if err := p.faultRunner.Inject(scenarioCtx, scenario.Inject); err != nil {
 return result, fmt.Errorf("fault injection failed: %w", err)
 }

 // Ensure cleanup, on a DETACHED context. Using ctx here means an
 // operator aborting the GameDay cancels the only path that removes the
 // fault, leaving it live after the process has moved on.
 defer func() {
 cctx, ccancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
 defer ccancel()
 if err := p.faultRunner.Cleanup(cctx); err != nil {
 p.logger.Error("CLEANUP FAILED, fault may still be live", "error", err)
 }
 }()

 // Wait for teams to resolve
 // In a real implementation, this would monitor metrics or receive signals
 ticker := time.NewTicker(10 * time.Second)
 defer ticker.Stop()

 hintIndex := 0
 remaining := len(teams)

 for {
 select {
 case <-scenarioCtx.Done():
 // Time limit exceeded. Teams still unresolved score zero, which
 // is already their entry in ByTeam.
 return result, nil

 case <-ticker.C:
 // Verify PER TEAM. Each team owns its own copy of the service,
 // so "is it resolved" has a different answer for each of them.
 for _, t := range teams {
 if result.ByTeam[t.ID].Completed {
 continue
 }

 resolved, err := p.verifier.Verify(scenarioCtx, t, scenario.Verify)
 if err != nil {
 p.logger.Error("verification failed", "team", t.ID, "error", err)
 continue
 }
 if !resolved {
 continue
 }

 d := time.Since(start)
 pts := scenario.Points
 // Bonus for fast resolution.
 if d < scenario.TimeLimit/2 {
 pts = int(float64(pts) * 1.5)
 }

 tr := TeamScenarioResult{TeamID: t.ID, Completed: true, Duration: d, Points: pts}
 result.ByTeam[t.ID] = tr
 remaining--

 p.notifier.NotifyScenarioEnd(ctx, *scenario, tr)
 }

 if remaining == 0 {
 return result, nil // Everyone solved it.
 }

 // Provide hints periodically
 elapsed := time.Since(start)
 if elapsed > (scenario.TimeLimit/3)*time.Duration(hintIndex+1) && hintIndex < len(scenario.Hints) {
 p.notifier.NotifyTeams(ctx, fmt.Sprintf("Hint: %s", scenario.Hints[hintIndex]))
 hintIndex++
 }
 }
 }
}

// PauseGameDay pauses the current game day
func (p *Platform) PauseGameDay() error {
 p.mu.Lock()
 defer p.mu.Unlock()

 if p.activeGameDay == nil {
 return fmt.Errorf("no active game day")
 }

 p.activeGameDay.Status = StatusPaused
 return nil
}

// GetLeaderboard returns current team rankings
func (p *Platform) GetLeaderboard() []Team {
 p.mu.RLock()
 defer p.mu.RUnlock()

 if p.activeGameDay == nil {
 return nil
 }

 // Sort by score, descending, with a deterministic tiebreak so two teams
 // on equal points do not swap places between refreshes of the scoreboard.
 teams := slices.Clone(p.activeGameDay.Teams)
 slices.SortFunc(teams, func(a, b Team) int {
 if d := cmp.Compare(b.Score, a.Score); d != 0 {
 return d
 }
 return cmp.Compare(a.Name, b.Name)
 })

 return teams
}
```

The report generator that turns the completed GameDay into a shareable artifact is covered in the next section.

### Senior at FAANG Track

For one service, run a chaos experiment with a written hypothesis. Document findings. Close the resilience gap if one is found.

Lead a GameDay with your team. Select three failure scenarios. Measure response time. Publish lessons.

### Staff / Principal Track

Pilot a chaos engineering program on one team. Document the findings. Present to leadership. Propose org-wide rollout.

Integrate chaos tests into the production readiness checklist for new services. Require passing chaos tests before launch.

Build the shared chaos library or adopt a platform (Chaos Mesh, Gremlin). Drive adoption.


## Generating the GameDay Report

A GameDay is only as valuable as the artifact it leaves behind, and this generator completes the exercise-3 platform above. Generate the report programmatically from the exercise data so that every GameDay produces the same structure: a summary of what ran, the team leaderboard, the findings, and the follow-up recommendations.


The obvious version of this function has a bug that survives review because the output looks right at a glance. It writes a `## Leaderboard` heading and then ranges over `gameDay.Teams`, printing `i+1` as the rank. It never sorts. `Teams` holds registration order, so the report confidently awards first place to whichever team signed up first. Feed it Alpha with 40 points, Bravo with 95, and Charlie with 70, and it prints Alpha as rank 1 and Bravo as rank 2. Every number on the page is real and the ranking is fiction.

Sort explicitly, and handle ties while you are there, since two teams on the same score both placed first and the team behind them placed third. Order findings by severity too, because a report that buries a critical finding under a stale-runbook note is optimising for the order a slice happened to be appended in.

```go
package chaos

import (
    "cmp"
    "fmt"
    "slices"
    "strings"
    "time"
)

var severityRank = map[string]int{"critical": 0, "high": 1, "medium": 2, "low": 3}

func sevRank(s string) int {
    if r, ok := severityRank[strings.ToLower(s)]; ok {
        return r
    }
    return len(severityRank) // Unknown severities sort last.
}

func GenerateGameDayReport(gameDay *GameDay) string {
    var b strings.Builder

    fmt.Fprintf(&b, "# GameDay Report: %s\n\n", gameDay.Name)
    b.WriteString("## Summary\n\n")
    fmt.Fprintf(&b, "- **Duration**: %v\n", gameDay.Results.TotalDuration.Round(time.Second))
    fmt.Fprintf(&b, "- **Scenarios**: %d\n", len(gameDay.Scenarios))
    fmt.Fprintf(&b, "- **Teams**: %d\n", len(gameDay.Teams))
    fmt.Fprintf(&b, "- **Findings**: %d\n\n", len(gameDay.Results.Findings))

    b.WriteString("## Leaderboard\n\n")

    // Clone before sorting. Rendering a report must not reorder the caller's
    // slice as a side effect.
    ranked := slices.Clone(gameDay.Teams)
    slices.SortFunc(ranked, func(a, c Team) int {
        if d := cmp.Compare(c.Score, a.Score); d != 0 {
            return d // Descending by score.
        }
        return cmp.Compare(a.Name, c.Name) // Stable, readable tiebreak.
    })

    rank := 0
    for i, team := range ranked {
        // Equal scores share a rank, and the next distinct score skips ahead.
        if i == 0 || team.Score != ranked[i-1].Score {
            rank = i + 1
        }
        fmt.Fprintf(&b, "%d. **%s**, %d points\n", rank, team.Name, team.Score)
    }

    if len(gameDay.Results.Findings) > 0 {
        findings := slices.Clone(gameDay.Results.Findings)
        slices.SortFunc(findings, func(a, c Finding) int {
            return cmp.Compare(sevRank(a.Severity), sevRank(c.Severity))
        })

        b.WriteString("\n## Findings\n\n")
        for _, f := range findings {
            fmt.Fprintf(&b, "- **[%s]** %s: %s\n",
                strings.ToUpper(f.Severity), f.Scenario, f.Description)
            if f.Remediation != "" {
                fmt.Fprintf(&b, "  - Remediation: %s\n", f.Remediation)
            }
        }
    }

    b.WriteString("\n## Recommendations\n\n")

    crit := 0
    for _, f := range gameDay.Results.Findings {
        if sevRank(f.Severity) <= severityRank["high"] {
            crit++
        }
    }

    switch {
    case len(gameDay.Results.Findings) == 0:
        // A clean sweep is not a victory lap. It is a signal about the
        // scenarios, and the report should say so.
        b.WriteString("- No findings. Raise the difficulty: scenarios that never " +
            "break anything teach nothing\n")
        b.WriteString("- Widen the blast radius or add a scenario the team has not seen\n")
    default:
        if crit > 0 {
            fmt.Fprintf(&b, "- Address the %d critical/high finding(s) within 30 days, "+
                "with named owners\n", crit)
        }
        b.WriteString("- Update the runbooks each finding touched, while the details are fresh\n")
        b.WriteString("- Re-run the failed scenarios once fixes land, to confirm the fix " +
            "rather than assume it\n")
    }

    return b.String()
}
```

Two smaller changes are worth naming. Building the report with `report += fmt.Sprintf(...)` in a loop reallocates and copies the whole document on every iteration, and `strings.Builder` is the standard answer. And the recommendations are derived rather than hardcoded: a fixed list that always says "address critical findings within 30 days" prints that line even when there were no findings at all, which trains readers to skip the section.

Given four teams where two tie at 95, the output ranks them 1, 1, 3, 4, leads with the critical finding, and counts the real number of items needing an owner:

```
## Leaderboard

1. **Team Bravo**, 95 points
1. **Team Delta**, 95 points
3. **Team Charlie**, 70 points
4. **Team Alpha**, 40 points

## Findings

- **[CRITICAL]** az-loss: no automatic failover
  - Remediation: enable multi-AZ
- **[LOW]** db-failover: runbook link stale

## Recommendations

- Address the 1 critical/high finding(s) within 30 days, with named owners
- Update the runbooks each finding touched, while the details are fresh
- Re-run the failed scenarios once fixes land, to confirm the fix rather than assume it
```
