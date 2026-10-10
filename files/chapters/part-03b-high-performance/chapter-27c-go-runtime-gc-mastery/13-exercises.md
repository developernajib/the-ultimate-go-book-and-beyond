## Exercises

1. **GC Pause Benchmark**: Write a server that allocates 100MB/second. Measure p99 latency with GOGC=100 vs GOGC=400 + GOMEMLIMIT. Use wrk2 to measure latency.

2. **Allocation Elimination**: Take an existing HTTP handler and use `go test -benchmem` to measure allocs/op. Drive it as low as you can with buffer reuse and the `strconv.Append` pattern, and record the floor you hit. Do not chase 0 allocs/op for the whole handler: `net/http` allocates per request internally (the request, the header map, the response writer), so zero is not reachable and pretending otherwise teaches the wrong lesson. Zero is a realistic target for the part *you* wrote, measured in isolation. The exercise is to find where your floor is and understand what is holding it there.

3. **Goroutine Leak Detection**: Write a test that creates goroutine leaks (e.g. unclosed channels) and verify your leak detector catches them.

4. **Finalizer Safety**: Write a resource type with both an explicit Close() and a finalizer safety net. Write a test that verifies the finalizer fires when Close() is not called.

5. **RCU Config Benchmark**: Benchmark a config lookup using sync.RWMutex vs the atomic-pointer RCU pattern. Measure at 100 concurrent goroutines.

6. **GC Trace Analysis**: Run a Go service with `GODEBUG=gctrace=1` under load. Parse the trace output and identify which GC cycles take the longest. What is the allocation rate?

7. **Struct Layout Optimization**: Take the BadLayout struct and reorder fields to minimize padding. Use `unsafe.Sizeof` to verify the size reduction.

8. **Off-Heap Cache**: Implement a cache that stores string values off-heap (as `[]byte` slabs). Verify using pprof that the cache contents do not appear in heap profiles.

### Junior → FAANG: ramped exercises

9. **Annotate one `gctrace` line**: Pick any Go program you have written, run it with `GODEBUG=gctrace=1`, and produce an annotated document that labels every field in one representative line. Share it with a more senior engineer and get feedback. Do this five times across different workloads until the fields are second nature.

10. **Hunt a synthetic goroutine leak**: Write a program that leaks 10 goroutines per request. Expose `/debug/pprof/goroutine`. Let it run for a minute, then read the profile and identify the leak site from the stack alone. Try three different leak shapes (channel receive, `WaitGroup.Wait`, `context.Done` that will never fire). This drill builds the muscle memory interviewers probe for.

11. **Read one piece of the Go runtime source**: Pick one file in `$GOROOT/src/runtime` that matches a concept from this chapter (`mgcmark.go` for marking, `malloc.go` for allocation, `proc.go` for the scheduler). Read it for 30 minutes and write one paragraph of what you learned. Repeat on a different file weekly for a month. You will develop runtime intuition that no textbook can give you.

12. **Reduce one struct's pointer density**: Find a struct in your codebase with at least three pointer fields. Flatten one (inline a `[]byte` array, intern a string to an integer ID, or embed a value instead of a pointer). Benchmark allocations before and after, and read `/gc/scan/heap:bytes` from `runtime/metrics` to see the scannable heap shrink directly, which is deterministic and does not depend on machine load. Then deploy to a canary and compare GC CPU share and RSS.

### Senior @ FAANG: staff-level exercises

13. **Write the runtime-tuning ADR for a service you own**: Follow the template from section 1.6. Include baseline metrics, chosen knobs, monitoring plan, and rollback criteria. Share with your team, collect feedback, and merge into the repo. If one already exists, refresh it.

14. **Run a GC regression hunt across Go versions**: Build your service against the previous three Go minor versions. Run the same load test against each. Capture p99, RSS, and GC CPU share as a rate (`rate(go_cpu_classes_gc_total_cpu_seconds_total[5m])`, not the lifetime-average `go_memstats_gc_cpu_fraction`). Document the trend. This is the kind of quarterly exercise that catches subtle runtime regressions before they become production incidents.

15. **Facilitate a post-incident review for a GC-related incident**: Either a real one, or a scheduled one where you intentionally tune `GOGC` wrong on a canary and walk the team through the diagnosis. The facilitation skill (not the runtime knowledge) is the transferable artifact.

16. **Mentor a junior through exercise 10**: Sit with them for an hour while they hunt the synthetic goroutine leak. Your job is to ask questions, not to type. Observing how another engineer reasons under unfamiliar pressure is the single most compressed learning experience available to a staff engineer. It also tends to reveal gaps in your own explanations that you did not know you had.

---
