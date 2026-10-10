## API Design

A clean, RESTful API is essential for merchants integrating with your payment platform. The endpoints below follow the standard pattern used by Stripe and similar providers: a `POST` to create a payment, separate endpoints to capture or refund it, and `GET` endpoints for querying status. Every mutating endpoint takes an idempotency key, refunds included, because a retried refund double-refunds just as readily as a retried charge double-charges. The struct tags show the validation rules each field must satisfy before the request reaches the payment service.

One convention note. Stripe carries the key in an `Idempotency-Key` HTTP header rather than in the body, which keeps it out of the resource representation and lets a gateway or client library attach it without understanding the payload. This design puts it in the body, which is a legitimate choice and makes the key visible in the struct, but if you claim Stripe-compatibility in an interview, know which one you are describing.

```go
package api

// POST /api/v1/payments - Process payment
type ProcessPaymentRequest struct {
	IdempotencyKey string        `json:"idempotency_key" validate:"required,max=255"`
	MerchantID     string        `json:"merchant_id" validate:"required"`
	Amount         int64         `json:"amount" validate:"gt=0"` // minor units
	Currency       string        `json:"currency" validate:"len=3,iso4217"`
	PaymentMethod  PaymentMethod `json:"payment_method"`
	Customer       CustomerInfo  `json:"customer"`
	CaptureMethod  string        `json:"capture_method" validate:"omitempty,oneof=automatic manual"`
}

// POST /api/v1/payments/{id}/refund - Refund payment
//
// Amount is optional: omitting it refunds the full remaining balance.
// It is a pointer so that "not specified" is distinguishable from an
// explicit zero, which must be rejected rather than silently promoted
// into a full refund.
type RefundRequest struct {
	IdempotencyKey string `json:"idempotency_key" validate:"required,max=255"`
	Amount         *int64 `json:"amount,omitempty" validate:"omitempty,gt=0"`
	Reason         string `json:"reason" validate:"max=500"`
}

// POST /api/v1/payments/{id}/capture - Capture authorized payment
// POST /api/v1/payments/{id}/refund - Refund payment
// GET /api/v1/payments/{id} - Get payment details
// POST /api/v1/payment-methods - Tokenize payment method
// GET /api/v1/merchants/{id}/balance - Merchant balance
// POST /api/v1/disputes/{id}/respond - Respond to chargeback
// POST /api/v1/webhooks - Register webhook endpoint
```

Amounts cross the API boundary as integers in the currency's minor unit, never as decimal strings and never as JSON numbers that a client might parse into a float. `12.34` is not exactly representable in binary floating point, so a client that round-trips an amount through a float can hand back `12.339999999999999`, and a system that accepts it has agreed to lose a cent somewhere downstream. `1234` has no such ambiguity. This also means the API must document the minor unit per currency rather than assume two decimal places: JPY has none, so ¥1234 is `1234`, and KWD has three, so 1.234 KWD is also `1234`. Assuming cents everywhere overcharges JPY customers by a factor of 100.

---
