## Go Implementation: Seat Map Cache

During a sale event, thousands of users are constantly refreshing the seat map to see which seats are still available. Querying Redis for every single request would be wasteful since the seat map only changes meaningfully every second or so. This service builds a cacheable snapshot of seat availability grouped by section, then caches it with a short TTL (1 second during sales, 30 seconds during normal traffic). The CDN serves this snapshot to all users, so the vast majority of seat map requests never reach the origin server.

The detail that decides whether this component helps or hurts is what happens the instant the cached entry expires. Building a snapshot means an `HGETALL` across every seat in the venue, 100K fields for a stadium. If a thousand in-flight requests all miss the cache at the same moment, a thousand goroutines each run that scan against the same Redis node, and the cache built to protect the origin becomes the thing that takes it down, once per second, all sale long. This is the thundering herd again, one layer in. `singleflight` collapses those duplicate misses into one rebuild whose result is shared with every waiter.

```go
package seatmap

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// SeatMapService provides CDN-cacheable seat map snapshots
type SeatMapService struct {
	rdb *redis.Client
	// group collapses concurrent rebuilds of the same event's snapshot into a
	// single Redis scan whose result every caller shares.
	group singleflight.Group
	// ttl is how long a snapshot stays fresh: short during a sale, longer when
	// inventory is barely moving.
	ttl time.Duration
}

type SeatMapSnapshot struct {
	EventID     string                 `json:"event_id"`
	Sections    map[string]SectionSnap `json:"sections"`
	Available   int                    `json:"available"`
	Held        int                    `json:"held"`
	Sold        int                    `json:"sold"`
	GeneratedAt time.Time              `json:"generated_at"`
	TTLSeconds  int                    `json:"ttl_seconds"`
}

// SectionSnap carries only counts. An earlier revision also declared MinPrice
// and MaxPrice, which nothing ever populated: every client got 0.00 for both,
// served with the same confidence as the real numbers. A field the API cannot
// fill is worse than a field the API does not have.
type SectionSnap struct {
	Name      string `json:"name"`
	Available int    `json:"available"`
	Sold      int    `json:"sold"`
	Held      int    `json:"held"`
}

// GetSeatMapSnapshot returns a cacheable seat map overview.
// This is what the CDN serves (1-second refresh during sale events).
func (svc *SeatMapService) GetSeatMapSnapshot(ctx context.Context, eventID string) (*SeatMapSnapshot, error) {
	cacheKey := fmt.Sprintf("seatmap:snapshot:%s", eventID)

	if snap, ok := svc.readCache(ctx, cacheKey); ok {
		return snap, nil
	}

	// Cache miss: exactly one rebuild per event runs at a time, and every
	// concurrent caller receives its result.
	v, err, _ := svc.group.Do(eventID, func() (any, error) {
		// Re-check under the flight: by the time this runs, an earlier flight
		// may already have populated the cache.
		if snap, ok := svc.readCache(ctx, cacheKey); ok {
			return snap, nil
		}
		return svc.rebuild(ctx, eventID, cacheKey)
	})
	if err != nil {
		return nil, err
	}
	return v.(*SeatMapSnapshot), nil
}

func (svc *SeatMapService) readCache(ctx context.Context, cacheKey string) (*SeatMapSnapshot, bool) {
	cached, err := svc.rdb.Get(ctx, cacheKey).Bytes()
	if err != nil {
		return nil, false
	}
	var snap SeatMapSnapshot
	// An ignored Unmarshal error here returns a zero-valued snapshot that
	// reports every seat sold, which is a convincing lie: 0 available.
	if err := json.Unmarshal(cached, &snap); err != nil {
		return nil, false
	}
	return &snap, true
}

func (svc *SeatMapService) rebuild(ctx context.Context, eventID, cacheKey string) (*SeatMapSnapshot, error) {
	seats, err := svc.rdb.HGetAll(ctx, fmt.Sprintf("seats:%s", eventID)).Result()
	if err != nil {
		return nil, err
	}

	snap := &SeatMapSnapshot{
		EventID:     eventID,
		Sections:    make(map[string]SectionSnap),
		GeneratedAt: time.Now(),
		TTLSeconds:  int(svc.ttl.Seconds()),
	}

	for seatID, status := range seats {
		section := extractSection(seatID)
		// Named sec, not s: shadowing the receiver inside the loop is how a
		// later edit reaches for s.rdb and gets a SectionSnap instead.
		sec := snap.Sections[section]
		sec.Name = section

		switch {
		case status == "available":
			sec.Available++
			snap.Available++
		case strings.HasPrefix(status, "held:"):
			sec.Held++
			snap.Held++
		case strings.HasPrefix(status, "sold:"):
			sec.Sold++
			snap.Sold++
		}

		snap.Sections[section] = sec
	}

	data, err := json.Marshal(snap)
	if err != nil {
		return nil, err
	}
	// A failed cache write costs a rebuild next time, not a wrong answer now.
	if err := svc.rdb.Set(ctx, cacheKey, data, svc.ttl).Err(); err != nil {
		return snap, nil
	}
	return snap, nil
}

// extractSection pulls the section label out of a seat ID of the form
// "SECTION-ROW-NUMBER", for example "A-12-7" -> "A".
func extractSection(seatID string) string {
	if section, _, ok := strings.Cut(seatID, "-"); ok {
		return section
	}
	return seatID
}
```

---
