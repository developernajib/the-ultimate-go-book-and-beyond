## 40.1 Input Validation Fundamentals

### Validation Principles

Key principles: validate early (at the API boundary), validate completely (all constraints at once rather than one at a time), be specific (field-level error codes), and sanitize after validation. Never trust user input before validation. Validation lives at the boundary: once data passes the DTO layer, internal code should trust the invariants it was handed instead of re-checking them on every call.

**Library choice.** `go-playground/validator/v10` is the de-facto standard for struct-tag validation and integrates with Gin, Echo, Fiber, and Huma out of the box. For rules that are awkward to express as tags, such as cross-field comparisons with dynamic thresholds, runtime-loaded schemas, or polymorphic payloads, `github.com/go-ozzo/ozzo-validation/v4` offers a programmatic API (`validation.ValidateStruct(&u, validation.Field(&u.Email, validation.Required, is.Email))`) that some teams find cleaner for complex domains. The two libraries compose: tags for the common 80% of shape checks, ozzo or hand-written functions for the gnarly rest.

### Struct Tag Validation

The `go-playground/validator` package validates structs using tags declared alongside `json` tags. A singleton `validator.Validate` instance, initialized with `sync.Once`, registers custom validation functions once and reuses them across all requests. The struct tags below show common constraints: `required`, length bounds, format checks like `email` and `url`, and custom rules like `slug` and `password_strength`.

```go
// ... imports omitted for brevity (regexp, sync, github.com/go-playground/validator/v10)

var (
    validate *validator.Validate
    once     sync.Once
)

// GetValidator returns a singleton validator instance
func GetValidator() *validator.Validate {
    once.Do(func() {
        validate = validator.New()

        // Register custom validations
        validate.RegisterValidation("slug", validateSlug)
        validate.RegisterValidation("password_strength", validatePasswordStrength)
        validate.RegisterValidation("phone", validatePhone)
    })
    return validate
}

// CreateUserInput with validation tags
type CreateUserInput struct {
    Name     string `json:"name" validate:"required,min=2,max=100"`
    Email    string `json:"email" validate:"required,email"`
    Password string `json:"password" validate:"required,min=8,password_strength"`
    Username string `json:"username" validate:"required,min=3,max=30,slug"`
    Phone    string `json:"phone" validate:"omitempty,phone"`
    Age      int    `json:"age" validate:"omitempty,gte=13,lte=150"`
    Website  string `json:"website" validate:"omitempty,url"`
    Role     string `json:"role" validate:"required,oneof=user admin editor"`
}

// UpdateUserInput for partial updates
type UpdateUserInput struct {
    Name    *string `json:"name" validate:"omitempty,min=2,max=100"`
    Email   *string `json:"email" validate:"omitempty,email"`
    Phone   *string `json:"phone" validate:"omitempty,phone"`
    Website *string `json:"website" validate:"omitempty,url"`
}

// Custom validation functions
var slugRegex = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func validateSlug(fl validator.FieldLevel) bool {
    return slugRegex.MatchString(fl.Field().String())
}

// Compile once at package init, never per call. regexp.MustCompile inside a
// hot validator is a common and entirely avoidable source of CPU burn.
var (
    upperRegex   = regexp.MustCompile(`[A-Z]`)
    lowerRegex   = regexp.MustCompile(`[a-z]`)
    numberRegex  = regexp.MustCompile(`[0-9]`)
    specialRegex = regexp.MustCompile(`[!@#$%^&*(),.?":{}|<>]`)
)

func validatePasswordStrength(fl validator.FieldLevel) bool {
    password := fl.Field().String()

    return upperRegex.MatchString(password) &&
        lowerRegex.MatchString(password) &&
        numberRegex.MatchString(password) &&
        specialRegex.MatchString(password)
}

var phoneRegex = regexp.MustCompile(`^\+?[1-9]\d{1,14}$`)

func validatePhone(fl validator.FieldLevel) bool {
    return phoneRegex.MatchString(fl.Field().String())
}
```

### Validation Error Handling

When validation fails, the `Validate` function converts `validator.ValidationErrors` into a slice of `FieldError` values that carry a JSON field name, a machine-readable code, a human-readable message, and, where it is safe to do so, the rejected value. The `tagToCode` mapping translates validator tags like `required` and `email` into stable codes like `REQUIRED` and `INVALID_EMAIL` that clients can branch on. The `toSnakeCase` helper converts Go's `CamelCase` field names to the `snake_case` convention used in JSON responses.

Note the `sensitiveFields` guard. Echoing the rejected value back to the caller is a genuine ergonomic win for fields like `age` or `role`, but doing it unconditionally means a failed `password_strength` check writes the user's plaintext password into your error response, your access logs, and every log aggregator downstream of them. Deny-list the fields that must never round-trip, and treat that list as security-reviewed code.

```go
// ... imports omitted for brevity (fmt, strings, github.com/go-playground/validator/v10)

// FieldError represents a single validation error
type FieldError struct {
    Field   string `json:"field"`
    Code    string `json:"code"`
    Message string `json:"message"`
    Value   any `json:"value,omitempty"`
}

// Validate validates a struct and returns field errors
func Validate(s any) []FieldError {
    err := GetValidator().Struct(s)
    if err == nil {
        return nil
    }

    var errors []FieldError

    validationErrors, ok := err.(validator.ValidationErrors)
    if !ok {
        return []FieldError{{
            Field:   "unknown",
            Code:    "VALIDATION_ERROR",
            Message: err.Error(),
        }}
    }

    for _, e := range validationErrors {
        field := toSnakeCase(e.Field())

        fe := FieldError{
            Field:   field,
            Code:    tagToCode(e.Tag()),
            Message: formatMessage(e),
        }
        // Never echo secrets back to the caller. Value is omitempty, so
        // leaving it nil drops the key entirely for sensitive fields.
        if !sensitiveFields[field] {
            fe.Value = e.Value()
        }

        errors = append(errors, fe)
    }

    return errors
}

// sensitiveFields never have their rejected value reflected in a response.
var sensitiveFields = map[string]bool{
    "password":         true,
    "new_password":     true,
    "current_password": true,
    "token":            true,
    "secret":           true,
    "api_key":          true,
    "card_number":      true,
    "cvv":              true,
    "ssn":              true,
}

// tagToCode converts validator tag to error code
func tagToCode(tag string) string {
    codes := map[string]string{
        "required":          "REQUIRED",
        "email":             "INVALID_EMAIL",
        "min":               "TOO_SHORT",
        "max":               "TOO_LONG",
        "gte":               "TOO_SMALL",
        "lte":               "TOO_LARGE",
        "oneof":             "INVALID_VALUE",
        "url":               "INVALID_URL",
        "slug":              "INVALID_SLUG",
        "password_strength": "WEAK_PASSWORD",
        "phone":             "INVALID_PHONE",
    }

    if code, ok := codes[tag]; ok {
        return code
    }
    return strings.ToUpper(tag)
}

// formatMessage creates human-readable error message
func formatMessage(e validator.FieldError) string {
    field := toSnakeCase(e.Field())

    switch e.Tag() {
    case "required":
        return fmt.Sprintf("%s is required", field)
    case "email":
        return "must be a valid email address"
    case "min":
        if e.Type().Kind().String() == "string" {
            return fmt.Sprintf("must be at least %s characters", e.Param())
        }
        return fmt.Sprintf("must be at least %s", e.Param())
    case "max":
        if e.Type().Kind().String() == "string" {
            return fmt.Sprintf("must be at most %s characters", e.Param())
        }
        return fmt.Sprintf("must be at most %s", e.Param())
    case "gte":
        return fmt.Sprintf("must be greater than or equal to %s", e.Param())
    case "lte":
        return fmt.Sprintf("must be less than or equal to %s", e.Param())
    case "oneof":
        return fmt.Sprintf("must be one of: %s", e.Param())
    case "url":
        return "must be a valid URL"
    case "slug":
        return "must contain only lowercase letters, numbers, and hyphens"
    case "password_strength":
        return "must contain uppercase, lowercase, number, and special character"
    case "phone":
        return "must be a valid phone number in E.164 format"
    default:
        return fmt.Sprintf("failed validation: %s", e.Tag())
    }
}

// toSnakeCase converts CamelCase to snake_case
func toSnakeCase(s string) string {
    var result strings.Builder
    for i, r := range s {
        if i > 0 && r >= 'A' && r <= 'Z' {
            result.WriteByte('_')
        }
        result.WriteRune(r)
    }
    return strings.ToLower(result.String())
}
```

### Junior → FAANG: the three mistakes every junior makes with validator tags

First mistake: forgetting that `validator.New()` is expensive and allocating a fresh one per request. The singleton via `sync.Once` shown above is not a stylistic preference, it is a correctness requirement because `RegisterValidation` only registers on that instance. Second mistake: writing `validate:"required,min=8"` on a `*string` and being confused when `nil` passes `required`. For pointer fields in partial update DTOs you want `required` to mean "the pointer is not nil" which is the default behavior, but `min=8` on a nil pointer is skipped, so combining them requires care. Third mistake: reusing `CreateUserInput` for both create and update, then adding `omitempty` everywhere until the struct no longer enforces anything. Separate DTOs per operation is not over-engineering, it is correctness.

The worked interview question for this section is "how do you handle passwords that contain only ASCII punctuation." The `password_strength` function above rejects them because it requires all four character classes. A senior interviewer expects you to notice that your regex class for special characters is Latin-centric, that NIST SP 800-63B recommends against composition rules entirely in favor of length plus breach-list checking, and that a production password validator should integrate with HaveIBeenPwned's k-anonymity API. Knowing this signals you have read the actual security standards, not just copied a Stack Overflow answer.

### Senior @ FAANG: choosing tags versus builder style, and when to abandon both

The code above is idiomatic `go-playground/validator` and is the right default for a greenfield service. At staff level you need a written rubric for when to abandon it. Tags are optimal when validation rules are static, expressible as pure functions of a single field or a sibling field, and do not need to be unit-tested in isolation. They become a liability when rules are conditional on request context ("validate X only if the caller has scope Y"), depend on external state ("this SKU exists in our catalog"), or need to be composed programmatically ("the tenant's admin has configured these fields as required"). At that point, switch to `ozzo-validation` or hand-written validators that take a `context.Context` and a repository.

`ozzo-validation` deserves a closer look for DDD-heavy codebases. Its `validation.ValidateStruct` takes field accessors and rules as values, which means you can write `validation.Field(&u.Email, validation.Required.When(u.RequiresEmail()), is.Email)` with conditional logic that reads naturally. Rules are first-class values, so you can build them from configuration, test them without a struct instance, and compose them across entities. The cost is more code per struct and the loss of having the rule sit visibly next to the field declaration. Both libraries use reflection and both allocate, so do not assume one is faster: benchmark your own structs before treating performance as the deciding factor. Choose on expressiveness and testability, which is where the two genuinely differ.

Huma v2 takes a third position: validation is derived from OpenAPI, which is derived from struct tags. You write tags, Huma generates the schema and validates against it, and the same schema documents your API. This is the shortest path from zero to a production-grade validated endpoint in Go today, and it is what you should reach for when starting a new HTTP service in 2026 unless you have a reason not to. The reason not to is usually that you need protobuf or GraphQL, at which point `connect-go` with `protovalidate` or `gqlgen` with directive-based validation takes over.

A subtler staff-level concern is reflection cost. `go-playground/validator` uses reflection on every call. For services at p99 latencies below 5 ms, the allocations and type introspection become measurable. Benchmark with `go test -bench -benchmem` before optimizing, but know that `protovalidate` compiles CEL once and reuses the compiled expression, which is why gRPC services at scale often outperform JSON services on the validation axis alone. If you find yourself CPU-bound on validation, the answers in order are: cache the validator instance (you already should), move to generated code (protovalidate, Huma), or write hand-rolled validators for the hot path.

Finally, the error catalog. The `tagToCode` function above embeds the mapping in code. That works until you have five services and three languages. At that point, extract the catalog into a YAML or CUE file, generate constants into each service, and publish it as a versioned artifact. Each code gets a stable identifier, a default English message, translation keys for supported locales, a link to a runbook, and a deprecation policy. Stripe and GitHub both publish versioned, documented error catalogs in exactly this spirit, and the catalog is the artifact that product, support, and engineering all share as source of truth. The first time a PM asks "how many distinct error codes does our API emit," you will wish you had built this on day one.

---
