## Production Considerations

Running a Twitter-scale system in production requires constant visibility into system health and a strong security posture. The sections below cover what to monitor, what thresholds to set alerts on, and the security measures that protect both the platform and its users.

### Monitoring and Alerting

Every critical path in the system should have latency and error rate metrics with well-defined alert thresholds. When an alert fires, the on-call engineer needs to know exactly which component to investigate. The table below maps each metric to its threshold and the most likely root cause.

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| Tweet write latency P99 | > 200ms | Check MySQL shard health |
| Timeline read latency P99 | > 50ms | Check Redis cluster health |
| Fan-out lag | > 30 seconds | Scale Kafka consumers |
| Elasticsearch indexing lag | > 5 minutes | Check ES cluster health |
| Trending computation time | > 10 seconds | Optimize Redis aggregation |
| Snowflake ID generation latency | > 1ms | Check clock sync (NTP) |
| Snowflake clock-backwards rejections | any | NTP stepped the clock, drain the node |
| Search P99 latency | > 200ms | Check ES hot index size |
| Celebrity cache miss rate | > 20% | Increase TTL or pre-warm |
| Fan-out batch size | > 100K followers in one tweet | Celebrity check is not firing |

### Security Considerations

Security at Twitter's scale is not optional, a single vulnerability can expose hundreds of millions of users' data. The checklist below covers the most critical security controls, from input sanitization to encryption and bot detection. In an interview, mentioning even two or three of these demonstrates that you think about security as a first-class concern, not an afterthought.

1. **Tweet text sanitization**: Strip HTML, prevent XSS in display
2. **Rate limiting**: Per-user and per-IP limits on all endpoints
3. **API authentication**: OAuth 2.0 with JWT tokens, rotate secrets regularly
4. **DM encryption**: Messages encrypted at rest, optional E2E encryption
5. **Account security**: 2FA via SMS/TOTP, suspicious login alerts
6. **Content moderation**: Automated toxicity detection + human review pipeline
7. **Bot detection**: Behavioral ML classifier. CAPTCHA for suspicious accounts
8. **Data privacy**: GDPR compliance, account deletion removes all data within 30 days


---
