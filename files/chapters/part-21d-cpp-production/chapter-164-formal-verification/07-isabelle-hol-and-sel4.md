## Isabelle/HOL and seL4

Isabelle/HOL is the proof assistant developed at Cambridge and TU Munich since 1986. HOL stands for **Higher-Order Logic**, simpler than Coq's Calculus of Inductive Constructions but powerful enough to mechanise large-scale mathematics and software verification. The crown jewel of Isabelle/HOL in software engineering is **seL4**.

### seL4 in numbers

- 10000 lines of C plus 600 lines of assembly.
- 200000 lines of Isabelle/HOL proof.
- 25 person-years of effort (NICTA, 2004 to 2009 for the first proof).
- \$362 per line of verified code (NICTA's published estimate for the original work).
- 0 functional bugs found in production since the proof closed in 2009.

The proof establishes:

1. **Functional correctness**. The C implementation refines an executable Haskell specification, which itself refines an abstract specification. Refinement means every behavior of the implementation is allowed by the spec.
2. **Integrity**. A subject can only modify objects it has authority over.
3. **Confidentiality**. Information cannot flow against the configured policy.
4. **Binary-level correctness** (added 2013). The compiled ARM binary refines the C source, eliminating the C compiler from the TCB for the targeted compiler version.

That last item is the killer feature. seL4's TCB is the Isabelle kernel, the Haskell extraction (validated by translation), the assembly stubs, and the hardware. No C compiler trust required.

### Isabelle/HOL basics

```isabelle
theory Example imports Main begin

primrec rev :: "'a list ⇒ 'a list" where
  "rev [] = []" |
  "rev (x # xs) = rev xs @ [x]"

lemma rev_rev: "rev (rev xs) = xs"
  apply (induct xs)
   apply simp
  apply simp
  done

end
```

`primrec` defines structural recursion. `apply (induct xs)` invokes induction on the list, leaving two subgoals (nil and cons). `simp` is the simplifier, which discharges most arithmetic and rewrites.

Compared with Coq, Isabelle's tactics are more automated by default and the syntax is closer to mathematical practice. The trade-off is that Isabelle's logic (HOL) is less expressive than CIC for dependently typed reasoning.

### Refinement methodology

The seL4 proof is built as a chain of refinements:

```
Abstract Spec  --refines-- Executable Spec (Haskell) --refines-- C Implementation --refines-- ARM Binary
```

Each arrow is a Coq-style theorem: any behavior of the lower level is permitted by the upper level. Composition gives end-to-end correctness.

**Why refinement and not direct Hoare-triple proof?** Refinement scales. Each level has its own invariants, and you prove preservation locally. A direct Hoare-triple proof of the C against the abstract spec would be untractable because the abstract spec has no notion of pointers, allocators, or capabilities-as-bitfields.

### Why C and not C++

Gerwin Klein and the seL4 team made an explicit choice in 2005:

1. **C has a tractable formal semantics**. The team built a C semantics in Isabelle (the C-Parser) covering a substantial fragment of C99. No comparable C++ semantics exists.
2. **No surprises from name resolution, ADL, template instantiation, or implicit conversions**. C's semantics fit on a whiteboard. C++'s do not.
3. **Predictable code generation**. C compiles to assembly with a clear correspondence. C++ has constructors, destructors, vtables, exception unwinding, RTTI, all hidden behind syntax.
4. **Smaller TCB**. seL4 uses a restricted C subset (no function pointers in the runtime path, no recursion, no dynamic allocation in the kernel). The subset is small enough to formalize.

The decision has been re-examined and re-affirmed by the seL4 Foundation. As of 2026, no serious effort to port seL4 to C++ exists. There *is* an effort to write a Rust-based microkernel verified in similar style (Hubris by Oxide Computer, plus academic projects), and Rust's stronger type system is a better starting point than C++ for fresh verified work.

### What seL4 actually proves, in detail

The functional correctness theorem, stripped:

```
theorem callKernel_corres:
  "corres (=) (invs and ct_active) (invs' and ct_active')
          (callKernel event) (callKernel' event)"
```

Read: under the invariants `invs` and assuming the current thread is active, the abstract kernel transition `callKernel event` and the C-level kernel transition `callKernel' event` are related by equality of return values and refinement of states. `corres` is the refinement relation.

The implication is precise: if you prove a security property at the abstract level, the implementation inherits it. The seL4 team did exactly this for noninterference (Murray et al., 2013).

### Proofcraft and the seL4 Foundation

Proofcraft (founded by Gerwin Klein in 2021) is the company that maintains the seL4 proofs commercially. The seL4 Foundation, with members including HENSOLDT Cyber, Cog Systems, and DARPA, funds ongoing verification work. Each new architecture port (RISC-V was added in 2020, ARMv8 in 2017) requires re-verifying the architecture-specific parts.

Production deployments as of 2026:

- HENSOLDT Cyber TRENTOS in defense systems.
- DARPA HACMS Boeing Unmanned Little Bird helicopter (demonstrated 2017, the red team could not break it).
- Cog Systems D4 Secure platform on Samsung Knox.
- Several classified deployments not publicly documented.

### What this teaches a C++ engineer

Three takeaways even if you never touch Isabelle:

1. **Refinement scales where direct proof does not**. Build your verification as a stack of small invariants, not one giant theorem.
2. **Subsetting the language is half the battle**. seL4's restricted C is tractable precisely because it banned what makes C hard. The same logic applies to MISRA C++ and AUTOSAR C++14: the restricted subset exists to make analysis possible.
3. **Spec-first development**. seL4's abstract spec was written first, the implementation followed. Most verification failures come from specs that diverged from intent. Writing the spec first forces clarity.

### Other Isabelle/HOL projects worth knowing

- **CertiKOS** (Yale, Shao et al.): a verified concurrent OS kernel in Coq, conceptually parallel to seL4.
- **AutoCorres** (NICTA): a tool that abstracts Isabelle's low-level C semantics into a more readable monadic form for proof.
- **Concurrent C** verification work using Isabelle's `simpl` language.
- The **Archive of Formal Proofs** (AFP) hosts thousands of Isabelle theories, including verified compilers, type systems, and cryptographic protocols.

### Engineering implication for C++

If you are starting greenfield safety-critical work and choosing between C++ and Rust, the seL4 lesson is that *the language choice constrains the assurance ceiling*. Rust's borrow checker buys memory safety up to `unsafe` blocks, and projects like Prusti and Verus extend that to functional verification. C++ in 2026 has no equivalent. The Lifetime profile is a heuristic, not a sound type system.

The pragmatic conclusion: greenfield critical components in 2026 should default to Rust, with C++ used where ecosystem (graphics, ML kernels, legacy IP) forces it. seL4 is the proof that fully verified system software is possible, and it is *not* in C++.

> **Senior at FAANG.** When a regulator or customer asks "is this verified?", the answer matters at the level of the proof's exact statement and TCB. seL4 is verified down to ARM binary for specific compiler versions. CompCert is verified for the C source-to-assembly translation. Frama-C WP is verified given Frama-C, Why3, and your SMT solvers are correct. Communicate the ceiling honestly. Verification is a contract, not a sticker.
