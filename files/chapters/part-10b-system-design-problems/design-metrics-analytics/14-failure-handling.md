## Failure Handling

A metrics pipeline must never silently drop data, a lost metric is an invisible outage. The `IngestFailover` struct implements a three-tier write path: if the primary Kafka cluster is unavailable, it immediately retries on a secondary cluster, and if that also fails, it buffers to local disk so a background goroutine can drain the backlog once connectivity restores. The `AlertFlapping` guard prevents alert storms by requiring a configurable number of consecutive failing evaluations before firing, avoiding the noise of transient spikes triggering pages. Query degradation is the last line of defense: rather than returning an error under load, the system progressively coarsens resolution, tightens time ranges, and falls back to stale cache to keep dashboards responsive even when the storage tier is under pressure.

```go
package resilience

import (
	"context"
)

type MetricPoint struct{}

type KafkaProducer interface {
	Produce(ctx context.Context, metrics []MetricPoint) error
}

type DiskBuffer struct{}

func (d *DiskBuffer) Write(metrics []MetricPoint) error {
	return nil
}

type IngestFailover struct {
	primary   KafkaProducer
	secondary KafkaProducer
	disk      *DiskBuffer
}

func (f *IngestFailover) Publish(ctx context.Context, metrics []MetricPoint) error {
	if err := f.primary.Produce(ctx, metrics); err == nil {
		return nil
	}
	if err := f.secondary.Produce(ctx, metrics); err == nil {
		return nil
	}
	return f.disk.Write(metrics) // background goroutine retries from disk
}

type AlertFlapping struct {
	consecutiveRequired int
}

func (f *AlertFlapping) ShouldFire(history []bool) bool {
	consecutive := 0
	for i := len(history) - 1; i >= 0; i-- {
		if !history[i] {
			break
		}
		consecutive++
	}
	return consecutive >= f.consecutiveRequired
}

// Query degradation: reduce resolution (10s->1m->1h), limit time range, drop GROUP BY, return stale cache
```

---
