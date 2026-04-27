export default `## 12.11 Complete Application: Event Processing System

A production event processing system demonstrating multiple patterns.

### Project Structure

The application is organized as a Go module with a clear separation between the executable entry point and the internal packages that implement the core logic. Each subdirectory under \`internal/\` owns a single concern, event types, the processing pipeline, pub/sub routing, and the worker pool, keeping dependencies explicit and the packages independently testable.

\`\`\`
eventprocessor/
├── cmd/
│   └── processor/
│       └── main.go
├── internal/
│   ├── event/
│   │   └── event.go
│   ├── pipeline/
│   │   └── pipeline.go
│   ├── pubsub/
│   │   └── pubsub.go
│   └── worker/
│       └── pool.go
├── Dockerfile
├── Makefile
└── go.mod
\`\`\`

### event/event.go

This file defines the shared domain types that flow through every layer of the system. The \`Event\` struct carries an open-ended \`Payload\` map for arbitrary data alongside a typed \`Metadata\` map for processing annotations, while the \`Handler\` interface provides a contract that any processing component must satisfy to participate in routing.

\`\`\`go
package event

import (
    "time"
)

// Event represents a system event
type Event struct {
    ID        string
    Type      string
    Source    string
    Payload   map[string]any
    Timestamp time.Time
    Metadata  map[string]string
}

// Result represents processing result
type Result struct {
    EventID   string
    Success   bool
    Output    any
    Error     error
    Duration  time.Duration
    Processor string
}

// Handler processes events
type Handler interface {
    Handle(event *Event) (*Result, error)
    CanHandle(eventType string) bool
}
\`\`\`

### pipeline/pipeline.go

The pipeline chains ordered \`Stage\` values, passing the transformed event from one handler to the next and short-circuiting on the first error. An embedded \`Metrics\` struct protected by a mutex accumulates per-pipeline counters, so the caller can query processed count, failure count, and average latency without external instrumentation.

\`\`\`go
package pipeline

import (
    "context"
    "sync"
    "time"

    "eventprocessor/internal/event"
)

// Stage represents a pipeline stage
type Stage struct {
    Name    string
    Handler func(context.Context, *event.Event) (*event.Event, error)
}

// Pipeline processes events through stages
type Pipeline struct {
    stages  []Stage
    metrics *Metrics
}

type Metrics struct {
    mu             sync.Mutex
    processed      int64
    failed         int64
    totalLatency   time.Duration
}

func NewPipeline(stages ...Stage) *Pipeline {
    return &Pipeline{
        stages:  stages,
        metrics: &Metrics{},
    }
}

func (p *Pipeline) Process(ctx context.Context, evt *event.Event) (*event.Result, error) {
    start := time.Now()
    current := evt

    for _, stage := range p.stages {
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        default:
        }

        result, err := stage.Handler(ctx, current)
        if err != nil {
            p.metrics.mu.Lock()
            p.metrics.failed++
            p.metrics.mu.Unlock()

            return &event.Result{
                EventID:   evt.ID,
                Success:   false,
                Error:     err,
                Duration:  time.Since(start),
                Processor: stage.Name,
            }, err
        }
        current = result
    }

    p.metrics.mu.Lock()
    p.metrics.processed++
    p.metrics.totalLatency += time.Since(start)
    p.metrics.mu.Unlock()

    return &event.Result{
        EventID:  evt.ID,
        Success:  true,
        Output:   current,
        Duration: time.Since(start),
    }, nil
}

func (p *Pipeline) Stats() (processed, failed int64, avgLatency time.Duration) {
    p.metrics.mu.Lock()
    defer p.metrics.mu.Unlock()

    if p.metrics.processed > 0 {
        avgLatency = p.metrics.totalLatency / time.Duration(p.metrics.processed)
    }
    return p.metrics.processed, p.metrics.failed, avgLatency
}
\`\`\`

### cmd/processor/main.go

The main function wires together a three-stage pipeline, a fixed worker pool of four goroutines, and a result collector goroutine, all coordinated through a shared context that cancels on \`SIGINT\` or \`SIGTERM\`. A test generator feeds one hundred synthetic events at a controlled rate, then closes the input channel so the worker pool drains cleanly before final statistics are printed.

\`\`\`go
package main

import (
    "context"
    "fmt"
    "log"
    "math/rand/v2"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"

    "eventprocessor/internal/event"
    "eventprocessor/internal/pipeline"
)

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Handle shutdown signals
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    go func() {
        <-sigCh
        log.Println("Shutdown signal received")
        cancel()
    }()

    // Create pipeline with stages
    p := pipeline.NewPipeline(
        pipeline.Stage{
            Name: "validate",
            Handler: func(ctx context.Context, e *event.Event) (*event.Event, error) {
                if e.Type == "" {
                    return nil, fmt.Errorf("missing event type")
                }
                return e, nil
            },
        },
        pipeline.Stage{
            Name: "enrich",
            Handler: func(ctx context.Context, e *event.Event) (*event.Event, error) {
                e.Metadata["processed_at"] = time.Now().Format(time.RFC3339)
                return e, nil
            },
        },
        pipeline.Stage{
            Name: "transform",
            Handler: func(ctx context.Context, e *event.Event) (*event.Event, error) {
                // Simulate processing
                time.Sleep(time.Duration(rand.IntN(50)) * time.Millisecond)
                return e, nil
            },
        },
    )

    // Worker pool for parallel processing
    numWorkers := 4
    events := make(chan *event.Event, 100)
    results := make(chan *event.Result, 100)

    var wg sync.WaitGroup
    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()
            for {
                select {
                case <-ctx.Done():
                    return
                case evt, ok := <-events:
                    if !ok {
                        return
                    }
                    result, _ := p.Process(ctx, evt)
                    select {
                    case <-ctx.Done():
                        return
                    case results <- result:
                    }
                }
            }
        }(i)
    }

    // Result collector
    go func() {
        for result := range results {
            if result.Success {
                log.Printf("Event %s processed in %v", result.EventID, result.Duration)
            } else {
                log.Printf("Event %s failed: %v", result.EventID, result.Error)
            }
        }
    }()

    // Generate test events
    eventTypes := []string{"user.created", "order.placed", "payment.processed"}
    for i := 0; i < 100; i++ {
        select {
        case <-ctx.Done():
            break
        default:
            evt := &event.Event{
                ID:        fmt.Sprintf("evt-%d", i),
                Type:      eventTypes[rand.IntN(len(eventTypes))],
                Source:    "test-generator",
                Timestamp: time.Now(),
                Payload:   map[string]any{"index": i},
                Metadata:  make(map[string]string),
            }
            events <- evt
        }
        time.Sleep(10 * time.Millisecond)
    }

    close(events)
    wg.Wait()
    close(results)

    // Print stats
    processed, failed, avgLatency := p.Stats()
    fmt.Printf("\\nFinal Stats:\\n")
    fmt.Printf("  Processed: %d\\n", processed)
    fmt.Printf("  Failed: %d\\n", failed)
    fmt.Printf("  Avg Latency: %v\\n", avgLatency)
}
\`\`\`

### Makefile

The Makefile provides four standard targets that cover the full local development lifecycle. \`build\` compiles the binary to \`bin/processor\`, \`test\` runs the full test suite with the race detector enabled, \`run\` compiles and immediately executes the processor, and \`clean\` removes build artifacts to give a fresh start.

\`\`\`makefile
.PHONY: build test run clean

build:
	go build -o bin/processor ./cmd/processor

test:
	go test -v -race ./...

run: build
	./bin/processor

clean:
	rm -rf bin/
\`\`\`

### Staff Lens: What This System Teaches

The event processing system above combines five of the chapter's patterns: worker pool (bounded concurrency), fan-out (parallel handler dispatch), pub/sub (topic routing), retry with backoff (transient failure handling), rate limiting (downstream protection). This composition is typical of real services. The lesson is not the specific code. It is recognising which patterns belong together for this class of problem (event-driven systems with unreliable downstreams and bursty traffic) so you can apply the same composition to similar problems.

### Production Gaps

Before running this in production, close:

1. **Durability.** Events in memory are lost on restart. Persist to disk or a durable queue (Kafka, Redis Streams).
2. **Observability.** The metrics are basic. Add tracing spans per event, emit to OpenTelemetry, build dashboards for queue depth per topic.
3. **Schema evolution.** Events with versioned schemas. Use protobuf or JSON schema with explicit versioning.
4. **Poison event handling.** An event that consistently fails should not retry forever. Route to a DLQ with explicit operator intervention.
5. **Authentication and authorization.** Who can publish to which topic? Who can subscribe?

These are the table stakes for event-driven systems. The teaching example does not include them. Production requires them all.

### Principal Lens: When to Stop Building Event Systems In-Process

This system fits in one process. At some scale, event-driven architecture is better served by a real message broker (Kafka, NATS, RabbitMQ) with the Go service as a producer or consumer rather than a message broker. The signals: events must survive process restart, multiple service instances must share subscription load, events must be replayable, messages need guaranteed delivery across service failures. When any of these apply, stop building in-process event systems and integrate with the broker instead. The in-process version is a teaching exercise and a useful tool for loose coupling within a single service. It is not infrastructure.

---
`;
