## Cost Analysis

### Infrastructure Cost Estimates at Scale

**Assumptions**, carried over unchanged from the capacity estimation so the money agrees with the design: 600M users, 200M DAU, 50M concurrent streams at peak, 80M tracks at 4 qualities, 5B play events/day (150B/month). Lossless adoption is modeled at 5% of plays: it is gated behind Premium, an opt-in, and an exact-transport output, so it is a minority of a minority even though every eligible listener is on a fast link.

Egress is the number to derive rather than guess, because it dominates everything else. Take 5B plays/day. A lossy play delivers about 3MB, roughly two and a half minutes at 160 kbps once skips are accounted for, while a lossless play of the same length delivers about 24MB at 1300 kbps. Blend them at 5% lossless and the average play is about 4MB. That is roughly 20PB/day, or about 610PB/month, up from 400PB before the tier existed. Sanity check it against concurrency: 610PB/month is around 1.9 Tbps sustained, and peak is 50M concurrent at a 5%-blended 217 kbps, which is about 11 Tbps. A peak-to-average ratio near 6x is what you would expect for a service with a global but daytime-weighted audience, so the two derivations agree. Notice that a 5% shift in plays moved egress by more than 50%: that is the leverage a heavy tier has, and it is why lossless is a bandwidth decision dressed as a product one.

| Component | Specification | Monthly Cost |
|-----------|--------------|-------------|
| CDN (audio delivery) | Multi-CDN (CloudFront + Akamai), ~610PB egress @ ~$0.004/GB committed | $2,440,000 |
| Origin Servers (40x) | c6i.8xlarge (32 vCPU, 64GB) | $43,200 |
| Audio Storage (S3) | 80M tracks x 4 qualities = 4.5PB | $104,000 |
| Elasticsearch Cluster (30 nodes) | r6i.4xlarge (16 vCPU, 128GB) | $51,840 |
| Recommendation Spark (100 nodes, nightly) | m6i.4xlarge, ~6h/day | $14,000 |
| Audio Model Training GPUs (8x) | p4d.24xlarge (8x A100), 3yr reserved | $78,336 |
| Kafka Cluster (20 brokers) | i3.4xlarge (16 vCPU, 122GB, 3.8TB NVMe) | $45,000 |
| PostgreSQL (users, playlists) | db.r6i.8xlarge multi-AZ + 8 replicas | $35,840 |
| Redis Cluster (vectors, sessions, cache) | cache.r6g.4xlarge (12 nodes) | $25,920 |
| Transcoding Pipeline (spot) | c6i.8xlarge (30 spot instances) | $10,800 |
| Royalty Calculation Pipeline | m6i.4xlarge (10 nodes) | $8,800 |
| Monitoring & Logging | Datadog + S3 for logs | $15,000 |
| **Total** | | **~$2,872,736/mo** |

Notice the shape of that table. CDN egress is 85% of the bill, and every other line is a rounding error against it. Lossless is what pushed the share up: the tier added $840K to the CDN line and $72K to storage, so the feature that felt like a codec choice landed almost entirely on bandwidth. That is the single most important thing the cost model tells you, and it is why the CDN rate you negotiate matters more than every instance-sizing decision on this page combined. At list price (roughly $0.085/GB) that row alone would be $52M/month, which is 120x the entire rest of the infrastructure. Bandwidth commitments are the architecture.

### Cost Optimization Strategies

Order these by the size of the line they attack, not by how clever they are. The first two are worth more than the rest put together, because they are the only ones aimed at egress.

1. **CDN Tiering**: Cheaper CDN for the catalog tail (80% of tracks, ~5% of plays), premium CDN for top tracks only. Shaving even 10% off a $2.44M line beats eliminating the entire royalty pipeline.
2. **Bandwidth Commitments**: Committed-volume contracts are the single largest lever available. This is a negotiation, not an engineering task, which is exactly why engineers overlook it.
3. **Lazy Lossless**: Do not pre-generate or pre-push the FLAC rung for the long tail. Lossless is 69% of storage but a few percent of plays, so transcoding and edge-warming it on demand keeps the heaviest tier from paying rent for a catalog nobody streams losslessly. This is the one optimization the tier created, and it attacks both the $104K storage line and the FLAC share of egress.
4. **Lazy Transcoding**: Only transcode all lossy qualities for tracks that clear a play threshold. The long tail stays at 160 kbps until demand appears, which cuts tail storage substantially. Storage is $104K/mo, so this is a rounding error against CDN, but it is nearly free to implement.
5. **Spot Instances for Transcoding**: ~70% savings on a batch workload that tolerates interruption.
6. **Recommendation Model Distillation**: Distill the training model down for serving.
7. **Regional Storage**: Replicate only popular tracks to all regions, serve long-tail from the nearest origin.
8. **Reserved Capacity**: Origin, PostgreSQL, and Redis on 3-year reserved (~60% on roughly $105K/mo, saving about $63K/mo).

### Cost Per Stream

At 150B streams/month: **$2,872,736 / 150B = $0.000019 per stream**, about 0.0019 cents.

Now put that next to the revenue. Roughly 200M premium subscribers at $10.99/month is about **$2.2B/mo**, against **$2.87M/mo** of infrastructure, so infrastructure is about 0.13% of revenue.

That ratio is the punchline of the entire chapter. Content licensing runs around 70% of revenue, roughly $1.5B/mo, which is over 500 times the infrastructure bill. Every engineering optimization in these 30 sections, every one of them, is fighting over roughly 0.1% of the cost base. This is not an argument for sloppiness, since the CDN bill is still real money and a stalling player still loses subscribers. It is an argument for knowing which numbers actually move the business: the royalty pipeline's correctness matters more than its efficiency, because it is arithmetic on the 70%, and a rounding bug there costs more than the servers do.


---
