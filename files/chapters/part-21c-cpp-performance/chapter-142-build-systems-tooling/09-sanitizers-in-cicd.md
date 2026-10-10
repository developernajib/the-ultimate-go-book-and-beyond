## Sanitizers in CI/CD

Sanitizers are compiler instrumentation passes that add runtime checks for specific classes of bugs. They turn silent undefined behavior, use-after-free, data races, signed overflow, into deterministic crashes with precise diagnostics. Unlike static analysis, sanitizers observe actual program execution, which means they catch bugs that only manifest on specific code paths or with specific inputs. Running your test suite under sanitizers is the single highest-value thing you can add to a CI pipeline for C++.

### AddressSanitizer (ASan)

ASan detects memory errors by maintaining a shadow memory map that tracks the validity of every byte in the process. Every memory access is instrumented with a check against the shadow map. Invalid accesses abort with a detailed report showing the stack trace of the access and the original allocation.

#### What ASan Catches

- Heap buffer overflow (reading/writing past `malloc`ed memory)
- Stack buffer overflow (reading/writing past a local array)
- Use-after-free (accessing memory after `free`)
- Use-after-return (returning a pointer to a local variable)
- Use-after-scope (using a pointer to a block-scoped variable after it exits)
- Double-free and invalid-free
- Memory leaks (via the integrated LeakSanitizer)

#### Build Configuration

The CMake function below adds `-fsanitize=address` (or `thread`, `undefined`) to both compiler and linker flags for a target, keeping sanitizer configuration encapsulated and reusable across CMakeLists files. Sanitizer builds require the same flag on both compiler and linker because the sanitizer runtime must be linked into the final binary. Omitting one side produces cryptic link errors.
```cmake
# cmake/Sanitizers.cmake

function(target_enable_sanitizers target)
    cmake_parse_arguments(SAN "" "TYPE" "" ${ARGN})

    if(SAN_TYPE STREQUAL "asan")
        target_compile_options(${target} PRIVATE
            -fsanitize=address
            -fno-omit-frame-pointer
            -fno-optimize-sibling-calls
            -g
        )
        target_link_options(${target} PRIVATE
            -fsanitize=address
        )

    elseif(SAN_TYPE STREQUAL "tsan")
        target_compile_options(${target} PRIVATE
            -fsanitize=thread
            -fno-omit-frame-pointer
            -g
        )
        target_link_options(${target} PRIVATE
            -fsanitize=thread
        )

    elseif(SAN_TYPE STREQUAL "ubsan")
        target_compile_options(${target} PRIVATE
            -fsanitize=undefined,float-cast-overflow,integer
            -fno-omit-frame-pointer
            -g
        )
        target_link_options(${target} PRIVATE
            -fsanitize=undefined
        )
    endif()
endfunction()
```

```cmake
# CMakeLists.txt

option(ENABLE_SANITIZER "Sanitizer type (asan/tsan/ubsan/none)" "none")

if(NOT ENABLE_SANITIZER STREQUAL "none")
    include(cmake/Sanitizers.cmake)
    target_enable_sanitizers(falcon_tests TYPE ${ENABLE_SANITIZER})
    target_enable_sanitizers(falcon_server TYPE ${ENABLE_SANITIZER})
endif()
```

#### Runtime Configuration

`ASAN_OPTIONS` environment variables control ASan's runtime behavior: `detect_leaks=1` enables LeakSanitizer, `abort_on_error=1` makes errors crash with a core dump instead of just printing a report, and `suppressions=` points to a file of known false positives that should be ignored. These options are typically set per CI job so leak detection and error handling can be tuned independently for unit tests versus integration tests.
```bash
# ASan options via environment variable
export ASAN_OPTIONS="detect_leaks=1:\
abort_on_error=1:\
halt_on_error=0:\
print_stats=1:\
suppressions=/path/to/asan.supp"

# ASan suppression file (for known false positives in third-party code)
# /path/to/asan.supp
# leak:libssl.so           # Suppress leak reports from OpenSSL
# leak:libunwind.so        # Suppress leak reports from libunwind
```

A real ASan report looks like this, notice the precision:

```
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000118
READ of size 4 at 0x602000000118 thread T0
    #0 0x561a2b in Scheduler::dequeue() src/scheduler.cpp:87
    #1 0x561a8c in WorkerPool::run() src/worker_pool.cpp:142
    #2 0x7f3e4a in std::thread::_Invoker... (libstdc++.so)

0x602000000118 is located 8 bytes to the right of 16-byte region
  allocated at:
    #0 0x7f3e1b in operator new[](unsigned long) (libasan.so)
    #1 0x561912 in Scheduler::Scheduler(int) src/scheduler.cpp:23
```

### ThreadSanitizer (TSan)

TSan instruments every memory access and synchronization operation to detect data races. It maintains a vector clock per memory location and reports when two threads access the same location without a happens-before relationship between them.

#### What TSan Catches

- Data races: two threads accessing the same variable, at least one write, no synchronization
- Lock order inversions: thread A acquires mutex M1 then M2. Thread B acquires M2 then M1
- Mutex double-lock and unlock errors
- Signal handler races

TSan cannot be combined with ASan (they both instrument memory accesses differently and conflict). Use separate CI jobs.

```bash
# TSan build
cmake -B build/tsan -S . -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_CXX_COMPILER=clang++-17 \
  -DENABLE_SANITIZER=tsan

# TSan runtime options
export TSAN_OPTIONS="halt_on_error=1:\
second_deadlock_stack=1:\
suppressions=/path/to/tsan.supp"

# Common TSan suppression (gtest teardown races)
# /path/to/tsan.supp
# race:testing::internal::ThreadLocalRegistryImpl
```

A typical TSan report:

```
WARNING: ThreadSanitizer: data race (pid=12345)
  Write of size 8 at 0x7f... by thread T2:
    #0 ConnectionPool::release(Connection*) src/connection_pool.cpp:156
    #1 WorkerThread::process() src/worker.cpp:89

  Previous read of size 8 at 0x7f... by thread T1:
    #0 ConnectionPool::acquire() src/connection_pool.cpp:134

  Thread T1 created at:
    #0 WorkerPool::start() src/worker_pool.cpp:67
```

### UndefinedBehaviorSanitizer (UBSan)

UBSan detects undefined behavior at runtime. C++ has dozens of forms of UB that compilers are free to exploit, signed integer overflow, null pointer dereference, misaligned access, out-of-bounds array indexing. UBSan instruments the code to trap these at the point they occur rather than letting them produce wrong results silently.

#### Key Sanitizer Groups

Dynamic analysis tools instrument the binary at compile time to detect memory errors, undefined behavior, and data races that are invisible to the compiler's static analysis. Running the test suite under AddressSanitizer and UBSan before shipping is the minimum bar for memory-safe C++ code.
```bash
# Full UBSan with most checks enabled
-fsanitize=undefined,\
float-cast-overflow,\
float-divide-by-zero,\
integer,\
nullability-assign,\
nullability-arg,\
nullability-return

# Can be combined with ASan (they do not conflict)
-fsanitize=address,undefined
```

UBSan-specific options:

```bash
export UBSAN_OPTIONS="print_stacktrace=1:\
halt_on_error=1:\
suppressions=/path/to/ubsan.supp"
```

### MemorySanitizer (MSan)

MSan detects reads of uninitialized memory. It is Clang-only and Linux-only. Unlike ASan (which instruments allocations), MSan instruments every load to check whether the bytes being read were written.

```bash
cmake -B build/msan -S . -G Ninja \
  -DCMAKE_CXX_COMPILER=clang++-17 \
  -DCMAKE_CXX_FLAGS="-fsanitize=memory -fno-omit-frame-pointer -g" \
  -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=memory"
```

MSan requires all linked libraries (including the standard library) to also be instrumented, otherwise it produces false positives. In practice this means using a custom-built `libc++` with MSan support, which makes it more complex to set up than ASan or UBSan.

### Full GitHub Actions CI Matrix

Continuous integration automatically builds and tests every commit, catching regressions before they reach the main branch. The workflow definition below configures the build matrix, runs the test suite under multiple compilers, and uploads coverage reports as artifacts.
```yaml
# .github/workflows/sanitizers.yml

name: Sanitizer CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  sanitizers:
    name: ${{ matrix.sanitizer }} / ${{ matrix.compiler }}
    runs-on: ubuntu-22.04

    strategy:
      fail-fast: false
      matrix:
        include:
          - sanitizer: none
            compiler: gcc-13
            build_type: Release
          - sanitizer: asan
            compiler: clang-17
            build_type: RelWithDebInfo
          - sanitizer: tsan
            compiler: clang-17
            build_type: RelWithDebInfo
          - sanitizer: ubsan
            compiler: clang-17
            build_type: RelWithDebInfo

    steps:
      - uses: actions/checkout@v4

      - name: Install build tools
        run: |
          sudo apt update
          sudo apt install -y \
            cmake ninja-build \
            gcc-13 g++-13 \
            clang-17 clang++-17

      - name: Install vcpkg dependencies
        uses: lukka/run-vcpkg@v11
        with:
          vcpkgJsonGlob: vcpkg.json

      - name: Configure
        run: |
          cmake -B build -S . -G Ninja \
            -DCMAKE_BUILD_TYPE=${{ matrix.build_type }} \
            -DCMAKE_CXX_COMPILER=${{ matrix.compiler == 'gcc-13' && 'g++-13' || 'clang++-17' }} \
            -DENABLE_SANITIZER=${{ matrix.sanitizer }} \
            -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake

      - name: Build
        run: cmake --build build --parallel

      - name: Test
        env:
          ASAN_OPTIONS: "detect_leaks=1:halt_on_error=1:print_stats=1"
          TSAN_OPTIONS: "halt_on_error=1:second_deadlock_stack=1"
          UBSAN_OPTIONS: "print_stacktrace=1:halt_on_error=1"
        run: ctest --test-dir build --output-on-failure --parallel 4

      - name: Upload sanitizer logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: sanitizer-logs-${{ matrix.sanitizer }}
          path: build/Testing/
```

### Overhead and Practical Guidance

| Sanitizer | Time overhead | Memory overhead | Can combine with |
|-----------|--------------|-----------------|-----------------|
| ASan      | ~2x          | ~2x             | UBSan           |
| TSan      | ~5-15x       | ~5-10x          | UBSan (limited) |
| UBSan     | ~1.1-1.5x    | Minimal         | ASan            |
| MSan      | ~3x          | ~2x             | UBSan           |

Run ASan + UBSan on every PR (overhead is acceptable). Run TSan nightly or on selected commits (overhead is too high for every build). Run MSan only if your codebase has a history of uninitialized memory bugs.

### The Go Comparison

Go has exactly one sanitizer: `-race`, which is equivalent to TSan. It is built into the compiler, requires no configuration, and runs with `go test -race ./...`. The Go memory model is simple enough that most race conditions are caught by the race detector alone. C++ needs four separate sanitizers because the language has four distinct classes of bugs that require different instrumentation strategies, and even all four together do not catch everything.

---
