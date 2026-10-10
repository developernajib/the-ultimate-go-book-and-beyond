## Part I: Exceptions - The Language's Native Mechanism

### The Basics: try, catch, throw

C++ exceptions transfer control from the point where an error is detected to the point where it can be handled. The runtime unwinds the stack, destroying local objects along the way.

```cpp
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include <fstream>

double divide(double numerator, double denominator) {
    if (denominator == 0.0) {
        throw std::invalid_argument("Division by zero");
    }
    return numerator / denominator;
}

int main() {
    try {
        double result = divide(10.0, 0.0);
        std::cout << "Result: " << result << "\n";  // never reached
    }
    catch (const std::invalid_argument& e) {
        std::cerr << "Invalid argument: " << e.what() << "\n";
    }
    catch (const std::exception& e) {
        std::cerr << "General error: " << e.what() << "\n";
    }
    catch (...) {
        std::cerr << "Unknown exception caught\n";
    }

    return 0;
}
```

Key rules:

1. **Throw by value, catch by const reference.** Throwing pointers leads to ownership confusion. Catching by value slices derived exceptions.
2. **Catch blocks are evaluated in order.** Put more specific catches first. `catch (const std::exception&)` before `catch (...)`.
3. **`catch (...)`** catches everything, including non-standard exceptions. Use it as a last-resort safety net.
4. **Stack unwinding destroys locals.** Every object with a destructor between the throw and the catch gets destroyed. This is why RAII matters so much in C++.

### Rethrowing and Nested Exceptions

Sometimes you need to catch an exception, do partial cleanup, and rethrow it:

```cpp
void process_file(const std::string& path) {
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("Cannot open file: " + path);
    }

    try {
        // Parse file contents...
        parse_contents(file);
    }
    catch (...) {
        // Log the error, then rethrow without slicing
        log_error("Failed processing: " + path);
        throw;  // rethrows the ORIGINAL exception, preserving type
    }
}
```

C++11 introduced nested exceptions for chaining error context:

```cpp
#include <exception>
#include <iostream>
#include <stdexcept>

void low_level_operation() {
    throw std::runtime_error("Disk I/O failed");
}

void mid_level_operation() {
    try {
        low_level_operation();
    }
    catch (...) {
        // Wrap the current exception inside a new one
        std::throw_with_nested(
            std::runtime_error("Mid-level operation failed")
        );
    }
}

void print_exception_chain(const std::exception& e, int depth = 0) {
    std::cerr << std::string(depth * 2, ' ') << "Exception: " << e.what() << "\n";
    try {
        std::rethrow_if_nested(e);
    }
    catch (const std::exception& nested) {
        print_exception_chain(nested, depth + 1);
    }
    catch (...) {
        std::cerr << std::string((depth + 1) * 2, ' ') << "Unknown nested exception\n";
    }
}

int main() {
    try {
        mid_level_operation();
    }
    catch (const std::exception& e) {
        print_exception_chain(e);
        // Output:
        // Exception: Mid-level operation failed
        //   Exception: Disk I/O failed
    }
}
```

### The Standard Exception Hierarchy

The standard library defines a tree of exception types rooted at `std::exception`:

```
std::exception
├── std::logic_error
│   ├── std::invalid_argument
│   ├── std::domain_error
│   ├── std::length_error
│   ├── std::out_of_range
│   └── std::future_error (C++11)
├── std::runtime_error
│   ├── std::range_error
│   ├── std::overflow_error
│   ├── std::underflow_error
│   ├── std::system_error (C++11)
│   │   └── std::filesystem::filesystem_error (C++17)
│   └── std::format_error (C++20)
├── std::bad_alloc
│   └── std::bad_array_new_length
├── std::bad_cast
├── std::bad_typeid
├── std::bad_exception
├── std::bad_function_call (C++11)
├── std::bad_weak_ptr (C++11)
└── std::bad_optional_access (C++17)
```

**`logic_error`** represents bugs in the program (precondition violations). In theory, these should never occur in correct code. **`runtime_error`** represents failures that cannot be predicted at compile time (file not found, network down). In practice, the line is blurry, and most teams catch `std::exception` as a base.

### Custom Exception Classes

Production code needs domain-specific exceptions:

```cpp
#include <stdexcept>
#include <string>
#include <system_error>

// Level 1: Simple custom exception
class DatabaseException : public std::runtime_error {
public:
    explicit DatabaseException(const std::string& msg)
        : std::runtime_error(msg) {}
};

// Level 2: Exception with structured error information
enum class DbErrorCode {
    ConnectionFailed,
    QueryTimeout,
    ConstraintViolation,
    AuthenticationFailed,
    DeadlockDetected
};

class DetailedDbException : public std::runtime_error {
public:
    DetailedDbException(DbErrorCode code, const std::string& query,
                        const std::string& msg)
        : std::runtime_error(msg)
        , error_code_(code)
        , query_(query) {}

    DbErrorCode error_code() const noexcept { return error_code_; }
    const std::string& query() const noexcept { return query_; }

    // Retry decision based on error type
    bool is_retryable() const noexcept {
        switch (error_code_) {
            case DbErrorCode::ConnectionFailed:
            case DbErrorCode::QueryTimeout:
            case DbErrorCode::DeadlockDetected:
                return true;
            default:
                return false;
        }
    }

private:
    DbErrorCode error_code_;
    std::string query_;
};

// Level 3: Exception with error code integration (std::system_error pattern)
class NetworkErrorCategory : public std::error_category {
public:
    const char* name() const noexcept override { return "network"; }

    std::string message(int ev) const override {
        switch (static_cast<DbErrorCode>(ev)) {
            case DbErrorCode::ConnectionFailed: return "Connection failed";
            case DbErrorCode::QueryTimeout:     return "Query timed out";
            default:                            return "Unknown network error";
        }
    }
};

// Usage
void execute_query(const std::string& sql) {
    // Simulate a timeout
    throw DetailedDbException(
        DbErrorCode::QueryTimeout,
        sql,
        "Query exceeded 30s timeout: " + sql.substr(0, 50)
    );
}

void handle_with_retry() {
    int max_retries = 3;
    for (int attempt = 1; attempt <= max_retries; ++attempt) {
        try {
            execute_query("SELECT * FROM large_table WHERE ...");
            return;  // success
        }
        catch (const DetailedDbException& e) {
            if (e.is_retryable() && attempt < max_retries) {
                std::cerr << "Attempt " << attempt << " failed: "
                          << e.what() << ". Retrying...\n";
                continue;
            }
            throw;  // rethrow if not retryable or out of retries
        }
    }
}
```

**Design guidelines for custom exceptions:**

- Inherit from `std::exception` or its subclasses (never throw raw integers or strings).
- Store enough context for diagnosis: error codes, operation names, affected resources.
- Make accessors `noexcept` - an exception's methods must never throw.
- Consider `std::system_error` integration for OS-level errors.
- Keep the `what()` message human-readable but also machine-parseable when possible.

---

### Junior → FAANG: The Three Exception Anti-Patterns to Avoid

The most common exception misuses for engineers new to C++ exceptions: (1) catching `std::exception&` in a non-recovery context and logging then continuing (this hides failures that should propagate), (2) throwing exceptions from destructors (which terminates the program if another exception is active during stack unwinding), (3) using exceptions for control flow in performance-critical paths (exception throwing and catching is expensive, typically microseconds).

Practice: find three places in any Go codebase where `if err != nil { return err }` is used. Trace how each of those errors would be represented in a C++ codebase that uses exceptions. This mapping exercise builds the instinct for when C++ exceptions are the right choice.

### Senior @ FAANG: Exceptions in Performance-Critical and Exception-Disabled Contexts

At the staff level, the decision to use or ban exceptions is one of the earliest and most consequential architecture decisions for a C++ codebase.

**Exception performance model.** Modern C++ implementations use zero-cost exceptions: in the non-throwing path, there is no overhead from exception handling (no stack frame manipulation, no exception table checks). The cost is paid only when an exception is thrown. This makes exceptions appropriate for error paths that are rare (network failures, configuration errors, resource exhaustion) and inappropriate for error paths that are common (returning "not found" from a lookup).

**`-fno-exceptions` policy and its consequences.** Google's style guide banned exceptions in new C++ code for many years (recently partially relaxed for new code). The consequences of this ban: constructors that fail must use two-phase initialization (constructor + `Init()` method) or factory functions, every function that can fail must return `absl::Status` or `absl::StatusOr`, and any third-party library that uses exceptions must be wrapped in a boundary that converts exceptions to status codes. A staff engineer joining a team with this policy must understand the full consequence chain, not just the "no exceptions" rule.

