## 24.11 Complete Production Debug Toolkit

This section assembles the individual debugging techniques from previous sections into a single, deployable toolkit. The toolkit can run as a sidecar alongside your production service or be embedded directly into it.

### Project Structure

The toolkit is divided into three layers: `pkg` contains publicly usable building blocks (collector, analyzer, detector, profiler, reporter), `internal/server` wires them into an HTTP API, and `cmd` exposes both a server daemon and a `debugctl` CLI for interactive inspection. This separation means the collector and analyzer can be embedded directly into any Go service, while the server and CLI provide a standalone debugging sidecar alternative.

```
debug-toolkit/
├── cmd/
│   ├── debugserver/
│   │   └── main.go
│   └── debugctl/
│       └── main.go
├── pkg/
│   ├── collector/
│   │   └── collector.go
│   ├── analyzer/
│   │   └── analyzer.go
│   ├── profiler/
│   │   └── profiler.go
│   ├── detector/
│   │   └── detector.go
│   └── reporter/
│       └── reporter.go
├── internal/
│   └── server/
│       └── server.go
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── go.mod
```

### pkg/collector/collector.go - Debug Data Collector

The `Collector` gathers a complete runtime snapshot in a single pass: runtime metadata, heap and GC statistics, goroutine state breakdown, and optionally all pprof profiles (heap, goroutine, allocs, block, mutex, threadcreate). Prometheus counters and histograms instrument the collection itself so operators can detect when debug data gathering is slow enough to affect production performance. The `CollectFromRemote` and `CollectProfileFromRemote` helpers allow `debugctl` to query a running service over HTTP without requiring direct access to its process.

One expectation to set before you read `collectProfiles`: two of those six profiles will be empty. `block` and `mutex` record nothing until `runtime.SetBlockProfileRate` and `runtime.SetMutexProfileFraction` are called with a non-zero value, and both default to 0. `pprof.Lookup("block")` still returns a valid, non-nil profile, and writing it still succeeds, so the collector cheerfully stores a well-formed profile containing zero samples. Nothing in the code path errors. This is worth knowing before you spend an incident staring at an empty contention profile and concluding you have no contention. The `EnableContentionProfiling` helper below makes the opt-in explicit and is deliberately not called by default.

```go
// EnableContentionProfiling turns on the block and mutex profiles, which are
// off by default and otherwise collect nothing at all.
//
// Both carry continuous overhead proportional to contention, so this is an
// investigation-time switch, not a fleet default. Enable it on one canary.
func EnableContentionProfiling() {
    // Sample one blocking event per 10,000ns spent blocked. Lower is finer
    // and more expensive. 1 records every event and will hurt.
    runtime.SetBlockProfileRate(10_000)

    // Sample 1 in 5 mutex contention events.
    runtime.SetMutexProfileFraction(5)
}

// DisableContentionProfiling restores the zero-overhead default.
func DisableContentionProfiling() {
    runtime.SetBlockProfileRate(0)
    runtime.SetMutexProfileFraction(0)
}
```

```go
// Package collector gathers debug information from Go services
package collector

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
    "runtime"
    "runtime/debug"
    "runtime/pprof"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    collectionsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "debug_collections_total",
            Help: "Total debug data collections",
        },
        []string{"type", "status"},
    )

    collectionDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "debug_collection_duration_seconds",
            Help:    "Time spent collecting debug data",
            Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
        },
        []string{"type"},
    )
)

// Snapshot represents a point-in-time debug snapshot
type Snapshot struct {
    ID           string            `json:"id"`
    Timestamp    time.Time         `json:"timestamp"`
    Hostname     string            `json:"hostname"`
    Version      string            `json:"version"`
    Runtime      RuntimeInfo       `json:"runtime"`
    Memory       MemoryInfo        `json:"memory"`
    GC           GCInfo            `json:"gc"`
    Goroutines   GoroutineInfo     `json:"goroutines"`
    Profiles     map[string][]byte `json:"-"`
    Environment  map[string]string `json:"environment"`
    CustomData   map[string]any    `json:"custom_data,omitempty"`
}

// RuntimeInfo contains Go runtime information
type RuntimeInfo struct {
    Version      string `json:"version"`
    GOOS         string `json:"goos"`
    GOARCH       string `json:"goarch"`
    NumCPU       int    `json:"num_cpu"`
    GOMAXPROCS   int    `json:"gomaxprocs"`
    NumGoroutine int    `json:"num_goroutine"`
    NumCgoCall   int64  `json:"num_cgo_call"`
}

// MemoryInfo contains memory statistics
type MemoryInfo struct {
    Alloc         uint64 `json:"alloc_bytes"`
    TotalAlloc    uint64 `json:"total_alloc_bytes"`
    Sys           uint64 `json:"sys_bytes"`
    HeapAlloc     uint64 `json:"heap_alloc_bytes"`
    HeapSys       uint64 `json:"heap_sys_bytes"`
    HeapIdle      uint64 `json:"heap_idle_bytes"`
    HeapInuse     uint64 `json:"heap_inuse_bytes"`
    HeapReleased  uint64 `json:"heap_released_bytes"`
    HeapObjects   uint64 `json:"heap_objects"`
    StackInuse    uint64 `json:"stack_inuse_bytes"`
    StackSys      uint64 `json:"stack_sys_bytes"`
    MSpanInuse    uint64 `json:"mspan_inuse_bytes"`
    MCacheInuse   uint64 `json:"mcache_inuse_bytes"`
    BuckHashSys   uint64 `json:"buckhash_sys_bytes"`
    GCSys         uint64 `json:"gc_sys_bytes"`
    OtherSys      uint64 `json:"other_sys_bytes"`
}

// GCInfo contains garbage collection statistics
type GCInfo struct {
    NumGC          uint32        `json:"num_gc"`
    NumForcedGC    uint32        `json:"num_forced_gc"`
    GCCPUFraction  float64       `json:"gc_cpu_fraction"`
    LastGC         time.Time     `json:"last_gc"`
    NextGC         uint64        `json:"next_gc_bytes"`
    PauseTotalNs   uint64        `json:"pause_total_ns"`
    PauseAvgNs     uint64        `json:"pause_avg_ns"`
    PauseMaxNs     uint64        `json:"pause_max_ns"`
    RecentPausesNs []uint64      `json:"recent_pauses_ns"`
}

// GoroutineInfo contains goroutine analysis
type GoroutineInfo struct {
    Total      int                 `json:"total"`
    Running    int                 `json:"running"`
    Waiting    int                 `json:"waiting"`
    Blocked    int                 `json:"blocked"`
    ByState    map[string]int      `json:"by_state"`
    ByFunction map[string]int      `json:"by_function"`
    Dump       string              `json:"dump,omitempty"`
}

// Collector gathers debug information
type Collector struct {
    version      string
    hostname     string
    customDataFn func() map[string]any
    mu           sync.RWMutex
    lastSnapshot *Snapshot
}

// NewCollector creates a new debug data collector
func NewCollector(version string) *Collector {
    hostname, _ := os.Hostname()
    return &Collector{
        version:  version,
        hostname: hostname,
    }
}

// SetCustomDataFunc sets a function to collect custom application data
func (c *Collector) SetCustomDataFunc(fn func() map[string]any) {
    c.customDataFn = fn
}

// Collect gathers a complete debug snapshot
func (c *Collector) Collect(ctx context.Context, includeProfiles bool) (*Snapshot, error) {
    start := time.Now()
    defer func() {
        collectionDuration.WithLabelValues("full").Observe(time.Since(start).Seconds())
    }()

    snapshot := &Snapshot{
        ID:          fmt.Sprintf("%d-%s", time.Now().UnixNano(), c.hostname),
        Timestamp:   time.Now(),
        Hostname:    c.hostname,
        Version:     c.version,
        Environment: c.collectEnvironment(),
        Profiles:    make(map[string][]byte),
    }

    // Collect runtime info
    snapshot.Runtime = c.collectRuntimeInfo()

    // Collect memory info
    snapshot.Memory = c.collectMemoryInfo()

    // Collect GC info
    snapshot.GC = c.collectGCInfo()

    // Collect goroutine info
    snapshot.Goroutines = c.CollectGoroutineInfo(true)

    // Collect profiles if requested
    if includeProfiles {
        if err := c.collectProfiles(ctx, snapshot); err != nil {
            collectionsTotal.WithLabelValues("profiles", "error").Inc()
            return nil, fmt.Errorf("collecting profiles: %w", err)
        }
    }

    // Collect custom data
    if c.customDataFn != nil {
        snapshot.CustomData = c.customDataFn()
    }

    c.mu.Lock()
    c.lastSnapshot = snapshot
    c.mu.Unlock()

    collectionsTotal.WithLabelValues("full", "success").Inc()
    return snapshot, nil
}

func (c *Collector) collectRuntimeInfo() RuntimeInfo {
    return RuntimeInfo{
        Version:      runtime.Version(),
        GOOS:         runtime.GOOS,
        GOARCH:       runtime.GOARCH,
        NumCPU:       runtime.NumCPU(),
        GOMAXPROCS:   runtime.GOMAXPROCS(0),
        NumGoroutine: runtime.NumGoroutine(),
        NumCgoCall:   runtime.NumCgoCall(),
    }
}

func (c *Collector) collectMemoryInfo() MemoryInfo {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    return MemoryInfo{
        Alloc:        m.Alloc,
        TotalAlloc:   m.TotalAlloc,
        Sys:          m.Sys,
        HeapAlloc:    m.HeapAlloc,
        HeapSys:      m.HeapSys,
        HeapIdle:     m.HeapIdle,
        HeapInuse:    m.HeapInuse,
        HeapReleased: m.HeapReleased,
        HeapObjects:  m.HeapObjects,
        StackInuse:   m.StackInuse,
        StackSys:     m.StackSys,
        MSpanInuse:   m.MSpanInuse,
        MCacheInuse:  m.MCacheInuse,
        BuckHashSys:  m.BuckHashSys,
        GCSys:        m.GCSys,
        OtherSys:     m.OtherSys,
    }
}

func (c *Collector) collectGCInfo() GCInfo {
    var gcStats debug.GCStats
    debug.ReadGCStats(&gcStats)

    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    info := GCInfo{
        NumGC:         m.NumGC,
        NumForcedGC:   m.NumForcedGC,
        GCCPUFraction: m.GCCPUFraction,
        LastGC:        time.Unix(0, int64(m.LastGC)),
        NextGC:        m.NextGC,
        PauseTotalNs:  m.PauseTotalNs,
    }

    if m.NumGC > 0 {
        info.PauseAvgNs = m.PauseTotalNs / uint64(m.NumGC)
    }

    // Get recent pauses
    recentPauses := make([]uint64, 0, 10)
    for i := 0; i < 10 && i < int(m.NumGC); i++ {
        pause := m.PauseNs[(int(m.NumGC)-1-i+256)%256]
        recentPauses = append(recentPauses, pause)
        if pause > info.PauseMaxNs {
            info.PauseMaxNs = pause
        }
    }
    info.RecentPausesNs = recentPauses

    return info
}

// CollectGoroutineInfo returns goroutine counts broken down by state and by
// function. Exported so the debug server can serve /debug/goroutines from it
// rather than keeping a second, divergent copy of the parsing logic.
func (c *Collector) CollectGoroutineInfo(includeDump bool) GoroutineInfo {
    info := GoroutineInfo{
        Total:      runtime.NumGoroutine(),
        ByState:    make(map[string]int),
        ByFunction: make(map[string]int),
    }

    // Get goroutine dump, growing until it fits. A fixed 1MB buffer
    // silently truncates on any service with a few thousand goroutines,
    // and a truncated dump quietly skews every count computed below.
    // Cap at 64MB, which is what the standard library settles for.
    var dump string
    for size := 1 << 20; ; size *= 2 {
        buf := make([]byte, size)
        n := runtime.Stack(buf, true)
        if n < len(buf) || size >= 64<<20 {
            dump = string(buf[:n])
            break
        }
    }

    if includeDump {
        info.Dump = dump
    }

    // Parse dump for statistics
    c.parseGoroutineDump(dump, &info)

    return info
}

func (c *Collector) parseGoroutineDump(dump string, info *GoroutineInfo) {
    // Simple parsing of goroutine states
    lines := bytes.Split([]byte(dump), []byte("\n"))

    for _, line := range lines {
        lineStr := string(line)

        // Parse goroutine header: goroutine N [state]:
        if bytes.HasPrefix(line, []byte("goroutine ")) {
            // Extract state between [ and ]
            start := bytes.Index(line, []byte("["))
            end := bytes.Index(line, []byte("]"))
            if start != -1 && end != -1 && end > start {
                state := string(line[start+1 : end])

                // Clean up state (remove timing info)
                if idx := bytes.Index([]byte(state), []byte(",")); idx != -1 {
                    state = state[:idx]
                }

                info.ByState[state]++

                switch {
                case state == "running" || state == "runnable":
                    info.Running++
                case bytes.Contains([]byte(state), []byte("select")),
                     bytes.Contains([]byte(state), []byte("chan receive")),
                     bytes.Contains([]byte(state), []byte("chan send")),
                     bytes.Contains([]byte(state), []byte("sleep")),
                     bytes.Contains([]byte(state), []byte("IO wait")):
                    info.Waiting++
                case bytes.Contains([]byte(state), []byte("sync")),
                     bytes.Contains([]byte(state), []byte("lock")),
                     bytes.Contains([]byte(state), []byte("semacquire")):
                    info.Blocked++
                default:
                    info.Waiting++
                }
            }
        }

        // Count every function frame appearing in any stack. Note this is
        // a frame census, not a top-of-stack census: a function that appears
        // ten frames deep in one goroutine counts the same as one that is
        // actually parked. For leak hunting you usually want the top frame
        // only, which means tracking whether this is the first frame since
        // the last goroutine header.
        if bytes.Contains(line, []byte(".go:")) {
            // A file:line reference, not a function name.
            continue
        }
        if bytes.Contains(line, []byte("(")) && !bytes.HasPrefix(line, []byte("\t")) {
            funcName := lineStr
            if idx := bytes.Index(line, []byte("(")); idx != -1 {
                funcName = string(line[:idx])
            }
            if funcName != "" {
                info.ByFunction[funcName]++
            }
        }
    }
}

func (c *Collector) collectProfiles(ctx context.Context, snapshot *Snapshot) error {
    // Heap profile
    var heapBuf bytes.Buffer
    if err := pprof.WriteHeapProfile(&heapBuf); err != nil {
        return fmt.Errorf("heap profile: %w", err)
    }
    snapshot.Profiles["heap"] = heapBuf.Bytes()

    // Goroutine profile
    var goroutineBuf bytes.Buffer
    if profile := pprof.Lookup("goroutine"); profile != nil {
        if err := profile.WriteTo(&goroutineBuf, 0); err != nil {
            return fmt.Errorf("goroutine profile: %w", err)
        }
        snapshot.Profiles["goroutine"] = goroutineBuf.Bytes()
    }

    // Allocs profile
    var allocsBuf bytes.Buffer
    if profile := pprof.Lookup("allocs"); profile != nil {
        if err := profile.WriteTo(&allocsBuf, 0); err != nil {
            return fmt.Errorf("allocs profile: %w", err)
        }
        snapshot.Profiles["allocs"] = allocsBuf.Bytes()
    }

    // Block profile
    var blockBuf bytes.Buffer
    if profile := pprof.Lookup("block"); profile != nil {
        if err := profile.WriteTo(&blockBuf, 0); err != nil {
            return fmt.Errorf("block profile: %w", err)
        }
        snapshot.Profiles["block"] = blockBuf.Bytes()
    }

    // Mutex profile
    var mutexBuf bytes.Buffer
    if profile := pprof.Lookup("mutex"); profile != nil {
        if err := profile.WriteTo(&mutexBuf, 0); err != nil {
            return fmt.Errorf("mutex profile: %w", err)
        }
        snapshot.Profiles["mutex"] = mutexBuf.Bytes()
    }

    // Threadcreate profile
    var threadBuf bytes.Buffer
    if profile := pprof.Lookup("threadcreate"); profile != nil {
        if err := profile.WriteTo(&threadBuf, 0); err != nil {
            return fmt.Errorf("threadcreate profile: %w", err)
        }
        snapshot.Profiles["threadcreate"] = threadBuf.Bytes()
    }

    return nil
}

func (c *Collector) collectEnvironment() map[string]string {
    // Collect relevant environment variables (safe ones only)
    safeVars := []string{
        "GOMAXPROCS",
        "GOGC",
        "GOMEMLIMIT",
        "GODEBUG",
        "GOTRACEBACK",
        "GORACE",
        "SERVICE_NAME",
        "SERVICE_VERSION",
        "ENVIRONMENT",
        "HOSTNAME",
        "POD_NAME",
        "POD_NAMESPACE",
        "NODE_NAME",
    }

    env := make(map[string]string)
    for _, v := range safeVars {
        if val := os.Getenv(v); val != "" {
            env[v] = val
        }
    }
    return env
}

// GetLastSnapshot returns the most recent snapshot
func (c *Collector) GetLastSnapshot() *Snapshot {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.lastSnapshot
}

// CollectFromRemote gathers debug info from a remote service
func (c *Collector) CollectFromRemote(ctx context.Context, baseURL string) (*Snapshot, error) {
    start := time.Now()
    defer func() {
        collectionDuration.WithLabelValues("remote").Observe(time.Since(start).Seconds())
    }()

    client := &http.Client{Timeout: 30 * time.Second}

    // Fetch debug info endpoint
    req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/debug/info", nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }

    resp, err := client.Do(req)
    if err != nil {
        collectionsTotal.WithLabelValues("remote", "error").Inc()
        return nil, fmt.Errorf("fetching debug info: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        collectionsTotal.WithLabelValues("remote", "error").Inc()
        return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
    }

    var snapshot Snapshot
    if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }

    collectionsTotal.WithLabelValues("remote", "success").Inc()
    return &snapshot, nil
}

// CollectProfileFromRemote fetches a specific profile from remote service
func (c *Collector) CollectProfileFromRemote(ctx context.Context, baseURL, profileType string, duration time.Duration) ([]byte, error) {
    client := &http.Client{Timeout: duration + 10*time.Second}

    url := fmt.Sprintf("%s/debug/pprof/%s", baseURL, profileType)
    if duration > 0 {
        url = fmt.Sprintf("%s?seconds=%d", url, int(duration.Seconds()))
    }

    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }

    resp, err := client.Do(req)
    if err != nil {
        return nil, fmt.Errorf("fetching profile: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
    }

    return io.ReadAll(resp.Body)
}
```

### pkg/analyzer/analyzer.go - Debug Data Analyzer

The `Analyzer` applies a set of configurable thresholds to a `Snapshot` and produces a list of typed, severity-tagged `Issue` values covering memory (heap allocation, object count, fragmentation), goroutines (count, blocked ratio), and GC (pause time, CPU fraction). A `calculateSummary` method converts the issue list into a 0-100 health score, each critical issue deducts 25 points, each warning 10, and produces human-readable status labels per subsystem. The `Compare` method enables trend analysis by diffing two snapshots across key metrics, surfacing growth rates that could indicate slow leaks invisible in a single snapshot.

```go
// Package analyzer provides analysis capabilities for debug data
package analyzer

import (
    "context"
    "fmt"
    "regexp"
    "time"

    "debug-toolkit/pkg/collector"
)

// Issue represents a detected problem
type Issue struct {
    ID          string    `json:"id"`
    Severity    string    `json:"severity"` // critical, warning, info
    Category    string    `json:"category"`
    Title       string    `json:"title"`
    Description string    `json:"description"`
    Evidence    string    `json:"evidence,omitempty"`
    Suggestion  string    `json:"suggestion,omitempty"`
    Timestamp   time.Time `json:"timestamp"`
}

// AnalysisResult contains the complete analysis output
type AnalysisResult struct {
    SnapshotID    string         `json:"snapshot_id"`
    Timestamp     time.Time      `json:"timestamp"`
    Issues        []Issue        `json:"issues"`
    Summary       AnalysisSummary `json:"summary"`
    Comparisons   []Comparison   `json:"comparisons,omitempty"`
}

// AnalysisSummary provides high-level analysis statistics
type AnalysisSummary struct {
    HealthScore      int    `json:"health_score"`       // 0-100
    CriticalIssues   int    `json:"critical_issues"`
    WarningIssues    int    `json:"warning_issues"`
    InfoIssues       int    `json:"info_issues"`
    MemoryStatus     string `json:"memory_status"`
    GoroutineStatus  string `json:"goroutine_status"`
    GCStatus         string `json:"gc_status"`
    OverallStatus    string `json:"overall_status"`
}

// Comparison shows differences between snapshots
type Comparison struct {
    Metric     string  `json:"metric"`
    Previous   float64 `json:"previous"`
    Current    float64 `json:"current"`
    Change     float64 `json:"change"`
    ChangePerc float64 `json:"change_percentage"`
    Trend      string  `json:"trend"` // up, down, stable
}

// Analyzer analyzes debug snapshots for issues
type Analyzer struct {
    thresholds AnalysisThresholds
}

// AnalysisThresholds configures when to raise issues
type AnalysisThresholds struct {
    // Memory thresholds
    HeapAllocWarning       uint64  // Bytes
    HeapAllocCritical      uint64  // Bytes
    HeapObjectsWarning     uint64  // Count
    HeapObjectsCritical    uint64  // Count
    MemoryGrowthRateWarn   float64 // Percentage per hour

    // Goroutine thresholds
    GoroutineCountWarning  int
    GoroutineCountCritical int
    BlockedRatioWarning    float64 // Percentage
    BlockedRatioCritical   float64 // Percentage

    // GC thresholds
    GCPauseWarningNs       uint64  // Nanoseconds
    GCPauseCriticalNs      uint64  // Nanoseconds
    GCCPUFractionWarning   float64 // Percentage
    GCCPUFractionCritical  float64 // Percentage
}

// DefaultThresholds returns sensible default thresholds
func DefaultThresholds() AnalysisThresholds {
    return AnalysisThresholds{
        HeapAllocWarning:       1 * 1024 * 1024 * 1024, // 1GB
        HeapAllocCritical:      4 * 1024 * 1024 * 1024, // 4GB
        HeapObjectsWarning:     10_000_000,
        HeapObjectsCritical:    50_000_000,
        MemoryGrowthRateWarn:   0.1, // 10% per hour

        GoroutineCountWarning:  10_000,
        GoroutineCountCritical: 100_000,
        BlockedRatioWarning:    0.1,  // 10% blocked
        BlockedRatioCritical:   0.25, // 25% blocked

        GCPauseWarningNs:      10_000_000,  // 10ms
        GCPauseCriticalNs:     100_000_000, // 100ms
        GCCPUFractionWarning:  0.05,        // 5%
        GCCPUFractionCritical: 0.25,        // 25%
    }
}

// NewAnalyzer creates a new analyzer with default thresholds
func NewAnalyzer() *Analyzer {
    return &Analyzer{
        thresholds: DefaultThresholds(),
    }
}

// NewAnalyzerWithThresholds creates an analyzer with custom thresholds
func NewAnalyzerWithThresholds(t AnalysisThresholds) *Analyzer {
    return &Analyzer{thresholds: t}
}

// Analyze performs comprehensive analysis on a snapshot
func (a *Analyzer) Analyze(ctx context.Context, snapshot *collector.Snapshot) (*AnalysisResult, error) {
    result := &AnalysisResult{
        SnapshotID: snapshot.ID,
        Timestamp:  time.Now(),
        Issues:     make([]Issue, 0),
    }

    // Analyze memory
    a.analyzeMemory(snapshot, result)

    // Analyze goroutines
    a.analyzeGoroutines(snapshot, result)

    // Analyze GC
    a.analyzeGC(snapshot, result)

    // Analyze goroutine dump for patterns
    a.analyzeGoroutineDump(snapshot, result)

    // Calculate summary
    result.Summary = a.calculateSummary(result)

    return result, nil
}

func (a *Analyzer) analyzeMemory(snapshot *collector.Snapshot, result *AnalysisResult) {
    mem := snapshot.Memory

    // Check heap allocation
    if mem.HeapAlloc > a.thresholds.HeapAllocCritical {
        result.Issues = append(result.Issues, Issue{
            ID:          fmt.Sprintf("mem-heap-critical-%d", time.Now().UnixNano()),
            Severity:    "critical",
            Category:    "memory",
            Title:       "Critical heap memory usage",
            Description: fmt.Sprintf("Heap allocation is %s, exceeding critical threshold of %s",
                formatBytes(mem.HeapAlloc), formatBytes(a.thresholds.HeapAllocCritical)),
            Suggestion:  "Investigate memory usage with heap profile. Check for memory leaks or unbounded caches.",
            Timestamp:   time.Now(),
        })
    } else if mem.HeapAlloc > a.thresholds.HeapAllocWarning {
        result.Issues = append(result.Issues, Issue{
            ID:          fmt.Sprintf("mem-heap-warning-%d", time.Now().UnixNano()),
            Severity:    "warning",
            Category:    "memory",
            Title:       "High heap memory usage",
            Description: fmt.Sprintf("Heap allocation is %s", formatBytes(mem.HeapAlloc)),
            Suggestion:  "Monitor memory growth and consider reviewing allocation patterns.",
            Timestamp:   time.Now(),
        })
    }

    // Check heap objects
    if mem.HeapObjects > a.thresholds.HeapObjectsCritical {
        result.Issues = append(result.Issues, Issue{
            ID:          fmt.Sprintf("mem-objects-critical-%d", time.Now().UnixNano()),
            Severity:    "critical",
            Category:    "memory",
            Title:       "Critical number of heap objects",
            Description: fmt.Sprintf("Heap has %d objects, exceeding critical threshold of %d",
                mem.HeapObjects, a.thresholds.HeapObjectsCritical),
            Suggestion:  "High object count causes GC pressure. Review allocation patterns and consider object pooling.",
            Timestamp:   time.Now(),
        })
    }

    // Check for potential memory leak (high idle heap)
    if mem.HeapIdle > 0 && mem.HeapInuse > 0 {
        idleRatio := float64(mem.HeapIdle) / float64(mem.HeapSys)
        if idleRatio > 0.5 && mem.HeapReleased < mem.HeapIdle/2 {
            result.Issues = append(result.Issues, Issue{
                ID:          fmt.Sprintf("mem-fragmentation-%d", time.Now().UnixNano()),
                Severity:    "warning",
                Category:    "memory",
                Title:       "Possible memory fragmentation",
                Description: fmt.Sprintf("%.1f%% of heap is idle but not released to OS", idleRatio*100),
                Evidence:    fmt.Sprintf("HeapIdle: %s, HeapReleased: %s", formatBytes(mem.HeapIdle), formatBytes(mem.HeapReleased)),
                Suggestion:  "Consider calling debug.FreeOSMemory() during low-traffic periods or reviewing GOGC settings.",
                Timestamp:   time.Now(),
            })
        }
    }
}

func (a *Analyzer) analyzeGoroutines(snapshot *collector.Snapshot, result *AnalysisResult) {
    gr := snapshot.Goroutines

    // Check goroutine count
    if gr.Total > a.thresholds.GoroutineCountCritical {
        result.Issues = append(result.Issues, Issue{
            ID:          fmt.Sprintf("gr-count-critical-%d", time.Now().UnixNano()),
            Severity:    "critical",
            Category:    "goroutines",
            Title:       "Critical goroutine count",
            Description: fmt.Sprintf("Running %d goroutines, exceeding critical threshold of %d",
                gr.Total, a.thresholds.GoroutineCountCritical),
            Suggestion:  "Investigate goroutine dump for leaks. Check for missing context cancellation or unbounded concurrency.",
            Timestamp:   time.Now(),
        })
    } else if gr.Total > a.thresholds.GoroutineCountWarning {
        result.Issues = append(result.Issues, Issue{
            ID:          fmt.Sprintf("gr-count-warning-%d", time.Now().UnixNano()),
            Severity:    "warning",
            Category:    "goroutines",
            Title:       "High goroutine count",
            Description: fmt.Sprintf("Running %d goroutines", gr.Total),
            Suggestion:  "Monitor goroutine growth over time. Consider implementing worker pools.",
            Timestamp:   time.Now(),
        })
    }

    // Check blocked ratio
    if gr.Total > 0 {
        blockedRatio := float64(gr.Blocked) / float64(gr.Total)
        if blockedRatio > a.thresholds.BlockedRatioCritical {
            result.Issues = append(result.Issues, Issue{
                ID:          fmt.Sprintf("gr-blocked-critical-%d", time.Now().UnixNano()),
                Severity:    "critical",
                Category:    "goroutines",
                Title:       "Critical number of blocked goroutines",
                Description: fmt.Sprintf("%.1f%% of goroutines are blocked (%d/%d)",
                    blockedRatio*100, gr.Blocked, gr.Total),
                Suggestion:  "Check for deadlocks, mutex contention, or blocking I/O operations.",
                Timestamp:   time.Now(),
            })
        } else if blockedRatio > a.thresholds.BlockedRatioWarning {
            result.Issues = append(result.Issues, Issue{
                ID:          fmt.Sprintf("gr-blocked-warning-%d", time.Now().UnixNano()),
                Severity:    "warning",
                Category:    "goroutines",
                Title:       "High number of blocked goroutines",
                Description: fmt.Sprintf("%.1f%% of goroutines are blocked", blockedRatio*100),
                Suggestion:  "Review blocking operations and consider async alternatives.",
                Timestamp:   time.Now(),
            })
        }
    }
}

func (a *Analyzer) analyzeGC(snapshot *collector.Snapshot, result *AnalysisResult) {
    gc := snapshot.GC

    // Check GC pause times
    for _, pause := range gc.RecentPausesNs {
        if pause > a.thresholds.GCPauseCriticalNs {
            result.Issues = append(result.Issues, Issue{
                ID:          fmt.Sprintf("gc-pause-critical-%d", time.Now().UnixNano()),
                Severity:    "critical",
                Category:    "gc",
                Title:       "Critical GC pause time",
                Description: fmt.Sprintf("GC pause of %s detected, exceeding critical threshold of %s",
                    formatDuration(pause), formatDuration(a.thresholds.GCPauseCriticalNs)),
                Suggestion:  "Review heap size and GOGC settings. Consider reducing allocation rate.",
                Timestamp:   time.Now(),
            })
            break // Only report once
        } else if pause > a.thresholds.GCPauseWarningNs {
            result.Issues = append(result.Issues, Issue{
                ID:          fmt.Sprintf("gc-pause-warning-%d", time.Now().UnixNano()),
                Severity:    "warning",
                Category:    "gc",
                Title:       "High GC pause time",
                Description: fmt.Sprintf("GC pause of %s detected", formatDuration(pause)),
                Suggestion:  "Monitor GC behavior and consider tuning GOGC or GOMEMLIMIT.",
                Timestamp:   time.Now(),
            })
            break
        }
    }

    // Check GC CPU fraction
    if gc.GCCPUFraction > a.thresholds.GCCPUFractionCritical {
        result.Issues = append(result.Issues, Issue{
            ID:          fmt.Sprintf("gc-cpu-critical-%d", time.Now().UnixNano()),
            Severity:    "critical",
            Category:    "gc",
            Title:       "Critical GC CPU usage",
            Description: fmt.Sprintf("GC consuming %.1f%% of CPU, exceeding critical threshold of %.1f%%",
                gc.GCCPUFraction*100, a.thresholds.GCCPUFractionCritical*100),
            Suggestion:  "Application is spending too much time in GC. Reduce allocation rate or increase GOGC.",
            Timestamp:   time.Now(),
        })
    } else if gc.GCCPUFraction > a.thresholds.GCCPUFractionWarning {
        result.Issues = append(result.Issues, Issue{
            ID:          fmt.Sprintf("gc-cpu-warning-%d", time.Now().UnixNano()),
            Severity:    "warning",
            Category:    "gc",
            Title:       "High GC CPU usage",
            Description: fmt.Sprintf("GC consuming %.1f%% of CPU", gc.GCCPUFraction*100),
            Suggestion:  "Consider optimizing allocation patterns or adjusting GOGC.",
            Timestamp:   time.Now(),
        })
    }
}

func (a *Analyzer) analyzeGoroutineDump(snapshot *collector.Snapshot, result *AnalysisResult) {
    dump := snapshot.Goroutines.Dump
    if dump == "" {
        return
    }

    // Look for common problematic patterns
    patterns := []struct {
        regex       *regexp.Regexp
        severity    string
        title       string
        description string
        suggestion  string
    }{
        {
            regexp.MustCompile(`(?m)goroutine \d+ \[sync\.Mutex\.Lock[^]]*\]:`),
            "warning",
            "Goroutines waiting on mutex",
            "Multiple goroutines are waiting to acquire a mutex",
            "Review lock contention and consider using sync.RWMutex or reducing critical section size",
        },
        {
            regexp.MustCompile(`(?m)goroutine \d+ \[semacquire[^]]*\]:`),
            "warning",
            "Goroutines waiting on semaphore",
            "Multiple goroutines are blocked on semaphore acquisition",
            "Check for channel capacity issues or sync.WaitGroup misuse",
        },
        {
            regexp.MustCompile(`(?m)goroutine \d+ \[chan send[^]]*\]:`),
            "info",
            "Goroutines blocked on channel send",
            "Goroutines are waiting to send on full channels",
            "Consider increasing channel buffer or adding more consumers",
        },
        {
            regexp.MustCompile(`(?m)goroutine \d+ \[chan receive[^]]*\]:`),
            "info",
            "Goroutines blocked on channel receive",
            "Goroutines are waiting to receive from empty channels",
            "Ensure producers are running and not deadlocked",
        },
        {
            regexp.MustCompile(`(?m)net/http\..*ServeHTTP`),
            "info",
            "HTTP handlers in flight",
            "Multiple HTTP requests are being processed",
            "Normal during load, but check if count seems excessive",
        },
        {
            // Real frames read `database/sql.(*DB).conn(...)`, so the
            // parentheses must be escaped and matched. Writing this as
            // `database/sql\.\*DB\.conn` escapes the dot and the star into
            // literals and produces a pattern that only ever matches the
            // text "database/sql.*DB.conn", which appears in no stack
            // trace ever produced. The rule never fires and the silence
            // reads exactly like "no database contention".
            regexp.MustCompile(`(?m)database/sql\.\(\*DB\)\.conn`),
            "info",
            "Database connection operations",
            "Goroutines are waiting for database connections",
            "Check connection pool size and database latency",
        },
    }

    for _, p := range patterns {
        matches := p.regex.FindAllString(dump, -1)
        if len(matches) > 5 { // Only report if multiple occurrences
            result.Issues = append(result.Issues, Issue{
                ID:          fmt.Sprintf("dump-pattern-%d", time.Now().UnixNano()),
                Severity:    p.severity,
                Category:    "goroutines",
                Title:       p.title,
                Description: fmt.Sprintf("%s (%d occurrences)", p.description, len(matches)),
                Suggestion:  p.suggestion,
                Timestamp:   time.Now(),
            })
        }
    }

    // Check for potential deadlock (same goroutines stuck for multiple snapshots)
    // This would require comparing with previous snapshots
}

func (a *Analyzer) calculateSummary(result *AnalysisResult) AnalysisSummary {
    summary := AnalysisSummary{
        HealthScore: 100,
    }

    for _, issue := range result.Issues {
        switch issue.Severity {
        case "critical":
            summary.CriticalIssues++
            summary.HealthScore -= 25
        case "warning":
            summary.WarningIssues++
            summary.HealthScore -= 10
        case "info":
            summary.InfoIssues++
            summary.HealthScore -= 2
        }
    }

    if summary.HealthScore < 0 {
        summary.HealthScore = 0
    }

    // Determine status strings
    summary.OverallStatus = a.getStatusFromScore(summary.HealthScore)
    summary.MemoryStatus = a.getCategoryStatus(result.Issues, "memory")
    summary.GoroutineStatus = a.getCategoryStatus(result.Issues, "goroutines")
    summary.GCStatus = a.getCategoryStatus(result.Issues, "gc")

    return summary
}

func (a *Analyzer) getStatusFromScore(score int) string {
    switch {
    case score >= 90:
        return "healthy"
    case score >= 70:
        return "degraded"
    case score >= 50:
        return "unhealthy"
    default:
        return "critical"
    }
}

func (a *Analyzer) getCategoryStatus(issues []Issue, category string) string {
    hasCritical := false
    hasWarning := false

    for _, issue := range issues {
        if issue.Category == category {
            if issue.Severity == "critical" {
                hasCritical = true
            } else if issue.Severity == "warning" {
                hasWarning = true
            }
        }
    }

    if hasCritical {
        return "critical"
    } else if hasWarning {
        return "warning"
    }
    return "healthy"
}

// Compare analyzes differences between two snapshots
func (a *Analyzer) Compare(baseline, current *collector.Snapshot) []Comparison {
    comparisons := make([]Comparison, 0)

    // Memory comparisons
    comparisons = append(comparisons, a.compareMetric(
        "heap_alloc",
        float64(baseline.Memory.HeapAlloc),
        float64(current.Memory.HeapAlloc),
    ))

    comparisons = append(comparisons, a.compareMetric(
        "heap_objects",
        float64(baseline.Memory.HeapObjects),
        float64(current.Memory.HeapObjects),
    ))

    // Goroutine comparisons
    comparisons = append(comparisons, a.compareMetric(
        "goroutine_count",
        float64(baseline.Goroutines.Total),
        float64(current.Goroutines.Total),
    ))

    // GC comparisons
    comparisons = append(comparisons, a.compareMetric(
        "gc_count",
        float64(baseline.GC.NumGC),
        float64(current.GC.NumGC),
    ))

    comparisons = append(comparisons, a.compareMetric(
        "gc_pause_avg_ns",
        float64(baseline.GC.PauseAvgNs),
        float64(current.GC.PauseAvgNs),
    ))

    return comparisons
}

func (a *Analyzer) compareMetric(name string, prev, curr float64) Comparison {
    change := curr - prev
    changePerc := 0.0
    if prev != 0 {
        changePerc = (change / prev) * 100
    }

    trend := "stable"
    if changePerc > 5 {
        trend = "up"
    } else if changePerc < -5 {
        trend = "down"
    }

    return Comparison{
        Metric:     name,
        Previous:   prev,
        Current:    curr,
        Change:     change,
        ChangePerc: changePerc,
        Trend:      trend,
    }
}

// Helper functions

func formatBytes(b uint64) string {
    const unit = 1024
    if b < unit {
        return fmt.Sprintf("%d B", b)
    }
    div, exp := uint64(unit), 0
    for n := b / unit; n >= unit; n /= unit {
        div *= unit
        exp++
    }
    return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func formatDuration(ns uint64) string {
    d := time.Duration(ns)
    if d < time.Microsecond {
        return fmt.Sprintf("%dns", ns)
    } else if d < time.Millisecond {
        return fmt.Sprintf("%.1fµs", float64(ns)/1000)
    } else if d < time.Second {
        return fmt.Sprintf("%.1fms", float64(ns)/1000000)
    }
    return fmt.Sprintf("%.2fs", float64(ns)/1000000000)
}
```

### pkg/detector/detector.go - Issue Detectors

The `Detector` runs two independent background loops: a main loop that samples goroutine count and heap allocation every `CheckInterval`, computing growth rates over a sliding window to detect gradual leaks that absolute thresholds would miss. And a deadlock detector that compares the set of goroutines parked on synchronisation and raises a critical alert if that set is unchanged for longer than `DeadlockStuckDuration`. An `AlertCooldown` mechanism prevents repeated firing of the same alert type, keeping operator notification channels free of noise during sustained incidents.

Two things in this component are worth studying beyond what it detects, because both are mistakes that survive review easily.

The first is the comparison itself. It is tempting to hash or string-compare the whole goroutine dump and call an unchanged dump a deadlock. That does not work: consecutive dumps of a genuinely deadlocked process are never byte-identical, so the detector never fires and its silence is indistinguishable from health. The normalised signature exists for that reason.

The second is the locking. `raiseAlert` mutates two maps and takes no lock of its own, relying on callers to hold `d.mu`. That is a legitimate design, but it makes the precondition invisible at the call site, and the two loops here call it from different goroutines. Miss the lock in one branch and `go test -race` reports a data race, while production reports `fatal error: concurrent map writes` and dies, because a concurrent map write is a runtime throw that `recover` cannot catch. A component whose entire job is to watch the process must never be able to take the process down. If you would rather not carry an undocumented precondition, give `raiseAlert` its own lock and have callers snapshot what they need before releasing theirs.

```go
// Package detector provides real-time issue detection
package detector

import (
    "context"
    "fmt"
    "log/slog"
    "regexp"
    "runtime"
    "slices"
    "strings"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    detectionsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "debug_detections_total",
            Help: "Total issues detected",
        },
        []string{"type", "severity"},
    )

    currentGoroutines = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "debug_goroutines_current",
            Help: "Current number of goroutines",
        },
    )

    currentHeapBytes = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "debug_heap_bytes_current",
            Help: "Current heap allocation in bytes",
        },
    )
)

// Alert represents a detected issue alert
type Alert struct {
    ID          string            `json:"id"`
    Type        string            `json:"type"`
    Severity    string            `json:"severity"`
    Message     string            `json:"message"`
    Details     map[string]any    `json:"details"`
    Timestamp   time.Time         `json:"timestamp"`
    Resolved    bool              `json:"resolved"`
    ResolvedAt  *time.Time        `json:"resolved_at,omitempty"`
}

// AlertHandler processes alerts
type AlertHandler func(alert *Alert)

// DetectorConfig configures the detector
type DetectorConfig struct {
    // Goroutine leak detection
    GoroutineLeakEnabled     bool
    GoroutineLeakThreshold   int
    GoroutineLeakWindow      time.Duration
    GoroutineGrowthRate      float64 // Max growth rate per window

    // Memory leak detection
    MemoryLeakEnabled        bool
    MemoryLeakThreshold      uint64
    MemoryLeakWindow         time.Duration
    MemoryGrowthRate         float64 // Max growth rate per window

    // Deadlock detection
    DeadlockEnabled          bool
    DeadlockCheckInterval    time.Duration
    DeadlockStuckDuration    time.Duration

    // GC pressure detection
    GCPressureEnabled        bool
    GCPauseThreshold         time.Duration
    GCCPUThreshold           float64

    // General settings
    CheckInterval            time.Duration
    AlertCooldown            time.Duration
}

// DefaultDetectorConfig returns sensible defaults
func DefaultDetectorConfig() DetectorConfig {
    return DetectorConfig{
        GoroutineLeakEnabled:   true,
        GoroutineLeakThreshold: 10000,
        GoroutineLeakWindow:    5 * time.Minute,
        GoroutineGrowthRate:    0.5, // 50% growth

        MemoryLeakEnabled:      true,
        MemoryLeakThreshold:    2 * 1024 * 1024 * 1024, // 2GB
        MemoryLeakWindow:       10 * time.Minute,
        MemoryGrowthRate:       0.3, // 30% growth

        DeadlockEnabled:        true,
        DeadlockCheckInterval:  30 * time.Second,
        DeadlockStuckDuration:  5 * time.Minute,

        GCPressureEnabled:      true,
        GCPauseThreshold:       50 * time.Millisecond,
        GCCPUThreshold:         0.15, // 15%

        CheckInterval:          10 * time.Second,
        AlertCooldown:          5 * time.Minute,
    }
}

// Detector monitors for runtime issues
type Detector struct {
    logger        *slog.Logger
    config        DetectorConfig
    handler       AlertHandler

    // State tracking. Everything below is guarded by mu, including from
    // raiseAlert, which assumes the caller already holds it.
    mu               sync.RWMutex
    goroutineSamples []int
    memorySamples    []uint64
    lastAlerts       map[string]time.Time
    activeAlerts     map[string]*Alert
    lastBlockedSig   []string // normalised blocked set from the previous tick
    stuckSince       time.Time

    // Lifecycle
    stopCh        chan struct{}
    wg            sync.WaitGroup
}

// NewDetector creates a new issue detector
func NewDetector(logger *slog.Logger, config DetectorConfig, handler AlertHandler) *Detector {
    return &Detector{
        logger:           logger,
        config:           config,
        handler:          handler,
        goroutineSamples: make([]int, 0),
        memorySamples:    make([]uint64, 0),
        lastAlerts:       make(map[string]time.Time),
        activeAlerts:     make(map[string]*Alert),
        stopCh:           make(chan struct{}),
    }
}

// Start begins monitoring
func (d *Detector) Start(ctx context.Context) {
    d.wg.Add(1)
    go d.runMainLoop(ctx)

    if d.config.DeadlockEnabled {
        d.wg.Add(1)
        go d.runDeadlockDetector(ctx)
    }
}

// Stop terminates monitoring
func (d *Detector) Stop() {
    close(d.stopCh)
    d.wg.Wait()
}

func (d *Detector) runMainLoop(ctx context.Context) {
    defer d.wg.Done()

    ticker := time.NewTicker(d.config.CheckInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-d.stopCh:
            return
        case <-ticker.C:
            d.check()
        }
    }
}

func (d *Detector) check() {
    // Update metrics
    numGoroutine := runtime.NumGoroutine()
    currentGoroutines.Set(float64(numGoroutine))

    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    currentHeapBytes.Set(float64(m.HeapAlloc))

    // Check for goroutine leak
    if d.config.GoroutineLeakEnabled {
        d.checkGoroutineLeak(numGoroutine)
    }

    // Check for memory leak
    if d.config.MemoryLeakEnabled {
        d.checkMemoryLeak(m.HeapAlloc)
    }

    // Check GC pressure
    if d.config.GCPressureEnabled {
        d.checkGCPressure(&m)
    }
}

func (d *Detector) checkGoroutineLeak(count int) {
    d.mu.Lock()
    defer d.mu.Unlock()

    // Add sample
    d.goroutineSamples = append(d.goroutineSamples, count)

    // Keep only samples within window
    maxSamples := int(d.config.GoroutineLeakWindow / d.config.CheckInterval)
    if len(d.goroutineSamples) > maxSamples {
        d.goroutineSamples = d.goroutineSamples[len(d.goroutineSamples)-maxSamples:]
    }

    // Check absolute threshold
    if count > d.config.GoroutineLeakThreshold {
        d.raiseAlert("goroutine_count", "warning", fmt.Sprintf(
            "Goroutine count (%d) exceeds threshold (%d)",
            count, d.config.GoroutineLeakThreshold,
        ), map[string]any{
            "count":     count,
            "threshold": d.config.GoroutineLeakThreshold,
        })
    }

    // Check growth rate
    if len(d.goroutineSamples) >= 2 {
        first := d.goroutineSamples[0]
        last := d.goroutineSamples[len(d.goroutineSamples)-1]
        if first > 0 {
            growthRate := float64(last-first) / float64(first)
            if growthRate > d.config.GoroutineGrowthRate {
                d.raiseAlert("goroutine_leak", "critical", fmt.Sprintf(
                    "Possible goroutine leak: %.1f%% growth in %v (from %d to %d)",
                    growthRate*100, d.config.GoroutineLeakWindow, first, last,
                ), map[string]any{
                    "growth_rate":  growthRate,
                    "start_count":  first,
                    "end_count":    last,
                    "window":       d.config.GoroutineLeakWindow.String(),
                })
            }
        }
    }
}

func (d *Detector) checkMemoryLeak(heapAlloc uint64) {
    d.mu.Lock()
    defer d.mu.Unlock()

    // Add sample
    d.memorySamples = append(d.memorySamples, heapAlloc)

    // Keep only samples within window
    maxSamples := int(d.config.MemoryLeakWindow / d.config.CheckInterval)
    if len(d.memorySamples) > maxSamples {
        d.memorySamples = d.memorySamples[len(d.memorySamples)-maxSamples:]
    }

    // Check absolute threshold
    if heapAlloc > d.config.MemoryLeakThreshold {
        d.raiseAlert("memory_usage", "warning", fmt.Sprintf(
            "Heap allocation (%s) exceeds threshold (%s)",
            formatBytes(heapAlloc), formatBytes(d.config.MemoryLeakThreshold),
        ), map[string]any{
            "heap_alloc_bytes": heapAlloc,
            "threshold_bytes":  d.config.MemoryLeakThreshold,
        })
    }

    // Check growth rate
    if len(d.memorySamples) >= 2 {
        first := d.memorySamples[0]
        last := d.memorySamples[len(d.memorySamples)-1]
        if first > 0 && last > first {
            growthRate := float64(last-first) / float64(first)
            if growthRate > d.config.MemoryGrowthRate {
                d.raiseAlert("memory_leak", "critical", fmt.Sprintf(
                    "Possible memory leak: %.1f%% growth in %v (from %s to %s)",
                    growthRate*100, d.config.MemoryLeakWindow,
                    formatBytes(first), formatBytes(last),
                ), map[string]any{
                    "growth_rate":    growthRate,
                    "start_bytes":    first,
                    "end_bytes":      last,
                    "window":         d.config.MemoryLeakWindow.String(),
                })
            }
        }
    }
}

func (d *Detector) checkGCPressure(m *runtime.MemStats) {
    // raiseAlert mutates d.lastAlerts and d.activeAlerts and does no
    // locking of its own, so every caller must hold d.mu. checkGoroutineLeak
    // and checkMemoryLeak do. Omitting it here races the deadlock detector
    // goroutine, which calls raiseAlert on its own ticker. `go test -race`
    // reports it immediately, and in production the failure mode is worse
    // than a wrong number: two goroutines writing one map is a runtime
    // throw, "fatal error: concurrent map writes", which no recover can
    // catch. A monitoring component must not be able to kill the process.
    d.mu.Lock()
    defer d.mu.Unlock()

    // Check GC CPU fraction
    if m.GCCPUFraction > d.config.GCCPUThreshold {
        d.raiseAlert("gc_cpu", "warning", fmt.Sprintf(
            "High GC CPU usage: %.1f%% (threshold: %.1f%%)",
            m.GCCPUFraction*100, d.config.GCCPUThreshold*100,
        ), map[string]any{
            "gc_cpu_fraction": m.GCCPUFraction,
            "threshold":       d.config.GCCPUThreshold,
        })
    }

    // Check recent pause times
    if m.NumGC > 0 {
        lastPause := time.Duration(m.PauseNs[(m.NumGC+255)%256])
        if lastPause > d.config.GCPauseThreshold {
            d.raiseAlert("gc_pause", "warning", fmt.Sprintf(
                "High GC pause time: %v (threshold: %v)",
                lastPause, d.config.GCPauseThreshold,
            ), map[string]any{
                "pause_duration": lastPause.String(),
                "threshold":      d.config.GCPauseThreshold.String(),
            })
        }
    }
}

func (d *Detector) runDeadlockDetector(ctx context.Context) {
    defer d.wg.Done()

    ticker := time.NewTicker(d.config.DeadlockCheckInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-d.stopCh:
            return
        case <-ticker.C:
            d.checkDeadlock()
        }
    }
}

func (d *Detector) checkDeadlock() {
    dump := goroutineDump()

    // Compare a normalised signature, never the raw dump. Two dumps of the
    // same permanently deadlocked process are not equal: the dump contains
    // the dumping goroutine's own stack, stack addresses, and the "N minutes"
    // annotation on parked goroutines, all of which change between calls.
    // Comparing whole dumps yields a detector that compiles, runs, costs a
    // stop-the-world on every tick, and never once fires.
    sig := blockedSignature(dump)

    d.mu.Lock()
    defer d.mu.Unlock()

    switch {
    case len(sig) == 0:
        d.stuckSince = time.Time{}

    case !slices.Equal(sig, d.lastBlockedSig):
        // Blocked set is churning, which is what a healthy service looks like.
        d.stuckSince = time.Time{}

    case d.stuckSince.IsZero():
        d.stuckSince = time.Now()

    case time.Since(d.stuckSince) > d.config.DeadlockStuckDuration:
        d.raiseAlert("deadlock", "critical", fmt.Sprintf(
            "Possible deadlock: %d goroutines blocked on the same primitives for %v",
            len(sig), time.Since(d.stuckSince),
        ), map[string]any{
            "stuck_duration": time.Since(d.stuckSince).String(),
            "blocked":        sig,
            "goroutine_dump": truncate(dump, 10000),
        })
    }

    d.lastBlockedSig = sig
}

// goroutineDump captures all goroutine stacks, growing the buffer until the
// dump fits. A fixed buffer truncates silently on a large service.
func goroutineDump() string {
    for size := 1 << 20; ; size *= 2 {
        buf := make([]byte, size)
        n := runtime.Stack(buf, true)
        if n < len(buf) || size >= 64<<20 {
            return string(buf[:n])
        }
    }
}

var goroutineHeaderRe = regexp.MustCompile(`^goroutine (\d+) \[([^,\]]+)(?:, (\d+) minutes)?\]:$`)

// States meaning "parked on synchronisation". Excludes IO wait and syscall,
// which are entirely normal for an idle but healthy server.
var blockedStates = map[string]bool{
    "chan receive":        true,
    "chan send":           true,
    "select":              true,
    "semacquire":          true,
    "sync.Mutex.Lock":     true,
    "sync.RWMutex.Lock":   true,
    "sync.RWMutex.RLock":  true,
    "sync.WaitGroup.Wait": true,
    "sync.Cond.Wait":      true,
}

// blockedSignature returns a sorted, stable "id:state" set for goroutines
// parked on synchronisation, with addresses and elapsed time excluded so
// that two snapshots of the same deadlock compare equal.
func blockedSignature(dump string) []string {
    var sig []string
    for _, line := range strings.Split(dump, "\n") {
        m := goroutineHeaderRe.FindStringSubmatch(line)
        if m == nil {
            continue
        }
        if blockedStates[m[2]] {
            sig = append(sig, m[1]+":"+m[2])
        }
    }
    slices.Sort(sig)
    return sig
}

// raiseAlert records an alert, subject to the per-type cooldown.
//
// PRECONDITION: the caller must hold d.mu. This method touches d.lastAlerts
// and d.activeAlerts without taking the lock itself, because its callers
// already hold it while inspecting sample windows and must not release it
// between the decision and the record.
func (d *Detector) raiseAlert(alertType, severity, message string, details map[string]any) {
    // Check cooldown
    alertKey := fmt.Sprintf("%s-%s", alertType, severity)
    if lastAlert, ok := d.lastAlerts[alertKey]; ok {
        if time.Since(lastAlert) < d.config.AlertCooldown {
            return
        }
    }

    alert := &Alert{
        ID:        fmt.Sprintf("%s-%d", alertType, time.Now().UnixNano()),
        Type:      alertType,
        Severity:  severity,
        Message:   message,
        Details:   details,
        Timestamp: time.Now(),
    }

    d.lastAlerts[alertKey] = time.Now()
    d.activeAlerts[alert.ID] = alert

    detectionsTotal.WithLabelValues(alertType, severity).Inc()

    d.logger.Warn("issue detected",
        "alert_id", alert.ID,
        "type", alertType,
        "severity", severity,
        "message", message,
    )

    if d.handler != nil {
        go d.handler(alert)
    }
}

// GetActiveAlerts returns currently active alerts
func (d *Detector) GetActiveAlerts() []*Alert {
    d.mu.RLock()
    defer d.mu.RUnlock()

    alerts := make([]*Alert, 0, len(d.activeAlerts))
    for _, alert := range d.activeAlerts {
        alerts = append(alerts, alert)
    }
    return alerts
}

// ResolveAlert marks an alert as resolved
func (d *Detector) ResolveAlert(alertID string) {
    d.mu.Lock()
    defer d.mu.Unlock()

    if alert, ok := d.activeAlerts[alertID]; ok {
        now := time.Now()
        alert.Resolved = true
        alert.ResolvedAt = &now
    }
}

func formatBytes(b uint64) string {
    const unit = 1024
    if b < unit {
        return fmt.Sprintf("%d B", b)
    }
    div, exp := uint64(unit), 0
    for n := b / unit; n >= unit; n /= unit {
        div *= unit
        exp++
    }
    return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func truncate(s string, maxLen int) string {
    if len(s) <= maxLen {
        return s
    }
    return s[:maxLen] + "... (truncated)"
}
```

### internal/server/server.go - Debug Server

The debug server registers both the standard `net/http/pprof` handler tree and a set of custom JSON endpoints, `/debug/info`, `/debug/analyze`, `/debug/goroutines`, `/debug/memory`, `/debug/history`, `/debug/compare`, and `/debug/alerts`, on a dedicated port so they are never reachable through the main application port. Snapshots are stored in a bounded ring buffer of `MaxSnapHistory` entries, enabling the `/debug/compare` endpoint to diff the oldest and most recent snapshots and expose long-running trends without unbounded memory growth.

```go
// Package server provides the debug HTTP server
package server

import (
    "context"
    "encoding/json"
    "log/slog"
    "net/http"
    "net/http/pprof"
    "runtime"
    "sync"
    "time"

    "debug-toolkit/pkg/analyzer"
    "debug-toolkit/pkg/collector"
    "debug-toolkit/pkg/detector"

    "github.com/prometheus/client_golang/prometheus/promhttp"
)

// Server provides debug endpoints
type Server struct {
    logger     *slog.Logger
    collector  *collector.Collector
    analyzer   *analyzer.Analyzer
    detector   *detector.Detector
    httpServer *http.Server

    mu         sync.RWMutex
    snapshots  []*collector.Snapshot
    maxHistory int
}

// Config configures the debug server
type Config struct {
    Addr           string
    Version        string
    ReadTimeout    time.Duration
    WriteTimeout   time.Duration
    MaxSnapHistory int
}

// DefaultConfig returns sensible defaults
func DefaultConfig() Config {
    return Config{
        // Loopback, not ":6060". A bare ":6060" binds 0.0.0.0 and publishes
        // heap contents, argv, and a free CPU-burn endpoint to anything that
        // can route to the pod. The default must be the safe one: reach this
        // through `kubectl port-forward` or an SSH tunnel, and make exposing
        // it wider a deliberate act by whoever overrides Addr.
        Addr:           "127.0.0.1:6060",
        Version:        "dev",
        ReadTimeout:    60 * time.Second,

        // Deliberately 0. A profile capture is a long, slow write:
        // /debug/pprof/profile?seconds=300 streams for five minutes, and any
        // WriteTimeout shorter than the capture cuts the response mid-stream
        // and hands you a truncated, unparseable profile. Safe here only
        // because the listener is loopback-only.
        WriteTimeout:   0,
        MaxSnapHistory: 100,
    }
}

// New creates a new debug server
func New(logger *slog.Logger, config Config) *Server {
    coll := collector.NewCollector(config.Version)
    anal := analyzer.NewAnalyzer()

    s := &Server{
        logger:     logger,
        collector:  coll,
        analyzer:   anal,
        snapshots:  make([]*collector.Snapshot, 0),
        maxHistory: config.MaxSnapHistory,
    }

    // Create HTTP mux
    mux := http.NewServeMux()

    // pprof endpoints
    mux.HandleFunc("/debug/pprof/", pprof.Index)
    mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
    mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
    mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
    mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

    // Custom debug endpoints
    mux.HandleFunc("/debug/info", s.handleInfo)
    mux.HandleFunc("/debug/snapshot", s.handleSnapshot)
    mux.HandleFunc("/debug/analyze", s.handleAnalyze)
    mux.HandleFunc("/debug/goroutines", s.handleGoroutines)
    mux.HandleFunc("/debug/memory", s.handleMemory)
    mux.HandleFunc("/debug/gc", s.handleGC)
    mux.HandleFunc("/debug/runtime", s.handleRuntime)
    mux.HandleFunc("/debug/history", s.handleHistory)
    mux.HandleFunc("/debug/compare", s.handleCompare)
    mux.HandleFunc("/debug/alerts", s.handleAlerts)

    // Prometheus metrics
    mux.Handle("/metrics", promhttp.Handler())

    // Health endpoints
    mux.HandleFunc("/healthz", s.handleHealthz)
    mux.HandleFunc("/readyz", s.handleReadyz)

    s.httpServer = &http.Server{
        Addr:         config.Addr,
        Handler:      mux,
        ReadTimeout:  config.ReadTimeout,
        WriteTimeout: config.WriteTimeout,
    }

    return s
}

// SetDetector sets the issue detector
func (s *Server) SetDetector(d *detector.Detector) {
    s.detector = d
}

// Start begins serving
func (s *Server) Start() error {
    s.logger.Info("starting debug server", "addr", s.httpServer.Addr)
    return s.httpServer.ListenAndServe()
}

// Shutdown gracefully stops the server
func (s *Server) Shutdown(ctx context.Context) error {
    return s.httpServer.Shutdown(ctx)
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
    snapshot, err := s.collector.Collect(r.Context(), false)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    s.addSnapshot(snapshot)
    s.writeJSON(w, snapshot)
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
    includeProfiles := r.URL.Query().Get("profiles") == "true"

    snapshot, err := s.collector.Collect(r.Context(), includeProfiles)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    s.addSnapshot(snapshot)

    // If profiles included, we need special handling
    if includeProfiles {
        // Return profile names, actual profiles can be fetched separately
        response := struct {
            *collector.Snapshot
            AvailableProfiles []string `json:"available_profiles"`
        }{
            Snapshot:          snapshot,
            AvailableProfiles: make([]string, 0, len(snapshot.Profiles)),
        }
        for name := range snapshot.Profiles {
            response.AvailableProfiles = append(response.AvailableProfiles, name)
        }
        s.writeJSON(w, response)
    } else {
        s.writeJSON(w, snapshot)
    }
}

func (s *Server) handleAnalyze(w http.ResponseWriter, r *http.Request) {
    snapshot, err := s.collector.Collect(r.Context(), false)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    s.addSnapshot(snapshot)

    result, err := s.analyzer.Analyze(r.Context(), snapshot)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    s.writeJSON(w, result)
}

func (s *Server) handleGoroutines(w http.ResponseWriter, r *http.Request) {
    full := r.URL.Query().Get("full") == "true"

    // Delegate to the collector rather than re-implementing the walk here.
    // An earlier version of this handler built the dump itself, allocated
    // an empty ByState map, and never filled it, so /debug/goroutines
    // always answered `"by_state": {}` while looking entirely healthy.
    // The collector already parses states and function counts correctly.
    info := s.collector.CollectGoroutineInfo(full)

    s.writeJSON(w, info)
}

func (s *Server) handleMemory(w http.ResponseWriter, r *http.Request) {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    info := collector.MemoryInfo{
        Alloc:        m.Alloc,
        TotalAlloc:   m.TotalAlloc,
        Sys:          m.Sys,
        HeapAlloc:    m.HeapAlloc,
        HeapSys:      m.HeapSys,
        HeapIdle:     m.HeapIdle,
        HeapInuse:    m.HeapInuse,
        HeapReleased: m.HeapReleased,
        HeapObjects:  m.HeapObjects,
        StackInuse:   m.StackInuse,
        StackSys:     m.StackSys,
        MSpanInuse:   m.MSpanInuse,
        MCacheInuse:  m.MCacheInuse,
        BuckHashSys:  m.BuckHashSys,
        GCSys:        m.GCSys,
        OtherSys:     m.OtherSys,
    }

    s.writeJSON(w, info)
}

func (s *Server) handleGC(w http.ResponseWriter, r *http.Request) {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    info := map[string]any{
        "num_gc":          m.NumGC,
        "num_forced_gc":   m.NumForcedGC,
        "gc_cpu_fraction": m.GCCPUFraction,
        "last_gc":         time.Unix(0, int64(m.LastGC)).Format(time.RFC3339),
        "next_gc_bytes":   m.NextGC,
        "pause_total_ns":  m.PauseTotalNs,
    }

    // Recent pauses
    pauses := make([]uint64, 0, 10)
    for i := 0; i < 10 && i < int(m.NumGC); i++ {
        pauses = append(pauses, m.PauseNs[(int(m.NumGC)-1-i+256)%256])
    }
    info["recent_pauses_ns"] = pauses

    s.writeJSON(w, info)
}

func (s *Server) handleRuntime(w http.ResponseWriter, r *http.Request) {
    info := map[string]any{
        "version":       runtime.Version(),
        "goos":          runtime.GOOS,
        "goarch":        runtime.GOARCH,
        "num_cpu":       runtime.NumCPU(),
        "gomaxprocs":    runtime.GOMAXPROCS(0),
        "num_goroutine": runtime.NumGoroutine(),
        "num_cgo_call":  runtime.NumCgoCall(),
    }

    s.writeJSON(w, info)
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    // Return summary of snapshots
    summaries := make([]map[string]any, 0, len(s.snapshots))
    for _, snap := range s.snapshots {
        summaries = append(summaries, map[string]any{
            "id":             snap.ID,
            "timestamp":      snap.Timestamp,
            "num_goroutine":  snap.Runtime.NumGoroutine,
            "heap_alloc":     snap.Memory.HeapAlloc,
            "num_gc":         snap.GC.NumGC,
        })
    }

    s.writeJSON(w, summaries)
}

func (s *Server) handleCompare(w http.ResponseWriter, r *http.Request) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    if len(s.snapshots) < 2 {
        http.Error(w, "need at least 2 snapshots to compare", http.StatusBadRequest)
        return
    }

    baseline := s.snapshots[0]
    current := s.snapshots[len(s.snapshots)-1]

    comparisons := s.analyzer.Compare(baseline, current)
    s.writeJSON(w, comparisons)
}

func (s *Server) handleAlerts(w http.ResponseWriter, r *http.Request) {
    if s.detector == nil {
        s.writeJSON(w, []any{})
        return
    }

    alerts := s.detector.GetActiveAlerts()
    s.writeJSON(w, alerts)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ok"))
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
    // Add readiness checks here
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ok"))
}

func (s *Server) addSnapshot(snap *collector.Snapshot) {
    s.mu.Lock()
    defer s.mu.Unlock()

    s.snapshots = append(s.snapshots, snap)
    if len(s.snapshots) > s.maxHistory {
        s.snapshots = s.snapshots[1:]
    }
}

func (s *Server) writeJSON(w http.ResponseWriter, v any) {
    w.Header().Set("Content-Type", "application/json")
    if err := json.NewEncoder(w).Encode(v); err != nil {
        s.logger.Error("failed to encode response", "error", err)
    }
}
```

### cmd/debugserver/main.go - Server Entry Point

The server entry point embeds `version`, `commit`, and `buildTime` variables that are injected at link time via `-ldflags`, enabling every debug snapshot to carry precise build provenance without a separate config file. The optional `--detector` flag wires in the background `Detector` and hooks its alert handler to structured `slog` output, so alert details appear in the same JSON log stream as all other service events and can be forwarded to any log aggregation platform.

```go
package main

import (
    "context"
    "errors"
    "flag"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "debug-toolkit/internal/server"
    "debug-toolkit/pkg/detector"
)

var (
    version   = "dev"
    commit    = "unknown"
    buildTime = "unknown"
)

func main() {
    // Loopback default. Overriding this to ":6060" publishes heap contents
    // and argv to the network, so make that a decision someone has to type.
    addr := flag.String("addr", "127.0.0.1:6060", "Debug server address")
    logLevel := flag.String("log-level", "info", "Log level (debug, info, warn, error)")
    enableDetector := flag.Bool("detector", true, "Enable issue detector")
    flag.Parse()

    // Setup logging
    var level slog.Level
    switch *logLevel {
    case "debug":
        level = slog.LevelDebug
    case "warn":
        level = slog.LevelWarn
    case "error":
        level = slog.LevelError
    default:
        level = slog.LevelInfo
    }

    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: level,
    }))

    logger.Info("starting debug toolkit",
        "version", version,
        "commit", commit,
        "build_time", buildTime,
    )

    // Create server. Start from DefaultConfig so the timeout reasoning
    // documented there is not silently re-broken here.
    config := server.DefaultConfig()
    config.Addr = *addr
    config.Version = version

    srv := server.New(logger, config)

    // Setup detector if enabled
    if *enableDetector {
        detectorConfig := detector.DefaultDetectorConfig()
        det := detector.NewDetector(logger, detectorConfig, func(alert *detector.Alert) {
            logger.Warn("alert raised",
                "alert_id", alert.ID,
                "type", alert.Type,
                "severity", alert.Severity,
                "message", alert.Message,
            )
        })

        srv.SetDetector(det)

        ctx, cancel := context.WithCancel(context.Background())
        defer cancel()

        det.Start(ctx)
        defer det.Stop()
    }

    // Handle shutdown
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        <-sigCh

        logger.Info("shutting down...")
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        if err := srv.Shutdown(ctx); err != nil {
            logger.Error("shutdown error", "error", err)
        }
    }()

    // Start server. Compare against the sentinel, not its message text:
    // `err.Error() != "http: Server closed"` is a string match against an
    // error whose wording is not part of any compatibility promise, and it
    // breaks the moment the error is wrapped. errors.Is sees through wrapping.
    if err := srv.Start(); err != nil && !errors.Is(err, http.ErrServerClosed) {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}
```

### cmd/debugctl/main.go - CLI Tool

`debugctl` is a lightweight, self-contained CLI that translates sub-commands, `info`, `analyze`, `goroutines`, `memory`, `gc`, `profile`, `alerts`, `compare`, `watch`, into HTTP requests against the debug server pointed to by the `DEBUG_URL` environment variable. This design means the CLI requires no special privileges or side-channels. It works over any HTTP-reachable network path, including `kubectl port-forward` tunnels into Kubernetes pods. The `watch` sub-command provides a continuously refreshing view of key metrics, replicating the feel of `top` for Go runtime internals.

```go
package main

import (
    "context"
    "encoding/json"
    "flag"
    "fmt"
    "io"
    "net/http"
    "os"
    "strings"
    "time"
)

func main() {
    if len(os.Args) < 2 {
        printUsage()
        os.Exit(1)
    }

    baseURL := os.Getenv("DEBUG_URL")
    if baseURL == "" {
        baseURL = "http://localhost:6060"
    }

    cmd := os.Args[1]
    args := os.Args[2:]

    switch cmd {
    case "info":
        cmdInfo(baseURL)
    case "snapshot":
        cmdSnapshot(baseURL, args)
    case "analyze":
        cmdAnalyze(baseURL)
    case "goroutines":
        cmdGoroutines(baseURL, args)
    case "memory":
        cmdMemory(baseURL)
    case "gc":
        cmdGC(baseURL)
    case "profile":
        cmdProfile(baseURL, args)
    case "alerts":
        cmdAlerts(baseURL)
    case "compare":
        cmdCompare(baseURL)
    case "watch":
        cmdWatch(baseURL, args)
    default:
        fmt.Printf("Unknown command: %s\n", cmd)
        printUsage()
        os.Exit(1)
    }
}

func printUsage() {
    fmt.Println(`Debug CLI Tool

Usage: debugctl <command> [options]

Commands:
  info        Show runtime information
  snapshot    Take debug snapshot
  analyze     Analyze current state
  goroutines  Show goroutine information
  memory      Show memory statistics
  gc          Show GC statistics
  profile     Capture profile (cpu, heap, goroutine)
  alerts      Show active alerts
  compare     Compare first and last snapshots
  watch       Continuously monitor metrics

Environment:
  DEBUG_URL   Base URL for debug server (default: http://localhost:6060)

Examples:
  debugctl info
  debugctl analyze
  debugctl profile cpu --duration 30s --output cpu.prof
  debugctl goroutines --full
  debugctl watch --interval 5s`)
}

func cmdInfo(baseURL string) {
    resp, err := http.Get(baseURL + "/debug/info")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var data map[string]any
    json.NewDecoder(resp.Body).Decode(&data)
    prettyPrint(data)
}

func cmdSnapshot(baseURL string, args []string) {
    fs := flag.NewFlagSet("snapshot", flag.ExitOnError)
    profiles := fs.Bool("profiles", false, "Include profiles")
    fs.Parse(args)

    url := baseURL + "/debug/snapshot"
    if *profiles {
        url += "?profiles=true"
    }

    resp, err := http.Get(url)
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var data map[string]any
    json.NewDecoder(resp.Body).Decode(&data)
    prettyPrint(data)
}

func cmdAnalyze(baseURL string) {
    resp, err := http.Get(baseURL + "/debug/analyze")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var data map[string]any
    json.NewDecoder(resp.Body).Decode(&data)

    // Format output nicely
    fmt.Println("=== Analysis Result ===")
    if summary, ok := data["summary"].(map[string]any); ok {
        fmt.Printf("\nHealth Score: %.0f/100\n", summary["health_score"])
        fmt.Printf("Overall Status: %s\n", summary["overall_status"])
        fmt.Printf("Memory Status: %s\n", summary["memory_status"])
        fmt.Printf("Goroutine Status: %s\n", summary["goroutine_status"])
        fmt.Printf("GC Status: %s\n", summary["gc_status"])
        fmt.Printf("\nIssues: %v critical, %v warnings, %v info\n",
            summary["critical_issues"],
            summary["warning_issues"],
            summary["info_issues"])
    }

    if issues, ok := data["issues"].([]any); ok && len(issues) > 0 {
        fmt.Println("\n=== Issues ===")
        for _, issue := range issues {
            if i, ok := issue.(map[string]any); ok {
                fmt.Printf("\n[%s] %s\n", strings.ToUpper(i["severity"].(string)), i["title"])
                fmt.Printf("  %s\n", i["description"])
                if suggestion, ok := i["suggestion"]; ok {
                    fmt.Printf("  Suggestion: %s\n", suggestion)
                }
            }
        }
    }
}

func cmdGoroutines(baseURL string, args []string) {
    fs := flag.NewFlagSet("goroutines", flag.ExitOnError)
    full := fs.Bool("full", false, "Include full goroutine dump")
    fs.Parse(args)

    url := baseURL + "/debug/goroutines"
    if *full {
        url += "?full=true"
    }

    resp, err := http.Get(url)
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var data map[string]any
    json.NewDecoder(resp.Body).Decode(&data)

    fmt.Printf("Total goroutines: %.0f\n", data["total"])
    if dump, ok := data["dump"].(string); ok && dump != "" {
        fmt.Println("\n=== Goroutine Dump ===")
        fmt.Println(dump)
    }
}

func cmdMemory(baseURL string) {
    resp, err := http.Get(baseURL + "/debug/memory")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var data map[string]any
    json.NewDecoder(resp.Body).Decode(&data)

    fmt.Println("=== Memory Statistics ===")
    fmt.Printf("Alloc:        %s\n", formatBytes(data["alloc_bytes"]))
    fmt.Printf("Total Alloc:  %s\n", formatBytes(data["total_alloc_bytes"]))
    fmt.Printf("Sys:          %s\n", formatBytes(data["sys_bytes"]))
    fmt.Printf("Heap Alloc:   %s\n", formatBytes(data["heap_alloc_bytes"]))
    fmt.Printf("Heap Inuse:   %s\n", formatBytes(data["heap_inuse_bytes"]))
    fmt.Printf("Heap Idle:    %s\n", formatBytes(data["heap_idle_bytes"]))
    fmt.Printf("Heap Objects: %.0f\n", data["heap_objects"])
    fmt.Printf("Stack Inuse:  %s\n", formatBytes(data["stack_inuse_bytes"]))
}

func cmdGC(baseURL string) {
    resp, err := http.Get(baseURL + "/debug/gc")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var data map[string]any
    json.NewDecoder(resp.Body).Decode(&data)

    fmt.Println("=== GC Statistics ===")
    fmt.Printf("Num GC:          %.0f\n", data["num_gc"])
    fmt.Printf("Num Forced GC:   %.0f\n", data["num_forced_gc"])
    fmt.Printf("GC CPU Fraction: %.2f%%\n", data["gc_cpu_fraction"].(float64)*100)
    fmt.Printf("Last GC:         %s\n", data["last_gc"])
    fmt.Printf("Next GC:         %s\n", formatBytes(data["next_gc_bytes"]))
    fmt.Printf("Total Pause:     %s\n", formatNanos(data["pause_total_ns"]))

    if pauses, ok := data["recent_pauses_ns"].([]any); ok && len(pauses) > 0 {
        fmt.Println("\nRecent Pauses:")
        for i, p := range pauses {
            fmt.Printf("  %d: %s\n", i+1, formatNanos(p))
        }
    }
}

func cmdProfile(baseURL string, args []string) {
    fs := flag.NewFlagSet("profile", flag.ExitOnError)
    duration := fs.Duration("duration", 30*time.Second, "Profile duration")
    output := fs.String("output", "", "Output file (default: stdout)")
    fs.Parse(args)

    profileType := "heap"
    if fs.NArg() > 0 {
        profileType = fs.Arg(0)
    }

    url := fmt.Sprintf("%s/debug/pprof/%s", baseURL, profileType)
    if profileType == "profile" || profileType == "cpu" {
        url = fmt.Sprintf("%s/debug/pprof/profile?seconds=%d", baseURL, int(duration.Seconds()))
        profileType = "cpu"
    }

    fmt.Printf("Capturing %s profile for %v...\n", profileType, *duration)

    ctx, cancel := context.WithTimeout(context.Background(), *duration+10*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var out io.Writer = os.Stdout
    if *output != "" {
        f, err := os.Create(*output)
        if err != nil {
            fmt.Printf("Error creating file: %v\n", err)
            os.Exit(1)
        }
        defer f.Close()
        out = f
    }

    n, err := io.Copy(out, resp.Body)
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }

    if *output != "" {
        fmt.Printf("Wrote %d bytes to %s\n", n, *output)
        fmt.Printf("Analyze with: go tool pprof %s\n", *output)
    }
}

func cmdAlerts(baseURL string) {
    resp, err := http.Get(baseURL + "/debug/alerts")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var alerts []map[string]any
    json.NewDecoder(resp.Body).Decode(&alerts)

    if len(alerts) == 0 {
        fmt.Println("No active alerts")
        return
    }

    fmt.Println("=== Active Alerts ===")
    for _, alert := range alerts {
        fmt.Printf("\n[%s] %s\n", strings.ToUpper(alert["severity"].(string)), alert["type"])
        fmt.Printf("  Message: %s\n", alert["message"])
        fmt.Printf("  Time: %s\n", alert["timestamp"])
    }
}

func cmdCompare(baseURL string) {
    resp, err := http.Get(baseURL + "/debug/compare")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
    defer resp.Body.Close()

    var comparisons []map[string]any
    json.NewDecoder(resp.Body).Decode(&comparisons)

    fmt.Println("=== Snapshot Comparison ===")
    fmt.Printf("%-20s %15s %15s %12s %10s\n", "Metric", "Previous", "Current", "Change", "Trend")
    fmt.Println(strings.Repeat("-", 75))

    for _, c := range comparisons {
        fmt.Printf("%-20s %15.0f %15.0f %+11.0f %10s\n",
            c["metric"],
            c["previous"],
            c["current"],
            c["change"],
            c["trend"])
    }
}

func cmdWatch(baseURL string, args []string) {
    fs := flag.NewFlagSet("watch", flag.ExitOnError)
    interval := fs.Duration("interval", 5*time.Second, "Poll interval")
    fs.Parse(args)

    fmt.Printf("Watching metrics (interval: %v). Press Ctrl+C to stop.\n\n", *interval)

    ticker := time.NewTicker(*interval)
    defer ticker.Stop()

    for {
        // Clear screen (simple approach)
        fmt.Print("\033[H\033[2J")

        resp, err := http.Get(baseURL + "/debug/info")
        if err != nil {
            fmt.Printf("Error: %v\n", err)
            <-ticker.C
            continue
        }

        var data map[string]any
        json.NewDecoder(resp.Body).Decode(&data)
        resp.Body.Close()

        fmt.Printf("=== Debug Watch [%s] ===\n\n", time.Now().Format("15:04:05"))

        if runtime, ok := data["runtime"].(map[string]any); ok {
            fmt.Printf("Goroutines: %.0f\n", runtime["num_goroutine"])
        }

        if memory, ok := data["memory"].(map[string]any); ok {
            fmt.Printf("Heap Alloc: %s\n", formatBytes(memory["heap_alloc_bytes"]))
            fmt.Printf("Heap Objects: %.0f\n", memory["heap_objects"])
        }

        if gc, ok := data["gc"].(map[string]any); ok {
            fmt.Printf("GC Count: %.0f\n", gc["num_gc"])
            fmt.Printf("GC CPU: %.2f%%\n", gc["gc_cpu_fraction"].(float64)*100)
        }

        <-ticker.C
    }
}

func prettyPrint(data any) {
    enc := json.NewEncoder(os.Stdout)
    enc.SetIndent("", "  ")
    enc.Encode(data)
}

func formatBytes(v any) string {
    var b float64
    switch n := v.(type) {
    case float64:
        b = n
    case int64:
        b = float64(n)
    default:
        return "?"
    }

    const unit = 1024
    if b < unit {
        return fmt.Sprintf("%.0f B", b)
    }
    div, exp := float64(unit), 0
    for n := b / unit; n >= unit; n /= unit {
        div *= unit
        exp++
    }
    return fmt.Sprintf("%.1f %cB", b/div, "KMGTPE"[exp])
}

func formatNanos(v any) string {
    var ns float64
    switch n := v.(type) {
    case float64:
        ns = n
    case int64:
        ns = float64(n)
    default:
        return "?"
    }

    d := time.Duration(ns)
    if d < time.Microsecond {
        return fmt.Sprintf("%.0fns", ns)
    } else if d < time.Millisecond {
        return fmt.Sprintf("%.1fµs", ns/1000)
    } else if d < time.Second {
        return fmt.Sprintf("%.1fms", ns/1000000)
    }
    return fmt.Sprintf("%.2fs", ns/1000000000)
}
```

### Dockerfile

This Dockerfile builds the debug server with `-gcflags="all=-N -l"`, which disables optimizations and inlining so that every frame survives and Delve can show you variables that would otherwise be optimized away or reported as `<optimized out>`.

Be clear about the trade, because it cuts against profiling rather than helping it. `-N -l` produces a binary that is meaningfully slower and allocates differently from the one you ship, and `all=` applies it to the standard library too. A CPU profile taken from a `-N -l` build is a profile of a program you do not run in production: costs that inlining would erase show up as real frames, and the hot paths move. So this flag combination is right for a sidecar whose job is interactive inspection under Delve, and wrong for the service you are actually profiling. Profile the optimized binary. If profiles are hard to read because inlining collapsed the frames you wanted, reach for `-gcflags="-l"` on the one package under study, or read the `-lines`-granularity view in pprof, rather than deoptimizing the whole binary.

Both the `debugserver` daemon and the `debugctl` CLI are compiled in the same build stage, and Delve is built there too, so the final image ships a self-contained toolkit without dragging a Go toolchain into the runtime layer.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build with debug info preserved
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=unknown

RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-X main.version=${VERSION} -X main.commit=${COMMIT} -X main.buildTime=${BUILD_TIME}" \
    -gcflags="all=-N -l" \
    -o /debugserver ./cmd/debugserver

RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-X main.version=${VERSION}" \
    -o /debugctl ./cmd/debugctl

# Build delve in the build stage, where the toolchain already lives.
# Installing Go into the runtime image to `go install` at runtime pulls a
# compiler and ~350MB into production and needs network access on a host
# that should have none.
RUN CGO_ENABLED=0 GOOS=linux go install github.com/go-delve/delve/cmd/dlv@latest

# Runtime stage
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /debugserver /app/
COPY --from=builder /debugctl /app/
# Copy the delve binary itself. `go install` in the runtime stage left it in
# /root/go/bin, off PATH, unusable, and the image was shipped believing it
# had a debugger.
COPY --from=builder /go/bin/dlv /usr/local/bin/dlv

# Expose ports. Each EXPOSE takes ports and nothing else: a trailing
# `EXPOSE 6060   # Debug server` does not build, it fails with
# "invalid containerPort: #". Comments go on their own line.
# 6060: debug server
EXPOSE 6060
# 2345: delve
EXPOSE 2345

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:6060/healthz || exit 1

# Default command runs debug server.
#
# Binds 0.0.0.0 because a loopback bind inside a container is unreachable
# from `docker run -p`. That makes the network boundary the only thing
# protecting these endpoints, so this port must never be published to an
# untrusted network or mapped to a public interface. Under Kubernetes,
# prefer a loopback bind plus `kubectl port-forward`, which reaches the
# pod's own network namespace and needs no exposed port at all.
ENTRYPOINT ["/app/debugserver"]
CMD ["--addr", "0.0.0.0:6060"]
```

### docker-compose.yml

The Compose file passes `VERSION`, `COMMIT`, and `BUILD_TIME` as Docker build arguments so the compiled snapshot metadata always reflects the exact image being run, and publishes port `2345` for Delve remote debugging alongside the main debug server port. Prometheus and Grafana are included as first-class services, giving teams a complete local observability stack that mirrors production monitoring without any manual dashboard setup.

This is a local development stack, and every port here is bound to `127.0.0.1` deliberately. Both of these ports are dangerous to publish. The debug server serves your heap and argv, and Delve on 2345 is unauthenticated remote code execution as the target process. Written as `"6060:6060"`, Compose binds `0.0.0.0` and the port is reachable from any network your machine is on. The `127.0.0.1:` prefix is what keeps that from happening, and it is the kind of detail that gets dropped when a compose file is copied toward staging.

```yaml
# No `version:` key. It has been obsolete since Compose v2 and current
# versions warn that it is ignored.

services:
  debug-toolkit:
    build:
      context: .
      args:
        VERSION: ${VERSION:-dev}
        COMMIT: ${COMMIT:-unknown}
        BUILD_TIME: ${BUILD_TIME:-unknown}
    ports:
      # Bind to the loopback interface of the HOST, not 0.0.0.0.
      # A bare "6060:6060" publishes on every host interface, which on a
      # laptop means anyone on the coffee shop wifi can read your heap.
      # The 127.0.0.1 prefix is the whole difference.
      - "127.0.0.1:6060:6060"
      # Delve is remote code execution by design: it has no auth and no TLS.
      # Loopback only, always.
      - "127.0.0.1:2345:2345"
    environment:
      - GOMAXPROCS=4
      - GOGC=100
      # Below the 1G container limit, not equal to it. GOMEMLIMIT caps only
      # Go's own heap - goroutine stacks, the binary, and any cgo or OS
      # allocations sit outside it. Setting the two to the same number means
      # the GC is content right up to the point the kernel OOM-kills the
      # container. Leave headroom.
      - GOMEMLIMIT=800MiB
      - LOG_LEVEL=info
    volumes:
      - debug-data:/app/data
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:6060/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 256M

  # Sample application to debug
  sample-app:
    image: your-app:latest
    ports:
      - "8080:8080"
    environment:
      - DEBUG_TOOLKIT_URL=http://debug-toolkit:6060
    depends_on:
      - debug-toolkit

  # Prometheus for metrics
  prometheus:
    image: prom/prometheus:v3.14.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.enable-lifecycle'

  # Grafana for visualization
  grafana:
    image: grafana/grafana:13.2.1
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on:
      - prometheus

volumes:
  debug-data:
  prometheus-data:
  grafana-data:
```

### Makefile

The Makefile derives `VERSION`, `COMMIT`, and `BUILD_TIME` from Git at build time using shell substitutions, so every binary and Docker image automatically carries reproducible provenance without any manual version bumping. Injecting these values via `LDFLAGS` rather than a separate config file keeps the build self-contained and ensures the debug server's startup log and snapshot metadata always reflect the exact artifact in production.

```makefile
.PHONY: all build test clean docker run help

# Variables
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME ?= $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')
LDFLAGS := -ldflags "-X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.buildTime=$(BUILD_TIME)"

all: build
```

### Staff Lens: Shared Debug Toolkit

Every service in the org gets this toolkit via shared library. Consistent endpoints, consistent diagnostics, consistent on-call playbook. Without a shared toolkit, every service is debugged differently.
