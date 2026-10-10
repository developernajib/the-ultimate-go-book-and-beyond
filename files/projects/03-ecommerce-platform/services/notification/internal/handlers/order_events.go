package handlers

import (
	"context"
	"encoding/json"
	"fmt"

	"go.uber.org/zap"

	"github.com/example/ecommerce-platform/pkg/events"
	"github.com/example/ecommerce-platform/services/notification/internal/service"
)

// OrderEventHandler handles order events
type OrderEventHandler struct {
	notificationService *service.NotificationService
	logger              *zap.Logger
}

// NewOrderEventHandler creates a new OrderEventHandler
func NewOrderEventHandler(
	notificationService *service.NotificationService,
	logger *zap.Logger,
) *OrderEventHandler {
	return &OrderEventHandler{
		notificationService: notificationService,
		logger:              logger,
	}
}

// HandleOrderCreated handles order created events
func (h *OrderEventHandler) HandleOrderCreated(ctx context.Context, msg *events.Message) error {
	var event OrderCreatedEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		return fmt.Errorf("unmarshaling event: %w", err)
	}

	h.logger.Info("handling order created event", zap.String("order_id", event.OrderID))

	if err := h.notificationService.SendOrderConfirmation(ctx, event.OrderID, event.UserID); err != nil {
		return fmt.Errorf("sending order confirmation: %w", err)
	}

	return nil
}

// HandlePaymentConfirmed handles payment confirmed events
func (h *OrderEventHandler) HandlePaymentConfirmed(ctx context.Context, msg *events.Message) error {
	var event PaymentConfirmedEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		return fmt.Errorf("unmarshaling event: %w", err)
	}

	h.logger.Info("handling payment confirmed event", zap.String("order_id", event.OrderID))

	if err := h.notificationService.SendPaymentConfirmation(ctx, event.OrderID, event.UserID); err != nil {
		return fmt.Errorf("sending payment confirmation: %w", err)
	}

	return nil
}

// Event types

type OrderCreatedEvent struct {
	OrderID string `json:"order_id"`
	UserID  string `json:"user_id"`
	Total   string `json:"total"`
}

type PaymentConfirmedEvent struct {
	OrderID         string `json:"order_id"`
	UserID          string `json:"user_id"`
	PaymentIntentID string `json:"payment_intent_id"`
	Total           string `json:"total"`
}
