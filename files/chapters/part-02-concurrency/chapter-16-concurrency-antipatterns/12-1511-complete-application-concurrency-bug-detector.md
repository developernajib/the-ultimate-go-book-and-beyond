## 16.11 Complete Application: Concurrency Bug Detector

The following tool detects and reports concurrency issues in running Go applications. It monitors goroutine counts for leak detection, tracks lock acquisitions to identify potential deadlocks, and exposes metrics for alerting.

Lock tracking has a specific shape that is easy to get wrong, and getting it wrong produces a detector that reports nothing while looking like it works. A lock has **three** states worth recording, not two: a goroutine is about to wait for it, a goroutine holds it, or it is free. Collapse "about to wait" and "holds" into a single `TrackAcquire` call and the tracker can never populate `holder`, the "am I waiting?" branch becomes unreachable, and `CheckDeadlocks` returns an empty slice forever. Point it at a textbook AB-BA deadlock and it reports zero alerts, in silence, which is the worst possible failure for a diagnostic tool: it does not crash, it just quietly certifies that everything is fine.

So the tracker below has three hooks, and `TrackedMutex.Lock` calls two of them, one on each side of the real `mu.Lock()`. That split is the entire design:

```go
func (m *TrackedMutex) Lock() {
    m.tracker.TrackWait(ptr, m.name) // Before: "I am about to block"
    m.mu.Lock()                      // May block for a long time
    m.tracker.TrackAcquired(ptr)     // After: "I now hold it"
}
```

Wired that way, the same AB-BA deadlock reports both sides of the cycle, which is exactly what you need to name the offending lock order:

```
goroutine 7 waiting on "A" (held by goroutine 6) for 950ms
goroutine 6 waiting on "B" (held by goroutine 7) for 950ms
```

One caveat before the code: `getGoroutineID` works by parsing `runtime.Stack` output, because Go deliberately exposes no goroutine ID. It is slow, it depends on the format of runtime output that carries no compatibility promise, and putting it on every `Lock` and `Unlock` makes this a debugging tool rather than something to leave enabled in a hot path. Gate it behind a build tag or a config flag and turn it on when you are hunting.

```go
// bugdetector/detector.go
package bugdetector

import (
    "context"
    "fmt"
    "runtime"
    "runtime/debug"
    "sync"
    "sync/atomic"
    "time"
    "unsafe"
)

// Detector monitors for concurrency issues
type Detector struct {
    config Config
    ctx    context.Context
    cancel context.CancelFunc

    // Goroutine tracking
    baseline      int
    lastCount     atomic.Int32
    leakThreshold int
    leakReports   []LeakReport

    // Deadlock detection
    lockTracker   *LockTracker
    deadlockAlerts chan DeadlockAlert

    // Metrics
    metrics *Metrics

    mu sync.Mutex
}

type Config struct {
    // Goroutine leak detection
    LeakCheckInterval  time.Duration
    LeakThreshold      int  // Alert if goroutines exceed baseline + threshold
    LeakGrowthRate     int  // Alert if growing faster than this per minute

    // Deadlock detection
    LockTimeout        time.Duration
    EnableLockTracking bool

    // Reporting
    ReportInterval     time.Duration
    AlertCallback      func(Alert)
}

func DefaultConfig() Config {
    return Config{
        LeakCheckInterval:  time.Second * 30,
        LeakThreshold:      100,
        LeakGrowthRate:     10,
        LockTimeout:        time.Second * 30,
        EnableLockTracking: true,
        ReportInterval:     time.Minute,
    }
}

type Alert interface {
    Type() string
    Severity() Severity
    Message() string
    Time() time.Time
}

type Severity int

const (
    SeverityInfo Severity = iota
    SeverityWarning
    SeverityCritical
)

type LeakReport struct {
    Time           time.Time
    GoroutineCount int
    GrowthRate     float64
    StackSample    string
}

type DeadlockAlert struct {
    time      time.Time
    goroutine int
    waitingOn string
    heldBy    []int
    stack     string
}

func (d DeadlockAlert) Type() string      { return "deadlock" }
func (d DeadlockAlert) Severity() Severity { return SeverityCritical }
func (d DeadlockAlert) Message() string {
    return fmt.Sprintf("potential deadlock: goroutine %d waiting on %s", d.goroutine, d.waitingOn)
}
func (d DeadlockAlert) Time() time.Time { return d.time }

type Metrics struct {
    GoroutineCount     atomic.Int32
    GoroutinePeak      atomic.Int32
    LeaksDetected      atomic.Int32
    DeadlocksDetected  atomic.Int32
    LockContentionMs   atomic.Int64
    ChecksPerformed    atomic.Int64
}

func NewDetector(config Config) *Detector {
    ctx, cancel := context.WithCancel(context.Background())

    d := &Detector{
        config:         config,
        ctx:            ctx,
        cancel:         cancel,
        baseline:       runtime.NumGoroutine(),
        leakThreshold:  config.LeakThreshold,
        deadlockAlerts: make(chan DeadlockAlert, 100),
        metrics:        &Metrics{},
    }

    if config.EnableLockTracking {
        d.lockTracker = NewLockTracker(config.LockTimeout)
    }

    return d
}

// Start begins monitoring
func (d *Detector) Start() {
    go d.monitorGoroutines()
    go d.processAlerts()

    if d.config.EnableLockTracking {
        go d.monitorLocks()
    }
}

// Stop halts monitoring
func (d *Detector) Stop() {
    d.cancel()
}

func (d *Detector) monitorGoroutines() {
    ticker := time.NewTicker(d.config.LeakCheckInterval)
    defer ticker.Stop()

    var history []int
    const historySize = 10

    for {
        select {
        case <-d.ctx.Done():
            return
        case <-ticker.C:
            count := runtime.NumGoroutine()
            d.lastCount.Store(int32(count))
            d.metrics.GoroutineCount.Store(int32(count))
            d.metrics.ChecksPerformed.Add(1)

            // Update peak
            for {
                peak := d.metrics.GoroutinePeak.Load()
                if int32(count) <= peak {
                    break
                }
                if d.metrics.GoroutinePeak.CompareAndSwap(peak, int32(count)) {
                    break
                }
            }

            // Track history for growth rate
            history = append(history, count)
            if len(history) > historySize {
                history = history[1:]
            }

            // Check for leaks.
            //
            // baseline is sampled once at construction and never moves,
            // which makes this a crude signal: a service that legitimately
            // scales its goroutine count with traffic will cross a fixed
            // baseline+threshold and alert forever. Sustained GROWTH is the
            // real leak signal, not absolute count, so treat the growth rate
            // as primary and this as a coarse gate.
            if count > d.baseline+d.leakThreshold {
                d.reportLeak(count, d.calculateGrowthRate(history))
            }
        }
    }
}

func (d *Detector) calculateGrowthRate(history []int) float64 {
    if len(history) < 2 {
        return 0
    }

    first := history[0]
    last := history[len(history)-1]

    // n samples span n-1 intervals, not n. Using len(history) here
    // under-reports the growth rate by a factor of n/(n-1).
    duration := float64(len(history)-1) * d.config.LeakCheckInterval.Minutes()
    if duration == 0 {
        return 0
    }

    return float64(last-first) / duration
}

func (d *Detector) reportLeak(count int, growthRate float64) {
    d.mu.Lock()
    defer d.mu.Unlock()

    d.metrics.LeaksDetected.Add(1)

    report := LeakReport{
        Time:           time.Now(),
        GoroutineCount: count,
        GrowthRate:     growthRate,
        StackSample:    d.captureGoroutineStacks(),
    }

    d.leakReports = append(d.leakReports, report)

    if d.config.AlertCallback != nil {
        d.config.AlertCallback(leakAlert{report})
    }
}

type leakAlert struct {
    report LeakReport
}

func (l leakAlert) Type() string      { return "goroutine_leak" }
func (l leakAlert) Severity() Severity {
    if l.report.GrowthRate > 50 {
        return SeverityCritical
    }
    return SeverityWarning
}
func (l leakAlert) Message() string {
    return fmt.Sprintf("goroutine leak detected: %d goroutines (%.1f/min growth)",
        l.report.GoroutineCount, l.report.GrowthRate)
}
func (l leakAlert) Time() time.Time { return l.report.Time }

// captureGoroutineStacks grows the buffer until the dump fits.
//
// A fixed buffer truncates silently, and it truncates worst exactly
// when it matters: the service with 50,000 leaked goroutines is the one
// whose dump does not fit in 1MB, so the leak evidence is what gets cut.
func (d *Detector) captureGoroutineStacks() string {
    size := 1 << 20
    for {
        buf := make([]byte, size)
        n := runtime.Stack(buf, true)
        if n < len(buf) {
            return string(buf[:n])
        }
        size *= 2
    }
}

func (d *Detector) monitorLocks() {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-d.ctx.Done():
            return
        case <-ticker.C:
            for _, alert := range d.lockTracker.CheckDeadlocks() {
                // Never send unguarded. A bare send here blocks forever
                // once the buffer fills and processAlerts has exited,
                // which leaks this monitor goroutine during shutdown.
                select {
                case d.deadlockAlerts <- alert:
                case <-d.ctx.Done():
                    return
                default:
                    // Buffer full: drop rather than stall the monitor.
                    // The same deadlock will be re-reported next tick.
                }
            }
        }
    }
}

func (d *Detector) processAlerts() {
    for {
        select {
        case <-d.ctx.Done():
            return
        case alert := <-d.deadlockAlerts:
            d.metrics.DeadlocksDetected.Add(1)
            if d.config.AlertCallback != nil {
                d.config.AlertCallback(alert)
            }
        }
    }
}

// GetMetrics returns current metrics snapshot
func (d *Detector) GetMetrics() MetricsSnapshot {
    return MetricsSnapshot{
        GoroutineCount:    int(d.metrics.GoroutineCount.Load()),
        GoroutinePeak:     int(d.metrics.GoroutinePeak.Load()),
        LeaksDetected:     int(d.metrics.LeaksDetected.Load()),
        DeadlocksDetected: int(d.metrics.DeadlocksDetected.Load()),
        LockContentionMs:  d.metrics.LockContentionMs.Load(),
        ChecksPerformed:   d.metrics.ChecksPerformed.Load(),
    }
}

type MetricsSnapshot struct {
    GoroutineCount    int
    GoroutinePeak     int
    LeaksDetected     int
    DeadlocksDetected int
    LockContentionMs  int64
    ChecksPerformed   int64
}

// LockTracker tracks lock acquisitions for deadlock detection
type LockTracker struct {
    mu       sync.Mutex
    locks    map[uintptr]*lockInfo
    timeout  time.Duration
    waiters  map[int]*waiterInfo // goroutine ID -> waiting info
}

type lockInfo struct {
    name       string
    holder     int  // goroutine ID
    acquiredAt time.Time
    waiters    []int
}

type waiterInfo struct {
    waitingFor uintptr
    since      time.Time
    stack      string
}

func NewLockTracker(timeout time.Duration) *LockTracker {
    return &LockTracker{
        locks:   make(map[uintptr]*lockInfo),
        timeout: timeout,
        waiters: make(map[int]*waiterInfo),
    }
}

// TrackWait records that this goroutine is ABOUT to block on lockPtr.
// It must be called BEFORE the real Lock, because once we are blocked
// inside Lock we cannot record anything at all.
func (t *LockTracker) TrackWait(lockPtr uintptr, name string) {
    // Capture identity and stack before taking t.mu: both are slow, and
    // holding the tracker's own lock across them makes the tracker the
    // bottleneck it exists to find.
    gid := getGoroutineID()
    stack := string(debug.Stack())

    t.mu.Lock()
    defer t.mu.Unlock()

    if _, exists := t.locks[lockPtr]; !exists {
        t.locks[lockPtr] = &lockInfo{name: name}
    }
    t.waiters[gid] = &waiterInfo{
        waitingFor: lockPtr,
        since:      time.Now(),
        stack:      stack,
    }
}

// TrackAcquired records that this goroutine now HOLDS lockPtr.
// Must be called AFTER the real Lock returns.
//
// Assigning holder here is what makes the whole tracker work. Omit it
// and holder stays 0 forever, no waiter is ever attributed to a holder,
// and CheckDeadlocks silently returns nothing during real deadlocks.
func (t *LockTracker) TrackAcquired(lockPtr uintptr) {
    gid := getGoroutineID()

    t.mu.Lock()
    defer t.mu.Unlock()

    delete(t.waiters, gid) // We are no longer waiting: we got it
    if info, ok := t.locks[lockPtr]; ok {
        info.holder = gid
        info.acquiredAt = time.Now()
    }
}

func (t *LockTracker) TrackRelease(lockPtr uintptr) {
    gid := getGoroutineID()

    t.mu.Lock()
    defer t.mu.Unlock()

    info, exists := t.locks[lockPtr]
    if !exists {
        return
    }

    // Only the holder may clear the holder. Guarding on gid keeps a
    // stray Unlock from erasing another goroutine's ownership record.
    if info.holder == gid {
        info.holder = 0
        info.acquiredAt = time.Time{}
    }
}

func (t *LockTracker) CheckDeadlocks() []DeadlockAlert {
    t.mu.Lock()
    defer t.mu.Unlock()

    var alerts []DeadlockAlert
    now := time.Now()

    for gid, waiter := range t.waiters {
        if now.Sub(waiter.since) <= t.timeout {
            continue
        }
        info := t.locks[waiter.waitingFor]
        if info == nil {
            continue // Nil-check: the map lookup can miss
        }
        alerts = append(alerts, DeadlockAlert{
            time:      now,
            goroutine: gid,
            waitingOn: info.name,
            heldBy:    []int{info.holder},
            stack:     waiter.stack,
        })
    }

    return alerts
}

func getGoroutineID() int {
    var buf [64]byte
    n := runtime.Stack(buf[:], false)
    var id int
    fmt.Sscanf(string(buf[:n]), "goroutine %d ", &id)
    return id
}

// TrackedMutex is a mutex that integrates with LockTracker
type TrackedMutex struct {
    mu      sync.Mutex
    tracker *LockTracker
    name    string
}

func NewTrackedMutex(tracker *LockTracker, name string) *TrackedMutex {
    return &TrackedMutex{
        tracker: tracker,
        name:    name,
    }
}

// Lock brackets the real Lock with the two tracking calls. The split is
// the point: TrackWait must happen before we block, TrackAcquired after
// we stop blocking. A single call on either side cannot express both.
func (m *TrackedMutex) Lock() {
    ptr := uintptr(unsafe.Pointer(&m.mu))
    if m.tracker != nil {
        m.tracker.TrackWait(ptr, m.name)
    }
    m.mu.Lock()
    if m.tracker != nil {
        m.tracker.TrackAcquired(ptr)
    }
}

func (m *TrackedMutex) Unlock() {
    ptr := uintptr(unsafe.Pointer(&m.mu))
    m.mu.Unlock()
    if m.tracker != nil {
        m.tracker.TrackRelease(ptr)
    }
}
```

### Tests

The test suite validates each major detection capability in isolation using a short `LeakCheckInterval` so tests don't have to wait for production-scale timeouts. `TestGoroutineLeakDetection` deliberately spawns goroutines that block forever and then asserts that the detector fires a `goroutine_leak` alert within one second. `TestDeadlockDetection` simulates the classic lock-ordering deadlock using two `TrackedMutex` instances, and `TestMetricsCollection` verifies that the periodic check loop increments `ChecksPerformed` at the expected rate.

```go
// bugdetector/detector_test.go
package bugdetector

import (
    "context"
    "sync"
    "testing"
    "time"
)

func TestGoroutineLeakDetection(t *testing.T) {
    alerts := make([]Alert, 0)
    var mu sync.Mutex

    config := DefaultConfig()
    config.LeakCheckInterval = time.Millisecond * 100
    config.LeakThreshold = 5
    config.AlertCallback = func(a Alert) {
        mu.Lock()
        alerts = append(alerts, a)
        mu.Unlock()
    }

    detector := NewDetector(config)
    detector.Start()
    defer detector.Stop()

    // Create goroutine leak
    for i := 0; i < 20; i++ {
        go func() {
            select {} // Blocks forever
        }()
    }

    // Wait for detection
    time.Sleep(time.Second)

    mu.Lock()
    defer mu.Unlock()

    if len(alerts) == 0 {
        t.Error("expected leak alert")
    }

    for _, alert := range alerts {
        if alert.Type() != "goroutine_leak" {
            t.Errorf("unexpected alert type: %s", alert.Type())
        }
    }
}

func TestDeadlockDetection(t *testing.T) {
    config := DefaultConfig()
    config.LockTimeout = time.Millisecond * 100
    config.EnableLockTracking = true

    detector := NewDetector(config)
    tracker := detector.lockTracker

    mu1 := NewTrackedMutex(tracker, "mutex1")
    mu2 := NewTrackedMutex(tracker, "mutex2")

    // Simulate a lock-ordering deadlock. Both goroutines stay parked
    // forever, so do NOT wait on them: a wg.Wait here would hang the
    // test along with the deadlock it is demonstrating.
    go func() {
        mu1.Lock()
        time.Sleep(time.Millisecond * 50)
        mu2.Lock()
        mu2.Unlock()
        mu1.Unlock()
    }()

    go func() {
        mu2.Lock()
        time.Sleep(time.Millisecond * 50)
        mu1.Lock()
        mu1.Unlock()
        mu2.Unlock()
    }()

    // Let the deadlock form and age past LockTimeout, then ask the
    // tracker directly. The two goroutines leak past the end of this
    // test by design: they ARE the deadlock under test. (That is also
    // why this package must not use a leak-checking TestMain.)
    time.Sleep(time.Millisecond * 300)

    alerts := tracker.CheckDeadlocks()
    if len(alerts) == 0 {
        t.Fatal("expected deadlock alerts, got none")
    }
}

func TestMetricsCollection(t *testing.T) {
    config := DefaultConfig()
    config.LeakCheckInterval = time.Millisecond * 50

    detector := NewDetector(config)
    detector.Start()
    defer detector.Stop()

    time.Sleep(time.Millisecond * 200)

    metrics := detector.GetMetrics()
    if metrics.ChecksPerformed < 2 {
        t.Errorf("expected at least 2 checks, got %d", metrics.ChecksPerformed)
    }
    if metrics.GoroutineCount == 0 {
        t.Error("expected non-zero goroutine count")
    }
}
```

### Makefile

The `Makefile` provides a consistent set of commands for building, testing, and quality-checking the detector package. The `race-test` target is particularly important for this package: because `bugdetector` itself uses goroutines and shared atomic state, running the test suite under Go's race detector (`-race`) catches any data races introduced in the detector's own implementation. The `coverage` target generates an HTML report so contributors can see which detection paths lack test coverage.

```makefile
# Makefile
.PHONY: build test race-test bench clean

BINARY=bugdetector

build:
	go build -o $(BINARY) ./cmd/bugdetector

test:
	go test -v ./...

race-test:
	go test -race -v ./...

bench:
	go test -bench=. -benchmem ./...

lint:
	golangci-lint run

coverage:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

clean:
	rm -f $(BINARY) coverage.out coverage.html
```

### Staff Lens: Concurrency Bug Detection Infrastructure

The bug detector above is a teaching exercise. In production, the equivalent is integration with observability infrastructure:

1. **Goroutine count metric** with alerts on monotonic growth.
2. **pprof endpoints** accessible from on-call tooling.
3. **Distributed tracing** to correlate cross-service concurrency issues.
4. **Structured logs** with request correlation IDs.
5. **Runtime telemetry** via `runtime/metrics` (GC, scheduler, heap).

Teams that build this infrastructure early catch concurrency bugs in minutes instead of hours. The infrastructure is unglamorous but compounds value over years.

---
