## 37E.2 Data Modeling: Query-First Design

### CQL Data Types and Keyspace

Cassandra schema design must start with the access patterns: each table is denormalized around a single query, and the partition key determines which node owns the data. The keyspace replication strategy (`NetworkTopologyStrategy`) and replication factor control how many copies exist per datacenter, which directly affects write latency and read consistency guarantees.

```cql
-- Keyspace: equivalent to a database
CREATE KEYSPACE IF NOT EXISTS ecommerce
WITH REPLICATION = {
  'class': 'NetworkTopologyStrategy',
  'us-east': 3,
  'eu-west': 2
}
AND DURABLE_WRITES = true;

USE ecommerce;

-- Wide column table anatomy:
-- PRIMARY KEY = (partition_key, clustering_columns)
-- Partition key: determines which node stores the data
-- Clustering columns: sort order within a partition

-- User profile: partition by user_id (UUID - high cardinality, no hotspot)
CREATE TABLE IF NOT EXISTS users (
  user_id      UUID,
  email        TEXT,
  name         TEXT,
  created_at   TIMESTAMP,
  metadata     MAP<TEXT, TEXT>,
  tags         SET<TEXT>,
  profile_vec  VECTOR<FLOAT, 384>,   -- Cassandra 5.0 vector type (semantic search)
  PRIMARY KEY (user_id)
) WITH compression = {'class': 'LZ4Compressor'}
  AND gc_grace_seconds = 864000;  -- 10 days

-- Cassandra 5.0: Storage-Attached Index (SAI) replaces legacy 2i (secondary indexes)
-- SAI scales with data, supports numeric ranges, text equality, and vector ANN search
CREATE INDEX IF NOT EXISTS users_email_sai ON users (email) USING 'sai';
CREATE INDEX IF NOT EXISTS users_vec_sai   ON users (profile_vec)
  USING 'sai' WITH OPTIONS = {'similarity_function': 'cosine'};
-- Query: SELECT user_id, name FROM users ORDER BY profile_vec ANN OF ? LIMIT 10;

-- Orders by user: query pattern = "get orders for user, sorted by date desc"
CREATE TABLE IF NOT EXISTS orders_by_user (
  user_id     UUID,
  created_at  TIMESTAMP,
  order_id    UUID,
  status      TEXT,
  total_cents BIGINT,
  items       LIST<FROZEN<order_item>>,
  PRIMARY KEY (user_id, created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id ASC)
  AND default_time_to_live = 7776000  -- 90 days TTL
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 1};

-- User-defined type
CREATE TYPE IF NOT EXISTS order_item (
  product_id  UUID,
  name        TEXT,
  price_cents BIGINT,
  quantity    INT
);

-- Orders by status: query pattern = "get pending orders for processing"
-- WARNING: "status" has low cardinality → hotspot if used as partition key alone
-- Solution: bucket with status + date
CREATE TABLE IF NOT EXISTS orders_by_status_date (
  status      TEXT,
  date_bucket DATE,           -- YYYY-MM-DD (limits partition size)
  created_at  TIMESTAMP,
  order_id    UUID,
  user_id     UUID,
  total_cents BIGINT,
  PRIMARY KEY ((status, date_bucket), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id ASC);

-- Time-series: IoT sensor data
-- Bucket by (sensor_id, day) to cap partition size
-- ~86400 readings/day per sensor = manageable partition
CREATE TABLE IF NOT EXISTS sensor_readings (
  sensor_id   UUID,
  day         DATE,
  timestamp   TIMESTAMP,
  temperature FLOAT,
  humidity    FLOAT,
  pressure    FLOAT,
  PRIMARY KEY ((sensor_id, day), timestamp)
) WITH CLUSTERING ORDER BY (timestamp DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 7}
  AND default_time_to_live = 2592000;  -- 30 days

-- Materialized view (or manual denormalization)
-- Pattern: same data, different access pattern
CREATE TABLE IF NOT EXISTS orders_by_id (
  order_id    UUID,
  user_id     UUID,
  created_at  TIMESTAMP,
  status      TEXT,
  total_cents BIGINT,
  items       LIST<FROZEN<order_item>>,
  PRIMARY KEY (order_id)
);
```

### Modeling Relationships (Denormalization)

Cassandra does not support server-side joins, so relationships must be modeled by duplicating data across multiple tables, one table per query pattern. The rules below govern when to denormalize, how to size partition keys, and how to avoid the tombstone and hot-partition pitfalls that result from naïve relational-to-Cassandra migrations.

```
Cassandra Data Modeling Rules:
═══════════════════════════════

1. Start with queries, not entities
2. Denormalize: duplicate data to avoid JOINs
3. Never model relationships as foreign keys
4. Each table = one query pattern
5. Cap partitions at ~100 MB / 100k rows; bucket by time or hash to enforce this
6. Use SAI (Cassandra 5.0) for low-selectivity secondary lookups inside a partition;
   never treat a 2i as a global index: it still queries every node

Example: Social feed system
Query: "get timeline for user X, newest first"

BAD approach (relational thinking):
  users(user_id, ...)
  follows(follower_id, followee_id)
  posts(post_id, author_id, ...)
  → Need 3-table JOIN impossible in Cassandra

GOOD approach (query-first):
  timeline_by_user (
    user_id UUID,          -- partition: all posts for this user's feed
    post_time TIMESTAMP,   -- cluster: newest first
    post_id UUID,
    author_id UUID,
    author_name TEXT,      -- denormalized!
    content TEXT,
    PRIMARY KEY (user_id, post_time, post_id)
  ) WITH CLUSTERING ORDER BY (post_time DESC, post_id ASC)

Fan-out on write: when author posts, insert into each follower's timeline partition
```

### Junior → FAANG: Prerequisite Gaps and Worked Entry Points

The single concept a junior must internalise before writing any CQL is the difference between the partition key, the clustering key, and the regular columns. The partition key is the argument to Murmur3 that decides which node stores the row. The clustering key decides the sort order inside that partition. Regular columns are payload. The compound expression `PRIMARY KEY ((a, b), c, d)` means a and b together form the partition key (both must be provided with equality in every query), c and d are clustering columns (c first, then d), and the rest are payload. `PRIMARY KEY (a, b, c)` means a alone is the partition key and b, c are clustering columns. That one pair of parentheses changes the physical layout and the allowed queries.

A worked junior exercise is to take the `orders_by_user` table above and answer five questions. Can I query all orders for a single user in the last thirty days. Yes, `WHERE user_id = ? AND created_at >= ?`. Can I query all pending orders across all users. Not from this table. You need `orders_by_status_date`. Can I update the status of an order using this table. Yes if you know user_id and created_at, otherwise you need `orders_by_id`. What happens if a user places one million orders. That partition grows past the one hundred megabyte soft cap and queries slow down. The fix is to add a `year_month` bucket to the partition key. What happens if I delete an order by user_id and created_at. A tombstone is written and lives for gc_grace_seconds, and reads over the deleted range pay a tombstone scan cost. If you can answer those five questions you understand query first modeling.

The junior level interview question is almost always a schema design on a whiteboard. Given a product requirement like store chat messages for a messaging app with channels that can have millions of messages and pagination by timestamp, the expected answer is `messages_by_channel ((channel_id, bucket), sent_at DESC, message_id)` where bucket is a day or hour depending on channel volume. Get the bucketing right and you have shown staff track potential.

### Senior @ FAANG: Staff and Principal Framing

Senior data modeling in Cassandra is an exercise in explicit partition size budgeting, tombstone avoidance, and write amplification accounting. Start with the partition size budget. The soft cap is one hundred megabytes and the hard engineering target is ten megabytes for latency sensitive reads, because a read must deserialize the partition index, scan the bloom filter, and potentially touch multiple SSTables under STCS or UCS. Size = rows per partition times average row size. For a user timeline at fifty posts per day with five hundred bytes per post, one user generates roughly nine megabytes per year, so a `((user_id, year), posted_at DESC)` bucketing keeps partitions bounded. For a high frequency sensor at one thousand samples per second with thirty bytes per sample, one sensor generates 2.6 gigabytes per day, so the bucket must be minute level or finer. The failure mode of getting this wrong is silent. Writes stay fast because they are append only, but reads degrade linearly with partition size and eventually timeout. The staff level discipline is to write down the partition size formula in the schema comment for every table, alongside the access pattern it serves.

Partition key design beyond cardinality has three traps. First, the celebrity problem where one key is orders of magnitude hotter than others. A product partition for Amazon's top selling item, a user partition for a viral TikTok account, a currency partition for USD in a forex ticker. The fix is a salted key `((entity_id, bucket), ts)` where bucket is `hash(something) mod N` and reads fan out across the N buckets. You pay a scatter gather on read in exchange for even distribution on write. Second, monotonically increasing keys like timestamps or sequential IDs as the sole partition key, which send every new write to the same node and cause write hotspots. Third, low cardinality keys like status or country code which cause wide partitions. Clustering column design is about on disk order. `CLUSTERING ORDER BY (ts DESC)` stores newest first on disk, which makes `SELECT ... LIMIT 10` a contiguous read. `CLUSTERING ORDER BY (ts ASC)` stores oldest first, which makes newest first queries a reverse scan that is measurably slower. You pick once at table creation.

Composite keys, static columns, and tuples are specific tools. Composite partition keys `((tenant_id, entity_id))` are used for multi tenant isolation where you want every query to be tenant scoped at the partition level. Static columns are shared across all rows in a partition and are used for partition level metadata like the last updated timestamp of a user's timeline without replicating it across every post row. Frozen UDTs and frozen collections are stored as a single blob that is replaced on update, which is the right choice for small immutable structures. Non frozen collections allow per element updates but are implemented as a range of cells with one tombstone per delete, and they are the leading cause of tombstone poisoning in naive schemas. The senior rule is never use a non frozen map or set unless you have measured the update rate and confirmed the tombstone budget.

Materialized views are a feature that looks attractive and ships with documented consistency bugs. A materialized view is a server maintained denormalization from a base table to a view table keyed differently, and under partition or failure scenarios the view can diverge from the base. For any table where divergence would be a correctness incident (payments, account balances, inventory), the senior level choice is to maintain the denormalization in application code with an idempotent write path, typically by issuing the base write and the view writes as parallel async `session.Query(...).Exec()` calls inside a single request handler, with a reconciliation job that reads the base table and repairs the view table on a schedule. LOGGED batches across the base and view tables give you atomicity at the cost of roughly halving write throughput, and that tradeoff is worth it only when the denormalization set is small.

Secondary indexes in Cassandra 5.0 are SAI and they are a real improvement, but they still scale with partition count not index selectivity. A SAI on email in a users table with one billion users fans the query out to every node because the partition key is user_id not email. SAI is useful inside a known partition to filter on a low cardinality column, or as a fallback for low frequency admin queries. It is never the primary access path for a high QPS read. For high QPS lookups by a non partition column, the senior level answer is always another table keyed by that column, populated by application level fan out on write or by an asynchronous CDC pipeline.

TTL first modeling means you set default_time_to_live at the table level and the column level as appropriate, and you design the compaction strategy so that entire SSTables expire together. TWCS is the correct choice for append only time series with TTL, because it groups writes by time window into separate SSTables and drops the whole SSTable when its window exceeds TTL, generating zero tombstones. TWCS misuse happens when the table has updates or deletes across time windows, which defeats the grouping and produces permanent read amplification. The rule is TWCS for pure append only with uniform TTL, UCS for everything else in Cassandra 5.0, and never mix explicit DELETE with TWCS. Time window partitioning is the natural companion: the partition key embeds the time bucket, reads specify the bucket range, and historical buckets eventually drop off disk automatically.

---
