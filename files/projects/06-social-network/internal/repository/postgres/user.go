// internal/repository/postgres/user.go
package postgres

import (
    "context"
    "database/sql"
    "errors"
    "fmt"

    "github.com/google/uuid"
    "github.com/jmoiron/sqlx"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/domain/repository"
)

type userRepository struct {
    db *sqlx.DB
}

func NewUserRepository(db *sqlx.DB) repository.UserRepository {
    return &userRepository{db: db}
}

func (r *userRepository) Create(ctx context.Context, user *domain.User) error {
    query := `
        INSERT INTO users (
            id, username, email, password_hash, display_name,
            bio, birth_date, is_private
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8
        ) RETURNING created_at, updated_at
    `

    return r.db.QueryRowContext(
        ctx, query,
        user.ID, user.Username, user.Email, user.PasswordHash,
        user.DisplayName, user.Bio, user.BirthDate, user.IsPrivate,
    ).Scan(&user.CreatedAt, &user.UpdatedAt)
}

func (r *userRepository) CreateSettings(ctx context.Context, settings *domain.UserSettings) error {
    query := `
        INSERT INTO user_settings (
            user_id, privacy_level, allow_mentions, allow_dms,
            show_activity, email_notifications, push_notifications,
            language, timezone, theme
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        ) RETURNING created_at, updated_at
    `

    return r.db.QueryRowContext(
        ctx, query,
        settings.UserID, settings.PrivacyLevel, settings.AllowMentions,
        settings.AllowDMs, settings.ShowActivity, settings.EmailNotifications,
        settings.PushNotifications, settings.Language, settings.Timezone,
        settings.Theme,
    ).Scan(&settings.CreatedAt, &settings.UpdatedAt)
}

func (r *userRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
    var user domain.User
    query := `
        SELECT id, username, email, password_hash, display_name,
               bio, avatar_url, cover_url, location, website, birth_date,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at, updated_at, last_seen_at, deleted_at
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
    `

    err := r.db.GetContext(ctx, &user, query, id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrUserNotFound
        }
        return nil, fmt.Errorf("get user by id: %w", err)
    }

    return &user, nil
}

func (r *userRepository) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
    var user domain.User
    query := `
        SELECT id, username, email, password_hash, display_name,
               bio, avatar_url, cover_url, location, website, birth_date,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at, updated_at, last_seen_at, deleted_at
        FROM users
        WHERE username = $1 AND deleted_at IS NULL
    `

    err := r.db.GetContext(ctx, &user, query, username)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrUserNotFound
        }
        return nil, fmt.Errorf("get user by username: %w", err)
    }

    return &user, nil
}

func (r *userRepository) GetByEmail(ctx context.Context, email string) (*domain.User, error) {
    var user domain.User
    query := `
        SELECT id, username, email, password_hash, display_name,
               bio, avatar_url, cover_url, location, website, birth_date,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at, updated_at, last_seen_at, deleted_at
        FROM users
        WHERE email = $1 AND deleted_at IS NULL
    `

    err := r.db.GetContext(ctx, &user, query, email)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrUserNotFound
        }
        return nil, fmt.Errorf("get user by email: %w", err)
    }

    return &user, nil
}

func (r *userRepository) GetByIDs(ctx context.Context, ids []uuid.UUID) ([]*domain.User, error) {
    if len(ids) == 0 {
        return []*domain.User{}, nil
    }

    query := `
        SELECT id, username, email, password_hash, display_name,
               bio, avatar_url, cover_url, location, website, birth_date,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at, updated_at, last_seen_at, deleted_at
        FROM users
        WHERE id = ANY($1) AND deleted_at IS NULL
    `

    var users []*domain.User
    err := r.db.SelectContext(ctx, &users, query, ids)
    if err != nil {
        return nil, fmt.Errorf("get users by ids: %w", err)
    }

    return users, nil
}

func (r *userRepository) GetSettings(ctx context.Context, userID uuid.UUID) (*domain.UserSettings, error) {
    var settings domain.UserSettings
    query := `
        SELECT user_id, privacy_level, allow_mentions, allow_dms,
               show_activity, email_notifications, push_notifications,
               language, timezone, theme, created_at, updated_at
        FROM user_settings
        WHERE user_id = $1
    `

    err := r.db.GetContext(ctx, &settings, query, userID)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrSettingsNotFound
        }
        return nil, fmt.Errorf("get user settings: %w", err)
    }

    return &settings, nil
}

func (r *userRepository) Update(ctx context.Context, user *domain.User) error {
    query := `
        UPDATE users
        SET display_name = $1, bio = $2, location = $3, website = $4,
            avatar_url = $5, cover_url = $6, is_private = $7
        WHERE id = $8 AND deleted_at IS NULL
    `

    result, err := r.db.ExecContext(
        ctx, query,
        user.DisplayName, user.Bio, user.Location, user.Website,
        user.AvatarURL, user.CoverURL, user.IsPrivate, user.ID,
    )
    if err != nil {
        return fmt.Errorf("update user: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return domain.ErrUserNotFound
    }

    return nil
}

func (r *userRepository) UpdateSettings(ctx context.Context, settings *domain.UserSettings) error {
    query := `
        UPDATE user_settings
        SET privacy_level = $1, allow_mentions = $2, allow_dms = $3,
            show_activity = $4, email_notifications = $5, push_notifications = $6,
            language = $7, timezone = $8, theme = $9
        WHERE user_id = $10
    `

    result, err := r.db.ExecContext(
        ctx, query,
        settings.PrivacyLevel, settings.AllowMentions, settings.AllowDMs,
        settings.ShowActivity, settings.EmailNotifications, settings.PushNotifications,
        settings.Language, settings.Timezone, settings.Theme, settings.UserID,
    )
    if err != nil {
        return fmt.Errorf("update user settings: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return domain.ErrSettingsNotFound
    }

    return nil
}

func (r *userRepository) UpdateLastSeen(ctx context.Context, userID uuid.UUID) error {
    query := `UPDATE users SET last_seen_at = NOW() WHERE id = $1`
    _, err := r.db.ExecContext(ctx, query, userID)
    return err
}

func (r *userRepository) IncrementFollowerCount(ctx context.Context, userID uuid.UUID, delta int) error {
    query := `SELECT increment_user_followers($1, $2)`
    _, err := r.db.ExecContext(ctx, query, userID, delta)
    return err
}

func (r *userRepository) IncrementFollowingCount(ctx context.Context, userID uuid.UUID, delta int) error {
    query := `SELECT increment_user_following($1, $2)`
    _, err := r.db.ExecContext(ctx, query, userID, delta)
    return err
}

func (r *userRepository) IncrementPostCount(ctx context.Context, userID uuid.UUID, delta int) error {
    query := `UPDATE users SET post_count = post_count + $1 WHERE id = $2`
    _, err := r.db.ExecContext(ctx, query, delta, userID)
    return err
}

func (r *userRepository) Delete(ctx context.Context, id uuid.UUID) error {
    query := `UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`

    result, err := r.db.ExecContext(ctx, query, id)
    if err != nil {
        return fmt.Errorf("delete user: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return domain.ErrUserNotFound
    }

    return nil
}

func (r *userRepository) Search(ctx context.Context, query string, limit, offset int) ([]*domain.User, error) {
    sqlQuery := `
        SELECT id, username, display_name, bio, avatar_url,
               is_verified, is_private, follower_count, following_count,
               post_count, created_at
        FROM users
        WHERE deleted_at IS NULL
          AND (username ILIKE $1 OR display_name ILIKE $1)
        ORDER BY follower_count DESC, created_at DESC
        LIMIT $2 OFFSET $3
    `

    var users []*domain.User
    searchPattern := "%" + query + "%"
    err := r.db.SelectContext(ctx, &users, sqlQuery, searchPattern, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("search users: %w", err)
    }

    return users, nil
}

func (r *userRepository) UsernameExists(ctx context.Context, username string) (bool, error) {
    var exists bool
    query := `SELECT EXISTS(SELECT 1 FROM users WHERE username = $1 AND deleted_at IS NULL)`
    err := r.db.GetContext(ctx, &exists, query, username)
    return exists, err
}

func (r *userRepository) EmailExists(ctx context.Context, email string) (bool, error) {
    var exists bool
    query := `SELECT EXISTS(SELECT 1 FROM users WHERE email = $1 AND deleted_at IS NULL)`
    err := r.db.GetContext(ctx, &exists, query, email)
    return exists, err
}
