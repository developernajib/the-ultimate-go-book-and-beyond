## Notification Service

The Notification Service delivers real-time updates to users when someone interacts with their content. Notifications are triggered by events like likes, comments, follows, and mentions. The service stores notifications in PostgreSQL for persistence and delivers them instantly through WebSocket connections when the user is online. If a user is offline, the notifications wait in the database and are fetched the next time the user opens the application. This dual approach ensures no notification is ever lost.

### Notification Domain Model
The notification service subscribes to domain events from other services and delivers alerts through in-app WebSocket push, mobile push notifications, and email digests. Deduplication logic and per-user preference settings prevent notification fatigue while ensuring important events are always delivered.

```go
// internal/domain/notification.go
package domain

import (
    "time"
    "github.com/google/uuid"
)

type Notification struct {
    ID         uuid.UUID  `json:"id" db:"id"`
    UserID     uuid.UUID  `json:"user_id" db:"user_id"`
    ActorID    *uuid.UUID `json:"actor_id" db:"actor_id"`
    Type       string     `json:"type" db:"type"`
    EntityType string     `json:"entity_type" db:"entity_type"`
    EntityID   *uuid.UUID `json:"entity_id" db:"entity_id"`
    Message    string     `json:"message" db:"message"`
    IsRead     bool       `json:"is_read" db:"is_read"`
    CreatedAt  time.Time  `json:"created_at" db:"created_at"`
    ReadAt     *time.Time `json:"read_at" db:"read_at"`

    // Hydrated fields
    Actor  *PublicUser `json:"actor,omitempty" db:"-"`
    Entity any `json:"entity,omitempty" db:"-"`
}

const (
    NotificationTypeLike    = "like"
    NotificationTypeComment = "comment"
    NotificationTypeFollow  = "follow"
    NotificationTypeMention = "mention"
    NotificationTypeRepost  = "repost"
    NotificationTypeReply   = "reply"
)
```

### Real-Time Notification Service with WebSocket

This service manages both the persistence and real-time delivery of notifications. It maintains an in-memory map of active WebSocket connections keyed by user ID, protected by a read-write mutex for thread safety. When a new notification is created, it is first saved to the database, and then immediately broadcast to all of the user's active WebSocket connections. The connection map allows a single user to have multiple open connections (for example, from a phone and a laptop simultaneously).

```go
// internal/service/notification.go
package service

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"

    "github.com/google/uuid"
    "github.com/gorilla/websocket"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/domain/repository"
    "go.uber.org/zap"
)

type NotificationService struct {
    notifRepo repository.NotificationRepository
    userRepo  repository.UserRepository
    postRepo  repository.PostRepository
    logger    *zap.Logger

    // WebSocket connections
    connections map[uuid.UUID][]*websocket.Conn
    connMux     sync.RWMutex
}

func NewNotificationService(
    notifRepo repository.NotificationRepository,
    userRepo repository.UserRepository,
    postRepo repository.PostRepository,
    logger *zap.Logger,
) *NotificationService {
    return &NotificationService{
        notifRepo:   notifRepo,
        userRepo:    userRepo,
        postRepo:    postRepo,
        logger:      logger,
        connections: make(map[uuid.UUID][]*websocket.Conn),
    }
}

func (s *NotificationService) CreateNotification(ctx context.Context, notif *domain.Notification) error {
    if notif.ID == uuid.Nil {
        notif.ID = uuid.New()
    }

    // Generate message based on type
    notif.Message = s.generateMessage(notif)

    if err := s.notifRepo.Create(ctx, notif); err != nil {
        return fmt.Errorf("create notification: %w", err)
    }

    // Send real-time notification via WebSocket
    go s.broadcastNotification(notif)

    s.logger.Info("notification created",
        zap.String("notification_id", notif.ID.String()),
        zap.String("user_id", notif.UserID.String()),
        zap.String("type", notif.Type),
    )

    return nil
}

func (s *NotificationService) GetNotifications(ctx context.Context, userID uuid.UUID, limit, offset int) ([]*domain.Notification, error) {
    if limit <= 0 || limit > 100 {
        limit = 20
    }

    notifications, err := s.notifRepo.GetByUserID(ctx, userID, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("get notifications: %w", err)
    }

    // Hydrate with actor information
    if err := s.hydrateNotifications(ctx, notifications); err != nil {
        s.logger.Error("failed to hydrate notifications", zap.Error(err))
        // Not critical, continue
    }

    return notifications, nil
}

func (s *NotificationService) GetUnreadCount(ctx context.Context, userID uuid.UUID) (int, error) {
    return s.notifRepo.GetUnreadCount(ctx, userID)
}

func (s *NotificationService) MarkAsRead(ctx context.Context, notificationID, userID uuid.UUID) error {
    return s.notifRepo.MarkAsRead(ctx, notificationID, userID)
}

func (s *NotificationService) MarkAllAsRead(ctx context.Context, userID uuid.UUID) error {
    return s.notifRepo.MarkAllAsRead(ctx, userID)
}

// WebSocket connection management
func (s *NotificationService) AddConnection(userID uuid.UUID, conn *websocket.Conn) {
    s.connMux.Lock()
    defer s.connMux.Unlock()

    s.connections[userID] = append(s.connections[userID], conn)

    s.logger.Info("websocket connection added",
        zap.String("user_id", userID.String()),
        zap.Int("total_connections", len(s.connections[userID])),
    )
}

func (s *NotificationService) RemoveConnection(userID uuid.UUID, conn *websocket.Conn) {
    s.connMux.Lock()
    defer s.connMux.Unlock()

    conns := s.connections[userID]
    for i, c := range conns {
        if c == conn {
            s.connections[userID] = append(conns[:i], conns[i+1:]...)
            break
        }
    }

    if len(s.connections[userID]) == 0 {
        delete(s.connections, userID)
    }

    s.logger.Info("websocket connection removed",
        zap.String("user_id", userID.String()),
    )
}

func (s *NotificationService) broadcastNotification(notif *domain.Notification) {
    s.connMux.RLock()
    conns := s.connections[notif.UserID]
    s.connMux.RUnlock()

    if len(conns) == 0 {
        return
    }

    data, err := json.Marshal(notif)
    if err != nil {
        s.logger.Error("failed to marshal notification", zap.Error(err))
        return
    }

    for _, conn := range conns {
        if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
            s.logger.Error("failed to send notification via websocket",
                zap.Error(err),
            )
        }
    }

    s.logger.Debug("notification broadcasted",
        zap.String("user_id", notif.UserID.String()),
        zap.Int("connections", len(conns)),
    )
}

func (s *NotificationService) generateMessage(notif *domain.Notification) string {
    switch notif.Type {
    case NotificationTypeLike:
        return "liked your post"
    case NotificationTypeComment:
        return "commented on your post"
    case NotificationTypeFollow:
        return "started following you"
    case NotificationTypeMention:
        return "mentioned you in a post"
    case NotificationTypeRepost:
        return "reposted your post"
    case NotificationTypeReply:
        return "replied to your post"
    default:
        return "interacted with you"
    }
}

func (s *NotificationService) hydrateNotifications(ctx context.Context, notifications []*domain.Notification) error {
    if len(notifications) == 0 {
        return nil
    }

    // Collect unique actor IDs
    actorIDs := make([]uuid.UUID, 0)
    for _, notif := range notifications {
        if notif.ActorID != nil {
            actorIDs = append(actorIDs, *notif.ActorID)
        }
    }

    if len(actorIDs) == 0 {
        return nil
    }

    // Fetch actors
    actors, err := s.userRepo.GetByIDs(ctx, actorIDs)
    if err != nil {
        return fmt.Errorf("get actors: %w", err)
    }

    // Create actor map
    actorMap := make(map[uuid.UUID]*domain.PublicUser)
    for _, actor := range actors {
        actorMap[actor.ID] = actor.Public()
    }

    // Attach actors to notifications
    for _, notif := range notifications {
        if notif.ActorID != nil {
            if actor, ok := actorMap[*notif.ActorID]; ok {
                notif.Actor = actor
            }
        }
    }

    return nil
}
```

### WebSocket Handler

The WebSocket handler upgrades a regular HTTP connection to a persistent WebSocket connection that stays open for real-time communication. Once connected, the server sends notifications as they arrive, and the client can send messages back (primarily for keepalive). A ping/pong mechanism detects dead connections so the server can clean them up and free resources. The handler automatically registers and deregisters connections with the notification service using defer statements, ensuring cleanup happens even if the connection drops unexpectedly.

```go
// internal/http/handler/websocket.go
package handler

import (
    "net/http"
    "time"

    "github.com/gorilla/websocket"
    "github.com/yourname/socialnet/internal/service"
    "go.uber.org/zap"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin: func(r *http.Request) bool {
        // In production, check origin properly
        return true
    },
}

type WebSocketHandler struct {
    notifService *service.NotificationService
    logger       *zap.Logger
}

func NewWebSocketHandler(
    notifService *service.NotificationService,
    logger *zap.Logger,
) *WebSocketHandler {
    return &WebSocketHandler{
        notifService: notifService,
        logger:       logger,
    }
}

func (h *WebSocketHandler) HandleNotifications(w http.ResponseWriter, r *http.Request) {
    userID := getUserIDFromContext(r.Context())

    // Upgrade connection
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        h.logger.Error("failed to upgrade websocket", zap.Error(err))
        return
    }
    defer conn.Close()

    // Add connection to notification service
    h.notifService.AddConnection(userID, conn)
    defer h.notifService.RemoveConnection(userID, conn)

    h.logger.Info("websocket connection established",
        zap.String("user_id", userID.String()),
    )

    // Set up ping/pong for connection health
    conn.SetReadDeadline(time.Now().Add(60 * time.Second))
    conn.SetPongHandler(func(string) error {
        conn.SetReadDeadline(time.Now().Add(60 * time.Second))
        return nil
    })

    // Start ping ticker
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    go func() {
        for range ticker.C {
            if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }()

    // Read messages (mainly for keepalive)
    for {
        _, _, err := conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
                h.logger.Error("websocket error", zap.Error(err))
            }
            break
        }
    }

    h.logger.Info("websocket connection closed",
        zap.String("user_id", userID.String()),
    )
}
```

### Junior → FAANG: Building and Reasoning About Notification Systems

Many junior candidates treat notifications as a simple "send a message" feature. The gap shows when they cannot explain delivery guarantees, deduplication, or fan-out cost. Before your first job, build a mental model where every notification has three separate concerns: event capture, delivery routing, and user preference filtering.

The common prerequisite miss is not understanding at-least-once delivery. If your event bus delivers a duplicate event, naive code sends the user two identical notifications. Practice implementing idempotency keys at the storage layer: a unique constraint on (user_id, event_id) so a duplicate insert fails silently rather than creating a double notification.

In entry-level interviews, interviewers look for candidates who can describe the difference between push and pull notification models and articulate when each is appropriate. Push via WebSocket is cheap when the user is online but wastes nothing when offline. Pull on reconnect requires pagination and a "last seen" cursor. Be ready to whiteboard both.

First-job habit: always write a separate notification preferences table from day one. Collapsing preferences into the user record creates a migration nightmare when product adds granular controls (per-event-type, per-channel, quiet hours). Keep it separate and addable.

### Senior @ FAANG: Notification Platform Governance and Scale Contracts

At FAANG scale, a notification service is a platform owned by one team but consumed by dozens of product teams. The architectural question is not "how do we send notifications" but "how do we govern notification traffic so no single team can degrade the experience for all users."

**Platform contract design.** Define a notification contract as a schema with mandatory fields: event type, deduplication key, priority tier (critical, high, normal, low), and TTL. Enforce this schema at the producer side using a shared SDK, not at the consumer side. This shifts the blast radius of a malformed payload from runtime to CI. The SDK publishes to a topic per priority tier, not a single unified topic, which allows the delivery layer to apply backpressure independently per tier.

**Fan-out budget governance.** The most dangerous operations in a social notification system are high-fan-out events: a celebrity with 50 million followers posts new content. A naive implementation triggers 50 million write operations synchronously. At staff level, the decision is whether to use push fan-out (write to each follower's notification queue at event time) or pull fan-out (store one record and expand on read). Most platforms use a hybrid: push for users with fewer than N followers, pull for high-follower accounts. The threshold N is a business decision documented in an ADR, not a magic constant in code.

**Delivery SLA tiering.** Not all notifications carry the same latency requirement. A two-factor authentication code must arrive in under three seconds. A weekly digest can be delayed by hours. A senior engineer codifies these SLA tiers in the service contract and implements separate delivery queues with independent scaling policies and alerting thresholds per tier. At the L6 bar, you should be able to explain how you prevent a digest-processing backlog from increasing p99 latency for OTP delivery.

**Suppression and fatigue governance.** At scale, notification fatigue drives user churn. Senior engineers build suppression systems that limit notification rate per user per hour across all product surfaces, not just per service. This requires a cross-service rate limiter with a shared Redis backend. The governance decision is who owns the global rate limit policy. Centralizing it in the notification platform prevents product teams from unilaterally exceeding the budget. Document this ownership explicitly in a service catalog entry.

**Observability requirements.** The bar-raiser interview signal at FAANG is when a candidate defines metrics at the right granularity. Track delivery rate, deduplication rate, suppression rate, and opt-out rate per event type per channel. If you only track aggregate delivery rate, you cannot detect that one event type has a 40% deduplication rate indicating a producer bug. Alerting should fire when deduplication rate exceeds a threshold, not just when delivery rate drops.

**ADR considerations.** Key architectural decisions to document: choice of fan-out model per follower tier, TTL policy per priority tier, schema versioning strategy for notification payloads, and ownership model for the global suppression budget. Each of these will be revisited when load grows or product requirements shift, and the ADR is the record that prevents relitigating context that was already decided.

---
