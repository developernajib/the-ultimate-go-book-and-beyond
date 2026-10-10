## Why Benchmarking is Hard

Most benchmarks are wrong. They measure the wrong thing, under the wrong conditions, and report a single number that obscures the actual performance story. Before writing any benchmark code, understand these failure modes so you can design around them:

1. **Dead code elimination**: Compiler removes the code being benchmarked
2. **Coordinated omission**: Load generator slows down when system slows, masking queuing latency
3. **Warmup effects**: First iterations include cache and branch-predictor warmup costs (Go is AOT-compiled, so there is no JIT warmup)
4. **Environment noise**: CPU frequency scaling, OS scheduling, GC interference
5. **Benchmark-production gap**: Benchmark doesn't model real workload (key distribution, payload size, concurrency)

The following methodology addresses each failure mode systematically. Starting with a hypothesis forces you to define what you expect to measure. Isolation removes environmental noise. Statistical analysis separates signal from variance. Production validation confirms that micro-benchmark improvements hold under real load.

```
┌───────────────────────────────────────────────────────────────────┐
│                    Benchmarking Methodology                       │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. Hypothesis         "Pooling encoders will reduce allocs"      │
│          │                                                        │
│  2. Baseline           Current code, measured consistently        │
│          │                                                        │
│  3. Isolation          Pin CPU, disable turbo boost, fix GOGC     │
│          │                                                        │
│  4. Controlled Run     for b.Loop(), b.ReportAllocs()             │
│          │                                                        │
│  5. Statistical Sig.   benchstat: t-test on 10+ samples           │
│          │                                                        │
│  6. Production Valid.  Load test with production traffic pattern  │
│          │                                                        │
│  7. Regression Guard   CI benchmark on every PR                   │
└───────────────────────────────────────────────────────────────────┘
```

### The five traps that fool experienced engineers

Each trap above has a specific shape worth recognizing. **Dead code elimination**: the compiler sees your benchmark result is unused and removes the code, so you measure an empty loop. Signature: throughput far too high, `ns/op` near zero. Fix: assign the result to a package-level sink variable, or use `for b.Loop()` (Go 1.24+), which the compiler treats specially so that the arguments and results of the code inside the loop are kept alive. **Coordinated omission**: `ab`, older `wrk`, and homemade loops throttle when the server slows, so a 500 ms stall shows as one tall sample instead of 500 ms of missing requests. Signature: a suspiciously clean p99 that does not match user complaints. Fix: `wrk2` with `-R`, `vegeta` in constant-rate mode, or `k6` with a scenario rate. **Warmup effects**: the first iterations pay cache miss, branch-prediction initialization, and potentially `mcache` cold start costs. Signature: the first run of a `-count` series is consistently the slow one. Fix: nothing in `testing` discards warmup for you, so lengthen the run with `-benchtime` until the cold iterations amortize away, and read the series with `benchstat` rather than trusting run one. **Environment noise**: CPU turbo boost, thermal throttling, neighbor processes, and GC background work all perturb timing. Signature: 20 percent variance across runs. Fix: pin the CPU, disable turbo boost for the run, run ten times and compare with `benchstat`. **Benchmark-production gap**: your 1000-key hash map benchmarks fast because it fits in L1, but production has a 10-million-key map that does not. Signature: benchmark wins do not materialize in production. Fix: size the benchmark data to realistic working-set sizes and sample realistic access distributions.

### Junior → FAANG: the skeptic's checklist

When you read a performance claim (from a colleague, a blog post, or your own benchmark), run the claim through this checklist before believing it. Did the author use `benchstat` over ten runs? Did they report `ns/op`, `allocs/op`, and `B/op` together, or cherry-pick one? Did they pin hardware, Go version, and `GOMAXPROCS`? Does the workload size reflect production? Did they use a coordinated-omission-corrected tool for latency? Is there a before/after comparison on the same machine? If any answer is no, your confidence in the claim should drop accordingly. This skeptic's reflex is what interviewers are probing for when they ask "how did you validate that optimization?" Candidates who parrot a number fail. Candidates who name the validation steps pass.

### Senior @ FAANG: the benchmarking governance you should own

Benchmarking at team scale is a governance problem, not a tooling problem. The load-bearing artifacts are: (1) a shared convention for what benchmarks every service must include (at minimum: one per hot handler, one per heavy decode path, one per downstream call boundary). (2) a CI integration that runs the benchmarks on every PR, stores the numbers, and surfaces regressions. (3) a regression-triage runbook that tells an engineer what to do when a benchmark regresses by 5, 10, or 25 percent. (4) a quarterly review that walks the historical trend and identifies the services drifting in the wrong direction. Staff engineers who own these four artifacts turn benchmarking from an ad-hoc ritual into a durable operational practice, and the team ships at predictable performance for years. Staff engineers who do not have teams that write benchmarks, never look at them, and are surprised by every regression.

---
