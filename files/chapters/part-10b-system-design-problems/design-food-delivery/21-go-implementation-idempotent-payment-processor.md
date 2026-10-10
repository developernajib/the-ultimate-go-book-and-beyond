## Go Implementation: Idempotent Payment Processor

Network failures during payment processing create a dangerous ambiguity: did the charge go through or not? If you retry blindly, the customer could be double-charged. Idempotency solves this by ensuring that the same payment request always produces the same result, no matter how many times it is retried. The implementation records each payment attempt with a unique idempotency key before calling Stripe, so subsequent retries with the same key return the cached result instead of creating a new charge. This pattern is essential for any system that handles real money.

```go
package payment

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type StripeChargeRequest struct {
	IdempotencyKey  string
	CustomerID      string
	Amount          int64
	PaymentMethodID string
	Currency        string
}

type StripeChargeResult struct {
	ChargeID string
}

type StripeService interface {
	CreateCharge(ctx context.Context, req StripeChargeRequest) (*StripeChargeResult, error)
}

// IdempotentPaymentProcessor ensures payments are processed exactly once
// even when the caller retries due to timeouts or network failures
type IdempotentPaymentProcessor struct {
	db         *pgxpool.Pool
	stripeSvc  StripeService
}

type PaymentResult struct {
	ChargeID  string
	Status    string
	Amount    int64
	Duplicate bool // true if this was a replay of an existing payment
}

// ProcessPayment handles payment with idempotency guarantee
func (p *IdempotentPaymentProcessor) ProcessPayment(
	ctx context.Context,
	idempotencyKey string,
	customerID string,
	amount int64,
	paymentMethodID string,
) (*PaymentResult, error) {
	// 1. Check if this payment was already processed. charge_id is
	// NULL until Stripe succeeds, so COALESCE it for the scan.
	var existingChargeID, existingStatus string
	var existingAmount int64
	err := p.db.QueryRow(ctx, `
		SELECT COALESCE(charge_id, ''), status, amount
		FROM payment_records
		WHERE idempotency_key = $1`,
		idempotencyKey,
	).Scan(&existingChargeID, &existingStatus, &existingAmount)

	if err == nil {
		// Already processed -- return the recorded result, not the
		// caller's request values
		return &PaymentResult{
			ChargeID:  existingChargeID,
			Status:    existingStatus,
			Amount:    existingAmount,
			Duplicate: true,
		}, nil
	}

	// 2. Record payment attempt (before calling Stripe)
	_, err = p.db.Exec(ctx, `
		INSERT INTO payment_records (idempotency_key, customer_id, amount, status, created_at)
		VALUES ($1, $2, $3, 'pending', NOW())
		ON CONFLICT (idempotency_key) DO NOTHING`,
		idempotencyKey, customerID, amount,
	)
	if err != nil {
		return nil, fmt.Errorf("record payment attempt: %w", err)
	}

	// 3. Call Stripe with their idempotency key
	chargeResult, err := p.stripeSvc.CreateCharge(ctx, StripeChargeRequest{
		IdempotencyKey:  idempotencyKey,
		CustomerID:      customerID,
		Amount:          amount,
		PaymentMethodID: paymentMethodID,
		Currency:        "usd",
	})

	if err != nil {
		// Update record with failure
		p.db.Exec(ctx, `
			UPDATE payment_records SET status = 'failed', error = $1
			WHERE idempotency_key = $2`,
			err.Error(), idempotencyKey)
		return nil, fmt.Errorf("stripe charge: %w", err)
	}

	// 4. Update record with success
	p.db.Exec(ctx, `
		UPDATE payment_records SET status = 'succeeded', charge_id = $1
		WHERE idempotency_key = $2`,
		chargeResult.ChargeID, idempotencyKey)

	return &PaymentResult{
		ChargeID: chargeResult.ChargeID,
		Status:   "succeeded",
		Amount:   amount,
	}, nil
}
```

---
