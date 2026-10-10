## Monitoring & Alerting

Monitoring a music streaming platform requires tracking metrics across several dimensions: streaming quality (are users experiencing buffering?), infrastructure health (is the CDN performing well?), business metrics (are royalties being calculated correctly?), and content pipeline metrics (are new uploads being processed on time?). The metrics, dashboards, and alerting rules below cover the critical signals that an operations team needs to keep the platform healthy at scale.

### Key Metrics Table

| Metric | Description | Alert Threshold | Dashboard |
|--------|-------------|-----------------|-----------|
| `stream.active_sessions` | Number of concurrent streaming sessions | > 90% capacity | Streaming |
| `stream.buffer_underrun_rate` | Percentage of sessions experiencing buffering | > 2% | Streaming |
| `stream.startup_latency_p99` | Time from play press to first audio (P99) | > 3s | Streaming |
| `stream.quality_distribution` | Breakdown of active streams by quality | Low > 30% | Streaming |
| `stream.segments_per_sec` | Total segment requests per second | > 90% capacity | Streaming |
| `cdn.cache_hit_rate` | CDN cache hit ratio for audio segments | < 85% | CDN |
| `cdn.origin_bandwidth` | Bandwidth to origin servers | > 50% capacity | CDN |
| `cdn.edge_latency_p99` | CDN edge response time | > 200ms | CDN |
| `search.latency_p99` | Elasticsearch query latency | > 500ms | Search |
| `search.result_quality` | Click-through rate on search results | < 40% | Search |
| `recs.model_latency_p99` | Recommendation inference latency | > 200ms | Recommendations |
| `recs.engagement_rate` | Percentage of recommended tracks played >30s | < 20% | Recommendations |
| `royalty.events_lag_seconds` | Kafka consumer lag for play events, in time | > 300s | Royalties |
| `royalty.calculation_errors` | Failed royalty calculations | > 0 | Royalties |
| `stream.play_events_dropped` | Play events shed because the buffer was full | > 0 | Royalties |
| `transcode.queue_depth` | Pending transcoding jobs | > 1,000 | Ingestion |
| `transcode.failure_rate` | Transcoding job failure rate | > 1% | Ingestion |

### Dashboard Recommendations

1. **Streaming Health Dashboard**: Active streams gauge, buffer underrun heatmap by region, startup latency percentiles, quality distribution pie chart.
2. **CDN Performance Dashboard**: Cache hit rates per PoP, origin bandwidth, segment latency heatmap, popular track caching efficiency.
3. **Content Pipeline Dashboard**: Transcoding queue depth, job success rate, new tracks ingested per hour, storage growth rate.
4. **Recommendation Dashboard**: Model latency, A/B test results, engagement metrics, diversity scores, cold-start performance.
5. **Revenue Dashboard**: Play counts by track/artist, royalty accrual rates, premium vs free user streaming patterns, per-stream cost.

### Alerting Rules

These Prometheus alerting rules encode the thresholds from the metrics table. Every rule carries a `for` duration so that a transient spike does not page anyone, and the rate windows smooth out momentary network congestion.

Alert on lag in seconds, not in messages. A raw message count sounds concrete but it is unreadable without dividing by throughput in your head, and it silently changes meaning as traffic grows. At 5B events/day this pipeline moves roughly 58K events/sec, so a threshold of 100K messages is under two seconds of backlog and pages all night for a batch pipeline nobody expects to be real-time. Five minutes of lag is a real signal. Two seconds is noise, and an alert that cries wolf gets muted, which is how the one that mattered gets missed.

```yaml
groups:
  - name: spotify_critical
    rules:
      - alert: HighBufferUnderrunRate
        expr: rate(stream_buffer_underrun_total[5m]) / rate(stream_segment_total[5m]) > 0.02
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Buffer underrun rate exceeds 2%"

      - alert: CDNCacheHitLow
        expr: cdn_cache_hit_rate < 0.85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "CDN cache hit rate below 85%"

      # Lag in seconds: messages divided by the rate they are being consumed.
      - alert: RoyaltyEventLag
        expr: >
          kafka_consumer_lag{topic="play_events"}
          / rate(kafka_consumer_consumed_total{topic="play_events"}[5m]) > 300
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Play event consumer more than 5 minutes behind"

      # Play events are billable. Any sustained drop means royalty undercounting,
      # so this pages at the first non-zero rate rather than at a percentage.
      - alert: PlayEventsDropped
        expr: rate(stream_play_events_dropped_total[5m]) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Play events being shed: royalty counts will undercount"

      - alert: TranscodeQueueBacklog
        expr: transcode_queue_depth > 1000
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Transcoding queue backlog exceeds 1000 jobs"
```

---
