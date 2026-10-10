## Part IV: Error Codes vs. Exceptions

### The Case for Error Codes

Some environments ban exceptions entirely. The reasons are legitimate:

1. **Deterministic latency.** Exception throwing involves stack unwinding, RTTI, and potentially heap allocation. The cost is unpredictable and can be high (microseconds to milliseconds).
2. **Binary size.** Exception handling tables add significant size to binaries. Embedded systems and game consoles care deeply about this.
3. **Compiler compatibility.** Some compilers and platforms have poor or incomplete exception support.
4. **Codegen clarity.** Error code paths are explicit and visible in the source. Exception paths are invisible.

```cpp
#include <system_error>
#include <string>
#include <iostream>

// C-style error codes (simplest)
enum class FileError {
    Success = 0,
    NotFound,
    PermissionDenied,
    DiskFull,
    CorruptData
};

struct ReadResult {
    FileError error;
    std::string data;
};

ReadResult read_file_c_style(const std::string& path) {
    if (path.empty()) {
        return {FileError::NotFound, {}};
    }
    // ... actual reading
    return {FileError::Success, "file contents here"};
}

// Modern C++: std::error_code with std::system_error integration
// Define your own error category
enum class HttpError {
    Ok = 0,
    BadRequest = 400,
    Unauthorized = 401,
    Forbidden = 403,
    NotFound = 404,
    InternalServerError = 500
};

class HttpErrorCategory : public std::error_category {
public:
    const char* name() const noexcept override { return "http"; }

    std::string message(int ev) const override {
        switch (static_cast<HttpError>(ev)) {
            case HttpError::Ok:                  return "OK";
            case HttpError::BadRequest:          return "Bad Request";
            case HttpError::Unauthorized:        return "Unauthorized";
            case HttpError::Forbidden:           return "Forbidden";
            case HttpError::NotFound:            return "Not Found";
            case HttpError::InternalServerError: return "Internal Server Error";
            default:                             return "Unknown HTTP Error";
        }
    }
};

const HttpErrorCategory& http_category() {
    static HttpErrorCategory instance;
    return instance;
}

std::error_code make_error_code(HttpError e) {
    return {static_cast<int>(e), http_category()};
}

// Register with the error_code system
namespace std {
    template<> struct is_error_code_enum<HttpError> : true_type {};
}

// Usage
std::error_code fetch_resource(const std::string& url, std::string& out) {
    if (url.empty()) {
        return HttpError::BadRequest;
    }
    // ... actual fetching
    out = "resource data";
    return {};  // default-constructed error_code means success
}

int main() {
    std::string data;
    if (auto ec = fetch_resource("/api/users", data); ec) {
        std::cerr << "Error: " << ec.message() << " (" << ec.value() << ")\n";
        return 1;
    }
    std::cout << "Got: " << data << "\n";
}
```

### The Case for Exceptions

Exceptions have genuine advantages:

1. **Cannot be silently ignored.** An uncaught exception terminates the program. An unchecked error code is silently swallowed.
2. **Separate happy path from error path.** Code that uses exceptions has a cleaner control flow for the common case.
3. **Constructors can fail.** There is no return value from a constructor. Exceptions are the only clean mechanism to signal construction failure.
4. **Propagation is automatic.** Errors propagate up the call stack without every intermediate function manually forwarding them.

```cpp
// With error codes: every level must check and forward
ErrorCode level3() {
    auto ec = level4();
    if (ec != ErrorCode::Success) return ec;
    auto ec2 = another_call();
    if (ec2 != ErrorCode::Success) return ec2;
    return ErrorCode::Success;
}

// With exceptions: errors propagate automatically
void level3_exceptions() {
    level4();           // throws on failure, propagates automatically
    another_call();     // same
    // Happy path is clean and linear
}
```

### Performance Characteristics

The performance tradeoff is well-studied:

| Aspect | Exceptions | Error Codes |
|---|---|---|
| Happy path overhead | Near zero (table-based) | Small (branch per check) |
| Error path cost | High (stack unwinding) | Same as happy path |
| Binary size | Larger (unwind tables) | Smaller |
| Predictability | Low (error path is expensive) | High (constant cost) |
| Code size (source) | Smaller (no manual checks) | Larger (explicit checks) |

Modern compilers use "zero-cost" exception handling (table-based, not the older setjmp/longjmp approach). The happy path has genuinely zero runtime overhead on most platforms. But the error path is expensive: stack unwinding, RTTI lookup, and potential heap allocation for the exception object.

```cpp
// Benchmark sketch: exception vs error code performance
#include <chrono>
#include <iostream>

enum class EC { Ok, Fail };

EC error_code_path(bool fail) {
    if (fail) return EC::Fail;
    return EC::Ok;
}

int exception_path(bool fail) {
    if (fail) throw std::runtime_error("fail");
    return 0;
}

void benchmark() {
    constexpr int iterations = 1'000'000;
    constexpr double failure_rate = 0.01;  // 1% failure rate

    // Error code benchmark
    auto start = std::chrono::high_resolution_clock::now();
    int failures_ec = 0;
    for (int i = 0; i < iterations; ++i) {
        bool fail = (i % 100 == 0);
        if (error_code_path(fail) == EC::Fail) {
            ++failures_ec;
        }
    }
    auto ec_time = std::chrono::high_resolution_clock::now() - start;

    // Exception benchmark
    start = std::chrono::high_resolution_clock::now();
    int failures_ex = 0;
    for (int i = 0; i < iterations; ++i) {
        bool fail = (i % 100 == 0);
        try {
            exception_path(fail);
        } catch (...) {
            ++failures_ex;
        }
    }
    auto ex_time = std::chrono::high_resolution_clock::now() - start;

    auto ec_us = std::chrono::duration_cast<std::chrono::microseconds>(ec_time).count();
    auto ex_us = std::chrono::duration_cast<std::chrono::microseconds>(ex_time).count();

    std::cout << "Error codes:  " << ec_us << " us\n";
    std::cout << "Exceptions:   " << ex_us << " us\n";
    std::cout << "Ratio:        " << static_cast<double>(ex_us) / ec_us << "x\n";

    // Typical results at 1% failure rate:
    // Error codes:  2100 us
    // Exceptions:   95000 us
    // Ratio:        ~45x slower
    //
    // At 0% failure rate:
    // Error codes:  2100 us
    // Exceptions:   1800 us  (exceptions are FASTER on happy path)
}
```

**Key insight:** At low failure rates (< 0.01%), exceptions can outperform error codes because the happy path has no branch overhead. As failure rates climb, exceptions become dramatically more expensive. If errors are expected and frequent (e.g., "user not found" in a search), use error codes. If errors are exceptional (e.g., "out of memory"), use exceptions.

### Decision Matrix

| Scenario | Recommendation |
|---|---|
| Constructor failure | Exceptions (no alternative) |
| Operator overload failure | Exceptions (no return value) |
| Expected failure (file not found) | Error codes / `std::expected` |
| Programming bug (null deref) | Assert / terminate |
| Resource exhaustion | Exceptions (`std::bad_alloc`) |
| Real-time / latency-critical | Error codes |
| Embedded / small binary | Error codes |
| Library API consumed by others | Both (give users a choice) |

---

### Junior → FAANG: Making the Error Codes vs. Exceptions Decision Once, Not Per Function

The biggest mistake for junior engineers is mixing error codes and exceptions within the same codebase layer without a policy. Decide which mechanism the team uses, then use it consistently. If the codebase is exceptions-disabled (`-fno-exceptions`), use error return values everywhere. If it uses exceptions, use them at the layer boundary where Go engineers would use `if err != nil`.

Go's error handling model (explicit return values, checked by the caller) maps directly to C++ error codes or `absl::StatusOr`. The discipline of always checking the return value in Go transfers directly to C++ error return value code.

### Senior @ FAANG: Error Code Policy and the ABI Stability of Error Types

At the staff level, the error type used in a C++ library's public API is an ABI commitment. Changing `absl::Status` to `std::expected` in a widely-used library requires a migration plan with a deprecation period.

**Error code stability.** If your library defines custom error codes (an enum or `absl::StatusCode` extension), adding new error codes is backward compatible. Renaming or removing error codes is a breaking change. A staff engineer documents the stability guarantee of the error code enum in the library's API documentation: "error codes are stable and will not be removed. New codes may be added."

**gRPC error mapping.** For services that expose a gRPC API, `absl::StatusCode` maps directly to gRPC status codes, which is one of the primary reasons FAANG engineers prefer `absl::Status` over custom error types. A staff engineer ensures the mapping table (which internal error codes map to which gRPC status codes) is documented, reviewed, and consistent across all RPC endpoints.

