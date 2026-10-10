package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/example/chat-application/internal/models"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
)

type PostgresStore struct {
	db *sql.DB
}

func NewPostgresStore(db *sql.DB) *PostgresStore {
	return &PostgresStore{db: db}
}

// User operations

func (s *PostgresStore) CreateUser(ctx context.Context, req *models.CreateUserRequest, passwordHash string) (*models.User, error) {
	query := `
		INSERT INTO users (username, email, password_hash, display_name)
		VALUES ($1, $2, $3, $4)
		RETURNING id, username, email, password_hash, display_name, avatar_url, status, custom_status, created_at, updated_at, last_seen_at
	`

	var user models.User
	err := s.db.QueryRowContext(
		ctx,
		query,
		req.Username,
		req.Email,
		passwordHash,
		req.DisplayName,
	).Scan(
		&user.ID,
		&user.Username,
		&user.Email,
		&user.PasswordHash,
		&user.DisplayName,
		&user.AvatarURL,
		&user.Status,
		&user.CustomStatus,
		&user.CreatedAt,
		&user.UpdatedAt,
		&user.LastSeenAt,
	)

	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique violation
			return nil, fmt.Errorf("username or email already exists")
		}
		return nil, fmt.Errorf("create user: %w", err)
	}

	return &user, nil
}

func (s *PostgresStore) GetUserByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `
		SELECT id, username, email, password_hash, display_name, avatar_url, status, custom_status, created_at, updated_at, last_seen_at
		FROM users
		WHERE username = $1 AND deleted_at IS NULL
	`

	var user models.User
	err := s.db.QueryRowContext(ctx, query, username).Scan(
		&user.ID,
		&user.Username,
		&user.Email,
		&user.PasswordHash,
		&user.DisplayName,
		&user.AvatarURL,
		&user.Status,
		&user.CustomStatus,
		&user.CreatedAt,
		&user.UpdatedAt,
		&user.LastSeenAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("user not found")
	}
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}

	return &user, nil
}

func (s *PostgresStore) GetUserByID(ctx context.Context, userID uuid.UUID) (*models.User, error) {
	query := `
		SELECT id, username, email, password_hash, display_name, avatar_url, status, custom_status, created_at, updated_at, last_seen_at
		FROM users
		WHERE id = $1 AND deleted_at IS NULL
	`

	var user models.User
	err := s.db.QueryRowContext(ctx, query, userID).Scan(
		&user.ID,
		&user.Username,
		&user.Email,
		&user.PasswordHash,
		&user.DisplayName,
		&user.AvatarURL,
		&user.Status,
		&user.CustomStatus,
		&user.CreatedAt,
		&user.UpdatedAt,
		&user.LastSeenAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("user not found")
	}
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}

	return &user, nil
}

func (s *PostgresStore) UpdateUserStatus(ctx context.Context, userID uuid.UUID, status models.UserStatus) error {
	query := `
		UPDATE users
		SET status = $1, last_seen_at = $2, updated_at = NOW()
		WHERE id = $3
	`

	_, err := s.db.ExecContext(ctx, query, status, time.Now(), userID)
	return err
}

// Channel operations

func (s *PostgresStore) CreateChannel(ctx context.Context, req *models.CreateChannelRequest, createdBy uuid.UUID) (*models.Channel, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Create channel
	query := `
		INSERT INTO channels (name, description, channel_type, created_by)
		VALUES ($1, $2, $3, $4)
		RETURNING id, name, description, channel_type, created_by, created_at, updated_at
	`

	var channel models.Channel
	err = tx.QueryRowContext(
		ctx,
		query,
		req.Name,
		req.Description,
		req.Type,
		createdBy,
	).Scan(
		&channel.ID,
		&channel.Name,
		&channel.Description,
		&channel.Type,
		&channel.CreatedBy,
		&channel.CreatedAt,
		&channel.UpdatedAt,
	)

	if err != nil {
		return nil, fmt.Errorf("create channel: %w", err)
	}

	// Add creator as owner
	memberQuery := `
		INSERT INTO channel_members (channel_id, user_id, role)
		VALUES ($1, $2, $3)
	`

	_, err = tx.ExecContext(ctx, memberQuery, channel.ID, createdBy, models.MemberRoleOwner)
	if err != nil {
		return nil, fmt.Errorf("add channel owner: %w", err)
	}

	// Add other members
	for _, memberID := range req.MemberIDs {
		_, err = tx.ExecContext(ctx, memberQuery, channel.ID, memberID, models.MemberRoleMember)
		if err != nil {
			return nil, fmt.Errorf("add channel member: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}

	return &channel, nil
}

func (s *PostgresStore) GetChannelByID(ctx context.Context, channelID uuid.UUID) (*models.Channel, error) {
	query := `
		SELECT id, name, description, channel_type, created_by, created_at, updated_at
		FROM channels
		WHERE id = $1 AND deleted_at IS NULL
	`

	var channel models.Channel
	err := s.db.QueryRowContext(ctx, query, channelID).Scan(
		&channel.ID,
		&channel.Name,
		&channel.Description,
		&channel.Type,
		&channel.CreatedBy,
		&channel.CreatedAt,
		&channel.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("channel not found")
	}
	if err != nil {
		return nil, fmt.Errorf("get channel: %w", err)
	}

	return &channel, nil
}

func (s *PostgresStore) GetUserChannels(ctx context.Context, userID uuid.UUID) ([]*models.Channel, error) {
	query := `
		SELECT c.id, c.name, c.description, c.channel_type, c.created_by, c.created_at, c.updated_at
		FROM channels c
		INNER JOIN channel_members cm ON c.id = cm.channel_id
		WHERE cm.user_id = $1 AND c.deleted_at IS NULL
		ORDER BY c.updated_at DESC
	`

	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("get user channels: %w", err)
	}
	defer rows.Close()

	var channels []*models.Channel
	for rows.Next() {
		var channel models.Channel
		err := rows.Scan(
			&channel.ID,
			&channel.Name,
			&channel.Description,
			&channel.Type,
			&channel.CreatedBy,
			&channel.CreatedAt,
			&channel.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan channel: %w", err)
		}
		channels = append(channels, &channel)
	}

	return channels, nil
}

func (s *PostgresStore) IsUserInChannel(ctx context.Context, userID, channelID uuid.UUID) (bool, error) {
	query := `
		SELECT EXISTS(
			SELECT 1 FROM channel_members
			WHERE user_id = $1 AND channel_id = $2
		)
	`

	var exists bool
	err := s.db.QueryRowContext(ctx, query, userID, channelID).Scan(&exists)
	return exists, err
}

// Message operations

func (s *PostgresStore) CreateMessage(ctx context.Context, userID, channelID uuid.UUID, content string, msgType models.MessageType) (*models.Message, error) {
	query := `
		INSERT INTO messages (channel_id, user_id, content, message_type)
		VALUES ($1, $2, $3, $4)
		RETURNING id, channel_id, user_id, content, message_type, metadata, parent_message_id, created_at, updated_at
	`

	var message models.Message
	var metadata []byte

	err := s.db.QueryRowContext(
		ctx,
		query,
		channelID,
		userID,
		content,
		msgType,
	).Scan(
		&message.ID,
		&message.ChannelID,
		&message.UserID,
		&message.Content,
		&message.Type,
		&metadata,
		&message.ParentMessageID,
		&message.CreatedAt,
		&message.UpdatedAt,
	)

	if err != nil {
		return nil, fmt.Errorf("create message: %w", err)
	}

	// Parse metadata if present
	if len(metadata) > 0 {
		if err := json.Unmarshal(metadata, &message.Metadata); err != nil {
			return nil, fmt.Errorf("unmarshal metadata: %w", err)
		}
	}

	// Load user info
	user, err := s.GetUserByID(ctx, userID)
	if err == nil {
		message.User = user.ToPublic()
	}

	return &message, nil
}

func (s *PostgresStore) GetMessages(ctx context.Context, channelID uuid.UUID, limit int, before *uuid.UUID) ([]*models.Message, error) {
	var query string
	var args []any

	if before != nil {
		query = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.message_type, m.metadata, m.parent_message_id, m.created_at, m.updated_at,
				   u.id, u.username, u.display_name, u.avatar_url, u.status
			FROM messages m
			INNER JOIN users u ON m.user_id = u.id
			WHERE m.channel_id = $1 AND m.deleted_at IS NULL
			  AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
			ORDER BY m.created_at DESC
			LIMIT $3
		`
		args = []any{channelID, before, limit}
	} else {
		query = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.message_type, m.metadata, m.parent_message_id, m.created_at, m.updated_at,
				   u.id, u.username, u.display_name, u.avatar_url, u.status
			FROM messages m
			INNER JOIN users u ON m.user_id = u.id
			WHERE m.channel_id = $1 AND m.deleted_at IS NULL
			ORDER BY m.created_at DESC
			LIMIT $2
		`
		args = []any{channelID, limit}
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get messages: %w", err)
	}
	defer rows.Close()

	var messages []*models.Message
	for rows.Next() {
		var message models.Message
		var user models.PublicUser
		var metadata []byte

		err := rows.Scan(
			&message.ID,
			&message.ChannelID,
			&message.UserID,
			&message.Content,
			&message.Type,
			&metadata,
			&message.ParentMessageID,
			&message.CreatedAt,
			&message.UpdatedAt,
			&user.ID,
			&user.Username,
			&user.DisplayName,
			&user.AvatarURL,
			&user.Status,
		)
		if err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}

		// Parse metadata
		if len(metadata) > 0 {
			if err := json.Unmarshal(metadata, &message.Metadata); err != nil {
				return nil, fmt.Errorf("unmarshal metadata: %w", err)
			}
		}

		message.User = &user
		messages = append(messages, &message)
	}

	return messages, nil
}

func (s *PostgresStore) SearchMessages(ctx context.Context, query string, channelID *uuid.UUID, limit, offset int) ([]*models.Message, error) {
	var sqlQuery string
	var args []any

	if channelID != nil {
		sqlQuery = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.message_type, m.metadata, m.parent_message_id, m.created_at, m.updated_at,
				   u.id, u.username, u.display_name, u.avatar_url, u.status,
				   ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', $1)) as rank
			FROM messages m
			INNER JOIN users u ON m.user_id = u.id
			WHERE m.channel_id = $2
			  AND m.deleted_at IS NULL
			  AND to_tsvector('english', m.content) @@ plainto_tsquery('english', $1)
			ORDER BY rank DESC, m.created_at DESC
			LIMIT $3 OFFSET $4
		`
		args = []any{query, channelID, limit, offset}
	} else {
		sqlQuery = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.message_type, m.metadata, m.parent_message_id, m.created_at, m.updated_at,
				   u.id, u.username, u.display_name, u.avatar_url, u.status,
				   ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', $1)) as rank
			FROM messages m
			INNER JOIN users u ON m.user_id = u.id
			WHERE m.deleted_at IS NULL
			  AND to_tsvector('english', m.content) @@ plainto_tsquery('english', $1)
			ORDER BY rank DESC, m.created_at DESC
			LIMIT $2 OFFSET $3
		`
		args = []any{query, limit, offset}
	}

	rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("search messages: %w", err)
	}
	defer rows.Close()

	var messages []*models.Message
	for rows.Next() {
		var message models.Message
		var user models.PublicUser
		var metadata []byte
		var rank float64

		err := rows.Scan(
			&message.ID,
			&message.ChannelID,
			&message.UserID,
			&message.Content,
			&message.Type,
			&metadata,
			&message.ParentMessageID,
			&message.CreatedAt,
			&message.UpdatedAt,
			&user.ID,
			&user.Username,
			&user.DisplayName,
			&user.AvatarURL,
			&user.Status,
			&rank,
		)
		if err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}

		if len(metadata) > 0 {
			json.Unmarshal(metadata, &message.Metadata)
		}

		message.User = &user
		messages = append(messages, &message)
	}

	return messages, nil
}

// Reaction operations

func (s *PostgresStore) AddReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error {
	query := `
		INSERT INTO reactions (message_id, user_id, emoji)
		VALUES ($1, $2, $3)
		ON CONFLICT (message_id, user_id, emoji) DO NOTHING
	`

	_, err := s.db.ExecContext(ctx, query, messageID, userID, emoji)
	if err != nil {
		return fmt.Errorf("add reaction: %w", err)
	}

	return nil
}

func (s *PostgresStore) RemoveReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error {
	query := `
		DELETE FROM reactions
		WHERE message_id = $1 AND user_id = $2 AND emoji = $3
	`

	_, err := s.db.ExecContext(ctx, query, messageID, userID, emoji)
	if err != nil {
		return fmt.Errorf("remove reaction: %w", err)
	}

	return nil
}

func (s *PostgresStore) GetReactions(ctx context.Context, messageID uuid.UUID) ([]*models.Reaction, error) {
	query := `
		SELECT id, message_id, user_id, emoji, created_at
		FROM reactions
		WHERE message_id = $1
		ORDER BY created_at
	`

	rows, err := s.db.QueryContext(ctx, query, messageID)
	if err != nil {
		return nil, fmt.Errorf("get reactions: %w", err)
	}
	defer rows.Close()

	var reactions []*models.Reaction
	for rows.Next() {
		var reaction models.Reaction
		err := rows.Scan(
			&reaction.ID,
			&reaction.MessageID,
			&reaction.UserID,
			&reaction.Emoji,
			&reaction.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan reaction: %w", err)
		}
		reactions = append(reactions, &reaction)
	}

	return reactions, nil
}
