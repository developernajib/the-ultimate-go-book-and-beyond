## Error Handling

Go handles errors explicitly through return values rather than exceptions. Functions that can fail return an `error` as their last return value, and callers are expected to check it immediately. Since Go 1.13, you can wrap errors with `fmt.Errorf("context: %w", err)` to add context while preserving the original error for inspection with `errors.Is` and `errors.As`. Define sentinel errors (package-level `var` values) for well-known error conditions, and create custom error types when you need to carry additional structured data.

```go
// Define error
import "errors"

err := errors.New("something went wrong")

// Formatted error
import "fmt"

err := fmt.Errorf("failed to open file: %s", filename)

// Wrap error (Go 1.13+)
err := fmt.Errorf("operation failed: %w", originalErr)

// Check if error
if err != nil {
    return err
}

// Unwrap error
unwrapped := errors.Unwrap(err)

// Check error type (Go 1.13+)
if errors.Is(err, os.ErrNotExist) {
    // File doesn't exist
}

// Extract error value (Go 1.13+)
var pathErr *os.PathError
if errors.As(err, &pathErr) {
    // Use pathErr
    fmt.Println(pathErr.Path)
}

// Custom error
type MyError struct {
    Code    int
    Message string
}

func (e *MyError) Error() string {
    return fmt.Sprintf("error %d: %s", e.Code, e.Message)
}

// Return custom error
func doSomething() error {
    return &MyError{Code: 42, Message: "bad things"}
}

// Sentinel errors
var (
    ErrNotFound     = errors.New("not found")
    ErrUnauthorized = errors.New("unauthorized")
    ErrInvalidInput = errors.New("invalid input")
)

// Check sentinel error
if errors.Is(err, ErrNotFound) {
    // Handle not found
}

// Multiple return values pattern
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, errors.New("division by zero")
    }
    return a / b, nil
}

result, err := divide(10, 2)
if err != nil {
    return err
}

// Defer error handling
func doWork() (err error) {
    f, err := os.Open("file.txt")
    if err != nil {
        return err
    }
    defer func() {
        if closeErr := f.Close(); closeErr != nil && err == nil {
            err = closeErr
        }
    }()
    // Work with file
    return nil
}

// Panic and recover
func risky() {
    defer func() {
        if r := recover(); r != nil {
            fmt.Println("Recovered:", r)
        }
    }()

    panic("something bad happened")
}

// Error groups (collect multiple errors)
type ErrorList []error

func (e ErrorList) Error() string {
    var msgs []string
    for _, err := range e {
        msgs = append(msgs, err.Error())
    }
    return strings.Join(msgs, "; ")
}

// Join errors (Go 1.20+)
err1 := errors.New("error 1")
err2 := errors.New("error 2")
err := errors.Join(err1, err2)

// Check any joined error
if errors.Is(err, err1) {
    // err1 is in the joined errors
}

// Common patterns
// Don't ignore errors
data, _ := os.ReadFile("file.txt")  // BAD!

// Always check
data, err := os.ReadFile("file.txt")
if err != nil {
    return fmt.Errorf("read file: %w", err)
}

// Add context when wrapping
if err := save(data); err != nil {
    return fmt.Errorf("save user %s: %w", userID, err)
}

// Validate inputs early
func process(input string) error {
    if input == "" {
        return errors.New("input cannot be empty")
    }
    // Process
    return nil
}
```

---
