## 52B.10 Anti-Corruption Layer

### Protecting Your Domain

An **Anti-Corruption Layer (ACL)** translates between an external model and your domain model. Without an ACL, your domain objects become polluted with concepts from external systems.

Consider integrating with Stripe for payment processing. Stripe has its own vocabulary: `PaymentIntent`, `charge`, `customer` (their ID, not yours). If you let Stripe's model leak into your domain, your `Order` starts referencing `StripePaymentIntentID` and `StripeCustomerID`. Your domain is now coupled to Stripe.

The ACL below wraps the Stripe SDK, translating between Stripe's API types and the domain's `PaymentRequest`/`PaymentResult` types. Error mapping is especially important: Stripe returns error codes like `card_declined` and `insufficient_funds`, which the ACL converts to domain-level errors that the application layer can handle without knowing about Stripe.

```go
// infrastructure/payment/stripe_acl.go

package paymentinfra

import (
    "context"
    "fmt"

    stripe "github.com/stripe/stripe-go/v74"
    "github.com/stripe/stripe-go/v74/paymentintent"
    "github.com/yourorg/ecommerce/order-service/internal/domain/payment"
)

// StripePaymentGateway is the Anti-Corruption Layer between Stripe's API
// and our domain's payment model.
type StripePaymentGateway struct {
    apiKey string
}

// NewStripePaymentGateway creates a new Stripe ACL.
func NewStripePaymentGateway(apiKey string) *StripePaymentGateway {
    stripe.Key = apiKey
    return &StripePaymentGateway{apiKey: apiKey}
}

// ProcessPayment translates our domain's payment request into Stripe's API
// and translates the response back into our domain's payment result.
func (g *StripePaymentGateway) ProcessPayment(
    ctx context.Context,
    req payment.PaymentRequest,
) (payment.PaymentResult, error) {
    // Translate domain model → Stripe model
    params := &stripe.PaymentIntentParams{
        Amount:   stripe.Int64(req.Amount.Amount), // already in cents
        Currency: stripe.String(string(req.Amount.Currency)),
        PaymentMethod: stripe.String(req.PaymentMethodToken),
        Confirm:  stripe.Bool(true),
        Metadata: map[string]string{
            "order_id":    string(req.OrderID),
            "customer_id": string(req.CustomerID),
        },
    }

    // Call Stripe
    intent, err := paymentintent.New(params)
    if err != nil {
        // Translate Stripe error → domain error
        return payment.PaymentResult{}, g.translateError(err)
    }

    // Translate Stripe response → domain model
    return payment.PaymentResult{
        TransactionID: payment.TransactionID(intent.ID),
        Status:        g.translateStatus(intent.Status),
        Amount:        req.Amount,
    }, nil
}

// translateError converts Stripe API errors to domain payment errors.
// This is the heart of the ACL: external error concepts become domain concepts.
func (g *StripePaymentGateway) translateError(err error) error {
    stripeErr, ok := err.(*stripe.Error)
    if !ok {
        return fmt.Errorf("payment gateway error: %w", err)
    }
    switch stripeErr.Code {
    case stripe.ErrorCodeCardDeclined:
        return payment.ErrPaymentDeclined
    case stripe.ErrorCodeInsufficientFunds:
        return payment.ErrInsufficientFunds
    case stripe.ErrorCodeExpiredCard:
        return payment.ErrCardExpired
    case stripe.ErrorCodeIncorrectCVC:
        return payment.ErrInvalidCardDetails
    default:
        return fmt.Errorf("%w: %s", payment.ErrPaymentFailed, stripeErr.Msg)
    }
}

func (g *StripePaymentGateway) translateStatus(status stripe.PaymentIntentStatus) payment.PaymentStatus {
    switch status {
    case stripe.PaymentIntentStatusSucceeded:
        return payment.PaymentStatusSucceeded
    case stripe.PaymentIntentStatusRequiresPaymentMethod:
        return payment.PaymentStatusDeclined
    default:
        return payment.PaymentStatusPending
    }
}
```

The domain's payment types are completely Stripe-free. The `PaymentGateway` interface lives in the domain package and knows nothing about which provider implements it. This is the Dependency Inversion Principle in action: the domain defines the contract, and infrastructure satisfies it.

```go
// domain/payment/types.go

package payment

import (
    "context"
    "errors"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

var (
    ErrPaymentDeclined     = errors.New("payment was declined by the card issuer")
    ErrInsufficientFunds   = errors.New("insufficient funds")
    ErrCardExpired         = errors.New("the card has expired")
    ErrInvalidCardDetails  = errors.New("invalid card details")
    ErrPaymentFailed       = errors.New("payment processing failed")
)

type TransactionID string
type PaymentStatus string

const (
    PaymentStatusSucceeded PaymentStatus = "succeeded"
    PaymentStatusDeclined  PaymentStatus = "declined"
    PaymentStatusPending   PaymentStatus = "pending"
)

type PaymentRequest struct {
    OrderID            order.OrderID
    CustomerID         order.CustomerID
    Amount             order.Money
    PaymentMethodToken string
}

type PaymentResult struct {
    TransactionID TransactionID
    Status        PaymentStatus
    Amount        order.Money
}

// PaymentGateway is the domain interface for processing payments.
// The domain defines this interface - infrastructure implements it.
type PaymentGateway interface {
    ProcessPayment(ctx context.Context, req PaymentRequest) (PaymentResult, error)
}
```

### Junior → FAANG: When to Build an ACL and What It Costs

The most common failure to build an ACL is with internal services: engineers assume that because the upstream is also written by their company, they can safely import its types directly. This is wrong. An internal service that changes its data model will break all of its direct importers. An ACL insulates your domain from those changes: only the translator needs to update, not your core domain logic.

The rule of thumb: any dependency whose data model you do not control needs an ACL. This includes all third-party APIs, all legacy systems, and any internal service owned by a different team with a different release cadence.

The cost of an ACL is translation code that must be maintained when either side changes. This is real cost. It is cheaper than the alternative (coupling your domain to an external model), but it is not free. Write the translator as a standalone type with its own tests. Each external error code should map to exactly one domain error. Each external data field should map to exactly one domain value object field. If a field in the external model has no equivalent in your domain model, drop it explicitly and document why.

For interviews, the ACL scenario typically appears as: "You need to integrate with a legacy ERP system that uses its own vocabulary and data format. How would you structure the integration?" The answer is three-layer: a client adapter that handles the wire protocol, a translator that converts external types to domain types, and a domain interface that the application service depends on. The domain never imports the ERP client.

### Senior @ FAANG: ACL Design for Resilience, Observability, and Multi-Provider Flexibility

The ACL is the most operationally complex part of a DDD system because it sits at the boundary between what you control and what you do not. At scale, three concerns dominate: resilience, observability, and schema isolation.

**Resilience design for external dependencies.** External services fail, are slow, or return unexpected responses. The ACL is the correct place for all resilience logic: timeouts, retries with exponential backoff, circuit breakers, and fallbacks. In Go, this is typically implemented with a resilience library (go-resiliency, or a custom circuit breaker) wrapped around the external client call. The domain interface the application service sees should never return errors that reflect external system timeouts or rate limits directly: those are translated into domain-meaningful errors (`ErrPaymentGatewayUnavailable`) or into domain-meaningful fallback behaviors (return the last cached price if the pricing service is down). Exposing raw HTTP status codes or gRPC status codes through the ACL boundary is a design failure.

**Observability at the ACL boundary.** Every call through an ACL should emit metrics: call count, latency, error rate broken down by error type, and circuit breaker state transitions. These metrics are the primary signal for detecting third-party service degradation before it impacts customers. At the L6 bar, designing an ACL without an observability plan is a significant gap. The plan should include: which dashboard panels show the health of each external dependency, which alert fires when the error rate exceeds a threshold, and which on-call runbook describes the remediation steps (enable the fallback, throttle the upstream caller, etc.).

**Multi-provider flexibility as an ACL benefit.** One undervalued property of a well-designed ACL is that it enables provider substitution without domain changes. If your domain defines `PaymentGateway` as an interface and your infrastructure provides `StripePaymentGateway`, switching to Adyen or Braintree is a matter of adding a new infrastructure adapter and updating the dependency injection configuration. The domain and application service are unchanged. At the staff level, this flexibility is a deliberate design goal when the business has requirements for multi-provider failover (primary gateway down: switch to secondary) or for regional compliance (European transactions must use a European-domiciled payment processor). Designing the ACL interface to be provider-agnostic from the start, rather than retrofitting it later, is the senior-level proactive call.

**Schema isolation and contract testing for ACLs.** The translator inside an ACL is the most brittle component of the integration. When the upstream changes a field name, renames an error code, or adds a required field, the translator breaks. The production defense is a contract test suite that runs against a recorded fixture of the external API's responses. When the external API ships a new version, you update the fixtures and run the contract tests to find all breakages before they reach production. In Go, this is implemented with `httptest` for REST APIs or with recorded gRPC response files. The contract test suite is the canary that catches upstream breaking changes in CI, not in production.

---
