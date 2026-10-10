## Production Considerations

### Monitoring and Alerting

Key metrics to track for a video streaming platform:

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| CDN cache hit rate | < 90% | Check popular video cache warm-up |
| Transcoding queue depth | > 500 jobs | Scale up workers |
| Transcoding failure rate | > 5% | Check FFmpeg config / input validation |
| Upload success rate | < 95% | Check S3 presign or network issues |
| Stream start latency P99 | > 3 seconds | Check CDN or manifest generation |
| Recommendation latency P99 | > 200ms | Check Redis cache hit rate |
| View count lag | > 5 minutes | Check Kafka consumer lag |
| API error rate | > 1% | Check downstream service health |

### Cost Optimization

Do the egress arithmetic before anything else, because at this scale it is not one line item among several, it is the entire business. 208 Tbps sustained is 26 TB every second, which is 68 exabytes per month. Priced against a commercial CDN, that number is brutal:

```
208 Tbps ÷ 8 = 26 TB/s × 2.63M s/month = 68 EB/month = 68 billion GB

at $0.085/GB (CloudFront list, low tiers):  $5.8B / month
at $0.020/GB (high-volume published tier):  $1.4B / month
at $0.005/GB (aggressively negotiated):     $342M / month
```

Compare that to storing everything. A 10-year archive at 8.6PB/day is about 31 EB, which costs roughly $722M/month in S3 Standard, or about $31M/month in Glacier Deep Archive, or about $66M/month with 5% kept hot and the rest cold. Egress at a negotiated rate still beats total storage cost, and egress recurs against every view forever while a byte is only stored once.

This is the whole reason the economics of streaming push every large player off commercial CDNs and onto hardware they own. Netflix's publicly documented answer is Open Connect: Netflix builds its own appliances and gives them to ISPs to install inside their networks, at no charge to the ISP. The content is pushed to those appliances during off-peak hours, so the ISP's subscribers stream from a box in the ISP's own data center. Netflix does not pay transit for that traffic and the ISP does not pay to carry it upstream, which is what makes the giveaway rational for both sides. Google runs its own global backbone and edge for YouTube on the same logic. Neither company could exist paying per-gigabyte retail.

| Component | Monthly Cost Estimate | Optimization |
|-----------|----------------------|--------------|
| CDN egress (68 EB) | $342M at $0.005/GB, billions at list | Own the edge. This dominates every other line combined. |
| S3 storage (~31 EB archive) | ~$66M tiered, ~$722M all-Standard | Cold-tier aggressively, drop rungs nobody requests |
| Transcoding (15K workers) | ~$2M | Spot instances (roughly 70% off on-demand) |
| Elasticsearch (50 nodes) | ~$200K | Hot/cold index strategy |
| Redis (1TB recommendations) | ~$100K | TTL eviction for inactive users |
| MySQL (metadata) | ~$50K | Read replicas, connection pooling |

The ordering of that table is the point. An interviewer who watches you optimize the $50K MySQL line while the $342M egress line sits untouched has learned something about you. Attack the top row.

### Security Considerations

1. **Presigned URL expiry**: Upload URLs expire in 4 hours, playback authorization in 4 hours
2. **Content validation**: Verify file type (magic bytes, not extension) before processing. Never pass a client-supplied filename or content type to FFmpeg
3. **DDoS protection**: Rate limit uploads per user (10/hour), API requests (1000/min)
4. **CDN authorization**: Signed cookies scoped to the `videos/{video_id}/` prefix, validated at the edge on every segment request. Signing only the master playlist protects nothing, since relative URI resolution drops the query string before the player ever requests a segment
5. **SQL injection**: All DB queries use parameterized statements
6. **XSS prevention**: User-generated content (titles, descriptions) sanitized on display
7. **CSRF tokens**: All state-changing operations require CSRF token
8. **Audit logging**: All admin actions (content removal, user bans) logged with attribution

### Deployment Strategy

A video platform cannot afford hard cutover deployments: a bad API build that drops 1% of stream-start requests translates to millions of buffering events within minutes. Blue-green deployment addresses this by keeping the previous version fully warm so a rollback is a DNS or load-balancer flip taking under 30 seconds, with zero re-deployment. The canary ramp (1% → 10% → 50% → 100%) lets error-rate and P99-latency dashboards catch regressions before they affect the majority of viewers.

```
Blue-Green Deployment for API servers:
1. Deploy new version to "green" environment
2. Run automated tests against green
3. Shift 1% of traffic (canary)
4. Monitor error rates for 30 minutes
5. Gradually shift: 1% -> 10% -> 50% -> 100%
6. Keep blue environment warm for 1 hour (instant rollback)

Transcoding workers: rolling update (drain queue, update, restart)
CDN: configuration update propagates in <60 seconds globally
Database: schema changes via online DDL (pt-online-schema-change)
```


---
