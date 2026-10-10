## Sanitizers as Testing Tools

Sanitizers are compiler-instrumented runtime detectors. They are not optional additions to your test suite, they are the most cost-effective way to catch memory corruption, data races, and undefined behavior in C++ code. A test binary that passes under plain gtest may fail immediately under ASan because it is reading freed memory that happens to still contain the right value. Running every unit test under ASan and UBSan as a standard CI configuration is not optional in serious C++ projects.

This chapter covers the four major sanitizers: ASan (memory safety), TSan (data races), UBSan (undefined behavior), and MSan (uninitialized reads), with concrete examples of what each catches and how to integrate them into a CI matrix.

### AddressSanitizer (ASan)

ASan instruments every memory access. It tracks every heap allocation and deallocation, poisons freed and out-of-bounds memory with magic values, and aborts with a full stack trace the moment any access violates memory safety.

```cpp
// asan_demo.cpp - this code has a use-after-free that EXPECT_EQ misses
#include <gtest/gtest.h>
#include <vector>

class DataBuffer {
public:
    DataBuffer(size_t n) : data_(new int[n]), size_(n) {}
    ~DataBuffer() { delete[] data_; }

    // Bug: returns a pointer into the internal array
    // Caller must not use it after DataBuffer is destroyed
    int* get_data() { return data_; }
    size_t size() const { return size_; }

private:
    int* data_;
    size_t size_;
};

TEST(DataBufferTest, SumOfElements) {
    int* raw_ptr = nullptr;
    size_t sz = 0;

    {
        DataBuffer buf(100);
        for (size_t i = 0; i < buf.size(); ++i) buf.get_data()[i] = i;
        raw_ptr = buf.get_data();
        sz = buf.size();
    }  // buf is destroyed here, raw_ptr is now dangling

    // Without ASan: reads stale (but still accessible) heap memory
    // EXPECT_EQ may pass because the memory hasn't been overwritten yet
    long sum = 0;
    for (size_t i = 0; i < sz; ++i) sum += raw_ptr[i];  // use-after-free

    EXPECT_EQ(sum, 4950);  // Passes! But the program is broken.
}
```

#### Building with ASan

Dynamic analysis tools instrument the binary at compile time to detect memory errors, undefined behavior, and data races that are invisible to the compiler's static analysis. Running the test suite under AddressSanitizer and UBSan before shipping is the minimum bar for memory-safe C++ code.
```cmake
# cmake/Sanitizers.cmake
function(enable_sanitizers target)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        set(ASAN_FLAGS
            -fsanitize=address
            -fno-omit-frame-pointer   # better stack traces
            -g
        )
        target_compile_options(${target} PRIVATE ${ASAN_FLAGS})
        target_link_options(${target} PRIVATE ${ASAN_FLAGS})
    endif()
endfunction()
```

```bash
# Run with symbolization for readable stack traces
ASAN_OPTIONS=symbolize=1:detect_leaks=1 \
ASAN_SYMBOLIZER_PATH=$(which llvm-symbolizer) \
./build_asan/my_tests
```

ASan output for the bug above:

```
==12345==ERROR: AddressSanitizer: heap-use-after-free on address 0x603...
READ of size 4 at 0x603... thread T0
    #0 DataBufferTest_SumOfElements_Test::TestBody() asan_demo.cpp:28
    
0x603... is located 0 bytes inside of 400-byte region [0x603..., 0x603...)
freed by thread T0 here:
    #0 DataBuffer::~DataBuffer() asan_demo.cpp:8
```

#### Leak Detection (LSan)

LSan is integrated into ASan and runs at process exit:

```bash
ASAN_OPTIONS=detect_leaks=1:leak_check_at_exit=1 ./my_tests
==12345==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 400 byte(s) in 1 object(s) allocated from:
    #0 operator new[](unsigned long) <...>
    #1 DataBuffer::DataBuffer(unsigned long) asan_demo.cpp:5
```

#### ASan Suppressions

For known false positives or third-party leaks:

```
# asan_suppressions.txt
leak:third_party_allocator
interceptor_via_lib:libdl.so
```

```bash
ASAN_OPTIONS=suppressions=/path/to/asan_suppressions.txt ./my_tests
```

### ThreadSanitizer (TSan)

TSan detects data races by tracking every memory access across threads. It instruments every load and store with a shadow memory table that records the last write and all concurrent reads for each memory location.

```cpp
// tsan_demo.cpp - a race that only manifests under specific scheduling
#include <gtest/gtest.h>
#include <thread>
#include <vector>

class Counter {
public:
    void increment() { ++count_; }  // Non-atomic: race condition
    int value() const { return count_; }

private:
    int count_{0};
};

TEST(CounterTest, ConcurrentIncrements) {
    Counter c;
    std::vector<std::thread> threads;

    for (int i = 0; i < 8; ++i) {
        threads.emplace_back([&c]() {
            for (int j = 0; j < 1000; ++j) c.increment();
        });
    }

    for (auto& t : threads) t.join();

    // Without TSan: likely passes because race is timing-dependent
    // With TSan: always reports the race, regardless of outcome
    EXPECT_EQ(c.value(), 8000);
}
```

```bash
# TSan cannot be combined with ASan - use a separate build
cmake -B build_tsan -DCMAKE_CXX_FLAGS="-fsanitize=thread -g" -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=thread"
cmake --build build_tsan
./build_tsan/my_tests
```

TSan output:
```
WARNING: ThreadSanitizer: data race (pid=12345)
  Write of size 4 at 0x... by thread T2:
    #0 Counter::increment() tsan_demo.cpp:8
  Previous write of size 4 at 0x... by thread T1:
    #0 Counter::increment() tsan_demo.cpp:8
```

#### TSan and Lock-Free Code

Legitimate lock-free code uses atomic operations that are invisible to the C++ memory model's race definition, but TSan can still flag them if you use relaxed orderings incorrectly. Use TSan suppressions or `__tsan_acquire/__tsan_release` annotations for intentionally racy code that you have proven correct:

```cpp
// TSAN_OPTIONS=suppressions=tsan.supp ./tests
// tsan.supp:
// race:MyLockFreeQueue::dequeue
```

### UndefinedBehaviorSanitizer (UBSan)

UBSan catches signed integer overflow, null pointer dereference, misaligned loads, out-of-bounds array access (static arrays), and invalid casts at runtime.

```cpp
// ubsan_demo.cpp
#include <gtest/gtest.h>
#include <cstdint>

TEST(UBSanDemo, SignedOverflow) {
    int x = INT_MAX;
    // Signed integer overflow is undefined behavior in C++.
    // Without UBSan: silently wraps to INT_MIN on x86.
    // With UBSan: reports runtime error.
    int y = x + 1;
    EXPECT_LT(y, x);  // Passes (INT_MIN < INT_MAX) but the overflow is UB
}

TEST(UBSanDemo, NullDereference) {
    int* p = nullptr;
    // UBSan reports before the segfault: "null pointer dereference"
    // *p = 42 - // uncommenting triggers UBSan
}

TEST(UBSanDemo, InvalidShift) {
    uint32_t val = 1u;
    // Shifting by >= width of type is UB
    // uint32_t bad = val << 32;  // UBSan: shift exponent >= width
}
```

```bash
# UBSan can be combined with ASan
cmake -B build_ubsan \
  -DCMAKE_CXX_FLAGS="-fsanitize=undefined,address -fno-sanitize-recover=all -g" \
  -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=undefined,address"
cmake --build build_ubsan
./build_ubsan/my_tests
```

`-fno-sanitize-recover=all` makes UBSan abort on the first violation rather than continue (which can produce misleading cascading errors).

### MemorySanitizer (MSan)

MSan detects reads of uninitialized memory. It is Clang-only and requires rebuilding all dependencies with MSan instrumentation (including the C++ standard library), which makes it the hardest sanitizer to deploy. Use it for security-critical parsing code.

```cpp
// msan_demo.cpp
#include <gtest/gtest.h>

TEST(MSanDemo, UninitializedRead) {
    int array[10];
    // array[5] is uninitialized
    // Without MSan: reads garbage, test may pass
    // With MSan: "use of uninitialized value"
    int result = array[5] * 2;
    EXPECT_GT(result, 0);  // May pass with garbage value
}
```

```bash
# MSan requires clang and cannot be combined with ASan or TSan
clang++ -fsanitize=memory -fno-omit-frame-pointer -g \
    -fsanitize-memory-track-origins=2 \
    msan_demo.cpp -o msan_demo
./msan_demo
```

### Sanitizer CI Matrix

A production CI pipeline runs tests in multiple configurations:

```yaml
# .github/workflows/sanitizers.yml
name: Sanitizer Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        config:
          - name: "Debug (no sanitizer)"
            build_type: Debug
            sanitizers: ""

          - name: "ASan + UBSan"
            build_type: RelWithDebInfo
            sanitizers: "-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer"

          - name: "TSan"
            build_type: RelWithDebInfo
            sanitizers: "-fsanitize=thread -fno-omit-frame-pointer"

    name: ${{ matrix.config.name }}

    steps:
      - uses: actions/checkout@v4

      - name: Install tools
        run: |
          sudo apt-get update
          sudo apt-get install -y clang cmake ninja-build llvm

      - name: Configure
        run: |
          cmake -B build -G Ninja \
            -DCMAKE_CXX_COMPILER=clang++ \
            -DCMAKE_BUILD_TYPE=${{ matrix.config.build_type }} \
            -DCMAKE_CXX_FLAGS="${{ matrix.config.sanitizers }}" \
            -DCMAKE_EXE_LINKER_FLAGS="${{ matrix.config.sanitizers }}"

      - name: Build
        run: cmake --build build --parallel

      - name: Test
        run: |
          ASAN_OPTIONS=detect_leaks=1:abort_on_error=1 \
          UBSAN_OPTIONS=print_stacktrace=1 \
          TSAN_OPTIONS=second_deadlock_stack=1 \
          ./build/my_tests \
            --gtest_output=xml:results-${{ matrix.config.name }}.xml

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results-${{ matrix.config.name }}
          path: results-*.xml
```

### GWP-ASan: Probabilistic Sanitizer in Production

GWP-ASan (Guardrails With Pointer-ASan) is a sampling variant of ASan designed for production: it instruments 1-in-N allocations rather than all of them, introducing negligible overhead while still catching heap corruption in production traffic.

```cpp
// Enabled in Clang via linker flag, no code changes needed
// -Wl,-plugin-opt=sample-profile  (compiler-specific)
// Or via MALLOC_CONF="tcache:false,metadata_thp:auto" for jemalloc GWP
```

GWP-ASan found real bugs in production at Google and Android that only manifested under specific workloads never covered by CI tests.

### Go Comparison

Go's `-race` flag is TSan built into the Go runtime. It requires no compile-time configuration, works on all platforms, and has near-zero operational overhead to enable. You run `go test -race ./...` and get race detection.

C++ sanitizers are more powerful, ASan catches memory corruption that Go's GC prevents by design, UBSan catches C++ undefined behavior that Go does not have, and MSan has no Go equivalent. But the operational complexity is real: you need four separate build configurations, they cannot all run simultaneously, and MSan requires rebuilding all dependencies. The C++ sanitizer story is a consequence of the language's memory model, not a deliberate design choice.

---
