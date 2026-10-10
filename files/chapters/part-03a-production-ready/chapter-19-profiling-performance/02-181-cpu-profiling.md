## 19.1 CPU Profiling

### The Philosophy of CPU Profiling

CPU profiling answers the question: "Where is my program spending time?" The Go runtime samples the call stack at regular intervals (100Hz by default) to build a statistical picture of CPU usage. While not perfectly accurate for short-running programs, it's highly effective for identifying hotspots.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          CPU PROFILE SAMPLING                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Program Execution Timeline:                                                    │
│  ├─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┤                  │
│  │ A   │ B   │ A   │ C   │ A   │ A   │ D   │ A   │ B   │ A   │                  │
│  ├─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┤                  │
│  │     │     │     │     │     │     │     │     │     │     │                  │
│  │     ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼                  │
│  │   Sample points (every 10ms)                                                 │
│                                                                                 │
│  Profile Results:                                                               │
│  ┌─────────────────────────────────────────┐                                    │
│  │ Function A: 60% of samples (6/10)       │ ← HOT PATH                         │
│  │ Function B: 20% of samples (2/10)       │                                    │
│  │ Function C: 10% of samples (1/10)       │                                    │
│  │ Function D: 10% of samples (1/10)       │                                    │
│  └─────────────────────────────────────────┘                                    │
│                                                                                 │
│  IMPORTANT: Samples include entire call stack, so parent functions              │
│  accumulate time from their children (cumulative vs flat time)                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Enabling CPU Profiling

The `runtime/pprof` package exposes direct control over profile collection: you call `pprof.StartCPUProfile` with an `io.Writer` and the runtime begins sampling, then `pprof.StopCPUProfile` flushes the remaining samples and closes the profile. Using `defer` for both `f.Close()` and `StopCPUProfile` ensures the profile file is always finalized even if `runWorkload` panics.

```go
import "runtime/pprof"

func main() {
    f, err := os.Create("cpu.prof")
    if err != nil {
        log.Fatal(err)
    }
    defer f.Close()

    if err := pprof.StartCPUProfile(f); err != nil {
        log.Fatal(err)
    }
    defer pprof.StopCPUProfile()

    // Your program runs here
    runWorkload()
}
```

### HTTP pprof Endpoint

Importing `net/http/pprof` as a blank import registers a set of HTTP handlers under `/debug/pprof/` as a side effect, giving you on-demand access to CPU, heap, goroutine, and other profiles from a live process without restarting it. Running the server in a separate goroutine keeps the profiling endpoint available continuously so you can capture profiles at any point during production-like load.

```go
import _ "net/http/pprof"

func main() {
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()

    // Your program runs here
}
```

Access profiles at:
- `http://localhost:6060/debug/pprof/`
- `http://localhost:6060/debug/pprof/profile?seconds=30`

> **Security: never expose pprof on a public port.** The blank import registers those handlers on `http.DefaultServeMux` as a side effect. If your application also serves its real traffic on the `DefaultServeMux` (that is, it passes `nil` as the handler to `ListenAndServe`), then importing the package anywhere in your dependency tree publishes `/debug/pprof/` on your public listener. Nobody has to write a line of code for this to happen.
>
> That is a genuine vulnerability, not a hygiene nit. `/debug/pprof/cmdline` leaks your full command line and its flags, which frequently contain credentials. `/debug/pprof/heap` leaks live heap contents, which can include tokens, keys, and user data. `/debug/pprof/profile` will happily burn 30 seconds of CPU on every concurrent request, which makes it a free denial-of-service amplifier. `/debug/pprof/goroutine?debug=2` dumps every stack trace in the process.
>
> Two rules keep you safe. First, bind the profiling server to `localhost` (as above) or to an internal-only interface, and reach it through an SSH tunnel or your service mesh rather than the internet. Second, never serve production traffic on the `DefaultServeMux`. Give your application its own explicit `http.ServeMux` so that a blank import cannot leak anything into it:
>
> ```go
> // Application traffic: its own mux, no pprof handlers on it.
> appMux := http.NewServeMux()
> appMux.HandleFunc("/api/", handleAPI)
> go http.ListenAndServe(":8080", appMux)
>
> // Profiling: DefaultServeMux, bound to loopback only.
> go http.ListenAndServe("localhost:6060", nil)
> ```
>
> If you genuinely need profiles from a remote host without a tunnel, put the endpoint behind authentication and an allowlist, and treat it with the same care as an admin interface.

### Analyzing CPU Profile

`go tool pprof` accepts both local `.prof` files and live HTTP endpoints, making it equally useful for post-mortem analysis and real-time investigation of a running service. The `-http` flag starts a local web server that renders interactive flame graphs, call trees, and source annotations, a much faster way to navigate a large profile than the text-based interactive shell.

```bash
# Interactive mode
go tool pprof cpu.prof

# Web UI
go tool pprof -http=:8080 cpu.prof

# From running process
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
```

### Common pprof Commands

Once inside the interactive `pprof` shell, `top10` gives an immediate ranked view of the most expensive functions measured by flat (self) CPU time, while `top -cum` sorts by cumulative time to expose functions that are cheap themselves but call expensive children. The `list FuncName` command is particularly valuable because it annotates each line of source code with its measured CPU cost, pinpointing the exact statement to optimize.

```
(pprof) top10          # Top 10 functions by CPU
(pprof) top -cum       # Top by cumulative time
(pprof) list FuncName  # Show annotated source
(pprof) web            # Open graph in browser
(pprof) svg            # Generate SVG graph
```

### Flame Graphs Are Usually the Right View

The `web` command opens a graph. The `-http` interface opens flame graphs. Flame graphs are usually easier to read than top lists: they show the call hierarchy and where time accumulates. Start there.

### Staff Lens: CPU Profile Reading Is a Skill

Reading profiles is a learned skill. Most engineers are not good at it. Staff engineers should train the team: walk through a real profile in a team session, explain what each view shows, practice on real workloads. The skill compounds: once half the team reads profiles fluently, performance investigations become collaborative instead of bottlenecked on specialists.

---
