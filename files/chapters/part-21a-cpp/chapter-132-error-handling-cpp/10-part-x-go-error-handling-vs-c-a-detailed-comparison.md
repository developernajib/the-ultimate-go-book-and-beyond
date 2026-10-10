## Part X: Go Error Handling vs. C++ - A Detailed Comparison

Go and C++ take fundamentally different approaches to error handling. Both have strengths. Both have weaknesses. Understanding the comparison deeply is valuable for engineers who work across both languages.

### Go's Approach: Explicit Error Values

Go makes failure a return value. Every fallible function returns an `error` alongside its result, the call site must acknowledge it, and there is no invisible unwinding. Keep that model in mind as the baseline for everything C++ does differently below.
```go
// Go: error is a return value, checked explicitly
func readConfig(path string) (Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return Config{}, fmt.Errorf("reading config: %w", err)
    }

    var config Config
    if err := json.Unmarshal(data, &config); err != nil {
        return Config{}, fmt.Errorf("parsing config: %w", err)
    }

    if err := config.Validate(); err != nil {
        return Config{}, fmt.Errorf("validating config: %w", err)
    }

    return config, nil
}
```

### C++ Equivalent Approaches

C++ offers three distinct strategies for the same operation. Exception-based code has the cleanest happy path because errors unwind automatically, but imposes hidden control-flow paths and cost. `std::expected` mirrors Go's explicit `(T, error)` style with compile-time enforcement of error handling. Error codes are the lowest-overhead option but the most verbose and easiest to accidentally ignore.
```cpp
// C++ with exceptions: cleanest happy path
Config read_config(const std::string& path) {
    auto data = read_file(path);        // throws on failure
    auto config = parse_json(data);     // throws on failure
    config.validate();                   // throws on failure
    return config;
}

// C++ with std::expected: explicit like Go, but type-safe
std::expected<Config, AppError> read_config(const std::string& path) {
    auto data = read_file(path);
    if (!data) return std::unexpected(data.error());

    auto config = parse_json(*data);
    if (!config) return std::unexpected(config.error());

    auto valid = config->validate();
    if (!valid) return std::unexpected(valid.error());

    return *config;
}

// C++ with monadic chaining
std::expected<Config, AppError> read_config(const std::string& path) {
    return read_file(path)
        .and_then(parse_json)
        .and_then([](Config c) -> std::expected<Config, AppError> {
            return c.validate().transform([&]() { return std::move(c); });
        });
}
```

### Detailed Feature Comparison

| Feature | Go | C++ (Exceptions) | C++ (std::expected) |
|---|---|---|---|
| Error propagation | Manual (`if err != nil`) | Automatic (stack unwinding) | Manual (check and forward) |
| Can be ignored | Yes (lint tools warn) | No (terminates if uncaught) | Partially (UB on bad access) |
| Constructor errors | N/A (no constructors) | Yes (throw in constructor) | Factory functions needed |
| Performance (happy) | Branch cost per check | Zero overhead | Branch cost per check |
| Performance (error) | Same as happy path | High (stack unwinding) | Same as happy path |
| Error context | `fmt.Errorf("%w", err)` | `throw_with_nested` | Manual wrapping |
| Error types | `error` interface | Any type (usually `exception`) | Template parameter `E` |
| Panic/recover | Yes (rare, for bugs) | `terminate`/signal handlers | N/A |
| Defer cleanup | `defer` keyword | RAII / destructors | RAII / destructors |
| Error wrapping | `errors.Is`, `errors.As` | `dynamic_cast`, nested | Custom matching |
| Standard pattern | `(T, error)` | `throw`/`catch` | `std::expected<T, E>` |

### The Verbosity Question

Go developers often defend the `if err != nil` pattern as promoting visibility of error paths. C++ developers counter that it buries the happy path in boilerplate. Both are right.

```go
// Go: 15 lines, 5 of which are error handling
func processOrder(ctx context.Context, orderID string) error {
    order, err := fetchOrder(ctx, orderID)
    if err != nil {
        return fmt.Errorf("fetching order: %w", err)
    }
    inventory, err := checkInventory(ctx, order.Items)
    if err != nil {
        return fmt.Errorf("checking inventory: %w", err)
    }
    receipt, err := chargePayment(ctx, order.Payment)
    if err != nil {
        return fmt.Errorf("charging payment: %w", err)
    }
    err = shipOrder(ctx, order, inventory, receipt)
    if err != nil {
        return fmt.Errorf("shipping order: %w", err)
    }
    return nil
}
```

```cpp
// C++ with exceptions: 6 lines, 0 explicit error handling
// Errors propagate automatically via stack unwinding
void process_order(const Context& ctx, const std::string& order_id) {
    auto order = fetch_order(ctx, order_id);
    auto inventory = check_inventory(ctx, order.items);
    auto receipt = charge_payment(ctx, order.payment);
    ship_order(ctx, order, inventory, receipt);
}

// C++ with std::expected + macros: 7 lines, similar to Go
// (Using Google's ASSIGN_OR_RETURN macro pattern)
std::expected<void, AppError>
process_order(const Context& ctx, const std::string& order_id) {
    ASSIGN_OR_RETURN(auto order, fetch_order(ctx, order_id));
    ASSIGN_OR_RETURN(auto inventory, check_inventory(ctx, order.items));
    ASSIGN_OR_RETURN(auto receipt, charge_payment(ctx, order.payment));
    RETURN_IF_ERROR(ship_order(ctx, order, inventory, receipt));
    return {};
}
```

### Error Wrapping and Context

Go's `fmt.Errorf` with `%w` creates an error chain that `errors.Is` and `errors.As` can traverse. C++ has equivalent mechanisms, but they are more verbose:

```cpp
// C++ error wrapping with nested exceptions
void high_level_operation() {
    try {
        mid_level_operation();
    }
    catch (...) {
        std::throw_with_nested(
            std::runtime_error("high-level operation failed")
        );
    }
}

// C++ error wrapping with std::expected (manual)
struct ContextualError {
    AppError code;
    std::string message;
    std::optional<std::string> context;

    // Chain context like Go's fmt.Errorf
    ContextualError with_context(std::string ctx) const {
        return {code, message, std::move(ctx)};
    }
};

std::expected<Order, ContextualError>
fetch_order(const std::string& id) {
    auto result = db_query("SELECT * FROM orders WHERE id = ?", id);
    if (!result) {
        return std::unexpected(
            ContextualError{AppError::DatabaseError, result.error()}
                .with_context("fetching order " + id)
        );
    }
    return parse_order(*result);
}
```

### Resource Cleanup: `defer` vs. RAII

Go's `defer` and C++'s RAII are philosophically different:

```go
// Go: explicit defer for cleanup
func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    lock.Lock()
    defer lock.Unlock()

    // ... use f and lock
    return nil
}
```

```cpp
// C++: RAII handles cleanup automatically
void process_file(const std::string& path) {
    std::ifstream f(path);           // closes automatically when destroyed
    std::lock_guard lock(mutex_);    // unlocks automatically when destroyed

    // ... use f and lock
    // No explicit cleanup needed - destructors handle it
}
```

C++'s RAII is more powerful because cleanup is guaranteed by the type system. In Go, forgetting `defer f.Close()` is a bug that compiles cleanly. In C++, `std::ifstream` cannot leak because its destructor always runs.

However, Go's `defer` is more flexible for ad-hoc cleanup (especially with closures), while RAII requires creating a scope guard object or using a purpose-built RAII wrapper.

### The Philosophical Divide

Go's philosophy: *Errors are values. Handle them explicitly. Make the error path visible.*

C++'s philosophy (exceptions): *Separate the happy path from error handling. Let RAII handle cleanup. Propagate errors automatically.*

C++'s philosophy (`std::expected`): *Errors are values (like Go), but with stronger type safety and monadic composition.*

The industry is converging. Go considered and rejected exceptions. C++23 added `std::expected`, which works much like Go's error returns. Rust's `Result<T, E>` influenced both. The future likely involves value-based error handling with monadic composition, regardless of language.

---
