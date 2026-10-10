## 80.6 Error Handling Interview Questions

**Q: Describe error handling patterns in Go. What's the difference between errors.Is and errors.As?**

```go
package main

import (
    "errors"
    "fmt"
    "net"
)

// Custom error types
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation error on %s: %s", e.Field, e.Message)
}

// Sentinel errors
var (
    ErrNotFound     = errors.New("not found")
    ErrUnauthorized = errors.New("unauthorized")
)

func main() {
    // errors.Is - check for specific error (or wrapped)
    err := fmt.Errorf("database: %w", ErrNotFound)

    if errors.Is(err, ErrNotFound) {
        fmt.Println("Handle not found")
    }

    // errors.As - extract specific error type (or wrapped)
    var valErr *ValidationError
    err = fmt.Errorf("request: %w", &ValidationError{
        Field:   "email",
        Message: "invalid format",
    })

    if errors.As(err, &valErr) {
        fmt.Printf("Invalid field: %s\n", valErr.Field)
    }
}

// Error wrapping with context
func processUser(id string) error {
    user, err := fetchUser(id)
    if err != nil {
        return fmt.Errorf("processUser(%s): %w", id, err)
    }

    if err := validateUser(user); err != nil {
        return fmt.Errorf("processUser(%s): validate: %w", id, err)
    }

    return nil
}

// Multiple error handling patterns
func handleErrors(err error) {
    // Pattern 1: Type switch
    switch e := err.(type) {
    case *ValidationError:
        fmt.Printf("Validation: %s\n", e.Field)
    case *net.OpError:
        fmt.Printf("Network: %v\n", e.Op)
    default:
        fmt.Printf("Unknown: %v\n", err)
    }

    // Pattern 2: errors.Is for sentinel errors
    if errors.Is(err, ErrNotFound) {
        // Handle not found
    }

    // Pattern 3: errors.As for typed errors
    var valErr *ValidationError
    if errors.As(err, &valErr) {
        // Handle validation
    }
}

// Stub functions for demonstration
func fetchUser(id string) (string, error) { return id, nil }
func validateUser(user string) error       { return nil }

// Ensure net import is used
var _ *net.OpError

// Difference between Is and As:
/*
errors.Is:
- Checks if error (or wrapped) equals target
- Works with sentinel errors (error values)
- Uses error.Is method if defined

errors.As:
- Extracts error of specific type
- Works with error types (structs)
- Unwraps and checks each error in chain
*/
```

---

### Junior → FAANG: Error Handling as a Readability and Reliability Signal

Error handling questions are among the most frequently asked Go-specific questions in phone screens. The common junior mistake is treating Go error handling as verbose boilerplate rather than explicit control flow. Interviewers notice when a candidate understands this distinction.

Know the four patterns cold: sentinel errors (`io.EOF`), error types (custom structs with an `Error()` method), `errors.Is` for value comparison, and `errors.As` for type extraction. Being able to write a correct custom error type that wraps an upstream error, and then unwrap it with `errors.As`, is the L4 baseline.

First-job habit: in every function you write during preparation, ask "what is the error contract for this function?" Defining the contract explicitly (does it wrap, does it use sentinel errors, what does `nil` mean here) trains the discipline that makes your interview answers precise rather than vague.

### Senior @ FAANG: Error Design as API and Contract Design

At L5/L6, error handling questions are really questions about API design and operational reliability. The interviewer is assessing whether you understand that error types are part of your public API and that changing them is a breaking change.

Production-level error thinking: errors in Go carry both a message (for logs and humans) and an identity (for programmatic handling via `errors.Is`/`errors.As`). A senior engineer designs error hierarchies with both consumers in mind. For example, a database layer that wraps `pgx` errors with domain-specific error types lets the service layer make routing decisions without depending on the database driver's error types. This decoupling is an architecture decision, not just an error handling detail.

ADR framing: at FAANG scale, consistency in error handling across a service is enforced through linters, style guides, and code review checklists. A staff engineer should be able to describe a standard they established or adopted for error wrapping in their codebase, why it was chosen over alternatives (e.g., always wrap with `fmt.Errorf("context: %w", err)` versus using structured error types), and how compliance is verified in CI.

Bar-raiser signal: when asked about error handling in the context of observability, connect errors to structured logging, tracing span status, and alert routing. An error that is logged as a string is invisible to automated monitoring. An error that sets a span status code and includes a structured error code becomes queryable. This connection between error design and operational maturity is what separates L5 from L6 answers.
