## Memory Debugging Tools

When memory bugs do occur, these tools help you find them. Knowing these tools is essential for any systems programmer.

### Valgrind (Memcheck)

Valgrind runs your program in a virtual machine and tracks every memory operation. It is the gold standard for finding memory bugs on Linux.

```bash
# Compile with debug symbols (no optimization for accurate line numbers)
g++ -g -O0 -o myapp myapp.cpp

# Run under Valgrind
valgrind --leak-check=full --show-leak-kinds=all --track-origins=yes ./myapp
```

Example output:

```
==12345== Invalid read of size 4
==12345==    at 0x400A1B: processData(int*) (main.cpp:15)
==12345==    by 0x400B3C: main (main.cpp:28)
==12345==  Address 0x5204040 is 0 bytes inside a block of size 400 free'd
==12345==    at 0x4C2B1D0: operator delete[](void*) (vg_replace_malloc.c:621)
==12345==    by 0x400A05: cleanup() (main.cpp:12)
==12345==    by 0x400B30: main (main.cpp:27)
==12345==
==12345== HEAP SUMMARY:
==12345==     in use at exit: 1,024 bytes in 2 blocks
==12345==   total heap usage: 10 allocs, 8 frees, 4,096 bytes allocated
==12345==
==12345== 1,024 bytes in 2 blocks are definitely lost in loss record 1 of 1
==12345==    at 0x4C29F73: operator new[](unsigned long) (vg_replace_malloc.c:423)
==12345==    at 0x400980: allocateBuffers() (main.cpp:8)
==12345==    by 0x400B10: main (main.cpp:25)
```

**Valgrind detects:**
- Memory leaks (definitely lost, indirectly lost, possibly lost)
- Use-after-free
- Reads of uninitialized memory
- Double free
- Mismatched malloc/free vs new/delete
- Invalid reads/writes (buffer overflows)
- Memory overlap in memcpy

**Drawback:** 10-50x slowdown. Not suitable for production or performance testing.

### AddressSanitizer (ASan)

ASan is a compiler-based tool that inserts checks at compile time. Much faster than Valgrind (2x slowdown vs 20x).

```bash
# Compile with ASan enabled
g++ -fsanitize=address -fno-omit-frame-pointer -g -O1 -o myapp myapp.cpp

# Or with Clang
clang++ -fsanitize=address -fno-omit-frame-pointer -g -O1 -o myapp myapp.cpp

# Run normally -- no special command needed
./myapp
```

Example output for a heap-buffer-overflow:

```
=================================================================
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x604000000038
READ of size 4 at 0x604000000038 thread T0
    #0 0x4a1234 in processData(int*) main.cpp:15
    #1 0x4a1456 in main main.cpp:28

0x604000000038 is located 4 bytes to the right of 40-byte region
[0x604000000010,0x604000000038)
allocated by thread T0 here:
    #0 0x494321 in operator new[](unsigned long)
    #1 0x4a1200 in allocate() main.cpp:10
```

```cpp
// Example program that ASan will catch
#include <iostream>

int main() {
    int* arr = new int[10];
    
    // ASan catches this immediately
    arr[10] = 42;  // Heap buffer overflow!
    
    delete[] arr;
    
    // ASan catches this too
    std::cout << arr[0] << "\n";  // Use-after-free!
    
    return 0;
}
```

### LeakSanitizer (LSan)

LSan specifically targets memory leaks. It is often used alongside ASan but can also run standalone.

```bash
# LSan is included with ASan by default
g++ -fsanitize=address -g -o myapp myapp.cpp
./myapp

# Standalone LSan (link with -llsan)
g++ -fsanitize=leak -g -o myapp myapp.cpp
./myapp
```

Example output:

```
=================================================================
==12345==ERROR: LeakSanitizer: detected memory leaks

Direct leak of 400 bytes in 1 object(s) allocated from:
    #0 0x493de1 in operator new[](unsigned long)
    #1 0x4a1100 in allocateStuff() main.cpp:5
    #2 0x4a1234 in main main.cpp:12

SUMMARY: AddressSanitizer: 400 byte(s) leaked in 1 allocation(s).
```

### MemorySanitizer (MSan)

MSan detects reads of uninitialized memory. This is a bug that Valgrind also catches but MSan does it with much less overhead.

```bash
# Only available with Clang (not GCC)
clang++ -fsanitize=memory -fno-omit-frame-pointer -g -O1 -o myapp myapp.cpp
./myapp
```

```cpp
// MSan catches this
#include <iostream>

int main() {
    int* arr = new int[10];  // Not initialized
    
    int sum = 0;
    for (int i = 0; i < 10; ++i) {
        sum += arr[i];  // MSan: use of uninitialized value!
    }
    
    std::cout << sum << "\n";
    delete[] arr;
    return 0;
}
```

### Tool Comparison

| Tool | Detects | Overhead | Platform | Compile-time? |
|------|---------|----------|----------|---------------|
| Valgrind | All memory bugs | 10-50x | Linux, macOS | No (runtime) |
| ASan | Out-of-bounds, UAF, double-free, leaks | 2x | Linux, macOS, Windows | Yes |
| LSan | Memory leaks only | Minimal | Linux, macOS | Yes |
| MSan | Uninitialized reads | 2-3x | Linux (Clang only) | Yes |
| TSan | Data races (threads) | 5-15x | Linux, macOS | Yes |
| UBSan | Undefined behavior | Minimal | Linux, macOS, Windows | Yes |

**Recommended CI pipeline:**

```bash
#!/bin/bash
# Build and test with sanitizers in CI

# Debug build with ASan + UBSan
g++ -fsanitize=address,undefined -fno-omit-frame-pointer -g -O1 \
    -o myapp_asan myapp.cpp
./myapp_asan

# Thread sanitizer build (cannot combine with ASan)
g++ -fsanitize=thread -fno-omit-frame-pointer -g -O1 \
    -o myapp_tsan myapp.cpp
./myapp_tsan

# If using Clang: memory sanitizer build
clang++ -fsanitize=memory -fno-omit-frame-pointer -g -O1 \
    -o myapp_msan myapp.cpp
./myapp_msan
```

**Go comparison:** Go has a built-in race detector (`go run -race`) which is similar to TSan. Go does not need ASan or MSan because the language prevents the bugs they detect (bounds checking, zero initialization, GC). However, Go code that uses `unsafe` or CGo can have the same bugs, and ASan can be used with CGo.

---

### Junior → FAANG: Making Sanitizers Part of Your Development Loop

Go engineers run `go test -race` routinely because it is fast and built-in. C++ engineers should treat ASan and UBSan the same way: always enabled in the development and test build, never in production (2x overhead is acceptable for tests, not for production).

The practical setup: create a CMake or Bazel build configuration called `asan` that adds `-fsanitize=address,undefined -fno-sanitize-recover=all`. Run all tests under this configuration before every PR. The `fno-sanitize-recover=all` flag is important: it causes any sanitizer finding to terminate the process immediately with a clear error, rather than continuing in a potentially corrupted state.

First-job habit: when a colleague reports a crash or "mysterious corruption" bug, your first question should be "did you reproduce it under ASan?" Sanitizers catch 90% of memory bugs that are otherwise hours-long debugging sessions.

### Senior @ FAANG: Sanitizer Infrastructure Ownership and Production Memory Safety

At the staff level, sanitizers are not just developer tools. They are a systematic component of the quality program.

**Sanitizer coverage as a CI gate.** A mature C++ CI pipeline runs at minimum: ASan + UBSan on all unit and integration tests, TSan on all multi-threaded unit tests, and MSan (Memory Sanitizer, detects uninitialized reads) on a subset of tests where uninitialized-read bugs have historically appeared. A staff engineer designs the CI configuration so that any new test automatically runs under ASan, without requiring the author to opt in.

**Sanitizer-incompatible code paths.** Some C++ code is intentionally not compatible with sanitizers: code that uses custom allocators that bypass the system allocator (ASan intercepts `malloc`/`free`), code that uses platform-specific memory mapping for huge pages, and code that performs deliberate type punning. A staff engineer documents these exceptions in the build system with a comment explaining why ASan is suppressed and what alternative safety measure is in place.

**Valgrind vs. ASan trade-off.** Valgrind (Memcheck) is slower (10x to 50x) but works on any binary without recompilation, making it useful for debugging issues that only appear in release builds. ASan is faster (2x) but requires recompilation. A staff engineer knows when to use each: ASan in CI for all test runs, Valgrind for investigating production binary issues where recompilation is not feasible. In a CI-first culture, Valgrind is rarely needed, but having the knowledge to use it is a signal of depth.

**Memory safety as a program metric.** A principal-level engineer tracks CVE history and asks: what fraction of our C++ CVEs in the last 12 months were memory safety issues (use-after-free, buffer overflow, heap corruption)? If the answer is more than 50%, the team needs either better sanitizer coverage, a more aggressive static analysis baseline, or an evaluation of whether Rust is viable for the riskiest components. This is the executive-level framing of what sanitizers are solving.

