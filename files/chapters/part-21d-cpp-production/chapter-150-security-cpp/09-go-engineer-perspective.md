## The Go Engineer's Perspective

Go was designed, in part, as a reaction to the security costs of C and C++. The language specification eliminates memory safety bugs by construction: slice bounds checking is mandatory, the garbage collector prevents use-after-free, and the type system prevents the pointer arithmetic that produces most memory corruption bugs. Understanding what Go provides automatically helps you understand what C++ requires you to build deliberately.

### Security Comparison

| Threat | Go | C++ |
|---|---|---|
| Buffer overflow | Impossible without `unsafe`, runtime bounds checks on all slice access | Use `std::span`, `std::vector::at()`, `_FORTIFY_SOURCE=2`, ASan, libFuzzer |
| Use-after-free | Impossible, GC reclaims memory only when zero references remain | `unique_ptr`, `shared_ptr`/`weak_ptr`, `enable_shared_from_this`, ASan, clang-tidy lifetime |
| Integer overflow | Panics on slice-index overflow. No automatic checked arithmetic | `__builtin_add_overflow`, SafeInt library, UBSan, input validation |
| Format string injection | Type-safe, `fmt.Sprintf` verbs operate on argument list only, no `%n` | `std::format`, `{fmt}` library. Never pass user input as format string, `-Wformat-security` |
| Cryptography | `crypto/aes`, `crypto/tls`, `golang.org/x/crypto`, simple, safe defaults | libsodium (recommended), BoringSSL (TLS), OpenSSL (interop). Manual lifecycle management |
| Secure memory | No stdlib primitive, `memguard` third-party. GC complicates pinning | `mlock`, `sodium_memzero`, `sodium_malloc`, guard pages, `MADV_DONTDUMP` |
| Binary hardening | PIE by default on major platforms. No CFI equivalent. Safe type system | Explicit: `-fstack-protector-strong`, `-fpie -pie`, full RELRO, CFI with LTO, SafeStack |
| Supply chain | `go.sum` hash verification for all deps, `govulncheck` for CVE scanning | vcpkg baseline + SHA512. Conan lock files. Bazel `sha256=`. Osv-scanner. Reproducible builds |

### What Go Gets for Free

**Memory safety by default.** Every slice access in Go is bounds-checked. There is no equivalent of `arr[n]` succeeding and corrupting adjacent memory. The runtime cost of bounds checking is typically 0-3% in real workloads, modern CPUs predict the branch correctly almost universally.

**Garbage collection.** The GC tracks all reachable objects. Memory is freed only when no goroutine can possibly reach it. Use-after-free, double-free, and dangling pointer dereferences are impossible without the `unsafe` package. The tradeoff is latency variance from GC pauses and the inability to control exactly when memory is released, relevant for real-time and embedded systems, not for most server code.

**Type-safe concurrency.** Go's race detector (`-race`) catches data races at runtime. Channels provide structured synchronization. Neither eliminates all concurrency bugs, but both substantially reduce the attack surface of concurrent code.

**Module integrity.** `go.sum` is generated automatically on every `go get` and verified on every build. The module proxy is tamper-evident. Compromising the Go supply chain requires compromising the proxy log, which is public and audited. There is no equivalent of a malicious vcpkg port that bypasses hash checking because nobody configured it.

### What C++ Requires in Addition

**Deliberate safe API design.** Go's safety is built into the language. In C++, safety is built into the APIs you choose: `std::span` instead of pointer+length, `std::vector::at()` instead of `operator[]`, `std::string` instead of `char*`. The C++ Standard Library provides safe equivalents for every unsafe C pattern, using them requires discipline and code review.

**Tooling integration.** The C++ security model depends on the toolchain: ASan for runtime detection, clang-tidy for static analysis, libFuzzer for input exploration, UBSan for undefined behavior. These tools are mature and effective, but they must be actively integrated into CI. A C++ project without these tools running continuously is operating without the safety net that Go provides by default.

**Explicit memory lifecycle management.** Go's GC handles memory lifecycle automatically. C++ requires explicit decisions about ownership (`unique_ptr`, `shared_ptr`), lifetime (scope, explicit release), and cleanup (destructors). The RAII pattern and smart pointers make this manageable, but they require understanding the ownership model, something that does not exist in Go because the GC makes it unnecessary.

**Build hardening.** Go binaries are PIE on most platforms by default. C++ requires explicit CMake configuration: stack canaries, PIE, full RELRO, CFI. A C++ binary without these flags is significantly more exploitable than a Go binary from the same source for the same vulnerability.

### Where C++ Wins

**Deterministic performance.** The GC pause, even Go's 500 microsecond P99 GC latency, is unacceptable in real-time systems, high-frequency trading, audio processing, and some networking contexts. C++ with RAII gives you deterministic, zero-GC-overhead memory management.

**Low-level control.** `mlock`, guard pages, custom allocators, direct hardware access, these are not accessible from Go's standard library without `unsafe` and significant extra work. C++ security code for HSMs, TPMs, and embedded security systems needs this control.

**Interoperability.** The kernel, hypervisors, hardware drivers, and the majority of security libraries (OpenSSL, BoringSSL, libsodium) are C/C++. Calling them from C++ is natural. Calling them from Go requires CGo, which adds complexity and eliminates Go's memory safety guarantees at the boundary.

### The Key Insight

The Chrome security team has shipped millions of lines of C++ for over a decade that parses the most adversarial input imaginable, arbitrary HTML, JavaScript, and media from the entire internet, with a manageable (though non-zero) vulnerability rate. They achieve this through four things: mandatory code review, mandatory fuzzing of all parsers, mandatory use of smart pointers (raw `new` is banned in Chromium), and a culture of treating every security bug as a process failure to fix rather than just a bug to patch.

Go eliminates the memory safety layer of this stack. C++ requires building it explicitly. The required investment is real, but the outcome is achievable.

---
