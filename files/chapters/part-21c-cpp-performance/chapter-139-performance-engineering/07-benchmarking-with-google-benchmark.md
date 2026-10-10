## Benchmarking with Google Benchmark

Google Benchmark is the industry-standard micro-benchmarking framework for C++. It handles warmup, iteration counting, statistical analysis, and result formatting.

```cpp
#include <benchmark/benchmark.h>
#include <vector>
#include <algorithm>
#include <numeric>
#include <random>

// Basic benchmark
static void BM_VectorPushBack(benchmark::State& state) {
    for (auto _ : state) {
        std::vector<int> v;
        for (int i = 0; i < state.range(0); ++i) {
            v.push_back(i);
        }
        benchmark::DoNotOptimize(v.data());
    }
    state.SetItemsProcessed(state.iterations() * state.range(0));
}
BENCHMARK(BM_VectorPushBack)->Range(64, 1 << 20);

// Compare with reserve
static void BM_VectorPushBackReserved(benchmark::State& state) {
    for (auto _ : state) {
        std::vector<int> v;
        v.reserve(state.range(0));
        for (int i = 0; i < state.range(0); ++i) {
            v.push_back(i);
        }
        benchmark::DoNotOptimize(v.data());
    }
    state.SetItemsProcessed(state.iterations() * state.range(0));
}
BENCHMARK(BM_VectorPushBackReserved)->Range(64, 1 << 20);

// Benchmark SoA vs AoS
struct PointAoS { float x, y, z, w; };  // 16 bytes

static void BM_SumAoS(benchmark::State& state) {
    size_t n = state.range(0);
    std::vector<PointAoS> points(n, {1.0f, 2.0f, 3.0f, 4.0f});

    for (auto _ : state) {
        float sum = 0;
        for (size_t i = 0; i < n; ++i) {
            sum += points[i].x;  // loads 16 bytes, uses 4
        }
        benchmark::DoNotOptimize(sum);
    }
    state.SetBytesProcessed(state.iterations() * n * sizeof(float));
}
BENCHMARK(BM_SumAoS)->Range(1024, 1 << 24);

static void BM_SumSoA(benchmark::State& state) {
    size_t n = state.range(0);
    std::vector<float> x(n, 1.0f);

    for (auto _ : state) {
        float sum = 0;
        for (size_t i = 0; i < n; ++i) {
            sum += x[i];  // loads 4 bytes, uses 4: perfect utilization
        }
        benchmark::DoNotOptimize(sum);
    }
    state.SetBytesProcessed(state.iterations() * n * sizeof(float));
}
BENCHMARK(BM_SumSoA)->Range(1024, 1 << 24);

// Benchmark branchy vs branchless
static void BM_ConditionalSumBranchy(benchmark::State& state) {
    size_t n = 1'000'000;
    std::vector<int> data(n);
    std::mt19937 rng(42);
    std::uniform_int_distribution<int> dist(0, 255);
    for (auto& v : data) v = dist(rng);

    for (auto _ : state) {
        long long sum = 0;
        for (size_t i = 0; i < n; ++i) {
            if (data[i] >= 128) sum += data[i];
        }
        benchmark::DoNotOptimize(sum);
    }
}
BENCHMARK(BM_ConditionalSumBranchy);

static void BM_ConditionalSumBranchless(benchmark::State& state) {
    size_t n = 1'000'000;
    std::vector<int> data(n);
    std::mt19937 rng(42);
    std::uniform_int_distribution<int> dist(0, 255);
    for (auto& v : data) v = dist(rng);

    for (auto _ : state) {
        long long sum = 0;
        for (size_t i = 0; i < n; ++i) {
            int mask = -(data[i] >= 128);
            sum += data[i] & mask;
        }
        benchmark::DoNotOptimize(sum);
    }
}
BENCHMARK(BM_ConditionalSumBranchless);

BENCHMARK_MAIN();
```

Build and run:

```bash
# Install Google Benchmark
sudo apt install libbenchmark-dev  # Ubuntu
# or build from source: https://github.com/google/benchmark

# Compile and run
g++ -O3 -march=native bench.cpp -lbenchmark -lpthread -o bench
./bench --benchmark_format=console --benchmark_repetitions=5
```

Key practices for reliable benchmarks:
- Use `benchmark::DoNotOptimize()` to prevent dead code elimination
- Use `benchmark::ClobberMemory()` after writes to prevent store elimination
- Run multiple repetitions and report mean and standard deviation
- Disable CPU frequency scaling during benchmarks (`cpupower frequency-set -g performance`)
- Pin benchmark process to a specific core (`taskset -c 0 ./bench`)

---
