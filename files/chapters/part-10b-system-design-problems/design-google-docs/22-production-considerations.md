## Production Considerations

Running a collaborative editor in production requires careful attention to monitoring, security, and cost management. Unlike a typical CRUD application, a real-time editor has unique failure modes: a single slow document server can affect thousands of active editors, a permission cache miss can add noticeable latency to every keystroke, and WebSocket connection storms during outages can overwhelm the gateway layer. The sections below cover the operational aspects that separate a prototype from a production-grade system.

### Monitoring and Alerting

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| WebSocket connections | > 80% capacity per server | Scale gateway layer |
| Op apply latency P99 | > 100ms | Check doc server load |
| Op log write failures | > 0 | Investigate storage health |
| Snapshot save failures | > 1% | Check S3 connectivity |
| Document recovery time | > 10 seconds | Optimize op replay |
| Permission cache miss rate | > 30% | Increase Redis TTL |
| Active docs per server | > 2,000 (10x the ~200 average) | Rebalance hash ring |
| Client reconnection rate | > 5% | Check network stability |

### Security Considerations

1. **WebSocket authentication**: Token validated on connection upgrade, refreshed every 30 minutes
2. **Per-operation permission check**: Every edit verified against user role (editor/commenter/viewer)
3. **Content sanitization**: Prevent XSS in document content, comments, and user names
4. **Rate limiting**: Max 100 ops/sec per user per document, prevents abuse
5. **Audit trail**: Every edit, share, and export logged with user attribution
6. **Data encryption at rest**: S3 server-side encryption for document content
7. **Link sharing**: Optional password protection and expiry dates
8. **GDPR compliance**: Document deletion removes all versions, ops, and snapshots within 30 days

### Cost Optimization

| Component | Monthly Cost | Optimization |
|-----------|-------------|--------------|
| Doc servers (1000 instances) | ~$500K | Right-size based on active doc count |
| Redis (permissions + routing) | ~$20K | TTL eviction, smaller key sizes |
| S3 (document content + versions) | ~$100K | Lifecycle policy: Glacier after 90 days |
| PostgreSQL (metadata) | ~$30K | Read replicas, connection pooling |
| Kafka (operation log) | ~$50K | Retention policy: 7 days hot, archive to S3 |
| WebSocket gateways | ~$200K | Auto-scale by connection count |


---
