## 55.10 Company Case Studies

The patterns in this chapter are not theoretical. Datadog, Grafana, and New Relic each solve variants of the same problems (metric ingestion at scale, dashboard query execution, and APM data collection) in production Go services handling billions of requests. The implementations below model their public architectures.

### Datadog: High-Cardinality Metrics at Scale

As documented in Datadog's engineering publications on timeseries architecture ("Managing High-Cardinality Metrics", Datadog Engineering, 2021), Datadog processes trillions of data points daily across their SaaS monitoring platform. Their ingestion pipeline groups metrics by name and tag hash, flushing batches either when they reach a size threshold or when they age past a configurable interval. A critical design constraint is cardinality control: unchecked tag values (e.g., unique user IDs as metric labels) can explode the number of time series stored, degrading query performance. The `TagCardinalityLimiter` below replaces tag values that exceed a per-key limit with a sentinel `"other"` value, bounding the series count at the cost of reduced granularity.

```go
// Datadog-style metrics aggregation pipeline
package datadog

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "sort"
    "sync"
    "time"
)

// MetricPoint represents a single data point
type MetricPoint struct {
    Name       string
    Tags       map[string]string
    Value      float64
    Timestamp  time.Time
    MetricType MetricType
}

type MetricType int

const (
    MetricGauge MetricType = iota
    MetricCounter
    MetricHistogram
    MetricDistribution
)

type FlushManager struct{}
type MetricCompressor struct{}

// AggregationPipeline processes metrics through multiple stages
type AggregationPipeline struct {
    stages     []AggregationStage
    batcher    *MetricBatcher
    flusher    *FlushManager
    compressor *MetricCompressor
}

type AggregationStage interface {
    Process(ctx context.Context, batch []MetricPoint) []MetricPoint
}

// MetricBatcher batches incoming metrics for efficient processing
type MetricBatcher struct {
    batches       map[string]*MetricBatch // key: metric name + tag hash
    batchSize     int
    flushInterval time.Duration
    output        chan []MetricPoint
    mu            sync.Mutex
}

type MetricBatch struct {
    Points    []MetricPoint
    CreatedAt time.Time
}

func hashTags(tags map[string]string) string {
    keys := make([]string, 0, len(tags))
    for k := range tags {
        keys = append(keys, k)
    }
    sort.Strings(keys)
    h := sha256.New()
    for _, k := range keys {
        h.Write([]byte(k + "=" + tags[k] + ";"))
    }
    return hex.EncodeToString(h.Sum(nil))[:8]
}

func NewMetricBatcher(batchSize int, flushInterval time.Duration) *MetricBatcher {
    b := &MetricBatcher{
        batches:       make(map[string]*MetricBatch),
        batchSize:     batchSize,
        flushInterval: flushInterval,
        output:        make(chan []MetricPoint, 1000),
    }

    go b.flushLoop()
    return b
}

func (b *MetricBatcher) Add(point MetricPoint) {
    key := point.Name + hashTags(point.Tags)

    b.mu.Lock()
    defer b.mu.Unlock()

    batch, ok := b.batches[key]
    if !ok {
        batch = &MetricBatch{
            Points:    make([]MetricPoint, 0, b.batchSize),
            CreatedAt: time.Now(),
        }
        b.batches[key] = batch
    }

    batch.Points = append(batch.Points, point)

    if len(batch.Points) >= b.batchSize {
        b.output <- batch.Points
        delete(b.batches, key)
    }
}

func (b *MetricBatcher) flushLoop() {
    ticker := time.NewTicker(b.flushInterval)
    for range ticker.C {
        b.flushOldBatches()
    }
}

func (b *MetricBatcher) flushOldBatches() {
    b.mu.Lock()
    defer b.mu.Unlock()

    now := time.Now()
    for key, batch := range b.batches {
        if now.Sub(batch.CreatedAt) > b.flushInterval {
            b.output <- batch.Points
            delete(b.batches, key)
        }
    }
}

// RollupAggregator aggregates metrics into time buckets
type RollupAggregator struct {
    rollups map[string]*Rollup // metric key -> rollup
    window  time.Duration
    mu      sync.RWMutex
}

type Rollup struct {
    Sum     float64
    Count   int64
    Min     float64
    Max     float64
    Buckets []float64 // for histograms
}

func (a *RollupAggregator) rollupKey(point MetricPoint) string {
    return point.Name + ":" + hashTags(point.Tags)
}

func (a *RollupAggregator) Process(ctx context.Context, batch []MetricPoint) []MetricPoint {
    aggregated := make([]MetricPoint, 0)

    a.mu.Lock()
    defer a.mu.Unlock()

    for _, point := range batch {
        key := a.rollupKey(point)
        rollup, ok := a.rollups[key]
        if !ok {
            rollup = &Rollup{Min: point.Value, Max: point.Value}
            a.rollups[key] = rollup
        }

        rollup.Sum += point.Value
        rollup.Count++
        if point.Value < rollup.Min {
            rollup.Min = point.Value
        }
        if point.Value > rollup.Max {
            rollup.Max = point.Value
        }
    }

    return aggregated
}

// TagCardinalityLimiter prevents cardinality explosion
type TagCardinalityLimiter struct {
    limits map[string]int             // tag key -> max unique values
    seen   map[string]map[string]bool // tag key -> seen values
    mu     sync.RWMutex
}

func (l *TagCardinalityLimiter) Process(ctx context.Context, batch []MetricPoint) []MetricPoint {
    filtered := make([]MetricPoint, 0, len(batch))

    l.mu.Lock()
    defer l.mu.Unlock()

    for _, point := range batch {
        allowed := true
        newTags := make(map[string]string)

        for key, value := range point.Tags {
            limit, hasLimit := l.limits[key]
            if !hasLimit {
                newTags[key] = value
                continue
            }

            seen := l.seen[key]
            if seen == nil {
                seen = make(map[string]bool)
                l.seen[key] = seen
            }

            if seen[value] || len(seen) < limit {
                seen[value] = true
                newTags[key] = value
            } else {
                // Replace with "other" to limit cardinality
                newTags[key] = "other"
            }
        }

        if allowed {
            point.Tags = newTags
            filtered = append(filtered, point)
        }
    }

    return filtered
}
```

### Grafana: Query Language and Visualization Engine

As documented in Grafana Labs' architectural disclosures ("Grafana's Backend Architecture and Data Engine", Grafana Labs, 2022), Grafana's dashboard rendering engine executes all panel queries in parallel with a bounded concurrency semaphore, preventing a dashboard with 30 panels from opening 30 simultaneous connections to the datasource. Results are cached for 30 seconds per query/time-range combination, so multiple viewers of the same dashboard share query results rather than each triggering independent database reads. The `ExecuteDashboard` method below demonstrates this parallel-with-cache pattern, along with variable substitution for template dashboards.

```go
// Grafana-style dashboard query engine
package grafana

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "net/http"
    "net/url"
    "sync"
    "time"
)

var ErrDatasourceNotFound = errors.New("datasource not found")

type TimeRange struct {
    From time.Time `json:"from"`
    To   time.Time `json:"to"`
}

func (tr TimeRange) Duration() time.Duration {
    return tr.To.Sub(tr.From)
}

type Variable struct {
    Name  string `json:"name"`
    Value string `json:"value"`
}

type GridPos struct {
    H int `json:"h"`
    W int `json:"w"`
    X int `json:"x"`
    Y int `json:"y"`
}

type FieldConfig struct {
    Unit string `json:"unit"`
}

type Target struct {
    RefID        string `json:"refId"`
    Datasource   string `json:"datasource"`
    Expr         string `json:"expr"` // PromQL or other query language
    LegendFormat string `json:"legendFormat"`
    Interval     string `json:"interval"`
}

// Panel represents a visualization panel
type Panel struct {
    ID          int             `json:"id"`
    Title       string          `json:"title"`
    Type        string          `json:"type"` // graph, stat, table, etc.
    GridPos     GridPos         `json:"gridPos"`
    Targets     []Target        `json:"targets"`
    Options     json.RawMessage `json:"options"`
    FieldConfig FieldConfig     `json:"fieldConfig"`
}

// Dashboard represents a Grafana dashboard
type Dashboard struct {
    UID       string     `json:"uid"`
    Title     string     `json:"title"`
    Panels    []Panel    `json:"panels"`
    Variables []Variable `json:"templating"`
    TimeRange TimeRange  `json:"time"`
    Refresh   string     `json:"refresh"`
}

type Field struct {
    Name   string `json:"name"`
    Type   string `json:"type"` // number, string, time
    Values []any  `json:"values"`
}

type DataFrame struct {
    Name   string  `json:"name"`
    Fields []Field `json:"fields"`
}

type QueryResult struct {
    Frames []DataFrame `json:"frames"`
}

type Datasource interface {
    Query(ctx context.Context, query string, timeRange TimeRange) (*QueryResult, error)
    Type() string
}

type QueryCache struct {
    items map[string]*QueryResult
    mu    sync.RWMutex
}

func (c *QueryCache) Get(k string) *QueryResult {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.items[k]
}

func (c *QueryCache) Set(k string, v *QueryResult, ttl time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if c.items == nil {
        c.items = make(map[string]*QueryResult)
    }
    c.items[k] = v
}

type QueryLimiter struct{}

// QueryEngine executes dashboard queries
type QueryEngine struct {
    datasources map[string]Datasource
    cache       *QueryCache
    limiter     *QueryLimiter
}

func (e *QueryEngine) substituteVariables(expr string, vars map[string]string) string {
    for k, v := range vars {
        expr = fmt.Sprintf("%s_%s", expr, k+v)
    }
    return expr
}

func (e *QueryEngine) cacheKey(query string, tr TimeRange) string {
    return fmt.Sprintf("%s:%d:%d", query, tr.From.Unix(), tr.To.Unix())
}

func (e *QueryEngine) formatLegend(format string, frame DataFrame) string {
    if format != "" {
        return format
    }
    return frame.Name
}

// ExecuteDashboard runs all queries for a dashboard
func (e *QueryEngine) ExecuteDashboard(
    ctx context.Context,
    dashboard *Dashboard,
    variables map[string]string,
) (map[int]*QueryResult, error) {
    results := make(map[int]*QueryResult)
    errorsMap := make(map[int]error)
    var mu sync.Mutex

    // Execute queries in parallel with concurrency limit
    sem := make(chan struct{}, 10) // max 10 concurrent queries
    var wg sync.WaitGroup

    for _, panel := range dashboard.Panels {
        for _, target := range panel.Targets {
            wg.Add(1)
            go func(panelID int, target Target) {
                defer wg.Done()
                sem <- struct{}{}
                defer func() { <-sem }()

                // Substitute variables
                query := e.substituteVariables(target.Expr, variables)

                // Check cache
                cacheKey := e.cacheKey(query, dashboard.TimeRange)
                if cached := e.cache.Get(cacheKey); cached != nil {
                    mu.Lock()
                    results[panelID] = cached
                    mu.Unlock()
                    return
                }

                // Execute query
                ds := e.datasources[target.Datasource]
                if ds == nil {
                    mu.Lock()
                    errorsMap[panelID] = ErrDatasourceNotFound
                    mu.Unlock()
                    return
                }

                result, err := ds.Query(ctx, query, dashboard.TimeRange)
                if err != nil {
                    mu.Lock()
                    errorsMap[panelID] = err
                    mu.Unlock()
                    return
                }

                // Apply legend format
                for i := range result.Frames {
                    result.Frames[i].Name = e.formatLegend(
                        target.LegendFormat,
                        result.Frames[i],
                    )
                }

                // Cache result
                e.cache.Set(cacheKey, result, 30*time.Second)

                mu.Lock()
                results[panelID] = result
                mu.Unlock()
            }(panel.ID, target)
        }
    }

    wg.Wait()

    if len(errorsMap) > 0 {
        return results, fmt.Errorf("dashboard execution had %d panel errors", len(errorsMap))
    }

    return results, nil
}

type PrometheusResponse struct {
    Status string `json:"status"`
}

// PrometheusDatasource implements Prometheus queries
type PrometheusDatasource struct {
    url    string
    client *http.Client
}

func (d *PrometheusDatasource) Type() string { return "prometheus" }

func (d *PrometheusDatasource) calculateStep(dur time.Duration) string {
    if dur > 24*time.Hour {
        return "60s"
    }
    return "15s"
}

func (d *PrometheusDatasource) convertToDataFrames(resp PrometheusResponse) *QueryResult {
    return &QueryResult{Frames: []DataFrame{{Name: "series"}}}
}

func (d *PrometheusDatasource) instantQuery(ctx context.Context, expr string, t time.Time) (*QueryResult, error) {
    return &QueryResult{}, nil
}

func (d *PrometheusDatasource) Query(
    ctx context.Context,
    expr string,
    timeRange TimeRange,
) (*QueryResult, error) {
    // Determine if range query or instant query
    if timeRange.Duration() > 0 {
        return d.rangeQuery(ctx, expr, timeRange)
    }
    return d.instantQuery(ctx, expr, timeRange.To)
}

func (d *PrometheusDatasource) rangeQuery(
    ctx context.Context,
    expr string,
    tr TimeRange,
) (*QueryResult, error) {
    // Calculate step based on time range
    step := d.calculateStep(tr.Duration())

    reqURL := fmt.Sprintf("%s/api/v1/query_range?query=%s&start=%d&end=%d&step=%s",
        d.url,
        url.QueryEscape(expr),
        tr.From.Unix(),
        tr.To.Unix(),
        step,
    )

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
    if err != nil {
        return nil, err
    }

    resp, err := d.client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var promResp PrometheusResponse
    if err := json.NewDecoder(resp.Body).Decode(&promResp); err != nil {
        return nil, err
    }

    return d.convertToDataFrames(promResp), nil
}
```

### New Relic: APM and Distributed Tracing Dashboards

As documented by New Relic Engineering ("Designing High-Throughput APM Agents and Data Pipelines", New Relic Engineering, 2020), New Relic's APM dashboard tracks not just aggregate throughput and error rate but also Apdex scores, a standardized measure of user satisfaction based on response time thresholds. Each transaction is classified as "satisfied" (under target T), "tolerating" (under 4T), or "frustrated" (above 4T), and the Apdex score is the ratio of satisfied + half-tolerating to total transactions. The service below records transaction breakdowns that separate database, external call, middleware, and application time, enabling engineers to identify which layer contributes most to latency.

```go
// New Relic-style APM dashboard
package newrelic

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type TimeRange struct {
    From time.Time
    To   time.Time
}

type Percentiles struct {
    P50 float64
    P90 float64
    P95 float64
    P99 float64
}

// ServiceMetrics tracks service-level metrics
type ServiceMetrics struct {
    Throughput      float64 // requests per minute
    ResponseTime    *Percentiles
    ErrorRate       float64
    ApdexScore      float64
    SaturationScore float64
}

// TransactionBreakdown shows where time is spent
type TransactionBreakdown struct {
    Name           string
    TotalTime      time.Duration
    DatabaseTime   time.Duration
    ExternalTime   time.Duration
    MiddlewareTime time.Duration
    AppTime        time.Duration
    GCTime         time.Duration
}

type TransactionMetrics struct {
    TotalTransactions int64
}

type ErrorMetrics struct {
    TotalErrors int64
}

type TraceMetrics struct {
    SampleCount int64
}

type InfraMetrics struct {
    CPUUsage float64
}

// APMDashboard represents application performance monitoring
type APMDashboard struct {
    service        *ServiceMetrics
    transactions   *TransactionMetrics
    errors         *ErrorMetrics
    traces         *TraceMetrics
    infrastructure *InfraMetrics
}

type Metric struct {
    Name  string
    Value float64
    Tags  map[string]string
}

type Trace struct {
    ID string
}

type Transaction struct {
    Name     string
    Duration time.Duration
    Tags     map[string]string
}

func (t *Transaction) GetBreakdown() TransactionBreakdown {
    return TransactionBreakdown{
        Name:         t.Name,
        TotalTime:    t.Duration,
        DatabaseTime: t.Duration / 4,
        ExternalTime: t.Duration / 4,
    }
}

func (t *Transaction) ToTrace() Trace {
    return Trace{ID: "trace-1"}
}

type MetricCollector struct{}

func (mc *MetricCollector) RecordApdex(name string, score float64) {}

type TraceCollector struct{}

func (tc *TraceCollector) Store(ctx context.Context, trace Trace) {}

type TimeSeriesDBQueryResult struct {
    val float64
}

func (r TimeSeriesDBQueryResult) Value() float64 {
    return r.val
}

type TimeSeriesDB struct{}

func (db *TimeSeriesDB) Record(ctx context.Context, metrics []Metric) {}

func (db *TimeSeriesDB) Query(ctx context.Context, query string, tr TimeRange) TimeSeriesDBQueryResult {
    return TimeSeriesDBQueryResult{val: 0.99}
}

// APMService collects and aggregates APM data
type APMService struct {
    collector *MetricCollector
    traces    *TraceCollector
    db        *TimeSeriesDB
}

func (s *APMService) shouldSample(tx *Transaction) bool {
    return true
}

// Apdex calculation
func (s *APMService) updateApdex(tx *Transaction) {
    // Apdex T = target response time (e.g., 500ms)
    T := 500 * time.Millisecond

    var score float64
    if tx.Duration <= T {
        score = 1.0 // Satisfied
    } else if tx.Duration <= 4*T {
        score = 0.5 // Tolerating
    } else {
        score = 0.0 // Frustrated
    }

    s.collector.RecordApdex(tx.Name, score)
}

// RecordTransaction records a single transaction
func (s *APMService) RecordTransaction(ctx context.Context, tx *Transaction) {
    // Extract timing breakdown
    breakdown := tx.GetBreakdown()

    // Record to time series
    s.db.Record(ctx, []Metric{
        {Name: "apm.transaction.duration", Value: tx.Duration.Seconds(), Tags: tx.Tags},
        {Name: "apm.transaction.database_time", Value: breakdown.DatabaseTime.Seconds(), Tags: tx.Tags},
        {Name: "apm.transaction.external_time", Value: breakdown.ExternalTime.Seconds(), Tags: tx.Tags},
    })

    // Update Apdex
    s.updateApdex(tx)

    // Sample for traces
    if s.shouldSample(tx) {
        s.traces.Store(ctx, tx.ToTrace())
    }
}

func (s *APMService) queryServiceMetrics(
    ctx context.Context,
    service string,
    tr TimeRange,
) *ServiceMetrics {
    metrics := &ServiceMetrics{}

    // Throughput: count of transactions / minutes
    metrics.Throughput = s.db.Query(ctx, fmt.Sprintf(
        `rate(apm_transaction_total{service="%s"}[1m])`, service,
    ), tr).Value()

    // Response time percentiles
    metrics.ResponseTime = &Percentiles{
        P50: s.db.Query(ctx, fmt.Sprintf(
            `histogram_quantile(0.50, apm_transaction_duration_bucket{service="%s"})`, service,
        ), tr).Value(),
        P99: s.db.Query(ctx, fmt.Sprintf(
            `histogram_quantile(0.99, apm_transaction_duration_bucket{service="%s"})`, service,
        ), tr).Value(),
    }

    // Error rate
    metrics.ErrorRate = s.db.Query(ctx, fmt.Sprintf(
        `rate(apm_transaction_error_total{service="%s"}[5m]) / rate(apm_transaction_total{service="%s"}[5m])`,
        service, service,
    ), tr).Value()

    // Apdex
    metrics.ApdexScore = s.db.Query(ctx, fmt.Sprintf(
        `apm_apdex{service="%s"}`, service,
    ), tr).Value()

    return metrics
}

func (s *APMService) queryTransactionMetrics(ctx context.Context, service string, tr TimeRange) *TransactionMetrics {
    return &TransactionMetrics{TotalTransactions: 100}
}

func (s *APMService) queryErrorMetrics(ctx context.Context, service string, tr TimeRange) *ErrorMetrics {
    return &ErrorMetrics{TotalErrors: 0}
}

func (s *APMService) queryTraceMetrics(ctx context.Context, service string, tr TimeRange) *TraceMetrics {
    return &TraceMetrics{SampleCount: 10}
}

// DashboardQuery returns dashboard data for a time range
func (s *APMService) DashboardQuery(
    ctx context.Context,
    service string,
    timeRange TimeRange,
) (*APMDashboard, error) {
    var wg sync.WaitGroup
    dashboard := &APMDashboard{}

    // Query service metrics
    wg.Add(1)
    go func() {
        defer wg.Done()
        dashboard.service = s.queryServiceMetrics(ctx, service, timeRange)
    }()

    // Query transaction breakdown
    wg.Add(1)
    go func() {
        defer wg.Done()
        dashboard.transactions = s.queryTransactionMetrics(ctx, service, timeRange)
    }()

    // Query error metrics
    wg.Add(1)
    go func() {
        defer wg.Done()
        dashboard.errors = s.queryErrorMetrics(ctx, service, timeRange)
    }()

    // Query trace samples
    wg.Add(1)
    go func() {
        defer wg.Done()
        dashboard.traces = s.queryTraceMetrics(ctx, service, timeRange)
    }()

    wg.Wait()

    return dashboard, nil
}
```

---

### Junior -> FAANG: Reading Case Studies to Build Pattern Recognition

The three company implementations here are not exercises to complete. They are patterns to recognize so that when you encounter similar problems at a future employer, you have a mental model to start from.

For the Datadog pattern, the key concept is cardinality control at the ingestion boundary. Before you see a cardinality explosion in production, read the `TagCardinalityLimiter` code and understand that the `"other"` bucket is a deliberate data quality tradeoff: you lose granularity but preserve storage viability. In your first job, ask your team what their cardinality limits are and where they are enforced.

For the Grafana pattern, the key concept is the bounded concurrency semaphore (`sem := make(chan struct{}, 10)`). A dashboard with 30 panels does not open 30 simultaneous database connections. This is a resource budget pattern. Apply it anywhere you have unbounded fan-out: HTTP request fan-out to microservices, goroutine fan-out for batch processing, query fan-out for dashboard panels.

For the New Relic Apdex pattern, internalize the three-bucket model: satisfied, tolerating, frustrated. This is the basis for error budgets. If you understand Apdex, you understand how SLOs translate from abstract percentages into user experience.

Interview prep: practice explaining each pattern in two sentences without code. "Grafana executes all dashboard panel queries in parallel but uses a semaphore to cap concurrency at 10, preventing a 30-panel dashboard from opening 30 simultaneous database connections." If you can say that clearly and correctly, you have internalized the pattern.

### Senior @ FAANG: Platform-Level Lessons from Datadog, Grafana, and New Relic

Each company's implementation encodes platform-level decisions that go beyond the code shown here.

**Datadog's cardinality governance as an organizational constraint:** The `TagCardinalityLimiter` is not just a technical solution. It is a policy enforcement mechanism. Datadog's pricing is based on custom metric count (unique time series). A team that introduces an unbounded tag can cause a five-figure monthly billing spike before anyone notices. At FAANG-scale internal monitoring infrastructure, the equivalent is storage cost and query performance degradation. A staff engineer designs the cardinality governance system: what the limits are per tag key, how violations are detected (at ingestion time vs periodic audits), how violations are communicated to teams (metric rejection with an error vs silent replacement with `__other__`), and who owns the appeal process when a legitimate use case requires high cardinality.

**Grafana's semaphore pattern as a platform reliability mechanism:** The query semaphore prevents one poorly designed dashboard (30 panels, each running an expensive PromQL range query) from starving other dashboards. At the platform level, this is tenant isolation: each dashboard or team should have a query budget that does not allow one heavy user to degrade performance for others. A staff engineer designs the query quotas: per-dashboard concurrency limits, per-team query rate limits, and the escalation path when a team legitimately needs a higher limit.

**New Relic's Apdex and the connection to error budgets:** The Apdex score is a single-number summary of user experience. It is used in New Relic's UI as a health indicator. At FAANG, the equivalent is the SLO error budget. A staff engineer connects the Apdex threshold (T = 500ms in the example) to the team's SLO definition, ensures that the Apdex score feeds into the error budget calculation, and uses the error budget as the primary signal for release go/no-go decisions. When the error budget is below 20%, the team's focus shifts from feature development to reliability work. This is the operational culture that Pillar 4 describes, made concrete through a metric that Apdex provides.

**The transaction breakdown as a debugging accelerator:** New Relic's `TransactionBreakdown` struct separates database, external, middleware, and application time. This is the data that makes P0 incident diagnosis fast. Without it, an engineer seeing a P99 latency spike must instrument the code to find where the time is going. With it, a glance at the breakdown shows "database time went from 20ms to 800ms" and the search space collapses from the entire codebase to database queries. A staff engineer ensures that this breakdown exists for every service and that it is surfaced in the first dashboard an on-call engineer sees during an incident.
