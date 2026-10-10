## Runtime Checks and Asserts

A C++ service that runs in production for years has thousands of invariants. "This pointer is non-null." "This index is in bounds." "This message has the right protocol version." Some of those invariants are checked by the type system. Most are not. The ones that are not need runtime assertions, and the discipline of which assertions ship enabled in production is one of the most consequential reliability decisions a team makes.

### The Spectrum of Assertions

C++ has a spectrum of assertion mechanisms, ordered roughly from cheapest to most expensive:

1. `assert(cond)` (libc). Compiled out in `NDEBUG` builds. Zero runtime cost in production. Useless for catching production bugs.
2. `static_assert(cond)`. Compile-time. Free.
3. `__builtin_assume(cond)` and `[[assume]]` (C++23). Optimization hint. The compiler trusts you. If you lie, undefined behavior.
4. `DCHECK(cond)` (Chromium, glog, absl). Debug-only check. Compiled out in release.
5. `CHECK(cond)` (Chromium, glog, absl). Always-on check. Aborts the process with a message and stack trace.
6. `FATAL` log. Equivalent to `CHECK(false)`.
7. `__builtin_trap()`. Crash immediately, no message. Used for "this should be unreachable" markers and for catching UB on optimized builds.

The interesting axis is which checks ship enabled in optimized production builds. Three philosophies:

**Philosophy A (textbook C++): NDEBUG everywhere.** The "assertions are for debugging" school. All checks vanish in production. The argument is performance. The result is that production failures take the form of silent corruption, segfaults with no context, or stack traces that point to a downstream library three frames removed from the actual bug.

**Philosophy B (Google, Chromium, modern Meta): CHECK is always on.** The argument is fail-fast. A `CHECK(ptr != nullptr)` that aborts immediately is far easier to debug than a segfault three frames later, and the cost of a single comparison is invisible at the request scale. `DCHECK` is for the expensive checks (full data-structure validation) that only run in debug.

**Philosophy C (HFT, embedded, real-time): nothing checks at runtime.** Performance dominates. The team relies on extensive static analysis, fuzzing, and formal proofs. The cost: when something does fail in production, debugging is brutal.

For a FAANG-tier service, the answer is overwhelmingly Philosophy B, with carefully chosen exceptions for the hottest inner loops.

### absl Logging in Practice

The Abseil logging library is the modern standard. It superseded glog in most Google C++ codebases, and the open-source absl release is what new projects start with.

```cpp
#include "absl/log/check.h"
#include "absl/log/log.h"

void Service::Process(Request* req) {
    CHECK(req != nullptr) << "null request reached Process";
    CHECK_GT(req->size(), 0) << "empty request: id=" << req->id();
    CHECK_LE(req->size(), kMaxSize)
        << "oversize request: id=" << req->id()
        << " size=" << req->size();

    DCHECK(req->is_valid()) << "valid() invariant: " << req->DebugString();

    LOG(INFO) << "processing request " << req->id();
    VLOG(2) << "detailed: " << req->DebugString();

    if (auto* cache = GetCache(); !cache) {
        LOG(WARNING) << "cache miss: " << req->id();
    }
}
```

`CHECK_GT`, `CHECK_LE`, `CHECK_EQ`, `CHECK_NE` are sugar over `CHECK`. They print the actual values on failure, which saves hours of debugging.

`VLOG(N)` is verbose-level logging. The level is controlled at runtime via a flag. `VLOG(2)` lines do not even evaluate their arguments unless the level is set to 2 or higher, so the streaming-cost is zero in normal operation.

### DCHECK vs CHECK: The Decision Rule

The rule:

- If the check is cheap (a comparison, a null check, a bounds check), make it a `CHECK`. Always on.
- If the check is expensive (full data-structure traversal, hash recomputation, `O(n)` validation), make it a `DCHECK`. Debug only.
- If the check is in a path that runs millions of times per second and benchmarks show a measurable cost, profile it. If the cost is real, demote to `DCHECK`. If the cost is in the noise, keep it as `CHECK`.

The cost of a `CHECK` in a hot path is rarely as high as engineers fear. A modern CPU branch-predicts the not-taken case correctly 99.99% of the time. The actual cost is one cycle and an L1 instruction-cache slot. A 100-byte CHECK message in the not-taken path costs nothing because it never executes.

### cheap_assert vs expensive_assert

Some teams add a third tier:

```cpp
#define CHEAP_ASSERT(cond) CHECK(cond)
#define EXPENSIVE_ASSERT(cond) DCHECK(cond)
```

with the convention that `EXPENSIVE_ASSERT` is for `O(n)` or worse predicates that should run in CI and on a small canary, but not in production. A flag enables them on the canary.

```cpp
EXPENSIVE_ASSERT(is_sorted(buffer.begin(), buffer.end()));
```

This is the right pattern when you have algorithmic invariants that are too expensive to check on every operation but valuable enough to verify continuously somewhere.

### BUILD_TYPE-Conditional Checks

A real production codebase has at least three build modes:

- `dbg`: full debug, all checks, `-O0`, sanitizers enabled. Used for development and CI.
- `opt`: production. `-O2`, `CHECK` enabled, `DCHECK` disabled, frame pointers on.
- `fastbuild`: a minimal-instrumentation mode for stress tests where every nanosecond counts. `CHECK` and `DCHECK` both off.

A clean build system (Bazel, CMake with presets) makes these one-flag choices.

### The Cost of Not Checking

A real example: a search backend used `vector::operator[]` in a hot path. A bug in the indexing math caused an out-of-bounds read once in 10 million queries. In production, the read either silently returned garbage (slight ranking corruption that nobody noticed) or segfaulted (about one in 100 of the bad reads, when the address happened to be unmapped). The team only noticed the bug when a customer complained about a specific query that consistently returned wrong results.

Replacing `vector::operator[]` with `vector::at` (which throws on out-of-bounds) would have caught the bug in two days, because the resulting `std::out_of_range` exception would have appeared in the error logs. The cost: roughly 1% throughput. The benefit: a bug found in days instead of months. For most services, that trade is correct.

The strongest version of this lesson is the Google C++ style guide, which encourages `CHECK_LT(i, v.size())` immediately before any indexed access, especially when the index comes from an external input.

### Defensive Programming Without Rotting

Two patterns to avoid:

**Boilerplate that nobody trusts.** A function that starts with twenty `CHECK_NOTNULL`s on every parameter is not telling you anything you did not already know from the type signature. Use references where you mean non-null, and reserve `CHECK_NOTNULL` for places where the precondition is genuinely uncertain.

**Recoverable conditions checked with CHECK.** Network errors, malformed user input, missing files. These are not invariant violations. They are expected runtime conditions, and they should produce errors, not aborts. Reserve `CHECK` for invariants you genuinely believe cannot fail except by bug.

The mental rule: a `CHECK` that fires is always a bug. If a `CHECK` could fire because of a malicious user, network failure, or disk full, it is the wrong tool. Use a `Status` return, an exception, or graceful degradation.

### Production Behavior on CHECK Failure

When a `CHECK` fires in production:

1. The message and stack trace go to the log.
2. The process aborts with `SIGABRT`.
3. The supervisor (Kubernetes, systemd) restarts the process.
4. If `CHECK` failures cluster (for example, on a specific input pattern), the load balancer should detect the elevated restart rate and route traffic away.

The third and fourth steps are non-obvious and important. A `CHECK` that fires on every request to one machine will crash-loop until the supervisor's backoff kicks in. A `CHECK` that fires on a particular query type will crash one machine per matching query, eventually crashing all of them. This is not a flaw in `CHECK`, it is the correct behavior for an invariant violation, but it argues for combining `CHECK` with circuit breakers and request shedding (chapter 12, 13) so that a single bad query does not take down the fleet.

### Senior at FAANG: The Cultural Move

A senior engineer's `CHECK` strategy is part of the service's reliability posture, not a private style preference. The team agrees on which classes of conditions warrant `CHECK`, the bar for when a `CHECK` graduates to `DCHECK` because of measured cost, and the postmortem ritual that follows every `CHECK` firing in production. A `CHECK` failure is never just "the binary crashed." It is "an invariant we believed was inviolable was violated, and here is what we will change to make sure it does not happen again."

---
