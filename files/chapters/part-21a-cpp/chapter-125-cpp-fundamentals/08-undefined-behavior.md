## Undefined Behavior

This section covers one of the most critical differences between Go and C++. **Go has no undefined behavior. C++ has a lot of it.** You must know undefined behavior (UB) to write correct C++ code, and it is a frequent topic in FAANG interviews.

### What Is Undefined Behavior?

Undefined behavior means the C++ standard places **no requirements** on what happens when your program triggers it. The compiler is free to:

- Do what you expect (masking the bug)
- Crash immediately
- Produce garbage values
- Format your hard drive (theoretically)
- Optimize away your code entirely
- Work on your machine and fail on another
- Work today and fail after a compiler update

**In Go,** every operation has defined semantics. Integer overflow wraps. Nil pointer dereference panics with a clear message. Out-of-bounds access panics. There is no equivalent of "anything can happen."

### Why Does UB Exist?

UB exists for performance. By declaring certain operations undefined, the C++ standard allows compilers to assume they never happen, which enables aggressive optimizations.

```cpp
// Example: the compiler can assume signed overflow never happens
int foo(int x) {
    if (x + 1 > x)    // always true if no overflow
        return 1;
    return 0;
}
// The compiler can optimize this to: return 1; // Because signed overflow is UB, the compiler assumes it never happens,
// so x + 1 > x is always true.
```

### Common Categories of Undefined Behavior

#### 1. Signed Integer Overflow

Because the C++ standard declares signed overflow undefined, the compiler is allowed to assume it never occurs. An optimizer that sees `x + 1 > x` can legally replace the entire branch with `return 1`, a real transformation that GCC and Clang perform at `-O2`. Go defines overflow as two's-complement wrapping, so no such optimization is permitted.
```cpp
#include <climits>
#include <iostream>

int main() {
    int x = INT_MAX;  // 2147483647
    x = x + 1;        // UNDEFINED BEHAVIOR!
    std::cout << x;    // might print -2147483648, might print anything
    return 0;
}
```

**In Go:**

```go
x := math.MaxInt32    // 2147483647
x = x + 1             // defined behavior: wraps to -2147483648
fmt.Println(x)        // always prints -2147483648
```

Note: unsigned integer overflow in C++ is well-defined (wraps around), just like in Go. Only signed overflow is UB.

#### 2. Null Pointer Dereference

Dereferencing a null pointer in C++ is undefined behavior, it typically segfaults, but an optimizing compiler may eliminate the check entirely because it assumes the code before the dereference is only reachable with a valid pointer. Go's nil dereference is defined to produce a recoverable panic with a clear message including the goroutine stack trace.
```cpp
int* p = nullptr;
int x = *p;          // UNDEFINED BEHAVIOR!
// Might crash with segfault, might return garbage, might be optimized away
```

**In Go:**

```go
var p *int = nil
x := *p              // defined behavior: runtime panic with clear message
// panic: runtime error: invalid memory address or nil pointer dereference
```

#### 3. Out-of-Bounds Array Access

C-style arrays and `std::vector::operator[]` perform no bounds checking, out-of-bounds access silently reads or corrupts adjacent memory, enabling buffer-overflow exploits. `std::vector::at()` throws `std::out_of_range` on invalid access. Go's slice indexing always bounds-checks and panics with a precise "index out of range" message.
```cpp
int arr[5] = {1, 2, 3, 4, 5};
int x = arr[10];     // UNDEFINED BEHAVIOR! No bounds checking
arr[-1] = 42;        // UNDEFINED BEHAVIOR!
```

**In Go:**

```go
arr := [5]int{1, 2, 3, 4, 5}
x := arr[10]         // defined behavior: runtime panic
// panic: runtime error: index out of range [10] with length 5
```

Use `std::vector` with `.at()` for bounds-checked access:

```cpp
std::vector<int> v = {1, 2, 3, 4, 5};
int x = v[10];       // UB: no bounds check (just like raw array)
int y = v.at(10);    // SAFE: throws std::out_of_range exception
```

#### 4. Use After Free

After `delete p`, the memory is returned to the allocator and may be reused immediately by another allocation. Reading or writing through the dangling pointer produces unpredictable values and can corrupt allocator metadata, leading to crashes far removed from the original bug. Go's garbage collector keeps memory alive as long as any reference exists, making this class of error structurally impossible.
```cpp
int* p = new int(42);
delete p;
int x = *p;          // UNDEFINED BEHAVIOR! p is dangling
*p = 100;            // UNDEFINED BEHAVIOR! writing to freed memory
```

**In Go:** This cannot happen. The garbage collector ensures objects are not freed while any reference exists.

#### 5. Uninitialized Variables

C++ local variables have indeterminate values until explicitly initialized, reading them before assignment is undefined behavior, so the compiler may produce any value or generate no load at all. Go zero-initializes every variable at declaration (`int` → 0, `bool` → false, pointers → nil), eliminating this entire category of bug without any runtime cost.
```cpp
int x;               // uninitialized local variable
std::cout << x;      // UNDEFINED BEHAVIOR! reading uninitialized memory
// Might print 0, might print garbage, might crash

bool flag;            // uninitialized
if (flag) {          // UNDEFINED BEHAVIOR!
    doSomething();
}
```

**In Go:**

```go
var x int            // zero-initialized: x == 0 (always)
var flag bool        // zero-initialized: flag == false (always)
```

Go's zero-value initialization eliminates this entire class of bugs. In C++, always initialize your variables:

```cpp
int x = 0;           // explicit initialization
int y{};             // zero-initialization with braces
bool flag = false;   // explicit initialization
```

#### 6. Data Races

Concurrent unsynchronized access to a non-atomic variable is undefined behavior in C++, giving the compiler license to cache `counter` in a register across loop iterations or reorder the increment entirely. Use `std::atomic<int>` with an appropriate memory order, or protect access with `std::mutex`. Go's race detector catches the equivalent bug at test time.
```cpp
#include <thread>

int counter = 0;

void increment() {
    for (int i = 0; i < 1000000; i++) {
        counter++;   // UNDEFINED BEHAVIOR when accessed from multiple threads!
    }
}

int main() {
    std::thread t1(increment);
    std::thread t2(increment);
    t1.join();
    t2.join();
    // counter might be 2000000, might be 1000042, might be anything
    return 0;
}
```

**In Go,** data races are also dangerous, but Go provides the race detector (`go build -race`) and the behavior, while unpredictable, does not cause the same level of "anything can happen" as C++ UB.

Fix with atomics or mutexes:

```cpp
#include <atomic>
#include <thread>

std::atomic<int> counter{0};

void increment() {
    for (int i = 0; i < 1000000; i++) {
        counter.fetch_add(1, std::memory_order_relaxed); // safe
    }
}
```

#### 7. Infinite Loop Without Side Effects

The C++ standard permits the compiler to assume any non-trivial loop eventually terminates. An infinite loop with no I/O, volatile accesses, or atomic operations may be entirely removed by the optimizer because the "forward progress" guarantee allows it to treat the loop as unreachable. Introduce a `std::atomic` flag or a volatile read inside the loop to prevent this optimization.
```cpp
// C++: this is technically UB if the loop never terminates
// and has no observable side effects
while (true) {
    // no I/O, no volatile access, no atomic operations
}
// The compiler may assume this loop terminates and optimize it away!
```

This is one of the more surprising forms of UB. The C++ standard allows the compiler to assume that all loops eventually terminate (with some exceptions in C++11 and later).

#### 8. Shifting Beyond Bit Width

Shifting a 32-bit integer by 32 or more bits, or by a negative count, is undefined behavior in C++. Compilers may generate the host CPU's native shift instruction, which wraps modulo the word size on x86 but zeros on ARM, silently producing platform-dependent results. Always ensure shift amounts are non-negative and strictly less than the type's bit width.
```cpp
int x = 1;
int y = x << 32;    // UB if int is 32 bits (shifting by >= width)
int z = x << -1;    // UB: negative shift count
```

#### 9. Modifying a String Literal

String literals are stored in the read-only data segment (`.rodata`). Declaring `char* s = "hello"` gives a non-const pointer to that read-only memory. Writing through it triggers a segfault on modern systems or silently corrupts other string literals on older ones. Always use `const char*` or `std::string` for string data.
```cpp
char* s = "hello";  // s points to read-only memory
s[0] = 'H';         // UNDEFINED BEHAVIOR! modifying a string literal
```

### Compiler Sanitizers: Your Safety Net

Modern compilers provide sanitizers that detect UB at runtime:

```bash
# AddressSanitizer: detects out-of-bounds, use-after-free, etc.
g++ -fsanitize=address -g program.cpp -o program

# UndefinedBehaviorSanitizer: detects signed overflow, null deref, etc.
g++ -fsanitize=undefined -g program.cpp -o program

# ThreadSanitizer: detects data races
g++ -fsanitize=thread -g program.cpp -o program

# Combine them
g++ -fsanitize=address,undefined -g program.cpp -o program
```

**Always compile with sanitizers during development.** They are the C++ equivalent of Go's race detector but cover far more categories of bugs.

### UB Summary for Go Developers

| Issue | Go Behavior | C++ Behavior |
|---|---|---|
| Signed overflow | Wraps (defined) | Undefined behavior |
| Nil/null deref | Panic with message | Undefined behavior |
| Out-of-bounds | Panic with message | Undefined behavior |
| Uninitialized vars | Zero-initialized | Undefined behavior |
| Use after free | Impossible (GC) | Undefined behavior |
| Data races | Unpredictable but bounded | Undefined behavior |
| Division by zero (int) | Panic | Undefined behavior |

---

### Junior → FAANG: Developing a Reflex for UB Recognition

Go engineers have strong safety reflexes built by the language: the compiler panics on nil dereference, out-of-bounds access, and integer conversion that would overflow. Those reflexes do not transfer to C++. In C++, the same operations silently compile and produce UB at runtime, which the compiler may exploit to generate surprising code.

Build a UB recognition checklist for code review: signed integer overflow (use `int64_t` and check bounds explicitly), array index without bounds check (prefer `at()` in debug builds, or `absl::Span`), uninitialized local variables (use `= {}` initialization for POD types), and pointer arithmetic that may go out of bounds. Reading this checklist before submitting your first C++ PR will catch bugs that ASan would only find at runtime.

First-job habit: run UBSan (`-fsanitize=undefined`) on every new piece of code locally before pushing. UBSan catches most UB categories at runtime with very low overhead (typically 1.1x to 1.5x slowdown). If CI does not already run UBSan, propose adding it.

### Senior @ FAANG: UB Elimination as a Security and Correctness Program

At the staff level, UB in a production C++ codebase is not a code quality problem. It is a security problem. Memory safety vulnerabilities (CVE-class) are overwhelmingly caused by UB in C++.

**UB as a security risk.** The compiler's assumption that UB never happens enables optimizations that can eliminate security checks. The canonical example: a null pointer check before a dereference may be eliminated by the compiler if it can prove (under the no-UB assumption) that the pointer is never null. This is not a compiler bug. It is correct behavior under the standard. A production security bug. A staff engineer ensures the team understands this by including UB-based security exploits in the team's security training.

**Sanitizer coverage as a program metric.** A mature C++ team tracks sanitizer coverage as a CI metric: what fraction of code paths exercised by tests are covered with ASan, UBSan, and TSan enabled? Coverage gaps are prioritized for new test additions. The goal is not 100% sanitizer coverage (some paths are too expensive to test with sanitizers) but an explicit, justified coverage map.

**UB elimination tooling.** Beyond sanitizers, two tools help eliminate UB systematically: Clang's `-fsanitize=undefined` with `-fno-sanitize-recover` (any UB terminates the process in test, forcing immediate investigation), and the Clang Static Analyzer (CSA) which detects some UB categories at compile time without the runtime overhead. A staff engineer integrates both into CI: UBSan in debug/test builds, CSA in every PR build. The combination catches UB both statically (at review time) and dynamically (in tests).

**Undefined behavior policy in code review.** At the L6 level, any PR that introduces a new potential UB (raw array access without bounds check, signed arithmetic without overflow check, `reinterpret_cast` between unrelated types) requires a written justification in the PR description. The justification must explain why the UB is unreachable (and how the reviewer can verify this) or why it is acceptable (performance-critical path with sanitizer coverage in tests). This policy makes UB visible and intentional rather than accidental.

