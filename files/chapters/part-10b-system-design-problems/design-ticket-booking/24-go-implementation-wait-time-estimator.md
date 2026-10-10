## Go Implementation: Wait Time Estimator

Users sitting in a virtual queue need to know how long they will wait, otherwise they abandon the process. The wait time estimator derives an estimate from the user's rank and the observed admission throughput over the last few minutes. It also reports a confidence score, computed from how many minutes of data it has and how much the rate has varied across them, so the frontend can show a range ("5 to 10 minutes") when the signal is noisy and a number when it is not.

```go
package queue

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

// WaitTimeEstimator predicts how long a user will wait in queue
type WaitTimeEstimator struct {
	rdb *redis.Client
}

type WaitEstimate struct {
	Position         int64   `json:"position"`
	EstimatedMinutes int     `json:"estimated_minutes"`
	Confidence       float64 `json:"confidence"` // 0-1
	QueueLength      int64   `json:"queue_length"`
	AdmissionRate    int64   `json:"admission_rate_per_min"`
}

// defaultAdmissionRate is the cold-start assumption before any minute bucket
// has been filled. It matches the rate the admission controller is configured
// to hold, 10K users/min, so the first estimate a user sees is not off by an
// order of magnitude from every estimate after it.
const defaultAdmissionRate int64 = 10_000

// EstimateWait calculates expected wait time based on current throughput
func (e *WaitTimeEstimator) EstimateWait(ctx context.Context, eventID, userID string) (*WaitEstimate, error) {
	// Get user's position
	position, err := e.rdb.ZRank(ctx, queueKey(eventID), userID).Result()
	if err != nil {
		return nil, fmt.Errorf("user not in queue")
	}

	queueLength, err := e.rdb.ZCard(ctx, queueKey(eventID)).Result()
	if err != nil {
		return nil, fmt.Errorf("queue length: %w", err)
	}

	rates, err := e.recentRates(ctx, eventID, 3)
	if err != nil {
		return nil, err
	}

	throughput := mean(rates)
	if throughput <= 0 {
		throughput = defaultAdmissionRate
	}

	waitMinutes := int(math.Ceil(float64(position) / float64(throughput)))

	return &WaitEstimate{
		Position:         position + 1,
		EstimatedMinutes: waitMinutes,
		Confidence:       confidenceFrom(rates),
		QueueLength:      queueLength,
		AdmissionRate:    throughput,
	}, nil
}

// recentRates reads the last n completed minute buckets. The current minute is
// skipped: it is still filling, so dividing by it understates the rate and
// tells everyone in line that the wait just got longer.
func (e *WaitTimeEstimator) recentRates(ctx context.Context, eventID string, n int) ([]int64, error) {
	now := time.Now()
	keys := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		keys = append(keys, throughputKey(eventID, now.Add(-time.Duration(i)*time.Minute)))
	}

	vals, err := e.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("read admission rates: %w", err)
	}

	rates := make([]int64, 0, n)
	for _, v := range vals {
		s, ok := v.(string)
		if !ok { // key absent: no admissions logged that minute
			continue
		}
		var r int64
		if _, err := fmt.Sscanf(s, "%d", &r); err == nil && r > 0 {
			rates = append(rates, r)
		}
	}
	return rates, nil
}

// confidenceFrom scores how much to trust the estimate, using both the amount
// of data and its stability. A single sample is a guess - three samples that
// agree are a trend - three that disagree wildly mean the rate is being
// throttled or the controller is struggling, and the UI should widen its range
// rather than promise a number.
func confidenceFrom(rates []int64) float64 {
	switch len(rates) {
	case 0:
		return 0.2 // cold start: nothing but the configured default
	case 1:
		return 0.5
	}

	avg := float64(mean(rates))
	if avg <= 0 {
		return 0.2
	}
	// Coefficient of variation: standard deviation relative to the mean.
	var sumSq float64
	for _, r := range rates {
		d := float64(r) - avg
		sumSq += d * d
	}
	cv := math.Sqrt(sumSq/float64(len(rates))) / avg

	// cv of 0 (perfectly steady) -> 0.9 - cv of 0.5 or worse -> 0.3.
	conf := 0.9 - cv*1.2
	return math.Max(0.3, math.Min(0.9, conf))
}

func mean(xs []int64) int64 {
	if len(xs) == 0 {
		return 0
	}
	var sum int64
	for _, x := range xs {
		sum += x
	}
	return sum / int64(len(xs))
}

// ScanQueuePositions walks the queue in bounded chunks, invoking fn for each
// member and its 1-based position.
//
// Note what this is not: a way to answer "what is my position" per request.
// A single ZRANGE over the whole key, which is the tempting one-liner, pulls
// all five million members into one reply and into one map, which is hundreds
// of megabytes on both the Redis and the client side, for an answer ZRANK
// already gives in O(log N). Use EstimateWait for a user. Use this only for
// offline work such as building bucketed status pages or analytics, and run it
// off a replica.
func (e *WaitTimeEstimator) ScanQueuePositions(ctx context.Context, eventID string, chunk int64, fn func(userID string, position int64) error) error {
	if chunk <= 0 {
		chunk = 1000
	}
	for start := int64(0); ; start += chunk {
		members, err := e.rdb.ZRange(ctx, queueKey(eventID), start, start+chunk-1).Result()
		if err != nil {
			return err
		}
		if len(members) == 0 {
			return nil
		}
		for i, userID := range members {
			if err := fn(userID, start+int64(i)+1); err != nil {
				return err
			}
		}
	}
}

func queueKey(eventID string) string { return fmt.Sprintf("queue:waiting:%s", eventID) }
func throughputKey(eventID string, t time.Time) string {
	return fmt.Sprintf("throughput:%s:%s", eventID, t.Format("200601021504"))
}
```

---
