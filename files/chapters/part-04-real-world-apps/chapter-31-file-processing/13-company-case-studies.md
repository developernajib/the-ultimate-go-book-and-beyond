## Company Case Studies

### Netflix: Parallel Video Encoding

Netflix processes millions of video files for encoding. Their approach emphasizes parallelism and fault tolerance:

```go
// Netflix-style chunked video processing
type VideoProcessor struct {
    chunkSize    int64
    workers      int
    storage      ObjectStorage
    encoder      Encoder
}

func (p *VideoProcessor) ProcessVideo(ctx context.Context, sourceURL string) (*Video, error) {
    // Get video metadata
    info, err := p.storage.Stat(ctx, sourceURL)
    if err != nil {
        return nil, err
    }

    // Calculate chunks
    numChunks := (info.Size + p.chunkSize - 1) / p.chunkSize
    chunks := make([]ChunkResult, numChunks)

    // Process chunks in parallel
    sem := make(chan struct{}, p.workers)
    var wg sync.WaitGroup
    var encodeErr error
    var errOnce sync.Once

    for i := int64(0); i < numChunks; i++ {
        wg.Add(1)
        go func(chunkIndex int64) {
            defer wg.Done()

            // Acquire semaphore
            select {
            case sem <- struct{}{}:
                defer func() { <-sem }()
            case <-ctx.Done():
                return
            }

            start := chunkIndex * p.chunkSize
            end := min(start+p.chunkSize, info.Size)

            // Download chunk
            reader, err := p.storage.GetRange(ctx, sourceURL, start, end)
            if err != nil {
                errOnce.Do(func() { encodeErr = err })
                return
            }

            // Encode chunk
            encoded, err := p.encoder.EncodeChunk(ctx, reader)
            if err != nil {
                errOnce.Do(func() { encodeErr = err })
                return
            }

            chunks[chunkIndex] = ChunkResult{
                Index:   chunkIndex,
                Data:    encoded,
                Success: true,
            }
        }(i)
    }

    wg.Wait()

    if encodeErr != nil {
        return nil, encodeErr
    }

    // Merge chunks
    return p.mergeChunks(ctx, chunks)
}
```

**Key Patterns from Netflix:**
- **Chunked processing**: Split large files for parallel processing
- **Semaphore-based concurrency**: Control worker count
- **Fail-fast**: Stop processing on first error
- **Idempotent chunks**: Each chunk can be retried independently

### Uber: Log Processing at Scale

Uber processes petabytes of logs daily. Their patterns focus on streaming and backpressure:

```go
// Uber-style log processor with backpressure
type LogProcessor struct {
    inputQueue    chan LogEntry
    outputQueue   chan ProcessedLog
    workers       int
    batchSize     int
    flushInterval time.Duration
}

func (p *LogProcessor) Start(ctx context.Context) error {
    // Start batch writer
    go p.batchWriter(ctx)

    // Start workers
    var wg sync.WaitGroup
    for i := 0; i < p.workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            p.worker(ctx)
        }()
    }

    wg.Wait()
    return nil
}

func (p *LogProcessor) worker(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case entry, ok := <-p.inputQueue:
            if !ok {
                return
            }

            // Parse and enrich log entry
            processed, err := p.processEntry(entry)
            if err != nil {
                metrics.IncrementFailed()
                continue
            }

            // Apply backpressure - block if output queue full
            select {
            case p.outputQueue <- processed:
                metrics.IncrementProcessed()
            case <-ctx.Done():
                return
            }
        }
    }
}

func (p *LogProcessor) batchWriter(ctx context.Context) {
    batch := make([]ProcessedLog, 0, p.batchSize)
    ticker := time.NewTicker(p.flushInterval)
    defer ticker.Stop()

    flush := func() {
        if len(batch) == 0 {
            return
        }
        if err := p.writeBatch(ctx, batch); err != nil {
            log.Error("batch write failed", "error", err)
        }
        batch = batch[:0]
    }

    for {
        select {
        case <-ctx.Done():
            flush() // Final flush
            return
        case <-ticker.C:
            flush()
        case entry, ok := <-p.outputQueue:
            if !ok {
                flush()
                return
            }
            batch = append(batch, entry)
            if len(batch) >= p.batchSize {
                flush()
            }
        }
    }
}
```

**Key Patterns from Uber:**
- **Bounded queues**: Prevent memory exhaustion
- **Backpressure propagation**: Slow consumers throttle producers
- **Batch writing**: Amortize I/O overhead
- **Periodic flush**: Ensure data isn't stuck in buffers

### Airbnb: ETL Pipeline

Airbnb processes massive data files for their analytics pipeline:

```go
// Airbnb-style ETL pipeline
type ETLPipeline struct {
    source       DataSource
    destination  DataDestination
    transforms   []Transform
    checkpointer Checkpointer
}

func (p *ETLPipeline) Run(ctx context.Context, job *ETLJob) error {
    // Load checkpoint
    checkpoint, err := p.checkpointer.Load(ctx, job.ID)
    if err != nil && !errors.Is(err, ErrNoCheckpoint) {
        return err
    }

    // Open source with checkpoint offset
    reader, err := p.source.Open(ctx, job.SourcePath, checkpoint.Offset)
    if err != nil {
        return err
    }
    defer reader.Close()

    // Create destination writer
    writer, err := p.destination.Open(ctx, job.DestPath)
    if err != nil {
        return err
    }
    defer writer.Close()

    // Process records
    var processedCount int64
    var lastCheckpoint time.Time

    for record := range reader.Records(ctx) {
        // Apply transforms
        transformed := record
        for _, t := range p.transforms {
            var err error
            transformed, err = t.Apply(ctx, transformed)
            if err != nil {
                if t.SkipOnError() {
                    continue
                }
                return fmt.Errorf("transform %s failed: %w", t.Name(), err)
            }
        }

        // Write to destination
        if err := writer.Write(ctx, transformed); err != nil {
            return err
        }

        processedCount++

        // Checkpoint periodically
        if time.Since(lastCheckpoint) > 30*time.Second {
            err := p.checkpointer.Save(ctx, job.ID, Checkpoint{
                Offset:    reader.Offset(),
                Processed: processedCount,
                UpdatedAt: time.Now(),
            })
            if err != nil {
                log.Warn("checkpoint failed", "error", err)
            }
            lastCheckpoint = time.Now()
        }
    }

    // Final checkpoint
    return p.checkpointer.Save(ctx, job.ID, Checkpoint{
        Offset:    reader.Offset(),
        Processed: processedCount,
        Complete:  true,
        UpdatedAt: time.Now(),
    })
}
```

**Key Patterns from Airbnb:**
- **Checkpointing**: Resume from failures without reprocessing
- **Transform chain**: Composable transformations
- **Skip-on-error option**: Flexible error handling per transform
- **Periodic saves**: Balance durability with performance

### Junior → FAANG: Prerequisites and Interview Framing

These case studies distill thousands of engineer-years into pages of code, which makes them look simpler than they are. Before you can reason about them, pin down three ideas that recur across all three. First, chunking. Any file large enough to matter is processed in pieces, because you cannot fit terabytes in memory and because a crash at byte N should not force you to restart from byte zero. Second, idempotency. Every piece of work must be safely retryable, which means the output must be a pure function of the input plus a deterministic side-effect policy (write-if-not-exists, upsert by key). Third, checkpointing. Long-running pipelines save their progress so restarts resume from the last good point rather than from scratch. These three ideas are the unifying theme, and every FAANG data platform is a variation on them.

A worked first-job context. You are given a 50 GB CSV file and asked to filter and upload processed rows to S3. The Netflix chunking lesson applies: split by byte range (not by line count, because you do not know line positions without scanning), process chunks concurrently, write chunk outputs to S3 with deterministic keys, and merge only at the end. The Uber batching lesson applies: group S3 uploads into multipart or batched PUTs rather than one PUT per row. The Airbnb checkpointing lesson applies: persist "I have processed through byte offset X" to a small state file so a crashed job resumes. A junior engineer who ships just "read CSV, transform, write S3" gets it working on small files and fails at 50 GB. The engineer who thinks in chunks, batches, and checkpoints gets a senior mentor's attention.

Interview framing for "design a data pipeline" is broad enough to flex in any direction. The signal interviewers look for: you chunk large inputs, you checkpoint progress, you handle partial failures with retry rather than abort, you bound memory with backpressure, you separate compute from storage (do not tie your pipeline to one output destination), and you instrument with metrics from day one. Junior candidates propose "load the file, process each row, save results." Senior candidates propose all the above and ask about scale, latency budget, and failure tolerance before writing code. The conversation before the code is the signal.

### Senior @ FAANG: Real Platform Case Studies and Architectural Lessons

The snippets above capture patterns but not the production systems they come from. Staff engineers need the fuller picture. Here is what the real systems look like in 2026, and the lessons that carry into Go system design.

Uber Marmaray is Uber's generic batch data ingestion platform, open-sourced in 2018 and still running internally. It moves data between any Hadoop-compatible source and sink (HDFS, Hive, Cassandra, Kafka) through a shared Spark-based engine. The architectural lesson is the generic "source to sink" abstraction with a shared pipeline of extract-transform-dispersal. Any new data source becomes a Marmaray adapter rather than a new pipeline. For Go engineers the lesson is to design your pipeline framework so that adding a new source is a matter of implementing a small `Source` interface, not a new pipeline. The anti-pattern Uber was escaping was "every team writes its own ingestion job with its own failure modes." The right abstraction turns N pipelines into one pipeline with N adapters.

Netflix Keystone is the real-time event processing backbone, handling over a trillion events per day. It is built on Kafka, Flink, and Iceberg, with a routing layer that fans events to many consumers with different latency and reliability requirements. The architectural lesson is the "router plus fleet of consumers" model: one durable event log, many independent consumers each with their own checkpoint and replay semantics. If one consumer is slow, the event log absorbs the backlog and the producer is not affected. For Go engineers building event-driven systems, the lesson is to never couple producers to consumers directly. Put a Kafka or equivalent log between them, because it is the only way to get independent failure and replay for each consumer.

Stripe's batch pipelines run on Flink and Spark for different workloads, with strong emphasis on correctness and auditability. Every pipeline is expected to be deterministic, idempotent, and reconcilable against source-of-truth data. Stripe famously runs reconciliation jobs that cross-check every processed transaction against the upstream payments ledger, with alarms on any drift. The architectural lesson is that determinism is a testable property: pin inputs, pin code version, rerun, compare outputs bit-for-bit. For Go engineers, the lesson is to make every pipeline deterministic by construction (no wall-clock time, no random IDs, no map iteration order leaking into outputs) and to add reconciliation as a first-class job, not an afterthought.

Airbnb's Data Quality program (the "Midas" system) treats data pipelines as versioned, reviewed, and certified artifacts. Every dataset has an owner, a schema, an SLA, and a certification level. The architectural lesson is that data has a lifecycle just like code: review, test, certify, deprecate, retire. For Go engineers, the lesson is that a production data platform needs catalog, lineage, and quality metrics as core features, not bolt-ons. Build the catalog into your framework (every pipeline registers its inputs and outputs with a metadata service) or adopt one of DataHub, Amundsen, or Atlan.

Meta's Scuba and Presto stack is the interactive-analytics side of the coin. Scuba holds raw event data in memory across thousands of machines for subsecond queries, while Presto (now Trino) serves federated SQL over Iceberg tables. The lesson is that "batch" and "interactive" are different workloads and should share storage but not compute. Writing pipelines that output to Iceberg or Delta Lake means Presto, Spark, Dremio, and Trino can all read the same data without a separate export step.

Google's Dataflow and internal Flume are the spiritual ancestors of Apache Beam. The Beam programming model (PCollections, PTransforms, windowing, triggers) encodes lessons learned from a decade of running MapReduce at Google scale. The deepest lesson is windowing: streaming data does not have well-defined boundaries, so every aggregation must declare its window (fixed, sliding, session) and its trigger (watermark, processing-time, data-driven). Any streaming pipeline that skips this question is implicitly choosing defaults that will be wrong for some input pattern. Go pipelines using Beam's Go SDK inherit this rigor, pipelines using hand-rolled stream processing usually do not and eventually get it wrong.

Shopify's pipeline culture emphasizes "micro-batching" as a default: tiny frequent batches rather than streaming or hourly jobs. This gets most of the latency benefit of streaming with most of the operational simplicity of batch. The lesson for Go engineers is that "should this be streaming" is often a false dichotomy. A pipeline that runs every 60 seconds on 60-second windows is simpler to operate and debug than a true streaming pipeline, and for most business use cases the latency difference is invisible.

Cloudflare's Quicksilver and R2 pipelines show the edge-first design pattern. Data is processed as close to ingestion as possible (at the edge PoP), summarized, and only summaries travel to the core. This inverts the traditional "ship everything to the data center and process there" model, trading processing complexity for bandwidth and latency wins. For Go engineers building observability pipelines, the lesson is that aggregation should happen at the collector, not the warehouse. Vector and the OpenTelemetry Collector embody this pattern in the observability ecosystem.

LinkedIn's Kafka origin story is worth remembering because it frames why Kafka exists. LinkedIn had N producer systems and M consumer systems, which meant N times M custom integration code paths. Kafka replaces that with N plus M, a single log that producers write to and consumers read from. The lesson generalizes: whenever you see quadratic integration complexity between producers and consumers, introduce a log or bus. This applies to file processing too. A pipeline that watches one directory per source and writes to one destination per sink is a quadratic mess. A pipeline that reads from a single "ingest" bucket with metadata routing and writes to a single "processed" bucket with metadata routing is linear.

Production failure modes these case studies gloss over. Stragglers: one slow chunk blocks the merge step, so production systems add speculative execution (start a second worker on slow chunks and take whichever finishes first). Hot partitions: a single popular key swamps one worker, so production systems salt keys or repartition dynamically. Late data: events arrive after their window closed, so production systems buffer for a "late arrival grace period" and emit corrections. Schema drift: upstream adds a field and downstream consumers break, so production systems require schema compatibility checks at publish time. Any framework that does not explicitly handle these is at best a dev-scale framework, at worst a production incident waiting to happen. When interviewing staff candidates for a data-platform role, the ability to enumerate these failure modes and their standard mitigations is the differentiator.

Open-source options every staff engineer should know concretely in 2026: Apache Iceberg (table format, now dominant), Apache Hudi (alternative, stronger for upserts), Delta Lake (Databricks-native, open standard), DuckDB (embedded analytics engine, highly effective for local processing of medium data), Arrow Flight (columnar RPC, replacing JDBC for data movement), Kafka Connect (source/sink connectors, the standard for non-streaming integrations), and Temporal (durable workflow, strong Go story). The technology choice matters less than the architectural alignment with your team's operational capacity and data gravity.

---
