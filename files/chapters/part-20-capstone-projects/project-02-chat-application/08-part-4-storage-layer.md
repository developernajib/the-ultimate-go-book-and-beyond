## Part 4: Storage Layer

The storage layer is responsible for all data persistence and caching in our chat application. You will build two main components: a PostgreSQL store for durable storage of users, messages, and channels, and a Redis store for fast caching of sessions, presence data, and rate-limiting counters. By abstracting these behind dedicated structs with clean method signatures, the rest of the application never interacts with raw SQL or Redis commands directly. This separation makes it straightforward to swap implementations, write unit tests with mocks, and reason about data flow.

### 4.1 PostgreSQL Storage (`internal/storage/postgres.go`)
The PostgreSQL storage struct wraps a `*sql.DB` connection pool and exposes methods for user management, message persistence, and channel operations. All queries use parameterized placeholders to prevent SQL injection, and context propagation enables per-request timeouts and cancellation.

```go
package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/yourusername/gochat/internal/models"
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
```

### 4.2 Redis Storage (`internal/storage/redis.go`)

The Redis storage struct handles session tokens, user presence, and rate-limiting counters. Each key uses a namespaced prefix to avoid collisions, and TTLs ensure stale entries expire automatically.

```go
package storage

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/google/uuid"
)

type RedisStore struct {
	client *redis.Client
}

func NewRedisStore(client *redis.Client) *RedisStore {
	return &RedisStore{client: client}
}

// Presence operations

func (s *RedisStore) SetOnline(ctx context.Context, userID uuid.UUID) error {
	key := fmt.Sprintf("presence:%s", userID)
	return s.client.Set(ctx, key, "online", 5*time.Minute).Err()
}

func (s *RedisStore) SetOffline(ctx context.Context, userID uuid.UUID) error {
	key := fmt.Sprintf("presence:%s", userID)
	return s.client.Del(ctx, key).Err()
}

func (s *RedisStore) IsOnline(ctx context.Context, userID uuid.UUID) (bool, error) {
	key := fmt.Sprintf("presence:%s", userID)
	val, err := s.client.Get(ctx, key).Result()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return val == "online", nil
}

func (s *RedisStore) SetTyping(ctx context.Context, userID, channelID uuid.UUID, isTyping bool) error {
	key := fmt.Sprintf("typing:%s:%s", channelID, userID)

	if isTyping {
		// Set with 5-second TTL
		return s.client.Set(ctx, key, "1", 5*time.Second).Err()
	}

	return s.client.Del(ctx, key).Err()
}

func (s *RedisStore) GetTypingUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	pattern := fmt.Sprintf("typing:%s:*", channelID)
	keys, err := s.client.Keys(ctx, pattern).Result()
	if err != nil {
		return nil, err
	}

	var userIDs []uuid.UUID
	for _, key := range keys {
		// Extract user ID from key (typing:channelID:userID)
		var userID uuid.UUID
		_, err := fmt.Sscanf(key, "typing:"+channelID.String()+":%s", &userID)
		if err == nil {
			userIDs = append(userIDs, userID)
		}
	}

	return userIDs, nil
}

func (s *RedisStore) GetOnlineUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	// This would require maintaining a set of online users per channel
	// For simplicity, we'll use a different approach in production
	key := fmt.Sprintf("channel:online:%s", channelID)
	members, err := s.client.SMembers(ctx, key).Result()
	if err != nil {
		return nil, err
	}

	var userIDs []uuid.UUID
	for _, member := range members {
		userID, err := uuid.Parse(member)
		if err == nil {
			userIDs = append(userIDs, userID)
		}
	}

	return userIDs, nil
}

func (s *RedisStore) AddOnlineUser(ctx context.Context, channelID, userID uuid.UUID) error {
	key := fmt.Sprintf("channel:online:%s", channelID)
	return s.client.SAdd(ctx, key, userID.String()).Err()
}

func (s *RedisStore) RemoveOnlineUser(ctx context.Context, channelID, userID uuid.UUID) error {
	key := fmt.Sprintf("channel:online:%s", channelID)
	return s.client.SRem(ctx, key, userID.String()).Err()
}

// Rate limiting

func (s *RedisStore) CheckRateLimit(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	now := time.Now().Unix()
	windowStart := now - int64(window.Seconds())

	pipe := s.client.Pipeline()

	// Remove old entries
	pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", windowStart))

	// Count current entries
	countCmd := pipe.ZCard(ctx, key)

	// Add current request
	pipe.ZAdd(ctx, key, &redis.Z{
		Score:  float64(now),
		Member: fmt.Sprintf("%d", now),
	})

	// Set expiry
	pipe.Expire(ctx, key, window)

	_, err := pipe.Exec(ctx)
	if err != nil {
		return false, err
	}

	count := countCmd.Val()
	return count < int64(limit), nil
}

// Session management

func (s *RedisStore) SetSession(ctx context.Context, sessionID string, userID uuid.UUID, expiration time.Duration) error {
	key := fmt.Sprintf("session:%s", sessionID)
	return s.client.Set(ctx, key, userID.String(), expiration).Err()
}

func (s *RedisStore) GetSession(ctx context.Context, sessionID string) (*uuid.UUID, error) {
	key := fmt.Sprintf("session:%s", sessionID)
	val, err := s.client.Get(ctx, key).Result()
	if err == redis.Nil {
		return nil, fmt.Errorf("session not found")
	}
	if err != nil {
		return nil, err
	}

	userID, err := uuid.Parse(val)
	if err != nil {
		return nil, fmt.Errorf("invalid session data")
	}

	return &userID, nil
}

func (s *RedisStore) DeleteSession(ctx context.Context, sessionID string) error {
	key := fmt.Sprintf("session:%s", sessionID)
	return s.client.Del(ctx, key).Err()
}

// Caching

func (s *RedisStore) CacheMessage(ctx context.Context, channelID uuid.UUID, message any) error {
	// Cache latest messages for quick retrieval
	key := fmt.Sprintf("cache:messages:%s", channelID)
	// Implementation depends on your caching strategy
	return nil
}
```

### Junior → FAANG: Storage Abstraction as a Testability Prerequisite

The repository pattern used here (a `PostgresStore` struct with interface-shaped methods) is what makes unit testing possible without a real database. When your handlers and services depend on a storage interface rather than a concrete `*sql.DB`, you can inject a mock implementation in tests that returns predefined data. This is a fundamental Go testing technique.

For interviews, describe the storage layer in terms of its interface boundary: "my chat handlers depend on a `MessageStore` interface that defines `CreateMessage`, `GetMessages`, and `DeleteMessage`. In production, a PostgreSQL implementation satisfies this interface. In tests, a mock satisfies it." That explanation demonstrates you understand dependency inversion.

Parameterized queries (using `$1`, `$2` placeholders in PostgreSQL) are the only acceptable way to write SQL in production code. Concatenating user input into a query string is a SQL injection vulnerability. Be ready to demonstrate this habit in any code review scenario.

### Senior @ FAANG: Storage Layer as a Performance Boundary

At senior level, the storage layer is where most performance problems originate. N+1 queries (one query to fetch a list, then one query per item to fetch details) are the most common culprit. For a chat application: fetching 50 messages and then fetching the user record for each sender is an N+1 pattern. The fix is a JOIN or a batch `IN` query.

Connection pool sizing is a configuration decision that requires measurement. Too few connections cause request queuing. Too many connections exhaust the database's per-connection memory budget. The correct pool size is typically: (max database connections / number of application instances). For PostgreSQL on a machine with 16 GB RAM, 100-200 connections is a reasonable maximum before connection overhead degrades query performance.

Read replicas are the first horizontal scaling lever for read-heavy workloads. Message history fetches (users scrolling back in chat) are read operations that can be served from a replica without affecting write latency. The storage layer should support directing reads to replicas and writes to the primary. The ADR for read replica usage should document the acceptable replica lag (for a chat application, 1-2 seconds of staleness is usually acceptable for history reads but not for "did my message send" confirmation).

---
