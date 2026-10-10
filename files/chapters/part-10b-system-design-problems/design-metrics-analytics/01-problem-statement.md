## Problem Statement

A metrics and analytics platform must serve two very different access patterns simultaneously: high-throughput ingestion (millions of writes per second from thousands of agents) and low-latency querying (interactive dashboard queries returning in under 5 seconds). These access patterns conflict because write-optimized storage structures make reads slower, and read-optimized indexes slow down writes. The design must find the right balance, which is why the architecture uses streaming pre-aggregation to reduce write volume before it hits the query-optimized time-series database.

Design a metrics and analytics platform (like Datadog/InfluxDB + Google Analytics):
- Ingest 1 million metrics/second from 100,000 hosts
- Store time-series data efficiently (1-year retention)
- Query: "avg CPU usage for service X in last 15 minutes"
- Support aggregations: sum, avg, min, max, percentiles (P50/P95/P99)
- Dashboards with < 5 second query response
- Alerting: notify when metric crosses threshold
- Support both infrastructure metrics and application events
- Retention policy: 1-min resolution → 1 year, 10-sec resolution → 1 week

The retention policy is a critical design driver. Keeping 10-second resolution data for a full year would require roughly 365TB of storage even after compression, clearly impractical. The two-tier approach (high-resolution for recent data, downsampled for historical) reduces this to roughly 80TB: about 7TB of full-resolution data for the most recent week plus about 70TB of 1-minute rollups for the year, while preserving the ability to drill into fine-grained data during active incident investigation.

---
