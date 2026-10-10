## Exercises

### Exercise 1: CMake Project with vcpkg

Set up a new C++ project from scratch using CMake 3.25+ and vcpkg manifest mode. The project must include a library (`libgreeter`), a binary that uses it, and a test executable.

**Requirements:**

1. Create a `vcpkg.json` manifest that declares dependencies on `{fmt}` 10.x, `spdlog`, and `gtest`.
2. Write a `CMakeLists.txt` that:
   - Defines a `greeter` library with `PRIVATE` compile options and `PUBLIC` include directories using generator expressions.
   - Defines a `greeter_server` binary that links `greeter` with `PRIVATE` visibility.
   - Defines a `greeter_tests` executable linked to `greeter` and `GTest::gtest_main`, with `gtest_discover_tests` integration.
   - Exports the library correctly so downstream projects can `find_package(Greeter REQUIRED)`.
3. Write a `CMakePresets.json` with at least three presets: `debug`, `release`, and `ci`. The `ci` preset must enable `CMAKE_EXPORT_COMPILE_COMMANDS` and `sccache` as the compiler launcher.
4. Verify: `cmake --preset ci && cmake --build --preset ci && ctest --test-dir build/ci` must pass.

**Stretch goal:** Add a `FetchContent_Declare` fallback in `CMakeLists.txt` so the project builds without vcpkg if the toolchain file is not provided.

---

### Exercise 2: clang-tidy in CI

Add clang-tidy integration to the project from Exercise 1 that runs only on changed files in pull requests.

**Requirements:**

1. Write a `.clang-tidy` configuration file that enables `bugprone-*`, `modernize-*`, and `performance-*` checks, disables `modernize-use-trailing-return-type`, and treats all warnings as errors.
2. Write a `cmake/ClangTidy.cmake` module that:
   - Detects `clang-tidy` with `find_program`.
   - Exposes an option `ENABLE_CLANG_TIDY` (default OFF).
   - When enabled, sets `CMAKE_CXX_CLANG_TIDY` with `--warnings-as-errors=*`.
3. Write a GitHub Actions workflow (`.github/workflows/lint.yml`) that:
   - Triggers on pull requests to `main`.
   - Generates `compile_commands.json` via CMake.
   - Computes the list of changed `.cpp` files using `git diff --name-only`.
   - Runs `clang-tidy -p build/ --warnings-as-errors='*'` on only those files.
   - Fails the workflow if any warning is emitted.

**Stretch goal:** Use `clang-tidy-diff.py` (from the LLVM utils package) to automatically scope analysis to changed lines rather than changed files.

---

### Exercise 3: Bazel BUILD File

Write a `BUILD` file for the greeter project from Exercise 1 using Bazel `cc_library`, `cc_binary`, and `cc_test`.

**Requirements:**

1. Write a `WORKSPACE` file that loads `{fmt}` and `googletest` via `http_archive`, with the correct `sha256` checksum and `strip_prefix`.
2. Write a `BUILD` file that:
   - Defines a `cc_library` named `greeter` with `hdrs`, `srcs`, `copts` (`-std=c++20 -Wall -Werror`), and a `dep` on `@com_github_fmtlib_fmt//:fmt`.
   - Defines a `cc_binary` named `greeter_server` that depends on `:greeter`.
   - Defines a `cc_test` named `greeter_test` with `size = "small"` that depends on `:greeter` and `@com_google_googletest//:gtest_main`.
3. Define a `platform` target for `linux_x86_64` and `linux_aarch64` in a `platforms/BUILD` file.
4. Provide the shell commands to build, test, and query the dependency graph:
   - `bazel build //...`
   - `bazel test //... --test_output=streamed`
   - `bazel query "deps(//src:greeter_server)"`

**Stretch goal:** Write a custom Starlark rule `proto_cc_library` that takes a `.proto` file and runs `protoc` to generate a C++ gRPC library, wrapping the output in a `cc_library`.

---

### Exercise 4: Compilation Cache with sccache + S3

Configure a CI pipeline that uses sccache with an S3-compatible backend to share the compilation cache across PR and main branch builds.

**Requirements:**

1. Set up a GitHub Actions workflow that:
   - Installs sccache using `mozilla-actions/sccache-action`.
   - Passes `CMAKE_CXX_COMPILER_LAUNCHER=sccache` to the CMake configure step.
   - Sets `SCCACHE_GHA_ENABLED=true` to use the GitHub Actions cache backend.
   - Prints `sccache --show-stats` at the end of the build step.
2. Add a second job that runs on `ubuntu-22.04` and `macos-13` to verify the cache works cross-platform (each platform has its own cache namespace).
3. Verify that on a second run (warm cache), the build time drops by at least 60% compared to the cold run. Document the expected hit rate and how to diagnose a low hit rate.

**Pitfall to address:** Explain why using `__DATE__` or `__TIME__` in any header included by your project will suppress cache hits, and how to fix it with `SCCACHE_IGNORE_SERVER_STDERR` or by replacing the macros.

**Stretch goal:** Configure sccache to use a real S3 bucket (or MinIO locally) as the cache backend, and demonstrate cross-machine cache sharing by running two separate GitHub Actions jobs that share cached artifacts.

---

### Exercise 5: Sanitizer CI Matrix

Add a full sanitizer matrix to the project from Exercise 1.

**Requirements:**

1. Write a `cmake/Sanitizers.cmake` module that defines a function `target_enable_sanitizers(target TYPE <asan|tsan|ubsan|none>)`. The function must add the correct compile and link options for each sanitizer type without modifying global CMake state.
2. Integrate the function into `CMakeLists.txt` via a `SANITIZER` cache variable (default `none`).
3. Write a GitHub Actions workflow (`.github/workflows/sanitizers.yml`) with a matrix across `{none, asan, tsan, ubsan}` and `{gcc-13, clang-17}`. The matrix must:
   - Skip the `tsan` + `gcc-13` combination (TSan with GCC has known false positives in gtest).
   - Set the correct `ASAN_OPTIONS`, `TSAN_OPTIONS`, and `UBSAN_OPTIONS` environment variables on the `ctest` step.
   - Upload sanitizer logs as artifacts on test failure.
4. Deliberately introduce a data race in a test (two threads writing to the same integer without synchronization) and verify that the `tsan` matrix job fails with a meaningful TSan report. Then fix the race with a `std::mutex` and verify the job passes.

**Stretch goal:** Add a MSan job using a custom Clang build with `libc++` instrumented for MSan. Document the steps needed to build an MSan-clean standard library and why this is rarely done outside of large organizations.

---
