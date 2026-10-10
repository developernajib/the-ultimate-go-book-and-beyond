## Data Storage Design

### Tweet Storage (Cassandra)

Cassandra's wide-column model maps naturally to Twitter's write-heavy, append-only tweet stream. Two tables are maintained: a primary `tweets` table keyed by `tweet_id` for direct lookups, and a `tweets_by_user` table partitioned by `user_id` and clustered by `created_at DESC` so that a user's timeline can be fetched in a single, efficient range scan without secondary indexes.

```cql
CREATE TABLE tweets (
    tweet_id bigint PRIMARY KEY,
    user_id bigint,
    content text,
    media_ids list<text>,
    created_at timestamp
);

CREATE TABLE tweets_by_user (
    user_id bigint,
    created_at timestamp,
    tweet_id bigint,
    PRIMARY KEY (user_id, created_at)
) WITH CLUSTERING ORDER BY (created_at DESC);
```

### Timeline Cache (Redis)

Each user's home timeline is cached in Redis as a sorted set where tweet IDs are members and Unix timestamps serve as scores, giving O(log n) insertion and O(log n + k) retrieval of the k most recent tweets via `ZREVRANGE`. Capping the sorted set at 200 entries bounds memory usage per user while covering the vast majority of real-world timeline reads.

```
Key: timeline:{user_id}
Value: Sorted Set with tweet_id as member, timestamp as score

ZADD timeline:123 1699000000 tweet_id_1
ZREVRANGE timeline:123 0 199  // Get top 200
```

### User Graph

The social graph is stored in Redis using plain sets rather than sorted sets, since follower relationships carry no inherent ordering beyond membership. Splitting followers and following into separate keys, plus an additional `following_celebrities` set, allows the fan-out-on-write service to efficiently distinguish between ordinary users (whose timelines are precomputed) and high-follower celebrities (whose tweets are injected at read time to avoid massive write amplification).

```
Key: followers:{user_id}
Value: Set of follower user IDs

Key: following:{user_id}
Value: Set of users this person follows

Key: following_celebrities:{user_id}
Value: Set of celebrities this person follows
```


### Junior → FAANG: Choosing the Right Data Storage

Data storage decisions are among the most consequential in a system design interview because they are hard to reverse in production. The core decision framework: relational (PostgreSQL, MySQL) for structured data with complex queries and ACID requirements. Key-value (Redis, DynamoDB) for high-throughput simple lookups. Wide-column (Cassandra, HBase) for time-series or high-write-volume data with known access patterns. Document (MongoDB) for flexible schema with nested structures. Graph (Neo4j) for relationship-heavy traversal workloads. Object storage (S3) for blobs. For interviews at the junior level, being able to justify your choice with two or three concrete reasons is sufficient. Common mistake: picking a database you have heard of rather than one that fits the access pattern.

### Senior @ FAANG: Storage Architecture, Multi-Model Design, and Governance

Senior engineers design storage as a portfolio, not a single choice. A real system often uses multiple stores optimized for different access patterns: a relational database as the system of record, a cache layer for hot reads, a search index for full-text queries, and a data warehouse for analytics. The bar-raiser question is how you keep these in sync: which is the authoritative source, what is the propagation lag, and how do you handle inconsistency. At L6, the interview expects you to discuss eventual consistency semantics explicitly and to quantify the acceptable staleness for each use case. Staff-level concerns include schema governance: who owns the schema, what is the migration strategy for schema changes without downtime, how do you handle the need for a migration that requires multi-hour backfills on a table that is under continuous write load. Internationally, data residency requirements add a storage partitioning concern: user data for EU residents must remain in EU regions, which affects your sharding and replication strategy.
