## Cost Analysis: Ad System at Scale

Understanding infrastructure costs is essential for system design interviews at senior levels and for real-world capacity planning. Note the deliberate scale change: this breakdown costs a 10 billion impression per day platform, the scale of a large independent ad network, rather than the 1 trillion per day design point used for the capacity estimates. Only a handful of platforms on earth operate at the trillion scale, and a cost model is more useful at a scale you can sanity-check against public cloud pricing. At 10 billion per day the infrastructure lands around $235K per month, only about 0.03% of the gross revenue it generates. The largest cost drivers are the ClickHouse analytics cluster and Redis clusters, which makes sense because they handle the heaviest data volumes. The cost optimization levers at the bottom show how reserved instances and spot pricing can reduce costs by 35-60%, which is a practical consideration that interviewers appreciate hearing about.

```
Infrastructure Cost Estimate (10B impressions/day, ~116K QPS average, ~300K peak)

═══════════════════════════════════════════════════════════════
Component              Spec                    Monthly Cost
═══════════════════════════════════════════════════════════════

Ad Serving Tier
  Auction servers       60x c6g.2xlarge         $  44,000
  Load balancers        6x NLB (multi-AZ)       $   3,600

Data Tier
  Redis (budgets/freq)  20x r6g.2xlarge cluster $  28,000
  Redis (targeting idx) 10x r6g.4xlarge         $  28,000
  PostgreSQL (campaigns) 2x r6g.4xlarge (RDS)   $   7,200
  ClickHouse (analytics) 15x i3.4xlarge         $  55,000

Streaming
  Kafka (events)        12x m6g.2xlarge         $  17,000
  Flink (fraud/agg)     8x c6g.4xlarge          $  19,000

CDN & Creative Storage
  CloudFront            ~200TB egress/month      $  16,000
  S3 (creatives)        50TB                     $   1,150

Fraud Detection
  ML inference (Sagemaker) 6x ml.c5.4xlarge     $  12,000

Monitoring & Logging
  Prometheus/Grafana    4x m6g.xlarge            $   2,400
  Log aggregation (S3)  100TB compressed/month   $   2,300

───────────────────────────────────────────────────────────────
TOTAL                                            ~$235,650/mo
                                                 ~$2.83M/year
───────────────────────────────────────────────────────────────

Revenue Context:
  - 10B impressions/day x $2.50 avg CPM = $25M/day revenue
  - Infrastructure = 0.03% of gross revenue
  - Industry benchmark: 1-3% infra-to-revenue ratio

Cost Optimization Levers:
  - Reserved instances (1yr): save 35-40% -> ~$153K/mo
  - Spot instances for Flink workers: save 60% on batch
  - ClickHouse compression: 10:1 ratio reduces storage costs
  - DSP response caching: reduce 15% of outbound bid calls
  - Regional serving: colocate with major ad exchanges
```
