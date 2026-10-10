## Part VIII: RAII Scope Guards and Transaction Rollback

RAII (Resource Acquisition Is Initialization) is C++'s most important idiom for exception safety. Scope guards extend RAII to arbitrary cleanup actions.

### Basic Scope Guard

A scope guard captures a cleanup callable in its constructor and invokes it in the destructor, running regardless of whether the scope exits normally or via exception. The `dismiss()` method cancels the cleanup for the success path, analogous to Go's `defer` but with explicit opt-out rather than opt-in cancellation.
```cpp
#include <functional>
#include <iostream>
#include <utility>

// Minimal scope guard implementation
template <typename F>
class ScopeGuard {
public:
    explicit ScopeGuard(F&& func)
        : func_(std::forward<F>(func))
        , active_(true) {}

    ~ScopeGuard() {
        if (active_) {
            try { func_(); }
            catch (...) {}  // destructors must not throw
        }
    }

    // Dismiss the guard (commit succeeded, no cleanup needed)
    void dismiss() noexcept { active_ = false; }

    // Non-copyable, non-movable
    ScopeGuard(const ScopeGuard&) = delete;
    ScopeGuard& operator=(const ScopeGuard&) = delete;
    ScopeGuard(ScopeGuard&& other) noexcept
        : func_(std::move(other.func_))
        , active_(std::exchange(other.active_, false)) {}

private:
    F func_;
    bool active_;
};

template <typename F>
ScopeGuard<std::decay_t<F>> make_scope_guard(F&& f) {
    return ScopeGuard<std::decay_t<F>>(std::forward<F>(f));
}

// Usage: transaction-style commit-or-rollback
void transfer_funds(Account& from, Account& to, long long amount_cents) {
    from.debit(amount_cents);
    auto rollback_debit = make_scope_guard([&]() {
        from.credit(amount_cents);  // undo the debit if anything below fails
    });

    to.credit(amount_cents);  // may throw
    auto rollback_credit = make_scope_guard([&]() {
        to.debit(amount_cents);    // undo the credit if anything below fails
    });

    log_transaction(from.id(), to.id(), amount_cents);  // may throw

    // Everything succeeded - dismiss the rollback guards
    rollback_credit.dismiss();
    rollback_debit.dismiss();
}
```

### Scope Guards with Different Policies

Production scope guards differentiate between exit-on-failure, exit-on-success, and exit-always:

```cpp
#include <exception>

// scope_exit: always runs
// scope_fail: runs only when leaving scope due to exception
// scope_success: runs only when leaving scope normally

template <typename F>
class ScopeExit {
public:
    explicit ScopeExit(F&& f) : func_(std::forward<F>(f)) {}
    ~ScopeExit() { func_(); }
    ScopeExit(const ScopeExit&) = delete;
    ScopeExit& operator=(const ScopeExit&) = delete;
private:
    F func_;
};

template <typename F>
class ScopeFail {
public:
    explicit ScopeFail(F&& f)
        : func_(std::forward<F>(f))
        , exceptions_on_entry_(std::uncaught_exceptions()) {}

    ~ScopeFail() {
        // If more exceptions are in flight now than when we were constructed,
        // we are unwinding due to an exception
        if (std::uncaught_exceptions() > exceptions_on_entry_) {
            try { func_(); } catch (...) {}
        }
    }

    ScopeFail(const ScopeFail&) = delete;
    ScopeFail& operator=(const ScopeFail&) = delete;

private:
    F func_;
    int exceptions_on_entry_;
};

template <typename F>
class ScopeSuccess {
public:
    explicit ScopeSuccess(F&& f)
        : func_(std::forward<F>(f))
        , exceptions_on_entry_(std::uncaught_exceptions()) {}

    ~ScopeSuccess() {
        if (std::uncaught_exceptions() <= exceptions_on_entry_) {
            func_();
        }
    }

    ScopeSuccess(const ScopeSuccess&) = delete;
    ScopeSuccess& operator=(const ScopeSuccess&) = delete;

private:
    F func_;
    int exceptions_on_entry_;
};

// Usage
void update_database(Database& db, const Record& record) {
    db.begin_transaction();

    // Automatically rollback on exception, commit on success
    ScopeFail rollback([&]() {
        db.rollback();
        std::cerr << "Transaction rolled back\n";
    });

    ScopeSuccess commit([&]() {
        db.commit();
        std::cout << "Transaction committed\n";
    });

    db.update("users", record);
    db.update("audit_log", make_audit_entry(record));
    // If either update throws, rollback runs
    // If both succeed, commit runs
}
```

The key insight is `std::uncaught_exceptions()` (C++17), which returns the number of exceptions currently in flight. This replaced the older `std::uncaught_exception()` (singular) which could not handle nested exception scenarios correctly.

### C++26 `std::scope_exit` (Proposed)

The standard library may adopt scope guards directly. Until then, Folly's `SCOPE_EXIT` / `SCOPE_FAIL` / `SCOPE_SUCCESS` macros and Boost's `scope_exit` provide production-ready implementations.

---
