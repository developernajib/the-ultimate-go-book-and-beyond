## Code Coverage: gcov and llvm-cov

Coverage measurement answers one question: which lines, branches, and functions did your tests actually execute? It does not tell you whether the tests are correct, a test that always passes regardless of the return value achieves 100% line coverage while testing nothing. Coverage is best used as a floor, not a ceiling: find the untested code paths and ask whether they need tests, not as a vanity metric to optimize.

C++ has two mainstream coverage toolchains: gcov (GCC) and llvm-cov (Clang). Both instrument the binary at compile time and produce coverage data when the binary runs. llvm-cov is more modern, supports region-level coverage (not just lines), and integrates cleanly with Codecov and Coveralls.

### gcov: The GCC Approach

#### Instrumented Build

gcov coverage requires compiling with `--coverage` (equivalent to `-fprofile-arcs -ftest-coverage`) applied to both compile and link steps so that the linker includes the gcov runtime. At runtime, the test binary writes `.gcda` execution count files that gcov then merges with the static `.gcno` flow graph files to produce per-line hit counts.
```cmake
# CMakeLists.txt - coverage target using gcov
option(ENABLE_COVERAGE "Enable gcov coverage instrumentation" OFF)

if(ENABLE_COVERAGE)
    if(NOT CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
        message(FATAL_ERROR "Coverage with gcov requires GCC")
    endif()

    # --coverage is equivalent to -fprofile-arcs -ftest-coverage
    # Must be applied to both compile and link steps
    target_compile_options(my_library PUBLIC --coverage -O0 -g)
    target_link_options(my_library PUBLIC --coverage)

    target_compile_options(my_tests PUBLIC --coverage -O0 -g)
    target_link_options(my_tests PUBLIC --coverage)
endif()
```

#### Running and Collecting

After a test run, gcov reads the `.gcda` execution counters and the `.gcno` graph files to produce a `.gcov` report with per-line hit counts. The `-b` flag includes branch coverage, and `-r` shows only source-relative paths so the output is readable even when the build tree is deeply nested.
```bash
# Build with coverage
cmake -B build -DENABLE_COVERAGE=ON -DCMAKE_BUILD_TYPE=Debug
cmake --build build

# Run tests - this generates .gcda and .gcno files alongside the source
./build/my_tests

# Per-file line+branch coverage to stdout
gcov -b -r src/widget.cpp
# Output: widget.cpp: Lines executed: 78.26% of 46
#         Branches executed: 62.50% of 32

# Generate human-readable .gcov annotated source
gcov src/widget.cpp
```

#### lcov + genhtml: HTML Report

`lcov --capture` aggregates all `.gcda` files under the build directory into a single `coverage.info` file. `lcov --remove` then strips out system headers and test harness code that would inflate apparent coverage. The filtered `coverage.info` is fed to `genhtml` to produce a browsable HTML report with color-coded line and branch coverage annotations.
```bash
# Capture coverage data from all .gcda files under build/
lcov --capture \
     --directory build/ \
     --output-file coverage.info \
     --rc lcov_branch_coverage=1

# Remove coverage data for system headers and test files
lcov --remove coverage.info \
     '/usr/*' '*/test*' '*/googletest/*' \
     --output-file coverage_filtered.info \
     --rc lcov_branch_coverage=1

# Generate HTML report
genhtml coverage_filtered.info \
        --output-directory coverage_html \
        --branch-coverage \
        --title "My Project Coverage"

# Open in browser
xdg-open coverage_html/index.html
```

The HTML report shows green/red highlighting per line and a coverage percentage per file. Branch coverage requires `--rc lcov_branch_coverage=1` at both capture and genhtml stages.

### llvm-cov: The Clang Approach

llvm-cov is more accurate than gcov at the region level, it tracks individual expressions within a line, so `a && b` shows separate coverage for `a` and `b`. It also integrates with sanitizer builds and is the tool used by most LLVM-based projects.

#### Instrumented Build

llvm-cov uses `-fprofile-instr-generate -fcoverage-mapping` to emit source-based coverage data, which tracks individual expressions rather than just lines, so a compound boolean like `a && b` reports separate hit counts for each operand. This `ENABLE_LLVM_COV` CMake option gates the flags and enforces that the Clang compiler is active, since these flags are Clang-specific and will cause linker errors under GCC.
```cmake
option(ENABLE_LLVM_COV "Enable llvm-cov coverage instrumentation" OFF)

if(ENABLE_LLVM_COV)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        message(FATAL_ERROR "llvm-cov requires Clang")
    endif()

    # Instrument for source-based coverage (more precise than gcov)
    add_compile_options(-fprofile-instr-generate -fcoverage-mapping -O0 -g)
    add_link_options(-fprofile-instr-generate)
endif()
```

#### Running and Reporting

The `LLVM_PROFILE_FILE` environment variable tells the instrumented binary where to write raw profile data (`.profraw`). Multiple parallel test binaries each write their own `.profraw` file, and `llvm-profdata merge` combines them into a single `.profdata` file that `llvm-cov export` converts to lcov format for upload to coverage reporting services like Codecov or Coveralls.
```bash
# Build
cmake -B build -DENABLE_LLVM_COV=ON
cmake --build build

# Set output file for raw profile data
LLVM_PROFILE_FILE="build/test.profraw" ./build/my_tests

# Merge (handles multiple .profraw files from parallel test runs)
llvm-profdata merge \
    -sparse build/test.profraw \
    -o build/test.profdata

# Summary report to stdout
llvm-cov report \
    ./build/my_tests \
    -instr-profile=build/test.profdata \
    -ignore-filename-regex='.*test.*|.*/usr/.*'

# Line+branch+region annotated source
llvm-cov show \
    ./build/my_tests \
    -instr-profile=build/test.profdata \
    -format=html \
    -output-dir=coverage_html \
    -show-branches=count \
    -show-regions

# Export in lcov format for Codecov/Coveralls
llvm-cov export \
    ./build/my_tests \
    -instr-profile=build/test.profdata \
    -format=lcov \
    > coverage.lcov
```

### GitHub Actions: Coverage in CI

Continuous integration automatically builds and tests every commit, catching regressions before they reach the main branch. The workflow definition below configures the build matrix, runs the test suite under multiple compilers, and uploads coverage reports as artifacts.
```yaml
# .github/workflows/coverage.yml
name: Coverage

on: [push, pull_request]

jobs:
  coverage:
    runs-on: ubuntu-24.04

    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y clang llvm cmake ninja-build

      - name: Configure with coverage
        run: |
          cmake -B build \
                -G Ninja \
                -DCMAKE_CXX_COMPILER=clang++ \
                -DENABLE_LLVM_COV=ON \
                -DCMAKE_BUILD_TYPE=Debug

      - name: Build
        run: cmake --build build --parallel

      - name: Run tests and collect coverage
        run: |
          LLVM_PROFILE_FILE="build/test.profraw" ./build/my_tests
          llvm-profdata merge -sparse build/test.profraw -o build/test.profdata
          llvm-cov export ./build/my_tests \
              -instr-profile=build/test.profdata \
              -format=lcov \
              -ignore-filename-regex='.*_test\.cpp|.*googletest.*' \
              > coverage.lcov

      - name: Upload to Codecov
        uses: codecov/codecov-action@v4
        with:
          files: coverage.lcov
          fail_ci_if_error: true
          token: ${{ secrets.CODECOV_TOKEN }}
```

### Coverage with Multiple Test Binaries

In real projects, coverage must be merged across multiple test binaries. llvm-profdata handles this:

```bash
# Run all test binaries with separate profile files
LLVM_PROFILE_FILE="build/unit.profraw"       ./build/unit_tests
LLVM_PROFILE_FILE="build/integration.profraw" ./build/integration_tests

# Merge all profraw files
llvm-profdata merge \
    -sparse \
    build/unit.profraw \
    build/integration.profraw \
    -o build/combined.profdata

# Report against all binaries (list them all)
llvm-cov report \
    -object ./build/unit_tests \
    -object ./build/integration_tests \
    -instr-profile=build/combined.profdata
```

### Coverage Pitfalls

**100% line coverage does not mean 100% branch coverage.** The line `return a > 0 ? a : -a;` has one line but two branches. Always measure branch coverage for any code with conditionals.

**Inlining hides coverage.** With `-O2`, the compiler inlines many functions. Covered call sites appear as covered in the callee's source, but the function itself may not appear covered. Use `-O0` for coverage builds.

**Coverage inflation from template instantiations.** A template instantiated for 10 types counts each instantiation separately in some tools. Filter out generated code if it distorts the report.

**Test files count toward coverage.** Always filter out `*_test.cpp` and third-party libraries from your coverage report.

### Go Comparison

Go's coverage toolchain is three commands with zero build-system configuration: the compiler, test runner, and report generator are all built into `go test` and `go tool cover`. C++ coverage requires selecting gcov or llvm-cov, adding CMake flags, running profdata merge, exporting to lcov format, and uploading to a third-party service, a meaningful operational cost that is worth paying for complex libraries but impractical for rapid iteration early in a project.
```bash
# Go: 3 commands, built-in, no flags needed for basic coverage
go test -coverprofile=cov.out ./...
go tool cover -func=cov.out        # per-function summary
go tool cover -html=cov.out        # open HTML report in browser
```

Go's toolchain integration is dramatically simpler. C++ requires choosing a compiler, adding build flags, running profdata merge, exporting to lcov format, then uploading to a service. The C++ tools are more detailed (region-level coverage, branch visualization) but the operational overhead is significant. If you add coverage early in a project's lifecycle, before the build is complex, the cost is manageable.

---
