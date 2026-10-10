## The Spectrum from Testing to Proof

Verification is not one technique, it is a continuum. Each step up costs more engineering and rules out more bugs. Picking the wrong level is how teams either ship buggy software or spend a year proving the wrong property.

### The ladder

```
Level 0  Code review                  catches some bugs, no formal guarantee
Level 1  Unit tests                   property holds on chosen examples
Level 2  Property-based tests         property holds on randomly sampled inputs (with shrinking)
Level 3  Coverage-guided fuzzing      property (no crash, no UBSan trap) holds on inputs the fuzzer reaches
Level 4  Symbolic execution           property holds on every path the engine explores within budget
Level 5  Bounded model checking       property holds on every input up to a bound (loop unrolling depth k)
Level 6  Abstract interpretation      property holds on an over-approximation of all reachable states
Level 7  Deductive verification       property holds on every input, given an SMT solver discharges the VCs
Level 8  Mechanised proof in a kernel property holds, machine-checked against a small trusted kernel
```

The shape of the cost curve is roughly exponential. Going from unit tests to property-based testing costs maybe 1.5x. Going from fuzzing to deductive verification with WP costs 5x to 10x. Going from WP to a full Coq proof on a non-trivial component is another 3x to 5x.

### What each level guarantees

#### Level 1: unit tests

```cpp
TEST(Stack, PushPopRoundtrip) {
    Stack<int> s;
    s.push(42);
    EXPECT_EQ(s.pop(), 42);
}
```

Guarantees: the property holds for the literal value 42. Says nothing about 41, 43, INT_MAX, or what happens when push is called on a full stack. A unit test is a single point sample of a function's behavior space.

#### Level 2: property-based testing

```cpp
// RapidCheck
rc::check("push then pop returns the pushed value", [](int x) {
    Stack<int> s;
    s.push(x);
    RC_ASSERT(s.pop() == x);
});
```

The framework generates inputs, shrinks failing cases to minimal counterexamples, and re-runs the property. Default 100 cases. Guarantees: property holds on the sampled distribution, which usually does not include adversarial values unless you write generators that produce them.

QuickCheck (Haskell, 2000) was the original. RapidCheck is the modern C++ port. Hypothesis (Python) introduced shrinking-as-search. Fast-check (TypeScript) adopted the same model.

#### Level 3: coverage-guided fuzzing

libFuzzer or AFL++ feeds inputs to a target, observes the edges of the CFG hit (via SanitizerCoverage), and mutates inputs that discover new edges. Combined with AddressSanitizer, UBSan, and MemorySanitizer, fuzzing is the workhorse of memory-safety bug-finding in C++.

OSS-Fuzz (Google) runs continuous fuzzing on more than 1000 open-source projects. It found over 10000 bugs in OpenSSL, libxml2, FFmpeg, SQLite, and the Linux kernel by 2025. Guarantee: no crash on any input the fuzzer reached given the time budget. There is no completeness claim. A bug behind a SHA-256 check will never be found by random mutation.

#### Level 4: symbolic execution

KLEE (Cadar, Dunbar, Engler, OSDI 2008) executes LLVM IR with symbolic inputs, forking on every conditional branch, and queries an SMT solver (STP, Z3) at the end of each path. Famously found bugs in GNU coreutils that had been there for years.

Path explosion is the killer. A loop with N iterations and a branch in the body has 2^N paths. KLEE fights this with state merging, search heuristics, and concolic execution. Bound the search and you get partial coverage, exhaustive for paths within budget.

#### Level 5: bounded model checking

CBMC (Kroening, Clarke, 2003) unrolls all loops to a bound k, encodes the program plus negated property as a SAT or SMT formula, and asks the solver. If UNSAT, the property holds for all inputs up to depth k. If SAT, the model is a counterexample.

Bit-precise. Catches integer overflow that abstract domains miss. AWS uses CBMC to verify the AWS C Common Runtime (s2n-tls, aws-c-common). Each commit runs proofs on memory safety and functional correctness of small C functions. The harnesses live in `verification/cbmc/proofs/`.

The bound k is the catch. CBMC proves nothing about k+1.

#### Level 6: abstract interpretation

Astrée (AbsInt) and Polyspace Code Prover (MathWorks) compute a fixed point in an abstract domain (intervals, octagons, polyhedra) over-approximating all reachable states. If the abstract value never includes a property violation, the property holds concretely.

Sound for the analyzed property class. Astrée proved absence of runtime errors in 132000 lines of C for the Airbus A380 primary flight control. The trade-off is precision: the abstract domain may be too coarse, producing alarms (false positives) that you have to investigate or refine.

Frama-C Eva is the open-source counterpart, weaker than Astrée but free.

#### Level 7: deductive verification

Annotate code with pre/post-conditions and loop invariants in ACSL (for C) or contracts (for C++26). The tool generates verification conditions (VCs) and ships them to an SMT solver (Alt-Ergo, Z3, CVC5). If all discharge, the function meets its spec for all inputs.

Frama-C WP is the canonical tool. Dafny, Spec#, Verifast, RefinedC sit in this family. Dependent on the SMT solver and on the spec being right.

#### Level 8: mechanised proof

Coq, Isabelle/HOL, Lean 4, Agda. You write the theorem and the proof, and a small kernel checks the proof. The trusted base is the kernel (a few thousand lines of OCaml for Coq) plus axioms.

CompCert, seL4, fiat-crypto, HACL\*. The gold standard. Cost is 10x to 30x development time over conventional implementation.

### Decision matrix

| Property to establish | Cheapest sufficient level |
| --- | --- |
| No null deref in this function | Level 6 (Astrée) or Level 7 (WP) |
| Crypto primitive matches RFC | Level 8 (Coq, fiat-crypto) |
| Distributed protocol cannot lose acks | Level 5 (TLA+/TLC, model checking) |
| No use-after-free in C++ refactor | Level 3 (fuzzing + ASan) plus Level 6 (Lifetime profile) |
| Compiler does not miscompile | Level 8 (CompCert) or Level 3 + differential testing (Csmith) |
| Parser accepts only well-formed input | Level 3 (fuzzing) plus Level 7 (WP on length checks) |

### The trusted computing base

Every level has a TCB, the set of artifacts you must trust for the guarantee to hold:

- Level 3 fuzzing: the sanitizer, the compiler, the OS.
- Level 5 CBMC: CBMC itself, the SMT solver, your harness's correctness.
- Level 7 WP: Frama-C, Why3, the SMT solver, the C semantics model.
- Level 8 Coq: the Coq kernel (~15 KLOC OCaml), the axioms you import, the extraction toolchain.

CompCert reduced the TCB by *replacing* the C compiler with a verified one. seL4 reduced it further by translating C semantics into Isabelle and proving against that. The frontier is reducing TCB further: Coq-in-Coq bootstrapping, MetaCoq, and CakeML's verified ML compiler.

### Where C++ fits

For greenfield safety-critical C++, the realistic ladder today is: tests + property tests + libFuzzer + UBSan + ASan (Level 1 to 3) baseline, plus Astrée or Polyspace for sound analysis on the MISRA C++ subset (Level 6), plus TLA+ at design time (Level 5) for any concurrent or distributed component. Levels 7 and 8 are reserved for the few thousand lines of crypto, kernel, or compiler core that justify them.
