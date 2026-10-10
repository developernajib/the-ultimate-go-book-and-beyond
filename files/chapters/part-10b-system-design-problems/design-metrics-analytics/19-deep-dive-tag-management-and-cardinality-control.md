## Deep Dive: Tag Management and Cardinality Control

High-cardinality tags are one of the most common causes of catastrophic performance degradation in metrics systems. A tag like `user_id` or `request_id` that takes millions of distinct values creates a separate time series for every unique combination, overwhelming the storage engine and making queries impossibly slow. The `TagManager` below enforces guardrails at ingestion time: it validates tags against a pre-approved allowlist of known-safe keys, drops or truncates tags that violate policy, and tracks per-metric tag cardinality with Redis HyperLogLog counters so operators get alerted before an explosion rather than after. Blocking high-cardinality tags at the edge, before they reach ClickHouse or Prometheus, is far cheaper than dealing with cardinality explosions after the fact.

```go
package tagmgmt

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// TagManager enforces tag policies and prevents cardinality explosion
type TagManager struct {
	rdb          *redis.Client
	maxTags      int
	maxTagKeyLen int
	maxTagValLen int
	allowedKeys  map[string]bool // pre-approved tag keys
}

type TagValidationResult struct {
	Valid   bool
	Dropped []string // tags that were dropped
	Reason  string
}

// ValidateTags checks incoming metric tags against policies
func (m *TagManager) ValidateTags(ctx context.Context, metricName string, tags map[string]string) TagValidationResult {
	result := TagValidationResult{Valid: true}

	// Check tag count
	if len(tags) > m.maxTags {
		result.Valid = false
		result.Reason = fmt.Sprintf("too many tags: %d (max %d)", len(tags), m.maxTags)
		return result
	}

	// Validate each tag
	for key, val := range tags {
		// Key length check
		if len(key) > m.maxTagKeyLen {
			result.Dropped = append(result.Dropped, key)
			delete(tags, key)
			continue
		}

		// Value length check
		if len(val) > m.maxTagValLen {
			tags[key] = val[:m.maxTagValLen] // truncate
		}

		// Allowed keys check (if configured)
		if len(m.allowedKeys) > 0 && !m.allowedKeys[key] {
			result.Dropped = append(result.Dropped, key)
			delete(tags, key)
			continue
		}
	}

	// Track cardinality per metric. The map is copied because the caller
	// keeps mutating and reusing it on the hot path, and the goroutine must
	// not race on it. The context is detached so the write survives the
	// request finishing.
	snapshot := make(map[string]string, len(tags))
	for k, v := range tags {
		snapshot[k] = v
	}
	go m.trackCardinality(context.WithoutCancel(ctx), metricName, snapshot)

	if len(result.Dropped) > 0 {
		result.Reason = fmt.Sprintf("dropped tags: %v", result.Dropped)
	}
	return result
}

// trackCardinality monitors unique tag combinations per metric
func (m *TagManager) trackCardinality(ctx context.Context, metricName string, tags map[string]string) {
	for key, val := range tags {
		cardKey := fmt.Sprintf("cardinality:%s:%s", metricName, key)
		m.rdb.PFAdd(ctx, cardKey, val) // HyperLogLog for approximate distinct count
		m.rdb.Expire(ctx, cardKey, 24*time.Hour)
	}
}

// GetCardinalityReport returns cardinality stats for all metrics.
// SCAN iterates incrementally, unlike KEYS, which blocks the whole
// Redis server while it walks the keyspace.
func (m *TagManager) GetCardinalityReport(ctx context.Context) ([]CardinalityEntry, error) {
	var entries []CardinalityEntry
	iter := m.rdb.Scan(ctx, 0, "cardinality:*", 500).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		count, err := m.rdb.PFCount(ctx, key).Result()
		if err != nil {
			continue
		}
		entries = append(entries, CardinalityEntry{
			Key:               key,
			ApproxCardinality: count,
			IsHighCardinality: count > 10000,
		})
	}
	if err := iter.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

type CardinalityEntry struct {
	Key               string `json:"key"`
	ApproxCardinality int64  `json:"approx_cardinality"`
	IsHighCardinality bool   `json:"is_high_cardinality"`
}
```

---
