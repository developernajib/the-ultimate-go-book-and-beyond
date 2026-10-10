## Branch Prediction: likely/unlikely and Branchless Programming

### Compiler Hints: `[[likely]]` and `[[unlikely]]`

C++20 introduced standard attributes to hint which branch path is more common:

```cpp
#include <stdexcept>

// Use [[unlikely]] for error paths
int parse_positive(int value) {
    if (value < 0) [[unlikely]] {
        throw std::invalid_argument("negative value");
    }
    return value;
}

// Use [[likely]] for the common case
void process_events(Event* events, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        if (events[i].type == EventType::Data) [[likely]] {
            handle_data(events[i]);
        } else if (events[i].type == EventType::Error) [[unlikely]] {
            handle_error(events[i]);
        } else {
            handle_other(events[i]);
        }
    }
}

// Pre-C++20 equivalent (GCC/Clang)
#define LIKELY(x)   __builtin_expect(!!(x), 1)
#define UNLIKELY(x) __builtin_expect(!!(x), 0)
```

These hints affect code layout (putting the likely path in the fall-through position) and can improve instruction cache utilization.

### Branchless Programming

When a branch is fundamentally unpredictable (50/50 probability, data-dependent), eliminating the branch entirely can be faster than any prediction strategy:

```cpp
#include <cstdint>
#include <algorithm>

// Branchy: unpredictable branch causes pipeline stalls
int min_branchy(int a, int b) {
    if (a < b) return a;
    return b;
}

// Branchless: uses conditional move (cmov) instruction
int min_branchless(int a, int b) {
    // The compiler often generates cmov for this,
    // but you can be explicit:
    return a < b ? a : b;  // hint to compiler: use cmov
}

// Branchless absolute value
int abs_branchless(int x) {
    int mask = x >> 31;          // all 1s if negative, all 0s if positive
    return (x ^ mask) - mask;    // flip bits and add 1 if negative
}

// Branchless clamp
int clamp_branchless(int x, int lo, int hi) {
    // std::clamp often compiles to two cmov instructions
    return std::clamp(x, lo, hi);
}

// Practical example: branchless conditional sum
// Sum only elements >= threshold
long long conditional_sum_branchless(const int* data, size_t n, int threshold) {
    long long sum = 0;
    for (size_t i = 0; i < n; ++i) {
        // Convert comparison to 0 or -1 mask, then AND with value
        int mask = -(data[i] >= threshold);  // 0 or 0xFFFFFFFF
        sum += data[i] & mask;
    }
    return sum;
}

// Compare: branchy version
long long conditional_sum_branchy(const int* data, size_t n, int threshold) {
    long long sum = 0;
    for (size_t i = 0; i < n; ++i) {
        if (data[i] >= threshold) {
            sum += data[i];
        }
    }
    return sum;
}
```

With uniformly random data and a threshold at the median, the branchless version is often 2-3x faster due to eliminating pipeline stalls. With sorted data or highly biased distributions, the branchy version can be faster because the branch predictor achieves near-perfect accuracy and the CPU avoids the data dependency in the branchless code.

---
