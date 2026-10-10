## Deep Dive: Sampled Counting for High QPS

At 100K queries per second, writing every single search event to Redis would generate 100K writes per second, which is expensive and unnecessary. Sampled counting uses the law of large numbers: by recording only a fraction of events (for example, 10%) and multiplying the counts, you get statistically accurate frequency estimates for popular terms while dramatically reducing write load. Low-frequency terms may be noisy, but they would not appear in the top-K suggestions anyway.

```go
package sampling

import (
	"context"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// SampledCounter reduces write load by sampling search events
// At 100K QPS, writing every event = 100K Redis writes/sec
// With 10% sampling: 10K writes/sec, multiply counts by 10
type SampledCounter struct {
	rdb        *redis.ClusterClient
	sampleRate float64 // 0.1 = 10%
	localBuf   map[string]int64
	mu         sync.Mutex
	flushEvery time.Duration
}

func NewSampledCounter(rdb *redis.ClusterClient, sampleRate float64) *SampledCounter {
	sc := &SampledCounter{
		rdb:        rdb,
		sampleRate: sampleRate,
		localBuf:   make(map[string]int64),
		flushEvery: 5 * time.Second,
	}
	go sc.flushLoop()
	return sc
}

func (sc *SampledCounter) Record(term string) {
	if rand.Float64() > sc.sampleRate {
		return // skip
	}
	sc.mu.Lock()
	sc.localBuf[term]++
	sc.mu.Unlock()
}

func (sc *SampledCounter) flushLoop() {
	ticker := time.NewTicker(sc.flushEvery)
	for range ticker.C {
		sc.mu.Lock()
		buf := sc.localBuf
		sc.localBuf = make(map[string]int64)
		sc.mu.Unlock()

		if len(buf) == 0 {
			continue
		}

		ctx := context.Background()
		pipe := sc.rdb.Pipeline()
		for term, count := range buf {
			estimated := int64(float64(count) / sc.sampleRate)
			pipe.IncrBy(ctx, "term:count:"+term, estimated)
		}
		pipe.Exec(ctx)
	}
}

// Why sampling works: law of large numbers ensures accuracy for popular terms.
// Term searched 10,000x/day: 10% sample = ~1,000 events, x10 = ~10,000 (within 3%)
// Low-frequency terms (<50/day) may be noisy but don't appear in top-K anyway.
```

---
