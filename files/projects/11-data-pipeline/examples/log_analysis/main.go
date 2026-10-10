// examples/log_analysis/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "regexp"
    "strconv"
    "time"

    "github.com/example/data-pipeline/pkg/pipeline"
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

    logPattern := "logs/app-*.log"
    if env := os.Getenv("LOG_PATH"); env != "" {
        logPattern = env
    }

    // Process logs in parallel
    source, _ := pipeline.NewFileSource(logPattern, pipeline.FormatText)

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
    `(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([\w-]+)\] \[([\w-]+)\] (.+)`,
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
    elem.Value = int64(1)
    return elem, nil
}

func formatReport(elem pipeline.Element) (pipeline.Element, error) {
    service := fmt.Sprintf("%v", elem.Key)
    var count int64
    switch v := elem.Value.(type) {
    case int64:
        count = v
    case int:
        count = int64(v)
    case pipeline.WindowedValue:
        if c, ok := v.Value.(int64); ok {
            count = c
        }
    }

    elem.Value = map[string]any{
        "service":      service,
        "error_count":  strconv.FormatInt(count, 10),
        "window_start": elem.EventTime.Format(time.RFC3339),
    }

    return elem, nil
}
