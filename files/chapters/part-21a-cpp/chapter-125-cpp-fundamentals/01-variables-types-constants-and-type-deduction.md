## Variables, Types, Constants, and Type Deduction

### Fundamental Types

C++ has a richer set of primitive types than Go. Where Go gives you precisely sized integers (`int32`, `int64`), C++ gives you platform-dependent sizes that you must explicitly pin down with fixed-width types from `<cstdint>`.

**In Go:**

```go
package main

import "fmt"

func main() {
    var a int = 42          // platform-dependent: 32 or 64 bits
    var b int32 = 42        // exactly 32 bits
    var c float64 = 3.14    // always 64-bit IEEE 754
    var d bool = true        // boolean
    var e string = "hello"  // immutable UTF-8 string
    var f byte = 0xFF       // alias for uint8
    var g rune = 'A'        // alias for int32 (Unicode code point)

    fmt.Println(a, b, c, d, e, f, g)
}
```

**In C++:**

```cpp
#include <cstdint>   // fixed-width integer types
#include <string>    // std::string
#include <iostream>  // std::cout

int main() {
    int a = 42;              // platform-dependent: usually 32 bits
    int32_t b = 42;          // exactly 32 bits (from <cstdint>)
    double c = 3.14;         // always 64-bit IEEE 754
    bool d = true;           // boolean (1 byte, not 1 bit)
    std::string e = "hello"; // mutable, dynamic string
    uint8_t f = 0xFF;        // exactly 8 bits unsigned
    char32_t g = U'A';       // 32-bit Unicode code point

    std::cout << a << " " << b << " " << c << " "
              << d << " " << e << " "
              << static_cast<int>(f) << " " << static_cast<int>(g)
              << "\n";
    return 0;
}
```

### Type Comparison Table: Go vs C++

| Concept | Go | C++ | Notes |
|---|---|---|---|
| Boolean | `bool` | `bool` | C++ `bool` is 1 byte. Go `bool` is 1 byte |
| Signed integers | `int8`, `int16`, `int32`, `int64` | `int8_t`, `int16_t`, `int32_t`, `int64_t` | C++ requires `<cstdint>` for fixed-width |
| Unsigned integers | `uint8`, `uint16`, `uint32`, `uint64` | `uint8_t`, `uint16_t`, `uint32_t`, `uint64_t` | Same header requirement |
| Platform int | `int` (32 or 64 bits) | `int` (usually 32 bits) | Sizes differ across platforms in both |
| Pointer-sized int | `uintptr` | `uintptr_t`, `size_t` | C++ `size_t` is the idiomatic choice for sizes |
| 32-bit float | `float32` | `float` | Both are IEEE 754 single precision |
| 64-bit float | `float64` | `double` | Both are IEEE 754 double precision |
| No 128-bit float | N/A | `long double` | Size varies: 80-bit, 128-bit, or same as `double` |
| Byte | `byte` (alias `uint8`) | `std::byte`, `uint8_t`, `unsigned char` | C++ `std::byte` (C++17) is not arithmetic |
| Character | `rune` (alias `int32`) | `char`, `wchar_t`, `char8_t`, `char16_t`, `char32_t` | C++ has many character types for encoding support |
| String | `string` (immutable) | `std::string` (mutable) | Go strings are value types. C++ strings are objects |
| Complex | `complex64`, `complex128` | `std::complex<float>`, `std::complex<double>` | C++ requires `<complex>` |

### Variable Declaration Styles

C++ offers multiple ways to declare variables. This is one of the first culture shocks for Go developers, who have exactly two: `var x int` and `x := value`.

```cpp
// C++ variable declaration styles

// 1. C-style initialization
int a = 42;

// 2. Constructor-style initialization (direct initialization)
int b(42);

// 3. Uniform initialization (brace initialization) - preferred in modern C++
int c{42};          // narrows: int c{3.14}; would be a compile ERROR
int d{};            // zero-initialized: d == 0

// 4. Copy initialization
std::string s = "hello";

// 5. auto with deduction (like Go's :=)
auto x = 42;       // deduced as int
auto y = 3.14;     // deduced as double
auto z = "hello";  // deduced as const char* (NOT std::string!)
auto w = std::string("hello"); // deduced as std::string
```

The brace initialization (`{}`) is the recommended modern style because it prevents narrowing conversions:

```cpp
int x = 3.14;   // compiles silently, x == 3 (truncated!)
int y{3.14};     // COMPILE ERROR: narrowing conversion
```

Go developers will appreciate this: Go also rejects implicit narrowing. The brace initialization brings C++ closer to Go's strict type safety.

### Constants: const, constexpr, and consteval

Go has `const` for compile-time constants. C++ has three levels of "constant-ness," each with different guarantees.

**In Go:**

```go
const Pi = 3.14159265358979323846  // untyped constant, compile-time
const MaxSize int = 1024           // typed constant, compile-time

// Go's iota for enumerations
const (
    Red = iota  // 0
    Green       // 1
    Blue        // 2
)
```

**In C++:**

```cpp
// const: value cannot change after initialization
// But can be initialized at RUNTIME
const int maxRetries = 3;              // compile-time constant
const int lineCount = countLines();    // runtime constant (set once, never changes)

// constexpr: MUST be evaluable at compile time
// This is closer to Go's const
constexpr double Pi = 3.14159265358979323846;
constexpr int MaxSize = 1024;
constexpr int Square(int x) { return x * x; }  // compile-time function!
constexpr int val = Square(5);                   // evaluated at compile time: 25

// consteval (C++20): function MUST be called at compile time
// Even stricter than constexpr
consteval int compileTimeOnly(int x) {
    return x * x;
}
constexpr int a = compileTimeOnly(5); // OK: compile-time context
// int b = compileTimeOnly(runtime_var); // ERROR: not compile-time

// constinit (C++20): variable initialized at compile time, but mutable later
constinit int global_counter = 0;     // initialized at compile time
// global_counter = 42; // OK: can change later
```

**Key difference from Go:** Go's `const` must always be a compile-time constant. C++'s `const` can hold runtime values that simply cannot be reassigned. Use `constexpr` or `consteval` when you want the Go-like guarantee that a value is known at compile time.

### The auto Keyword (Type Deduction)

C++'s `auto` keyword is the closest equivalent to Go's `:=` short variable declaration.

```cpp
auto i = 42;                // int
auto d = 3.14;              // double
auto s = std::string("hi"); // std::string
auto v = std::vector<int>{1, 2, 3}; // std::vector<int>

// auto with references and const
const auto& ref = s;        // const std::string&
auto* ptr = &i;             // int*

// auto in function return types (C++14)
auto add(int a, int b) {
    return a + b;            // return type deduced as int
}

// auto in range-based for loops (very common)
std::vector<int> nums = {1, 2, 3, 4, 5};
for (auto n : nums) {           // copies each element
    std::cout << n << " ";
}
for (const auto& n : nums) {    // reads by reference (no copy)
    std::cout << n << " ";
}
for (auto& n : nums) {          // mutable reference
    n *= 2;
}
```

**In Go** there is no equivalent to `const auto&`. Go manages this automatically: slices, maps, and channels are already reference types. Value types are copied unless you use pointers. C++ makes you spell out the choice explicitly, which gives you more control but demands more thought.

---

### Junior → FAANG: Type Discipline as a Safety Habit

The most common type-related bugs for Go engineers learning C++ are: signed/unsigned comparison (mixing `int` and `size_t` silently), narrowing conversions (assigning a 64-bit value to a 32-bit variable without a warning when `-Wall` is not enabled), and misusing `auto` to obscure a type that matters for ownership.

Concrete habit: always compile with `-Wall -Wextra -Wshadow` (or the Clang equivalent). These flags surface the implicit conversions and shadowing bugs that UBSan only catches at runtime. Treat every warning as an error in new code (`-Werror` in CI).

Interview note: when asked about `const` correctness, explain it as a contract that the compiler enforces: a `const` reference promises the referenced object will not be modified through this binding, enabling both safety and optimization (the compiler may cache the value in a register). The parallel in Go is a value receiver on a method, which copies the value rather than modifying it.

### Senior @ FAANG: Type System Policy and Approved Type Usage

At the staff level, type choices in a shared codebase are policy decisions, not personal preferences.

**Integer type policy.** A mature C++ style guide specifies exactly which integer types are used for which purposes: `int32_t`/`int64_t` for domain values with known range, `size_t` for sizes and indices into containers, `ptrdiff_t` for pointer differences, and never `int` for anything that can reach 2^31. Google's C++ style guide mandates this. The reason is portability and correctness: `int` is 32 bits on all modern 64-bit platforms but this is implementation-defined, and code that assumes otherwise has produced real bugs.

**`auto` policy.** Some teams ban `auto` for non-iterator uses. Others allow it everywhere. The right policy depends on your team's context: in a codebase with many template-heavy types (Abseil, Folly), `auto` improves readability. In a codebase with many implicit conversions, `auto` can hide a narrowing conversion that becomes a bug. A staff engineer writes the policy with examples of approved and prohibited uses, not just a blanket allow or ban.

**`constexpr` as correctness and performance tool.** At the staff level, `constexpr` is not just an optimization hint. It is a correctness guarantee. A `constexpr` function that takes only compile-time inputs is guaranteed to be evaluated at compile time, moving potential runtime errors to compile time. In a codebase that uses `constexpr` lookup tables (for protocol parsing, for example), a staff engineer ensures these tables are validated in static_asserts rather than tested only at runtime.

