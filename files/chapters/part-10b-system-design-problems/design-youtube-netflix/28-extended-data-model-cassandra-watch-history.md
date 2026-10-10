## Extended Data Model: Cassandra Watch History

Watch history is a classic time-series workload: write-heavy (billions of events per day), append-only, and queried by user. Cassandra suits it because it absorbs write throughput across nodes without the locking a relational database would impose on the same pattern. Two tables with different partition keys serve two different questions: `watch_events` for "my history" and "resume playback", `video_views_daily` for per-video analytics.

**Every Cassandra partition key must be bounded.** This is the rule that governs the whole design, and the natural key here violates it. Partitioning `watch_events` on `user_id` alone means one partition per user growing for the lifetime of the account, forever. Cassandra will not stop you. It will accept the writes cheerfully for two years and then hand you a heavy user with a partition large enough to hurt compaction, reads, and repair, on a single node that cannot be split. A partition is the unit of storage and replication, so an unbounded partition is an unbounded blast radius.

The fix is to put a time bucket into the partition key. Note that the second table below already does exactly this (`(video_id, day)`), which is the tell: if bucketing is right for per-video analytics, it is right for per-user history, and the same reasoning applies to both.

Bucket size is a real trade-off, not a formality. Buckets that are too large bring the original problem back. Too small and "show my last 50" fans out across many partitions, so the read that was supposed to be cheap now touches a dozen nodes. Month buckets are a reasonable default here: a heavy user watching 50 videos a day builds roughly 1,500 rows a month, which is a comfortable partition, and the common query almost always finds 50 rows in the current bucket without looking further.

```sql
-- Cassandra: watch_events (time-series, write-optimized)
-- Partition by (user_id, month_bucket) so partitions stop growing.
-- month_bucket is an integer like 202607, written by the client.
-- Good for: "show my watch history", "resume from where I left off"
CREATE TABLE watch_events (
    user_id       TEXT,
    month_bucket  INT,          -- yyyyMM
    watched_at    TIMESTAMP,
    video_id      TEXT,
    watch_duration_secs INT,
    position_secs INT,
    completed     BOOLEAN,
    quality       TEXT,
    device        TEXT,
    PRIMARY KEY ((user_id, month_bucket), watched_at, video_id)
) WITH CLUSTERING ORDER BY (watched_at DESC, video_id ASC);

-- "Last 50 watched" reads the current bucket first and walks backwards only if
-- it comes up short. Most users are satisfied by the first query.
--   SELECT * FROM watch_events
--    WHERE user_id = ? AND month_bucket = 202607
--    LIMIT 50;

-- Resume playback needs one row per video, not a scan of history. Reading it
-- out of watch_events would mean scanning buckets backwards to find the last
-- event for one video, which is unbounded work for a lookup on the play path.
-- A tiny table keyed for exactly that question is worth the duplicated write.
CREATE TABLE resume_positions (
    user_id       TEXT,
    video_id      TEXT,
    position_secs INT,
    updated_at    TIMESTAMP,
    PRIMARY KEY (user_id, video_id)
);

-- Cassandra: per-video analytics.
-- Partition by video_id + day: bounded by construction, 24 rows per partition.
CREATE TABLE video_views_daily (
    video_id    TEXT,
    day         DATE,
    hour        INT,
    view_count  COUNTER,
    watch_time_secs COUNTER,
    PRIMARY KEY ((video_id, day), hour)
);
```

One warning about that counter table, because it interacts badly with the rest of this chapter. **Cassandra counters are not idempotent.** An increment that times out may or may not have been applied, and retrying it may double-count. Since the analytics pipeline is at-least-once by design, counters are the one place where a retry cannot be made safe by carrying an event ID. If the number has to be defensible, aggregate deduplicated events in the stream processor and write the result as a regular column, keeping counters for dashboards where approximate is genuinely good enough. Know which of those two you are building before someone asks why the payout report disagrees with the dashboard.

---
