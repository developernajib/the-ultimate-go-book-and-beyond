// internal/service/notification.go
package service

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"

    "github.com/google/uuid"
    "github.com/gorilla/websocket"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/domain/repository"
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
    case domain.NotificationTypeLike:
        return "liked your post"
    case domain.NotificationTypeComment:
        return "commented on your post"
    case domain.NotificationTypeFollow:
        return "started following you"
    case domain.NotificationTypeMention:
        return "mentioned you in a post"
    case domain.NotificationTypeRepost:
        return "reposted your post"
    case domain.NotificationTypeReply:
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
