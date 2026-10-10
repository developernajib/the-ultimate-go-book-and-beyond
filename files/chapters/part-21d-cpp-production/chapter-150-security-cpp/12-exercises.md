## Exercises

### Exercise 1: Fuzz a JSON Parser and Trigger an Integer Overflow

Write a minimal JSON number parser that reads a numeric value into a fixed-size buffer. Instrument it with a libFuzzer entry point. The parser should contain a latent integer overflow bug where `count * sizeof(char)` wraps when count exceeds `SIZE_MAX / sizeof(char)`. Run the fuzzer and observe it triggering the overflow via AddressSanitizer.

Your tasks:
- Write `parse_json_number(std::string_view input)` that allocates `count * sizeof(char)` bytes and writes `count` characters.
- Write the `LLVMFuzzerTestOneInput` entry point.
- Build with `clang++ -fsanitize=address,fuzzer`.
- Fix the overflow using `__builtin_mul_overflow` and verify the fuzzer no longer crashes.
- Add an explicit upper bound check before the arithmetic as a second defense layer.

Expected outcome: the fuzzer finds the crash within seconds, ASan reports the heap overflow with exact stack traces, and the fixed version runs for millions of iterations without finding a crash.

---

### Exercise 2: Replace printf Throughout a Codebase

You are given a small network logging module (`logger.cpp`, `logger.h`) that uses `printf`, `fprintf`, `sprintf`, and `snprintf` throughout. Some calls pass user-controlled strings directly as format arguments (a format string vulnerability). Others pass them as the format string itself (a format string injection vulnerability).

Your tasks:
- Enable `-Wformat=2 -Wformat-security -Werror=format-security` and compile the module. Identify all warnings.
- Distinguish safe calls (user input as an argument, literal format string) from vulnerable calls (user input as the format string itself).
- Replace all logging with `std::format` (C++20) or `{fmt}`. Remove `sprintf` in favor of `std::string`.
- Enable `cppcoreguidelines-pro-type-vararg` in clang-tidy and verify no remaining variadic calls.
- Write a unit test that passes a crafted `%n%x%x%x` string as log input and verifies it is treated as literal text, not interpreted as a format string.

---

### Exercise 3: Implement a Secure Key Container with mlock and Guard Pages

Implement a `SecureKey` class that meets the following requirements:

- Allocates key material using `mmap` with `MAP_PRIVATE | MAP_ANONYMOUS`.
- Calls `mlock` to prevent the pages from being swapped to disk.
- Calls `madvise(..., MADV_DONTDUMP)` to exclude the pages from core dumps.
- Places a read/write guard page (mapped with `PROT_NONE`) immediately before and immediately after the key buffer.
- On destruction, zeroes the key material using `sodium_memzero` before unmapping.
- Provides `std::span<const uint8_t> view() const` for read-only access.
- Is non-copyable and non-movable.

Write a test that:
- Allocates a 32-byte key, fills it with random data.
- Writes past the end of the allocated region by 1 byte (into the guard page) inside a `fork()` child process, the child should crash with SIGSEGV, confirming the guard page is active.
- The parent process verifies the child terminated with signal 11.

---

### Exercise 4: Add Full RELRO, PIE, CFI, and Stack Canaries to a CMake Build

You have an existing CMake project (`CMakeLists.txt`) that builds a network daemon. It currently has no hardening flags. The daemon parses binary protocol messages from untrusted clients.

Your tasks:
- Add a `HARDENED_BUILD` CMake option (default `ON` in Release builds).
- When enabled, apply: `-fstack-protector-strong`, `-fpie -fPIE`, `-D_FORTIFY_SOURCE=2`, `-Wformat -Wformat-security -Werror=format-security`.
- Link with: `-pie`, `-Wl,-z,relro -Wl,-z,now`, `-Wl,-z,noexecstack`.
- Add CFI with LTO: `-flto -fsanitize=cfi-vcall,cfi-icall -fvisibility=hidden`.
- Add a post-build step that runs `checksec --file=$<TARGET_FILE:daemon>` and fails the build if any expected hardening flag is missing.
- Verify the final binary with `readelf -h daemon | grep DYN` and `checksec --file=daemon`.

Bonus: add a CI check using GitHub Actions that builds in Release mode and asserts `checksec` reports Full RELRO, PIE enabled, stack canary found, and NX enabled.

---

### Exercise 5: Write a vcpkg Baseline That Pins All Dependencies with Hash Verification

You are starting a new C++ project that will use libsodium, {fmt}, Abseil, and OpenSSL.

Your tasks:
- Create a `vcpkg.json` with a `builtin-baseline` pointing to a specific vcpkg registry commit.
- Add all four dependencies with minimum version constraints.
- Pin `zlib` (a transitive dependency) to a specific version in `overrides` to prevent automatic updates.
- Write a `vcpkg-configuration.json` that points to a private mirror registry for internal packages.
- Write a CI step (GitHub Actions) that:
  - Installs vcpkg from a pinned commit (not latest HEAD).
  - Runs `vcpkg install --x-manifest-root=. --feature-flags=versions`.
  - Verifies the SHA512 of the downloaded libsodium archive matches the value in the portfile.
  - Fails the build if any dependency was fetched from a URL not in the approved list.
- Document in a comment in `vcpkg.json` why each version minimum was chosen (e.g., minimum OpenSSL version for CVE remediation).

---
