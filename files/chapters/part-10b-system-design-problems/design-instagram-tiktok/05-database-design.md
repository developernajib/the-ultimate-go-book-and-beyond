## Database Design

The database schema reflects the "query-first" approach that NoSQL databases like Cassandra require. Unlike relational databases where you normalize data and join at query time, Cassandra tables are designed around specific access patterns. This means you will often store the same data in multiple tables (for example, follows are stored in both `followers_of` and `following_of`) to support efficient lookups in both directions. Stories use Cassandra's built-in TTL feature to automatically expire after 24 hours, eliminating the need for cleanup jobs.

**Users Table (PostgreSQL or Cassandra):** User profiles are read frequently but updated rarely, making them suitable for either PostgreSQL (if you need relational queries like "find users by email") or Cassandra (if you prioritize write scalability). Denormalized counters (follower_count, post_count) avoid expensive COUNT queries on the follows and posts tables.

```
Users Table (PostgreSQL or Cassandra):
  - id, username, email, bio, avatar_url
  - follower_count, following_count, post_count
  - private_account, verified
```

**Posts Table (Cassandra):** Partitioned by `user_id` so that all of a user's posts live on the same node. The `post_id` uses a TimeUUID, which is both globally unique and time-ordered, so `ORDER BY post_id DESC` returns posts in reverse chronological order without a separate timestamp index. Engagement counters live in a companion `post_counters` table because Cassandra forbids counter columns alongside regular columns. They track metrics with eventual consistency, avoiding the need for distributed locks on every like or view.

```
Posts Table (Cassandra - partition by user_id):
  - PRIMARY KEY (user_id, post_id timeuuid)
  - media_url, thumbnail_url, caption, tags

Post Counters Table (Cassandra - counter-only table):
  - PRIMARY KEY (post_id)
  - like_count, comment_count, view_count (counters)
```

**Follows Table (Cassandra):** The social graph requires two separate tables because Cassandra cannot efficiently query a table by a non-partition column. `followers_of` answers "who follows user X?" (needed for fan-out), while `following_of` answers "who does user X follow?" (needed for feed generation). Both tables store the same relationship, which doubles storage but makes both queries single-partition reads.

```
Follows Table (Cassandra - two tables for bidirectional queries):
  - followers_of: PRIMARY KEY (user_id, follower_id)
  - following_of: PRIMARY KEY (user_id, following_id)
```

**Comments Table (Cassandra):** Partitioned by `post_id` with a TimeUUID clustering key, so loading comments for a post is a single-partition scan in chronological order. For posts with thousands of comments, the application fetches only the first 20 and paginates using the last `comment_id` as a cursor.

```
Comments Table (Cassandra):
  - PRIMARY KEY (post_id, comment_id timeuuid)
```

**Likes (Redis + Cassandra):** Redis sorted sets provide fast "is this post liked by user X?" lookups and power the real-time like count displayed in the UI. Cassandra stores the durable like record for audit and analytics. Redis is the source of truth for the live count, and a background reconciliation job corrects drift against the Cassandra ledger nightly.

```
Likes (Redis sorted set for recent, Cassandra for persistence):
  - likes:{post_id} → sorted set of user_ids with timestamp
```

**Stories (TTL Table):** Stories are the simplest table because they are entirely ephemeral. The 86,400-second TTL means Cassandra automatically removes expired stories during compaction, requiring zero application-level cleanup. The `user_id` partition key ensures that loading a user's active stories is a single-partition read.

```
Stories (separate TTL table - auto-expires after 24h):
  - PRIMARY KEY (user_id, story_id)
  - TTL = 86400 seconds
```

---
