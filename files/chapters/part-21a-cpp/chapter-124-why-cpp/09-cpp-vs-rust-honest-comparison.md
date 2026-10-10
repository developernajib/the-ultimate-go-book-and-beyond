## C++ vs Rust: An Honest Comparison

> **Junior to FAANG:** Pick the language your team already runs in production. Rust is a great language but it does not magically erase a 30-million-line C++ codebase.
>
> **Senior at FAANG:** You will be asked to justify language choice in design docs. Reviewers want trade-offs, not religion. Memorize the matrix below.

This is not a "Rust is the future" post and it is not a "C++ is fine, leave it alone" post. Both are wrong. The two languages overlap heavily in the systems space, and at FAANG you will see them coexist for the next decade.

### The Honest Scorecard

| Concern | C++ (2026) | Rust (2026) | Winner |
|-------------------------------|---------------------------------|-----------------------------------|--------|
| Memory safety by default | No (UB on use-after-free, etc.) | Yes (borrow checker, no UB safe) | Rust |
| Compile times (incremental) | Slow without modules | Slow (LLVM-bound) | Tie |
| Build system maturity | CMake, Bazel, Buck2, Meson | Cargo (one true way) | Rust |
| Package management | vcpkg, Conan, system pkg | crates.io | Rust |
| ABI stability | Stable per platform (Itanium) | No stable ABI | C++ |
| Mature numeric libraries | Eigen, BLAS, MKL, Boost | nalgebra, ndarray (younger) | C++ |
| GPU toolchains | CUDA, ROCm, SYCL, HIP | rust-cuda (alpha), wgpu | C++ |
| Embedded compiler support | gcc-arm, IAR, Keil, TI, Green Hills | embedded-hal, probe-rs | C++ |
| Async runtime | None standard, executors P0443 | Tokio (de facto) | Rust |
| Pattern matching | P2688 (proposed C++26) | Built-in, exhaustive | Rust |
| Templates / generics power | Turing-complete templates | Generics + traits | C++ |
| Existing investment at FAANG | Massive | Growing in pockets | C++ |
| Hiring pool size | Large, skewed senior | Small, skewed junior or convert | C++ |
| Senior salary band | High (HFT, infra) | High and rising | Tie |

### Where Rust Actually Wins

**Memory safety.** This is not marketing. Microsoft's MSRC reported ~70% of CVEs across their C++ codebases came from memory unsafety (use-after-free, double-free, OOB read/write, type confusion). Google's Android team published similar numbers. Chromium's "Rule Of 2" exists because nobody trusts hand-written C++ at the security boundary anymore. If you are writing an IPC parser, a media decoder, or a sandbox host process, Rust starts you ten yards down the field.

**Tooling out of the box.** `cargo new`, `cargo test`, `cargo bench`, `cargo clippy`, `cargo fmt`, `cargo doc`. No CMakeLists.txt, no Conan profiles, no `find_package` archaeology. A new engineer can clone a Rust repo and run tests in under 60 seconds. The C++ equivalent is a setup wiki that hasn't been updated since 2022.

**No undefined behavior in safe code.** This matters most when fuzzing. A Rust crash is a panic. A C++ crash might be silent corruption that surfaces three days later in a different process.

**Concurrency without data races.** `Send`/`Sync` are checked at compile time. C++ ships data races to production every week.

### Where C++ Still Wins

**Mature ecosystem.** Want a SAT solver, a tensor library, a finite-element mesher, a real-time DSP framework, a CAD kernel? It exists in C++, it has been battle-tested for 20 years, and it has Fortran or assembly hot loops you cannot reasonably port. Rust crates exist for many of these but are typically thinner, younger, and missing edge cases.

**ABI stability.** The Itanium C++ ABI on Linux/macOS and the MSVC ABI on Windows are de facto stable. You can ship a `.so` or `.dll` and have it load against binaries built with a different compiler version. Rust has no stable ABI by design. Every Rust dynamic library is `extern "C"` underneath, which means giving up generics, traits, and most of what makes Rust ergonomic.

**GPU and accelerator toolchains.** CUDA is C++. HIP is C++. SYCL is C++. Metal Shading Language is C++-ish. If you are writing kernels for an A100, an MI300, or an Apple Silicon GPU, you are in C++ whether you want to be or not. `rust-cuda` exists but is alpha-quality and lags CUDA releases by 12-18 months.

**Embedded toolchains for exotic targets.** TI C2000 DSPs, Green Hills MULTI for avionics, IAR for Cortex-M, Keil, ARM Compiler 6, XC8 for PIC. These vendors ship C++ compilers (often C++14, sometimes C++17). They do not ship Rust. If your hardware is a Raspberry Pi or an STM32, Rust is fine. If it is an actual shipping consumer or industrial product, check before you commit.

**Existing investment.** Chrome is 35 million lines of C++. Unreal Engine, Unity native runtime, LLVM, GCC, V8, JSC, WebKit, MySQL, PostgreSQL, MongoDB, ClickHouse, Tensorflow, PyTorch internals. None of these are getting rewritten. You will work on them in C++ for the rest of your career.

### The Interop Reality

Rust-to-C++ interop is not magic. You have three real options.

**`bindgen` (Rust calls C):** mature, works well for C APIs, pain for anything that uses C++ classes, templates, or exceptions. The standard escape hatch is to write a C wrapper around your C++ API.

```cpp
// wrapper.h
extern "C" {
    void* engine_new();
    void engine_free(void*);
    int engine_step(void*, double dt);
}
```

**`cxx` (David Tolnay):** safe-ish bidirectional bridge with a shared schema. Good for value types, `std::string`, `std::vector`, `std::unique_ptr<T>`. Does not handle templates, multiple inheritance, virtual dispatch beyond a single layer. Used in Chromium, used heavily at Cloudflare. Production-ready for new boundaries, painful to retrofit.

**`autocxx`:** auto-generates `cxx` bindings from C++ headers using libclang. Aspirational. Works on simple headers, falls over on heavy template code. Treat as a productivity boost, not a strategy.

The pragmatic stack at scale: keep C++ as the implementation language for the hot loop and large existing libraries. Build new long-lived services and security-sensitive components in Rust. Use `cxx` at the boundary. Do not write a single Rust file that tries to be a thin wrapper around 200 C++ classes. That is where careers go to die.

### How to Choose for a New Project

Ask three questions in order:

1. **Does this code touch a security boundary or parse untrusted input?** Choose Rust. The CVE math is unambiguous.
2. **Does this code need to integrate with a large existing C++ codebase, GPU toolchain, or vendor SDK that only ships C++?** Choose C++. The interop tax exceeds the language benefit.
3. **Are you writing a long-lived service from scratch with a small team and no legacy?** Choose Rust if the team has Rust experience or a clear runway to learn. Choose C++ if hiring pool and ecosystem maturity dominate the calculation.

Tiebreakers nobody admits: who wrote the design doc, what the staff engineer prefers, and what the team can hire for. These are real, and pretending otherwise is naive.

### How to Choose for an Existing Codebase

Do not rewrite. The Joel Spolsky rule still holds in 2026. The only times a C++-to-Rust rewrite has worked at scale are:

- Cloudflare's Pingora (replaced nginx, not their own C++)
- Microsoft's bits of Windows kernel (incremental, multi-year, dedicated team)
- Mozilla's Stylo and WebRender in Firefox (component-level, not whole-engine)

In every successful case, the rewrite replaced a clearly bounded module with a fresh design. None replaced a 1M+ line C++ application all at once.

The realistic playbook for a healthy C++ codebase: keep writing C++, adopt sanitizers (ASan, UBSan, TSan, MSan) in CI, turn on `-Wall -Wextra -Wpedantic -Werror`, ban raw `new`/`delete` in style guides, use `std::unique_ptr` and `std::span`, and if you have a brand new component at the security perimeter, that one can be Rust.

### Perspective and Recommendation

If I were starting a new HFT engine today, I would still pick C++. The numerical libraries, the latency-tuned allocators, the cooperation with kernel bypass NICs (Solarflare, Mellanox/NVIDIA), and the talent pool win. If I were starting a new web service that parses untrusted input, I would pick Rust without hesitation. If I were extending Chrome, I would write C++ because that is what Chrome is, and I would push hard for any new IPC parser to be Rust behind a `cxx` boundary.

Anyone who tells you C++ is dead has not shipped to a CUDA target recently. Anyone who tells you Rust is a fad has not read the CVE database. Both are working languages with real strengths. Pick the one that solves your actual problem.

