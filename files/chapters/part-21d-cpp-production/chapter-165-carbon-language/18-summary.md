## Summary

Carbon is Google's open-source experimental successor to C++, designed for codebases where Rust's interop friction makes migration impractical. It was first announced in 2022 and has been in active design and partial implementation since. As of early 2026 it is pre-1.0, the toolchain is alpha, and the project itself explicitly tells users not to deploy it in production.

### The Central Bet

Carbon's core design bet is that cheap bidirectional C++ interop is more valuable in the short term than day-one memory safety, for the specific case of large existing C++ codebases that need a migration path. The bet has two halves: that interop can be made truly cheap by adopting C++ ABI and template visibility, and that safety can be retrofitted evolutionarily over the years following 1.0 without breaking the interop story. The first half is a hard engineering problem with a plausible path. The second half is a research-grade open question that no language has yet solved at scale.

### The Design in One Page

- **Syntax**: declarations with name before type, `var` and `let` for bindings, `fn` for functions, no preprocessor, packages instead of headers, modern parser-friendly grammar.
- **Generics**: constraint-based, checked at definition site, in the Rust trait and Swift protocol style. Errors land on the function being defined, not on callers.
- **Classes**: single inheritance of state, multiple implementation of interfaces, explicit virtual and override, no implicit conversions, no multiple inheritance of state.
- **Errors**: result-type values, no exceptions, panics for unrecoverable conditions. The detailed syntax is still being designed.
- **Memory**: C++-like at 1.0, evolutionary path toward safer defaults later. Not Rust-style borrow-checked.
- **Toolchain**: LLVM-based compiler, Bazel-based build, Carbon Explorer as the easiest entry point, local install possible but rough.
- **Interop**: import C++ headers through the `Cpp` package alias, full template and class visibility for the cases the design supports, no FFI ceremony.

### When Carbon Matters

For codebases of tens of millions of lines or more of C++, with heavy templates, long lifespans, and performance constraints, Carbon is the most credible migration path on offer. For everything else, Carbon is not the right answer in 2026 and may not be the right answer in 2030 either. Greenfield code should pick Rust or another language that fits. Smaller C++ codebases can be rewritten faster than they can wait for Carbon.

### The Honest Outlook

Three plausible futures: Carbon delivers and becomes the migration path for a meaningful slice of large C++ codebases. Carbon delivers partial value and finds a smaller niche than originally targeted. Carbon fails to deliver and the world moves on to other approaches. The middle outcome is probably the most likely. None of the three are knowable today, and the right disposition is calibrated tracking rather than commitment.

### Signals to Watch

The signals that would shift Carbon from "track" to "consider":
- A 1.0 release with a stability commitment.
- At least one production deployment outside Google.
- A working safe subset specification.
- A mature language server and debugger.
- Documented migration tooling for common C++ patterns.

None have arrived as of early 2026. Check the carbon-lang repository quarterly to see whether they have arrived by the time you read this.

### Comparison Quick Reference

- **Rust**: greenfield, safety, hard interop with C++.
- **Carbon**: large C++ migration, free interop, deferred safety.
- **Cpp2 / CppFront**: cleaner C++ syntax, no semantic change, available now.
- **Hylo**: research-grade safety through mutable value semantics.
- **Mojo**: ML and accelerator code.
- **Modern C++**: the answer for most teams that are tempted by any of the above.

### What This Chapter Was Not

This chapter was not a tutorial that prepares you to ship Carbon code, because no one ships Carbon code in 2026. It was a design tour that prepares you to discuss Carbon coherently, evaluate its progress accurately, and make a defensible call on whether your codebase should care about it.

### Junior at FAANG

You should be able to give a one-paragraph overview of Carbon: what it is, who built it, what problem it tries to solve, what its current status is. You should know it is not production-ready. You should not pretend to have used it.

### Senior at FAANG

You should be able to make a recommendation to your team about Carbon based on the specific characteristics of your codebase, identify the signals that would change that recommendation, and articulate the trade-offs against the alternatives (Rust, modern C++, Cpp2). You should be able to read Carbon design documents and form opinions on them, file useful issues against the project, and contribute to internal language strategy discussions at a level above the marketing-page level.

The most senior take on Carbon is the calmest one. The language might succeed, the language might fail, the right move is to track real signals, plan around the most likely outcomes, and avoid both the hype and the dismissal. That posture serves you well for every emerging technology, not just this one.

---

| [◀ Chapter 164: Formal Verification and Proof-Carrying C++](../chapter-164-formal-verification/00-introduction.md) | [Chapter 165: Carbon, Google's Experimental C++ Successor](00-introduction.md) | [Chapter 166: Blockchain, Cryptography, and Crypto-Trading Systems in C++](../chapter-166-blockchain-crypto-cpp/00-introduction.md) ▶ |
