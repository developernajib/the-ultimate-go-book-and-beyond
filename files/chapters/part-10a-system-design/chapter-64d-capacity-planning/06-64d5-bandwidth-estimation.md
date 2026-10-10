## 64D.5 Bandwidth Estimation

### Ingress vs. Egress

Ingress is data flowing into your system (user uploads, API requests). Egress is data flowing out (responses, downloads, media delivery). For most consumer applications, egress >> ingress because each write is read many times.

```
Read:Write ratio implications for bandwidth:
- Social media feed: 1 write → 1,000 reads → 1,000x egress
- Email: 1 write → 1-5 reads → 5x egress
- Video upload: 1 write → 1,000,000 views → 1,000,000x egress (for viral content)
```

### CDN Bandwidth vs. Origin Bandwidth

For static assets and media, a CDN absorbs most egress. The key parameter is cache hit rate:

```
Origin bandwidth = Total egress × (1 - cache hit rate)

Example: YouTube
Total egress: 50 Tbps (from our earlier calculation)
CDN cache hit rate: 90% (popular videos are cached, long-tail isn't)
Origin bandwidth: 50 Tbps × 10% = 5 Tbps

This is still enormous. Google's own network (AS15169) is the CDN.
```

### Worked Example: URL Shortener Bandwidth

**Given**: 500M shortened URLs created per day, 100B clicks per day.

```
Ingress (URL creation):
- Each URL creation request: ~200 bytes (the original URL)
= 500M × 200 B / 86,400 s = ~1.2 MB/s ingress

Egress (redirects):
- Each redirect response: HTTP 301 with Location header
- Redirect response: ~500 bytes
= 100B clicks/day × 500 B / 86,400 s = ~580 MB/s egress

For popular URLs (trending on Twitter), single URLs get
millions of clicks in minutes - peak egress can spike 100x average.
Peak egress: 580 MB/s × 100 = 58 GB/s during viral events.

This is handled by:
1. CDN caching the 301 redirect (cache-control: public, max-age=3600)
2. Serving redirect from edge, not origin
3. Rate limiting per URL to prevent DoS via URL bombing
```

### Junior → FAANG: Bandwidth Estimation as an Architecture Justifier

Bandwidth estimation is the step most junior candidates skip or underestimate. It is also the step that most directly justifies CDN, caching, and geographic distribution decisions. If you can quantify egress bandwidth and explain why a CDN is economically necessary, you demonstrate system-level thinking that interviewers reward.

**The egress-dominates-ingress intuition.** For any consumer content platform, egress is orders of magnitude larger than ingress because each piece of content is read many more times than it is written. A video uploaded once and viewed 1 million times creates 1 million times more egress than ingress. This asymmetry is why CDN investment is justified: the cost of CDN egress is lower than the cost of serving all reads from origin, and the latency is dramatically better. Stating this ratio explicitly in an interview (and calculating the origin vs CDN egress split) demonstrates that you understand why CDNs exist, not just that they exist.

**Cache hit rate as the lever between CDN and origin bandwidth.** The URL shortener example's 580 MB/s of egress is about 4.6 Gbps. A 95% CDN cache hit rate serves only the remaining 5% from origin, reducing origin bandwidth to about 0.23 Gbps (29 MB/s). That 20x reduction is what makes origin servers affordable. In an interview, always state the cache hit rate assumption and derive origin bandwidth from it. Candidates who talk about CDNs without stating a cache hit rate are describing CDN as magic rather than as an engineering system with measurable parameters.

**Ingress spikes and rate limiting.** The URL shortener viral event scenario (580 MB/s average becomes 58 GB/s during a viral event) illustrates a class of ingress problem that is easy to overlook: a single popular URL can concentrate traffic on a small number of resources. Rate limiting per URL, at the CDN edge, is the correct defense. In an interview, when you calculate peak bandwidth and find a spike that is 100x average, the interviewer expects you to identify the mitigation (CDN caching with aggressive TTL, rate limiting, request coalescing).

**First-job habit:** In your team's monitoring dashboards, find the ingress and egress metrics for each service tier. Calculate the read-write bandwidth ratio. If egress is not significantly larger than ingress for a content service, either the service is not content-serving, or the caching layer is not working effectively. Knowing this ratio for your own services makes you a more effective capacity planner.

**Interview entry point:** "Design a CDN for static asset delivery." The expected answer includes: estimate the read-to-write ratio (100:1 or higher for static assets), calculate total egress at peak RPS times average asset size, apply a cache hit rate (90-99% for static assets), derive origin bandwidth as egress times (1 minus cache hit rate), and explain that geographic distribution of CDN PoPs reduces both latency (by serving from the nearest edge) and origin bandwidth (by increasing cache hit rate across geographically concentrated user populations).

### Senior @ FAANG: Bandwidth as a Cost and Architecture Decision Driver

At senior level, bandwidth estimation drives infrastructure cost decisions, CDN contract negotiations, network topology design, and the choice between synchronous and asynchronous data transfer patterns.

**ADR: CDN vendor selection based on bandwidth cost at scale.** CDN pricing varies significantly between vendors and at different volume tiers. At 50 Tbps of egress (YouTube scale), the difference between a CDN that charges $0.008 per GB and one that charges $0.006 per GB is $36 million per year. A staff engineer selecting a CDN vendor for a high-egress service must produce a bandwidth estimate by tier and geography, model the cost at each vendor's pricing, and include egress cost in the ADR alongside performance characteristics. At FAANG scale, CDN costs are often one of the top three infrastructure cost lines.

**Origin shield architecture to reduce origin bandwidth.** For services with high egress but heterogeneous content (where CDN cache hit rates are 70-85% rather than 95%+), origin shield is a critical cost reduction technique. An origin shield adds a second caching layer between the CDN edge and the origin, coalescing cache misses from many edge nodes into a smaller number of requests to the origin. The effect: if 100 CDN edge nodes each have a cache miss for the same popular piece of content simultaneously, origin shield reduces that to one request to the origin instead of 100. A staff engineer designing a high-egress system must decide whether origin shield is warranted (it adds latency and complexity) based on the estimated cache miss rate and the number of edge PoPs.

**Bandwidth estimation for multi-region replication.** For globally-distributed services with multi-region replication, intra-region bandwidth is typically free or low-cost, but inter-region replication bandwidth is priced at network transfer rates. At AWS pricing, inter-region data transfer costs approximately $0.02 per GB. A service that replicates 1 TB per day between regions incurs $20 per day, or $7,300 per year, in replication bandwidth costs alone. A staff engineer designing multi-region replication must include this cost in the architecture ADR and evaluate whether selective replication (only replicating the data required for regional availability, not full global replication) reduces cost while meeting the RTO and RPO targets.

**L6/L7 concern: network bandwidth as a cluster-level bottleneck.** In large-scale distributed systems, the network bandwidth of individual nodes and the aggregate bandwidth of a rack or cluster can become the limiting factor before CPU or disk. A single Kafka broker receiving 50 MB/s of writes must also send 50 MB/s to two replicas (for a replication factor of 3), consuming 150 MB/s of outgoing bandwidth. On a 1 Gbps NIC, the effective Kafka write throughput ceiling is approximately 800 MB/s (leaving headroom for other traffic), which means a single broker can support about 5 high-throughput partitions before becoming NIC-bound. A staff engineer designing a Kafka cluster must calculate the per-broker bandwidth budget and determine whether 10 GbE or 25 GbE NICs are required for the target throughput. This analysis belongs in the cluster sizing ADR, not in the post-mortem after a NIC saturation incident.

**Governance: bandwidth estimation as a CDN contract input.** FAANG companies negotiate multi-year CDN contracts that include volume commitments in exchange for lower per-GB pricing. A bandwidth estimate for a new product launch or a growing service feeds directly into these contract negotiations. A staff engineer who owns a high-egress service is responsible for providing the capacity planning team with a bandwidth forecast (average and peak, by region and content type) on the cadence required by the contract renewal cycle. Inaccurate forecasts result in either under-committing (paying higher per-GB prices) or over-committing (paying for capacity that is never used). The business cost of poor bandwidth estimation is real and measurable.

---
