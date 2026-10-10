## Formal Verification of Concurrent C++

Reasoning about lock-free code by hand fails for any nontrivial algorithm. Even experts get it wrong. Tools that mechanically enumerate executions catch bugs no review can. This file covers the practical toolchain for verifying C++ atomics code.

### The Tools

| Tool | Scope | Input | Strength |
|------|-------|-------|----------|
| cppmem | Small programs in C++ MM | C-like syntax | Pedagogical, easy to use |
| herd7 | C/C++ and hardware models | .litmus files | Production-grade enumeration |
| RMEM | Hardware models (Power, ARM) | Litmus | Hardware execution traces |
| GenMC | C/C++ MM, larger programs | C with annotations | DPOR, scales to ~10K execs |
| TLA+ / TLC | Algorithm-level | TLA+ | High-level, not bit-exact |
| Coq C++ MM | Foundational | Coq scripts | Proven theorems |
| litmus7 | Hardware tests | Litmus | Run real CPUs as oracle |

Three categories: model checkers that enumerate executions (herd7, GenMC), high-level verifiers (TLA+), and theorem-prover formalizations (Coq).

### cppmem

The original online tool from Cambridge (Sarkar, Batty, Sewell). URL: svr-pes20-cppmem.cl.cam.ac.uk.

Input is a small C-like syntax with atomic ops. The tool enumerates all consistent executions under the formal C++ memory model and shows the rf, sb, sw, hb edges.

```
int main() {
  atomic_int x = 0;
  atomic_int y = 0;
  {{{
    x.store(1, mo_release);
  |||
    y.store(1, mo_release);
  |||
    r1 = x.load(mo_acquire).readsvalue(1);
    r2 = y.load(mo_acquire).readsvalue(0);
  |||
    r3 = y.load(mo_acquire).readsvalue(1);
    r4 = x.load(mo_acquire).readsvalue(0);
  }}}
  return 0;
}
```

cppmem reports whether this IRIW execution is "consistent" under the C++ MM. It is, with acq_rel. It is not, with seq_cst.

cppmem is excellent for teaching and small examples but does not scale beyond ~6-8 atomic ops per thread.

### herd7 and litmus

herd7 (from the diy7 toolset) reads a `.litmus` file, takes a memory model written in cat, and enumerates all executions classifying them as Allowed, Forbidden, or DUDU (deadlock or undefined).

```
C IRIW
{ atomic_int x; atomic_int y; }
P0 (atomic_int *x) {
  atomic_store_explicit(x, 1, memory_order_release);
}
P1 (atomic_int *y) {
  atomic_store_explicit(y, 1, memory_order_release);
}
P2 (atomic_int *x, atomic_int *y) {
  int r1 = atomic_load_explicit(x, memory_order_acquire);
  int r2 = atomic_load_explicit(y, memory_order_acquire);
}
P3 (atomic_int *x, atomic_int *y) {
  int r3 = atomic_load_explicit(y, memory_order_acquire);
  int r4 = atomic_load_explicit(x, memory_order_acquire);
}
exists (2:r1=1 /\ 2:r2=0 /\ 3:r3=1 /\ 3:r4=0)
```

Run with `herd7 -model c11.cat IRIW.litmus`. Output reports whether the existential is satisfiable. Switch to `c11_seqcst.cat` to test seq_cst variant.

The `cat` model files are themselves formal definitions of memory models. The C++ model in herd7 (`c11.cat`) is derived from N4527 with corrections from P0668. Hardware models for x86, ARM, POWER, RISC-V are also included.

litmus7 is the runtime counterpart: it compiles and runs the same .litmus file on real hardware many times to check whether the execution is observable in practice.

### RMEM

RMEM (from the same group) is a model checker specialized for hardware models. Useful when verifying low-level kernel code that depends on POWER or ARM hardware semantics directly, not C++ MM.

### GenMC

GenMC (Kokologiannakis et al.) is a stateless model checker for C11 atomics with Dynamic Partial Order Reduction (DPOR). It runs a real C program (compiled with LLVM) under all possible interleavings and reports any execution that hits an assertion or has UB.

GenMC can handle real C++ code (with limitations on standard library usage). It scales to programs with thousands of states by exploiting DPOR. Used in the verification of Linux RCU primitives.

```
genmc -mo my_test.c
```

The `-mo` flag enables modification-order tracking. Without it, GenMC uses a faster but less precise model.

### TLA+

TLA+ (Lamport) is a high-level specification language. You write the algorithm at the level of state transitions, not C++ code. TLC (the model checker) explores the state space.

TLA+ is not bit-exact and does not capture C++ memory model details directly. Use it to verify the algorithm-level properties (e.g., "this queue never loses an item") and use herd7 for the memory-order details.

PlusCal is a more imperative front-end to TLA+ that translates to TLA+ specifications. Easier to learn for programmers used to imperative code.

### Coq Formalizations

The C++ memory model has been mechanized in Coq (Batty et al., HOL4 originally then ported). The Lahav et al. Fix to seq_cst (P0668) was developed in this formal setting.

For day-to-day C++ work this is not practical. But when proposing new memory order semantics, contributing to WG21, or designing the memory model for a new language, the Coq formalization is the gold standard.

### Mining Counterexamples

Practical workflow for verifying a new lock-free algorithm:

1. **Sketch in pseudocode**. Write the algorithm at the level you would describe it in a paper.
2. **TLA+ model**. Encode the algorithm as state transitions. Verify high-level safety and liveness properties via TLC.
3. **Translate to C with atomics**. Use the same memory orders you intend in production.
4. **GenMC or herd7 on small instances**. Run with 2-3 threads, small input sizes. Check for assertion failures and unexpected outcomes.
5. **Hardware litmus tests**. For interesting executions herd7 marks as allowed, run litmus7 on real hardware (x86, ARM, POWER) to confirm.
6. **TSan in CI**. Catch any data races (covered in the TSan and Data Race Detection section).
7. **Stress tests**. Run the algorithm millions of iterations on real hardware with rdrand-driven scheduling perturbation.

This pipeline catches the vast majority of memory order bugs before code review.

### Common Counterexamples

**Treiber stack memory reclamation**: pop reads `head`, then reads `head->next`. If the popped node is freed before the CAS, the second load is UB. herd7 finds this if you model free() as overwriting the memory.

**Michael-Scott queue tail update**: helping CAS to advance tail. herd7 verifies the helping does not lose items.

**Chase-Lev work-stealing deque**: complex acq_rel + seq_cst pattern. The original paper had a bug fixed years later. Le, Pop, Cohen, Zappa Nardelli formalized and verified the corrected version.

**RCU**: liburcu has been verified against the C11 model by GenMC. Found two latent bugs in pre-2017 versions.

### The Cost of Formal Verification

Real cost. Tooling is academic-quality, error messages are obscure, and modeling a real codebase takes weeks.

Worth it when:
- You are designing a primitive that will be used by many teams.
- A bug would cause silent data corruption rather than crashes.
- The hardware target is weakly-ordered (ARM, POWER), where x86 testing is insufficient.
- Code review would not catch the bug class.

Not worth it for:
- Application-level code using std::atomic in straightforward patterns.
- Code that uses well-tested primitives (folly, abseil, std::mutex).
- One-off scripts or research prototypes.

### Junior at FAANG vs Senior at FAANG

Junior writes lock-free code, runs it 10000 times, sees no bug, ships. Six months later customer reports random data corruption on ARM machines. Senior runs herd7 on a model of the algorithm before writing C++, identifies a missing seq_cst, fixes it, then ships. The bug never occurs.

The investment: senior spends one extra day on verification, saves two weeks of debugging at production scale. The senior also writes a TLA+ spec that becomes the team's reference for understanding the algorithm. New hires read the spec instead of decoding the C++ from scratch.
