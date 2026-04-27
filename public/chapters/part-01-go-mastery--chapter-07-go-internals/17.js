export default `## Exercises

1. **Profile Goroutine Scheduling with GODEBUG**: Run a concurrent program that spawns hundreds of goroutines performing CPU-bound work. Enable \`GODEBUG=schedtrace=1000\` and \`GODEBUG=scheddetail=1\` to capture scheduler output. Analyze the \`runqueue\`, \`idleprocs\`, and \`gomaxprocs\` fields across multiple samples. Identify when goroutines are starved, explain why the scheduler makes the decisions it does, and propose a structural change (such as adjusting worker pool size or yielding with \`runtime.Gosched()\`) that measurably reduces runqueue depth.

2. **Analyze GC Pressure with pprof**: Build a server or batch job that creates many short-lived allocations (e.g., parsing JSON in a tight loop). Expose a \`/debug/pprof\` endpoint, then use \`go tool pprof -inuse_space\` and \`go tool pprof -alloc_objects\` to capture heap profiles before and after a load test. Identify the top three allocation sites, explain which escape analysis decisions caused heap allocation, and refactor at least one hot path to use stack allocation or \`sync.Pool\` - demonstrating a measurable reduction in \`alloc_objects\` in the follow-up profile.

3. **Understand Escape Analysis with \`-gcflags="-m"\`**: Write a set of small functions covering: returning a pointer to a local variable, passing a value to an interface, closures capturing stack variables, and appending to a slice whose backing array grows. Compile each with \`go build -gcflags="-m -m"\` and record every "escapes to heap" and "does not escape" decision. Write a short explanation for each decision referencing the specific Go escape analysis rule that applies, then rewrite the escaping cases to remain on the stack where semantically safe to do so.

4. **Build a Custom Memory Allocator Using \`sync.Pool\`**: Implement a high-throughput byte-buffer allocator backed by \`sync.Pool\` that recycles \`[]byte\` slices of fixed size classes (e.g., 512 B, 4 KB, 64 KB). Write a benchmark (\`BenchmarkPoolAllocator\` vs \`BenchmarkNaiveAllocator\`) that measures allocations per operation (\`-benchmem\`) under concurrent load. The pool-backed version must show zero or near-zero heap allocations per operation. Instrument the allocator with \`runtime.MemStats\` snapshots to confirm reduced \`HeapAlloc\` growth rate during the benchmark.

5. **Trace Goroutine Lifecycle with \`runtime.Stack\`**: Write a program that deliberately creates three classes of goroutine problems: a goroutine leak (blocked on an unread channel), a deadlock between two goroutines, and a goroutine that calls \`runtime.Goexit()\` mid-execution. For each scenario, capture all goroutine stacks at the moment of the problem using \`runtime.Stack(buf, true)\` and parse the output to extract goroutine IDs, states (\`chan receive\`, \`semacquire\`, etc.), and creation sites. Document how the stack trace output uniquely identifies each problem class and write a diagnostic helper function that classifies goroutine states from a raw stack dump.

6. **Benchmark with Different \`GOMAXPROCS\` Values**: Take a workload that mixes CPU-bound computation (e.g., parallel matrix multiplication) with I/O-bound work (e.g., concurrent HTTP requests to a local mock server). Write a benchmark suite that programmatically sets \`runtime.GOMAXPROCS\` to 1, 2, 4, 8, and the host's \`runtime.NumCPU()\` value before each sub-benchmark. Record throughput, latency percentiles, and context-switch overhead (via \`GODEBUG=schedtrace\`). Plot or tabulate the results and explain the inflection points: where does adding more Ps stop helping the CPU-bound workload, and why does the I/O-bound workload behave differently?

**Useful tools for these exercises**: \`go tool compile -S\`, \`go tool trace\`, \`go tool pprof\`, and \`GODEBUG\` environment variables (\`gctrace\`, \`schedtrace\`, \`scheddetail\`).

### Senior at FAANG Track

7. **Team runbook.** Author your team's on-call runbook for Go-runtime-related incidents. Cover GC pressure, goroutine leak, scheduler gap, memory bloat. For each: symptom, diagnosis command, fix category. Send to the team for review. Publish.

8. **Incident catalogue.** List every Go-runtime-related incident your team has had in the past year. For each, write a short post-mortem: symptom, root cause, fix, prevention. The catalogue is the institutional memory that survives team turnover.

9. **PGO rollout.** For the top hot service in your fleet, implement PGO end-to-end (profile collection, build integration, refresh cadence). Measure before and after. Document the operational model so the team maintains it.

10. **Continuous profiling audit.** If your team runs continuous profiling, audit its coverage and usefulness. If not, write the adoption proposal. Include the tooling (Pyroscope, Parca, hosted), the integration cost, and the expected diagnostic value.

11. **Upgrade economics.** Pick one service. Quantify the cost savings from upgrading to Go 1.26 (Green Tea GC). Include GC CPU percentage, RSS, and build-time changes. The deliverable is the measurement and the recommendation.
`;
