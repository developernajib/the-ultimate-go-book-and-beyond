## Part VI: Google's Pattern - `absl::Status` and `absl::StatusOr`

Google's Abseil library provides `absl::Status` and `absl::StatusOr<T>`, which have been the standard error handling mechanism at Google for over a decade. This pattern predates `std::expected` and influenced its design.

```cpp
#include "absl/status/status.h"
#include "absl/status/statusor.h"
#include "absl/strings/str_cat.h"

// absl::Status for operations that return no value
absl::Status initialize_subsystem(const Config& config) {
    if (!config.is_valid()) {
        return absl::InvalidArgumentError("Invalid configuration");
    }
    if (!connect_to_backend(config.backend_url())) {
        return absl::UnavailableError(
            absl::StrCat("Cannot reach backend: ", config.backend_url())
        );
    }
    return absl::OkStatus();
}

// absl::StatusOr<T> for operations that return a value or an error
absl::StatusOr<User> find_user(const Database& db, int64_t user_id) {
    auto row = db.FindRow("users", user_id);
    if (!row.ok()) {
        return absl::NotFoundError(
            absl::StrCat("User not found: ", user_id)
        );
    }
    return User::FromRow(*row);
}

// The RETURN_IF_ERROR macro eliminates boilerplate
// (Google's internal macro, replicated in many open-source projects)
#define RETURN_IF_ERROR(expr)                          \
    do {                                               \
        auto _status = (expr);                         \
        if (!_status.ok()) return _status;             \
    } while (0)

#define ASSIGN_OR_RETURN(lhs, expr)                    \
    auto _statusor_##__LINE__ = (expr);                \
    if (!_statusor_##__LINE__.ok())                    \
        return _statusor_##__LINE__.status();          \
    lhs = std::move(*_statusor_##__LINE__)

absl::StatusOr<Report> generate_report(int64_t user_id) {
    // Macro propagates errors automatically - similar to Go's if err != nil
    ASSIGN_OR_RETURN(auto user, find_user(db, user_id));
    ASSIGN_OR_RETURN(auto orders, find_orders(db, user_id));
    RETURN_IF_ERROR(validate_permissions(user));

    return build_report(user, orders);
}
```

### Status Codes

`absl::Status` uses canonical error codes inspired by gRPC:

```cpp
// The canonical codes (subset):
absl::OkStatus()                           // Success
absl::CanceledError("msg")                // Operation canceled
absl::InvalidArgumentError("msg")          // Client sent bad input
absl::NotFoundError("msg")                 // Resource not found
absl::AlreadyExistsError("msg")            // Resource already exists
absl::PermissionDeniedError("msg")         // Caller lacks permission
absl::ResourceExhaustedError("msg")        // Quota or limit exceeded
absl::FailedPreconditionError("msg")       // System not in required state
absl::AbortedError("msg")                  // Concurrency conflict
absl::OutOfRangeError("msg")               // Operation out of valid range
absl::UnimplementedError("msg")            // Not implemented
absl::InternalError("msg")                 // Internal invariant broken
absl::UnavailableError("msg")              // Service unavailable (retry)
absl::DataLossError("msg")                 // Unrecoverable data loss
absl::UnauthenticatedError("msg")          // Missing authentication

// Attaching payloads for rich error context
absl::Status status = absl::NotFoundError("User 42 not found");
status.SetPayload("user_id", absl::Cord("42"));
status.SetPayload("retry_after", absl::Cord("5s"));
```

### Why Google Chose This Over Exceptions

Google's C++ codebase is massive (billions of lines). Their rationale:

1. **Legacy code.** Most code was written without exception safety. Enabling exceptions would create undefined behavior.
2. **Binary size.** Google deploys to millions of machines. Exception tables add meaningful binary size at their scale.
3. **Readability.** Error handling is explicit and visible in code review. No hidden control flow.
4. **Tooling.** Static analysis can verify that every `StatusOr` is checked. Forgotten exception catches are harder to detect.
5. **gRPC integration.** `absl::Status` codes map directly to gRPC status codes, making RPC error handling seamless.

---

### Junior → FAANG: `RETURN_IF_ERROR` as the Go `if err != nil` Equivalent

The most disorienting thing for Go engineers using `absl::StatusOr` is the boilerplate without macros: check `.ok()`, extract the value, propagate the error. The `RETURN_IF_ERROR` and `ASSIGN_OR_RETURN` macros collapse this to Go-equivalent terseness:

```cpp
// Without macros (verbose):
auto result = DoSomething();
if (!result.ok()) return result.status();
auto value = std::move(*result);

// With macros (Go-equivalent):
ASSIGN_OR_RETURN(auto value, DoSomething());
```

Learn these macros on your first day with an Abseil codebase. They are the idiomatic pattern. Avoiding them produces verbose code that every code reviewer will ask you to simplify.

### Senior @ FAANG: `absl::Status` and Error Context Propagation

At the staff level, `absl::Status` in a production service requires a discipline for error context propagation: when an error is wrapped or re-raised, it must preserve enough context for debugging without leaking sensitive information to clients.

**Error payload and status payloads.** `absl::Status` supports attaching typed payloads (proto-serialized error details) that can be extracted by the caller. For gRPC services, this allows structured error information (field validation errors, retry-after headers) to be included in the gRPC error response without hacking the error message string. A staff engineer designs the error detail types for their service's RPC API and documents which error codes carry which detail types.

**Structured error logging.** When an `absl::Status` error is logged, the log entry should include: the status code, the error message, the request ID (for tracing), and the call stack (for debugging). Abseil's logging integration makes this straightforward, but a staff engineer ensures the logging format is structured (JSON) and consistent across all error logging in the service. Inconsistent error logging is a post-incident debugging nightmare.

