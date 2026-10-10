## 19.4 Trace Analysis

### Recording a Trace

The `runtime/trace` package records a time-stamped event log of scheduler decisions, goroutine state transitions, garbage collection phases, and system calls. Starting the tracer at the top of `main` and stopping it via `defer` ensures the full program lifecycle is captured, including startup costs that CPU profiles often miss.

```go
import (
    "log"
    "os"
    "runtime/trace"
)

func main() {
    f, err := os.Create("trace.out")
    if err != nil {
        log.Fatal(err)
    }
    defer f.Close()

    if err := trace.Start(f); err != nil {
        log.Fatal(err)
    }
    defer trace.Stop()

    // Your program runs here
}
```

### Analyzing Trace

`go tool trace` opens an interactive web UI that visualizes the trace data as a timeline. Each goroutine appears as a horizontal lane showing its state transitions, running, runnable, waiting, overlaid with GC events and system call blocks. This view exposes problems that CPU profiles miss entirely, such as goroutines starved for scheduling time or GC pauses that coincide with latency spikes.

```bash
go tool trace trace.out
```

If the process already exposes `net/http/pprof`, you do not need to add tracing code to capture a trace from it. The same endpoint set includes a trace handler, which is usually how you grab one from a live service:

```bash
curl -o trace.out 'http://localhost:6060/debug/pprof/trace?seconds=5'
```

Keep that duration short. Unlike a CPU profile, which samples at a fixed 100Hz regardless of how busy the process is, a trace records *every* scheduler event, so its cost and its output size both scale with how much your program actually does. A few seconds from a busy service is normal. A few minutes is a file too large to open comfortably, gathered at a cost you did not intend to pay in production. Capture a narrow window around the behavior you are investigating.

The trace viewer provides several analysis views:
- **Goroutine analysis**, execution time, scheduling latency, and blocking durations per goroutine
- **Network blocking**, time spent waiting on network I/O
- **Syscall blocking**, time lost to blocking system calls
- **Scheduler latency**, delay between a goroutine becoming runnable and actually running
- **User-defined tasks**, custom annotations that map application concepts to trace events

### User Annotations

User annotations let you embed application-level semantics directly into the execution trace, so the viewer can correlate high-level operations like "processRequest" with the underlying scheduler and GC events. Tasks group related regions across goroutine boundaries, while `trace.WithRegion` marks discrete phases, such as a database query or a compute step, allowing you to measure each phase's latency in the trace viewer's task timeline.

```go
ctx, task := trace.NewTask(context.Background(), "processRequest")
defer task.End()

trace.WithRegion(ctx, "database", func() {
    queryDatabase()
})

trace.WithRegion(ctx, "compute", func() {
    processData()
})
```

### When to Reach for Trace Instead of pprof

pprof shows cumulative time, trace shows the timeline. Use trace when:

- You need to understand goroutine interactions (lock contention, channel blocking).
- You are diagnosing latency (why did this specific request take 500ms?).
- GC pauses are suspected.
- Concurrency is the issue, not CPU usage.

Use pprof when you need to know what code is running. Use trace when you need to know when and why.

### Staff Lens: Trace Is a Specialist Tool

Most performance work can be done with pprof alone. Trace is a specialist tool for specific questions. When a team member reaches for trace, there should be a specific question it answers. "Let me look at the trace" as a general approach usually means the person does not know what they are looking for.

---
