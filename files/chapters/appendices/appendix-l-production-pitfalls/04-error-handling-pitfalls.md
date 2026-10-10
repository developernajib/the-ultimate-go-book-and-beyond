## Error Handling Pitfalls

Go's explicit error handling (`val, err := fn()`) forces developers to acknowledge failures at the call site. However, subtle semantic traps in Go's type system can turn error handling into a source of silent bugs and production panics.

---

### 1. The `nil` Interface Wrapping a `nil` Pointer

#### Root Cause Mechanics
An interface in Go is represented as a pair: `(Type, Data)`. An interface is `nil` if and only if **both** the type descriptor and the data pointer are `nil`. If a function returns a concrete pointer type (e.g. `*CustomError`) that is `nil`, and the caller assigns it to the built-in `error` interface, the interface's Type is `*CustomError` while its Data is `nil`. As a result, checking `if err != nil` evaluates to **true**!

#### Vulnerable Code
```go
type ValidationError struct {
    Field string
}

func (e *ValidationError) Error() string {
    return "invalid field: " + e.Field
}

// BUG: Returning a concrete pointer type instead of the error interface
func ValidateUser(name string) *ValidationError {
    if name == "" {
        return &ValidationError{Field: "name"}
    }
    return nil // Returns (*ValidationError)(nil)
}

func main() {
    var err error = ValidateUser("Alice")
    if err != nil { // EVALUATES TO TRUE! Interface contains non-nil type descriptor!
        fmt.Println("Validation failed unexpectedly!") // Silent production bug
    }
}
```

#### Production-Grade Solution
```go
// FIX: Always return the error interface type directly, never concrete pointers
func ValidateUserSafe(name string) error {
    if name == "" {
        return &ValidationError{Field: "name"}
    }
    return nil // Pure nil interface: (nil, nil)
}
```

---

### 2. Error Wrapping vs Direct Equality (`==`)

#### Root Cause Mechanics
Since Go 1.13, errors wrapped with `fmt.Errorf("%w", err)` encapsulate internal error chains. Using direct equality (`if err == ErrNotFound`) fails if the error was wrapped with context anywhere in the call stack.

#### Production-Grade Solution
```go
// WRONG: Breaks if error was wrapped with fmt.Errorf("...: %w", ErrNotFound)
if err == sql.ErrNoRows { ... }

// RIGHT: Traverses the error unwrapping chain
if errors.Is(err, sql.ErrNoRows) {
    // Correctly detects wrapped ErrNoRows
}

// For custom error types, use errors.As:
var valErr *ValidationError
if errors.As(err, &valErr) {
    fmt.Printf("Field %s failed validation", valErr.Field)
}
```
