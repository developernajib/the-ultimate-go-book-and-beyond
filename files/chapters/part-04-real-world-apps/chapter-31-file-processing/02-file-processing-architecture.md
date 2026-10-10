## File Processing Architecture

The architecture diagram below shows how files flow from discovery through decoding, transformation, validation, and output encoding. Every input source, local files, network streams, object storage, message queues, enters the pipeline through a unified `io.Reader` interface. Each stage operates concurrently, with back-pressure naturally applied through channel buffering. The streaming pattern at the center keeps memory usage proportional to the buffer size, not the file size.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    FILE PROCESSING ARCHITECTURE                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                         Input Sources                                    │    │
│  │                                                                          │    │
│  │   Local Files     Network Streams     Object Storage    Message Queue    │    │
│  │        │                │                   │                │           │    │
│  │        └────────────────┴────────┬──────────┴────────────────┘           │    │
│  │                                  │                                       │    │
│  │                                  ▼                                       │    │
│  │                    ┌────────────────────────┐                            │    │
│  │                    │     io.Reader          │                            │    │
│  │                    │  (Unified Interface)   │                            │    │
│  │                    └────────────┬───────────┘                            │    │
│  │                                 │                                        │    │
│  └─────────────────────────────────┼────────────────────────────────────────┘    │
│                                    │                                             │
│                                    ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                     Processing Pipeline                                  │    │
│  │                                                                          │    │
│  │  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   │    │
│  │  │   Decode    │──►│  Transform  │──►│  Validate   │──►│   Encode    │   │    │
│  │  │             │   │             │   │             │   │             │   │    │
│  │  │ - Decompress│   │ - Filter    │   │ - Schema    │   │ - Compress  │   │    │
│  │  │ - Parse     │   │ - Map       │   │ - Business  │   │ - Format    │   │    │
│  │  │ - Stream    │   │ - Aggregate │   │ - Sanitize  │   │ - Serialize │   │    │
│  │  └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘   │    │
│  │                                                                          │    │
│  │                         STREAMING PATTERNS                               │    │
│  │                                                                          │    │
│  │  ┌───────────────────────────────────────────────────────────────────┐   │    │
│  │  │                                                                   │   │    │
│  │  │   Reader ──► Buffer ──► Process ──► Buffer ──► Writer             │   │    │
│  │  │              (8KB)                    (8KB)                       │   │    │
│  │  │                                                                   │   │    │
│  │  │   Memory: O(buffer_size), not O(file_size)                        │   │    │
│  │  │                                                                   │   │    │
│  │  └───────────────────────────────────────────────────────────────────┘   │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                    │                                             │
│                                    ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                     io.Writer Interface                                  │    │
│  │                                                                          │    │
│  │        ┌───────────────────────┬───────────────────────┐                 │    │
│  │        │                       │                       │                 │    │
│  │        ▼                       ▼                       ▼                 │    │
│  │   ┌──────────┐           ┌──────────┐           ┌──────────┐             │    │
│  │   │  File    │           │  Network │           │  Memory  │             │    │
│  │   │  Writer  │           │  Writer  │           │  Buffer  │             │    │
│  │   └──────────┘           └──────────┘           └──────────┘             │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│                                                                                  │
│                         PARALLEL PROCESSING                                      │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                          │    │
│  │   ┌─────────┐                                                            │    │
│  │   │  File   │                                                            │    │
│  │   │ Reader  │                                                            │    │
│  │   └────┬────┘                                                            │    │
│  │        │                                                                 │    │
│  │        │  Split into chunks                                              │    │
│  │        │                                                                 │    │
│  │        ├──────────────┬──────────────┬──────────────┐                    │    │
│  │        ▼              ▼              ▼              ▼                    │    │
│  │   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐               │    │
│  │   │ Worker  │    │ Worker  │    │ Worker  │    │ Worker  │               │    │
│  │   │   1     │    │   2     │    │   3     │    │   N     │               │    │
│  │   └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘               │    │
│  │        │              │              │              │                    │    │
│  │        └──────────────┴──────┬───────┴──────────────┘                    │    │
│  │                              │                                           │    │
│  │                              ▼                                           │    │
│  │                        ┌──────────┐                                      │    │
│  │                        │  Merge   │                                      │    │
│  │                        │ Results  │                                      │    │
│  │                        └──────────┘                                      │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│                                                                                  │
│                         ATOMIC FILE WRITE                                        │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                          │    │
│  │   1. Write to temp file:     /data/config.tmp.abc123                     │    │
│  │   2. Sync (fsync):           Ensure data on disk                         │    │
│  │   3. Rename atomically:      /data/config.tmp.abc123 → /data/config.json │    │
│  │                                                                          │    │
│  │   Benefits:                                                              │    │
│  │   - No partial writes visible                                            │    │
│  │   - Crash-safe                                                           │    │
│  │   - No readers see incomplete data                                       │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│                                                                                  │
│                         COMMON FILE FORMATS                                      │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                          │    │
│  │   Format     │ Streaming │ Schema │ Size    │ Use Case                   │    │
│  │   ────────────────────────────────────────────────────────────────────── │    │
│  │   CSV        │ Yes       │ No     │ Medium  │ Tabular data exchange      │    │
│  │   JSON       │ Partial   │ No     │ Large   │ API responses, configs     │    │
│  │   NDJSON     │ Yes       │ No     │ Medium  │ Logs, event streams        │    │
│  │   Protobuf   │ Yes       │ Yes    │ Small   │ RPC, internal storage      │    │
│  │   Parquet    │ Partial   │ Yes    │ Small   │ Analytics, data warehouse  │    │
│  │   Avro       │ Yes       │ Yes    │ Small   │ Kafka, Hadoop ecosystem    │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Junior to FAANG: reading the diagram correctly

A common mistake is to read the architecture diagram top to bottom as if it were a sequence of function calls. It is not. Every arrow is a channel or an interface boundary, and the pipeline runs concurrently. The decoder is not finished before the transformer starts, they run as goroutines connected by channels or by chained `io.Reader` wrappers. That concurrency is what keeps memory proportional to buffer size instead of file size.

The second mistake is missing where back pressure lives. In a channel based pipeline, back pressure comes from bounded channel capacity. When the encoder is slow, its input channel fills, the validator blocks on send, which blocks the transformer, which blocks the decoder, which stops reading from the source. No explicit rate limiter is needed. If you replace channels with unbounded queues, back pressure disappears and memory grows without bound. That is the single most common production incident in junior built pipelines.

The third mistake is treating the parallel processing box as a drop in optimization. Splitting a file across workers only works if the record boundaries are known in advance, or if you can scan forward from a byte offset to the next record boundary (newline for JSONL, row group header for Parquet). CSV with embedded newlines inside quoted fields cannot be split naively, and will produce corrupted records at chunk boundaries.

Practice reading the diagram and naming, for each arrow, whether it is synchronous, asynchronous, buffered, or unbounded. If you cannot answer that, you cannot debug the pipeline when it stalls.

### Senior @ FAANG: the architecture that does not appear in the diagram

The diagram shows the happy path. The production architecture has four layers that are not drawn, and those four layers consume more engineering time than the happy path ever will.

The control plane layer sits above the data plane and decides which files get processed, by whom, in what order, and with what priority. At scale this is a distributed scheduler (internally, something like Google's Borg or Meta's Tupperware, externally Kubernetes with a custom operator or Temporal/Cadence for workflow orchestration). It handles leader election, work stealing, and failure detection. The control plane writes a manifest per run that lists the input files, their checksums, and the target outputs, and that manifest is the source of truth for replay and audit. Without a manifest, you cannot prove what ran.

The lineage layer tracks, for every output byte, which input bytes and which code version produced it. OpenLineage and Marquez are the open standards. Internally at Netflix this is Metacat plus Atlas, at Uber it is Databook, at Meta it is internal. Lineage is what lets you answer "customer X requested GDPR erasure, which downstream datasets contain their data" in under an hour instead of under a week. It is also what lets you do correctness driven rollbacks when a bug ships: identify every output produced by the bad version and reprocess just those.

The quarantine layer captures records that fail validation without stopping the pipeline. The default behavior at junior scale is to fail fast on the first bad record. The default behavior at FAANG scale is to route bad records to a dead letter location, emit a metric, and continue. The quarantine must preserve the original bytes, the validation error, the pipeline version, and the timestamp, because some bad records are actually schema drift that the producer will fix, and you will need to reprocess them. A quarantine without a reprocess path is just a graveyard.

The observability layer is cross cutting and must be designed in, not bolted on. Every stage emits metrics (records in, records out, records quarantined, bytes in, bytes out, latency histograms), structured logs with a trace ID that follows the record through the pipeline, and traces via OpenTelemetry. The trace sampling strategy matters. At 10 million records per second you cannot trace every record, so you head sample by trace ID hash (for deterministic reproduction) and tail sample on error (to always capture failures). The SLO framework at the top is "99.9 percent of records processed within 5 minutes of arrival", and every stage has a latency budget that sums to that SLO.

These four layers are the difference between a pipeline that a senior engineer builds and one that a platform team operates. Interview questions at L6 and above routinely ask "design a file processing platform for 100 teams, not a pipeline for one team", and the answer must lead with control plane, lineage, quarantine, and observability. The data plane is the easy part, and whoever shows up to that interview with a diagram of only the data plane has already lost the loop.

---
