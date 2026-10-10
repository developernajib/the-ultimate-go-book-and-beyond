## Monitoring and Observability

You cannot operate a system at this scale without thorough monitoring. Each dashboard below tracks a different concern: upload pipeline health ensures content flows through processing, feed performance catches latency regressions, engagement metrics track product health, and infrastructure dashboards monitor the underlying systems. The alerting thresholds are calibrated to catch real problems (like a stalled moderation pipeline) without generating noise from normal fluctuations.

```
Key Dashboards:

1. Upload Pipeline:
   - Uploads/sec by media type
   - Processing success rate
   - Avg processing time (photo vs video)
   - Content moderation pass rate
   - Processing queue depth (SQS)

2. Feed Performance:
   - Feed load latency P50/P95/P99
   - Cache hit rate for feed reads
   - Fan-out write latency (per follower count bucket)
   - Feed freshness (time from post to visible)
   - Celebrity pull latency

3. Engagement:
   - Likes/comments/shares per minute
   - DAU/MAU ratio
   - Average session duration
   - Posts per user per day
   - Story view rate

4. Infrastructure:
   - Cassandra read/write latency
   - Redis cluster memory and ops/sec
   - S3 upload/download latency
   - CDN cache hit rate for media
   - FFmpeg worker utilization

Alerting:
  Critical: feed latency P99 >2s, upload failure >5%, moderation pipeline stalled
  Warning: fan-out lag >10s, CDN miss rate >20%, storage growth anomaly
```


---
