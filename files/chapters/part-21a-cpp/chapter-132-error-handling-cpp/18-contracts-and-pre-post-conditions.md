## Contracts and Pre/Post-Conditions

A contract is a statement about the relationship between a function and its caller: what the caller must guarantee on entry (precondition), what the function guarantees on exit (postcondition), and what the function maintains throughout (invariant). C++ has had `assert` for decades and contracts proposals for almost as long. C++26 (P2900) finally lands a real contracts facility.

### The Pre-Contracts World

`assert` from `<cassert>` is the only standardized check. Limitations:

- Disabled by `NDEBUG` in release builds. Most production binaries run with `NDEBUG`. Most assertions never fire.
- No category. You cannot say "this is a precondition" vs "this is an internal invariant".
- No way to opt one assertion in for production while keeping others debug-only.
- Side effects in the expression vanish in release.

Industry workarounds:

- absl `CHECK` family: always-active, formatted message, integrated with logging, fatal.
- absl `DCHECK`: debug-only, like `assert` but uniformly across the codebase.
- Custom `ENFORCE` macros for precondition checking that survives release.
- Eiffel-style "design by contract" wrappers built on top.

```cpp
// Pre-C++26 idiomatic style
void Service::handle(const Request& r) {
    DCHECK_NE(r.session_id(), 0);            // internal sanity
    CHECK(state_ == State::Ready) << "service not ready"; // production safety
    // ...
    CHECK(invariant_holds());
}
```

## P2900: C++26 Contracts

The accepted-as-of-Kona-2024 design ([P2900R6] etc.) introduces three contract attributes:

```cpp
int parse_port(std::string_view s)
    pre (!s.empty())                         // precondition
    post (r : r > 0 && r <= 65535)           // postcondition with named result
{
    contract_assert(s.front() != '-');       // assertion mid-function
    int v = /* ... */;
    return v;
}
```

The exact syntax in C++26 may use `pre`, `post`, and `contract_assert` keywords (subject to the final wording landing). Each contract has a **semantic** chosen at translation time:

- `ignore`: not evaluated. Zero cost.
- `observe`: evaluated, on failure, the contract violation handler is called and execution continues.
- `enforce`: evaluated, on failure, the handler is called and execution terminates (default: `abort`).
- `quick_enforce`: evaluated, on failure, immediate termination without invoking the handler.

The build configures which semantic each contract has. A debug build picks `enforce` everywhere. A production build picks `observe` for cheap checks (logged, not fatal) and `enforce` for cheap, critical checks. A latency-critical inner loop picks `ignore` to drop them entirely.

This is the long-missing decoupling. With `assert`, "in or out" is binary and global. With contracts, you choose per build, per category, even per file.

## The Violation Handler

```cpp
namespace std::contracts {
    void invoke_default_contract_violation_handler(const contract_violation&);
}
```

The handler receives a `contract_violation` carrying:

- The kind (`pre`, `post`, `assert`).
- The semantic (`observe`, `enforce`).
- A textual representation of the predicate (implementation defined).
- Source location.
- The detection mode (predicate false, predicate threw an exception, etc.).

A custom handler logs structured error with category and source location:

```cpp
[[noreturn]] void on_violation(const std::contracts::contract_violation& v) {
    log_fatal({
        {"kind", static_cast<int>(v.kind())},
        {"semantic", static_cast<int>(v.semantic())},
        {"file", v.location().file_name()},
        {"line", v.location().line()},
        {"comment", v.comment()},
    });
    std::abort();
}
```

The handler is a single global function. You replace it via the standard "weak symbol replaced at link time" mechanism (analogous to `operator new` replacement).

## Comparison with Other Languages

**Eiffel.** Bertrand Meyer's "Design by Contract" coined the term. Eiffel had `require`, `ensure`, `invariant`, plus inheritance rules (preconditions weaken in subclasses, postconditions strengthen). C++ contracts adopt the names and the basic shape but not the full inheritance rules.

**Spec#.** Microsoft Research extension to C# with static checking via theorem provers. C++26 contracts are runtime-only, static checking was deferred. Tools like Z3-based verifiers can target them externally.

**Rust.** No language-level contracts. Crates like `contracts` provide attribute macros. Most Rust code uses `assert!`, `debug_assert!`, and `Result`.

**D.** Has `in`, `out`, `invariant` blocks since the start. Closest to what C++26 ships.

## Axiom Contracts

The current design includes a fourth category, axiom-style: contracts the compiler may **assume** without checking. The notation under discussion is `[[assume]]`:

```cpp
void hot(int* p, std::size_t n) {
    [[assume(n % 8 == 0)]];
    for (std::size_t i = 0; i < n; ++i) p[i] *= 2;
}
```

The optimizer is allowed to use `n % 8 == 0` for vectorization without inserting a runtime check. If the assumption is false at runtime, behavior is undefined. This is dangerous and load-bearing: use it only where you have an external proof and a static analyzer to verify it.

`[[assume]]` already exists as a vendor extension (`__builtin_assume` on Clang, `__assume` on MSVC). C++23 standardized the spelling via P1774.

### Static vs Dynamic

Contracts are dynamic by default. Static checking (proving contracts hold without running) requires a separate verifier. Tools that do this for C++:

- Microsoft VC++ `/analyze` plus SAL annotations.
- Frama-C with the C subset.
- The Verisol / Coq / Why3 ecosystems for embedded.
- Clang's static analyzer (`scan-build`) does some.

C++26 contracts give the verifiers a stable surface to consume, which is why static checking will accelerate after the language facility lands. Today, most contract checking in production C++ is dynamic, observed in CI fuzzers, and never reaches static proofs.

### Contracts and Exceptions

A contract violation is not an exception. The handler can throw, but the surrounding code typically does not expect it (especially if the contract is on a `noexcept` function). Standard guidance: do not throw from the handler. Log and abort.

A precondition that "throws" (the predicate evaluation itself throws) is treated as a contract violation with the throwing-detection mode. Predicates should be pure and total (no side effects, no allocation, no I/O). Pure predicates are also amenable to static checking later.

### Contracts in Practice (Pre-C++26)

Until C++26 ships in your toolchain, the closest equivalents are:

- absl `CHECK` for enforced contracts (always-on).
- `assert` or `DCHECK` for debug-only contracts.
- `[[assume]]` (compiler builtin) for axiom contracts.
- Concepts and `static_assert` for compile-time contracts on type parameters.

Mark the policy explicitly:

```cpp
#define EXPECT_NONNULL(p) CHECK_NE((p), nullptr)
#define EXPECT_RANGE(x, lo, hi) CHECK((x) >= (lo) && (x) <= (hi))
#define ASSUME_INVARIANT(cond) DCHECK(cond)
```

Three macros, three categories. When C++26 lands, the macros are mechanically replaced with `pre`, `post`, `contract_assert`.

### Common Mistakes

**Side effects in predicates.** A predicate that mutates state, allocates, or logs is a bug. The contract may be evaluated zero, one, or many times depending on semantic. Predicates are pure expressions of state.

**Overlapping responsibility.** A precondition that the function then re-checks internally and throws on violation is wasted work. Pick one: contract violation (programmer bug) or runtime exception (external input). External input is validated, internal misuse is contracted.

**Postconditions that are too strong.** A postcondition the function does not actually meet (off-by-one, edge cases) becomes a flaky test. Keep them tight enough to be useful, loose enough to be true.

**Treating contract violations as recoverable.** A contract violation is a programmer error. Recovery code is itself buggy by definition. Crash, restart, fix.

### FAANG Bar

A senior engineer should:

- Distinguish contracts from exceptions: contracts are about programmer errors, exceptions about runtime conditions.
- Pick the right semantic per build and per check.
- Avoid side effects in contract predicates.
- Implement a structured violation handler that logs and aborts.
- Use `[[assume]]` only with external proof, never as a generalization of `assert`.
- Apply Lakos's wide/narrow contract framing to API design.
