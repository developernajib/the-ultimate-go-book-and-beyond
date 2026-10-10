## Extended Architecture: Multi-Region Deployment

A global video platform serves users from the nearest region. This architecture deploys independent stacks in US-East, EU-West, and AP-South, each with its own API gateway, CDN PoPs, Redis, Elasticsearch, and transcoding workers. The MySQL primary lives in US-East with read replicas in each region. Uploads land in the nearest region's bucket and are transcoded there, so the heavy bytes never cross an ocean.

Two things this diagram does not say, and both will be asked about.

**A single primary means writes are not regional.** Reads are local and fast. Every write from Mumbai crosses to Virginia and back, which is a couple of hundred milliseconds of round trip that no amount of local infrastructure removes. That is fine for this workload, and you should be able to say why: the write rate is tiny compared to the read rate, and the reads and the video bytes, which are the parts users feel, are already local. One primary buys strong consistency and no conflict resolution, which is worth far more here than shaving latency off an upload that is about to spend ten minutes transcoding anyway. If writes ever become the bottleneck, the next step is sharding the primary by region of ownership, not multi-primary, because multi-primary means conflicts and conflicts mean somebody's edit is silently discarded.

**Replication lag breaks read-your-own-writes.** This is the bug that will actually reach production. A creator in Mumbai uploads a video: the write goes to US-East, the client immediately fetches the video page, the read goes to the local AP-South replica, and the row is not there yet. The creator gets a 404 for the video they just uploaded, refreshes, and it appears. It is intermittent, it never reproduces in a single-region test environment, and the log for the failed read looks exactly like a request for a video that does not exist. Route reads to the primary for a short window after a user writes (a sticky-primary period, keyed on the user and typically a few seconds), or pass the write's position and wait for the replica to catch up. Anything less and the platform is subtly broken for exactly the people who create its content.

```
                 ┌─────────────────────┐
                 │     Global DNS      │
                 │  (Route53 / Cloud   │
                 │ DNS latency-based)  │
                 └──────────┬──────────┘
                            │
           ┌────────────────┼────────────────┐
           ▼                ▼                ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │   US-East    │ │   EU-West    │ │   AP-South   │
   │    Region    │ │    Region    │ │    Region    │
   │              │ │              │ │              │
   │    API GW    │ │    API GW    │ │    API GW    │
   │   CDN PoPs   │ │   CDN PoPs   │ │   CDN PoPs   │
   │   MySQL RR   │ │   MySQL RR   │ │   MySQL RR   │
   │    Redis     │ │    Redis     │ │    Redis     │
   │  ES Cluster  │ │  ES Cluster  │ │  ES Cluster  │
   │  Transcode   │ │  Transcode   │ │  Transcode   │
   └──────────────┘ └──────────────┘ └──────────────┘
           │                │                │
           └────────────────┼────────────────┘
                            │
                    ┌───────▼───────┐
                    │     MySQL     │
                    │    Primary    │
                    │   (US-East)   │
                    │               │
                    │ Cross-region  │
                    │  replication  │
                    └───────────────┘

Upload:   client -> nearest region's S3 -> transcoding in the same region
Read:     client -> nearest CDN PoP -> (miss) -> regional S3 -> (miss) -> origin S3
Writes:   all regions -> single MySQL primary in US-East (cross-region RTT)
Metadata: primary -> regional read replicas (lag is normally tens of ms and is
          NOT bounded: it grows under write bursts and during replica catch-up.
          Reads after a user's own write must go to the primary for a few
          seconds, or that user sees their upload 404)
Search:   per-region Elasticsearch cluster (index replicated via Kafka)
```

---
