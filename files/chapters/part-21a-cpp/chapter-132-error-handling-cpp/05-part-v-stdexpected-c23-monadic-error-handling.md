## Part V: `std::expected` (C++23) - Monadic Error Handling

C++23 introduced `std::expected<T, E>`, a type that holds either a value of type `T` (success) or an error of type `E`. It bridges the gap between exceptions and error codes.

```cpp
#include <expected>
#include <string>
#include <iostream>
#include <fstream>
#include <system_error>
#include <charconv>

// Basic usage: parsing an integer
std::expected<int, std::string> parse_int(const std::string& input) {
    int value = 0;
    auto [ptr, ec] = std::from_chars(
        input.data(), input.data() + input.size(), value
    );

    if (ec == std::errc::invalid_argument) {
        return std::unexpected("Not a valid integer: " + input);
    }
    if (ec == std::errc::result_out_of_range) {
        return std::unexpected("Integer out of range: " + input);
    }
    if (ptr != input.data() + input.size()) {
        return std::unexpected("Trailing characters after integer: " + input);
    }
    return value;
}

int main() {
    auto result = parse_int("42");
    if (result) {
        std::cout << "Parsed: " << *result << "\n";
    }

    auto bad = parse_int("abc");
    if (!bad) {
        std::cerr << "Error: " << bad.error() << "\n";
    }

    // value_or for defaults
    int val = parse_int("xyz").value_or(-1);
    std::cout << "With default: " << val << "\n";  // -1
}
```

### Monadic Operations

The real power of `std::expected` comes from its monadic interface, which enables functional-style error handling chains:

```cpp
#include <expected>
#include <string>
#include <iostream>
#include <vector>
#include <sstream>

enum class AppError {
    ParseFailed,
    ValidationFailed,
    DatabaseError,
    NotFound
};

std::string to_string(AppError e) {
    switch (e) {
        case AppError::ParseFailed:     return "Parse failed";
        case AppError::ValidationFailed: return "Validation failed";
        case AppError::DatabaseError:   return "Database error";
        case AppError::NotFound:        return "Not found";
    }
    return "Unknown error";
}

using Result = std::expected<int, AppError>;

Result parse_age(const std::string& input) {
    try {
        int age = std::stoi(input);
        return age;
    }
    catch (...) {
        return std::unexpected(AppError::ParseFailed);
    }
}

Result validate_age(int age) {
    if (age < 0 || age > 150) {
        return std::unexpected(AppError::ValidationFailed);
    }
    return age;
}

Result store_age(int age) {
    // Simulate database operation
    if (age == 13) {  // simulate a DB error for testing
        return std::unexpected(AppError::DatabaseError);
    }
    return age;
}

// Monadic chaining with and_then, transform, or_else
void process_age_input(const std::string& input) {
    auto result = parse_age(input)
        .and_then(validate_age)          // chain if success, short-circuit on error
        .and_then(store_age)             // chain if success
        .transform([](int age) {         // map the success value
            return age * 365;            // convert to approximate days
        })
        .or_else([](AppError e) -> std::expected<int, AppError> {
            // Handle or transform the error
            std::cerr << "Pipeline failed: " << to_string(e) << "\n";
            return std::unexpected(e);   // re-propagate
        });

    if (result) {
        std::cout << "Approximate days alive: " << *result << "\n";
    }
}

int main() {
    process_age_input("25");     // Success: ~9125 days
    process_age_input("abc");    // Error: Parse failed
    process_age_input("-5");     // Error: Validation failed
    process_age_input("13");     // Error: Database error
}
```

### `std::expected<void, E>`

For operations that succeed with no value:

```cpp
std::expected<void, std::string> send_email(const std::string& to,
                                             const std::string& body) {
    if (to.empty()) {
        return std::unexpected("Empty recipient");
    }
    if (body.empty()) {
        return std::unexpected("Empty body");
    }
    // ... send the email
    return {};  // success (void)
}

void example() {
    auto result = send_email("user@example.com", "Hello!");
    if (!result) {
        std::cerr << "Failed to send: " << result.error() << "\n";
    }
}
```

### `std::expected` vs Go's Error Returns

`std::expected` is remarkably similar to Go's `(value, error)` pattern, but with type system enforcement:

```cpp
// C++ with std::expected
std::expected<User, DbError> find_user(int id);

auto user = find_user(42);
if (!user) {
    handle_error(user.error());
    return;
}
use(*user);
```

```go
// Go equivalent
package main

import "fmt"

type User struct {
    Name string
}

func findUser(id int) (User, error) {
    if id == 42 {
        return User{Name: "Alice"}, nil
    }
    return User{}, fmt.Errorf("user %d not found", id)
}

func handleError(err error) {
    fmt.Println("Error:", err)
}

func use(u User) {
    fmt.Println("Using user:", u.Name)
}

func main() {
    user, err := findUser(42)
    if err != nil {
        handleError(err)
        return
    }
    use(user)
}
```

The critical difference: in Go, you can ignore the error return. In C++, `std::expected` forces you to check - accessing the value when an error is stored triggers undefined behavior (or throws `std::bad_expected_access` with `.value()`).

---

### Junior → FAANG: `std::expected` as the Go-Friendly C++ Error Pattern

For Go engineers, `std::expected<T, E>` is the most familiar C++ error handling pattern. It mirrors Go's `(T, error)` return tuple, but with monadic chaining (`.and_then()`, `.transform()`) that eliminates the repetitive `if err != nil` chains.

The key habit: always use `.value_or(default)` or check `.has_value()` before accessing the value. Never use `.value()` without a prior check in production code (it throws or UBs on error). This is the `if err != nil` equivalent in `std::expected` land.

### Senior @ FAANG: `std::expected` vs. `absl::StatusOr` Trade-offs at Scale

At the staff level, choosing between `std::expected` and `absl::StatusOr` is a policy decision with long-term maintenance implications.

**`absl::StatusOr` advantages.** It integrates directly with gRPC, has been in production at Google for many years, provides structured error codes (`absl::StatusCode::kNotFound`, etc.), and has good tooling support (Abseil's `RETURN_IF_ERROR` and `ASSIGN_OR_RETURN` macros significantly reduce boilerplate). For any codebase that uses Abseil and gRPC, `absl::StatusOr` is the clear choice.

**`std::expected` advantages.** It is standard (no Abseil dependency required), works with any error type (not just `absl::Status`), and has better monadic composition in C++23. For a codebase that does not use Abseil and targets C++23, `std::expected` is the modern choice.

**Migration policy.** In a codebase that currently uses error codes (`std::error_code` or `int`) and is upgrading to C++23, the migration to `std::expected` is incremental: convert one module at a time, starting with modules that have the most error-code return values (which will see the largest readability improvement). A staff engineer writes the migration guide with before/after examples and a mechanical conversion rule that engineers can apply.

