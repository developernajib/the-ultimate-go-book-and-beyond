## 37B.2 B-Tree Index Internals

### What a B-Tree Is (Not a Binary Tree)

A **B-tree** (Balanced tree, invented by Bayer and McCreight in 1972) is a self-balancing search tree designed for storage systems where reading a node is expensive (disk I/O). Unlike a binary tree where each node has at most 2 children, a B-tree node can have hundreds of children.

Key properties:
- Every leaf is at the same depth (perfectly balanced)
- Each node has up to `m` children and up to `m - 1` keys, with at least `⌈m/2⌉` children (where `m` is the order)
- Search, insertion, and deletion are all `O(log n)`
- Nodes map directly to disk pages (e.g., 8KB in PostgreSQL)

```
B-Tree of order 5 (up to 4 keys per node, up to 5 children):

                    [30 | 70]
                   /    |    \
          [10|20]    [40|50|60]    [80|90]
          / | \      /  |  |  \    /  |  \
        [.][.][.]  [.][.][.][.]  [.][.][.]
```

### B+ Tree: The Variant Databases Actually Use

PostgreSQL (and almost every other RDBMS) uses a **B+ Tree**, a variant with one critical difference:

- **Internal nodes** store only keys (routing information)
- **Leaf nodes** store keys + data (or pointers to heap rows)
- **Leaf nodes are linked** in a doubly-linked list for range scans

```
B+ Tree Structure:

Internal nodes (keys only, for routing):
                    [30 | 70]
                   /    |    \
          [10|20]    [40|50|60]    [80|90]

Leaf nodes (keys + TIDs, linked list):
[10,p1|20,p2] <-> [30,p3|40,p4|50,p5] <-> [60,p6|70,p7] <-> [80,p8|90,p9]
         ^                                                              ^
       head                                                           tail

p1..p9 = heap tuple identifiers (ctid): (page_number, slot_number)
```

The linked leaf list is what makes range scans efficient. Once you find the starting leaf, you walk the list without touching internal nodes again.

> **Senior track**: Most production OLTP databases (PostgreSQL, MySQL InnoDB, SQL Server, Oracle, SQLite) use B+tree variants, not classical B-trees. The distinction matters in interviews: saying "PostgreSQL uses a B-tree" is technically imprecise. The variant is B+tree with sibling pointers (Lehman-Yao for concurrent access in PostgreSQL). InnoDB goes further: its clustered index is a B+tree whose leaves hold the full row, so the primary key index is the table itself, and secondary indexes store primary key values (not heap pointers) to cope with row movement.

### How B-Tree Insertion Works (Splits)

When a new key arrives, PostgreSQL walks from the root to the correct leaf page using binary search at each level. If the leaf has room, the key is inserted in sorted order. If not, the page splits: half the keys stay on the original page, half move to a new page, and a separator key is pushed up to the parent. If the parent also overflows, the split propagates upward. In the worst case, the root itself splits, and the tree grows one level taller. PostgreSQL uses a configurable fill factor (default 90% for B-tree indexes) to leave headroom on pages, reducing the frequency of splits for workloads with sequential inserts.

```
Insert 35 into this B+ tree (order 3, max 2 keys per node):

Before:
Internal: [30]
Leaves:   [10|20] <-> [30|40]

Step 1: Find correct leaf → [30|40]
Step 2: Insert 35 → [30|35|40] - OVERFLOW (max 2 keys)
Step 3: Split leaf:
  Left:  [30|35]
  Right: [40]
Step 4: Push middle key (40) up to parent:
Internal: [30|40]
Leaves:   [10|20] <-> [30|35] <-> [40]

If parent also overflows, split propagates upward.
If root splits, tree grows one level taller.
```

**Performance implication**: Sequential inserts (auto-increment IDs) only ever append to the rightmost leaf. Only the rightmost page is "hot." Random inserts (UUIDs) cause splits across the entire tree, fragmenting pages and causing more I/O.

### How B-Tree Deletion Works (Merges and Redistributions)

In a textbook B-tree, deleting a key that causes a page to fall below the minimum fill triggers either a redistribution (borrowing keys from a sibling) or a merge (combining two underfull siblings). PostgreSQL takes a lazier approach: it marks deleted index entries as dead but does not immediately remove them or merge pages. The `VACUUM` process later reclaims these dead entries. This means heavily-deleted indexes accumulate bloat over time. You can inspect index health using the `pageinspect` extension and the `pg_stat_user_indexes` view to track dead tuple accumulation and decide when to run `REINDEX CONCURRENTLY`.

```sql
-- Create a table and index
CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    status      TEXT NOT NULL,
    amount_cents BIGINT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_user_id ON orders (user_id);

-- Inspect index internals using pageinspect extension
CREATE EXTENSION IF NOT EXISTS pageinspect;

-- View B-tree meta page
SELECT * FROM bt_metap('idx_orders_user_id');
-- Returns: magic, version, root page, level (height), fastroot, etc.

-- View internal node contents
SELECT * FROM bt_page_items('idx_orders_user_id', 1);
-- Returns: itemoffset, ctid (pointer), itemlen, nulls, vars, data (key value)

-- View leaf node contents
SELECT * FROM bt_page_items('idx_orders_user_id', bt_metap('idx_orders_user_id').root);
```

```sql
-- Check index size vs table size
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
    pg_size_pretty(pg_indexes_size(schemaname||'.'||tablename)) AS index_size
FROM pg_tables
WHERE tablename = 'orders';

-- Check index bloat (dead entries)
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename = 'orders';
```

### When B-Tree Indexes Shine vs Struggle

**B-tree excels at:**
- Equality lookups: `WHERE id = 42`
- Range scans: `WHERE created_at BETWEEN x AND y`
- Ordered results: `ORDER BY id` (can avoid sort step)
- `IS NULL` / `IS NOT NULL`
- `LIKE 'prefix%'` (left-anchored only)

**B-tree struggles with:**
- `LIKE '%suffix'` or `LIKE '%middle%'` - cannot use index
- Array containment: `WHERE tags @> '{go, postgres}'` - use GIN
- Full-text search: `WHERE to_tsvector(body) @@ query` - use GIN
- Geometric queries: `WHERE point <@ circle` - use GiST
- Very low cardinality columns: `WHERE status IN ('active', 'inactive')` - seq scan often faster
- Write-heavy workloads with random keys (UUIDs) - high split rate

### Multi-Column B-Tree Indexes (Column Order Matters!)

A multi-column B-tree sorts entries by the first column, then by the second column within ties, and so on. This makes column order critical: the index is only usable when the query filters on a left prefix of the indexed columns. Choosing the wrong column order is one of the most common indexing mistakes in production systems.

```sql
-- This index:
CREATE INDEX idx_orders_user_status ON orders (user_id, status);

-- Supports these queries efficiently:
WHERE user_id = 5                          -- leading column, yes
WHERE user_id = 5 AND status = 'active'   -- both columns, yes
WHERE user_id BETWEEN 1 AND 100           -- range on leading column, yes

-- Does NOT efficiently support:
WHERE status = 'active'                   -- skips leading column, seq scan
WHERE status = 'active' AND user_id = 5  -- same, optimizer may reorder but...
```

**The rule**: A multi-column index can be used for a query if the query's WHERE clause includes a **prefix** of the index columns (consecutive from the left). Once a range condition appears, subsequent columns cannot be used for filtering (only for index-only scans).

```
Index: (a, b, c)

Query: WHERE a = 1 AND b = 2 AND c = 3   → uses all 3 columns
Query: WHERE a = 1 AND b = 2             → uses 2 columns
Query: WHERE a = 1                       → uses 1 column
Query: WHERE a = 1 AND b > 5 AND c = 3  → uses a (equality) + b (range), c skipped
Query: WHERE b = 2                       → cannot use index (no leading a)
```

### Index-Only Scans

When all columns needed by a query are present in the index (including SELECT columns), PostgreSQL can answer the query from the index alone without touching the heap. This is called an **index-only scan** and is dramatically faster.

```sql
-- This index includes both columns needed by the query:
CREATE INDEX idx_orders_user_amount ON orders (user_id, amount_cents);

-- This query can use an index-only scan:
SELECT amount_cents FROM orders WHERE user_id = 42;
-- PostgreSQL reads only the index, never touches the 8KB heap pages

-- EXPLAIN confirms:
EXPLAIN SELECT amount_cents FROM orders WHERE user_id = 42;
-- Index Only Scan using idx_orders_user_amount on orders
--   Index Cond: (user_id = 42)
--   Heap Fetches: 0   ← zero heap reads
```

**Caveat**: MVCC visibility. PostgreSQL maintains a **visibility map** per table. Pages marked "all-visible" allow true index-only scans. Pages not yet vacuumed require a heap fetch to verify tuple visibility. Heavy write workloads prevent index-only scans from working effectively until autovacuum runs.

### Go Code: Observing B-Tree Behavior with EXPLAIN ANALYZE

The following Go code wraps `EXPLAIN (ANALYZE, BUFFERS)` in a reusable function. It executes the target query, captures the plan output, and parses out planning and execution times. The `DetectSeqScan` helper flags plans that contain sequential scans, which often indicate a missing or unused index.

```go
package dbinternals

import (
    "context"
    "fmt"
    "strings"

    "github.com/jackc/pgx/v5/pgxpool"
)

// ExplainResult holds parsed EXPLAIN ANALYZE output.
type ExplainResult struct {
    Plan          string
    PlanningTime  string
    ExecutionTime string
    Lines         []string
}

// ExplainAnalyze runs EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) on a query
// and returns the plan. Use only in development/staging - never production
// without understanding the overhead (query actually executes).
func ExplainAnalyze(ctx context.Context, pool *pgxpool.Pool, query string, args ...any) (*ExplainResult, error) {
    explainQuery := fmt.Sprintf(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) %s",
        query,
    )

    rows, err := pool.Query(ctx, explainQuery, args...)
    if err != nil {
        return nil, fmt.Errorf("explain analyze: %w", err)
    }
    defer rows.Close()

    var lines []string
    for rows.Next() {
        var line string
        if err := rows.Scan(&line); err != nil {
            return nil, fmt.Errorf("scan explain row: %w", err)
        }
        lines = append(lines, line)
    }
    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("explain rows: %w", err)
    }

    result := &ExplainResult{
        Plan:  strings.Join(lines, "\n"),
        Lines: lines,
    }

    // Extract timing from last two lines
    for _, line := range lines {
        if strings.HasPrefix(line, "Planning Time:") {
            result.PlanningTime = strings.TrimPrefix(line, "Planning Time: ")
        }
        if strings.HasPrefix(line, "Execution Time:") {
            result.ExecutionTime = strings.TrimPrefix(line, "Execution Time: ")
        }
    }

    return result, nil
}

// DetectSeqScan returns true if the plan contains a sequential scan,
// which may indicate a missing index.
func DetectSeqScan(result *ExplainResult) bool {
    return strings.Contains(result.Plan, "Seq Scan")
}

// Usage example:
func investigateQuery(ctx context.Context, pool *pgxpool.Pool) {
    result, err := ExplainAnalyze(ctx, pool,
        "SELECT * FROM orders WHERE user_id = $1 AND status = $2",
        42, "active",
    )
    if err != nil {
        panic(err)
    }

    fmt.Println(result.Plan)

    if DetectSeqScan(result) {
        fmt.Println("WARNING: Sequential scan detected - consider adding an index")
    }
}
```

### Junior to FAANG: Worked Examples and Interview Entry Point

The single most useful mental exercise for a junior engineer learning B-trees is to sit down and compute the fanout of a real index. Take an 8 KB Postgres page, subtract the 24 byte page header and a small amount of per-item overhead, and assume your index key is a 16 byte UUID plus an 8 byte TID. Each index entry is roughly 28 bytes with headers. An 8 KB page then holds about 290 entries. With a fanout of 290 a three-level B-tree covers 290 to the third power, which is roughly 24 million rows. A four-level B-tree covers 290 to the fourth, which is seven billion rows. This is why B-trees almost never have more than four levels in practice and why a point lookup on any real-world table costs three or four page reads. Memorize that arithmetic and you can back-of-envelope any index sizing question in an interview.

A common worked example you will see phrased as "why did adding this index not help". Setup: a `logs` table with a `level` column that is 95 percent `INFO`. A junior adds `CREATE INDEX ON logs(level)` and is confused when `WHERE level = 'INFO'` still runs a sequential scan. The explanation walks through selectivity. The planner sees `pg_stats` reports `n_distinct = 4` and `most_common_freqs = {0.95, 0.03, 0.015, 0.005}`. For `level = 'INFO'` it estimates 95 percent of rows match, so using the index would require fetching almost every heap page in random order anyway, which is slower than a sequential scan of the same heap. A junior who can narrate that reasoning, name `pg_stats`, and propose a partial index `WHERE level <> 'INFO'` as the fix is operating at the mid-level bar.

The interview entry-point for this section is almost always "walk me through what happens when I insert a row into a table with three indexes". The staircase answer is: acquire a lock on the target heap page, write the new tuple to the heap, emit a heap insert WAL record, then for each of the three indexes descend to the correct leaf, insert the index entry (splitting the leaf and propagating up if needed), and emit a btree insert WAL record. The client sees success only once the WAL flush for the commit returns. That sequence, narrated fluently with the words fanout, page split, and WAL record in the right places, is the difference between a pass and a fail on most Postgres-focused interview loops.

### Senior at FAANG: B+Tree Internals at Depth

At senior level the interesting surface area of B-trees is not the happy path, it is the pathologies and the engine-specific details that determine how the tree behaves under real workloads. Start with fill factor. Postgres defaults B-tree indexes to a fill factor of 90 percent, which means on initial build each leaf is packed to 90 percent and the other 10 percent is reserved for later inserts without splits. For append-only workloads with a monotonic key (BIGSERIAL, UUIDv7, snowflake IDs) this is nearly optimal because all inserts land at the rightmost leaf, which Postgres handles with a special "fastpath" rightmost-insert optimization that avoids the full root-to-leaf descent. For random key workloads (UUIDv4, hashed identifiers) the fill factor is almost irrelevant because inserts distribute uniformly and pages split roughly half-full, producing a long-run average fill factor closer to 70 percent and 40 percent index bloat relative to a sequentially built index of the same logical size.

Page splits themselves have a cost that is easy to underestimate. A split emits a WAL record for the new page, a WAL record for the redistributed old page, and a WAL record for the parent pointer update, plus any splits propagated upward. Under random-key write load this roughly triples WAL volume compared to sequential inserts of the same row count. A staff engineer debugging unexpectedly high WAL generation on a UUID-keyed table should recognize this as the mechanical cause, and the fix is almost always to switch the key to a time-ordered format like UUIDv7 rather than tune WAL parameters.

Heap-only tuple (HOT) updates are a Postgres-specific optimization that every senior engineer working with Postgres needs to know cold. When an UPDATE changes only columns that are not indexed, and the new tuple fits on the same 8 KB heap page as the old tuple, Postgres can create a HOT chain: the old tuple points to the new tuple via `t_ctid`, and no index entries are created or updated. The indexes continue to point at the old tuple, and index scans follow the HOT chain to the current visible version. This avoids the index bloat that would otherwise accompany updates and is the single most important reason to leave fill factor room on update-heavy tables (tune `fillfactor` to 70 or 80 on hot tables to give HOT updates space to work). When HOT cannot apply, every UPDATE becomes an effective DELETE plus INSERT on every index, which is how a naive schema with many indexes turns a modest write rate into unmanageable index bloat.

Leaf-level bidirectional linkage matters for concurrency. Postgres uses the Lehman-Yao B-link tree variant where each leaf page carries a right-sibling pointer and a "high key" that describes the largest key that could live on that page. This allows concurrent readers to descend without locking the entire root-to-leaf path. If a reader finds the key they want is greater than the page high key they follow the right pointer to the next leaf, which may have been added by a concurrent splitter. The practical consequence is that Postgres B-tree index scans do not block on concurrent inserts except at the single leaf page being split, which is why you can build a reasonable write-throughput system on Postgres without resorting to hash indexes or LSM engines for most workloads.

The clustered versus non-clustered distinction is where InnoDB and Postgres diverge sharply. InnoDB stores the table rows inside the B+tree of the primary key. The primary key index is the table. Secondary indexes store the primary key value as the row pointer, not a physical TID, which means a secondary index lookup costs two B-tree descents (once in the secondary, once in the primary) and which also means row movement on primary key updates requires no secondary index maintenance. Postgres takes the opposite approach. The heap is a separate, unordered file of tuples, and every index (including the primary key) stores a TID pointing into the heap. The cost is that heap access on index scans is a random read into a separate file. The benefit is that every index is symmetric with every other, there is no distinction between primary and secondary, and update-in-place HOT is possible where InnoDB would have to rewrite the clustered index entry. Interview signal: if a candidate says "the primary key is the table" and knows that is true for InnoDB but not Postgres, they are operating at senior level on this material.

The operational consequences of the heap+index split in Postgres are significant. Because the heap is unordered, range scans on a secondary index that returns many rows degenerate to random I/O across the heap, which is much slower than the equivalent InnoDB scan that reads the clustered index sequentially. The Postgres answer is the `CLUSTER` command, which rewrites the heap in index order, or BRIN indexes for very large tables where physical ordering correlates with the indexed column (time-ordered event tables are the canonical fit). The InnoDB answer is different: choose a primary key that groups related rows (multi-tenant ID first, then time), because the clustered index physically colocates them. Getting this primary key choice wrong on InnoDB is a multi-order-of-magnitude mistake on range scan performance and one of the most common reasons MySQL migrations from small to large scale fail without a schema redesign.

Two more details to internalize at staff level. First, the `INCLUDE` clause on Postgres 11+ creates covering indexes where the included columns are stored at the leaf but not in the key, which enables index-only scans without bloating the internal nodes. This is the correct tool when you want an index-only scan but the covered columns are large and not worth keying on. Second, `REINDEX CONCURRENTLY` on Postgres 12+ rebuilds an index without taking an exclusive lock, by building a new index alongside the old one and swapping under a brief exclusive lock at the end. It is the correct remedy for established index bloat on write-heavy indexes, and the incorrect remedy is VACUUM FULL which locks the table for the duration of the rebuild. A staff engineer who owns a Postgres fleet should have a runbook entry that says "if pg_stat_user_indexes reports idx_scan high and pg_relation_size greatly exceeds the theoretical size for the row count, schedule REINDEX CONCURRENTLY off-peak" and the runbook should be executed by the on-call rotation without escalation.

---
