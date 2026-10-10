## Cost Analysis

### Infrastructure Cost Estimates at Scale

**Assumptions**: a reference slice at **300K peak concurrent participants**, one tenth of the 3M design peak from the capacity section, deployed across 5 regions. At 30 participants per meeting that is 10K concurrent meetings at peak, and with a peak-to-average ratio of 3 it averages 100K concurrent participants. Multiply through by ten for the full design load. One-to-one calls are excluded throughout: they run peer-to-peer and never touch an SFU.

| Component | Specification | Monthly Cost |
|-----------|--------------|-------------|
| SFU Nodes (100 total, 20x per region) | c5n.18xlarge (72 vCPU, 192GB, 100Gbps), 3,000 participants each | $283,800 |
| TURN Relay Nodes (10x per region) | c5n.4xlarge (16 vCPU, 42GB, 25Gbps) | $31,500 |
| Signaling Servers (8x per region) | c6i.4xlarge (16 vCPU, 32GB) | $19,900 |
| Recording Pipeline (20x) | m6i.4xlarge + GPU for mixing | $28,800 |
| Redis Cluster (per region) | cache.r6g.2xlarge (6 nodes) | $13,000 |
| PostgreSQL (multi-region) | db.r6i.4xlarge (primary + 4 replicas) | $14,400 |
| Object Storage (recordings) | S3, 112TB/month new, ~338TB steady state at 90-day retention | $7,800 |
| CDN (static assets + recordings) | CloudFront (200TB egress) | $17,000 |
| **Media bandwidth** | **600 Gbps peak / 200 Gbps average = 64.8 PB/month**, on owned PoPs with peering and transit at ~$0.50/Mbps | **$300,000** |
| Monitoring (Prometheus/Grafana) | m6i.2xlarge (10 nodes across regions) | $5,600 |
| Load Balancers (per region) | NLB for UDP, ALB for HTTPS | $4,500 |
| **Total** | | **~$726,000/mo** |

### Why the Bandwidth Line Decides the Business

Compute that media line before anything else, because it is the one that ends arguments. Each of 300K peak participants receives about 2 Mbps, so the fleet pushes **600 Gbps at peak and ~200 Gbps on average**, which over a month is `200 Gbps x 2.592M s / 8 = 64.8 PB`. Not 1 PB. Getting this wrong by two orders of magnitude, which is easy to do by reasoning about "cross-region transfer" instead of the actual egress to users, produces a cost model that is confidently off by more than its own total.

Now price it two ways, and notice the gap:

- **Public cloud egress**: 64.8 PB at even a discounted $0.05/GB is **~$3.24M/month**, roughly 4.5x the entire rest of this table combined.
- **Owned PoPs with peering and transit**: 95th-percentile billing on 600 Gbps at ~$0.50/Mbps is **~$300K/month**, an order of magnitude cheaper.

That ratio is the whole reason large conferencing providers run their own points of presence and peer directly with eyeball networks instead of relaying media out of a public cloud, and it is why Zoom kept its own data centers for media while using cloud capacity for burst. In a system where bandwidth is the product, egress pricing is not a line item, it is the architecture.

### Cost Optimization Strategies

Ordered by what they actually save, which means the bandwidth ones come first:

1. **Simulcast Layer Control**: Stop sending 720p to a face rendered 180px wide. In gallery view the SFU forwards low layers to everyone but the active speaker, cutting egress by ~40%. Against a $300K bandwidth line that is ~$120K/mo, the single largest saving available.
2. **Peer-to-Peer for Small Meetings**: 1:1 calls connect directly with STUN and never reach an SFU, so they consume no server bandwidth and no SFU capacity at all. They are the majority of calls by count and are already excluded from the numbers above, which is why the SFU fleet is sized for 300K participants rather than for every session on the platform.
3. **Reserved Capacity**: SFU nodes on 1-year reserved terms, ~40% off $283.8K = **~$114K/mo saved**. The fleet's baseline is predictable, so paying on-demand rates for it is simply a discount left unclaimed.
4. **TURN Optimization**: Better ICE negotiation moves sessions off the relay. Every relayed session costs double bandwidth, so pushing TURN usage from 20% toward 10% takes real money off the largest line.
5. **Regional Spot Instances**: Recording mixers are interruptible batch work, ideal for spot (~70% off $28.8K = **~$20K/mo saved**).
6. **Recording Tiering**: Recordings are written once and almost never read. Move them to S3 Infrequent Access after 30 days ($0.0125/GB vs $0.023/GB).

### Cost Per Meeting Minute

At 10K peak concurrent meetings, average concurrency is ~3,300 meetings, which is `3,300 x 43,800 min = ~146M meeting-minutes/month`:

**$726,000 / 146M = ~$0.005 per meeting-minute**, or **~$0.00017 per participant-minute** across 4.38B participant-minutes.

Sanity-check that against a seat rather than against an invented per-minute rate. A heavy enterprise user in 20 hours of meetings a month consumes `1,200 x $0.00017 = ~$0.20` of infrastructure. Against a seat price in the tens of dollars, infrastructure is a low single-digit percentage of revenue, which is exactly the shape of the real business: the gross margin of a conferencing company is set by sales, support, and R&D, not by the SFU fleet. The infrastructure risk is not the average, it is the tail, since one 1,000-person webinar costs as much bandwidth as 30 ordinary meetings and pays for one host.
