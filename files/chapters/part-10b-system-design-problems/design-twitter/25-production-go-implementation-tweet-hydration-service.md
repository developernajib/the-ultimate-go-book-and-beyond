## Production Go Implementation: Tweet Hydration Service

The timeline cache stores only tweet IDs to save memory, but the client needs full tweet objects with author info, media URLs, and engagement counts. The Hydration Service bridges this gap by batch-fetching tweet data from cache (with DB fallback), collecting unique author IDs, fetching user profiles in one pipelined call, and checking whether the viewer has liked or retweeted each tweet. Batching all of these lookups is critical, without it, hydrating a 20-tweet timeline page would require 60+ individual round trips instead of a handful.

Hydration looks like plumbing, which is exactly why it hides bugs that no test notices and every user sees.

The first is ordering. The timeline arrives as an ordered list of IDs and the order *is* the product. If cache hits come back first and database misses get appended behind them, the page renders with yesterday's tweet above this morning's, and nothing in the system reports an error. The fix is to treat the input slice as the authority and index results back into their original positions rather than accumulating them in completion order.

The second is that a viewer-relative field which is never computed does not look broken, it looks like `false`. An `IsLiked` that is always false renders every heart as hollow, including on tweets the viewer liked ten seconds ago. Compute it or delete the field.

The third is fanning out one goroutine per user, each doing its own round trip. That is not batching, it is the N round trips this service exists to avoid, wearing a concurrency costume. One pipelined call beats fifty parallel ones.

```go
package hydration

import (
	"context"
	"fmt"
)

// HydrationService enriches tweet IDs with full tweet objects.
// The timeline cache stores only IDs, so hydration happens at read time.
type HydrationService struct {
	tweetCache TweetCache // Redis hash per tweet
	tweetDB    TweetStore // MySQL (fallback)
	userCache  UserCache  // Redis hash per user
	engagement EngagementCache
}

type HydratedTweet struct {
	ID           int64    `json:"id"`
	Text         string   `json:"text"`
	UserID       int64    `json:"user_id"`
	Username     string   `json:"username"`
	DisplayName  string   `json:"display_name"`
	AvatarURL    string   `json:"avatar_url"`
	IsVerified   bool     `json:"is_verified"`
	MediaURLs    []string `json:"media_urls"`
	LikeCount    int64    `json:"like_count"`
	RetweetCount int64    `json:"retweet_count"`
	ReplyCount   int64    `json:"reply_count"`
	IsLiked      bool     `json:"is_liked"`
	IsRetweeted  bool     `json:"is_retweeted"`
}

// HydrateBatch converts tweet IDs to full tweet objects, preserving the order
// of tweetIDs. That order is the timeline, so it is a correctness requirement
// and not a cosmetic one.
func (s *HydrationService) HydrateBatch(ctx context.Context, tweetIDs []int64, viewerID int64) ([]HydratedTweet, error) {
	// Step 1: Batch fetch tweets from cache (one pipelined call)
	byID, missingTweetIDs, err := s.tweetCache.GetBatch(ctx, tweetIDs)
	if err != nil {
		return nil, fmt.Errorf("cache batch: %w", err)
	}

	// Step 2: Fetch cache misses from the DB and merge them into the same map.
	// Keying by ID instead of appending to a slice is what keeps the misses
	// from drifting to the bottom of the page.
	if len(missingTweetIDs) > 0 {
		dbTweets, err := s.tweetDB.GetBatch(ctx, missingTweetIDs)
		if err != nil {
			return nil, fmt.Errorf("db batch: %w", err)
		}
		backfill := make([]Tweet, 0, len(dbTweets))
		for _, t := range dbTweets {
			byID[t.ID] = t
			backfill = append(backfill, t)
		}
		// One pipelined backfill, not one goroutine per miss. Detached from the
		// request context so a client disconnect does not abort the warm-up.
		if len(backfill) > 0 {
			s.tweetCache.SetBatch(context.WithoutCancel(ctx), backfill)
		}
	}

	// Step 3: Collect unique author IDs and fetch them in one call
	userIDs := make([]int64, 0, len(byID))
	seen := make(map[int64]bool, len(byID))
	for _, t := range byID {
		if !seen[t.UserID] {
			seen[t.UserID] = true
			userIDs = append(userIDs, t.UserID)
		}
	}
	users, err := s.userCache.GetBatch(ctx, userIDs)
	if err != nil {
		return nil, fmt.Errorf("user batch: %w", err)
	}

	// Step 4: Check the viewer's like/retweet status in one pipelined call.
	// viewerID 0 is a logged-out reader: there is nothing to look up, and
	// asking would key the cache on a user that does not exist.
	liked := map[int64]bool{}
	retweeted := map[int64]bool{}
	if viewerID != 0 {
		liked, retweeted, err = s.engagement.CheckBatch(ctx, viewerID, tweetIDs)
		if err != nil {
			return nil, fmt.Errorf("engagement batch: %w", err)
		}
	}

	// Step 5: Assemble in the caller's order
	result := make([]HydratedTweet, 0, len(tweetIDs))
	for _, id := range tweetIDs {
		t, ok := byID[id]
		if !ok {
			continue // deleted between the timeline read and now
		}
		user, ok := users[t.UserID]
		if !ok {
			// A tweet with no resolvable author renders as a blank row. Drop it
			// rather than shipping an empty username to the client.
			continue
		}
		result = append(result, HydratedTweet{
			ID:           t.ID,
			Text:         t.Text,
			UserID:       t.UserID,
			Username:     user.Username,
			DisplayName:  user.DisplayName,
			AvatarURL:    user.AvatarURL,
			IsVerified:   user.IsVerified,
			MediaURLs:    t.MediaURLs,
			LikeCount:    t.LikeCount,
			RetweetCount: t.RetweetCount,
			ReplyCount:   t.ReplyCount,
			IsLiked:      liked[t.ID],
			IsRetweeted:  retweeted[t.ID],
		})
	}

	return result, nil
}

type UserInfo struct {
	Username    string
	DisplayName string
	AvatarURL   string
	IsVerified  bool
}
```

---
