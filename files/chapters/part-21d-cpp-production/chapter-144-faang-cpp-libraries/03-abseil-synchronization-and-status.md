## Abseil: Synchronization and Status

Two of the most consequential design decisions in any large C++ codebase are how you synchronize shared state and how you propagate errors. Abseil provides production-hardened answers to both questions, refined through years of use across Google's entire software stack.

### absl::Mutex and absl::MutexLock

`absl::Mutex` is a drop-in replacement for `std::mutex` with critical additions: thread annotation support for compile-time lock ordering verification, and deadlock detection in debug builds.

```cpp
#include "absl/synchronization/mutex.h"

class RequestCounter {
    mutable absl::Mutex mu_;
    int64_t count_ ABSL_GUARDED_BY(mu_) = 0;

public:
    void increment() {
        absl::MutexLock lock(&mu_);  // RAII -- unlocks on scope exit
        ++count_;
    }

    // Reader/writer lock -- multiple concurrent readers, exclusive writers
    int64_t get() const {
        absl::ReaderMutexLock lock(&mu_);
        return count_;
    }

    // Conditional wait -- unlock mutex and wait until predicate is true
    void wait_until_nonzero() {
        absl::MutexLock lock(&mu_);
        mu_.Await(absl::Condition(+[](int64_t* c) { return *c > 0; }, &count_));
    }
};
```

The `ABSL_GUARDED_BY(mu_)` annotation is processed by Clang's thread safety analysis. If you forget to hold `mu_` when accessing `count_`, it's a **compile-time error**, not a race condition discovered in production. Go has no equivalent because Go's race detector is runtime-based, but the Abseil approach catches more classes of errors earlier.

### absl::Notification: One-Shot Events

`absl::Notification` is a simpler primitive for "signal once, wait for signal" patterns. It replaces the verbose `std::condition_variable` + `std::mutex` + `bool` pattern.

```cpp
#include "absl/synchronization/notification.h"
#include <thread>

absl::Notification server_ready;

// Thread 1: server startup
std::thread server([&]() {
    initialize_server();
    server_ready.Notify();  // Signal -- can only be called once
    run_server_loop();
});

// Thread 2: wait for server before sending requests
server_ready.WaitForNotification();
// or with timeout:
bool ready = server_ready.WaitForNotificationWithTimeout(absl::Seconds(5));

server.join();
```

Go equivalent: `sync.WaitGroup` with `Add(1)` + `Done()` + `Wait()`, or a `chan struct{}` closed with `close(ch)`. `absl::Notification` maps most directly to a closed channel, it's a broadcast signal that all waiters unblock simultaneously.

### absl::Barrier: N-Thread Synchronization

`absl::Barrier` is initialized with a thread count N and blocks each thread that calls `Block()` until all N threads have arrived, then releases all of them simultaneously. This is the standard pattern for phased parallel algorithms, each thread does its phase-one work independently, then synchronizes at the barrier before any thread begins phase two, ensuring no thread reads another's phase-two writes before they are complete.
```cpp
#include "absl/synchronization/barrier.h"

void parallel_phase(absl::Barrier* barrier, int thread_id) {
    // Phase 1: all threads do work independently
    do_phase_one_work(thread_id);

    // All threads must reach this point before any proceeds
    bool last = barrier->Block();  // returns true for the last thread to arrive
    if (last) {
        // Only one thread runs this -- the last to arrive
        merge_phase_one_results();
    }

    // Phase 2: all threads start here together
    do_phase_two_work(thread_id);
}

// Create barrier for N threads
auto barrier = std::make_unique<absl::Barrier>(num_threads);
```

### absl::Status and absl::StatusOr

Google's codebase avoids C++ exceptions entirely. The reason: exceptions interact poorly with `goto`-style control flow, make code harder to reason about in large codebases, and have nonzero overhead even on the non-throwing path in some compiler configurations. Instead, Google uses `absl::Status` as the universal error type.

```cpp
#include "absl/status/status.h"
#include "absl/status/statusor.h"

// Return status-only functions
absl::Status ValidateRequest(const Request& req) {
    if (req.user_id() <= 0) {
        return absl::InvalidArgumentError("user_id must be positive");
    }
    if (req.query().empty()) {
        return absl::InvalidArgumentError("query must not be empty");
    }
    return absl::OkStatus();
}

// Return a value or an error
absl::StatusOr<User> LookupUser(int64_t user_id) {
    if (!db_.contains(user_id)) {
        return absl::NotFoundError(
            absl::StrCat("user ", user_id, " not found")
        );
    }
    return db_[user_id];  // implicit construction of StatusOr<User>
}

// Consuming StatusOr
absl::StatusOr<User> result = LookupUser(42);
if (!result.ok()) {
    LOG(ERROR) << "Lookup failed: " << result.status();
    return result.status();  // propagate error
}
User user = *result;       // dereference -- valid because ok() is true
// or: User user = std::move(result).value();
```

### The RETURN_IF_ERROR Macros

Propagating errors through call stacks is verbose without macros. Abseil provides two that dramatically reduce boilerplate:

```cpp
#include "absl/status/status_macros.h"

// RETURN_IF_ERROR: if expr is not OK, return its status immediately
absl::Status ProcessRequest(const Request& req) {
    RETURN_IF_ERROR(ValidateRequest(req));
    RETURN_IF_ERROR(CheckRateLimit(req.user_id()));

    ASSIGN_OR_RETURN(User user, LookupUser(req.user_id()));
    ASSIGN_OR_RETURN(Response resp, BuildResponse(user, req));

    return SendResponse(resp);
}

// Without macros -- equivalent but verbose:
absl::Status ProcessRequest_verbose(const Request& req) {
    absl::Status s = ValidateRequest(req);
    if (!s.ok()) return s;

    s = CheckRateLimit(req.user_id());
    if (!s.ok()) return s;

    absl::StatusOr<User> user_or = LookupUser(req.user_id());
    if (!user_or.ok()) return user_or.status();
    User user = *user_or;
    // ...
}
```

Go engineers will recognize the pattern immediately: this is exactly how Go error handling works. `RETURN_IF_ERROR(expr)` is `if err := expr; err != nil { return err }`. The C++ version is a macro rather than a language feature, but the semantics are identical.

### Status Codes

`absl::Status` maps directly to the `google.rpc.Code` enum used by gRPC, so the same status values flow through local function calls, gRPC responses, and log messages without translation. Using typed constructors like `absl::NotFoundError("resource not found")` instead of integer codes makes error handling self-documenting and allows callers to use `absl::IsNotFound(status)` for unambiguous categorization.
```cpp
// Standard status codes from google.rpc.Code
absl::OkStatus()
absl::CanceledError("operation canceled")
absl::UnknownError("unknown error")
absl::InvalidArgumentError("bad input: " + details)
absl::DeadlineExceededError("timeout after 5s")
absl::NotFoundError("resource not found")
absl::AlreadyExistsError("key already exists")
absl::PermissionDeniedError("not authorized")
absl::ResourceExhaustedError("rate limit exceeded")
absl::UnauthenticatedError("missing credentials")
absl::InternalError("internal server error")
absl::UnavailableError("service temporarily unavailable")

// Check the code
if (absl::IsNotFound(status)) { /* 404 path */ }
if (absl::IsPermissionDenied(status)) { /* 403 path */ }
```

These codes map directly to gRPC status codes and HTTP status codes, making `absl::Status` a natural fit for service boundaries.

### absl::Flags: Command-Line Configuration

`ABSL_FLAG` declares typed command-line flags at file scope using the flag name, default value, and help text, `absl::ParseCommandLine` processes `argv` at startup and populates all registered flags. Accessing a flag via `absl::GetFlag(FLAGS_port)` is type-safe, the compiler enforces that the return type matches the flag's declared type, and the flags appear in `--help` output automatically without any additional registration code.
```cpp
#include "absl/flags/flag.h"
#include "absl/flags/parse.h"

// Declare flags at file scope
ABSL_FLAG(int32_t,     port,          8080,        "Port to listen on");
ABSL_FLAG(std::string, db_host,       "localhost", "Database hostname");
ABSL_FLAG(bool,        enable_debug,  false,       "Enable debug logging");
ABSL_FLAG(absl::Duration, timeout,    absl::Seconds(30), "Request timeout");

int main(int argc, char** argv) {
    absl::ParseCommandLine(argc, argv);

    int32_t port = absl::GetFlag(FLAGS_port);
    std::string db = absl::GetFlag(FLAGS_db_host);
    absl::Duration timeout = absl::GetFlag(FLAGS_timeout);

    // Flags can be set via --port=9090 or --port 9090
    // Usage is auto-generated from the descriptions
}
```

Go equivalent: the `flag` package. The API is nearly identical, `flag.Int`, `flag.String`, `flag.Parse`. `absl::Flags` adds integration with Abseil's type system (including `absl::Duration` as a native flag type) and the `ABSL_FLAG` macro provides better tooling integration.

---
