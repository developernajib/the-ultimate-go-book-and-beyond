## C++26 Contracts (P2900)

After two failed attempts (C++20 contracts were pulled before standardization, and a 2018-era proposal collapsed), C++26 contracts are converging via P2900 and its successors. As of early 2026 the proposal is in the late stages of standardization. This section covers the design as it currently stands, with the caveat that small details may shift before final ratification.

Contracts are not formal verification. Contracts are **runtime** checks that the standard sanctions, with optional **compile-time** elaboration, plus a hook for static tools to consume them. The right framing: contracts give every C++ function a documented spec the compiler understands, which is the precondition for any future verification effort.

### Syntax

```cpp
int divide(int x, int y)
    pre(y != 0)
    post(r : r * y == x)
{
    return x / y;
}

void process(std::span<int> v) {
    contract_assert(!v.empty());
    contract_assert(v.size() < 1024);
    // ...
}
```

Three contract kinds:

- `pre(expr)` precondition, evaluated on entry.
- `post(name : expr)` postcondition, evaluated on return, `name` binds the return value.
- `contract_assert(expr)` arbitrary mid-function check.

Multiple `pre` and `post` clauses compose conjunctively.

### Evaluation modes

The proposal defines several **contract evaluation semantics** the implementation may choose:

| Semantic | Behavior |
| --- | --- |
| `ignore` | Contracts are not evaluated. Zero runtime cost. |
| `enforce` | Contracts evaluated, on violation, terminate (default for debug builds). |
| `observe` | Contracts evaluated, on violation, invoke a handler and continue. |
| `quick_enforce` | Contracts evaluated, on violation, terminate with minimal overhead. |

Toggleable per translation unit, typically via compiler flag (`-fcontract-evaluation-semantic=enforce`). The standard does not mandate one default, vendors decide.

The mode-toggle design is a compromise. Eiffel's contracts are always-on. Spec# and Dafny treat contracts as proof obligations. C++ landed on "runtime checks with knobs" because the C++ value system rejects mandatory overhead.

### Violation handling

```cpp
namespace std::contracts {
    enum class detection_mode { predicate_false, evaluation_exception };
    enum class evaluation_semantic { ignore, observe, enforce, quick_enforce };

    class contract_violation { /* location, kind, semantic, ... */ };
}

extern "C++" void handle_contract_violation(const std::contracts::contract_violation&);
```

User code can override `handle_contract_violation` to log, beacon, or terminate as the system requires. Default behavior under `enforce` is `std::abort`.

### What contracts give us

1. **Documented spec at the language level**. The compiler sees the spec, IDEs surface it, static analysers can consume it.
2. **Runtime checking for free in debug**. Catch violations during testing without writing assertion macros.
3. **Optimization hints**. Under `ignore`, a contract's truth can be assumed by the optimizer, enabling stronger code generation.
4. **A handle for verification tools**. CBMC, Frama-C/WP-cxx, future verifiers can read contracts as proof obligations.

### What contracts do *not* give us

1. **Static proof**. The compiler does not check that the function meets its postcondition. Only verification tools do.
2. **Exception safety**. A precondition that throws (e.g. lazily evaluating a complex expression) is itself a hazard.
3. **Side-effect freedom**. Contracts are evaluated, and if they have side effects, those happen. The standard discourages but does not prohibit.
4. **Generic-type contracts**. Concepts handle compile-time constraints, contracts are runtime. Combining the two for full template specs is still active design work.

### Comparison to other contract systems

#### Eiffel (Bertrand Meyer, 1986)

Eiffel introduced design-by-contract. Pre/post conditions, class invariants, loop invariants, all first-class. Contracts are inherited by subclasses with covariance/contravariance rules (Liskov substitution enforced at the language level). Always evaluated, cannot be turned off in production except via global flag.

C++ contracts are weaker by design. No class invariants in C++26 (deferred). No inheritance interaction. The "off in production" mode is the headline feature, which Meyer would call a category mistake.

#### Spec# (Microsoft Research, 2004 to 2010)

Spec# extended C# with contracts plus an automated verifier (Boogie + Z3). The verifier statically discharged most contracts at compile time. Runtime checks were the fallback.

Spec# was the closest serious industry experiment with contracts-as-proofs. It did not survive product transition (Code Contracts in .NET shipped, then was deprecated). Lessons: static verification of contracts is feasible for moderate code, but the language design has to support it, and the developer experience has to be acceptable.

#### Dafny (Microsoft Research, ongoing)

Dafny is a language designed around contracts plus automated verification. Every method has pre/post, the verifier discharges them via Boogie + Z3 at compile time, failure is a compile error. Dafny has been used to verify the IronFleet distributed systems work and several protocol implementations.

C++ contracts in `enforce` mode are roughly Dafny without the verifier. The verifier is the difference between assertion and proof.

### The optimization question

A contract under `ignore` semantics may be **assumed**:

```cpp
void scale(int* p, size_t n)
    pre(p != nullptr)
{
    for (size_t i = 0; i < n; i++) p[i] *= 2;
}
```

Under `ignore`, the compiler can assume `p != nullptr` and skip null checks downstream. Under `enforce`, the check happens. Under `observe`, the check happens but execution continues even on failure (the handler logs and returns).

This is precisely the "UB from assume-or-check" pattern that has caused trouble in C with `__builtin_unreachable` and in Rust with `unsafe` assumptions. The committee has tried to thread the needle: under `observe`, no UB is introduced, under `ignore`, the contract is a proof obligation the programmer assumes responsibility for.

### Static enforcement: the verification angle

The contract proposal explicitly leaves room for static verification tools to consume contracts. The expectation:

- Frama-C/WP-cxx will eventually read C++ contracts as ACSL-equivalent.
- CBMC will treat `pre` as `__CPROVER_assume`, `post` as `__CPROVER_assert`.
- Static analysers (Astrée, Polyspace) can use contracts to refine inter-procedural analysis.

Whether this materialises depends on tool vendor uptake. By 2026 it is partial: clang-tidy reads contracts for documentation purposes, sound analysers do not yet consume them.

### Migration from existing assertion macros

Real codebases already have something like contracts:

```cpp
void f(int* p, size_t n) {
    assert(p != nullptr);
    assert(n > 0);
    // ...
    auto r = compute();
    assert(r > 0);
    return r;
}
```

The C++26 transition path:

```cpp
auto f(int* p, size_t n)
    pre(p != nullptr)
    pre(n > 0)
    post(r : r > 0)
{
    return compute();
}
```

The mechanical translation is straightforward. The semantic improvement: pre and post are visible to the compiler at the call site, the optimizer can use them under `ignore`, and tools can extract them.

### Caveat: this is shipping in 2026 / 2027

As of this writing the proposal is stable but not all compiler vendors have shipped. MSVC has an experimental implementation behind a flag, clang has a partial implementation, gcc trails. By the time C++26 ratifies, all three majors will have at least basic support.

For new code today: write `[[expects: ...]]`-style assertions in comments or use a contract-emulating library (e.g., Microsoft's GSL provides `Expects(...)` and `Ensures(...)` macros), and migrate when the compiler supports it.

### Where contracts fit in the verification stack

| Level | Tool |
| --- | --- |
| Inline runtime check | `assert`, GSL `Expects` |
| Standardized runtime check | C++26 contracts in `enforce` |
| Static type-level constraint | Concepts |
| Static contract verification | Frama-C/WP-cxx consuming contracts (future) |
| Full proof | Coq/Lean/Isabelle |

C++26 contracts are necessary infrastructure for the verification ecosystem, not sufficient assurance on their own. They are the language hook that lets us bolt on stronger tools later.

> **Senior at FAANG.** Treat C++26 contracts as documentation that happens to be checkable. Write them on every public API. Choose `enforce` in debug, `ignore` (with care) in release for hot paths, `observe` plus a logging handler in production for everything else. The optimization gain from `ignore` is real but small, the assurance gain from `enforce` plus a logged handler is large. Default to safety.
