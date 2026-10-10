## 64D.4 Storage Estimation Framework

### The Five-Step Storage Framework

1. **Data per user** (or per event/item)
2. **Number of users/items**
3. **Total raw storage**
4. **Replication factor**
5. **Retention period**

### Replication Factor

Distributed storage systems replicate data for fault tolerance. Use replication factor 3 as the standard for most systems:
- HDFS default: 3
- Cassandra default: 3
- Kafka default: 3
- PostgreSQL streaming replication: 1 primary + 2 replicas = 3

```
Storage with replication = raw storage × 3
```

### Retention Periods

Not all data is retained forever. Match retention to business requirements:

```
Data Type                  Typical Retention
─────────────────────────────────────────────
User profiles              Indefinite (or 30 days post-deletion)
Social media posts         Indefinite
Messages (WhatsApp)        30 days (encrypted on device, not server)
Application logs           7-30 days (hot), 1 year (cold)
Metrics/telemetry          13 months (for year-over-year comparison)
Audit logs                 7 years (compliance)
Video (YouTube)            Indefinite
Photos (Instagram)         Indefinite
Financial transactions     7 years (regulatory)
```

### Worked Example: Photo Storage (Instagram Scale)

**Given**: 100M photos uploaded per day.

```
Step 1: Data per photo
- Original HD photo: 3 MB (compressed JPEG from smartphone)
- Thumbnail (150px): 20 KB
- Medium (600px): 200 KB
- Standard (1080px): 500 KB
- HD (1080px 2x for Retina): 1 MB

Total per photo: 3 MB (original) + 1.72 MB (derived) ≈ 5 MB

Step 2: Daily storage (raw)
= 100M photos × 5 MB = 500M MB = 500 TB/day

Step 3: With replication
= 500 TB × 3 = 1.5 PB/day

Step 4: Annual growth
= 1.5 PB × 365 = ~550 PB/year

Step 5: Over 5 years (retention: indefinite for user photos)
= 550 PB × 5 = 2.75 EB (exabytes)

At this scale, Instagram uses:
- Content-addressable storage (dedup reduces storage by ~20% for identical
  photos shared by multiple accounts - memes, stock photos)
- Tiered storage: recent photos on SSD-backed object storage,
  older photos on HDD-backed storage (reduces cost ~70%)
- Compression improvements over time (HEIC vs JPEG reduces size 40%)
```

### Worked Example: Message Storage (WhatsApp Scale)

**Given**: 100B messages sent per day, WhatsApp model (messages stored temporarily on server until delivered, then deleted from server).

```
Step 1: Data per message
- Text message: 280 bytes (average)
- Image message: 200 KB (compressed)
- Video message (30s): 15 MB (compressed)
- Voice note (30s): 500 KB

Message type mix (estimated):
- Text: 65% × 280 B = 182 B average contribution
- Image: 25% × 200 KB = 50 KB average contribution
- Video: 5% × 15 MB = 750 KB average contribution
- Voice: 5% × 500 KB = 25 KB average contribution

Weighted average IF media travels inline:
≈ 182 B + 50 KB + 750 KB + 25 KB ≈ 825 KB (dominated by video/image)
= 100B × 825 KB = 82.5 PB/day, which is enormous.

This is exactly why WhatsApp does NOT put media through the message
pipeline. Photos and videos are uploaded once as separate encrypted
blobs (their own object store), and the message that flows through the
delivery pipeline carries only text plus a blob pointer plus metadata,
about 1 KB. So the two tiers are sized separately: the message pipeline
at ~1 KB/message, and media blobs at their true size.

Step 2: Message-pipeline daily storage
= 100B messages × 1 KB = 100 TB/day (raw)
(Media blob storage is a separate, larger calculation driven by the
number and size of media uploads, not the message count.)

Step 3: WhatsApp's retention model
WhatsApp stores messages for 30 days if undelivered.
Typical delivery is within seconds.
Effective undelivered buffer: 1% of messages × 30 days

Persistent storage: 100 TB/day × 30 days = 3 PB maximum buffer
(With typical delivery rate, effective storage << 1 PB)

Step 4: Metadata (message receipts, timestamps) - indefinite
100B messages/day × 200 bytes metadata
= 20 TB metadata/day
= 20 TB × 365 = 7.3 PB metadata/year
```

### Worked Example: Log Storage

**Given**: 50 microservices, each processing 10,000 RPS at peak, logging 1 log line per request.

```
Step 1: Log lines per second
= 50 services × 10,000 RPS × 1 log line/request
= 500,000 log lines/second

Step 2: Data per log line
= 200 bytes (structured JSON with timestamp, service, trace ID, level, message)

Step 3: Raw log rate
= 500,000 × 200 bytes = 100 MB/second = 360 GB/hour = 8.64 TB/day

Step 4: Compression
JSON logs compress 4:1 with gzip/zstd
Compressed storage: 8.64 TB / 4 = 2.16 TB/day

Step 5: Retention (hot: 7 days, cold: 90 days)
Hot storage (SSD-backed, fast query): 2.16 TB × 7 = 15 TB
Cold storage (HDD-backed, Glacier): 2.16 TB × 83 more days = 180 TB

Step 6: Replication (hot: 3x, cold: 2x)
Hot with replication: 15 TB × 3 = 45 TB
Cold with replication: 180 TB × 2 = 360 TB

Total infrastructure: ~405 TB for log storage
```

### Junior → FAANG: Mastering the Five-Step Storage Framework for Interviews

The five-step storage framework is the structure that separates candidates who produce defensible storage estimates from those who guess. The most common failure modes are: forgetting the replication factor (which understates storage by 3x), ignoring retention periods (which overstates or understates storage dramatically), and conflating raw data size with actual per-item storage size (which ignores derived versions like thumbnails and transcoded resolutions).

**The replication reflex.** Every storage estimate ends with "times three for replication." This should be as automatic as saying "amen" at the end of a prayer. If you do not say it in an interview, you signal that you design for single-node storage, which flags a gap in distributed systems understanding. Practice ending every storage calculation with the replication step out loud.

**Retention as the variable that changes estimates by orders of magnitude.** WhatsApp messages retained for 30 days versus seven years differ by a factor of 85. Audit logs retained for seven years versus application logs retained for 30 days differ by a factor of 85 in the other direction. The retention period is not a detail: it is the multiplier that drives the most important sizing decisions (which storage class, what replication strategy, whether tiered storage is needed). In an interview, state the retention assumption before calculating, and note if it came from a business or regulatory requirement.

**Derived data multiplication.** The Instagram photo example (3 MB original becomes 5 MB with derived sizes) illustrates a pattern that applies to nearly every media system: the system stores not just the original but multiple derived representations. Video platforms store five resolutions. Image platforms store four or five thumbnail sizes. Document systems store rendered previews. Always ask: what derived formats does this system need, and what is the total storage multiplier relative to the original? For video, the multiplier is roughly 3-5x. For images, roughly 1.5-2x. Including this in your estimate demonstrates production-level thinking.

**First-job habit:** The next time your team deploys a new data pipeline or storage schema, calculate the storage growth rate before it goes to production: data per record times write rate times retention period. Then verify after one week that the actual growth rate matches your estimate. The ratio of actual to estimated growth is your calibration error. Tracking it over multiple estimates builds the intuition that makes you reliable at storage planning.

**Interview entry point:** "How much storage does Instagram need for photos?" The expected four-step answer: 100 million photos uploaded per day, about 5 MB each with derived sizes, gives 500 TB per day raw. Times three for replication, 1.5 PB per day. Over five years with indefinite retention, roughly 2.7 exabytes total. Then note that deduplication (identical memes) and tiered storage (recent on SSD, older on HDD or cold storage) reduce effective cost significantly. Candidates who reach the deduplication and tiering insight demonstrate depth beyond the basic formula.

### Senior @ FAANG: Storage Estimation as a Cost Architecture and Data Governance Tool

At senior level, storage estimation is not just about knowing how much space data occupies. It is about building cost-efficient storage architectures, governing data lifecycle policy, and identifying when storage growth rates will require architectural changes.

**ADR: storage tier strategy based on access pattern and retention.** The Instagram photo example spans three distinct storage tiers: recent photos on NVMe-backed object storage (fast random access, high cost), photos from the past year on HDD-backed object storage (acceptable latency for occasional access, lower cost), and very old photos on cold storage or tape (high retrieval latency, lowest cost). An ADR for a tiered storage strategy must specify: what are the access frequency thresholds for tier promotion and demotion, what is the retrieval SLA for each tier, and what is the cost per GB per month for each tier at the organization's scale? Without this analysis, teams either over-pay for hot storage on infrequently-accessed data or fail to meet SLAs by migrating too aggressively to cold storage.

**Data governance and retention as an engineering responsibility.** The retention period table in this section is not just a lookup table: it reflects legal, regulatory, and business requirements that have engineering implications. GDPR requires that user data be deletable upon request, which means your storage architecture must support targeted deletion, not just bulk retention expiry. Financial transaction data retained for seven years must be auditable, which means it must remain queryable and integrity-verified for the full retention period. A staff engineer working on a user data storage system must understand which data categories have retention requirements and design the storage schema and lifecycle management accordingly.

**Storage cost modeling as a budget conversation.** At FAANG scale, storage costs are a significant budget line. The Instagram photo estimate (2.7 exabytes over five years) at AWS S3 pricing ($0.023 per GB-month) would cost approximately $1.5 billion over five years without tiering optimizations. With intelligent tiering and deduplication, the actual cost might be 30-50% of that. A staff engineer who owns a high-storage service must understand the cost implications of their storage design choices and present them in budget conversations. This requires knowing: current storage volume and growth rate, cost per GB for each tier, savings from deduplication and compression, and projected five-year cost with and without tiering.

**L6/L7 concern: storage estimation for multi-region compliance.** Global services often face data residency requirements: EU user data must remain in EU regions, financial data for specific jurisdictions must remain on-shore. These requirements can eliminate the cross-region replication strategies that simplify disaster recovery planning. A staff engineer designing storage architecture for a globally-compliant service must model storage independently per region: EU storage at EU-user volume times EU data retention, US storage at US-user volume times US data retention, with no cross-pollination. The total storage estimate is the sum across jurisdictions, not a single global figure. Data residency requirements can increase storage costs significantly compared to a globally-replicated single-region primary model.

**Governance: storage estimate reviews as a release gate.** Any feature that creates a new data type or substantially changes the write rate of an existing one should require a storage estimate review before launch. The review answers: how much storage will this feature consume per day, per month, and per year, what tier is appropriate for this access pattern, and what is the lifecycle management plan (when does data transition between tiers, when is it deleted)? Without this gate, teams routinely discover months after launch that a feature is consuming unexpected storage at unexpected cost, with no lifecycle management in place.

---
