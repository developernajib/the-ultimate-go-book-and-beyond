## Section 1: Pipeline Foundation

### 1.1 Core Pipeline Primitives

The `Pipeline` type models an ETL graph as a slice of `Stage` values connected by typed channels of `Record`, where each stage runs in its own goroutine pool and forwards records downstream or writes failed records to a dead-letter channel. The `Record.Err` field carries errors in-band so that downstream stages can inspect failure context without breaking the channel-based topology, and `sync/atomic` counters on each stage provide lock-free throughput metrics without pausing the processing goroutines.

```go
package etl

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Record is the basic unit of data flowing through the pipeline.
type Record struct {
	ID        string
	Source    string
	Data      map[string]any
	Schema    string
	Timestamp time.Time
	Metadata  map[string]string
	Err       error // non-nil if this record has an error
}

// Pipeline orchestrates stages in a directed acyclic graph.
type Pipeline struct {
	stages  []Stage
	metrics PipelineMetrics
	dlq     DeadLetterQueue
	name    string
}

// Stage is one processing step in the pipeline.
type Stage interface {
	Name() string
	Process(ctx context.Context, in <-chan Record) <-chan Record
}

// PipelineMetrics tracks per-stage statistics.
type PipelineMetrics struct {
	processed sync.Map // stage name → *stageCounter
}

type stageCounter struct {
	in      atomic.Int64
	out     atomic.Int64
	errors  atomic.Int64
	dropped atomic.Int64
	latency atomic.Int64 // nanoseconds sum for avg
}

func (m *PipelineMetrics) counter(stageName string) *stageCounter {
	v, _ := m.processed.LoadOrStore(stageName, &stageCounter{})
	return v.(*stageCounter)
}

func (m *PipelineMetrics) Record(stageName string, in, out, errors, dropped int64, latency time.Duration) {
	c := m.counter(stageName)
	c.in.Add(in)
	c.out.Add(out)
	c.errors.Add(errors)
	c.dropped.Add(dropped)
	c.latency.Add(latency.Nanoseconds())
}

// DeadLetterQueue stores records that failed processing.
type DeadLetterQueue interface {
	Send(ctx context.Context, record Record, reason string) error
}

// NewPipeline creates a pipeline with the given name.
func NewPipeline(name string, dlq DeadLetterQueue) *Pipeline {
	return &Pipeline{name: name, dlq: dlq}
}

// AddStage appends a processing stage.
func (p *Pipeline) AddStage(stage Stage) {
	p.stages = append(p.stages, stage)
}

// Run connects all stages and runs the pipeline until the input channel closes.
func (p *Pipeline) Run(ctx context.Context, source <-chan Record, sink ...chan<- Record) error {
	current := source
	for _, stage := range p.stages {
		current = p.instrumentStage(ctx, stage, current)
	}
	var out chan<- Record
	if len(sink) > 0 {
		out = sink[0]
	}
	// Drain the final channel (or forward to sink if provided)
	for record := range current {
		if out != nil {
			select {
			case out <- record:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return nil
}

func (p *Pipeline) instrumentStage(ctx context.Context, stage Stage, in <-chan Record) <-chan Record {
	raw := stage.Process(ctx, in)
	out := make(chan Record, 256)

	go func() {
		defer close(out)
		for record := range raw {
			if record.Err != nil {
				if p.dlq != nil {
					p.dlq.Send(ctx, record, record.Err.Error())
				}
				p.metrics.Record(stage.Name(), 1, 0, 1, 0, 0)
				continue
			}
			select {
			case out <- record:
				p.metrics.Record(stage.Name(), 1, 1, 0, 0, 0)
			case <-ctx.Done():
				return
			}
		}
	}()

	return out
}

// FanOut distributes records to N parallel stage instances.
func FanOut(ctx context.Context, in <-chan Record, n int, stage Stage) <-chan Record {
	outs := make([]<-chan Record, n)
	splits := make([]chan Record, n)
	for i := range splits {
		splits[i] = make(chan Record, 256)
		outs[i] = stage.Process(ctx, splits[i])
	}

	// Round-robin distribution
	go func() {
		defer func() {
			for _, ch := range splits {
				close(ch)
			}
		}()
		i := 0
		for record := range in {
			select {
			case splits[i%n] <- record:
			case <-ctx.Done():
				return
			}
			i++
		}
	}()

	// Merge outputs
	return MergeChannels(ctx, outs...)
}

// MergeChannels merges multiple channels into one.
func MergeChannels(ctx context.Context, ins ...<-chan Record) <-chan Record {
	out := make(chan Record, 256)
	var wg sync.WaitGroup
	for _, ch := range ins {
		wg.Add(1)
		go func(c <-chan Record) {
			defer wg.Done()
			for record := range c {
				select {
				case out <- record:
				case <-ctx.Done():
					return
				}
			}
		}(ch)
	}
	go func() {
		wg.Wait()
		close(out)
	}()
	return out
}
```

### 1.2 Built-in Stage Implementations

With the core `Stage` interface defined, we can build a library of reusable stages. Each stage below follows the same pattern: accept an input channel, spin up a goroutine that processes records, and return an output channel. `FilterStage` drops records that fail a predicate. `MapStage` applies a one-to-one transformation. `BatchStage` accumulates records by count or time before flushing. `DeduplicateStage` tracks seen record IDs in a `sync.Map` with TTL-based expiry. `ValidateStage` checks each record's fields against a set of type and length rules.

```go
package etl

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// FilterStage drops records that don't match a predicate.
type FilterStage struct {
	name      string
	predicate func(Record) bool
}

func NewFilterStage(name string, predicate func(Record) bool) *FilterStage {
	return &FilterStage{name: name, predicate: predicate}
}

func (s *FilterStage) Name() string { return s.name }

func (s *FilterStage) Process(ctx context.Context, in <-chan Record) <-chan Record {
	out := make(chan Record, 256)
	go func() {
		defer close(out)
		for record := range in {
			if s.predicate(record) {
				select {
				case out <- record:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out
}

// MapStage applies a transformation function to each record.
type MapStage struct {
	name      string
	transform func(Record) (Record, error)
}

func NewMapStage(name string, transform func(Record) (Record, error)) *MapStage {
	return &MapStage{name: name, transform: transform}
}

func (s *MapStage) Name() string { return s.name }

func (s *MapStage) Process(ctx context.Context, in <-chan Record) <-chan Record {
	out := make(chan Record, 256)
	go func() {
		defer close(out)
		for record := range in {
			transformed, err := s.transform(record)
			if err != nil {
				record.Err = err
				transformed = record
			}
			select {
			case out <- transformed:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// BatchStage accumulates records into batches.
type BatchStage struct {
	name        string
	size        int
	flushEvery  time.Duration
	processBatch func(context.Context, []Record) ([]Record, error)
}

func NewBatchStage(name string, size int, flush time.Duration,
	process func(context.Context, []Record) ([]Record, error)) *BatchStage {
	return &BatchStage{name: name, size: size, flushEvery: flush, processBatch: process}
}

func (s *BatchStage) Name() string { return s.name }

func (s *BatchStage) Process(ctx context.Context, in <-chan Record) <-chan Record {
	out := make(chan Record, 256)
	go func() {
		defer close(out)
		batch := make([]Record, 0, s.size)
		ticker := time.NewTicker(s.flushEvery)
		defer ticker.Stop()

		flush := func() {
			if len(batch) == 0 {
				return
			}
			results, err := s.processBatch(ctx, batch)
			batch = batch[:0]
			if err != nil {
				// Mark all records in batch as errored
				for _, r := range results {
					r.Err = err
					out <- r
				}
				return
			}
			for _, r := range results {
				select {
				case out <- r:
				case <-ctx.Done():
					return
				}
			}
		}

		for {
			select {
			case record, ok := <-in:
				if !ok {
					flush()
					return
				}
				batch = append(batch, record)
				if len(batch) >= s.size {
					flush()
				}
			case <-ticker.C:
				flush()
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// DeduplicateStage removes records with seen IDs within a time window.
type DeduplicateStage struct {
	name    string
	seen    sync.Map
	ttl     time.Duration
}

type seenEntry struct {
	seenAt time.Time
}

func NewDeduplicateStage(name string, ttl time.Duration) *DeduplicateStage {
	return &DeduplicateStage{name: name, ttl: ttl}
}

func (s *DeduplicateStage) Name() string { return s.name }

func (s *DeduplicateStage) Process(ctx context.Context, in <-chan Record) <-chan Record {
	out := make(chan Record, 256)

	// Cleanup goroutine for expired entries
	go func() {
		ticker := time.NewTicker(s.ttl / 2)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				cutoff := time.Now().Add(-s.ttl)
				s.seen.Range(func(k, v any) bool {
					if v.(seenEntry).seenAt.Before(cutoff) {
						s.seen.Delete(k)
					}
					return true
				})
			case <-ctx.Done():
				return
			}
		}
	}()

	go func() {
		defer close(out)
		for record := range in {
			key := record.Source + ":" + record.ID
			if _, loaded := s.seen.LoadOrStore(key, seenEntry{seenAt: time.Now()}); loaded {
				continue // duplicate - drop
			}
			select {
			case out <- record:
			case <-ctx.Done():
				return
			}
		}
	}()

	return out
}

// ValidateStage checks records against a schema.
type ValidateStage struct {
	name    string
	rules   []ValidationRule
}

// ValidationRule defines one field validation rule.
type ValidationRule struct {
	Field    string
	Required bool
	Type     string // "string", "number", "bool"
	MaxLen   int
}

func NewValidateStage(name string, rules []ValidationRule) *ValidateStage {
	return &ValidateStage{name: name, rules: rules}
}

func (s *ValidateStage) Name() string { return s.name }

func (s *ValidateStage) Process(ctx context.Context, in <-chan Record) <-chan Record {
	out := make(chan Record, 256)
	go func() {
		defer close(out)
		for record := range in {
			if err := s.validate(record); err != nil {
				record.Err = fmt.Errorf("validation: %w", err)
			}
			select {
			case out <- record:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

func (s *ValidateStage) validate(r Record) error {
	for _, rule := range s.rules {
		v, ok := r.Data[rule.Field]
		if rule.Required && !ok {
			return fmt.Errorf("required field missing: %s", rule.Field)
		}
		if !ok {
			continue
		}
		switch rule.Type {
		case "string":
			sv, ok := v.(string)
			if !ok {
				return fmt.Errorf("field %s must be string", rule.Field)
			}
			if rule.MaxLen > 0 && len(sv) > rule.MaxLen {
				return fmt.Errorf("field %s exceeds max length %d", rule.Field, rule.MaxLen)
			}
		case "number":
			switch v.(type) {
			case int, int64, float64:
			default:
				return fmt.Errorf("field %s must be number", rule.Field)
			}
		case "bool":
			if _, ok := v.(bool); !ok {
				return fmt.Errorf("field %s must be bool", rule.Field)
			}
		}
	}
	return nil
}
```

### Junior to FAANG: reading the foundation code line by line

The code above compresses several concurrency patterns that a first-year engineer will find dense. Work through them in order.

Channels as typed pipes. `chan Record` is a typed queue that one goroutine writes to and another reads from. `<-chan Record` is a receive-only view of the same channel. The compiler enforces direction, which prevents a stage from accidentally writing to its own input. The buffer size of 256 in `make(chan Record, 256)` means the writer can enqueue up to 256 records before it blocks waiting for a reader. That blocking is the backpressure mechanism. If you set the buffer to zero the writer blocks on every send until a reader is ready, which is slow. If you set it too high you paper over throughput mismatches and consume memory without catching the real bottleneck. A common starting value is the batch size of the downstream sink times two.

`sync/atomic` counters. The `atomic.Int64` type wraps a 64-bit integer with lock-free `Add` and `Load` operations. Using atomics instead of a mutex means the metrics update does not serialize goroutines. The price is that you cannot atomically read two counters together, so if you need "records processed and errors at the same instant" you need a different pattern. For per-stage throughput this is a non-issue.

`sync.Map` for dedup. Why not a plain `map[string]time.Time` with a mutex? Because `sync.Map` is optimized for the case where entries are written once and read many times, which fits a dedup cache. The downside is higher memory overhead per entry and slower iteration. For dedup windows larger than a few million entries, move to a probabilistic structure like a Bloom filter or Cuckoo filter, or offload to Redis with a short TTL.

Worked example. To wire these primitives together into a minimal working pipeline, imagine ingesting JSON lines from stdin. You would write an extractor that reads `os.Stdin`, parses each line, and pushes a `Record` onto a channel. Then add `NewFilterStage("non-empty", func(r Record) bool { return len(r.Data) > 0 })` to drop empty records. Then add `NewValidateStage` with a rule requiring the `user_id` field. Then add `NewBatchStage` with size 100 and flush every five seconds, where `processBatch` writes the batch to BigQuery. Running this end-to-end on a thousand-line file should process in under a second. Adding a `time.Sleep(10*time.Millisecond)` inside the BigQuery write will cause the batch channel to fill, which pushes back on validate, which pushes back on the extractor, which pauses stdin reads. Watching that cascade in a debugger is the fastest way to internalise backpressure.

Interview entry point. "Why did you put `Err` on the `Record` struct rather than using a separate error channel?" The answer is that an in-band error preserves ordering with respect to the successful records and lets a downstream stage like a DLQ writer see the same stream in sequence. A separate error channel would require a `select` on both channels in every consumer and risks reordering errors relative to successes. Both approaches work. In-band is simpler for DAG-shaped pipelines. A separate channel is preferable when the error handling logic is genuinely different (different rate, different destination, different serialization) from the success path.

### Senior at FAANG: what this foundation does and does not give you

Staff-level review of the code above is less about whether it compiles and more about what operational properties it provides and which it silently omits. Start with the delivery guarantee. The `Pipeline.Run` method closes each stage's output channel when the input closes, which gives a clean shutdown on EOF. It does not give exactly-once. If the process crashes between the `Process` goroutine and the `instrumentStage` forwarder, records in flight are lost. Achieving at-least-once requires durable checkpointing at the extract boundary, so that on restart the extractor resumes from the last acknowledged offset. Achieving exactly-once requires either transactional sinks or idempotent sinks with a deterministic key. Neither is implemented here, and that is a reasonable scope boundary for a chapter, but code that looks this clean will be copied into production by a junior engineer who believes it to be complete. A staff engineer should mark those boundaries in comments and in the chapter text when reviewing.

The `BatchStage` has a subtle bug that is worth calling out because it appears in many real pipelines. When `processBatch` returns an error the code iterates `results` to mark each record as errored, but `results` may be empty or may be a different slice than `batch`. If the sink returns `nil, err` then no records get emitted to the DLQ and the failure is silently swallowed. The correct behavior is to iterate `batch` on error, not `results`. This is the kind of defect that only shows up at three in the morning during an outage. A review should also flag that `out <- r` inside the error branch bypasses the `ctx.Done()` check, so a shutdown during a batch error can hang. The fix is a `select` in both paths. Errors deserve the same cancellation discipline as successes.

Backpressure is implemented correctly for a single-process topology but breaks down in three situations that production pipelines hit regularly. First, fan-out with non-uniform work. The `FanOut` function round-robins records across N workers, but if one record is ten times more expensive than the average (a large document, a slow enrichment lookup), the round-robin worker for that record blocks while others drain. The correct fan-out for variable-cost work is a single input channel shared across N workers rather than N separate input channels. This is the goroutine pool pattern. Second, backpressure does not propagate across process boundaries. When the pipeline is sharded across pods, a slow loader pod causes Kafka lag only on the partitions it owns, not on all partitions. The cure is partition-aware autoscaling, typically Kafka consumer group rebalancing with Keda scaling on lag. Third, backpressure is ineffective against upstream data skew. If one tenant produces 90 percent of the records and their data is badly shaped, the pipeline slows for every tenant. The cure is per-tenant queues or per-tenant rate limits, not bigger buffers.

The `DeduplicateStage` uses an in-memory `sync.Map` with a TTL. That is fine for a single process with a dedup window of minutes. It does not survive a restart, so duplicates that straddle a restart will pass through. It does not coordinate across replicas, so if you run two pipeline pods consuming the same source you will see duplicates that happen to land on different pods. Production dedup has three tiers. Tier one is content-addressed storage at the extract boundary: hash the payload, write to S3 keyed by hash, and use object-exists checks as the dedup primitive. Tier two is a shared Redis set with TTL, which handles cross-replica dedup for windows up to a few hours. Tier three is the sink itself: BigQuery MERGE on a deterministic key, Snowflake MERGE, ClickHouse `ReplacingMergeTree`, Iceberg MERGE. Always prefer sink-level dedup as the source of truth because it survives code bugs in the pipeline.

Metrics. The `PipelineMetrics` counters are lock-free and cheap, but they are not exported. A production pipeline exports per-stage counters to Prometheus using `promauto.NewCounterVec` with labels for stage name, outcome (ok, error, dropped), and source. The labels matter. "Records dropped" without a reason label is a number you cannot act on. "Records dropped by stage=validate reason=schema_mismatch" is an actionable alert. Also export a histogram of per-stage latency so you can set SLOs on p99 rather than averages. Averages hide the tail and the tail is where pipelines fail.

The `ValidateStage` rule engine is a reasonable starter but it has two weaknesses that a senior review will flag. The first is that it checks one rule at a time and returns on the first failure, so the DLQ entry only captures the first validation error. For operator triage you want all violations in one record. Collect errors into a slice, wrap with `errors.Join`, and return a composite error. The second is that the rule set is hardcoded in Go. In a mature pipeline the schema contract lives in a registry (Confluent Schema Registry, Apicurio, or a JSON Schema file in a repo) and the validator is generated from the registry. That separation lets schema changes ship without a pipeline redeploy and lets the same contract be enforced by producers and consumers.

One final architectural note. The `Stage` interface takes `<-chan Record` and returns `<-chan Record`. That is elegant and type-safe, but it locks you into one message type. Real pipelines have heterogeneous stages: an extractor produces `RawRecord`, a parser produces `ParsedRecord`, a loader consumes `ParsedRecord`. Forcing everything through `Record` pushes type information into `map[string]any` and loses compile-time safety. The generics-aware rewrite uses `Stage[In, Out any]` with `Process(ctx, <-chan In) <-chan Out`. The cost is that wiring the graph is more verbose. The benefit is that you catch schema mismatches at `go build` rather than at runtime in prod. Worth the trade in any pipeline that will be operated beyond a single service.

---
