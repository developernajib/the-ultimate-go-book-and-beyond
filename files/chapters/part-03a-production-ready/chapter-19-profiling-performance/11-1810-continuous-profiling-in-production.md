## 19.10 Continuous Profiling in Production

### Building a Production Profiler

A continuous profiling system captures CPU, heap, and goroutine profiles on a recurring schedule and ships them to a central store, enabling correlation between performance regressions and specific deploys. Unlike on-demand `pprof` endpoints, continuous profiling records baseline state before a problem occurs, making it possible to compare pre- and post-deploy profiles to diagnose regressions that only manifest under real production load.

In 2026 the common choice is not to build your own. Grafana Pyroscope (open source) and Datadog Continuous Profiler both ingest standard `runtime/pprof` captures, visualize them as flame graphs, and diff across time and versions. Vendors generally report low single-digit percent CPU overhead for continuous profiling, which is consistent with Go's sampling design, though the real figure depends on your capture rate and workload. Measure it on your own service rather than taking any number, theirs or this book's, on faith. Parca, from Polar Signals, adds eBPF-based fleet-wide profiling without code changes. The code below shows how to build one from scratch, which is useful for understanding the moving parts, but for a real service pick an off-the-shelf agent and skip the glue code. The examples in this section run push-mode: the service self-profiles and ships captures. pull-mode scraping works similarly.

```go
// profiler/profiler.go
package profiler

import (
    "bytes"
    "compress/gzip"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "math/rand/v2"
    "net/http"
    "os"
    "path/filepath"
    "runtime"
    "runtime/pprof"
    "sync"
    "sync/atomic"
    "time"
)

// Config configures the profiler
type Config struct {
    // Profiling intervals
    CPUProfileInterval    time.Duration
    HeapProfileInterval   time.Duration
    GoroutineInterval     time.Duration

    // Profile durations
    CPUProfileDuration    time.Duration
    TraceDuration         time.Duration

    // Storage
    StoragePath           string
    RetentionPeriod       time.Duration
    MaxStorageSize        int64 // bytes

    // Upload
    UploadEndpoint        string
    UploadTimeout         time.Duration

    // Sampling (0-1)
    SampleRate            float64

    // Labels
    ServiceName           string
    Environment           string
    Version               string
    Instance              string
}

// DefaultConfig returns sensible defaults
func DefaultConfig() Config {
    hostname, err := os.Hostname()
    if err != nil {
        hostname = "unknown"
    }
    return Config{
        CPUProfileInterval:  10 * time.Minute,
        HeapProfileInterval: 5 * time.Minute,
        GoroutineInterval:   1 * time.Minute,
        CPUProfileDuration:  30 * time.Second,
        TraceDuration:       5 * time.Second,
        StoragePath:         "/tmp/profiles",
        RetentionPeriod:     24 * time.Hour,
        MaxStorageSize:      1 << 30, // 1GB
        SampleRate:          0.1,     // 10% of intervals
        ServiceName:         "unknown",
        Environment:         "production",
        Version:             "unknown",
        Instance:            hostname,
    }
}

// Profiler manages continuous profiling
type Profiler struct {
    config      Config
    ctx         context.Context
    cancel      context.CancelFunc

    mu          sync.RWMutex
    profiles    []ProfileMetadata
    collecting  atomic.Bool

    // Metrics
    cpuProfiles     atomic.Int64
    heapProfiles    atomic.Int64
    uploadedBytes   atomic.Int64
    errors          atomic.Int64
}

// ProfileMetadata describes a collected profile
type ProfileMetadata struct {
    ID          string            `json:"id"`
    Type        string            `json:"type"`
    Timestamp   time.Time         `json:"timestamp"`
    Duration    time.Duration     `json:"duration"`
    Size        int64             `json:"size"`
    Labels      map[string]string `json:"labels"`
    Path        string            `json:"path"`
}

// New creates a new profiler
func New(config Config) *Profiler {
    ctx, cancel := context.WithCancel(context.Background())

    return &Profiler{
        config:   config,
        ctx:      ctx,
        cancel:   cancel,
        profiles: make([]ProfileMetadata, 0),
    }
}

// Start begins continuous profiling
func (p *Profiler) Start() error {
    // Create storage directory
    if err := os.MkdirAll(p.config.StoragePath, 0755); err != nil {
        return fmt.Errorf("create storage dir: %w", err)
    }

    // Start background workers
    go p.cpuProfileWorker()
    go p.heapProfileWorker()
    go p.goroutineProfileWorker()
    go p.cleanupWorker()
    go p.uploadWorker()

    return nil
}

// Stop halts profiling
func (p *Profiler) Stop() {
    p.cancel()
}

func (p *Profiler) cpuProfileWorker() {
    ticker := time.NewTicker(p.config.CPUProfileInterval)
    defer ticker.Stop()

    for {
        select {
        case <-p.ctx.Done():
            return
        case <-ticker.C:
            if !p.shouldSample() {
                continue
            }

            if err := p.collectCPUProfile(); err != nil {
                p.errors.Add(1)
            } else {
                p.cpuProfiles.Add(1)
            }
        }
    }
}

func (p *Profiler) heapProfileWorker() {
    ticker := time.NewTicker(p.config.HeapProfileInterval)
    defer ticker.Stop()

    for {
        select {
        case <-p.ctx.Done():
            return
        case <-ticker.C:
            if !p.shouldSample() {
                continue
            }

            if err := p.collectHeapProfile(); err != nil {
                p.errors.Add(1)
            } else {
                p.heapProfiles.Add(1)
            }
        }
    }
}

func (p *Profiler) goroutineProfileWorker() {
    ticker := time.NewTicker(p.config.GoroutineInterval)
    defer ticker.Stop()

    for {
        select {
        case <-p.ctx.Done():
            return
        case <-ticker.C:
            if err := p.collectGoroutineProfile(); err != nil {
                p.errors.Add(1)
            }
        }
    }
}

func (p *Profiler) shouldSample() bool {
    return rand.Float64() < p.config.SampleRate
}

func (p *Profiler) collectCPUProfile() error {
    if !p.collecting.CompareAndSwap(false, true) {
        return fmt.Errorf("profile collection already in progress")
    }
    defer p.collecting.Store(false)

    var buf bytes.Buffer

    if err := pprof.StartCPUProfile(&buf); err != nil {
        return fmt.Errorf("start CPU profile: %w", err)
    }

    time.Sleep(p.config.CPUProfileDuration)
    pprof.StopCPUProfile()

    return p.saveProfile("cpu", &buf, p.config.CPUProfileDuration)
}

func (p *Profiler) collectHeapProfile() error {
    var buf bytes.Buffer

    runtime.GC() // Get accurate heap stats

    if err := pprof.WriteHeapProfile(&buf); err != nil {
        return fmt.Errorf("write heap profile: %w", err)
    }

    return p.saveProfile("heap", &buf, 0)
}

func (p *Profiler) collectGoroutineProfile() error {
    var buf bytes.Buffer

    if err := pprof.Lookup("goroutine").WriteTo(&buf, 0); err != nil {
        return fmt.Errorf("write goroutine profile: %w", err)
    }

    return p.saveProfile("goroutine", &buf, 0)
}

func (p *Profiler) saveProfile(profileType string, data *bytes.Buffer, duration time.Duration) error {
    id := fmt.Sprintf("%s-%d", profileType, time.Now().UnixNano())
    filename := fmt.Sprintf("%s.pprof.gz", id)
    path := filepath.Join(p.config.StoragePath, filename)

    // Compress profile
    f, err := os.Create(path)
    if err != nil {
        return fmt.Errorf("create file: %w", err)
    }
    defer f.Close()

    gw := gzip.NewWriter(f)
    if _, err := io.Copy(gw, data); err != nil {
        return fmt.Errorf("compress: %w", err)
    }
    if err := gw.Close(); err != nil {
        return fmt.Errorf("close gzip: %w", err)
    }

    // Record metadata
    info, _ := f.Stat()
    metadata := ProfileMetadata{
        ID:        id,
        Type:      profileType,
        Timestamp: time.Now(),
        Duration:  duration,
        Size:      info.Size(),
        Path:      path,
        Labels: map[string]string{
            "service":     p.config.ServiceName,
            "environment": p.config.Environment,
            "version":     p.config.Version,
            "instance":    p.config.Instance,
        },
    }

    p.mu.Lock()
    p.profiles = append(p.profiles, metadata)
    p.mu.Unlock()

    return nil
}

func (p *Profiler) cleanupWorker() {
    ticker := time.NewTicker(time.Hour)
    defer ticker.Stop()

    for {
        select {
        case <-p.ctx.Done():
            return
        case <-ticker.C:
            p.cleanup()
        }
    }
}

func (p *Profiler) cleanup() {
    cutoff := time.Now().Add(-p.config.RetentionPeriod)

    p.mu.Lock()
    defer p.mu.Unlock()

    remaining := make([]ProfileMetadata, 0)
    for _, profile := range p.profiles {
        if profile.Timestamp.Before(cutoff) {
            os.Remove(profile.Path)
        } else {
            remaining = append(remaining, profile)
        }
    }
    p.profiles = remaining
}

func (p *Profiler) uploadWorker() {
    if p.config.UploadEndpoint == "" {
        return
    }

    ticker := time.NewTicker(time.Minute)
    defer ticker.Stop()

    for {
        select {
        case <-p.ctx.Done():
            return
        case <-ticker.C:
            p.uploadProfiles()
        }
    }
}

func (p *Profiler) uploadProfiles() {
    p.mu.RLock()
    profiles := make([]ProfileMetadata, len(p.profiles))
    copy(profiles, p.profiles)
    p.mu.RUnlock()

    for _, profile := range profiles {
        if err := p.uploadProfile(profile); err != nil {
            p.errors.Add(1)
            continue
        }

        // Mark as uploaded (in real system, track upload status)
        p.uploadedBytes.Add(profile.Size)
    }
}

func (p *Profiler) uploadProfile(profile ProfileMetadata) error {
    data, err := os.ReadFile(profile.Path)
    if err != nil {
        return err
    }

    ctx, cancel := context.WithTimeout(p.ctx, p.config.UploadTimeout)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "POST", p.config.UploadEndpoint, bytes.NewReader(data))
    if err != nil {
        return err
    }

    req.Header.Set("Content-Type", "application/octet-stream")
    req.Header.Set("Content-Encoding", "gzip")
    req.Header.Set("X-Profile-Type", profile.Type)
    req.Header.Set("X-Profile-ID", profile.ID)

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("upload failed: %d", resp.StatusCode)
    }

    return nil
}

// Stats returns profiling statistics
func (p *Profiler) Stats() map[string]any {
    return map[string]any{
        "cpu_profiles":   p.cpuProfiles.Load(),
        "heap_profiles":  p.heapProfiles.Load(),
        "uploaded_bytes": p.uploadedBytes.Load(),
        "errors":         p.errors.Load(),
    }
}

// HTTPHandler returns an HTTP handler for profile management
func (p *Profiler) HTTPHandler() http.Handler {
    mux := http.NewServeMux()

    mux.HandleFunc("/profiles", func(w http.ResponseWriter, r *http.Request) {
        p.mu.RLock()
        profiles := p.profiles
        p.mu.RUnlock()

        json.NewEncoder(w).Encode(profiles)
    })

    mux.HandleFunc("/profiles/now/cpu", func(w http.ResponseWriter, r *http.Request) {
        // Clamp caller-supplied duration: this is untrusted input that
        // directly controls how long we hold the global profiling lock.
        const maxDuration = 60 * time.Second
        duration := 30 * time.Second
        if d := r.URL.Query().Get("duration"); d != "" {
            parsed, err := time.ParseDuration(d)
            if err != nil || parsed <= 0 {
                http.Error(w, "invalid duration", http.StatusBadRequest)
                return
            }
            duration = min(parsed, maxDuration)
        }

        // Only one CPU profile can run at a time, process-wide. Reject
        // concurrent callers rather than letting StartCPUProfile fail late.
        if !p.collecting.CompareAndSwap(false, true) {
            http.Error(w, "profile already in progress", http.StatusConflict)
            return
        }
        defer p.collecting.Store(false)

        w.Header().Set("Content-Type", "application/octet-stream")
        w.Header().Set("Content-Disposition", "attachment; filename=cpu.pprof")

        if err := pprof.StartCPUProfile(w); err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }
        defer pprof.StopCPUProfile()

        select {
        case <-time.After(duration):
        case <-r.Context().Done(): // client hung up, stop early
        }
    })

    mux.HandleFunc("/profiles/now/heap", func(w http.ResponseWriter, r *http.Request) {
        runtime.GC()

        w.Header().Set("Content-Type", "application/octet-stream")
        w.Header().Set("Content-Disposition", "attachment; filename=heap.pprof")

        pprof.WriteHeapProfile(w)
    })

    mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
        json.NewEncoder(w).Encode(p.Stats())
    })

    return mux
}
```

### Complete Benchmark Suite

A structured benchmark suite wraps `testing.Benchmark` to capture not just elapsed time but also allocations per operation and bytes per operation, then serializes results to JSON so that a subsequent run can load the baseline and compute per-benchmark speedup percentages.

Read the next paragraph before you copy this into a CI pipeline, because the obvious way to use it is wrong.

```go
// bench/benchmark.go
package bench

import (
    "encoding/json"
    "fmt"
    "os"
    "sort"
    "strings"
    "testing"
)

// BenchmarkResult stores benchmark results
type BenchmarkResult struct {
    Name       string
    N          int
    NsPerOp    float64
    AllocsPerOp int64
    BytesPerOp int64
    Throughput float64
    Custom     map[string]float64
}

// BenchmarkSuite runs multiple benchmarks and compares results
type BenchmarkSuite struct {
    results []BenchmarkResult
    before  map[string]BenchmarkResult
    after   map[string]BenchmarkResult
}

// NewBenchmarkSuite creates a new benchmark suite
func NewBenchmarkSuite() *BenchmarkSuite {
    return &BenchmarkSuite{
        results: make([]BenchmarkResult, 0),
        before:  make(map[string]BenchmarkResult),
        after:   make(map[string]BenchmarkResult),
    }
}

// Run executes a benchmark and records results
func (s *BenchmarkSuite) Run(name string, fn func(b *testing.B)) BenchmarkResult {
    result := testing.Benchmark(fn)

    br := BenchmarkResult{
        Name:        name,
        N:           result.N,
        NsPerOp:     float64(result.T.Nanoseconds()) / float64(result.N),
        AllocsPerOp: result.AllocsPerOp(),
        BytesPerOp:  result.AllocedBytesPerOp(),
        Custom:      make(map[string]float64),
    }

    s.results = append(s.results, br)
    return br
}

// Compare loads baseline results and computes changes
func (s *BenchmarkSuite) Compare(baselinePath string) ([]ComparisonResult, error) {
    baseline, err := s.loadBaseline(baselinePath)
    if err != nil {
        return nil, err
    }

    comparisons := make([]ComparisonResult, 0)

    for _, current := range s.results {
        if prev, ok := baseline[current.Name]; ok {
            comparisons = append(comparisons, ComparisonResult{
                Name:            current.Name,
                Before:          prev,
                After:           current,
                SpeedupPercent:  (prev.NsPerOp - current.NsPerOp) / prev.NsPerOp * 100,
                AllocsDelta:     current.AllocsPerOp - prev.AllocsPerOp,
                BytesDelta:      current.BytesPerOp - prev.BytesPerOp,
            })
        }
    }

    return comparisons, nil
}

func (s *BenchmarkSuite) loadBaseline(path string) (map[string]BenchmarkResult, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, err
    }

    var results []BenchmarkResult
    if err := json.Unmarshal(data, &results); err != nil {
        return nil, err
    }

    m := make(map[string]BenchmarkResult)
    for _, r := range results {
        m[r.Name] = r
    }
    return m, nil
}

// SaveBaseline saves current results as baseline
func (s *BenchmarkSuite) SaveBaseline(path string) error {
    data, err := json.MarshalIndent(s.results, "", "  ")
    if err != nil {
        return err
    }
    return os.WriteFile(path, data, 0644)
}

// Report generates a benchmark report
func (s *BenchmarkSuite) Report() string {
    var sb strings.Builder

    sb.WriteString("Benchmark Results\n")
    sb.WriteString("=================\n\n")

    // Sort by name
    sort.Slice(s.results, func(i, j int) bool {
        return s.results[i].Name < s.results[j].Name
    })

    // Header
    sb.WriteString(fmt.Sprintf("%-40s %12s %12s %12s %12s\n",
        "Name", "ns/op", "allocs/op", "B/op", "throughput"))
    sb.WriteString(strings.Repeat("-", 90) + "\n")

    for _, r := range s.results {
        throughput := ""
        if r.Throughput > 0 {
            throughput = fmt.Sprintf("%.2f MB/s", r.Throughput)
        }

        sb.WriteString(fmt.Sprintf("%-40s %12.2f %12d %12d %12s\n",
            r.Name, r.NsPerOp, r.AllocsPerOp, r.BytesPerOp, throughput))
    }

    return sb.String()
}

// ComparisonResult shows the difference between runs
type ComparisonResult struct {
    Name           string
    Before         BenchmarkResult
    After          BenchmarkResult
    SpeedupPercent float64
    AllocsDelta    int64
    BytesDelta     int64
}

// ComparisonReport generates a comparison report
func ComparisonReport(comparisons []ComparisonResult) string {
    var sb strings.Builder

    sb.WriteString("Benchmark Comparison\n")
    sb.WriteString("====================\n\n")

    sb.WriteString(fmt.Sprintf("%-40s %12s %12s %12s %10s\n",
        "Name", "Before", "After", "Delta", "Change"))
    sb.WriteString(strings.Repeat("-", 90) + "\n")

    for _, c := range comparisons {
        change := fmt.Sprintf("%.1f%%", c.SpeedupPercent)
        if c.SpeedupPercent > 0 {
            change = "+" + change + " faster"
        } else if c.SpeedupPercent < 0 {
            change = change + " slower"
        }

        sb.WriteString(fmt.Sprintf("%-40s %12.2f %12.2f %12.2f %10s\n",
            c.Name, c.Before.NsPerOp, c.After.NsPerOp,
            c.Before.NsPerOp-c.After.NsPerOp, change))
    }

    return sb.String()
}
```

### The Catch: This Suite Compares Single Runs

`SpeedupPercent` is a subtraction between two numbers. It carries no notion of variance, and that makes it exactly the mistake the benchmarking section warned about, dressed up in enough structure to look rigorous.

Recall the measurement from earlier in this chapter: the same sort benchmark, unchanged, varied by roughly 1.8x across three consecutive runs on an idle machine. Feed that into `SpeedupPercent` and it will confidently report a 76% regression caused by nothing at all. Wire that to a CI gate with a negative threshold and the system fails builds at random. Teams do not tolerate that for long. They raise the threshold until it stops firing, at which point it no longer catches real regressions either, and the gate becomes decoration.

Use this suite for what it is honestly good at: recording `allocs/op` and `B/op`, which are exact counts rather than timings and therefore do not suffer from this problem at all. An allocation regression from 3 to 47 allocs/op is a real signal at n=1, and it is usually the thing worth gating on anyway, since allocation counts change when code changes, not when the CPU governor changes its mind.

For timing regressions in CI, do not compare single runs. Run each benchmark with `-count=10` or more and hand the output to `benchstat`, which reports a p-value and will tell you plainly when a difference is indistinguishable from noise. Gate on what `benchstat` calls significant, and only on a dedicated, quiet machine. Timing gates on shared CI runners produce noise, and a noisy gate is worse than no gate, because it trains the team to ignore it.

### Staff Lens: Continuous Profiling Is Infrastructure

Tools like Pyroscope, Google Cloud Profiler, Polar Signals, and Datadog Continuous Profiler capture profiles from production continuously at low overhead. Every production Go service should have this. Without it, performance investigations rely on synthetic loads or post-incident captures. With it, engineers can see production behavior in real time and catch regressions before they impact users.

The cost is a few percent CPU, and it is worth validating that figure against your own service rather than assuming it. The benefit is dramatically faster performance investigation. Every org should evaluate adoption.

### Principal Lens: Continuous Profiling Changes How You Investigate

When profiles are always available, you diagnose performance issues in minutes instead of days. You compare "before and after a deploy" without needing to recreate synthetic load. You identify unexpected regressions in low-traffic code paths. This is a qualitative change in the team's performance engineering capability. Worth the cost.

---
