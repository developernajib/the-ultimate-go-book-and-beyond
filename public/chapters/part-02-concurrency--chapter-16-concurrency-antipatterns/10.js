export default `## 16.9 Debugging Techniques

### Goroutine Dumps

Capturing a full goroutine dump with \`runtime.Stack(buf, true)\` writes every goroutine's stack trace into a byte buffer, which can be logged or printed without terminating the program. This is the lowest-friction way to inspect live goroutine state during debugging. The \`debug.PrintStack()\` variant writes only the current goroutine's stack to stderr.

\`\`\`go
import "runtime/debug"

func dumpGoroutines() {
    buf := make([]byte, 1024*1024)
    n := runtime.Stack(buf, true)
    fmt.Printf("=== GOROUTINES ===\\n%s\\n", buf[:n])
}

// Or with debug package
debug.PrintStack()
\`\`\`

### pprof for Goroutines

Registering \`net/http/pprof\` exposes the \`/debug/pprof/goroutine\` endpoint, which provides goroutine profiles at two verbosity levels: \`debug=1\` groups goroutines by stack trace, and \`debug=2\` prints each goroutine individually with full state. The \`go tool pprof\` interactive interface adds graph and flame-chart views for identifying which call sites are responsible for the most blocked goroutines.

\`\`\`go
import _ "net/http/pprof"

func main() {
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()
    // ...
}
\`\`\`

\`\`\`bash
# View goroutine profiles
go tool pprof http://localhost:6060/debug/pprof/goroutine

# Download and analyze
curl http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutines.txt
\`\`\`

### Trace for Concurrency Analysis

The \`runtime/trace\` package records scheduler events, goroutine creation and blocking, GC pauses, and system calls at nanosecond resolution. The resulting trace file is analyzed with \`go tool trace\`, which renders a timeline view that makes goroutine scheduling delays, contention hot spots, and lock convoy effects visually apparent.

\`\`\`go
import "runtime/trace"

func main() {
    f, _ := os.Create("trace.out")
    trace.Start(f)
    defer trace.Stop()

    // Your code
}
\`\`\`

\`\`\`bash
go tool trace trace.out
\`\`\`

### Delve Debugger

Delve is a Go-aware debugger that understands goroutines as first-class objects, unlike \`gdb\` which treats them as raw OS threads and cannot map them back to Go source. The \`goroutines\` command lists every goroutine with its current function and status, and \`goroutine N\` switches the debugging context to goroutine \`N\` so you can inspect its stack frame and local variables, a critical capability when diagnosing deadlocks or unexpected blocking in a concurrent program.

\`\`\`bash
# Start debugging
dlv debug main.go

# Commands
(dlv) goroutines       # List all goroutines
(dlv) goroutine 5      # Switch to goroutine 5
(dlv) stack            # Show stack trace
(dlv) threads          # List OS threads
\`\`\`

### Scheduler Tracing

\`GODEBUG=schedtrace=1000\` prints a one-line scheduler summary every 1000 ms showing the number of goroutines, threads, idle Ps, and work-steal counts. Adding \`scheddetail=1\` expands this to per-goroutine and per-P state, which is useful for diagnosing scheduler stalls where goroutines are runnable but not being scheduled.

\`\`\`bash
GODEBUG=schedtrace=1000,scheddetail=1 ./myapp
\`\`\`

The output line includes several fields that reveal scheduler health:

- **Goroutine states**, how many are runnable, running, or waiting
- **P (processor) assignments**, which logical processors are active or idle
- **Work stealing activity**, how often idle Ps steal runnable goroutines from busy Ps, indicating load imbalance

### The Production Debugging Toolkit

Every production Go service should expose:

1. **\`net/http/pprof\` endpoint** at \`/debug/pprof/\` (behind auth, never public).
2. **Runtime metrics** via Prometheus (goroutines, GC pauses, heap, threads).
3. **Structured logging** with trace correlation IDs.
4. **Distributed tracing** (OpenTelemetry) across service boundaries.

With these in place, a production concurrency incident has concrete data to diagnose:

- Goroutine count trend shows leaks.
- pprof goroutine dump shows where leaked goroutines are blocked.
- pprof mutex profile shows contention hot spots.
- Tracing shows which request paths are slow.
- Structured logs correlate errors across goroutines via request ID.

Without these, the incident is blind guesswork. Make them non-negotiable for every production service.

### Staff Lens: Debugging Is a Runbook Discipline

When an incident happens, on-call engineers need a runbook. "Concurrency bug suspected" should map to specific diagnostic steps: capture goroutine dump, compare to baseline, bucket by stack, identify leak. Without the runbook, each incident is rediscovered from scratch. With it, triage is minutes instead of hours.

---
`;
