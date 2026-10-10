package chat

import (
	"context"

	"github.com/example/chat-application/internal/storage"
	"github.com/google/uuid"
)

type presenceService struct {
	redisStore *storage.RedisStore
}

func NewPresenceService(redisStore *storage.RedisStore) PresenceService {
	return &presenceService{
		redisStore: redisStore,
	}
}

func (s *presenceService) SetOnline(ctx context.Context, userID uuid.UUID) error {
	return s.redisStore.SetOnline(ctx, userID)
}

func (s *presenceService) SetOffline(ctx context.Context, userID uuid.UUID) error {
	return s.redisStore.SetOffline(ctx, userID)
}

func (s *presenceService) SetTyping(ctx context.Context, userID, channelID uuid.UUID, isTyping bool) error {
	return s.redisStore.SetTyping(ctx, userID, channelID, isTyping)
}

func (s *presenceService) GetOnlineUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	return s.redisStore.GetOnlineUsers(ctx, channelID)
}

func (s *presenceService) GetTypingUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	return s.redisStore.GetTypingUsers(ctx, channelID)
}
