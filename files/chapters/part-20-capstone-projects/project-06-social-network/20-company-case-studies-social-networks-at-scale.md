## Company Case Studies: Social Networks at Scale

### Meta/Facebook: News Feed Architecture

Meta's News Feed serves billions of users:

```go
// Meta-style News Feed service
package meta

import (
    "context"
    "sync"
    "time"
)

// NewsFeedService handles feed generation and ranking
type NewsFeedService struct {
    tao            *TAOClient
    feedCache      *FeedCache
    ranker         *MLRanker
    integrity      *IntegrityService
    aggregator     *StoryAggregator
}

// FeedItem represents a News Feed story
type FeedItem struct {
    ID            string          `json:"id"`
    ActorID       string          `json:"actor_id"`
    Type          string          `json:"type"` // post, share, comment, like_aggregation
    ObjectID      string          `json:"object_id"`
    Timestamp     time.Time       `json:"timestamp"`
    Score         float64         `json:"score"`
    Aggregations  []*Aggregation  `json:"aggregations,omitempty"`
    Attachments   []*Attachment   `json:"attachments,omitempty"`
    Actions       []*Action       `json:"actions"`
    SeenState     string          `json:"seen_state"`
}

// EdgeRank represents the original FB ranking formula
type EdgeRank struct {
    Affinity    float64 // How close is user to content creator
    Weight      float64 // Type of interaction (comment > like)
    TimeDecay   float64 // How recent is the content
}

// GenerateFeed creates personalized feed for user
func (s *NewsFeedService) GenerateFeed(ctx context.Context, userID string, cursor string, limit int) (*FeedResponse, error) {
    // Check feed cache first
    if cached := s.feedCache.GetFeed(userID, cursor); cached != nil {
        return cached, nil
    }

    // Get user's social graph
    friendIDs, err := s.tao.AssocRange(ctx, userID, "friend", 0, 5000)
    if err != nil {
        return nil, err
    }

    followIDs, err := s.tao.AssocRange(ctx, userID, "following", 0, 1000)
    if err != nil {
        return nil, err
    }

    // Collect candidate stories from connections
    var wg sync.WaitGroup
    candidates := make(chan *FeedItem, 10000)

    // Fan-out to fetch recent posts from friends
    for _, friendID := range friendIDs {
        wg.Add(1)
        go func(fid string) {
            defer wg.Done()
            posts := s.getRecentPosts(ctx, fid, 24*time.Hour)
            for _, post := range posts {
                candidates <- post
            }
        }(friendID)
    }

    // Fetch from followed pages/groups
    for _, followID := range followIDs {
        wg.Add(1)
        go func(fid string) {
            defer wg.Done()
            posts := s.getRecentPosts(ctx, fid, 72*time.Hour)
            for _, post := range posts {
                candidates <- post
            }
        }(followID)
    }

    wg.Wait()
    close(candidates)

    // Collect all candidates
    var items []*FeedItem
    for item := range candidates {
        items = append(items, item)
    }

    // Run integrity checks (remove violating content)
    items = s.integrity.FilterContent(ctx, userID, items)

    // Aggregate similar stories (e.g., "5 friends liked this")
    items = s.aggregator.Aggregate(ctx, items)

    // ML-based ranking
    rankedItems := s.ranker.Rank(ctx, userID, items)

    // Paginate
    response := &FeedResponse{
        Items:      rankedItems[:limit],
        NextCursor: generateCursor(rankedItems[limit-1]),
    }

    // Cache the feed
    s.feedCache.SetFeed(userID, cursor, response)

    return response, nil
}

// Rank applies ML model for personalized ranking
func (r *MLRanker) Rank(ctx context.Context, userID string, items []*FeedItem) []*FeedItem {
    // Get user features
    userFeatures := r.getUserFeatures(ctx, userID)

    // Score each item
    for _, item := range items {
        itemFeatures := r.getItemFeatures(ctx, item)
        interactionFeatures := r.getInteractionFeatures(ctx, userID, item.ActorID)

        // Combine features and run through model
        features := r.combineFeatures(userFeatures, itemFeatures, interactionFeatures)
        item.Score = r.model.Predict(features)
    }

    // Sort by score
    sort.Slice(items, func(i, j int) bool {
        return items[i].Score > items[j].Score
    })

    return items
}
```

### Twitter/X: Timeline Service

Twitter's timeline architecture:

```go
// Twitter-style timeline service
package twitter

import (
    "context"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

// TimelineService handles home timeline generation
type TimelineService struct {
    redis          *redis.ClusterClient
    tweetStore     *TweetStore
    graphStore     *GraphStore
    fanoutService  *FanoutService
    rankingService *RankingService
}

// Tweet represents a Twitter tweet
type Tweet struct {
    ID            string    `json:"id"`
    UserID        string    `json:"user_id"`
    Text          string    `json:"text"`
    Entities      *Entities `json:"entities"`
    ReplyToID     string    `json:"reply_to_id,omitempty"`
    QuoteTweetID  string    `json:"quote_tweet_id,omitempty"`
    RetweetOf     string    `json:"retweet_of,omitempty"`
    CreatedAt     time.Time `json:"created_at"`
    Metrics       *TweetMetrics `json:"metrics"`
}

// Entities contains parsed entities from tweet
type Entities struct {
    Hashtags    []string `json:"hashtags"`
    Mentions    []string `json:"mentions"`
    URLs        []string `json:"urls"`
    Media       []*Media `json:"media"`
}

// PostTweet handles tweet creation with fanout
func (s *TimelineService) PostTweet(ctx context.Context, tweet *Tweet) error {
    // Store the tweet
    if err := s.tweetStore.Save(ctx, tweet); err != nil {
        return err
    }

    // Get follower count
    followerCount, err := s.graphStore.GetFollowerCount(ctx, tweet.UserID)
    if err != nil {
        return err
    }

    // Fanout strategy based on follower count
    if followerCount < 10000 {
        // Fan-out on write for normal users
        return s.fanoutService.FanoutToFollowers(ctx, tweet)
    } else {
        // Fan-out on read for celebrities (lazy loading)
        return s.fanoutService.MarkForLazyFanout(ctx, tweet)
    }
}

// FanoutToFollowers pushes tweet to all follower timelines
func (f *FanoutService) FanoutToFollowers(ctx context.Context, tweet *Tweet) error {
    // Get all followers
    followers, err := f.graphStore.GetFollowers(ctx, tweet.UserID)
    if err != nil {
        return err
    }

    // Batch write to Redis sorted sets
    pipe := f.redis.Pipeline()
    for _, followerID := range followers {
        timelineKey := fmt.Sprintf("timeline:%s", followerID)
        pipe.ZAdd(ctx, timelineKey, redis.Z{
            Score:  float64(tweet.CreatedAt.UnixNano()),
            Member: tweet.ID,
        })
        // Trim to last 800 tweets
        pipe.ZRemRangeByRank(ctx, timelineKey, 0, -801)
    }

    _, err = pipe.Exec(ctx)
    return err
}

// GetHomeTimeline retrieves personalized timeline
func (s *TimelineService) GetHomeTimeline(ctx context.Context, userID string, maxID string, count int) ([]*Tweet, error) {
    timelineKey := fmt.Sprintf("timeline:%s", userID)

    // Get tweet IDs from timeline sorted set
    var tweetIDs []string
    if maxID != "" {
        // Pagination: get tweets older than maxID
        maxScore, _ := s.getTweetScore(ctx, maxID)
        tweetIDs, _ = s.redis.ZRevRangeByScore(ctx, timelineKey, &redis.ZRangeBy{
            Max:    fmt.Sprintf("(%f", maxScore),
            Min:    "-inf",
            Offset: 0,
            Count:  int64(count),
        }).Result()
    } else {
        tweetIDs, _ = s.redis.ZRevRange(ctx, timelineKey, 0, int64(count-1)).Result()
    }

    // Hydrate tweet IDs to full tweet objects
    tweets := s.tweetStore.GetMulti(ctx, tweetIDs)

    // Merge in celebrity tweets (fan-out on read)
    celebrityTweets := s.getCelebrityTweets(ctx, userID, count)
    tweets = s.mergeTweets(tweets, celebrityTweets)

    // Apply ranking
    rankedTweets := s.rankingService.RankTimeline(ctx, userID, tweets)

    return rankedTweets[:count], nil
}
```

### LinkedIn: Professional Network Graph

LinkedIn's connection recommendations:

```go
// LinkedIn-style professional network service
package linkedin

import (
    "context"
    "sync"
)

// NetworkService handles professional networking features
type NetworkService struct {
    graphDB        *Neo4jClient
    searchService  *PeopleSearchService
    recommendEngine *RecommendationEngine
    messageService *InMailService
}

// Connection represents a professional connection
type Connection struct {
    UserID        string    `json:"user_id"`
    ConnectionID  string    `json:"connection_id"`
    Degree        int       `json:"degree"` // 1st, 2nd, 3rd
    MutualCount   int       `json:"mutual_count"`
    SharedGroups  []string  `json:"shared_groups"`
    SharedCompanies []string `json:"shared_companies"`
    ConnectedAt   time.Time `json:"connected_at,omitempty"`
}

// PYMK represents "People You May Know" recommendation
type PYMK struct {
    UserID        string   `json:"user_id"`
    Score         float64  `json:"score"`
    Reasons       []string `json:"reasons"`
    MutualConnections []string `json:"mutual_connections"`
}

// GetPYMK generates connection recommendations
func (s *NetworkService) GetPYMK(ctx context.Context, userID string, limit int) ([]*PYMK, error) {
    // Get user's network
    firstDegree, err := s.graphDB.GetConnections(ctx, userID, 1)
    if err != nil {
        return nil, err
    }

    // Get second-degree connections
    secondDegree, err := s.graphDB.GetConnections(ctx, userID, 2)
    if err != nil {
        return nil, err
    }

    // Exclude already connected
    firstDegreeSet := make(map[string]bool)
    for _, conn := range firstDegree {
        firstDegreeSet[conn.ConnectionID] = true
    }

    // Score second-degree connections
    candidates := make([]*PYMK, 0)
    for _, conn := range secondDegree {
        if firstDegreeSet[conn.ConnectionID] {
            continue
        }

        pymk := s.scoreCandidate(ctx, userID, conn, firstDegree)
        candidates = append(candidates, pymk)
    }

    // Add company/school/industry-based recommendations
    similarPeople := s.recommendEngine.FindSimilarProfiles(ctx, userID)
    for _, person := range similarPeople {
        if firstDegreeSet[person.UserID] {
            continue
        }
        pymk := &PYMK{
            UserID:  person.UserID,
            Score:   person.SimilarityScore,
            Reasons: person.SimilarityReasons,
        }
        candidates = append(candidates, pymk)
    }

    // Deduplicate and sort by score
    candidates = s.deduplicateAndSort(candidates)

    if len(candidates) > limit {
        candidates = candidates[:limit]
    }

    return candidates, nil
}

// scoreCandidate calculates PYMK score for a candidate
func (s *NetworkService) scoreCandidate(ctx context.Context, userID string, conn *Connection, firstDegree []*Connection) *PYMK {
    pymk := &PYMK{
        UserID:  conn.ConnectionID,
        Reasons: make([]string, 0),
    }

    score := 0.0

    // Mutual connections (strongest signal)
    mutuals := s.findMutualConnections(conn.ConnectionID, firstDegree)
    pymk.MutualConnections = mutuals
    score += float64(len(mutuals)) * 10.0

    if len(mutuals) > 0 {
        pymk.Reasons = append(pymk.Reasons, fmt.Sprintf("%d mutual connections", len(mutuals)))
    }

    // Same company
    if len(conn.SharedCompanies) > 0 {
        score += 5.0
        pymk.Reasons = append(pymk.Reasons, fmt.Sprintf("Works at %s", conn.SharedCompanies[0]))
    }

    // Same industry
    user := s.getUserProfile(ctx, userID)
    candidate := s.getUserProfile(ctx, conn.ConnectionID)
    if user.Industry == candidate.Industry {
        score += 3.0
        pymk.Reasons = append(pymk.Reasons, fmt.Sprintf("Also in %s", user.Industry))
    }

    // Same school
    if hasCommonSchool(user.Education, candidate.Education) {
        score += 4.0
        pymk.Reasons = append(pymk.Reasons, "Went to the same school")
    }

    // Same location
    if user.Location == candidate.Location {
        score += 2.0
        pymk.Reasons = append(pymk.Reasons, fmt.Sprintf("Lives in %s", user.Location))
    }

    pymk.Score = score
    return pymk
}
```

### TikTok: For You Page Algorithm

TikTok's content recommendation:

```go
// TikTok-style content recommendation
package tiktok

import (
    "context"
    "math/rand/v2"
    "time"
)

// ForYouService handles personalized content feed
type ForYouService struct {
    contentStore    *ContentStore
    userModel       *UserInterestModel
    contentRanker   *ContentRanker
    diversifier     *FeedDiversifier
    coldStartEngine *ColdStartEngine
}

// Video represents a TikTok video
type Video struct {
    ID            string            `json:"id"`
    CreatorID     string            `json:"creator_id"`
    Description   string            `json:"description"`
    Hashtags      []string          `json:"hashtags"`
    Music         *Music            `json:"music"`
    Duration      time.Duration     `json:"duration"`
    Categories    []string          `json:"categories"`
    Embeddings    []float32         `json:"embeddings"`
    Metrics       *VideoMetrics     `json:"metrics"`
    CreatedAt     time.Time         `json:"created_at"`
}

// VideoMetrics tracks engagement
type VideoMetrics struct {
    Views         int64   `json:"views"`
    Likes         int64   `json:"likes"`
    Comments      int64   `json:"comments"`
    Shares        int64   `json:"shares"`
    WatchTime     float64 `json:"watch_time_pct"` // Average watch percentage
    CompletionRate float64 `json:"completion_rate"`
}

// GetForYouPage generates personalized feed
func (s *ForYouService) GetForYouPage(ctx context.Context, userID string, count int) ([]*Video, error) {
    // Get user interest model
    userInterests, err := s.userModel.GetInterests(ctx, userID)
    if err != nil {
        // New user - use cold start
        return s.coldStartEngine.GetInitialFeed(ctx, count)
    }

    // Candidate generation from multiple sources
    candidates := make([]*Video, 0, count*10)

    // 1. Interest-based retrieval (60%)
    interestVideos := s.contentStore.GetByInterests(ctx, userInterests, count*6)
    candidates = append(candidates, interestVideos...)

    // 2. Collaborative filtering (20%)
    similarUsers := s.userModel.GetSimilarUsers(ctx, userID, 100)
    cfVideos := s.contentStore.GetLikedByUsers(ctx, similarUsers, count*2)
    candidates = append(candidates, cfVideos...)

    // 3. Trending/Explore (10%)
    trendingVideos := s.contentStore.GetTrending(ctx, count)
    candidates = append(candidates, trendingVideos...)

    // 4. Creator following (10%)
    followingVideos := s.getFollowingContent(ctx, userID, count)
    candidates = append(candidates, followingVideos...)

    // Deduplicate
    candidates = s.deduplicate(candidates)

    // Filter already seen
    candidates = s.filterSeen(ctx, userID, candidates)

    // Rank candidates
    rankedVideos := s.contentRanker.Rank(ctx, userID, userInterests, candidates)

    // Diversify feed (avoid too many similar videos in a row)
    diversifiedVideos := s.diversifier.Diversify(rankedVideos, count)

    // Add exploration (5% random for discovering new interests)
    s.addExploration(ctx, diversifiedVideos, count)

    return diversifiedVideos[:count], nil
}

// Rank scores videos based on predicted engagement
func (r *ContentRanker) Rank(ctx context.Context, userID string, interests *UserInterests, videos []*Video) []*Video {
    for _, video := range videos {
        score := 0.0

        // Interest match
        interestScore := r.calculateInterestMatch(interests, video)
        score += interestScore * 0.3

        // Creator affinity
        creatorScore := r.getCreatorAffinity(ctx, userID, video.CreatorID)
        score += creatorScore * 0.15

        // Content quality (engagement metrics)
        qualityScore := r.calculateQualityScore(video.Metrics)
        score += qualityScore * 0.25

        // Freshness
        freshnessScore := r.calculateFreshness(video.CreatedAt)
        score += freshnessScore * 0.1

        // Watch history prediction (will user complete the video?)
        completionPred := r.predictCompletion(ctx, userID, video)
        score += completionPred * 0.2

        video.Metrics.WatchTime = score // Reuse field for ranking score
    }

    sort.Slice(videos, func(i, j int) bool {
        return videos[i].Metrics.WatchTime > videos[j].Metrics.WatchTime
    })

    return videos
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Meta | TAO cache, ML ranking, aggregation | 2B+ DAU |
| Twitter | Fan-out on write/read hybrid, timeline cache | 500M+ tweets/day |
| LinkedIn | Graph-based PYMK, professional context | 900M+ members |
| TikTok | Deep interest modeling, real-time ranking | 1B+ MAU |

---

### Junior → FAANG: Learning from Industry Case Studies

Case studies are not just interesting history. They are the vocabulary of senior engineering conversations. When an interviewer asks "how would Meta solve this," they expect you to know roughly how TAO works, why the timeline fanout problem drove Twitter to write Snowflake, and why LinkedIn migrated from a monolith to microservices.

The prerequisite study pattern: for each company in this chapter, understand the specific problem they were solving at scale that forced an architectural decision, the solution they chose, and the tradeoff they accepted. For Meta TAO: the problem was that Memcached could not express graph associations natively, the solution was a purpose-built cache for graph edges, the tradeoff was operational complexity of a custom system.

Entry-level interview framing: do not just name the technology. Describe the problem first. "Meta built TAO because..." shows understanding. "Meta uses TAO" shows only that you read the blog post.

First-job habit: read engineering blogs from Stripe, Netflix, Airbnb, Uber, Meta, and LinkedIn regularly. Not to copy solutions, but to build a mental library of tradeoffs at scale that you can draw on when encountering similar problems in your own work.

### Senior @ FAANG: Applying Industry Patterns as an Architectural Decision Maker

At L6, you are expected to be the person in the room who can map the company's current problem to an industry pattern, assess whether the pattern applies to your specific context, and make a documented decision about whether to adopt, adapt, or reject it.

**The adoption decision framework.** When evaluating an industry pattern (for example, adopting a TAO-like graph cache), ask four questions. First, is our problem actually the same problem they solved, or just superficially similar? Second, do we have the engineering and operational capacity to build and maintain a custom system, or should we use an off-the-shelf solution? Third, what does success look like, and how will we measure it? Fourth, what is the rollback plan if it does not work? Documenting answers to these four questions in an ADR before committing to the pattern is the staff-level standard.

**Knowing when NOT to follow the FAANG pattern.** Industry case studies describe solutions to problems at 100M to 2B user scale. Most companies are not at that scale. The senior engineer's responsibility is to resist cargo-culting. Building a custom distributed cache system for a product with 100,000 users adds operational complexity without solving a real problem. The right question is "what is the simplest architecture that meets our current requirements and can be evolved when we grow?" Define the scale trigger points in an ADR: "we will consider sharding when table X exceeds 100M rows."

**Maturity model thinking.** At staff level, you assess your system's maturity against an industry maturity model and identify the next increment of investment. Level 1: manual deployments, no SLOs, reactive monitoring. Level 2: automated deployments, SLOs defined, alert-based response. Level 3: progressive delivery, SLO-based alerting, chaos tested. Level 4: self-healing systems, predictive scaling, full observability. Knowing your current level and the gap to the next level lets you prioritize platform investments based on reliability ROI rather than engineering interest.

**Cross-company collaboration signals.** FAANG hiring bar-raisers look for candidates who have contributed to open source projects that industry companies use, presented at engineering conferences, written public postmortems, or published design documents that influenced cross-company standards. This signals that the candidate thinks at a platform level, not just within their team's domain. In your own career, look for opportunities to contribute to open standards (OpenTelemetry, OpenAPI) or to publish learnings from your system's unique challenges. This builds the reputation that attracts L6 and above opportunities.
