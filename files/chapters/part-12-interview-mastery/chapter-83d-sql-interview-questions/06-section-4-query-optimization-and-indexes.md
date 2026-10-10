## 83D.6 Section 4: Query Optimization and Indexes

### Index Strategies

Query optimization separates candidates who understand database internals from those who can only write correct SQL, a distinction that distinguishes senior from mid-level engineers in technical interviews. The following examples demonstrate execution plan analysis, index selection reasoning, and the rewrite patterns that eliminate full table scans.

```sql
-- B-tree (default): equality and range queries
CREATE INDEX idx_employee_salary ON employee(salary);

-- Composite index: order matters for leftmost prefix
CREATE INDEX idx_emp_dept_salary ON employee(department_id, salary DESC);

-- Partial index: only index relevant rows
CREATE INDEX idx_active_users ON users(email) WHERE active = true;

-- Covering index: includes all columns needed by the query
CREATE INDEX idx_covering ON orders(customer_id) INCLUDE (total, status);

-- GIN index: for JSONB, arrays, full-text search
CREATE INDEX idx_metadata ON products USING GIN(metadata);
```

### EXPLAIN ANALYZE

The reference SQL below is written to the standard an interviewer expects.

```sql
EXPLAIN ANALYZE
SELECT e.name, d.name
FROM employee e
JOIN department d ON e.department_id = d.id
WHERE e.salary > 100000;
```

**Key things to look for:**
- `Seq Scan` on large tables → needs an index
- `Nested Loop` with large outer table → consider Hash Join
- `Sort` with high cost → add index matching ORDER BY
- Actual rows >> estimated rows → statistics are stale, run `ANALYZE`

### Common Optimization Patterns

**1. EXISTS vs IN:**
```sql
-- Prefer EXISTS for correlated subqueries (stops at first match)
SELECT * FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);

-- IN is fine for small result sets
SELECT * FROM customers WHERE id IN (1, 2, 3);
```

**2. Avoid SELECT *:**
```sql
-- Bad: fetches all columns, prevents covering index usage
SELECT * FROM employees WHERE department_id = 5;

-- Good: only fetch what you need
SELECT id, name, salary FROM employees WHERE department_id = 5;
```

**3. Pagination with keyset (cursor) instead of OFFSET:**
```sql
-- Bad: OFFSET scans and discards rows
SELECT * FROM products ORDER BY id LIMIT 20 OFFSET 10000;

-- Good: keyset pagination is O(log n)
SELECT * FROM products WHERE id > 10000 ORDER BY id LIMIT 20;
```

**Go Integration for keyset pagination:**
```go
type PageRequest struct {
    Cursor int32
    Limit  int32
}

type Product struct {
    ID         int32
    Name       string
    PriceCents int64
}

func (r *Repository) ListProducts(ctx context.Context, req PageRequest) ([]Product, error) {
    rows, err := r.pool.Query(ctx,
        "SELECT id, name, price_cents FROM products WHERE id > $1 ORDER BY id LIMIT $2",
        req.Cursor, req.Limit)
    if err != nil {
        return nil, fmt.Errorf("list products: %w", err)
    }
    defer rows.Close()

    var products []Product
    for rows.Next() {
        var p Product
        if err := rows.Scan(&p.ID, &p.Name, &p.PriceCents); err != nil {
            return nil, fmt.Errorf("scan product: %w", err)
        }
        products = append(products, p)
    }
    return products, rows.Err()
}
```


### Junior → FAANG: SQL Query Optimization and Index Fundamentals

Query optimization and indexes are the bridge between correct SQL and efficient SQL. The key concepts: a B-tree index speeds up equality lookups and range scans on the indexed column. A composite index covers multiple columns and is used by queries that filter on the leading columns. EXPLAIN (or EXPLAIN ANALYZE in PostgreSQL) shows the query plan and the estimated versus actual row counts for each step. The most common optimization gap is adding an index on a single frequently-queried column without realizing that the query planner will not use it if the WHERE clause applies a function to the column.

### Senior @ FAANG: Query Optimization at the Senior Bar: Index Strategy and Cost-Based Planning

At the senior level, query optimization is a cost-benefit discipline. Every index speeds reads but slows writes, increases storage, and adds to the vacuum/autovacuum workload. The ADR for an index covers: which queries benefit from the index, the estimated cardinality of the indexed column, the write-to-read ratio for the table, and the impact on storage. Staff-level concerns include index bloat management (indexes fragment over time and periodic REINDEX or VACUUM FULL is needed, with implications for table locking), partial indexes (an index on a subset of rows that covers the common query pattern is smaller and faster than a full-table index), and the functional index (an index on an expression rather than a raw column value, which enables efficient queries on computed values like lower(email) for case-insensitive lookups).

---
