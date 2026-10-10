## 62.8 Delivery Tracking

Delivery tracking records the lifecycle of each notification, queued, sent, delivered, opened, failed, providing the observability needed to diagnose delivery issues and compute SLA compliance metrics. The tracker receives status updates from channel workers (for send/fail events) and from provider webhooks (for delivered/opened events) and persists them to a time-series optimized storage. This audit trail is essential for both operational debugging ("why didn't user X receive their notification?") and product analytics ("what is the open rate for transactional emails?").

```go
// tracking/delivery_tracker.go
package tracking

import (
    "context"
    "time"

    "yourproject/types"
)

// DeliveryTracker tracks notification delivery
type DeliveryTracker struct {
    repo    DeliveryRepository
    metrics Metrics
}

// DeliveryEvent represents a delivery event
type DeliveryEvent struct {
    NotificationID string
    EventType      string // sent, delivered, opened, clicked, bounced, complained
    Channel        types.Channel
    Timestamp      time.Time
    Metadata       map[string]string
}

// NewDeliveryTracker creates a new delivery tracker
func NewDeliveryTracker(repo DeliveryRepository, metrics Metrics) *DeliveryTracker {
    return &DeliveryTracker{
        repo:    repo,
        metrics: metrics,
    }
}

// RecordEvent records a delivery event
func (t *DeliveryTracker) RecordEvent(ctx context.Context, event DeliveryEvent) error {
    // Update notification status
    switch event.EventType {
    case "delivered":
        t.repo.UpdateStatus(ctx, event.NotificationID, types.StatusDelivered)
    case "bounced", "complained":
        t.repo.UpdateStatus(ctx, event.NotificationID, types.StatusBounced)
    }

    // Store event
    if err := t.repo.SaveEvent(ctx, &event); err != nil {
        return err
    }

    // Update metrics
    t.metrics.RecordDeliveryEvent(event.Channel, event.EventType)

    return nil
}

// GetDeliveryStats returns delivery statistics
func (t *DeliveryTracker) GetDeliveryStats(ctx context.Context, notificationID string) (*DeliveryStats, error) {
    events, err := t.repo.GetEvents(ctx, notificationID)
    if err != nil {
        return nil, err
    }

    stats := &DeliveryStats{
        NotificationID: notificationID,
        Events:         events,
    }

    for _, event := range events {
        switch event.EventType {
        case "sent":
            stats.SentAt = &event.Timestamp
        case "delivered":
            stats.DeliveredAt = &event.Timestamp
        case "opened":
            stats.OpenedAt = &event.Timestamp
            stats.OpenCount++
        case "clicked":
            stats.ClickedAt = &event.Timestamp
            stats.ClickCount++
        }
    }

    return stats, nil
}

// DeliveryStats contains delivery statistics
type DeliveryStats struct {
    NotificationID string
    SentAt         *time.Time
    DeliveredAt    *time.Time
    OpenedAt       *time.Time
    ClickedAt      *time.Time
    OpenCount      int
    ClickCount     int
    Events         []*DeliveryEvent
}
```

### Webhook Handlers

Email and SMS providers like SendGrid and Twilio report post-delivery events (opens, clicks, bounces, spam complaints) via outbound HTTP webhooks rather than synchronous API responses, because the provider has no connection back to the caller once the message is handed off to the recipient's mail server or carrier. Each handler translates the provider's event schema into the system's canonical `DeliveryEvent` type, preserving provider-specific metadata (e.g., `sg_event`, `MessageSid`) in the `Metadata` map for debugging without polluting the core model. The notification ID is recovered from a custom field or query parameter that the system embeds when sending, closing the loop between outbound send and inbound status update.

```go
// webhook/handlers.go
package webhook

import (
    "context"
    "encoding/json"
    "net/http"
    "time"

    "yourproject/tracking"
    "yourproject/types"
)

// WebhookHandler handles delivery webhooks from providers
type WebhookHandler struct {
    tracker *tracking.DeliveryTracker
}

// HandleSendGridWebhook handles SendGrid event webhooks
func (h *WebhookHandler) HandleSendGridWebhook(w http.ResponseWriter, r *http.Request) {
    var events []SendGridEvent
    if err := json.NewDecoder(r.Body).Decode(&events); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    ctx := r.Context()
    for _, event := range events {
        notificationID := event.NotificationID // Custom header we set

        deliveryEvent := tracking.DeliveryEvent{
            NotificationID: notificationID,
            Channel:        types.ChannelEmail,
            Timestamp:      time.Unix(event.Timestamp, 0),
            Metadata: map[string]string{
                "email":     event.Email,
                "sg_event": event.Event,
            },
        }

        switch event.Event {
        case "delivered":
            deliveryEvent.EventType = "delivered"
        case "open":
            deliveryEvent.EventType = "opened"
        case "click":
            deliveryEvent.EventType = "clicked"
        case "bounce":
            deliveryEvent.EventType = "bounced"
        case "spamreport":
            deliveryEvent.EventType = "complained"
        default:
            continue
        }

        h.tracker.RecordEvent(ctx, deliveryEvent)
    }

    w.WriteHeader(http.StatusOK)
}

type SendGridEvent struct {
    Email          string `json:"email"`
    Timestamp      int64  `json:"timestamp"`
    Event          string `json:"event"`
    NotificationID string `json:"notification_id"` // Custom field
}

// HandleTwilioWebhook handles Twilio status callbacks
func (h *WebhookHandler) HandleTwilioWebhook(w http.ResponseWriter, r *http.Request) {
    if err := r.ParseForm(); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    notificationID := r.URL.Query().Get("id")
    status := r.FormValue("MessageStatus")

    deliveryEvent := tracking.DeliveryEvent{
        NotificationID: notificationID,
        Channel:        types.ChannelSMS,
        Timestamp:      time.Now(),
        Metadata: map[string]string{
            "twilio_status": status,
            "message_sid":   r.FormValue("MessageSid"),
        },
    }

    switch status {
    case "delivered":
        deliveryEvent.EventType = "delivered"
    case "failed", "undelivered":
        deliveryEvent.EventType = "bounced"
    default:
        w.WriteHeader(http.StatusOK)
        return
    }

    h.tracker.RecordEvent(r.Context(), deliveryEvent)
    w.WriteHeader(http.StatusOK)
}
```

### Junior -> FAANG: Delivery Tracking as an Audit Trail

The `DeliveryTracker` closes the loop between the outbound send and the inbound status update. Without delivery tracking, the notification system is a black box: you know you sent, but you do not know if the user received. This matters for customer support ("why didn't I get my OTP?"), product analytics ("what is our email open rate?"), and compliance ("can you demonstrate that user X's password reset email was delivered?").

The canonical event types (sent, delivered, opened, clicked, bounced, complained) map directly to the events that SendGrid and Twilio report via webhooks. Understanding which events require action is a first-job distinction: "bounced" means the email address is invalid or the mailbox is full (temporary or permanent), while "complained" means the user marked the email as spam, and this user must be immediately added to the suppression list or you risk getting your sending IP blacklisted.

The `ProviderID` field in `NotificationResult` is the external provider's message ID (SendGrid's `message-id`, Twilio's `MessageSid`). Store this field. When debugging a delivery issue, the provider's support team will ask for this ID to look up the message in their logs. Without it, debugging delivery failures is nearly impossible.

The webhook handler pattern (translating provider-specific event schemas into a canonical `DeliveryEvent`) is the adapter pattern applied to delivery tracking. New providers can be added by writing a new webhook handler adapter without touching the tracking core.

### Senior @ FAANG: Delivery Tracking Infrastructure for Analytics and Compliance

**Webhook security is non-negotiable**

The `HandleSendGridWebhook` handler accepts any POST request and processes it. A production handler must first validate that the webhook came from SendGrid using the `X-Twilio-Email-Event-Webhook-Signature` header (ECDSA signature over the payload). Without this validation, any attacker can send fake "delivered" events, inflating delivery metrics and potentially obscuring real delivery failures. Every provider that sends webhooks also provides a signature mechanism. Implementing it is not optional.

**Webhook idempotency at high volume**

SendGrid and Twilio both retry webhook delivery if they do not receive a 200 response within their timeout window. This means the tracking system will receive duplicate events for the same notification. The webhook handler must be idempotent: processing the same event twice should produce the same result as processing it once. The simplest approach is to check whether the event's provider message ID has already been recorded before inserting, and return 200 (success) even on duplicates. A deduplication window of 24 hours is sufficient since providers retry for a maximum of 72 hours.

**Event storage: time-series vs relational**

The current `SaveEvent` call writes to an unspecified repository. At scale, delivery events are time-series data (high write throughput, query by time range, append-only), making TimescaleDB, InfluxDB, or a partitioned Postgres table better fits than a generic ORM-backed table. A 1M notification/minute system generates multiple delivery events/minute (each notification can generate sent, delivered, opened, clicked). At roughly 500-600 bytes per event record including metadata, that is ~10MB/second, or ~864GB/day. Choosing the right storage tier for this volume is a capacity planning concern that a senior candidate brings up unprompted.

**Using delivery data to drive product decisions**

The `DeliveryStats` struct returned by `GetDeliveryStats` contains open count and click count. These aggregate signals, at the notification type level across millions of users, drive product decisions: which notification types have the highest engagement, which channels are most effective for which user segments, and which templates should be retired. A staff-level notification platform exposes a metrics API (not just individual notification status) that product managers can query through a BI tool. Building this API is an engineering investment that pays dividends across every product team that uses the platform.

**Compliance reporting as a first-class product**

GDPR subject access requests require the ability to export all data held about a specific user, including all notifications sent to them with timestamps, content, and delivery status. CCPA requires the ability to delete all user data on request, including notification history. A notification platform that cannot produce a per-user audit export within the legally required response window (30 days for GDPR) puts the company at regulatory risk. Designing the delivery tracking schema with user-level queryability and erasure capability from day one is a staff-level architectural concern, not a compliance team afterthought.

---
