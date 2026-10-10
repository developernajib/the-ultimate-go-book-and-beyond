## Core Components

The following sections walk through each major service in Go. Each service is designed as an independent module with its own repository and event bus, following the single-responsibility principle. Together, they handle the full lifecycle of a tweet: creation, distribution, search indexing, and trending detection.

### 1. Tweet Service

The Tweet Service is the entry point for all new tweets. It validates the input (character limit, empty check), extracts hashtags and mentions from the text, generates a globally unique Snowflake ID, persists the tweet to the database, and then publishes an event so that downstream services like fan-out, search, and trending can react asynchronously.

```go
package tweet

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Tweet represents a single tweet
type Tweet struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	Text         string    `json:"text"`
	MediaURLs    []string  `json:"media_urls,omitempty"`
	RetweetID    *int64    `json:"retweet_id,omitempty"`
	ReplyToID    *int64    `json:"reply_to_id,omitempty"`
	QuoteTweetID *int64    `json:"quote_tweet_id,omitempty"`
	LikeCount    int64     `json:"like_count"`
	RetweetCount int64     `json:"retweet_count"`
	ReplyCount   int64     `json:"reply_count"`
	Hashtags     []string  `json:"hashtags,omitempty"`
	Mentions     []string  `json:"mentions,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// CreateTweetRequest is the request to post a tweet
type CreateTweetRequest struct {
	UserID       int64    `json:"user_id"`
	Text         string   `json:"text"`
	MediaIDs     []string `json:"media_ids,omitempty"`
	RetweetID    *int64   `json:"retweet_id,omitempty"`
	ReplyToID    *int64   `json:"reply_to_id,omitempty"`
	QuoteTweetID *int64   `json:"quote_tweet_id,omitempty"`
}

// TweetService handles tweet creation and retrieval
type TweetService struct {
	tweetRepo  TweetRepository
	mediaStore MediaStore
	eventBus   EventBus
	idGen      IDGenerator // Snowflake ID generator
}

// Create posts a new tweet
func (s *TweetService) Create(ctx context.Context, req CreateTweetRequest) (*Tweet, error) {
	// Validate
	if utf8.RuneCountInString(req.Text) > 280 {
		return nil, fmt.Errorf("tweet exceeds 280 characters")
	}
	if req.Text == "" && len(req.MediaIDs) == 0 && req.RetweetID == nil {
		return nil, fmt.Errorf("tweet cannot be empty")
	}

	// Extract hashtags and mentions
	hashtags := extractHashtags(req.Text)
	mentions := extractMentions(req.Text)

	// Generate Snowflake ID (encodes timestamp + datacenter + sequence)
	id, err := s.idGen.Next()
	if err != nil {
		return nil, fmt.Errorf("generate id: %w", err)
	}

	tweet := &Tweet{
		ID:           id,
		UserID:       req.UserID,
		Text:         req.Text,
		RetweetID:    req.RetweetID,
		ReplyToID:    req.ReplyToID,
		QuoteTweetID: req.QuoteTweetID,
		Hashtags:     hashtags,
		Mentions:     mentions,
		CreatedAt:    time.Now().UTC(),
	}

	// Attach media. GetURL takes the requesting user because a media ID is an
	// opaque string a client hands back to us: without an ownership check,
	// anyone holding someone else's media ID could attach their upload to their
	// own tweet. It also has to be resolved rather than skipped on error, since
	// silently dropping media publishes a tweet the author did not write.
	for _, mediaID := range req.MediaIDs {
		url, err := s.mediaStore.GetURLOwnedBy(ctx, mediaID, req.UserID)
		if err != nil {
			return nil, fmt.Errorf("attach media %s: %w", mediaID, err)
		}
		tweet.MediaURLs = append(tweet.MediaURLs, url)
	}

	// Persist to DB
	if err := s.tweetRepo.Create(ctx, tweet); err != nil {
		return nil, fmt.Errorf("create tweet: %w", err)
	}

	// Publish event for async fan-out, search indexing, trending
	s.eventBus.Publish(TweetCreatedEvent{Tweet: *tweet})

	return tweet, nil
}

func extractHashtags(text string) []string {
	var tags []string
	for _, word := range strings.Fields(text) {
		if strings.HasPrefix(word, "#") && len(word) > 1 {
			tag := strings.ToLower(strings.Trim(word[1:], ".,!?"))
			tags = append(tags, tag)
		}
	}
	return tags
}

func extractMentions(text string) []string {
	var mentions []string
	for _, word := range strings.Fields(text) {
		if strings.HasPrefix(word, "@") && len(word) > 1 {
			mention := strings.ToLower(strings.Trim(word[1:], ".,!?"))
			mentions = append(mentions, mention)
		}
	}
	return mentions
}

type TweetCreatedEvent struct {
	Tweet Tweet
}

// TweetRepository defines tweet persistence operations
type TweetRepository interface {
	Create(ctx context.Context, tweet *Tweet) error
}

// MediaStore defines media asset retrieval
type MediaStore interface {
	GetURLOwnedBy(ctx context.Context, mediaID string, userID int64) (string, error)
}

// EventBus defines asynchronous event publishing
type EventBus interface {
	Publish(event any)
}

// IDGenerator defines distributed ID generation
type IDGenerator interface {
	Next() (int64, error)
}
```

### 2. Timeline Service with Fan-Out

The Timeline Service is responsible for building and serving each user's home feed. It uses a hybrid fan-out model: when a regular user tweets, the fan-out worker pushes the tweet ID into every follower's Redis sorted set. For celebrities with more than 100,000 followers, the system skips push entirely and instead pulls their recent tweets at read time, merging them with the pre-computed feed. This avoids writing to millions of Redis keys for a single celebrity tweet.

```go
package timeline

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	MaxTimelineSize        = 800                // max tweets cached per user
	CelebFollowerThreshold = 100000             // use pull model for users above this
	TimelineTTL            = 7 * 24 * time.Hour // evict timelines of inactive users
)

// TimelineService manages user timelines
type TimelineService struct {
	rdb         *redis.ClusterClient
	tweetStore  TweetStore
	followStore FollowStore
}

// FanOutWorker processes tweet fan-out from Kafka
type FanOutWorker struct {
	ts          *TimelineService
	followStore FollowStore
}

// FanOut distributes a tweet to all followers' timelines.
// This is the push half of the hybrid model. Celebrities above
// CelebFollowerThreshold are skipped here and pulled at read time instead,
// so one celebrity tweet never turns into 10M Redis writes.
func (w *FanOutWorker) FanOut(ctx context.Context, tweet Tweet) error {
	// The threshold check has to happen on the write path, not just the read
	// path. Without it the hybrid model is really fan-out-on-write for everyone.
	count, err := w.followStore.CountFollowers(ctx, tweet.UserID)
	if err != nil {
		return fmt.Errorf("count followers: %w", err)
	}
	if count > CelebFollowerThreshold {
		return nil // pull-on-read handles this author
	}

	followers, err := w.followStore.GetFollowers(ctx, tweet.UserID)
	if err != nil {
		return err
	}

	// Batch Redis updates: pipeline 1000 writes per batch
	batchSize := 1000
	for i := 0; i < len(followers); i += batchSize {
		end := i + batchSize
		if end > len(followers) {
			end = len(followers)
		}
		batch := followers[i:end]

		pipe := w.ts.rdb.Pipeline()
		for _, followerID := range batch {
			timelineKey := fmt.Sprintf("timeline:%d", followerID)
			pipe.ZAdd(ctx, timelineKey, redis.Z{
				// Snowflake IDs are time-ordered, so the ID doubles as the score.
				// Redis scores are float64, which holds only 53 significant bits,
				// so an ID this large rounds to the nearest ~32. That is far below
				// the 4,194,304 ID units in one millisecond, so cross-millisecond
				// ordering is exact and only same-millisecond ties can shift.
				Score:  float64(tweet.ID),
				Member: tweet.ID,
			})
			// Trim to max size to bound memory
			pipe.ZRemRangeByRank(ctx, timelineKey, 0, -(MaxTimelineSize + 1))
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return fmt.Errorf("pipeline exec batch %d: %w", i/batchSize, err)
		}
	}
	return nil
}

// GetTimeline returns a user's home timeline (hybrid: push + celebrity pull)
func (s *TimelineService) GetTimeline(ctx context.Context, userID int64, sinceID, maxID int64, limit int) ([]Tweet, error) {
	timelineKey := fmt.Sprintf("timeline:%d", userID)

	// Score range via Snowflake ID bounds
	min := "-inf"
	max := "+inf"
	if sinceID > 0 {
		min = fmt.Sprintf("(%d", sinceID) // exclusive lower bound
	}
	if maxID > 0 {
		max = fmt.Sprintf("%d", maxID)
	}

	tweetIDStrs, err := s.rdb.ZRevRangeByScore(ctx, timelineKey, &redis.ZRangeBy{
		Min:   min,
		Max:   max,
		Count: int64(limit),
	}).Result()
	if err != nil || len(tweetIDStrs) == 0 {
		// Cache miss: rebuild the pushed half from the DB, then merge celebrities
		// on top exactly as the cache-hit path does.
		pushed, err := s.hydrateTimeline(ctx, userID, limit)
		if err != nil {
			return nil, err
		}
		return mergeSorted(pushed, s.fetchCelebrityTweets(ctx, userID, limit), limit), nil
	}

	// Cache hit, so this user is active: push the eviction deadline back.
	s.rdb.Expire(ctx, timelineKey, TimelineTTL)

	// Hydrate tweet IDs to full tweet objects (batch fetch)
	tweetIDs := make([]int64, len(tweetIDStrs))
	for i, str := range tweetIDStrs {
		// Parse as int64. Sorting these as strings would not be chronological
		// once the ID width changes, so never compare the string form.
		if _, err := fmt.Sscanf(str, "%d", &tweetIDs[i]); err != nil {
			continue
		}
	}

	// Merge in celebrity tweets at read time (not in push cache)
	pushed, err := s.tweetStore.GetBatch(ctx, tweetIDs)
	if err != nil {
		return nil, err
	}
	celeb := s.fetchCelebrityTweets(ctx, userID, limit)

	return mergeSorted(pushed, celeb, limit), nil
}

// fetchCelebrityTweets pulls recent tweets from followed celebrities
// These are NOT in the fan-out cache to avoid 10M-write amplification
func (s *TimelineService) fetchCelebrityTweets(ctx context.Context, userID int64, limit int) []Tweet {
	celebs, _ := s.followStore.GetCelebFollowing(ctx, userID, CelebFollowerThreshold)
	var tweets []Tweet
	for _, celebID := range celebs {
		t, _ := s.tweetStore.GetByUser(ctx, celebID, 5)
		tweets = append(tweets, t...)
	}
	return tweets
}

// hydrateTimeline rebuilds timeline cache for cold-start users.
// It rebuilds only the pushed half of the timeline. Celebrities are excluded
// so the cache never holds a tweet that fetchCelebrityTweets will also pull,
// which would show the tweet twice after the next cache hit.
func (s *TimelineService) hydrateTimeline(ctx context.Context, userID int64, limit int) ([]Tweet, error) {
	following, err := s.followStore.GetNonCelebFollowing(ctx, userID, CelebFollowerThreshold)
	if err != nil {
		return nil, err
	}
	following = append(following, userID) // include own tweets

	var allTweets []Tweet
	var mu sync.Mutex
	var wg sync.WaitGroup
	// Bound concurrency: a user following 5,000 accounts must not open 5,000
	// simultaneous store reads and stampede the shards on one cache miss.
	sem := make(chan struct{}, 32)

	for _, authorID := range following {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			tweets, err := s.tweetStore.GetByUser(ctx, id, 20)
			if err != nil {
				return
			}
			mu.Lock()
			allTweets = append(allTweets, tweets...)
			mu.Unlock()
		}(authorID)
	}
	wg.Wait()

	sort.Slice(allTweets, func(i, j int) bool {
		return allTweets[i].CreatedAt.After(allTweets[j].CreatedAt)
	})
	if len(allTweets) > limit {
		allTweets = allTweets[:limit]
	}

	// Async cache write
	go func() {
		timelineKey := fmt.Sprintf("timeline:%d", userID)
		pipe := s.rdb.Pipeline()
		for _, tweet := range allTweets {
			pipe.ZAdd(context.Background(), timelineKey, redis.Z{
				Score:  float64(tweet.ID),
				Member: tweet.ID,
			})
		}
		// 7 days, matching the inactive-user eviction policy. A timeline is a
		// cache and is always rebuildable, so an expiry here costs a slow read,
		// never data. Refresh the TTL on read so an active user's timeline is
		// not evicted out from under them.
		pipe.Expire(context.Background(), timelineKey, TimelineTTL)
		pipe.Exec(context.Background())
	}()

	return allTweets, nil
}

// mergeSorted interleaves the pushed and pulled halves newest-first and drops
// duplicates, so a tweet that reaches the feed down both paths appears once.
func mergeSorted(a, b []Tweet, limit int) []Tweet {
	merged := make([]Tweet, 0, len(a)+len(b))
	seen := make(map[int64]struct{}, len(a)+len(b))
	for _, t := range append(append([]Tweet{}, a...), b...) {
		if _, dup := seen[t.ID]; dup {
			continue
		}
		seen[t.ID] = struct{}{}
		merged = append(merged, t)
	}
	sort.Slice(merged, func(i, j int) bool {
		return merged[i].CreatedAt.After(merged[j].CreatedAt)
	})
	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged
}

// TweetStore provides tweet retrieval operations
type TweetStore interface {
	GetBatch(ctx context.Context, tweetIDs []int64) ([]Tweet, error)
	GetByUser(ctx context.Context, userID int64, limit int) ([]Tweet, error)
}

// FollowStore provides social graph operations
type FollowStore interface {
	CountFollowers(ctx context.Context, userID int64) (int, error)
	GetFollowers(ctx context.Context, userID int64, limit int) ([]int64, error)
	GetCelebFollowing(ctx context.Context, userID int64, threshold int) ([]int64, error)
	GetNonCelebFollowing(ctx context.Context, userID int64, threshold int) ([]int64, error)
}
```

### 3. Trending Topics with Velocity Detection

Trending topics must detect what is surging right now, not just what is popular in general. Hashtags like #love or #news always have high volume, but they are not "trending" unless their usage suddenly spikes. This service solves that problem using per-minute Redis buckets combined with z-score normalization. Each minute's hashtag counts are stored in a separate Redis sorted set, and the service aggregates across a 60-minute sliding window to compute both total volume and recent velocity. The z-score measures how many standard deviations a hashtag's count is above the mean, weighted by a velocity bonus that rewards suddenly-accelerating topics over permanently popular ones.

```go
package trending

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

// TrendingService computes real-time trending topics
// Uses sliding window + velocity score to detect breakout moments
type TrendingService struct {
	rdb *redis.Client
}

// RecordHashtag records a hashtag usage in current time bucket
func (s *TrendingService) RecordHashtag(ctx context.Context, hashtag string) error {
	bucketKey := fmt.Sprintf("trending:%d", time.Now().Unix()/60) // per-minute bucket

	pipe := s.rdb.Pipeline()
	pipe.ZIncrBy(ctx, bucketKey, 1, hashtag)
	pipe.Expire(ctx, bucketKey, 90*time.Minute)
	_, err := pipe.Exec(ctx)
	return err
}

// TrendingTopic represents a trending topic with velocity metrics
type TrendingTopic struct {
	Hashtag  string  `json:"hashtag"`  // the tag itself
	Count    float64 `json:"count"`    // total in window
	Velocity float64 `json:"velocity"` // count in last 5 min
	ZScore   float64 `json:"z_score"`  // standard deviations above mean
}

// GetTrending returns top N trending topics using sliding window + z-score
// Window: 60 minutes total - velocity based on last 5 minutes
func (s *TrendingService) GetTrending(ctx context.Context, window time.Duration, limit int) ([]TrendingTopic, error) {
	now := time.Now()
	numBuckets := int(window.Minutes())

	// Aggregate counts across buckets
	counts := make(map[string]float64)
	recentCounts := make(map[string]float64) // last 5 min = velocity

	for i := 0; i < numBuckets; i++ {
		bucketTime := now.Unix()/60 - int64(i)
		bucketKey := fmt.Sprintf("trending:%d", bucketTime)

		members, err := s.rdb.ZRangeWithScores(ctx, bucketKey, 0, -1).Result()
		if err != nil {
			continue
		}
		for _, m := range members {
			tag := m.Member.(string)
			counts[tag] += m.Score
			if i < 5 { // last 5 minutes
				recentCounts[tag] += m.Score
			}
		}
	}

	// Compute mean and stddev across all hashtags (for z-score)
	var values []float64
	for _, v := range counts {
		values = append(values, v)
	}
	mean, stddev := meanStddev(values)

	// Build trending list with z-score
	var topics []TrendingTopic
	for hashtag, count := range counts {
		zScore := 0.0
		if stddev > 0 {
			zScore = (count - mean) / stddev
		}
		topics = append(topics, TrendingTopic{
			Hashtag:  hashtag,
			Count:    count,
			Velocity: recentCounts[hashtag],
			ZScore:   zScore,
		})
	}

	// Sort: z-score weighted by velocity
	// Z-score alone would always pick established popular hashtags
	// Velocity bonus rewards suddenly-surging topics
	sort.Slice(topics, func(i, j int) bool {
		scoreI := topics[i].ZScore + math.Log1p(topics[i].Velocity)*0.5
		scoreJ := topics[j].ZScore + math.Log1p(topics[j].Velocity)*0.5
		return scoreI > scoreJ
	})

	if len(topics) > limit {
		topics = topics[:limit]
	}
	return topics, nil
}

func meanStddev(values []float64) (mean, stddev float64) {
	if len(values) == 0 {
		return 0, 0
	}
	for _, v := range values {
		mean += v
	}
	mean /= float64(len(values))
	for _, v := range values {
		diff := v - mean
		stddev += diff * diff
	}
	stddev = math.Sqrt(stddev / float64(len(values)))
	return
}
```

### 4. Search Indexing Service

The Search Indexing Service consumes tweet events from Kafka and indexes them into Elasticsearch for full-text search. Tweets from the last 7 days go into a "hot" index that fits in RAM for sub-50ms queries, while older tweets are stored in monthly archive indices on disk. The service supports both single-document indexing and bulk indexing, where bulk is far more efficient because it reduces HTTP round trips from hundreds to one.

```go
package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// SearchIndexer ingests tweets into Elasticsearch
type SearchIndexer struct {
	esURL    string
	client   *http.Client
	bulkSize int
}

// TweetDocument is the Elasticsearch document for a tweet
type TweetDocument struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	Username     string    `json:"username"`
	Text         string    `json:"text"`
	Hashtags     []string  `json:"hashtags"`
	Mentions     []string  `json:"mentions"`
	LikeCount    int64     `json:"like_count"`
	RetweetCount int64     `json:"retweet_count"`
	CreatedAt    time.Time `json:"created_at"`
	Lang         string    `json:"lang"` // detected language for locale filtering
}

// IndexTweet sends a tweet document to Elasticsearch
func (s *SearchIndexer) IndexTweet(ctx context.Context, tweet TweetDocument) error {
	// Route to correct index: hot (last 7 days) or cold (older)
	indexName := s.indexForTweet(tweet.CreatedAt)
	url := fmt.Sprintf("%s/%s/_doc/%d", s.esURL, indexName, tweet.ID)

	body, err := json.Marshal(tweet)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("index tweet: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("elasticsearch: HTTP %d", resp.StatusCode)
	}
	return nil
}

// BulkIndex sends a batch of tweets using Elasticsearch Bulk API
// Much more efficient: reduces HTTP overhead from N requests to 1
func (s *SearchIndexer) BulkIndex(ctx context.Context, tweets []TweetDocument) error {
	var buf strings.Builder
	for _, tweet := range tweets {
		// Action line
		meta := fmt.Sprintf(`{"index":{"_index":"%s","_id":"%d"}}`, s.indexForTweet(tweet.CreatedAt), tweet.ID)
		buf.WriteString(meta)
		buf.WriteByte('\n')

		// Document line
		doc, _ := json.Marshal(tweet)
		buf.Write(doc)
		buf.WriteByte('\n')
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.esURL+"/_bulk", strings.NewReader(buf.String()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("bulk index: %w", err)
	}
	defer resp.Body.Close()

	// The Bulk API answers 200 even when individual documents fail, so the
	// status code alone is not enough. Check the per-item errors flag or the
	// batch silently loses tweets.
	var br struct {
		Errors bool `json:"errors"`
		Items  []map[string]struct {
			Status int             `json:"status"`
			Error  json.RawMessage `json:"error"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&br); err != nil {
		return fmt.Errorf("bulk index: decode response: %w", err)
	}
	if br.Errors {
		failed := 0
		for _, item := range br.Items {
			for _, r := range item {
				if r.Status >= 400 {
					failed++
				}
			}
		}
		return fmt.Errorf("bulk index: %d of %d documents failed", failed, len(tweets))
	}
	return nil
}

// Search queries Elasticsearch for tweets matching a query
type SearchRequest struct {
	Query   string    `json:"query"`
	Hashtag string    `json:"hashtag,omitempty"`
	UserID  int64     `json:"user_id,omitempty"`
	Since   time.Time `json:"since,omitempty"`
	SortBy  string    `json:"sort_by"` // "relevance" or "recency"
	Limit   int       `json:"limit"`
}

type SearchResult struct {
	Tweets []TweetDocument `json:"tweets"`
	Total  int             `json:"total"`
}

func (s *SearchIndexer) Search(ctx context.Context, req SearchRequest) (*SearchResult, error) {
	query := buildESQuery(req)
	body, _ := json.Marshal(query)

	// Query the hot index and the monthly archives in one shot. The wildcard
	// costs a little planning time but means a search for last month's tweets
	// does not come back empty.
	indexName := "tweets-hot,tweets-*"
	url := fmt.Sprintf("%s/%s/_search", s.esURL, indexName)

	httpReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	defer resp.Body.Close()

	var result esSearchResponse
	json.NewDecoder(resp.Body).Decode(&result)

	tweets := make([]TweetDocument, 0, len(result.Hits.Hits))
	for _, hit := range result.Hits.Hits {
		tweets = append(tweets, hit.Source)
	}

	return &SearchResult{Tweets: tweets, Total: result.Hits.Total.Value}, nil
}

func (s *SearchIndexer) indexForTweet(t time.Time) string {
	if time.Since(t) < 7*24*time.Hour {
		return "tweets-hot"
	}
	return fmt.Sprintf("tweets-%d-%02d", t.Year(), t.Month())
}

func buildESQuery(req SearchRequest) map[string]any {
	must := []map[string]any{}

	if req.Query != "" {
		must = append(must, map[string]any{
			"match": map[string]any{"text": req.Query},
		})
	}
	if req.Hashtag != "" {
		must = append(must, map[string]any{
			"term": map[string]any{"hashtags": req.Hashtag},
		})
	}
	// UserID and Since are part of the request contract, so they have to reach
	// the query. Dropping them here would silently widen every filtered search
	// into a global one.
	if req.UserID != 0 {
		must = append(must, map[string]any{
			"term": map[string]any{"user_id": req.UserID},
		})
	}
	if !req.Since.IsZero() {
		must = append(must, map[string]any{
			"range": map[string]any{
				"created_at": map[string]any{"gte": req.Since.UTC().Format(time.RFC3339)},
			},
		})
	}

	order := []map[string]any{{"created_at": "desc"}}
	if req.SortBy == "relevance" {
		order = []map[string]any{{"_score": "desc"}}
	}

	size := req.Limit
	if size <= 0 {
		size = 20
	}

	return map[string]any{
		"query": map[string]any{
			"bool": map[string]any{"must": must},
		},
		"sort": order,
		"size": size,
	}
}

type esSearchResponse struct {
	Hits struct {
		Total struct{ Value int } `json:"total"`
		Hits  []struct {
			Source TweetDocument `json:"_source"`
		} `json:"hits"`
	} `json:"hits"`
}
```

### 5. Snowflake ID Generator

Every tweet needs a globally unique ID, but auto-increment IDs create a write bottleneck on a single database shard, and UUIDs are not sortable by time. Snowflake IDs solve both problems by encoding the current timestamp, datacenter ID, and a per-node sequence number into a single 64-bit integer. Because the timestamp occupies the most significant bits, these IDs are naturally time-ordered, which means you can use them directly as Redis sorted set scores and for cursor-based pagination.

The subtle part is the clock. Uniqueness rests entirely on the assumption that time only moves forward, and on a real machine it does not: NTP corrections step the wall clock backwards routinely. A generator that shrugs and keeps going will replay a millisecond it has already issued and mint IDs that collide with tweets already in the database. The implementation below refuses to issue an ID while the clock is behind its high-water mark, because a failed write can be retried and a duplicate tweet ID cannot be undone. Note also that IDs are read back as strings from some stores, and a string sort is not a chronological sort once IDs cross a digit-count boundary. Compare them as int64.

```go
package id

import (
	"fmt"
	"sync"
	"time"
)

// SnowflakeGenerator generates unique 64-bit IDs
// Bit layout: [1 bit unused][41 bits timestamp ms][5 bits datacenter][5 bits worker][12 bits sequence]
// Properties: time-ordered, sortable without DB query, 4,096 IDs/ms per node
type SnowflakeGenerator struct {
	mu           sync.Mutex
	epoch        int64 // custom epoch (ms since 2024-01-01)
	datacenterID int64
	workerID     int64
	sequence     int64
	lastTime     int64
}

const (
	workerBits      = 5
	datacenterBits  = 5
	sequenceBits    = 12
	maxWorkerID     = -1 ^ (-1 << workerBits)
	maxDatacenterID = -1 ^ (-1 << datacenterBits)
	maxSequence     = -1 ^ (-1 << sequenceBits)
	workerShift     = sequenceBits
	datacenterShift = sequenceBits + workerBits
	timestampShift  = sequenceBits + workerBits + datacenterBits
)

// NewSnowflakeGenerator validates the node coordinates before use. An ID above
// the field width would overflow into the neighbouring bits and hand out IDs
// that decode to the wrong node and the wrong timestamp.
func NewSnowflakeGenerator(datacenterID, workerID int64) (*SnowflakeGenerator, error) {
	if datacenterID < 0 || datacenterID > maxDatacenterID {
		return nil, fmt.Errorf("datacenter id %d out of range [0,%d]", datacenterID, maxDatacenterID)
	}
	if workerID < 0 || workerID > maxWorkerID {
		return nil, fmt.Errorf("worker id %d out of range [0,%d]", workerID, maxWorkerID)
	}
	return &SnowflakeGenerator{
		// Custom epoch: 2024-01-01 UTC expressed in Unix milliseconds. Counting
		// from here instead of 1970 buys back 54 years of the 41-bit field, so
		// the generator runs until roughly 2093.
		epoch:        1704067200000,
		datacenterID: datacenterID,
		workerID:     workerID,
	}, nil
}

// Next generates a new unique ID.
func (g *SnowflakeGenerator) Next() (int64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now().UnixMilli() - g.epoch

	switch {
	case now < g.lastTime:
		// The wall clock went backwards, almost always an NTP correction. If we
		// carried on we would replay a millisecond we have already issued and
		// hand out IDs that collide with live tweets. Refuse instead: a failed
		// write is recoverable, a duplicate tweet ID is not.
		return 0, fmt.Errorf("clock moved backwards by %dms, refusing to issue an id", g.lastTime-now)
	case now == g.lastTime:
		g.sequence = (g.sequence + 1) & maxSequence
		if g.sequence == 0 {
			// 4,096 IDs issued this millisecond. Spin to the next one.
			for now <= g.lastTime {
				now = time.Now().UnixMilli() - g.epoch
			}
		}
	default:
		g.sequence = 0
	}
	g.lastTime = now

	return (now << timestampShift) |
		(g.datacenterID << datacenterShift) |
		(g.workerID << workerShift) |
		g.sequence, nil
}

// ExtractTimestamp decodes when an ID was created
func (g *SnowflakeGenerator) ExtractTimestamp(id int64) time.Time {
	ms := (id >> timestampShift) + g.epoch
	return time.UnixMilli(ms)
}
```

---
