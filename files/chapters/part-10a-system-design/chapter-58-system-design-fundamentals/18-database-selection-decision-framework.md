# Database Selection Decision Framework

The most common database mistake is picking one before you understand your access patterns. The second most common mistake is choosing NoSQL "for scale" before you have proven you need it. This chapter gives you a concrete framework for picking the right database the first time.

---

## The Core Question

Before choosing a database, answer these four questions:

1. What does a read look like? (simple key lookup, complex join, graph traversal)
2. What does a write look like? (single row, batch, time-series append)
3. What consistency do you need? (ACID transactions, eventual consistency acceptable)
4. What is your data shape? (structured schema, nested documents, relationships)

The answers eliminate most options immediately.

---

## Relational Databases (PostgreSQL, MySQL)

Use relational databases when:

- Your data has clear relationships between entities (users, orders, products).
- You need complex joins across multiple tables.
- You need ACID transactions (atomicity, consistency, isolation, durability).
- Your schema is stable and well-understood upfront.

The killer feature of relational databases is the transaction. A bank transfer that debits one account and credits another either completes entirely or rolls back entirely. That guarantee does not exist natively in most NoSQL databases.

```go
// PostgreSQL transaction in Go
import "database/sql"

func transfer(db *sql.DB, fromID, toID int, amountCents int64) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    _, err = tx.Exec("UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2", amountCents, fromID)
    if err != nil {
        return err
    }
    _, err = tx.Exec("UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2", amountCents, toID)
    if err != nil {
        return err
    }
    return tx.Commit()
}
```

**Good fits:** e-commerce (customers, orders, line items), financial systems, CMS, user management with roles.

**Watch out for:** many-to-many joins at massive scale without caching. Horizontal write scaling requires sharding, which relational databases make complex.

---

## Document Stores (MongoDB)

Use document stores when:

- Data is naturally nested and self-contained (a blog post with embedded comments).
- The schema varies across records (product catalog with wildly different attributes per category).
- You need to iterate fast on schema without migrations.
- You read the whole document most of the time, not individual fields scattered across tables.

```go
// MongoDB driver in Go
import "go.mongodb.org/mongo-driver/mongo"

type Product struct {
    ID          primitive.ObjectID     `bson:"_id,omitempty"`
    Name        string                 `bson:"name"`
    Attributes  map[string]any          `bson:"attributes"` // flexible schema
}

func insertProduct(ctx context.Context, coll *mongo.Collection, p Product) error {
    _, err := coll.InsertOne(ctx, p)
    return err
}

func findProduct(ctx context.Context, coll *mongo.Collection, id primitive.ObjectID) (*Product, error) {
    var p Product
    err := coll.FindOne(ctx, bson.M{"_id": id}).Decode(&p)
    return &p, err
}
```

**Good fits:** product catalogs with variable attributes, content management, user activity logs, event storage.

**Watch out for:** multi-document transactions exist in MongoDB but are slow compared to single-document operations. If your access patterns require frequent multi-entity transactions, you are using the wrong tool.

---

## Key-Value Stores (Redis, Memcached)

Use key-value stores when:

- You need sub-millisecond reads.
- Data is simple: a value behind a key, with no need for queries.
- The use case is caching, session storage, rate limit counters, or leaderboards.

Key-value stores are primarily in-memory. Reading from Redis is 10-100x faster than reading from Postgres for the same data because there is no disk I/O in the hot path.

```go
// Redis via go-redis/v9
import "github.com/redis/go-redis/v9"

rdb := redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Cache a user session
func setSession(ctx context.Context, rdb *redis.Client, token string, userID int) error {
    return rdb.Set(ctx, "session:"+token, userID, 15*time.Minute).Err()
}

// Increment a rate limit counter
func checkRateLimit(ctx context.Context, rdb *redis.Client, ip string) (int64, error) {
    key := "ratelimit:" + ip
    count, err := rdb.Incr(ctx, key).Result()
    if count == 1 {
        rdb.Expire(ctx, key, time.Minute)
    }
    return count, err
}

// Leaderboard using a sorted set
func addScore(ctx context.Context, rdb *redis.Client, userID string, score float64) error {
    return rdb.ZAdd(ctx, "leaderboard", redis.Z{Score: score, Member: userID}).Err()
}
```

**Good fits:** session tokens, caching query results, rate limiting, leaderboards, pub/sub messaging, distributed locks.

**Watch out for:** Redis data is in memory. If the data must survive restarts, configure persistence (AOF or RDB snapshots). Do not treat Redis as your primary database for data you cannot afford to lose.

---

## Wide-Column Stores (Cassandra, DynamoDB)

Use wide-column stores when:

- You have extremely high write throughput (millions of writes per second).
- Your queries are predictable and narrow (always query by partition key).
- You are storing time-series data, IoT sensor readings, or event logs.
- You need geographic distribution with multi-region writes.

Cassandra scales horizontally with no single master. Every node accepts writes. The trade-off is that you must design your schema around your query patterns. You cannot query columns you have not indexed, and cross-partition queries are expensive.

```
-- Cassandra schema designed around the query "get events for user X in time range Y"
CREATE TABLE user_events (
    user_id   UUID,
    event_ts  TIMESTAMP,
    event_type TEXT,
    payload   TEXT,
    PRIMARY KEY (user_id, event_ts)
) WITH CLUSTERING ORDER BY (event_ts DESC);
```

**Good fits:** time-series (metrics, logs, IoT), activity feeds, high-write audit trails, globally distributed data.

**Watch out for:** Cassandra has no joins and no cross-partition transactions. If your access patterns change after launch, you must rebuild tables. Design schema for reads, not for normalization.

---

## Graph Databases (Neo4j)

Use graph databases when:

- Relationships between entities are first-class data, not just foreign keys.
- You need to traverse multi-hop relationships efficiently (friends of friends, product recommendations).
- Queries like "find all nodes reachable within 3 hops" are core to your product.

```cypher
// Find product recommendations based on purchase history
MATCH (u:User {id: $userId})-[:PURCHASED]->(p:Product)
      <-[:PURCHASED]-(similar:User)-[:PURCHASED]->(rec:Product)
WHERE NOT (u)-[:PURCHASED]->(rec)
RETURN rec.name, count(*) AS frequency
ORDER BY frequency DESC LIMIT 10
```

**Good fits:** social networks, recommendation engines, fraud detection (tracing transaction chains), knowledge graphs, access control graphs.

**Watch out for:** graph databases do not replace your primary store. Most systems use a graph database for one specific query type (recommendations, fraud) while keeping relational or document databases for transactional workloads.

---

## Decision Table

| Use case | Recommended database | Why |
|---|---|---|
| E-commerce orders and inventory | PostgreSQL | ACID transactions, joins across customers/products/orders |
| User authentication and profiles | PostgreSQL | Structured schema, ACID for account operations |
| Session tokens | Redis | Sub-millisecond reads, automatic TTL |
| Product search cache | Redis | Cache query results with short TTL |
| Rate limiting | Redis | Atomic increment, per-IP counters |
| Leaderboard | Redis sorted sets | O(log n) sorted insert and range queries |
| Social activity feed | Cassandra | High write throughput, partition by user |
| IoT sensor data | Cassandra | Time-series, high write volume |
| Product catalog with variable fields | MongoDB | Flexible schema per category |
| Content management | MongoDB | Nested documents, schema evolution |
| Product recommendations | Neo4j | Multi-hop graph traversal |
| Fraud detection (transaction chains) | Neo4j | Relationship traversal at depth |
| Analytics aggregations | ClickHouse or BigQuery | Column-oriented, OLAP workloads |

---

## Common Mistakes

**Choosing NoSQL for scale before you need it.** PostgreSQL handles millions of rows and thousands of queries per second on a single machine with proper indexing. Most startups that default to MongoDB because "it scales" end up needing multi-document transactions and fighting the tool.

**Not planning for transactions.** If two operations must succeed or fail together, you need either a relational database with ACID guarantees or a distributed saga pattern. Discovering this after choosing Cassandra or MongoDB is expensive.

**Schema-free means schema-later.** Document stores do not enforce a schema, but your application code does. You will write validation and migration code anyway. You just do it in Go instead of SQL.

**Using a key-value store as a primary database.** Redis losing data on restart, or running out of memory, is a production incident. Cache what you can afford to rebuild, do not cache what you cannot.

**Watch:** [System Design Course](https://www.youtube.com/watch?v=C842vFY5kRo)
