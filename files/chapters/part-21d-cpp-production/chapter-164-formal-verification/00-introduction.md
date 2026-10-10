# Chapter 164: Formal Verification and Proof-Carrying C++

Testing shows the presence of bugs, not their absence. Edsger Dijkstra wrote that line in 1969 and it remains the cleanest argument for formal methods. If your software flies an A350, drives an insulin pump, runs in a Tesla AP3 ECU under ISO 26262 ASIL-D, signs a TLS handshake on a billion phones, or arbitrates memory in a hypervisor, the question is not "did the unit tests pass" but "does the implementation satisfy a mathematical specification under all reachable inputs". That second question is what formal verification answers.

This chapter is for senior engineers who already know modern C++ and want to understand the tooling, theory, and economics of proving code correct. We are not going to teach you Coq from scratch, we are going to map the terrain so you can pick the right tool for a real product.

## Why this matters in 2026

Four landmark projects reshape the conversation about whether verification scales:

1. **CompCert** is a formally verified optimizing C compiler written and proved correct in Coq by Xavier Leroy and INRIA. CompCert proves a semantic preservation theorem, the assembly it emits behaves as the C source specifies under the C99/C11 abstract machine. Airbus uses CompCert in DO-178C Level A avionics toolchains. The performance gap to gcc -O2 is roughly 10 to 20 percent, and that gap is acceptable when you can eliminate "compiler bug" from the certification argument.

2. **seL4** is a 10000-line C microkernel verified down to binary in Isabelle/HOL by NICTA and now Proofcraft. The proofs cover functional correctness, integrity, and confidentiality. seL4 ships in autonomous helicopters (the DARPA HACMS Boeing Unmanned Little Bird), automotive safety controllers, and classified systems. The cost was roughly 200000 lines of proof for 10000 lines of C, about 20x.

3. **Amazon Web Services uses TLA+** on S3, DynamoDB, EBS, and IAM. Chris Newcombe's 2015 CACM paper documented how TLA+ caught a subtle bug in the DynamoDB replication protocol that had survived design review and would have cost data loss in production. TLA+ is now part of how AWS designs distributed protocols, before C++ or Rust is written.

4. **Google Project Zero and academic teams** use Frama-C with the WP plugin to verify cryptographic primitives and parsers. HACL\*, the verified crypto library from Project Everest (INRIA, Microsoft Research, CMU), ships inside Mozilla NSS, the Linux kernel WireGuard implementation, and the Windows Hyper-V trusted boot path. Every line of HACL\* C has a corresponding F\* proof of memory safety, functional correctness, and constant-time execution.

## What "verified" actually means

Vocabulary matters because vendors abuse it. Three levels worth distinguishing:

| Level | What is checked | What it guarantees | Tool example |
| --- | --- | --- | --- |
| Unsound static analysis | Heuristic patterns | Finds *some* bugs, gives no completeness claim | Coverity, Klocwork, clang-tidy |
| Sound static analysis | Over-approximate semantics | If it reports clean, the property holds (modulo tool bugs and unsupported language features) | Astrée, Polyspace Code Prover, Frama-C Eva |
| Deductive proof | A proof object machine-checked against axiomatic semantics | Property holds for all inputs, given the spec is correct and the proof kernel is correct | Frama-C WP, VST in Coq, Isabelle/HOL |

Sound analysis trades false positives for completeness. Astrée is the classic example: it proved absence of runtime errors in the Airbus A380 fly-by-wire C code with zero false negatives on the proven property class. That is not "no bugs", that is "no division by zero, no out-of-bound access, no overflow, no uninitialized read on this code under the modeled input ranges".

## What C++ specifically adds

C is hard to verify. C++ is harder by an order of magnitude, and that gap is why most production verification today targets C, Rust, or restricted C++ subsets:

- **Templates and instantiation**. A specification must be parametric in template arguments, and most verification logics do not natively handle higher-kinded polymorphism. Lean 4 and Coq can, but the bridge to C++ AST does not yet exist at production quality.
- **Multiple inheritance and virtual dispatch**. Reasoning about dynamic dispatch requires a class hierarchy invariant plus a vtable model. Verifast and RefinedC handle restricted forms.
- **Exceptions**. Most Hoare-style logics assume normal control flow. Exception-aware logics exist (Jacobs et al.) but tooling lags.
- **Undefined behavior**. The C++ standard has roughly 200 species of UB. A sound verifier must rule out *every* one or model them as halting states. Frama-C Eva handles a defined fragment, MISRA C++ restricts the language to make UB tractable, and the C++ Core Guidelines Lifetime profile tries to push some of this into the type system.
- **Move semantics and ownership**. C++ has no borrow checker. Lifetime analysis is heuristic, not a sound type system. This is precisely the gap Rust fills and the reason serious new safety-critical code increasingly chooses Rust.

## Reading guide

This chapter walks the spectrum from cheap-and-shallow (property-based testing, fuzzing) to expensive-and-deep (Coq proofs of crypto). We cover Frama-C, CBMC, KLEE, Coq, Isabelle/HOL, Lean 4, TLA+, the C++26 contracts proposal, the Core Guidelines lifetime checker, and the verified-compiler line from CompCert to CakeML to MalCert. We finish with the economics, current AI-assisted proof tooling (Lean Copilot, GPT-style invariant suggestion), and where the field is going.

By the end you should be able to answer, for any given C++ codebase, the question: *what is the cheapest formal technique that buys us the assurance we actually need*.
