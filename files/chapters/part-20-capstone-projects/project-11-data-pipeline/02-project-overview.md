## Project Overview

We'll build **PipelineX**, a full-featured data processing framework that supports:

- **Declarative pipeline definitions** with fluent APIs
- **Streaming and batch processing** with unified semantics
- **Rich transformations**: Map, Filter, FlatMap, GroupBy, Join, Aggregate
- **Windowing strategies**: Tumbling, Sliding, Session windows
- **Distributed execution** with worker management and fault tolerance
- **State management** with checkpointing and recovery
- **Multiple connectors**: Kafka, Files (CSV/JSON/Parquet), Databases, HTTP
- **Backpressure handling** with adaptive flow control
- **Full monitoring** with metrics and observability

### System Architecture

The system architecture decomposes PipelineX into a pipeline engine, worker pool, state manager, and connector layer, each with clearly defined responsibilities and failure modes.

```
┌───────────────────────────────────────────────────────────────────────┐
│                          PIPELINEX FRAMEWORK                          │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────┐      ┌───────────────┐      ┌─────────────┐          │
│  │   SOURCES   │ ───→ │TRANSFORMATIONS│ ───→ │    SINKS    │          │
│  └─────────────┘      └───────────────┘      └─────────────┘          │
│       │                      │                      │                 │
│       ├─ Kafka               ├─ Map/Filter          ├─ Kafka          │
│       ├─ Files               ├─ FlatMap             ├─ Files          │
│       ├─ Database            ├─ GroupBy             ├─ Database       │
│       ├─ HTTP                ├─ Join                ├─ S3             │
│       └─ Custom              ├─ Window              └─ Custom         │
│                              ├─ Aggregate                             │
│                              └─ Custom                                │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────┐          │
│  │            STATE MANAGEMENT & CHECKPOINTING             │          │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │          │
│  │  │  Memory  │  │   Disk   │  │  Remote  │               │          │
│  │  │  Backend │  │  Backend │  │  Backend │               │          │
│  │  └──────────┘  └──────────┘  └──────────┘               │          │
│  └─────────────────────────────────────────────────────────┘          │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────┐          │
│  │           DISTRIBUTED EXECUTION ENGINE                  │          │
│  │                                                         │          │
│  │   ┌──────────┐   ┌──────────┐   ┌──────────┐            │          │
│  │   │ Worker 1 │   │ Worker 2 │   │ Worker N │            │          │
│  │   └──────────┘   └──────────┘   └──────────┘            │          │
│  │        │              │              │                  │          │
│  │        └──────────────┴──────────────┘                  │          │
│  │                      │                                  │          │
│  │               ┌──────────────┐                          │          │
│  │               │  Coordinator │                          │          │
│  │               └──────────────┘                          │          │
│  └─────────────────────────────────────────────────────────┘          │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────┐          │
│  │         MONITORING & OBSERVABILITY                      │          │
│  │   Metrics │ Tracing │ Logging │ Health Checks           │          │
│  └─────────────────────────────────────────────────────────┘          │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Pipeline Execution Flow

Data flows through the pipeline in stages: a source reads records from Kafka, files, or a database, processors transform, filter, and enrich records, and a sink writes results to the target store.

```
Input Data Stream
      │
      ▼
┌──────────────┐
│   Source     │ ← Read from Kafka/Files/DB
└──────────────┘
      │
      ▼
┌──────────────┐
│ Partitioner  │ ← Distribute across workers
└──────────────┘
      │
      ▼
┌──────────────┐
│ Transform 1  │ ← Map/Filter operations
└──────────────┘
      │
      ▼
┌──────────────┐
│ Transform 2  │ ← Window/GroupBy
└──────────────┘
      │
      ▼
┌──────────────┐
│  Aggregator  │ ← Reduce/Combine
└──────────────┘
      │
      ▼
┌──────────────┐
│     Sink     │ ← Write to destination
└──────────────┘
      │
      ▼
Output Data
```
