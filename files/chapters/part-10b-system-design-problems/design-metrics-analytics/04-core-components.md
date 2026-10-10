## Core Components

The metrics analytics system is built from four major components that work together in a pipeline. Metrics flow from agents through an ingestion layer, into a stream processor for real-time aggregation, then into a time-series database for storage and querying. An alert engine continuously evaluates rules against incoming data and triggers notifications when thresholds are crossed. Each component is designed to scale independently, so you can add more ingest capacity without changing the query layer.

### 1. Metrics Ingestion

The ingestion service is the front door of the entire system. It receives metric batches from thousands of host-level agents via HTTP, validates each data point, and publishes them to Kafka for downstream processing. Kafka acts as a durable buffer between the unpredictable ingest rate and the database's write capacity, preventing data loss during traffic spikes. The service partitions messages by metric name so that all data points for the same metric land on the same Kafka partition, which enables efficient stream aggregation downstream.

```go
package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// MetricPoint is a single data point
type MetricPoint struct {
	Name      string            `json:"name"`      // e.g., "cpu.usage"
	Tags      map[string]string `json:"tags"`      // host, service, region, etc.
	Value     float64           `json:"value"`
	Timestamp int64             `json:"ts"`        // Unix milliseconds
	Type      MetricType        `json:"type"`
}

// MetricType determines how the metric is aggregated
type MetricType string

const (
	TypeGauge   MetricType = "gauge"   // point-in-time value (CPU %, memory)
	TypeCounter MetricType = "counter" // monotonically increasing (requests total)
	TypeHistogram MetricType = "histogram" // distribution (request latency)
	TypeSummary MetricType = "summary"   // pre-computed quantiles
)

type Validator interface {
	Validate(m MetricPoint) error
}

// IngestService receives metrics from agents
type IngestService struct {
	kafka      *kgo.Client
	batcher    *MetricBatcher
	validators []Validator
}

// Batch is a collection of metrics from one agent
type Batch struct {
	AgentID string        `json:"agent_id"`
	Metrics []MetricPoint `json:"metrics"`
	SentAt  int64         `json:"sent_at"`
}

// HandleBatch processes an incoming metric batch
func (s *IngestService) HandleBatch(w http.ResponseWriter, r *http.Request) {
	var batch Batch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// Validate and normalize
	valid := make([]MetricPoint, 0, len(batch.Metrics))
	for _, m := range batch.Metrics {
		if err := validateMetric(m); err != nil {
			continue // skip invalid metrics
		}
		// Ensure timestamp is set
		if m.Timestamp == 0 {
			m.Timestamp = time.Now().UnixMilli()
		}
		valid = append(valid, m)
	}

	if len(valid) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Publish to Kafka (partitioned by metric name hash for locality)
	if err := s.publishToKafka(ctx, valid); err != nil {
		http.Error(w, "ingest failed", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusAccepted)
}

// publishToKafka publishes metrics to Kafka for stream processing
func (s *IngestService) publishToKafka(ctx context.Context, metrics []MetricPoint) error {
	records := make([]*kgo.Record, 0, len(metrics))
	for _, m := range metrics {
		data, err := json.Marshal(m)
		if err != nil {
			continue
		}
		// Partition by metric name, so the same metric lands on the same
		// partition for efficient stream aggregation
		records = append(records, &kgo.Record{
			Topic: "metrics-raw",
			Key:   []byte(m.Name),
			Value: data,
		})
	}
	return s.kafka.ProduceSync(ctx, records...).FirstErr()
}

func validateMetric(m MetricPoint) error {
	if m.Name == "" {
		return fmt.Errorf("metric name required")
	}
	if len(m.Name) > 200 {
		return fmt.Errorf("metric name too long")
	}
	if len(m.Tags) > 30 {
		return fmt.Errorf("too many tags (max 30)")
	}
	return nil
}

// MetricBatcher batches metrics for efficient storage writes
type MetricBatcher struct {
	mu      sync.Mutex
	buffer  []MetricPoint
	maxSize int
	ticker  *time.Ticker
	flush   func([]MetricPoint) error
}

func (b *MetricBatcher) Add(ctx context.Context, metrics []MetricPoint) {
	b.mu.Lock()
	b.buffer = append(b.buffer, metrics...)
	shouldFlush := len(b.buffer) >= b.maxSize
	b.mu.Unlock()

	if shouldFlush {
		b.Flush(ctx)
	}
}

func (b *MetricBatcher) Flush(ctx context.Context) {
	b.mu.Lock()
	if len(b.buffer) == 0 {
		b.mu.Unlock()
		return
	}
	batch := b.buffer
	b.buffer = make([]MetricPoint, 0, b.maxSize)
	b.mu.Unlock()

	b.flush(batch)
}
```

### 2. Time-Series Storage

The time-series database is where all metric data lives after ingestion. This implementation uses ClickHouse, a columnar database that achieves roughly 10:1 compression on time-series data and supports fast aggregation queries out of the box. The key operations are bulk writes (inserting thousands of data points at once), flexible queries with time-bucketed aggregations (like "average CPU over 5-minute windows"), and a downsample job that converts high-resolution data into lower-resolution summaries for long-term retention.

```go
package tsdb

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
)

type MetricType string

const (
	TypeGauge     MetricType = "gauge"
	TypeCounter   MetricType = "counter"
	TypeHistogram MetricType = "histogram"
	TypeSummary   MetricType = "summary"
)

type MetricPoint struct {
	Name      string
	Tags      map[string]string
	Value     float64
	Timestamp int64
	Type      MetricType
}

// TimeSeriesDB stores and queries metric time-series
// Using ClickHouse: columnar storage, 10:1 compression, fast aggregations
type TimeSeriesDB struct {
	conn clickhouse.Conn
}

// DataPoint is a stored metric reading
type DataPoint struct {
	Timestamp int64   // Unix milliseconds
	Value     float64
}

// WriteMetrics bulk-inserts metrics into ClickHouse
func (db *TimeSeriesDB) WriteMetrics(ctx context.Context, metrics []MetricPoint) error {
	batch, err := db.conn.PrepareBatch(ctx, `
		INSERT INTO metrics (
			timestamp, metric_name, tags_json, value, metric_type
		)`)
	if err != nil {
		return fmt.Errorf("prepare batch: %w", err)
	}

	for _, m := range metrics {
		tagsJSON, _ := json.Marshal(m.Tags)
		if err := batch.Append(
			time.UnixMilli(m.Timestamp),
			m.Name,
			string(tagsJSON),
			m.Value,
			string(m.Type),
		); err != nil {
			continue
		}
	}

	return batch.Send()
}

// QueryRequest defines a metric query
type QueryRequest struct {
	MetricName  string            `json:"metric"`
	Tags        map[string]string `json:"tags"`       // filter by tags
	Start       time.Time         `json:"start"`
	End         time.Time         `json:"end"`
	Aggregation string            `json:"aggregation"` // avg, sum, min, max, p95, p99
	Interval    string            `json:"interval"`    // 1m, 5m, 1h
}

// QueryResult is a time-series query result
type QueryResult struct {
	Metric     string      `json:"metric"`
	Tags       map[string]string `json:"tags"`
	DataPoints []DataPoint `json:"data_points"`
}

// Query retrieves aggregated metric data
func (db *TimeSeriesDB) Query(ctx context.Context, req QueryRequest) ([]QueryResult, error) {
	// Build ClickHouse SQL query
	aggFunc := aggregationSQL(req.Aggregation)
	intervalSec := parseInterval(req.Interval)

	// Build tag filter
	tagFilters := ""
	args := []any{req.MetricName, req.Start, req.End}
	argIdx := 4

	// Bind both the tag key and value as parameters. Interpolating the
	// key into the SQL string would open a SQL injection hole, since tag
	// keys come from user-defined queries.
	for key, val := range req.Tags {
		tagFilters += fmt.Sprintf(` AND JSONExtractString(tags_json, $%d) = $%d`, argIdx, argIdx+1)
		args = append(args, key, val)
		argIdx += 2
	}

	query := fmt.Sprintf(`
		SELECT
			toStartOfInterval(timestamp, INTERVAL %d SECOND) AS ts,
			%s(value) AS agg_value
		FROM metrics
		WHERE metric_name = $1
		  AND timestamp BETWEEN $2 AND $3
		  %s
		GROUP BY ts
		ORDER BY ts ASC`,
		intervalSec, aggFunc, tagFilters,
	)

	rows, err := db.conn.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var points []DataPoint
	for rows.Next() {
		var ts time.Time
		var val float64
		if err := rows.Scan(&ts, &val); err != nil {
			continue
		}
		points = append(points, DataPoint{
			Timestamp: ts.UnixMilli(),
			Value:     val,
		})
	}

	return []QueryResult{{
		Metric:     req.MetricName,
		Tags:       req.Tags,
		DataPoints: points,
	}}, nil
}

// QueryPercentile computes percentile over a time window
func (db *TimeSeriesDB) QueryPercentile(ctx context.Context, metricName string, start, end time.Time, percentile float64) (float64, error) {
	// ClickHouse has native quantile functions
	q := fmt.Sprintf(`
		SELECT quantile(%f)(value)
		FROM metrics
		WHERE metric_name = $1
		  AND timestamp BETWEEN $2 AND $3`,
		percentile/100,
	)

	var result float64
	err := db.conn.QueryRow(ctx, q, metricName, start, end).Scan(&result)
	return result, err
}

// Downsample aggregates high-resolution data into lower-resolution
// Run periodically to maintain retention policy
func (db *TimeSeriesDB) Downsample(ctx context.Context, olderThan time.Time) error {
	// Aggregate 10-second data into 1-minute buckets
	return db.conn.Exec(ctx, `
		INSERT INTO metrics_1m (timestamp, metric_name, tags_json, value_avg, value_min, value_max, value_count)
		SELECT
			toStartOfMinute(timestamp) AS ts,
			metric_name,
			tags_json,
			avg(value), min(value), max(value), count()
		FROM metrics
		WHERE timestamp < $1
		GROUP BY ts, metric_name, tags_json`,
		olderThan,
	)
}

func aggregationSQL(agg string) string {
	switch agg {
	case "avg":
		return "avg"
	case "sum":
		return "sum"
	case "min":
		return "min"
	case "max":
		return "max"
	case "p50":
		return "median"
	case "p95":
		return "quantile(0.95)"
	case "p99":
		return "quantile(0.99)"
	default:
		return "avg"
	}
}

func parseInterval(interval string) int {
	switch interval {
	case "10s":
		return 10
	case "1m":
		return 60
	case "5m":
		return 300
	case "1h":
		return 3600
	default:
		return 60
	}
}
```

### 3. Alert Engine

The alert engine is a background process that continuously evaluates user-defined rules against live metric data. Each rule specifies a metric, a time window, an aggregation function, and a threshold condition (for example, "fire if average CPU exceeds 90% over the last 5 minutes"). The engine uses Redis to track each alert's current state (ok, alerting, or no_data), which prevents duplicate notifications. When a metric crosses its threshold, the engine transitions the alert state and sends a notification through configured channels like Slack, PagerDuty, or email.

```go
package alert

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type DataPoint struct {
	Timestamp int64
	Value     float64
}

type QueryRequest struct {
	MetricName  string
	Tags        map[string]string
	Start       time.Time
	End         time.Time
	Aggregation string
	Interval    string
}

type QueryResult struct {
	Metric     string
	Tags       map[string]string
	DataPoints []DataPoint
}

type TimeSeriesQuerier interface {
	Query(ctx context.Context, req QueryRequest) ([]QueryResult, error)
}

type Notifier interface {
	Send(ctx context.Context, n Notification) error
}

// AlertEngine evaluates alert rules against incoming metrics
type AlertEngine struct {
	db     *pgxpool.Pool
	rdb    *redis.Client
	tsdb   TimeSeriesQuerier
	notify Notifier
}

// AlertRule defines when to fire an alert
type AlertRule struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	MetricName string            `json:"metric"`
	Tags       map[string]string `json:"tags"`       // filter
	Condition  AlertCondition    `json:"condition"`
	Window     string            `json:"window"`     // "5m", "15m"
	Aggregation string           `json:"aggregation"` // avg, max, p99
	Severity   string            `json:"severity"`   // critical, warning, info
	Channels   []string          `json:"channels"`   // notification channels
	Enabled    bool              `json:"enabled"`
}

type AlertCondition struct {
	Operator  string  `json:"operator"`
	Threshold float64 `json:"threshold"`
}

// AlertState tracks the current state of an alert
type AlertState struct {
	RuleID    string
	Status    string    // ok, alerting, no_data
	Value     float64
	FiredAt   *time.Time
	ResolvedAt *time.Time
}

// EvaluateAll evaluates all enabled alert rules
func (e *AlertEngine) EvaluateAll(ctx context.Context) error {
	rules, err := e.loadEnabledRules(ctx)
	if err != nil {
		return err
	}

	for _, rule := range rules {
		if err := e.evaluateRule(ctx, rule); err != nil {
			// Log error but continue evaluating other rules
			fmt.Printf("error evaluating rule %s: %v\n", rule.ID, err)
		}
	}
	return nil
}

// evaluateRule checks one alert rule against current metric values
func (e *AlertEngine) evaluateRule(ctx context.Context, rule AlertRule) error {
	// Query current metric value
	end := time.Now()
	start := end.Add(-parseDuration(rule.Window))

	result, err := e.tsdb.Query(ctx, QueryRequest{
		MetricName:  rule.MetricName,
		Tags:        rule.Tags,
		Start:       start,
		End:         end,
		Aggregation: rule.Aggregation,
		Interval:    rule.Window,
	})
	if err != nil {
		return e.setAlertState(ctx, rule.ID, "no_data")
	}

	if len(result) == 0 || len(result[0].DataPoints) == 0 {
		return e.setAlertState(ctx, rule.ID, "no_data")
	}

	// Get most recent value
	latest := result[0].DataPoints[len(result[0].DataPoints)-1].Value

	// Evaluate condition
	firing := evaluateCondition(latest, rule.Condition.Operator, rule.Condition.Threshold)

	if firing {
		return e.fireAlert(ctx, rule, latest)
	}

	return e.resolveAlert(ctx, rule, latest)
}

func (e *AlertEngine) fireAlert(ctx context.Context, rule AlertRule, value float64) error {
	stateKey := fmt.Sprintf("alert:state:%s", rule.ID)

	// Check if already firing (prevent alert storm)
	currentState, _ := e.rdb.Get(ctx, stateKey).Result()
	if currentState == "alerting" {
		return nil // already firing, no re-notification
	}

	now := time.Now()

	// Record state
	e.rdb.Set(ctx, stateKey, "alerting", 0) // no expiry
	e.saveAlertEvent(ctx, rule.ID, "fired", value)

	// Send notifications
	return e.notify.Send(ctx, Notification{
		RuleID:   rule.ID,
		RuleName: rule.Name,
		Severity: rule.Severity,
		Message:  fmt.Sprintf("[%s] %s is %.2f (threshold: %.2f)", rule.Severity, rule.MetricName, value, rule.Condition.Threshold),
		Value:    value,
		FiredAt:  now,
		Channels: rule.Channels,
	})
}

func (e *AlertEngine) resolveAlert(ctx context.Context, rule AlertRule, value float64) error {
	stateKey := fmt.Sprintf("alert:state:%s", rule.ID)

	currentState, _ := e.rdb.Get(ctx, stateKey).Result()
	if currentState != "alerting" {
		return nil // wasn't firing
	}

	// Alert resolved
	e.rdb.Set(ctx, stateKey, "ok", 0)
	e.saveAlertEvent(ctx, rule.ID, "resolved", value)

	return e.notify.Send(ctx, Notification{
		RuleID:   rule.ID,
		RuleName: rule.Name,
		Severity: "info",
		Message:  fmt.Sprintf("[RESOLVED] %s is back to normal: %.2f", rule.MetricName, value),
		Value:    value,
		Channels: rule.Channels,
	})
}

func evaluateCondition(value float64, operator string, threshold float64) bool {
	switch operator {
	case "gt":
		return value > threshold
	case "lt":
		return value < threshold
	case "gte":
		return value >= threshold
	case "lte":
		return value <= threshold
	case "eq":
		return math.Abs(value-threshold) < 1e-9
	}
	return false
}

func (e *AlertEngine) setAlertState(ctx context.Context, ruleID, status string) error {
	stateKey := fmt.Sprintf("alert:state:%s", ruleID)
	return e.rdb.Set(ctx, stateKey, status, 0).Err()
}

func (e *AlertEngine) saveAlertEvent(ctx context.Context, ruleID, event string, value float64) {
	e.db.Exec(ctx, `
		INSERT INTO alert_events (rule_id, event, value, occurred_at)
		VALUES ($1, $2, $3, NOW())`,
		ruleID, event, value,
	)
}

func (e *AlertEngine) loadEnabledRules(ctx context.Context) ([]AlertRule, error) {
	// "window" is a reserved word in PostgreSQL, so it must be quoted
	rows, err := e.db.Query(ctx, `
		SELECT id, name, metric_name, tags, condition, "window", aggregation, severity, channels
		FROM alert_rules WHERE enabled = true`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rules []AlertRule
	for rows.Next() {
		var r AlertRule
		var tagsJSON, condJSON []byte
		if err := rows.Scan(&r.ID, &r.Name, &r.MetricName, &tagsJSON, &condJSON,
			&r.Window, &r.Aggregation, &r.Severity, &r.Channels); err != nil {
			return nil, err
		}
		if len(tagsJSON) > 0 {
			if err := json.Unmarshal(tagsJSON, &r.Tags); err != nil {
				return nil, fmt.Errorf("rule %s: bad tags: %w", r.ID, err)
			}
		}
		if err := json.Unmarshal(condJSON, &r.Condition); err != nil {
			return nil, fmt.Errorf("rule %s: bad condition: %w", r.ID, err)
		}
		r.Enabled = true
		rules = append(rules, r)
	}
	return rules, rows.Err()
}

type Notification struct {
	RuleID   string
	RuleName string
	Severity string
	Message  string
	Value    float64
	FiredAt  time.Time
	Channels []string
}

func parseDuration(s string) time.Duration {
	switch s {
	case "1m":
		return time.Minute
	case "5m":
		return 5 * time.Minute
	case "15m":
		return 15 * time.Minute
	case "1h":
		return time.Hour
	default:
		return 5 * time.Minute
	}
}
```

### 4. Stream Aggregation (Flink-style)

The stream aggregator sits between Kafka and the time-series database, building the 1-minute rollup tier in real time. It groups incoming raw points into 1-minute windows and computes summary statistics (average, min, max, count) for each unique metric-plus-tags combination. Since each series reports every 10 seconds, six raw points collapse into one rollup row, cutting the long-term write volume roughly 6x, from 1 million raw points per second to about 167 thousand rollup rows per second. The aggregator uses a map of window accumulators keyed by metric name and tags, flushing completed windows to the database on a timer.

```go
package stream

import (
	"context"
	"encoding/json"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

type MetricPoint struct {
	Name      string
	Tags      map[string]string
	Value     float64
	Timestamp int64
}

type TimeSeriesWriter interface {
	WriteRollups(ctx context.Context, rollups []RollupPoint) error
}

// StreamAggregator processes the raw metric stream
// Builds the 1-minute rollup tier in real time
// Cuts long-term write volume: 1M raw/sec → ~167K rollup rows/sec
type StreamAggregator struct {
	kafka   *kgo.Client
	tsdb    TimeSeriesWriter
	windows map[string]*WindowAccumulator // metric_key → accumulator
	mu      sync.Mutex
	ticker  *time.Ticker
}

// WindowAccumulator accumulates values within a time window.
// It keeps only running statistics, never the raw values, so memory
// stays bounded by series cardinality rather than ingest rate.
type WindowAccumulator struct {
	MetricName string
	Tags       map[string]string
	Sum        float64
	Min        float64
	Max        float64
	Count      int64
	WindowEnd  time.Time
}

// ProcessStream continuously reads from Kafka and aggregates
func (s *StreamAggregator) ProcessStream(ctx context.Context) {
	go s.flushLoop(ctx)

	for {
		fetches := s.kafka.PollFetches(ctx)
		fetches.EachRecord(func(r *kgo.Record) {
			var m MetricPoint
			if err := json.Unmarshal(r.Value, &m); err != nil {
				return
			}
			s.accumulate(m)
		})
	}
}

// accumulate adds a data point to its window accumulator
func (s *StreamAggregator) accumulate(m MetricPoint) {
	key := metricKey(m)

	s.mu.Lock()
	defer s.mu.Unlock()

	acc, ok := s.windows[key]
	if !ok {
		acc = &WindowAccumulator{
			MetricName: m.Name,
			Tags:       m.Tags,
			Min:        m.Value,
			Max:        m.Value,
			WindowEnd:  time.Now().Truncate(time.Minute).Add(time.Minute),
		}
		s.windows[key] = acc
	}

	acc.Sum += m.Value
	acc.Count++
	if m.Value < acc.Min {
		acc.Min = m.Value
	}
	if m.Value > acc.Max {
		acc.Max = m.Value
	}
}

// flushLoop periodically flushes aggregated windows to TSDB
func (s *StreamAggregator) flushLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.flushExpired(ctx, now)
		}
	}
}

func (s *StreamAggregator) flushExpired(ctx context.Context, now time.Time) {
	s.mu.Lock()
	toFlush := make([]*WindowAccumulator, 0)
	for key, acc := range s.windows {
		if now.After(acc.WindowEnd) {
			toFlush = append(toFlush, acc)
			delete(s.windows, key)
		}
	}
	s.mu.Unlock()

	if len(toFlush) == 0 {
		return
	}

	// Write one rollup row per series per window to metrics_1m
	rollups := make([]RollupPoint, 0, len(toFlush))
	for _, acc := range toFlush {
		rollups = append(rollups, RollupPoint{
			Name:      acc.MetricName,
			Tags:      acc.Tags,
			Avg:       acc.Sum / float64(acc.Count),
			Min:       acc.Min,
			Max:       acc.Max,
			Count:     acc.Count,
			Timestamp: acc.WindowEnd.Add(-time.Minute).UnixMilli(), // window start
		})
	}

	if err := s.tsdb.WriteRollups(ctx, rollups); err != nil {
		// Kafka offsets are not committed until the write succeeds,
		// so a failed flush is retried on restart rather than lost
		log.Printf("rollup flush failed: %v", err)
	}
}

// RollupPoint is one pre-aggregated 1-minute row for the metrics_1m table
type RollupPoint struct {
	Name      string
	Tags      map[string]string
	Avg       float64
	Min       float64
	Max       float64
	Count     int64
	Timestamp int64 // window start, Unix milliseconds
}

func metricKey(m MetricPoint) string {
	// Stable key from name + sorted tags
	tags := make([]string, 0, len(m.Tags))
	for k, v := range m.Tags {
		tags = append(tags, k+"="+v)
	}
	slices.Sort(tags)
	return m.Name + "{" + strings.Join(tags, ",") + "}"
}
```

---
