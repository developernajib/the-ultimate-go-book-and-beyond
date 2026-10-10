## Coq and C++ Proofs

Coq (renamed Rocq in 2024 but the tool is the same) is the proof assistant behind CompCert, fiat-crypto, the four-color theorem, and the Iris separation logic framework. For senior engineers, the value is not in writing tactics, it is in understanding what Coq-style proofs cost and what they buy.

### Gallina, the language

Coq's term language is **Gallina**, a dependently typed pure functional language in the Calculus of Inductive Constructions (CIC). You write definitions and theorems, and the kernel checks proof terms.

```coq
Inductive list (A : Type) : Type :=
  | nil  : list A
  | cons : A -> list A -> list A.

Fixpoint length {A} (l : list A) : nat :=
  match l with
  | nil => 0
  | cons _ t => S (length t)
  end.

Fixpoint app {A} (l1 l2 : list A) : list A :=
  match l1 with
  | nil => l2
  | cons h t => cons h (app t l2)
  end.

Theorem app_length : forall A (l1 l2 : list A),
  length (app l1 l2) = length l1 + length l2.
Proof.
  intros A l1 l2.
  induction l1 as [| h t IH].
  - simpl. reflexivity.
  - simpl. rewrite IH. reflexivity.
Qed.
```

The `Qed` records a proof object that the Coq kernel re-checks. The trusted base is the kernel, roughly 15000 lines of OCaml.

### Hoare logic on a C-like language

Verifying imperative code in Coq requires embedding a programming language and its operational semantics. The standard approach is **shallow** or **deep embedding**.

A toy Hoare triple proof on a deeply embedded `Imp` (from Software Foundations):

```coq
(* { X = m } X := X + 1 { X = m + 1 } *)
Theorem inc_correct : forall m,
  {{ fun st => st X = m }}
    X ::= APlus (AId X) (ANum 1)
  {{ fun st => st X = m + 1 }}.
Proof.
  intros m. apply hoare_assign.
Qed.
```

This is fine for textbooks, useless for production C++. Real verification frameworks build on this foundation.

### VST: the Verified Software Toolchain

VST (Andrew Appel, Princeton) is a Coq library that lets you prove functional correctness of real C programs, with **separation logic** as the assertion language. VST hooks into the CompCert C frontend, so the C you verify is the same C CompCert compiles, eliminating the front-end TCB.

A VST proof of `reverse` on a singly linked list is roughly 200 lines of Coq for 10 lines of C. The proof establishes:

- Memory safety (no UB).
- Functional correctness (the resulting list is the input reversed).
- Frame condition (no other heap touched).

Separation logic's `*` (separating conjunction) is the weapon that makes heap-mutating proofs tractable: `P * Q` says the heap splits into disjoint parts satisfying `P` and `Q`. Without it, every heap mutation requires global reasoning.

### RefinedC

RefinedC (Sammler, Krebbers, et al., 2021, MPI-SWS) automates VST-style proofs using **refinement types** plus **Iris** (a higher-order separation logic in Coq). You annotate a C function with refinement types, RefinedC generates Coq proof obligations, and a Coq tactic suite discharges most of them automatically. Manual intervention is reserved for hard lemmas.

```c
[[rc::parameters("n : nat")]]
[[rc::args("p : &own<array<int, n>>", "n : int<size_t>")]]
[[rc::ensures("∀ i, i < n → p.[i] = 0")]]
void zero_buffer(int *p, size_t n) {
    for (size_t i = 0; i < n; i++) p[i] = 0;
}
```

RefinedC has been used to verify parts of the seL4 capability system and the Linux kernel's klock allocator (in research). Production deployment is still rare, but the trajectory is promising.

### Iris

Iris (Jung, Krebbers, Birkedal, et al.) is the higher-order separation logic that powers RefinedC, RustBelt, and modern verification of concurrent imperative code in Coq. RustBelt used Iris to prove Rust's type system is sound in the presence of `unsafe` blocks. The same machinery underlies verified spinlocks, mutexes, and lock-free data structures.

For C++ specifically, Iris work is limited. The barrier is not Iris itself, it is the C++ semantics: there is no equivalent to CompCert's formalized C semantics for the C++ language. That gap is the single biggest reason C++ verification trails C verification.

### Bridging Coq to C++

Three strategies exist, all imperfect:

1. **Verify a C subset and link**. Write the kernel in C, verify with VST/RefinedC, expose a C ABI, call from C++. This is the HACL\* and seL4 model.
2. **Extract from Coq to C++**. Write the algorithm in Gallina, prove properties, extract to OCaml or Haskell, hand-port to C++. Fragile, the port is not verified.
3. **Embed a C++ semantics directly**. Bedrock Systems has been working on a C++ semantics in Coq for years. Their BHV (Bedrock Hypervisor) is the most ambitious C++ verification project public as of 2026, targeting a verified hypervisor in C++.

### Linked-list invariants worked example

Sketch of a singly linked list invariant in Iris-style separation logic:

```
list_repr [] p ≜ p = null
list_repr (x :: xs) p ≜ ∃ q, p ↦ {x, q} * list_repr xs q
```

`p ↦ {x, q}` means the heap cell at `p` stores the pair `(x, q)`. `*` is separating conjunction, ruling out cycles. To prove `length xs = list_length(p)`:

1. Induct on `xs`.
2. In the `cons` case, unfold `list_repr` to get `q` and the recursive `list_repr xs q`.
3. Use the IH plus the separation to conclude the C function's loop preserves the invariant.

Total: roughly 80 lines of Coq for a 6-line C function. This ratio is typical and is why production Coq proofs ship for crypto and kernels, not for general application code.

### Why C++ remains hard

- **No formal C++ semantics ratified**. The standard is English. Cerberus (Cambridge) formalizes a fragment of C, no comparable effort exists for C++.
- **Templates are higher-kinded**. Specs must be parametric.
- **Constructors and destructors are control-flow**. RAII complicates the operational semantics.
- **Exceptions cross abstraction boundaries**. Most logics handle one or the other, not both.
- **`std::move` and r-value references**. Ownership transfer without a borrow checker. Specs become annotation-heavy.

### When Coq is the right answer

- Crypto primitives. fiat-crypto generates verified field arithmetic for elliptic curves, used in BoringSSL.
- Compiler internals. CompCert is Coq end-to-end.
- Kernel primitives. seL4 is Isabelle but the principle is the same.
- Mathematical algorithms where correctness is the entire product (Kepler conjecture in HOL Light, four-color theorem in Coq).

When Coq is **not** the answer:

- Application code with shifting requirements.
- Anything with a heavy C++ standard library dependency.
- Code your team will not maintain.

> **Senior at FAANG.** A Coq proof outlives the engineer who wrote it only if a successor can read it. Plan for proof maintenance the way you plan for code maintenance: documentation, naming conventions, refactoring discipline. Coq projects that lose their author and re-break on the next compiler version are technical debt, not assurance.
