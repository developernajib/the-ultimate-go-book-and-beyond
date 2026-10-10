## Part 4: Payment Service (Stripe Integration)

The Payment Service handles all payment processing through Stripe, including payment intents, webhook handling, and refunds. Integrating with a real payment provider like Stripe is one of the most security-sensitive parts of any e-commerce system, so this service demonstrates how to verify webhook signatures, handle idempotency, and manage sensitive data without exposing it to other services. You will learn how Stripe's two-step payment flow works: first creating a payment intent, then confirming it after the customer authorizes the charge.

### 4.1 Payment Service Proto Definition

**services/payment/proto/payment.proto**

```protobuf
syntax = "proto3";

package payment;
option go_package = "github.com/yourusername/ecommerce/services/payment/proto";

import "google/protobuf/timestamp.proto";
import "proto/common/types.proto";

service PaymentService {
  rpc CreatePaymentIntent(CreatePaymentIntentRequest) returns (CreatePaymentIntentResponse);
  rpc GetPaymentIntent(GetPaymentIntentRequest) returns (GetPaymentIntentResponse);
  rpc CapturePayment(CapturePaymentRequest) returns (CapturePaymentResponse);
  rpc RefundPayment(RefundPaymentRequest) returns (RefundPaymentResponse);
  rpc HandleWebhook(HandleWebhookRequest) returns (HandleWebhookResponse);
}

message Payment {
  string id = 1;
  string order_id = 2;
  string stripe_payment_intent_id = 3;
  common.Money amount = 4;
  PaymentStatus status = 5;
  PaymentMethod payment_method = 6;
  string customer_email = 7;
  map<string, string> metadata = 8;
  google.protobuf.Timestamp created_at = 9;
  google.protobuf.Timestamp updated_at = 10;
}

enum PaymentStatus {
  PAYMENT_STATUS_UNSPECIFIED = 0;
  PAYMENT_STATUS_PENDING = 1;
  PAYMENT_STATUS_REQUIRES_PAYMENT_METHOD = 2;
  PAYMENT_STATUS_REQUIRES_CONFIRMATION = 3;
  PAYMENT_STATUS_PROCESSING = 4;
  PAYMENT_STATUS_SUCCEEDED = 5;
  PAYMENT_STATUS_CANCELED = 6;
  PAYMENT_STATUS_FAILED = 7;
  PAYMENT_STATUS_REFUNDED = 8;
  PAYMENT_STATUS_PARTIALLY_REFUNDED = 9;
}

message PaymentMethod {
  string type = 1;
  CardDetails card = 2;
}

message CardDetails {
  string last4 = 1;
  string brand = 2;
  int32 exp_month = 3;
  int32 exp_year = 4;
}

message CreatePaymentIntentRequest {
  string order_id = 1;
  common.Money amount = 2;
  string customer_email = 3;
  map<string, string> metadata = 4;
}

message CreatePaymentIntentResponse {
  Payment payment = 1;
  string client_secret = 2;
}

message GetPaymentIntentRequest {
  string id = 1;
}

message GetPaymentIntentResponse {
  Payment payment = 1;
}

message CapturePaymentRequest {
  string payment_intent_id = 1;
}

message CapturePaymentResponse {
  Payment payment = 1;
}

message RefundPaymentRequest {
  string payment_intent_id = 1;
  optional common.Money amount = 2;
  string reason = 3;
}

message RefundPaymentResponse {
  string refund_id = 1;
  common.Money amount = 2;
  string status = 3;
}

message HandleWebhookRequest {
  bytes payload = 1;
  string signature = 2;
}

message HandleWebhookResponse {
  bool success = 1;
}
```

### 4.2 Payment Service Implementation

**services/payment/internal/service/payment_service.go**

```go
package service

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/paymentintent"
	"github.com/stripe/stripe-go/v76/refund"
	"github.com/stripe/stripe-go/v76/webhook"
	"go.uber.org/zap"

	"github.com/yourusername/ecommerce/pkg/events"
	"github.com/yourusername/ecommerce/services/payment/internal/domain"
	"github.com/yourusername/ecommerce/services/payment/internal/repository"
)

// PaymentService handles payment processing
type PaymentService struct {
	paymentRepo    *repository.PaymentRepository
	eventPublisher events.Publisher
	logger         *zap.Logger
	webhookSecret  string
}

// NewPaymentService creates a new PaymentService
func NewPaymentService(
	paymentRepo *repository.PaymentRepository,
	eventPublisher events.Publisher,
	logger *zap.Logger,
	stripeSecretKey string,
	webhookSecret string,
) *PaymentService {
	stripe.Key = stripeSecretKey

	return &PaymentService{
		paymentRepo:    paymentRepo,
		eventPublisher: eventPublisher,
		logger:         logger,
		webhookSecret:  webhookSecret,
	}
}

// CreatePaymentIntent creates a Stripe payment intent
func (s *PaymentService) CreatePaymentIntent(
	ctx context.Context,
	orderID uuid.UUID,
	amount int64,
	currency string,
	customerEmail string,
	metadata map[string]string,
) (*domain.Payment, string, error) {
	// Create payment record
	payment := &domain.Payment{
		ID:       uuid.New(),
		OrderID:  orderID,
		Amount:   amount,
		Currency: currency,
		Status:   domain.PaymentStatusPending,
		Metadata: metadata,
	}

	// Add order ID to metadata
	if payment.Metadata == nil {
		payment.Metadata = make(map[string]string)
	}
	payment.Metadata["order_id"] = orderID.String()
	payment.Metadata["payment_id"] = payment.ID.String()

	// Create Stripe payment intent
	params := &stripe.PaymentIntentParams{
		Amount:   stripe.Int64(amount),
		Currency: stripe.String(currency),
		Metadata: payment.Metadata,
	}

	if customerEmail != "" {
		params.ReceiptEmail = stripe.String(customerEmail)
	}

	// Enable automatic payment methods
	params.AutomaticPaymentMethods = &stripe.PaymentIntentAutomaticPaymentMethodsParams{
		Enabled: stripe.Bool(true),
	}

	pi, err := paymentintent.New(params)
	if err != nil {
		return nil, "", fmt.Errorf("creating Stripe payment intent: %w", err)
	}

	payment.StripePaymentIntentID = pi.ID
	payment.Status = stripeStatusToDomain(pi.Status)
	payment.CreatedAt = time.Now()
	payment.UpdatedAt = time.Now()

	// Save payment to database
	if err := s.paymentRepo.Create(ctx, payment); err != nil {
		return nil, "", fmt.Errorf("saving payment: %w", err)
	}

	// Publish payment created event
	if err := s.publishEvent(ctx, "payment.created", payment); err != nil {
		s.logger.Error("failed to publish payment created event", zap.Error(err))
	}

	s.logger.Info("payment intent created",
		zap.String("payment_id", payment.ID.String()),
		zap.String("stripe_payment_intent_id", pi.ID),
		zap.Int64("amount", amount),
		zap.String("currency", currency),
	)

	return payment, pi.ClientSecret, nil
}

// GetPaymentIntent retrieves a payment by Stripe payment intent ID
func (s *PaymentService) GetPaymentIntent(ctx context.Context, paymentIntentID string) (*domain.Payment, error) {
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, paymentIntentID)
	if err != nil {
		return nil, fmt.Errorf("getting payment: %w", err)
	}

	return payment, nil
}

// CapturePayment captures a payment (for manual capture)
func (s *PaymentService) CapturePayment(ctx context.Context, paymentIntentID string) (*domain.Payment, error) {
	// Get payment from database
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, paymentIntentID)
	if err != nil {
		return nil, fmt.Errorf("getting payment: %w", err)
	}

	// Capture payment intent in Stripe
	pi, err := paymentintent.Capture(paymentIntentID, nil)
	if err != nil {
		return nil, fmt.Errorf("capturing Stripe payment intent: %w", err)
	}

	// Update payment status
	payment.Status = stripeStatusToDomain(pi.Status)
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return nil, fmt.Errorf("updating payment: %w", err)
	}

	// Publish payment captured event
	if err := s.publishEvent(ctx, "payment.captured", payment); err != nil {
		s.logger.Error("failed to publish payment captured event", zap.Error(err))
	}

	s.logger.Info("payment captured",
		zap.String("payment_id", payment.ID.String()),
		zap.String("stripe_payment_intent_id", paymentIntentID),
	)

	return payment, nil
}

// RefundPayment creates a refund for a payment
func (s *PaymentService) RefundPayment(
	ctx context.Context,
	paymentIntentID string,
	amount *int64,
	reason string,
) (string, int64, error) {
	// Get payment from database
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, paymentIntentID)
	if err != nil {
		return "", 0, fmt.Errorf("getting payment: %w", err)
	}

	// Create refund params
	params := &stripe.RefundParams{
		PaymentIntent: stripe.String(paymentIntentID),
	}

	if amount != nil {
		params.Amount = stripe.Int64(*amount)
	}

	if reason != "" {
		params.Reason = stripe.String(reason)
	}

	// Create refund in Stripe
	r, err := refund.New(params)
	if err != nil {
		return "", 0, fmt.Errorf("creating Stripe refund: %w", err)
	}

	// Update payment status
	if r.Amount == payment.Amount {
		payment.Status = domain.PaymentStatusRefunded
	} else {
		payment.Status = domain.PaymentStatusPartiallyRefunded
	}
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return "", 0, fmt.Errorf("updating payment: %w", err)
	}

	// Publish payment refunded event
	if err := s.publishEvent(ctx, "payment.refunded", map[string]any{
		"payment_id":  payment.ID.String(),
		"refund_id":   r.ID,
		"amount":      r.Amount,
		"reason":      reason,
		"full_refund": r.Amount == payment.Amount,
	}); err != nil {
		s.logger.Error("failed to publish payment refunded event", zap.Error(err))
	}

	s.logger.Info("payment refunded",
		zap.String("payment_id", payment.ID.String()),
		zap.String("refund_id", r.ID),
		zap.Int64("amount", r.Amount),
	)

	return r.ID, r.Amount, nil
}

// HandleWebhook processes Stripe webhooks
func (s *PaymentService) HandleWebhook(ctx context.Context, payload []byte, signature string) error {
	// Verify webhook signature
	event, err := webhook.ConstructEvent(payload, signature, s.webhookSecret)
	if err != nil {
		return fmt.Errorf("verifying webhook signature: %w", err)
	}

	s.logger.Info("received webhook event",
		zap.String("type", string(event.Type)),
		zap.String("id", event.ID),
	)

	// Handle different event types
	switch event.Type {
	case "payment_intent.succeeded":
		return s.handlePaymentIntentSucceeded(ctx, event)
	case "payment_intent.payment_failed":
		return s.handlePaymentIntentFailed(ctx, event)
	case "payment_intent.canceled":
		return s.handlePaymentIntentCanceled(ctx, event)
	case "charge.refunded":
		return s.handleChargeRefunded(ctx, event)
	default:
		s.logger.Info("unhandled webhook event type", zap.String("type", string(event.Type)))
	}

	return nil
}

func (s *PaymentService) handlePaymentIntentSucceeded(ctx context.Context, event stripe.Event) error {
	var pi stripe.PaymentIntent
	if err := event.Data.UnmarshalJSON(&pi); err != nil {
		return fmt.Errorf("unmarshaling payment intent: %w", err)
	}

	// Get payment from database
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, pi.ID)
	if err != nil {
		return fmt.Errorf("getting payment: %w", err)
	}

	// Update payment status
	payment.Status = domain.PaymentStatusSucceeded
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

	// Publish payment succeeded event
	if err := s.publishEvent(ctx, "payment.succeeded", payment); err != nil {
		s.logger.Error("failed to publish payment succeeded event", zap.Error(err))
	}

	s.logger.Info("payment succeeded",
		zap.String("payment_id", payment.ID.String()),
		zap.String("order_id", payment.OrderID.String()),
	)

	return nil
}

func (s *PaymentService) handlePaymentIntentFailed(ctx context.Context, event stripe.Event) error {
	var pi stripe.PaymentIntent
	if err := event.Data.UnmarshalJSON(&pi); err != nil {
		return fmt.Errorf("unmarshaling payment intent: %w", err)
	}

	// Get payment from database
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, pi.ID)
	if err != nil {
		return fmt.Errorf("getting payment: %w", err)
	}

	// Update payment status
	payment.Status = domain.PaymentStatusFailed
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

	// Publish payment failed event
	if err := s.publishEvent(ctx, "payment.failed", payment); err != nil {
		s.logger.Error("failed to publish payment failed event", zap.Error(err))
	}

	s.logger.Info("payment failed",
		zap.String("payment_id", payment.ID.String()),
		zap.String("order_id", payment.OrderID.String()),
	)

	return nil
}

func (s *PaymentService) handlePaymentIntentCanceled(ctx context.Context, event stripe.Event) error {
	var pi stripe.PaymentIntent
	if err := event.Data.UnmarshalJSON(&pi); err != nil {
		return fmt.Errorf("unmarshaling payment intent: %w", err)
	}

	// Get payment from database
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, pi.ID)
	if err != nil {
		return fmt.Errorf("getting payment: %w", err)
	}

	// Update payment status
	payment.Status = domain.PaymentStatusCanceled
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

	// Publish payment canceled event
	if err := s.publishEvent(ctx, "payment.canceled", payment); err != nil {
		s.logger.Error("failed to publish payment canceled event", zap.Error(err))
	}

	return nil
}

func (s *PaymentService) handleChargeRefunded(ctx context.Context, event stripe.Event) error {
	var charge stripe.Charge
	if err := event.Data.UnmarshalJSON(&charge); err != nil {
		return fmt.Errorf("unmarshaling charge: %w", err)
	}

	// Get payment from database
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, charge.PaymentIntent.ID)
	if err != nil {
		return fmt.Errorf("getting payment: %w", err)
	}

	// Update payment status
	if charge.Refunded {
		payment.Status = domain.PaymentStatusRefunded
	} else {
		payment.Status = domain.PaymentStatusPartiallyRefunded
	}
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

	return nil
}

func (s *PaymentService) publishEvent(ctx context.Context, eventType string, data any) error {
	return s.eventPublisher.Publish(ctx, eventType, data)
}

func stripeStatusToDomain(status stripe.PaymentIntentStatus) domain.PaymentStatus {
	switch status {
	case stripe.PaymentIntentStatusRequiresPaymentMethod:
		return domain.PaymentStatusRequiresPaymentMethod
	case stripe.PaymentIntentStatusRequiresConfirmation:
		return domain.PaymentStatusRequiresConfirmation
	case stripe.PaymentIntentStatusProcessing:
		return domain.PaymentStatusProcessing
	case stripe.PaymentIntentStatusSucceeded:
		return domain.PaymentStatusSucceeded
	case stripe.PaymentIntentStatusCanceled:
		return domain.PaymentStatusCanceled
	default:
		return domain.PaymentStatusPending
	}
}
```

---

### Junior → FAANG: Payment Integration as a Security-Critical Discipline

Payment processing is the highest-security operation in an e-commerce system. Three rules that must never be violated: never log payment method details (card numbers, CVV), never store raw card data (use Stripe's token or payment method IDs), and always verify webhook signatures before processing webhook events.

Stripe's two-step flow (create PaymentIntent, then confirm) is the correct pattern for server-side payment initiation. The client receives the client secret, confirms with the payment provider, and the server receives confirmation via webhook. Never confirm a payment on the server side using information received from the client: clients are not trusted.

Idempotency keys in Stripe API calls prevent double charges on network retries. Pass your order ID as the idempotency key. On retry after a timeout, Stripe returns the original result without creating a second charge. Know this pattern and be able to explain it in an interview.

### Senior @ FAANG: Payment Service as a Compliance Boundary

At senior level, the payment service is not just a Stripe wrapper. It is a PCI DSS compliance boundary. Any system that handles payment card data must comply with PCI DSS requirements, which include network segmentation (the payment service must be isolated from services that do not need payment data), audit logging of all payment-related operations (who charged what, when, and with what authorization), and annual penetration testing.

The webhook signature verification pattern is a zero-trust mechanism: you do not trust that the webhook came from Stripe just because it arrived at your endpoint. The signature verification (using Stripe's shared secret to verify the HMAC signature) is the authentication mechanism. Without it, any actor who knows your webhook URL can inject fake payment events.

Refund logic requires the same idempotency guarantees as charge logic. A refund that fails partway through and is retried must not issue two refunds. Using the original charge ID as the refund idempotency key prevents this. Additionally, refund processing must handle the case where the payment was never fully captured (authorization only), which requires a different API call than a standard refund.

Multi-currency and multi-payment-method support are product decisions that must be made before the payment schema is designed. Adding currencies later requires migrating all existing price columns to include a currency code, which is a large migration on a financial table that cannot have downtime.

---
