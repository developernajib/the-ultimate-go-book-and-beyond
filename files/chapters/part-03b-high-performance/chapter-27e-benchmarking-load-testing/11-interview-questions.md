## Interview Questions

> **What FAANG expects:** performance questions at senior/staff level are rarely about memorizing flags. The interviewer is probing whether you treat performance as a measurement discipline, whether you know why naive numbers lie (dead-code elimination, coordinated omission, closed-model generators, shared-runner noise), and whether you can reason about signal vs. noise with the vocabulary of statistics. Strong answers cite specific tooling (`b.Loop`, `benchstat`, `wrk2`, HDR histogram, flight recorder) and tie each one to the concrete failure mode it fixes.

---

**Q: What is coordinated omission in load testing and how do you fix it?**

A: Coordinated omission occurs when the load generator slows down to match the system under test, masking queuing latency. Work the arithmetic, because the interviewer wants to see you do exactly this. At a target of 100 RPS (one request every 10 ms), suppose one request stalls for 500 ms. A naive closed generator is blocked waiting, so it never sends the 49 requests due at t=10ms through t=490ms. It records **one** sample of 500 ms and nothing else. Those 49 omitted requests were owed: the one due at t=10ms does not go out until t=500ms, so its response time is 490 ms of queuing plus 10 ms of service, and the one due at t=490ms waits only 20 ms. So the honest picture is 49 samples spread from roughly 500 ms down to 20 ms, every one of which the naive generator threw away. It kept the single least representative sample and discarded the queue. Fix: use an **open-model** generator that schedules each request at its intended start time regardless of previous response times. Record latency as `now - intended_start_time`. HDR Histogram's `recordValueWithExpectedInterval()` applies the correction retroactively. Gil Tene coined the term and implemented the canonical fix in `wrk2`. vegeta, k6 (with `constant-arrival-rate` executor), and fortio also avoid it by construction. `wrk`, `hey`, and `bombardier` do not.

Follow-ups:
- "We measured p99 = 12 ms at 10k RPS, but users report p99 around 200 ms. What do you check first?" (Suspect closed-model generator. Re-run with `wrk2` or vegeta at an open arrival rate.)
- "Your load generator is saturating its own CPU before the server does. What happens to your numbers?" (Generator-side queuing becomes indistinguishable from server-side queuing, which is why k6 and vegeta report generator-side metrics like `wait` time separately.)
- "When is a closed-model test actually what you want?" (Capacity planning for a fixed connection-pool-backed consumer, e.g., a batch worker with N parallel threads.)

---

**Q: How do you prevent dead-code elimination from making a Go benchmark meaningless?**

A: Historically the defense was a package-level `var sink T` plus `//go:noinline` on the function under test, with non-constant inputs to block constant folding. Since Go 1.24 the idiomatic answer is simpler: write `for b.Loop() { ... }` instead of `for i := 0; i < b.N; i++`. The compiler recognizes the pattern and keeps the parameters and results of calls in the loop body alive, so a function called between the braces is not optimized away even if nobody reads what it returns. It also eliminates the `b.N` ramp (the body runs once) and resets the timer on the first iteration, so setup above the loop is excluded without `b.ResetTimer()`.

The senior half of the answer is knowing what `b.Loop()` does **not** cover, because that is where benchmarks still lie. It protects calls, not expressions: `_ = x + y` still folds away, and a loop-invariant expression still gets hoisted out of the loop no matter how it is sinked. For those you need a typed package-level sink *and* an input that actually varies per iteration. Two sanity checks worth naming: any result under about 1 ns/op is a bug report about your benchmark, since a single L1 hit is already roughly that; and `allocs/op` of zero on something that should allocate means it did not, usually because escape analysis stack-allocated it (`go test -gcflags=-m` will say "does not escape"), so the benchmark is measuring a different program than production runs.

Follow-ups:
- "What does `b.Loop()` do that `b.N` doesn't, internally?" (Runtime drives duration directly instead of ramping `b.N`, and the compiler treats the loop body as an optimization barrier.)
- "Show me a benchmark that passes dead-code elimination but still measures the wrong thing." (Constant inputs: `x, y := 100, 200` lets the compiler fold `x+y` at compile time even if the store escapes. Fix with `rand.IntN`.)
- "How would you verify the compiler actually ran your code?" (Inspect `-gcflags=-m` inlining decisions, confirm allocs/op matches hand-calculation, and differential-benchmark against a trivial `return 0` variant.)

---

**Q: What p-value should you require before calling a performance change real?**

A: p < 0.05 is the classical significance threshold but is too loose for CI gates. At α=0.05 about 1 in 20 unchanged benchmarks flags as *changed* purely from noise (roughly half of those in the slower direction), so a 100-benchmark suite produces a handful of false alarms on every commit, forever, on code nobody touched. Use p < 0.01, preferably with `-count=20`, for automated gates.

But the real answer is that **the p-value is the wrong thing to lead with**, and an interviewer is listening for whether you know that. Significance testing answers "did these two samples come from different distributions", not "did my code get slower". Those come apart badly on a noisy machine. Benchmarking identical code against itself on a loaded box readily produces `+117% (p=0.004)`, and the tell is not in the p-value but in the `± 88%` sitting next to it. So read `± %` **first**. Note what it is, since it is routinely misdescribed as a standard deviation or a coefficient of variation: it is the half-width of the confidence interval of the median, at the level set by `-confidence` (0.95 by default). If it is above ~5%, you have not measured anything yet and no p-value redeems that. Fix the environment first. Then ignore any delta smaller than roughly 3x that `± %`, because `benchstat`'s Mann-Whitney test will happily flag a 0.3% "improvement" at p=0.000 on a quiet machine, and that one evaporates on the next kernel update.

The corollary worth volunteering: gate allocations separately and tightly. `allocs/op` is deterministic, needs no noise allowance, and stays honest on exactly the shared runners where the timing numbers have already stopped meaning anything.

Follow-ups:
- "Your benchmark reports ±8%. What do you change before trusting the next result?" (Dedicated hardware, disable turbo boost, pin CPU affinity with `taskset`, fix GOGC and GOMAXPROCS, kill background daemons, raise `-benchtime` and `-count`. Note the framing: nothing about the delta is worth discussing until this is fixed.)
- "Why does `benchstat` report median rather than mean?" (Benchmark distributions are right-skewed by scheduler preemptions and GC. The median is robust to the right tail, the mean is not.)
- "When is a 2% regression worth blocking a PR?" (When it's on a hot path executed billions of times per day, e.g., a serialization codec in a mesh sidecar. When you have very low variance, say ±0.3%, you can trust small deltas.)

---

**Q: How would you set up continuous benchmarking in CI?**

A: (1) Run `go test -bench=. -count=10 -benchmem` on every PR against the target package. (2) Run the same suite on the PR's merge base. (3) Compare with `benchstat base.txt head.txt` and fail CI on any regression exceeding the threshold at p < 0.01 (typical thresholds: 5% for latency-critical code, 10% for general). (4) Persist raw results to a time-series store (Prometheus pushgateway, InfluxDB) with commit SHA labels so Grafana can show trends. (5) Critically, run on **dedicated self-hosted runners** with fixed CPU affinity, turbo boost disabled, and a fixed `GOMAXPROCS`. Shared cloud CI workers have load variance that swamps any real signal. (6) Layer continuous profiling (Pyroscope, Parca) on top so that when a regression alert fires you can diff flame graphs between commits without re-running anything. For orgs without dedicated hardware, a pragmatic alternative is running the bench suite N times on the same runner and comparing against a same-runner baseline captured within the same job, which cancels out most environmental variance.

Follow-ups:
- "Your PR benchmark fails intermittently with `± 15%` variance on a shared runner. How do you fix it without buying hardware?" (Same-job baseline capture, `perflock` on Linux, increase `-count`, and isolate on a single CPU with `taskset`.)
- "How do you benchmark a change that affects 200 benchmarks across the repo?" (Sub-sample or tag the hot benchmarks, run the full suite nightly, and use `benchstat`'s geomean for aggregate movement.)
- "Would you ever accept a regression?" (Yes, when it enables a larger win elsewhere, e.g., accepting 5% slower cold path for 20% faster hot path. The decision belongs in the PR description with numbers, not in the CI threshold.)

---

**Q: Explain the tradeoffs between k6, vegeta, wrk2, and fortio. Which would you pick and why?**

A: All four are open-model generators, so none of them suffer coordinated omission. The differences are ergonomic. **k6** runs JavaScript scenarios on a Go runtime, which makes multi-step auth flows, session reuse, WebSocket, and gRPC trivial. It is the de-facto CI default in 2026 thanks to Grafana Cloud integration. **vegeta** is a Go library and CLI with no scripting layer, ideal for a single endpoint at a constant rate, and its library API is easy to embed inside Go test binaries. **wrk2** is C + Lua and remains the gold standard for measuring the high 9s (p99.9, p99.99) because its HDR histogram implementation and CO correction are the reference ones Gil Tene wrote. **fortio** (from the Istio team) speaks HTTP/1, HTTP/2, and gRPC equally and has the best built-in web UI for watching latency percentiles live. Picking: k6 for scenario-heavy CI gates, vegeta for one-shot Go-native tests, wrk2 when tail latency is the deliverable, fortio for gRPC-heavy service meshes. Avoid `wrk` (closed model), `hey` (unmaintained closed model), and `bombardier` for anything where latency numbers matter.

Follow-ups:
- "Why not just write a Go goroutine-based generator?" (Fine for bespoke protocols. For HTTP you'd reimplement open-model scheduling, HDR histograms, and connection pooling, all of which vegeta already gets right.)
- "What's the difference between k6's `constant-vus` and `constant-arrival-rate` executors?" (`constant-vus` is closed-model and will hide queuing. `constant-arrival-rate` is open-model and must be used for any public-facing API test.)
- "You're testing a service behind an L7 load balancer. What bias does that introduce?" (LB connection pooling, keep-alive reuse, and potential connection pinning can skew per-instance load. Randomize client identity or bypass the LB to isolate a single backend.)

---

**Q: When would you reach for `runtime/trace` flight recorder instead of pprof during a load test?**

A: pprof answers "where is CPU time going" by sampling stacks. It cannot answer "why did this goroutine sit blocked for 40 ms with no CPU activity." The execution trace captures every scheduler event, GC phase, goroutine state transition, and syscall boundary, and the flight recorder (promoted to `runtime/trace` in Go 1.25, previously in `golang.org/x/exp/trace`) keeps the last few seconds of trace data in an in-memory ring buffer at ~1-2% overhead. Snapshot it on an SLO breach, a panic recovery, or an alert webhook, then open in `go tool trace`. Classic wins over pprof: rare GC assists stalling a latency-sensitive request, channel-send blocking that doesn't show up as CPU time, network poller wake-up anomalies, and goroutine leak diagnosis. You still use pprof for steady-state CPU and heap questions. Flight recorder is for rare, transient, post-mortem-only events.

Follow-ups:
- "How do you size the flight recorder buffer?" (Based on how much history you need to cover an SLO window. 5-10 seconds at MaxBytes = 10 MiB is a typical starting point.)
- "Can you leave it on in production?" (Yes at ~1-2% overhead for most workloads. Disable for extremely hot paths. Validate with a canary first.)
- "What's the failure mode if you snapshot too eagerly?" (Disk and analysis-time blow up. Gate snapshots behind a rate limiter or a single-flight pattern like the `CompareAndSwap` in section 5.1.)

---

**Q (Junior-track onramp): You have never run a load test. Where do you start?**

A: I would pick my simplest service and run `wrk2 -t4 -c100 -d30s -R 1000 --latency http://localhost:8080/endpoint` or `vegeta attack -rate=1000/s -duration=30s -targets=targets.txt | vegeta report -type=hdrplot`. I would read the output, note the p50, p99, p999 numbers, and ask myself whether they match what I would expect. Then I would rerun at double the rate, then at half the rate, and observe how the percentiles move. That three-run sequence teaches more about load testing than any amount of reading, because it exposes the shape of the service's latency curve under stress. I would also show the output to a senior colleague for interpretation help, because the vocabulary transfers faster with feedback than alone.

Follow-ups:
- "The p99 at 1000 RPS is 80 ms but at 2000 RPS is 500 ms. What is happening?" (The service is hitting some contention point: pool exhaustion, queue buildup, downstream saturation. Next step is pprof while reproducing.)
- "How do you know your load test is hitting the service and not the network?" (Measure against localhost first, then against a same-zone IP, and compare. If localhost is already at the p99 target, the service is the limit, not the network.)

---

**Q (Staff-track): Your team inherits a service with no benchmarks and no load tests. You are the staff engineer. What do you do in the first 30 days?**

A: Week one, read the code and the SLO. If the SLO is missing, that is the first artifact to produce. Week two, add one `testing.B` benchmark per hot handler following the template in section 2.5. Run them to establish a baseline. Week three, stand up a load-test harness (vegeta or k6) against a staging replica, run the five scenarios from section 6.3, establish baselines. Week four, wire the benchmark suite into CI with a 10 percent regression threshold and the load-test scenarios into a nightly job. Month two and three, fill gaps: add degradation scenarios, continuous profiling, flight recorder on breach, alerting. The key move is to produce evidence before touching optimizations. A staff engineer who shows up, reads the service, and starts "optimizing" without a baseline is indistinguishable from a senior engineer who does not yet think at staff level. The baseline is the deliverable in the first month, not the improvements.

Follow-ups:
- "What if leadership wants visible wins quickly?" (Deliver the benchmarks and a one-page "state of performance" document in week two. That is a visible win.)
- "What if the existing team pushes back on the CI gate?" (Start with a soft gate: warn on regressions but do not block. Tighten to blocking after a month of clean runs. Trust is easier to build than to demand.)
- "Who signs off on the SLO and the thresholds?" (Product for SLO, SRE for operational thresholds, tech lead for the CI policy. Get all three in writing.)

