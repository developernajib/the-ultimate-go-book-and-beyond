## 40.9 Common Mistakes and How to Avoid Them

### Mistake 1: Leaking Internal Error Details

A raw PostgreSQL constraint violation message reveals the table name, column name, and database engine to the caller. That is enough information to start crafting targeted injection or enumeration attacks. The corrected handler inspects the error type internally, maps it to a safe code like `ALREADY_EXISTS`, and includes the request ID in the response so support teams can correlate the client message to the full server log.

```go
// ❌ Wrong: Exposing internal details
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.service.Create(r.Context(), input)
    if err != nil {
        // Leaks database schema, SQL queries, internal paths
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
}

// Example leaked error:
// "pq: duplicate key value violates unique constraint "users_email_key""
// Attacker now knows: PostgreSQL, table name "users", column "email"

// ✅ Correct: Generic errors for clients, detailed logs internally
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.service.Create(r.Context(), input)
    if err != nil {
        requestID := GetRequestID(r.Context())

        // Log full details internally. Note what is NOT here: the raw email.
        // An email is PII, and error logs fan out to a far wider audience
        // than your user store. Log a stable non-reversible handle instead,
        // so you can still correlate reports without spraying addresses
        // through every downstream log sink.
        h.logger.Error("failed to create user",
            "error", err,
            "request_id", requestID,
            "email_hash", hashForLogs(input.Email),
        )

        // Map to safe client error
        if isDuplicateKeyError(err) {
            ErrorResponse(w, r, http.StatusConflict, "ALREADY_EXISTS",
                "A user with this email already exists")
            return
        }

        // Generic error for unexpected failures
        ErrorResponse(w, r, http.StatusInternalServerError, "INTERNAL_ERROR",
            "An unexpected error occurred. Reference: "+requestID)
    }
}
```

### Mistake 2: Inconsistent Error Formats

When each endpoint invents its own error shape, client SDK authors must write endpoint-specific error parsers, and monitoring dashboards cannot aggregate errors across the API surface. Centralizing all error responses through named helper functions like `NotFound` and `ValidationError` ensures every response shares the same `APIError` envelope.

```json
// ❌ Wrong: Multiple error formats in same API
// Endpoint A:
{"error": "not found"}

// Endpoint B:
{"message": "Not Found", "code": 404}

// Endpoint C:
{"errors": [{"field": "email", "msg": "invalid"}]}
```

```go
// ✅ Correct: Single consistent format everywhere
type APIError struct {
    Status    int           `json:"status"`
    Code      string        `json:"code"`
    Message   string        `json:"message"`
    Details   []ErrorDetail `json:"details,omitempty"`
    RequestID string        `json:"request_id"`
    Timestamp string        `json:"timestamp"`
}

// All handlers use same error functions:
func NotFound(w http.ResponseWriter, r *http.Request, resource string)
func ValidationError(w http.ResponseWriter, r *http.Request, details []ErrorDetail)
func InternalError(w http.ResponseWriter, r *http.Request)
// etc.
```

### Mistake 3: Not Validating Early

Performing two database queries before checking that `amount > 0` wastes round-trips on inputs that should have been rejected at the HTTP layer. The corrected handler decodes and validates the request body first, before touching any repository, keeping expensive operations gated behind cheap, synchronous checks.

```go
// ❌ Wrong: Validation happens too late
func (h *Handler) Transfer(w http.ResponseWriter, r *http.Request) {
    var input TransferInput
    json.NewDecoder(r.Body).Decode(&input)

    // Start expensive operations before validation
    fromAccount, _ := h.accountRepo.Get(r.Context(), input.FromID)
    toAccount, _ := h.accountRepo.Get(r.Context(), input.ToID)

    // Now validate... after two DB queries
    if input.Amount <= 0 {
        BadRequest(w, r, "amount must be positive")
        return
    }
    // ...
}

// ✅ Correct: Validate before any expensive operations.
// Note the signature returns error, matching the ErrorHandler.Wrap adapter
// from 40.6. The `return err` lines below do not compile without it.
func (h *Handler) Transfer(w http.ResponseWriter, r *http.Request) error {
    var input TransferInput

    // 1. Parse and validate first
    if err := DecodeJSONBody(w, r, &input); err != nil {
        return err
    }

    if verrs := Validate(input); len(verrs) > 0 {
        ValidationErrorResponse(w, r, toErrorDetails(verrs))
        return nil
    }

    // 2. Now do expensive operations
    fromAccount, err := h.accountRepo.Get(r.Context(), input.FromID)
    if err != nil {
        return err
    }
    // ...
    return nil
}
```

### Mistake 4: Using Wrong Status Codes

Using `400` for authentication failures or `500` for client input errors misleads HTTP intermediaries, retry logic, and alerting rules that distinguish client errors (4xx) from server failures (5xx). The reference table maps each scenario to its precise code so the API communicates intent through the protocol itself.

```go
// ❌ Wrong: Misusing status codes
// Returning 200 for errors
w.WriteHeader(200)
json.Encode(map[string]string{"error": "not found"})

// Using 400 for everything
func BadRequest(w, r, msg string) {
    w.WriteHeader(400) // Even for 404, 401, 409 cases
}

// Using 500 for client errors
if input.Email == "" {
    w.WriteHeader(500) // Should be 400 or 422
}

// ✅ Correct: Semantic status codes
// 400 Bad Request:    Malformed syntax (JSON parse error)
// 401 Unauthorized:   Missing/invalid authentication
// 403 Forbidden:      Authenticated but not authorized
// 404 Not Found:      Resource doesn't exist
// 409 Conflict:       State conflict (duplicate, stale update)
// 422 Unprocessable:  Validation failed (valid syntax, invalid data)
// 429 Too Many:       Rate limited
// 500 Internal:       Server-side failures only
// 503 Unavailable:    Temporary overload
// 504 Timeout:        Upstream timeout
```

### Mistake 5: Forgetting Error Response in Early Returns

A bare `return` after a guard check sends a `200 OK` with an empty body, which is worse than an explicit error because the client cannot tell whether the request succeeded or failed. Returning a `RequestError` value from the handler and letting a central error-handling layer write the response eliminates all silent failure paths.

```go
// ❌ Wrong: Silent failures
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    if id == "" {
        return // Client gets empty response!
    }

    user, err := h.service.Get(r.Context(), id)
    if err != nil {
        w.WriteHeader(500) // No body, client can't understand error
        return
    }
    // ...
}

// ✅ Correct: Always return proper error response
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) error {
    id := r.PathValue("id")
    if id == "" {
        return &RequestError{
            Status:  http.StatusBadRequest,
            Code:    "MISSING_PARAMETER",
            Message: "User ID is required",
        }
    }

    user, err := h.service.Get(r.Context(), id)
    if err != nil {
        return err // Error handler writes proper response
    }

    WriteJSON(w, http.StatusOK, user)
    return nil
}
```

### Junior → FAANG: The Mistakes That Cost You the Offer

Every mistake above has shown up in a real postmortem, and every one of them is a common interview trap. If a prompt says "here is a handler, find the bugs," the reviewer is watching for the reflex to look at status codes first, response shape second, and business logic third. Candidates who dive straight into the SQL without noticing the 200-on-error fail the loop before they finish reading.

Worked example to internalize. Given this handler:

```go
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
    var in LoginInput
    json.NewDecoder(r.Body).Decode(&in)
    user, err := h.repo.ByEmail(r.Context(), in.Email)
    if err != nil { http.Error(w, err.Error(), 500); return }
    if user.Password != in.Password { http.Error(w, "wrong password", 401); return }
    json.NewEncoder(w).Encode(user)
}
```

List the defects before reading on. Answer ladder: ignored decode error, no body size cap, no content-type check, leaks `err.Error()` (which may contain `sql: connection refused` and therefore an internal hostname), plaintext password comparison with a timing side channel, "wrong password" reveals whether the email exists (enumeration), encodes the full user struct including the password hash and any internal fields, no request ID, no rate limiting, no structured log. A first-job candidate who finds four of these is on track. A FAANG new-grad candidate is expected to find seven.

The "why did this fail" reflex for each mistake above. Mistake 1 (leaks): diff the response body against an allowlist of fields before it ever leaves the process, and fail CI if `err.Error()` reaches `w.Write`. Mistake 2 (shape drift): contract test every handler against the shared schema, not just the happy path. Mistake 3 (late validation): measure p50 latency on 400 responses, if it is above single-digit milliseconds you are doing database work on invalid input. Mistake 4 (wrong codes): alerting that pages on 5xx will never fire if you return 200, which is how silent outages last for days. Mistake 5 (silent returns): enable the `errcheck` and `nilerr` linters, and make the handler signature return `error` so a bare `return` does not compile.

Prerequisite reading for these mistakes: Go's `errors.Is` and `errors.As`, the difference between `json.Decoder` with `DisallowUnknownFields` and without, `http.MaxBytesReader`, `subtle.ConstantTimeCompare`, and why `fmt.Errorf("%w", err)` is not the same as `fmt.Errorf("%v", err)`. An interviewer who asks "what is wrong with this error message" is often testing whether you know `%w` preserves the chain.

### Senior @ FAANG: The Long Tail of Error Antipatterns and the Governance That Catches Them

The five mistakes above are the obvious ones. The ones that sink mature APIs are quieter, and staff engineers are hired to see them before they ship.

The long tail worth cataloging. Returning 200 on errors (breaks every retry policy downstream, hides SLO breaches, defeats circuit breakers). Leaking stack traces (Go's default panic handler will write the trace to the response if your recovery middleware is misordered, which reveals package paths, function names, and sometimes environment variables). No field-level errors (forces the client into one-at-a-time form submission, destroys mobile UX). Inconsistent shapes across endpoints (forces SDK teams to write parser-per-endpoint, multiplies maintenance cost, blocks code generation). Missing request ID (makes support impossible, because a user complaint cannot be joined to logs). No retry guidance in 429 and 503 (clients either hammer or give up, and both are wrong, the correct answer is `Retry-After` with jitter guidance). Validating only in the handler (skips the service layer and lets internal callers, cron jobs, and message consumers bypass invariants). Forgetting Unicode normalization: "café" can arrive as NFC (`caf` + U+00E9, one precomposed code point) or as NFD (`cafe` + U+0301, a combining acute accent). Both render identically, both look correct in a bug report, and they compare unequal as Go strings, so a user registers twice with visually identical addresses and the uniqueness constraint never fires. Normalize to a single form with `golang.org/x/text/unicode/norm` before you compare, hash, or store. No body size cap (a 10GB request will happily consume memory until OOM). Trusting input types (JSON numbers are float64 in Go by default, so a user ID "larger than 2^53" silently loses precision, and `json.Number` or string encoding is the fix).

ADR-grade fixes rather than patches. For PII in error logs, do not rely on developer discipline. Ship a `slog.Handler` wrapper that walks attributes and redacts any key matching a configured regex, and fail CI if a new log call adds a key outside the allowlist. For stack trace leakage, the recovery middleware must be the outermost middleware and must always return the configured error shape, and you should have a test that panics deliberately and asserts the response body contains no file paths. For shape drift, generate the error type from an OpenAPI or protobuf definition and make the handwritten struct a compile error.

Governance that catches these at scale. An error catalog as a first-class artifact, versioned in its own repository, with owners, review gates, and automated doc generation. Spectral rules in CI that fail any OpenAPI spec whose error responses do not reference the shared Problem Details schema. A Problem Details `type` URI registry with a process for adding new URIs (proposal, review, 30-day comment period for breaking changes). Lint rules in the Go codebase that forbid `http.Error` outside a short allowlist of packages, forcing everyone through the typed error path. A weekly error dashboard that surfaces new codes, codes with rising volume, and codes that have no client SDK handler.

Bar-raiser prompts. "Eliminate PII from error logs at 5TB per day." Expected signal: structured logging with attribute-level redaction, sampling strategy for high-volume codes, retention policy differentiated by sensitivity, a compile-time check that new log statements cannot introduce raw PII fields, and a migration plan that does not drop existing log volume during rollout. "Handle i18n for error messages at 30 languages." Expected signal: messages are not stored in the catalog as English strings but as message IDs resolved per-request from an ICU MessageFormat bundle, the stable `code` never changes across translations, fallback chain is explicit (user locale, Accept-Language, default), pseudo-locale testing catches concatenation bugs, and translator workflow is async from code deploys. Candidates who propose `if lang == "fr"` branches inside handlers fail the loop.

Maturity model for mistakes-to-absence. L1: mistakes are discovered by customer complaints. L2: mistakes are caught in staging by QA. L3: mistakes are caught in CI by lint and contract tests. L4: mistakes are prevented at compile time by generated types and wrapped helpers. L5: mistakes are prevented at design time by an API council that reviews every new endpoint against the catalog before it is implemented.

---
