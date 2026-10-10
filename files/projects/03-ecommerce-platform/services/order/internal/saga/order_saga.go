package saga

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/example/ecommerce-platform/pkg/events"
	"github.com/example/ecommerce-platform/services/order/internal/domain"
)

// OrderSaga orchestrates the order creation process
type OrderSaga struct {
	orderRepo     OrderRepository
	productClient ProductClient
	paymentClient PaymentClient
	eventBus      events.Publisher
	logger        *zap.Logger
}

// OrderRepository defines order persistence interface
type OrderRepository interface {
	Create(ctx context.Context, order *domain.Order) error
	GetByID(ctx context.Context, id uuid.UUID) (*domain.Order, error)
	Update(ctx context.Context, order *domain.Order) error
	AddEvent(ctx context.Context, event *domain.OrderEvent) error
}

// ProductClient defines product service interface
type ProductClient interface {
	ReserveInventory(ctx context.Context, items []domain.OrderItem) (uuid.UUID, time.Time, error)
	ReleaseInventory(ctx context.Context, reservationID uuid.UUID) error
	CommitInventory(ctx context.Context, reservationID uuid.UUID) error
}

// PaymentClient defines payment service interface
type PaymentClient interface {
	CreatePaymentIntent(ctx context.Context, orderID uuid.UUID, amount, currency string) (string, error)
	CapturePayment(ctx context.Context, paymentIntentID string) error
	RefundPayment(ctx context.Context, paymentIntentID string) error
}

// NewOrderSaga creates a new OrderSaga
func NewOrderSaga(
	orderRepo OrderRepository,
	productClient ProductClient,
	paymentClient PaymentClient,
	eventBus events.Publisher,
	logger *zap.Logger,
) *OrderSaga {
	return &OrderSaga{
		orderRepo:     orderRepo,
		productClient: productClient,
		paymentClient: paymentClient,
		eventBus:      eventBus,
		logger:        logger,
	}
}

// CreateOrder executes the order creation saga
func (s *OrderSaga) CreateOrder(ctx context.Context, order *domain.Order) (*domain.Order, error) {
	s.logger.Info("starting order creation saga", zap.String("order_id", order.ID.String()))

	order.Status = domain.OrderStatusPending
	if err := s.orderRepo.Create(ctx, order); err != nil {
		return nil, fmt.Errorf("creating order: %w", err)
	}

	if err := s.publishEvent(ctx, order.ID, domain.OrderEventCreated, map[string]any{
		"user_id": order.UserID.String(),
		"total":   order.Total.String(),
	}); err != nil {
		s.logger.Error("failed to publish order created event", zap.Error(err))
	}

	reservationID, expiresAt, err := s.productClient.ReserveInventory(ctx, order.Items)
	if err != nil {
		s.logger.Error("failed to reserve inventory", zap.Error(err))
		order.Status = domain.OrderStatusCancelled
		_ = s.orderRepo.Update(ctx, order)
		return nil, fmt.Errorf("reserving inventory: %w", err)
	}

	order.InventoryReservationID = reservationID
	order.Status = domain.OrderStatusPaymentPending
	if err := s.orderRepo.Update(ctx, order); err != nil {
		_ = s.productClient.ReleaseInventory(ctx, reservationID)
		return nil, fmt.Errorf("updating order: %w", err)
	}

	s.logger.Info("inventory reserved",
		zap.String("order_id", order.ID.String()),
		zap.String("reservation_id", reservationID.String()),
		zap.Time("expires_at", expiresAt),
	)

	paymentIntentID, err := s.paymentClient.CreatePaymentIntent(
		ctx,
		order.ID,
		order.Total.String(),
		order.Currency,
	)
	if err != nil {
		s.logger.Error("failed to create payment intent", zap.Error(err))
		_ = s.productClient.ReleaseInventory(ctx, reservationID)
		order.Status = domain.OrderStatusCancelled
		_ = s.orderRepo.Update(ctx, order)
		return nil, fmt.Errorf("creating payment intent: %w", err)
	}

	order.PaymentIntentID = paymentIntentID
	if err := s.orderRepo.Update(ctx, order); err != nil {
		_ = s.productClient.ReleaseInventory(ctx, reservationID)
		_ = s.paymentClient.RefundPayment(ctx, paymentIntentID)
		return nil, fmt.Errorf("updating order: %w", err)
	}

	s.logger.Info("payment intent created",
		zap.String("order_id", order.ID.String()),
		zap.String("payment_intent_id", paymentIntentID),
	)

	return order, nil
}

// ConfirmPayment handles payment confirmation
func (s *OrderSaga) ConfirmPayment(ctx context.Context, orderID uuid.UUID, paymentIntentID string) error {
	s.logger.Info("confirming payment", zap.String("order_id", orderID.String()))

	order, err := s.orderRepo.GetByID(ctx, orderID)
	if err != nil {
		return fmt.Errorf("getting order: %w", err)
	}

	if order.Status != domain.OrderStatusPaymentPending {
		return fmt.Errorf("order is not in payment pending status")
	}

	if err := s.paymentClient.CapturePayment(ctx, paymentIntentID); err != nil {
		s.logger.Error("failed to capture payment", zap.Error(err))
		return fmt.Errorf("capturing payment: %w", err)
	}

	if err := s.productClient.CommitInventory(ctx, order.InventoryReservationID); err != nil {
		s.logger.Error("failed to commit inventory", zap.Error(err))
		_ = s.paymentClient.RefundPayment(ctx, paymentIntentID)
		order.Status = domain.OrderStatusCancelled
		_ = s.orderRepo.Update(ctx, order)
		return fmt.Errorf("committing inventory: %w", err)
	}

	order.Status = domain.OrderStatusPaymentConfirmed
	if err := s.orderRepo.Update(ctx, order); err != nil {
		s.logger.Error("failed to update order status", zap.Error(err))
		return fmt.Errorf("updating order: %w", err)
	}

	if err := s.publishEvent(ctx, order.ID, domain.OrderEventPaymentConfirmed, map[string]any{
		"payment_intent_id": paymentIntentID,
		"total":             order.Total.String(),
	}); err != nil {
		s.logger.Error("failed to publish payment confirmed event", zap.Error(err))
	}

	s.logger.Info("payment confirmed", zap.String("order_id", orderID.String()))

	return nil
}

// CancelOrder handles order cancellation
func (s *OrderSaga) CancelOrder(ctx context.Context, orderID uuid.UUID, reason string) error {
	s.logger.Info("cancelling order",
		zap.String("order_id", orderID.String()),
		zap.String("reason", reason),
	)

	order, err := s.orderRepo.GetByID(ctx, orderID)
	if err != nil {
		return fmt.Errorf("getting order: %w", err)
	}

	if !order.CanCancel() {
		return domain.ErrCannotCancel
	}

	if order.InventoryReservationID != uuid.Nil {
		if err := s.productClient.ReleaseInventory(ctx, order.InventoryReservationID); err != nil {
			s.logger.Error("failed to release inventory", zap.Error(err))
		}
	}

	if order.Status == domain.OrderStatusPaymentConfirmed || order.Status == domain.OrderStatusProcessing {
		if err := s.paymentClient.RefundPayment(ctx, order.PaymentIntentID); err != nil {
			s.logger.Error("failed to refund payment", zap.Error(err))
			return fmt.Errorf("refunding payment: %w", err)
		}
		order.Status = domain.OrderStatusRefunded
	} else {
		order.Status = domain.OrderStatusCancelled
	}

	if err := s.orderRepo.Update(ctx, order); err != nil {
		return fmt.Errorf("updating order: %w", err)
	}

	if err := s.publishEvent(ctx, order.ID, domain.OrderEventCancelled, map[string]any{
		"reason": reason,
	}); err != nil {
		s.logger.Error("failed to publish cancelled event", zap.Error(err))
	}

	s.logger.Info("order cancelled", zap.String("order_id", orderID.String()))

	return nil
}

func (s *OrderSaga) publishEvent(ctx context.Context, orderID uuid.UUID, eventType domain.OrderEventType, data map[string]any) error {
	event := &domain.OrderEvent{
		ID:        uuid.New(),
		OrderID:   orderID,
		EventType: eventType,
		Data:      data,
		CreatedAt: time.Now(),
	}

	if err := s.orderRepo.AddEvent(ctx, event); err != nil {
		return fmt.Errorf("saving event: %w", err)
	}

	return s.eventBus.Publish(ctx, string(eventType), event)
}
