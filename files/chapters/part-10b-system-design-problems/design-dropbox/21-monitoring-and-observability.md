## Monitoring and Observability

A production Dropbox deployment requires thorough monitoring across four dimensions: sync performance (how fast changes propagate), storage health (deduplication effectiveness and block throughput), infrastructure metrics (database and cache performance), and business metrics (user engagement and platform distribution). The alerting thresholds below are calibrated to catch problems before they affect users, for example, a sync latency P99 above 30 seconds means some users are experiencing noticeably delayed sync, while an S3 error rate above 0.1% could indicate a regional outage.

```
Key Dashboards:

1. Sync Performance:
   - Active sync connections (by device type)
   - Sync latency P50/P95/P99 (time from change to all devices synced)
   - Long-poll connection count
   - Changes/sec processed
   - Conflict rate (should be <0.1% of syncs)

2. Storage:
   - Total storage used (logical vs physical)
   - Deduplication ratio over time
   - Block upload rate (blocks/sec)
   - Pre-signed URL generation rate
   - S3 upload/download latency

3. Infrastructure:
   - PostgreSQL query latency (per shard)
   - Redis Pub/Sub message rate
   - S3 request rate and errors
   - API server CPU/memory
   - CDN cache hit rate for blocks

4. Business:
   - DAU/MAU by platform (Windows, Mac, Linux, iOS, Android, Web)
   - Storage quota utilization distribution
   - Shared folder collaboration metrics
   - File type distribution
   - Average sync time for new device setup

Alerting:
  Critical: sync latency P99 >30s, S3 error rate >0.1%, DB replication lag >1min
  Warning: conflict rate >0.5%, storage growth >5%/week, GC not running
```

---
