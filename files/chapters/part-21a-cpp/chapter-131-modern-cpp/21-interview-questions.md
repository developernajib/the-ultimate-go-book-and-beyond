## Interview Questions

### Conceptual Questions

**Q1: What is the difference between `std::optional`, `std::variant`, and `std::any`? When would you use each?**

`std::optional<T>` holds either a `T` or nothing. Use it for values that may not exist (nullable semantics). `std::variant<Ts...>` holds exactly one of a closed set of types. Use it for sum types where you know all possibilities at compile time. `std::any` holds a value of any copyable type. Use it only when the type set is truly open (plugin systems, property maps). Prefer `optional` and `variant` because they are type-safe and do not require heap allocation for large types (unlike `any`).

**Q2: Explain the difference between `constexpr`, `consteval`, and `constinit`.**

`constexpr` means "can be evaluated at compile time" but also allows runtime evaluation. `consteval` means "must be evaluated at compile time" and produces a compiler error if called with runtime arguments. `constinit` means "must be initialized at compile time" but the variable itself can be modified at runtime. It solves the static initialization order fiasco. A `constexpr` variable is implicitly `const`. A `constinit` variable is not.

**Q3: Why are C++20 modules not widely adopted despite being standardized?**

Build system support is the primary blocker. Modules require dependency scanning (the build system must parse module declarations to determine compilation order), which traditional build systems were not designed for. CMake has experimental support, Bazel has limited support, and many custom build systems have none. Additionally, migrating millions of lines of header-based code is a multi-year effort with limited immediate benefit. The compile-time benefits are real but do not justify the migration cost for most teams today.

**Q4: What problem does `std::expected<T, E>` solve that exceptions and error codes do not?**

`std::expected` is a sum type that forces callers to handle the error path: you cannot access the value without checking if it exists. Exceptions are invisible in function signatures and can be silently ignored. Error codes (int returns) are easily ignored, lose type information, and cannot carry rich error data alongside the success value. `std::expected` also supports monadic operations (`transform`, `and_then`, `or_else`) that enable functional-style error chaining without nesting. It is particularly valuable in codebases that disable exceptions (Google, many game engines) because it provides structured error handling without exception overhead.

**Q5: How do concepts improve upon SFINAE?**

SFINAE (Substitution Failure Is Not An Error) produces incomprehensible error messages, is hard to compose, and requires advanced template metaprogramming knowledge to write. Concepts are declarative constraints that read like documentation. Error messages reference the concept name and which requirements failed. Concepts compose with `&&` and `||`. They can be used in function signatures directly (abbreviated function templates with `auto`), as template parameter constraints, and as `requires` clauses. The code becomes self-documenting: `void sort(std::ranges::random_access_range auto& r)` tells you exactly what the parameter requires.

### Coding Questions

**Q6: Write a function that accepts any container and returns the sum of its elements using concepts.**

```cpp
template<typename C>
concept NumericContainer = requires(C c) {
    typename C::value_type;
    requires std::is_arithmetic_v<typename C::value_type>;
    { c.begin() } -> std::input_or_output_iterator;
    { c.end() }   -> std::input_or_output_iterator;
};

template<NumericContainer C>
auto sum(const C& container) {
    using T = typename C::value_type;
    return std::accumulate(container.begin(), container.end(), T{});
}
```

**Q7: Implement a simple `Result<T, E>` type with monadic operations (for codebases that do not have C++23).**

```cpp
template<typename T, typename E>
class Result {
    std::variant<T, E> data_;
public:
    static Result ok(T value) { return Result{std::move(value)}; }
    static Result err(E error) { return Result{std::move(error)}; }

    bool is_ok() const { return data_.index() == 0; }
    bool is_err() const { return data_.index() == 1; }

    const T& value() const { return std::get<0>(data_); }
    const E& error() const { return std::get<1>(data_); }

    template<typename F>
    auto transform(F&& f) const -> Result<decltype(f(value())), E> {
        if (is_ok()) return Result<decltype(f(value())), E>::ok(f(value()));
        return Result<decltype(f(value())), E>::err(error());
    }

    template<typename F>
    auto and_then(F&& f) const -> decltype(f(value())) {
        if (is_ok()) return f(value());
        return decltype(f(value()))::err(error());
    }

private:
    explicit Result(T value) : data_(std::move(value)) {}
    explicit Result(E error) : data_(std::in_place_index<1>, std::move(error)) {}
};
```

**Q8: Using ranges, write a one-liner that takes a vector of strings, filters to those starting with 'A', transforms to uppercase, and collects into a new vector.**

```cpp
auto result = strings
    | std::views::filter([](const auto& s) { return !s.empty() && s[0] == 'A'; })
    | std::views::transform([](std::string s) {
        std::ranges::transform(s, s.begin(), ::toupper);
        return s;
    })
    | std::ranges::to<std::vector>();  // C++23 ranges::to
```

**Q9: What is the output of the following code using structured bindings and `if constexpr`?**

```cpp
template<typename T>
auto describe(T val) {
    if constexpr (std::is_integral_v<T>) {
        return std::pair{val, "integer"};
    } else if constexpr (std::is_floating_point_v<T>) {
        return std::pair{val, "float"};
    } else {
        return std::pair{0, "other"};
    }
}

auto [v1, t1] = describe(42);
auto [v2, t2] = describe(3.14);
auto [v3, t3] = describe("hello");
// v1=42, t1="integer"
// v2=3.14, t2="float"
// v3=0, t3="other"
```

**Q10: Design a compile-time validated settings system where invalid configuration combinations cause compilation errors. Use concepts and `consteval`.**

```cpp
struct Settings {
    int port;
    int max_connections;
    int thread_pool_size;
};

consteval Settings make_settings(int port, int max_conn, int threads) {
    if (port < 1 || port > 65535)
        throw "port out of range";  // compile error with message
    if (max_conn < 1)
        throw "max_connections must be positive";
    if (threads < 1 || threads > max_conn)
        throw "thread_pool_size must be between 1 and max_connections";
    return {port, max_conn, threads};
}

// Valid: compiles
constexpr auto prod_settings = make_settings(8080, 1000, 16);

// Invalid: compile error "port out of range"
// constexpr auto bad_settings = make_settings(0, 1000, 16);
```

**Q11: Explain the difference between `std::span` and `std::string_view`. When would you choose one over the other?**

Both are non-owning views into contiguous data. `std::string_view` is specifically for character sequences and provides string-specific operations (`find`, `substr`, `starts_with`, comparison operators). `std::span<T>` is generic and works with any element type. Use `string_view` for text processing and `span` for generic array/buffer passing. Both have the same dangling reference risk: they do not extend the lifetime of the data they view.

**Q12: How does `std::jthread` differ from `std::thread`, and why was it added?**

`std::jthread` (joining thread) automatically joins in its destructor, preventing the program from calling `std::terminate` when a `std::thread` goes out of scope without being joined or detached. It also supports cooperative cancellation via `std::stop_token`. A `jthread` can be given a stop token as its first parameter, and the creator can call `request_stop()` to signal the thread to terminate gracefully. `std::thread` has none of this, which made it a source of bugs (forgotten joins, no clean shutdown mechanism). In new code, always prefer `jthread` over `thread`.

**Q13: What is "deducing this" in C++23, and what problem does it solve?**

Deducing `this` allows member functions to deduce the type and value category of the object they are called on, by making `this` an explicit template parameter: `auto&& content(this auto&& self)`. This solves three problems: (1) eliminates the need to duplicate `const` and non-`const` overloads, (2) replaces the CRTP pattern for static polymorphism, and (3) enables recursive lambdas without `std::function` overhead. Before C++23, duplicating overloads for `const`/non-`const`/rvalue qualified versions of the same function was a common source of boilerplate.

---
