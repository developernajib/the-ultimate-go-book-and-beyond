## 31.10 Complete Production File Processing Framework

This section assembles the patterns from earlier sections into a full file processing framework with a pipeline architecture, pluggable format handlers, and parallel execution.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
fileproc/
├── cmd/
│   └── processor/
│       └── main.go                 # CLI entry point
├── internal/
│   ├── processor/
│   │   ├── processor.go            # Core processor
│   │   ├── pipeline.go             # Pipeline builder
│   │   └── stage.go                # Pipeline stages
│   ├── format/
│   │   ├── csv.go                  # CSV reader/writer
│   │   ├── json.go                 # JSON reader/writer
│   │   ├── parquet.go              # Parquet support
│   │   └── detector.go             # Format detection
│   ├── storage/
│   │   ├── local.go                # Local filesystem
│   │   ├── s3.go                   # S3 storage
│   │   └── gcs.go                  # GCS storage
│   ├── transform/
│   │   ├── filter.go               # Filter operations
│   │   ├── map.go                  # Map operations
│   │   └── aggregate.go            # Aggregation operations
│   └── metrics/
│       └── metrics.go              # Processing metrics
├── Dockerfile
├── Makefile
└── go.mod
```

### Core Processor Interface

The interface definition below establishes the contract that all implementations must satisfy. Programming to this interface rather than a concrete type enables dependency injection, simplifies testing, and allows the implementation to be swapped without changing callers.

```go
// internal/processor/processor.go
package processor

import (
	"context"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// Record represents a single data record
type Record map[string]any

// RecordStream is a channel of records
type RecordStream <-chan Record

// Processor handles file processing operations
type Processor struct {
	config     Config
	metrics    *Metrics
	logger     Logger
}

type Config struct {
	Workers      int
	BufferSize   int
	BatchSize    int
	MaxFileSize  int64
	TempDir      string
	RetryCount   int
	RetryDelay   time.Duration
}

type Metrics struct {
	RecordsProcessed int64
	RecordsFailed    int64
	BytesRead        int64
	BytesWritten     int64
	ProcessingTime   time.Duration

	mu sync.RWMutex
}

func NewProcessor(config Config, logger Logger) *Processor {
	if config.Workers == 0 {
		config.Workers = 4
	}
	if config.BufferSize == 0 {
		config.BufferSize = 8192
	}
	if config.BatchSize == 0 {
		config.BatchSize = 1000
	}

	return &Processor{
		config:  config,
		metrics: &Metrics{},
		logger:  logger,
	}
}

// Process processes a file through a pipeline
func (p *Processor) Process(ctx context.Context, input io.Reader, output io.Writer, pipeline *Pipeline) error {
	start := time.Now()
	defer func() {
		p.metrics.mu.Lock()
		p.metrics.ProcessingTime = time.Since(start)
		p.metrics.mu.Unlock()
	}()

	// Create record stream from input
	records, err := pipeline.Reader.Read(ctx, input)
	if err != nil {
		return fmt.Errorf("reader error: %w", err)
	}

	// Apply transformations
	for _, stage := range pipeline.Stages {
		records = stage.Process(ctx, records)
	}

	// Track progress
	records = p.trackProgress(ctx, records)

	// Write output
	if err := pipeline.Writer.Write(ctx, output, records); err != nil {
		return fmt.Errorf("writer error: %w", err)
	}

	return nil
}

func (p *Processor) trackProgress(ctx context.Context, input RecordStream) RecordStream {
	output := make(chan Record, p.config.BufferSize)

	go func() {
		defer close(output)
		for record := range input {
			atomic.AddInt64(&p.metrics.RecordsProcessed, 1)
			select {
			case output <- record:
			case <-ctx.Done():
				return
			}
		}
	}()

	return output
}

// ProcessParallel processes input with parallel workers
func (p *Processor) ProcessParallel(ctx context.Context, input RecordStream, process func(Record) (Record, error)) RecordStream {
	output := make(chan Record, p.config.BufferSize)
	var wg sync.WaitGroup

	// Start workers
	for i := 0; i < p.config.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for record := range input {
				select {
				case <-ctx.Done():
					return
				default:
				}

				result, err := process(record)
				if err != nil {
					atomic.AddInt64(&p.metrics.RecordsFailed, 1)
					p.logger.Error("record processing failed", "error", err)
					continue
				}

				select {
				case output <- result:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// Close output when all workers done
	go func() {
		wg.Wait()
		close(output)
	}()

	return output
}

func (p *Processor) GetMetrics() Metrics {
	p.metrics.mu.RLock()
	defer p.metrics.mu.RUnlock()
	return *p.metrics
}
```

### Pipeline Builder

The `PipelineBuilder` assembles a processing pipeline from a reader, a writer, and zero or more intermediate stages. Each stage, filter, map, or batch, receives a channel of records and returns a new channel, forming a chain of goroutines connected by channels. The builder pattern lets callers compose pipelines fluently without managing channel wiring themselves.

```go
// internal/processor/pipeline.go
package processor

import (
	"context"
	"io"
)

// Reader reads records from an input source
type Reader interface {
	Read(ctx context.Context, r io.Reader) (RecordStream, error)
}

// Writer writes records to an output destination
type Writer interface {
	Write(ctx context.Context, w io.Writer, records RecordStream) error
}

// Stage transforms a record stream
type Stage interface {
	Process(ctx context.Context, input RecordStream) RecordStream
}

// Pipeline represents a processing pipeline
type Pipeline struct {
	Reader  Reader
	Writer  Writer
	Stages  []Stage
}

// PipelineBuilder builds processing pipelines
type PipelineBuilder struct {
	reader  Reader
	writer  Writer
	stages  []Stage
	config  Config
}

func NewPipelineBuilder(config Config) *PipelineBuilder {
	return &PipelineBuilder{
		config: config,
		stages: make([]Stage, 0),
	}
}

func (b *PipelineBuilder) WithReader(r Reader) *PipelineBuilder {
	b.reader = r
	return b
}

func (b *PipelineBuilder) WithWriter(w Writer) *PipelineBuilder {
	b.writer = w
	return b
}

func (b *PipelineBuilder) AddStage(s Stage) *PipelineBuilder {
	b.stages = append(b.stages, s)
	return b
}

func (b *PipelineBuilder) Filter(predicate func(Record) bool) *PipelineBuilder {
	return b.AddStage(&FilterStage{Predicate: predicate, BufferSize: b.config.BufferSize})
}

func (b *PipelineBuilder) Map(transform func(Record) Record) *PipelineBuilder {
	return b.AddStage(&MapStage{Transform: transform, BufferSize: b.config.BufferSize})
}

func (b *PipelineBuilder) Build() *Pipeline {
	return &Pipeline{
		Reader: b.reader,
		Writer: b.writer,
		Stages: b.stages,
	}
}

// FilterStage filters records based on predicate
type FilterStage struct {
	Predicate  func(Record) bool
	BufferSize int
}

func (s *FilterStage) Process(ctx context.Context, input RecordStream) RecordStream {
	output := make(chan Record, s.BufferSize)

	go func() {
		defer close(output)
		for record := range input {
			if s.Predicate(record) {
				select {
				case output <- record:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return output
}

// MapStage transforms records
type MapStage struct {
	Transform  func(Record) Record
	BufferSize int
}

func (s *MapStage) Process(ctx context.Context, input RecordStream) RecordStream {
	output := make(chan Record, s.BufferSize)

	go func() {
		defer close(output)
		for record := range input {
			result := s.Transform(record)
			select {
			case output <- result:
			case <-ctx.Done():
				return
			}
		}
	}()

	return output
}

// BatchStage groups records into batches
type BatchStage struct {
	BatchSize  int
	BufferSize int
}

func (s *BatchStage) Process(ctx context.Context, input RecordStream) RecordStream {
	output := make(chan Record, s.BufferSize)

	go func() {
		defer close(output)
		batch := make([]Record, 0, s.BatchSize)

		for record := range input {
			batch = append(batch, record)
			if len(batch) >= s.BatchSize {
				batchRecord := Record{"_batch": batch}
				select {
				case output <- batchRecord:
				case <-ctx.Done():
					return
				}
				batch = make([]Record, 0, s.BatchSize)
			}
		}

		// Send remaining records
		if len(batch) > 0 {
			select {
			case output <- Record{"_batch": batch}:
			case <-ctx.Done():
			}
		}
	}()

	return output
}
```

### CSV Format Handler

The `CSVReader` satisfies the `Reader` interface by spawning a goroutine that reads CSV records and sends them as `Record` maps on a channel. If the file has a header row, the header values become map keys. Otherwise, columns are named `col_0`, `col_1`, etc. The `CSVWriter` reverses the process, pulling records from the channel and writing them as CSV rows.

```go
// internal/format/csv.go
package format

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"

	"fileproc/internal/processor"
)

type CSVReader struct {
	Delimiter  rune
	HasHeader  bool
	BufferSize int
}

func NewCSVReader() *CSVReader {
	return &CSVReader{
		Delimiter:  ',',
		HasHeader:  true,
		BufferSize: 1000,
	}
}

func (r *CSVReader) Read(ctx context.Context, input io.Reader) (processor.RecordStream, error) {
	output := make(chan processor.Record, r.BufferSize)

	reader := csv.NewReader(input)
	reader.Comma = r.Delimiter
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true

	go func() {
		defer close(output)

		var headers []string
		if r.HasHeader {
			var err error
			headers, err = reader.Read()
			if err != nil {
				return
			}
		}

		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			row, err := reader.Read()
			if err == io.EOF {
				return
			}
			if err != nil {
				continue
			}

			record := make(processor.Record)
			for i, value := range row {
				if headers != nil && i < len(headers) {
					record[headers[i]] = value
				} else {
					record[fmt.Sprintf("col_%d", i)] = value
				}
			}

			select {
			case output <- record:
			case <-ctx.Done():
				return
			}
		}
	}()

	return output, nil
}

type CSVWriter struct {
	Delimiter rune
	Headers   []string
}

func NewCSVWriter(headers []string) *CSVWriter {
	return &CSVWriter{
		Delimiter: ',',
		Headers:   headers,
	}
}

func (w *CSVWriter) Write(ctx context.Context, output io.Writer, records processor.RecordStream) error {
	writer := csv.NewWriter(output)
	writer.Comma = w.Delimiter

	// Write header
	if len(w.Headers) > 0 {
		if err := writer.Write(w.Headers); err != nil {
			return err
		}
	}

	for record := range records {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		row := make([]string, len(w.Headers))
		for i, header := range w.Headers {
			if val, ok := record[header]; ok {
				row[i] = fmt.Sprintf("%v", val)
			}
		}

		if err := writer.Write(row); err != nil {
			return err
		}
	}

	writer.Flush()
	return writer.Error()
}
```

### Main Application

The entry point wires everything together: it parses CLI flags, creates a `Processor` with the desired worker count and buffer sizes, builds a pipeline with a format-specific reader/writer and transformation stages, and runs the pipeline within a cancellable context. Signal handling ensures a clean shutdown, canceling the context drains in-flight records before the process exits.

```go
// cmd/processor/main.go
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"fileproc/internal/format"
	"fileproc/internal/processor"
)

func main() {
	// Parse flags
	inputPath := flag.String("input", "", "Input file path")
	outputPath := flag.String("output", "", "Output file path")
	workers := flag.Int("workers", 4, "Number of parallel workers")
	format := flag.String("format", "csv", "Input/output format (csv, json)")
	flag.Parse()

	if *inputPath == "" || *outputPath == "" {
		fmt.Println("Usage: processor -input <file> -output <file>")
		os.Exit(1)
	}

	// Initialize logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Create processor
	proc := processor.NewProcessor(processor.Config{
		Workers:    *workers,
		BufferSize: 10000,
		BatchSize:  1000,
	}, logger)

	// Build pipeline
	builder := processor.NewPipelineBuilder(processor.Config{BufferSize: 10000})

	// Configure reader/writer based on format
	switch *format {
	case "csv":
		builder.WithReader(format.NewCSVReader())
		builder.WithWriter(format.NewCSVWriter([]string{"id", "name", "email", "status"}))
	default:
		logger.Error("unsupported format", "format", *format)
		os.Exit(1)
	}

	// Add transformations
	pipeline := builder.
		Filter(func(r processor.Record) bool {
			// Example: filter active users
			status, _ := r["status"].(string)
			return status == "active"
		}).
		Map(func(r processor.Record) processor.Record {
			// Example: transform email to lowercase
			if email, ok := r["email"].(string); ok {
				r["email"] = strings.ToLower(email)
			}
			return r
		}).
		Build()

	// Open files
	input, err := os.Open(*inputPath)
	if err != nil {
		logger.Error("failed to open input", "error", err)
		os.Exit(1)
	}
	defer input.Close()

	output, err := os.Create(*outputPath)
	if err != nil {
		logger.Error("failed to create output", "error", err)
		os.Exit(1)
	}
	defer output.Close()

	// Setup context with cancellation
	ctx, cancel := context.WithCancel(context.Background())

	// Handle signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		logger.Info("shutting down...")
		cancel()
	}()

	// Process
	start := time.Now()
	if err := proc.Process(ctx, input, output, pipeline); err != nil {
		logger.Error("processing failed", "error", err)
		os.Exit(1)
	}

	// Report metrics
	metrics := proc.GetMetrics()
	logger.Info("processing complete",
		"records_processed", metrics.RecordsProcessed,
		"records_failed", metrics.RecordsFailed,
		"duration", time.Since(start),
	)
}
```

### Dockerfile

The multi-stage Dockerfile separates the build environment from the runtime image. The first stage compiles the Go binary with all build tools available. The second stage copies only the compiled binary into a minimal base image, reducing the final image size and attack surface.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/processor ./cmd/processor

FROM alpine:3.19

RUN apk add --no-cache ca-certificates

RUN addgroup -g 1000 processor && adduser -u 1000 -G processor -s /bin/sh -D processor

WORKDIR /app
COPY --from=builder /app/processor .

USER processor

ENTRYPOINT ["./processor"]
```

### Makefile

The Makefile encodes the standard build, test, and benchmark commands so every developer and CI system runs them identically. The `generate-testdata` target creates a million-row CSV for benchmarking the pipeline under realistic load.

```makefile
# Makefile
.PHONY: all build test benchmark clean

BINARY=processor

all: build

build:
	go build -o bin/$(BINARY) ./cmd/processor

test:
	go test -v -race ./...

benchmark:
	go test -bench=. -benchmem ./...

# Process sample data
process-csv:
	./bin/processor -input testdata/input.csv -output testdata/output.csv -format csv

# Generate test data
generate-testdata:
	@echo "id,name,email,status" > testdata/input.csv
	@for i in $$(seq 1 1000000); do echo "$$i,User$$i,user$$i@example.com,active" >> testdata/input.csv; done

clean:
	rm -rf bin/
```

### Junior → FAANG: Prerequisites and Interview Framing

A framework like this one packs a lot of Go idioms into a small surface. Before it makes sense, you need fluency in four things. First, channels as pipelines: a `chan Record` is the unit of streaming, and each stage in the pipeline is a goroutine that reads from an input channel, transforms, and writes to an output channel. The pipeline is topologically a DAG of goroutines connected by channels. Second, context propagation: every long-running operation takes a `context.Context` as its first argument, checks `ctx.Done()` regularly, and returns promptly on cancellation. This is how you get clean shutdown. Third, the interface-plus-implementation split: `Reader`, `Writer`, and `Stage` are small interfaces that different format and transform implementations satisfy, so the core processor does not know about CSV or JSON at all. Fourth, worker pools: a fixed number of goroutines pull from a shared input channel and push to a shared output channel, bounded by channel buffer size.

A worked first-job scenario. Your team uses a Python script to process a million-row CSV nightly, and it takes two hours. You rewrite it in Go with this framework. The throughput gain comes from three places, not just "Go is faster." The CSV reader streams rather than loading the full file into memory, so you avoid swap thrashing. The pipeline stages run concurrently on separate cores, so filtering and mapping overlap with reading. The worker pool distributes the expensive per-record work across all cores. The interview framing question is "why is this faster than a simple loop," and the signal they want is all three reasons plus an acknowledgment that if the per-record work is trivial the channel overhead may dominate and the simple loop wins. Nuance matters.

The typical first-job mistake on a framework like this is overfitting the abstraction. Someone adds `Reader`, `Writer`, `Stage`, then another `Source`, `Sink`, `Processor`, `Pipeline`, `PipelineBuilder`, `PipelineDirector`, and the code becomes unreadable. The Go style is to start with three concrete interfaces at most, and only add abstractions when a second concrete implementation proves they are needed. Reviewers at FAANG Go teams will push back hard on premature abstraction. The correct response to "I might need this someday" is "delete it, add when needed." YAGNI has teeth in Go.

Interview framing at junior-to-mid level usually asks you to extend this framework: "add a JSON Lines reader" or "add a rate-limiter stage." The signal: you correctly implement the `Reader` or `Stage` interface, you respect the context, you close the output channel in a defer, you handle partial reads. Candidates who forget to close the channel deadlock the pipeline and fail the screen.

### Senior @ FAANG: Framework Design, When to Buy vs Build, and Production Data Platforms

At staff level, the question is almost never "write this framework from scratch." The question is "should we adopt Airflow, Dagster, Prefect, Flyte, Temporal, Spark, or Beam, or build our own." Picking wrong here costs years of engineering time and locks your data platform into the wrong abstractions. Understand each ecosystem deeply before recommending one.

Airflow is the incumbent workflow orchestrator, still dominant in 2026 despite its age and quirks. It is Python-native, DAG-per-file, with a rich operator catalog. Strengths: enormous ecosystem, every cloud provider integrates with it, battle-tested at petabyte scale. Weaknesses: scheduler latency is in the tens of seconds, not subsecond, so it is wrong for near-real-time workloads. Its Python-only execution model means Go services call into Airflow via APIs, not the other way. Use Airflow for batch ETL where "runs every hour" is fast enough.

Dagster is the modern replacement. Asset-oriented rather than task-oriented, which means your DAG is defined by data dependencies rather than execution order. Strong type system for assets, first-class support for software-defined data products, excellent local dev experience. Weaknesses: smaller ecosystem than Airflow, and the asset model is a conceptual shift that not every team absorbs easily. Use Dagster for greenfield data platforms where asset lineage and observability are first-class requirements.

Prefect is the "better Airflow" for teams that want Python-native orchestration without Airflow's quirks. Flow-centric, dynamic DAGs, good developer ergonomics. Weaknesses: less adoption at FAANG scale, and the managed Prefect Cloud has a separate cost model you must factor in. Use Prefect for mid-size data teams that want something newer than Airflow but are not ready for Dagster's asset paradigm.

Flyte is the ML-native orchestrator, originated at Lyft and now a Linux Foundation project. Strongly typed, multi-language (including Go), containerized per task, with native support for distributed training and hyperparameter sweeps. Weaknesses: complex to operate, Kubernetes-heavy. Use Flyte for ML pipelines where reproducibility and versioned artifacts matter more than scheduler simplicity.

Apache Beam is the portable pipeline API that runs on Dataflow (GCP), Flink, Spark, and others. Write the pipeline once, pick the runner. Strengths: windowing and watermarking semantics are the reference benchmark for streaming, and the portability is real, not marketing. Weaknesses: Go SDK is second-class compared to Java and Python, and the abstraction tax is real. Use Beam when you need to run the same pipeline on multiple backends or have hard streaming requirements.

Spark is the big-data default. Structured Streaming handles near-real-time, batch is mature, and Delta Lake (Databricks) or Iceberg (everyone else) plus Spark is the modern lakehouse pattern. Go integration is via Spark Connect's gRPC API in 2026, which finally makes Go a reasonable client language. Use Spark when your data is in a lakehouse and your ad-hoc analysts need to hit it with SQL and notebooks alongside your pipelines.

Temporal is the workflow engine for long-running business logic rather than data pipelines specifically. Durable execution, deterministic replay, first-class Go SDK. Use Temporal for orchestrating business processes (order fulfillment, payment flows, multi-step approvals) where the "pipeline" is really a stateful workflow with human-in-the-loop steps.

When to build in Go rather than adopt one of these. The honest answer: rarely. You build a Go framework like the one in this chapter when your throughput requirements exceed what Python-based orchestrators can sustain per worker (tens of thousands of records per second per core), when your data is already in Go services (gRPC payloads, protobuf logs), when operational simplicity matters more than orchestration features (a single Go binary beats a Python + Kubernetes + Redis + Postgres deployment for a small team), or when you need a library to embed in other Go services rather than a standalone system. Uber's internal Cadence-to-Temporal evolution is the canonical example of the "we need it in Go and we need full control" case.

Backpressure design is the senior-level piece that most first-cut frameworks get wrong. This chapter's framework uses buffered channels, which gives you implicit backpressure: when a downstream stage is slow, the upstream channel fills and the upstream goroutine blocks on send. That works until you have many parallel producers and a single slow consumer, at which point you need explicit backpressure via a semaphore pool or a reactive-streams-style request-credit model. For sustained throughput at FAANG scale, consider integrating with `golang.org/x/sync/semaphore` for credit-based flow control, or bound the whole pipeline with a single `errgroup.Group` plus `SetLimit`.

Observability in a production data framework is not optional. Every stage needs metrics (records in, records out, errors, latency histograms), every failure needs a structured log with correlation IDs, and every pipeline run needs a trace. OpenTelemetry is the 2026 standard: `otelgrpc` and `otelhttp` for transport spans, custom spans for each pipeline stage, and metrics via `go.opentelemetry.io/otel/metric`. The trace connects producer to consumer through the `context.Context` that flows through the pipeline. Without this, debugging a slow pipeline requires adding print statements, which is the signal that your observability is broken.

Schema evolution for records is the other piece every in-house framework eventually gets wrong. Using `map[string]any` as the record type (as this chapter does) is ergonomic for dynamic data but gives up all compile-time type safety. Production frameworks eventually migrate to Avro or protobuf records with a schema registry, because the operational cost of silent field renames and type changes exceeds the ergonomic benefit of untyped maps. Plan for this migration from day one: keep a schema field in every record, version it, and reject records with unknown schema versions rather than silently interpreting them.

Exactly-once semantics in a pipeline framework is the distributed-systems trap. If the pipeline crashes mid-batch, do you reprocess the batch (at-least-once with duplicates) or skip it (at-most-once with loss)? The honest answer for most frameworks is at-least-once with idempotent sinks, which shifts the burden to the output layer to deduplicate by record ID. True exactly-once requires transactional sinks (Kafka transactions, Iceberg commits, database transactions) and transactional source offsets, and it is why Kafka Streams and Flink are popular despite their operational overhead. Do not claim exactly-once on a framework that does not actually provide it.

---
