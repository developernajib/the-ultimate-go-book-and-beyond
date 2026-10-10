## ACSL and Frama-C

ACSL is the **ANSI/ISO C Specification Language**, a behavioral-contract notation for C functions. Frama-C is the open-source platform from CEA-List (France) that consumes ACSL annotations and runs analyses on them. The pair is the most production-ready deductive verification stack for C in 2026, and a restricted form (WP-cxx, experimental) handles a C++ subset.

### Annotation basics

ACSL annotations live in `/*@ ... */` comments. Four pillars: **requires**, **ensures**, **assigns**, and **loop invariant**.

```c
/*@
  requires \valid(dst + (0..n-1));
  requires \valid_read(src + (0..n-1));
  requires \separated(dst + (0..n-1), src + (0..n-1));
  assigns dst[0..n-1];
  ensures \forall integer i; 0 <= i < n ==> dst[i] == \old(src[i]);
*/
void my_memcpy(char *dst, const char *src, size_t n);
```

Read this as a contract:

- `requires` pre-conditions the caller must satisfy.
- `assigns` frame condition, the only memory the function may modify.
- `ensures` post-condition the function guarantees on return.
- `\valid(p + (0..n-1))` says the pointer range is allocated and writable.
- `\separated` rules out aliasing, which is exactly what real `memcpy` requires (see C11 7.24.2.1).
- `\old(e)` refers to the value of `e` at function entry.

Frama-C's WP plugin translates this contract plus the implementation into verification conditions and discharges them through Alt-Ergo, Z3, or CVC5. If all VCs go green, `my_memcpy` is proved correct for all inputs satisfying the precondition.

### Loop invariants

The classical hard part. WP cannot induct over a loop without an invariant.

```c
/*@
  requires n >= 0;
  requires \valid_read(a + (0..n-1));
  ensures \forall integer i; 0 <= i < n ==> \result >= a[i];
  ensures n > 0 ==> \exists integer i; 0 <= i < n && \result == a[i];
  ensures n == 0 ==> \result == INT_MIN;
*/
int max_array(const int *a, size_t n) {
    int m = INT_MIN;
    /*@
      loop invariant 0 <= i <= n;
      loop invariant \forall integer k; 0 <= k < i ==> m >= a[k];
      loop invariant i > 0 ==> \exists integer k; 0 <= k < i && m == a[k];
      loop assigns i, m;
      loop variant n - i;
    */
    for (size_t i = 0; i < n; i++) {
        if (a[i] > m) m = a[i];
    }
    return m;
}
```

The invariant must:

1. Hold at loop entry (base case).
2. Be preserved by the body (inductive step).
3. Combined with the negation of the loop condition, imply the post-condition.

The `loop variant` is a non-negative integer expression that strictly decreases each iteration, proving termination.

Writing invariants is the bottleneck of deductive verification. Tools like CBMC sidestep this by unrolling, paying with completeness. WP demands them, paying with engineering time. Recent Lean Copilot and Frama-C's experimental ML-based invariant suggester aim to automate this.

### Frama-C plugins

Frama-C is a kernel plus plugins. The plugins worth knowing:

| Plugin | Technique | What it gives you |
| --- | --- | --- |
| **Eva** | Abstract interpretation (value analysis) | Sound over-approximation of reachable values, runtime error detection |
| **WP** | Weakest-precondition deductive verification | Functional correctness against ACSL contracts |
| **Slicer** | Program slicing | Extract the subprogram relevant to a property |
| **Metrics** | Code metrics | Cyclomatic complexity, ACSL coverage |
| **E-ACSL** | Runtime assertion checker | Compile ACSL to runtime checks, like contracts |
| **RTE** | Runtime error generation | Auto-generate ACSL assertions for division-by-zero, overflow, etc. |
| **Aoraï** | LTL property checker | Temporal properties on call sequences |

### Verifying memcpy end to end

```sh
frama-c -wp -wp-rte -wp-prover alt-ergo,z3,cvc5 my_memcpy.c
```

`-wp-rte` generates runtime-error obligations (no overflow, no out-of-bound) automatically. `-wp-prover` lists the SMT backends to try in order. A clean run prints something like:

```
[wp] Proved goals:   12 / 12
  Qed:              4
  Alt-Ergo:         8
```

The 12 goals are: pre-condition admissibility, each loop invariant initialization, each invariant preservation, the assigns clause, the post-condition, and the runtime-error checks (no integer overflow on `n-1`, no out-of-bound on `dst[i]`).

### Bounded-loop safety in production

The pattern that ships in real avionics code:

```c
/*@
  requires n <= MAX_BUF;
  requires \valid(buf + (0..n-1));
  assigns buf[0..n-1];
*/
void zero_buffer(uint8_t *buf, size_t n) {
    /*@
      loop invariant 0 <= i <= n;
      loop invariant \forall integer k; 0 <= k < i ==> buf[k] == 0;
      loop assigns i, buf[0..n-1];
      loop variant n - i;
    */
    for (size_t i = 0; i < n; i++) buf[i] = 0;
}
```

The `n <= MAX_BUF` constraint is the trick that makes WP fast. Unbounded `size_t` parameters explode the SMT space. ASIL-D code conventions in the automotive industry routinely cap buffer sizes at compile time precisely so that abstract interpretation and WP terminate quickly.

### C++ via WP-cxx

WP-cxx (experimental as of Frama-C 28 Manganese, 2025) handles a C++ subset:

- Classes without virtual inheritance.
- Templates after instantiation (the verifier sees the monomorphised AST).
- `std::array`, `std::span` modeled as primitive ranges.
- No exceptions, no RTTI.
- `std::vector` modeled but with simplified allocator behavior.

The realistic workflow is: write your hot kernel in a C-with-classes style, annotate, prove, and let the rest of the codebase use it through a thin C++ facade. This is how parts of Airbus's certified code base are organized.

### Failure modes

Three reasons WP commonly fails to prove a true property:

1. **Insufficient invariant**. The user wrote a partial invariant that does not imply the post-condition. Fix: strengthen.
2. **SMT solver timeout**. Non-linear arithmetic, bit-vectors mixed with integers, quantifier alternations. Fix: split lemmas, provide hints, use `Coq` interactive proof for the hard ones.
3. **Spec is wrong**. The contract does not capture intended behavior. This is the most expensive failure mode and the strongest argument for property-based testing of the spec itself before investing in WP.

### When to reach for ACSL

Reach for ACSL when:

- The function is small (under 200 lines) and self-contained.
- The spec is naturally expressible (numeric, array-shape, ordering).
- The cost of a wrong implementation is high (crypto, control law, parser).
- The team has at least one engineer fluent in Hoare logic.

Avoid ACSL when:

- The component is large, stateful, and integrates with many libraries.
- The "spec" is "what the customer demoed last Tuesday".
- Time-to-market dominates assurance.

> **Senior at FAANG.** A team proposing "we will verify this with Frama-C WP" without a written spec, an estimate of invariant complexity, and a budget for SMT timeouts is proposing a research project, not an engineering deliverable. Push back and ask for the spec first. The hardest day in a verification project is the day you discover the spec is wrong after six months of proof work.
