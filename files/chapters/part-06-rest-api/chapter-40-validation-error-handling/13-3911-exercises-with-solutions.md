## 40.11 Exercises with Solutions

### Exercise 1: Implement Credit Card Validation with Luhn Check

**Problem:** Create a custom validator for credit card numbers using the Luhn algorithm.

**Solution:**

```go
// ... imports omitted for brevity (regexp, strconv, strings, github.com/go-playground/validator/v10)

// RegisterCreditCardValidators registers credit card validation rules
func RegisterCreditCardValidators(v *validator.Validate) error {
    // Basic credit card format
    if err := v.RegisterValidation("credit_card", validateCreditCard); err != nil {
        return err
    }

    // Specific card types
    if err := v.RegisterValidation("visa", validateVisa); err != nil {
        return err
    }
    if err := v.RegisterValidation("mastercard", validateMastercard); err != nil {
        return err
    }
    if err := v.RegisterValidation("amex", validateAmex); err != nil {
        return err
    }

    return nil
}

// validateCreditCard validates a credit card number using Luhn algorithm
func validateCreditCard(fl validator.FieldLevel) bool {
    number := fl.Field().String()
    return isValidCreditCard(number)
}

func isValidCreditCard(number string) bool {
    // Remove spaces and dashes
    number = strings.ReplaceAll(number, " ", "")
    number = strings.ReplaceAll(number, "-", "")

    // Check if it's all digits
    if !regexp.MustCompile(`^\d+$`).MatchString(number) {
        return false
    }

    // Check length (13-19 digits for most cards)
    if len(number) < 13 || len(number) > 19 {
        return false
    }

    // Luhn algorithm
    return luhnCheck(number)
}

// luhnCheck implements the Luhn algorithm (mod 10)
func luhnCheck(number string) bool {
    sum := 0
    alternate := false

    // Process from right to left
    for i := len(number) - 1; i >= 0; i-- {
        digit, _ := strconv.Atoi(string(number[i]))

        if alternate {
            digit *= 2
            if digit > 9 {
                digit -= 9
            }
        }

        sum += digit
        alternate = !alternate
    }

    return sum%10 == 0
}

// Card type validators
func validateVisa(fl validator.FieldLevel) bool {
    number := cleanCardNumber(fl.Field().String())
    // Visa: starts with 4, 13 or 16 digits
    if len(number) != 13 && len(number) != 16 {
        return false
    }
    if !strings.HasPrefix(number, "4") {
        return false
    }
    return luhnCheck(number)
}

func validateMastercard(fl validator.FieldLevel) bool {
    number := cleanCardNumber(fl.Field().String())
    // Mastercard: 16 digits, starts with 51-55 or 2221-2720
    if len(number) != 16 {
        return false
    }
    prefix2 := number[:2]
    prefix4 := number[:4]
    isMasterPrefix := (prefix2 >= "51" && prefix2 <= "55") ||
        (prefix4 >= "2221" && prefix4 <= "2720")
    if !isMasterPrefix {
        return false
    }
    return luhnCheck(number)
}

func validateAmex(fl validator.FieldLevel) bool {
    number := cleanCardNumber(fl.Field().String())
    // Amex: 15 digits, starts with 34 or 37
    if len(number) != 15 {
        return false
    }
    prefix := number[:2]
    if prefix != "34" && prefix != "37" {
        return false
    }
    return luhnCheck(number)
}

func cleanCardNumber(number string) string {
    number = strings.ReplaceAll(number, " ", "")
    number = strings.ReplaceAll(number, "-", "")
    return number
}

// DetectCardType returns the card type based on the number
func DetectCardType(number string) string {
    number = cleanCardNumber(number)
    if len(number) < 4 {
        return "unknown"
    }

    prefix2 := number[:2]
    prefix4 := ""
    if len(number) >= 4 {
        prefix4 = number[:4]
    }

    switch {
    case strings.HasPrefix(number, "4"):
        return "visa"
    case (prefix2 >= "51" && prefix2 <= "55") || (prefix4 >= "2221" && prefix4 <= "2720"):
        return "mastercard"
    case prefix2 == "34" || prefix2 == "37":
        return "amex"
    case prefix2 == "36" || prefix2 == "38" || prefix2 == "39":
        return "diners"
    case prefix4 == "6011" || strings.HasPrefix(number, "65"):
        return "discover"
    default:
        return "unknown"
    }
}

// Usage example.
// ExpiryYear carries no gte=<year> tag: a literal year in a struct tag is
// wrong the moment that year passes. "Not expired" depends on time.Now(),
// so it belongs in a struct-level validator (see 40.2), not a tag.
type PaymentInput struct {
    CardNumber  string `json:"card_number" validate:"required,credit_card"`
    ExpiryMonth int    `json:"expiry_month" validate:"required,min=1,max=12"`
    ExpiryYear  int    `json:"expiry_year" validate:"required,gte=1970"`
    CVV         string `json:"cvv" validate:"required,len=3|len=4"`
}

// Test cases
func TestLuhnCheck(t *testing.T) {
    tests := []struct {
        number string
        valid  bool
    }{
        {"4532015112830366", true},   // Valid Visa
        {"5425233430109903", true},   // Valid Mastercard
        {"374245455400126", true},    // Valid Amex
        {"4532015112830367", false},  // Invalid checksum
        {"1234567890123456", false},  // Invalid
        {"", false},                  // Empty
        {"abcd1234", false},          // Non-numeric
    }

    for _, tt := range tests {
        t.Run(tt.number, func(t *testing.T) {
            result := isValidCreditCard(tt.number)
            if result != tt.valid {
                t.Errorf("isValidCreditCard(%s) = %v, want %v", tt.number, result, tt.valid)
            }
        })
    }
}
```

### Exercise 2: Build an Error Catalog with Documentation Links

**Problem:** Create an error catalog system that provides consistent error codes with documentation links.

**Solution:**

```go
// ... imports omitted for brevity (encoding/json, fmt, net/http, sort, sync)

// ErrorCatalog manages all error definitions
type ErrorCatalog struct {
    mu     sync.RWMutex
    errors map[string]*ErrorDefinition
    baseURL string
}

// ErrorDefinition describes an error type
type ErrorDefinition struct {
    Code        string            `json:"code"`
    HTTPStatus  int               `json:"http_status"`
    Title       string            `json:"title"`
    Description string            `json:"description"`
    Causes      []string          `json:"causes,omitempty"`
    Solutions   []string          `json:"solutions,omitempty"`
    Examples    []ErrorExample    `json:"examples,omitempty"`
    Metadata    map[string]string `json:"metadata,omitempty"`
}

// ErrorExample provides usage examples
type ErrorExample struct {
    Request  string `json:"request,omitempty"`
    Response string `json:"response"`
}

// CatalogError is an error with full catalog information
type CatalogError struct {
    Definition *ErrorDefinition
    Message    string
    Details    []ErrorDetail
    RequestID  string
}

func (e *CatalogError) Error() string {
    return e.Message
}

// NewErrorCatalog creates an error catalog
func NewErrorCatalog(baseURL string) *ErrorCatalog {
    catalog := &ErrorCatalog{
        errors:  make(map[string]*ErrorDefinition),
        baseURL: baseURL,
    }
    catalog.registerBuiltinErrors()
    return catalog
}

func (c *ErrorCatalog) registerBuiltinErrors() {
    // Validation errors
    c.Register(&ErrorDefinition{
        Code:        "VALIDATION_ERROR",
        HTTPStatus:  422,
        Title:       "Validation Failed",
        Description: "One or more fields failed validation.",
        Causes: []string{
            "Required field is missing",
            "Field format is invalid",
            "Value is outside allowed range",
        },
        Solutions: []string{
            "Check the 'details' array for specific field errors",
            "Refer to the API documentation for field requirements",
        },
    })

    c.Register(&ErrorDefinition{
        Code:        "INVALID_JSON",
        HTTPStatus:  400,
        Title:       "Invalid JSON",
        Description: "The request body contains malformed JSON.",
        Causes: []string{
            "Missing quotes around string values",
            "Trailing commas in arrays or objects",
            "Unclosed brackets or braces",
        },
        Solutions: []string{
            "Validate your JSON using a JSON linter",
            "Ensure all string values are quoted",
            "Check for matching brackets and braces",
        },
        Examples: []ErrorExample{
            {
                Request:  `{"name": John}`,
                Response: `{"code": "INVALID_JSON", "message": "Malformed JSON: expected string at position 10"}`,
            },
        },
    })

    c.Register(&ErrorDefinition{
        Code:        "NOT_FOUND",
        HTTPStatus:  404,
        Title:       "Resource Not Found",
        Description: "The requested resource does not exist.",
        Causes: []string{
            "The resource ID is incorrect",
            "The resource was deleted",
            "You don't have permission to view this resource",
        },
        Solutions: []string{
            "Verify the resource ID is correct",
            "List resources to find valid IDs",
            "Check if you have the required permissions",
        },
    })

    c.Register(&ErrorDefinition{
        Code:        "ALREADY_EXISTS",
        HTTPStatus:  409,
        Title:       "Resource Already Exists",
        Description: "A resource with the same unique identifier already exists.",
        Causes: []string{
            "Duplicate email address",
            "Duplicate username",
            "Duplicate external ID",
        },
        Solutions: []string{
            "Use a different value for the unique field",
            "Update the existing resource instead",
            "Delete the existing resource first",
        },
    })

    c.Register(&ErrorDefinition{
        Code:        "RATE_LIMITED",
        HTTPStatus:  429,
        Title:       "Rate Limit Exceeded",
        Description: "You have exceeded the API rate limit.",
        Causes: []string{
            "Too many requests in a short time period",
            "Burst limit exceeded",
        },
        Solutions: []string{
            "Implement exponential backoff with jitter",
            "Check the Retry-After header for when to retry",
            "Consider upgrading your plan for higher limits",
        },
        // The X-RateLimit-* headers are legacy convention, never standardized.
        // The IETF work in this area consolidated on a single RateLimit header
        // carrying the remaining quota and reset window, plus RateLimit-Policy
        // describing the policy itself. Retry-After (RFC 9110) is the one
        // header here that is genuinely standard, so clients should honor it
        // first and treat the rest as advisory.
        Metadata: map[string]string{
            "header_limit":  "RateLimit",
            "header_policy": "RateLimit-Policy",
            "header_retry":  "Retry-After",
        },
    })

    c.Register(&ErrorDefinition{
        Code:        "UNAUTHORIZED",
        HTTPStatus:  401,
        Title:       "Unauthorized",
        Description: "Authentication is required to access this resource.",
        Causes: []string{
            "Missing Authorization header",
            "Invalid or expired token",
            "Malformed token format",
        },
        Solutions: []string{
            "Include a valid Authorization header",
            "Refresh your access token",
            "Verify your API key is correct",
        },
    })
}

// Register adds an error definition to the catalog
func (c *ErrorCatalog) Register(def *ErrorDefinition) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.errors[def.Code] = def
}

// Get retrieves an error definition
func (c *ErrorCatalog) Get(code string) *ErrorDefinition {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.errors[code]
}

// DocURL returns the documentation URL for an error code
func (c *ErrorCatalog) DocURL(code string) string {
    return fmt.Sprintf("%s/errors/%s", c.baseURL, code)
}

// NewError creates an error from the catalog
func (c *ErrorCatalog) NewError(code, message string, details ...ErrorDetail) *CatalogError {
    def := c.Get(code)
    if def == nil {
        def = &ErrorDefinition{
            Code:       code,
            HTTPStatus: 500,
            Title:      "Unknown Error",
        }
    }

    if message == "" {
        message = def.Description
    }

    return &CatalogError{
        Definition: def,
        Message:    message,
        Details:    details,
    }
}

// WriteError writes an error response using the catalog
func (c *ErrorCatalog) WriteError(w http.ResponseWriter, r *http.Request, err *CatalogError) {
    response := map[string]any{
        "status":     err.Definition.HTTPStatus,
        "code":       err.Definition.Code,
        "message":    err.Message,
        "doc_url":    c.DocURL(err.Definition.Code),
        "request_id": GetRequestID(r.Context()),
    }

    if len(err.Details) > 0 {
        response["details"] = err.Details
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(err.Definition.HTTPStatus)
    json.NewEncoder(w).Encode(response)
}

// ServeDocumentation serves error documentation as JSON
func (c *ErrorCatalog) ServeDocumentation(w http.ResponseWriter, r *http.Request) {
    code := r.PathValue("code")

    if code == "" {
        // List all errors. Named defs, not errors, to avoid shadowing the
        // standard library package name.
        c.mu.RLock()
        defs := make([]*ErrorDefinition, 0, len(c.errors))
        for _, def := range c.errors {
            defs = append(defs, def)
        }
        c.mu.RUnlock()

        // Map iteration order is random in Go, so sort for a stable payload.
        // Documentation that reshuffles on every request defeats caching and
        // makes diffs unreadable.
        sort.Slice(defs, func(i, j int) bool { return defs[i].Code < defs[j].Code })

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(defs)
        return
    }

    def := c.Get(code)
    if def == nil {
        http.NotFound(w, r)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(def)
}

// Usage
func main() {
    catalog := NewErrorCatalog("https://api.example.com/docs")

    // Register custom errors
    catalog.Register(&ErrorDefinition{
        Code:        "INSUFFICIENT_BALANCE",
        HTTPStatus:  422,
        Title:       "Insufficient Balance",
        Description: "Your account balance is too low for this transaction.",
        Solutions:   []string{"Add funds to your account", "Use a smaller amount"},
    })

    // Use in handler
    http.HandleFunc("/transfer", func(w http.ResponseWriter, r *http.Request) {
        // ... validation ...

        if balanceCents < amountCents {
            err := catalog.NewError("INSUFFICIENT_BALANCE",
                fmt.Sprintf("Balance $%d.%02d is less than requested $%d.%02d",
                    balanceCents/100, balanceCents%100, amountCents/100, amountCents%100))
            catalog.WriteError(w, r, err)
            return
        }
    })

    // Serve error documentation
    http.HandleFunc("/docs/errors", catalog.ServeDocumentation)
    http.HandleFunc("/docs/errors/{code}", catalog.ServeDocumentation)
}
```

### Junior → FAANG: Work These Exercises Like a Take-Home

Both exercises above are archetypes of take-home questions given to new-grad and early-career engineers. The Luhn exercise tests whether you can read a spec and produce correct, bounded code. The error catalog exercise tests whether you understand data-driven design. Treat them as rehearsal for live coding at Stripe, Square, Adyen, Shopify, or any payments-adjacent company.

Walk-through for Exercise 1. Start by writing the failing test first (TDD as your global rules require). Seed the test table with the published Visa/Mastercard/Amex test numbers, one known-invalid checksum, one too-short input, one with spaces and dashes, and one with a non-ASCII digit character (`'１'` looks like `'1'` but is not). Only then write the Luhn code. The test cases are the spec. A common junior mistake is to read the Wikipedia Luhn description, code it up, run the happy path, and stop. Interviewers are watching for the candidate who thinks about Unicode digit lookalikes, leading zero preservation, and `strconv.Atoi` on a single byte where a simple subtraction (`byte(ch) - '0'`) is clearer and faster.

Worked follow-up on the Luhn code above. Notice the pattern `regexp.MustCompile` inside the hot path. That compiles the regex on every call. A production version caches the compiled regex at package init. A more senior version does not use regex at all, because `for _, r := range s { if r < '0' || r > '9' { return false } }` is faster, allocates nothing, and reads clearer. When the interviewer asks "can you make this faster," that is the answer they want.

Walk-through for Exercise 2. The catalog design above is good enough to ship. The gap for a first-job candidate is recognizing that the catalog is the contract. Every new `Register` call is a public API change. Ask the interviewer "where does this catalog live, in code or in a separate data file?" The answer ("code today, but we want to generate it from YAML later") opens the door to the staff-level discussion below.

The "why did this fail" reflex for these exercises. If your Luhn check passes all tests but still rejects a real card in production, the input has non-breaking spaces, zero-width joiners, or full-width digits that your cleaner missed. If your error catalog returns "Unknown Error" with a 500, someone registered a typo'd code or the catalog initialization ran after the handler registered. Both are common and both are caught by integration tests that exercise the decode-to-response path, not just the unit under test.

### Senior @ FAANG: Staff Extensions to These Exercises

The exercises as written produce correct L3 code. At staff and principal level, the same prompts expand into platform work.

Staff extension to Exercise 1: build a typed error library with stable codes, structured metadata, i18n-ready messages, and a catalog contract. The Luhn validator is one rule in a library of hundreds. Design the library so every rule emits a `{code, field, params, i18n_key}` tuple rather than a formatted string, so that the same rule serves a mobile SDK rendering French, a support tool rendering English, and a log pipeline rendering a locale-neutral default. Expose a `ValidationFailure` type that implements `error`, unwraps into a tree of per-field failures, and serializes directly to RFC 9457 with a `violations` extension member. Ship a code-generation tool that reads a YAML catalog and emits both Go constants and TypeScript enums so the client and server share a single source of truth. Add a `Deprecated` field on each rule and a linter that fails CI if a handler references a deprecated rule after its sunset date.

Staff extension to Exercise 2: implement an RFC 9457 middleware that replaces the bespoke JSON envelope with `application/problem+json`. The middleware intercepts any `*CatalogError` returned from a handler, sets the content type, writes the Problem Details shape (`type`, `title`, `status`, `detail`, `instance`), adds the extension members (`code`, `traceId`, `violations`, `retryAfter`), respects content negotiation for clients that still request the legacy shape during migration, and emits metrics keyed by `code` so the error dashboard can surface rising volume. Wire it through `slog` with a redaction `Handler` that strips any attribute matching a configured PII pattern before the log line leaves the process. Add a test that panics inside a handler and asserts the outermost recover produces a valid Problem Details payload with no stack trace in the body. Gate the rollout behind a feature flag keyed by route, and add telemetry that reports the ratio of legacy-shape to Problem Details responses per SDK version.

Staff extension three: design a validation DSL that non-Go services can reuse. Define rules declaratively (YAML, CUE, or a small purpose-built grammar), compile them into an intermediate representation, and ship runtimes in Go, TypeScript, and Python. The Go runtime plugs into the validator library from extension one. The TypeScript runtime runs in the browser for pre-submission hints. The Python runtime runs in the batch pipeline that validates 10K-item uploads. The same rule text is the contract across all three, which means a change to "email must match this pattern" lands in one PR rather than three, and the test suite runs across all runtimes in CI.

ADR for adopting these extensions. Context: validation and error handling were duplicated per service, client SDKs carried per-service parsers, and support could not correlate user complaints to logs. Decision: adopt a shared error catalog as code-generated artifact, ship RFC 9457 middleware as a platform library, and standardize validation on a DSL with multi-language runtimes. Consequences: net reduction in per-service code, faster onboarding for new services, versioning discipline becomes mandatory (the catalog is now a published API), and the platform team owns an on-call rotation for the catalog and middleware. Alternatives rejected: per-service ownership with style guides (fails to produce consistency at scale), buy-versus-build for a third-party validation platform (vendor lock-in on a contract surface this central is a higher risk than the engineering cost).

Maturity model extensions. L3: per-service catalogs, copy-paste code, inconsistent shapes across teams. L4: shared library in one language, manual catalog entries, consistent shapes within a service. L5: code-generated catalog from a YAML source, Problem Details middleware, SDK types generated from the same source. L6: validation DSL with multi-language runtimes, governance via API council, automated doc generation, PII redaction enforced at log handler. L7: error taxonomy drives product decisions (fraud signals, retry policy, SLO alerting, translator workflow), catalog is a published artifact with deprecation policy, and new rules require business review alongside engineering review.

Bar-raiser extension prompt. "Extend the error catalog to support 30 languages, 200 error codes, five SDK languages, and a translator workflow that does not block engineering deploys." Expected signal: messages are message IDs not strings, translators work in a TMS that produces signed ICU bundles, bundles load at runtime with a fallback chain, pseudo-locale runs in CI and catches concatenation bugs, and the deployment model decouples code releases from translation releases via bundle versioning. Candidates who propose adding language fields to the catalog struct fail the loop.

---
