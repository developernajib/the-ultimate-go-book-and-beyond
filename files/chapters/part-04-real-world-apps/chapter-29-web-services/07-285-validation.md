## 29.5 Validation

### Input Validation

Validating request payloads at the handler boundary prevents malformed data from propagating into business logic. In production, the ecosystem standard is `github.com/go-playground/validator/v10`, tag-driven, battle-tested, and embedded inside gin/echo/fiber. The hand-rolled validator shown below is useful when you want zero dependencies or domain-specific rules that validator's tag grammar cannot express. Real projects usually combine both.

### Production Approach: validator.v10 (Tag-Based)

```go
package handlers

import (
    "encoding/json"
    "errors"
    "net/http"

    "github.com/go-playground/validator/v10"
)

// validate is safe for concurrent use, initialize once.
var validate = validator.New(validator.WithRequiredStructEnabled())

type CreateUserRequest struct {
    Name     string `json:"name"     validate:"required,min=2,max=100"`
    Email    string `json:"email"    validate:"required,email"`
    Password string `json:"password" validate:"required,min=8,containsany=ABCDEFGHIJKLMNOPQRSTUVWXYZ,containsany=0123456789"`
    Age      int    `json:"age"      validate:"gte=18,lte=120"`
    Role     string `json:"role"     validate:"oneof=admin editor viewer"`
}

func handleCreateUserV10(w http.ResponseWriter, r *http.Request) {
    var req CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        return
    }

    if err := validate.Struct(req); err != nil {
        var verrs validator.ValidationErrors
        if errors.As(err, &verrs) {
            out := make([]map[string]string, 0, len(verrs))
            for _, fe := range verrs {
                out = append(out, map[string]string{
                    "field": fe.Field(),
                    "rule":  fe.Tag(),
                    "param": fe.Param(),
                })
            }
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusBadRequest)
            _ = json.NewEncoder(w).Encode(map[string]any{"errors": out})
            return
        }
        http.Error(w, "validation failed", http.StatusBadRequest)
        return
    }
    // Proceed with user creation...
}
```

Key tags you will reach for: `required`, `email`, `url`, `uuid4`, `min`/`max` (length or value), `gte`/`lte`, `oneof=a b c`, `eqfield=OtherField` for password-confirmation, `dive` to recurse into slice/map elements. Register custom rules with `validate.RegisterValidation("slug", slugFn)` for domain-specific constraints.

### Hand-Rolled Validator (Zero Dependencies)

```go
package validation

import (
    "fmt"
    "regexp"
    "strings"
)

type ValidationError struct {
    Field   string `json:"field"`
    Message string `json:"message"`
}

type ValidationErrors []ValidationError

func (e ValidationErrors) Error() string {
    var msgs []string
    for _, err := range e {
        msgs = append(msgs, fmt.Sprintf("%s: %s", err.Field, err.Message))
    }
    return strings.Join(msgs, "; ")
}

type Validator struct {
    errors ValidationErrors
}

func NewValidator() *Validator {
    return &Validator{}
}

func (v *Validator) Required(field, value string) *Validator {
    if strings.TrimSpace(value) == "" {
        v.errors = append(v.errors, ValidationError{field, "is required"})
    }
    return v
}

func (v *Validator) Email(field, value string) *Validator {
    emailRegex := regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)
    if !emailRegex.MatchString(value) {
        v.errors = append(v.errors, ValidationError{field, "must be a valid email"})
    }
    return v
}

func (v *Validator) MinLength(field, value string, min int) *Validator {
    if len(value) < min {
        v.errors = append(v.errors, ValidationError{field, fmt.Sprintf("must be at least %d characters", min)})
    }
    return v
}

func (v *Validator) MaxLength(field, value string, max int) *Validator {
    if len(value) > max {
        v.errors = append(v.errors, ValidationError{field, fmt.Sprintf("must be at most %d characters", max)})
    }
    return v
}

func (v *Validator) Range(field string, value, min, max int) *Validator {
    if value < min || value > max {
        v.errors = append(v.errors, ValidationError{field, fmt.Sprintf("must be between %d and %d", min, max)})
    }
    return v
}

func (v *Validator) Match(field, value, pattern, message string) *Validator {
    re := regexp.MustCompile(pattern)
    if !re.MatchString(value) {
        v.errors = append(v.errors, ValidationError{field, message})
    }
    return v
}

func (v *Validator) Valid() bool {
    return len(v.errors) == 0
}

func (v *Validator) Errors() ValidationErrors {
    return v.errors
}
```

### Using Validator

With the validator defined, each request type attaches a `Validate()` method that chains the relevant checks. The handler calls `Validate()` after decoding JSON and returns a structured error response listing all violations at once, so clients can fix every issue in a single round trip.

```go
package handlers

type CreateUserRequest struct {
    Name     string `json:"name"`
    Email    string `json:"email"`
    Password string `json:"password"`
    Age      int    `json:"age"`
}

func (r *CreateUserRequest) Validate() error {
    v := validation.NewValidator()

    v.Required("name", r.Name).
        MinLength("name", r.Name, 2).
        MaxLength("name", r.Name, 100)

    v.Required("email", r.Email).
        Email("email", r.Email)

    v.Required("password", r.Password).
        MinLength("password", r.Password, 8).
        Match("password", r.Password, `[A-Z]`, "must contain uppercase letter").
        Match("password", r.Password, `[0-9]`, "must contain number")

    v.Range("age", r.Age, 18, 120)

    if !v.Valid() {
        return v.Errors()
    }

    return nil
}

func handleCreateUser(w http.ResponseWriter, r *http.Request) {
    var req CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "Invalid JSON")
        return
    }

    if err := req.Validate(); err != nil {
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusBadRequest)
        json.NewEncoder(w).Encode(map[string]any{
            "error":  "Validation failed",
            "errors": err,
        })
        return
    }

    // Create user...
}
```

### Junior to FAANG: Validation Is Security, Not UX

Treat validation as your first line of defense, not a nicety to make forms prettier. Every field that crosses a trust boundary (client to server) must be validated for type, range, format, and length. Never assume the client validated anything. Never trust the `Content-Length` header. Never trust `Content-Type`. Validate server-side and treat client-side validation as a UX hint only.

A concrete exercise. Take the `CreateUserRequest` above. Write a fuzz test that sends 1000 random payloads and asserts the handler always returns 400 or 201, never 5xx. If your handler panics on any input, validation is broken.

```go
func FuzzCreateUser(f *testing.F) {
    f.Fuzz(func(t *testing.T, body []byte) {
        req := httptest.NewRequest("POST", "/users", bytes.NewReader(body))
        rr := httptest.NewRecorder()
        handleCreateUser(rr, req)
        if rr.Code >= 500 {
            t.Fatalf("got 5xx on input %q", body)
        }
    })
}
```

Interview framing. Expect "how do you validate an email." The wrong answer, regex. The right answer, "use `mail.ParseAddress` from the stdlib, which handles RFC 5322 correctly, then send a verification email because address validity means nothing about ownership." That answer separates engineers.

### Senior at FAANG: Validation as Schema Governance

At scale, validation is not "add tags to a struct." It is a schema-registry discipline. Every request and response type is defined in OpenAPI 3.1 or Protobuf, checked into a central registry, validated in CI, and used to generate both server-side validators and client SDKs. A breaking schema change fails CI. An additive change ships.

Tooling choices in 2026. `github.com/go-playground/validator/v10` remains the standard for runtime struct validation. `getkin/kin-openapi` for OpenAPI-based request validation middleware. `bufbuild/protovalidate` for Protobuf when you are gRPC or Connect-heavy. Publish platform wrappers so teams do not pick the validator library per service.

Error envelope for validation. Every validation failure returns `application/problem+json` with `type: https://corp.dev/problems/validation`, `status: 400`, `errors: [{path, code, message}]`. The `code` is a stable identifier like `required`, `min_length`, `email_format`. Machine-readable, localizable, loggable. Publish the code registry.

Defense in depth. Validation at the edge (API gateway, schema check), at the handler (struct validator), at the service layer (business rules), at the database (constraints). Each layer catches what the previous missed. The database constraint is the last line of defense and the most reliable, never rely only on application validation for uniqueness or referential integrity.

PII validation. Beyond format, validate whether the field should be present at all. `ssn` in a request to a service that has no business touching SSNs should 400 with `unexpected_field`. Implement a "PII tripwire" at the edge that rejects requests carrying tagged fields unless the service is allowlisted. Publish the PII tag registry, enforce via code scanning.

Custom validators at the org level. `validate.RegisterValidation("tenant_slug", tenantSlugFn)` for your business keys. Publish these in `platform/validation` so every service uses the same rules. A "slug" that means three different things across three services is a migration disaster waiting to happen.

Validation performance. `validator.v10` uses reflection and caches. Initialize one global instance per process (as shown). Do not create per-request. For hot paths with >10k RPS per pod, consider code-generated or hand-written validators that avoid reflection. Benchmark first, optimize only with evidence.

Localization. Error messages must support locale for user-facing APIs. Keep the `code` stable across locales, translate `message` at the edge based on `Accept-Language`. The handler returns English codes, a gateway translates if needed. Never embed translation logic in handlers.

Schema-driven testing. Generate fuzz corpora from OpenAPI schemas. For every endpoint, auto-generate valid and invalid examples, run them through the handler, assert 2xx vs 4xx as expected. This catches the class of bugs where validation drifted from the schema.

Staff-level ADR. Do we pick OpenAPI or Protobuf as the source of truth. OpenAPI wins for REST-heavy, human-readable, HTTP-native APIs. Protobuf wins for RPC-heavy, cross-language, binary-efficient. FAANG orgs typically pick one per boundary, OpenAPI for external and user-facing, Protobuf for internal east-west. Document the boundary.

Multi-year roadmap. Year 1, unify on validator.v10 plus RFC 7807 errors. Year 2, land the schema registry and CI gates. Year 3, code-generate validators and clients from schemas. Year 4, retire hand-rolled validators org-wide.

---
