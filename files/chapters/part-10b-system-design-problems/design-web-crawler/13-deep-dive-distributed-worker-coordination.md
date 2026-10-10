## Deep Dive: Distributed Worker Coordination

With 200 crawler workers running across multiple machines, you need visibility into which workers are alive and how each one is performing. Each worker periodically reports its throughput and error rate to Redis under a key with a TTL, and a worker that stops heartbeating lets its key expire, which is how the coordinator notices it is gone.

Be precise about what this layer is for, because it is easy to build it for the wrong reason. **It does not fail work over.** Kafka's consumer group protocol already does that: a worker that stops polling misses `session.timeout.ms`, the group coordinator evicts it, and its partitions are reassigned to surviving members automatically. Writing your own liveness detector to "trigger a rebalance" duplicates that machinery, and worse, it races with it. Two systems reassigning the same partitions on different timeouts is how you get two consumers on one partition, and on this crawler that means two rate limiters for one domain and a politeness violation. Let Kafka own liveness and partition ownership.

What this coordinator owns is **observability and control**: which workers exist, how fast each is crawling, what its error rate is, and whether an operator has asked it to drain. That is genuinely useful and Kafka will not tell you any of it. Note also the TTL relationship. The Redis key expires after `heartbeatTTL`, so a missing key *is* the dead signal, and there is no point scanning a `LastHeartbeat` timestamp for staleness on a key that has already been deleted. The TTL must be comfortably longer than the heartbeat interval, or a worker that is merely slow gets declared dead on every GC pause.

```go
package coordinator

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	heartbeatInterval = 30 * time.Second
	heartbeatTTL      = 90 * time.Second // 3 missed beats before a worker vanishes
	workerKeyPrefix   = "worker:"
)

type WorkerCoordinator struct {
	rdb *redis.ClusterClient
}

type WorkerInfo struct {
	ID            string    `json:"id"`
	Host          string    `json:"host"`
	Status        string    `json:"status"` // active, draining, stopped
	PagesPerSec   float64   `json:"pages_per_sec"`
	ErrorRate     float64   `json:"error_rate"`
	LastHeartbeat time.Time `json:"last_heartbeat"`
}

// Heartbeat publishes this worker's liveness and stats.
// HSet and Expire go in one pipeline: issued separately, a failure between them
// leaves a key with no TTL, and a worker that later dies stays "alive" forever.
func (c *WorkerCoordinator) Heartbeat(ctx context.Context, w WorkerInfo) error {
	key := workerKeyPrefix + w.ID
	pipe := c.rdb.TxPipeline()
	pipe.HSet(ctx, key, map[string]any{
		"host":           w.Host,
		"status":         w.Status,
		"pages_per_sec":  w.PagesPerSec,
		"error_rate":     w.ErrorRate,
		"last_heartbeat": time.Now().Unix(),
	})
	pipe.Expire(ctx, key, heartbeatTTL)
	// Actually check the result. Swallowing this error would mean every worker
	// reports a healthy heartbeat throughout a Redis outage.
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("heartbeat %s: %w", w.ID, err)
	}
	return nil
}

// LiveWorkers returns the workers currently heartbeating, read from Redis.
// Redis is the only source of truth here. An in-process map would be empty on
// every replica except the one that happened to serve the write.
func (c *WorkerCoordinator) LiveWorkers(ctx context.Context) ([]WorkerInfo, error) {
	var out []WorkerInfo
	// SCAN, never KEYS: KEYS blocks the server for the whole scan.
	iter := c.rdb.Scan(ctx, 0, workerKeyPrefix+"*", 100).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		vals, err := c.rdb.HGetAll(ctx, key).Result()
		if err != nil || len(vals) == 0 {
			continue // expired between SCAN and HGETALL: that worker is gone
		}
		pps, _ := strconv.ParseFloat(vals["pages_per_sec"], 64)
		errRate, _ := strconv.ParseFloat(vals["error_rate"], 64)
		secs, _ := strconv.ParseInt(vals["last_heartbeat"], 10, 64)
		out = append(out, WorkerInfo{
			ID:            key[len(workerKeyPrefix):],
			Host:          vals["host"],
			Status:        vals["status"],
			PagesPerSec:   pps,
			ErrorRate:     errRate,
			LastHeartbeat: time.Unix(secs, 0),
		})
	}
	if err := iter.Err(); err != nil {
		return nil, fmt.Errorf("scan workers: %w", err)
	}
	return out, nil
}

// A worker that stops heartbeating simply disappears from LiveWorkers when its
// key expires. There is no DetectDeadWorkers and no reassignment step here on
// purpose: Kafka's consumer group protocol already detects the dead member and
// moves its partitions. Doing it here too would race with Kafka and could put
// two consumers on one partition, which breaks per-domain politeness.
```

---
