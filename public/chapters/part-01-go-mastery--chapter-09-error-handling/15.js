export default `## 9.14 Exercises with Solutions

These exercises build progressively from a basic HTTP error handler to a complete retry system with error classification. Each solution is a self-contained program you can run directly with \`go run\`.

### Exercise 1: HTTP Error Handler

Create a complete HTTP error handler that:
- Converts errors to JSON responses
- Logs errors with context
- Handles panics

**Solution:**

\`\`\`go
package main

import (
    "encoding/json"
    "errors"
    "fmt"
    "log/slog"
    "net/http"
    "runtime/debug"
)

type ErrorCode string

const (
    ErrNotFound    ErrorCode = "NOT_FOUND"
    ErrBadRequest  ErrorCode = "BAD_REQUEST"
    ErrInternal    ErrorCode = "INTERNAL_ERROR"
    ErrUnauthorized ErrorCode = "UNAUTHORIZED"
)

type APIError struct {
    Code    ErrorCode \`json:"code"\`
    Message string    \`json:"message"\`
    cause   error
}

func (e *APIError) Error() string {
    if e.cause != nil {
        return fmt.Sprintf("%s: %s (%v)", e.Code, e.Message, e.cause)
    }
    return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *APIError) Unwrap() error { return e.cause }

func (e *APIError) HTTPStatus() int {
    switch e.Code {
    case ErrNotFound:
        return http.StatusNotFound
    case ErrBadRequest:
        return http.StatusBadRequest
    case ErrUnauthorized:
        return http.StatusUnauthorized
    default:
        return http.StatusInternalServerError
    }
}

// Error constructors
func NotFound(resource string) *APIError {
    return &APIError{Code: ErrNotFound, Message: resource + " not found"}
}

func BadRequest(msg string) *APIError {
    return &APIError{Code: ErrBadRequest, Message: msg}
}

func Internal(err error) *APIError {
    return &APIError{Code: ErrInternal, Message: "internal error", cause: err}
}

// ErrorHandler wraps an error-returning handler
func ErrorHandler(logger *slog.Logger, fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Panic recovery
        defer func() {
            if rec := recover(); rec != nil {
                logger.Error("panic",
                    "recover", rec,
                    "stack", string(debug.Stack()),
                    "path", r.URL.Path,
                )
                writeError(w, Internal(fmt.Errorf("panic: %v", rec)))
            }
        }()

        err := fn(w, r)
        if err == nil {
            return
        }

        // Log the error
        logger.Error("request error",
            "error", err.Error(),
            "path", r.URL.Path,
            "method", r.Method,
        )

        // Convert to APIError
        var apiErr *APIError
        if !errors.As(err, &apiErr) {
            apiErr = Internal(err)
        }

        writeError(w, apiErr)
    }
}

func writeError(w http.ResponseWriter, err *APIError) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(err.HTTPStatus())
    json.NewEncoder(w).Encode(map[string]any{
        "error": map[string]any{
            "code":    err.Code,
            "message": err.Message,
        },
    })
}

// Example usage
func main() {
    logger := slog.Default()

    http.HandleFunc("/users/{id}", ErrorHandler(logger, func(w http.ResponseWriter, r *http.Request) error {
        id := r.PathValue("id")
        if id == "" {
            return BadRequest("id required")
        }
        if id == "999" {
            return NotFound("user")
        }

        json.NewEncoder(w).Encode(map[string]string{"id": id, "name": "John"})
        return nil
    }))

    http.HandleFunc("/panic", ErrorHandler(logger, func(w http.ResponseWriter, r *http.Request) error {
        panic("test panic")
    }))

    http.ListenAndServe(":8080", nil)
}
\`\`\`

### Exercise 2: Validation Error Collector

Create a validation system that collects all field errors before returning, rather than failing on the first invalid field. The \`ValidationErrors\` type should implement the \`error\` interface and support Go 1.20's \`Unwrap() []error\` for chain inspection.

**Solution:**

\`\`\`go
package main

import (
    "errors"
    "fmt"
    "regexp"
    "strings"
)

type FieldError struct {
    Field   string
    Message string
}

func (e FieldError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

type ValidationErrors struct {
    Errors []FieldError
}

func (e *ValidationErrors) Error() string {
    if len(e.Errors) == 0 {
        return "validation passed"
    }
    var msgs []string
    for _, fe := range e.Errors {
        msgs = append(msgs, fe.Error())
    }
    return strings.Join(msgs, "; ")
}

func (e *ValidationErrors) Add(field, message string) {
    e.Errors = append(e.Errors, FieldError{Field: field, Message: message})
}

func (e *ValidationErrors) HasErrors() bool {
    return len(e.Errors) > 0
}

func (e *ValidationErrors) ToError() error {
    if !e.HasErrors() {
        return nil
    }
    return e
}

// Implement Unwrap to return slice of errors (Go 1.20+)
func (e *ValidationErrors) Unwrap() []error {
    errs := make([]error, len(e.Errors))
    for i, fe := range e.Errors {
        errs[i] = fe
    }
    return errs
}

// User represents a user to validate
type User struct {
    Name     string
    Email    string
    Age      int
    Password string
}

var emailRegex = regexp.MustCompile(\`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\$\`)

func ValidateUser(u User) error {
    errs := &ValidationErrors{}

    // Name validation
    if strings.TrimSpace(u.Name) == "" {
        errs.Add("name", "is required")
    } else if len(u.Name) < 2 {
        errs.Add("name", "must be at least 2 characters")
    } else if len(u.Name) > 100 {
        errs.Add("name", "must be at most 100 characters")
    }

    // Email validation
    if strings.TrimSpace(u.Email) == "" {
        errs.Add("email", "is required")
    } else if !emailRegex.MatchString(u.Email) {
        errs.Add("email", "is invalid")
    }

    // Age validation
    if u.Age < 0 {
        errs.Add("age", "cannot be negative")
    } else if u.Age < 13 {
        errs.Add("age", "must be at least 13")
    } else if u.Age > 150 {
        errs.Add("age", "is invalid")
    }

    // Password validation
    if u.Password == "" {
        errs.Add("password", "is required")
    } else {
        if len(u.Password) < 8 {
            errs.Add("password", "must be at least 8 characters")
        }
        if !strings.ContainsAny(u.Password, "0123456789") {
            errs.Add("password", "must contain a number")
        }
        if !strings.ContainsAny(u.Password, "!@#\$%^&*") {
            errs.Add("password", "must contain a special character")
        }
    }

    return errs.ToError()
}

func main() {
    user := User{
        Name:     "J",
        Email:    "invalid",
        Age:      10,
        Password: "short",
    }

    err := ValidateUser(user)
    if err != nil {
        fmt.Println("Validation failed:")

        var valErrs *ValidationErrors
        if errors.As(err, &valErrs) {
            for _, fe := range valErrs.Errors {
                fmt.Printf("  - %s: %s\\n", fe.Field, fe.Message)
            }
        }
    }
}

// Output:
// Validation failed:
//   - name: must be at least 2 characters
//   - email: is invalid
//   - age: must be at least 13
//   - password: must be at least 8 characters
//   - password: must contain a number
//   - password: must contain a special character
\`\`\`

### Exercise 3: Retry with Error Classification

Create a generic retry function that classifies errors as retryable or permanent. The retry logic should use exponential backoff with jitter, respect context cancellation, and stop immediately on permanent errors. Two marker types (\`RetryableError\` and \`PermanentError\`) control the classification.

**Solution:**

\`\`\`go
package main

import (
    "context"
    "errors"
    "fmt"
    "math/rand/v2"
    "net"
    "time"
)

// RetryableError indicates an error can be retried
type RetryableError struct {
    Err error
}

func (e RetryableError) Error() string {
    return e.Err.Error()
}

func (e RetryableError) Unwrap() error {
    return e.Err
}

// PermanentError indicates an error should not be retried
type PermanentError struct {
    Err error
}

func (e PermanentError) Error() string {
    return e.Err.Error()
}

func (e PermanentError) Unwrap() error {
    return e.Err
}

// IsRetryable determines if an error can be retried
func IsRetryable(err error) bool {
    if err == nil {
        return false
    }

    // Check for explicit retryable error
    var retryable RetryableError
    if errors.As(err, &retryable) {
        return true
    }

    // Check for explicit permanent error
    var permanent PermanentError
    if errors.As(err, &permanent) {
        return false
    }

    // Network errors are usually retryable
    var netErr net.Error
    if errors.As(err, &netErr) {
        return netErr.Timeout() || netErr.Temporary()
    }

    // Context deadline is retryable, canceled is not
    if errors.Is(err, context.DeadlineExceeded) {
        return true
    }
    if errors.Is(err, context.Canceled) {
        return false
    }

    // Default: don't retry unknown errors
    return false
}

// RetryConfig configures retry behavior
type RetryConfig struct {
    MaxAttempts  int
    InitialDelay time.Duration
    MaxDelay     time.Duration
    Multiplier   float64
    Jitter       float64
}

var DefaultRetryConfig = RetryConfig{
    MaxAttempts:  3,
    InitialDelay: 100 * time.Millisecond,
    MaxDelay:     10 * time.Second,
    Multiplier:   2.0,
    Jitter:       0.1,
}

// Retry executes fn with retries for retryable errors
func Retry[T any](ctx context.Context, cfg RetryConfig, fn func() (T, error)) (T, error) {
    var lastErr error
    var zero T
    delay := cfg.InitialDelay

    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        // Check context before attempt
        if ctx.Err() != nil {
            return zero, ctx.Err()
        }

        result, err := fn()
        if err == nil {
            return result, nil
        }

        lastErr = err

        // Don't retry permanent errors
        if !IsRetryable(err) {
            return zero, err
        }

        // Don't sleep after last attempt
        if attempt < cfg.MaxAttempts-1 {
            // Add jitter
            jitter := time.Duration(float64(delay) * cfg.Jitter * (rand.Float64()*2 - 1))
            sleepDuration := delay + jitter

            select {
            case <-ctx.Done():
                return zero, ctx.Err()
            case <-time.After(sleepDuration):
            }

            // Increase delay for next attempt
            delay = time.Duration(float64(delay) * cfg.Multiplier)
            if delay > cfg.MaxDelay {
                delay = cfg.MaxDelay
            }
        }
    }

    return zero, fmt.Errorf("max retries exceeded: %w", lastErr)
}

// Example usage
func main() {
    ctx := context.Background()

    // Simulate flaky operation
    attempts := 0
    result, err := Retry(ctx, DefaultRetryConfig, func() (string, error) {
        attempts++
        fmt.Printf("Attempt %d\\n", attempts)

        if attempts < 3 {
            // Simulate temporary failure
            return "", RetryableError{Err: errors.New("temporary failure")}
        }
        return "success", nil
    })

    if err != nil {
        fmt.Printf("Failed: %v\\n", err)
    } else {
        fmt.Printf("Result: %s\\n", result)
    }

    // Test with permanent error
    _, err = Retry(ctx, DefaultRetryConfig, func() (string, error) {
        return "", PermanentError{Err: errors.New("invalid input")}
    })
    fmt.Printf("Permanent error (not retried): %v\\n", err)
}

// Output:
// Attempt 1
// Attempt 2
// Attempt 3
// Result: success
// Permanent error (not retried): invalid input
\`\`\`

### Exercise 4: Error Chain Analysis

Write a function that walks an error chain using \`errors.Unwrap\`, collects the type and message at each depth level, and produces a structured analysis. This exercise reinforces how wrapped errors form a linked list that \`errors.Is\` and \`errors.As\` traverse internally.

**Solution:**

\`\`\`go
package main

import (
    "errors"
    "fmt"
    "io"
    "os"
)

type ErrorInfo struct {
    Type    string
    Message string
    Depth   int
}

type ChainAnalysis struct {
    Errors       []ErrorInfo
    TotalDepth   int
    RootCause    string
    ContainsType map[string]bool
}

func AnalyzeErrorChain(err error) ChainAnalysis {
    analysis := ChainAnalysis{
        ContainsType: make(map[string]bool),
    }

    if err == nil {
        return analysis
    }

    depth := 0
    for e := err; e != nil; {
        info := ErrorInfo{
            Type:    fmt.Sprintf("%T", e),
            Message: e.Error(),
            Depth:   depth,
        }
        analysis.Errors = append(analysis.Errors, info)
        analysis.ContainsType[info.Type] = true
        analysis.RootCause = e.Error()

        // Handle multi-error unwrap (Go 1.20+)
        if unwrapper, ok := e.(interface{ Unwrap() []error }); ok {
            errs := unwrapper.Unwrap()
            if len(errs) > 0 {
                e = errs[0] // Follow first error in chain
            } else {
                e = nil
            }
        } else {
            e = errors.Unwrap(e)
        }
        depth++
    }

    analysis.TotalDepth = depth
    return analysis
}

func PrintChainAnalysis(a ChainAnalysis) {
    fmt.Printf("Error Chain Analysis:\\n")
    fmt.Printf("  Total Depth: %d\\n", a.TotalDepth)
    fmt.Printf("  Root Cause: %s\\n", a.RootCause)
    fmt.Printf("\\n  Chain:\\n")
    for _, info := range a.Errors {
        indent := ""
        for i := 0; i < info.Depth; i++ {
            indent += "  "
        }
        fmt.Printf("    %s[%d] %s\\n", indent, info.Depth, info.Type)
        fmt.Printf("    %s    Message: %s\\n", indent, info.Message)
    }
    fmt.Printf("\\n  Contains Types:\\n")
    for t := range a.ContainsType {
        fmt.Printf("    - %s\\n", t)
    }
}

func main() {
    // Create a wrapped error chain
    err1 := os.ErrNotExist
    err2 := fmt.Errorf("open config.yaml: %w", err1)
    err3 := fmt.Errorf("load configuration: %w", err2)
    err4 := fmt.Errorf("initialize application: %w", err3)

    analysis := AnalyzeErrorChain(err4)
    PrintChainAnalysis(analysis)

    fmt.Println("\\n--- Checking standard errors ---")
    fmt.Printf("Contains os.ErrNotExist: %v\\n", errors.Is(err4, os.ErrNotExist))
    fmt.Printf("Contains io.EOF: %v\\n", errors.Is(err4, io.EOF))
}

// Output:
// Error Chain Analysis:
//   Total Depth: 4
//   Root Cause: file does not exist
//
//   Chain:
//     [0] *fmt.wrapError
//         Message: initialize application: load configuration: open config.yaml: file does not exist
//       [1] *fmt.wrapError
//           Message: load configuration: open config.yaml: file does not exist
//         [2] *fmt.wrapError
//             Message: open config.yaml: file does not exist
//           [3] *errors.errorString
//               Message: file does not exist
//
//   Contains Types:
//     - *fmt.wrapError
//     - *errors.errorString
//
// --- Checking standard errors ---
// Contains os.ErrNotExist: true
// Contains io.EOF: false
\`\`\`

### Exercise 5: Domain Error Hierarchy

Design a domain error hierarchy for an e-commerce application with three failure domains: inventory (out of stock, invalid SKU), payment (card declined, fraud suspected), and orders (invalid state transitions). Each domain error embeds a base \`DomainError\` type that supports \`errors.Is\` matching by domain and code.

**Solution:**

\`\`\`go
package main

import (
    "errors"
    "fmt"
    "time"
)

// Base domain error
type DomainError struct {
    Domain    string
    Code      string
    Message   string
    Timestamp time.Time
    cause     error
}

func (e *DomainError) Error() string {
    if e.cause != nil {
        return fmt.Sprintf("[%s.%s] %s: %v", e.Domain, e.Code, e.Message, e.cause)
    }
    return fmt.Sprintf("[%s.%s] %s", e.Domain, e.Code, e.Message)
}

func (e *DomainError) Unwrap() error {
    return e.cause
}

func (e *DomainError) Is(target error) bool {
    if t, ok := target.(*DomainError); ok {
        return e.Domain == t.Domain && e.Code == t.Code
    }
    return false
}

// Domain-specific error factories

// Inventory errors
var (
    ErrOutOfStock   = &DomainError{Domain: "inventory", Code: "OUT_OF_STOCK"}
    ErrInvalidSKU   = &DomainError{Domain: "inventory", Code: "INVALID_SKU"}
    ErrReserveLimit = &DomainError{Domain: "inventory", Code: "RESERVE_LIMIT"}
)

type InventoryError struct {
    *DomainError
    SKU       string
    Requested int
    Available int
}

func OutOfStock(sku string, requested, available int) *InventoryError {
    return &InventoryError{
        DomainError: &DomainError{
            Domain:    "inventory",
            Code:      "OUT_OF_STOCK",
            Message:   fmt.Sprintf("insufficient stock for %s", sku),
            Timestamp: time.Now(),
        },
        SKU:       sku,
        Requested: requested,
        Available: available,
    }
}

// Payment errors
var (
    ErrCardDeclined     = &DomainError{Domain: "payment", Code: "CARD_DECLINED"}
    ErrInsufficientFunds = &DomainError{Domain: "payment", Code: "INSUFFICIENT_FUNDS"}
    ErrPaymentTimeout   = &DomainError{Domain: "payment", Code: "TIMEOUT"}
    ErrFraudSuspected   = &DomainError{Domain: "payment", Code: "FRAUD_SUSPECTED"}
)

type PaymentError struct {
    *DomainError
    TransactionID string
    Amount        float64
    DeclineCode   string
}

func CardDeclined(txnID string, amount float64, declineCode string) *PaymentError {
    return &PaymentError{
        DomainError: &DomainError{
            Domain:    "payment",
            Code:      "CARD_DECLINED",
            Message:   "card was declined",
            Timestamp: time.Now(),
        },
        TransactionID: txnID,
        Amount:        amount,
        DeclineCode:   declineCode,
    }
}

// Order errors
var (
    ErrOrderNotFound = &DomainError{Domain: "order", Code: "NOT_FOUND"}
    ErrOrderCanceled = &DomainError{Domain: "order", Code: "CANCELED"}
    ErrInvalidState  = &DomainError{Domain: "order", Code: "INVALID_STATE"}
)

type OrderError struct {
    *DomainError
    OrderID      string
    CurrentState string
    AttemptedAction string
}

func InvalidOrderState(orderID, currentState, action string) *OrderError {
    return &OrderError{
        DomainError: &DomainError{
            Domain:    "order",
            Code:      "INVALID_STATE",
            Message:   fmt.Sprintf("cannot %s order in %s state", action, currentState),
            Timestamp: time.Now(),
        },
        OrderID:         orderID,
        CurrentState:    currentState,
        AttemptedAction: action,
    }
}

// Error handling utilities

func IsDomainError(err error, domain, code string) bool {
    target := &DomainError{Domain: domain, Code: code}
    return errors.Is(err, target)
}

func IsInventoryError(err error) bool {
    var invErr *InventoryError
    return errors.As(err, &invErr)
}

func IsPaymentError(err error) bool {
    var payErr *PaymentError
    return errors.As(err, &payErr)
}

func IsRetryablePaymentError(err error) bool {
    var payErr *PaymentError
    if !errors.As(err, &payErr) {
        return false
    }

    // Only timeout errors are retryable
    return errors.Is(payErr, ErrPaymentTimeout)
}

// Example usage
func ProcessOrder(orderID string) error {
    // Simulate inventory check
    if err := checkInventory("SKU-123", 5); err != nil {
        return fmt.Errorf("process order %s: %w", orderID, err)
    }

    // Simulate payment
    if err := processPayment(orderID, 99.99); err != nil {
        return fmt.Errorf("process order %s: %w", orderID, err)
    }

    return nil
}

func checkInventory(sku string, qty int) error {
    available := 3 // Simulated
    if qty > available {
        return OutOfStock(sku, qty, available)
    }
    return nil
}

func processPayment(orderID string, amount float64) error {
    // Simulated decline
    return CardDeclined("TXN-"+orderID, amount, "insufficient_funds")
}

func main() {
    err := ProcessOrder("ORD-001")
    if err == nil {
        fmt.Println("Order processed successfully")
        return
    }

    fmt.Printf("Order failed: %v\\n\\n", err)

    // Check error types
    fmt.Println("Error analysis:")

    if IsDomainError(err, "inventory", "OUT_OF_STOCK") {
        fmt.Println("- Out of stock error detected")

        var invErr *InventoryError
        if errors.As(err, &invErr) {
            fmt.Printf("  SKU: %s, Requested: %d, Available: %d\\n",
                invErr.SKU, invErr.Requested, invErr.Available)
        }
    }

    if IsDomainError(err, "payment", "CARD_DECLINED") {
        fmt.Println("- Payment declined error detected")

        var payErr *PaymentError
        if errors.As(err, &payErr) {
            fmt.Printf("  Transaction: %s, Amount: \$%.2f, Code: %s\\n",
                payErr.TransactionID, payErr.Amount, payErr.DeclineCode)
        }
    }

    fmt.Printf("\\nRetryable: %v\\n", IsRetryablePaymentError(err))
}

// Output:
// Order failed: process order ORD-001: insufficient stock for SKU-123
//
// Error analysis:
// - Out of stock error detected
//   SKU: SKU-123, Requested: 5, Available: 3
//
// Retryable: false
\`\`\`

### Senior at FAANG Track

7. **Team error-handling discipline authorship.** Write the team's guide covering: wrapping rules, sentinel vs typed decision, error envelope format, observability integration. Publish.

8. **Cross-service error contract.** Define the error envelope for inter-service calls on your team. Codes, messages, retry semantics. Document.

9. **Error-handling audit.** For one service, audit error handling: which sites wrap, which do not, which leak sensitive data. File remediation PRs.

10. **Observability integration.** Wire errors to metrics (error rate by code), logs (structured fields, one line per error), and traces (error annotations on spans). Demonstrate the full flow.

---
`;
