// internal/domain/repository/notification.go
package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/example/social-network/internal/domain"
)

// NotificationRepository defines data access for notifications.
type NotificationRepository interface {
	Create(ctx context.Context, notification *domain.Notification) error
	GetByUserID(ctx context.Context, userID uuid.UUID, limit, offset int) ([]*domain.Notification, error)
	GetUnreadCount(ctx context.Context, userID uuid.UUID) (int, error)
	MarkAsRead(ctx context.Context, notificationID, userID uuid.UUID) error
	MarkAllAsRead(ctx context.Context, userID uuid.UUID) error
}
