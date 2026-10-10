## Post Service

The Post Service handles the core content of the social network: creating, reading, updating, and deleting posts. Each post can contain text, media attachments, hashtags, and mentions of other users. When a post is created, the service triggers several asynchronous side effects including fan-out to followers' feeds, notifications for mentioned users, and reply notifications. The service also enforces ownership checks so that only the author of a post can edit or delete it.

### Post Domain Model
The post model captures text content, media attachments, hashtags, and mentions. Each post tracks its author, creation timestamp, and engagement counts (likes, comments, shares).

```go
// internal/domain/post.go
package domain

import (
    "time"
    "github.com/google/uuid"
)

type Post struct {
    ID           uuid.UUID   `json:"id" db:"id"`
    UserID       uuid.UUID   `json:"user_id" db:"user_id"`
    Content      string      `json:"content" db:"content"`
    MediaURLs    []string    `json:"media_urls" db:"media_urls"`
    MediaTypes   []string    `json:"media_types" db:"media_types"`
    Hashtags     []string    `json:"hashtags" db:"hashtags"`
    Mentions     []uuid.UUID `json:"mentions" db:"mentions"`
    ReplyToID    *uuid.UUID  `json:"reply_to_id" db:"reply_to_id"`
    RepostOfID   *uuid.UUID  `json:"repost_of_id" db:"repost_of_id"`
    Visibility   string      `json:"visibility" db:"visibility"`
    LikeCount    int         `json:"like_count" db:"like_count"`
    CommentCount int         `json:"comment_count" db:"comment_count"`
    RepostCount  int         `json:"repost_count" db:"repost_count"`
    ViewCount    int         `json:"view_count" db:"view_count"`
    CreatedAt    time.Time   `json:"created_at" db:"created_at"`
    UpdatedAt    time.Time   `json:"updated_at" db:"updated_at"`
    DeletedAt    *time.Time  `json:"deleted_at" db:"deleted_at"`

    // Joined fields
    Author *PublicUser `json:"author,omitempty" db:"-"`
    IsLiked bool       `json:"is_liked,omitempty" db:"-"`
}

type CreatePostRequest struct {
    Content    string      `json:"content" validate:"omitempty,max=280"`
    MediaURLs  []string    `json:"media_urls" validate:"omitempty,max=4,dive,url"`
    ReplyToID  *uuid.UUID  `json:"reply_to_id"`
    RepostOfID *uuid.UUID  `json:"repost_of_id"`
    Visibility string      `json:"visibility" validate:"omitempty,oneof=public followers private"`
}

type UpdatePostRequest struct {
    Content string `json:"content" validate:"required,max=280"`
}

type PostLike struct {
    ID        uuid.UUID `json:"id" db:"id"`
    PostID    uuid.UUID `json:"post_id" db:"post_id"`
    UserID    uuid.UUID `json:"user_id" db:"user_id"`
    CreatedAt time.Time `json:"created_at" db:"created_at"`
}
```

(Due to length constraints, I'll continue with the Post Service implementation, Feed System, Notification Service, Media Service, and remaining sections. The content follows the same production-ready pattern shown above.)

### Post Repository Implementation

The post repository handles all database operations for posts, including creating, reading, updating, deleting, and managing likes. It automatically extracts hashtags and mentions from post content using regular expressions during creation. Like and unlike operations use database transactions to ensure that the like record and the counter update happen atomically, preventing inconsistencies where a like exists but the count is wrong.

```go
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
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/domain/repository"
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
```

### Post Service Implementation

The Post Service orchestrates the full lifecycle of a post. When a new post is created, it triggers several asynchronous side effects: the feed service fans out the post to all followers, mentioned users receive notifications, and reply notifications are sent to the original post author. These side effects run in goroutines so the user gets an immediate response without waiting for fan-out to complete.

```go
// internal/service/post.go
package service

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/domain/repository"
    "go.uber.org/zap"
)

type PostService struct {
    postRepo repository.PostRepository
    userRepo repository.UserRepository
    feedService *FeedService
    notifService *NotificationService
    logger   *zap.Logger
}

func NewPostService(
    postRepo repository.PostRepository,
    userRepo repository.UserRepository,
    feedService *FeedService,
    notifService *NotificationService,
    logger *zap.Logger,
) *PostService {
    return &PostService{
        postRepo: postRepo,
        userRepo: userRepo,
        feedService: feedService,
        notifService: notifService,
        logger:   logger,
    }
}

func (s *PostService) CreatePost(ctx context.Context, userID uuid.UUID, req *domain.CreatePostRequest) (*domain.Post, error) {
    // Validate that at least one field is provided
    if req.Content == "" && len(req.MediaURLs) == 0 && req.RepostOfID == nil {
        return nil, fmt.Errorf("post must have content, media, or be a repost")
    }

    // Create post
    post := &domain.Post{
        ID:         uuid.New(),
        UserID:     userID,
        Content:    req.Content,
        MediaURLs:  req.MediaURLs,
        ReplyToID:  req.ReplyToID,
        RepostOfID: req.RepostOfID,
        Visibility: req.Visibility,
    }

    if post.Visibility == "" {
        post.Visibility = "public"
    }

    if err := s.postRepo.Create(ctx, post); err != nil {
        return nil, fmt.Errorf("create post: %w", err)
    }

    // Increment user post count
    if err := s.userRepo.IncrementPostCount(ctx, userID, 1); err != nil {
        s.logger.Error("failed to increment post count", zap.Error(err))
    }

    // Fan-out to followers' feeds (async)
    go func() {
        ctx := context.Background()
        if err := s.feedService.FanOutPost(ctx, post); err != nil {
            s.logger.Error("failed to fan out post",
                zap.String("post_id", post.ID.String()),
                zap.Error(err),
            )
        }
    }()

    // Send notifications for mentions (async)
    if len(post.Mentions) > 0 {
        go func() {
            ctx := context.Background()
            for _, mentionedUserID := range post.Mentions {
                _ = s.notifService.CreateNotification(ctx, &domain.Notification{
                    UserID:     mentionedUserID,
                    ActorID:    &userID,
                    Type:       "mention",
                    EntityType: "post",
                    EntityID:   &post.ID,
                })
            }
        }()
    }

    // Handle reply notifications
    if post.ReplyToID != nil {
        go func() {
            ctx := context.Background()
            originalPost, err := s.postRepo.GetByID(ctx, *post.ReplyToID)
            if err == nil && originalPost.UserID != userID {
                _ = s.notifService.CreateNotification(ctx, &domain.Notification{
                    UserID:     originalPost.UserID,
                    ActorID:    &userID,
                    Type:       "reply",
                    EntityType: "post",
                    EntityID:   &post.ID,
                })
            }
        }()
    }

    s.logger.Info("post created",
        zap.String("post_id", post.ID.String()),
        zap.String("user_id", userID.String()),
    )

    return post, nil
}

func (s *PostService) GetPost(ctx context.Context, postID uuid.UUID, viewerID *uuid.UUID) (*domain.Post, error) {
    post, err := s.postRepo.GetByID(ctx, postID)
    if err != nil {
        return nil, err
    }

    // Get author information
    author, err := s.userRepo.GetByID(ctx, post.UserID)
    if err == nil {
        post.Author = author.Public()
    }

    // Check if viewer has liked the post
    if viewerID != nil {
        isLiked, err := s.postRepo.IsLiked(ctx, postID, *viewerID)
        if err == nil {
            post.IsLiked = isLiked
        }
    }

    return post, nil
}

func (s *PostService) GetUserPosts(ctx context.Context, userID uuid.UUID, limit, offset int) ([]*domain.Post, error) {
    if limit <= 0 || limit > 50 {
        limit = 20
    }

    posts, err := s.postRepo.GetByUserID(ctx, userID, limit, offset)
    if err != nil {
        return nil, err
    }

    // Hydrate with author info
    if len(posts) > 0 {
        author, err := s.userRepo.GetByID(ctx, userID)
        if err == nil {
            publicAuthor := author.Public()
            for _, post := range posts {
                post.Author = publicAuthor
            }
        }
    }

    return posts, nil
}

func (s *PostService) UpdatePost(ctx context.Context, postID, userID uuid.UUID, req *domain.UpdatePostRequest) (*domain.Post, error) {
    post, err := s.postRepo.GetByID(ctx, postID)
    if err != nil {
        return nil, err
    }

    // Check ownership
    if post.UserID != userID {
        return nil, fmt.Errorf("unauthorized: not post owner")
    }

    post.Content = req.Content

    if err := s.postRepo.Update(ctx, post); err != nil {
        return nil, fmt.Errorf("update post: %w", err)
    }

    s.logger.Info("post updated",
        zap.String("post_id", postID.String()),
    )

    return post, nil
}

func (s *PostService) DeletePost(ctx context.Context, postID, userID uuid.UUID) error {
    post, err := s.postRepo.GetByID(ctx, postID)
    if err != nil {
        return err
    }

    // Check ownership
    if post.UserID != userID {
        return fmt.Errorf("unauthorized: not post owner")
    }

    if err := s.postRepo.Delete(ctx, postID); err != nil {
        return fmt.Errorf("delete post: %w", err)
    }

    // Decrement user post count
    if err := s.userRepo.IncrementPostCount(ctx, userID, -1); err != nil {
        s.logger.Error("failed to decrement post count", zap.Error(err))
    }

    s.logger.Info("post deleted",
        zap.String("post_id", postID.String()),
    )

    return nil
}

func (s *PostService) LikePost(ctx context.Context, postID, userID uuid.UUID) error {
    // Get post to find author
    post, err := s.postRepo.GetByID(ctx, postID)
    if err != nil {
        return err
    }

    if err := s.postRepo.LikePost(ctx, postID, userID); err != nil {
        return fmt.Errorf("like post: %w", err)
    }

    // Send notification to post author (if not self-like)
    if post.UserID != userID {
        go func() {
            ctx := context.Background()
            _ = s.notifService.CreateNotification(ctx, &domain.Notification{
                UserID:     post.UserID,
                ActorID:    &userID,
                Type:       "like",
                EntityType: "post",
                EntityID:   &postID,
            })
        }()
    }

    s.logger.Info("post liked",
        zap.String("post_id", postID.String()),
        zap.String("user_id", userID.String()),
    )

    return nil
}

func (s *PostService) UnlikePost(ctx context.Context, postID, userID uuid.UUID) error {
    if err := s.postRepo.UnlikePost(ctx, postID, userID); err != nil {
        return fmt.Errorf("unlike post: %w", err)
    }

    s.logger.Info("post unliked",
        zap.String("post_id", postID.String()),
        zap.String("user_id", userID.String()),
    )

    return nil
}

func (s *PostService) GetPostLikes(ctx context.Context, postID uuid.UUID, limit, offset int) ([]*domain.PublicUser, error) {
    userIDs, err := s.postRepo.GetLikes(ctx, postID, limit, offset)
    if err != nil {
        return nil, err
    }

    if len(userIDs) == 0 {
        return []*domain.PublicUser{}, nil
    }

    users, err := s.userRepo.GetByIDs(ctx, userIDs)
    if err != nil {
        return nil, err
    }

    publicUsers := make([]*domain.PublicUser, len(users))
    for i, user := range users {
        publicUsers[i] = user.Public()
    }

    return publicUsers, nil
}
```

### Junior → FAANG: Content Service as a Write-Heavy Workload

The Post Service handles the core content creation workload: user posts, likes, comments, shares. Content creation (write path) and content retrieval (read path) have different performance characteristics and should be optimized independently.

For the write path, the most important correctness property is atomicity: when a user creates a post, the post must be stored in PostgreSQL (durable), the hashtags must be indexed in Elasticsearch (searchable), and the fan-out event must be published (for feed generation). If any step fails, the whole operation should either roll back or retry. The transactional outbox pattern (write the event to an outbox table in the same database transaction as the post) ensures at-least-once delivery without distributed transactions.

Ownership checks (only the author can edit or delete their post) must be enforced at the service layer, not just at the API layer. If the Post Service exposes a gRPC API for other services, each internal call must also enforce ownership, because a bug in the caller could bypass API-level checks.

### Senior @ FAANG: Content at Scale and Its Consistency Challenges

At senior level, a post in a social network is not a simple record: it is a distributed object with replicated state across multiple systems (PostgreSQL for durability, Elasticsearch for search, Redis cache for hot reads, CDN for media). The consistency of this distributed object is an ongoing concern.

Media attachment handling is particularly complex. A post with an attached video reference that points to a non-existent video object (because the video upload failed after the post was created) is a consistency violation that users experience as a broken link. Preventing this requires either two-phase write (upload video first, get a confirmed URL, then create the post with the confirmed URL) or deferred media processing (create post with a placeholder, process and link the media asynchronously).

Post deletion (GDPR right-to-erasure) for viral posts is expensive: a post that has been retweeted/shared by millions of users generates millions of references to the original post ID. Deleting the original post requires cascading through all of those references. Real-time cascading deletion is impractical at scale. The production approach is reference-based deletion: mark the post as deleted, serve a "post not found" response when the post ID is requested, and clean up database references in a background job over days or weeks.

---
