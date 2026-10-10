## 103.6 OpenTelemetry Collector

### Collector Configuration

The OpenTelemetry Collector configuration defines receivers, processors, and exporters that form the telemetry pipeline between instrumented services and observability backends. The following YAML configuration demonstrates a production-ready pipeline with batching, resource enrichment, and multi-backend export.

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

  prometheus:
    config:
      scrape_configs:
        - job_name: 'go-services'
          scrape_interval: 15s
          static_configs:
            - targets: ['service1:8080', 'service2:8080']

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024

  memory_limiter:
    check_interval: 1s
    limit_mib: 1000
    spike_limit_mib: 200

  attributes:
    actions:
      - key: environment
        value: production
        action: insert

  filter:
    traces:
      span:
        - 'attributes["http.target"] == "/health"'

exporters:
  otlp:
    endpoint: jaeger:4317
    tls:
      insecure: true

  prometheus:
    endpoint: 0.0.0.0:8889

  # The old `logging` exporter was removed, use `debug` instead
  debug:
    verbosity: detailed

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  pprof:
    endpoint: 0.0.0.0:1777

service:
  extensions: [health_check, pprof]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, attributes, filter, batch]
      exporters: [otlp, debug]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
```

### Junior → FAANG: What the Collector Actually Does and Why It Matters

Many engineers think the Collector is optional because the OTel SDK can export directly to Jaeger or Prometheus. At FAANG, direct export from application to backend is considered an anti-pattern for two reasons. First, it couples your application to a specific backend: if you switch from Jaeger to Grafana Tempo, you must redeploy every service. Second, it pushes backend-specific concerns (batching, retry logic, connection management) into application code.

The Collector decouples the "what data to collect" decision (made in application code) from the "where to send it and how to process it" decision (made in Collector configuration). This separation is what enables platform teams to add new backends, apply PII scrubbing, or change sampling rates without touching a single service.

For a first job, understand the three pipeline stages: receivers accept data (OTLP, Prometheus scrape, Zipkin). Processors transform data (batch, memory limiter, attribute filter). Exporters send data to backends (OTLP, Jaeger, Prometheus remote write). You should be able to draw this pipeline from memory in an interview.

### Senior @ FAANG: Collector Topology, Capacity Planning, and Operational Safety

**Tiered Collector deployment.** A production Collector topology has two tiers. The first tier is a per-node DaemonSet (or sidecar per pod) that accepts OTLP from local services, applies head-based sampling and local batching, and forwards to the second tier. The second tier is a horizontally scaled stateful set of gateway Collectors that apply tail-based sampling, PII scrubbing, fan-out to multiple backends, and cross-service correlation. This topology is necessary because tail-based sampling requires seeing all spans for a trace before making a sampling decision, which requires routing spans from the same trace to the same gateway instance using consistent hashing.

**Memory limiter is not optional.** Without `memory_limiter`, a spike in ingestion volume can cause the Collector process to OOM-kill, dropping all buffered telemetry without sending it to any backend. The memory limiter processor drops new data when the process approaches a configurable memory threshold, which is a lossy but safe degradation. A common production baseline sets the memory limiter to roughly 80% of the container memory limit, with an alert on the Collector's own `otelcol_processor_refused_spans` and drop metrics so sustained data loss is caught within minutes.

**Collector as a security boundary.** The Collector is the last line of defense before telemetry data reaches external backends. An `attributes` processor with `action: delete` removes PII fields (user email, session token, IP address) before export. A `filter` processor drops spans from internal health-check routes that generate noise without providing signal. Documenting these transformations in a "data lineage" runbook is an L6 responsibility: if a compliance audit asks "where does user data flow," the Collector configuration is part of the answer.

**Capacity planning.** At high scale, the Collector fleet itself becomes a significant infrastructure cost. A senior engineer instruments the Collector with its own metrics (the Collector exports `otelcol_*` metrics about its own throughput, queue depth, and drop rate), builds a Grafana dashboard for Collector health, and sets capacity thresholds that trigger horizontal scaling before queue saturation occurs. The Collector should never be the bottleneck in the telemetry pipeline. If it is, the upstream sampling rate needs to be reduced.

---
