## Rust vs C++: The Formal Position

Any serious discussion of formal verification in C++ in 2026 has to address Rust, because Rust shifts the baseline. Rust's borrow checker is a **lightweight formal method** built into the compiler: it statically rules out data races and use-after-free in safe code, without programmer annotation beyond what the type system already requires. C++ has no equivalent.

This chapter section is not about Rust evangelism. It is about correctly placing C++ in the verification landscape now that Rust exists.

### What the borrow checker proves

Rust's ownership rules:

1. Every value has a unique owner.
2. References are either a single mutable borrow or any number of shared borrows, never both.
3. References cannot outlive the data they refer to.

These rules are checked at compile time. The published soundness proof (RustBelt, Jung et al., POPL 2018, in Coq using Iris) establishes that *safe* Rust programs are free of:

- Data races.
- Use-after-free.
- Iterator invalidation.
- Null pointer dereference (no nulls without `Option`).
- Type confusion.

The proof has a hole: `unsafe` blocks. Inside `unsafe`, the programmer is trusted to maintain invariants the compiler cannot check. RustBelt's contribution was showing how `unsafe` libraries (e.g., `Vec`, `Mutex`, `Arc`) can be locally proven sound, after which safe callers inherit safety.

In C++ terms, Rust's safe subset is what you would get if the C++ Core Guidelines Lifetime profile were a sound type system rather than a heuristic.

### Rust for Linux

The Linux kernel has accepted Rust for new drivers since version 6.1 (2022). By 2026, Rust is used in:

- Several drivers for Apple silicon and Intel hardware.
- The Asahi Linux GPU driver.
- Parts of the binder IPC subsystem.
- Filesystems experimentally.

The pitch to kernel maintainers was specifically about memory safety: Rust eliminates the bug class that has dominated Linux CVEs for two decades. Linus Torvalds and Greg Kroah-Hartman both publicly endorsed the move, with reservations about ABI churn and toolchain stability.

The implication for C++: Rust adoption in the kernel sets a precedent. New safety-critical code in adjacent ecosystems (firmware, hypervisors, embedded) will increasingly default to Rust unless C++ has a specific advantage.

### Verified Rust

Rust's type system is a starting point, not an endpoint. Several projects extend it to full functional verification:

#### Prusti

Prusti (ETH Zurich, Müller's group) verifies Rust code annotated with pre/post-conditions and pure functions. Built on Viper (the same backend as Dafny). PrustiPlus, the 2024 successor, supports more idiomatic Rust including some `unsafe` patterns.

```rust
#[requires(x >= 0)]
#[ensures(result >= x)]
fn next(x: i32) -> i32 {
    x + 1
}
```

Prusti generates verification conditions for Viper, which discharges them via Z3.

#### Verus

Verus (Microsoft Research, CMU, 2023) is a Rust dialect with built-in proof support. Specifications and proofs live alongside code in a single file. Verus has been used to verify a verified storage stack (PageTable, IronKV) and parts of a hypervisor.

```rust
proof fn lemma_assoc(a: int, b: int, c: int)
    ensures (a + b) + c == a + (b + c)
{ }
```

#### Aeneas

Aeneas (Ho et al., 2022) translates Rust to a pure functional model in F\* or Coq, sidestepping the impedance mismatch between imperative reasoning and Rust's borrow-checker discipline.

#### Kani

Kani (Amazon, 2022, open-source) is a bounded model checker for Rust based on CBMC. Same idea as CBMC for C, but exploits Rust's type information for stronger reasoning. Used internally at AWS for Rust code in s2n-quic and the Bottlerocket OS.

```rust
#[kani::proof]
fn check_increment() {
    let x: i32 = kani::any();
    kani::assume(x < i32::MAX);
    let y = x + 1;
    assert!(y > x);
}
```

The maturity gap between verified Rust tooling (Prusti, Verus, Kani, Aeneas) and verified C++ tooling is striking. By 2026, a senior engineer choosing between "verify a safety-critical component in C++ with Frama-C/WP-cxx" and "verify it in Rust with Verus or Prusti" will, in most cases, find the Rust path shorter.

### What this means for C++ in 2026

Three honest positions:

#### 1. Greenfield safety-critical, no ecosystem constraint

Default to Rust. Verify with Verus or Kani. The borrow checker alone gives you a substantial fraction of what verified C++ aims for, at zero annotation cost beyond ordinary Rust.

#### 2. Brownfield C++ with deep ecosystem ties

Stay in C++ but adopt the verification stack honestly: Astrée or Polyspace for sound static analysis, CBMC or ESBMC for memory-safety proofs of small components, Frama-C/WP-cxx for the most critical kernels, fuzz everything in between, and use C++ Core Guidelines Lifetime profile as a heuristic gate in CI.

#### 3. C++ at the boundary, Rust at the core

Increasingly common: a C++ application links a Rust crate compiled to a static library, with C ABI between them. The crate carries the verification work, the C++ side is conventional. This is the pattern emerging at Microsoft (Windows components), Mozilla (Servo to Gecko), Cloudflare (Pingora), and Discord.

### The C++ counter-argument

C++ partisans make several reasonable points:

- **Library ecosystem**. Boost, Eigen, ROS, OpenCV, CUDA, ONNX, LLVM itself. None of this exists in equivalent form for Rust yet.
- **ABI compatibility**. C++ links to C and to itself across decades. Rust's stable ABI is still emerging (`extern "C"` is the workaround).
- **Compile times and tooling maturity**. clangd is faster than rust-analyzer on large codebases as of 2026.
- **Workforce**. Far more C++ engineers than Rust engineers. Hiring matters.
- **Cost of rewrite**. Throwing away tens of millions of lines of working code is rarely the right call.

These are all valid reasons to keep C++. None of them is a reason to ignore the verification gap.

### Predictions worth stating clearly

By 2030, on current trajectories:

1. New OS kernels and hypervisors will be majority Rust or verified Rust, not C++.
2. New cryptographic libraries will be Rust or extracted from F\*/Coq, with C++ wrappers.
3. C++26 contracts will be in production, but they are runtime checks, not proofs. They do not close the gap with Rust's static guarantees.
4. C++ will retain dominance in graphics, ML kernels, HPC, and games where the library ecosystem is decisive.
5. Verification of C++ will remain niche, valuable for specific high-stakes components, not general practice.

### The honest senior engineer's stance

Treat Rust as a first-class option for new safety-critical C++ work. When the answer is C++, lean on the strongest static analysis your team can afford, fuzz aggressively, and reserve deductive verification for the components where the stakes justify it. Do not pretend C++ has Rust's safety story.

> **Junior to FAANG.** If you are considering whether to learn Rust as a C++ engineer, the answer is yes. Not because Rust replaces C++, but because the verification and safety conversation in your career is shifting, and you want to be in the room when your org decides which language a new safety-critical component is written in.

> **Senior at FAANG.** Be the person who can articulate the Rust-vs-C++ tradeoff in concrete terms (toolchain maturity, library ecosystem, hiring, verification ceiling) without sliding into either tribalism or false equivalence. That is the rarest skill in the room when this decision is made, and it is increasingly the decision being made.
