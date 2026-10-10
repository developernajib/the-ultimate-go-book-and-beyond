## Differential and Model-Based Testing

For any implementation you suspect is subtly wrong (a JSON parser, a floating-point math library, a compression codec, a database query engine), differential testing gives you a production-grade correctness bar: run the same input through your implementation and a reference, and flag any disagreement. Model-based testing is the generalization: build a simple, obviously-correct specification, then compare it to the production implementation under randomly generated operation sequences.

### Differential Testing in Practice

```cpp
#include <gtest/gtest.h>
#include <rapidjson/document.h>
#include "my_json_parser.h"

#include <cstdlib>
#include <random>
#include <string>
#include <string_view>

std::string random_json(std::mt19937& rng, int depth = 0);  // corpus generator

TEST(JsonParserDifferential, MatchesRapidJson) {
    std::mt19937 rng(std::random_device{}());
    for (int i = 0; i < 10'000; ++i) {
        std::string input = random_json(rng);

        rapidjson::Document ref;
        bool ref_ok = !ref.Parse(input.c_str()).HasParseError();

        my::JsonValue candidate;
        bool cand_ok = my::parse(input, candidate);

        ASSERT_EQ(ref_ok, cand_ok)
            << "Parse success disagreement on input: " << input;

        if (ref_ok) {
            // Compare the canonicalized output.
            ASSERT_EQ(canonicalize(ref), canonicalize(candidate))
                << "Parse result disagreement on input: " << input;
        }
    }
}
```

The test fails the moment your parser disagrees with RapidJSON on any input. The generator can produce deeply nested objects, unicode edge cases, numeric boundary values, and malformed inputs. Any disagreement is a bug in one of the two parsers, and a minute of investigation narrows it down.

Differential testing is how LLVM's Clang team finds codegen bugs (diff against GCC), how database engines find query-planner bugs (diff against SQLite or PostgreSQL), and how browser vendors find DOM bugs (diff across browsers).

### Model-Based Testing

A model is a reference implementation, often simplified to the point of obvious correctness. For a concurrent queue, the model is a `std::deque` under a mutex. For a B-tree, the model is a `std::map`. You then generate random operation sequences and apply them to both the model and the system under test, asserting that observable outputs match at every step.

```cpp
#include <deque>
#include <mutex>
#include <random>
#include <vector>
#include <gtest/gtest.h>

#include "my_lockfree_queue.h"

class ModelQueue {
    std::deque<int> q_;
    std::mutex mu_;
public:
    void push(int v) { std::lock_guard g(mu_); q_.push_back(v); }
    bool try_pop(int& out) {
        std::lock_guard g(mu_);
        if (q_.empty()) return false;
        out = q_.front(); q_.pop_front(); return true;
    }
};

enum class Op { Push, Pop };
struct Action { Op op; int value; };

TEST(LockfreeQueueModel, MatchesReference) {
    std::mt19937 rng(0);
    std::uniform_int_distribution<int> ops(0, 1);
    std::uniform_int_distribution<int> values(0, 1 << 20);

    std::vector<Action> plan;
    for (int i = 0; i < 10'000; ++i) {
        plan.push_back({ops(rng) ? Op::Push : Op::Pop, values(rng)});
    }

    ModelQueue model;
    my::LockfreeQueue<int> candidate;

    for (const auto& a : plan) {
        if (a.op == Op::Push) {
            model.push(a.value);
            candidate.push(a.value);
        } else {
            int mref{}, mcand{};
            bool ok_ref  = model.try_pop(mref);
            bool ok_cand = candidate.try_pop(mcand);
            ASSERT_EQ(ok_ref, ok_cand);
            if (ok_ref) ASSERT_EQ(mref, mcand);
        }
    }
}
```

The single-threaded case shown above is the starting point. A more advanced setup runs the candidate under multiple threads with randomized scheduling (or the Linux scheduler's `sched_yield`), and compares final states after linearization. Tools like Jepsen (for distributed systems) and Stateright (for protocol models) formalize this pattern.

### Integrating with Fuzzing

The best of both worlds is to drive the differential comparison with libFuzzer's coverage-guided input generation. The fuzzer explores inputs that exercise new code paths, and the differential assertion catches divergent behavior at any of them.

```cpp
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    std::string_view input(reinterpret_cast<const char*>(data), size);

    rapidjson::Document ref;
    bool ref_ok = !ref.Parse(input.data(), input.size()).HasParseError();

    my::JsonValue cand;
    bool cand_ok = my::parse(input, cand);

    if (ref_ok != cand_ok) std::abort();  // divergence: fuzzer saves the input
    if (ref_ok && canonicalize(ref) != canonicalize(cand)) std::abort();

    return 0;
}
```

Run this under libFuzzer with ASan. Coverage-guided generation finds the edge cases (embedded nulls, surrogate-pair-split UTF-8, extremely deep nesting) that random generators miss.

### When Differential Testing Lies

Differential tests can fail for reasons other than bugs. Different JSON parsers may disagree on whether a trailing comma is valid (it is not in strict JSON, but many parsers accept it). Different floating-point libraries may produce last-bit differences on denormals. Before treating a divergence as a bug, consult both specifications and classify the input:
1. Both parsers agree it is valid and produce the same AST: pass.
2. Both parsers agree it is invalid: pass.
3. Both parsers agree it is valid but produce different ASTs: one of them is buggy.
4. One parser accepts and the other rejects: either the input is in a gray area of the spec, or one parser is buggy.

Category 4 is the hardest to triage, but it is also where most real-world parser bugs live. The fix is typically in the stricter parser, because the looser one is accepting malformed input that other components may mishandle downstream.
