## 16.9 Debugging Techniques

### Goroutine Dumps

Capturing a full goroutine dump with `runtime.Stack(buf, true)` writes every goroutine's stack trace into a byte buffer, which can be logged or printed without terminating the program. This is the lowest-friction way to inspect live goroutine state during debugging. The `debug.PrintStack()` variant writes only the current goroutine's stack to stderr.

```go
import "runtime/debug"

// dumpGoroutines grows the buffer until the dump fits.
//
// A fixed-size buffer is the trap here: runtime.Stack fills what you
// give it and returns n, silently TRUNCATING the rest. On the service
// that actually needs this, the one with 50,000 leaked goroutines, a
// 1MB buffer shows you the first few hundred and hides the leak.
func dumpGoroutines() string {
    size := 1 << 20
    for {
        buf := make([]byte, size)
        n := runtime.Stack(buf, true)
        if n < len(buf) {
            return string(buf[:n]) // Fit: n < size means it was not truncated
        }
        size *= 2
    }
}

// Current goroutine only, written to stderr
debug.PrintStack()
```

### pprof for Goroutines

Registering `net/http/pprof` exposes the `/debug/pprof/goroutine` endpoint, which provides goroutine profiles at two verbosity levels: `debug=1` groups goroutines by stack trace, and `debug=2` prints each goroutine individually with full state. The `go tool pprof` interactive interface adds graph and flame-chart views for identifying which call sites are responsible for the most blocked goroutines.

```go
import _ "net/http/pprof"

func main() {
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()
    // ...
}
```

```bash
# View goroutine profiles
go tool pprof http://localhost:6060/debug/pprof/goroutine

# Download and analyze
curl http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutines.txt
```

### The Mutex and Block Profiles Are Off by Default

This is the single most common way a concurrency investigation stalls, and it is worth burning into memory: **importing `net/http/pprof` does not enable the mutex or block profiles.** The endpoints exist, they return HTTP 200, and they are empty. An engineer mid-incident hits `/debug/pprof/mutex`, sees nothing, and concludes there is no lock contention. The profile was simply never recording.

Both are gated on a sampling rate that defaults to zero:

```
mutex profile records (default settings): 0
block profile records (default settings): 0
mutex profile records (after SetMutexProfileFraction): 6
block profile records (after SetBlockProfileRate): 2
```

Same contended workload in both runs. The only difference is two lines of setup, which belong in every service's `main`:

```go
func main() {
    // Sample 1 in N mutex contention events. 0 disables (the default).
    // 5 is a reasonable production value: enough signal, little overhead.
    runtime.SetMutexProfileFraction(5)

    // Sample blocking events (channel ops, select, Cond.Wait) longer
    // than N nanoseconds. 0 disables (the default).
    runtime.SetBlockProfileRate(10000) // 10µs

    go func() { log.Println(http.ListenAndServe("localhost:6060", nil)) }()
    // ...
}
```

Know what each one tells you, because they answer different questions. The **mutex** profile shows where goroutines waited on `sync.Mutex` and `sync.RWMutex`, which is your lock contention. The **block** profile shows where goroutines blocked on channel operations, `select`, and `sync.Cond`, which is your pipeline stalls. A deadlock investigation usually wants both, and the goroutine profile to see who is currently stuck.

Both cost some overhead, so tune the rates rather than leaving them maximal. Enabling them only during an incident is a trap of its own: the leak or convoy you are chasing may not reproduce on demand, and you will wish the profile had been recording all along.

### Trace for Concurrency Analysis

The `runtime/trace` package records scheduler events, goroutine creation and blocking, GC pauses, and system calls at nanosecond resolution. The resulting trace file is analyzed with `go tool trace`, which renders a timeline view that makes goroutine scheduling delays, contention hot spots, and lock convoy effects visually apparent.

```go
import "runtime/trace"

func main() {
    f, _ := os.Create("trace.out")
    trace.Start(f)
    defer trace.Stop()

    // Your code
}
```

```bash
go tool trace trace.out
```

### Delve Debugger

Delve is a Go-aware debugger that understands goroutines as first-class objects, unlike `gdb` which treats them as raw OS threads and cannot map them back to Go source. The `goroutines` command lists every goroutine with its current function and status, and `goroutine N` switches the debugging context to goroutine `N` so you can inspect its stack frame and local variables, a critical capability when diagnosing deadlocks or unexpected blocking in a concurrent program.

```bash
# Start debugging
dlv debug main.go

# Commands
(dlv) goroutines       # List all goroutines
(dlv) goroutine 5      # Switch to goroutine 5
(dlv) stack            # Show stack trace
(dlv) threads          # List OS threads
```

### Scheduler Tracing

`GODEBUG=schedtrace=1000` prints a one-line scheduler summary every 1000 ms showing the number of goroutines, threads, idle Ps, and work-steal counts. Adding `scheddetail=1` expands this to per-goroutine and per-P state, which is useful for diagnosing scheduler stalls where goroutines are runnable but not being scheduled.

```bash
GODEBUG=schedtrace=1000,scheddetail=1 ./myapp
```

The output line includes several fields that reveal scheduler health:

- **Goroutine states**, how many are runnable, running, or waiting
- **P (processor) assignments**, which logical processors are active or idle
- **Work stealing activity**, how often idle Ps steal runnable goroutines from busy Ps, indicating load imbalance

### The Production Debugging Toolkit

Every production Go service should expose:

1. **`net/http/pprof` endpoint** at `/debug/pprof/` (behind auth, never public).
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
