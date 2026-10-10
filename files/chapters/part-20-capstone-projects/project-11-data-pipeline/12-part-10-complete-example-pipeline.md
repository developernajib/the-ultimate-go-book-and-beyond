## Part 10: Complete Example Pipeline

Now that all the framework components are in place, this part shows three complete end-to-end examples that demonstrate how to use PipelineX for real-world tasks. Each example reads from a source, applies a series of transforms, and writes results to a sink, illustrating different pipeline patterns and configurations.

### Real-World Example: Event Processing

This example builds a batch pipeline that reads user events from JSON Lines files, parses them into typed structs, filters out invalid records, groups events by user within one-minute windows, sums the values per user, and writes the results to an output file. It demonstrates the typical ETL pattern: extract raw data, transform it into a useful shape, and load the results into a destination. Notice how the fluent API makes the entire pipeline definition fit into a single readable chain of method calls.

```go
// examples/event_processing/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "pipelinex/pkg/pipeline"
)

// Event represents a user event
type Event struct {
    UserID    string    `json:"user_id"`
    EventType string    `json:"event_type"`
    Timestamp time.Time `json:"timestamp"`
    Value     float64   `json:"value"`
}

func main() {
    ctx := context.Background()

    // Create pipeline
    p := pipeline.NewPipeline("EventProcessing", pipeline.PipelineOptions{
        Parallelism: 4,
        StateBackend: pipeline.NewMemoryStateBackend(),
    })

    // Define pipeline
    source := pipeline.NewFileSource("events/*.jsonl", pipeline.FormatJSONL)

    p.ReadFrom(source).
        Map(parseEvent).
        Filter(isValidEvent).
        WithFixedWindows(time.Minute).
        Map(extractKey).
        GroupByKey().
        CombinePerKey(pipeline.SumInt64{}).
        Map(formatOutput).
        WriteTo(pipeline.NewFileSink("output/results.jsonl", pipeline.FormatJSONL))

    // Run pipeline
    if err := p.Run(ctx); err != nil {
        log.Fatalf("Pipeline failed: %v", err)
    }

    fmt.Println("Pipeline completed successfully")
}

func parseEvent(elem pipeline.Element) (pipeline.Element, error) {
    data, err := json.Marshal(elem.Value)
    if err != nil {
        return elem, err
    }

    var event Event
    if err := json.Unmarshal(data, &event); err != nil {
        return elem, err
    }

    elem.Value = event
    elem.EventTime = event.Timestamp

    return elem, nil
}

func isValidEvent(elem pipeline.Element) (bool, error) {
    event, ok := elem.Value.(Event)
    if !ok {
        return false, nil
    }

    return event.UserID != "" && event.Value >= 0, nil
}

func extractKey(elem pipeline.Element) (pipeline.Element, error) {
    event := elem.Value.(Event)
    elem.Key = event.UserID
    elem.Value = int64(event.Value)
    return elem, nil
}

func formatOutput(elem pipeline.Element) (pipeline.Element, error) {
    result := map[string]any{
        "user_id": elem.Key,
        "total":   elem.Value,
    }

    elem.Value = result
    return elem, nil
}
```

### Streaming Example: Real-Time Analytics

This example builds a streaming pipeline that continuously reads click events from Kafka, applies sliding windows (5 minutes wide, sliding every minute), counts clicks per domain, and outputs only domains that exceed 100 clicks to another Kafka topic. It also sets up a file-based state backend with periodic checkpointing so the pipeline can recover from crashes. This pattern is common for real-time dashboards and alerting systems that need low-latency results from continuous data streams.

```go
// examples/streaming_analytics/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "strings"
    "time"

    "pipelinex/pkg/pipeline"
)

// ClickEvent represents a website click
type ClickEvent struct {
    URL       string    `json:"url"`
    UserID    string    `json:"user_id"`
    Timestamp time.Time `json:"timestamp"`
}

func main() {
    ctx := context.Background()

    // Create pipeline with checkpointing
    stateBackend, _ := pipeline.NewFileStateBackend("/tmp/pipeline-state")

    p := pipeline.NewPipeline("StreamingAnalytics", pipeline.PipelineOptions{
        Parallelism:   8,
        StateBackend:  stateBackend,
        CheckpointDir: "/tmp/checkpoints",
    })

    // Kafka source for streaming data
    source := pipeline.NewKafkaSource(
        []string{"localhost:9092"},
        "clicks",
        "analytics-group",
    )

    // Define streaming pipeline
    p.ReadFrom(source).
        Map(parseClick).
        WithSlidingWindows(5*time.Minute, time.Minute). // 5-min windows, 1-min slide
        Map(extractDomain).
        GroupByKey().
        CombinePerKey(pipeline.Count{}).
        Filter(popularDomains).
        WriteTo(pipeline.NewKafkaSink(
            []string{"localhost:9092"},
            "popular-domains",
        ))

    // Start checkpoint coordinator
    checkpointCoord := pipeline.NewCheckpointCoordinator(stateBackend).
        WithInterval(time.Minute)

    go func() {
        if err := checkpointCoord.Start(ctx); err != nil {
            log.Printf("Checkpoint coordinator error: %v", err)
        }
    }()

    // Run pipeline
    if err := p.Run(ctx); err != nil {
        log.Fatalf("Pipeline failed: %v", err)
    }
}

func parseClick(elem pipeline.Element) (pipeline.Element, error) {
    data, _ := json.Marshal(elem.Value)

    var click ClickEvent
    if err := json.Unmarshal(data, &click); err != nil {
        return elem, err
    }

    elem.Value = click
    elem.EventTime = click.Timestamp

    return elem, nil
}

func extractDomain(elem pipeline.Element) (pipeline.Element, error) {
    click := elem.Value.(ClickEvent)

    // Extract domain from URL
    url := click.URL
    if idx := strings.Index(url, "://"); idx >= 0 {
        url = url[idx+3:]
    }
    if idx := strings.Index(url, "/"); idx >= 0 {
        url = url[:idx]
    }

    elem.Key = url
    elem.Value = 1

    return elem, nil
}

func popularDomains(elem pipeline.Element) (bool, error) {
    count := elem.Value.(int64)
    return count >= 100, nil // Only domains with 100+ clicks
}
```

### Batch Processing Example: Log Analysis

This example processes application log files to generate an error report. It uses `FlatMap` to parse each log line with a regular expression (returning zero elements for lines that do not match the expected format), filters for ERROR and FATAL entries, groups by service name within hourly windows, counts errors per service, and writes a CSV report. This demonstrates how PipelineX handles text parsing, regex-based extraction, and multi-file batch processing with high parallelism.

```go
// examples/log_analysis/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "regexp"
    "strconv"
    "time"

    "pipelinex/pkg/pipeline"
)

// LogEntry represents a parsed log line
type LogEntry struct {
    Timestamp time.Time
    Level     string
    Service   string
    Message   string
}

func main() {
    ctx := context.Background()

    p := pipeline.NewPipeline("LogAnalysis", pipeline.PipelineOptions{
        Parallelism: 16,
    })

    // Process logs in parallel
    source := pipeline.NewFileSource("/var/log/app-*.log", pipeline.FormatText)

    p.ReadFrom(source).
        FlatMap(parseLogs).
        Filter(isError).
        Map(extractService).
        WithFixedWindows(time.Hour).
        GroupByKey().
        CombinePerKey(pipeline.Count{}).
        Map(formatReport).
        WriteTo(pipeline.NewFileSink("reports/error-report.csv", pipeline.FormatCSV))

    if err := p.Run(ctx); err != nil {
        log.Fatalf("Pipeline failed: %v", err)
    }

    fmt.Println("Log analysis complete")
}

var logPattern = regexp.MustCompile(
    `(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] \[(\w+)\] (.+)`,
)

func parseLogs(elem pipeline.Element) ([]pipeline.Element, error) {
    line := elem.Value.(string)

    matches := logPattern.FindStringSubmatch(line)
    if matches == nil {
        return nil, nil
    }

    timestamp, _ := time.Parse("2006-01-02 15:04:05", matches[1])

    entry := LogEntry{
        Timestamp: timestamp,
        Level:     matches[2],
        Service:   matches[3],
        Message:   matches[4],
    }

    return []pipeline.Element{
        pipeline.NewElementWithEventTime(entry, timestamp),
    }, nil
}

func isError(elem pipeline.Element) (bool, error) {
    entry := elem.Value.(LogEntry)
    return entry.Level == "ERROR" || entry.Level == "FATAL", nil
}

func extractService(elem pipeline.Element) (pipeline.Element, error) {
    entry := elem.Value.(LogEntry)
    elem.Key = entry.Service
    elem.Value = 1
    return elem, nil
}

func formatReport(elem pipeline.Element) (pipeline.Element, error) {
    service := elem.Key.(string)
    count := elem.Value.(int64)

    elem.Value = map[string]any{
        "service":      service,
        "error_count":  strconv.FormatInt(count, 10),
        "window_start": elem.EventTime.Format(time.RFC3339),
    }

    return elem, nil
}
```
