## Extended Architecture: Kafka Topic Design

Kafka acts as the central nervous system connecting all Twitter services. Each topic is partitioned by a key that ensures related events land on the same partition (for ordering guarantees) while spreading load across many consumers. For example, tweet events are partitioned by user_id so that all of one user's tweets are processed in order, while engagement events are partitioned by tweet_id so that like and retweet counts for a single tweet are never processed concurrently by different workers.

```
Kafka Topics for Twitter:

1. tweet-events (partitioned by user_id, 256 partitions)
   - All tweet create/delete events
   - Consumers: fan-out workers, search indexer, trending, analytics

2. fan-out-tasks (partitioned by follower_id range, 128 partitions)
   - Pre-computed fan-out batches
   - Consumers: timeline cache writers
   - Optional second stage. The workers shown earlier in this chapter consume
     tweet-events and write Redis directly, which is simpler and is the right
     starting point. Split the follower expansion into its own topic only when
     one tweet's fan-out no longer fits comfortably inside a single consumer's
     poll interval and you need to checkpoint partway through.

3. engagement-events (partitioned by tweet_id, 64 partitions)
   - Like, retweet, reply events
   - Consumers: counter updater, notification service, analytics

4. user-events (partitioned by user_id, 64 partitions)
   - Follow/unfollow, profile updates, account changes
   - Consumers: graph updater, notification service

5. search-index (partitioned by tweet_id, 32 partitions)
   - Tweet documents for Elasticsearch ingestion
   - Consumers: ES bulk indexer

6. notification-events (partitioned by recipient_id, 64 partitions)
   - All notification types
   - Consumers: push notification workers, in-app notification writers

7. dm-events (partitioned by conversation_id, 32 partitions)
   - Direct message send/read events
   - Consumers: DM delivery workers

Retention: 7 days for real-time topics, 30 days for analytics topics
Replication factor: 3 (across availability zones)
```

---
