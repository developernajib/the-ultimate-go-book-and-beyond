## Cost Analysis

Understanding infrastructure costs helps you make informed trade-offs during system design and demonstrates business awareness in an interview. This section breaks down the real costs of running a payment platform at scale, shows where the money goes, and explains optimization strategies that can save millions annually.

### Infrastructure Cost Estimates at Scale

**Assumptions**: 100M transactions/day (3B/month, 1,160/sec average, 5K/sec peak), $50 average transaction value, 99.999% uptime SLA, PCI DSS Level 1 compliance. These are the same numbers as the capacity estimation, and they should be: a cost model built on a different volume than the design it prices is not a cost model, it is a coincidence.

| Component | Specification | Monthly Cost |
|-----------|--------------|-------------|
| Payment API Servers (20x) | c6i.4xlarge (16 vCPU, 32GB) behind NLB, 250 TPS each | $10,800 |
| PostgreSQL Primary (2x) | db.r6i.8xlarge (32 vCPU, 256GB) multi-AZ | $17,920 |
| PostgreSQL Read Replicas (4x) | db.r6i.4xlarge (16 vCPU, 128GB) | $11,200 |
| Redis Cluster (idempotency) | cache.r6g.4xlarge (6 nodes, ~60GB working set) | $12,960 |
| Kafka Cluster (events) | i3.4xlarge (5 brokers, 2x 1.9TB NVMe) | $11,250 |
| Fraud Detection Service (6x) | ml.m5.4xlarge with ML model inference | $8,640 |
| Ledger Service (4x) | c6i.4xlarge dedicated for ledger writes | $2,160 |
| Settlement Pipeline | m6i.2xlarge (4 workers) | $2,240 |
| Webhook Delivery (8x) | c6i.2xlarge for outbound HTTP delivery | $2,160 |
| HSM (Hardware Security Module) | CloudHSM cluster (2 nodes) | $3,200 |
| WAF + DDoS Protection | AWS Shield Advanced + WAF | $6,000 |
| Monitoring & Logging | Datadog/Prometheus + S3 for logs | $5,000 |
| PCI Compliance (audit, scanning) | Quarterly scans, annual audit | $4,200 |
| **Total** | | **~$97,730/mo** |

### Cost Optimization Strategies

While the raw infrastructure cost is small relative to payment revenue, optimizing it still matters as you scale because savings compound. The strategies below are ordered by impact, and notice that the ordering is not by infrastructure spend: processor routing dwarfs every server-level saving combined, because it operates on payment volume rather than on compute.

1. **Reserved Instances**: Database and API servers on 3-year reserved (60% savings on ~$40K = ~$24K/mo saved).
2. **Tiered Storage**: Archive transaction logs older than 90 days to S3 Glacier (PCI DSS requires a year of audit history, but cold storage saves roughly 80% on it).
3. **Processor Routing**: Route to the cheapest processor per card type and region while maintaining reliability. Shaving 0.05% off the effective rate on $150B of monthly volume is ~$75M/month, which is three orders of magnitude larger than the entire infrastructure bill. This is the number to bring up in an interview.
4. **Batch Settlement**: Batch settlement processing during off-peak hours to reduce compute costs.
5. **Fraud Model Optimization**: Use the rule engine for clear-cut cases and the ML model for the rest, which trims inference cost but, as noted in the design decisions, is not where the savings are: hard rules reject a small fraction of traffic, so the ML layer still runs on nearly every payment.

### Cost Per Transaction

At 100M transactions/day (3B/month): **$97,730 / 3B = $0.0000326 per transaction**, about a thirtieth of a cent.

Revenue at 2.9% + $0.30 per transaction: an average $50 transaction yields **$1.75 revenue** against **$0.0000326 cost**, so infrastructure is roughly **0.002% of revenue**.

That ratio is the real lesson of this section, and it should reframe every trade-off in the chapter. Infrastructure is rounding error here. A single percentage point of decline rate on $150B of monthly volume costs more than the entire server estate for a decade, and one duplicate charge costs more than it saves to shave a replica. This is why a payment system is designed the way it is: every fail-closed choice, every extra database round trip to make an invariant hold, every synchronous ledger write, buys correctness at a price that does not register against the money moving through the system. Optimizing a payment platform for infrastructure cost is optimizing the wrong variable.


---
