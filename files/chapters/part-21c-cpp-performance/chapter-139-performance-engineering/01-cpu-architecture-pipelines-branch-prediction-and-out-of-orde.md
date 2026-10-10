## CPU Architecture: Pipelines, Branch Prediction, and Out-of-Order Execution

### The Instruction Pipeline

Modern CPUs do not execute one instruction at a time. They break execution into stages: fetch, decode, execute, memory access, and write-back. While one instruction is executing, the next is being decoded, and the one after that is being fetched. A five-stage pipeline can have five instructions in flight simultaneously, approaching one instruction per cycle throughput.

```cpp
// This loop appears sequential, but the CPU pipelines it
// Each iteration's stages overlap with adjacent iterations
void add_arrays(float* __restrict__ dst,
                const float* __restrict__ a,
                const float* __restrict__ b,
                size_t n) {
    for (size_t i = 0; i < n; ++i) {
        dst[i] = a[i] + b[i];  // fetch, decode, execute overlap across iterations
    }
}
```

Modern x86 CPUs have pipelines 15 to 20 stages deep. This depth increases throughput but creates a problem: when a branch is encountered, the CPU does not know which instructions to fetch next until the branch resolves many stages later.

### Branch Prediction

To keep the pipeline full, CPUs predict which way branches will go and speculatively execute along the predicted path. Modern branch predictors use sophisticated algorithms (TAGE, perceptron-based) that achieve 95-99% accuracy on typical code. When the prediction is correct, execution continues at full speed. When wrong, the CPU flushes the pipeline and restarts from the correct path, wasting 15-20 cycles.

```cpp
#include <algorithm>
#include <random>
#include <vector>
#include <chrono>
#include <iostream>

// Demonstrate branch prediction impact
void branch_prediction_demo() {
    constexpr size_t N = 100'000'000;
    std::vector<int> data(N);

    std::mt19937 rng(42);
    std::uniform_int_distribution<int> dist(0, 255);
    for (auto& v : data) v = dist(rng);

    // Test 1: Unsorted data - branch predictor struggles
    {
        long long sum = 0;
        auto start = std::chrono::high_resolution_clock::now();
        for (size_t i = 0; i < N; ++i) {
            if (data[i] >= 128) {  // unpredictable branch
                sum += data[i];
            }
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
        std::cout << "Unsorted: " << ms << " ms, sum=" << sum << "\n";
    }

    // Test 2: Sorted data - branch predictor succeeds
    std::sort(data.begin(), data.end());
    {
        long long sum = 0;
        auto start = std::chrono::high_resolution_clock::now();
        for (size_t i = 0; i < N; ++i) {
            if (data[i] >= 128) {  // predictable: all false, then all true
                sum += data[i];
            }
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
        std::cout << "Sorted:   " << ms << " ms, sum=" << sum << "\n";
    }
}
```

Typical results: the sorted version runs 3-5x faster, despite processing identical data. The only difference is branch predictability.

### Out-of-Order Execution

Modern CPUs do not execute instructions in program order. The out-of-order engine examines a window of 200+ instructions, identifies independent operations, and executes them on available execution units regardless of their position in the instruction stream. This hides latency: while one instruction waits for a cache miss, others can execute.

```cpp
// The CPU can execute these independent operations in parallel
// even though they appear sequential in source code
void independent_operations(float* a, float* b, float* c, float* d, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        a[i] = a[i] * 2.0f;   // independent chain 1
        b[i] = b[i] + 3.0f;   // independent chain 2
        c[i] = c[i] - 1.0f;   // independent chain 3
        d[i] = d[i] / 4.0f;   // independent chain 4
    }
}

// Contrast with a dependency chain - CPU cannot parallelize
float dependent_chain(const float* data, size_t n) {
    float result = 0.0f;
    for (size_t i = 0; i < n; ++i) {
        result = result * 0.99f + data[i];  // each iteration depends on the previous
    }
    return result;
}
```

The first function runs much faster per element because the CPU overlaps operations across the four independent streams. The second function is bottlenecked by the serial dependency chain.

---
