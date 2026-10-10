## 42B.9 Complete Example: Designing a Payment API

### Requirements Gathering

Business requirements:
- Accept payments from users on behalf of merchants
- Support cards, bank transfers, and wallets
- Idempotent, network failures must not cause double charges
- PCI-compliant, no raw card data stored
- Multi-currency, 135+ currencies (ISO 4217 codes)
- Amounts always expressed in the smallest currency unit (cents for USD, yen for JPY)
- Webhook notifications to merchants for payment events, HMAC-signed with replay protection

Technical constraints:
- Sub-200ms P99 for payment creation
- 99.99% availability SLA
- Full audit trail for compliance

### Resource Modeling

Domain models represent the core entities and value objects of the application. Keeping models free of framework annotations and database tags in the domain layer maintains a clean separation between business logic and infrastructure concerns.

```
Core resources:
- PaymentMethod (card, bank_account, wallet) - represents a payment instrument
- Customer (links payment methods to a user identity)
- Payment (a charge attempt against a payment method)
- Refund (partial or full refund of a payment)
- Payout (transfer of collected funds to merchant)
- Webhook (merchant-registered event endpoint)

Relationships:
- Payment → PaymentMethod (the instrument used)
- Payment → Customer (optional, for saved customers)
- Refund → Payment (refund of a payment)
- WebhookDelivery → Webhook + Event (delivery record)
```

### Full Go Implementation

The payment handler encodes the idempotency key in the request context and checks it against persistent storage before executing the charge, ensuring that a network-interrupted client can safely replay the same request without double-charging. Sentinel domain errors like `ErrDuplicate` and `ErrInsufficientFunds` are translated to precise HTTP status codes at the handler boundary, keeping business logic free of HTTP concerns.

```go
// internal/api/payments/handler.go
package payments

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "net/http"
    "time"
    "uuid"

    "github.com/go-chi/chi/v5"
)

// -------- Request/Response Types --------

type CreatePaymentRequest struct {
    Amount         int64   `json:"amount" validate:"required,min=1,max=99999999"`
    Currency       string  `json:"currency" validate:"required,iso4217"`
    PaymentMethod  string  `json:"payment_method" validate:"required"`
    CustomerID     *string `json:"customer_id" validate:"omitempty,uuid"`
    Description    string  `json:"description" validate:"max=500"`
    Metadata       map[string]string `json:"metadata" validate:"max=20keys"`
    IdempotencyKey string  `json:"-"` // From header
    StatementDescriptor string `json:"statement_descriptor" validate:"max=22"`
}

type PaymentResponse struct {
    ID              string            `json:"id"`
    Object          string            `json:"object"` // always "payment"
    Amount          int64             `json:"amount"`
    Currency        string            `json:"currency"`
    Status          string            `json:"status"`
    PaymentMethodID string            `json:"payment_method"`
    CustomerID      *string           `json:"customer,omitempty"`
    Description     string            `json:"description,omitempty"`
    Metadata        map[string]string `json:"metadata"`
    FailureCode     *string           `json:"failure_code,omitempty"`
    FailureMessage  *string           `json:"failure_message,omitempty"`
    Livemode        bool              `json:"livemode"`
    CreatedAt       int64             `json:"created"` // Unix timestamp (Stripe convention)
}

// -------- Handler --------

type PaymentHandler struct {
    payments        PaymentService
    idempotency     IdempotencyStore
    rateLimiter     RateLimiter
    logger          Logger
}

func (h *PaymentHandler) CreatePayment(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    authCtx := GetAuthContext(ctx)

    // Extract idempotency key from header
    idempotencyKey := r.Header.Get("Idempotency-Key")

    // Parse request
    var req CreatePaymentRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        writeError(w, r, http.StatusBadRequest, "invalid_json",
            "Request body contains malformed JSON. Please check the request format.")
        return
    }
    req.IdempotencyKey = idempotencyKey

    // Validate
    if errs := validateCreatePaymentRequest(req); len(errs) > 0 {
        writeValidationErrors(w, r, errs)
        return
    }

    // Create the payment
    payment, err := h.payments.Create(ctx, CreatePaymentParams{
        Amount:         req.Amount,
        Currency:       req.Currency,
        PaymentMethod:  req.PaymentMethod,
        CustomerID:     req.CustomerID,
        Description:    req.Description,
        Metadata:       req.Metadata,
        MerchantID:     authCtx.MerchantID,
        Livemode:       !authCtx.IsTest,
        IdempotencyKey: idempotencyKey,
    })
    if err != nil {
        h.handlePaymentError(w, r, err)
        return
    }

    w.Header().Set("Location", fmt.Sprintf("/payments/%s", payment.ID))
    writeJSON(w, http.StatusCreated, mapPaymentToResponse(payment))
}

func (h *PaymentHandler) handlePaymentError(w http.ResponseWriter, r *http.Request, err error) {
    var pmNotFound *PaymentMethodNotFoundError
    if errors.As(err, &pmNotFound) {
        writeError(w, r, http.StatusUnprocessableEntity, "payment_method_not_found",
            fmt.Sprintf("No payment method with ID %q was found.", pmNotFound.ID))
        return
    }

    var cardDeclined *CardDeclinedError
    if errors.As(err, &cardDeclined) {
        writeError(w, r, http.StatusPaymentRequired, "card_declined",
            fmt.Sprintf("The card was declined. %s", cardDeclined.HumanMessage()),
            withCode(cardDeclined.DeclineCode),
            withDocURL(fmt.Sprintf("https://api.example.com/docs/errors/%s", cardDeclined.DeclineCode)),
        )
        return
    }

    var idempotencyConflict *IdempotencyConflictError
    if errors.As(err, &idempotencyConflict) {
        writeError(w, r, http.StatusConflict, "idempotency_conflict",
            "A concurrent request with the same Idempotency-Key is being processed.")
        return
    }

    h.logger.Error("unexpected payment creation error",
        "error", err,
        "request_id", GetRequestID(r.Context()),
    )
    writeError(w, r, http.StatusInternalServerError, "internal_error",
        "An unexpected error occurred. Please try again or contact support.")
}

// -------- Error Design --------

type ErrorOption func(*errorResponse)

func withCode(code string) ErrorOption {
    return func(e *errorResponse) { e.Code = code }
}

func withDocURL(url string) ErrorOption {
    return func(e *errorResponse) { e.DocURL = url }
}

type errorResponse struct {
    Type    string            `json:"type"`
    Code    string            `json:"code,omitempty"`
    Message string            `json:"message"`
    Param   string            `json:"param,omitempty"`
    DocURL  string            `json:"doc_url,omitempty"`
    Errors  []FieldError      `json:"errors,omitempty"`
}

func writeError(w http.ResponseWriter, r *http.Request, status int, errType, message string, opts ...ErrorOption) {
    resp := &errorResponse{
        Type:    errType,
        Message: message,
    }
    for _, opt := range opts {
        opt(resp)
    }
    writeJSON(w, status, map[string]any{"error": resp})
}

// -------- Response Mapping --------

func mapPaymentToResponse(p *Payment) *PaymentResponse {
    resp := &PaymentResponse{
        ID:              p.ID,
        Object:          "payment",
        Amount:          p.Amount,
        Currency:        p.Currency,
        Status:          string(p.Status),
        PaymentMethodID: p.PaymentMethodID,
        CustomerID:      p.CustomerID,
        Description:     p.Description,
        Metadata:        p.Metadata,
        Livemode:        p.Livemode,
        CreatedAt:       p.CreatedAt.Unix(),
    }
    if p.FailureCode != nil {
        resp.FailureCode = p.FailureCode
        resp.FailureMessage = p.FailureMessage
    }
    return resp
}
```

### SDK Design Sketch

The SDK client embeds a `golang.org/x/time/rate` limiter to enforce client-side rate limits before requests leave the process, preventing `429` responses from the server under predictable traffic patterns. Wrapping `net/http` rather than exposing it directly lets the SDK control serialization, error mapping, and retry logic in one place without leaking HTTP primitives to callers.

```go
// go-payments/client.go
package payments

import (
    "context"
    "math/rand/v2"
    "net/http"
    "time"

    "golang.org/x/time/rate"
)

type Client struct {
    apiKey     string
    baseURL    string
    httpClient *http.Client
    maxRetries int
    limiter    *rate.Limiter

    Payments *PaymentsService
    Refunds  *RefundsService
    Webhooks *WebhooksService
}

func NewClient(apiKey string, opts ...Option) *Client {
    c := &Client{
        apiKey:     apiKey,
        baseURL:    "https://api.example.com",
        httpClient: &http.Client{Timeout: 30 * time.Second},
        maxRetries: 3,
        limiter:    rate.NewLimiter(rate.Every(time.Second), 100),
    }
    for _, opt := range opts {
        opt(c)
    }
    c.Payments = &PaymentsService{client: c}
    c.Refunds = &RefundsService{client: c}
    c.Webhooks = &WebhooksService{client: c}
    return c
}

type Option func(*Client)

func WithBaseURL(url string) Option {
    return func(c *Client) { c.baseURL = url }
}

func WithMaxRetries(n int) Option {
    return func(c *Client) { c.maxRetries = n }
}

// Retries on 429 and 5xx with exponential backoff + jitter
func (c *Client) do(ctx context.Context, req *http.Request) (*http.Response, error) {
    var lastErr error
    for attempt := 0; attempt <= c.maxRetries; attempt++ {
        if attempt > 0 {
            backoff := time.Duration(attempt*attempt)*100*time.Millisecond +
                time.Duration(rand.IntN(100))*time.Millisecond
            select {
            case <-ctx.Done():
                return nil, ctx.Err()
            case <-time.After(backoff):
            }
        }

        resp, err := c.httpClient.Do(req.Clone(ctx))
        if err != nil {
            lastErr = err
            continue
        }

        if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
            resp.Body.Close()
            lastErr = fmt.Errorf("server returned %d", resp.StatusCode)
            continue
        }

        return resp, nil
    }
    return nil, fmt.Errorf("after %d retries: %w", c.maxRetries, lastErr)
}
```

---

### Junior → FAANG: Reading a Production API Design and Extracting Lessons

Most junior engineers write handlers before they design resources. The payment API example inverts that order, and understanding why is the key lesson.

**Prerequisite gaps to close**

If the phrase "sentinel domain error" is unfamiliar, study Go error wrapping first. `errors.As` is the mechanism that lets a handler decode a domain error type without importing business logic packages into the transport layer. This is the practical expression of the Dependency Inversion principle in a Go HTTP service.

Understand the difference between PCI scope and PCI out-of-scope components. The payment handler never holds raw card numbers because it delegates to a tokenization service. That design choice, not just encryption, is what limits PCI audit scope. Not knowing this in a payments interview is a red flag.

**Worked example: tracing an idempotency key through the stack**

Follow the idempotency key from header extraction to storage. The handler reads `Idempotency-Key` from the request header and attaches it to `CreatePaymentParams`. The service layer checks the idempotency store before executing the charge. If a record exists, it returns the stored response. If not, it executes the charge, then writes the idempotency record before returning to the caller.

Notice that the handler does not implement the idempotency logic. It only extracts the key and passes it down. This is single responsibility: the handler owns transport concerns, the service owns business rules. If a junior engineer puts the idempotency store lookup inside the handler, they have coupled transport and business logic, making both harder to test.

**First-job habits**

Always use a response mapping function like `mapPaymentToResponse` rather than returning domain models directly from handlers. Domain models change for business reasons. Response shapes change for API consumer reasons. Keeping them separate means you can evolve both independently without a breaking change hitting the other side.

When writing error handling, enumerate the known domain errors explicitly using `errors.As`. Avoid a generic catch-all that maps every error to 500. Unknown errors becoming 500 is correct. Known errors becoming 500 because you forgot to handle them is a bug.

**Interview entry-point framing**

When asked to design a payment API in an interview, open with the idempotency requirement before any endpoint design. Interviewers use this as a filter. Candidates who jump to resource naming without mentioning idempotency have not thought about real-world payment failure modes.

---

### Senior @ FAANG: Payment API Architecture, Compliance Governance, and Platform Reliability

A payment API is not just a REST API that moves money. It is a regulated financial system with compliance, reliability, and security requirements that shape every architectural decision. At the senior level, knowing what to build is less important than knowing which constraints force which tradeoffs.

**PCI DSS scope as an architectural driver**

PCI DSS compliance is not a checkbox. It is a design constraint that determines which components can touch cardholder data. The correct architecture eliminates raw card data from your application entirely by using a PCI-compliant tokenization provider (Stripe, Braintree, Adyen). Your application never sees the card number. It only ever sees a token. This keeps your entire application out of PCI scope for cardholder data, reducing audit surface from potentially your entire stack to a thin webhook receiver and token-passing layer.

Document this as an ADR: "We will never store, transmit, or log raw cardholder data. All card interactions go through the tokenization provider SDK on the client side. The payment API receives only payment method tokens." Any PR that violates this must be rejected at review. Add a CI lint rule that fails if the string `card_number` appears anywhere in handler code.

**Idempotency correctness at the database level**

The implementation sketch shows the pattern but omits the critical correctness guarantee. The idempotency record must be written atomically with the side effect. If the service executes the charge and then crashes before writing the idempotency record, the next retry creates a second charge. The canonical fix is to write the idempotency record in the same database transaction as the charge record. For a distributed system where the charge goes to an external processor (Stripe, Adyen), use an outbox pattern: write the charge intent and the idempotency record to your database in one transaction, then have a worker execute the external call and update status.

This guarantee is what separates a payment system that is correct under failure from one that is correct only on the happy path. At the senior bar, you are expected to know this distinction and design for it.

**Merchant webhook delivery: the guarantee model**

The webhook system in the requirements mentions HMAC signing and replay protection. The delivery contract requires an explicit decision: at-most-once or at-least-once. Payment APIs universally choose at-least-once because dropping a webhook is worse than delivering it twice. Merchants must be told to implement idempotent webhook handlers using the event ID.

Webhook delivery must be retried on non-2xx responses with exponential backoff and a maximum TTL (typically 72 hours). After TTL expiry, mark the delivery as permanently failed and surface it in the merchant dashboard. Log every delivery attempt with the HTTP status received and the response body (truncated). Merchants will ask "why did my webhook fail?" and you must be able to answer.

HMAC replay protection requires the webhook body to include a `timestamp` field and the signature to cover both the body and the timestamp. Merchants verify that `|now - timestamp| < 5 minutes`. Without the timestamp, an attacker who intercepts a valid webhook can replay it indefinitely.

**SDK design as a platform contract**

The SDK client uses `errors.As`-compatible error types on the client side, mirroring the server-side domain error pattern. This symmetry is intentional. When the server returns `card_declined` with a `decline_code`, the SDK should surface a `CardDeclinedError` with a `DeclineCode` field, not a generic error with a string message. This allows merchant application code to switch on typed errors rather than parsing strings.

Versioning the SDK separately from the API is a common mistake. Tie SDK versions to API version dates. `v1.5.0` of the SDK targets `API-Version: 2024-01-15`. The SDK sets the header automatically so merchants cannot accidentally hit a version mismatch.

**Reliability under the 99.99% SLA**

A 99.99% availability SLA allows approximately 52 minutes of downtime per year. For a synchronous payment API with a sub-200ms P99, that means the entire call path from load balancer through application to database to payment processor and back must be highly available. Identify each dependency and its own availability figure. If the payment processor's SLA is 99.95%, your API cannot achieve 99.99% end-to-end without circuit breakers and fallback behavior.

Design circuit breakers around the processor call. When the processor is degraded, fail fast with a clear `processor_unavailable` error rather than timing out at 30 seconds. Include a `Retry-After` header with an estimated recovery time. Merchants can queue their payment attempts rather than hammering a degraded endpoint.

**Bar-raiser signals**

Senior candidates are expected to surface the compliance angle without prompting. They know the difference between idempotency under failure and idempotency under normal conditions. They can explain why the outbox pattern is necessary and what happens without it. They have opinions about SDK ergonomics backed by developer experience data. They think about the merchant's operational experience, not just the payment success path. And they can articulate the reliability chain across all dependencies, not just the code they own.
