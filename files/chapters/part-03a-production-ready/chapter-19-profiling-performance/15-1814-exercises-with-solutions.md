## 19.14 Exercises with Solutions

### Exercise 1: Find and Fix a Memory Leak

**Problem:** This service leaks goroutines. Find and fix it.

```go
type Service struct {
    requests chan Request
}

func NewService() *Service {
    s := &Service{
        requests: make(chan Request, 100),
    }

    // Worker pool
    for i := 0; i < 10; i++ {
        go s.worker()
    }

    return s
}

func (s *Service) worker() {
    for req := range s.requests {
        process(req) // May take a long time
    }
}

func (s *Service) Submit(req Request) {
    s.requests <- req
}

// Problem: How do you stop the service?
```

**Solution:**

The leak is that nothing ever closes `s.requests`, so the ten workers block on `range` forever and `NewService` is a goroutine leak factory. Fixing it is easy to get *almost* right, which is what makes this exercise worth doing carefully.

The tempting fix adds a `done` channel, selects on it in the worker, and closes it in `Stop`. Do not use it. That version has two serious bugs, and both are shown below so you can recognize them:

```go
// BROKEN. Do not copy this.
func (s *Service) worker() {
    defer s.wg.Done()
    for {
        select {
        case req := <-s.requests:
            process(req)
        case <-s.done:      // BUG 1: races with pending work
            return
        }
    }
}

func (s *Service) Stop() {
    close(s.done)
    s.wg.Wait()
    close(s.requests)       // BUG 2: senders may still be running
}
```

**Bug 1: it throws away queued work.** When two cases of a `select` are both ready, Go picks one *at random*. Once `done` is closed it is always ready, so a worker with 100 requests waiting in the buffer flips a coin each iteration and exits within a couple of turns. Submitting 100 requests and calling `Stop` on the machine used for this book processed **4 of them and discarded 96**. The service does not report an error. The work simply evaporates.

**Bug 2: `close(s.requests)` can panic.** `Stop` closes the channel that `Submit` sends on. A `Submit` running concurrently will panic with `send on closed channel` and take the process down. The test for this fired six panics in a single run. The general rule: only close a channel from the sending side, and never while another sender might still be running.

The correct version closes `requests` as the shutdown signal, which makes the workers' `range` loop drain the buffer to completion before exiting. A read-write mutex makes closing safe: senders hold `RLock`, so taking `Lock` guarantees no send is in flight at the moment of the close.

```go
var ErrStopped = errors.New("service stopped")

type Service struct {
    requests chan Request
    wg       sync.WaitGroup

    mu      sync.RWMutex // senders hold RLock; Stop takes Lock
    stopped bool
}

func NewService() *Service {
    s := &Service{requests: make(chan Request, 100)}

    for i := 0; i < 10; i++ {
        s.wg.Add(1)
        go s.worker()
    }

    return s
}

// range drains every buffered request, then exits when the channel closes.
func (s *Service) worker() {
    defer s.wg.Done()

    for req := range s.requests {
        process(req)
    }
}

func (s *Service) Submit(ctx context.Context, req Request) error {
    s.mu.RLock()
    defer s.mu.RUnlock()

    if s.stopped {
        return ErrStopped
    }

    select {
    case s.requests <- req:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Stop is idempotent and waits for all queued work to finish.
func (s *Service) Stop() {
    s.mu.Lock()
    if s.stopped {
        s.mu.Unlock()
        return
    }
    s.stopped = true
    close(s.requests) // safe: Lock excludes every in-flight sender
    s.mu.Unlock()

    s.wg.Wait()
}
```

Verified under `go test -race`: all 100 requests processed, no panic under concurrent `Submit` and `Stop`, and `Stop` safe to call twice.

Two properties worth naming. `Stop` here waits for queued work to *complete*, which is what you want for a job queue and what you may not want for a request server with a shutdown deadline. If you need bounded shutdown, keep this structure and add a `context` to `Stop`, then have it wait on either `wg.Wait` or the deadline. And because `Submit` holds `RLock` while it blocks on a full buffer, `Stop` waits for those senders to drain or time out, which is why every `Submit` needs a `context` with a deadline in production.

### Exercise 2: Optimize JSON Processing

**Problem:** Optimize this hot path.

```go
func ProcessJSON(data []byte) ([]Result, error) {
    var items []Item
    if err := json.Unmarshal(data, &items); err != nil {
        return nil, err
    }

    var results []Result
    for _, item := range items {
        result := Result{
            ID:   item.ID,
            Name: strings.ToUpper(item.Name),
            Data: base64.StdEncoding.EncodeToString(item.Payload),
        }
        results = append(results, result)
    }

    return results, nil
}
```

**Solution:**

```go
// Pool for reusable objects. Pool the *pointer* to the slice, never the
// slice itself, or every Put boxes the slice header and allocates.
var itemPool = sync.Pool{
    New: func() any {
        return &[]Item{}
    },
}

func ProcessJSONOptimized(data []byte) ([]Result, error) {
    // Reuse item slice
    itemsPtr := itemPool.Get().(*[]Item)
    items := *itemsPtr
    items = items[:0]
    defer func() {
        *itemsPtr = items[:0]
        itemPool.Put(itemsPtr)
    }()

    if err := json.Unmarshal(data, &items); err != nil {
        return nil, err
    }

    // Pre-allocate results
    results := make([]Result, len(items))

    for i, item := range items {
        results[i] = Result{
            ID:   item.ID,
            Name: toUpperASCII(item.Name), // Avoids allocating when already uppercase
            Data: base64.StdEncoding.EncodeToString(item.Payload),
        }
    }

    return results, nil
}

// ASCII-only uppercase (avoids allocation for ASCII strings)
func toUpperASCII(s string) string {
    hasLower := false
    for i := 0; i < len(s); i++ {
        if s[i] >= 'a' && s[i] <= 'z' {
            hasLower = true
            break
        }
    }

    if !hasLower {
        return s // Return original if no changes needed
    }

    b := make([]byte, len(s))
    for i := 0; i < len(s); i++ {
        c := s[i]
        if c >= 'a' && c <= 'z' {
            c -= 'a' - 'A'
        }
        b[i] = c
    }
    return string(b)
}
```

**Two warnings about this solution.**

First, `toUpperASCII` is not a drop-in replacement for `strings.ToUpper`. It is correct only for ASCII. It will silently leave `é` and `ß` and every non-Latin script untouched where `strings.ToUpper` would handle them. That is a deliberate trade of correctness-for-general-input against speed-on-known-input, and it is only acceptable if you actually know the field is ASCII (an ID, a currency code, a hex digest). Making this swap on user-supplied names is a bug, not an optimization. The fast path that matters most here is the `hasLower` scan, which returns the original string with zero allocation when nothing needs changing.

Second, and more instructive: an earlier draft of this solution allocated a `strings.Builder` in the loop, called `Reset` and `Grow` on it, and then never used it, because the base64 encoding went through `EncodeToString` instead. It looked like an optimization. It compiled. `go vet` said nothing, because `Reset` and `Grow` count as uses of the variable.

Measured over 100 items, that decorative builder cost **exactly 100 extra allocations per call** (597 allocs/op versus 497) and about 2.3KiB, because each `Grow` allocated a buffer that was immediately abandoned. The "optimization" was a pessimization, in the solution to an optimization exercise.

This is the chapter's thesis in miniature. The code looked plausible to a reader, to a compiler, and to a linter. Only `-benchmem` disagreed, and `-benchmem` was right. Whenever you add something for performance, benchmark the version with it against the version without it. If you cannot show a difference, remove it.

### Exercise 3: Build a Profiling Dashboard

**Problem:** Create an HTTP handler that exposes profiling data as JSON.

**Solution:**

```go
package profiling

import (
    "encoding/json"
    "net/http"
    "runtime"
    "runtime/debug"
    "slices"
    "sync"
    "time"
)

type Stats struct {
    Timestamp   time.Time `json:"timestamp"`

    // Memory
    Alloc       uint64 `json:"alloc_bytes"`
    TotalAlloc  uint64 `json:"total_alloc_bytes"`
    Sys         uint64 `json:"sys_bytes"`
    HeapAlloc   uint64 `json:"heap_alloc_bytes"`
    HeapInuse   uint64 `json:"heap_inuse_bytes"`
    HeapIdle    uint64 `json:"heap_idle_bytes"`
    HeapObjects uint64 `json:"heap_objects"`

    // GC
    NumGC       uint32        `json:"num_gc"`
    LastGC      time.Time     `json:"last_gc"`
    PauseTotal  time.Duration `json:"pause_total_ns"`
    LastPause   time.Duration `json:"last_pause_ns"`
    GCCPUFrac   float64       `json:"gc_cpu_fraction"`

    // Goroutines
    NumGoroutine int `json:"num_goroutine"`

    // CPU
    NumCPU    int `json:"num_cpu"`
    GOMAXPROCS int `json:"gomaxprocs"`
}

func CollectStats() Stats {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    var gc debug.GCStats
    debug.ReadGCStats(&gc)

    var lastPause time.Duration
    if len(gc.Pause) > 0 {
        lastPause = gc.Pause[0]
    }

    return Stats{
        Timestamp:    time.Now(),

        Alloc:        m.Alloc,
        TotalAlloc:   m.TotalAlloc,
        Sys:          m.Sys,
        HeapAlloc:    m.HeapAlloc,
        HeapInuse:    m.HeapInuse,
        HeapIdle:     m.HeapIdle,
        HeapObjects:  m.HeapObjects,

        NumGC:        m.NumGC,
        LastGC:       time.Unix(0, int64(m.LastGC)),
        PauseTotal:   time.Duration(m.PauseTotalNs),
        LastPause:    lastPause,
        GCCPUFrac:    m.GCCPUFraction,

        NumGoroutine: runtime.NumGoroutine(),

        NumCPU:       runtime.NumCPU(),
        GOMAXPROCS:   runtime.GOMAXPROCS(0),
    }
}

func StatsHandler(w http.ResponseWriter, r *http.Request) {
    stats := CollectStats()

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(stats)
}

// Time series handler.
// Record runs on a ticker goroutine and Handler runs on HTTP goroutines,
// so every access to samples must be guarded. See the notes below.
type TimeSeries struct {
    mu      sync.Mutex
    samples []Stats
    maxLen  int
}

func NewTimeSeries(maxLen int) *TimeSeries {
    return &TimeSeries{
        samples: make([]Stats, 0, maxLen),
        maxLen:  maxLen,
    }
}

func (ts *TimeSeries) Record() {
    stats := CollectStats() // collect outside the lock

    ts.mu.Lock()
    defer ts.mu.Unlock()

    if len(ts.samples) >= ts.maxLen {
        copy(ts.samples, ts.samples[1:])
        ts.samples = ts.samples[:ts.maxLen-1]
    }
    ts.samples = append(ts.samples, stats)
}

func (ts *TimeSeries) Handler(w http.ResponseWriter, r *http.Request) {
    ts.mu.Lock()
    snapshot := slices.Clone(ts.samples) // copy, then release
    ts.mu.Unlock()

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(snapshot)
}

// Dashboard HTML
func DashboardHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    w.Write([]byte(`
<!DOCTYPE html>
<html>
<head>
    <title>Profiling Dashboard</title>
</head>
<body>
    <h1>Go Application Profiling Dashboard</h1>
    <pre id="stats"></pre>

    <script>
        async function update() {
            const resp = await fetch('/debug/stats');
            const stats = await resp.json();
            document.getElementById('stats').textContent =
                JSON.stringify(stats, null, 2);
        }

        setInterval(update, 5000);
        update();
    </script>
</body>
</html>
    `))
}
```

Three things in this exercise are worth calling out, because each is a mistake that survives review easily.

**Write `</script>`, not `<\/script>`.** An earlier version of this handler used `<\/script>`, which is the escape you need inside a *JavaScript string literal* so the parser does not see a closing tag early. Inside a Go raw string literal (backticks), no escaping happens at all: the bytes `<\/script>` reach the browser exactly as written, the `<script>` element never closes, and the rest of the page becomes script content. The page renders blank. The Go compiler is perfectly happy, because a raw string can contain anything.

**`ReadMemStats` stops the world, so do not poll it aggressively.** `CollectStats` calls `runtime.ReadMemStats`, which halts every goroutine while it reads. A dashboard refreshing once per second means a stop-the-world pause every second, forever, in the service you are trying to characterize. That is observation changing the thing observed. The interval above is 5 seconds rather than 1, and for a production dashboard you should build this on `runtime/metrics` instead, which does not stop the world.

**The `TimeSeries` mutex is not optional.** `Record` runs on a ticker goroutine while `Handler` runs on HTTP goroutines, and both touch `ts.samples`. Without the mutex above this is a data race that `go test -race` reports immediately as concurrent read and write on the slice header.

Note also that `Handler` clones the slice under the lock and encodes *after* releasing it. Encoding JSON directly to a network connection while holding the mutex would block every `Record` for as long as the client takes to read the response, which a slow client can stretch indefinitely. Copy under the lock, do I/O outside it.

Finally, this dashboard exposes runtime internals and must be treated exactly like `/debug/pprof`: bound to an internal interface or behind authentication, never on your public listener.

### Senior at FAANG Track

4. **pprof infrastructure rollout.** For every service your team owns, ensure `/debug/pprof/` is exposed (behind auth). Document in the runbook. Train on-call engineers on basic diagnosis.

5. **Performance regression gate.** For one latency-critical service, add benchmark gates in CI that fail the build if a key benchmark regresses by more than X%. Document the baseline.

6. **Continuous profiling adoption.** Evaluate Pyroscope, Google Cloud Profiler, or equivalent. Pilot on one service. Document the diagnostic improvements.

### Staff / Principal Track

7. **Org performance-engineering standard.** Author the standard: what services expose, what they measure, what they monitor. Drive adoption.

8. **PGO rollout.** Identify three latency-critical services that would benefit from PGO. Establish the pipeline (collect profile, build with it, verify). Measure the latency improvement.

9. **Cost-of-compute analysis.** For five services in your org, analyze the cost structure (CPU, memory, I/O). Identify the top three services where optimization would yield the most cost savings. Propose specific investments.

10. **Performance maturity assessment.** Score each service in your org on the four-level profiling maturity model. Propose investments to move each up one level over the next year.

---
