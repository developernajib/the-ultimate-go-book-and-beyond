## Key Design Decisions

Every system design involves trade-offs, and interviewers specifically look for your ability to justify why you chose one approach over another. The decisions below represent the most impactful architectural choices in a video streaming platform. For each decision, you should understand the alternative, the reasoning behind the chosen approach, and what you give up in exchange.

### Decision 1: Client-Direct Upload to Object Storage (vs. Upload Through API Servers)

**Choice:** Generate presigned S3 URLs and have clients upload directly to S3.

**Why:** 500 hours of footage arrive per minute. A high-bitrate 4K master runs 100GB per hour, but most uploads are far smaller, so even at a realistic average of 4GB per hour of footage the ingress is roughly 2TB per minute, which is about 33GB per second sustained. Routed through API servers, that burns dozens of 10Gbps NICs doing nothing but proxying bytes from one socket to another. Presigned URLs remove the tier entirely: clients upload straight to S3 while our servers only track metadata.

**Trade-off:** We cannot inspect the bytes as they arrive, which matters for moderation and for malformed input. Moderation runs as a post-upload async step gating the transition to `status = ready`. Validation moves there too: check magic bytes rather than trusting the declared content type, and never interpolate a client-supplied filename into an FFmpeg command line.

---

### Decision 2: Segment-Based HLS/DASH for Adaptive Streaming (vs. Progressive Download)

**Choice:** Videos split into 6-second HLS segments, player downloads manifest, then requests individual segments.

**Why:** Each 6-second segment is independently requestable, so seeking to minute 45 means fetching segment #450 rather than downloading 45 minutes of video first. Adaptive bitrate switches quality per segment based on measured bandwidth. The CDN caches each segment independently, which gives cache granularity that matches how people actually watch: the first two minutes of a popular video stay hot at the edge while the last twenty minutes may never be cached at all.

**Trade-off:** An enormous number of small objects. Do the arithmetic, because the usual claim of "6× more objects" is off by two orders of magnitude. A 10-minute video is 600 seconds ÷ 6 = 100 segments per rung, times 6 rungs, which is 600 objects plus 7 playlists and 6 init segments, against 1 object for a progressive file. A 2-hour film is over 7,000 objects. Across the catalog this is a metadata and lifecycle-management problem before it is a storage-cost problem, which is why the key layout is organized by prefix: `videos/{id}/{quality}/` lets one lifecycle rule tier an entire rung and one invalidation clear an entire video.

---

### Decision 3: Separate Transcoding Workers (vs. In-Process)

**Choice:** SQS-driven worker fleet on EC2 Spot Instances / Lambda, separate from the API tier.

**Why:** Transcoding is CPU-bound and runs for minutes to hours per video, while API serving is I/O-bound and measured in milliseconds. Mixing them means provisioning the API tier for the transcoder's CPU appetite and watching latency collapse whenever a long encode lands. Separated, the worker fleet runs on Spot instances at roughly 70% off on-demand, which is only possible because the workers are stateless: when Spot reclaims an instance mid-encode, the SQS message becomes visible again and another worker starts over. Interruption is routine rather than exceptional, and the queue is what makes it survivable.

**Trade-off:** Transcoding latency of 5 to 15 minutes after upload, which is fine for user-generated content. Netflix sits at the opposite end deliberately, spending 24 to 48 hours per title on per-title encoding, because a title it will stream tens of millions of times justifies almost any one-time encoding cost to shave bits off every future delivery. The right answer depends entirely on the ratio of encodes to views.

---

### Decision 4: Two-Stage Recommendation Pipeline (vs. Single-Pass Ranking)

**Choice:** Candidate generation (millions → ~500) followed by deep ranking (~500 → 20).

**Why:** Applying an expensive ranking model to a catalog of hundreds of millions of videos on every request is not affordable at 11,574 queries per second. Candidate generation uses cheap approximations (ANN search on embeddings, collaborative filtering) to get to roughly 500. The ranking model, which predicts expected watch time, then runs on those 500 only, which is tractable.

**Trade-off:** Recall loss. Anything candidate generation fails to retrieve can never be ranked, no matter how good the ranker is, so the ceiling on the whole system is set by the cheapest stage in it. This is the trade you are actually making, and it is usually the right one: recommendations express preference rather than correctness, and a user who never sees their 400th-best video has lost nothing they can perceive. It also means that when quality is poor, the instinct to improve the ranker is often wrong. Measure recall at the candidate stage first, because no amount of ranking recovers a candidate that was never generated.

---

### Decision 5: Predictive CDN Pre-Loading (Netflix) vs. Reactive Caching (YouTube)

**Choice Netflix:** Preload predicted-popular content to Open Connect appliances inside ISP networks during the nightly off-peak fill window.

**Why Netflix:** The catalog is bounded, on the order of tens of thousands of titles, and viewing is predictable enough that a model trained on history is a good guide to tomorrow. Pre-loading one popular film to a thousand appliances converts what would have been millions of individual cache misses into one planned, off-peak transfer per appliance. The appliance then answers essentially every request locally.

**YouTube approach:** A catalog orders of magnitude larger, dominated by a long tail where most videos get very few views and any given obscure video is unlikely to be requested in a given region on a given day. There is nothing useful to predict, so caching is reactive: LRU/LFU at the edge, with longer TTLs for trending content. The hybrid is to apply Netflix-style cache-push selectively to the small set of new uploads that are already going viral, where prediction is easy and the payoff is large.

**Trade-off:** Pre-loading spends storage and fill bandwidth on content that will not be watched, and you will never get the prediction fully right. This is a good trade because the two sides are not symmetric. A wasted fill costs some off-peak bandwidth and some disk on a box you already own. A cache miss at peak costs a transit charge and a user staring at a spinner. Be able to state that asymmetry, because it, not the model's accuracy, is the actual justification.

---

### Decision 6: View Count Consistency (Eventually vs. Strong)

**Choice:** Eventual consistency for view counts. Batch-increment using stream processing.

**Why:** A strongly consistent view count means serializing writes on the hottest row in the system. At 1B views per day, and far worse for a single viral video where a large share of those views land on one row, that row becomes a global lock. Instead, view events flow to Kafka, a stream processor aggregates them, and the database takes a bulk increment every 30 seconds. The hot row is written a few times a minute instead of thousands of times a second.

**Trade-off:** The displayed count lags reality by up to 30 seconds, most visibly during exactly the viral event where people are watching the number. That is the right call, because nobody can distinguish 1,000,241 from 1,000,258 views, and the alternative is that the counter falls over precisely when the video matters most. Be careful about what you promise here, though: this buys eventual consistency, not accuracy. The count still has to be correct eventually, which means the aggregation must be idempotent and must survive a consumer restart without double-counting or dropping a window.

---
