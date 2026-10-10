// examples/streaming_analytics/main.go
package main

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/example/data-pipeline/pkg/pipeline"
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
