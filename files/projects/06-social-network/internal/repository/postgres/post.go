// internal/repository/postgres/post.go
package postgres

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "strings"
    "regexp"

    "github.com/google/uuid"
    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/domain/repository"
)

type postRepository struct {
    db *sqlx.DB
}

func NewPostRepository(db *sqlx.DB) repository.PostRepository {
    return &postRepository{db: db}
}

var (
    hashtagRegex = regexp.MustCompile(`#(\w+)`)
    mentionRegex = regexp.MustCompile(`@(\w+)`)
)

func (r *postRepository) Create(ctx context.Context, post *domain.Post) error {
    // Extract hashtags and mentions from content
    post.Hashtags = extractHashtags(post.Content)
    mentions, err := r.extractMentions(ctx, post.Content)
    if err != nil {
        return fmt.Errorf("extract mentions: %w", err)
    }
    post.Mentions = mentions

    query := `
        INSERT INTO posts (
            id, user_id, content, media_urls, media_types,
            hashtags, mentions, reply_to_id, repost_of_id, visibility
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        ) RETURNING created_at, updated_at
    `

    return r.db.QueryRowContext(
        ctx, query,
        post.ID, post.UserID, post.Content,
        post.MediaURLs, post.MediaTypes,
        post.Hashtags, post.Mentions,
        post.ReplyToID, post.RepostOfID, post.Visibility,
    ).Scan(&post.CreatedAt, &post.UpdatedAt)
}

func (r *postRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Post, error) {
    var post domain.Post
    query := `
        SELECT id, user_id, content, media_urls, media_types,
               hashtags, mentions, reply_to_id, repost_of_id,
               visibility, like_count, comment_count, repost_count,
               view_count, created_at, updated_at, deleted_at
        FROM posts
        WHERE id = $1 AND deleted_at IS NULL
    `

    err := r.db.GetContext(ctx, &post, query, id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrPostNotFound
        }
        return nil, fmt.Errorf("get post by id: %w", err)
    }

    return &post, nil
}

func (r *postRepository) GetByUserID(ctx context.Context, userID uuid.UUID, limit, offset int) ([]*domain.Post, error) {
    query := `
        SELECT id, user_id, content, media_urls, media_types,
               hashtags, mentions, reply_to_id, repost_of_id,
               visibility, like_count, comment_count, repost_count,
               view_count, created_at, updated_at
        FROM posts
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `

    var posts []*domain.Post
    err := r.db.SelectContext(ctx, &posts, query, userID, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("get posts by user id: %w", err)
    }

    return posts, nil
}

func (r *postRepository) Update(ctx context.Context, post *domain.Post) error {
    query := `
        UPDATE posts
        SET content = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL
    `

    result, err := r.db.ExecContext(ctx, query, post.Content, post.ID)
    if err != nil {
        return fmt.Errorf("update post: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return domain.ErrPostNotFound
    }

    return nil
}

func (r *postRepository) Delete(ctx context.Context, id uuid.UUID) error {
    query := `UPDATE posts SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`

    result, err := r.db.ExecContext(ctx, query, id)
    if err != nil {
        return fmt.Errorf("delete post: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return domain.ErrPostNotFound
    }

    return nil
}

func (r *postRepository) LikePost(ctx context.Context, postID, userID uuid.UUID) error {
    tx, err := r.db.BeginTxx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback()

    // Insert like
    likeQuery := `
        INSERT INTO post_likes (id, post_id, user_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (post_id, user_id) DO NOTHING
    `

    result, err := tx.ExecContext(ctx, likeQuery, uuid.New(), postID, userID)
    if err != nil {
        return fmt.Errorf("insert like: %w", err)
    }

    rows, _ := result.RowsAffected()
    if rows == 0 {
        // Already liked
        return nil
    }

    // Increment like count
    countQuery := `SELECT increment_post_likes($1, $2)`
    if _, err := tx.ExecContext(ctx, countQuery, postID, 1); err != nil {
        return fmt.Errorf("increment like count: %w", err)
    }

    return tx.Commit()
}

func (r *postRepository) UnlikePost(ctx context.Context, postID, userID uuid.UUID) error {
    tx, err := r.db.BeginTxx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback()

    // Delete like
    likeQuery := `DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2`

    result, err := tx.ExecContext(ctx, likeQuery, postID, userID)
    if err != nil {
        return fmt.Errorf("delete like: %w", err)
    }

    rows, _ := result.RowsAffected()
    if rows == 0 {
        // Not liked
        return nil
    }

    // Decrement like count
    countQuery := `SELECT increment_post_likes($1, $2)`
    if _, err := tx.ExecContext(ctx, countQuery, postID, -1); err != nil {
        return fmt.Errorf("decrement like count: %w", err)
    }

    return tx.Commit()
}

func (r *postRepository) IsLiked(ctx context.Context, postID, userID uuid.UUID) (bool, error) {
    var exists bool
    query := `SELECT EXISTS(SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2)`
    err := r.db.GetContext(ctx, &exists, query, postID, userID)
    return exists, err
}

func (r *postRepository) GetLikes(ctx context.Context, postID uuid.UUID, limit, offset int) ([]uuid.UUID, error) {
    query := `
        SELECT user_id
        FROM post_likes
        WHERE post_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `

    var userIDs []uuid.UUID
    err := r.db.SelectContext(ctx, &userIDs, query, postID, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("get likes: %w", err)
    }

    return userIDs, nil
}

func extractHashtags(content string) []string {
    matches := hashtagRegex.FindAllStringSubmatch(content, -1)
    hashtags := make([]string, 0, len(matches))
    seen := make(map[string]bool)

    for _, match := range matches {
        tag := strings.ToLower(match[1])
        if !seen[tag] {
            hashtags = append(hashtags, tag)
            seen[tag] = true
        }
    }

    return hashtags
}

func (r *postRepository) extractMentions(ctx context.Context, content string) ([]uuid.UUID, error) {
    matches := mentionRegex.FindAllStringSubmatch(content, -1)
    if len(matches) == 0 {
        return []uuid.UUID{}, nil
    }

    usernames := make([]string, 0, len(matches))
    for _, match := range matches {
        usernames = append(usernames, match[1])
    }

    // Look up user IDs by username
    query := `SELECT id FROM users WHERE username = ANY($1) AND deleted_at IS NULL`

    var userIDs []uuid.UUID
    err := r.db.SelectContext(ctx, &userIDs, query, usernames)
    if err != nil {
        return nil, fmt.Errorf("get mentioned users: %w", err)
    }

    return userIDs, nil
}

func (r *postRepository) GetByIDs(ctx context.Context, ids []uuid.UUID) ([]*domain.Post, error) {
    if len(ids) == 0 {
        return nil, nil
    }
    query := `SELECT * FROM posts WHERE id = ANY($1) AND deleted_at IS NULL`
    var posts []*domain.Post
    if err := r.db.SelectContext(ctx, &posts, query, ids); err != nil {
        return nil, fmt.Errorf("get posts by ids: %w", err)
    }
    return posts, nil
}

func (r *postRepository) GetByAuthorIDs(ctx context.Context, authorIDs []uuid.UUID, limit int, beforeID *uuid.UUID) ([]*domain.Post, error) {
    if len(authorIDs) == 0 {
        return nil, nil
    }
    var posts []*domain.Post
    var err error
    if beforeID != nil {
        query := `SELECT * FROM posts WHERE user_id = ANY($1) AND id < $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $3`
        err = r.db.SelectContext(ctx, &posts, query, authorIDs, *beforeID, limit)
    } else {
        query := `SELECT * FROM posts WHERE user_id = ANY($1) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2`
        err = r.db.SelectContext(ctx, &posts, query, authorIDs, limit)
    }
    if err != nil {
        return nil, fmt.Errorf("get posts by author ids: %w", err)
    }
    return posts, nil
}
