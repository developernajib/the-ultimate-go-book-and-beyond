## 62.1 Requirements Analysis

### Functional Requirements

1. **Multi-channel Support**: Email, SMS, Push notifications, In-app
2. **Templating**: Dynamic content generation
3. **Scheduling**: Immediate and scheduled delivery
4. **Preferences**: User notification preferences
5. **Tracking**: Delivery status and analytics
6. **Batching**: Aggregate similar notifications

### Non-Functional Requirements

1. **High Throughput**: 1M+ notifications per minute
2. **Low Latency**: Critical notifications < 5 seconds
3. **Reliability**: 99.99% delivery for critical notifications
4. **Scalability**: Horizontal scaling
5. **Fault Tolerance**: No message loss

### Notification Types and Priorities

Separating notifications by priority and channel at the type level is a prerequisite for routing them into different Kafka topics with different SLA guarantees, critical OTP messages must never queue behind marketing newsletters. The `IdempotencyKey` field allows callers to safely retry failed requests without producing duplicate notifications. The service stores this key with a TTL and rejects re-submissions within that window. `ExpiresAt` ensures time-sensitive notifications (e.g., a one-time login link) are discarded rather than delivered late, preventing confusing user experiences.

```go
// types/notification.go
package types

import "time"

// Priority levels for notifications
type Priority int

const (
    PriorityCritical Priority = iota // Security alerts, OTP, payment confirmations
    PriorityHigh                      // Order updates, account changes
    PriorityMedium                    // Social interactions, recommendations
    PriorityLow                       // Marketing, newsletters
)

// Channel represents notification delivery channel
type Channel string

const (
    ChannelEmail Channel = "email"
    ChannelSMS   Channel = "sms"
    ChannelPush  Channel = "push"
    ChannelInApp Channel = "in_app"
)

// Notification represents a notification to be sent
type Notification struct {
    ID           string                 `json:"id"`
    UserID       string                 `json:"user_id"`
    Type         string                 `json:"type"`
    Channel      Channel                `json:"channel"`
    Priority     Priority               `json:"priority"`
    Template     string                 `json:"template"`
    Data         map[string]any `json:"data"`
    ScheduledAt  *time.Time             `json:"scheduled_at,omitempty"`
    ExpiresAt    *time.Time             `json:"expires_at,omitempty"`
    IdempotencyKey string               `json:"idempotency_key,omitempty"`
    Metadata     map[string]string      `json:"metadata,omitempty"`
    CreatedAt    time.Time              `json:"created_at"`
}

// DeliveryStatus represents notification delivery status
type DeliveryStatus string

const (
    StatusPending   DeliveryStatus = "pending"
    StatusQueued    DeliveryStatus = "queued"
    StatusSending   DeliveryStatus = "sending"
    StatusDelivered DeliveryStatus = "delivered"
    StatusFailed    DeliveryStatus = "failed"
    StatusBounced   DeliveryStatus = "bounced"
)

// NotificationResult represents delivery result
type NotificationResult struct {
    NotificationID string
    Status         DeliveryStatus
    Channel        Channel
    DeliveredAt    *time.Time
    Error          string
    ProviderID     string // External provider message ID
    Attempts       int
}
```

### Junior -> FAANG: Requirements Gathering as a Signal of Seniority

Interviewers at FAANG use the requirements analysis phase to separate candidates who think deeply from candidates who rush to draw boxes. Before writing a single line of architecture, spend five minutes asking clarifying questions: What is the expected daily notification volume? What is the SLA for critical vs marketing messages? Does the system need to support opt-out compliance (CAN-SPAM, GDPR)? Are there existing provider contracts with SendGrid or Twilio?

The `IdempotencyKey` field in the notification type is a first-job distinction. Many junior candidates build retry logic without idempotency, then wonder why users complain about duplicate emails. The habit to build: every API that produces side effects in external systems must accept a client-generated idempotency key and deduplicate within a 24-hour window.

The `ExpiresAt` field is equally important and often missed. An OTP valid for 10 minutes must not be delivered 15 minutes later after a retry storm. Interviewers notice candidates who include expiry enforcement versus those who leave it as a TODO.

For channel prioritization: knowing that `PriorityCritical` (OTP, payment confirmation) must never queue behind `PriorityLow` (marketing newsletter) is a functional requirement, but knowing to enforce it with separate Kafka topics rather than consumer-side filtering is the architectural insight that shows engineering depth.

### Senior @ FAANG: Non-Functional Requirements as Constraints That Drive Architecture

At the senior level, non-functional requirements are not a checklist to complete. They are the constraints from which the entire architecture flows. Working backward from "99.99% delivery for critical notifications" is how you justify the cost of multi-provider failover, write-ahead logging, and distributed idempotency stores.

The 1M+ notifications per minute requirement deserves a capacity calculation at the whiteboard, not just a nodding acknowledgment. 1M/min is roughly 16,700/sec. An email provider like SendGrid supports up to 100 connections per IP and roughly 200 messages/second per connection on dedicated IPs. That means you need multiple sending IPs, properly warmed, with per-IP rate tracking. A candidate who arrives at this number during the interview signals production-grade thinking.

**Compliance as a non-negotiable non-functional requirement**

At FAANG, legal and compliance requirements are first-class NFRs. CAN-SPAM requires a physical postal address and an unsubscribe mechanism on every commercial email. GDPR requires that opt-out preferences propagate within 24 hours. CASL in Canada requires express consent before sending commercial messages. These are not nice-to-haves that get added later. They are requirements that affect the data model (you need to store consent timestamps and consent source), the preference engine (unsubscribe must be real-time, not eventually consistent), and the audit trail (compliance teams must be able to demonstrate that a specific user's opt-out was respected).

**Capacity planning as an architectural input**

The notification type hierarchy described above feeds directly into capacity planning. If 80% of volume is PriorityLow marketing messages and only 0.1% is PriorityCritical, then the critical path can be over-provisioned (expensive) without affecting the economics of the marketing path (cheaper, asynchronous, higher latency tolerance). This is a cost-performance tradeoff that a principal engineer must be able to articulate and quantify, not just sketch.

**Observability requirements belong in this section**

A production notification system needs these metrics from day one: delivery rate per channel per priority, per-provider failure rate and latency, per-user rate limit hit rate, and end-to-end notification latency (time from API call to delivery). Defining these as requirements here, rather than treating them as an afterthought, is what separates a platform design from a point solution.

---
