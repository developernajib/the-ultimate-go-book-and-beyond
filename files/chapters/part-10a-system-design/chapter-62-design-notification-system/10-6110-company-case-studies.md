## 62.10 Company Case Studies

### Uber's Notification System

As documented in "RAMEN: Building Uber’s Real-Time Push Platform" (*Uber Engineering Blog*, 2017), Uber handles billions of notifications daily across rides, deliveries, and payments, requiring a notification router that selects the optimal delivery channel per notification type and user preference in real time. The router considers channel reliability (push notifications can be dropped if the device is offline), urgency (ride arrival notifications are time-critical), and cost (SMS is more expensive than push) to make routing decisions. The following implementation models Uber's channel-selection logic with priority-ordered fallback chains.

```go
// uber/notification_router.go
package uber

import (
    "context"
    "sync"
    "time"
)

// UberNotificationRouter routes notifications with location awareness
type UberNotificationRouter struct {
    regions      map[string]*RegionConfig
    channelPools map[string]*ChannelPool
    priorities   *PriorityManager
    mu           sync.RWMutex
}

type RegionConfig struct {
    Name           string
    Providers      map[string][]string // channel -> provider list
    LatencyBudgets map[string]time.Duration
    Fallbacks      map[string]string
}

// RouteNotification routes based on user location and channel availability
func (r *UberNotificationRouter) RouteNotification(ctx context.Context, n *Notification) error {
    // Get user's current region
    region := r.getRegion(n.UserID)
    config := r.regions[region]

    // Critical notifications (trip safety) bypass all throttling
    if n.Priority == PriorityCritical {
        return r.sendCritical(ctx, n, config)
    }

    // Select provider based on region and availability
    provider := r.selectProvider(config, n.Channel)

    // Send with region-specific latency budget
    deadline := config.LatencyBudgets[string(n.Channel)]
    sendCtx, cancel := context.WithTimeout(ctx, deadline)
    defer cancel()

    err := r.channelPools[provider].Send(sendCtx, n)
    if err != nil {
        // Automatic fallback to secondary provider
        if fallback, ok := config.Fallbacks[provider]; ok {
            return r.channelPools[fallback].Send(ctx, n)
        }
    }
    return err
}

// sendCritical sends safety-critical notifications through all channels
func (r *UberNotificationRouter) sendCritical(ctx context.Context, n *Notification, config *RegionConfig) error {
    // Safety notifications go through ALL available channels simultaneously
    var wg sync.WaitGroup
    errCh := make(chan error, 3)

    channels := []string{"push", "sms", "call"}
    for _, ch := range channels {
        wg.Add(1)
        go func(channel string) {
            defer wg.Done()
            provider := r.selectProvider(config, Channel(channel))
            if err := r.channelPools[provider].Send(ctx, n); err != nil {
                errCh <- err
            }
        }(ch)
    }

    wg.Wait()
    close(errCh)

    // At least one channel must succeed
    successCount := 3 - len(errCh)
    if successCount == 0 {
        return <-errCh
    }
    return nil
}
```

### Slack's Real-Time Notifications

As described in Slack's engineering posts on messaging architecture ("Flannel: An Application-Level Edge Cache for Slack", *Slack Engineering Blog*, 2017), Slack's notification system makes per-message delivery decisions based on the recipient's current presence state: an active desktop user receives the message over an existing WebSocket connection, an away user gets a delayed push notification after a configurable timeout, and a DND user has the notification queued until the quiet period ends (unless the sender marks it urgent). This presence-aware routing prevents both missed messages and notification fatigue.

```go
// slack/realtime_notifier.go
package slack

import (
    "context"
    "time"
)

// SlackNotifier handles real-time notifications with presence
type SlackNotifier struct {
    presence    *PresenceService
    connections *ConnectionManager
    pushService *PushService
    preferences *PreferenceService
}

type UserPresence struct {
    Status       string // active, away, dnd
    LastActive   time.Time
    ActiveDevice string
    DNDUntil     *time.Time
}

// NotifyUser delivers notification based on presence state
func (s *SlackNotifier) NotifyUser(ctx context.Context, userID string, msg *Message) error {
    presence, _ := s.presence.GetPresence(ctx, userID)
    prefs, _ := s.preferences.Get(ctx, userID)

    // Check Do Not Disturb
    if presence.DNDUntil != nil && time.Now().Before(*presence.DNDUntil) {
        if msg.Priority != PriorityUrgent {
            return s.queueForLater(ctx, userID, msg, *presence.DNDUntil)
        }
    }

    // Active user - deliver via WebSocket
    if presence.Status == "active" {
        conn := s.connections.GetConnection(userID, presence.ActiveDevice)
        if conn != nil {
            return conn.Send(msg)
        }
    }

    // Away user - check preferences for push
    if presence.Status == "away" {
        awayDuration := time.Since(presence.LastActive)

        // Send push after configured away time
        if awayDuration > prefs.MobilePushDelay {
            return s.pushService.Send(ctx, userID, msg)
        }

        // Queue and wait
        return s.queueWithDeadline(ctx, userID, msg, prefs.MobilePushDelay-awayDuration)
    }

    // Offline - immediate push for mentions, queue others
    if msg.IsMention || msg.IsDM {
        return s.pushService.Send(ctx, userID, msg)
    }

    return s.queueForBadgeOnly(ctx, userID, msg)
}
```

### WhatsApp's Delivery Guarantees

As detailed by Rick Reed in "Scaling Erlang at WhatsApp" (*Erlang Factory*, 2014) and subsequent Meta engineering retrospectives, WhatsApp's delivery model uses a write-ahead log pattern: every message is persisted to durable storage before any delivery attempt, so a server crash never loses a message. Delivery proceeds through a WebSocket to connected devices, with a 30-second acknowledgment window. If the ack does not arrive, the message enters an exponential backoff retry queue that persists across server restarts. The state machine tracks each message through `pending → sent → delivered → read`, with each transition visible to both sender and recipient.

```go
// whatsapp/delivery_guarantee.go
package whatsapp

import (
    "context"
    "time"
)

// WhatsAppDelivery provides guaranteed message delivery
type WhatsAppDelivery struct {
    store       MessageStore
    queue       *RetryQueue
    acks        *AckTracker
    connections *ConnectionPool
}

type MessageState struct {
    ID          string
    State       string // pending, sent, delivered, read
    Attempts    int
    LastAttempt time.Time
    NextRetry   time.Time
}

// SendWithGuarantee ensures message delivery with retries
func (w *WhatsAppDelivery) SendWithGuarantee(ctx context.Context, msg *Message) error {
    // Store message first (write-ahead log pattern)
    state := &MessageState{
        ID:        msg.ID,
        State:     "pending",
        Attempts:  0,
        NextRetry: time.Now(),
    }
    if err := w.store.Save(ctx, msg, state); err != nil {
        return err
    }

    // Attempt delivery
    return w.attemptDelivery(ctx, msg, state)
}

func (w *WhatsAppDelivery) attemptDelivery(ctx context.Context, msg *Message, state *MessageState) error {
    state.Attempts++
    state.LastAttempt = time.Now()

    // Try to get active connection
    conn := w.connections.GetConnection(msg.RecipientID)

    if conn != nil && conn.IsActive() {
        // Send via WebSocket
        if err := conn.SendMessage(msg); err == nil {
            state.State = "sent"
            w.store.UpdateState(ctx, state)

            // Wait for delivery ack with timeout
            ackCh := w.acks.WaitForAck(msg.ID, 30*time.Second)
            select {
            case ack := <-ackCh:
                if ack.Type == "delivered" {
                    state.State = "delivered"
                    w.store.UpdateState(ctx, state)
                    return nil
                }
            case <-time.After(30 * time.Second):
                // No ack, will retry
            }
        }
    }

    // Schedule retry with exponential backoff
    backoff := w.calculateBackoff(state.Attempts)
    state.NextRetry = time.Now().Add(backoff)
    w.store.UpdateState(ctx, state)

    return w.queue.ScheduleRetry(msg.ID, backoff)
}

func (w *WhatsAppDelivery) calculateBackoff(attempts int) time.Duration {
    // Exponential backoff: 1s, 2s, 4s, 8s, ... max 5min
    backoff := time.Second * time.Duration(1<<uint(attempts-1))
    if backoff > 5*time.Minute {
        backoff = 5 * time.Minute
    }
    return backoff
}
```

### Junior -> FAANG: What These Case Studies Are Testing

Interviewers at FAANG who ask about real-world notification systems are not testing your memorization of company blog posts. They are testing whether you can extract transferable architectural principles from concrete examples and apply them to novel problems.

From Uber: the key principle is that safety-critical notifications (trip status, emergency alerts) bypass all throttling and are sent through all available channels simultaneously. The fan-out to push, SMS, and phone call in `sendCritical` is the implementation of "priority as a first-class architectural concern."

From Slack: the key principle is presence-aware routing. Sending a push notification to a user who is actively reading on desktop is wasteful and jarring. Slack's presence state machine (active, away, DND, offline) maps to a notification routing decision tree, not just a "send or not" binary. For your own system designs, ask: does the notification delivery decision depend on any real-time user state (presence, device activity, timezone)? If yes, that state needs to be part of the routing decision.

From WhatsApp: the write-ahead log pattern before any delivery attempt is the mechanism that provides "no message loss" guarantees. If you are asked "how do you ensure no notification is ever dropped?", the answer starts with "persist before delivering." This is the same principle as WAL in databases, applied to a notification system.

### Senior @ FAANG: Reading Case Studies as ADR Inputs

**Uber's region-aware routing as a governance model**

The `RegionConfig` structure with per-region provider lists and latency budgets is an example of configuration-driven routing. The routing algorithm itself is generic: "try the best provider for this region within the latency budget, fall back to the secondary." The business logic (which provider is best in which region, what the latency budget is) lives in configuration, not in code. This separation enables ops teams to tune provider selection without code deployments. At a bar-raiser level, the candidate asks: "Who owns this configuration? How is it version-controlled? How are changes reviewed?"

**Slack's DND and the user experience contract**

The `queueForLater` path in `NotifyUser` is the implementation of a user experience contract: "if you set DND, we will not interrupt you until it ends." This contract must be enforced unconditionally, or users stop trusting the feature. The only exception (urgent messages) must be explicitly named in the product spec and implemented as a separate `PriorityUrgent` enum value, not as a boolean flag that any caller can set to `true`. A common FAANG interview question is: "How do you prevent urgent priority from being abused to bypass DND?" The answer is: enforce it at the platform level by requiring the notification type to be pre-registered as a legitimate urgent type, with product and legal review before activation.

**WhatsApp's state machine as a reliability pattern**

The `pending -> sent -> delivered -> read` state machine is a reliability contract. Each state transition is persisted before the next action is attempted, so a crash at any point can be recovered by resuming from the last persisted state. This is the pattern that enables WhatsApp's offline delivery guarantee: a message can wait in `pending` for days while the recipient is offline, survive multiple server restarts, and be delivered when the recipient comes online. Any notification system with a "no message loss" SLA should model this state machine explicitly in the database schema.

**What these companies have in common**

All three case studies share a design principle: the delivery decision is made per-user in real time, not at the time of the triggering event. Uber routes based on the user's current region at delivery time. Slack routes based on the user's current presence at delivery time. WhatsApp delivers based on the user's current connection state at delivery time. Systems that make the delivery decision at event time (during intake) and then blindly execute it will fail when user state changes between event and delivery.

---
