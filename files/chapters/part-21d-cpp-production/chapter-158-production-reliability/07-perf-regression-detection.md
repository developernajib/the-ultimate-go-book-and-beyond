## Performance Regression Detection

A 1% latency regression at p99 of a search backend, multiplied by a billion queries per day, is ten million seconds of user wait time per day. Catching that 1% in code review is not realistic. Catching it after deployment, when an SRE notices the dashboard moved a pixel, is too late. The right place to catch performance regressions is in CI, with statistical machinery good enough to separate a real 1% signal from benchmarking noise.

This chapter is about that machinery.

### Continuous Benchmarking with Google Benchmark

Google Benchmark is the de facto C++ microbenchmarking library. A minimal benchmark:

```cpp
#include <benchmark/benchmark.h>
#include "myservice/encoder.h"

static void BM_EncodeMessage(benchmark::State& state) {
    Message msg = MakeFixture(state.range(0));
    Encoder enc;
    for (auto _ : state) {
        std::string out;
        enc.Encode(msg, &out);
        benchmark::DoNotOptimize(out);
    }
    state.SetBytesProcessed(state.iterations() * msg.ByteSize());
}
BENCHMARK(BM_EncodeMessage)->Range(64, 1 << 16);

BENCHMARK_MAIN();
```

`benchmark::DoNotOptimize` prevents the compiler from eliminating the call. `state.SetBytesProcessed` lets the framework report bytes per second.

Run:

```bash
$ ./encoder_bench --benchmark_repetitions=20 --benchmark_min_time=2s \
    --benchmark_format=json --benchmark_out=results.json
```

The repetitions and min-time settings matter. A single short run is dominated by startup noise, CPU frequency scaling, and cache effects. Twenty repetitions of two seconds each gives the statistical machinery something to work with.

### Why a Single Run Lies

CPU frequency scaling (Turbo Boost on Intel, similar on AMD), cache effects, hyperthreading, kernel scheduling, and ASLR all introduce variance on the order of 5 to 15% on a modern Linux system. A naive comparison of "old binary 100ms, new binary 105ms, regression!" is wrong roughly half the time.

Mitigations:

- **Pin the benchmark to a specific core.** `taskset -c 3 ./bench`.
- **Disable CPU frequency scaling.** `sudo cpupower frequency-set --governor performance`.
- **Disable hyperthreading on the benchmark core.** Or pin to the physical core's only thread.
- **Disable address space layout randomization.** `setarch x86_64 -R ./bench`.
- **Run on a quiet machine.** No other workloads, no monitoring agents that wake up periodically.
- **Multiple repetitions plus a statistical test.** This is the load-bearing one.

### Statistical Significance: Mann-Whitney U

A 1% mean-difference between two benchmark runs may or may not be significant. The right test is non-parametric (benchmark distributions are not Gaussian, they have long right tails from outliers). Mann-Whitney U is the standard.

```python
from scipy.stats import mannwhitneyu

# samples_old and samples_new are arrays of measurements
u, p = mannwhitneyu(samples_old, samples_new, alternative='two-sided')
if p < 0.001:
    print(f"Significant regression: median {median(samples_new) - median(samples_old):.1f}ns")
```

The p-value threshold matters. At `p < 0.05`, you get one false alarm per twenty benchmarks per build. With thousands of benchmarks, that is dozens of false alarms per day. At `p < 0.001`, false alarms are rare enough that a flagged regression is almost always real.

A common practical setup:

- 20 repetitions per benchmark per commit.
- Mann-Whitney U vs the previous commit, threshold `p < 0.001`.
- A 2% effect-size threshold below which even significant regressions are ignored as "uninteresting."
- Confirmed regressions block the merge until either the author justifies the regression in writing or fixes it.

### Bisecting with `git bisect run`

A regression that slipped past CI manifests as "the benchmark dashboard shows a 5% jump on April 12." The dashboard does not say which commit. `git bisect run` does, automatically, against a benchmark threshold.

`bisect_check.sh`:

```bash
#!/bin/bash
set -e
make encoder_bench >/dev/null 2>&1
RESULT=$(./encoder_bench --benchmark_filter=BM_EncodeMessage \
    --benchmark_format=json | jq '.benchmarks[0].cpu_time')
# Threshold: 100ns. Above is "bad" (regression introduced).
awk -v r="$RESULT" 'BEGIN { exit (r > 100.0) ? 1 : 0 }'
```

Then:

```bash
$ git bisect start
$ git bisect bad HEAD
$ git bisect good <known-good-commit>
$ git bisect run ./bisect_check.sh
```

Git checks out a commit halfway between, runs the script, decides good or bad, narrows the range, repeats. After log2(N) steps, you have the offending commit.

The trap: if the benchmark is flaky, bisection produces wrong answers. Stabilize the benchmark first (more repetitions, pinned core). If a single run still varies wildly, take the median of N runs in the bisect script.

### Continuous Profiling: Strobelight, GWP-style

Microbenchmarks measure what you remembered to benchmark. Continuous profiling measures everything.

The pattern, originally from Google's GWP-Lite and Strobelight (Meta's equivalent): every production binary, every few minutes, takes a 100ms perf-record sample. The samples are aggregated into a service-wide flame graph that shows where CPU time is spent across the whole fleet, by version, by region, by tenant.

A regression that microbenchmarks miss but production hits, like a cache-line bouncing problem that only manifests under specific concurrent traffic patterns, becomes visible as a flame-graph cell that grew between two versions.

Tools:

- **pprof** (Google) and the C++ profiler in gperftools. Old and battle-tested.
- **perf** plus `perf script` plus a flame-graph script. Free, ubiquitous.
- **Pyroscope**, **Parca** (open source). Continuous-profiling backends with C++ agents.
- **Strobelight** at Meta and **Polaris** at Google: internal-only, but the design is documented in papers.

Integration sketch: a thread-local profiler that wakes every 60 seconds, records 100ms of stack samples via `getitimer + SIGPROF` or `perf_event_open`, and ships the result to the aggregator. Total overhead under 0.1%.

### Microbenchmark Pitfalls

A senior engineer reviews benchmarks with skepticism. Common pitfalls:

**The compiler optimized away the work.** `result = f(x)` with `result` unused. Compiler eliminates the call. Benchmark reports nanoseconds. Fix: `benchmark::DoNotOptimize(result)`.

**The benchmark is in cache.** First iteration cold, all subsequent iterations hot. The reported number reflects an unrealistic warm cache. Fix: `state.PauseTiming(); flush_cache(); state.ResumeTiming();` per iteration, or randomize the input to defeat the prefetcher.

**The benchmark fits in L1.** Real production code does not have its inputs in L1. Fix: ensure the input set is larger than L2, or measure cold-cache.

**The benchmark is single-threaded.** Real services run on saturated multi-core boxes. Memory bandwidth, NUMA effects, and contention only show up under load. Fix: run the benchmark with N threads at saturation. Google Benchmark supports this via `BENCHMARK(BM_X)->Threads(N)`.

**The benchmark uses a synthetic input.** The synthetic input is uniform, real input has heavy keys and a long tail. Fix: capture a sample of real traffic and replay it as the benchmark input.

### A Realistic CI Pipeline

A pattern that works at scale:

1. PR submission: run a small set of fast benchmarks (under 5 minutes total). Mann-Whitney against main. Flag regressions over 5%.
2. Pre-merge: run the full benchmark suite (under 30 minutes). Mann-Whitney with `p < 0.001`. Block merges that regress critical benchmarks.
3. Post-merge nightly: run extended benchmarks (multiple hours), including multi-threaded and large-input variants. Updates the dashboard.
4. Continuous: GWP-style sampling against production. The dashboard surfaces unexpected flame-graph drifts.

### Senior at FAANG: The Performance Gate

A senior contribution is not "I made the function faster." It is "I added a benchmark, set the regression gate at 2% with `p < 0.001`, wired it into CI, and now nobody on the team can accidentally regress this hot path without the build failing." Performance is enforced by infrastructure, not by hope.

---
