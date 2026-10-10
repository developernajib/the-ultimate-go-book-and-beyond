// internal/service/feed.go
package service

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/redis/go-redis/v9"
    "github.com/example/social-network/internal/domain"
    "github.com/example/social-network/internal/domain/repository"
    "go.uber.org/zap"
)

const (
    feedCacheKeyPrefix = "feed:"
    feedCacheTTL       = 5 * time.Minute
    maxFeedSize        = 1000 // Keep only recent 1000 posts in feed
)

type FeedService struct {
    feedRepo   repository.FeedRepository
    postRepo   repository.PostRepository
    userRepo   repository.UserRepository
    followRepo repository.FollowRepository
    redis      *redis.Client
    logger     *zap.Logger
}

func NewFeedService(
    feedRepo repository.FeedRepository,
    postRepo repository.PostRepository,
    userRepo repository.UserRepository,
    followRepo repository.FollowRepository,
    redisClient *redis.Client,
    logger *zap.Logger,
) *FeedService {
    return &FeedService{
        feedRepo:   feedRepo,
        postRepo:   postRepo,
        userRepo:   userRepo,
        followRepo: followRepo,
        redis:      redisClient,
        logger:     logger,
    }
}

// FanOutPost distributes a new post to all followers' feeds
func (s *FeedService) FanOutPost(ctx context.Context, post *domain.Post) error {
    // Get all followers
    followerIDs, err := s.followRepo.GetFollowerIDs(ctx, post.UserID)
    if err != nil {
        return fmt.Errorf("get followers: %w", err)
    }

    s.logger.Info("fanning out post",
        zap.String("post_id", post.ID.String()),
        zap.Int("followers", len(followerIDs)),
    )

    // If user has too many followers (celebrity), use fan-out on read instead
    if len(followerIDs) > 10000 {
        s.logger.Info("skipping fan-out for celebrity user",
            zap.String("user_id", post.UserID.String()),
            zap.Int("follower_count", len(followerIDs)),
        )
        return nil
    }

    // Calculate rank score (simple version: recency-based)
    rankScore := float64(time.Now().Unix())

    // Create feed entries for all followers
    entries := make([]*domain.FeedEntry, len(followerIDs))
    for i, followerID := range followerIDs {
        entries[i] = &domain.FeedEntry{
            ID:           uuid.New(),
            UserID:       followerID,
            PostID:       post.ID,
            PostAuthorID: post.UserID,
            RankScore:    rankScore,
        }
    }

    // Batch insert into database
    if err := s.feedRepo.CreateBatch(ctx, entries); err != nil {
        return fmt.Errorf("create feed entries: %w", err)
    }

    // Invalidate Redis cache for affected users
    go func() {
        ctx := context.Background()
        for _, followerID := range followerIDs {
            cacheKey := feedCacheKey(followerID)
            s.redis.Del(ctx, cacheKey)
        }
    }()

    s.logger.Info("post fanned out successfully",
        zap.String("post_id", post.ID.String()),
        zap.Int("entries_created", len(entries)),
    )

    return nil
}

// GetFeed returns a user's personalized feed with pagination
func (s *FeedService) GetFeed(ctx context.Context, userID uuid.UUID, limit int, cursor *string) (*domain.Feed, error) {
    if limit <= 0 || limit > 100 {
        limit = 20
    }

    // Try to get from Redis cache first
    cacheKey := feedCacheKey(userID)
    if cursor == nil { // Only cache first page
        if cachedFeed, err := s.getFeedFromCache(ctx, cacheKey); err == nil {
            s.logger.Debug("feed cache hit", zap.String("user_id", userID.String()))
            return cachedFeed, nil
        }
    }

    // Get from database
    var offset int
    if cursor != nil {
        fmt.Sscanf(*cursor, "%d", &offset)
    }

    entries, err := s.feedRepo.GetByUserID(ctx, userID, limit+1, offset)
    if err != nil {
        return nil, fmt.Errorf("get feed entries: %w", err)
    }

    // Check if there are more results
    hasMore := len(entries) > limit
    if hasMore {
        entries = entries[:limit]
    }

    // Hydrate entries with posts
    if err := s.hydrateFeedEntries(ctx, entries); err != nil {
        return nil, fmt.Errorf("hydrate feed: %w", err)
    }

    // Calculate next cursor
    var nextCursor *string
    if hasMore {
        nextOffset := offset + limit
        cursorStr := fmt.Sprintf("%d", nextOffset)
        nextCursor = &cursorStr
    }

    feed := &domain.Feed{
        Entries:    entries,
        NextCursor: nextCursor,
        HasMore:    hasMore,
    }

    // Cache first page
    if cursor == nil {
        go s.cacheFeed(context.Background(), cacheKey, feed)
    }

    return feed, nil
}

// GetHomeTimeline returns chronological timeline (alternative to ranked feed)
func (s *FeedService) GetHomeTimeline(ctx context.Context, userID uuid.UUID, limit int, beforeID *uuid.UUID) ([]*domain.Post, error) {
    // Get users the current user is following
    followingIDs, err := s.followRepo.GetFollowingIDs(ctx, userID)
    if err != nil {
        return nil, fmt.Errorf("get following: %w", err)
    }

    // Add user's own ID to see their own posts
    authorIDs := append(followingIDs, userID)

    // Get recent posts from followed users
    posts, err := s.postRepo.GetByAuthorIDs(ctx, authorIDs, limit, beforeID)
    if err != nil {
        return nil, fmt.Errorf("get timeline posts: %w", err)
    }

    return posts, nil
}

// hydrateFeedEntries loads full post data for feed entries
func (s *FeedService) hydrateFeedEntries(ctx context.Context, entries []*domain.FeedEntry) error {
    if len(entries) == 0 {
        return nil
    }

    // Collect unique post IDs and user IDs
    postIDs := make([]uuid.UUID, len(entries))
    userIDMap := make(map[uuid.UUID]bool)

    for i, entry := range entries {
        postIDs[i] = entry.PostID
        userIDMap[entry.PostAuthorID] = true
    }

    // Batch fetch posts
    posts, err := s.postRepo.GetByIDs(ctx, postIDs)
    if err != nil {
        return fmt.Errorf("get posts: %w", err)
    }

    // Create post map for easy lookup
    postMap := make(map[uuid.UUID]*domain.Post)
    for _, post := range posts {
        postMap[post.ID] = post
    }

    // Batch fetch users
    userIDs := make([]uuid.UUID, 0, len(userIDMap))
    for userID := range userIDMap {
        userIDs = append(userIDs, userID)
    }

    users, err := s.userRepo.GetByIDs(ctx, userIDs)
    if err != nil {
        return fmt.Errorf("get users: %w", err)
    }

    // Create user map
    userMap := make(map[uuid.UUID]*domain.PublicUser)
    for _, user := range users {
        userMap[user.ID] = user.Public()
    }

    // Attach posts and authors to entries
    for _, entry := range entries {
        if post, ok := postMap[entry.PostID]; ok {
            entry.Post = post
            if author, ok := userMap[post.UserID]; ok {
                post.Author = author
            }
        }
    }

    return nil
}

func feedCacheKey(userID uuid.UUID) string {
    return fmt.Sprintf("%s%s", feedCacheKeyPrefix, userID.String())
}

func (s *FeedService) getFeedFromCache(ctx context.Context, key string) (*domain.Feed, error) {
    data, err := s.redis.Get(ctx, key).Bytes()
    if err != nil {
        return nil, err
    }

    var feed domain.Feed
    if err := json.Unmarshal(data, &feed); err != nil {
        return nil, err
    }

    return &feed, nil
}

func (s *FeedService) cacheFeed(ctx context.Context, key string, feed *domain.Feed) {
    data, err := json.Marshal(feed)
    if err != nil {
        s.logger.Error("failed to marshal feed for cache", zap.Error(err))
        return
    }

    if err := s.redis.Set(ctx, key, data, feedCacheTTL).Err(); err != nil {
        s.logger.Error("failed to cache feed", zap.Error(err))
    }
}
