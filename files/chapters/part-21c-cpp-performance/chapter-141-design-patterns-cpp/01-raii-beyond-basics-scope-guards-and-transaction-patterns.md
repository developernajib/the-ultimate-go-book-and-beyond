## RAII Beyond Basics: Scope Guards and Transaction Patterns

RAII, Resource Acquisition Is Initialization, is C++'s most important idiom. You already know the basics: constructor acquires, destructor releases. But production code needs more than `unique_ptr`. You need to run arbitrary cleanup at scope exit, commit or roll back operations depending on whether an exception was thrown, and compose multiple resources safely. This is where scope guards and transaction patterns come in.

### The Problem RAII Solves (Again)

Consider code that acquires multiple resources and needs cleanup in all exit paths, normal return, early return, and exception. Without a guard, you duplicate cleanup code or wrap everything in `try/finally` (which C++ doesn't have). The scope guard pattern gives you Go's `defer` semantics with deterministic destruction.

### ScopeGuard: Generic Defer Mechanism

Andrei Alexandrescu popularized the ScopeGuard in 2000. The modern C++17 implementation is clean and zero-overhead:

```cpp
#include <functional>
#include <utility>

// ScopeGuard executes a callable when it goes out of scope.
// Modeled after Go's defer statement -- but destructor-based, so it
// interacts correctly with stack unwinding and exceptions.
template <typename Fn>
class ScopeGuard {
    Fn      fn_;
    bool    active_;

public:
    explicit ScopeGuard(Fn&& fn)
        : fn_(std::forward<Fn>(fn))
        , active_(true)
    {}

    // Non-copyable -- ownership is unique
    ScopeGuard(const ScopeGuard&) = delete;
    ScopeGuard& operator=(const ScopeGuard&) = delete;

    // Movable -- allows factory function pattern
    ScopeGuard(ScopeGuard&& other) noexcept
        : fn_(std::move(other.fn_))
        , active_(other.active_)
    {
        other.active_ = false;
    }

    ~ScopeGuard() {
        if (active_) fn_();
    }

    // Call dismiss() to prevent cleanup -- used for the "success" path
    void dismiss() noexcept { active_ = false; }
};

// Deduction guide: factory function so callers don't specify the type
template <typename Fn>
[[nodiscard]] auto make_scope_guard(Fn&& fn) {
    return ScopeGuard<std::decay_t<Fn>>(std::forward<Fn>(fn));
}

// Convenience macro -- mirrors Go's defer syntax closely
#define SCOPE_EXIT(code) \
    auto SCOPE_EXIT_##__LINE__ = make_scope_guard([&]{ code; })
```

### Using ScopeGuard in Practice

`ScopeGuard` takes a callable at construction time and invokes it in the destructor, ensuring cleanup runs even when exceptions unwind the stack. The `dismiss()` method cancels the guard on the success path, a critical detail that allows `ScopeGuard` to implement both unconditional cleanup and transactional rollback semantics with the same primitive.
```cpp
#include <cstdio>
#include <stdexcept>

void process_file(const char* path) {
    FILE* f = std::fopen(path, "r");
    if (!f) throw std::runtime_error("cannot open file");

    // This mirrors Go's: defer f.Close()
    // Runs unconditionally when process_file() exits.
    auto guard = make_scope_guard([f]{ std::fclose(f); });

    // ... process file ...
    // No need to fclose in every return/throw path.
}

// Macro version -- even closer to Go's defer
void process_file_v2(const char* path) {
    FILE* f = std::fopen(path, "r");
    if (!f) throw std::runtime_error("cannot open file");

    SCOPE_EXIT(std::fclose(f));

    // ... process file ...
}
```

Unlike Go's `defer`, C++ scope guards execute in reverse-declaration order (LIFO), and their lifetime is tied to the enclosing block, not the function. You can create fine-grained scopes:

```cpp
void with_multiple_resources() {
    auto* conn = acquire_connection();
    auto conn_guard = make_scope_guard([conn]{ release_connection(conn); });

    {
        // Inner scope: lock held only within this block
        auto* lock = acquire_lock();
        auto lock_guard = make_scope_guard([lock]{ release_lock(lock); });

        // lock released here
    }

    // conn released here
}
```

### TransactionGuard: Commit or Rollback

A more sophisticated pattern combines RAII with the concept of commit/rollback. The guard rolls back by default. You must call `commit()` explicitly to prevent rollback. This is the "dismiss on success" pattern:

```cpp
#include <functional>
#include <utility>

class TransactionGuard {
    std::function<void()> rollback_;
    std::function<void()> commit_;
    bool committed_ = false;

public:
    TransactionGuard(std::function<void()> commit_fn,
                     std::function<void()> rollback_fn)
        : rollback_(std::move(rollback_fn))
        , commit_(std::move(commit_fn))
    {}

    ~TransactionGuard() {
        if (!committed_) {
            rollback_();
        }
    }

    void commit() {
        commit_();
        committed_ = true;
    }

    TransactionGuard(const TransactionGuard&) = delete;
    TransactionGuard& operator=(const TransactionGuard&) = delete;
};
```

### Production Example: Database Transaction RAII Guard

RAII (Resource Acquisition Is Initialization) ties the lifetime of a resource to the lifetime of a stack-allocated object, guaranteeing cleanup even when exceptions are thrown. This idiom is the cornerstone of exception-safe C++ and the basis for all standard library resource wrappers.
```cpp
#include <stdexcept>
#include <string>

// Hypothetical DB connection type
struct DbConnection {
    void execute(const std::string& sql);
    void begin_transaction();
    void commit();
    void rollback();
};

// RAII guard that wraps a database transaction.
// Commit only happens if commit() is explicitly called.
// Any exception or early return triggers automatic rollback.
class DbTransaction {
    DbConnection& conn_;
    bool          committed_ = false;

public:
    explicit DbTransaction(DbConnection& conn) : conn_(conn) {
        conn_.begin_transaction();
    }

    ~DbTransaction() noexcept {
        if (!committed_) {
            try { conn_.rollback(); }
            catch (...) { /* suppress in destructor */ }
        }
    }

    void commit() {
        conn_.commit();
        committed_ = true;
    }

    DbTransaction(const DbTransaction&) = delete;
    DbTransaction& operator=(const DbTransaction&) = delete;
};

void transfer_funds(DbConnection& db, int from_id, int to_id, double amount) {
    DbTransaction tx(db);  // BEGIN TRANSACTION

    db.execute("UPDATE accounts SET balance = balance - " +
               std::to_string(amount) + " WHERE id = " + std::to_string(from_id));

    db.execute("UPDATE accounts SET balance = balance + " +
               std::to_string(amount) + " WHERE id = " + std::to_string(to_id));

    // Any exception above causes ~DbTransaction() to call rollback()
    tx.commit();  // COMMIT -- only reaches here on success
}
```

### C++23: std::scope_exit, std::scope_fail, std::scope_success

C++23 standardizes three scope guard types in `<scope>` (from P0052, based on the N4189 proposal). They remove the need for hand-rolled implementations:

```cpp
#include <scope>  // C++23

void process(FILE* f) {
    // Runs always, like ScopeGuard::dismiss() never called
    std::scope_exit  cleanup([f]{ std::fclose(f); });

    // Runs only if an exception is thrown (stack unwinding in progress)
    std::scope_fail  on_error([]{ log_error("process failed"); });

    // Runs only if no exception is thrown (normal exit)
    std::scope_success on_ok([]{ log_info("process succeeded"); });

    // ... do work ...
}
```

`std::scope_success` and `std::scope_fail` use `std::uncaught_exceptions()` internally to determine whether unwinding is in progress, the same technique you would use in a hand-rolled implementation.

### Go Comparison

Go's `defer` is the closest analog. Key differences:

- Go `defer` is always function-scoped. C++ scope guards are block-scoped (more precise control).
- Go `defer` arguments are evaluated immediately. C++ lambdas capture by reference or value explicitly.
- Go `defer` runs in LIFO order within a function. C++ scope guards run in reverse declaration order within their block.
- C++ has `scope_success`/`scope_fail` differentiation. Go has no equivalent, you must check `err` at the top of a deferred function.

The concept is identical: guarantee cleanup without duplicating it across every exit path.

---
