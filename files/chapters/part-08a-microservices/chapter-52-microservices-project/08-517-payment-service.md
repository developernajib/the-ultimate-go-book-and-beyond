## 52.7 Payment Service

The payment service processes charges and refunds. In this project it uses a simulated gateway (`processWithGateway`), but the structure mirrors a real Stripe or PayPal integration: create a payment record in a pending state, transition it through processing to completed or failed, and publish events for each outcome. The order service listens for `PaymentProcessed` and `PaymentFailed` events to advance or roll back its saga. Amounts over $10,000 are rejected by the simulator, which is useful for testing the failure-compensation path.

**Production Stripe integration, what this scaffold is modeling.** Real payment code follows the Stripe *PaymentIntent* lifecycle: the server creates a `PaymentIntent` (server-side, with the amount, currency, and capture method), returns the `client_secret` to the browser/app, the client confirms with a payment method, and Stripe ultimately fires a `payment_intent.succeeded` or `payment_intent.payment_failed` webhook. Three non-negotiables to carry into any real implementation:

1. **Idempotency keys on every POST to Stripe.** Stripe officially recommends an idempotency key on all writes. Without one, a network retry can double-charge a customer. The key should be deterministic per logical operation, for a checkout that means `"order-" + orderID` for the first attempt, or `"order-" + orderID + "-retry-" + attempt` if you want separate attempts. Keys are valid for 24 hours on Stripe's side. After that the server treats a reused key as a new request.
2. **The webhook is the source of truth, not the API response.** Treat the synchronous `ProcessPayment` return value as "acknowledged," and only flip the order to `paid` when the signed `payment_intent.succeeded` webhook arrives. Verify the `Stripe-Signature` header, persist the event ID, and make handlers idempotent, Stripe retries webhooks for up to three days.
3. **Never store PANs.** Tokenize via Stripe Elements / Payment Element on the client. The server sees only tokens (`pm_...`, `pi_...`) and customer IDs (`cus_...`). This keeps you out of PCI-DSS SAQ D scope.

The `Token` field on `ProcessPaymentRequest` below represents that client-side payment method token. The `IdempotencyKey` field on the request, added in the next revision of this service, should map directly to Stripe's `Idempotency-Key` HTTP header.

```go
// internal/payment/service.go
package payment

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"example.com/ecommerce/pkg/events"
)

// Payment represents a payment
type Payment struct {
	ID         string    `json:"id" db:"id"`
	OrderID    string    `json:"order_id" db:"order_id"`
	UserID     string    `json:"user_id" db:"user_id"`
	AmountCents int64     `json:"amount_cents" db:"amount_cents"`
	Currency   string    `json:"currency" db:"currency"`
	Status     string    `json:"status" db:"status"`
	Method     string    `json:"method" db:"method"`
	ExternalID string    `json:"external_id,omitempty" db:"external_id"`
	CreatedAt  time.Time `json:"created_at" db:"created_at"`
	UpdatedAt  time.Time `json:"updated_at" db:"updated_at"`
}

// PaymentStatus constants
const (
	PaymentPending   = "pending"
	PaymentProcessing = "processing"
	PaymentCompleted = "completed"
	PaymentFailed    = "failed"
	PaymentRefunded  = "refunded"
)

// Service handles payment operations
type Service struct {
	db        *sql.DB
	publisher events.Publisher
	logger    *slog.Logger
	// In production, this would be Stripe/PayPal client
}

// NewService creates a payment service
func NewService(db *sql.DB, publisher events.Publisher, logger *slog.Logger) (*Service, error) {
	s := &Service{
		db:        db,
		publisher: publisher,
		logger:    logger,
	}
	if err := s.createSchema(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS payments (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			order_id UUID NOT NULL,
			user_id UUID NOT NULL,
			amount_cents BIGINT NOT NULL,
			currency VARCHAR(3) DEFAULT 'USD',
			status VARCHAR(20) NOT NULL,
			method VARCHAR(50),
			external_id VARCHAR(255),
			idempotency_key VARCHAR(255) UNIQUE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
		CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idem ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
	`

	_, err := s.db.Exec(query)
	return err
}

// ProcessPaymentRequest represents a payment request.
// IdempotencyKey MUST be supplied by the caller (the order service) and
// forwarded verbatim as Stripe's Idempotency-Key header. A good default is
// "order-{orderID}" -- deterministic per logical checkout, so a client or
// network retry always lands on the same PaymentIntent.
type ProcessPaymentRequest struct {
	OrderID        string  `json:"order_id"`
	UserID         string  `json:"user_id"`
	AmountCents    int64   `json:"amount_cents"`
	Method         string  `json:"method"`          // card, paypal, etc.
	Token          string  `json:"token"`           // Payment method token (pm_...)
	IdempotencyKey string  `json:"idempotency_key"` // e.g. "order-{orderID}"
}

// ProcessPayment processes a payment.
//
// The idempotency check at the top is the server-side half of the contract:
// if the same IdempotencyKey arrives twice (client retry, Kafka redelivery,
// order-service crash-and-resume), return the original Payment instead of
// creating a second one. The UNIQUE index on payments.idempotency_key
// enforces this at the database level even under concurrent retries.
func (s *Service) ProcessPayment(ctx context.Context, req ProcessPaymentRequest) (*Payment, error) {
	if req.IdempotencyKey == "" {
		return nil, fmt.Errorf("idempotency key is required")
	}

	// Check if we've already processed this request.
	existing, err := s.getByIdempotencyKey(ctx, req.IdempotencyKey)
	if err == nil && existing != nil {
		return existing, nil
	}

	payment := &Payment{
		ID:        uuid.New().String(),
		OrderID:   req.OrderID,
		UserID:    req.UserID,
		AmountCents: req.AmountCents,
		Currency:  "USD",
		Status:    PaymentPending,
		Method:    req.Method,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}

	// Save payment
	if err := s.savePayment(ctx, payment, req.IdempotencyKey); err != nil {
		return nil, fmt.Errorf("save payment: %w", err)
	}

	// Process with payment gateway
	payment.Status = PaymentProcessing
	s.updatePaymentStatus(ctx, payment.ID, PaymentProcessing)

	// Simulate payment processing
	success, reason := s.processWithGateway(ctx, req)

	if !success {
		payment.Status = PaymentFailed
		s.updatePaymentStatus(ctx, payment.ID, PaymentFailed)

		// Publish failure event
		s.publisher.Publish(ctx, events.PaymentFailed, events.PaymentFailedEvent{
			PaymentID: payment.ID,
			OrderID:   payment.OrderID,
			Reason:    reason,
		})

		return nil, fmt.Errorf("payment failed: %s", reason)
	}

	// Payment successful
	payment.Status = PaymentCompleted
	payment.ExternalID = fmt.Sprintf("ext_%s", uuid.New().String()[:8])
	s.updatePayment(ctx, payment)

	// Publish success event
	s.publisher.Publish(ctx, events.PaymentProcessed, events.PaymentProcessedEvent{
		PaymentID: payment.ID,
		OrderID:   payment.OrderID,
		AmountCents: payment.AmountCents,
	})

	s.logger.Info("Payment processed",
		"payment_id", payment.ID,
		"order_id", payment.OrderID,
		"amount_cents", payment.AmountCents,
	)

	return payment, nil
}

func (s *Service) processWithGateway(ctx context.Context, req ProcessPaymentRequest) (bool, string) {
	// In production, this would call Stripe/PayPal API
	// Simulate processing
	time.Sleep(100 * time.Millisecond)

	// Simulate failures for testing
	if req.AmountCents > 1000000 { // $10,000.00 limit
		return false, "amount exceeds limit"
	}

	return true, ""
}

func (s *Service) savePayment(ctx context.Context, payment *Payment, idempotencyKey string) error {
	query := `
		INSERT INTO payments (id, order_id, user_id, amount_cents, currency, status, method, idempotency_key, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`

	_, err := s.db.ExecContext(ctx, query,
		payment.ID, payment.OrderID, payment.UserID, payment.AmountCents,
		payment.Currency, payment.Status, payment.Method, idempotencyKey,
		payment.CreatedAt, payment.UpdatedAt,
	)

	return err
}

// getByIdempotencyKey returns a previously-created payment for the given
// idempotency key, or (nil, nil) if none exists.
func (s *Service) getByIdempotencyKey(ctx context.Context, key string) (*Payment, error) {
	var p Payment
	err := s.db.QueryRowContext(ctx,
		`SELECT id, order_id, user_id, amount_cents, currency, status, method, external_id, created_at, updated_at
		 FROM payments WHERE idempotency_key = $1`,
		key,
	).Scan(
		&p.ID, &p.OrderID, &p.UserID, &p.AmountCents, &p.Currency,
		&p.Status, &p.Method, &p.ExternalID, &p.CreatedAt, &p.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Service) updatePaymentStatus(ctx context.Context, id, status string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2`,
		status, id,
	)
	return err
}

func (s *Service) updatePayment(ctx context.Context, payment *Payment) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE payments SET status = $1, external_id = $2, updated_at = NOW() WHERE id = $3`,
		payment.Status, payment.ExternalID, payment.ID,
	)
	return err
}

// RefundPayment refunds a payment
func (s *Service) RefundPayment(ctx context.Context, paymentID string) error {
	// Get payment
	var payment Payment
	err := s.db.QueryRowContext(ctx,
		`SELECT id, order_id, user_id, amount_cents, status FROM payments WHERE id = $1`,
		paymentID,
	).Scan(&payment.ID, &payment.OrderID, &payment.UserID, &payment.AmountCents, &payment.Status)
	if err != nil {
		return fmt.Errorf("payment not found: %w", err)
	}

	if payment.Status != PaymentCompleted {
		return fmt.Errorf("payment cannot be refunded: status is %s", payment.Status)
	}

	// Process refund with gateway
	// In production, call Stripe/PayPal refund API

	// Update status
	_, err = s.db.ExecContext(ctx,
		`UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2`,
		PaymentRefunded, paymentID,
	)
	if err != nil {
		return err
	}

	// Publish event
	s.publisher.Publish(ctx, events.PaymentRefunded, events.PaymentRefundedEvent{
		PaymentID: payment.ID,
		OrderID:   payment.OrderID,
		AmountCents: payment.AmountCents,
	})

	s.logger.Info("Payment refunded",
		"payment_id", payment.ID,
		"order_id", payment.OrderID,
		"amount_cents", payment.AmountCents,
	)

	return nil
}

// GetPayment retrieves a payment
func (s *Service) GetPayment(ctx context.Context, paymentID string) (*Payment, error) {
	var payment Payment
	err := s.db.QueryRowContext(ctx,
		`SELECT id, order_id, user_id, amount_cents, currency, status, method, external_id, created_at, updated_at
		 FROM payments WHERE id = $1`,
		paymentID,
	).Scan(
		&payment.ID, &payment.OrderID, &payment.UserID, &payment.AmountCents,
		&payment.Currency, &payment.Status, &payment.Method, &payment.ExternalID,
		&payment.CreatedAt, &payment.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("payment not found")
	}

	return &payment, err
}
```

### Junior → FAANG: Payment Service Fundamentals That Must Be Second Nature

Payment code is the highest-stakes code in any e-commerce system. Two behaviors in this file are non-negotiable in production and come up in every payment-related interview question.

**Idempotency keys are not optional.** The `ProcessPayment` method rejects requests without an `IdempotencyKey`. This is the correct behavior. The key prevents double-charges when a network timeout causes the caller to retry. The key should be deterministic for the same logical operation: `"order-" + orderID` for the initial charge. If the caller retries with the same key, the function returns the original result without touching the payment gateway again. This is the invariant the `UNIQUE` index on `payments.idempotency_key` enforces at the database level.

**The webhook is the source of truth, not the synchronous response.** The comment in this file says this. The implication for your code: the synchronous `ProcessPayment` call confirms that the payment request was submitted, not that the money was received. Only flip the order to `paid` when the payment gateway's signed webhook arrives. If you flip the order status based on the synchronous response and the gateway later rejects the charge (fraud hold, insufficient funds detected after authorization), you have shipped goods without payment.

**PCI-DSS scope and tokenization.** The `Token` field on `ProcessPaymentRequest` represents a Stripe payment method token (`pm_...`). The server never sees a raw card number. If you store or log raw card numbers, you enter PCI-DSS SAQ D scope, which requires quarterly external penetration testing and annual on-site audits. Tokenization via Stripe Elements keeps you in SAQ A scope. For an interview: "We use client-side tokenization so the server never handles raw card data, keeping us in the lightest PCI-DSS compliance scope."

**First-job habit.** Always search your codebase for any place where payment method data is logged, stored in a non-encrypted column, or passed through a service that does not need it. Card data in a log file is a reportable breach.

### Senior @ FAANG: Payment Platform Architecture, Risk, and Compliance

The payment service here models the Stripe integration structure correctly. At FAANG scale, payment is a platform-level concern with organizational, legal, and operational dimensions that dwarf the code complexity.

**The authorize-capture split in production.** The current code runs `processWithGateway` synchronously and either completes or fails the payment in one step. Real Stripe integrations use the authorize-capture split: authorize during checkout (hold the funds), capture after the order is confirmed and ready to ship. The authorize-capture window is typically 7 days on Stripe. This model provides two advantages: you can void the authorization without a refund if the order cannot be fulfilled, and you capture only the final amount after any order modifications (item removed, promotional discount applied). The `RefundPayment` path is then only needed when the order has already shipped.

**Dispute (chargeback) handling as a first-class feature.** The current code has no dispute handling. In production, Stripe sends a `charge.dispute.created` webhook when a customer initiates a chargeback. The payment service must respond to Stripe within 7 days with evidence (order details, shipping confirmation, customer communication). Missing the response window results in an automatic loss. A production payment service has a dispute workflow: detect dispute, pause fulfillment if the order is in flight, alert the fraud team, and track the evidence submission deadline. This is not optional for a live commerce platform.

**Regulatory compliance by region.** EU payments require Strong Customer Authentication (SCA) under PSD2: additional verification (3DS2) for transactions above certain thresholds. Some markets require local payment methods (iDEAL in Netherlands, Boleto in Brazil, UPI in India) with different settlement timelines and failure modes. A payment platform that serves multiple regions must abstract over these differences and expose a unified API to the order service. The per-region payment method configuration, SCA policy, and settlement reporting are platform concerns, not service concerns.

**Fraud signal integration.** The `processWithGateway` simulator rejects amounts over $10,000. A real fraud system scores each transaction based on device fingerprint, IP geolocation, velocity (multiple orders from the same account in a short window), and order value. Scores above a threshold trigger manual review, not automatic rejection. The fraud score is computed before the payment gateway is called. Building a fraud scoring service is a platform investment: it requires a feature store for real-time signals, a model serving infrastructure, and an analyst workflow for reviewing flagged orders.

---
