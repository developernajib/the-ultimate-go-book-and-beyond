## Learning Objectives

By the end of this chapter, a senior engineer should be able to:

### Conceptual

1. Distinguish **sound** from **unsound** analysis and explain what each guarantees about false positives and false negatives.
2. Place a verification technique on the spectrum from unit tests to deductive proof, naming what each level rules out.
3. Explain the **trusted computing base (TCB)** of a verified system: proof kernel, axioms, compiler, hardware model, and why "verified" never means "trusted by zero".
4. Articulate why **C++ is harder to verify than C**, citing templates, virtual dispatch, exceptions, and the catalog of undefined behavior.
5. Describe the **specification problem**: a proof is only as good as its spec, and most real bugs in verified systems come from wrong specs, not wrong proofs.

### Tooling

6. Read and write **ACSL** annotations (`requires`, `ensures`, `assigns`, `loop invariant`, `loop variant`) and run Frama-C WP on a small C function.
7. Write a **CBMC harness** for a C/C++ function with bounded loops and interpret a counterexample trace.
8. Explain how **KLEE** uses LLVM IR plus an SMT solver to enumerate symbolic paths, and identify when path explosion makes it impractical.
9. Sketch a **Coq Hoare-triple proof** of a simple imperative function and identify what VST, RefinedC, and Iris bring on top.
10. Read an **Isabelle/HOL** theorem statement well enough to know what seL4 actually proved.
11. Write a small **TLA+** specification with PlusCal and run it through TLC and Apalache.
12. Configure **Astrée or Polyspace Code Prover** in a CI pipeline for a safety-critical C/C++ subset.

### C++ specific

13. Apply the **C++ Core Guidelines Lifetime profile** (`gsl::not_null`, `gsl::span`, `gsl::owner`) and run the MSVC or clang lifetime checker.
14. Write **C++26 contract annotations** (`pre`, `post`, `contract_assert` per P2900) and explain runtime versus compile-time enforcement modes.
15. Write **property-based tests** in RapidCheck and explain the role of shrinking.
16. Build a **libFuzzer or AFL++ harness** for a parser, integrate it into OSS-Fuzz, and read a coverage and corpus growth report.

### Engineering judgment

17. Estimate the **cost ratio** of formal verification for a target component (typical 5x to 30x dev time) and decide when it is justified.
18. Choose the right tool for a given assurance goal: memory safety, functional correctness, absence of timing side channels, distributed protocol correctness, compiler correctness.
19. Explain why **Rust** is shifting verification economics and what that implies for new C++ greenfield decisions.
20. Identify which parts of an architecture are amenable to verification (small, pure, hot-path crypto or kernel code) and which are not (large stateful UI, third-party libraries with no spec).

### Cultural

21. Speak fluently with researchers and certifiers using the right terms: refinement, simulation, weakest precondition, strongest postcondition, separation logic, refinement-based proof, model checking, abstract interpretation, SMT.
22. Recognize the major projects (CompCert, seL4, HACL\*, Project Everest, Iris, RustBelt, fiat-crypto, AWS TLA+ work) and what each contributed.

### Junior to FAANG / Senior at FAANG callouts

> **Junior to FAANG.** You are not expected to write Coq proofs in your first five years. You *are* expected to know which of your team's components could benefit from sound static analysis, which need fuzzing in CI, and which the security team will require a TLA+ design doc for before launch.

> **Senior at FAANG.** You are expected to make the call. When a staff engineer proposes "let us verify this in Coq", you should be able to scope the cost, identify the spec risk, and propose a cheaper alternative (CBMC, fuzzing, or stronger types in Rust) when it is defensible. Verification is a budget decision, not a religion.
