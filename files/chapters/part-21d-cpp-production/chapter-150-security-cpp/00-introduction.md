# Chapter 150: Security in C++

> "Security is not a product, but a process.", Bruce Schneier

---

70% of CVEs filed against Microsoft and Google products over the last decade trace back to a single root cause: memory safety bugs. Buffer overflows, use-after-free, type confusion, integer truncation. Not logic errors. Not misconfigured access control. Memory bugs. And the language at the center of that statistic is C++.

That fact is not an argument against C++. Browsers, operating system kernels, media decoders, network stacks, cryptographic libraries, the software that processes untrusted input at the highest volume and the lowest latency is written in C++. Chrome, BoringSSL, the Linux kernel's BPF JIT, Signal's native layer, Android's media framework. These are not legacy codebases waiting to be rewritten. They are active, evolving, production systems that serve billions of users. The engineers who maintain them have developed a rigorous, layered approach to security that any C++ engineer working on production code must understand.

Go engineers entering the C++ world have an advantage: Go's design eliminates entire categories of bugs at the language level. Slice bounds checking makes buffer overflows impossible without `unsafe`. Garbage collection eliminates use-after-free. The `fmt` package is type-safe by construction. Understanding what Go does automatically helps you understand what C++ requires you to do deliberately.

This chapter covers the complete C++ security stack.

**Memory safety** starts with understanding what buffer overflows and use-after-free actually are, what they enable an attacker to do, and how modern C++ idioms, `std::span`, smart pointers, lifetime annotations, prevent them. We cover both the safe patterns and the tooling: AddressSanitizer, clang-tidy, libFuzzer.

**Integer safety** addresses one of the most subtle classes of bugs: arithmetic that wraps or truncates, producing allocation sizes far smaller than intended. We cover undefined behavior in signed arithmetic, `__builtin_add_overflow`, and the SafeInt library.

**Format string security** shows why `printf` with a user-controlled format string is a critical vulnerability, and how `std::format` and the `{fmt}` library make the entire class impossible at the type system level.

**Cryptography** covers the three libraries you will encounter in production C++ codebases, libsodium for high-level, misuse-resistant encryption. BoringSSL for TLS and low-level primitives. OpenSSL for industry-standard interoperability. We show real encrypt/decrypt code, not toy examples.

**Secure memory** addresses a concern that rarely appears in Go but is critical in C++ systems handling cryptographic key material: preventing sensitive data from reaching swap, ensuring it is zeroed before deallocation, and protecting it with guard pages.

**Binary hardening** covers the compiler and linker flags that make exploitation harder: stack canaries, PIE, RELRO, CFI. These are not optional extras, they are the baseline for any C++ binary that processes untrusted input.

**Supply chain security** addresses the growing threat of compromised dependencies, covering vcpkg and Conan pinning, hash verification, SBOM generation, and vulnerability scanning.

**Sanitizers in production workflows** covers build matrices, thread and memory sanitizer deployment constraints, canary builds with sanitizers, and suppression governance.

**Fuzzing and continuous coverage** explores libFuzzer target anatomy, AFL++ out-of-process harnesses, structure-aware grammar mutations, and corpus management.

By the end of this chapter you will know how Chrome engineers ship millions of lines of C++ that parse untrusted HTML, JavaScript, and media without regularly creating exploitable vulnerabilities. It is not magic. It is process, tooling, and disciplined application of the patterns in this chapter.

---
