## Key Takeaways

- **70% of CVEs in major C++ codebases are memory safety bugs.** Buffer overflows, use-after-free, type confusion, and integer overflow account for the majority of critical vulnerabilities in browsers, OS kernels, and media parsers. These are not exotic edge cases, they are the predictable consequence of raw pointer operations without bounds enforcement.

- **Go eliminates memory safety categories at the language level. C++ requires you to build the equivalent protections deliberately.** Go's slice bounds checking and garbage collection make buffer overflows and use-after-free structurally impossible. In C++, the same guarantees come from choosing the right APIs: `std::span` instead of pointer+length, `std::vector::at()` instead of `operator[]`, `unique_ptr` and `shared_ptr` instead of raw `new`/`delete`.

- **Signed integer overflow is undefined behavior in C++, which means compiler optimizations silently remove overflow checks.** The only safe way to check for overflow before arithmetic is `__builtin_add_overflow` / `__builtin_mul_overflow` (GCC/Clang), or to validate operands against `std::numeric_limits` before the operation. UBSan (`-fsanitize=signed-integer-overflow`) catches overflows in tests.

- **`printf` with a user-controlled format string is a read/write primitive for attackers.** `%n` writes to memory, `%x` leaks stack values. The fix is always using a literal format string. The architectural fix is `std::format` (C++20) or `{fmt}`, which are type-safe by design and have no `%n` equivalent. Enable `-Wformat-security -Werror=format-security` in all builds.

- **Never implement cryptography yourself.** Use libsodium for application-level authenticated encryption (XSalsa20-Poly1305, Ed25519, Argon2id), BoringSSL or OpenSSL for TLS and AES-GCM with proper AAD. Common mistakes: nonce reuse with AES-GCM (breaks both confidentiality and integrity), not verifying the authentication tag, using MD5 or SHA-1 for security purposes.

- **Sensitive memory, keys, passwords, tokens, can escape your process through swap, core dumps, and freed allocations.** Use `mlock`/`sodium_mlock` to prevent swapping, `MADV_DONTDUMP` to exclude pages from core dumps, and `sodium_memzero`/`explicit_bzero` to zero before freeing. The compiler may optimize away plain `memset` on dead stores, portable secure zeroing requires defeating the optimizer.

- **Binary hardening is a baseline requirement for any software that processes untrusted input.** Stack canaries (`-fstack-protector-strong`), PIE (`-fpie -pie`), full RELRO (`-Wl,-z,relro,-z,now`), and CFI (`-fsanitize=cfi-vcall,cfi-icall` with LTO) are independent layers, defeating one does not defeat the others. Verify with `checksec`. Fail CI if any are missing. Go binaries are PIE by default. C++ requires explicit configuration.

- **C++ supply chain security requires explicit hash pinning because there is no tamper-evident module proxy.** Go's `go.sum` provides automatic hash verification for all dependencies. In C++, vcpkg baselines, Conan lock files, and Bazel `sha256=` hashes must be configured deliberately. Scan all transitive dependencies with `osv-scanner`. The `xz-utils` backdoor (2024) demonstrates that supply chain attacks against C++ infrastructure are active and sophisticated.

- **The security tools are mature and effective: use all of them.** ASan catches buffer overflows and use-after-free with exact stack traces. UBSan catches undefined behavior including signed overflow. libFuzzer finds inputs your tests miss in minutes. clang-tidy with lifetime checks catches dangling pointer patterns statically. These tools together approximate Go's automatic safety, but only if you run them in CI on every change, not occasionally.

- **Secure C++ at scale is achievable.** Chrome processes arbitrary HTML, CSS, JavaScript, and media from the entire internet using millions of lines of C++ with a controlled vulnerability rate. The enabling factors are consistent: smart pointer discipline (no raw `new` in Chromium), mandatory fuzzing of all parsers, mandatory code review for security-sensitive paths, and a culture of treating memory safety as an engineering requirement rather than a nice-to-have. Process, tooling, and design discipline, not language magic, are what make secure C++ possible.

- **Sanitizers and fuzzers are complementary continuous shields.** Sanitizers provide oracle checks on deterministic test suites, while coverage-guided fuzzers (libFuzzer, AFL++) actively hunt edge-case inputs that crash or corrupt memory. Integrating both into CI and continuous canary environments prevents zero-day vulnerabilities from reaching production.

---

| [◀ Chapter 149: Embedded and Real-Time C++](../chapter-149-embedded-realtime/00-introduction.md) | [Chapter 150: Security in C++](00-introduction.md) | [Chapter 151: C++ Interview Preparation](../chapter-151-cpp-interview-prep/00-introduction.md) ▶ |

