## Deep Dive: View Count at Scale

At 115,000 views per second, writing each view directly to the database would overwhelm even the most powerful cluster. This service uses two key techniques to handle the load. First, it buffers view counts locally in memory and flushes them to Redis in batches every few seconds (write coalescing), reducing write throughput by 20x or more. Second, it uses Redis HyperLogLog to track unique viewers with only 12KB of memory per post, accepting a small (0.81% standard error) accuracy trade-off for massive memory savings.

```go
package counters

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// 115K views/sec: cannot write each to database
type ViewCountService struct {
	rdb         *redis.ClusterClient
	localBuffer map[string]int64
	mu          sync.Mutex
}

func (s *ViewCountService) RecordView(ctx context.Context, postID, viewerID string) {
	// Unique viewers: HyperLogLog (12KB per post, 0.81% standard error)
	s.rdb.PFAdd(ctx, fmt.Sprintf("views:hll:%s", postID), viewerID)

	// Total count: buffer locally, flush every 5 seconds (write coalescing)
	s.mu.Lock()
	s.localBuffer[postID]++
	s.mu.Unlock()
}

func (s *ViewCountService) FlushViewCounts(ctx context.Context) {
	s.mu.Lock()
	buf := s.localBuffer
	s.localBuffer = make(map[string]int64)
	s.mu.Unlock()

	pipe := s.rdb.Pipeline()
	for postID, count := range buf {
		pipe.IncrBy(ctx, fmt.Sprintf("views:total:%s", postID), count)
	}
	pipe.Exec(ctx)
}

// Design decisions:
// - Total views: buffered INCR (115K/sec -> ~5K/sec with coalescing)
// - Unique views: HyperLogLog
// - Display total to user (not unique, the larger number)
// - Sync to Cassandra hourly. After 30 days, freeze Redis counter.
```

---
