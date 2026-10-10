## 107.2 Input Validation and Sanitization

**The Golden Rule**: Never trust user input. All data from HTTP requests, databases, and external APIs must be validated.

### Comprehensive Input Validation

The validator uses allowlist-based regular expressions, accepting only the characters explicitly permitted rather than attempting to block known-bad patterns, because blocklists are always incomplete and bypassed by encoding tricks. Email validation uses `net/mail.ParseAddress` rather than a hand-rolled regex because the standard library correctly handles edge cases like quoted local parts and internationalized domain names. Centralizing all field validators in one package ensures that the same rules are applied consistently whether input arrives via HTTP, gRPC, or a background job queue.

```go
package validator

import (
    "encoding/json"
    "fmt"
    "net/http"
    "net/mail"
    "regexp"
    "strings"
    "unicode/utf8"
)

// Validator provides input validation methods
type Validator struct {
    Errors map[string]string
}

// NewValidator creates a new validator instance
func NewValidator() *Validator {
    return &Validator{
        Errors: make(map[string]string),
    }
}

// Valid returns true if no validation errors
func (v *Validator) Valid() bool {
    return len(v.Errors) == 0
}

// Check adds an error if validation condition is not met
func (v *Validator) Check(ok bool, field, message string) {
    if !ok {
        v.Errors[field] = message
    }
}

// NotBlank validates that a value is not empty
func (v *Validator) NotBlank(value, field string) {
    v.Check(strings.TrimSpace(value) != "", field, "must not be blank")
}

// MaxLength validates maximum string length
func (v *Validator) MaxLength(value string, field string, n int) {
    v.Check(utf8.RuneCountInString(value) <= n, field,
        fmt.Sprintf("must not be more than %d characters", n))
}

// MinLength validates minimum string length
func (v *Validator) MinLength(value string, field string, n int) {
    v.Check(utf8.RuneCountInString(value) >= n, field,
        fmt.Sprintf("must be at least %d characters", n))
}

// Email validates email format
func (v *Validator) Email(value, field string) {
    _, err := mail.ParseAddress(value)
    v.Check(err == nil, field, "must be a valid email address")
}

// Matches validates value against regex pattern
func (v *Validator) Matches(value string, field string, pattern *regexp.Regexp) {
    v.Check(pattern.MatchString(value), field, "invalid format")
}

// In validates value is in permitted list
func (v *Validator) In(value string, field string, permitted ...string) {
    for _, p := range permitted {
        if value == p {
            return
        }
    }
    v.Check(false, field, fmt.Sprintf("must be one of: %v", permitted))
}

// PasswordStrength validates password meets security requirements
func (v *Validator) PasswordStrength(password, field string) {
    // Minimum 12 characters
    v.MinLength(password, field, 12)

    // Check for required character types
    hasUpper := regexp.MustCompile(`[A-Z]`).MatchString(password)
    hasLower := regexp.MustCompile(`[a-z]`).MatchString(password)
    hasNumber := regexp.MustCompile(`[0-9]`).MatchString(password)
    hasSpecial := regexp.MustCompile(`[!@#$%^&*(),.?":{}|<>]`).MatchString(password)

    v.Check(hasUpper && hasLower && hasNumber && hasSpecial, field,
        "must contain uppercase, lowercase, number, and special character")
}

// Example usage in handler
type CreateUserRequest struct {
    Email    string `json:"email"`
    Password string `json:"password"`
    Name     string `json:"name"`
    Role     string `json:"role"`
}

func CreateUserHandler(w http.ResponseWriter, r *http.Request) {
    var req CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request body", http.StatusBadRequest)
        return
    }

    v := NewValidator()

    // Validate each field
    v.NotBlank(req.Email, "email")
    v.Email(req.Email, "email")

    v.NotBlank(req.Password, "password")
    v.PasswordStrength(req.Password, "password")

    v.NotBlank(req.Name, "name")
    v.MaxLength(req.Name, "name", 100)

    v.In(req.Role, "role", "user", "admin", "moderator")

    if !v.Valid() {
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusUnprocessableEntity)
        json.NewEncoder(w).Encode(map[string]any{
            "errors": v.Errors,
        })
        return
    }

    // Proceed with user creation...
}
```

### Junior → FAANG: Getting Input Validation Right From Day One

Input validation is the first line of defense and the most commonly skipped step by juniors under time pressure. At FAANG interviews, "never trust user input" is expected knowledge. Demonstrating it in code is what separates candidates.

**Gap to close:** Many juniors validate presence (is the field non-empty?) but not type, length, format, and range. All four dimensions matter. A field that accepts an email should be non-empty, under a reasonable length limit (254 characters is the RFC maximum), match an email pattern, and ideally have the domain verified. Omitting any of these creates attack surface.

**First-job habit:** Centralize validation. Do not scatter `if len(s) > 100` checks across handlers. Write or adopt a validation package with a fluent API and use it at every handler boundary. When validation logic is centralized, you can audit it, test it, and update it in one place.

**Worked example:** A common junior mistake is validating on the happy path but not on edge cases. Write tests with empty strings, strings of maximum length plus one, Unicode control characters, null bytes, and format strings like `%s` and `{{.}}`. Any of these that reach your business logic without rejection is a gap.

**Interview framing:** When asked "how do you validate user input in Go?", describe the two-phase approach: parse into a typed struct first (Go's type system rejects malformed JSON for you), then apply semantic validation rules (length, range, format, whitelist). Name a library like `go-playground/validator` and explain what it does and does not cover.

### Senior @ FAANG: Input Validation as a Contract, Not a Courtesy

Senior engineers think of input validation as a formal contract between the caller and the service. Violating the contract is a protocol error, not a user error. This framing changes how you design APIs, write OpenAPI specs, and build shared validation libraries.

**Contract-first design:** At L6+, input validation is defined at the API contract level before any code is written. For gRPC services, `protoc-gen-validate` enforces field constraints at the protobuf layer. For REST APIs, JSON Schema or OpenAPI `minLength`, `maxLength`, `pattern`, and `enum` constraints are the source of truth, and a schema validation middleware enforces them before any handler runs. This approach means validation logic is not scattered across handlers: it is generated from the schema or enforced by the framework.

**Defense in depth for validation:** Even with schema validation at the gateway, apply semantic validation in the service layer. The gateway prevents obviously malformed input. The service layer enforces business-level constraints (is this user ID a valid reference? Is this date range sensible for the use case?). Defense in depth means neither layer trusts the other.

**ADR consideration:** When evaluating validation libraries, document in an ADR: does the library validate after deserialization or before? Does it support custom validators for domain-specific types? Does it produce structured errors (field-level) or flat error strings? Structured errors are required for good UX and for audit logging. A library that returns "validation failed" as a single string is not production-grade.

**Security boundary classification:** Not all inputs are equally risky. Classify inputs by their downstream destination: inputs that reach SQL queries need parameterization, inputs that reach HTML templates need context-aware escaping, inputs that reach shell commands need rejection by default (never interpolate user input into shell commands in Go, use `exec.Command` with separate argument slices). Senior engineers build these classifications into code review checklists and static analysis rules.

**Measurement:** Track validation rejection rates by endpoint. A sudden spike in 400 errors on a specific field can indicate a scanning attempt or a breaking client change. Surface this in your observability stack with a `validation_rejection_total` counter labeled by field name and reason. This metric has caught active probing at multiple large Go services.

---
