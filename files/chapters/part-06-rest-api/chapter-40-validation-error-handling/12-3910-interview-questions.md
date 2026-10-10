## 40.10 Interview Questions

### Question 1: What's the difference between 400, 422, and 409 status codes?

**Answer:**

- **400 Bad Request**: The request was malformed and couldn't be parsed. Examples: invalid JSON syntax, wrong Content-Type, missing required headers.

- **422 Unprocessable Entity**: The request was syntactically correct but semantically invalid. Examples: email format invalid, age is negative, required field missing from valid JSON object.

- **409 Conflict**: The request couldn't be completed due to a conflict with current resource state. Examples: duplicate email (uniqueness violation), outdated ETag (optimistic locking failure), resource already deleted.

```go
// 400 - Parse error
json.Decode(r.Body, &input) // "{invalid json" → 400

// 422 - Validation error
if input.Email != "" && !isValidEmail(input.Email) {
    return 422, "email format invalid"
}

// 409 - State conflict
if _, err := db.Create(user); isDuplicateKey(err) {
    return 409, "email already exists"
}
```

**What FAANG expects:** Candidates should know that 422 arrived as a WebDAV code (RFC 4918) but is no longer WebDAV-specific: RFC 9110 defines it for general HTTP as **422 Unprocessable Content**, which is the name to use now. Real APIs genuinely split on this. GitHub leans on 422 for validation failures, returning a `message` plus an `errors` array naming each offending field. Stripe goes the other way and returns 400 for invalid parameters, reserving its taxonomy for the `type`/`code` fields in the body rather than the status line. Neither is wrong. What matters is that you pick one and apply it uniformly, because a client cannot branch on a rule that changes per endpoint. Mentioning RFC 9457 Problem Details (`application/problem+json`) as the body format is a green flag. Distinguishing 409 from 412 (precondition failed on ETag/If-Match) shows depth.

**Follow-ups:**
- When would you return 200 with an error body instead of a 4xx? (Answer: never for real errors. The exception is batch and multi-status patterns like GraphQL or 207, and even then the top-level status reflects transport success only.)
- A client sends `Content-Type: text/plain` to a JSON endpoint. What status? (415 Unsupported Media Type, not 400.)
- If the same request is retried and the first succeeded, what status? (409 if state conflicts, or ideally use idempotency keys and return the original 2xx.)

### Question 2: How would you implement validation that can be reused across multiple handlers?

**Answer:**

Use a layered approach with struct tags + custom validators + middleware:

```go
// 1. Struct tags for format validation (reusable)
type CreateUserInput struct {
    Email    string `json:"email" validate:"required,email"`
    Age      int    `json:"age" validate:"gte=18,lte=150"`
}

// 2. Validation function (reusable).
// Struct is a method on *validator.Validate, not a package-level function,
// so this goes through the sync.Once singleton from 40.1.
func Validate[T any](input T) []FieldError {
    err := GetValidator().Struct(input)
    if err == nil {
        return nil
    }
    // Guarded, not a bare type assertion: Struct returns
    // *validator.InvalidValidationError (not ValidationErrors) when handed
    // a non-struct, and a bare assertion panics on it.
    var verrs validator.ValidationErrors
    if !errors.As(err, &verrs) {
        return []FieldError{{Field: "unknown", Code: "VALIDATION_ERROR"}}
    }
    return convertValidationErrors(verrs)
}

// 3. Generic decode + validate helper
func ValidateBody[T any](r *http.Request) (T, error) {
    var input T
    if err := DecodeJSON(r, &input); err != nil {
        return input, err
    }
    if verrs := Validate(input); len(verrs) > 0 {
        return input, &ValidationError{Errors: verrs}
    }
    return input, nil
}

// 4. Handler just calls the reusable function
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) error {
    input, err := ValidateBody[CreateUserInput](r)
    if err != nil {
        return err // Error middleware writes the response
    }

    user, err := h.service.Create(r.Context(), input)
    if err != nil {
        return err
    }

    return WriteJSON(w, http.StatusCreated, user)
}
```

**What FAANG expects:** A clear separation between *shape* validation (struct tags, generic), *semantic* validation (business rules, per-endpoint), and *authorization* checks (a separate concern, never folded into validation). Interviewers look for the generic `ValidateBody[T]` pattern using Go 1.18+ generics, and for recognition that middleware should not own business rules: it owns decoding and format validation only. Bonus: knowing why the validator is a `sync.Once` singleton. It is not that reflection disappears, because `Struct` still reflects over the value on every call. It is that a `*validator.Validate` caches the parsed struct-tag metadata per type and holds your `RegisterValidation` custom rules. A fresh instance per request re-parses every tag and, worse, has none of your custom validators registered.

**Follow-ups:**
- Why not just call `validate.Struct` inside every handler? (Duplication, inconsistent error shapes, easy to forget, harder to swap libraries later.)
- How do you return *all* validation errors at once instead of failing on the first? (validator/v10 already does this by default. With `errors.Join` for ad-hoc rule bundles.)
- Where does DTO-to-domain mapping belong? (After validation, in the handler or a dedicated mapper, never in the middleware.)

### Question 3: How do you handle validation that requires database lookups?

**Answer:**

Separate format validation (fast, no I/O) from business validation (requires DB):

```go
// Business validator with dependencies
type BusinessValidator struct {
    userRepo UserRepository
}

func (v *BusinessValidator) ValidateCreateUser(ctx context.Context, input CreateUserInput) []FieldError {
    var verrs []FieldError

    // Check email uniqueness (requires DB)
    exists, err := v.userRepo.EmailExists(ctx, input.Email)
    if err != nil {
        verrs = append(verrs, FieldError{
            Field:   "email",
            Code:    "VALIDATION_FAILED",
            Message: "unable to validate email",
        })
    } else if exists {
        verrs = append(verrs, FieldError{
            Field:   "email",
            Code:    "ALREADY_EXISTS",
            Message: "email is already registered",
        })
    }

    // Check referral code exists (if provided)
    if input.ReferralCode != "" {
        valid, err := v.userRepo.ReferralCodeExists(ctx, input.ReferralCode)
        // Do not swallow this error. A dropped DB error here silently
        // reports a real referral code as "not found".
        if err != nil {
            verrs = append(verrs, FieldError{
                Field:   "referral_code",
                Code:    "VALIDATION_FAILED",
                Message: "unable to validate referral code",
            })
        } else if !valid {
            verrs = append(verrs, FieldError{
                Field:   "referral_code",
                Code:    "INVALID_REFERENCE",
                Message: "referral code not found",
            })
        }
    }

    return verrs
}

// Handler chains format + business validation
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) error {
    var input CreateUserInput

    // 1. Format validation (no DB)
    if err := DecodeAndValidate(r, &input); err != nil {
        return err
    }

    // 2. Business validation (requires DB)
    if verrs := h.validator.ValidateCreateUser(r.Context(), input); len(verrs) > 0 {
        ValidationErrorResponse(w, r, toErrorDetails(verrs))
        return nil
    }

    // 3. Create user
    user, err := h.service.Create(r.Context(), input)
    if err != nil {
        return err
    }

    return WriteJSON(w, http.StatusCreated, user)
}
```

**What FAANG expects:** Awareness of the TOCTOU race - "email exists" check at T0 says no, user is created at T1, and between them a concurrent request claimed the email. The correct answer is to still enforce uniqueness at the database level (unique constraint) and treat the pre-check as a UX optimization, not a correctness guarantee. Senior candidates will mention moving expensive lookups behind rate-limiting or caching (with short TTLs) to avoid enumeration attacks on "does this email exist" endpoints.

**Follow-ups:**
- How do you avoid timing attacks on the email-existence check? (Constant-time response regardless of existence. Or never expose the check at all.)
- Would you use a transaction for the check + create? (Yes when the check informs other state. Otherwise rely on the unique index and handle the `23505` error.)
- What's the HTTP status for the race-loss case? (409 Conflict, with a stable machine-readable code like `email_already_exists`.)

### Question 4: How would you implement error response internationalization?

**Answer:**

```go
// Error message catalog
type ErrorCatalog struct {
    messages map[string]map[string]string // code -> locale -> message
}

func NewErrorCatalog() *ErrorCatalog {
    return &ErrorCatalog{
        messages: map[string]map[string]string{
            "REQUIRED": {
                "en": "%s is required",
                "es": "%s es requerido",
                "fr": "%s est requis",
            },
            "INVALID_EMAIL": {
                "en": "must be a valid email address",
                "es": "debe ser una dirección de correo válida",
                "fr": "doit être une adresse email valide",
            },
            // ...
        },
    }
}

func (c *ErrorCatalog) GetMessage(code, locale, field string) string {
    localeMessages, ok := c.messages[code]
    if !ok {
        return code
    }

    // Try requested locale, fall back to English
    msg, ok := localeMessages[locale]
    if !ok {
        msg = localeMessages["en"]
    }

    if strings.Contains(msg, "%s") {
        return fmt.Sprintf(msg, field)
    }
    return msg
}

// Middleware extracts locale from Accept-Language header
func LocaleMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        locale := parseAcceptLanguage(r.Header.Get("Accept-Language"))
        ctx := context.WithValue(r.Context(), localeKey, locale)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Error response uses locale. Details is []ErrorDetail to match the APIError
// envelope from 40.3: the localizer is where FieldError becomes ErrorDetail.
// Note the response also sets Content-Language, so caches and clients can see
// which locale they actually got rather than guessing.
func ValidationErrorResponse(w http.ResponseWriter, r *http.Request, verrs []FieldError) {
    locale := GetLocale(r.Context())

    localized := make([]ErrorDetail, len(verrs))
    for i, e := range verrs {
        localized[i] = ErrorDetail{
            Field:    e.Field,
            Code:     e.Code,
            Message:  catalog.GetMessage(e.Code, locale, e.Field),
            Value:    e.Value,
            Location: "body",
        }
    }

    w.Header().Set("Content-Language", locale)
    WriteJSON(w, http.StatusUnprocessableEntity, APIError{
        Status:  http.StatusUnprocessableEntity,
        Code:    "VALIDATION_ERROR",
        Message: catalog.GetMessage("VALIDATION_ERROR", locale, ""),
        Details: localized,
    })
}
```

**What FAANG expects:** Knowledge of `golang.org/x/text/language` for proper Accept-Language parsing (quality values, fallback chains via `language.Matcher`) rather than naive substring matching. Mention of ICU MessageFormat or Go's `golang.org/x/text/message` for pluralization/gender (`%d item` vs `%d items`) separates juniors from seniors. Also: error *codes* (stable, machine-readable) are the contract. Messages are presentation, so clients can render their own translations from the code.

**Follow-ups:**
- Where should translation happen, server or client? (Prefer client when the UI owns presentation. Server when emails, SMS, or logs need localizing.)
- How do you handle right-to-left languages and numeric formatting? (`x/text/number`, CLDR data via `x/text`.)
- What if the client sends `Accept-Language: zz-XX`? (Fall back through the matcher. Never 4xx on unknown locales.)

### Question 5: How do you test validation logic effectively?

**Answer:**

Use table-driven tests with thorough edge cases:

```go
func TestUserValidation(t *testing.T) {
    tests := []struct {
        name       string
        input      CreateUserInput
        wantErrors map[string]string // field -> error code
    }{
        {
            name: "valid input passes",
            input: CreateUserInput{
                Email:    "test@example.com",
                Password: "SecurePass123!",
                Name:     "John Doe",
            },
            wantErrors: nil,
        },
        {
            name:       "empty input fails all required",
            input:      CreateUserInput{},
            wantErrors: map[string]string{
                "email":    "REQUIRED",
                "password": "REQUIRED",
                "name":     "REQUIRED",
            },
        },
        {
            name: "invalid email format",
            input: CreateUserInput{
                Email:    "not-an-email",
                Password: "SecurePass123!",
                Name:     "John",
            },
            wantErrors: map[string]string{"email": "INVALID_EMAIL"},
        },
        {
            name: "weak password",
            input: CreateUserInput{
                Email:    "test@example.com",
                Password: "weak",
                Name:     "John",
            },
            wantErrors: map[string]string{"password": "WEAK_PASSWORD"},
        },
        {
            name: "boundary: name exactly at min length",
            input: CreateUserInput{
                Email:    "test@example.com",
                Password: "SecurePass123!",
                Name:     "Jo", // min is 2
            },
            wantErrors: nil, // Should pass
        },
        {
            name: "boundary: name below min length",
            input: CreateUserInput{
                Email:    "test@example.com",
                Password: "SecurePass123!",
                Name:     "J", // below min of 2
            },
            wantErrors: map[string]string{"name": "TOO_SHORT"},
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            verrs := Validate(tt.input)

            if tt.wantErrors == nil {
                require.Empty(t, verrs, "expected no errors")
                return
            }

            errorMap := make(map[string]string)
            for _, e := range verrs {
                errorMap[e.Field] = e.Code
            }

            require.Equal(t, tt.wantErrors, errorMap)
        })
    }
}
```

**What FAANG expects:** Table-driven tests are table stakes. Seniors add *boundary* cases (exactly at min, one below min, one above max), *equivalence classes* (one case per validation rule, not per value), and *negative space* (Unicode edge cases: combining characters, RTL, zero-width joiners in names). Property-based testing with `pgregory.net/rapid` (the stdlib's `testing/quick` is frozen and does not shrink failures), and fuzz testing (`go test -fuzz`) on the decode-and-validate pipeline, are the differentiator. Bonus: snapshotting the full error *shape* (not just codes) to catch accidental envelope changes.

**Follow-ups:**
- How do you test that validation returns *all* errors, not just the first? (Assert on the full set, not length. Use `ElementsMatch`.)
- How do you fuzz-test the validator against the decoder together? (`FuzzDecodeAndValidate(f *testing.F)` with seed corpus of known-bad JSON.)
- What's the right test for a custom regex validator? (Table with matches, near-misses, and ReDoS-style pathological inputs under `testing.Short()` gating.)

### Junior → FAANG: The Entry-Point Interview Playbook

If this is your first API-heavy loop, study the five questions above as a pattern, not as facts to memorize. Each one starts with a concrete scenario, expects a specific code sketch, and ends with a follow-up that probes depth. The structure is the answer. You are being graded on whether you can take a vague prompt and turn it into a bounded problem with a small working example and a tradeoff statement.

A worked template you can carry into any first-job interview. When asked "how would you X," answer in four beats. Beat one: restate the problem and name two constraints the interviewer did not state (body size limits, i18n, rate limiting, whatever is relevant). Beat two: sketch the simplest working code that solves the happy path. Beat three: point at one failure mode of that code and show how you would catch it (a test, a lint rule, a middleware, a database constraint). Beat four: name the next problem this design creates (timing attacks on existence checks, cache invalidation, SDK compatibility) and defer it. Candidates who skip beat four sound junior even when the code is correct.

Prerequisite gaps that show up as follow-up questions. HTTP status semantics across the full 4xx and 5xx range (not just 400 and 500). The difference between `Accept-Language` parsing with a `language.Matcher` and a naive split on commas. Why `validator.Struct` is slow if you construct a new validator per request and what `sync.Once` fixes. Why returning "email already exists" on signup is a user enumeration vulnerability and what the mitigations are (same response for both cases, rate limiting, captcha). Why `errors.Is` matters when a wrapped error crosses a package boundary.

The "why did this fail" reflex in interviews. When the interviewer says "this passed validation but broke in production," the answer ladder is: Unicode normalization, length in bytes versus runes versus grapheme clusters, timezone on date fields, float precision on money, missing transaction boundary on the check-then-create, idempotency on retries. Walk the ladder out loud. Interviewers reward the ladder more than the correct guess.

### Senior @ FAANG: Signal Ladders, Bar-Raiser Prompts, and Calibration

At staff and principal level, the questions above become signal ladders rather than single questions. The interviewer's rubric distinguishes L3 through L7 by what the candidate produces unprompted.

Signal ladder for "design error handling for a 500-endpoint API." L3: returns a consistent JSON shape, uses correct status codes, includes request IDs. L4: picks RFC 9457 Problem Details, designs a registry of `type` URIs, specifies field-level error structure, covers rate-limit headers and `Retry-After`. L5: treats the error catalog as a product artifact with owners, proposes Spectral rules in CI, specifies a migration path from legacy shapes with content negotiation, defines SLOs on error shape consistency, and discusses SDK code generation. L6: extends to organization-wide governance (API council, deprecation policy, cross-product error taxonomy), handles i18n at 30 languages with ICU and a translator workflow, addresses PII redaction at log pipeline scale, and defines a maturity model other teams can self-assess against. L7: frames the error catalog as a business asset (reduced support cost, higher SDK adoption, faster integration time), negotiates cross-organization commitments, and writes the ADR that will outlive the current tech stack.

Signal ladder for "design validation for a payments API." L3: struct tags, a validator library, field-level errors. L4: separates format from business validation, handles TOCTOU with a unique constraint fallback, addresses idempotency keys. L5: designs a validation DSL that non-Go services can reuse, handles batch requests with partial failure semantics (207 Multi-Status or equivalent envelope), addresses Unicode normalization and canonical equivalence, specifies body-size caps and memory bounds. L6: covers regulatory constraints (PCI scope boundaries, PSD2 strong customer authentication triggers, card network rules), handles cross-region consistency, defines a schema evolution policy that does not break clients, specifies observability (metrics per rule, per code, per SDK version). L7: builds the validation platform that other product teams depend on, negotiates API standards across the company, and aligns validation failure taxonomy with fraud, risk, and support tooling.

Bar-raiser prompts to rehearse. "Migrate 100 legacy endpoints to RFC 9457 without a flag day." Expected plan: dual-shape emission driven by `Accept` header, telemetry on shape selection per client, SDK rollout that flips `Accept`, observability-gated cutover, 30-day no-legacy-traffic rule before deletion, documented rollback plan. "Handle i18n for error messages at 30 languages." Expected plan: stable codes are the contract, messages resolve from ICU bundles keyed by code plus locale, translator workflow is async from code deploys via a CMS or TMS, pseudo-locale testing runs in CI, fallback chain is (user preference, Accept-Language matcher, default), logs always use the default locale to keep grep working. "Eliminate PII from error logs at 5TB per day." Expected plan: structured logging with attribute-level redaction, a typed logger API that makes it impossible to log raw PII, sampling by code rather than by request for high-volume errors, differentiated retention by sensitivity class, a pre-production linter that rejects log calls with non-allowlisted keys, and a replay test harness that verifies redaction on historical samples. "Design validation for a batch API accepting 10K items." Expected plan: stream decoding rather than load-all, per-item error collection with index pointers, bounded concurrency for per-item business validation, partial-success response shape, idempotency at the batch and item level, and a body-size ceiling with 413 on overflow.

Calibration notes. Candidates who propose ad-hoc solutions without referring to existing standards (Problem Details, `google.rpc.Status`, Stripe's catalog) signal limited industry awareness and cap at L4. Candidates who cite standards but cannot explain when to deviate (for example, keeping a legacy envelope for a public SDK with long-tail clients) cap at L5. Candidates who treat error handling as a governance and product problem, not only a code problem, start reading as L6 or above.

---
