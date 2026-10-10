## 83C.11 Mock Go-Specific Technical Deep Dive

### Interviewer Briefing

**Company style:** Go-focused team (senior/staff hire screen). This interview evaluates deep Go runtime knowledge, debugging skills, and design ability. The candidate is expected to demonstrate production experience with Go, not just textbook knowledge. Each section is 10-12 minutes.

### Section 1: Explain Garbage Collector Internals (10 minutes)

*Interviewer says:* "Walk me through how Go's garbage collector works. What are the key phases, and how does it minimize stop-the-world pauses?"

**What a strong candidate says:**

"Go uses a concurrent, tri-color mark-and-sweep garbage collector. Let me walk through the phases:

**1. Mark Setup (STW - Stop The World, ~10-30 microseconds):**
All goroutines are paused. The GC enables write barriers and prepares for the marking phase. This is extremely brief.

**2. Concurrent Marking:**
The GC resumes all goroutines and begins marking. It uses a tri-color abstraction:
- **White:** Not yet visited (potentially garbage)
- **Grey:** Visited but children not yet scanned
- **Black:** Visited and all children scanned

The GC starts by coloring all root objects (globals, stack variables, registers) gray. It then processes gray objects: scan their references, color referenced objects gray, then color the original object black. The write barrier is crucial here - if a running goroutine modifies a pointer, the write barrier ensures the referenced object is colored gray, preventing the GC from missing live objects. Go uses a hybrid write barrier (combining Dijkstra's insertion barrier and Yuasa's deletion barrier) since Go 1.8, which eliminated the need for stack re-scanning.

**3. Mark Termination (STW, ~10-60 microseconds):**
A brief pause to finish any remaining marking work, disable write barriers, and prepare for sweeping.

**4. Concurrent Sweeping:**
Unreachable (white) objects are freed. This happens concurrently with application execution. Sweeping is done lazily - memory is reclaimed as new allocations need it.

**Key design decisions that minimize latency:**
- Target pause time: Go aims for sub-millisecond STW pauses (typically 10-100 microseconds)
- Pacing: The GC pacer decides when to start a GC cycle based on heap growth. The `GOGC` environment variable (default 100) controls the heap growth trigger - GC starts when the heap has grown 100% since the last collection
- Work stealing: GC marking work is distributed across available Ps (processor cores), using a work-stealing scheduler similar to the goroutine scheduler
- Assists: If the application is allocating faster than the GC can mark, goroutines are forced to assist with GC work before their allocations proceed - this prevents the heap from growing unboundedly

**Trade-offs:**
- Go prioritizes latency over throughput. The concurrent GC uses ~25% of CPU during marking. A stop-the-world compacting GC (like Java's) could reclaim memory more efficiently but with longer pauses.
- No compaction: Go's GC doesn't compact the heap, which means memory fragmentation can be an issue for long-running services with variable allocation patterns. The allocator (based on tcmalloc) mitigates this with size classes."

*Follow-up:* "How would you tune GC for a latency-sensitive service vs. a batch processing service?"

**Strong answer:**

"For a latency-sensitive service: lower `GOGC` (e.g., 50) to trigger GC more frequently with smaller heaps, reducing individual GC cycle work. Use `debug.SetGCPercent()` at runtime. Also consider using `sync.Pool` for frequently allocated objects to reduce allocation pressure. Pre-allocate slices and maps where sizes are predictable.

For batch processing: raise `GOGC` (e.g., 200-400) or use `GOMEMLIMIT` to let the heap grow larger, reducing GC frequency. Batch processing cares about throughput, not individual pause times. In extreme cases, use `debug.SetGCPercent(-1)` to disable automatic GC and call `runtime.GC()` manually between batches."

### Section 2: Debug a Goroutine Leak in Production (10 minutes)

*Interviewer says:* "Your production Go service is slowly consuming more memory. You suspect a goroutine leak. Walk me through how you'd diagnose and fix this."

**What a strong candidate says:**

"Goroutine leaks are one of the most common production issues in Go services. Here's my systematic approach:

**Step 1: Confirm the leak.**

Add a pprof endpoint if it's not already present:

```go
import _ "net/http/pprof"

// In main or init:
go func() {
    log.Println(http.ListenAndServe(":6060", nil))
}()
```

Then monitor goroutine count over time:

```bash
# Get current goroutine count
curl http://service:6060/debug/pprof/goroutine?debug=1 | head -1

# Get full goroutine dump
curl http://service:6060/debug/pprof/goroutine?debug=2 > goroutines.txt
```

If goroutine count is steadily increasing (e.g., 100 new goroutines per minute with none terminating), we have a leak.

**Step 2: Identify the leaking goroutine.**

The goroutine profile groups goroutines by their creation stack trace. Look for groups with abnormally high counts:

```bash
go tool pprof http://service:6060/debug/pprof/goroutine
(pprof) top
(pprof) traces
```

This shows which function is spawning goroutines that aren't terminating. Common culprits:

**Pattern A: Unbounded channel send with no receiver.**
```go
// LEAK: if nobody reads from ch, this goroutine blocks forever
go func() {
    ch <- result
}()
```

Fix: use a buffered channel of size 1 or select with context:
```go
go func() {
    select {
    case ch <- result:
    case <-ctx.Done():
    }
}()
```

**Pattern B: Missing context cancellation.**
```go
// LEAK: if parent doesn't cancel ctx, this goroutine runs forever
go func() {
    for {
        select {
        case <-ctx.Done():
            return
        case <-time.After(1 * time.Second):
            doWork()
        }
    }
}()
```

Fix: ensure the context is properly canceled when the parent scope exits. Use `defer cancel()` after `context.WithCancel()`.

**Pattern C: HTTP response body not closed.**
```go
resp, err := http.Get(url)
if err != nil {
    return err
}
// LEAK: if body is not closed, the transport goroutine hangs
// Fix: defer resp.Body.Close()
```

**Pattern D: Ticker not stopped.**
```go
ticker := time.NewTicker(1 * time.Second)
// LEAK: if ticker.Stop() is never called, it keeps firing
// Fix: defer ticker.Stop()
```

**Step 3: Fix and verify.**

After identifying the pattern, fix it, deploy to staging, and run a load test while monitoring goroutine count. The count should stabilize. I'd also add a runtime metric for goroutine count to our monitoring dashboard:

```go
// Report goroutine count to Prometheus
go func() {
    gauge := prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "go_goroutines_active",
        Help: "Number of active goroutines",
    })
    prometheus.MustRegister(gauge)

    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        gauge.Set(float64(runtime.NumGoroutine()))
    }
}()
```

**Step 4: Prevent future leaks.**

Add `goleak` (from Uber) to test suites - it detects goroutine leaks in tests:

```go
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

Also, I establish a team convention: every `go func()` must have a clear termination condition, usually a context or a done channel."

### Section 3: Optimize a Hot Path with Profiling (10 minutes)

*Interviewer says:* "Your Go service's API endpoint has a p99 latency of 200ms and you need it under 50ms. Walk me through your profiling and optimization approach."

**What a strong candidate says:**

"Here's my systematic approach:

**Step 1: CPU Profile to find the bottleneck.**

```bash
# Collect a 30-second CPU profile during production load
curl http://service:6060/debug/pprof/profile?seconds=30 > cpu.prof
go tool pprof -http=:8080 cpu.prof
```

In the flame graph, I look for the widest bars - those are the functions consuming the most CPU time in the hot path.

**Step 2: Common Go-specific optimizations I'd look for:**

**Memory allocations on the hot path.** Each allocation is a potential GC trigger. Use `go test -bench -benchmem` and `pprof -alloc_space`:

```go
package main

import (
    "bytes"
    "strings"
    "sync"
)

var preallocatedSlice []string
func parseItems(data []byte) []string { return nil }
func transform(item string) string { return item }
func parseItemsInto(data []byte, slice []string) []string { return nil }

// BEFORE: allocates on every call
func processRequest(data []byte) string {
    var result []string // allocates
    for _, item := range parseItems(data) { // parseItems allocates
        result = append(result, transform(item)) // append may allocate
    }
    return strings.Join(result, ",") // allocates
}

// AFTER: pre-allocate, reuse buffers
var bufPool = sync.Pool{
    New: func() any {
        return &bytes.Buffer{}
    },
}

func processRequestOptimized(data []byte) string {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufPool.Put(buf)
    }()

    items := parseItemsInto(data, preallocatedSlice)
    for i, item := range items {
        if i > 0 {
            buf.WriteByte(',')
        }
        buf.WriteString(transform(item))
    }
    return buf.String()
}
```

**String concatenation.** Use `strings.Builder` or `bytes.Buffer` instead of `+` or `fmt.Sprintf` in loops.

**Reflection.** `encoding/json` uses reflection. For hot paths, switch to code-generated serialization (`easyjson`, `ffjson`) or a binary format like Protocol Buffers.

**Map access patterns.** If the map is read-heavy with rare writes, use `sync.RWMutex` instead of `sync.Mutex`, or use `sync.Map` if keys are stable. For small maps with known keys, consider a struct with named fields.

**Interface dispatch.** In extremely hot loops, interface method calls have overhead from indirect dispatch. If the concrete type is always the same, use the concrete type directly.

**Step 3: Verify with benchmarks.**

```go
func BenchmarkProcessRequest(b *testing.B) {
    data := loadTestData()
    b.ResetTimer()
    b.ReportAllocs()
    for b.Loop() {
        processRequest(data)
    }
}
```

Run before and after with `benchstat` to confirm the improvement is statistically significant:

```bash
go test -bench=BenchmarkProcessRequest -count=10 > old.txt
# Apply optimization
go test -bench=BenchmarkProcessRequest -count=10 > new.txt
benchstat old.txt new.txt
```

**Step 4: Trace for latency analysis.**

CPU profiles show CPU-bound work, but latency issues are often I/O-bound. Use `runtime/trace`:

```bash
curl http://service:6060/debug/pprof/trace?seconds=5 > trace.out
go tool trace trace.out
```

The trace viewer shows goroutine scheduling, network I/O waits, and GC pauses on a timeline. If the hot path is blocked on a database call, no amount of CPU optimization will help - I need to optimize the query or add caching."

### Section 4: Design an Interface-Based Plugin System (12 minutes)

*Interviewer says:* "Design a plugin system for a Go application where plugins can be loaded and executed at runtime. The plugins should be type-safe and testable."

**What a strong candidate says:**

"Let me design a plugin system for a concrete use case - say, a data processing pipeline where plugins transform data. Here's my approach:

**Core interface design:**

```go
package plugin

import (
    "context"
    "time"
)

// Processor is the core plugin interface.
// Each plugin processes a record and returns the transformed record
// or an error.
type Processor interface {
    // Name returns the unique identifier for this plugin.
    Name() string

    // Init is called once when the plugin is loaded.
    // Config is plugin-specific configuration.
    Init(ctx context.Context, config map[string]any) error

    // Process transforms a single record.
    Process(ctx context.Context, record *Record) (*Record, error)

    // Close releases any resources held by the plugin.
    Close() error
}

// Record represents a unit of data flowing through the pipeline.
type Record struct {
    Key       string
    Value     []byte
    Metadata  map[string]string
    Timestamp time.Time
}
```

**Plugin registry with compile-time safety:**

```go
package plugin

import (
    "fmt"
    "sync"
)

// Registry manages available plugins.
type Registry struct {
    mu       sync.RWMutex
    creators map[string]func() Processor
}

func NewRegistry() *Registry {
    return &Registry{
        creators: make(map[string]func() Processor),
    }
}

// Register adds a plugin factory to the registry.
// This is typically called in init() functions.
func (r *Registry) Register(name string, creator func() Processor) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if _, exists := r.creators[name]; exists {
        panic(fmt.Sprintf("plugin %q already registered", name))
    }
    r.creators[name] = creator
}

// Create instantiates a plugin by name.
func (r *Registry) Create(name string) (Processor, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    creator, ok := r.creators[name]
    if !ok {
        return nil, fmt.Errorf("unknown plugin: %s", name)
    }
    return creator(), nil
}

// Global registry for convenience.
var DefaultRegistry = NewRegistry()
```

**Example plugin implementation:**

```go
package plugins

import (
    "context"
    "fmt"
    "strings"

    "myapp/plugin"
)

func init() {
    plugin.DefaultRegistry.Register("uppercase", func() plugin.Processor {
        return &UppercasePlugin{}
    })
}

type UppercasePlugin struct {
    fields []string // which fields to uppercase
}

func (p *UppercasePlugin) Name() string { return "uppercase" }

func (p *UppercasePlugin) Init(_ context.Context, config map[string]any) error {
    fieldsRaw, ok := config["fields"]
    if !ok {
        return fmt.Errorf("uppercase plugin requires 'fields' config")
    }

    fieldsSlice, ok := fieldsRaw.([]any)
    if !ok {
        return fmt.Errorf("'fields' must be an array")
    }

    for _, f := range fieldsSlice {
        s, ok := f.(string)
        if !ok {
            return fmt.Errorf("each field must be a string")
        }
        p.fields = append(p.fields, s)
    }
    return nil
}

func (p *UppercasePlugin) Process(_ context.Context, record *plugin.Record) (*plugin.Record, error) {
    for _, field := range p.fields {
        if val, ok := record.Metadata[field]; ok {
            record.Metadata[field] = strings.ToUpper(val)
        }
    }
    return record, nil
}

func (p *UppercasePlugin) Close() error { return nil }
```

**Pipeline that chains plugins:**

```go
package pipeline

import (
    "context"
    "fmt"

    "myapp/plugin"
)

// Pipeline chains multiple processors together.
type Pipeline struct {
    processors []plugin.Processor
}

// NewPipeline creates a pipeline from a configuration.
func NewPipeline(ctx context.Context, registry *plugin.Registry, configs []PluginConfig) (*Pipeline, error) {
    var processors []plugin.Processor

    for _, cfg := range configs {
        proc, err := registry.Create(cfg.Name)
        if err != nil {
            // Clean up already-initialized processors
            for _, p := range processors {
                p.Close()
            }
            return nil, fmt.Errorf("creating plugin %s: %w", cfg.Name, err)
        }

        if err := proc.Init(ctx, cfg.Config); err != nil {
            for _, p := range processors {
                p.Close()
            }
            return nil, fmt.Errorf("initializing plugin %s: %w", cfg.Name, err)
        }

        processors = append(processors, proc)
    }

    return &Pipeline{processors: processors}, nil
}

// Execute runs a record through all processors in order.
func (p *Pipeline) Execute(ctx context.Context, record *plugin.Record) (*plugin.Record, error) {
    var err error
    for _, proc := range p.processors {
        record, err = proc.Process(ctx, record)
        if err != nil {
            return nil, fmt.Errorf("plugin %s: %w", proc.Name(), err)
        }
    }
    return record, nil
}

// Close shuts down all plugins in reverse order.
func (p *Pipeline) Close() error {
    var firstErr error
    for i := len(p.processors) - 1; i >= 0; i-- {
        if err := p.processors[i].Close(); err != nil && firstErr == nil {
            firstErr = err
        }
    }
    return firstErr
}

type PluginConfig struct {
    Name   string
    Config map[string]any
}
```

**Testing with mock plugins:**

```go
package pipeline_test

import (
    "context"
    "testing"

    "myapp/plugin"
    "myapp/pipeline"
)

// MockProcessor implements plugin.Processor for testing.
type MockProcessor struct {
    name       string
    initErr    error
    processErr error
    processFn  func(*plugin.Record) *plugin.Record
    closed     bool
}

func (m *MockProcessor) Name() string { return m.name }
func (m *MockProcessor) Init(_ context.Context, _ map[string]any) error {
    return m.initErr
}
func (m *MockProcessor) Process(_ context.Context, r *plugin.Record) (*plugin.Record, error) {
    if m.processErr != nil {
        return nil, m.processErr
    }
    if m.processFn != nil {
        return m.processFn(r), nil
    }
    return r, nil
}
func (m *MockProcessor) Close() error {
    m.closed = true
    return nil
}

func TestPipelineExecutesInOrder(t *testing.T) {
    var order []string

    registry := plugin.NewRegistry()
    registry.Register("first", func() plugin.Processor {
        return &MockProcessor{
            name: "first",
            processFn: func(r *plugin.Record) *plugin.Record {
                order = append(order, "first")
                return r
            },
        }
    })
    registry.Register("second", func() plugin.Processor {
        return &MockProcessor{
            name: "second",
            processFn: func(r *plugin.Record) *plugin.Record {
                order = append(order, "second")
                return r
            },
        }
    })

    p, err := pipeline.NewPipeline(context.Background(), registry, []pipeline.PluginConfig{
        {Name: "first"},
        {Name: "second"},
    })
    if err != nil {
        t.Fatal(err)
    }
    defer p.Close()

    record := &plugin.Record{Key: "test", Value: []byte("data")}
    _, err = p.Execute(context.Background(), record)
    if err != nil {
        t.Fatal(err)
    }

    if len(order) != 2 || order[0] != "first" || order[1] != "second" {
        t.Errorf("expected [first, second], got %v", order)
    }
}
```

**Design principles I followed:**

1. **Interface Segregation:** `Processor` has only the methods needed. I didn't put `Register` on the plugin interface.
2. **Dependency Inversion:** `Pipeline` depends on the `Processor` interface, not concrete plugins. Plugins are injected via the registry.
3. **Open-Closed:** New plugins can be added by implementing `Processor` and registering - no modification to Pipeline needed.
4. **Testability:** Every component is testable in isolation using mock implementations of the interface.
5. **Resource management:** `Close()` in reverse order mirrors the initialization order, similar to `defer` semantics."


### Junior → FAANG: Go Technical Deep-Dive Mock Basics

A Go-specific technical deep dive evaluates your depth in the language runtime, type system, and concurrency model. Entry-level questions probe: goroutine scheduling model (M:N threading, GOMAXPROCS), memory model (what guarantees does the Go memory model provide for shared variable access across goroutines), interface satisfaction (how does the compiler determine if a type satisfies an interface), and slice internals (backing array, len, cap, and the aliasing behavior of slices created from the same array). Know these mechanics, not just the syntax.

### Senior @ FAANG: Go Deep-Dive at the L5/L6 Bar: Runtime Internals and Production Debugging

At the L5/L6 level, the Go technical deep dive tests production-grade knowledge: reading and interpreting pprof profiles (heap, CPU, goroutine, mutex), understanding garbage collector behavior and tuning (GOGC, GOMEMLIMIT, GC pause patterns), diagnosing goroutine leaks from goroutine dumps, and understanding the runtime's scheduler behavior under high goroutine counts. Bar-raisers ask about escape analysis: why does allocating a struct and assigning it to an interface cause the struct to escape to the heap, and what is the performance implication? They also probe the reflect package performance cost: why is reflect slow, when is it justified, and what are the alternatives (type assertions, code generation). Staff-level Go knowledge also includes the module system governance: when to use replace directives, how to manage multi-module workspaces, and how to audit third-party dependencies for security vulnerabilities.

---
