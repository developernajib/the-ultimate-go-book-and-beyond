## Exercises

1. **CPU Profiling with pprof**: Add an HTTP pprof endpoint to an existing Go HTTP server using `net/http/pprof`. Write a load-generating test that hits the server for 30 seconds, then collect a 20-second CPU profile with `go tool pprof`. Identify the top three CPU-consuming functions in the flame graph and explain what each is doing. Your solution should demonstrate navigating the `top`, `list`, and `web` commands within the pprof interactive shell.

2. **Memory Leak Detection**: Write a program that intentionally accumulates memory by appending to a global slice inside a goroutine every 100ms without ever releasing it. Enable the heap profiler by hitting `/debug/pprof/heap` at 10-second intervals. Use `go tool pprof` to compare two heap snapshots with `-base` and identify the leaking allocation site. Fix the leak and confirm that the second snapshot shows stable heap growth after the fix.

3. **Goroutine Profile Analysis**: Build a program that spawns 500 goroutines blocked on a channel read that never completes. Capture the goroutine profile via `/debug/pprof/goroutine?debug=2` and write a short analysis identifying the blocking call stack for the stuck goroutines. Then refactor the program to use a `context.Context` with a 5-second timeout so all goroutines exit cleanly, and verify the goroutine count returns to baseline in the profile.

4. **Benchmark Optimization Workflow**: Write a `BenchmarkJSONEncode` that serializes a 1000-element struct slice using `encoding/json`. Run it with `-benchmem` to establish a baseline for ns/op and allocs/op. Apply at least two allocation-reduction techniques (e.g., `sync.Pool` for encoder reuse, pre-allocated byte buffers, or switching to a zero-allocation library). Re-run benchmarks after each change and document the improvement percentage. The final result must reduce allocations by at least 50% compared to the baseline.

5. **Trace Analysis with go tool trace**: Instrument a pipeline program that reads records from a channel, fans out to three worker goroutines for processing, then fans in results using `runtime/trace`. Run the program and open the trace with `go tool trace`. Identify any goroutine scheduling latency, GC pauses, and periods where worker goroutines are blocked waiting for input. Annotate the pipeline with `trace.WithRegion` for the fan-out and fan-in phases and confirm the regions appear in the trace viewer.

6. **Writing Allocation-Efficient Code**: Implement a log-line formatter that accepts a severity string, a message string, and up to five key-value pairs. Give it an append-style signature, `AppendLine(dst []byte, sev, msg string, kvs ...KV) []byte`, following the convention of `strconv.AppendInt` and `time.Time.AppendFormat`: it appends to the caller's buffer and returns the extended slice. Write a benchmark with `-benchmem` that reuses one buffer across iterations (`buf = AppendLine(buf[:0], ...)`) and confirm **zero heap allocations per call**. Avoid `fmt.Sprintf` and do not box values into `any`. Include a correctness test that verifies the output format alongside the benchmark.

    Before you start, work out *why* the signature has to look like this. The tempting design allocates a local `[256]byte` scratch array and returns a slice of it, on the theory that the array lives on the stack. Try it and read `go build -gcflags=-m`: the compiler reports `moved to heap: buf`, because a slice of that array outlives the function that owns it. Escape analysis is not fooled, the array is heap-allocated, and the benchmark reports 1 alloc/op no matter how the body is written. Zero-allocation formatting is only possible when the caller owns the buffer, which is precisely why the standard library's `Append*` functions all take a `dst` parameter. This exercise is really about learning to recognize that constraint from the shape of an API.

### Senior at FAANG Track

7. **Production pprof exposure.** For every service your team owns, expose `/debug/pprof/` behind auth. Document. Train on-call.

8. **Performance SLO definition.** For one service, define SLOs (latency P99, throughput, cost per request). Measure against them monthly. Investigate misses.

9. **Benchmark gate in CI.** Commit baselines for key benchmarks. Run in CI. Gate PRs on regression.

### Staff / Principal Track

10. **Continuous profiling rollout.** Adopt Pyroscope or equivalent. Pilot on three services. Document the diagnostic improvements and cost. Recommend org-wide adoption or rejection.

11. **PGO pipeline.** Build the pipeline to collect production profiles, build with PGO, and verify speedup. Pilot on one latency-critical service.

12. **Performance-engineering training.** Author and deliver a workshop on profiling and performance engineering. Measure comprehension. Iterate.

13. **Cost-of-compute dashboard.** For the org's services, build a dashboard showing CPU hours, memory hours, allocations per request. Identify the top three cost centers. Propose investments.

14. **Performance maturity assessment.** Score each service on the four-level profiling maturity model. Propose a one-year plan to move the median service up one level.

---
