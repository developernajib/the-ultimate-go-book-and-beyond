## 25.9 Performance Analysis

### pprof Integration

Generating CPU and memory profiles during benchmark runs captures realistic workloads rather than synthetic micro-benchmarks in isolation. The `-http` flag launches a browser-accessible flame graph viewer directly from `go tool pprof`, making it easy to visually identify the functions consuming the most time or allocating the most memory without memorizing `pprof` commands.

```bash
# Generate CPU profile from one package's benchmarks.
# The profile flags take a SINGLE package: with `./...` the go command
# refuses outright ("cannot use -cpuprofile flag with multiple packages"),
# because one profile file cannot hold several test binaries' output.
go test -cpuprofile=cpu.prof -bench=. ./internal/parser

# Generate memory profile
go test -memprofile=mem.prof -bench=. ./internal/parser

# Analyze profile
go tool pprof cpu.prof

# Web UI (lands on the flame graph)
go tool pprof -http=:8080 cpu.prof
```

### Trace Analysis

The execution tracer records goroutine scheduling events, GC phases, and system calls at nanosecond granularity. Unlike pprof, which shows aggregate time, the trace viewer shows the exact timeline of what each goroutine and OS thread was doing, making it the right tool for diagnosing scheduler latency, GC stop-the-world pauses, or goroutine blocking cascades.

```bash
# Generate trace from test
go test -trace=trace.out ./...

# View trace
go tool trace trace.out

# Generate trace programmatically
import "runtime/trace"
trace.Start(file)
defer trace.Stop()
```

### Escape Analysis

The compiler's escape analysis determines whether a variable can live on the goroutine's stack (zero allocation) or must be promoted to the heap (GC pressure). Passing `-gcflags="-m"` during a build prints each allocation decision inline. Identifying values that escape to the heap unexpectedly, often due to interface conversions or closures, is the first step in reducing allocation-driven GC pressure.

```bash
# Show escape analysis and inlining decisions
go build -gcflags="-m" ./...

# More verbose: -m -m explains WHY a value escapes, which is the part you
# actually need to fix it
go build -gcflags="-m -m" ./...

# Analyze one package only, without the noise of its dependencies
go build -gcflags="-m=2" ./internal/parser
```

One flag to read carefully: `-l` **disables** inlining (`go tool compile -h` says so in as many words). It does not reveal more optimizations, it removes one. Add it to `-m` and the "can inline foo" lines simply disappear, and the escape decisions you see are those of a program the compiler deliberately pessimized. That makes `-gcflags="-m -l"` useful for isolating escape analysis from inlining effects while you reason about a single function, and actively misleading if you read the result as what your shipped binary does. For the real picture, leave `-l` off.

Remember too that `-gcflags` applies to the packages matched by the build pattern, not the whole program, unless you prefix it with `all=`. `-gcflags="-m"` on `./...` reports on your code, `-gcflags="all=-m"` drags in the standard library and buries you.

### Staff Lens: Escape Analysis on Hot Paths

For measurably-hot code, run escape analysis and understand where allocations happen. Redesigning to keep values on the stack eliminates GC pressure without changing algorithm.

---
