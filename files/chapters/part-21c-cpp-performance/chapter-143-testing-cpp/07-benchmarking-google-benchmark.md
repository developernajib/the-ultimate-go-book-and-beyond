## Benchmarking with Google Benchmark

Wall-clock timing of a function call is useless for microbenchmarks. The first call hits an empty instruction cache and branch predictor. The OS scheduler may preempt the process mid-measurement. The compiler may optimize away the entire computation if the result is unused. Google Benchmark addresses all of these: it runs each benchmark in a loop until the measurement stabilizes, prevents dead-code elimination with `DoNotOptimize`, and reports statistical summaries rather than single samples.

Google Benchmark is the standard for C++ microbenchmarking. It integrates with Google's performance regression tracking infrastructure and is used in Chromium, TensorFlow, abseil, and virtually every performance-sensitive Google project.

### Basic Benchmark

Profiling identifies the actual bottlenecks in a program rather than relying on intuition, directing optimization effort where it will have the greatest impact. The workflow below establishes a reproducible measurement baseline before any changes are made, enabling objective comparison between alternatives.
```cpp
#include <benchmark/benchmark.h>
#include <vector>
#include <algorithm>
#include <numeric>

// A benchmark function takes a benchmark::State& parameter.
// The measurement loop runs until the framework decides it has enough samples.
static void BM_VectorSum(benchmark::State& state) {
    std::vector<int> v(state.range(0));
    std::iota(v.begin(), v.end(), 0);

    for (auto _ : state) {
        // Everything inside the for loop is measured.
        // The `_` variable is an opaque iteration handle.
        long long sum = 0;
        for (int x : v) sum += x;

        // Prevent the compiler from optimizing away `sum`
        benchmark::DoNotOptimize(sum);
    }

    // Report throughput in bytes/sec
    state.SetBytesProcessed(
        static_cast<int64_t>(state.iterations()) * state.range(0) * sizeof(int)
    );
}

// Register the benchmark with a range of input sizes
BENCHMARK(BM_VectorSum)->Arg(64)->Arg(1024)->Arg(65536)->Arg(1'000'000);

BENCHMARK_MAIN();
```

### DoNotOptimize and ClobberMemory

These two calls are essential for correct benchmarks:

```cpp
static void BM_StringConstruct(benchmark::State& state) {
    for (auto _ : state) {
        std::string s(state.range(0), 'x');

        // Without DoNotOptimize, the compiler can prove `s` is unused
        // and eliminate the entire construction - benchmarking nothing.
        benchmark::DoNotOptimize(s);

        // ClobberMemory tells the compiler to assume all memory may have
        // been modified - prevents hoisting loop-invariant memory reads
        // out of the measurement loop.
        benchmark::ClobberMemory();
    }
}
BENCHMARK(BM_StringConstruct)->Range(8, 8 << 16);
```

`Range(start, limit)` with default multiplier 8 generates: 8, 64, 512, 4096, ... up to `limit`. Use `RangeMultiplier(2)` before `Range()` to change the step.

### Fixtures

Use fixtures when benchmark setup is too expensive to repeat each iteration or when you need shared state:

```cpp
#include <benchmark/benchmark.h>
#include <unordered_map>
#include <random>

class HashMapFixture : public benchmark::Fixture {
public:
    // Called once before all iterations of benchmarks in this fixture
    void SetUp(const benchmark::State& state) override {
        std::mt19937 rng(42);
        std::uniform_int_distribution<int> dist(0, 1'000'000);

        map_.reserve(state.range(0));
        for (int i = 0; i < state.range(0); ++i) {
            map_[dist(rng)] = i;
        }
    }

    void TearDown(const benchmark::State& /*state*/) override {
        map_.clear();
    }

    std::unordered_map<int, int> map_;
};

BENCHMARK_DEFINE_F(HashMapFixture, LookupHit)(benchmark::State& state) {
    for (auto _ : state) {
        // Lookup a key that exists (map was populated in SetUp)
        auto it = map_.find(500'000);
        benchmark::DoNotOptimize(it);
    }
}

BENCHMARK_DEFINE_F(HashMapFixture, LookupMiss)(benchmark::State& state) {
    for (auto _ : state) {
        auto it = map_.find(-1);  // never inserted
        benchmark::DoNotOptimize(it);
    }
}

BENCHMARK_REGISTER_F(HashMapFixture, LookupHit)->Range(1000, 1'000'000);
BENCHMARK_REGISTER_F(HashMapFixture, LookupMiss)->Range(1000, 1'000'000);
```

### Multi-Dimensional Arguments

Some benchmarks vary along two axes, for example, container size and thread count:

```cpp
static void BM_SortParallel(benchmark::State& state) {
    int n_elements = state.range(0);
    int n_threads  = state.range(1);

    std::vector<int> v(n_elements);
    std::iota(v.begin(), v.end(), 0);

    for (auto _ : state) {
        state.PauseTiming();  // Exclude setup from measurement
        std::shuffle(v.begin(), v.end(), std::mt19937{42});
        state.ResumeTiming();

        // Imagine a parallel sort using n_threads
        std::sort(v.begin(), v.end());
        benchmark::DoNotOptimize(v.data());
    }
}

// Test all combinations of size × threads
BENCHMARK(BM_SortParallel)
    ->Args({1024,  1})
    ->Args({1024,  4})
    ->Args({65536, 1})
    ->Args({65536, 4})
    ->Args({65536, 8});
```

### Custom Counters

Report domain-specific metrics alongside timing:

```cpp
static void BM_NetworkPacketParse(benchmark::State& state) {
    const int packet_size = state.range(0);
    std::vector<uint8_t> packet(packet_size, 0xAB);  // synthetic packet
    size_t packets_parsed = 0;

    for (auto _ : state) {
        benchmark::DoNotOptimize(parse_packet(packet.data(), packet.size()));
        ++packets_parsed;
    }

    // Counter::kIsRate divides by elapsed time → packets/sec
    state.counters["packets/sec"] = benchmark::Counter(
        static_cast<double>(packets_parsed),
        benchmark::Counter::kIsRate
    );

    // kIsRate | kInvert gives seconds/packet (latency)
    state.counters["latency_ns"] = benchmark::Counter(
        static_cast<double>(packets_parsed),
        benchmark::Counter::kIsRate | benchmark::Counter::kInvert
    );

    state.SetBytesProcessed(
        static_cast<int64_t>(state.iterations()) * packet_size
    );
}
BENCHMARK(BM_NetworkPacketParse)->Range(64, 9000);
```

### Running and Output Formats

`--benchmark_filter` accepts glob patterns so you can run a subset of benchmarks without recompiling, and `--benchmark_repetitions=5` runs each benchmark five times to produce mean, median, and standard deviation statistics. Passing `--benchmark_format=json` writes machine-readable results that can be fed to regression detection tools like `google/benchmark`'s `compare.py` script to catch performance regressions in CI.
```bash
# Run all benchmarks
./my_benchmarks

# Filter by name (glob)
./my_benchmarks --benchmark_filter='BM_Sort.*'

# Run with more repetitions for statistical confidence
./my_benchmarks --benchmark_repetitions=5

# JSON output for CI regression detection
./my_benchmarks \
    --benchmark_format=json \
    --benchmark_out=results.json \
    --benchmark_out_format=json

# Compare two result files (before vs after a change)
# Python script shipped with Google Benchmark
python3 tools/compare.py results_before.json results_after.json
```

The compare script outputs:

```
BM_VectorSum/64         +0.0031   +0.0027   (mean: 123ns → 123ns)
BM_VectorSum/1024       -0.0412   -0.0408   (mean: 1.4µs → 1.3µs)  FASTER
BM_VectorSum/65536      +0.1523   +0.1491   (mean: 87µs → 100µs)   SLOWER (significant)
```

### Performance Regression in CI

Continuous integration automatically builds and tests every commit, catching regressions before they reach the main branch. The workflow definition below configures the build matrix, runs the test suite under multiple compilers, and uploads coverage reports as artifacts.
```yaml
# .github/workflows/benchmark.yml
name: Benchmark Regression

on:
  pull_request:
    branches: [main]

jobs:
  bench:
    runs-on: ubuntu-24.04-4core   # consistent hardware matters

    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Build benchmarks (baseline - main branch)
        run: |
          git checkout main
          cmake -B build_base -DCMAKE_BUILD_TYPE=Release
          cmake --build build_base --parallel
          ./build_base/my_benchmarks \
              --benchmark_format=json \
              --benchmark_out=baseline.json

      - name: Build benchmarks (PR branch)
        run: |
          git checkout ${{ github.sha }}
          cmake -B build_pr -DCMAKE_BUILD_TYPE=Release
          cmake --build build_pr --parallel
          ./build_pr/my_benchmarks \
              --benchmark_format=json \
              --benchmark_out=pr.json

      - name: Compare
        run: |
          pip install scipy
          python3 build_base/tools/compare.py \
              --threshold=0.05 \
              baseline.json pr.json
        # Exits non-zero if any benchmark regresses by >5%
```

### Benchmark Anti-Patterns

**Cold-start benchmarks**: if you call a function only once, you are measuring cache fill and branch predictor training, not steady-state performance. Let the benchmark loop warm up, the framework does this automatically.

**Benchmarking under thermal throttling**: modern CPUs reduce clock speed under sustained load. Use `--benchmark_enable_random_interleaving=true` to interleave benchmark runs, reducing the impact of thermal effects.

**Including I/O in a compute benchmark**: use `state.PauseTiming()` / `state.ResumeTiming()` to exclude file reads, random data generation, or any non-subject work from the measurement window.

**Microbenchmarking an inlined function**: if the function under test is small enough to inline into the benchmark loop body, the optimizer may produce a result that does not reflect real-world call overhead. Add `[[gnu::noinline]]` to the function to prevent inlining in benchmarks.

### Go Comparison

Go's `testing.B` automatically determines the iteration count (`b.N`) by running the benchmark loop until stable timing is achieved, so the user never specifies iteration counts. Google Benchmark requires the explicit `for (auto _ : state)` loop but provides richer controls: custom counters, CPU time vs. wall time, bytes-per-second throughput reporting, and template-parameterized benchmark families.
```go
// Go benchmark - testing.B handles the loop and warm-up
func BenchmarkVectorSum(b *testing.B) {
    v := make([]int, 65536)
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        sum := 0
        for _, x := range v { sum += x }
        _ = sum
    }

    b.ReportAllocs()
    b.SetBytes(int64(len(v) * 8))
}
```

`testing.B` is simpler: no `DoNotOptimize`, no counter API, no JSON output. Google Benchmark provides `--benchmark_repetitions`, statistical analysis, custom counters, and fixture-based setup that Go's `testing.B` lacks. For rigorous performance work or regression tracking in CI, Google Benchmark is the right tool.

---
