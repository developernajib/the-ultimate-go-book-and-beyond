## Strategy: Templates vs Virtual Dispatch

The Strategy pattern replaces hard-coded algorithms with interchangeable implementations. In C++, you have three fundamentally different mechanisms to implement it, each with different performance characteristics and flexibility trade-offs: virtual dispatch (runtime), templates (compile-time), and `std::function` (runtime with type erasure). The choice has measurable performance implications on hot paths.

### Strategy via Virtual Dispatch (Classic)

The textbook approach: an abstract base class with a pure virtual method. Callers hold a pointer to the base.

```cpp
#include <vector>
#include <cstdint>
#include <algorithm>

class SortStrategy {
public:
    virtual ~SortStrategy() = default;
    virtual void sort(std::vector<int>& data) = 0;
};

class QuickSort : public SortStrategy {
public:
    void sort(std::vector<int>& data) override {
        std::sort(data.begin(), data.end());
    }
};

class CountingSort : public SortStrategy {
public:
    void sort(std::vector<int>& data) override {
        if (data.empty()) return;
        auto [mn, mx] = std::minmax_element(data.begin(), data.end());
        std::vector<int> count(*mx - *mn + 1, 0);
        for (int v : data) count[v - *mn]++;
        int idx = 0;
        for (int v = *mn; v <= *mx; ++v)
            while (count[v - *mn]-- > 0)
                data[idx++] = v;
    }
};

class DataProcessor {
    SortStrategy* strategy_;  // or unique_ptr<SortStrategy>

public:
    explicit DataProcessor(SortStrategy* s) : strategy_(s) {}

    void process(std::vector<int>& data) {
        strategy_->sort(data);  // Indirect call: vtable lookup + virtual dispatch
    }
};
```

**Cost**: one indirect call through the vtable per `sort()` call. For a sort over a million elements, this one-time overhead is negligible. For a comparison function called per-element, it is catastrophic.

### Strategy via Templates (Compile-Time)

Template parameters replace the base class pointer. The concrete type is baked in at compile time. The compiler sees the full call chain and can inline.

```cpp
#include <vector>
#include <algorithm>
#include <functional>

// SortStrategy is now a template parameter -- no vtable, no indirection
template <typename SortPolicy>
class DataProcessor {
    SortPolicy sorter_;

public:
    explicit DataProcessor(SortPolicy s = SortPolicy{})
        : sorter_(std::move(s)) {}

    void process(std::vector<int>& data) {
        sorter_(data);  // Direct call -- inlined by optimizer
    }
};

// Strategies are plain callables
struct QuickSortPolicy {
    void operator()(std::vector<int>& data) const {
        std::sort(data.begin(), data.end());
    }
};

struct RadixSortPolicy {
    void operator()(std::vector<int>& data) const {
        // LSD radix sort implementation
        radix_sort_impl(data);
    }
private:
    static void radix_sort_impl(std::vector<int>& data);
};

// Instantiation -- distinct types, zero virtual overhead
using FastProcessor    = DataProcessor<RadixSortPolicy>;
using DefaultProcessor = DataProcessor<QuickSortPolicy>;
using LambdaProcessor  = DataProcessor<std::function<void(std::vector<int>&)>>;
```

C++20 concepts make the template requirement explicit and produce clean error messages:

```cpp
template <typename T>
concept SortPolicy = requires(T t, std::vector<int>& v) {
    { t(v) } -> std::same_as<void>;
};

template <SortPolicy Policy>
class DataProcessor { /* ... */ };
```

### The Comparison Function Problem

The template strategy matters most when the strategy is called per-element, not per-collection. The classic example is a comparator. `std::sort` takes a comparator as a template parameter, not a virtual function, this is why it can inline the comparison and achieve cache-optimal performance.

```cpp
// SLOW -- virtual dispatch per comparison, optimizer cannot inline
struct VirtualComparator {
    virtual ~VirtualComparator() = default;
    virtual bool less(int a, int b) const = 0;
};

struct DescendingVirtual : VirtualComparator {
    bool less(int a, int b) const override { return a > b; }
};

void sort_slow(std::vector<int>& v, VirtualComparator* cmp) {
    std::sort(v.begin(), v.end(),
        [cmp](int a, int b) { return cmp->less(a, b); });  // Per-element virtual call
}

// FAST -- template parameter, inlined, zero overhead
auto sort_fast(std::vector<int>& v, auto cmp) {
    std::sort(v.begin(), v.end(), cmp);  // Inlined by optimizer
}

// sort_fast([](int a, int b){ return a > b; }) -- single instruction comparison
```

### Hybrid: std::function for Runtime Configurability

When the strategy must be read from a config file or injected at runtime, neither virtual dispatch nor templates work well. `std::function` provides runtime flexibility with a fixed interface:

```cpp
#include <functional>
#include <vector>

class DataProcessor {
    std::function<void(std::vector<int>&)> strategy_;

public:
    explicit DataProcessor(std::function<void(std::vector<int>&)> s)
        : strategy_(std::move(s)) {}

    void set_strategy(std::function<void(std::vector<int>&)> s) {
        strategy_ = std::move(s);
    }

    void process(std::vector<int>& data) {
        strategy_(data);
    }
};

// Can be set from config, changed at runtime, stored in containers
DataProcessor proc([](auto& v){ std::sort(v.begin(), v.end()); });
// Later:
proc.set_strategy([](auto& v){ std::reverse(v.begin(), v.end()); });
```

### Performance Reality

Benchmark on 10M calls to a trivial strategy (noop body, optimized build):

| Mechanism | Overhead per call | Notes |
|---|---|---|
| Template (inlined) | ~0 ns | Compiler eliminates call entirely |
| `std::function` (SBO) | ~3-5 ns | Indirect call through internal vtable |
| Virtual dispatch | ~4-8 ns | Pointer dereference + indirect call |
| Virtual (megamorphic) | ~15-30 ns | Branch predictor misses on many call sites |

"Megamorphic" virtual dispatch, when many different concrete types are dispatched through the same call site, is where virtual dispatch gets truly expensive. The branch predictor cannot learn the target. Template instantiation has no such problem: each call site is monomorphic.

### Decision Matrix

The choice between template-based and virtual-dispatch strategies reduces to a handful of questions about when the strategy is known, how hot the call site is, and who supplies implementations.
```
Need to swap at runtime?
  Yes → std::function or virtual
    Swapped rarely (once at startup)?  → virtual (simpler)
    Swapped frequently?                → std::function (more flexible)
    On a hot path?                     → hand-rolled type erasure (Chapter section 3)
  No  → Template parameter
    One instantiation per binary?      → single template, no overhead
    Many instantiations?               → watch binary size (code bloat tradeoff)
```

### Go Comparison

Go only has interface-based dispatch (equivalent to virtual dispatch). There is no compile-time strategy pattern without generics. With Go 1.18+ generics, compile-time strategies are possible but not yet idiomatic:

```go
// Go generics: compile-time strategy (Go 1.18+)
type Sorter[T any] interface {
    Sort(data []T)
}

type Processor[T any, S Sorter[T]] struct {
    strategy S
}
```

For most Go code, an interface parameter is the idiomatic choice and the 3-5 ns overhead is acceptable. C++ engineers reach for templates when that overhead is not acceptable, specifically for per-element operations and high-frequency call sites.

---
