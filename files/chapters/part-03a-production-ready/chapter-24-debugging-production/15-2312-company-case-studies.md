## 24.12 Company Case Studies

### Google: Continuous Profiling with Cloud Profiler

Google Cloud Profiler demonstrates production debugging at scale. Their approach collects low-overhead profiling data from thousands of instances continuously.

**Key Insights from Google's Approach:**

1. **Statistical Sampling**: Sample over time rather than instrument every request. Cloud Profiler collects a short capture from each instance periodically, so any single instance is profiling only a small fraction of the time, and the cost lands on the fleet rather than on the request path.
2. **Flame Graph Aggregation**: Combine profiles across instances into a single view
3. **Version Comparison**: Compare performance between deployments automatically
4. **Integration with CI/CD**: Block deployments that regress performance

The sampling point is worth stating carefully, because "profile 1% of requests" is a different technique from what a Go CPU profiler does. Go's CPU profiler is not request-aware at all: it interrupts on a timer and attributes samples to whatever stack is running. You cannot profile "1% of requests" with it. What you can do is profile 100% of the process for a short window, infrequently, and let the aggregate across many instances stand in for the fleet. If you want per-request attribution, that is what `pprof.Labels` and distributed tracing are for.

```go
// Google-style continuous profiler integration
package profiling

import (
    "context"
    "fmt"
    "log/slog"

    "cloud.google.com/go/profiler"
)

type GoogleProfilerConfig struct {
    ProjectID      string
    Service        string
    ServiceVersion string
    DebugLogging   bool
    MutexProfiling bool
}

func InitGoogleProfiler(ctx context.Context, config GoogleProfilerConfig) error {
    cfg := profiler.Config{
        ProjectID:      config.ProjectID,
        Service:        config.Service,
        ServiceVersion: config.ServiceVersion,
        DebugLogging:   config.DebugLogging,
        MutexProfiling: config.MutexProfiling,
    }

    if err := profiler.Start(cfg); err != nil {
        return fmt.Errorf("failed to start profiler: %w", err)
    }

    slog.Info("Google Cloud Profiler started",
        "project", config.ProjectID,
        "service", config.Service,
        "version", config.ServiceVersion,
    )

    return nil
}

// Google uses profile-guided optimization
// Their internal tools analyze profiles to suggest:
// - Hot functions that need optimization
// - Memory allocation hotspots
// - Lock contention points
// - Cache efficiency issues
```

**Google's Debugging Philosophy:**
- Never debug in production without safety guards
- Always have rollback capability
- Use progressive rollout to limit blast radius
- Automated anomaly detection triggers investigation

### Netflix: Flamescope and Production Profiling

Netflix developed Flamescope for analyzing subsecond latency patterns. Their approach emphasizes time-series analysis of profiles.

**Key Innovations:**

The profiler below captures 100ms CPU snapshots at configurable intervals and stores them in a ring buffer. By plotting these samples on a time axis, engineers can spot periodic latency spikes that a single 30-second profile would average away.

Read this one as an illustration of the idea rather than a component to deploy, because two properties of Go's CPU profiler fight it directly.

CPU profiling is process-global and exclusive. `pprof.StartCPUProfile` returns `cpu profiling already in use` if a profile is already running, and there is no way to have two. So while this sampler runs, every request to `/debug/pprof/profile` fails, and the `return` on error above swallows that silently in the other direction too. A background component that quietly disables your main profiling endpoint is a bad trade during an incident.

And a 100ms window is thin. The profiler samples at 100Hz, so 100ms buys you roughly ten samples per busy CPU, which is noise rather than a profile. FlameScope's actual approach is the reverse of this: take one long capture and slice it along the time axis afterwards, which gives subsecond resolution without repeatedly starting and stopping the profiler. If you want this capability in a Go service today, the flight recorder in `runtime/trace` (see 24.5) is the tool that genuinely fits: it keeps a rolling window and lets you dump the last few seconds when an SLO fires.

```go
// Netflix-style subsecond profiling
package flamescope

import (
    "bytes"
    "context"
    "runtime/pprof"
    "sync"
    "time"
)

type SubsecondProfiler struct {
    profiles    []ProfileSample
    mu          sync.RWMutex
    maxSamples  int
    sampleRate  time.Duration
}

type ProfileSample struct {
    Timestamp time.Time
    Data      []byte
    Duration  time.Duration
}

func NewSubsecondProfiler(maxSamples int, sampleRate time.Duration) *SubsecondProfiler {
    return &SubsecondProfiler{
        profiles:   make([]ProfileSample, 0, maxSamples),
        maxSamples: maxSamples,
        sampleRate: sampleRate,
    }
}

func (p *SubsecondProfiler) Start(ctx context.Context) {
    ticker := time.NewTicker(p.sampleRate)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            p.captureSample()
        }
    }
}

func (p *SubsecondProfiler) captureSample() {
    var buf bytes.Buffer
    start := time.Now()

    // Capture brief CPU profile (100ms)
    if err := pprof.StartCPUProfile(&buf); err != nil {
        return
    }
    time.Sleep(100 * time.Millisecond)
    pprof.StopCPUProfile()

    sample := ProfileSample{
        Timestamp: start,
        Data:      buf.Bytes(),
        Duration:  time.Since(start),
    }

    p.mu.Lock()
    defer p.mu.Unlock()

    p.profiles = append(p.profiles, sample)
    if len(p.profiles) > p.maxSamples {
        p.profiles = p.profiles[1:]
    }
}

// GetProfiles returns profiles in a time range
func (p *SubsecondProfiler) GetProfiles(start, end time.Time) []ProfileSample {
    p.mu.RLock()
    defer p.mu.RUnlock()

    var result []ProfileSample
    for _, sample := range p.profiles {
        if sample.Timestamp.After(start) && sample.Timestamp.Before(end) {
            result = append(result, sample)
        }
    }
    return result
}
```

**Netflix's Key Practices:**
- Heatmap visualization for identifying latency patterns
- Correlation with deployment events
- A/B testing of optimization changes
- Regional performance comparison

### Uber: Dynamic Debug Instrumentation

Uber pioneered dynamic instrumentation that can be enabled at runtime without restarts. The idea is to embed named "debug points" throughout application code that are no-ops by default. When an operator enables a point via a control plane API, it starts recording context data, hit counts, and caller information.

The usual claim attached to this pattern is "zero overhead when disabled, because it is just an atomic boolean check". Look at what the call site below actually does before that check is reached. `Hit` takes an `RWMutex` read lock, hashes a string to look the point up in a map, and releases the lock, and the caller has already constructed a `map[string]any` of debug data to pass in. All of that happens on every call whether the point is enabled or not. Benchmarked, the disabled path costs a couple of hundred nanoseconds per call rather than the ~3ns an atomic load costs. That is fine at 100 call sites and ruinous in a hot loop, which is exactly where you want debug points.

To get the property the pattern promises, resolve the `*DebugPoint` once at init, keep the atomic load at the call site, and put everything else, the map construction included, behind it:

```go
// Resolved once, not per call.
var authPoint = debugger.RegisterPoint("user-auth-check", "auth.go:42")

func checkAuth(ctx context.Context, userID string) {
    // Disabled path: one atomic load. Nothing is built, nothing is locked.
    if authPoint.Enabled.Load() {
        authPoint.Hit(ctx, map[string]any{"user_id": userID, "method": "password"})
    }
    // ...
}
```

The lesson generalises beyond debug points. A guard is only free if the expensive work sits inside it. If arguments are evaluated at the call site, the guard is not a guard, and the same mistake shows up in hand-rolled logging wrappers where `log.Debug("x", expensiveString())` evaluates the argument no matter what the level is.

```go
// Uber-style dynamic debug points
package dyndbg

import (
    "context"
    "fmt"
    "log/slog"
    "runtime"
    "sync"
    "sync/atomic"
)

type DebugPoint struct {
    ID       string
    Location string
    Enabled  atomic.Bool
    HitCount atomic.Int64
    Handler  func(ctx context.Context, data map[string]any)
    logger   *slog.Logger
}

type DynamicDebugger struct {
    points map[string]*DebugPoint
    mu     sync.RWMutex
    logger *slog.Logger
}

func NewDynamicDebugger(logger *slog.Logger) *DynamicDebugger {
    return &DynamicDebugger{
        points: make(map[string]*DebugPoint),
        logger: logger,
    }
}

// RegisterPoint adds a debug point that can be dynamically enabled
func (d *DynamicDebugger) RegisterPoint(id, location string) *DebugPoint {
    d.mu.Lock()
    defer d.mu.Unlock()

    point := &DebugPoint{
        ID:       id,
        Location: location,
        logger:   d.logger,
    }
    d.points[id] = point
    return point
}

// EnablePoint enables a debug point at runtime
func (d *DynamicDebugger) EnablePoint(id string) error {
    d.mu.RLock()
    defer d.mu.RUnlock()

    point, ok := d.points[id]
    if !ok {
        return fmt.Errorf("debug point not found: %s", id)
    }

    point.Enabled.Store(true)
    d.logger.Info("debug point enabled",
        "id", id,
        "location", point.Location,
    )
    return nil
}

// Hit records a hit on an already-resolved point.
//
// Call it behind `if p.Enabled.Load()` at the call site. The lookup-by-id
// form, Hit(ctx, "some-id", data), takes a read lock and a map lookup on
// every call and forces the caller to build `data` up front, so the
// disabled path costs hundreds of nanoseconds instead of the ~3ns that
// the atomic load alone costs.
func (p *DebugPoint) Hit(ctx context.Context, data map[string]any) {
    // Re-checked so the method is safe to call directly, and because the
    // point may have been disabled between the caller's check and now.
    if !p.Enabled.Load() {
        return
    }

    p.HitCount.Add(1)

    // Add caller info. runtime.Caller is comparatively expensive, which is
    // another reason it must never sit on the disabled path.
    if _, file, line, ok := runtime.Caller(1); ok {
        data["_caller_file"] = file
        data["_caller_line"] = line
    }

    if p.Handler != nil {
        p.Handler(ctx, data)
        return
    }
    if p.logger != nil {
        p.logger.Debug("debug point hit",
            "id", p.ID,
            "hit_count", p.HitCount.Load(),
            "data", data,
        )
    }
}

// Usage in application code. Register once, guard at the call site:
//
// var authPoint = debugger.RegisterPoint("user-auth-check", "auth.go:42")
//
// func checkAuth(ctx context.Context, userID string) {
//     if authPoint.Enabled.Load() {
//         authPoint.Hit(ctx, map[string]any{
//             "user_id": userID,
//             "method":  "password",
//         })
//     }
// }
```

**Uber's Debugging Principles:**
- Zero-overhead when disabled
- Runtime enablement via control plane
- Automatic disable after timeout
- Rate limiting to prevent log storms

### Stripe: Production Debugging with Safety

Stripe emphasizes safe production debugging with full audit trails for every debug session. Their model requires a peer-approved session before any diagnostic action can execute against a production service. Every action, profile capture, log-level change, goroutine dump, is recorded with operator identity, timestamp, and result, creating an immutable record that post-incident reviews can examine.

```go
// Stripe-style safe production debugging
package safedebug

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "sync"
    "time"
)

type AuditedDebugSession struct {
    ID          string
    Operator    string
    Reason      string
    StartTime   time.Time
    EndTime     *time.Time
    Actions     []DebugAction
    Approved    bool
    ApprovedBy  string
    mu          sync.Mutex
}

type DebugAction struct {
    Timestamp   time.Time
    ActionType  string
    Target      string
    Parameters  map[string]any
    Result      string
}

type SafeDebugger struct {
    sessions    map[string]*AuditedDebugSession
    mu          sync.RWMutex
    logger      *slog.Logger
    auditLogger *slog.Logger
    requireApproval bool
}

func NewSafeDebugger(logger, auditLogger *slog.Logger) *SafeDebugger {
    return &SafeDebugger{
        sessions:        make(map[string]*AuditedDebugSession),
        logger:          logger,
        auditLogger:     auditLogger,
        requireApproval: true,
    }
}

// StartSession begins an audited debug session
func (d *SafeDebugger) StartSession(ctx context.Context, operator, reason string) (*AuditedDebugSession, error) {
    session := &AuditedDebugSession{
        ID:        fmt.Sprintf("dbg-%d", time.Now().UnixNano()),
        Operator:  operator,
        Reason:    reason,
        StartTime: time.Now(),
        Actions:   make([]DebugAction, 0),
    }

    d.mu.Lock()
    d.sessions[session.ID] = session
    d.mu.Unlock()

    d.auditLogger.Info("debug session started",
        "session_id", session.ID,
        "operator", operator,
        "reason", reason,
    )

    return session, nil
}

// ApproveSession requires peer approval for sensitive debugging.
//
// d.mu guards the sessions map. Each session's own fields are guarded by
// session.mu, and every reader and writer of them must take it. Getting
// this wrong here is not a cosmetic race: Approved is the authorization
// gate, and a torn read of it is a security control failing open.
func (d *SafeDebugger) ApproveSession(sessionID, approver string) error {
    d.mu.RLock()
    session, ok := d.sessions[sessionID]
    d.mu.RUnlock()

    if !ok {
        return fmt.Errorf("session not found")
    }

    session.mu.Lock()
    defer session.mu.Unlock()

    if session.Operator == approver {
        return fmt.Errorf("cannot self-approve debug session")
    }

    session.Approved = true
    session.ApprovedBy = approver

    d.auditLogger.Info("debug session approved",
        "session_id", sessionID,
        "approver", approver,
    )

    return nil
}

// ExecuteAction performs and logs a debug action
func (d *SafeDebugger) ExecuteAction(
    ctx context.Context,
    sessionID string,
    actionType string,
    target string,
    params map[string]any,
    fn func() (string, error),
) (string, error) {
    d.mu.RLock()
    session, ok := d.sessions[sessionID]
    d.mu.RUnlock()

    if !ok {
        return "", fmt.Errorf("session not found")
    }

    // Read the approval flag under the session's lock. Reading it bare
    // races ApproveSession, which `go test -race` flags immediately, and
    // it is the check that decides whether a production diagnostic runs.
    session.mu.Lock()
    approved := session.Approved
    session.mu.Unlock()

    if d.requireApproval && !approved {
        return "", fmt.Errorf("session requires approval")
    }

    action := DebugAction{
        Timestamp:  time.Now(),
        ActionType: actionType,
        Target:     target,
        Parameters: params,
    }

    result, err := fn()
    if err != nil {
        action.Result = fmt.Sprintf("error: %v", err)
    } else {
        action.Result = result
    }

    session.mu.Lock()
    session.Actions = append(session.Actions, action)
    session.mu.Unlock()

    d.auditLogger.Info("debug action executed",
        "session_id", sessionID,
        "action_type", actionType,
        "target", target,
        "result", action.Result,
    )

    return result, err
}

// EndSession completes the debug session
func (d *SafeDebugger) EndSession(sessionID string) error {
    d.mu.RLock()
    session, ok := d.sessions[sessionID]
    d.mu.RUnlock()

    if !ok {
        return fmt.Errorf("session not found")
    }

    session.mu.Lock()
    now := time.Now()
    session.EndTime = &now
    actionCount := len(session.Actions)
    duration := now.Sub(session.StartTime)
    // Marshal while still holding the lock. Serialising the session while
    // another goroutine appends to session.Actions is a race on the slice
    // header, and json.Marshal walking a slice that is being reallocated
    // underneath it is how audit logs come out corrupt or the process
    // panics. The audit record is the point of this whole component, so it
    // is the last thing that should be read without a lock.
    sessionJSON, _ := json.Marshal(session)
    session.mu.Unlock()

    d.auditLogger.Info("debug session ended",
        "session_id", sessionID,
        "duration", duration,
        "action_count", actionCount,
        "full_session", string(sessionJSON),
    )

    return nil
}
```

**Stripe's Safety Practices:**
- All production debugging requires peer approval
- Complete audit trail of all actions
- Automatic session timeout
- Post-incident review of debug sessions

### Staff Lens: Audit Production Access

Production debugging access is production access. Log it, audit it, review it. Not because engineers are untrustworthy, but because every access point is a potential incident. Good audit is how security and on-call coexist.

---
