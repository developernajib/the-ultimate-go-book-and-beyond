## Cost Analysis: Metrics and Analytics System at Scale

Understanding infrastructure costs is a critical part of system design: the choices you make about retention periods, sampling rates, and storage tiers have direct dollar consequences that interviewers often probe. The table below estimates monthly AWS costs at 1M metrics/second ingest with 10 million unique time series, 7 days of raw retention, and a year of 1-minute rollups. The dominant cost driver is the ClickHouse storage tier, and tiered retention cuts storage costs by roughly 80% compared to retaining everything at full resolution for the year. Total system cost lands around $105K/month, or roughly $0.04 per million metric points ingested.

```
Infrastructure Cost Estimate (1M metrics/sec, 10M unique series, 7-day raw + 1-year rollups)

═══════════════════════════════════════════════════════════════
Component                Spec                    Monthly Cost
═══════════════════════════════════════════════════════════════

Ingestion Tier
  Kafka brokers          12x m6g.2xlarge          $  17,000
  Kafka storage          50TB gp3 EBS             $   4,000
  Flink aggregation      8x c6g.4xlarge           $  19,000
  Ingestion API servers  20x c6g.xlarge           $   7,200

Storage Tier (ClickHouse)
  Hot (raw, 7 days)      8x i3.4xlarge            $  29,000
  Warm (1min agg, 30d)   6x i3.2xlarge            $  16,000
  Cold (1min agg, 1yr)   S3 via CH S3 disk, 70TB  $   1,610
  ZooKeeper (CH coord)   3x m6g.large             $     900

Metadata & Config
  PostgreSQL (RDS)       1x r6g.xlarge Multi-AZ   $   1,800
  Redis (query cache)    3x r6g.xlarge cluster     $   4,200

Alert Engine
  Alert evaluators       4x c6g.xlarge            $   1,440
  Notification service   2x t3.medium             $     150

Agent Infrastructure
  Agent binary hosting   S3 + CloudFront          $     200
  Agent config service   2x t3.medium             $     150

Monitoring (self-monitoring)
  Prometheus + Grafana   3x m6g.xlarge            $   1,800
  Log aggregation        S3 (20TB compressed/mo)  $     460

───────────────────────────────────────────────────────────────
TOTAL                                             ~$104,900/mo
                                                  ~$1.26M/year
───────────────────────────────────────────────────────────────

Scaling Characteristics:
  - Ingestion scales linearly: +1 Kafka broker per 100K pts/sec
  - ClickHouse scales horizontally: add shards for write throughput
  - Query scales independently: add read replicas for dashboard load
  - Storage grows predictably: ~1TB/day raw compressed (2TB with 2x
    replication), ~200GB/day of 1-minute rollups

Cost Optimization Levers:
  - Reserved instances (1yr): save 35-40% -> ~$65K/mo
  - Agent pre-aggregation: reduces ingestion volume 5-10x
  - Aggressive downsampling: 10s -> 1min after 24h saves 6x storage
  - ClickHouse compression: LZ4 provides 8-12:1 ratio on metrics data
  - Cold tier on S3 (ClickHouse S3 engine): $0.023/GB vs $0.10/GB EBS
  - Query result caching: 60% cache hit rate reduces CH query load

Cost Per Metric Point (2.6 trillion points ingested per month):
  - Raw ingestion + 7d hot storage: ~$0.03 per million points
  - Full system with 1-year rollup retention: ~$0.04 per million points
  - SaaS benchmark: ~$0.01-0.05 per metric series per month at list
    pricing, which is $100K-500K/mo for 10M series
  - Self-hosted advantage: roughly 5x cheaper than SaaS list pricing
    at this scale, before negotiated discounts
```
