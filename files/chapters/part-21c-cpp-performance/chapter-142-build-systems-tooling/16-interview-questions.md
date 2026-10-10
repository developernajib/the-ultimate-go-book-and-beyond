## Interview Questions

### Q1: What is the difference between `PRIVATE`, `PUBLIC`, and `INTERFACE` in `target_link_libraries`? When would you use each?

**Answer:**

These keywords control transitive propagation of build properties (include paths, compile flags, link libraries) through the dependency graph.

- `PRIVATE`: The dependency is used only in the implementation of this target. Consumers of this target do not see it. Use when a library is an implementation detail, for example, a scheduler library using `{fmt}` internally to format log messages.

- `PUBLIC`: The dependency is used in both the implementation and the public interface (headers). Consumers inherit it automatically. Use when a type from the dependency appears in a public header, for example, if your library's public API uses `boost::asio::io_context` by value.

- `INTERFACE`: The dependency is not used in the implementation but is imposed on consumers. Use for header-only libraries or when writing a compatibility shim that forces consumers to link against something specific.

The rule of thumb: if a dependency's types appear in your public headers, use `PUBLIC`. If they appear only in `.cpp` files, use `PRIVATE`. The common mistake is using `PUBLIC` for everything, which unnecessarily forces implementation dependencies onto all downstream consumers and increases their compile times.

---

### Q2: What does it mean for Bazel to produce "hermetic" builds? Why does this matter in a team of 100 engineers?

**Answer:**

A hermetic build is one where the output depends only on the declared inputs and nothing else, not the state of the file system outside the build sandbox, not environment variables, not the system clock, not tools that happen to be installed on the machine.

Bazel enforces hermeticity by running each build action in a sandbox with restricted file system access. If your `BUILD` file declares that `scheduler.cpp` depends on `//src/util:logging` and nothing else, Bazel will prevent the compilation action from reading any file not explicitly listed. If your `.cpp` file actually does `#include <some_header_not_declared>`, the build fails, even if that header is physically present on disk.

For a team of 100 engineers this matters because:
1. "It builds on my machine but not in CI" becomes impossible. If it builds in Bazel, it builds everywhere.
2. Remote caching works correctly. Cache hits are valid because two identical input sets always produce identical outputs.
3. Incremental correctness is guaranteed. Bazel knows exactly what needs to rebuild because it tracks all dependencies explicitly.

The practical cost is that Bazel requires more upfront discipline in writing `BUILD` files, you must list every dependency. CMake will silently use headers that happen to be on the include path.

---

### Q3: You have a CI pipeline where ccache hit rates are at 40% even on the second run. What are three likely causes and how do you diagnose each?

**Answer:**

**Cause 1: `__DATE__` or `__TIME__` macros in headers.** These expand to different values on each build, producing different preprocessed source and therefore different cache keys. Diagnose with `ccache --show-config` (look for `sloppiness` settings). Fix with `sloppiness = time_macros` in `ccache.conf` to ignore these macros in the cache key, or better, remove them from headers.

**Cause 2: Absolute paths in compiler flags.** If `-I/home/runner/work/project/include` appears in the compiler invocation, and the CI runner path changes between runs (common in ephemeral GitHub Actions runners), the cache key changes. Diagnose with `ccache --show-stats --verbose` to see cache misses by reason. Fix by using relative paths in CMakeLists or by setting `hash_dir = false` in ccache config, combined with `-fdebug-prefix-map=$(pwd)=.` to strip absolute paths from debug info.

**Cause 3: Compiler binary content differs between runs.** If the compiler is installed fresh on each runner and the binary content changes (different patch version), the cache key differs. Diagnose by checking whether the compiler version is identical across runs. Fix by pinning the compiler version explicitly and setting `compiler_check = mtime` instead of `content` (faster, less precise) or by using a Docker container with a pinned compiler.

---

### Q4: What is the difference between Ninja and Make? When should you prefer one over the other?

**Answer:**

Make is a general-purpose build tool that evaluates rules, expands macros, and determines what needs rebuilding. It is Turing-complete and can be used for arbitrary tasks beyond compilation. It is slow on large projects because it parses its own Makefile, evaluates all rules, and checks timestamps for every target on every invocation, even when only one file changed.

Ninja is a deliberately minimal build executor. It has no built-in rules, no macro expansion language, and no decision-making beyond "this input changed, run this command." It is designed to be generated by another tool (CMake, GN, Meson) rather than written by hand. On a large project it starts in milliseconds compared to Make's seconds.

Prefer Ninja in all cases where you are using CMake (or any other generator). Set `cmake -G Ninja`. The build time improvement is immediate and measurable, especially on large incremental builds where Make's rule evaluation overhead dominates.

Keep Make when: you are maintaining an existing Makefile-based project where migration cost is not justified, or for simple auxiliary tasks (run tests, format code, clean artifacts) that are not part of the main build graph.

---

### Q5: Why does C++ not have a standard package manager like Go's `go get`? Is this a solvable problem?

**Answer:**

The core problem is the ABI (Application Binary Interface) instability of C++. When you compile a C++ library, the resulting binary depends on: the compiler (GCC vs Clang vs MSVC), the compiler version, the C++ standard (`-std=c++17` vs `-std=c++20`), the standard library implementation (`libstdc++` vs `libc++`), optimization flags (different optimization levels can change struct layouts in practice), and the platform (x86_64 Linux vs ARM64 macOS).

Go avoids this entirely by always compiling from source. There is no binary Go library format, `go get` fetches source code, not compiled objects. Go's module system works because a module at a given version always compiles to the same output on a given platform, independent of any external configuration.

C++ could theoretically mandate source-only distribution (as Go does), but this would be a breaking change to decades of ecosystem practice and would make compilation of large projects prohibitively slow (Boost takes 10+ minutes from source). The C++ committee chose to keep the language ABI-stable within certain constraints rather than requiring source-distribution, which preserves performance but creates the package manager problem.

vcpkg and Conan solve this by building from source per configuration and caching binaries keyed by the full configuration hash. This is correct but inherently more complex than Go's approach. It is not a fundamental unsolvable problem, it is a consequence of specific design decisions that made sense when they were made.

---

### Q6: Explain the ratchet pattern for integrating clang-tidy into a large existing C++ codebase that currently has 5,000 warnings.

**Answer:**

You cannot add `--warnings-as-errors` to a build with 5,000 existing warnings, it would block all development until every warning is fixed, which could take months. The ratchet pattern solves this by applying the lint rule only to changed code:

1. Run clang-tidy on the entire codebase and save the current warning count (or list of warning hashes) as the baseline.
2. In CI, run clang-tidy only on files changed in the current PR (via `git diff --name-only origin/main...HEAD`).
3. Fail the build if any new warning appears in the changed files.
4. Gradually fix existing warnings in background cleanup PRs, reducing the baseline over time.
5. Eventually the baseline reaches zero and you can enable global `--warnings-as-errors`.

The key tool is `clang-tidy-diff.py` (shipped with LLVM utils), which can scope analysis to specific line ranges rather than entire files. This prevents a situation where you touch one line of a file and must fix 20 pre-existing warnings in that file.

---

### Q7: You are designing a CI pipeline for a project that runs on Linux x86_64 and ARM64, Windows MSVC, and macOS. What does the build matrix look like and what tools do you use at each layer?

**Answer:**

```yaml
strategy:
  matrix:
    include:
      # Linux x86_64 (GCC and Clang)
      - os: ubuntu-22.04
        compiler: gcc-13
        triplet: x64-linux
      - os: ubuntu-22.04
        compiler: clang-17
        triplet: x64-linux
      # Linux ARM64 (cross-compile on x86_64)
      - os: ubuntu-22.04
        compiler: clang-17
        triplet: arm64-linux
        cross_compile: true
      # Windows MSVC
      - os: windows-2022
        compiler: msvc-2022
        triplet: x64-windows
      # macOS ARM64 (Apple Silicon)
      - os: macos-14
        compiler: apple-clang-15
        triplet: arm64-osx
```

At each layer:
- **Build system**: CMake with CMakePresets.json, the presets abstract platform differences
- **Packages**: vcpkg with triplet-specific configurations. The `vcpkg.json` is shared, vcpkg selects the right binaries per triplet
- **Compilation cache**: sccache with a separate S3 bucket prefix per triplet to avoid cache collisions
- **Tests**: CTest, same command on all platforms (`ctest --test-dir build --output-on-failure`)
- **Static analysis**: clang-tidy on Linux/macOS only (MSVC does not run clang-tidy in this pipeline. Use `/analyze` on Windows)

For Windows, pass `-DCMAKE_GENERATOR_PLATFORM=x64 -T host=x64` to select the 64-bit toolset. On macOS, use `-DCMAKE_OSX_ARCHITECTURES=arm64` to force Apple Silicon. On the cross-compile job, pass a `CMAKE_TOOLCHAIN_FILE` for the aarch64-linux-gnu toolchain.

---

### Q8: What is deferred materialization in Buck2 and why is it important for large monorepos?

**Answer:**

Deferred materialization means Buck2 does not download or write to disk the artifacts from remote build actions unless they are actually needed by a subsequent action or by the user explicitly.

In a large monorepo, a build of a top-level binary might involve thousands of intermediate artifacts, compiled object files, static libraries, generated headers. With a traditional remote execution setup (including Bazel in some configurations), all of these artifacts are downloaded to local disk even if only the final binary is needed. On a monorepo with tens of thousands of targets, this creates enormous I/O pressure and consumes significant disk space.

With deferred materialization, Buck2 tracks which artifacts exist in the remote cache by their content hash but only downloads them when:
1. A local action needs the artifact as an input and it is not already cached locally.
2. The user explicitly requests the artifact (e.g., the final binary output they asked to build).

In practice this means that `buck2 build //src:my_binary` on a warm remote cache downloads only `my_binary` and any intermediate artifacts not already cached locally, even if the build graph has thousands of nodes. This is the primary reason Buck2 feels faster than Bazel for incremental builds at Meta's scale, the network I/O is reduced proportionally to the number of intermediate artifacts that never need to materialize locally.

---
