## Common Mistakes and How to Avoid Them

These mistakes reflect the most common gaps in candidates' understanding of time-series data at scale. Each one has been observed in production outages at real companies.

1. **No pre-aggregation.** Keeping every raw point at full resolution for its entire lifetime makes storage costs and long-range query latency grow linearly with ingest rate. A stream aggregation layer that groups points into 1-minute windows and emits summary statistics (avg, min, max, count) collapses the six 10-second points a series reports per minute into one rollup row, cutting long-term write volume roughly 6x and letting month-long queries scan the compact rollup table instead of raw data.

2. **High-cardinality tags.** Adding a `user_id` tag to a metric creates 100 million unique series, one per user per metric. This explodes storage (each series needs its own index entry), slows queries (an aggregation must touch every one of those 100M series), and can crash the TSDB entirely. The fix is tag validation at the ingest layer: maintain a per-metric allow-list of permitted tag keys, and reject any metric with unauthorized tags.

3. **Single resolution.** Storing 10-second resolution data for a full year requires 365TB of storage (even after compression). The cost is prohibitive, and most historical queries do not need 10-second granularity. Tiered retention, 7 days at full resolution, 1 year at 1-minute resolution, reduces storage by roughly 80% while preserving the data needed for both real-time debugging and long-term capacity planning.

4. **Alert storms.** An oscillating metric that crosses its threshold repeatedly causes the alert engine to fire and resolve every evaluation cycle (every minute), flooding on-call engineers with notifications. Requiring N consecutive failing evaluations before firing (the "flapping guard") prevents this. A typical setting of 3 consecutive checks means a metric must stay above the threshold for 3 minutes before an alert fires.

5. **No query tier optimization.** A dashboard query for "CPU over the last 30 days" does not need 10-second resolution, 1-minute resolution gives the same visual curve with 6x fewer data points. The query service must auto-select the appropriate storage tier based on the requested time range, or explicitly let the user choose resolution. Without this, dashboard queries scan unnecessarily large datasets.

6. **Clock skew ignored.** Agents on different hosts may have clocks that differ by seconds. Accepting timestamps without bounds allows a misconfigured agent to write data with timestamps in the far future or past, corrupting queries and alerts. The fix is a validation window (+/-30 seconds) that clamps or rejects out-of-range timestamps.

7. **No backpressure handling.** When the TSDB slows down, Kafka consumers fall behind and the backlog grows silently until data freshness SLAs are violated. Consumer lag must be monitored as a first-class metric, with automatic scaling of consumer instances or controlled shedding of low-priority metrics when lag exceeds the freshness budget.

8. **Missing metric metadata.** Without a metric catalog recording each metric's name, description, unit, and expected range, dashboards become unmaintainable once the system passes a few tens of thousands of metric names. Nobody knows whether `queue_depth_2` is in messages or bytes, or whether 5,000 is normal or an emergency. The catalog is cheap to build at ingest time and impossible to reconstruct later.

9. **Alerting without context.** A notification that says only "CPU > 90% on web-42" forces the on-call engineer to open three dashboards before understanding anything. Every alert should carry a snapshot of the recent graph, links to related metrics and the service runbook, and the alert's own history. Enrichment costs milliseconds at fire time and saves minutes at 3 AM.

10. **Row-oriented database.** PostgreSQL cannot handle 1M writes/sec, and its row-oriented storage produces 10x larger data than columnar alternatives for time-series workloads. ClickHouse's columnar storage compresses time-series data roughly 10:1 and can ingest 1M+ rows/sec per node. Candidates who propose PostgreSQL or MySQL for the TSDB show they have not considered the write throughput requirements.

---
