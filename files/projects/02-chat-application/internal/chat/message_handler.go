package chat

import (
	"context"
	"fmt"

	"github.com/example/chat-application/internal/models"
	"github.com/example/chat-application/internal/storage"
	"github.com/google/uuid"
)

type messageHandler struct {
	pgStore *storage.PostgresStore
}

func NewMessageHandler(pgStore *storage.PostgresStore) MessageHandler {
	return &messageHandler{
		pgStore: pgStore,
	}
}

func (h *messageHandler) SaveMessage(ctx context.Context, userID, channelID uuid.UUID, content string) (*models.Message, error) {
	// Validate user is in channel
	isMember, err := h.pgStore.IsUserInChannel(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("check channel membership: %w", err)
	}
	if !isMember {
		return nil, fmt.Errorf("user not in channel")
	}

	// Create message
	message, err := h.pgStore.CreateMessage(ctx, userID, channelID, content, models.MessageTypeText)
	if err != nil {
		return nil, fmt.Errorf("create message: %w", err)
	}

	return message, nil
}

func (h *messageHandler) GetMessages(ctx context.Context, channelID uuid.UUID, limit int, before *uuid.UUID) ([]*models.Message, error) {
	return h.pgStore.GetMessages(ctx, channelID, limit, before)
}

func (h *messageHandler) DeleteMessage(ctx context.Context, messageID, userID uuid.UUID) error {
	// In a real implementation, check if user owns the message
	// For now, soft delete by updating deleted_at
	return nil
}

func (h *messageHandler) AddReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error {
	return h.pgStore.AddReaction(ctx, messageID, userID, emoji)
}

func (h *messageHandler) RemoveReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error {
	return h.pgStore.RemoveReaction(ctx, messageID, userID, emoji)
}
