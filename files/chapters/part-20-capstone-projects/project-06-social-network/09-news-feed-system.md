## News Feed System

### Feed Architecture Decision: Fan-Out on Write

For a Twitter-like social network, we'll use **Fan-Out on Write** (push model) for most users, with a hybrid approach for celebrities.

#### Why Fan-Out on Write?

1. **Faster reads**: Feed is pre-computed, just read from cache/DB
2. **Consistent experience**: All users see updates quickly
3. **Simpler ranking**: Can compute rank scores during fan-out

#### Trade-offs

| Aspect | Fan-Out on Write | Fan-Out on Read |
|--------|------------------|-----------------|
| Read Speed | Very Fast (pre-computed) | Slower (compute on demand) |
| Write Speed | Slower (write to many feeds) | Fast (write to one place) |
| Storage | Higher (duplicate posts) | Lower (single copy) |
| Best For | Most users | Celebrities (millions of followers) |

### Feed Domain Model

The feed model represents a materialized timeline entry. Each `FeedItem` stores the post ID, author, a relevance score, and the timestamp used for cursor-based pagination.

```go
// internal/domain/feed.go
package domain

import (
    "time"
    "github.com/google/uuid"
)

type FeedEntry struct {
    ID           uuid.UUID `json:"id" db:"id"`
    UserID       uuid.UUID `json:"user_id" db:"user_id"`
    PostID       uuid.UUID `json:"post_id" db:"post_id"`
    PostAuthorID uuid.UUID `json:"post_author_id" db:"post_author_id"`
    RankScore    float64   `json:"rank_score" db:"rank_score"`
    CreatedAt    time.Time `json:"created_at" db:"created_at"`

    // Hydrated post
    Post *Post `json:"post,omitempty" db:"-"`
}

type Feed struct {
    Entries    []*FeedEntry `json:"entries"`
    NextCursor *string      `json:"next_cursor,omitempty"`
    HasMore    bool         `json:"has_more"`
}
```

### Feed Service with Redis Cache

The Feed Service is the heart of the social network experience. It writes pre-computed feed entries for each follower when a post is created (fan-out on write), and caches the first page of every user's feed in Redis for ultra-fast retrieval. For celebrity users with more than 10,000 followers, the service skips fan-out on write to avoid overwhelming the database, and instead merges their posts at read time. Pagination uses cursor-based offsets so that users can scroll through their feed without missing or duplicating posts.

```go
// internal/service/feed.go
package service

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/redis/go-redis/v9"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/domain/repository"
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
```

### Advanced Feed Ranking Algorithm

Instead of showing posts in simple chronological order, the feed ranker scores each post based on a combination of engagement metrics and recency. Posts with more comments and reposts rank higher than those with only likes, because deeper engagement signals more interesting content. Time decay ensures that even highly engaged posts eventually drop off the feed, keeping the content fresh. This is a simplified version of the ranking algorithms used by platforms like Twitter and Facebook.

```go
// internal/service/feed_ranker.go
package service

import (
    "math"
    "time"

    "github.com/yourname/socialnet/internal/domain"
)

// FeedRanker calculates relevance scores for posts
type FeedRanker struct{}

func NewFeedRanker() *FeedRanker {
    return &FeedRanker{}
}

// CalculateScore uses a hybrid of engagement and recency
// Similar to Twitter's ranking algorithm
func (r *FeedRanker) CalculateScore(post *domain.Post, viewerID uuid.UUID) float64 {
    // Time decay (older posts score lower)
    age := time.Since(post.CreatedAt).Hours()
    timeDecay := 1.0 / math.Pow(age+2, 1.5)

    // Engagement score
    engagementScore := float64(post.LikeCount)*1.0 +
        float64(post.CommentCount)*2.0 + // Comments worth more than likes
        float64(post.RepostCount)*3.0 + // Reposts worth most
        float64(post.ViewCount)*0.01 // Views worth least

    // Combine scores
    // Weight: 70% engagement, 30% recency
    finalScore := (engagementScore * 0.7) + (timeDecay * 100 * 0.3)

    return finalScore
}

// RankPosts sorts posts by relevance
func (r *FeedRanker) RankPosts(posts []*domain.Post, viewerID uuid.UUID) []*domain.Post {
    // Calculate scores
    type scoredPost struct {
        post  *domain.Post
        score float64
    }

    scored := make([]scoredPost, len(posts))
    for i, post := range posts {
        scored[i] = scoredPost{
            post:  post,
            score: r.CalculateScore(post, viewerID),
        }
    }

    // Sort by score (descending)
    for i := 0; i < len(scored); i++ {
        for j := i + 1; j < len(scored); j++ {
            if scored[j].score > scored[i].score {
                scored[i], scored[j] = scored[j], scored[i]
            }
        }
    }

    // Extract sorted posts
    ranked := make([]*domain.Post, len(posts))
    for i, sp := range scored {
        ranked[i] = sp.post
    }

    return ranked
}
```

### Junior → FAANG: Fan-Out as the Core News Feed Design Decision

Fan-out on write (pre-compute each user's feed when a post is created) versus fan-out on read (build the feed on request) is the central news feed design question in FAANG interviews. Know both approaches, their tradeoffs, and the hybrid approach used at scale.

Fan-out on write: when user A (with 1000 followers) posts, write the post ID to each of 1000 followers' feed tables. Feed read is fast (just read the feed table). Write is expensive for high-follower-count users (a celebrity with 10M followers requires 10M feed table writes per post).

Fan-out on read: when user B loads their feed, fetch the post IDs from all users B follows, then fetch the posts and sort by time. Read is slow (N database queries where N is the number of accounts B follows). Write is instant (just save the post).

Hybrid: fan-out on write for non-celebrity accounts (followers less than 10,000), fan-out on read for celebrity accounts (followers greater than 10,000). This is Twitter's actual approach.

### Senior @ FAANG: News Feed as a Ranking and Personalization System

At senior level, the news feed is not just a chronological list of posts from followed accounts. It is a personalized, ranked feed that uses engagement signals (likes, comments, shares, dwell time) to prioritize content the user is likely to engage with. This ranking system is the core product differentiator for social networks.

The ranking model for news feed personalization is an ML system that consumes features from multiple sources: post metadata (creation time, author, hashtags), social graph features (relationship strength between author and viewer), engagement signals (historical engagement rate of this viewer with this author), and content features (predicted engagement given the viewer's history). Training this model, serving it at feed generation time, and continuously improving it requires a full ML platform.

Feed ranking A/B testing is the most important feedback loop for product improvement. The experiment must control for: which users see the new ranking (treatment group), how long they are in the experiment (must be long enough for statistical significance), and what metric is being optimized (not just click rate, but meaningful engagement like comments or reshares). Building the A/B testing infrastructure that feeds into the ranking model improvement cycle is a staff-level platform investment.

---
