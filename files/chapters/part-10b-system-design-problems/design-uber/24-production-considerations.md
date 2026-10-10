## Production Considerations

Running a ride-sharing platform in production requires much more than just correct code, you need thorough monitoring to detect problems before users notice them, security controls to protect financial and personal data, and cost awareness to keep infrastructure expenses proportional to revenue. This section covers the operational aspects that separate a working prototype from a production-grade system.

### Monitoring and Alerting

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| Driver location write latency | > 10ms | Check Redis cluster health |
| Match success rate | < 85% | Check driver supply or scoring weights |
| Trip completion rate | < 90% | Investigate cancellation patterns |
| Payment success rate | < 98% | Check Stripe integration |
| Surge accuracy | > 20% error | Recalibrate demand prediction |
| ETA accuracy | > 3 minutes error | Retrain traffic model |
| Driver app crash rate | > 1% | Check app release quality |
| Fraud detection false positive rate | > 5% | Retrain ML model |

### Security Considerations

1. **Payment security**: PCI-DSS compliant, never store raw card numbers
2. **Driver verification**: Background check, license verification, vehicle inspection
3. **Rider safety**: Panic button, live location sharing, automatic incident detection
4. **GPS validation**: Detect spoofed GPS from jailbroken/rooted devices
5. **API authentication**: JWT tokens with short expiry, refresh token rotation
6. **Data privacy**: GDPR/CCPA compliance, rider location data anonymized after 30 days
7. **Rate limiting**: Max 10 ride requests/hour per rider, prevents abuse
8. **Encryption**: All data encrypted in transit (TLS 1.3) and at rest (AES-256)

### Cost Optimization

These are order-of-magnitude figures for reasoning about proportions, not quotes. The proportions are the lesson.

| Component | Monthly Cost | Optimization |
|-----------|-------------|--------------|
| Redis Cluster (location) | ~$300K | Regional partitioning reduces per-cluster size |
| WebSocket gateways (200) | ~$400K | Auto-scale by connection count |
| PostgreSQL (trips) | ~$100K | Archive completed trips after 90 days |
| Maps API (ETA, routing) | ~$2M | Self-host OSRM, cache traffic matrices |
| Kafka (events) | ~$100K | Retention policy: 7 days hot, archive to S3 |
| Push notifications | ~$50K | Batch driver updates, silent pushes for non-urgent |
| **Card processing (list price 2.9% + $0.30)** | **~$220M** | Negotiate interchange-plus, cut per-transaction count |

That last row is not a typo, and it is the most important number on the page. Work it out rather than trusting it:

```
Trips/month:     10M/day x 30            = 300M
Fixed component: 300M x $0.30            = $90M/month
Variable:        300M x $15 avg x 2.9%   = $130M/month
Total:                                   ≈ $220M/month  (~$2.6B/year)
```

Payment processing costs roughly seventy times the entire Redis, PostgreSQL, Kafka, and gateway bill combined. Every engineering instinct on this page points at infrastructure, and infrastructure is a rounding error next to the card fees. Note also that the $90M fixed component depends only on the *number* of transactions, not their size, which is why it dominates on low-value trips and why batching a driver's weekly payout into one transfer instead of 60 matters more than any query you could tune.

The check that catches an error like this costs ten seconds: the per-transaction fee alone is $90M/month, so any total below that is arithmetically impossible regardless of the fare. Order-of-magnitude sanity checks are worth running on every number you put in a design doc, because a cost model that is wrong by 7x sends the team to optimize the wrong system for a year.

At this volume nobody pays list price. Interchange-plus pricing around 1.8% + $0.10 brings the bill to roughly $111M/month, so the negotiation is worth about $110M/month, which is more than the rest of the infrastructure budget by two orders of magnitude. That is a commercial lever, not a technical one, and recognizing when the biggest win on the table is a contract rather than a rewrite is a senior instinct worth having.


---
