## Production Perf Regression Detection

A 3% throughput regression that ships unnoticed becomes a 20% regression after six months of stacking. Performance regressions are best caught before merge, second-best caught in canary, third-best caught by alerts. None of that is automatic. You build it.

### Microbenchmarks in CI: Google Benchmark

```cpp
#include <benchmark/benchmark.h>

static void BM_HashLookup(benchmark::State& state) {
    auto map = build_map(state.range(0));
    auto keys = random_keys(1000);
    size_t i = 0;
    for (auto _ : state) {
        auto v = map.find(keys[i++ & 1023]);
        benchmark::DoNotOptimize(v);
    }
    state.SetItemsProcessed(state.iterations());
}
BENCHMARK(BM_HashLookup)->Range(1<<10, 1<<22);
```

Run with statistics:

```bash
./bench --benchmark_repetitions=10 \
        --benchmark_report_aggregates_only=true \
        --benchmark_format=json --benchmark_out=results.json
```

Output gives min, median, mean, stddev, cv. In CI you want median and stddev. Mean is biased by frequency outliers.

### Reproducible Benchmark Hosts

Without controls, microbenchmarks have ~10% noise. Controls:

```bash
# /etc/default/grub (or kernel cmdline)
isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7 intel_pstate=disable

# At benchmark time
sudo cpupower frequency-set -g performance --min 2.4GHz --max 2.4GHz
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo
echo 0 | sudo tee /proc/sys/kernel/numa_balancing
echo 0 | sudo tee /proc/sys/kernel/randomize_va_space

# Pin
taskset -c 4 chrt -f 99 ./bench
```

After this, benchmark CV typically drops below 1%. Without it, do not trust diffs under 5%.

### Statistical Comparison

Do not eyeball. Use Mann-Whitney U or bootstrap CI. Google Benchmark's `compare.py`:

```bash
python3 tools/compare.py benchmarks before.json after.json
```

Outputs per-benchmark % change with U-test p-values. Reject diffs with p > 0.05 as noise.

A reasonable CI gate:

- Median speedup: at least 1% before claiming a win
- Median regression: more than 2% blocks merge
- Median regression 0.5% to 2%: warns, requires reviewer ack
- p-value > 0.05: noise, no action

### Regression Bisection

`git bisect run`:

```bash
#!/bin/bash
# bisect_perf.sh
set -e
make -j$(nproc) bench
./bench --benchmark_filter=BM_Critical \
        --benchmark_repetitions=10 \
        --benchmark_report_aggregates_only=true \
        --benchmark_format=json > /tmp/bench.json
TIME=$(jq -r '.benchmarks[] | select(.aggregate_name=="median") | .real_time' /tmp/bench.json)
THRESHOLD=120000   # ns
[ "$(echo "$TIME < $THRESHOLD" | bc)" = "1" ] && exit 0 || exit 1

# Then
git bisect start HEAD <good-sha>
git bisect run ./bisect_perf.sh
```

Reduces a 200-commit bisect to ~8 builds. Worth automating.

### Production Wide Profiling

Microbenchmarks miss real-world effects: data distribution, cache pressure, lock contention under load, interaction with the runtime. Production profiling fills the gap.

#### Google's GWP (Google-Wide Profiling)

System-wide, always-on, sampled. Each machine runs `perf record` briefly at random intervals. Profiles aggregated, attributed to binaries, surfaced in dashboards.

Key properties:

- Sampling rate ~1 sample per CPU per second, fleet-wide. Negligible overhead.
- Symbolized centrally with debug info from build artifacts.
- Hot functions across the fleet ranked weekly.

A single sample is noise. Aggregated over a fleet of 10K hosts for 24 hours, you see signals 1000x weaker than a single benchmark would see.

#### Meta's Strobelight

Meta's equivalent. Continuous BPF-based stack sampling, integrated with their flamegraph viewer (Scuba). Adds memory and lock-contention profiles.

#### Pyroscope, Parca, Polar Signals

Open-source equivalents:

- **Pyroscope** (Grafana): pull-based, agent samples and pushes to a server. Multi-language (perf for native).
- **Parca** (Polar Signals): eBPF-based, no instrumentation, profiles even already-running binaries. Symbolization via debuginfod or eh_frame.
- **Polar Signals Cloud**: hosted. Same eBPF agent, hosted backend.

Each gives you continuous flamegraphs in production, by service, by host, with diffing across time and versions.

```bash
# Parca agent on a node
docker run --rm -it --privileged --pid=host \
  -v /sys:/sys -v /proc:/proc \
  ghcr.io/parca-dev/parca-agent:latest \
  --remote-store-address=parca-server:7070 \
  --node=hostname
```

A real diff:

```
flamegraph(2024-12-01) vs flamegraph(2024-12-02):
+ 3.4% in MyService::handle_request -> hash_map_lookup
- 1.1% in MyService::serialize -> protobuf::ByteSize
```

### Canary Comparisons

Deploy v_new to 1% of fleet, v_old to 99%. Aggregate latency and CPU per version. Compare with the same statistical approach as benchmarks: confidence intervals, not point estimates.

Key metrics:

- p50/p95/p99 latency per version (hist of distributions, not means)
- CPU per request (cycles or seconds normalized by QPS)
- Memory per instance
- Allocations per request (jemalloc/tcmalloc stats)
- Cache miss rate per request (perf counters scraped per host)

Auto-rollback rule: if v_new p99 > v_old p99 * 1.05 with p > 0.99 (one-sided), rollback. The threshold and statistical confidence are tunable.

### Per-Request Tracing

Distributed tracing (OpenTelemetry, Jaeger) catches per-request regressions: a downstream call started taking 10 ms longer because the called service deployed.

```cpp
auto span = tracer->StartSpan("hash_lookup");
auto result = map.find(key);
span->End();
```

Sample 0.1 to 1% in production. Aggregate to per-span p99 and alert on shifts.

### CI Performance Suite Layout

A real perf suite has tiers:

1. **Pre-merge nano-benchmarks** (~30s total): hottest 10 functions, run on isolated host, must not regress >2%.
2. **Pre-merge integration benchmarks** (~5 min): full request path against synthetic load. Must not regress >5%.
3. **Nightly large-scale** (~1 hr): real-traffic replay against the new binary, p99 latency comparison. Page on regression.
4. **Continuous canary** (always running): 1% fleet on new version, dashboards show side-by-side metrics.
5. **Weekly full-fleet profiling**: GWP-style aggregated flamegraphs, top regressing functions reported.

Each tier catches what the previous misses.

### Concrete CI Snippet

```yaml
# .github/workflows/perf.yml (excerpt)
perf:
  runs-on: [self-hosted, perf-host]   # isolated, pinned host
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0 }
    - name: Build base
      run: |
        git checkout origin/main
        cmake -B build-base -DCMAKE_BUILD_TYPE=Release
        cmake --build build-base -j --target bench
        taskset -c 4 chrt -f 99 \
          build-base/bench --benchmark_repetitions=20 \
            --benchmark_format=json > base.json
    - name: Build PR
      run: |
        git checkout ${{ github.sha }}
        cmake -B build-pr -DCMAKE_BUILD_TYPE=Release
        cmake --build build-pr -j --target bench
        taskset -c 4 chrt -f 99 \
          build-pr/bench --benchmark_repetitions=20 \
            --benchmark_format=json > pr.json
    - name: Compare
      run: |
        python3 third_party/benchmark/tools/compare.py \
          benchmarks base.json pr.json > report.txt
        # Fail if any benchmark regresses > 2% with p < 0.05
        ./scripts/check_regression.py report.txt --threshold=0.02
    - uses: actions/upload-artifact@v4
      with: { name: perf-report, path: report.txt }
```

### What to Track Over Time

- Top 50 functions by self-time (weekly delta)
- p99 of each public RPC method
- CPU per request, allocations per request, syscalls per request
- Cache miss rate, branch miss rate (TMA buckets)
- TLB walk fraction
- Lock wait time at p99
- AVX-512 / AMX duty cycle (frequency throttle risk)
- HITM rate (false sharing canary)

A dashboard with these metrics versus time, annotated with deployments, is the difference between catching regressions in the same week or after the fifth one stacks.

### Junior to FAANG callout

You will not catch perf regressions without measuring perf in CI. "It seemed fast" is not data. Set up a microbenchmark, even a bad one, today. Iterate from there.

### Senior at FAANG callout

The job is not catching every regression. The job is catching the right regressions: the ones that compound, the ones that hit p99, the ones that bite on real traffic shapes. Microbenchmarks alone miss this. Continuous profiling, canary diffs, and traffic-replay rigs are required for any service whose performance is a product attribute.

### Real Stories (rough sketches from public talks)

- **Meta.** BOLT introduction post, reported 5 to 10% improvements caught only after deploying continuous profiling.
- **Google.** AutoFDO at scale, reported regressions of 3 to 8% from "innocuous" cleanups that broke profile-driven inlining decisions, caught only via fleet-wide flamegraph diffing.
- **Netflix.** FlameGraph-driven on-call, reported routine catches of 10%+ regressions hidden by averages but visible in p99 flamegraph diffs.

The pattern is universal: profile production, diff over time, alert on functions, not just metrics.

### Tools cheat sheet

| Need | Tool |
|------|------|
| Microbench in CI | Google Benchmark, nanobench |
| Statistical compare | benchmark/tools/compare.py |
| Bisect | git bisect run |
| Continuous profiling | Pyroscope, Parca, Polar Signals |
| Flamegraph | Brendan Gregg's FlameGraph, speedscope |
| Trace | OpenTelemetry, Jaeger, Tempo |
| Live diff | flamegraph diff, --differential |
| Live counters | pcm-* (Intel), turbostat |
| Wide-fleet profile | GWP-equivalents (build internally) |
