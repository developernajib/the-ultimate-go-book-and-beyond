## 58.5 Database Design

### SQL vs NoSQL Decision Matrix

Choosing between SQL and NoSQL databases is one of the most consequential early architectural decisions, as it shapes data modeling, query patterns, consistency guarantees, and operational complexity for the lifetime of the system. SQL databases offer ACID transactions, complex join queries, and strong schema enforcement, making them the right default for financial data, complex relational domains, and applications where correctness is paramount. NoSQL databases trade schema flexibility and horizontal scalability against weaker consistency guarantees, making them appropriate for high-throughput write workloads, document-centric data, and time-series data where eventual consistency is acceptable.

```
┌─────────────────┬──────────────────┬──────────────────┐
│    Factor       │       SQL        │      NoSQL       │
├─────────────────┼──────────────────┼──────────────────┤
│ Data Structure  │ Fixed schema     │ Flexible schema  │
│ Relationships   │ Complex joins    │ Denormalized     │
│ ACID            │ Full support     │ Varies           │
│ Scale           │ Vertical first   │ Horizontal first │
│ Query Language  │ SQL              │ Varies by type   │
│ Consistency     │ Strong           │ Eventual (often) │
│ Use Cases       │ Transactions,    │ High throughput, │
│                 │ Complex queries  │ Flexible data    │
└─────────────────┴──────────────────┴──────────────────┘

NoSQL Types:
┌─────────────────┬──────────────────┬──────────────────┐
│     Type        │    Examples      │    Best For      │
├─────────────────┼──────────────────┼──────────────────┤
│ Document        │ MongoDB, Couch   │ Content mgmt     │
│ Key-Value       │ Redis, DynamoDB  │ Caching, session │
│ Wide-Column     │ Cassandra, HBase │ Time series      │
│ Graph           │ Neo4j, Neptune   │ Relationships    │
└─────────────────┴──────────────────┴──────────────────┘
```

### Index Design

Indexes trade write overhead and storage for faster reads, so designing them incorrectly is one of the most common sources of production performance regressions. The column order in a composite index is critical because the query planner can only use a left-to-right prefix: an index on `(status, created_at)` accelerates queries that filter by `status` alone or by both columns, but cannot efficiently answer a query that filters only on `created_at` without `status`. Covering indexes go a step further by including all projected columns directly in the index structure, eliminating the secondary lookup back to the heap, a technique that can reduce query cost from an index scan plus N heap fetches to a single index-only scan, which is especially impactful for high-frequency read queries on large tables.

```go
// Index design considerations

// 1. B-Tree indexes (default in most databases)
// Good for: equality, range queries, sorting
// CREATE INDEX idx_user_email ON users(email) - 
// 2. Composite indexes
// Order matters! Left-to-right prefix matching
// CREATE INDEX idx_user_status_created ON users(status, created_at) - // Supports:
//   - WHERE status = 'active'
//   - WHERE status = 'active' AND created_at > '2024-01-01'
// Does NOT efficiently support:
//   - WHERE created_at > '2024-01-01' (without status)

// 3. Covering indexes
// Include all columns needed by query to avoid table lookup
// CREATE INDEX idx_user_covering ON users(email) INCLUDE (name, created_at) - 
// Query optimization example
type QueryOptimizer struct {
    db *sql.DB
}

// Before optimization: Full table scan
func (q *QueryOptimizer) SlowQuery(status string) ([]User, error) {
    // Missing index on status
    query := `SELECT * FROM users WHERE status = $1`
    rows, err := q.db.Query(query, status)
    // ...
}

// After optimization: Index scan
func (q *QueryOptimizer) FastQuery(status string) ([]User, error) {
    // With index: CREATE INDEX idx_status ON users(status) -     query := `SELECT id, name, email FROM users WHERE status = $1`
    rows, err := q.db.Query(query, status)
    // ...
}

// Explain analyze to understand query plans
func (q *QueryOptimizer) AnalyzeQuery(query string) (string, error) {
    row := q.db.QueryRow("EXPLAIN ANALYZE " + query)
    var plan string
    err := row.Scan(&plan)
    return plan, err
}
```

### Junior → FAANG: Database Selection and Index Basics

The SQL versus NoSQL decision is one of the most common early-interview questions, and the most common mistake is framing it as a preference rather than a requirements-driven decision. Interviewers at FAANG want to hear specific access patterns that justify the choice, not general statements like "NoSQL is more scalable."

A useful decision framework for interviews: start with SQL and default to PostgreSQL. Justify a NoSQL choice only when you can name a specific requirement that SQL cannot satisfy at the required scale or with the required schema flexibility. Examples: "The document structure varies per record and is deeply nested, which would require dozens of nullable columns in a relational schema" justifies a document store. "We need 1 million writes per second with linear horizontal scalability" justifies a wide-column store. "We need to traverse friend-of-friend relationships three hops deep in real time" justifies a graph database.

Index design is a topic where interviewers can reliably separate candidates who have worked with production databases from those who have only read about them. Know left-to-right prefix matching for composite indexes. Know what a covering index is and when to use it. Know that adding an index to a write-heavy table has a cost (every write updates every index). And know how to interpret a `EXPLAIN ANALYZE` output at a basic level. A candidate who says "I would add an index on status and check the query plan to verify it is being used" is demonstrating practical database experience.

### Senior @ FAANG: Database Architecture Governance and Index Engineering

At staff level, database decisions are some of the most consequential and hardest to reverse choices you will make. A wrong database selection can require a full data migration, which at FAANG scale can take months, be executed by multiple teams, and carry significant risk of data loss or inconsistency.

**Database selection ADRs with migration triggers.** Every database selection should have a documented ADR that includes: the access patterns it is optimized for, the scale at which the chosen database is expected to be a bottleneck, and the migration path at that point. This last element is frequently omitted and frequently needed. A PostgreSQL primary that handles writes up to 50,000 rows per second is fine for most early-stage services. What happens at 200,000 rows per second? The ADR should name the trigger (write latency p99 exceeds 20ms, or replica lag exceeds 1 minute) and the migration target (sharded Postgres, Vitess, or a move to a wide-column store), even if that migration is 18 months away.

**Index engineering at scale.** Index design is not a one-time decision. Indexes should be reviewed whenever the query workload changes, which happens at every major feature addition. At FAANG scale, production databases have query performance monitoring (pg_stat_statements in PostgreSQL, slow query logs in MySQL) that surfaces the top-N slowest queries weekly. An L6 engineer reviews this report regularly and drives index changes through a proper schema migration process, never applied directly to production. The migration process includes: running `EXPLAIN ANALYZE` on a replica with production data, validating that the new index is used, measuring write throughput impact on the replica, and using `CREATE INDEX CONCURRENTLY` (or equivalent) to avoid table locks.

**Schema migration governance.** At scale, schema migrations are operational events that require coordination across multiple teams. A migration that adds a column to a table with 500 million rows, depending on the database and whether it is truly online, can lock the table or cause replication lag for minutes. At the staff level, you define the migration standards: all migrations must be backward-compatible (new columns must be nullable or have defaults that work for the old application version), migrations must be tested on a production-sized replica, and the on-call engineer for the database team must be notified before any migration runs in production. These standards prevent incidents where a developer runs `ALTER TABLE` directly in production without understanding the blocking behavior.

**Denormalization decisions and their governance.** Wide-column and document stores require explicit denormalization decisions. Data is stored in the shape of its most common read query, which means writes must update multiple locations to keep denormalized copies consistent. This is a correctness contract: if the payment service writes to a `payments` table and the order service reads denormalized payment status from an `orders` table, there must be an explicit process that keeps them in sync, whether that is a synchronous dual-write, an async event, or a materialized view. At L7, you define the organization-wide standard for how denormalization is managed, documented, and monitored, because ad hoc dual-write patterns are one of the most common sources of data inconsistency at scale.

---
