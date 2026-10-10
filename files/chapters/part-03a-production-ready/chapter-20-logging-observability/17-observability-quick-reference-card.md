## Observability Quick Reference Card

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    OBSERVABILITY QUICK REFERENCE                                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  THREE PILLARS:                                                                  │
│  ├── Logs:    What happened (discrete events, high cardinality)                  │
│  ├── Metrics: How much/many (aggregated numbers, low cardinality)                │
│  └── Traces:  How things connect (distributed request flow, sampled)             │
│                                                                                  │
│  STRUCTURED LOGGING (slog):                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  slog.Info("request completed",                                         │     │
│  │      "method", r.Method,                                                │     │
│  │      "path", r.URL.Path,                                                │     │
│  │      "status", status,                                                  │     │
│  │      "duration_ms", duration.Milliseconds(),                            │     │
│  │      "trace_id", traceID,  // ALWAYS include correlation IDs            │     │
│  │  )                                                                      │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  PROMETHEUS METRICS:                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  Counter:   requestsTotal.Inc()           // Cumulative count           │     │
│  │  Gauge:     activeConns.Set(123)          // Current value              │     │
│  │  Histogram: requestDuration.Observe(0.5)  // Distribution               │     │
│  │  Summary:   responseSize.Observe(1024)    // Percentiles                │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  CARDINALITY RULES:                                                              │
│  ├── NEVER use user_id, request_id as labels (use logs/traces)                   │
│  ├── < 1000 unique label combinations per metric                                 │
│  ├── Use buckets for continuous values (latency_bucket: fast/normal/slow)        │
│  └── Use exemplars to link metrics → traces                                      │
│                                                                                  │
│  DISTRIBUTED TRACING (OpenTelemetry):                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  ctx, span := tracer.Start(ctx, "operation-name")                       │     │
│  │  defer span.End()                                                       │     │
│  │                                                                         │     │
│  │  span.SetAttributes(                                                    │     │
│  │      attribute.String("user.id", userID),                               │     │
│  │      attribute.Int("items.count", len(items)),                          │     │
│  │  )                                                                      │     │
│  │                                                                         │     │
│  │  if err != nil {                                                        │     │
│  │      span.RecordError(err)                                              │     │
│  │      span.SetStatus(codes.Error, err.Error())                           │     │
│  │  }                                                                      │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  SAMPLING STRATEGIES:                                                            │
│  ├── Head-based: Decide at start (simple, may miss errors)                       │
│  ├── Tail-based: Decide after completion (complex, captures errors)              │
│  └── Adaptive: Always sample errors/slow, ratio for rest                         │
│                                                                                  │
│  HEALTH CHECKS:                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  /healthz (Liveness):   Is process alive? (don't check deps)            │     │
│  │  /readyz (Readiness):   Can accept traffic? (check deps)                │     │
│  │  /health (Comprehensive): Full status with component checks             │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  ALERTING BEST PRACTICES:                                                        │
│  ├── Alert on symptoms (high error rate), not causes (high CPU)                  │
│  ├── Use SLO-based alerts (error budget burn rate)                               │
│  ├── Multi-window, multi-burn-rate for accurate alerts                           │
│  ├── Include runbook links in alert annotations                                  │
│  └── Severity levels: critical (page), warning (ticket), info (log)              │
│                                                                                  │
│  RED METHOD (Request-driven services):                                           │
│  ├── Rate:     Requests per second                                               │
│  ├── Errors:   Failed requests per second                                        │
│  └── Duration: Latency distribution (p50, p95, p99)                              │
│                                                                                  │
│  USE METHOD (Resource-oriented):                                                 │
│  ├── Utilization: % time resource is busy                                        │
│  ├── Saturation:  Queue length, pending work                                     │
│  └── Errors:      Error count for resource                                       │
│                                                                                  │
│  GOLDEN SIGNALS (Google SRE):                                                    │
│  ├── Latency:     Time to service a request                                      │
│  ├── Traffic:     Demand on the system                                           │
│  ├── Errors:      Rate of failed requests                                        │
│  └── Saturation:  How "full" the service is                                      │
│                                                                                  │
│  PROMQL CHEAT SHEET:                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  # Request rate                                                         │     │
│  │  rate(http_requests_total[5m])                                          │     │
│  │                                                                         │     │
│  │  # Error rate                                                           │     │
│  │  sum(rate(http_requests_total{status=~"5.."}[5m]))                      │     │
│  │    / sum(rate(http_requests_total[5m]))                                 │     │
│  │                                                                         │     │
│  │  # P99 latency ("sum by (le)" is required, not optional)                │     │
│  │  histogram_quantile(0.99,                                               │     │
│  │    sum by (le) (rate(http_request_duration_seconds_bucket[5m])))        │     │
│  │                                                                         │     │
│  │  # SLO burn rate (99.9% target, 30-day window)                          │     │
│  │  sum(rate(http_requests_total{status=~"5.."}[1h]))                      │     │
│  │    / sum(rate(http_requests_total[1h]))                                 │     │
│  │    / 0.001  # Error budget                                              │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  DEBUGGING WORKFLOW (5 minutes):                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  1. Alert fires → Check error rate dashboard                            │     │
│  │  2. Identify affected service/endpoint from metrics                     │     │
│  │  3. Click exemplar → Jump to trace                                      │     │
│  │  4. Trace → Identify slow/failing span                                  │     │
│  │  5. Copy trace_id → Search logs                                         │     │
│  │  6. Logs reveal root cause                                              │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  COMMON PITFALLS:                                                                │
│  ├── High-cardinality metrics → Use logs/traces for user_id, etc.                │
│  ├── Missing correlation → Always include trace_id in logs                       │
│  ├── Alert fatigue → Alert on SLOs, not individual metrics                       │
│  ├── Logging secrets → Automatic redaction for sensitive fields                  │
│  └── Sampling misses errors → Always sample errors (tail-based)                  │
│                                                                                  │
│  TOOL SELECTION:                                                                 │
│  ├── Logs: Loki (lightweight), Elasticsearch (full-text search)                  │
│  ├── Metrics: Prometheus (pull), Mimir (scale), Datadog (managed)                │
│  ├── Traces: Tempo (Grafana), Jaeger (Uber), Zipkin                              │
│  └── Visualization: Grafana (unified), Kibana (ELK)                              │
│                                                                                  │
│  COST OPTIMIZATION:                                                              │
│  ├── Sample traces (1-10% normal, 100% errors)                                   │
│  ├── Aggregate metrics (5min in warm, 1hr in cold storage)                       │
│  ├── Limit log retention (7 days hot, 30 days warm, 1 year cold)                 │
│  ├── Index only essential log fields                                             │
│  └── Use tiered storage (SSD → HDD → S3)                                         │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Staff Lens: Distribute to On-Call Engineers

Print this card for the on-call team. In an incident, the diagnostic paths and tool selection are exactly what the on-call engineer needs. The card reduces cognitive load during stressful moments.

---
