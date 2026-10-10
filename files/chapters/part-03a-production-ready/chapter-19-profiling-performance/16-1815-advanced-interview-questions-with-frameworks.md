## 19.15 Advanced Interview Questions with Frameworks

### Question 6: Design a Continuous Profiling System for a Large Fleet

**Problem**: Design a continuous profiling system for 10,000+ Go services that can help identify performance regressions before they reach production.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│              CONTINUOUS PROFILING SYSTEM ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                      SERVICE FLEET (10,000+ instances)                  │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │   ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐            │    │
│  │   │ Service A │  │ Service A │  │ Service B │  │ Service C │            │    │
│  │   │ Instance 1│  │ Instance 2│  │ Instance 1│  │ Instance 1│            │    │
│  │   │           │  │           │  │           │  │           │            │    │
│  │   │ ┌───────┐ │  │ ┌───────┐ │  │ ┌───────┐ │  │ ┌───────┐ │            │    │
│  │   │ │Profile│ │  │ │Profile│ │  │ │Profile│ │  │ │Profile│ │            │    │
│  │   │ │ Agent │ │  │ │ Agent │ │  │ │ Agent │ │  │ │ Agent │ │            │    │
│  │   │ └───┬───┘ │  │ └───┬───┘ │  │ └───┬───┘ │  │ └───┬───┘ │            │    │
│  │   └─────┼─────┘  └─────┼─────┘  └─────┼─────┘  └─────┼─────┘            │    │
│  │         │              │              │              │                  │    │
│  │         └──────────────┼──────────────┼──────────────┘                  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                         │                                       │
│  DESIGN DECISIONS:                      │                                       │
│  • Sampling rate: 1% of instances       │                                       │
│  • Profile types: CPU (30s), Heap, Goroutine                                    │
│  • Upload frequency: Every 10 min       │                                       │
│  • Storage: S3/GCS with symbolization   │                                       │
│                                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                       INGESTION LAYER                                   │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │   ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │    │
│  │   │   API Gateway   │────►│  Kafka/Kinesis  │────►│   Symbolizer    │   │    │
│  │   │  (gzip, auth)   │     │  (buffering)    │     │  (debug info)   │   │    │
│  │   └─────────────────┘     └─────────────────┘     └─────────────────┘   │    │
│  │                                                                         │    │
│  │   Challenges:                                                           │    │
│  │   • 10K services × 0.01 sampling × 6 profiles/hr = 600 profiles/hr      │    │
│  │   • Each profile: 1-50MB → ~1-30GB/hour uncompressed                    │    │
│  │   • Symbol lookup: map addresses → function names                       │    │
│  │                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                         │                                       │
│                                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        STORAGE LAYER                                    │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │   ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │    │
│  │   │  Object Store   │     │   ClickHouse/   │     │    Postgres     │   │    │
│  │   │  (S3/GCS)       │     │   TimescaleDB   │     │   (metadata)    │   │    │
│  │   │  Raw profiles   │     │   Aggregated    │     │   Labels/tags   │   │    │
│  │   └─────────────────┘     └─────────────────┘     └─────────────────┘   │    │
│  │                                                                         │    │
│  │   Retention:                                                            │    │
│  │   ├── Raw: 7 days (for debugging)                                       │    │
│  │   ├── Hourly aggregates: 30 days                                        │    │
│  │   └── Daily aggregates: 1 year                                          │    │
│  │                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                         │                                       │
│                                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        ANALYSIS LAYER                                   │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │   ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │    │
│  │   │   Flame Graph   │     │   Regression    │     │   Anomaly       │   │    │
│  │   │   Generation    │     │   Detection     │     │   Detection     │   │    │
│  │   └─────────────────┘     └─────────────────┘     └─────────────────┘   │    │
│  │                                                                         │    │
│  │   Regression Detection:                                                 │    │
│  │   • Compare function CPU% between versions                              │    │
│  │   • Alert if function CPU increases > 20%                               │    │
│  │   • Track allocation rate changes                                       │    │
│  │                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  REGRESSION DETECTION WORKFLOW:                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                         │    │
│  │  1. Deploy new version (canary)                                         │    │
│  │     ↓                                                                   │    │
│  │  2. Collect profiles from canary + baseline                             │    │
│  │     ↓                                                                   │    │
│  │  3. Compare: diff = (canary_cpu[fn] - baseline_cpu[fn]) / baseline      │    │
│  │     ↓                                                                   │    │
│  │  4. If max(diff) > 20% for 10+ minutes:                                 │    │
│  │     ├── Alert to deployment pipeline                                    │    │
│  │     ├── Link to flame graph comparison                                  │    │
│  │     └── Optionally: automatic rollback                                  │    │
│  │     ↓                                                                   │    │
│  │  5. Generate report: "json.Unmarshal: +45% CPU (new code path X)"       │    │
│  │                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Implementation:**

```go
// profiling/agent.go
package profiling

import (
    "bytes"
    "compress/gzip"
    "context"
    "crypto/sha256"
    "fmt"
    "io"
    "net/http"
    "runtime"
    "runtime/pprof"
    "sync/atomic"
    "time"
)

// AgentConfig configures the profiling agent
type AgentConfig struct {
    ServiceName    string
    Version        string
    Environment    string
    InstanceID     string

    // Sampling
    SampleRate     float64       // 0.01 = 1% of intervals

    // Profile settings
    CPUDuration    time.Duration // How long to collect CPU profile
    ProfileInterval time.Duration // How often to collect

    // Upload
    Endpoint       string
    APIKey         string

    // Build info
    BuildID        string        // Unique build identifier for symbolization
}

// Agent collects and uploads profiles
type Agent struct {
    config         AgentConfig
    ctx            context.Context
    cancel         context.CancelFunc
    client         *http.Client

    profilesCollected atomic.Int64
    profilesUploaded  atomic.Int64
    errors            atomic.Int64
}

// NewAgent creates a new profiling agent
func NewAgent(cfg AgentConfig) *Agent {
    ctx, cancel := context.WithCancel(context.Background())
    return &Agent{
        config: cfg,
        ctx:    ctx,
        cancel: cancel,
        client: &http.Client{Timeout: 30 * time.Second},
    }
}

// Start begins background profiling
func (a *Agent) Start() {
    // Determine if this instance should profile
    if !a.shouldProfile() {
        return
    }

    go a.collectLoop()
}

// shouldProfile uses consistent hashing to select instances
func (a *Agent) shouldProfile() bool {
    h := sha256.Sum256([]byte(a.config.InstanceID))
    // Use first 8 bytes as uint64
    hashVal := uint64(h[0])<<56 | uint64(h[1])<<48 | uint64(h[2])<<40 |
               uint64(h[3])<<32 | uint64(h[4])<<24 | uint64(h[5])<<16 |
               uint64(h[6])<<8 | uint64(h[7])
    threshold := uint64(float64(^uint64(0)) * a.config.SampleRate)
    return hashVal < threshold
}

func (a *Agent) collectLoop() {
    ticker := time.NewTicker(a.config.ProfileInterval)
    defer ticker.Stop()

    for {
        select {
        case <-a.ctx.Done():
            return
        case <-ticker.C:
            a.collectAndUpload()
        }
    }
}

func (a *Agent) collectAndUpload() {
    profiles := map[string]*bytes.Buffer{
        "cpu":       a.collectCPU(),
        "heap":      a.collectHeap(),
        "goroutine": a.collectGoroutine(),
    }

    for profileType, data := range profiles {
        if data == nil {
            continue
        }

        a.profilesCollected.Add(1)

        if err := a.upload(profileType, data); err != nil {
            a.errors.Add(1)
            continue
        }

        a.profilesUploaded.Add(1)
    }
}

func (a *Agent) collectCPU() *bytes.Buffer {
    var buf bytes.Buffer

    if err := pprof.StartCPUProfile(&buf); err != nil {
        return nil
    }

    time.Sleep(a.config.CPUDuration)
    pprof.StopCPUProfile()

    return &buf
}

func (a *Agent) collectHeap() *bytes.Buffer {
    var buf bytes.Buffer
    runtime.GC()

    if err := pprof.WriteHeapProfile(&buf); err != nil {
        return nil
    }

    return &buf
}

func (a *Agent) collectGoroutine() *bytes.Buffer {
    var buf bytes.Buffer

    if err := pprof.Lookup("goroutine").WriteTo(&buf, 0); err != nil {
        return nil
    }

    return &buf
}

func (a *Agent) upload(profileType string, data *bytes.Buffer) error {
    // Compress
    var compressed bytes.Buffer
    gw := gzip.NewWriter(&compressed)
    if _, err := io.Copy(gw, data); err != nil {
        return err
    }
    gw.Close()

    // Build request
    url := fmt.Sprintf("%s/profiles", a.config.Endpoint)
    req, err := http.NewRequestWithContext(a.ctx, "POST", url, &compressed)
    if err != nil {
        return err
    }

    // Headers
    req.Header.Set("Content-Type", "application/octet-stream")
    req.Header.Set("Content-Encoding", "gzip")
    req.Header.Set("X-Profile-Type", profileType)
    req.Header.Set("X-Service-Name", a.config.ServiceName)
    req.Header.Set("X-Service-Version", a.config.Version)
    req.Header.Set("X-Environment", a.config.Environment)
    req.Header.Set("X-Instance-ID", a.config.InstanceID)
    req.Header.Set("X-Build-ID", a.config.BuildID)
    req.Header.Set("X-Timestamp", time.Now().UTC().Format(time.RFC3339))
    req.Header.Set("Authorization", "Bearer "+a.config.APIKey)

    // Send
    resp, err := a.client.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
        return fmt.Errorf("upload failed: %d", resp.StatusCode)
    }

    return nil
}

// Stop halts profiling
func (a *Agent) Stop() {
    a.cancel()
}

// Stats returns agent statistics
func (a *Agent) Stats() map[string]int64 {
    return map[string]int64{
        "collected": a.profilesCollected.Load(),
        "uploaded":  a.profilesUploaded.Load(),
        "errors":    a.errors.Load(),
    }
}
```

**Key Design Points:**
- **Consistent hashing**: Same instance always profiles (or doesn't), preventing sample bias
- **Low overhead**: 1% sampling, compressed uploads, background collection
- **Regression detection**: Compare CPU% by function across versions
- **Symbolization**: Build ID links profiles to debug symbols

---

### Question 7: Explain the Go Memory Model and Its Performance Implications

**Problem**: How does the Go memory model affect performance, and how do you write memory-safe high-performance code?

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    GO MEMORY MODEL PERFORMANCE IMPLICATIONS                      │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  MEMORY ORDERING (Happens-Before):                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                                                                         │     │
│  │  Goroutine 1              Goroutine 2                                   │     │
│  │  ───────────              ───────────                                   │     │
│  │  data = "ready"           ───────────────────► (waits)                  │     │
│  │       │                                                                 │     │
│  │       ▼                                                                 │     │
│  │  done <- true  ═══════════════════════════►  <-done                     │     │
│  │                   (synchronization)               │                     │     │
│  │                                                   ▼                     │     │
│  │                                             print(data) // "ready"      │     │
│  │                                                                         │     │
│  │  Channel send HAPPENS-BEFORE channel receive                            │     │
│  │  So 'data = "ready"' is visible after <-done                            │     │
│  │                                                                         │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  DANGEROUS: No Synchronization                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                                                                         │     │
│  │  Goroutine 1              Goroutine 2                                   │     │
│  │  ───────────              ───────────                                   │     │
│  │  data = "ready"           if done {         // DATA RACE!               │     │
│  │  done = true                  print(data)   // Might see "" or "ready"  │     │
│  │                           }                 // Undefined behavior!      │     │
│  │                                                                         │     │
│  │  Without synchronization:                                               │     │
│  │  • Compiler can reorder writes                                          │     │
│  │  • CPU can reorder memory operations                                    │     │
│  │  • Caches may not be synchronized                                       │     │
│  │                                                                         │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  SYNCHRONIZATION PRIMITIVES AND THEIR COSTS:                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                                                                         │     │
│  │  Primitive       Typical Cost    Memory Barrier    Use Case             │     │
│  │  ─────────       ────────────    ──────────────    ────────             │     │
│  │  atomic.Load     ~1ns            Load barrier       Reading counters    │     │
│  │  atomic.Store    ~5ns            Store barrier      Updating flags      │     │
│  │  atomic.Add      ~10ns           Full barrier       Counters, stats     │     │
│  │  atomic.CAS      ~15ns           Full barrier       Lock-free updates   │     │
│  │  sync.Mutex      ~20ns           Full barrier       Critical sections   │     │
│  │  sync.RWMutex    ~25ns           Full barrier       Read-heavy loads    │     │
│  │  channel send    ~50ns           Full barrier       Communication       │     │
│  │                                                                         │     │
│  │  Note: Costs are approximate and vary by hardware                       │     │
│  │                                                                         │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  FALSE SHARING (Cache Line Contention):                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                                                                         │     │
│  │  // BAD: Fields on same cache line (64 bytes on most CPUs)              │     │
│  │  type Counters struct {                                                 │     │
│  │      counter1 int64  // ─┐                                              │     │
│  │      counter2 int64  // ─┤ Same 64-byte cache line                      │     │
│  │      counter3 int64  // ─┤ Writing counter1 invalidates counter2!       │     │
│  │      counter4 int64  // ─┘                                              │     │
│  │  }                                                                      │     │
│  │                                                                         │     │
│  │  // GOOD: Pad to separate cache lines                                   │     │
│  │  type Counters struct {                                                 │     │
│  │      counter1 int64                                                     │     │
│  │      _pad1    [56]byte  // Padding to 64 bytes                          │     │
│  │      counter2 int64                                                     │     │
│  │      _pad2    [56]byte                                                  │     │
│  │      counter3 int64                                                     │     │
│  │      _pad3    [56]byte                                                  │     │
│  │      counter4 int64                                                     │     │
│  │  }                                                                      │     │
│  │                                                                         │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  CHOOSING THE RIGHT SYNCHRONIZATION:                                             │
│                                                                                  │
│  Decision Tree:                                                                  │
│  ┌───────────────────────────────────────────────────────────────────────┐       │
│  │                    Is it a single integer/pointer?                    │       │
│  │                              │                                        │       │
│  │              ┌───────────────┴───────────────┐                        │       │
│  │              │                               │                        │       │
│  │            Yes                              No                        │       │
│  │              │                               │                        │       │
│  │              ▼                               ▼                        │       │
│  │    Use atomic operations          Is it read-heavy (>90% reads)?      │       │
│  │                                              │                        │       │
│  │                              ┌───────────────┴───────────────┐        │       │
│  │                              │                               │        │       │
│  │                            Yes                              No        │       │
│  │                              │                               │        │       │
│  │                              ▼                               ▼        │       │
│  │                     Use sync.RWMutex               Use sync.Mutex     │       │
│  │                                                                       │       │
│  │  For complex lock-free: Consider channels or specialized structures   │       │
│  └───────────────────────────────────────────────────────────────────────┘       │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Code Example:**

```go
// High-performance concurrent counter with proper memory semantics
const cacheLine = 64

type Counter struct {
    value int64
    _     [cacheLine - 8]byte // Pad so each Counter owns its cache line
}

func (c *Counter) Inc()       { atomic.AddInt64(&c.value, 1) }
func (c *Counter) Get() int64 { return atomic.LoadInt64(&c.value) }

// Sharded counter for extreme contention
type ShardedCounter struct {
    shards [16]Counter // 16 cache-line-separated counters
}

// math/rand/v2's top-level generator is per-P and lock-free, so this
// spreads writes across shards without adding contention of its own.
func (c *ShardedCounter) Inc() {
    c.shards[rand.IntN(len(c.shards))].Inc()
}

// Get is approximate under concurrent writes: shards are read one at a
// time, so the total is not a consistent snapshot of any single instant.
func (c *ShardedCounter) Get() int64 {
    var total int64
    for i := range c.shards {
        total += c.shards[i].Get()
    }
    return total
}
```

**On shard selection.** You will see this written as `runtime_procPin() % 16`, picking the shard from the current P so that each processor touches its own cache line. That is genuinely the ideal distribution, and you cannot write it: `runtime_procPin` is an internal runtime function, available to `sync` and friends through `//go:linkname` but simply undefined in your code. Code that calls it does not compile. It is also easy to get subtly wrong even with access, since unpinning before using the index lets the goroutine migrate and defeats the purpose.

`rand.IntN` from `math/rand/v2` is the portable answer. Its top-level functions draw from per-P state without locking, so the shard choice is cheap and uncontended.

**Does sharding actually pay?** Measured on the machine used for this book (linux/amd64, 8 logical CPUs, Go 1.27.1) with `b.RunParallel`:

| Counter | ns/op under contention |
|---|---|
| Single `atomic.AddInt64` | 43.88 ±3% |
| 16-way sharded | 30.71 ±15% |

Real, and smaller than the folklore suggests: about 30% on 8 cores, not the order of magnitude people expect. The gap widens with core count, because the problem being solved is many cores fighting over one cache line. On an 8-core box there are only so many fighters.

That is the honest framing for an interview answer. Sharding a counter trades memory (16 cache lines instead of one) and read cost (`Get` now sums 16 values and is no longer a consistent snapshot) for write throughput under contention. Reach for it when a profile shows a single hot counter is actually the bottleneck, and expect the win to scale with your core count rather than with your enthusiasm.

### Staff Lens: Interview Framework Reliability

Advanced performance questions like these test whether the candidate can apply systematic thinking, not just recall facts. A strong candidate walks through: characterise the workload, capture profiles, identify bottleneck, propose fix, measure result. A weak candidate jumps to specific optimizations without establishing the context.

When interviewing, reward the systematic approach even if the specific fix is not the one you had in mind. Penalise the jump to optimization without analysis even if the fix happens to be correct.

---
