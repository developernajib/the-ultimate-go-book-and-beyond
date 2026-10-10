## Functions

C++ functions are more feature-rich than Go functions. Go keeps functions simple by design. C++ provides overloading, default arguments, trailing return types, and inline hints.

### Basic Function Syntax

**In Go:**

```go
func add(a, b int) int {
    return a + b
}

// Multiple return values
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, errors.New("division by zero")
    }
    return a / b, nil
}
```

**In C++:**

```cpp
// Basic function
int add(int a, int b) {
    return a + b;
}

// C++ does not have multiple return values natively,
// but you can use std::pair, std::tuple, or structured bindings

#include <tuple>
#include <optional>
#include <string>

// Option 1: std::pair
std::pair<double, std::string> divide(double a, double b) {
    if (b == 0.0) {
        return {0.0, "division by zero"};
    }
    return {a / b, ""};
}

// Option 2: std::optional (C++17, more idiomatic for single value + error)
std::optional<double> divide_v2(double a, double b) {
    if (b == 0.0) return std::nullopt;
    return a / b;
}

// Option 3: structured bindings (C++17) for receiving
auto [result, err] = divide(10.0, 3.0);  // like Go's multiple returns!
if (!err.empty()) {
    std::cerr << err << "\n";
}

// Using optional
if (auto val = divide_v2(10.0, 3.0); val.has_value()) {
    std::cout << *val << "\n"; // dereference optional
}
```

### Function Overloading (No Go Equivalent)

C++ allows multiple functions with the same name but different parameter types or counts. Go does not support this at all.

```cpp
#include <string>
#include <iostream>

// Three functions, same name, different parameters
int add(int a, int b) {
    return a + b;
}

double add(double a, double b) {
    return a + b;
}

std::string add(const std::string& a, const std::string& b) {
    return a + b;
}

int main() {
    std::cout << add(1, 2) << "\n";           // calls int version: 3
    std::cout << add(1.5, 2.5) << "\n";       // calls double version: 4.0
    std::cout << add("hello, ", "world") << "\n"; // calls string version
    return 0;
}
```

**In Go, you would need:**

```go
func AddInts(a, b int) int { return a + b }
func AddFloats(a, b float64) float64 { return a + b }
func AddStrings(a, b string) string { return a + b }

// Or with Go 1.18+ generics:
func Add[T int | float64 | string](a, b T) T {
    return a + b
}
```

The compiler resolves overloaded function calls at compile time based on argument types. This is called **static dispatch** (or overload resolution). The rules for overload resolution in C++ are complex and sometimes surprising, which is why some style guides recommend being conservative with overloading.

### Default Arguments (No Go Equivalent)

C++ functions can have default values for parameters. Go does not support this. The typical Go pattern is variadic arguments or option structs.

```cpp
// C++: default arguments
void connect(const std::string& host,
             int port = 8080,              // default: 8080
             int timeout_ms = 5000,        // default: 5000
             bool use_tls = true) {        // default: true
    // implementation
}

// All of these are valid calls:
connect("example.com");                    // port=8080, timeout=5000, tls=true
connect("example.com", 443);              // timeout=5000, tls=true
connect("example.com", 443, 10000);       // tls=true
connect("example.com", 443, 10000, false);

// RULE: defaults must go right-to-left (trailing parameters)
// void bad(int a = 1, int b); // COMPILE ERROR
```

**In Go, the equivalent pattern:**

```go
type ConnectOptions struct {
    Host      string
    Port      int  // zero value: caller must set or we default
    TimeoutMs int
    UseTLS    bool
}

func Connect(opts ConnectOptions) {
    if opts.Port == 0 {
        opts.Port = 8080
    }
    if opts.TimeoutMs == 0 {
        opts.TimeoutMs = 5000
    }
    // ...
}
```

### Trailing Return Types (C++11)

C++ allows specifying the return type after the parameter list, which is useful when the return type depends on the parameters.

```cpp
// Traditional syntax
int add(int a, int b) {
    return a + b;
}

// Trailing return type syntax (equivalent)
auto add(int a, int b) -> int {
    return a + b;
}

// Where trailing return types shine: dependent types
template<typename T, typename U>
auto multiply(T a, U b) -> decltype(a * b) {
    return a * b;
    // Return type depends on T and U
    // int * double = double, so return type is deduced correctly
}

// C++14: auto return type deduction (no trailing type needed)
auto multiply_v2(auto a, auto b) {  // C++20 abbreviated template
    return a * b;
}
```

### Inline Functions

The `inline` keyword is a hint to the compiler to substitute the function body at the call site, avoiding function call overhead.

```cpp
// inline function: suggests the compiler inline this
inline int square(int x) {
    return x * x;
}

// In practice, modern compilers ignore the inline hint and make
// their own inlining decisions based on optimization analysis.

// The REAL use of inline in modern C++: allowing multiple definitions
// across translation units (important for header-only code).
// We'll see this in the Header Files section.

// constexpr functions are implicitly inline
constexpr int cube(int x) {
    return x * x * x;
}
```

**In Go,** inlining is entirely automatic. The Go compiler inlines small functions without any annotation. You can check which functions were inlined with `go build -gcflags='-m'`. C++ gives you the `inline` keyword, but modern C++ compilers also inline automatically based on their own heuristics.

### Lambda Expressions (C++11)

Lambdas are anonymous functions, similar to Go's function literals (closures).

**In Go:**

```go
add := func(a, b int) int {
    return a + b
}
fmt.Println(add(3, 4)) // 7

// Closure capturing outer variable
counter := 0
increment := func() int {
    counter++
    return counter
}
```

**In C++:**

```cpp
// Lambda syntax: [capture](params) -> return_type { body }
auto add = [](int a, int b) -> int {
    return a + b;
};
std::cout << add(3, 4) << "\n"; // 7

// Capture by reference (like Go's implicit capture)
int counter = 0;
auto increment = [&counter]() -> int {
    counter++;
    return counter;
};

// Capture modes:
// []        - capture nothing
// [=]       - capture all by value (copy)
// [&]       - capture all by reference
// [x]       - capture x by value
// [&x]      - capture x by reference
// [=, &x]   - capture all by value, except x by reference
// [this]    - capture the enclosing object's this pointer

// C++14: generic lambdas (auto parameters)
auto generic_add = [](auto a, auto b) {
    return a + b;
};
std::cout << generic_add(1, 2) << "\n";       // int: 3
std::cout << generic_add(1.5, 2.5) << "\n";   // double: 4.0
```

**Key difference:** Go closures capture variables by reference implicitly. C++ lambdas require you to explicitly specify how each variable is captured. This explicitness prevents a whole class of bugs related to dangling references.

---

### Junior → FAANG: Function Overloading and Lambda Capture Discipline

Function overloading is a C++ feature Go deliberately omitted. For a Go engineer, overloading feels magical at first, then dangerous: when you call `process(x)`, which overload is selected? The answer involves overload resolution rules (best match by conversion, no ambiguity allowed), and getting it wrong produces either a surprising overload selection or a compile error.

Rule for new C++ engineers: avoid creating more than two overloads with the same name until you understand overload resolution. When in doubt, give functions distinct names. This matches Go's philosophy and avoids subtle dispatch bugs.

For lambdas: default capture by reference (`[&]`) is convenient but dangerous when the lambda outlives the scope it captures from (storing a lambda in a container, passing it to an async callback). Default capture by value (`[=]`) is safer for async use but copies everything. The safe practice: name each captured variable explicitly. `[this, count = current_count]` is always clearer than `[&]` or `[=]`.

### Senior @ FAANG: Function API Design, ABI Stability, and Lambda Anti-Patterns in Production

At the staff level, function signatures are API contracts with ABI implications. Changing a function signature breaks binary compatibility, which in a shared library context means all callers must be recompiled.

**ABI-safe function design.** When designing a function that will be part of a shared library's public API, avoid: default parameters (adding or changing a default breaks ABI), function templates in the public API (template instantiation is not ABI-stable across compiler versions), and `std::string` or `std::vector` parameters in C ABI boundaries (library ABI for these types is not stable across ABIs). The safe pattern is a C-compatible extern "C" boundary with opaque handles, with the C++ API built on top of it internally.

**Lambda lifetime in async systems.** At the staff level, the most serious lambda bug in production C++ async systems is a lambda that captures `this` by reference (or implicit `[&]` that captures `this`) and is executed after the object is destroyed. In a callback-based async system (Folly Futures, Boost.Asio), this is a common crash pattern. The fix is: capture `shared_ptr<this>` (enabling `enable_shared_from_this`), or use a `WeakPtr` that safely expires. A staff engineer adds a clang-tidy check or code review policy that flags all `[&]` captures in lambdas passed to async APIs.

**`std::function` performance at hot paths.** `std::function` uses type erasure with a possible heap allocation for large callables. In a hot path that calls a stored callback millions of times per second, `std::function` overhead is measurable. Alternatives: `absl::AnyInvocable` (move-only, slightly cheaper), a template parameter for the callable type (zero overhead but forces inlining), or a virtual dispatch interface (explicit but readable). A staff engineer documents in the performance guide which callback mechanism is appropriate at each level of the latency budget.

