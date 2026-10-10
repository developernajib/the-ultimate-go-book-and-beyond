# Capstone Project 9: Observability Platform

**Difficulty**: Advanced
**Estimated Time**: 3-4 weeks
**Target**: Unified telemetry ingestion, processing, and querying platform
**Tech Stack**: Go 1.27+, OpenTelemetry, BadgerDB / ClickHouse, TSDB indexing, gRPC, Protobuf, Grafana Plugin

---

### Project Overview & Architecture

Observability is the nervous system of modern distributed architectures. As systems scale to thousands of microservices handling millions of operations per second, engineers cannot rely on SSH or local log files; they require unified real-time telemetry across the three pillars: metrics, structured logs, and distributed traces.

In this capstone project, you will build an end-to-end, high-performance Observability Platform in Go. The platform ingests telemetry via OTLP (OpenTelemetry Protocol) over gRPC, processes events through concurrent non-blocking pipelines with rate limiting and deduplication, stores compressed time-series data using custom delta-of-delta encoding, and serves high-speed queries compatible with Prometheus PromQL and Grafana datasources.

```
┌──────────────────────────────────────────────────────────────┐
│                    Telemetry Producers                       │
│                                                              │
│      Services / Apps (OTel SDK) ────> OTLP gRPC Stream       │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                  Telemetry Ingestion Engine                  │
│                                                              │
│   Worker Pools & Non-Blocking Ring Buffers                   │
│   ├─ Ingestion Validation & Schema Enforcement               │
│   ├─ Dynamic Sampling (Head-based & Tail-based)              │
│   └─ High-Throughput Batch Compaction                        │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│              Storage & Query Engine (Go TSDB)                │
│                                                              │
│   ├─ In-Memory Head Block (Gorilla XOR & ZigZag Encoding)    │
│   ├─ Persistent Block Storage (Compressed Inverted Index)    │
│   ├─ Query Planner & PromQL Parser (Vector / Matrix Ops)     │
│   └─ Grafana HTTP Query Endpoint & Alert Evaluation Loop     │
└──────────────────────────────────────────────────────────────┘
```

### What You Will Build and Learn Across Sections

- **Part 1 & 2 (Foundation & OTLP Ingestion)**: Implement gRPC receivers conforming to OpenTelemetry specifications for metrics, logs, and trace spans.
- **Part 3 (High-Throughput Pipeline)**: Design lock-free ring buffers, adaptive worker pools, and memory-recycled byte buffers using `sync.Pool` to handle 100k+ events/sec with minimal GC pauses.
- **Part 4 (Time-Series Storage Engine)**: Build a custom time-series storage engine implementing Facebook Gorilla compression (XOR timestamp & value delta-of-delta encoding) and inverted posting lists for label matching.
- **Part 5 (Trace Stitching & Span Graphing)**: Construct directed acyclic graphs (DAGs) from distributed trace spans, calculating critical paths, service dependency maps, and span duration histograms.
- **Part 6 (Query Engine & PromQL Parser)**: Build a query evaluation engine supporting instant and range vector evaluations, rate calculations, and quantile aggregations.
- **Part 7 (Alerting Engine & Grafana API)**: Implement a streaming rule evaluation engine that triggers Webhook and PagerDuty alerts on SLO threshold violations.

### Junior → FAANG: Core Systems & Telemetry Foundations

- **Understanding Zero-Allocation Pipelines**: Telemetry pipelines are the ultimate stress test for Go's garbage collector. Beginners frequently allocate new structs and byte slices per span or log line, causing severe GC thrashing. Master reusing buffers with `sync.Pool` and slicing existing byte payloads in place.
- **Sampling Strategies**: Recording 100% of traces at high traffic volumes is economically and physically unfeasible. Learn how head-based probabilistic sampling differs from tail-based sampling (which retains traces containing 5xx errors or high latency).

### Senior @ FAANG: High-Cardinality & Multi-Tenant Economics

- **The High-Cardinality Trap**: When developers inject dynamic parameters (e.g. `user_id` or `order_id`) as metric labels, the number of distinct time-series explodes exponentially, overwhelming memory indices. Implement cardinality limiters and adaptive series eviction policies.
- **Compaction & Tiered Storage**: Time-series data decays rapidly in access frequency. Design a multi-tiered storage engine that keeps the last 2 hours in RAM, writes 2-hour blocks to local SSD, and compacts 24-hour blocks to compressed cloud object storage (S3/GCS).
- **Graceful Backpressure**: When storage ingestion falls behind incoming network traffic, dropping telemetry arbitrarily causes data blindness during incidents. Implement adaptive backpressure signals (HTTP 429 / gRPC ResourceExhausted) and memory-bounded spill-to-disk spooling.
