## Interview Questions

Twelve deep questions that probe formal-methods understanding in a C++ context. These are not memorization tests, they are designed to elicit how a candidate thinks about assurance, cost, and trade-offs.

---

#### 1. Soundness vs unsoundness

**Question.** Coverity reports zero defects on a 200000-line C++ codebase. What does that tell you about the codebase's correctness?

**What to look for.** The candidate should immediately note that Coverity is unsound: zero reports does not mean zero bugs. They should describe what soundness means precisely (no false negatives for the analyzed property class), name a sound alternative (Astrée, Polyspace Code Prover, Frama-C Eva), and articulate the trade-off (sound tools have higher false-positive rates).

**Red flags.** A candidate who treats "Coverity passed" as proof of correctness, or who cannot distinguish unsound from sound analysis.

---

#### 2. Spec-vs-proof

**Question.** A team has spent 6 months proving in Coq that their C function `f` satisfies a postcondition `P`. They ship it. Three months later a critical bug is reported. The Coq proof still type-checks. What happened?

**What to look for.** The spec problem. Either `P` did not capture the intended behavior (most likely), or the proof relies on axioms or assumptions that did not hold in deployment (memory model assumptions, hardware behavior, library code outside the verified scope). Bonus for discussing how to mitigate: spec property-testing before proof investment, multiple specs at different abstraction levels, customer review of specs.

**Red flags.** "The proof must be wrong somehow." A real proof verified by Coq's kernel does not become wrong, the spec was wrong.

---

#### 3. CBMC harness pitfall

**Question.** You write a CBMC harness with `__CPROVER_assume(n < 1024)` for a function that processes a buffer of size `n`. The harness verifies cleanly. A user reports a crash with `n = 2048`. What does the verification result actually mean, and what should the harness have done?

**What to look for.** The harness verified the function only for `n < 1024`. The assumption excluded the failing case. The candidate should propose either expanding the bound (with attention to verification cost), encoding the bound as a precondition the caller must establish, or splitting the proof into ranges. Bonus for discussing the AWS pattern of explicit `MAX_BUFFER_SIZE` constants and their role in CI scaling.

**Red flags.** Treating CBMC's "VERIFICATION SUCCESSFUL" as unconditional, or proposing to remove the assume without addressing the cost explosion.

---

#### 4. TLA+ vs Frama-C

**Question.** You are designing a new distributed cache invalidation protocol that will be implemented in C++. Which formal methods would you apply at which phase of the project, and why?

**What to look for.** TLA+ at design time for the protocol itself (catches concurrent-interleaving bugs cheaply). Property-based testing of the C++ implementation against the TLA+ model (model-based testing). Frama-C/WP-cxx or CBMC harnesses on individual hot functions in the implementation (memory safety, local invariants). Fuzzing on any code that touches network input. The candidate should sequence these by cost and by phase.

**Red flags.** Proposing a single tool for the whole project, or skipping the design-time TLA+ step.

---

#### 5. C vs C++ verification

**Question.** Why is seL4 written in C and not C++? Defend or refute the choice.

**What to look for.** Tractable formal C semantics, templates and virtual dispatch break standard verification logics, exceptions complicate Hoare-style reasoning, smaller TCB, predictable code generation. The candidate should acknowledge the choice was correct in 2005 and remains defensible in 2026, while discussing what C++ would have offered (templates for capability tables, RAII for resource lifetime) and why those benefits did not outweigh the verification cost.

**Red flags.** Either dogmatic ("C is always better for kernels") or naive ("C++ would have been fine").

---

#### 6. Lifetime profile limits

**Question.** A colleague proposes that the C++ Core Guidelines Lifetime profile gives equivalent safety to Rust's borrow checker. How do you respond?

**What to look for.** The candidate should distinguish heuristic from sound. The Lifetime profile is a best-effort static analyser. Rust's borrow checker is part of a soundness-proved type system (RustBelt). The profile catches a real fraction of memory-safety bugs in C++ but cannot eliminate the bug class. Bonus for discussing what fraction the profile typically catches in practice (modern C++ idioms: fairly high, legacy patterns: low) and what the realistic deployment looks like.

**Red flags.** Either claiming the profile is sound or dismissing it as useless. Both are wrong.

---

#### 7. Verified crypto integration

**Question.** Your team needs ChaCha20-Poly1305 in a new C++ service. Walk me through the options and the trade-offs.

**What to look for.** Use HACL\*/EverCrypt linked through `extern "C"` from a thin C++ wrapper. Alternatives: BoringSSL (audited but unverified), OpenSSL (broader compatibility, larger audit surface), handwritten (do not). The candidate should discuss: side-channel guarantees, integration complexity, performance, version pinning, the responsibility of the C++ wrapper to handle key zeroization and lifetime. Mention that the verified primitive plus an unverified wrapper still benefits from the verification, because the wrapper is small and reviewable.

**Red flags.** Proposing handwritten crypto, or proposing OpenSSL without discussing the alternative.

---

#### 8. Counterexample interpretation

**Question.** CBMC produces a counterexample showing variables `a = INT_MAX, b = 1, c = INT_MIN` that triggers an assertion failure on line 47. The function under test is a small numerical utility. What do you do next?

**What to look for.** Reproduce the counterexample by hand or in a debugger. Examine line 47 to understand the failure. Decide: (1) is this a real bug in the code (fix the code), (2) is the assertion wrong (fix the assertion or spec), (3) is the input genuinely impossible in production (add a precondition, document the constraint, possibly prove the precondition at the call site). The candidate should not jump to "weaken the assertion" without justification.

**Red flags.** Suppressing the failure, or "blaming the tool".

---

#### 9. Fuzzing claims

**Question.** A team fuzz-tested a parser for 24 hours with no crashes. They claim the parser is "memory safe". How do you assess that claim?

**What to look for.** Fuzzing is statistical evidence, not proof. The right framing: "in 24 hours of fuzzing with these sanitisers and this corpus, no input triggered a sanitiser violation". Coverage matters: did the fuzzer exercise all relevant code paths? Was the sanitiser configuration complete (ASan + UBSan + MSan as appropriate)? Was the harness representative of production use? The candidate should propose checking coverage reports, examining the corpus, and considering complementary techniques (property-based tests for semantic correctness, CBMC for bounded proof of memory safety on the hot loop).

**Red flags.** Either accepting "memory safe" without qualification or dismissing fuzzing as worthless.

---

#### 10. Verification economics

**Question.** Your director asks: "Should we verify our payment processing service in Coq?" Walk me through how you would answer.

**What to look for.** A structured economic analysis. Identify the components of the service: most are conventional business logic, a small core handles money movement and reconciliation. Estimate the cost of full Coq verification (10x to 30x dev time on the targeted core) versus alternatives (sound static analysis, property-based testing, model-based testing of state machines, formal review of the financial state machine in TLA+). Quantify the bug cost. Recommend a graduated approach: TLA+ for the financial state machine, property-based tests for invariants, sound static analysis on the whole service, full proof only on the smallest highest-stakes algorithmic kernel if any. The answer is rarely "yes, verify everything in Coq".

**Red flags.** Either jumping to "yes, do Coq" or refusing to consider verification at all.

---

#### 11. AI-assisted proof

**Question.** Lean Copilot suggests a tactic that closes a difficult goal in your proof. Do you accept it? What do you check?

**What to look for.** Yes, you accept it (the kernel verifies the tactic, so soundness is not at risk). But you check: does the resulting proof still depend on the spec you intend? Has the tactic introduced an assumption you did not authorize (e.g., classical logic axioms, a `Sorry` somewhere)? Is the proof maintainable: will a successor understand it? Bonus for discussing that the kernel is the trust boundary, the LLM is a productivity tool inside that boundary.

**Red flags.** Either rejecting AI assistance categorically or accepting it without verifying the implications.

---

#### 12. End-to-end argument

**Question.** A product is described as "formally verified". A customer asks what that means. How do you draft an honest answer for the marketing brief?

**What to look for.** State precisely: which property is verified (memory safety, functional correctness, side-channel resistance, etc.), against which spec (cite the spec document), using which tool (Coq, Frama-C/WP, CBMC), with what TCB (kernel, axioms, compiler, hardware model). State explicitly what is *not* verified: e.g., the surrounding orchestration code, third-party dependencies, hardware microarchitecture. The candidate should resist marketing-friendly oversimplifications. seL4's example is the gold standard: "functional correctness and security properties of the microkernel, verified down to ARM binary, modulo trust in the Isabelle/HOL kernel and the hardware ISA model".

**Red flags.** A claim of "verified" with no qualifications, or refusing to make any claim because of fear of overstatement. The right answer is a precise, bounded statement.

---

### Calibration notes

These twelve questions, asked across a half-day technical interview, separate candidates with formal-methods awareness from those without. A senior C++ engineer in 2026 should answer at least eight of them substantively. A staff or principal engineer should answer all twelve with concrete examples from their experience.

The questions are not about whether the candidate can write Coq tactics. They are about whether the candidate understands assurance as an engineering discipline.
