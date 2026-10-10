## Key Takeaways

- **CMake is the de facto standard build system generator.** Write modern CMake (3.20+) with explicit target-based properties, `target_link_libraries(PRIVATE/PUBLIC/INTERFACE)`, and never use global `include_directories` or `add_definitions`. Use `CMakePresets.json` to standardize configuration across developer machines and CI, eliminating the "works on my laptop" class of problems.

- **Bazel and Buck2 provide hermetic builds at monorepo scale.** Both enforce that every dependency is explicitly declared. Undeclared file system access fails the build. Bazel has a larger ecosystem and more remote execution providers. Buck2 (Rust engine, deferred materialization) has faster local builds and is Meta's choice for their monorepo. Both use Starlark for build rules and content-addressed caching for remote build sharing.

- **Ninja is the fastest build executor. Always use it with CMake.** Ninja does one thing: execute a pre-computed build graph as fast as possible. It has no built-in rules and is not meant to be hand-written, use `-G Ninja` when configuring CMake. The improvement over Makefiles is immediate and measurable, especially on incremental builds.

- **C++'s package management complexity is ABI-rooted.** vcpkg and Conan both work, but neither can be as simple as `go get` because the same source code compiled with different flags produces incompatible binaries. Use vcpkg manifest mode (`vcpkg.json`) for the fastest path to working dependencies with CMake. Use Conan 2.0 profiles when you need fine-grained control over binary configurations and team-wide binary caching via Artifactory.

- **ccache and sccache can cut clean build times by 80-95%.** Compilation caching keys object files by the hash of preprocessed source and compiler flags. ccache is for local development. sccache adds S3/GCS/Azure backends for shared CI caches, critical on ephemeral CI runners where local caches are empty every run. Use `sccache-action` on GitHub Actions.

- **clang-tidy with a ratchet strategy is the practical path to static analysis on existing codebases.** Enable clang-tidy on changed files only in pull requests using `git diff` to scope analysis. This avoids the bootstrap problem of 5,000 pre-existing warnings blocking development. Use `CMAKE_EXPORT_COMPILE_COMMANDS=ON` to generate the `compile_commands.json` that clang-tidy requires.

- **clang-format eliminates style debates. IWYU eliminates build ordering bugs.** Configure `.clang-format` once (Google base is a good starting point), enforce it in CI with `--dry-run --Werror`, and run `clang-format-diff.py` to format only changed lines. Run IWYU on the full codebase once to remove spurious includes, typical reduction is 20-40% of include directives, with 10-25% faster builds as a result.

- **Run sanitizers in CI: ASan + UBSan on every PR, TSan nightly.** Sanitizers find memory errors, races, and undefined behavior that static analysis cannot see. The CI matrix pattern (separate build job per sanitizer type) with appropriate `ASAN_OPTIONS`/`TSAN_OPTIONS` env vars is the production standard. Overhead: ASan ~2x, TSan ~5-15x, UBSan ~1.1x.

- **Docker multi-stage builds produce reproducible C++ binaries.** Order layers by stability (deps before source), use `--platform` for cross-compilation, and cache the vcpkg or Conan package layer separately from the source layer. Use BuildKit's GitHub Actions cache backend (`type=gha`) to share Docker layer caches between CI runs.

- **Go's tooling simplicity is a consequence of deliberate design constraints.** Go's single compiler, stable ABI, and source-only distribution model mean `go build` can do what CMake + Ninja + vcpkg + sccache do separately. C++'s complexity is not accidental, it reflects real constraints from compiler diversity, ABI instability, and 40 years of ecosystem evolution. Understanding why helps you configure the C++ tools correctly and reason about the problems each one solves.

---

| [◀ Chapter 141: Design Patterns in Modern C++](../chapter-141-design-patterns-cpp/00-introduction.md) | [Chapter 142: Build Systems and Tooling](00-introduction.md) | [Chapter 143: Testing in C++](../chapter-143-testing-cpp/00-introduction.md) ▶ |
