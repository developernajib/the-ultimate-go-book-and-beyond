## Part VII: Meta's Pattern - `folly::Expected` and `folly::Try`

Meta's Folly library takes a different approach, influenced by functional programming and Haskell's `Either` type.

### `folly::Expected<T, E>`

`folly::Expected<T, E>` holds either a success value of type `T` or an error of type `E`, making the error path visible in the function signature without relying on exceptions. It predates `std::expected` (C++23) by several years and follows the same monadic interface: `hasValue()` tests the state, dereferencing gives the value, and `error()` extracts the error, closely paralleling Go's `(T, error)` return convention but encoded in the type system.
```cpp
#include <folly/Expected.h>
#include <folly/Conv.h>
#include <string>

enum class ParseError {
    Empty,
    InvalidFormat,
    OutOfRange
};

// folly::Expected predates std::expected by years
folly::Expected<int, ParseError> parse_port(const std::string& input) {
    if (input.empty()) {
        return folly::makeUnexpected(ParseError::Empty);
    }

    auto result = folly::tryTo<int>(input);
    if (!result.hasValue()) {
        return folly::makeUnexpected(ParseError::InvalidFormat);
    }

    int port = result.value();
    if (port < 1 || port > 65535) {
        return folly::makeUnexpected(ParseError::OutOfRange);
    }

    return port;
}

void example() {
    auto port = parse_port("8080");
    if (port.hasValue()) {
        std::cout << "Port: " << port.value() << "\n";
    } else {
        std::cout << "Error code: " << static_cast<int>(port.error()) << "\n";
    }

    // Chaining with thenValue (similar to std::expected::and_then)
    auto result = parse_port("443")
        .thenValue([](int port) -> folly::Expected<std::string, ParseError> {
            return "https://localhost:" + std::to_string(port);
        });
}
```

### `folly::Try<T>` - Exception Capture

`folly::Try` bridges the exception world and the value-or-error world. It captures exceptions as values:

```cpp
#include <folly/Try.h>
#include <folly/futures/Future.h>

// folly::Try<T> holds either a T, an exception, or nothing
folly::Try<int> safe_divide(int a, int b) {
    return folly::makeTryWith([&]() -> int {
        if (b == 0) throw std::invalid_argument("division by zero");
        return a / b;
    });
}

void example() {
    auto result = safe_divide(10, 0);

    if (result.hasValue()) {
        std::cout << "Result: " << result.value() << "\n";
    } else if (result.hasException()) {
        // Access the exception without rethrowing
        auto* ex = result.tryGetExceptionObject<std::invalid_argument>();
        if (ex) {
            std::cout << "Invalid argument: " << ex->what() << "\n";
        }
    }
}

// folly::Try shines with futures and async code
folly::Future<int> async_computation() {
    return folly::makeFuture()
        .thenValue([](auto&&) {
            return expensive_computation();
        })
        .thenTry([](folly::Try<int>&& t) {
            // Handle both success and failure in one callback
            if (t.hasException()) {
                log_error(t.exception());
                return -1;  // default value
            }
            return t.value();
        });
}
```

### Meta's Design Philosophy

Meta's approach differs from Google's in key ways:

1. **Exceptions are not banned.** Meta uses exceptions in some codebases. `folly::Try` bridges exception-using code with error-value code.
2. **Async-first.** `folly::Try` integrates deeply with `folly::Future` for asynchronous programming.
3. **Functional composition.** The monadic API (`thenValue`, `thenError`) enables pipeline-style error handling.
4. **Exception capture.** Instead of banning exceptions, Meta captures them as values for deferred handling.

---
