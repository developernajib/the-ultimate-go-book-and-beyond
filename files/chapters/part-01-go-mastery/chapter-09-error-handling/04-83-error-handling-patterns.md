## 9.3 Error Handling Patterns

### The Guard Clause Pattern

Guard clauses check for error conditions at the top of a function and return immediately, keeping the main logic at the lowest indentation level. This avoids deeply nested `if-else` chains and makes the success path visually obvious.

```go
func processUser(id int) error {
    user, err := getUser(id)
    if err != nil {
        return fmt.Errorf("get user: %w", err)
    }

    if !user.IsActive {
        return errors.New("user is inactive")
    }

    if user.Balance < 0 {
        return errors.New("negative balance")
    }

    if time.Since(user.LastLogin) > 90*24*time.Hour {
        return errors.New("account dormant")
    }

    // Happy path continues here at minimal indentation
    return processActiveUser(user)
}
```

### The Errors Slice Pattern

Validation functions often need to report all invalid fields at once rather than stopping at the first failure. The errors slice pattern accumulates errors into a `[]error` and joins them at the end with `errors.Join`, which returns `nil` when the slice is empty.

```go
func validate(user User) error {
    var errs []error

    if user.Name == "" {
        errs = append(errs, errors.New("name is required"))
    }

    if user.Email == "" {
        errs = append(errs, errors.New("email is required"))
    } else if !strings.Contains(user.Email, "@") {
        errs = append(errs, errors.New("email is invalid"))
    }

    if user.Age < 0 {
        errs = append(errs, errors.New("age cannot be negative"))
    } else if user.Age < 13 {
        errs = append(errs, errors.New("must be at least 13 years old"))
    }

    if len(user.Password) < 8 {
        errs = append(errs, errors.New("password must be at least 8 characters"))
    }

    return errors.Join(errs...)
}
```

### errors.Join (Go 1.20+)

`errors.Join` combines multiple error values into a single error. The resulting error's `Error()` string concatenates each message on a separate line, and `errors.Is`/`errors.As` can still match any of the original errors through the combined value. Nil arguments are silently filtered out.

```go
err1 := errors.New("first error")
err2 := errors.New("second error")
combined := errors.Join(err1, err2)

fmt.Println(combined)
// first error
// second error

// Both original errors are still matchable
errors.Is(combined, err1)  // true
errors.Is(combined, err2)  // true

// nil errors are filtered out
result := errors.Join(nil, err1, nil, err2)  // same as Join(err1, err2)
```

### The Deferred Error Pattern

When a function opens a resource and defers its cleanup, the `Close` call can itself fail (e.g., flushing buffered writes to a full disk). Named return values combined with a deferred closure let you capture the close error without discarding the original write error.

```go
func writeFile(path string, data []byte) (err error) {
    f, err := os.Create(path)
    if err != nil {
        return fmt.Errorf("create file: %w", err)
    }
    defer func() {
        closeErr := f.Close()
        if err == nil {
            err = closeErr
        }
        // If write failed, don't override with close error
    }()

    if _, err := f.Write(data); err != nil {
        return fmt.Errorf("write: %w", err)
    }

    // Sync to ensure data is written to disk
    if err := f.Sync(); err != nil {
        return fmt.Errorf("sync: %w", err)
    }

    return nil
}
```

### Better Deferred Error Handling

Named return values and deferred functions allow capturing and wrapping errors from `Close` or `Commit` calls without cluttering the happy path. This ensures cleanup errors are never silently discarded.

```go
func writeFile(path string, data []byte) (err error) {
    f, err := os.Create(path)
    if err != nil {
        return fmt.Errorf("create file: %w", err)
    }
    defer func() {
        closeErr := f.Close()
        // Join errors if both failed
        err = errors.Join(err, closeErr)
    }()

    if _, err := f.Write(data); err != nil {
        return fmt.Errorf("write: %w", err)
    }

    return nil
}
```

### Error Annotation Pattern

Sometimes you want to attach metadata (stack traces, timestamps, operation names) to an error without altering what `errors.Is` and `errors.As` find in the chain. An annotation wrapper preserves the original error identity while carrying extra debugging information.

```go
type annotatedError struct {
    err        error
    message    string
    stackTrace string
}

func (e annotatedError) Error() string {
    return fmt.Sprintf("%s: %s", e.message, e.err.Error())
}

func (e annotatedError) Unwrap() error {
    return e.err
}

func annotate(err error, message string) error {
    if err == nil {
        return nil
    }
    return annotatedError{
        err:        err,
        message:    message,
        stackTrace: string(debug.Stack()),
    }
}
```

### The Try Pattern (Functional Approach)

A `Result` type with chainable methods can reduce repetitive `if err != nil` blocks when a sequence of operations all share the same error-handling strategy. The chain short-circuits on the first error, similar to monadic error handling in functional languages. This is not idiomatic Go for most code, but it fits well in pipeline-style data processing where each step transforms the same value.

```go
type Result[T any] struct {
    Value T
    Err   error
}

func Try[T any](value T, err error) Result[T] {
    return Result[T]{Value: value, Err: err}
}

func (r Result[T]) Then(fn func(T) (T, error)) Result[T] {
    if r.Err != nil {
        return r
    }
    return Try(fn(r.Value))
}

func (r Result[T]) ThenDo(fn func(T) error) Result[T] {
    if r.Err != nil {
        return r
    }
    return Result[T]{Value: r.Value, Err: fn(r.Value)}
}

// Usage: every step consumes and produces the same type,
// e.g. loadConfig returns (Config, error), applyDefaults is
// func(Config) (Config, error), validateConfig is func(Config) error
result := Try(loadConfig("config.json")).
    Then(applyDefaults).
    ThenDo(validateConfig).
    Then(normalizeConfig)

if result.Err != nil {
    return result.Err
}
config := result.Value
```

### Designing Error Contracts: Stop Forwarding, Start Designing

In junior and mid-level codebases, the default response to any failure is blind error forwarding: `if err != nil { return err }`. While concise, this leaks internal implementation details across architectural boundaries and forces callers into a guessing game.

> **Production Context & Article Reference**:
> This architectural principle is established by Yaninyz witty in [*Stop Returning Errors Like This: Design Them Instead*](https://medium.com/@yaninyzwitty/stop-returning-errors-like-this-design-them-instead).

#### The Problem: The "Error Forwarding" Anti-Pattern
```go
func (s *PaymentService) Charge(ctx context.Context, accountID string, amount int64) error {
    account, err := s.repo.GetAccount(ctx, accountID)
    if err != nil {
        return err // ❌ Leaks "sql: no rows in result set" or "pq: connection refused"
    }
    if account.Balance < amount {
        return errors.New("insufficient balance") // ❌ Plain string error, caller cannot programmatically inspect
    }
    return s.gateway.Debit(ctx, accountID, amount)
}
```
When an upstream HTTP handler or Temporal workflow receives this error, it cannot determine:
1. Is this a 404 (account does not exist)?
2. Is this a 400 (insufficient funds)?
3. Is this a 503 (database connection dropped) that is safe to retry with backoff?

#### Step 1: Enumerate Failure Modes, Not Messages
Design your errors around what the caller needs to decide:
- **Client Error (4xx)**: Non-retryable (invalid input, resource missing, domain invariant violated).
- **Transient Dependency Error (503/429)**: Retryable with exponential backoff.
- **Permanent Internal Invariant (500)**: Non-retryable operational bug.

#### Step 2: Structured Error Contracts with Retryability

```go
package payment

import (
	"errors"
	"fmt"
)

// Domain Sentinels
var (
	ErrAccountNotFound   = errors.New("account not found")
	ErrInsufficientFunds = errors.New("insufficient balance")
	ErrGatewayTimeout    = errors.New("payment gateway timeout")
)

// Retryable error classification
type RetryableError interface {
	error
	IsRetryable() bool
}

type transientError struct {
	err error
}

func (e transientError) Error() string   { return e.err.Error() }
func (e transientError) Unwrap() error  { return e.err }
func (e transientError) IsRetryable() bool { return true }

func MarkRetryable(err error) error {
	if err == nil {
		return nil
	}
	return transientError{err: err}
}

func IsRetryable(err error) bool {
	var r RetryableError
	return errors.As(err, &r) && r.IsRetryable()
}
```

#### Step 3: Boundary Translation
At the repository or service boundary, translate driver errors into domain sentinels while preserving the causal chain using `%w`:

```go
func (s *PaymentService) Charge(ctx context.Context, accountID string, amount int64) error {
    account, err := s.repo.GetAccount(ctx, accountID)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            // Translate storage detail into domain failure:
            return fmt.Errorf("%w: account ID %s", ErrAccountNotFound, accountID)
        }
        // Mark database connection failures as transient:
        return MarkRetryable(fmt.Errorf("database query failed: %w", err))
    }

    if account.Balance < amount {
        return fmt.Errorf("%w: balance %d < requested %d", ErrInsufficientFunds, account.Balance, amount)
    }

    if err := s.gateway.Debit(ctx, accountID, amount); err != nil {
        return MarkRetryable(fmt.Errorf("%w: %w", ErrGatewayTimeout, err))
    }
    return nil
}
```

Now, callers evaluate intent with `errors.Is(err, ErrAccountNotFound)` and retry logic with `if IsRetryable(err) { retry() }`, completely decoupled from SQL or HTTP wire details.

---

### Choosing the Right Pattern

Most Go functions handle errors with the `if err != nil { return err }` pattern. Reach for more elaborate patterns only when the simple one fails to express something important: Result types for functional pipelines, errgroup for concurrent operations, typed errors for callers who need to branch. The elaborate patterns have costs (complexity, unfamiliarity, non-idiomatic feel), so do not use them by default.

---
