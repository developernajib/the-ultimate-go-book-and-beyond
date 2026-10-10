## Property-Based Testing with RapidCheck

Unit tests verify specific examples. Property-based testing verifies invariants, statements that must hold for every possible input. If your sort function is correct, then for any input vector, the output must be sorted and must be a permutation of the input. You do not enumerate the cases. You state the property and let the framework generate hundreds of random cases to try to falsify it.

RapidCheck is the leading C++ port of Haskell's QuickCheck. It integrates with gtest and Catch2, provides type-aware random generators for all standard types, and, critically, automatically shrinks failing inputs to the minimal reproducing case.

### Core Concepts

C++20 concepts provide first-class syntax for expressing template constraints, replacing the SFINAE idiom with readable, compiler-enforced requirements. Constraints are checked at the call site, producing clear error messages when a type does not satisfy the required interface.
```cpp
#include <rapidcheck.h>
#include <rapidcheck/gtest.h>
#include <algorithm>
#include <vector>
#include <numeric>

// RC_GTEST_PROP(Suite, Name, (typed_args...)) runs the body
// with randomly generated values for each argument type.
// The framework generates 100 test cases by default (configurable).

RC_GTEST_PROP(SortProperties, OutputIsSorted, (std::vector<int> input)) {
    std::vector<int> result = input;
    std::sort(result.begin(), result.end());

    // Property 1: output is sorted
    RC_ASSERT(std::is_sorted(result.begin(), result.end()));
}

RC_GTEST_PROP(SortProperties, OutputIsPermutationOfInput, (std::vector<int> input)) {
    std::vector<int> result = input;
    std::sort(result.begin(), result.end());

    // Property 2: no elements added or removed
    std::vector<int> sorted_input = input;
    std::sort(sorted_input.begin(), sorted_input.end());
    RC_ASSERT(result == sorted_input);
}

RC_GTEST_PROP(SortProperties, SortIsIdempotent, (std::vector<int> input)) {
    std::vector<int> once = input;
    std::sort(once.begin(), once.end());

    std::vector<int> twice = once;
    std::sort(twice.begin(), twice.end());

    // Property 3: sorting an already-sorted vector changes nothing
    RC_ASSERT(once == twice);
}
```

### Built-In Generators

RapidCheck infers generators from argument types automatically. For finer control, use the `rc::gen::` namespace:

```cpp
#include <rapidcheck.h>
#include <rapidcheck/gtest.h>

RC_GTEST_PROP(ArithmeticProperties, AdditionIsCommutative,
              (int a, int b)) {
    RC_ASSERT(a + b == b + a);
}

RC_GTEST_PROP(ArithmeticProperties, MultiplicationDistributesOverAddition,
              (int a, int b, int c)) {
    // Cast to avoid signed overflow UB
    long long la = a, lb = b, lc = c;
    RC_ASSERT(la * (lb + lc) == la * lb + la * lc);
}

// Generate values from a restricted range
RC_GTEST_PROP(DivisionProperties, DivisionRoundsDown, ()) {
    int a = *rc::gen::inRange<int>(0, 1'000'000);
    int b = *rc::gen::inRange<int>(1, 1'000);  // non-zero divisor

    RC_ASSERT(a / b == static_cast<int>(std::floor(static_cast<double>(a) / b)));
}

// Generate containers with elements from a specific generator
RC_GTEST_PROP(ContainerProperties, VectorSumIsCorrect, ()) {
    auto vec = *rc::gen::container<std::vector<int>>(
        rc::gen::inRange<int>(0, 100)
    );

    long long expected = 0;
    for (int x : vec) expected += x;

    long long actual = std::accumulate(vec.begin(), vec.end(), 0LL);
    RC_ASSERT(actual == expected);
}
```

### Automatic Shrinking

When a property fails, RapidCheck automatically minimizes the counterexample. If a bug triggers on a vector of 500 elements, RapidCheck will shrink it down to the minimal 3-element vector that still reproduces the failure. This is the feature that makes property-based testing practical, the failure you investigate is already small.

```cpp
// Deliberately buggy function to demonstrate shrinking
int buggy_min(const std::vector<int>& v) {
    if (v.empty()) return 0;
    // Bug: returns first element, not minimum
    return v.front();
}

RC_GTEST_PROP(BuggyMinProperties, ReturnsActualMinimum, (std::vector<int> v)) {
    if (v.empty()) return;  // RC_PRE can skip cases: RC_PRE(!v.empty());

    int result = buggy_min(v);
    int expected = *std::min_element(v.begin(), v.end());

    // Failure: RapidCheck will shrink to a 2-element vector like {1, 0}
    // where front (1) != min (0)
    RC_ASSERT(result == expected);
}
```

The failure message will show:
```
Falsifiable after 7 tests.
Counterexample: {[1, 0]}
```

### Custom Generators

For domain types, define generators using `rc::gen::map` and `rc::gen::bind`:

```cpp
#include <rapidcheck.h>
#include <rapidcheck/gtest.h>

struct Rectangle {
    int width;
    int height;

    int area() const { return width * height; }
    int perimeter() const { return 2 * (width + height); }
};

// Build a generator for Rectangle from two int generators
namespace rc {
template <>
struct Arbitrary<Rectangle> {
    static Gen<Rectangle> arbitrary() {
        return gen::build<Rectangle>(
            gen::set(&Rectangle::width,  gen::inRange<int>(1, 1000)),
            gen::set(&Rectangle::height, gen::inRange<int>(1, 1000))
        );
    }
};
} // namespace rc

RC_GTEST_PROP(RectangleProperties, AreaIsWidthTimesHeight, (Rectangle r)) {
    RC_ASSERT(r.area() == r.width * r.height);
}

RC_GTEST_PROP(RectangleProperties, PerimeterIsTwiceSumOfSides, (Rectangle r)) {
    RC_ASSERT(r.perimeter() == 2 * (r.width + r.height));
}

RC_GTEST_PROP(RectangleProperties, SquareHasEqualSides, ()) {
    int side = *rc::gen::inRange<int>(1, 500);
    Rectangle square{side, side};
    RC_ASSERT(square.width == square.height);
    RC_ASSERT(square.area() == side * side);
}
```

### Stateful Property Testing (Command-Based)

For data structures with mutable state, use command-based testing: generate sequences of random operations, execute them on both your implementation and a reference model, and compare observable state.

```cpp
#include <rapidcheck.h>
#include <rapidcheck/state.h>
#include <rapidcheck/gtest.h>
#include <deque>
#include <vector>

// The system under test: a fixed-capacity circular buffer
template <typename T>
class CircularBuffer {
public:
    explicit CircularBuffer(size_t cap) : cap_(cap) {}
    void push(T val) {
        if (buf_.size() == cap_) buf_.pop_front();
        buf_.push_back(std::move(val));
    }
    T pop_front() { T v = buf_.front(); buf_.pop_front(); return v; }
    size_t size() const { return buf_.size(); }
    bool empty() const { return buf_.empty(); }
private:
    size_t cap_;
    std::deque<T> buf_;
};

// The reference model: just a deque that matches the expected behavior
using Model = std::vector<int>;

struct PushCommand : rc::state::Command<Model, CircularBuffer<int>> {
    int value;
    explicit PushCommand(int v) : value(v) {}

    void apply(Model& model) const override {
        if (model.size() == 8) model.erase(model.begin());
        model.push_back(value);
    }

    void run(const Model& model, CircularBuffer<int>& sut) const override {
        sut.push(value);
        RC_ASSERT(sut.size() == model.size());
    }
};

RC_GTEST_PROP(CircularBufferProperties, MatchesReferenceModel, ()) {
    CircularBuffer<int> sut(8);
    Model model;

    rc::state::check(
        model,
        sut,
        rc::state::gen::execOneOfWithArgs<PushCommand>(
            rc::gen::arbitrary<int>()
        )
    );
}
```

### Configuration

RapidCheck reads the `RC_PARAMS` environment variable at startup, so test case count and seed can be overridden per CI run without recompiling. Setting `max_success=500` via environment is the standard CI practice: keep it low enough not to blow the test budget but high enough to catch non-obvious edge cases that the default 100 cases miss.
```cpp
// Set number of test cases via environment variable:
// RC_PARAMS="max_success=500" ./tests

// Or programmatically in main():
rc::detail::configuration().max_success = 500;
```

### CMake Integration

Integrating RapidCheck with CMake follows the same `FetchContent` pattern used for GoogleTest. The snippet below fetches a pinned commit and links it alongside your test framework.
```cmake
include(FetchContent)
FetchContent_Declare(
    rapidcheck
    GIT_REPOSITORY https://github.com/emil-e/rapidcheck.git
    GIT_TAG        master
)
FetchContent_MakeAvailable(rapidcheck)

target_link_libraries(my_tests PRIVATE
    rapidcheck
    rapidcheck_gtest   # provides RC_GTEST_PROP integration
    GTest::gtest_main
)
```

### Go Comparison

Go's `testing/quick` package provides basic property testing: `quick.Check(func(x int) bool { ... }, nil)`. It is minimal, no shrinking, no compound generators, no stateful testing. `pgregory.net/rapid` is the Go equivalent to RapidCheck: it has shrinking, custom generators via `rapid.Custom`, and stateful machine testing. For C++, RapidCheck is the clear choice. Both tools share the same philosophy: state what must be true, not just what is true for specific inputs.

---
