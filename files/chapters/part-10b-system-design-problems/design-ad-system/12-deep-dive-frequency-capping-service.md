## Deep Dive: Frequency Capping Service

Frequency capping limits how many times a specific user sees the same ad within a given time window (hourly, daily, or weekly). Without frequency capping, a high-budget campaign could show the same ad to the same user hundreds of times per day, wasting advertiser money and annoying users. This service uses Redis keys with time-bucketed suffixes (hour, date, ISO week) so that counters naturally expire via TTL. The check runs during the auction before bidding, and the counter increments after an ad is successfully served, ensuring accurate counts even under high concurrency.

```go
package frequency

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type FrequencyCapService struct{ rdb *redis.Client }

type FrequencyCap struct {
	CampaignID                        string
	MaxPerHour, MaxPerDay, MaxPerWeek int
}

func (s *FrequencyCapService) CanShowAd(ctx context.Context, userID, campaignID string, cap FrequencyCap) (bool, error) {
	now := time.Now()
	if cap.MaxPerHour > 0 {
		c, _ := s.rdb.Get(ctx, fmt.Sprintf("freq:%s:%s:h:%s", userID, campaignID, now.Format("2006010215"))).Int()
		if c >= cap.MaxPerHour {
			return false, nil
		}
	}
	if cap.MaxPerDay > 0 {
		c, _ := s.rdb.Get(ctx, fmt.Sprintf("freq:%s:%s:d:%s", userID, campaignID, now.Format("20060102"))).Int()
		if c >= cap.MaxPerDay {
			return false, nil
		}
	}
	if cap.MaxPerWeek > 0 {
		y, w := now.ISOWeek()
		c, _ := s.rdb.Get(ctx, fmt.Sprintf("freq:%s:%s:w:%d%02d", userID, campaignID, y, w)).Int()
		if c >= cap.MaxPerWeek {
			return false, nil
		}
	}
	return true, nil
}

func (s *FrequencyCapService) RecordImpression(ctx context.Context, userID, campaignID string) error {
	now := time.Now()
	pipe := s.rdb.Pipeline()
	hk := fmt.Sprintf("freq:%s:%s:h:%s", userID, campaignID, now.Format("2006010215"))
	pipe.Incr(ctx, hk)
	pipe.Expire(ctx, hk, 2*time.Hour)
	dk := fmt.Sprintf("freq:%s:%s:d:%s", userID, campaignID, now.Format("20060102"))
	pipe.Incr(ctx, dk)
	pipe.Expire(ctx, dk, 25*time.Hour)
	y, w := now.ISOWeek()
	wk := fmt.Sprintf("freq:%s:%s:w:%d%02d", userID, campaignID, y, w)
	pipe.Incr(ctx, wk)
	pipe.Expire(ctx, wk, 8*24*time.Hour)
	_, err := pipe.Exec(ctx)
	return err
}
```

---
