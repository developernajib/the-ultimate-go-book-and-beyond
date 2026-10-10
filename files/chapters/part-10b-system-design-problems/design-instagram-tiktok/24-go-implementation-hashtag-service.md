## Go Implementation: Hashtag Service

Hashtags drive content discovery and trending topics on social platforms. This service extracts hashtags from captions using regex, tracks usage in hourly time windows using Redis sorted sets, and detects trending tags by comparing current-hour counts against historical averages. A tag is considered "trending" when its current velocity exceeds 1.5x the 24-hour average, which filters out consistently popular tags (like #love) and surfaces genuinely spiking topics. Brand-new tags have no history to average, so they qualify once they clear a minimum volume floor instead of being hidden by a zero baseline.

```go
package hashtag

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// HashtagService manages hashtag extraction, trending, and search
type HashtagService struct {
	rdb      *redis.ClusterClient
	esClient ElasticsearchClient
}

var hashtagRegex = regexp.MustCompile(`#(\w+)`)

// ExtractHashtags parses hashtags from a caption
func ExtractHashtags(caption string) []string {
	matches := hashtagRegex.FindAllStringSubmatch(caption, -1)
	var tags []string
	seen := make(map[string]bool)
	for _, m := range matches {
		tag := strings.ToLower(m[1])
		if !seen[tag] && len(tag) <= 100 {
			tags = append(tags, tag)
			seen[tag] = true
		}
	}
	return tags
}

// RecordHashtagUsage increments hashtag counters for trending detection
func (s *HashtagService) RecordHashtagUsage(ctx context.Context, tags []string) {
	if len(tags) == 0 {
		return
	}

	pipe := s.rdb.Pipeline()
	now := time.Now()
	hourKey := fmt.Sprintf("hashtag:hourly:%s", now.Format("2006010215"))

	for _, tag := range tags {
		// Increment hourly counter (for trending)
		pipe.ZIncrBy(ctx, hourKey, 1, tag)
		// Increment all-time counter
		pipe.ZIncrBy(ctx, "hashtag:alltime", 1, tag)
	}
	pipe.Expire(ctx, hourKey, 25*time.Hour)
	pipe.Exec(ctx)
}

// GetTrendingHashtags returns hashtags with highest velocity
func (s *HashtagService) GetTrendingHashtags(ctx context.Context, limit int) ([]TrendingHashtag, error) {
	now := time.Now()
	currentHour := fmt.Sprintf("hashtag:hourly:%s", now.Format("2006010215"))

	// Get top hashtags from current hour
	results, err := s.rdb.ZRevRangeWithScores(ctx, currentHour, 0, int64(limit*3)).Result()
	if err != nil {
		return nil, err
	}

	var trending []TrendingHashtag
	for _, r := range results {
		tag := r.Member.(string)
		currentCount := int64(r.Score)

		// Compare to previous day average. A brand-new tag has no history,
		// so it needs a volume floor instead of a ratio test
		yesterdayAvg := s.getHistoricalAvg(ctx, tag, 24)
		velocity := float64(currentCount)
		if yesterdayAvg > 0 {
			velocity = float64(currentCount) / yesterdayAvg
			if velocity <= 1.5 {
				continue
			}
		} else if currentCount < 100 {
			continue // too little signal to call it a trend
		}

		trending = append(trending, TrendingHashtag{
			Tag:      tag,
			Count:    currentCount,
			Velocity: velocity,
		})
	}

	if len(trending) > limit {
		trending = trending[:limit]
	}
	return trending, nil
}

type TrendingHashtag struct {
	Tag      string  `json:"tag"`
	Count    int64   `json:"count"`
	Velocity float64 `json:"velocity"` // current/historical ratio
}

func (s *HashtagService) getHistoricalAvg(ctx context.Context, tag string, hours int) float64 {
	total := float64(0)
	now := time.Now()
	for i := 1; i <= hours; i++ {
		key := fmt.Sprintf("hashtag:hourly:%s", now.Add(-time.Duration(i)*time.Hour).Format("2006010215"))
		count, _ := s.rdb.ZScore(ctx, key, tag).Result()
		total += count
	}
	return total / float64(hours)
}
```

---
