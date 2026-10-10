## 40.8 Company Case Studies

### How Stripe Handles Error Responses

Stripe structures every error around a `type` (category like `card_error` or `api_error`), a `code` (specific machine-readable cause), a `param` (which field failed), and a `doc_url` (link to the relevant documentation page). This format lets client SDKs switch on the type and code without parsing the human-readable message.

```go
// Stripe's Error Response Structure
type StripeError struct {
    Error StripeErrorBody `json:"error"`
}

type StripeErrorBody struct {
    Type           string `json:"type"`            // card_error, api_error, etc.
    Code           string `json:"code"`            // specific error code
    DocURL         string `json:"doc_url"`         // link to documentation
    Message        string `json:"message"`         // human-readable
    Param          string `json:"param,omitempty"` // which parameter failed
    RequestLogURL  string `json:"request_log_url,omitempty"`
    DeclineCode    string `json:"decline_code,omitempty"` // for card errors
}

// Implementation inspired by Stripe.
//
// Note this is a distinct type from the APIError envelope in 40.3. That one
// is the book's own envelope (status, code, details, trace_id). This one
// mirrors Stripe's shape (type, code, param, doc_url). Pick one envelope for
// your API and stay on it. Two error shapes in one service is the exact
// inconsistency this chapter argues against.
type StripeStyleError struct {
    Type    string `json:"type"`
    Code    string `json:"code"`
    Message string `json:"message"`
    Param   string `json:"param,omitempty"`
    DocURL  string `json:"doc_url,omitempty"`
}

func (e *StripeStyleError) Error() string { return e.Message }

type StripeStyleErrors struct {
    docBase string
}

func (s *StripeStyleErrors) CardError(code, message, param string) *StripeStyleError {
    return &StripeStyleError{
        Type:    "card_error",
        Code:    code,
        Message: message,
        Param:   param,
        DocURL:  fmt.Sprintf("%s/errors/%s", s.docBase, code),
    }
}

func (s *StripeStyleErrors) InvalidRequestError(code, message, param string) *StripeStyleError {
    return &StripeStyleError{
        Type:    "invalid_request_error",
        Code:    code,
        Message: message,
        Param:   param,
        DocURL:  fmt.Sprintf("%s/errors/%s", s.docBase, code),
    }
}

// Error codes with consistent naming
const (
    // Card errors
    ErrCardDeclined          = "card_declined"
    ErrExpiredCard           = "expired_card"
    ErrIncorrectCVC          = "incorrect_cvc"
    ErrInsufficientFunds     = "insufficient_funds"

    // Validation errors
    ErrParameterMissing      = "parameter_missing"
    ErrParameterInvalid      = "parameter_invalid"
    ErrParameterUnknown      = "parameter_unknown"

    // Resource errors
    ErrResourceMissing       = "resource_missing"
    ErrResourceAlreadyExists = "resource_already_exists"
)

// Usage in handler. `errs` is a field on the handler, not a package-level
// global, so the doc base URL stays injectable in tests.
type PaymentHandler struct {
    paymentService PaymentService
    errs           *StripeStyleErrors
}

func (h *PaymentHandler) CreateCharge(w http.ResponseWriter, r *http.Request) error {
    var input ChargeInput
    if err := DecodeJSON(r, &input); err != nil {
        // Do not pass err.Error() through: it is an internal parser message.
        // Emit a stable code and a message you actually control.
        return h.errs.InvalidRequestError(ErrParameterInvalid, "Request body could not be parsed", "")
    }

    // Validate amount
    if input.Amount <= 0 {
        return h.errs.InvalidRequestError(
            ErrParameterInvalid,
            "Amount must be at least 1 cent",
            "amount",
        )
    }

    // Process payment
    charge, err := h.paymentService.CreateCharge(r.Context(), input)
    if err != nil {
        var cardErr *CardError
        if errors.As(err, &cardErr) {
            return h.errs.CardError(cardErr.Code, cardErr.Message, "card")
        }
        return err
    }

    WriteJSON(w, http.StatusCreated, charge)
    return nil
}
```

### How Google Cloud Handles Errors

Google Cloud APIs follow the `google.rpc.Status` model, where every error carries an HTTP code, a gRPC status name (like `INVALID_ARGUMENT`), and a `details` array of typed objects. Field-level violations live inside a `BadRequest` detail with an `@type` discriminator, so clients can handle different detail types (quota errors, precondition failures, field violations) with a single parsing strategy.

```go
// Google Cloud Error Model
type GoogleError struct {
    Error GoogleErrorBody `json:"error"`
}

type GoogleErrorBody struct {
    Code    int                 `json:"code"`    // HTTP status
    Message string              `json:"message"` // Developer message
    Status  string              `json:"status"`  // gRPC status name
    Details []GoogleErrorDetail `json:"details,omitempty"`
}

// Named GoogleErrorDetail, not ErrorDetail, to avoid colliding with the
// book's own ErrorDetail from 40.3. The two carry different fields.
type GoogleErrorDetail struct {
    Type            string            `json:"@type"`
    FieldViolations []FieldViolation  `json:"fieldViolations,omitempty"`
    Reason          string            `json:"reason,omitempty"`
    Domain          string            `json:"domain,omitempty"`
    Metadata        map[string]string `json:"metadata,omitempty"`
}

type FieldViolation struct {
    Field       string `json:"field"`
    Description string `json:"description"`
}

// Google-style error implementation
func GoogleStyleValidationError(violations []FieldViolation) GoogleError {
    return GoogleError{
        Error: GoogleErrorBody{
            Code:    400,
            Message: "Request contains an invalid argument.",
            Status:  "INVALID_ARGUMENT",
            Details: []GoogleErrorDetail{
                {
                    Type:            "type.googleapis.com/google.rpc.BadRequest",
                    FieldViolations: violations,
                },
            },
        },
    }
}

// Example response:
// {
//   "error": {
//     "code": 400,
//     "message": "Request contains an invalid argument.",
//     "status": "INVALID_ARGUMENT",
//     "details": [
//       {
//         "@type": "type.googleapis.com/google.rpc.BadRequest",
//         "fieldViolations": [
//           {
//             "field": "email",
//             "description": "must be a valid email address"
//           }
//         ]
//       }
//     ]
//   }
// }
```

### How Shopify Validates Webhook Payloads

Shopify signs every webhook with `base64(HMAC-SHA256(raw_body, client_secret))` and sends it in the `X-Shopify-Hmac-SHA256` header. Verification has three requirements that are easy to get wrong: you must hash the *raw* body (any middleware that parses and re-serializes JSON will change the bytes and break the signature), you must decode both values to bytes before a timing-safe comparison, and you must never log signature material.

Shopify does not send a timestamp header, so it has no Stripe-style signed-timestamp replay window. Its at-least-once delivery model means the same webhook can legitimately arrive more than once, and the mechanism for handling that is deduplication on the `X-Shopify-Webhook-Id` header, not a freshness check.

```go
// Shopify Webhook Validation Pattern
// ... imports omitted for brevity (bytes, crypto/hmac, crypto/sha256,
// encoding/base64, io, log/slog, net/http)
type WebhookValidator struct {
    secretKey []byte
    seen      SeenStore // dedupe by X-Shopify-Webhook-Id
}

// SeenStore records webhook IDs already handled. SeenBefore reports whether
// the ID was present and records it atomically if not.
type SeenStore interface {
    SeenBefore(ctx context.Context, id string) (bool, error)
}

func NewWebhookValidator(secret string, seen SeenStore) *WebhookValidator {
    return &WebhookValidator{
        secretKey: []byte(secret),
        seen:      seen,
    }
}

func (v *WebhookValidator) ValidateMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Get signature from header
        signature := r.Header.Get("X-Shopify-Hmac-SHA256")
        if signature == "" {
            ErrorResponse(w, r, http.StatusUnauthorized, "MISSING_SIGNATURE",
                "X-Shopify-Hmac-SHA256 header is required")
            return
        }

        // Read body
        body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20)) // 10MB max
        if err != nil {
            ErrorResponse(w, r, http.StatusBadRequest, "BODY_READ_ERROR",
                "Failed to read request body")
            return
        }
        r.Body = io.NopCloser(bytes.NewBuffer(body))

        // Decode the client-supplied signature to raw bytes. Shopify's own
        // guidance is to compare decoded bytes, and it also means a garbage
        // header is rejected here rather than later.
        received, err := base64.StdEncoding.DecodeString(signature)
        if err != nil {
            ErrorResponse(w, r, http.StatusUnauthorized, "INVALID_SIGNATURE",
                "Webhook signature validation failed")
            return
        }

        // Compute expected signature over the RAW body bytes.
        mac := hmac.New(sha256.New, v.secretKey)
        mac.Write(body)
        expected := mac.Sum(nil)

        // Constant-time comparison. hmac.Equal, never ==, and never
        // bytes.Compare, both of which leak timing.
        if !hmac.Equal(received, expected) {
            // Log the fact of the failure and nothing about the signatures.
            // Echoing even a prefix of the expected HMAC hands an attacker a
            // free oracle, and slicing an attacker-controlled header (
            // signature[:10]) panics outright on a short value.
            slog.Warn("webhook signature mismatch",
                "webhook_id", r.Header.Get("X-Shopify-Webhook-Id"),
                "topic", r.Header.Get("X-Shopify-Topic"),
            )
            ErrorResponse(w, r, http.StatusUnauthorized, "INVALID_SIGNATURE",
                "Webhook signature validation failed")
            return
        }

        next.ServeHTTP(w, r)
    })
}

// Shopify delivers at least once, so the same webhook can arrive twice. There
// is no signed timestamp to check, so dedupe on the webhook ID and make the
// handler idempotent. Seen is backed by Redis or similar with a TTL comfortably
// longer than Shopify's retry window.
func (v *WebhookValidator) AlreadyProcessed(ctx context.Context, r *http.Request) (bool, error) {
    id := r.Header.Get("X-Shopify-Webhook-Id")
    if id == "" {
        return false, nil // nothing to dedupe on, let the handler decide
    }
    return v.seen.SeenBefore(ctx, id)
}
```

### Junior → FAANG: Reading These Case Studies Like a First-Year Engineer

If you are early in your career, the first thing to notice is that none of these companies return a bare string. Every payload has at least three load-bearing fields: a stable machine code, a human message, and a pointer to where the client should look next (a field path, a doc URL, or a decline code). That shape is not decoration. It is what lets a mobile app written three years ago keep working when a new error case ships, because the app switches on `code` and falls back to `message` for anything it does not recognize.

Work this mini example. You are writing a signup handler and the email already exists. A junior instinct is `http.Error(w, "email taken", 409)`. Read the Stripe block above and rewrite it as a typed error with `type: "invalid_request_error"`, `code: "resource_already_exists"`, `param: "email"`, and a `doc_url`. Now your frontend can render a red underline under the email field without parsing English. That is the whole point of the pattern, and it is the answer hiring managers want when they ask "why did your last API fail in production."

The "why did this fail" reflex to build right now: when a response arrives that you cannot explain, open devtools, copy the `X-Request-Id`, and search the logs. If the body has no request ID, that is bug one. If the body has a stack trace, that is bug two and a security incident. If the body is HTML from a reverse proxy, your error middleware never ran. Interviewers at Stripe, Shopify, and Google will hand you a screenshot of a broken response and ask what you would fix first, and the expected ladder is: request ID, shape, status code, taxonomy, documentation link.

Prerequisite gaps to close before your first API-heavy interview: HTTP status semantics (400 vs 422 vs 409 vs 429), idempotency keys, HMAC and constant-time comparison (note `hmac.Equal` in the Shopify block, never `==` on signatures), and the difference between an error category and an error code. If you cannot explain why `hmac.Equal` exists, study timing attacks before going further.

One more habit from that same block: never slice a header value at a fixed offset. `signature[:10]` looks like harmless log truncation, but the header is attacker-controlled, and a three-character value turns it into an out-of-range panic. Every string you take from a request is adversarial input, including the ones you only meant to log.

### Senior @ FAANG: Error Catalogs, Governance, and the Long Tail

At staff and principal level, the case studies above are not implementation references. They are artifacts of governance. Stripe's error catalog is a product surface with its own on-call rotation, its own changelog, and its own deprecation policy. Adding a new `code` at Stripe requires catalog review because every code becomes a client branch somewhere in the world and cannot be deleted for years. Treat that as the bar. If your company cannot tell you who owns the error catalog, that is your first ADR.

ADR template for adopting an error model at scale. Context: heterogeneous services returning inconsistent shapes, SDK teams writing per-endpoint parsers, support tickets quoting opaque messages. Decision: adopt RFC 9457 Problem Details as the wire shape, with a registry of `type` URIs owned by the API platform team, a required `code` extension member for machine handling, and a required `traceId` extension for support correlation. Consequences: every new service ships with a lint rule (Spectral) that rejects responses without `type` and `code`, every error gets a doc page generated from the registry, and SDKs ship a single parser. Alternatives rejected: Google `google.rpc.Status` (great for gRPC-native shops, awkward to retrofit into REST-first estates without the `@type` discriminator tooling), bespoke envelopes (cheap to start, expensive to migrate from at 500 endpoints).

Maturity model for API error handling, L1 through L5. L1: strings and 500s, no catalog, no request IDs. L2: consistent JSON envelope per service, no cross-service consistency, request ID present but not propagated. L3: organization-wide envelope (Problem Details or equivalent), request ID propagated via W3C Trace Context, field-level errors standardized. L4: error catalog as a first-class artifact with owners, deprecation policy, and automated documentation generation, SDK parsers generated from the catalog, Spectral rules enforced in CI. L5: error taxonomy drives product decisions (retry policy, circuit breakers, SLO alerting, i18n pipeline), errors are versioned independently of endpoints, and new codes require a written rationale reviewed by API council.

Cross-cutting patterns worth lifting from the case studies. From Stripe: stable codes survive message edits, which means you can rewrite English copy in all 30 languages without breaking a single SDK. From Google: the `details` array with `@type` discriminators lets you evolve error payloads without a breaking change, because unknown detail types are ignorable by older clients. From Shopify: HMAC over the raw body, a body size cap, and dedupe on the delivery ID are the minimum for any inbound webhook. Note what the provider gives you differs: Shopify signs the body only, so replay defense is idempotency, while Stripe signs a timestamp alongside the payload and expects you to reject stale signatures. Copying Stripe's freshness window onto a Shopify integration means checking a header that does not exist. From AWS across its 200+ services: consistency of shape is more valuable than expressiveness of shape, and the boring envelope that every service uses beats the elegant envelope that only three services use. From Meta's GraphQL conventions: extensions carrying `code` and `classification` let a single error channel serve both user-facing validation and operational failures without ambiguity. From Twilio: numeric error codes (like `20003` for authentication) are searchable across decades of documentation and support tickets in a way string codes are not, but they demand a registry authority to hand out ranges.

Bar-raiser prompt to prepare for. "You inherit 100 legacy endpoints across 14 services, each with its own error shape. Migrate them to RFC 9457 without breaking any existing client." The signal they want: a content-negotiation strategy (emit legacy shape when `Accept: application/json`, emit Problem Details when `Accept: application/problem+json`), a dual-write period with telemetry on which shape clients request, a deprecation clock tied to observed usage rather than calendar, an SDK update that flips the `Accept` header, and a final cutover gated on zero legacy requests for 30 days. Candidates who propose a flag day fail the loop.

---
