## Go Implementation: Personalization Service

Personalization makes autocomplete significantly more useful by boosting suggestions the user has searched for before. This service stores each user's recent search history in a Redis sorted set, keyed by timestamp so the most recent searches rank highest. When a suggestion request includes a user ID, the service merges personal history with global suggestions, giving the user a blend of relevant past queries and popular completions.

```go
package personalization

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// PersonalizationService manages per-user search history
type PersonalizationService struct {
	rdb *redis.ClusterClient
}

type PersonalSuggestion struct {
	Term       string
	Score      float64
	SearchedAt time.Time
}

// GetUserHistory returns recent searches matching a prefix
func (s *PersonalizationService) GetUserHistory(ctx context.Context, userID string, limit int) ([]PersonalSuggestion, error) {
	key := fmt.Sprintf("user:history:%s", userID)

	// Get recent searches (sorted set, score = timestamp)
	results, err := s.rdb.ZRevRangeWithScores(ctx, key, 0, int64(limit)-1).Result()
	if err != nil {
		return nil, err
	}

	var suggestions []PersonalSuggestion
	for _, r := range results {
		suggestions = append(suggestions, PersonalSuggestion{
			Term:       r.Member.(string),
			Score:      r.Score,
			SearchedAt: time.Unix(int64(r.Score), 0),
		})
	}
	return suggestions, nil
}

// GetUserHistoryForPrefix returns history entries matching a prefix
func (s *PersonalizationService) GetUserHistoryForPrefix(ctx context.Context, userID, prefix string, limit int) ([]PersonalSuggestion, error) {
	all, err := s.GetUserHistory(ctx, userID, 100) // get last 100
	if err != nil {
		return nil, err
	}

	prefix = strings.ToLower(prefix)
	var matching []PersonalSuggestion
	for _, h := range all {
		if strings.HasPrefix(strings.ToLower(h.Term), prefix) {
			matching = append(matching, h)
			if len(matching) >= limit {
				break
			}
		}
	}
	return matching, nil
}

// RecordUserSearch adds a search to user history
func (s *PersonalizationService) RecordUserSearch(ctx context.Context, userID, term string) error {
	key := fmt.Sprintf("user:history:%s", userID)

	pipe := s.rdb.Pipeline()
	pipe.ZAdd(ctx, key, redis.Z{
		Score:  float64(time.Now().Unix()),
		Member: term,
	})
	// Keep only last 100 searches
	pipe.ZRemRangeByRank(ctx, key, 0, -101)
	// Expire after 30 days of inactivity
	pipe.Expire(ctx, key, 30*24*time.Hour)

	_, err := pipe.Exec(ctx)
	return err
}

// DeleteUserHistory removes all or specific terms from history
func (s *PersonalizationService) DeleteUserHistory(ctx context.Context, userID string, term string) error {
	key := fmt.Sprintf("user:history:%s", userID)
	if term == "" {
		return s.rdb.Del(ctx, key).Err()
	}
	return s.rdb.ZRem(ctx, key, term).Err()
}
```

---
