## 64B.3 Twitter/X Timeline Architecture

Twitter processes hundreds of thousands of tweets per second and must assemble a personalized timeline for each user from the accounts they follow. The core challenge is fan-out: when a user posts a tweet, how does every follower see it in their timeline without introducing unacceptable latency or storage costs? Twitter's timeline and fan-out architecture was detailed by Raffi Krikorian (VP of Platform Engineering at Twitter) in *Timelines at Scale* (QCon SF 2012) and subsequent Twitter Engineering publications (*Real-time Delivery Architecture at Twitter*, 2014). The design pioneered the hybrid fan-out model to resolve the "celebrity problem" (or "Superbowl problem") within Redis-backed timeline caches.

### Fan-out Strategies

Twitter's timeline architecture faces the "celebrity problem": when a user with millions of followers tweets, pushing that tweet to every follower's timeline cache (fan-out on write) would require millions of cache writes in milliseconds. The solution is a hybrid model that uses fan-out on write for ordinary users but fan-out on read for high-follower accounts, ordinary user tweets are precomputed into follower timelines, while celebrity tweets are merged in at read time. This implementation demonstrates both strategies with a threshold-based switch that routes to the appropriate fan-out path based on follower count.

```go
// twitter/timeline.go
package twitter

import (
    "context"
    "encoding/json"
    "fmt"
    "sort"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

// TweetStore defines the persistence interface for tweets
type TweetStore interface {
    Save(ctx context.Context, tweet *Tweet) error
    GetUserTweets(ctx context.Context, userID string, limit int, before time.Time) ([]*Tweet, error)
}

// Tweet represents a tweet
type Tweet struct {
    ID        string    `json:"id"`
    UserID    string    `json:"user_id"`
    Content   string    `json:"content"`
    Likes     int64     `json:"likes"`
    Retweets  int64     `json:"retweets"`
    CreatedAt time.Time `json:"created_at"`
}

// TimelineService generates user timelines
type TimelineService struct {
    tweetStore      TweetStore
    graphService    *SocialGraphService
    cache           *redis.Client
    fanoutThreshold int // Users with more followers use pull model
}

// NewTimelineService creates a new timeline service
func NewTimelineService(ts TweetStore, gs *SocialGraphService, cache *redis.Client) *TimelineService {
    return &TimelineService{
        tweetStore:      ts,
        graphService:    gs,
        cache:           cache,
        fanoutThreshold: 10000, // Celebrities use pull model
    }
}

// PostTweet posts a new tweet
func (s *TimelineService) PostTweet(ctx context.Context, tweet *Tweet) error {
    // Store the tweet
    if err := s.tweetStore.Save(ctx, tweet); err != nil {
        return err
    }

    // Get follower count
    followerCount, err := s.graphService.GetFollowerCount(ctx, tweet.UserID)
    if err != nil {
        return err
    }

    // Decide fan-out strategy
    if followerCount < s.fanoutThreshold {
        // Fan-out on write: push to all followers' timelines
        go s.fanoutToFollowers(ctx, tweet)
    } else {
        // Fan-out on read: celebrities just store their tweets
        // Timeline will be merged at read time
    }

    return nil
}

// fanoutToFollowers pushes tweet to all followers' cached timelines
func (s *TimelineService) fanoutToFollowers(ctx context.Context, tweet *Tweet) {
    followers, _ := s.graphService.GetFollowers(ctx, tweet.UserID)

    tweetJSON, _ := json.Marshal(tweet)

    // Fan out in batches
    batchSize := 1000
    for i := 0; i < len(followers); i += batchSize {
        end := i + batchSize
        if end > len(followers) {
            end = len(followers)
        }
        batch := followers[i:end]

        var wg sync.WaitGroup
        for _, followerID := range batch {
            wg.Add(1)
            go func(fid string) {
                defer wg.Done()
                key := "timeline:" + fid

                // Add to sorted set (score = timestamp)
                s.cache.ZAdd(ctx, key, redis.Z{
                    Score:  float64(tweet.CreatedAt.UnixNano()),
                    Member: string(tweetJSON),
                })

                // Trim to keep only recent tweets
                s.cache.ZRemRangeByRank(ctx, key, 0, -801) // Keep last 800
            }(followerID)
        }
        wg.Wait()
    }
}

// GetTimeline retrieves a user's timeline
func (s *TimelineService) GetTimeline(ctx context.Context, userID string, limit int, before time.Time) ([]*Tweet, error) {
    key := "timeline:" + userID

    // Get from cached timeline
    maxScore := float64(before.UnixNano())
    if before.IsZero() {
        maxScore = float64(time.Now().UnixNano())
    }

    results, err := s.cache.ZRevRangeByScore(ctx, key, &redis.ZRangeBy{
        Min:   "-inf",
        Max:   fmt.Sprintf("%f", maxScore),
        Count: int64(limit),
    }).Result()

    if err != nil {
        return nil, err
    }

    // Parse tweets
    tweets := make([]*Tweet, 0, len(results))
    for _, result := range results {
        var tweet Tweet
        if err := json.Unmarshal([]byte(result), &tweet); err != nil {
            continue
        }
        tweets = append(tweets, &tweet)
    }

    // Merge with celebrity tweets (fan-out on read)
    celebrities, _ := s.graphService.GetFollowedCelebrities(ctx, userID)
    for _, celeb := range celebrities {
        celebTweets, _ := s.tweetStore.GetUserTweets(ctx, celeb, limit, before)
        tweets = append(tweets, celebTweets...)
    }

    // Sort and deduplicate
    tweets = s.sortAndDedup(tweets)
    if len(tweets) > limit {
        tweets = tweets[:limit]
    }

    return tweets, nil
}

func (s *TimelineService) sortAndDedup(tweets []*Tweet) []*Tweet {
    // Deduplicate
    seen := make(map[string]bool)
    unique := make([]*Tweet, 0)
    for _, t := range tweets {
        if !seen[t.ID] {
            seen[t.ID] = true
            unique = append(unique, t)
        }
    }

    // Sort by time (newest first)
    sort.Slice(unique, func(i, j int) bool {
        return unique[i].CreatedAt.After(unique[j].CreatedAt)
    })

    return unique
}
```

### Social Graph Service

The social graph is the structural backbone of the fan-out decision: every time a tweet is posted, the system must quickly answer "how many followers does this user have?" and "which of the people I follow are celebrities?" to choose the right timeline strategy. Redis sets are ideal here because `SADD`/`SREM` for follow/unfollow and `SCARD` for follower count are all O(1) operations, and `SINTER` for mutual followers is computed in O(min(|A|, |B|)) time, fast enough to serve as a real-time feature. The bidirectional key scheme (`followers:{id}` and `following:{id}`) deliberately denormalizes the relationship so that both "who follows user X" (needed for fan-out) and "who does user X follow" (needed for timeline assembly) can each be resolved with a single Redis `SMEMBERS` call.

```go
// twitter/graph.go
package twitter

import (
    "context"
    "fmt"

    "github.com/redis/go-redis/v9"
)

// SocialGraphService manages follow relationships
type SocialGraphService struct {
    redis *redis.Client
}

// NewSocialGraphService creates a new social graph service
func NewSocialGraphService(client *redis.Client) *SocialGraphService {
    return &SocialGraphService{redis: client}
}

// Follow creates a follow relationship
func (s *SocialGraphService) Follow(ctx context.Context, followerID, followeeID string) error {
    pipe := s.redis.Pipeline()

    // Add to follower's following set
    pipe.SAdd(ctx, s.followingKey(followerID), followeeID)

    // Add to followee's followers set
    pipe.SAdd(ctx, s.followersKey(followeeID), followerID)

    _, err := pipe.Exec(ctx)
    return err
}

// Unfollow removes a follow relationship
func (s *SocialGraphService) Unfollow(ctx context.Context, followerID, followeeID string) error {
    pipe := s.redis.Pipeline()

    pipe.SRem(ctx, s.followingKey(followerID), followeeID)
    pipe.SRem(ctx, s.followersKey(followeeID), followerID)

    _, err := pipe.Exec(ctx)
    return err
}

// GetFollowers returns all followers of a user
func (s *SocialGraphService) GetFollowers(ctx context.Context, userID string) ([]string, error) {
    return s.redis.SMembers(ctx, s.followersKey(userID)).Result()
}

// GetFollowing returns all users a user follows
func (s *SocialGraphService) GetFollowing(ctx context.Context, userID string) ([]string, error) {
    return s.redis.SMembers(ctx, s.followingKey(userID)).Result()
}

// GetFollowerCount returns the number of followers
func (s *SocialGraphService) GetFollowerCount(ctx context.Context, userID string) (int, error) {
    count, err := s.redis.SCard(ctx, s.followersKey(userID)).Result()
    return int(count), err
}

// IsFollowing checks if user A follows user B
func (s *SocialGraphService) IsFollowing(ctx context.Context, followerID, followeeID string) (bool, error) {
    return s.redis.SIsMember(ctx, s.followingKey(followerID), followeeID).Result()
}

// GetMutualFollowers returns users who follow both A and B
func (s *SocialGraphService) GetMutualFollowers(ctx context.Context, userA, userB string) ([]string, error) {
    return s.redis.SInter(ctx, s.followersKey(userA), s.followersKey(userB)).Result()
}

// GetFollowedCelebrities returns followed users with > 10k followers
func (s *SocialGraphService) GetFollowedCelebrities(ctx context.Context, userID string) ([]string, error) {
    following, err := s.GetFollowing(ctx, userID)
    if err != nil {
        return nil, err
    }

    celebrities := make([]string, 0)
    for _, fid := range following {
        count, _ := s.GetFollowerCount(ctx, fid)
        if count >= 10000 {
            celebrities = append(celebrities, fid)
        }
    }

    return celebrities, nil
}

func (s *SocialGraphService) followersKey(userID string) string {
    return fmt.Sprintf("followers:%s", userID)
}

func (s *SocialGraphService) followingKey(userID string) string {
    return fmt.Sprintf("following:%s", userID)
}
```

---

### Junior -> FAANG: Fan-Out Trade-Off as an Interview Core Concept

The fan-out problem is one of the most frequently tested system design concepts because it generalizes far beyond Twitter. Any system where one event must be delivered to many recipients faces this choice: compute at write time (fan-out on write, high write cost, low read latency) or compute at read time (fan-out on read, low write cost, high read latency).

The hybrid approach (fan-out on write for users below a threshold, fan-out on read for celebrities) is the correct answer for most interview scenarios involving social feeds. But the threshold is not magic: it is the break-even point between write cost and read cost. If each timeline write costs 1ms and each timeline read costs 1ms, the break-even is at the follower count where `fanout_write_cost > read_savings_per_session`. For Twitter's usage patterns (users check timeline 10 times per day), the break-even is roughly 10,000-100,000 followers, which is where most implementations set the threshold.

The Redis sorted set with score = timestamp is the correct data structure for a timeline cache: O(log n) insert, O(log n) range query by time, and automatic expiry via `ZREMRANGEBYRANK`. The trim operation (keeping only the most recent 800 tweets per user) is critical for bounding memory usage. Without it, a user who follows many active accounts would accumulate unlimited entries in their timeline key.

### Senior @ FAANG: The Full Complexity of Celebrity Fan-Out at Twitter's Scale

The `GetFollowedCelebrities` method performs a sequential `GetFollowerCount` call for every followed account to classify them as celebrity or not. For a user who follows 1,000 accounts, this is 1,000 sequential Redis `SCARD` calls. In production, celebrity status is a pre-computed flag stored on the user profile, not computed at read time from follower count. The classification job runs periodically and updates the `is_celebrity` flag when follower count crosses the threshold. This converts the timeline assembly from 1,000 network calls to one database query.

The `fanoutToFollowers` function spawns goroutines for each follower in batches of 1,000. At 1 million followers, this creates 1,000 goroutines per batch across 1,000 batches, totaling up to 1,000 concurrent goroutines per tweet. For a user with 10 million followers posting during peak hours, multiple simultaneous tweets would spawn millions of goroutines, saturating the timeline service's goroutine pool. The production fix is a work queue (Kafka topic) where each fan-out task is a message, and a configurable pool of workers drains the queue at a controlled rate. This decouples the fan-out throughput from the posting rate and allows the system to absorb spikes by buffering in the queue.

Twitter's migration from a pure push model to a hybrid model is an instructive case of architecture evolution driven by a specific failure mode: the "Superbowl problem," where a single celebrity tweet caused millions of simultaneous timeline updates that overwhelmed the cache tier. The hybrid model is not an optimization, it is a correctness fix for a system that was breaking under specific load patterns. This distinction matters for staff-level engineering: the goal is not to optimize the average case, it is to bound the worst case.