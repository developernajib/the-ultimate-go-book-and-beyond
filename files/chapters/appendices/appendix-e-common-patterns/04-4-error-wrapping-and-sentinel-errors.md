## 4. Error Wrapping and Sentinel Errors

Go 1.13+ provides error wrapping. Sentinel errors enable error type checking.

### Error Wrapping

Use `fmt.Errorf` with `%w` to wrap errors with context while preserving the original error for `errors.Is` and `errors.As` checks. Each layer of your call stack should add context describing what it was doing when the error occurred.

```go
package errors

import (
    "errors"
    "fmt"
)

// Example service errors
var (
    ErrNotFound      = errors.New("not found")
    ErrUnauthorized  = errors.New("unauthorized")
    ErrInvalidInput  = errors.New("invalid input")
    ErrDatabase      = errors.New("database error")
    ErrNetwork       = errors.New("network error")
)

// User represents a user
type User struct {
    ID   int
    Name string
}

// UserRepository handles user storage
type UserRepository struct{}

// FindByID demonstrates error wrapping
func (r *UserRepository) FindByID(id int) (*User, error) {
    // Simulate database error
    if id < 0 {
        return nil, fmt.Errorf("invalid user ID %d: %w", id, ErrInvalidInput)
    }

    if id == 0 {
        return nil, fmt.Errorf("user %d: %w", id, ErrNotFound)
    }

    // Simulate database connection error
    if id == 999 {
        dbErr := errors.New("connection timeout")
        return nil, fmt.Errorf("failed to query user %d: %w: %w", id, ErrDatabase, dbErr)
    }

    return &User{ID: id, Name: "Test User"}, nil
}

// UserService handles user business logic
type UserService struct {
    repo *UserRepository
}

// GetUser demonstrates error propagation
func (s *UserService) GetUser(id int) (*User, error) {
    user, err := s.repo.FindByID(id)
    if err != nil {
        return nil, fmt.Errorf("UserService.GetUser(%d): %w", id, err)
    }
    return user, nil
}

// HandleUserRequest demonstrates error checking
func HandleUserRequest(service *UserService, id int) {
    user, err := service.GetUser(id)
    if err != nil {
        // Check for specific error types
        if errors.Is(err, ErrNotFound) {
            fmt.Printf("User not found: %v\n", err)
            return
        }

        if errors.Is(err, ErrInvalidInput) {
            fmt.Printf("Invalid input: %v\n", err)
            return
        }

        if errors.Is(err, ErrDatabase) {
            fmt.Printf("Database error: %v\n", err)
            return
        }

        fmt.Printf("Unknown error: %v\n", err)
        return
    }

    fmt.Printf("Found user: %s\n", user.Name)
}
```

### Custom Error Types

```go
package errors

import (
    "fmt"
)

// ValidationError represents validation failures
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed for %s: %s", e.Field, e.Message)
}

// NotFoundError represents resource not found
type NotFoundError struct {
    Resource string
    ID       any
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s with id %v not found", e.Resource, e.ID)
}

// AuthorizationError represents permission denied
type AuthorizationError struct {
    User      string
    Resource  string
    Operation string
}

func (e *AuthorizationError) Error() string {
    return fmt.Sprintf("%s not authorized to %s %s", e.User, e.Operation, e.Resource)
}

// MultiError aggregates multiple errors
type MultiError struct {
    Errors []error
}

func (e *MultiError) Error() string {
    if len(e.Errors) == 0 {
        return "no errors"
    }
    if len(e.Errors) == 1 {
        return e.Errors[0].Error()
    }
    return fmt.Sprintf("%d errors occurred: %v", len(e.Errors), e.Errors[0])
}

// Add appends an error
func (e *MultiError) Add(err error) {
    if err != nil {
        e.Errors = append(e.Errors, err)
    }
}

// HasErrors returns true if any errors exist
func (e *MultiError) HasErrors() bool {
    return len(e.Errors) > 0
}

// ErrorOrNil returns nil if no errors, otherwise returns itself
func (e *MultiError) ErrorOrNil() error {
    if len(e.Errors) == 0 {
        return nil
    }
    return e
}

// Example usage of custom errors
func ValidateUser(name, email string) error {
    var errs MultiError

    if name == "" {
        errs.Add(&ValidationError{Field: "name", Message: "cannot be empty"})
    }

    if email == "" {
        errs.Add(&ValidationError{Field: "email", Message: "cannot be empty"})
    } else if !isValidEmail(email) {
        errs.Add(&ValidationError{Field: "email", Message: "invalid format"})
    }

    return errs.ErrorOrNil()
}

func isValidEmail(email string) bool {
    // Simplified validation
    return len(email) > 3 && email[0] != '@'
}

// GetDocument demonstrates custom error usage
func GetDocument(docID string, userID string) (any, error) {
    // Check if document exists
    doc := findDocument(docID)
    if doc == nil {
        return nil, &NotFoundError{Resource: "document", ID: docID}
    }

    // Check authorization
    if !canAccess(userID, docID) {
        return nil, &AuthorizationError{
            User:      userID,
            Resource:  "document",
            Operation: "read",
        }
    }

    return doc, nil
}

func findDocument(id string) any {
    return nil // Simulated
}

func canAccess(userID, docID string) bool {
    return false // Simulated
}
```

---
