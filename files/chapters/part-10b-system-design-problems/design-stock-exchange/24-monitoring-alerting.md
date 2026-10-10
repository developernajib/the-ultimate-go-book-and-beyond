## Monitoring & Alerting

### Key Metrics Table

| Metric | Description | Alert Threshold | Dashboard |
|--------|-------------|-----------------|-----------|
| `matching.latency_p99` | Order-to-match latency (P99) | > 500us | Matching Engine |
| `matching.latency_p50` | Order-to-match latency (P50) | > 100us | Matching Engine |
| `matching.throughput` | Orders processed per second | < 10,000 | Matching Engine |
| `matching.trades_per_sec` | Trade executions per second | Anomaly detection | Matching Engine |
| `orderbook.depth_bid` | Resting bid orders per symbol | < 10 (illiquid) | Market Quality |
| `orderbook.depth_ask` | Resting ask orders per symbol | < 10 (illiquid) | Market Quality |
| `orderbook.spread` | Best ask - best bid per symbol | > 1% of mid | Market Quality |
| `gateway.order_reject_rate` | Orders rejected by risk engine | > 5% | Risk |
| `gateway.fix_session_count` | Active FIX sessions | Drop > 20% | Connectivity |
| `wal.write_latency` | WAL fsync latency | > 100us | Durability |
| `wal.lag_bytes` | Standby WAL replay lag | > 10MB | Failover |
| `surveillance.alert_count` | Manipulation alerts triggered | > 10/hour | Compliance |
| `settlement.pending_count` | Unsettled trades older than T+1 | > 0 | Settlement |
| `kafka.consumer_lag` | Trade event consumer lag | > 10,000 | Infrastructure |
| `system.cpu_usage` | Matching engine CPU utilization | > 70% | Infrastructure |
| `system.gc_pause` | Go GC pause duration | > 1ms | Infrastructure |

### Dashboard Recommendations

1. **Matching Engine Dashboard**: Real-time latency heatmaps (P50/P95/P99), throughput gauges, heap sizes per symbol, GC pause histogram.
2. **Market Quality Dashboard**: Spread charts per symbol, depth heatmaps, trade volume time series, LULD band proximity alerts.
3. **Risk Dashboard**: Reject rates by trader, margin utilization, position limit usage, fat-finger catch rate.
4. **Infrastructure Dashboard**: CPU/memory per node, Kafka lag, WAL replication lag, network throughput, disk I/O.
5. **Compliance Dashboard**: Surveillance alerts timeline, cancel-to-fill ratios by trader, wash trading detections, regulatory report status.

### Alerting Rules

The Prometheus alerting rules below encode the operational thresholds from the metrics table into actionable alerts. The `for` duration on each rule suppresses transient spikes so that only sustained anomalies trigger a page. The WAL replication lag alert uses a short 30-second window because any lag in the hot standby directly increases failover recovery time.

```yaml
groups:
  - name: exchange_critical
    rules:
      - alert: MatchingLatencyHigh
        # histogram_quantile needs the per-bucket rate aggregated by le, not
        # the bare metric name: passing a raw histogram silently yields
        # nothing useful rather than failing loudly.
        expr: >
          histogram_quantile(0.99,
            sum by (le) (rate(matching_latency_seconds_bucket[5m]))) > 0.0005
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "P99 matching latency exceeds 500us"

      - alert: WALReplicationLag
        expr: wal_standby_lag_bytes > 10485760
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "Hot standby WAL lag exceeds 10MB"

      - alert: OrderBookEmpty
        expr: orderbook_depth{side="bid"} == 0 or orderbook_depth{side="ask"} == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Order book has no liquidity on one side"

      - alert: HighRejectRate
        expr: rate(gateway_orders_rejected_total[5m]) / rate(gateway_orders_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Order reject rate exceeds 5%"
```

---
