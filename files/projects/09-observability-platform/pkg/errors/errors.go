// pkg/errors/errors.go
package errors

import (
    "errors"
    "fmt"
)

// Common error types
var (
    ErrNotFound          = errors.New("not found")
    ErrAlreadyExists     = errors.New("already exists")
    ErrInvalidInput      = errors.New("invalid input")
    ErrUnauthorized      = errors.New("unauthorized")
    ErrForbidden         = errors.New("forbidden")
    ErrTooManyRequests   = errors.New("too many requests")
    ErrInternal          = errors.New("internal error")
    ErrTimeout           = errors.New("timeout")
    ErrUnavailable       = errors.New("service unavailable")
    ErrQuotaExceeded     = errors.New("quota exceeded")
)

// ObservabilityError wraps errors with context
type ObservabilityError struct {
    Op      string // Operation that failed
    Kind    error  // Error kind
    Err     error  // Underlying error
    Context map[string]any // Additional context
}

func (e *ObservabilityError) Error() string {
    if e.Err != nil {
        return fmt.Sprintf("%s: %v: %v", e.Op, e.Kind, e.Err)
    }
    return fmt.Sprintf("%s: %v", e.Op, e.Kind)
}

func (e *ObservabilityError) Unwrap() error {
    return e.Err
}

// E constructs an ObservabilityError
func E(op string, kind error, err error, context ...map[string]any) error {
    e := &ObservabilityError{
        Op:   op,
        Kind: kind,
        Err:  err,
    }

    if len(context) > 0 {
        e.Context = context[0]
    }

    return e
}

// IsNotFound checks if error is not found
func IsNotFound(err error) bool {
    return errors.Is(err, ErrNotFound)
}

// IsUnauthorized checks if error is unauthorized
func IsUnauthorized(err error) bool {
    return errors.Is(err, ErrUnauthorized)
}

// IsQuotaExceeded checks if error is quota exceeded
func IsQuotaExceeded(err error) bool {
    return errors.Is(err, ErrQuotaExceeded)
}
