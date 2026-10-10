package service

import (
	"context"
	"fmt"

	"go.uber.org/zap"
)

// NotificationService handles sending notifications
type NotificationService struct {
	logger *zap.Logger
}

// NewNotificationService creates a new NotificationService
func NewNotificationService(logger *zap.Logger) *NotificationService {
	return &NotificationService{logger: logger}
}

// SendOrderConfirmation sends an order confirmation notification
func (s *NotificationService) SendOrderConfirmation(ctx context.Context, orderID, userID string) error {
	s.logger.Info("sending order confirmation",
		zap.String("order_id", orderID),
		zap.String("user_id", userID),
	)
	// In production: send email via SMTP or email service (SES, SendGrid, etc.)
	return nil
}

// SendPaymentConfirmation sends a payment confirmation notification
func (s *NotificationService) SendPaymentConfirmation(ctx context.Context, orderID, userID string) error {
	s.logger.Info("sending payment confirmation",
		zap.String("order_id", orderID),
		zap.String("user_id", userID),
	)
	// In production: send email via SMTP or email service
	return nil
}

// SendOrderShipped sends an order shipped notification
func (s *NotificationService) SendOrderShipped(ctx context.Context, orderID, userID, trackingNumber string) error {
	s.logger.Info("sending order shipped notification",
		zap.String("order_id", orderID),
		zap.String("user_id", userID),
		zap.String("tracking_number", trackingNumber),
	)
	return nil
}

// ensure fmt is used
var _ = fmt.Sprintf
