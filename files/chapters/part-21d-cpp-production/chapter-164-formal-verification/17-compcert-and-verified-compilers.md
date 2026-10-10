## CompCert and Verified Compilers

Every formal verification claim about C or C++ source code rests on an unstated assumption: the compiler does not miscompile. That assumption is not safe. Every major C/C++ compiler has a long history of miscompilation bugs, some of which silently broke programs in production. Csmith (Yang et al., 2011) found 79 bugs in gcc and 202 in clang by random testing. Many were silent miscompilations, where the compiled binary did the wrong thing without crashing.

CompCert closes the gap. It is a verified optimizing C compiler, written and proved correct in Coq.

### What CompCert is

CompCert (Xavier Leroy, INRIA, 2005 onwards) compiles a substantial subset of C99/C11 to PowerPC, ARM, x86-32, x86-64, RISC-V, and KVX assembly. The proof is a single theorem in Coq:

```
theorem compcert_correct:
  forall (P : C_program) (T : trace),
    program_behaves (semantics P) T ->
    forall (asm : Asm_program),
      transf_c_program P = OK asm ->
      exists T',
        program_behaves (semantics_asm asm) T' /\
        improves T T'.
```

In English: if you compile C program P to assembly *asm*, then any observable behavior of *asm* is also a permitted behavior of P (modulo the implementation choosing among the several behaviors a C program may permit, e.g., evaluation order of unsequenced expressions).

The chain of refinements is roughly:

```
C  -> Clight -> Cminor -> CminorSel -> RTL -> LTL -> Linear -> Mach -> Asm
```

Each pass is proved correct. Optimizations (constant folding, common subexpression elimination, register allocation, inlining, loop invariant motion) are all proved to preserve semantics.

### What CompCert proves

1. The compiled assembly does not introduce behaviors absent from the source.
2. Optimizations do not break the C semantics.
3. The proven properties hold for the entire CompCert pipeline, end to end.

What CompCert does *not* prove:

- That the C source itself is correct. CompCert is a faithful compiler, not a verifier.
- That undefined behavior in the source is benign. CompCert maps UB to "any behavior permitted by C". A program with UB has no claim under the theorem.
- That the assembly executes correctly on hardware. CompCert's hardware model is the assembly ISA, not microarchitecture. Spectre-style issues are below the level CompCert proves.

### Performance

CompCert's optimized output is roughly 10 to 20 percent slower than gcc -O2 on standard benchmarks. The gap has narrowed over the years (CompCert was 50 percent slower in 2008, substantial work on instruction scheduling, register allocation, and software pipelining has closed most of it).

For most safety-critical code, 15 percent performance is a trivial price. For HPC and games, it is unacceptable. CompCert ships where the value of certainty exceeds the cost of cycles.

### Industrial use

- **Airbus**: used CompCert in DO-178C Level A avionics development. The certification argument shifts from "we extensively tested the compiler" to "we used a compiler with a mathematical proof of correctness". The first deployment was reported in 2015.
- **MTU Aero Engines**: turbine controller software.
- **Various automotive ECU vendors**: under ISO 26262 certifications.
- **AbsInt** (the company that commercialises CompCert): provides commercial support, additional architectures, and certification packages.

CompCert is BSD-licensed for the open-source kernel, with commercial extensions for unverified but useful features (GUI debugger integration, specific architecture ports).

### CakeML

CakeML is the verified ML compiler analogue, from CMU and Cambridge. It compiles a substantial Standard ML dialect to ARM, x86-64, RISC-V, MIPS, and others, with end-to-end Coq-style proofs in HOL4. CakeML's verified runtime even handles garbage collection.

CakeML matters for the C++ engineer because:

1. It demonstrates that verified compilation extends beyond C.
2. CakeML is itself a target for higher-level verified tools: extracted Coq programs can run on CakeML for end-to-end verified pipelines.
3. The methodology informs how a verified C++ compiler would be structured.

### LLVM-Cake (Vellvm, Alive)

Vellvm (Steve Zdancewic, Penn) is a Coq formalization of LLVM IR. Alive (John Regehr, Utah, integrated into LLVM) checks LLVM peephole optimizations against an SMT model of LLVM semantics, finding miscompilations. Both projects target the LLVM ecosystem, which underpins clang.

The 2026 state: Vellvm and Alive2 (the modern successor) are mature enough to be used inside LLVM development. Several optimization patches have been blocked from landing because Alive2 found counterexamples. This is a softer form of verification than CompCert (no end-to-end proof) but is integrated into the workflow of an unverified compiler used by billions.

### MalCert and verified middleends

MalCert and similar projects target the **middleend** (mid-level optimizations). The idea: keep the existing gcc or clang frontend, replace the optimizer with a verified equivalent, keep the existing backend. Hybrid verification.

By 2026 these projects remain academic. The frontend and backend complexity of mainstream compilers makes the hybrid model attractive in principle, hard in practice.

### Why no verified C++ compiler

Several hard reasons:

1. **No formal C++ semantics**. C has Cerberus (Cambridge) and the CompCert C semantics. C++ has neither at the same fidelity. The standard is English, ambiguous in places, and the committee has not chartered a formalization effort.
2. **Templates and instantiation**. The compiler instantiates templates lazily, with name lookup that depends on argument-dependent lookup, partial ordering, and overload resolution. Verifying this is a research project.
3. **Constructors, destructors, and exceptions**. C++ object lifetime is woven into control flow. Modeling it formally is the work seL4 sidestepped by choosing C.
4. **The C++ standard library**. Verifying C++ programs requires verifying the standard library they use. The libc++/libstdc++ codebases dwarf the language itself.
5. **Pace of change**. C is stable. C++ adds features every three years. A verified C++ compiler chasing C++26 contracts, modules, coroutines, and reflection would never converge.
6. **Demand**. The customers willing to pay for a verified compiler (avionics, defense) historically use C, not C++. Less commercial pull.

The realistic future: a verified C++ compiler may exist for a heavily restricted subset (think MISRA C++ minus exceptions and templates) within a decade. A full C++26 verified compiler is not on the horizon.

### What this means for C++ verification today

Three implications:

1. **C++ formal verification efforts must trust the compiler**. Even a fully verified C++ source (hypothetical) becomes assembly through gcc or clang, which may miscompile. The TCB includes the compiler.
2. **Differential testing of compilers is essential**. YARPGen and Csmith for C++ generate random programs and compare gcc, clang, MSVC outputs. Found dozens of bugs in each. This is the *unsound* substitute for verified compilation.
3. **For the highest-stakes C++ code, consider transpiling to C and using CompCert**. This is what some certified-C-via-MISRA shops do: write in a restricted C-like style, compile with CompCert, get the verified-compilation guarantee. The cost is giving up most of C++'s features.

### Verified compilation from a different angle: WebAssembly

Wasm has a small, formally specified semantics from day one. Multiple verified Wasm compilers and interpreters exist (WasmCert in Coq, Wasmtime's safety arguments, Lucet). For new ahead-of-time code targeting sandboxed environments, Wasm offers a verified-compilation-adjacent path C++ does not have natively, except by compiling C++ to Wasm and trusting the Wasm runtime.

### TCB shrinking as the long game

The CompCert lesson generalizes: verification's long arc is shrinking the trusted computing base. seL4 extended to binary verification, dropping the C compiler from TCB. fiat-crypto extends to assembly via Vale. Future work: extending to microarchitecture (proving Spectre safety against a formal CPU model) and to silicon (proving the CPU implements the ISA).

Each step costs years of effort and removes a class of trust assumption. By 2030 the realistic frontier is: verified high-level code, verified compilation to assembly (CompCert), verified instruction-level execution (CHERI-like capability hardware as one path). Microarchitecture remains a trust boundary.

> **Senior at FAANG.** If your team is doing serious formal verification on C code and not using CompCert, the question is why. The performance gap is small, the certification argument is dramatically stronger, and the license permits commercial use. The opposite question for C++: there is no verified compiler, so the strongest claim you can make about a verified C++ source is "verified modulo trusting clang", which is still useful but bounded. State the bound when you communicate the result.
