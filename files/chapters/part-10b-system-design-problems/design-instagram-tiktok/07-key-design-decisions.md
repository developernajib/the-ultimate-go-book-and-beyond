## Key Design Decisions

This section covers the most commonly probed areas in system design interviews. Each subsection represents a feature that interviewers expect you to discuss with specific technical choices and trade-offs. Being able to explain why you chose a particular approach (not just what the approach is) separates strong candidates from average ones.

### Decision 1: Stories Architecture with TTL-Based Expiration

**Choice:** Store stories in Cassandra with a TTL of 86,400 seconds (24 hours). Maintain a Redis sorted set (`stories:{user_id}`) with expiry timestamps as scores for fast ordering. Track which stories a user has viewed on the client side.

**Why Cassandra TTL:** Stories are inherently ephemeral: they must disappear after exactly 24 hours. Cassandra's built-in TTL feature handles this at the storage engine level during compaction, eliminating the need for a separate cleanup cron job. At 100 million stories per day, a deletion job would create significant write amplification. TTL-based expiration is essentially free.

**Why client-side seen tracking:** Moving "has the user seen this story" to the client avoids writing a "viewed" event to the server for every story view. With 500 million DAU each viewing dozens of stories, server-side tracking would generate billions of writes per day for a feature that only affects the UI indicator (dimming viewed stories). The client stores seen story IDs locally and syncs a compact summary periodically.

**Trade-off:** Client-side tracking means a user who switches devices may see stories they already viewed on another device. This is acceptable because re-viewing a story is not a significant UX problem.

---

### Decision 2: Adaptive Bitrate Video Streaming (HLS)

**Choice:** Transcode all videos into 4 quality levels (360p, 480p, 720p, 1080p) and split each into 6-second HLS segments. The CDN serves segments from edge locations. The client player measures available bandwidth and switches quality per-segment.

**Why HLS over progressive download:** Progressive download requires the user to download from the beginning, making seeking expensive. HLS segments are independently addressable: seeking to the 30-second mark means requesting the segment that covers it directly. Adaptive bitrate switching means users on cellular networks get a watchable 360p experience instead of constant buffering at 1080p. Each segment is a separate HTTP request, which aligns perfectly with CDN cache granularity.

**Why 6-second segments:** Shorter segments (2 seconds) enable faster quality adaptation but increase the number of HTTP requests and S3 objects by 3x. Longer segments (10 seconds) reduce request overhead but make quality switching sluggish. Six seconds balances responsiveness against infrastructure cost, and matches Apple's HLS authoring recommendation.

**Trade-off:** Storing 4 quality variants multiplies storage by roughly 4x compared to a single quality. At 1 petabyte of new video per day, this means 4 petabytes of transcoded output. Mitigated with S3 Intelligent-Tiering, which automatically moves less-accessed variants to cheaper storage tiers.

---

### Decision 3: Asynchronous Notification Batching via Kafka

**Choice:** All user actions (likes, comments, follows, mentions) publish events to a Kafka topic (`user_actions`). A notification service consumes these events, batches them intelligently (e.g., "Alice and 47 others liked your photo"), and fans out via FCM (Android) and APNs (iOS).

**Why Kafka instead of synchronous push:** A viral post receiving 10,000 likes per minute would generate 10,000 individual push notifications if handled synchronously. This overwhelms both the user's device and the push notification services. Kafka decouples the action from the notification, allowing the notification service to aggregate events over a configurable window (typically 30-60 seconds) and send a single batched notification.

**Why not skip batching and use real-time push:** Real-time individual notifications are appropriate for direct interactions (someone commented on your post, someone mentioned you) but destructive for high-volume engagement signals. A user opening their phone to 500 separate "X liked your photo" notifications will disable notifications entirely. Batching preserves engagement by making each notification meaningful.

**Trade-off:** Batching introduces 30-60 seconds of notification delay for likes and follows. Direct interactions (comments, mentions, DMs) bypass batching and deliver immediately because they carry higher urgency. This two-tier approach keeps latency-sensitive notifications fast while preventing notification fatigue.

---
