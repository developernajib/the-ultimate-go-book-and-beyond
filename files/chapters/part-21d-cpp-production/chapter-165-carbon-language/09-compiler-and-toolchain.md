## Compiler and Toolchain

Carbon's toolchain is one of the more concrete and shippable parts of the project, even though it is far from feature-complete. The architectural choices and the developer workflow are clearer than the language semantics in some areas.

### LLVM-Based Compiler

The Carbon compiler is built on LLVM. Carbon source is parsed by a Carbon-specific frontend, lowered to a Carbon-specific intermediate representation, and then lowered further to LLVM IR for code generation. Using LLVM means Carbon gets:

- A mature optimizer with decades of engineering investment.
- Backends for every architecture LLVM supports: x86-64, ARM64, RISC-V, WebAssembly, and the rest.
- Sanitizer integration (ASan, MSan, TSan, UBSan) effectively for free.
- LTO (link-time optimization) and debug info generation that already work.

This is the same backend strategy Rust took, and for the same reasons. Building a production-quality optimizing backend from scratch is a multi-decade project, and there is no benefit to redoing it.

### Bazel as the Reference Build System

Carbon uses Bazel as its build system, both for building the Carbon compiler itself and as the recommended build system for Carbon code. This is unsurprising given the project's Google origins. Bazel's strengths (correct incremental builds, hermetic build environments, scaling to monorepos) align with what Carbon's target users want.

Whether Carbon will support other build systems (CMake, Meson, simple Makefiles) is a question for the future. The design does not preclude other build systems, but Bazel is what the team uses and what the docs assume.

### Modules, Not Headers

Carbon has no preprocessor and no header files. A Carbon source file declares its package, imports other packages by name, and is compiled as a unit. This means:

- No textual inclusion. Build times do not scale with the number of headers transitively included.
- No header guards, no `#pragma once`, no include order issues.
- No macro pollution. There are no macros.
- Cleaner separation between interface and implementation, similar to C++20 modules but without the years of standards-committee compromises.

The build graph is straightforward: each Carbon source file produces one module, modules depend on each other, the build system schedules them. This is the same model Rust, Swift, and modern Java use, and it is the right model for fast incremental builds.

### C++ Header Import

C++ headers are imported through the `Cpp` package alias, not through `#include`. The compiler invokes the Clang frontend internally to parse the C++ header, extracts the declarations, and exposes them under the `Cpp.` namespace inside Carbon. This is conceptually similar to how Swift's C++ interop works (and how Apple's Objective-C bridging headers worked before that).

The cost is that the Carbon compiler embeds, or at least cooperates with, a full C++ frontend. Clang is not small. The benefit is that interop works without bindings generation.

### Carbon Explorer

The Carbon Explorer is a browser-based playground for trying small Carbon snippets without installing anything locally. It runs the Carbon compiler in WebAssembly in the browser and shows compilation output and execution results. As of early 2026, the Explorer is the easiest way to try the language, since it bypasses the local install entirely.

The Explorer's limitations track the language's: features not yet implemented in the toolchain are not available in the Explorer either. But for reading the docs and running small examples, it is the right entry point.

### Local Install

Local install requires building the Carbon toolchain from source, which is a Bazel-based build of the carbon-lang repository. The currently documented steps are roughly:

1. Install Bazel (the project documents the supported version).
2. Install LLVM and Clang at compatible versions.
3. Clone the `carbon-language/carbon-lang` repository.
4. Run a Bazel build target for the Carbon toolchain.
5. Run the resulting binary against `.carbon` source files.

The exact commands change as the project evolves. The repository's `README.md` is the source of truth and should be checked before following anything else, including this chapter.

Be prepared for the local install to be rough. The toolchain is alpha. Build failures, missing features, and undocumented requirements are part of the experience.

### Editor Tooling

Editor tooling for Carbon (syntax highlighting, language server, formatter) is in early stages. The project has a language server in development but its feature set lags the language. For 2026, expect to read and write Carbon in an editor with basic syntax highlighting and not much else.

This is a meaningful daily-use limitation. Modern engineers rely on language servers for navigation, completion, and refactoring, and a language without good tooling is harder to use even for experienced developers.

### Diagnostics

The Carbon team has emphasized diagnostic quality as a design goal. Generic checking at the definition site (covered in the generics chapter) is one piece of this. Clean error messages with structured spans, suggestions, and minimal noise are the design intent. The current implementation is partial but the direction is right.

Comparing to C++'s default compiler diagnostics, where a single template error can produce kilobytes of unreadable output, Carbon's bar is not high to clear. Comparing to Rust's diagnostics, which set the modern standard, Carbon has work to do.

### Performance of the Compiler Itself

Carbon's compiler is designed to be fast. The architectural choices (no preprocessor, modules, definition-site checking) all reduce the work the compiler has to do. Whether this delivers in practice depends on implementation maturity. As of early 2026, the toolchain is alpha and not optimized for speed, the design admits the possibility of fast compilation, but the artifact does not yet demonstrate it.

### Junior at FAANG

You should be able to use the Carbon Explorer to run a hello-world program and explain what the toolchain does at a high level (parse, lower to LLVM IR, emit machine code).

### Senior at FAANG

You should be able to evaluate whether the toolchain is mature enough for a particular use case. As of early 2026, the answer for any production use case is no, and a senior engineer should be able to explain the specific gaps (incomplete language features, alpha-quality error messages, no language server, build system constraints) rather than handwave.

---
