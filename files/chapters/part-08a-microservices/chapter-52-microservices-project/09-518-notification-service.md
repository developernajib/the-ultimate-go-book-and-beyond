## 52.8 Notification Service

The notification service delivers messages to users across multiple channels: email, push, and SMS. It depends on three sender interfaces (`EmailSender`, `PushSender`, `SMSSender`), each of which can be swapped for a stub in tests or a real provider (SendGrid, Firebase Cloud Messaging, Twilio) in production. Every notification is persisted to PostgreSQL before delivery, creating an audit trail and enabling retry of failed sends.

```go
// internal/notification/service.go
package notification

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// Notification represents a notification
type Notification struct {
	ID        string          `json:"id" db:"id"`
	UserID    string          `json:"user_id" db:"user_id"`
	Type      string          `json:"type" db:"type"`
	Channel   string          `json:"channel" db:"channel"` // email, push, sms
	Subject   string          `json:"subject" db:"subject"`
	Content   string          `json:"content" db:"content"`
	Data      json.RawMessage `json:"data,omitempty" db:"data"`
	Status    string          `json:"status" db:"status"`
	SentAt    *time.Time      `json:"sent_at,omitempty" db:"sent_at"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
}

// NotificationType constants
const (
	TypeOrderCreated   = "order_created"
	TypeOrderPaid      = "order_paid"
	TypeOrderShipped   = "order_shipped"
	TypeOrderDelivered = "order_delivered"
	TypeOrderCanceled = "order_canceled"
	TypePaymentFailed  = "payment_failed"
	TypeWelcome        = "welcome"
)

// Channel constants
const (
	ChannelEmail = "email"
	ChannelPush  = "push"
	ChannelSMS   = "sms"
)

// Service handles notification operations
type Service struct {
	db          *sql.DB
	emailSender EmailSender
	pushSender  PushSender
	smsSender   SMSSender
	logger      *slog.Logger
}

// EmailSender sends emails
type EmailSender interface {
	Send(ctx context.Context, to, subject, body string) error
}

// PushSender sends push notifications
type PushSender interface {
	Send(ctx context.Context, userID, title, body string, data map[string]string) error
}

// SMSSender sends SMS messages
type SMSSender interface {
	Send(ctx context.Context, phone, message string) error
}

// NewService creates a notification service
func NewService(db *sql.DB, email EmailSender, push PushSender, sms SMSSender, logger *slog.Logger) (*Service, error) {
	s := &Service{
		db:          db,
		emailSender: email,
		pushSender:  push,
		smsSender:   sms,
		logger:      logger,
	}
	if err := s.createSchema(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS notifications (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID NOT NULL,
			type VARCHAR(50) NOT NULL,
			channel VARCHAR(20) NOT NULL,
			subject VARCHAR(255),
			content TEXT NOT NULL,
			data JSONB,
			status VARCHAR(20) DEFAULT 'pending',
			sent_at TIMESTAMP WITH TIME ZONE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
		CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
	`

	_, err := s.db.Exec(query)
	return err
}

// SendNotification sends a notification
func (s *Service) SendNotification(ctx context.Context, notif *Notification) error {
	notif.ID = uuid.New().String()
	notif.Status = "pending"
	notif.CreatedAt = time.Now().UTC()

	// Save notification
	dataJSON, _ := json.Marshal(notif.Data)
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO notifications (id, user_id, type, channel, subject, content, data, status, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		notif.ID, notif.UserID, notif.Type, notif.Channel, notif.Subject, notif.Content, dataJSON, notif.Status, notif.CreatedAt,
	)
	if err != nil {
		return err
	}

	// Send based on channel
	var sendErr error
	switch notif.Channel {
	case ChannelEmail:
		sendErr = s.sendEmail(ctx, notif)
	case ChannelPush:
		sendErr = s.sendPush(ctx, notif)
	case ChannelSMS:
		sendErr = s.sendSMS(ctx, notif)
	default:
		sendErr = fmt.Errorf("unknown channel: %s", notif.Channel)
	}

	// Update status
	if sendErr != nil {
		s.updateStatus(ctx, notif.ID, "failed")
		s.logger.Error("Failed to send notification",
			"id", notif.ID,
			"channel", notif.Channel,
			"error", sendErr,
		)
		return sendErr
	}

	now := time.Now().UTC()
	notif.SentAt = &now
	notif.Status = "sent"
	s.updateStatus(ctx, notif.ID, "sent")

	s.logger.Info("Notification sent",
		"id", notif.ID,
		"user_id", notif.UserID,
		"type", notif.Type,
		"channel", notif.Channel,
	)

	return nil
}

func (s *Service) sendEmail(ctx context.Context, notif *Notification) error {
	// Get user email (in production, call user service)
	// For demo, assume email is in data
	var data struct {
		Email string `json:"email"`
	}
	json.Unmarshal(notif.Data, &data)

	if data.Email == "" {
		return fmt.Errorf("email not found in notification data")
	}

	return s.emailSender.Send(ctx, data.Email, notif.Subject, notif.Content)
}

func (s *Service) sendPush(ctx context.Context, notif *Notification) error {
	var data map[string]string
	json.Unmarshal(notif.Data, &data)

	return s.pushSender.Send(ctx, notif.UserID, notif.Subject, notif.Content, data)
}

func (s *Service) sendSMS(ctx context.Context, notif *Notification) error {
	var data struct {
		Phone string `json:"phone"`
	}
	json.Unmarshal(notif.Data, &data)

	if data.Phone == "" {
		return fmt.Errorf("phone not found in notification data")
	}

	return s.smsSender.Send(ctx, data.Phone, notif.Content)
}

func (s *Service) updateStatus(ctx context.Context, id, status string) {
	s.db.ExecContext(ctx,
		`UPDATE notifications SET status = $1, sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END WHERE id = $2`,
		status, id,
	)
}

// GetUserNotifications retrieves notifications for a user
func (s *Service) GetUserNotifications(ctx context.Context, userID string, limit, offset int) ([]Notification, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, type, channel, subject, content, data, status, sent_at, created_at
		 FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
		userID, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var notifications []Notification
	for rows.Next() {
		var notif Notification
		if err := rows.Scan(
			&notif.ID, &notif.UserID, &notif.Type, &notif.Channel,
			&notif.Subject, &notif.Content, &notif.Data, &notif.Status,
			&notif.SentAt, &notif.CreatedAt,
		); err != nil {
			return nil, err
		}
		notifications = append(notifications, notif)
	}

	return notifications, rows.Err()
}
```

### Junior → FAANG: Notification Service Design Patterns

The notification service introduces a pattern used throughout FAANG systems: interface-based abstraction over external providers. Understanding why this abstraction is designed this way, not just that it is, is what interviewers probe.

**Why interfaces over concrete provider clients.** `EmailSender`, `PushSender`, and `SMSSender` are interfaces, not concrete types. This means: in tests, you inject a `MockEmailSender` that records calls without network I/O. In production, you inject `SendGridEmailSender`. If you need to switch from SendGrid to SES, you add a new implementation and change one line in the composition root. The service logic is untouched. This is the Dependency Inversion Principle applied to vendor integrations, and it is the correct approach for any service that talks to external APIs.

**Why every notification is persisted before sending.** `SendNotification` inserts the notification record first, then attempts delivery. If delivery fails, the status is updated to `failed` and the record exists for retry or audit. If you send first and then persist, a crash between the two results in a sent notification with no record, which makes debugging support tickets ("I got a text but there's no order") impossible. The database record is the audit trail.

**Template rendering belongs in the service, not the handler.** The current code passes `notif.Subject` and `notif.Content` as pre-rendered strings. In production, the service should accept a notification type and data payload, then render the template internally. This keeps template logic centralized, enables A/B testing of message content, and allows localization without changing the caller.

**First-job habit.** When you add a notification channel or a notification type, add the test first. Notification bugs are invisible until a customer complains. A test that asserts "when an order is paid, a `TypeOrderPaid` email is enqueued with the correct subject" catches regressions before they reach production.

### Senior @ FAANG: Notification Platform Architecture, Reliability, and Deliverability

At FAANG scale, notification delivery is a platform engineering problem. The notification service here is a starting point. The production notification platform handles millions of messages per day, manages channel preferences per user, and tracks deliverability at the provider level.

**User notification preferences as a first-class service.** The current code sends to whichever channel is specified in the `Notification` struct. A production system consults a preferences service: does this user want order confirmations by email, SMS, or push? Have they unsubscribed from marketing? Is their phone number verified? The preferences service owns opt-in/opt-out state and must be queried before every notification is dispatched. Missing this causes legal violations (TCPA in the US, GDPR in the EU) when you send SMS to users who opted out.

**Deliverability as a platform metric.** The notification service records `sent_at` but not whether the email was delivered, opened, or bounced. A production notification platform consumes webhook events from SendGrid or SES to update delivery status: `delivered`, `bounced`, `spam_reported`, `unsubscribed`. Bounce rate and spam rate are key metrics. If the spam rate exceeds 0.1%, major email providers begin filtering all email from your sending domain. The notification platform must detect this, suppress future sends to high-bounce addresses, and alert the team before the domain reputation is damaged.

**Multi-channel fan-out with priority queues.** The pitfalls section later in this chapter describes a notification storm during Black Friday. The production architecture uses a tiered queue system: order confirmation emails are P0 (sent immediately, bypassing rate limits), shipping updates are P1 (sent within minutes), marketing is P2 (batched and rate-limited to provider quotas). The queue is backed by a database (not an in-memory channel), so it survives process restarts. Workers pull from the queue and enforce per-channel rate limits using a Redis token bucket.

**Idempotency at the notification level.** Kafka guarantees at-least-once delivery. If the notification consumer crashes after sending the email but before committing the offset, the same event is redelivered and the email is sent again. The fix is to include the Kafka event ID (or a derived idempotency key) in the notification record and check for duplicates before sending. The `UNIQUE` constraint on `(user_id, type, idempotency_key)` enforces this at the database level. Without this, customers receive duplicate order confirmation emails after any consumer rebalance.

---
