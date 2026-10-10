## CBMC and Bounded Model Checking

CBMC (the C Bounded Model Checker) is the most production-deployed deductive-style tool in the C and C++ space. Maintained by Daniel Kroening's group, now at Amazon and the University of Oxford, CBMC has been used since 2015 by Amazon Web Services to verify the AWS C Common Runtime, the s2n-tls library, and parts of the Boot Loader code that runs on every EC2 instance.

### How BMC works

Take a program, unroll every loop to a fixed depth k, replace recursion with bounded inlining, encode the result plus the negation of the property as a single bit-precise formula, and ship to a SAT or SMT solver.

```
P(x) and not Spec(x)   is SAT  =>  counterexample exists at depth <= k
                       is UNSAT =>  property holds for all inputs at depth <= k
```

That is the entire idea. The genius is in engineering: bit-blasting C semantics correctly (signed overflow, pointer arithmetic, struct padding, aliasing, the C memory model), interfacing to MiniSAT/CaDiCaL/Z3, and producing readable counterexample traces.

### A first proof

```c
#include <assert.h>
#include <stdint.h>

uint32_t saturating_add(uint32_t a, uint32_t b) {
    uint32_t c = a + b;
    return (c < a) ? UINT32_MAX : c;
}

void harness(void) {
    uint32_t a, b;
    __CPROVER_assume(1);            // any value
    uint32_t r = saturating_add(a, b);
    assert(r >= a);                 // saturation does not lose monotonicity
    assert(r >= b);
}
```

Run:

```sh
cbmc --function harness saturating.c
```

Output if the property holds:

```
[harness.assertion.1] line 12 assertion r >= a: SUCCESS
[harness.assertion.2] line 13 assertion r >= b: SUCCESS
VERIFICATION SUCCESSFUL
```

Output on a real bug, with `--trace`, gives concrete values for `a` and `b` that violate the assertion. The trace is what makes BMC engineering-friendly. WP gives you "Alt-Ergo timed out". CBMC gives you "a=3, b=4, r=2, line 7 reached".

### Loop unwinding

Loops are the heart of the bound:

```c
void sum_to_n(int n) {
    int s = 0;
    for (int i = 0; i <= n; i++) s += i;
    assert(s == n*(n+1)/2);
}
```

```sh
cbmc --unwind 11 --unwinding-assertions sum.c
```

`--unwinding-assertions` adds a check that the loop *actually terminated* within the unwind bound. Without it, CBMC silently truncates. With it, you get a "unwinding assertion" failure if the bound was insufficient. ASIL-D and DO-178C reviews insist on this flag.

For loops with a fixed compile-time bound, CBMC can prove unbounded correctness. For loops bounded by a runtime parameter, you prove correctness up to a chosen k and document the bound as a precondition.

### Harness writing

The CBMC discipline is **proof harness per function**. AWS's pattern, codified in their CBMC Starter Kit:

```c
// proofs/aws_byte_buf_init/aws_byte_buf_init_harness.c
void aws_byte_buf_init_harness(void) {
    struct aws_allocator *alloc = can_fail_allocator();
    struct aws_byte_buf buf;
    size_t capacity;
    __CPROVER_assume(capacity <= MAX_BUFFER_SIZE);

    if (aws_byte_buf_init(&buf, alloc, capacity) == AWS_OP_SUCCESS) {
        assert(aws_byte_buf_is_valid(&buf));
        assert(buf.capacity == capacity);
        assert(buf.len == 0);
        aws_byte_buf_clean_up(&buf);
    }
}
```

`can_fail_allocator()` is a CBMC stub that nondeterministically returns NULL or a valid allocator. `__CPROVER_assume` constrains symbolic inputs. `aws_byte_buf_is_valid` is the data-structure invariant the team chose to maintain.

The discipline:

1. One harness per public function.
2. Bound every input (`MAX_BUFFER_SIZE`, `MAX_STRING_LENGTH`).
3. Assert the data-structure invariant on entry and exit.
4. Run on every commit in CI.
5. When a harness times out, refactor the function or split the proof, do not weaken the bound silently.

AWS publishes about 700 CBMC harnesses in `aws-c-common`, `s2n-tls`, and `aws-c-cal`. Each runs in roughly 30 seconds to 5 minutes. The full suite runs nightly.

### Witness generation

CBMC emits **GraphML witnesses** compatible with SV-COMP (Software Verification Competition). A witness is a machine-readable description of either the counterexample path or the proof structure. For certification, the witness becomes part of the evidence package.

```sh
cbmc --graphml-witness witness.graphml ...
```

### ESBMC

ESBMC (Efficient SMT-based BMC, University of Manchester) is the fork that supports a wider C++ subset, including some templates and exceptions, with Z3 or Boolector as backend. ESBMC won SV-COMP's C++ track in 2023 and 2024. If you need BMC on production C++ rather than C, ESBMC is the realistic starting point.

```sh
esbmc --cpp17 --unwind 8 --no-unwinding-assertions \
      --memory-leak-check --overflow-check my_class.cpp
```

### CBMC for the C++ subset

CBMC itself supports `--cpp` for a C++03/C++11 subset: classes, single inheritance, templates after instantiation, no exceptions. Realistic targets:

- Bit-twiddling utility classes.
- Fixed-size container implementations.
- Parser state machines compiled from a grammar.
- Lock-free data structures (combined with a memory-model option).

What does *not* work: heavy template metaprogramming, `std::variant`/`std::any`, exceptions across abstraction boundaries, dynamic polymorphism through smart pointers.

### Concurrency

CBMC supports a sequentially consistent and a partial-order weak memory model (`--mm sc`, `--mm tso`, `--mm pso`). Useful for verifying small lock-free primitives:

```c
_Atomic int x = 0, y = 0;
int r1, r2;

void *t1(void *_) { x = 1; r1 = y; return 0; }
void *t2(void *_) { y = 1; r2 = x; return 0; }
```

Under SC, you can prove `r1 == 0 && r2 == 0` is unreachable. Under TSO (x86) you cannot, store-buffer reordering allows it. CBMC will produce a counterexample showing the reorder.

### Cost and integration

Realistic numbers from AWS C Common Runtime, public:

- Roughly 5 to 10 engineer-days to add the first CBMC proof to a new module.
- Roughly 1 hour per additional function once the harness scaffolding exists.
- CI cost: full CBMC suite for s2n-tls runs on a c5.4xlarge in roughly 45 minutes.
- Bug catch rate: the AWS team reports CBMC has caught dozens of memory-safety regressions before merge that ASan/UBSan missed because they required specific symbolic inputs.

### When to choose CBMC

Reach for CBMC when:

- Your code is in C or a tractable C++ subset.
- Functions are small (under 1000 lines) with bounded loops.
- The properties are local (memory safety, function contracts, simple invariants).
- You need machine-checkable evidence for certification or audit.

Avoid CBMC when:

- The whole-program state space is enormous (TLA+/TLC is better for distributed protocols).
- You need to prove properties about unbounded data structures (deductive verification with Frama-C WP or Coq is better).
- The hot loop has data-dependent unbounded depth.

> **Junior to FAANG.** First contact with CBMC: pick the smallest function in your service that touches untrusted input. Write a harness. Run it. Watch it find an overflow you did not know existed. The investment is one afternoon, the lesson is permanent.
