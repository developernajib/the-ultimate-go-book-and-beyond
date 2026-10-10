## API Design

The API layer defines the contract between clients (mobile apps, web) and the backend services. Each endpoint maps to a specific service behind the API gateway. Notice the use of cursor-based pagination with `since_id` and `max_id` instead of page numbers, this is critical for feeds where new content is constantly being inserted. The response types are kept flat and denormalized so that clients can render a tweet without making additional API calls.

```go
package api

import "time"

// POST /api/v1/tweets
// Idempotency-Key header carries a client-generated UUID. A retry after a
// timeout replays the same key, and the service returns the original tweet
// instead of posting a duplicate.
type CreateTweetAPI struct {
	Text         string   `json:"text" validate:"max=280"`
	MediaIDs     []string `json:"media_ids,omitempty"`
	RetweetID    *int64   `json:"retweet_id,omitempty"`
	ReplyToID    *int64   `json:"reply_to_id,omitempty"`
	QuoteTweetID *int64   `json:"quote_tweet_id,omitempty"`
}

// TweetResponse is flat and denormalized so a client can render a tweet
// without a second round trip. IsLiked is viewer-relative, so this struct is
// never shared between users in a cache.
type TweetResponse struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	Username     string    `json:"username"`
	Text         string    `json:"text"`
	MediaURLs    []string  `json:"media_urls,omitempty"`
	Hashtags     []string  `json:"hashtags"`
	LikeCount    int64     `json:"like_count"`
	RetweetCount int64     `json:"retweet_count"`
	ReplyCount   int64     `json:"reply_count"`
	IsLiked      bool      `json:"is_liked"`
	CreatedAt    time.Time `json:"created_at"`
}

// GET /api/v1/timeline/home?since_id=X&max_id=Y&count=20
type TimelineResponse struct {
	Tweets  []TweetResponse `json:"tweets"`
	HasMore bool            `json:"has_more"`
}

// GET /api/v1/search/tweets?q=golang&sort=relevance
type TweetSearchResp struct {
	Tweets []TweetResponse `json:"tweets"`
	Total  int             `json:"total"`
}

// GET /api/v1/trends?region=US
type TrendItem struct {
	Hashtag  string  `json:"hashtag"`
	Count    int64   `json:"count"`
	Velocity float64 `json:"velocity"`
}
```

---
