## Cost Analysis

### Infrastructure Cost Estimates at Scale

**Assumptions**: 10,000 symbols and 1M orders/sec peak, matching the capacity estimate. Peak is not the average: sizing runs on peak because the exchange must not reject orders during a volatility spike, while cost per trade runs on the average, roughly 100K orders/sec across the 6.5-hour session. Also 50,000 concurrent WebSocket connections and a 99.99% uptime SLA.

| Component | Specification | Monthly Cost |
|-----------|--------------|-------------|
| Matching Engine Nodes (10x) | c6i.8xlarge (32 vCPU, 64GB RAM, NVMe) | $10,800 |
| Hot Standby Nodes (10x) | c6i.8xlarge (identical to primary) | $10,800 |
| Order Gateway (4x) | c6i.4xlarge (16 vCPU, 32GB RAM) | $2,160 |
| Market Data Publishers (6x) | c6i.4xlarge with enhanced networking | $3,240 |
| Kafka Cluster (5 brokers) | i3.2xlarge (8 vCPU, 61GB, 1.9TB NVMe) | $4,500 |
| PostgreSQL (primary + replica) | db.r6i.4xlarge (16 vCPU, 128GB) | $5,600 |
| Redis Cluster (6 nodes) | cache.r6g.xlarge (4 vCPU, 26GB) | $2,400 |
| Surveillance Flink Cluster | m6i.4xlarge (4 nodes) | $3,520 |
| Monitoring (Prometheus/Grafana) | m6i.2xlarge (2 nodes) | $1,120 |
| Network (cross-AZ, NAT, ELB) | Data transfer + load balancers | $3,000 |
| Storage (WAL, snapshots, logs) | 10TB gp3 + 50TB S3 | $1,500 |
| **Total** | | **~$48,640/mo** |

### Cost Optimization Strategies

1. **Reserved Instances**: The always-on compute (matching, standby, gateway, market data, Kafka, Flink, monitoring) is about $36K/mo of the bill. At roughly 60% off for a 3-year reservation, that is about $22K/mo saved.
2. **Spot for Surveillance**: Non-critical surveillance backtesting can use spot instances (70% savings).
3. **Tiered Storage**: Move trade audit data older than 90 days to S3 Glacier ($0.004/GB vs $0.08/GB).
4. **Right-Sizing**: Monitor CPU utilization, matching engines are memory/latency bound, not CPU bound.
5. **Co-location**: For ultra-low latency, co-locate in exchange data centers (Equinix NY4/NY5). Higher fixed cost ($15K-50K/mo rack), and note what it does buy: colocation removes network flight time between the participant and the engine, it does not make matching itself faster. Matching latency is set by the code and the WAL, and it stays what it was.

### Cost Per Trade

Watch the units here, because orders and trades are not interchangeable and the 20% fill rate is the bridge between them. Averaging 100K orders/sec across a 6.5-hour session gives 2.34B orders/day. At the 20% fill rate from the capacity estimate that is roughly 470M trades/day, or about 9.8B trades across 21 trading days.

**$48,640 / 9.8B = $0.000005 per trade** (about 0.0005 cents).

Revenue at $0.003/trade: **~$29M/mo revenue** vs **~$49K/mo infrastructure cost**.

Treat that ratio as a description of where exchange economics actually live rather than as free money. Infrastructure is close to a rounding error for an exchange, and the real costs are regulatory compliance, market surveillance staff, SEC reporting, clearing house membership, colocation contracts, and the engineers who keep a system running where a bad deploy is a market-wide incident. The interesting cost of an exchange has never been the servers.


---
