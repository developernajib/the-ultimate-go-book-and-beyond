## Production Go Implementation: Time-Series Ingestion Pipeline

The time-series ingestion pipeline is the highest-throughput component in the metrics system, ingesting a million data points per second from 100,000 agent hosts. Rather than keeping every incoming point at full resolution forever, the pipeline groups points into tumbling 1-minute windows and pre-aggregates them into a single bucket (min, max, sum, count, and a t-digest sketch for percentiles) per metric-tag combination. This collapses the six 10-second points a series reports per minute into one row, cutting long-term write volume roughly 6x, and produces the pre-computed statistics that downstream query engines need for fast dashboard rendering. FNV hashing produces compact series keys, and a mutex-guarded window map accumulates the buckets, sharding that map by key hash is the natural next step if lock contention shows up in profiles.

```go
package ingestion

import (
	"context"
	"fmt"
	"hash/fnv"
	"log"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// ============================================================
// Domain Types
// ============================================================

// MetricPoint represents a single data point ingested from an agent.
type MetricPoint struct {
	Name      string
	Tags      map[string]string
	Value     float64
	Timestamp int64 // unix milliseconds
}

// AggregatedBucket holds pre-aggregated statistics for a tumbling window.
// Stored in ClickHouse after stream aggregation cuts write volume roughly 6x.
type AggregatedBucket struct {
	MetricKey   string // name + sorted tags hash
	Name        string
	Tags        map[string]string
	WindowStart int64
	WindowEnd   int64
	Count       int64
	Sum         float64
	Min         float64
	Max         float64
	TDigest     *SimpleTDigest
}

// ============================================================
// Ingestion Pipeline
// ============================================================

// IngestionPipeline orchestrates the full path from raw metric points
// through validation, cardinality checking, stream aggregation, and
// batch writing to storage backends.
type IngestionPipeline struct {
	validator     *TagValidator
	aggregator    *StreamAggregator
	cardTracker   *CardinalityTracker
	writers       []BatchWriter
	metrics       *PipelineMetrics
	inCh          chan MetricPoint
	done          chan struct{}
	batchSize     int
	flushInterval time.Duration
	wg            sync.WaitGroup
}

type PipelineMetrics struct {
	pointsReceived    atomic.Int64
	pointsDropped     atomic.Int64
	pointsAggregated  atomic.Int64
	batchesWritten    atomic.Int64
	batchesFailed     atomic.Int64
	cardinalityErrors atomic.Int64
}

// BatchWriter is implemented by storage backends (ClickHouse, S3, etc.)
type BatchWriter interface {
	WriteBatch(ctx context.Context, buckets []AggregatedBucket) error
}

func NewIngestionPipeline(
	writers []BatchWriter,
	maxCardinality int,
	windowSize time.Duration,
	batchSize int,
	flushInterval time.Duration,
	numWorkers int,
) *IngestionPipeline {
	p := &IngestionPipeline{
		validator:     NewTagValidator(30, 100), // max 30 tags, max 100 char values
		aggregator:    NewStreamAggregator(windowSize),
		cardTracker:   NewCardinalityTracker(maxCardinality),
		writers:       writers,
		metrics:       &PipelineMetrics{},
		inCh:          make(chan MetricPoint, 100_000),
		done:          make(chan struct{}),
		batchSize:     batchSize,
		flushInterval: flushInterval,
	}

	// Start worker goroutines for parallel ingestion
	for i := 0; i < numWorkers; i++ {
		p.wg.Add(1)
		go p.worker(i)
	}

	// Start flush ticker
	p.wg.Add(1)
	go p.flushLoop()

	return p
}

// Ingest validates a metric point and sends it to the aggregation pipeline.
// Returns an error immediately if validation or cardinality checks fail.
// Uses a buffered channel with backpressure semantics, so callers should
// implement retry or local disk buffering when this returns channel-full errors.
func (p *IngestionPipeline) Ingest(point MetricPoint) error {
	p.metrics.pointsReceived.Add(1)

	// Step 1: Validate tags (blocked keys, max count, max value length)
	if err := p.validator.Validate(point); err != nil {
		p.metrics.pointsDropped.Add(1)
		return fmt.Errorf("validation failed: %w", err)
	}

	// Step 2: Cardinality check (per-metric series limit)
	seriesKey := computeSeriesKey(point.Name, point.Tags)
	if !p.cardTracker.CheckAndTrack(seriesKey, point.Name) {
		p.metrics.cardinalityErrors.Add(1)
		p.metrics.pointsDropped.Add(1)
		return fmt.Errorf("cardinality limit exceeded for metric %s", point.Name)
	}

	// Step 3: Send to aggregation channel (non-blocking with backpressure)
	select {
	case p.inCh <- point:
		return nil
	default:
		p.metrics.pointsDropped.Add(1)
		return fmt.Errorf("ingestion channel full, applying backpressure")
	}
}

func (p *IngestionPipeline) worker(id int) {
	defer p.wg.Done()
	for point := range p.inCh {
		p.aggregator.Add(point)
		p.metrics.pointsAggregated.Add(1)
	}
}

func (p *IngestionPipeline) flushLoop() {
	defer p.wg.Done()
	ticker := time.NewTicker(p.flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			p.flushBuckets(p.aggregator.FlushCompleted())
		}
	}
}

// flushBuckets writes completed windows in batches to all configured writers
func (p *IngestionPipeline) flushBuckets(buckets []AggregatedBucket) {
	for i := 0; i < len(buckets); i += p.batchSize {
		end := min(i+p.batchSize, len(buckets))
		batch := buckets[i:end]

		for _, w := range p.writers {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := w.WriteBatch(ctx, batch)
			cancel()
			if err != nil {
				// Failed batches are counted and dropped here for brevity.
				// Production systems re-enqueue them to a retry topic so
				// data is not silently lost.
				log.Printf("batch write failed: %v", err)
				p.metrics.batchesFailed.Add(1)
				continue
			}
			p.metrics.batchesWritten.Add(1)
		}
	}
}

// Close gracefully shuts down the pipeline: workers drain in-flight
// points, the flush loop stops, and closed windows get a final flush.
func (p *IngestionPipeline) Close() {
	close(p.inCh)
	close(p.done)
	p.wg.Wait()
	p.flushBuckets(p.aggregator.FlushCompleted())
}

// Stats returns current pipeline metrics for monitoring.
func (p *IngestionPipeline) Stats() map[string]int64 {
	return map[string]int64{
		"points_received":    p.metrics.pointsReceived.Load(),
		"points_dropped":     p.metrics.pointsDropped.Load(),
		"points_aggregated":  p.metrics.pointsAggregated.Load(),
		"batches_written":    p.metrics.batchesWritten.Load(),
		"batches_failed":     p.metrics.batchesFailed.Load(),
		"cardinality_errors": p.metrics.cardinalityErrors.Load(),
	}
}

// ============================================================
// Tag Validator
// ============================================================

// TagValidator enforces tag hygiene to prevent cardinality explosions.
// Blocks known high-cardinality keys (user_id, request_id, etc.),
// limits tag count per point, and caps value length.
type TagValidator struct {
	maxTags     int
	maxValueLen int
	blockedKeys map[string]bool
}

func NewTagValidator(maxTags, maxValueLen int) *TagValidator {
	return &TagValidator{
		maxTags:     maxTags,
		maxValueLen: maxValueLen,
		blockedKeys: map[string]bool{
			"user_id": true, "request_id": true, "trace_id": true,
			"session_id": true, "ip_address": true, "email": true,
		},
	}
}

func (v *TagValidator) Validate(p MetricPoint) error {
	if len(p.Tags) > v.maxTags {
		return fmt.Errorf("too many tags: %d > %d", len(p.Tags), v.maxTags)
	}
	for k, val := range p.Tags {
		if v.blockedKeys[k] {
			return fmt.Errorf("blocked high-cardinality tag: %s", k)
		}
		if len(val) > v.maxValueLen {
			return fmt.Errorf("tag value too long: %s (%d chars)", k, len(val))
		}
	}
	return nil
}

// ============================================================
// Stream Aggregator (in-memory tumbling windows)
// ============================================================

// StreamAggregator maintains in-memory tumbling windows that accumulate
// count, sum, min, max, and a T-Digest sketch per unique series per window.
// Completed windows (where WindowEnd < now) are flushed to storage.
type StreamAggregator struct {
	mu         sync.RWMutex
	windows    map[string]*AggregatedBucket
	windowSize time.Duration
}

func NewStreamAggregator(windowSize time.Duration) *StreamAggregator {
	return &StreamAggregator{
		windows:    make(map[string]*AggregatedBucket),
		windowSize: windowSize,
	}
}

func (a *StreamAggregator) Add(p MetricPoint) {
	windowStart := (p.Timestamp / a.windowSize.Milliseconds()) * a.windowSize.Milliseconds()
	seriesKey := computeSeriesKey(p.Name, p.Tags)
	bucketKey := fmt.Sprintf("%s:%d", seriesKey, windowStart)

	a.mu.Lock()
	defer a.mu.Unlock()

	bucket, exists := a.windows[bucketKey]
	if !exists {
		bucket = &AggregatedBucket{
			MetricKey:   seriesKey,
			Name:        p.Name,
			Tags:        p.Tags,
			WindowStart: windowStart,
			WindowEnd:   windowStart + a.windowSize.Milliseconds(),
			Min:         p.Value,
			Max:         p.Value,
			TDigest:     NewSimpleTDigest(),
		}
		a.windows[bucketKey] = bucket
	}

	bucket.Count++
	bucket.Sum += p.Value
	if p.Value < bucket.Min {
		bucket.Min = p.Value
	}
	if p.Value > bucket.Max {
		bucket.Max = p.Value
	}
	bucket.TDigest.Add(p.Value)
}

// FlushCompleted returns all windows that have closed (WindowEnd < now)
// and removes them from the in-memory map.
func (a *StreamAggregator) FlushCompleted() []AggregatedBucket {
	now := time.Now().UnixMilli()
	a.mu.Lock()
	defer a.mu.Unlock()

	var completed []AggregatedBucket
	for key, bucket := range a.windows {
		if bucket.WindowEnd < now {
			completed = append(completed, *bucket)
			delete(a.windows, key)
		}
	}
	return completed
}

// ActiveWindows returns the count of currently open aggregation windows
// for monitoring purposes.
func (a *StreamAggregator) ActiveWindows() int {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return len(a.windows)
}

// ============================================================
// Cardinality Tracker (approximate, per-metric series limits)
// ============================================================

// CardinalityTracker enforces a maximum number of unique time series
// per metric name. Uses an in-memory map for fast checking - production
// systems would back this with HyperLogLog in Redis for distributed tracking.
type CardinalityTracker struct {
	mu        sync.RWMutex
	counts    map[string]int  // metric_name -> approx unique series
	seen      map[string]bool // series_key -> already counted
	maxSeries int
}

func NewCardinalityTracker(maxSeries int) *CardinalityTracker {
	return &CardinalityTracker{
		counts:    make(map[string]int),
		seen:      make(map[string]bool),
		maxSeries: maxSeries,
	}
}

func (c *CardinalityTracker) CheckAndTrack(seriesKey, metricName string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Already seen this exact series - allow
	if c.seen[seriesKey] {
		return true
	}

	// New series - check limit
	current := c.counts[metricName]
	if current >= c.maxSeries {
		return false
	}
	c.counts[metricName] = current + 1
	c.seen[seriesKey] = true
	return true
}

// GetCardinality returns the current number of unique series for a metric.
func (c *CardinalityTracker) GetCardinality(metricName string) int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.counts[metricName]
}

// ============================================================
// Simplified T-Digest for percentile estimation
// ============================================================

// SimpleTDigest is a simplified implementation of the T-Digest algorithm
// for estimating quantiles (P50, P95, P99, P99.9) with bounded memory.
// Production systems should use a battle-tested library like github.com/influxdata/tdigest.
type SimpleTDigest struct {
	centroids []Centroid
	maxSize   int
}

type Centroid struct {
	Mean  float64
	Count int64
}

func NewSimpleTDigest() *SimpleTDigest {
	return &SimpleTDigest{
		centroids: make([]Centroid, 0, 100),
		maxSize:   100,
	}
}

func (t *SimpleTDigest) Add(value float64) {
	t.centroids = append(t.centroids, Centroid{Mean: value, Count: 1})
	if len(t.centroids) > t.maxSize*2 {
		t.compress()
	}
}

func (t *SimpleTDigest) compress() {
	sort.Slice(t.centroids, func(i, j int) bool {
		return t.centroids[i].Mean < t.centroids[j].Mean
	})

	if len(t.centroids) <= t.maxSize {
		return
	}

	// Merge adjacent centroids in equal-size groups so the digest
	// shrinks back to maxSize while preserving the value distribution.
	// A real t-digest uses smaller groups near the extremes, which is
	// what keeps P99/P99.9 estimates tight.
	groupSize := (len(t.centroids) + t.maxSize - 1) / t.maxSize
	merged := make([]Centroid, 0, t.maxSize)
	for i := 0; i < len(t.centroids); i += groupSize {
		end := min(i+groupSize, len(t.centroids))
		var count int64
		var weighted float64
		for _, c := range t.centroids[i:end] {
			count += c.Count
			weighted += c.Mean * float64(c.Count)
		}
		merged = append(merged, Centroid{Mean: weighted / float64(count), Count: count})
	}
	t.centroids = merged
}

// Quantile returns the estimated value at quantile q (0.0 to 1.0).
// For example, Quantile(0.99) returns the estimated P99 value.
func (t *SimpleTDigest) Quantile(q float64) float64 {
	t.compress()
	if len(t.centroids) == 0 {
		return 0
	}

	var totalCount int64
	for _, c := range t.centroids {
		totalCount += c.Count
	}

	target := q * float64(totalCount)
	var cumulative float64
	for _, c := range t.centroids {
		cumulative += float64(c.Count)
		if cumulative >= target {
			return c.Mean
		}
	}
	return t.centroids[len(t.centroids)-1].Mean
}

// Merge combines another T-Digest into this one. Used when merging
// agent-side digests into a global digest at the aggregation layer.
func (t *SimpleTDigest) Merge(other *SimpleTDigest) {
	t.centroids = append(t.centroids, other.centroids...)
	if len(t.centroids) > t.maxSize*2 {
		t.compress()
	}
}

// ============================================================
// Helpers
// ============================================================

// computeSeriesKey produces a deterministic key for a unique time series
// (metric name + sorted tag key-value pairs). Uses FNV-1a for speed.
func computeSeriesKey(name string, tags map[string]string) string {
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	slices.Sort(keys)

	h := fnv.New64a()
	h.Write([]byte(name))
	for _, k := range keys {
		h.Write([]byte(k))
		h.Write([]byte(tags[k]))
	}

	return fmt.Sprintf("%s:%x", name, h.Sum64())
}
```

---
