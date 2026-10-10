## Modern C++ (C++17/20/23) vs Legacy C++

If your last exposure to C++ was a university course that taught `new`/`delete`, raw pointers, and `printf`, modern C++ will surprise you. The language has evolved dramatically. C++11 was a watershed moment, and each subsequent standard (C++14, C++17, C++20, C++23) has added features that make the language safer, more expressive, and more productive.

### The Old Way vs The Modern Way

**Memory Management:**

```cpp
// Legacy C++ (pre-C++11): manual memory management
Widget* w = new Widget();
// ... 200 lines of code ...
delete w;  // Easy to forget. Easy to double-delete. Easy to use after delete.

// Modern C++ (C++14+): smart pointers
auto w = std::make_unique<Widget>();
// Automatically deleted when w goes out of scope
// Cannot be copied (unique ownership, like Go's lack of pointer aliasing by convention)
// No memory leaks, no double-free, no use-after-free
```

**Go comparison:** Go's garbage collector handles this automatically but at a runtime cost. C++ smart pointers achieve the same safety with zero runtime overhead (unique_ptr is literally free. The compiler generates the same code as manual `new`/`delete` but guarantees correctness).

**String Handling:**

```cpp
// Legacy: C-style strings
char buffer[256];
strcpy(buffer, "hello");  // Buffer overflow if source > 255 chars
strcat(buffer, " world"); // Same problem

// Modern: std::string and std::string_view
std::string s = "hello";
s += " world";  // Safe, automatic resizing

// C++17: string_view for zero-copy references (like Go's string slicing)
std::string_view sv = s;  // No copy, just a pointer + length
// Similar to Go's: sv := s[0:5]
```

**Iteration:**

```cpp
// Legacy: index-based loops with iterators
for (std::vector<int>::iterator it = vec.begin(); it != vec.end(); ++it) {
    std::cout << *it << "\n";
}

// Modern C++11+: range-based for (similar to Go's range)
for (const auto& val : vec) {
    std::cout << val << "\n";
}

// C++20: ranges with views (lazy evaluation, composable)
#include <ranges>
namespace rv = std::ranges::views;

auto result = vec
    | rv::filter([](int x) { return x > 0; })
    | rv::transform([](int x) { return x * 2; });

for (int val : result) {
    std::cout << val << "\n";
}
```

**Go comparison:** Go's `range` keyword provides similar iteration convenience. Go does not have an equivalent to C++20 ranges with lazy views and composition. You would use explicit loops or a library.

### C++17 Key Features

**Structured Bindings** (like Go's multiple return values):

```cpp
// C++17 structured bindings
std::map<std::string, int> scores = {{"Alice", 95}, {"Bob", 87}};

for (const auto& [name, score] : scores) {
    std::cout << name << ": " << score << "\n";
}

// Similar to Go's:
// for name, score := range scores {
//     fmt.Printf("%s: %d\n", name, score)
// }
```

**std::optional** (like Go's pointer-or-nil pattern, but type-safe):

```cpp
// C++17: std::optional
std::optional<int> FindUser(const std::string& name) {
    if (name == "Alice") return 42;
    return std::nullopt;  // No value
}

auto user = FindUser("Alice");
if (user.has_value()) {
    std::cout << "Found: " << *user << "\n";
}

// Go equivalent:
// func FindUser(name string) (int, bool) {
//     if name == "Alice" { return 42, true }
//     return 0, false
// }
```

**std::variant** (type-safe union, like Go's interface{} but checked at compile time):

```cpp
// C++17: std::variant (tagged union)
using Value = std::variant<int, double, std::string>;

Value v = 42;
v = "hello";  // Now holds a string

// Visit pattern (like Go's type switch, but compile-time checked)
std::visit([](auto&& arg) {
    using T = std::decay_t<decltype(arg)>;
    if constexpr (std::is_same_v<T, int>) {
        std::cout << "int: " << arg << "\n";
    } else if constexpr (std::is_same_v<T, std::string>) {
        std::cout << "string: " << arg << "\n";
    }
}, v);
```

**if constexpr** (compile-time branching):

```cpp
template <typename T>
void process(T value) {
    if constexpr (std::is_integral_v<T>) {
        // This branch is only compiled for integer types
        std::cout << "Integer: " << value << "\n";
    } else if constexpr (std::is_floating_point_v<T>) {
        std::cout << "Float: " << value << "\n";
    } else {
        std::cout << "Other: " << value << "\n";
    }
}
```

Go has no equivalent. Go generics (Go 1.18+) provide type parameterization but not compile-time conditional compilation.

### C++20 Key Features

**Concepts** (constrained generics, similar in spirit to Go's type constraints):

```cpp
// C++20: Concepts constrain template parameters
// Similar to Go's type constraints but more powerful
#include <concepts>

template <typename T>
concept Numeric = std::integral<T> || std::floating_point<T>;

template <Numeric T>
T add(T a, T b) {
    return a + b;
}

// Go equivalent:
// type Numeric interface {
//     ~int | ~int8 | ~int16 | ~int32 | ~int64 |
//     ~float32 | ~float64
// }
// func Add[T Numeric](a, b T) T { return a + b }
```

**Coroutines** (stackless, language-level async):

```cpp
// C++20: Coroutines (generator example)
#include <coroutine>
#include <iostream>

// Generator type (simplified - real implementation requires boilerplate)
Generator<int> fibonacci() {
    int a = 0, b = 1;
    while (true) {
        co_yield a;
        auto temp = a;
        a = b;
        b = temp + b;
    }
}

// Usage:
for (int val : fibonacci() | std::views::take(10)) {
    std::cout << val << " ";
}
// Output: 0 1 1 2 3 5 8 13 21 34
```

Go does not have coroutines in the C++ sense. Goroutines are preemptively scheduled and have their own stack. C++20 coroutines are stackless and cooperatively scheduled (the programmer decides when to suspend), which makes them more efficient but harder to reason about.

**Modules** (replacing the `#include` preprocessor model):

```cpp
// C++20: Modules (the biggest compilation speed improvement in C++ history)

// math_utils.cppm (module interface unit)
export module math_utils;

export int add(int a, int b) {
    return a + b;
}

// main.cpp
import math_utils;  // Compiled once, not copy-pasted like #include

int main() {
    return add(1, 2);
}
```

This is conceptually similar to Go's package system, which has always been module-based. C++ is catching up to what Go had from day one.

**Ranges** (functional-style collection processing):

```cpp
#include <ranges>
#include <vector>
#include <algorithm>

std::vector<int> nums = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};

// Filter, transform, and take - lazily evaluated
auto result = nums
    | std::views::filter([](int n) { return n % 2 == 0; })
    | std::views::transform([](int n) { return n * n; })
    | std::views::take(3);

// result: 4, 16, 36 (computed lazily, no intermediate allocations)
```

### C++23 Key Features

**std::expected** (like Rust's `Result`, like Go's `(value, error)` pattern):

```cpp
// C++23: std::expected (typed error handling)
#include <expected>

std::expected<int, std::string> parse_int(std::string_view s) {
    try {
        return std::stoi(std::string(s));
    } catch (const std::exception& e) {
        return std::unexpected(std::string(e.what()));
    }
}

auto result = parse_int("42");
if (result) {
    std::cout << "Value: " << *result << "\n";
} else {
    std::cout << "Error: " << result.error() << "\n";
}

// Go equivalent:
// func parseInt(s string) (int, error) {
//     n, err := strconv.Atoi(s)
//     if err != nil { return 0, err }
//     return n, nil
// }
```

**std::print** (finally, formatted output without iostream):

```cpp
// C++23: std::print (inspired by Python's print and Rust's println!)
#include <print>

std::print("Hello, {}! You are {} years old.\n", "Alice", 30);
// Compare to Go: fmt.Printf("Hello, %s! You are %d years old.\n", "Alice", 30)
```

**Deducing `this`** (explicit object parameter):

```cpp
// C++23: Deducing this enables CRTP without the boilerplate
struct Base {
    template <typename Self>
    void log(this Self&& self) {
        // 'self' is the actual derived type, not Base
        std::cout << typeid(self).name() << "\n";
    }
};
```

### Evolution Summary

| Feature | Go Equivalent | C++ Version |
|---------|--------------|-------------|
| Smart pointers | GC | C++11 |
| Lambda functions | Function literals | C++11 |
| Range-based for | `range` keyword | C++11 |
| Type inference (`auto`) | `:=` | C++11 |
| Multiple returns | `(val, err)` | C++17 (structured bindings) |
| Optional values | `*T` (pointer) | C++17 (`std::optional`) |
| Sum types | `interface{}` / type switch | C++17 (`std::variant`) |
| Generics with constraints | Go 1.18 generics | C++20 (Concepts) |
| Coroutines | Goroutines | C++20 |
| Module system | Packages (always had) | C++20 |
| Error as values | `(val, error)` | C++23 (`std::expected`) |
| Format strings | `fmt.Printf` | C++23 (`std::print`) |

The trend is clear: C++ is slowly converging toward features that Go and Rust have had for years, but C++ adds them with zero-overhead abstractions and backward compatibility with 40 years of existing code.

---

### Junior → FAANG: Recognizing Which Standard You Are Actually Working In

One of the most common junior pitfalls is reading a modern C++ blog post (C++20 ranges, coroutines, concepts) and then trying to apply it in a codebase compiled at C++14. FAANG companies are not always on the latest standard. Google's internal codebase moved to C++17 as the baseline years after the standard was published, and many teams are still cautious about C++20 features.

Before writing any new C++ at a new team, check the CMakeLists or BUILD file for the `cxx_std_XX` constraint. Then check which compiler version is in use. Clang 14 supports most of C++20. Clang 12 does not. The standard version in use tells you which features are available and which patterns from the table in this section apply.

Interview tip: if asked "how would you implement X in modern C++?", clarify which standard is in scope. Defaulting to C++17 is usually safe. Offering a C++20 alternative shows awareness of the evolution.

### Senior @ FAANG: Standard Version Policy and Toolchain Upgrade Governance

At the staff level, the C++ standard version in use across an organization is a governance decision with build, binary, and security implications.

**Toolchain upgrade ADRs.** Moving a large codebase from C++17 to C++20 is not a flag flip. It requires: auditing all third-party dependencies for C++20 compatibility, testing that ABI-incompatible changes (modules, coroutines ABI) do not break shared library boundaries, updating CI to use a compiler version that fully implements C++20, and training the team on which new features are approved for use (not every C++20 feature is safe at scale, concepts can generate enormous error messages, coroutines add frame allocation overhead). A staff engineer writes the migration plan and gates it on measured build time regression and CI green status.

**Feature allowlisting.** Google's C++ style guide allowlists specific features from each standard and explicitly bans others. The ban list exists for real reasons: `std::regex` is notoriously slow, `std::shared_ptr` reference counting is a performance hazard in hot paths, `std::function` has type-erasure overhead that eliminates inlining. A staff engineer contributes to the internal style guide by proposing allowlist changes with performance evidence and rollback criteria.

**ABI stability across standard versions.** When your C++ service exposes a shared library interface (common for plugin architectures and FFI boundaries), changing the C++ standard can silently break ABI compatibility. The safe pattern is: define a C ABI boundary (extern "C" functions with POD types) and keep the standard-version evolution internal. A bar-raiser will ask how you ensure ABI stability when upgrading the compiler. The answer involves symbol versioning scripts, ABI compliance checkers (libabigail), and a policy for breaking changes.

**L7 concern: standards committee participation.** At principal level, you may represent your organization's interests in the WG21 C++ standards committee. This is not academic. It is how FAANG companies ensure that language features (such as `std::expected`, executors, or hazard pointers) that solve their production problems are standardized in a way that is compatible with their existing codebases. Google, Apple, and Meta all have engineers on WG21. Understanding what proposals are in flight and which ones your org cares about is a signal of principal-engineer depth in C++ platform thinking.

