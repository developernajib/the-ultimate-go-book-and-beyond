## Interview Questions

### Conceptual Questions

**Q1:** What is the difference between the basic, strong, and nothrow exception safety guarantees? Give a real-world example of each.

**A1:** The basic guarantee ensures no resource leaks and objects remain in a valid (but possibly modified) state. Example: `std::vector::insert` - if it throws during element construction, the vector is valid but may have been resized. The strong guarantee ensures rollback to the original state on failure. Example: `std::vector::push_back` provides the strong guarantee - if the new element's copy/move throws, the vector is unchanged. The nothrow guarantee means the operation never throws. Example: `std::vector::swap` is noexcept. Destructors must provide the nothrow guarantee because throwing during stack unwinding calls `std::terminate`.

**Q2:** Why should move constructors be marked `noexcept`? What happens if they are not?

**A2:** Standard containers like `std::vector` check `std::is_nothrow_move_constructible` at compile time. When reallocating (e.g., during `push_back`), if the move constructor is `noexcept`, the vector moves elements to the new buffer. If the move constructor might throw, the vector falls back to copying elements to preserve the strong exception guarantee. This can cause orders-of-magnitude performance degradation for types that are expensive to copy.

**Q3:** Compare Go's `if err != nil` pattern with C++ exceptions and `std::expected`. What are the tradeoffs in readability, safety, and performance?

**A3:** Go's pattern makes error handling visible but verbose (approximately 30-40% of Go code is error checking). Errors can be silently ignored. C++ exceptions give the cleanest happy path with zero runtime overhead on success, but error paths are invisible in source code and expensive at runtime. `std::expected` combines Go-like explicitness with C++ type safety - the value cannot be accessed without checking for errors (unlike Go, where you can use the zero value). Performance-wise, `std::expected` and Go error returns have constant overhead per call, while C++ exceptions have zero happy-path overhead but O(N) error-path cost proportional to stack depth.

**Q4:** How does `std::uncaught_exceptions()` (plural) differ from the deprecated `std::uncaught_exception()` (singular), and why does this matter for scope guards?

**A4:** `std::uncaught_exception()` returned a boolean - "is any exception in flight?" This broke in nested scenarios: if a destructor running during unwinding created a scope guard, the guard would see `true` even though its scope wasn't the one being unwound. `std::uncaught_exceptions()` returns a count. A scope guard records the count at construction and compares at destruction. If the count increased, the guard's scope is being unwound due to an exception. This enables correct `ScopeFail` and `ScopeSuccess` implementations even in nested exception scenarios.

**Q5:** You are designing a high-frequency trading system processing 100,000 orders per second. Each order can fail validation (approximately 5% of orders). How would you handle errors?

**A5:** At 5% failure rate and 100K orders/second, that is 5,000 failures per second. Exceptions would be catastrophically expensive - each throw/catch cycle could take 1-10 microseconds, consuming 5-50 milliseconds of a single core per second just on exception handling. Use error codes or `std::expected` for validation failures. Reserve exceptions only for truly exceptional situations like memory exhaustion or system failures. For the hot path, use a pre-validated order type so that validation errors are caught at the boundary (parse, don't validate). The inner loop should operate on types that are correct by construction.

### Coding Questions

**Q6:** Write a function `safe_stoi` that converts a string to int using `std::expected` instead of throwing. Handle empty strings, non-numeric input, and out-of-range values with distinct error types.

```cpp
enum class ParseError { Empty, InvalidFormat, OutOfRange };

std::expected<int, ParseError> safe_stoi(const std::string& s) {
    if (s.empty()) return std::unexpected(ParseError::Empty);

    int value = 0;
    auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), value);

    if (ec == std::errc::invalid_argument)
        return std::unexpected(ParseError::InvalidFormat);
    if (ec == std::errc::result_out_of_range)
        return std::unexpected(ParseError::OutOfRange);
    if (ptr != s.data() + s.size())
        return std::unexpected(ParseError::InvalidFormat);

    return value;
}
```

**Q7:** Implement an exception-safe `swap` for a class that manages two dynamically allocated arrays. The swap must provide the nothrow guarantee.

```cpp
class DualBuffer {
public:
    DualBuffer(size_t n, size_t m)
        : a_(new int[n]), b_(new int[m]), n_(n), m_(m) {}

    ~DualBuffer() noexcept {
        delete[] a_;
        delete[] b_;
    }

    // Nothrow swap: only pointer and integer swaps
    friend void swap(DualBuffer& lhs, DualBuffer& rhs) noexcept {
        std::swap(lhs.a_, rhs.a_);
        std::swap(lhs.b_, rhs.b_);
        std::swap(lhs.n_, rhs.n_);
        std::swap(lhs.m_, rhs.m_);
    }

    // Copy-and-swap assignment: strong guarantee
    DualBuffer& operator=(DualBuffer other) noexcept {
        swap(*this, other);
        return *this;
    }

private:
    int* a_;
    int* b_;
    size_t n_;
    size_t m_;
};
```

**Q8:** Design a `Result<T>` type that works in C++17 (no `std::expected`). Support `map`, `flat_map`, and `or_else` operations. This is a common interview question at companies that maintain their own result types.

```cpp
template <typename T, typename E = std::string>
class Result {
public:
    // Construction
    static Result ok(T value) { return Result(std::move(value)); }
    static Result err(E error) { return Result(std::move(error), ErrorTag{}); }

    bool is_ok() const noexcept { return std::holds_alternative<T>(data_); }
    bool is_err() const noexcept { return !is_ok(); }

    const T& value() const& { return std::get<T>(data_); }
    T&& value() && { return std::get<T>(std::move(data_)); }
    const E& error() const& { return std::get<E>(data_); }

    // Monadic: map (transform the success value)
    template <typename F>
    auto map(F&& f) const -> Result<std::invoke_result_t<F, const T&>, E> {
        if (is_ok()) return Result<std::invoke_result_t<F, const T&>, E>::ok(f(value()));
        return Result<std::invoke_result_t<F, const T&>, E>::err(error());
    }

    // Monadic: flat_map / and_then
    template <typename F>
    auto flat_map(F&& f) const -> std::invoke_result_t<F, const T&> {
        if (is_ok()) return f(value());
        using R = std::invoke_result_t<F, const T&>;
        return R::err(error());
    }

    // Monadic: or_else (handle the error)
    template <typename F>
    auto or_else(F&& f) const -> Result {
        if (is_ok()) return *this;
        return f(error());
    }

private:
    struct ErrorTag {};
    explicit Result(T value) : data_(std::move(value)) {}
    explicit Result(E error, ErrorTag) : data_(std::move(error)) {}
    std::variant<T, E> data_;
};
```

---

### Junior → FAANG: Error Handling Questions as Design Discussion Openers

Every error handling interview question has a follow-up: "and how would you enforce that convention across a large codebase?" For exceptions: clang-tidy checks for uncaught exception specifications, review guidelines for `catch(...)` blocks. For `absl::Status`: `[[nodiscard]]` enforcement, `RETURN_IF_ERROR` macros, ban on silently discarding status. For `noexcept`: static assertions on move operations.

Practice answering not just the primary question, but the enforcement follow-up. This demonstrates you think about institutional code quality, not just individual code correctness.

### Senior @ FAANG: Bar-Raiser Error Handling Questions

At the L6 bar-raiser level, error handling questions probe the candidate's ability to design a consistent error handling strategy for a system, not just use the tools. The expected depth: "design the error handling strategy for a service that has a C++ core with exceptions disabled, wraps two third-party libraries that use exceptions, and exposes a gRPC API." This requires knowledge of exception boundary patterns (catch-all at the boundary, translate to status), gRPC error mapping, and internal consistency despite heterogeneous dependencies.

A candidate who designs this correctly, with specific error types, translation layers, and monitoring hooks, is demonstrating L6 judgment. A candidate who designs one part well and ignores the others is demonstrating L5.

