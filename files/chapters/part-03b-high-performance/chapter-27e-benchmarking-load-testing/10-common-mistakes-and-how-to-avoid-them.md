## Common Mistakes and How to Avoid Them

Each mistake below produces benchmarks that report misleading numbers. The "Effect" column explains how the mistake distorts results, and the "Fix" column gives the corrective action.

| Mistake | Effect | Fix |
|---------|--------|-----|
| Not using b.ReportAllocs() | Miss allocation regressions | Always add b.ReportAllocs() |
| Dead code elimination | Benchmark measures nothing | `for b.Loop()`, or a typed package-level sink for bare expressions |
| Reporting a sub-nanosecond result | An L1 hit alone is ~1 ns, so it measured an empty loop | Treat any result under ~1 ns/op as a bug in the benchmark |
| Loop-invariant expression under test | Compiler hoists it out, loop times a store | Vary the input per iteration |
| `sync.Pool.Put([]byte)` in the "optimized" arm | Boxing a slice allocates 24 B, so the pool loses to the code it replaced | Pool a `*[]byte`, which is pointer-shaped and boxes free |
| Benchmarking only fast path | Cache effects inflate results | Mix hits/misses at realistic ratio |
| Single benchmark run | Environmental noise affects results | Use -count=10, analyze with benchstat |
| Reading `p` without reading `± %` | A noisy box yields p<0.05 on unchanged code | Check the confidence interval first, then the delta |
| Calling b.ResetTimer() with `for b.Loop()` | Harmless but stale: b.Loop already resets on iteration one | Only needed with the legacy `for i := 0; i < b.N; i++` form |
| Naïve load generator | Coordinated omission hides queuing | Use intended-start-time + HDR histogram |
| Your own generator dropping slots when saturated | Coordinated omission, self-inflicted | Report dropped slots and fail the run on any |
| Testing only normal load | Miss spike behavior | Always include spike test phase |
| No baseline in CI | Can't detect regressions automatically | Save baseline, compare on every PR |
| Turbo boost enabled | Non-reproducible results | Disable: echo 0 > /sys/.../boost |
| Short benchmark duration | Timer resolution too coarse | Use -benchtime=5s or -benchtime=100000x |
| Claiming improvement without `benchstat` | Noise mistaken for signal, wrong decisions shipped | Run 10x each, pipe through `benchstat`, reject below noise floor |
| Load testing against a cold service | Warmup inflates p99, unrealistic numbers | Pre-warm for 30 seconds before measurement window |
| Load test against loopback | Network path ignored, tail latency understated | Test over realistic network topology or add RTT in analysis |
| Closed-model load generator (`wrk`, `ab`) | Coordinated omission, p99 looks better than reality | Use open-model tools: `wrk2`, `vegeta`, `k6`, `fortio` |
| Uniform key distribution in load test | Cache hit rate overstated, hot-key issues hidden | Fit the skew to production logs, do not guess a Zipf exponent |
| Benchmark running in shared CI with variable load | Wide variance, false positives and negatives | Dedicated benchmark runner with CPU pinning, disabled turbo |
| Pprof on the same port as the service under load | Profile and service contend, p99 regresses | Separate admin port for pprof endpoints |
| Missing scenario for degradation (slow downstream) | Cascading failure mode never tested | Add fault-injection scenario, assert graceful degradation |
| Benchmark workload size fits in L1 cache but production does not | Benchmark wins do not materialize in production | Size workload to match realistic working set |

### Junior → FAANG: the self-audit checklist

For every benchmark or load test you report, walk this checklist before hitting send on the number. Did I use `b.ReportAllocs()` and `b.Loop()` (or equivalent)? Did I run ten times and run through `benchstat`? Did I report `ns/op`, `B/op`, and `allocs/op` together, not just one? Did I use an open-model load generator with HDR histograms? Did I size the workload to match production? Did I pin hardware, Go version, and environmental variables (GOMAXPROCS, GOGC, GOMEMLIMIT)? If any answer is no, revise before reporting. Engineers who run this checklist consistently earn reputations for trustworthy numbers, and trustworthy numbers are what interviewers, reviewers, and leadership actually want.

### Senior @ FAANG: the team-level anti-patterns

Beyond individual mistakes, teams at scale accumulate benchmark pathologies. Common ones: the benchmark suite has not been run in six months and nobody notices because CI silently skipped it after a flake. The load-test harness has drifted from production traffic shape, but nobody has validated it recently, so the numbers lie in an unknown direction. The regression threshold was set to 20 percent by the engineer who set up the pipeline, and nobody has revisited it as the benchmark variance has improved, so real regressions slip through. The team has 50 benchmarks, 30 of which are redundant or test trivial code, and the signal-to-noise ratio of the suite has degraded. Each of these is a staff-level opportunity. Audit the benchmark suite quarterly. Validate load-test fidelity against production annually. Adjust thresholds based on measured variance. Delete benchmarks that do not exercise real hot paths. The alternative is a suite that looks impressive but produces no actionable signal, which is the most expensive outcome of all.

---
