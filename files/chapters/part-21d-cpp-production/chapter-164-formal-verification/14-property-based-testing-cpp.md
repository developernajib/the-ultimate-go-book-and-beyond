## Property-Based Testing in C++

Property-based testing (PBT) is the cheapest formal-leaning technique you can adopt. You write a property the code should satisfy for *all* inputs, and a framework generates many inputs to falsify it. Not as strong as a proof, far stronger than handcrafted unit tests, and it scales to almost any function with a definable property.

QuickCheck (Claessen and Hughes, ICFP 2000) introduced the idea for Haskell. Hypothesis (David MacIver, 2013) introduced shrinking-as-search and brought PBT into mainstream Python. The C++ ports came later: RapidCheck (2014, by Emil Eriksson) is the closest analogue, with several smaller libraries (CppCheck-style, fuzz-style) covering related ground.

### The core loop

```cpp
#include <rapidcheck.h>
#include <vector>
#include <algorithm>

int main() {
    rc::check("reverse twice is identity", [](std::vector<int> v) {
        auto u = v;
        std::reverse(v.begin(), v.end());
        std::reverse(v.begin(), v.end());
        RC_ASSERT(v == u);
    });

    rc::check("sort idempotent", [](std::vector<int> v) {
        std::sort(v.begin(), v.end());
        auto sorted_once = v;
        std::sort(v.begin(), v.end());
        RC_ASSERT(v == sorted_once);
    });

    rc::check("sort produces non-decreasing sequence", [](std::vector<int> v) {
        std::sort(v.begin(), v.end());
        for (size_t i = 1; i < v.size(); i++) {
            RC_ASSERT(v[i - 1] <= v[i]);
        }
    });

    return 0;
}
```

The default 100 cases per property is the convention. RapidCheck mutates and shrinks failures to minimal counterexamples. The output of a failing case is the shrunken witness, not the random one that triggered the failure.

### Generators

RapidCheck infers generators for primitive types and standard containers. For domain types you define your own:

```cpp
namespace rc {
template<>
struct Arbitrary<UserId> {
    static Gen<UserId> arbitrary() {
        return gen::construct<UserId>(
            gen::inRange<uint64_t>(1, 1'000'000'000)
        );
    }
};

template<>
struct Arbitrary<Order> {
    static Gen<Order> arbitrary() {
        return gen::build<Order>(
            gen::set(&Order::id, gen::arbitrary<UserId>()),
            gen::set(&Order::quantity, gen::inRange(1, 1000)),
            gen::set(&Order::price, gen::positive<double>())
        );
    }
};
```

The investment in generators is the main upfront cost. Generators encode the **valid input distribution** for your domain, which is itself a documented spec.

### Shrinking

When a property fails, the framework searches for a smaller failing input. The default for `std::vector<int>` shrinks toward shorter lists with smaller numbers. You see the minimal failure, not noise.

```
Falsifiable after 47 tests and 12 shrinks
[1, 0, -1]   // from a much larger random vector
```

Shrinking is the difference between PBT being useful and being noise. A failure on a 1000-element vector with random values tells you nothing. A failure on `[1, 0, -1]` tells you the comparison function is broken on negative numbers.

### Stateful testing

The deepest pattern PBT enables. Generate a sequence of operations on a stateful object, run the sequence against a model and the real implementation, assert they agree at every step.

```cpp
struct StackModel {
    std::vector<int> data;
};

struct Push : rc::state::Command<StackModel, MyStack> {
    int value = *rc::gen::arbitrary<int>();

    void apply(StackModel& m) const override { m.data.push_back(value); }
    void run(const StackModel&, MyStack& s) const override { s.push(value); }
    void show(std::ostream& os) const override { os << "Push(" << value << ")"; }
};

struct Pop : rc::state::Command<StackModel, MyStack> {
    void checkPreconditions(const StackModel& m) const override {
        RC_PRE(!m.data.empty());
    }
    void apply(StackModel& m) const override { m.data.pop_back(); }
    void run(const StackModel& m, MyStack& s) const override {
        RC_ASSERT(s.pop() == m.data.back());
    }
};

rc::check([] {
    StackModel m;
    MyStack s;
    rc::state::check(m, s, rc::state::gen::execOneOfWithArgs<Push, Pop>());
});
```

The model is a reference implementation (often `std::vector` or similar), the system under test is your real implementation. RapidCheck generates command sequences, runs both, and shrinks any divergence.

This is how Jepsen-style tests find consistency bugs. Stateful PBT is the closest a C++ project comes to TLA+ at the implementation level.

### Hypothesis-style features and what RapidCheck lacks

Hypothesis (Python) has features RapidCheck does not match in 2026:

- **Database**. Failures are persisted, replayed first on next run. RapidCheck has partial support.
- **Targeted PBT**. Optimization-style search for inputs that maximize some metric. Useful for performance regressions.
- **Stateful "rules" with concise syntax**. RapidCheck's stateful API is more verbose.
- **`@example` decorators**. Pinning specific inputs alongside random ones. RapidCheck makes you do this manually.

C++ alternatives competing with RapidCheck:

- **fast-check** (TypeScript inspiration), C++ port in early stages.
- **CppFuzz**: thinner, focused on generator composition.
- Several internal frameworks at large companies (Google's Fuzztest is the most relevant, an OSS release combining property tests with structured fuzzing).

**Fuzztest** (Google, 2022, OSS) is worth particular attention. It bridges fuzzing and PBT: write a property as a function with parameters, let libFuzzer drive coverage, and shrink failures. As of 2026 it is the most production-grade C++ option for high-volume property testing.

```cpp
#include "fuzztest/fuzztest.h"

void DoesNotCrashOnAnyString(const std::string& s) {
    MyParser p;
    p.parse(s);  // no crash means property holds
}
FUZZ_TEST(MySuite, DoesNotCrashOnAnyString);

void RoundTrips(const std::vector<int>& v) {
    auto serialized = serialize(v);
    auto deserialized = deserialize(serialized);
    EXPECT_EQ(v, deserialized);
}
FUZZ_TEST(MySuite, RoundTrips);
```

Fuzztest reuses GoogleTest infrastructure, integrates with Bazel, and runs both as deterministic tests (CI) and as fuzz tests (long-running). Adoption inside Google is widespread.

### Comparison with deterministic test generation

| | Hand-written tests | PBT | Coverage-guided fuzzing |
| --- | --- | --- | --- |
| Inputs | Hand-picked | Random + shrunk | Mutated for coverage |
| Coverage strategy | Engineer judgment | Distribution of generators | CFG edges |
| What it proves | Property on chosen inputs | Property on sampled inputs | No crash on reached inputs |
| Effort | Low per test, high count | Moderate per property, low count | Low per harness, machine time |
| Best for | Regression locks | Algorithmic correctness | Memory safety on parsers |

The right deployment is all three. PBT and fuzzing are complementary: PBT verifies semantic properties (round-trip, idempotence, agreement-with-model), fuzzing verifies absence of crashes. A well-instrumented project runs both.

### Property design patterns

The four patterns that cover most useful PBT properties:

1. **Round-trip**. `decode(encode(x)) == x`. Catches encoder/decoder asymmetries.
2. **Algebraic identity**. `reverse(reverse(x)) == x`, `sort(sort(x)) == sort(x)`, `add(x, 0) == x`. Catches edge-case-free semantic violations.
3. **Model agreement**. Run real implementation against simple reference, assert equal output. Catches optimization bugs in the real implementation.
4. **Invariant preservation**. After any operation, the data structure invariant holds. Catches bugs that corrupt internal state.

Properties beyond these (performance bounds, security properties) need more sophisticated generators and metrics.

### Pitfalls

1. **Generators are too narrow**. Default integer generators bias toward small values. Explicitly include INT_MAX, INT_MIN, 0, and -1 if your code is sensitive to them.
2. **Properties are too weak**. "Function returns without crashing" is fuzzing, not PBT. PBT properties should compare to a reference or assert structural invariants.
3. **Properties have false positives**. A sloppy property fires on inputs you do not care about. Use `RC_PRE` to constrain.
4. **Generators do not converge in shrinking**. Recursive generators with no base case can loop. Always provide a terminating shrink path.
5. **No corpus persistence**. A failing case found once is forgotten on next run. Add a regression test for each shrunk failure manually until your framework supports persistence.

### When PBT is the right answer

- Pure functions with simple specs (parsers, codecs, mathematical kernels, sorting, hashing).
- Data structures with invariants you can express.
- Algorithms with a slow reference implementation to compare against.
- Stateful APIs where a model exists.

When PBT is **not** enough:

- High-stakes code where you need a proof, not sampling.
- Code with no expressible reference (UI, system integration).
- Memory-safety bugs hidden behind exotic input formats (use fuzzing).

### Cost

Realistic numbers:

- First property on a new function: under an hour.
- Generator for a custom domain type: 1 to 4 hours depending on complexity.
- Stateful test for a non-trivial data structure: 1 to 3 days.
- Maintenance overhead: low, properties survive refactoring better than unit tests.
- Bug catch rate: high in the first weeks of a new property suite, settling to occasional regressions.

PBT is one of the highest-ROI testing investments available. The barrier is engineer fluency, not tooling.

> **Junior to FAANG.** Pick one pure function in your codebase next week and write three property tests for it. Use RapidCheck or Fuzztest. Watch the first one fail. The lesson sticks.

> **Senior at FAANG.** Property-based testing is what your team should be doing before any conversation about deductive verification. It costs an order of magnitude less than Frama-C/WP and catches a substantial fraction of the bugs deductive verification catches. Build the PBT discipline first, then escalate to deductive proof for the components that warrant it.
