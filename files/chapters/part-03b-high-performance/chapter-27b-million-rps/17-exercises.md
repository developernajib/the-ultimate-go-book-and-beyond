## Exercises

These exercises progress from isolated micro-optimizations (zero-allocation encoding, lock-free structures) to full system-level performance tuning (GC experiments, load testing, consistent hashing). Complete them on a multi-core machine and use `go test -benchmem`, `pprof`, and `perf stat` to validate your results quantitatively.

A note on how to grade yourself, which matters more than any single exercise. Prefer targets that are *counts* over targets that are *nanoseconds*. `allocs/op`, escape-analysis decisions from `-gcflags=-m`, and the presence or absence of a `CALL` in `-gcflags=-S` output reproduce exactly on any machine. A `ns/op` figure on a shared laptop with frequency scaling can swing by a factor of two between runs of identical code, which means a nanosecond target will happily tell you that you succeeded when you did nothing. Where an exercise below asks for a timing, it also asks you to say what hardware produced it.

1. **Zero-Allocation JSON Encoding**: Write a handler that serializes its response by appending into a pooled buffer, with no `encoding/json` and no `fmt` on the hot path. Benchmark the **encode path directly** and drive `allocs/op` to 0. Do not try to drive the whole handler to 0 through an `httptest.NewRecorder`: the recorder and `net/http`'s own per-response state allocate regardless of what your code does (measured: 9 allocs/op for a handler whose entire body is one `w.Write` of a package-level `[]byte`). Knowing which allocations are yours to remove and which belong to the framework is the actual lesson.

2. **Lock-Free Rate Limiter**: Implement a token bucket rate limiter using only atomic operations (no mutexes). Verify the real properties: 0 allocs/op on the check path, and correctness under `go test -race` with a few hundred goroutines hammering one bucket. Then verify it actually limits, by admitting exactly the configured burst from a cold bucket.

3. **NUMA Benchmark**: On a multi-NUMA machine, benchmark memory allocation with and without NUMA pinning. Quantify the latency difference for sequential vs random access patterns.

4. **GC Tuning Experiment**: Deploy a Go HTTP server handling 100K RPS. Measure GC pause times with GOGC=100 (default) vs GOGC=400+GOMEMLIMIT. Compare p99 latency.

5. **Event-Loop Echo Server**: Build a TCP echo server using gnet (an epoll-based event loop on Linux) and benchmark against the standard net package. Measure CPU utilization at 100K connections.

6. **False Sharing Demonstration**: Write a benchmark with a shared struct that causes false sharing, then fix it with padding. Measure the throughput difference on a multi-core machine.

7. **Goroutine Pool Tuning**: Implement the bounded worker pool and find the optimal worker count for a CPU-bound workload on your machine. Plot throughput vs worker count.

8. **Consistent Hashing Load Test**: Deploy 5 backend servers with the consistent hash router. Remove one server and measure the percentage of keys that remapped. Predict the answer before you run it, then check it against the 1/N reasoning and the measured table in section 10.3. Then measure the *load spread* across the 5 nodes and notice that it is nowhere near even, which is the point section 10.3 is making.

### Junior → FAANG: ramped exercises

9. **Baseline an echo server**: Write the simplest possible `net/http` echo handler. Run `wrk -t4 -c100 -d30s` against it. Record RPS, p50, p99 to establish a concrete personal baseline for your laptop.

10. **Kill one allocation at a time**: Take the echo handler from (9). Write a `testing.B` over its **response-building logic** (not the whole server), using `b.Loop()` so the compiler cannot dead-code-eliminate the work, and `b.ReportAllocs()`. Remove one allocation per iteration: start with `fmt.Sprintf`, then `make([]byte, ...)` without a capacity, then interface boxing of values wider than a word. Track `allocs/op` and `B/op` after each change, and drive them to 0. Watch `B/op` rather than `ns/op` while you do it: `B/op` is exact and `ns/op` is noise on a laptop. Then confirm each win with `-gcflags=-m` and read the escape-analysis line that changed.

11. **Read a flame graph end to end**: Capture a CPU profile under load and walk the top 10 functions. Write one paragraph per function explaining what it does and why it is expensive. This exercise is more valuable than any implementation task.

12. **Draw the GMP picture**: Without looking anything up, draw the GMP model on paper. Show runnable queues, stealing, and what happens on a blocking syscall. Then check your drawing against the Go source in `runtime/proc.go`. Fix whatever you got wrong. Repeat in a week.

### Senior @ FAANG: staff-level exercises

13. **Write the capacity model for a service you own**: In a spreadsheet, compute current RPS, p50, p99, fan-out degree, downstream pool sizes, peak over average ratio, and cost per million requests. Project three quarters out. Identify the first tier that will break. Share the document with your team and collect feedback.

14. **Author an ADR for a past decision**: Pick a performance-related decision your team made in the last six months that was not documented. Write the ADR retroactively: context, options, decision, consequences. Notice what you have to guess at. That gap is what an ADR is supposed to preserve.

15. **Run a production-shadow load test**: Set up a sampled replay of production traffic against a canary replica. Compare p99 and error rate between canary and primary during a normal day and during a deploy. The infrastructure for this is load-bearing for every subsequent performance change you ship.

16. **Mentor a junior engineer through exercise (10)**: Sit with a junior engineer for an hour while they complete exercise (10). Your job is to ask questions, not to type. The skill of coaching another engineer through a performance refactor is the one that gets you promoted to principal. Start practicing it now.

---
