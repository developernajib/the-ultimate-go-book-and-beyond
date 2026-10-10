package service

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	stripe "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/paymentintent"
	"github.com/stripe/stripe-go/v76/refund"
	"github.com/stripe/stripe-go/v76/webhook"
	"go.uber.org/zap"

	"github.com/example/ecommerce-platform/pkg/events"
	"github.com/example/ecommerce-platform/services/payment/internal/domain"
	"github.com/example/ecommerce-platform/services/payment/internal/repository"
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
	payment := &domain.Payment{
		ID:       uuid.New(),
		OrderID:  orderID,
		Amount:   amount,
		Currency: currency,
		Status:   domain.PaymentStatusPending,
		Metadata: metadata,
	}

	if payment.Metadata == nil {
		payment.Metadata = make(map[string]string)
	}
	payment.Metadata["order_id"] = orderID.String()
	payment.Metadata["payment_id"] = payment.ID.String()

	params := &stripe.PaymentIntentParams{
		Amount:   new(amount),
		Currency: new(currency),
		Metadata: payment.Metadata,
	}

	if customerEmail != "" {
		params.ReceiptEmail = new(customerEmail)
	}

	params.AutomaticPaymentMethods = &stripe.PaymentIntentAutomaticPaymentMethodsParams{
		Enabled: new(true),
	}

	pi, err := paymentintent.New(params)
	if err != nil {
		return nil, "", fmt.Errorf("creating Stripe payment intent: %w", err)
	}

	payment.StripePaymentIntentID = pi.ID
	payment.Status = stripeStatusToDomain(pi.Status)
	payment.CreatedAt = time.Now()
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Create(ctx, payment); err != nil {
		return nil, "", fmt.Errorf("saving payment: %w", err)
	}

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

// CapturePayment captures a payment
func (s *PaymentService) CapturePayment(ctx context.Context, paymentIntentID string) (*domain.Payment, error) {
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, paymentIntentID)
	if err != nil {
		return nil, fmt.Errorf("getting payment: %w", err)
	}

	pi, err := paymentintent.Capture(paymentIntentID, nil)
	if err != nil {
		return nil, fmt.Errorf("capturing Stripe payment intent: %w", err)
	}

	payment.Status = stripeStatusToDomain(pi.Status)
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return nil, fmt.Errorf("updating payment: %w", err)
	}

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
	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, paymentIntentID)
	if err != nil {
		return "", 0, fmt.Errorf("getting payment: %w", err)
	}

	params := &stripe.RefundParams{
		PaymentIntent: new(paymentIntentID),
	}

	if amount != nil {
		params.Amount = new(*amount)
	}

	if reason != "" {
		params.Reason = new(reason)
	}

	r, err := refund.New(params)
	if err != nil {
		return "", 0, fmt.Errorf("creating Stripe refund: %w", err)
	}

	if r.Amount == payment.Amount {
		payment.Status = domain.PaymentStatusRefunded
	} else {
		payment.Status = domain.PaymentStatusPartiallyRefunded
	}
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return "", 0, fmt.Errorf("updating payment: %w", err)
	}

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
	event, err := webhook.ConstructEvent(payload, signature, s.webhookSecret)
	if err != nil {
		return fmt.Errorf("verifying webhook signature: %w", err)
	}

	s.logger.Info("received webhook event",
		zap.String("type", string(event.Type)),
		zap.String("id", event.ID),
	)

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
	if err := json.Unmarshal(event.Data.Raw, &pi); err != nil {
		return fmt.Errorf("unmarshaling payment intent: %w", err)
	}

	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, pi.ID)
	if err != nil {
		return fmt.Errorf("getting payment: %w", err)
	}

	payment.Status = domain.PaymentStatusSucceeded
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

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
	if err := json.Unmarshal(event.Data.Raw, &pi); err != nil {
		return fmt.Errorf("unmarshaling payment intent: %w", err)
	}

	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, pi.ID)
	if err != nil {
		return fmt.Errorf("getting payment: %w", err)
	}

	payment.Status = domain.PaymentStatusFailed
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

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
	if err := json.Unmarshal(event.Data.Raw, &pi); err != nil {
		return fmt.Errorf("unmarshaling payment intent: %w", err)
	}

	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, pi.ID)
	if err != nil {
		return fmt.Errorf("getting payment: %w", err)
	}

	payment.Status = domain.PaymentStatusCancelled
	payment.UpdatedAt = time.Now()

	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

	if err := s.publishEvent(ctx, "payment.cancelled", payment); err != nil {
		s.logger.Error("failed to publish payment cancelled event", zap.Error(err))
	}

	return nil
}

func (s *PaymentService) handleChargeRefunded(ctx context.Context, event stripe.Event) error {
	var charge stripe.Charge
	if err := json.Unmarshal(event.Data.Raw, &charge); err != nil {
		return fmt.Errorf("unmarshaling charge: %w", err)
	}

	payment, err := s.paymentRepo.GetByStripePaymentIntentID(ctx, charge.PaymentIntent.ID)
	if err != nil {
		return fmt.Errorf("getting payment: %w", err)
	}

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
		return domain.PaymentStatusCancelled
	default:
		return domain.PaymentStatusPending
	}
}
