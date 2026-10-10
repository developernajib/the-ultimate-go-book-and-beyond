// examples/event_processing/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/example/data-pipeline/pkg/pipeline"
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
    source, _ := pipeline.NewFileSource("events/*.jsonl", pipeline.FormatJSONL)

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
