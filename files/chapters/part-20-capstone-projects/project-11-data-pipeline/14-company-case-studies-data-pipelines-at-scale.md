## Company Case Studies: Data Pipelines at Scale

These case studies show how major technology companies solve data pipeline challenges at massive scale. Each example translates real-world architectural patterns into Go code, giving you a sense of how the concepts from PipelineX apply to production systems that process billions of events per day.

### Apache Beam/Google Dataflow: Unified Batch and Stream

Google created the unified batch-and-stream processing model that inspired PipelineX. Their key insight is that batch processing is just a special case of streaming with a bounded input. The `DoFn` (Do Function) abstraction lets you write processing logic once and run it on any execution engine, whether local, on Google Cloud Dataflow, or on Apache Flink. The code below shows the Beam-style API with bundle lifecycle hooks (`StartBundle`, `ProcessElement`, `FinishBundle`) that give transforms control over initialization and cleanup.

```go
// Apache Beam-style unified data pipeline
package beam

import (
    "context"
    "time"
)

// Pipeline represents a data processing pipeline
type Pipeline struct {
    ID        string
    Options   *PipelineOptions
    Transforms []*PTransform
    Counters  map[string]*Counter
}

// PCollection represents a distributed dataset
type PCollection struct {
    Name      string
    Type      reflect.Type
    Windowing *WindowingStrategy
    Coder     Coder
}

// PTransform represents a pipeline transform
type PTransform struct {
    Name    string
    Inputs  []*PCollection
    Outputs []*PCollection
    DoFn    DoFn
}

// DoFn represents a user-defined function
type DoFn interface {
    StartBundle(ctx context.Context) error
    ProcessElement(ctx context.Context, elem any, emit func(any)) error
    FinishBundle(ctx context.Context) error
}

// ParDo applies a DoFn to each element
func ParDo(input *PCollection, fn DoFn) *PCollection {
    return &PCollection{
        Name: fmt.Sprintf("ParDo(%s)", input.Name),
        Type: inferOutputType(fn),
        Windowing: input.Windowing,
    }
}

// GroupByKey groups elements by key
func GroupByKey(input *PCollection) *PCollection {
    return &PCollection{
        Name: fmt.Sprintf("GBK(%s)", input.Name),
        Type: reflect.TypeOf(KV{}),
        Windowing: input.Windowing,
    }
}

// Window assigns elements to windows
func Window(input *PCollection, windowFn WindowFn) *PCollection {
    return &PCollection{
        Name: fmt.Sprintf("Window(%s)", input.Name),
        Type: input.Type,
        Windowing: &WindowingStrategy{
            WindowFn: windowFn,
            Trigger:  DefaultTrigger(),
        },
    }
}

// Runner executes a pipeline
type Runner interface {
    Run(ctx context.Context, p *Pipeline) (*PipelineResult, error)
}

// DirectRunner runs locally for testing
type DirectRunner struct{}

func (r *DirectRunner) Run(ctx context.Context, p *Pipeline) (*PipelineResult, error) {
    executor := &DirectExecutor{
        bundles: make(map[string][]any),
    }

    // Build execution graph
    graph := buildGraph(p.Transforms)

    // Execute transforms in topological order
    for _, transform := range graph.TopologicalSort() {
        if err := executor.ExecuteTransform(ctx, transform); err != nil {
            return nil, err
        }
    }

    return &PipelineResult{
        State:    "DONE",
        Counters: p.Counters,
    }, nil
}
```

### Netflix: Real-Time Stream Processing

Netflix processes billions of viewing events daily to power recommendations, trending lists, and quality-of-service monitoring. Their pipeline consumes events from Kafka, updates viewing history in Cassandra for personalization, feeds real-time popularity scores into Flink for trending calculations, and indexes events in Elasticsearch for search and discovery. The `TrendingCalculator` uses sliding windows to detect which titles are gaining popularity in each country.

```go
// Netflix-style real-time event processing
package netflix

import (
    "context"
    "time"
)

// StreamProcessor handles Netflix event streams
type StreamProcessor struct {
    kafkaConsumer  *KafkaConsumer
    flinkConnector *FlinkConnector
    cassandraStore *CassandraStore
    esClient       *ElasticsearchClient
}

// ViewingEvent represents user viewing data
type ViewingEvent struct {
    UserID       string    `json:"user_id"`
    ProfileID    string    `json:"profile_id"`
    TitleID      string    `json:"title_id"`
    SessionID    string    `json:"session_id"`
    EventType    string    `json:"event_type"` // play, pause, stop, scrub
    Position     int64     `json:"position"`
    Duration     int64     `json:"duration"`
    DeviceType   string    `json:"device_type"`
    Quality      string    `json:"quality"`
    Timestamp    time.Time `json:"timestamp"`
    CountryCode  string    `json:"country_code"`
}

// ProcessViewingEvents handles viewing analytics
func (s *StreamProcessor) ProcessViewingEvents(ctx context.Context) error {
    events := s.kafkaConsumer.Subscribe(ctx, "viewing-events")

    for event := range events {
        var viewing ViewingEvent
        if err := json.Unmarshal(event.Value, &viewing); err != nil {
            continue
        }

        // Update viewing history in Cassandra
        s.cassandraStore.UpdateViewingHistory(ctx, &ViewingHistory{
            UserID:    viewing.UserID,
            ProfileID: viewing.ProfileID,
            TitleID:   viewing.TitleID,
            WatchedAt: viewing.Timestamp,
            Position:  viewing.Position,
            Duration:  viewing.Duration,
            Completed: viewing.Position >= int64(float64(viewing.Duration)*0.9),
        })

        // Update real-time popularity
        s.flinkConnector.EmitEvent(ctx, &PopularityUpdate{
            TitleID:   viewing.TitleID,
            Country:   viewing.CountryCode,
            Timestamp: viewing.Timestamp,
            Weight:    calculateWeight(viewing),
        })

        // Index for search/discovery
        s.esClient.Index(ctx, "viewing-events", viewing)
    }

    return nil
}

// TrendingCalculator computes trending titles
type TrendingCalculator struct {
    windowSize   time.Duration
    slideBy      time.Duration
    topN         int
}

func (t *TrendingCalculator) Calculate(ctx context.Context, events <-chan *PopularityUpdate) <-chan *TrendingResult {
    results := make(chan *TrendingResult)

    go func() {
        defer close(results)

        window := NewSlidingWindow(t.windowSize, t.slideBy)

        for event := range events {
            window.Add(event)

            if window.ShouldEmit() {
                trending := window.GetTopN(t.topN)
                results <- &TrendingResult{
                    Country:   event.Country,
                    Titles:    trending,
                    Timestamp: time.Now(),
                }
            }
        }
    }()

    return results
}
```

### Uber: Real-Time Analytics Pipeline

Uber's data platform processes millions of trip events per day to power surge pricing, driver dispatch, and business analytics. Trip lifecycle events flow from Kafka into multiple downstream systems: Apache Pinot for real-time OLAP queries, HDFS for historical batch analysis with Presto, and back into Kafka as aggregated city-level and product-level metrics. The `SupplyDemandAnalyzer` tracks available drivers and trip requests per geographic cell to compute the supply-demand ratio that drives dynamic pricing.

```go
// Uber-style real-time analytics platform
package uber

import (
    "context"
    "time"
)

// AnalyticsPlatform processes ride and driver data
type AnalyticsPlatform struct {
    kafkaStreams  *KafkaStreamsClient
    pinot         *PinotClient
    hdfs          *HDFSClient
    presto        *PrestoClient
}

// TripEvent represents a ride lifecycle event
type TripEvent struct {
    TripID        string    `json:"trip_id"`
    EventType     string    `json:"event_type"` // request, match, pickup, dropoff, cancel
    DriverID      string    `json:"driver_id,omitempty"`
    RiderID       string    `json:"rider_id"`
    ProductType   string    `json:"product_type"` // UberX, UberXL, Black
    PickupLat     float64   `json:"pickup_lat"`
    PickupLng     float64   `json:"pickup_lng"`
    DropoffLat    float64   `json:"dropoff_lat,omitempty"`
    DropoffLng    float64   `json:"dropoff_lng,omitempty"`
    City          string    `json:"city"`
    Surge         float64   `json:"surge_multiplier"`
    EstimatedFare float64   `json:"estimated_fare"`
    ActualFare    float64   `json:"actual_fare,omitempty"`
    Timestamp     time.Time `json:"timestamp"`
}

// ProcessTripEvents builds real-time analytics
func (p *AnalyticsPlatform) ProcessTripEvents(ctx context.Context) error {
    // Consume from Kafka
    events := p.kafkaStreams.Stream(ctx, "trip-events")

    // Real-time aggregations
    aggregator := &TripAggregator{
        byCity:    make(map[string]*CityMetrics),
        byProduct: make(map[string]*ProductMetrics),
    }

    for event := range events {
        var trip TripEvent
        json.Unmarshal(event.Value, &trip)

        // Update real-time metrics
        aggregator.Update(&trip)

        // Write to Pinot for real-time queries
        p.pinot.Upsert(ctx, "trip_events", trip)

        // Batch write to HDFS for historical analysis
        p.hdfs.AppendToPartition(ctx, fmt.Sprintf(
            "/data/trips/city=%s/date=%s/hour=%d",
            trip.City,
            trip.Timestamp.Format("2006-01-02"),
            trip.Timestamp.Hour(),
        ), trip)

        // Emit aggregated metrics
        if aggregator.ShouldEmit() {
            p.kafkaStreams.Produce(ctx, "city-metrics", aggregator.GetCityMetrics())
            p.kafkaStreams.Produce(ctx, "product-metrics", aggregator.GetProductMetrics())
        }
    }

    return nil
}

// SupplyDemandAnalyzer computes real-time supply/demand
type SupplyDemandAnalyzer struct {
    geoCells     *GeoCellIndex
    windowMinutes int
}

func (s *SupplyDemandAnalyzer) Analyze(ctx context.Context, drivers <-chan *DriverLocation, trips <-chan *TripEvent) <-chan *SupplyDemandMetric {
    metrics := make(chan *SupplyDemandMetric)

    go func() {
        defer close(metrics)

        // Track supply (available drivers) per geohash
        supply := make(map[string]int)
        // Track demand (trip requests) per geohash
        demand := make(map[string]int)

        ticker := time.NewTicker(time.Duration(s.windowMinutes) * time.Minute)

        for {
            select {
            case driver := <-drivers:
                cell := s.geoCells.GetCell(driver.Lat, driver.Lng)
                if driver.Status == "available" {
                    supply[cell]++
                }

            case trip := <-trips:
                if trip.EventType == "request" {
                    cell := s.geoCells.GetCell(trip.PickupLat, trip.PickupLng)
                    demand[cell]++
                }

            case <-ticker.C:
                // Emit supply/demand metrics
                for cell, sup := range supply {
                    dem := demand[cell]
                    metrics <- &SupplyDemandMetric{
                        GeoCell:   cell,
                        Supply:    sup,
                        Demand:    dem,
                        Ratio:     float64(sup) / float64(max(dem, 1)),
                        Timestamp: time.Now(),
                    }
                }
                // Reset for next window
                supply = make(map[string]int)
                demand = make(map[string]int)

            case <-ctx.Done():
                return
            }
        }
    }()

    return metrics
}
```

### Airbnb: Data Quality Pipeline

Airbnb builds automated data quality checks into their pipelines to catch problems before bad data reaches production dashboards or machine learning models. Their system defines "expectations" (rules like "this column must never be null" or "values must fall within this range") and validates every dataset against them. When a critical expectation fails, the system fires an alert and records the failure rate as a metric. This approach catches data issues early, before they propagate through downstream systems and cause incorrect business decisions.

```go
// Airbnb-style data quality monitoring
package airbnb

import (
    "context"
    "time"
)

// DataQualityService monitors data pipeline health
type DataQualityService struct {
    expectations map[string]*DataExpectation
    alertService *AlertService
    metricsStore *MetricsStore
}

// DataExpectation defines quality rules
type DataExpectation struct {
    Name        string              `json:"name"`
    Dataset     string              `json:"dataset"`
    Column      string              `json:"column,omitempty"`
    Type        string              `json:"type"` // not_null, unique, range, regex, freshness
    Parameters  map[string]any `json:"parameters"`
    Severity    string              `json:"severity"` // critical, warning, info
}

// ValidationResult represents check results
type ValidationResult struct {
    Expectation     string    `json:"expectation"`
    Passed          bool      `json:"passed"`
    ObservedValue   any `json:"observed_value"`
    ExpectedValue   any `json:"expected_value"`
    FailedRecords   int64     `json:"failed_records"`
    TotalRecords    int64     `json:"total_records"`
    FailurePercent  float64   `json:"failure_percent"`
    Timestamp       time.Time `json:"timestamp"`
}

// ValidateDataset runs all expectations for a dataset
func (s *DataQualityService) ValidateDataset(ctx context.Context, dataset string, data []map[string]any) ([]*ValidationResult, error) {
    results := make([]*ValidationResult, 0)

    expectations := s.getExpectationsForDataset(dataset)

    for _, exp := range expectations {
        result := s.runExpectation(ctx, exp, data)
        results = append(results, result)

        if !result.Passed && exp.Severity == "critical" {
            s.alertService.Alert(ctx, &Alert{
                Title:    fmt.Sprintf("Data quality check failed: %s", exp.Name),
                Severity: "critical",
                Dataset:  dataset,
                Details:  result,
            })
        }

        // Record metrics
        s.metricsStore.Record(ctx, &DataQualityMetric{
            Dataset:    dataset,
            Expectation: exp.Name,
            Passed:     result.Passed,
            FailureRate: result.FailurePercent,
            Timestamp:  time.Now(),
        })
    }

    return results, nil
}

func (s *DataQualityService) runExpectation(ctx context.Context, exp *DataExpectation, data []map[string]any) *ValidationResult {
    result := &ValidationResult{
        Expectation:   exp.Name,
        TotalRecords:  int64(len(data)),
        Timestamp:     time.Now(),
    }

    switch exp.Type {
    case "not_null":
        nullCount := 0
        for _, row := range data {
            if row[exp.Column] == nil {
                nullCount++
            }
        }
        result.FailedRecords = int64(nullCount)
        result.Passed = nullCount == 0

    case "unique":
        seen := make(map[any]bool)
        duplicates := 0
        for _, row := range data {
            val := row[exp.Column]
            if seen[val] {
                duplicates++
            }
            seen[val] = true
        }
        result.FailedRecords = int64(duplicates)
        result.Passed = duplicates == 0

    case "range":
        minVal := exp.Parameters["min"].(float64)
        maxVal := exp.Parameters["max"].(float64)
        outOfRange := 0
        for _, row := range data {
            val, ok := row[exp.Column].(float64)
            if !ok || val < minVal || val > maxVal {
                outOfRange++
            }
        }
        result.FailedRecords = int64(outOfRange)
        result.Passed = outOfRange == 0
        result.ExpectedValue = fmt.Sprintf("[%v, %v]", minVal, maxVal)

    case "freshness":
        maxAgeMinutes := exp.Parameters["max_age_minutes"].(float64)
        stale := 0
        threshold := time.Now().Add(-time.Duration(maxAgeMinutes) * time.Minute)
        for _, row := range data {
            ts, ok := row[exp.Column].(time.Time)
            if !ok || ts.Before(threshold) {
                stale++
            }
        }
        result.FailedRecords = int64(stale)
        result.Passed = stale == 0
    }

    result.FailurePercent = float64(result.FailedRecords) / float64(result.TotalRecords) * 100
    return result
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Google Dataflow | Unified batch/stream, auto-scaling | Exabytes/day |
| Netflix | Real-time recommendations, viewing analytics | Billions of events/day |
| Uber | Geospatial analytics, supply/demand | Millions of trips/day |
| Airbnb | Data quality monitoring, expectations | Petabyte-scale warehouse |

---
