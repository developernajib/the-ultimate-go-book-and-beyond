export default `## Additional Error Handling Mistakes and Patterns

Beyond the classic "100 Go Mistakes" list, production Go code surfaces several additional patterns and anti-patterns that deserve dedicated attention. These cover newer language features, design decisions that compound over time, and library authoring mistakes that are easy to make and expensive to fix.

### Using errors.Join for Multiple Errors (Go 1.20+)

When multiple operations can fail independently, cleanup routines, batch validations, closing multiple resources, you need a way to collect all errors rather than discarding all but the first. Before Go 1.20, teams reached for third-party packages like \`uber-go/multierr\` or hand-rolled accumulation logic. Go 1.20 introduced \`errors.Join\` in the standard library, which combines multiple errors into a single error value that preserves full \`errors.Is\` and \`errors.As\` compatibility for every wrapped error.

**Cleanup code where multiple resources can each fail:**

\`\`\`go
// WRONG: Only the last close error is captured
func processFiles(paths []string) error {
    var files []*os.File
    for _, p := range paths {
        f, err := os.Open(p)
        if err != nil {
            // Close already-opened files, but ignore their errors
            for _, opened := range files {
                opened.Close() // Error silently discarded!
            }
            return fmt.Errorf("open %s: %w", p, err)
        }
        files = append(files, f)
    }

    defer func() {
        for _, f := range files {
            f.Close() // All close errors lost
        }
    }()

    return doWork(files)
}
\`\`\`

\`\`\`go
// CORRECT: Collect all close errors with errors.Join
func processFiles(paths []string) error {
    var files []*os.File
    for _, p := range paths {
        f, err := os.Open(p)
        if err != nil {
            // Close already-opened files, collecting ALL errors
            closeErr := closeAll(files)
            return errors.Join(fmt.Errorf("open %s: %w", p, err), closeErr)
        }
        files = append(files, f)
    }

    workErr := doWork(files)
    closeErr := closeAll(files)
    return errors.Join(workErr, closeErr)
}

// closeAll closes every file and returns a joined error for any failures
func closeAll(files []*os.File) error {
    var errs []error
    for _, f := range files {
        if err := f.Close(); err != nil {
            errs = append(errs, fmt.Errorf("close %s: %w", f.Name(), err))
        }
    }
    return errors.Join(errs...)
}
\`\`\`

**Validation that collects all field errors at once instead of failing fast:**

\`\`\`go
// WRONG: Fail-fast validation - caller only sees the first problem
func ValidateUser(u User) error {
    if u.Name == "" {
        return errors.New("name is required")
    }
    if u.Email == "" {
        return errors.New("email is required")
    }
    if u.Age < 0 || u.Age > 150 {
        return errors.New("age must be between 0 and 150")
    }
    return nil
}
\`\`\`

\`\`\`go
// CORRECT: Collect all validation errors - caller sees everything at once
func ValidateUser(u User) error {
    var errs []error

    if u.Name == "" {
        errs = append(errs, errors.New("name is required"))
    }
    if u.Email == "" {
        errs = append(errs, errors.New("email is required"))
    }
    if u.Age < 0 || u.Age > 150 {
        errs = append(errs, errors.New("age must be between 0 and 150"))
    }

    return errors.Join(errs...) // Returns nil if errs is empty
}

// The joined error supports Is/As for every individual error
func ExampleValidation() {
    u := User{Name: "", Email: "", Age: -1}
    err := ValidateUser(u)
    if err != nil {
        fmt.Println(err)
        // name is required
        // email is required
        // age must be between 0 and 150
    }
}
\`\`\`

**Key properties of \`errors.Join\`:**

- Returns \`nil\` if all arguments are \`nil\` - safe to call unconditionally
- The joined error's \`Error()\` string concatenates messages with newlines
- \`errors.Is\` and \`errors.As\` traverse all wrapped errors, not just the first
- Before Go 1.20, use \`go.uber.org/multierr\` for the same semantics, or accumulate into a \`[]error\` manually and format at the end

### Sentinel Errors vs Error Types, When to Use Which

Go gives you three tools for creating errors, and choosing the wrong one leads to either over-engineering or under-engineering. The decision is simpler than most developers make it:

1. **\`fmt.Errorf\` with \`%w\`** - the default choice for most errors. Adds context, preserves the chain, requires no new types.
2. **Sentinel errors** (\`var ErrNotFound = errors.New("not found")\`), for simple, fixed error conditions that callers need to check by identity.
3. **Error types** (\`type NotFoundError struct{...}\`), when the error must carry additional context beyond a fixed message.

**Sentinel errors, simple conditions, no extra data:**

\`\`\`go
package repository

import "errors"

// Sentinel errors: package-level, exported, Err prefix
var (
    ErrNotFound      = errors.New("repository: not found")
    ErrAlreadyExists = errors.New("repository: already exists")
    ErrOptimisticLock = errors.New("repository: optimistic lock conflict")
)

func (r *UserRepo) FindByID(id string) (*User, error) {
    row := r.db.QueryRow("SELECT ... WHERE id = \$1", id)
    var u User
    if err := row.Scan(&u.ID, &u.Name, &u.Email); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, ErrNotFound // Simple condition, no extra data needed
        }
        return nil, fmt.Errorf("find user %s: %w", id, err)
    }
    return &u, nil
}

// Caller uses errors.Is for sentinel matching
user, err := repo.FindByID("abc")
if errors.Is(err, repository.ErrNotFound) {
    // Return 404
}
\`\`\`

**Error types, when the error needs to carry structured data:**

\`\`\`go
package repository

// Error type: carries the entity kind and the ID that was not found
type NotFoundError struct {
    Entity string // "user", "order", "product"
    ID     string
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s %s not found", e.Entity, e.ID)
}

// Error type: carries all the fields that failed validation
type ValidationError struct {
    Field   string
    Message string
    Value   any
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed on %s: %s (got %v)", e.Field, e.Message, e.Value)
}

func (r *UserRepo) FindByID(id string) (*User, error) {
    row := r.db.QueryRow("SELECT ... WHERE id = \$1", id)
    var u User
    if err := row.Scan(&u.ID, &u.Name, &u.Email); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            // Error type because caller needs to know WHICH entity and ID
            return nil, &NotFoundError{Entity: "user", ID: id}
        }
        return nil, fmt.Errorf("find user %s: %w", id, err)
    }
    return &u, nil
}

// Caller uses errors.As to extract the structured data
user, err := repo.FindByID("abc")
var notFound *repository.NotFoundError
if errors.As(err, &notFound) {
    log.Printf("entity %s with ID %s not found", notFound.Entity, notFound.ID)
    // Return 404 with specific message
}
\`\`\`

**The anti-pattern, creating 50 sentinel errors in a package:**

\`\`\`go
// WRONG: Too many sentinels - this is a code smell
package payment

var (
    ErrInvalidAmount      = errors.New("invalid amount")
    ErrInvalidCurrency    = errors.New("invalid currency")
    ErrInvalidCardNumber  = errors.New("invalid card number")
    ErrInvalidExpiry      = errors.New("invalid expiry")
    ErrInvalidCVV         = errors.New("invalid CVV")
    ErrInvalidName        = errors.New("invalid name")
    ErrInvalidAddress     = errors.New("invalid address")
    ErrInvalidZip         = errors.New("invalid zip")
    ErrInvalidCountry     = errors.New("invalid country")
    ErrInvalidPhone       = errors.New("invalid phone")
    // ... 40 more sentinels
)
\`\`\`

\`\`\`go
// CORRECT: Use an error type when you have many related conditions
package payment

// Single error type replaces dozens of sentinels
type ValidationError struct {
    Field   string // "amount", "currency", "card_number", etc.
    Rule    string // "required", "format", "range"
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("payment validation: %s %s: %s", e.Field, e.Rule, e.Message)
}

// Caller checks for any validation error, then inspects the field
var valErr *ValidationError
if errors.As(err, &valErr) {
    switch valErr.Field {
    case "amount":
        // Handle invalid amount
    case "card_number":
        // Handle invalid card
    default:
        // Generic validation failure response
    }
}
\`\`\`

**Decision guide:**

| Situation | Use | Why |
|-----------|-----|-----|
| Simple, well-known condition | Sentinel (\`var ErrX = errors.New(...)\`) | No extra data needed, callers use \`errors.Is\` |
| Error needs structured context | Error type (\`type XError struct{...}\`) | Callers extract data with \`errors.As\` |
| Internal error, callers don't inspect | \`fmt.Errorf("context: %w", err)\` | No new types needed |
| Many related conditions in one category | Error type with a discriminator field | Avoids sentinel explosion |

### Using fmt.Errorf Without %w (Lost Error Chain)

This is one of the most common mistakes in Go code written after Go 1.13, and it is particularly insidious because the code compiles, runs, and even produces reasonable-looking error messages, but silently breaks \`errors.Is\` and \`errors.As\` for every caller up the stack.

The difference between \`%v\` and \`%w\` in \`fmt.Errorf\`:

- \`%v\` formats the error as a **string** - the original error is converted to text and embedded. The error chain is severed. \`errors.Is\` and \`errors.As\` cannot find the original error.
- \`%w\` **wraps** the error, the original error is preserved as a linked value. The chain remains intact for \`errors.Is\` and \`errors.As\`.

\`\`\`go
var ErrDatabase = errors.New("database error")

func queryUser(id string) error {
    return ErrDatabase
}

func fetchUser(id string) error {
    err := queryUser(id)
    if err != nil {
        // WRONG: %v converts to string - chain is LOST
        return fmt.Errorf("fetch user %s: %v", id, err)
    }
    return nil
}

func fetchUserCorrect(id string) error {
    err := queryUser(id)
    if err != nil {
        // CORRECT: %w wraps - chain is PRESERVED
        return fmt.Errorf("fetch user %s: %w", id, err)
    }
    return nil
}

func ExampleChainBehavior() {
    // Both produce the same Error() string:
    errV := fetchUser("abc")
    errW := fetchUserCorrect("abc")
    fmt.Println(errV) // fetch user abc: database error
    fmt.Println(errW) // fetch user abc: database error

    // But Is/As behavior is completely different:
    fmt.Println(errors.Is(errV, ErrDatabase)) // false - chain lost!
    fmt.Println(errors.Is(errW, ErrDatabase)) // true  - chain preserved
}
\`\`\`

**After Go 1.13, always use \`%w\` unless you deliberately want to hide the underlying error.** The only legitimate reason to use \`%v\` is when the wrapped error is an implementation detail that you do not want callers to depend on:

\`\`\`go
// Deliberate use of %v: hiding an implementation detail
// You don't want callers to check for the specific Redis error
// because you might switch to Memcached later
func (c *Cache) Get(key string) ([]byte, error) {
    val, err := c.redis.Get(ctx, key).Bytes()
    if err != nil {
        // %v intentionally - callers should not depend on redis.Nil
        return nil, fmt.Errorf("cache get %s: %v", key, err)
    }
    return val, nil
}

// Correct use of %w: preserving an error that IS part of the contract
func (r *UserRepo) FindByID(id string) (*User, error) {
    user, err := r.db.QueryRow("SELECT ...").Scan(...)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, fmt.Errorf("find user %s: %w", id, ErrNotFound)
        }
        // %w because database errors are relevant to callers
        return nil, fmt.Errorf("find user %s: %w", id, err)
    }
    return user, nil
}
\`\`\`

**Quick rule:** If you are wrapping an error with \`fmt.Errorf\` and you are not sure whether to use \`%v\` or \`%w\`, use \`%w\`. You can always tighten the API later by switching to \`%v\`, but switching from \`%v\` to \`%w\` is a backward-compatible expansion that callers may not expect.

### Panicking in Library Code

Libraries should **never** panic. A library panic crashes the caller's entire program for a condition the caller had no opportunity to handle. This violates the fundamental contract between a library and its consumer: the library provides functionality, the caller decides what to do when things go wrong.

"File not found" is not a reason to panic. "Invalid input" is not a reason to panic. "Network timeout" is not a reason to panic. These are all runtime conditions that the caller can and should handle.

**The only acceptable panic in a library:** violated invariants that indicate a **bug in the program**, not a runtime condition. Even then, many teams prefer returning errors for everything and reserving panic exclusively for the \`Must\` initialization pattern.

\`\`\`go
// WRONG: Library that panics on invalid input
package mathutil

// Divide panics if b is zero
func Divide(a, b float64) float64 {
    if b == 0 {
        panic("division by zero") // Crashes the caller's program!
    }
    return a / b
}

// The caller has no way to handle this gracefully:
// result := mathutil.Divide(10, userInput) // if userInput is 0 → crash
\`\`\`

\`\`\`go
// CORRECT: Library that returns errors for all failure conditions
package mathutil

import "errors"

var ErrDivisionByZero = errors.New("mathutil: division by zero")

// Divide returns an error if b is zero
func Divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, ErrDivisionByZero
    }
    return a / b, nil
}

// The caller can handle this however they want:
// result, err := mathutil.Divide(10, userInput)
// if errors.Is(err, mathutil.ErrDivisionByZero) {
//     // Return a user-friendly message, use a default, retry, etc.
// }
\`\`\`

**Converting panics to errors at API boundaries using \`recover\`:**

Even when your library does not panic, dependencies might. If your library calls third-party code that could panic, you should catch the panic at the API boundary and convert it to an error, so the panic does not leak into the caller's program:

\`\`\`go
package safejson

import (
    "encoding/json"
    "fmt"
)

// Parse unmarshals JSON into the target, converting any panics to errors.
// This is useful when calling third-party unmarshalers that may panic
// on malformed input.
func Parse(data []byte, target any) (err error) {
    defer func() {
        if r := recover(); r != nil {
            // Convert the panic to an error
            err = fmt.Errorf("safejson: recovered from panic: %v", r)
        }
    }()

    if err := json.Unmarshal(data, target); err != nil {
        return fmt.Errorf("safejson: unmarshal: %w", err)
    }
    return nil
}
\`\`\`

\`\`\`go
// A more complete example: safe execution wrapper for any function
package safeexec

import "fmt"

// Do executes fn and converts any panic into a returned error.
// Use this at service boundaries, goroutine entry points,
// or when calling untrusted code.
func Do(fn func() error) (err error) {
    defer func() {
        if r := recover(); r != nil {
            switch v := r.(type) {
            case error:
                err = fmt.Errorf("safeexec: panic: %w", v)
            case string:
                err = fmt.Errorf("safeexec: panic: %s", v)
            default:
                err = fmt.Errorf("safeexec: panic: %v", v)
            }
        }
    }()
    return fn()
}

// Usage:
// err := safeexec.Do(func() error {
//     return thirdPartyLib.Process(data)
// })
// if err != nil {
//     // Handle gracefully - even if thirdPartyLib panicked
// }
\`\`\`

**Summary of the panic rules for library authors:**

| Situation | Action |
|-----------|--------|
| Invalid user input | Return an error |
| Resource not found | Return an error |
| Network/IO failure | Return an error |
| Bug in the program (violated invariant) | Panic is acceptable |
| \`Must\` pattern for init-time setup | Panic is acceptable |
| Calling untrusted/third-party code | Wrap with \`recover\` at the boundary |

### Not Using Custom Error Types for Domain Errors

Generic errors like \`errors.New("something failed")\` or \`fmt.Errorf("not found")\` give callers no programmatic way to handle specific failure conditions. When an HTTP handler receives a generic error, it has no choice but to return a 500 Internal Server Error for everything, even for errors that should clearly be a 404 or 403. Domain error types solve this by carrying behavior (methods) that the handler layer can use to produce the correct response.

**The problem, generic errors force catch-all handling:**

\`\`\`go
// WRONG: Generic errors - handler cannot distinguish failure types
func (s *UserService) GetUser(id string) (*User, error) {
    user, err := s.repo.FindByID(id)
    if err != nil {
        return nil, fmt.Errorf("get user: %v", err) // What kind of error?
    }
    if !s.authz.CanView(user) {
        return nil, errors.New("access denied") // A string. Not inspectable.
    }
    return user, nil
}

func HandleGetUser(w http.ResponseWriter, r *http.Request) {
    user, err := userService.GetUser(r.URL.Query().Get("id"))
    if err != nil {
        // What status code? 404? 403? 500? We have no idea.
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }
    json.NewEncoder(w).Encode(user)
}
\`\`\`

**The solution, domain error types with behavior:**

\`\`\`go
package apperr

import "fmt"

// StatusCoder is implemented by errors that know their HTTP status
type StatusCoder interface {
    StatusCode() int
}

// UserMessager is implemented by errors that carry a user-safe message
type UserMessager interface {
    UserMessage() string
}

// NotFoundError represents a resource that was not found
type NotFoundError struct {
    Entity string
    ID     string
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s %q not found", e.Entity, e.ID)
}

func (e *NotFoundError) StatusCode() int {
    return 404
}

func (e *NotFoundError) UserMessage() string {
    return fmt.Sprintf("The requested %s was not found.", e.Entity)
}

// ForbiddenError represents an authorization failure
type ForbiddenError struct {
    Action   string
    Resource string
    Reason   string
}

func (e *ForbiddenError) Error() string {
    return fmt.Sprintf("forbidden: %s on %s: %s", e.Action, e.Resource, e.Reason)
}

func (e *ForbiddenError) StatusCode() int {
    return 403
}

func (e *ForbiddenError) UserMessage() string {
    return "You do not have permission to perform this action."
}

// InternalError wraps unexpected failures
type InternalError struct {
    Op  string // The operation that failed
    Err error  // The underlying cause
}

func (e *InternalError) Error() string {
    return fmt.Sprintf("internal error in %s: %v", e.Op, e.Err)
}

func (e *InternalError) StatusCode() int {
    return 500
}

func (e *InternalError) UserMessage() string {
    return "An unexpected error occurred. Please try again later."
}

func (e *InternalError) Unwrap() error {
    return e.Err
}
\`\`\`

**Using domain errors in the service layer:**

\`\`\`go
package service

import "myapp/apperr"

func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
    user, err := s.repo.FindByID(ctx, id)
    if err != nil {
        if errors.Is(err, repository.ErrNotFound) {
            return nil, &apperr.NotFoundError{Entity: "user", ID: id}
        }
        return nil, &apperr.InternalError{Op: "get-user", Err: err}
    }

    if !s.authz.CanView(ctx, user) {
        return nil, &apperr.ForbiddenError{
            Action:   "view",
            Resource: fmt.Sprintf("user/%s", id),
            Reason:   "insufficient permissions",
        }
    }

    return user, nil
}
\`\`\`

**The handler now produces correct responses without a switch statement:**

\`\`\`go
package handler

import (
    "encoding/json"
    "log"
    "net/http"

    "myapp/apperr"
)

// ErrorResponse is the JSON envelope for error responses
type ErrorResponse struct {
    Error   string \`json:"error"\`
    Message string \`json:"message"\`
}

// HandleError translates domain errors into HTTP responses.
// It uses interface checks (StatusCoder, UserMessager) so it works
// with ANY error type that implements these interfaces - no switch needed.
func HandleError(w http.ResponseWriter, err error) {
    // Determine status code
    code := http.StatusInternalServerError
    var sc apperr.StatusCoder
    if errors.As(err, &sc) {
        code = sc.StatusCode()
    }

    // Determine user-safe message
    msg := "An unexpected error occurred."
    var um apperr.UserMessager
    if errors.As(err, &um) {
        msg = um.UserMessage()
    }

    // Log the full internal error for debugging
    if code >= 500 {
        log.Printf("ERROR [%d]: %v", code, err)
    }

    // Send the response
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(code)
    json.NewEncoder(w).Encode(ErrorResponse{
        Error:   http.StatusText(code),
        Message: msg,
    })
}

func HandleGetUser(w http.ResponseWriter, r *http.Request) {
    user, err := userService.GetUser(r.Context(), r.URL.Query().Get("id"))
    if err != nil {
        HandleError(w, err) // Automatically produces 404, 403, or 500
        return
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
}
\`\`\`

**Building an error type hierarchy for API errors:**

\`\`\`go
package apperr

// Base API error - all domain errors can embed this
type APIError struct {
    Code       string // Machine-readable code: "USER_NOT_FOUND", "RATE_LIMITED"
    HTTPStatus int    // HTTP status code
    Message    string // User-safe message
    Internal   error  // Internal cause (not exposed to users)
}

func (e *APIError) Error() string {
    if e.Internal != nil {
        return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.Internal)
    }
    return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

func (e *APIError) StatusCode() int    { return e.HTTPStatus }
func (e *APIError) UserMessage() string { return e.Message }
func (e *APIError) ErrorCode() string   { return e.Code }

func (e *APIError) Unwrap() error { return e.Internal }

// Convenience constructors for common cases
func NewNotFound(entity, id string) *APIError {
    return &APIError{
        Code:       "NOT_FOUND",
        HTTPStatus: 404,
        Message:    fmt.Sprintf("The requested %s was not found.", entity),
    }
}

func NewForbidden(reason string) *APIError {
    return &APIError{
        Code:       "FORBIDDEN",
        HTTPStatus: 403,
        Message:    reason,
    }
}

func NewBadRequest(message string) *APIError {
    return &APIError{
        Code:       "BAD_REQUEST",
        HTTPStatus: 400,
        Message:    message,
    }
}

func NewInternal(op string, cause error) *APIError {
    return &APIError{
        Code:       "INTERNAL_ERROR",
        HTTPStatus: 500,
        Message:    "An unexpected error occurred. Please try again later.",
        Internal:   fmt.Errorf("%s: %w", op, cause),
    }
}

// Usage anywhere in the codebase:
// return apperr.NewNotFound("user", id)
// return apperr.NewForbidden("Only admins can delete users.")
// return apperr.NewInternal("fetch-order", err)
\`\`\`

This pattern scales to any number of error conditions without creating dozens of sentinel errors or separate types for each case. The \`APIError\` struct carries all the information needed to produce correct HTTP responses, log entries, and metrics, and the handler layer uses interface checks rather than type switches, so adding new error conditions never requires modifying handler code.

### Adoption Path

For a senior engineer introducing a unified error type to an existing codebase, the migration path: (1) define the \`APIError\` type in a shared package, (2) migrate one handler as a reference, (3) write the team's guide with the before-and-after example, (4) migrate remaining handlers incrementally. Resist the urge to migrate everything at once. The incremental path lands cleanly with less coordination cost.

---
`;
