## Go Implementation: Story Service

This service implements the full lifecycle of ephemeral stories: creation with automatic 24-hour TTL, feed assembly with unseen-first ordering, and view tracking. Cassandra's TTL feature handles the expiration at the storage layer, while Redis sorted sets (keyed by expiry timestamp) enable efficient filtering of active stories. The story feed sorts groups so that users with unseen stories appear first, which is the interaction pattern users expect from Instagram and Snapchat. Note that the key design decisions section tracked seen state client-side to save writes. The Redis seen-set shown here is the server-side alternative: it pays those writes to gain cross-device consistency and to power the story owner's viewer list.

```go
package story

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/gocql/gocql"
	"github.com/redis/go-redis/v9"
)

// StoryService manages ephemeral content (24h expiry)
type StoryService struct {
	session *gocql.Session
	rdb     *redis.ClusterClient
}

type Story struct {
	ID        gocql.UUID `json:"id"`
	UserID    gocql.UUID `json:"user_id"`
	MediaURL  string     `json:"media_url"`
	MediaType string     `json:"media_type"`
	Caption   string     `json:"caption"`
	ExpiresAt time.Time  `json:"expires_at"`
	CreatedAt time.Time  `json:"created_at"`
}

// CreateStory publishes a new story with 24h TTL
func (s *StoryService) CreateStory(ctx context.Context, userID gocql.UUID, mediaURL, mediaType, caption string) (*Story, error) {
	story := &Story{
		ID:        gocql.TimeUUID(),
		UserID:    userID,
		MediaURL:  mediaURL,
		MediaType: mediaType,
		Caption:   caption,
		ExpiresAt: time.Now().Add(24 * time.Hour),
		CreatedAt: time.Now(),
	}

	// Insert with Cassandra TTL (auto-delete after 24h)
	err := s.session.Query(`
		INSERT INTO stories (user_id, story_id, media_url, media_type, caption, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		USING TTL 86400`,
		story.UserID, story.ID, story.MediaURL, story.MediaType,
		story.Caption, story.ExpiresAt, story.CreatedAt,
	).WithContext(ctx).Exec()
	if err != nil {
		return nil, err
	}

	// Add to Redis sorted set (for story feed ordering)
	key := fmt.Sprintf("stories:%s", userID)
	s.rdb.ZAdd(ctx, key, redis.Z{
		Score:  float64(story.ExpiresAt.Unix()),
		Member: story.ID.String(),
	})
	s.rdb.Expire(ctx, key, 25*time.Hour) // slightly longer than 24h

	return story, nil
}

// GetStoryFeed returns story groups for followed users
func (s *StoryService) GetStoryFeed(ctx context.Context, userID string, following []string) ([]StoryGroup, error) {
	var groups []StoryGroup

	for _, followedID := range following {
		key := fmt.Sprintf("stories:%s", followedID)

		// Get non-expired stories with their expiry scores
		now := float64(time.Now().Unix())
		entries, err := s.rdb.ZRangeByScoreWithScores(ctx, key, &redis.ZRangeBy{
			Min: fmt.Sprintf("%f", now),
			Max: "+inf",
		}).Result()
		if err != nil || len(entries) == 0 {
			continue
		}

		storyIDs := make([]string, len(entries))
		for i, z := range entries {
			storyIDs[i] = z.Member.(string)
		}

		// Check if user has seen all stories
		seenKey := fmt.Sprintf("story:seen:%s:%s", userID, followedID)
		seenCount, _ := s.rdb.SCard(ctx, seenKey).Result()
		hasUnseen := int(seenCount) < len(storyIDs)

		groups = append(groups, StoryGroup{
			UserID:    followedID,
			StoryIDs:  storyIDs,
			HasUnseen: hasUnseen,
			LatestAt:  entries[len(entries)-1].Score, // newest story's expiry
		})
	}

	// Sort: unseen stories first, then by recency of the newest story.
	// TimeUUID strings do not sort chronologically, so use the sorted-set
	// score (expiry = created_at + 24h) as the recency proxy
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].HasUnseen != groups[j].HasUnseen {
			return groups[i].HasUnseen
		}
		return groups[i].LatestAt > groups[j].LatestAt
	})

	return groups, nil
}

// MarkStoryViewed records that a user viewed a story
func (s *StoryService) MarkStoryViewed(ctx context.Context, viewerID, storyOwnerID, storyID string) {
	seenKey := fmt.Sprintf("story:seen:%s:%s", viewerID, storyOwnerID)
	s.rdb.SAdd(ctx, seenKey, storyID)
	s.rdb.Expire(ctx, seenKey, 25*time.Hour)

	// Increment view count
	s.rdb.Incr(ctx, fmt.Sprintf("story:views:%s", storyID))
}

type StoryGroup struct {
	UserID    string
	StoryIDs  []string
	HasUnseen bool
	LatestAt  float64 // expiry timestamp of the newest story
}
```

---
