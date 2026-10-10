## 64D.7 Complete System Design Examples

### Example 1: URL Shortener at Scale

**Requirements**: Design bit.ly - a URL shortening service.

**Assumptions**:
- 500M new URLs shortened per day (write-heavy at creation, read-heavy afterward)
- 100B redirects per day
- URLs stored for 5 years
- p99 redirect latency < 10ms

**Traffic estimation**:

```
Write RPS (URL creation):
= 500M / 86,400 ≈ 6,000 RPS average
= 6,000 × 3 = 18,000 peak RPS

Read RPS (redirects):
= 100B / 86,400 ≈ 1,150,000 RPS average ≈ 1.15M RPS
= 1.15M × 5 = 5.75M peak RPS (viral content multiplier is higher)

Read:Write ratio = 1.15M / 6,000 ≈ 192:1 (read-heavy)
```

**Storage estimation**:

```
Per short URL record:
- Short code: 7 characters = 7 bytes
- Original URL: 500 bytes (average long URL)
- Creation timestamp: 8 bytes
- Expiry timestamp: 8 bytes
- User ID: 16 bytes (UUID)
- Click count: 8 bytes
Total per record: ~550 bytes ≈ 1 KB (with overhead)

5-year storage:
= 500M URLs/day × 365 days × 5 years × 1 KB
= 912.5B URLs × 1 KB
= ~900 TB raw
= 900 TB × 3 (replication) = 2.7 PB

Database choice: Cassandra (write-heavy, high read scalability)
or PostgreSQL (lower scale, simpler operations)

At 900B records, Cassandra is the right choice.
Single Cassandra node (i3.2xlarge): ~10 TB storage
Nodes needed: 900 TB / 10 TB = 90 nodes
With replication factor 3: 90 × 3 = 270 nodes total

Alternatively: Object storage (S3) for persistence + Redis/Memcached for hot data
Hot data = recently created URLs + popular URLs ≈ 50M records × 1 KB = 50 GB
→ Fits in Redis cluster (3 r6g.xlarge nodes, 128 GB total)
```

**Bandwidth estimation**:

```
Redirect egress:
= 1.15M RPS × 500 bytes (HTTP 301 response)
= 575 MB/s average = ~4.6 Gbps average
= 4.6 Gbps × 5 (peak) = 23 Gbps peak

CDN handles the vast majority:
Cache hit rate for redirects: 95% (popular URLs are aggressively cached)
Origin bandwidth: 23 Gbps × 5% = 1.15 Gbps to origin
```

**Server count estimation**:

```
Redirect servers (I/O-bound, reading from cache):
Peak: 5.75M RPS
RPS per Go server (with Redis cache hit): 100,000 RPS
Servers at 70% utilization: 5.75M / (100,000 × 0.7) ≈ 82 servers

But 95% of redirects are served from CDN.
Servers handling cache-miss redirects: 5.75M × 5% = 287,500 RPS
Servers: 287,500 / 70,000 ≈ 5 servers (plus 2x redundancy = 10 servers)

URL creation servers:
Peak: 18,000 RPS (write to database + cache)
RPS per Go server (with DB write): 3,000 RPS
Servers at 70%: 18,000 / (3,000 × 0.7) ≈ 9 servers

Total: ~20 application servers + Redis cluster + Cassandra cluster
```

**Short code generation**:

```go
// Base62 encoding: a-z, A-Z, 0-9 = 62 characters
// 7 characters: 62^7 = 3.5 trillion combinations
// At 500M URLs/day, this lasts 7,000 days = 19 years

package shortener

import (
    "math/rand/v2"
    "time"
)

const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const shortCodeLen = 7

// GenerateShortCode produces a random 7-character base62 code.
// For production: use a counter-based approach with base62 encoding
// to guarantee uniqueness without random collision checks.
func GenerateShortCode() string {
    r := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0))
    code := make([]byte, shortCodeLen)
    for i := range code {
        code[i] = charset[r.IntN(len(charset))]
    }
    return string(code)
}

// CounterBasedCode converts a distributed counter to base62.
// Use a distributed counter (Redis INCR, Zookeeper, or Snowflake)
// to guarantee uniqueness without collision checks.
func CounterBasedCode(counter int64) string {
    if counter == 0 {
        return string(charset[0])
    }

    code := make([]byte, 0, shortCodeLen)
    for counter > 0 {
        code = append([]byte{charset[counter%62]}, code...)
        counter /= 62
    }

    // Pad to consistent length
    for len(code) < shortCodeLen {
        code = append([]byte{charset[0]}, code...)
    }

    return string(code)
}
```

### Example 2: Notification System

**Requirements**: Design a push notification system like the one used by Instagram.

**Assumptions**:
- 500M DAU
- Each user receives ~50 notifications per day (likes, comments, follows, DMs)
- Each user generates ~5 actions/day that trigger notifications
- 99.5% delivery rate within 5 seconds
- Supports iOS (APNs), Android (FCM), Web (Web Push)

**Traffic estimation**:

```
Notifications generated (estimate from the receiving side):
Each user receives ~50 notifications/day × 500M users = 25B notifications/day

Notification delivery RPS:
= 25B / 86,400 ≈ 290,000 notifications/second average
= 290,000 × 3 = 870,000 peak RPS

These notifications go through APNs/FCM:
APNs handles billions per day from all Apple developers.
FCM: same scale at Google.
Our throughput: 870K/second for sends to APNs/FCM gateways.
```

**Architecture**:

```
User action → Event (Kafka) → Notification Service → Priority Queue
                                                    ↓
                               Fanout Service → Notification Store (Cassandra)
                                              → Push Gateway (APNs/FCM)
                                              → Real-time (WebSocket)
```

**Storage for notification records**:

```
Per notification:
- Notification ID: 16 bytes (UUID)
- User ID (recipient): 16 bytes
- Type: 4 bytes (like, comment, follow, mention)
- Content: 200 bytes (compressed text)
- Read status: 1 byte
- Timestamp: 8 bytes
- Sender ID: 16 bytes
Total: ~261 bytes ≈ 300 bytes

Retention: 90 days (notifications older than 90 days purged)

Storage:
= 25B notifications/day × 300 bytes = 7.5 TB/day
= 7.5 TB × 90 days = 675 TB raw
= 675 TB × 3 (replication) = 2 PB

Database: Cassandra with partition key = user_id, cluster key = timestamp DESC
This makes "get my last 20 notifications" a single partition scan.
```

**Kafka topic sizing**:

```
Kafka ingress rate: 290,000 messages/second
Average Kafka message: ~500 bytes (notification event + metadata)

Throughput: 290,000 × 500 bytes = 145 MB/second

Kafka partition capacity: ~50 MB/second (for reliable, replicating writes)
Partitions needed: 145 MB/s / 50 MB/s = 3 partitions minimum
Production: 10-20 partitions for parallelism and consumer group scaling

Kafka storage (7-day retention for replay):
= 145 MB/s × 86,400 s × 7 days = 87.7 TB
= 87.7 TB × 3 (replication) = 263 TB
```

### Example 3: Video Streaming Platform (Netflix/YouTube Scale)

**Requirements**: Design a video streaming platform.

**Assumptions**:
- 200M subscribers, 100M DAU
- Each user watches 120 minutes of video per day
- 10,000 videos added per day (not YouTube scale - more like Netflix original content)
- Support for multiple resolutions: 360p, 720p, 1080p, 4K
- 99.99% availability for streaming (content must always be available)

**Ingress (content upload and transcoding)**:

```
10,000 videos/day × 45 minutes average length

Transcoding output per video:
- 360p: 45 min × 0.5 Mbps = 168 MB
- 480p: 45 min × 1 Mbps = 337 MB
- 720p: 45 min × 3 Mbps = 1 GB
- 1080p: 45 min × 5 Mbps = 1.7 GB
- 4K HDR: 45 min × 20 Mbps = 6.75 GB
Total per video: ~10 GB

Daily transcoded output:
= 10,000 videos × 10 GB = 100 TB/day

Transcoding compute:
1080p transcoding runs at ~0.1x real-time on a modern CPU
(45 min video takes ~450 minutes to transcode at 1080p)
With GPU acceleration (NVENC): ~10x real-time
GPU transcoding time: 45 min / 10 = 4.5 minutes per video

Transcoding servers needed:
= 10,000 videos × 4.5 min / (24 × 60 min/day)
= 45,000 GPU-minutes / 1,440 minutes
= 31.25 GPU servers (round to 40 with headroom)
```

**Egress (streaming)**:

```
100M DAU × 120 minutes × 60 seconds = 720B seconds of video/day

Average streaming bitrate (quality mix): 4 Mbps
Total egress: 720B seconds × 4 Mbps = 2,880 Tbps-seconds/day
= 2,880,000,000,000,000 bits / 86,400 seconds
= 33,333,333 Mbps = 33.3 Tbps average egress

Average concurrent streams:
= 720B seconds / 86,400 seconds = ~8.3M concurrent streams

Peak concurrent (prime time: 2x average):
= 8.3M × 2 = 16.6M concurrent streams
= 16.6M × 4 Mbps = 66.4 Tbps peak egress

This requires a global CDN with hundreds of Tbps capacity.
Netflix's CDN (Open Connect) has ~200 Tbps deployed globally.
```

**Storage**:

```
Content library: 15,000 titles (Netflix's current count)
Average show: 10 episodes × 45 minutes = 450 minutes

Storage per title (all resolutions):
The ~10 GB above is the all-resolution size of ONE 45-min video.
A 450-min title is ten such videos:
= 450 min / 45 min × 10 GB = ~100 GB per title

Total content library:
= 15,000 titles × 100 GB = ~1.5 PB

With geographic replication (3 regions):
= 1.5 PB × 3 = 4.5 PB

Plus new content daily:
= 100 TB/day new content × 3 regions = 300 TB/day added

Annual storage growth:
= 300 TB/day × 365 = ~109 PB/year
```

### Junior → FAANG: Extracting Patterns from Worked Examples

The three complete examples in this section (URL shortener, notification system, video streaming) are not just sample problems: they are templates for three recurring system archetypes that appear in FAANG interviews. Each archetype has a characteristic capacity profile that you can learn to recognize and apply.

**URL shortener archetype: extreme read-write asymmetry.** 192:1 read-to-write ratio is the defining characteristic of redirect-heavy systems. The design consequence is a tiered serving model: CDN absorbs 95% of reads at the edge, Redis absorbs most of the remaining 5%, and the origin serves only true cache misses. Any time an interview problem has this asymmetry (read-heavy, relatively static data, global user base), the URL shortener pattern applies: CDN first, cache second, database third. The short code generation section (base62 encoding, counter-based versus random) is a common technical deep-dive question in coding rounds, not just system design.

**Notification system archetype: fan-out with platform dependency.** The notification system's defining characteristic is that its output (APNs, FCM) is controlled by external platforms with their own rate limits and SLAs. The capacity estimate shows 870,000 notifications per second, but APNs and FCM impose per-app rate limits that may be far lower than your internal throughput. Any time an interview involves sending high volumes of notifications, SMS, or emails through external gateways, the capacity estimate must include the external rate limit and the queuing strategy (Kafka, priority queues) that absorbs the difference between your generation rate and the external delivery rate.

**Video streaming archetype: transcoding and CDN at scale.** The video streaming example demonstrates that the dominant infrastructure cost is not compute or database: it is CDN egress. 66 Tbps peak egress at CDN pricing dominates every other cost line. GPU transcoding servers are the secondary bottleneck (31 GPU servers for content ingestion). Any time an interview involves video or audio content, the capacity estimate must calculate CDN egress first, then work backward to transcoding capacity and storage. The resolution mix and average bitrate assumptions drive everything else.

**First-job habit:** For each new system your team designs, identify which of these archetypes it resembles and use the corresponding worked example as a capacity planning template. The URL shortener pattern applies to any redirect or proxy service. The notification pattern applies to any event-driven fan-out service. The video streaming pattern applies to any media delivery service. Starting from a known archetype is faster and more reliable than starting from scratch every time.

**Interview entry point:** "Design a push notification system for a social app with 500M users." The expected opening: "Let me estimate the scale. If each of 500M users receives 50 notifications per day, that is 25 billion notifications per day, or roughly 290,000 per second on average and 870,000 at peak. That is our throughput target for the Kafka ingest layer. Now let me think about the APNs and FCM rate limits..." Candidates who immediately anchor in numbers before touching architecture demonstrate the capacity-first thinking that FAANG interviewers expect.

### Senior @ FAANG: Using System Archetypes to Drive Platform Design Decisions

At senior level, recognizing system archetypes across your organization's portfolio of services allows you to design shared platform primitives that solve capacity problems once rather than repeatedly.

**Platform primitive: shared URL shortening and redirect infrastructure.** If multiple product teams need redirect functionality (link tracking, campaign URLs, internal short links), building separate URL shortener services for each team wastes infrastructure and creates inconsistent capacity planning. A platform engineering team can provide a shared redirect service with CDN integration, Redis caching, and a key-value store backend as a managed primitive. The capacity model scales with the aggregate redirect volume across all teams, allowing better CDN contract negotiation and more predictable capacity planning than team-specific implementations.

**Platform primitive: unified notification pipeline.** The notification system example highlights that APNs and FCM access, deduplication logic, user preference management, and notification store are common across every product team that sends notifications. A platform-owned notification service provides these as shared infrastructure: product teams submit notification events to a well-defined API, and the platform handles routing, deduplication, APNs/FCM rate limit management, delivery tracking, and the Cassandra notification store. The capacity model is centralized, APNs/FCM rate limits are managed at the platform level (not duplicated across teams), and product teams get notifications without rebuilding the pipeline.

**ADR: CDN architecture for video streaming at scale.** The Netflix Open Connect model (dedicated CDN appliances in ISP data centers, seeded nightly with popular content) achieves dramatically higher cache hit rates than traditional cloud CDN because content placement is controlled by the CDN operator, not by random cache population. An ADR for a video streaming CDN strategy at scale must evaluate: the cache hit rate achievable with cloud CDN (typically 80-90% for heterogeneous long-tail content), the cache hit rate achievable with a purpose-built CDN with intelligent content placement (95-99% for popular content), and the cost and operational complexity difference between the two approaches. At Netflix scale, the difference in CDN cost between 85% and 95% cache hit rate is hundreds of millions of dollars per year.

**L6/L7 concern: capacity planning for real-time versus batch workloads in the same system.** The video streaming example separates two distinct workload types: real-time streaming (66 Tbps egress, latency-sensitive) and transcoding (batch, throughput-sensitive). These workloads have completely different capacity planning constraints. Real-time streaming requires capacity for peak concurrent viewers, which is highly variable and must be over-provisioned for reliability. Transcoding is batch-oriented and can be capacity-planned based on average video ingest rate, with a queue to absorb ingestion spikes. A staff engineer designing a video platform must explicitly separate the capacity models for these two workloads and ensure they do not compete for the same resources (GPU servers for transcoding should not be shared with latency-sensitive streaming infrastructure).

**Governance: capacity planning reviews for each system archetype.** Different archetypes have different capacity planning cadences and review requirements. Redirect-heavy systems (URL shortener archetype) change capacity requirements slowly (link creation volume is relatively stable). Notification systems change rapidly (new features, growth campaigns). Video streaming systems change at content licensing cadence (new seasons of popular shows can double streaming volume on launch day). A staff engineer owning platform capacity planning assigns a review cadence to each system based on its archetype and growth characteristics, not a uniform quarterly review that is too slow for fast-growing systems and too frequent for stable ones.

---
