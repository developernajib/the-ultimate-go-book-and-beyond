## Exercises

These exercises progress from micro-benchmark fundamentals through load testing to CI integration. Each one targets a specific concept from the chapter and requires producing measurable results, not just writing code, but verifying the output is correct.

1. **Dead Code Elimination**: Write a benchmark that appears to measure `strings.Contains` but actually measures nothing because the compiler eliminates it. Then fix it.

2. **Statistical Comparison**: Implement a cache lookup in two ways (sync.Map vs RWMutex). Run each with `-count=20` and compare with benchstat. Is the difference statistically significant? Then do the part that matters: run it again at a different read/write ratio and at a different goroutine count. `sync.Map` is built for read-mostly and disjoint-key workloads, so whichever structure you benchmark at one ratio you can make win or lose by choosing another. Report the ratio you tested at, or your result means nothing.

3. **Coordinated Omission Demo**: Build a simple load generator that uses `time.Sleep(1/rate)` between requests. Then build one using intended-start-time. Under 100ms artificial latency, compare the measured p99 from each approach.

4. **Alloc Profiling**: Write a benchmark for an HTTP handler. Use `-memprofile=mem.out` to capture the heap profile. Identify the top 3 allocating sites and eliminate them.

5. **Regression Guard**: Write a Go benchmark and a CI script that saves baseline results and fails if any benchmark regresses > 5%. Then measure your own noise floor before you trust the gate: run the suite twice with *no code change at all* and see what your machine reports. If that null run trips your 5% threshold, the gate is a random number generator, and the exercise is to find the `-count`, `-benchtime`, and `taskset` invocation that gets the null run reliably under it. Also gate `allocs/op` at zero tolerance and notice how much better behaved that check is.

6. **Realistic Traffic**: Implement ZipfDistribution and benchmark a map lookup under it versus uniform random. Do not assume "Zipf" means 80/20: first *measure* what share of traffic the hottest 20 percent of keys actually receives at exponents 1.01, 1.1, and 1.5, and find out how skewed the mildest legal setting already is. Then pick the exponent that matches a distribution you can point at, and say which one you used.

7. **Spike Test**: Use the GradualRampPattern + StepPattern to simulate: 10 min at 1K RPS, spike to 10K for 30s, return to 1K. Record latency histogram throughout. Does p99 recover within 60 seconds?

8. **CPU Profile During Benchmark**: Run `go test -bench=BenchmarkUserHandler -cpuprofile=cpu.out`, then `go tool pprof -http=:8080 cpu.out`. Identify the hottest functions and optimize one.

### Junior → FAANG: ramped exercises

9. **Write your first trustworthy benchmark**: Take any function you have written. Write a `testing.B` using `b.Loop()` and `b.ReportAllocs()`. Run `go test -bench -count=10 -benchmem`. Pipe through `benchstat`. Commit the benchmark to the repo with a one-line comment explaining what it measures. This is the smallest meaningful contribution to performance culture, and the skill compounds.

10. **Run `wrk2` against three services**: Pick three services you have access to (local, staging, production if permitted at low rate). Run `wrk2 -t4 -c100 -d30s -R 100 --latency` against each. Record the p50, p99, p999 for each. Write one paragraph on what the numbers tell you about each service.

11. **Reproduce coordinated omission**: Build two load generators, one using `time.Sleep(duration/rate)` between requests (closed), one scheduling at absolute timestamps (open). Point both at a server that sleeps 500 ms on 1 percent of requests. Compare the reported p99. The gap is real, and seeing it yourself is worth more than reading about it.

12. **Annotate one `benchstat` output**: Run a benchmark before and after any change (pool, flatten, rewrite). Run `benchstat` and write out each column's meaning in your own words. Share with a senior colleague for feedback.

### Senior @ FAANG: staff-level exercises

13. **Write the benchmarking policy for your team**: Define what benchmarks every service must have, who reviews regressions, what thresholds block deploy. Circulate the draft, collect feedback, publish.

14. **Build the CI benchmark gate for one service**: Follow the pattern in section 4.1. Pin hardware, automate `benchstat`, wire a threshold, deploy to production. Document the false-positive rate for the first month and adjust.

15. **Run a production-shaped load test against a staging replica**: Sample 24 hours of production request logs. Replay at realistic rate against staging. Compare latency distributions to production metrics. Adjust the test until the distributions match within 10 percent. Use the validated harness for future release gates.

16. **Mentor a junior through exercise 11**: Sit with a junior engineer while they build the two load generators. Your role is to ask "what do you expect to see and why" before each run, not to type. The contrast between their prediction and the data is the learning moment, and coaching it well is a staff-to-principal skill.

---
