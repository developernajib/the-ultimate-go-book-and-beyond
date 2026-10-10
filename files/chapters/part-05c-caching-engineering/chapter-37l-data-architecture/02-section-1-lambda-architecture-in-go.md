## Section 1: Lambda Architecture in Go

### 1.1 Why this section still exists

Lambda is legacy in 2026. Treat this section as the pattern you will inherit, rarely the pattern you will build. If you are starting fresh, skip to Section 2 (Kappa). You are still reading this section because Lambda lives on in two cases: (1) estates built in the 2012 to 2018 window that nobody has budget to rewrite, and (2) shops with genuinely divergent batch and stream semantics (ML training on Snowflake or BigQuery, real-time serving on Kafka) where the two codepaths are different on purpose, not by accident.

> **Senior track**: The failure mode that killed Lambda in practice was not cost, it was drift. Teams wrote the same business rule twice (once in Spark SQL, once in Flink or Storm) and the two versions silently diverged over months. Dashboards showed different numbers depending on whether the user queried the batch view or the speed view. If you must run Lambda, enforce a single source of truth for the logic (for example, a shared SQL definition compiled to both engines) or accept that the two numbers will drift.

### 1.2 Batch, Speed, and Serving Layers

Lambda architecture separates data into a batch layer for accurate historical computation and a speed layer for low-latency recent results, merging them at query time. The Go implementation below wires a Kafka consumer for the speed layer and a Spark-like batch processor for the batch layer, demonstrating the merge view pattern.

```go
package lambda

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// BatchView is an immutable, pre-computed view of all historical data.
type BatchView struct {
	Name      string
	ComputedAt time.Time
	Data      map[string]any
}

// BatchLayer computes batch views from raw data files.
type BatchLayer struct {
	rawDataPath  string
	viewsPath    string
	computations map[string]BatchComputation
}

// BatchComputation defines how to compute a batch view.
type BatchComputation struct {
	Name     string
	Compute  func(ctx context.Context, files []string) (map[string]any, error)
	Schedule string // cron expression
}

func NewBatchLayer(rawPath, viewsPath string) *BatchLayer {
	return &BatchLayer{
		rawDataPath:  rawPath,
		viewsPath:    viewsPath,
		computations: make(map[string]BatchComputation),
	}
}

// Register adds a batch computation.
func (bl *BatchLayer) Register(comp BatchComputation) {
	bl.computations[comp.Name] = comp
}

// RunAll executes all registered computations.
func (bl *BatchLayer) RunAll(ctx context.Context) error {
	files, err := bl.listRawFiles()
	if err != nil {
		return err
	}

	var wg sync.WaitGroup
	errs := make(chan error, len(bl.computations))

	for name, comp := range bl.computations {
		wg.Add(1)
		go func(n string, c BatchComputation) {
			defer wg.Done()
			result, err := c.Compute(ctx, files)
			if err != nil {
				errs <- fmt.Errorf("%s: %w", n, err)
				return
			}
			view := BatchView{Name: n, ComputedAt: time.Now(), Data: result}
			errs <- bl.saveView(view)
		}(name, comp)
	}

	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func (bl *BatchLayer) listRawFiles() ([]string, error) {
	return filepath.Glob(filepath.Join(bl.rawDataPath, "*.jsonl"))
}

func (bl *BatchLayer) saveView(view BatchView) error {
	path := filepath.Join(bl.viewsPath, view.Name+".json")
	data, err := json.MarshalIndent(view, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// 1.2 Speed Layer (real-time)

// SpeedLayer maintains incremental views from the last few hours.
type SpeedLayer struct {
	views  sync.Map // view name → *IncrementalView
}

type IncrementalView struct {
	Name    string
	mu      sync.RWMutex
	Counts  map[string]int64
	Sums    map[string]float64
	LastUpdated time.Time
	TTL     time.Duration
}

func NewIncrementalView(name string, ttl time.Duration) *IncrementalView {
	return &IncrementalView{
		Name:   name,
		Counts: make(map[string]int64),
		Sums:   make(map[string]float64),
		TTL:    ttl,
	}
}

func (v *IncrementalView) Increment(key string, delta int64) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.Counts[key] += delta
	v.LastUpdated = time.Now()
}

func (v *IncrementalView) Add(key string, value float64) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.Sums[key] += value
	v.LastUpdated = time.Now()
}

func (v *IncrementalView) Get(key string) (count int64, sum float64) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return v.Counts[key], v.Sums[key]
}

func (v *IncrementalView) IsExpired() bool {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return time.Since(v.LastUpdated) > v.TTL
}

// ProcessEvent updates relevant incremental views for a real-time event.
func (sl *SpeedLayer) ProcessEvent(eventType string, userID string, value float64) {
	// Update hourly user event counts
	v, _ := sl.views.LoadOrStore("hourly_events", NewIncrementalView("hourly_events", time.Hour))
	view := v.(*IncrementalView)

	hour := time.Now().Truncate(time.Hour).Format("2006-01-02T15")
	view.Increment(fmt.Sprintf("%s:%s", hour, eventType), 1)
	view.Add(fmt.Sprintf("%s:%s:value", hour, eventType), value)
}

// 1.3 Serving Layer: merges batch + speed views

// ServingLayer combines batch and real-time data for queries.
type ServingLayer struct {
	batch *BatchLayer
	speed *SpeedLayer
}

func NewServingLayer(batch *BatchLayer, speed *SpeedLayer) *ServingLayer {
	return &ServingLayer{batch: batch, speed: speed}
}

// Query merges batch view data with speed layer increments.
func (sl *ServingLayer) Query(viewName, key string) (BatchValue, SpeedValue, error) {
	// Load batch view
	path := filepath.Join(sl.batch.viewsPath, viewName+".json")
	var batchView BatchView
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &batchView)
	}

	bv := BatchValue{}
	if batchView.Data != nil {
		if v, ok := batchView.Data[key]; ok {
			bv.Value = v
			bv.ComputedAt = batchView.ComputedAt
		}
	}

	// Get speed layer data
	sv := SpeedValue{}
	if v, ok := sl.speed.views.Load(viewName); ok {
		view := v.(*IncrementalView)
		count, sum := view.Get(key)
		sv.Count = count
		sv.Sum = sum
	}

	return bv, sv, nil
}

type BatchValue struct {
	Value      any
	ComputedAt time.Time
}

type SpeedValue struct {
	Count int64
	Sum   float64
}
```

### Junior to FAANG: reading this code like an operator

The code above is easy to read and easy to misread. Three things deserve attention before you copy it into anything real. First, `BatchView` and `IncrementalView` are two different data models holding overlapping information, and the `ServingLayer.Query` method returns both to the caller without merging them. That is not an accidental omission. It is the Lambda pattern explicitly surfacing the fact that the batch view is authoritative for anything older than the speed layer's TTL and the speed view is authoritative for anything newer. The caller has to know the watermark between the two to produce a consistent answer. If you find yourself wanting to paper over this with a single number returned from `Query`, you have just discovered why Lambda is painful. Second, the speed layer stores state in a `sync.Map` of in-process views, which means the state evaporates on restart. In production you would back this with Redis or a similar store so that a rolling deploy does not erase the last hour of increments. Third, the batch layer runs all registered computations in parallel goroutines with no bounded concurrency, which is fine for a handful of views but will exhaust file descriptors and memory on a real workload. Add a worker pool.

A worked first-job example helps here. Suppose you are asked to produce a daily orders-by-region count that is accurate as of midnight and a rolling count that reflects the last hour. The batch computation reads all the JSONL files for the previous day, aggregates by region, and writes a `BatchView` named `orders_by_region`. The speed layer receives order events on a Kafka topic, calls `ProcessEvent`, and maintains an in-memory `IncrementalView`. The dashboard calls `ServingLayer.Query("orders_by_region", "us-west")` at 10 a.m. and receives a batch value computed at midnight plus a speed value counting everything since. The dashboard then displays `batch_value + speed_value_since_midnight`. The bug you will hit the first time you run this in anger is that the speed layer contains events from before midnight as well, because its TTL is an hour but the batch cutoff is ten hours ago. You have to either filter the speed layer by timestamp on read or align the speed TTL with the batch cadence. This is the drift problem in microcosm, and it is why the code returns both values separately rather than pretending to merge them for you.

Interview entry-point questions on Lambda implementations tend to be practical. Expect to be asked why the batch and speed layers exist as separate codepaths rather than being unified, and the answer you want is that the speed layer optimizes for latency by accepting approximate results over recent data while the batch layer optimizes for correctness by recomputing from the full history on a slow cadence. Expect to be asked what happens if the batch job fails one night, and the answer is that the speed layer keeps the system serving, but the freshness of the batch view degrades by one cadence interval, which is why most Lambda shops alarm on batch job lag rather than on batch job failure alone. Expect to be asked how you would migrate this code to Kappa, and the answer is that you delete the batch layer, extend the speed layer to replay from Kafka offset zero on demand, and promote the incremental view to the sole source of truth with its state durably backed in Flink or Redis.

### Senior at FAANG: the production reality of Lambda in 2026 and the honest migration path

At staff level you will almost never be asked to green-field a Lambda architecture in 2026. You will, however, frequently be asked to audit, stabilise, or migrate an existing one, and the Go code above is a reasonable model for understanding what you will find inside those estates. The honest senior perspective on Lambda begins with acknowledging what it got right. Marz's 2011 insight that the master dataset should be immutable, append-only, and reprocessable was correct and has survived every subsequent architecture. The lakehouse pattern, the Kappa pattern, and the event-sourcing pattern all inherit it directly. Lambda's batch layer, reading the full history from immutable storage and recomputing views from scratch, is the conceptual ancestor of every modern backfill job. Where Lambda failed was not in the principle but in the implementation, specifically in the requirement that the batch and speed layers be physically separate systems running different code.

The drift problem is worth a precise treatment because it is the single most important failure mode to understand. Consider a business rule that says "revenue excludes refunded orders." In the batch layer, this is typically expressed as a Spark SQL query with `WHERE status != 'refunded'`. In the speed layer, this is typically expressed as a stateful Flink or Storm operator that tracks pending refunds and retroactively decrements counters when refunds arrive. The two implementations look equivalent on day one. Six months later, product adds a new refund type called `partial_refund`, and the business rule is updated to `status NOT IN ('refunded', 'partial_refund')`. The batch SQL gets updated because the data engineering team owns it and sees the ticket. The streaming operator gets updated a week later because a different team owns it and got pulled into an incident. For a week, the batch view shows lower revenue than the speed view for the same time window. The dashboard shows a step change at the boundary between speed and batch coverage. A customer escalates. You are now the on-call engineer debugging a drift incident, and the root cause is that the same rule was expressed twice in two languages and updated on two schedules.

The defensive patterns against drift, in rough order of effectiveness, are as follows. The strongest pattern is single-source-logic, where the business rule is written once in a portable format, typically SQL compiled to both engines or a DSL interpreted by both, and the two layers differ only in execution. Trino and Flink SQL, Calcite-based SQL on both Spark and Flink, and dbt with streaming extensions all target this pattern. The second-strongest pattern is contract tests, where the same fixture dataset is pushed through both pipelines in CI and the outputs are compared for equality within a tolerance. The weakest pattern, and unfortunately the most common in practice, is quarterly reconciliation where a person runs a query comparing batch and speed aggregates and files tickets for the deltas. If you inherit a Lambda stack, the first audit you should run is to ask which of these three the team practices. If the answer is the third or none, you have a drift incident in your future and you should prioritize accordingly.

The migration path from Lambda to the lakehouse-native hybrid is the engagement you will most often run at staff level, and it has a consistent shape. Phase one is to move the master dataset from HDFS or a warehouse into an Iceberg table, with the existing batch job rewritten to read and write Iceberg rather than Parquet files. This is a low-risk change because Iceberg on the read side is compatible with Spark SQL semantics, and it buys you snapshot isolation, schema evolution, and time travel, which you will need in later phases. Phase two is to point the streaming layer at the same Iceberg table via Flink's Iceberg sink, so that the speed layer's state is durably materialized into the lakehouse rather than living only in the serving store. This is where the drift problem starts to dissolve, because both layers now write to the same physical table with the same schema. Phase three is to rewrite the business logic in a single language, almost always Flink SQL or Spark Structured Streaming's unified API, so that the batch job and the streaming job share a codebase and differ only in their trigger semantics. Phase four is to delete the speed layer's redundant serving store, now that Iceberg with a streaming read path can serve both recent and historical queries from the same table. At the end of phase four you have what the industry calls streaming lakehouse, and you have retired Lambda without a big-bang rewrite.

Observability patterns for Lambda and post-Lambda hybrids deserve their own treatment. You need four metrics at minimum. Batch freshness, defined as the wall-clock age of the most recent batch view, alarms when the batch cadence slips. Speed lag, defined as the consumer group lag in seconds behind the head of the log, alarms when the speed layer cannot keep up with ingestion. Drift, defined as the absolute or relative delta between batch and speed views over an overlapping window, alarms when the two codepaths produce inconsistent results. Reprocess throughput, defined as the rate at which the streaming job consumes events when replaying from an old offset, determines how fast you can recover from a logic bug. The first three are standard. The fourth is the one juniors miss and the one that determines how fast you can ship fixes. If your reprocess throughput is only 1.5x real-time, then a logic bug that corrupted a day of data takes sixteen hours to re-run. If it is 20x, the same bug takes an hour. Invest in reprocess throughput the same way you invest in deploy speed, because they are the same variable under different names.

Code-review discipline for the Go file above, applied at staff level, would flag several things beyond the junior observations. The `RunAll` method's error channel is sized to the computation count but drains only after `Wait` returns, which means a failing computation cannot short-circuit the others. In a real batch layer with expensive computations, you want context cancellation on first error or a policy decision to continue and report all failures. The `saveView` path writes to the local filesystem, which is a single-node assumption that will not survive a move to Kubernetes or a shared object store. The `ServingLayer.Query` method reads the batch view from disk on every call, which is acceptable at low query rates but will saturate a filesystem at dashboard scale. Cache the batch view in memory with an invalidation signal tied to new batch writes. None of these are bugs in the pedagogical code, but all of them are the review comments you would leave if this showed up in a real pull request, and knowing to leave them is part of what distinguishes senior review from junior review.

---
