## 33.6 Common Table Expressions (CTEs)

### Recursive CTEs

Common Table Expressions (CTEs) name intermediate result sets within a query, improving readability for complex multi-step transformations. Recursive CTEs traverse hierarchical data structures such as organizational trees or bill-of-materials without requiring multiple round-trips.

```go
package main

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

// Get category tree
type Category struct {
    ID       int64
    Name     string
    ParentID *int64
    Level    int
    Path     string
}

func getCategoryTree(ctx context.Context, pool *pgxpool.Pool) ([]Category, error) {
    query := `
        WITH RECURSIVE category_tree AS (
            -- Base case: root categories
            SELECT id, name, parent_id, 0 as level, name::text as path
            FROM categories
            WHERE parent_id IS NULL

            UNION ALL

            -- Recursive case
            SELECT c.id, c.name, c.parent_id, ct.level + 1, ct.path || ' > ' || c.name
            FROM categories c
            JOIN category_tree ct ON c.parent_id = ct.id
        )
        SELECT id, name, parent_id, level, path
        FROM category_tree
        ORDER BY path
    `

    rows, err := pool.Query(ctx, query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var categories []Category
    for rows.Next() {
        var c Category
        if err := rows.Scan(&c.ID, &c.Name, &c.ParentID, &c.Level, &c.Path); err != nil {
            return nil, err
        }
        categories = append(categories, c)
    }

    return categories, rows.Err()
}

// Get all descendants of a category
func getCategoryDescendants(ctx context.Context, pool *pgxpool.Pool, categoryID int64) ([]int64, error) {
    query := `
        WITH RECURSIVE descendants AS (
            SELECT id FROM categories WHERE id = $1
            UNION ALL
            SELECT c.id FROM categories c
            JOIN descendants d ON c.parent_id = d.id
        )
        SELECT id FROM descendants WHERE id != $1
    `

    rows, err := pool.Query(ctx, query, categoryID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var ids []int64
    for rows.Next() {
        var id int64
        if err := rows.Scan(&id); err != nil {
            return nil, err
        }
        ids = append(ids, id)
    }

    return ids, rows.Err()
}
```

### CTEs for Complex Queries

Beyond recursion, CTEs shine in multi-step analytical queries where each stage builds on the previous one. The following example chains two CTEs: the first aggregates order data per customer, and the second classifies customers into segments based on their spending. This keeps each transformation readable and independently testable, compared to deeply nested subqueries that achieve the same result.

```go
type CustomerAnalytics struct {
    UserID             int64
    Name               string
    Email              string
    OrderCount         int
    TotalSpentCents    int64
    AvgOrderValueCents int64
    LastOrderDate      *time.Time
    Segment            string
}

func getCustomerAnalytics(ctx context.Context, pool *pgxpool.Pool) ([]CustomerAnalytics, error) {
    query := `
        WITH order_stats AS (
            SELECT
                user_id,
                COUNT(*) as order_count,
                SUM(total_cents) as total_spent_cents,
                ROUND(AVG(total_cents))::bigint as avg_order_value_cents,
                MAX(created_at) as last_order_date
            FROM orders
            WHERE created_at > NOW() - INTERVAL '1 year'
            GROUP BY user_id
        ),
        customer_segments AS (
            SELECT
                user_id,
                order_count,
                total_spent_cents,
                avg_order_value_cents,
                last_order_date,
                CASE
                    WHEN total_spent_cents > 1000000 THEN 'VIP'
                    WHEN total_spent_cents > 100000 THEN 'Regular'
                    ELSE 'Occasional'
                END as segment
            FROM order_stats
        )
        SELECT
            u.id,
            u.name,
            u.email,
            COALESCE(cs.order_count, 0),
            COALESCE(cs.total_spent_cents, 0),
            COALESCE(cs.avg_order_value_cents, 0),
            cs.last_order_date,
            COALESCE(cs.segment, 'New')
        FROM users u
        LEFT JOIN customer_segments cs ON u.id = cs.user_id
        ORDER BY COALESCE(cs.total_spent_cents, 0) DESC
    `

    rows, err := pool.Query(ctx, query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var list []CustomerAnalytics
    for rows.Next() {
        var ca CustomerAnalytics
        if err := rows.Scan(&ca.UserID, &ca.Name, &ca.Email, &ca.OrderCount, &ca.TotalSpentCents, &ca.AvgOrderValueCents, &ca.LastOrderDate, &ca.Segment); err != nil {
            return nil, err
        }
        list = append(list, ca)
    }

    return list, rows.Err()
}
```

### Junior → FAANG: CTE prerequisites and first-job use

A CTE is a named subquery that lives for the duration of one statement. Syntactically you write `WITH foo AS (SELECT ...) SELECT * FROM foo JOIN bar ...`. Think of CTEs as local variables for SQL. You can reference a CTE multiple times in the main query, and you can chain them so each step names the previous one.

Worked example. A reporting query wants active users who placed an order in the last 30 days and their latest order total.

```sql
WITH active_users AS (
    SELECT id, email FROM users WHERE status = 'active'
),
last_orders AS (
    SELECT DISTINCT ON (user_id) user_id, total_cents, created_at
    FROM orders
    WHERE created_at > NOW() - INTERVAL '30 days'
    ORDER BY user_id, created_at DESC
)
SELECT au.email, lo.total_cents, lo.created_at
FROM active_users au
JOIN last_orders lo ON lo.user_id = au.id;
```

Without CTEs you would write nested subqueries with poor readability. With CTEs the pipeline is linear and reviewable step by step.

Recursive CTE mental model. The recursive form has a base case (`SELECT ... WHERE parent_id IS NULL`) and a recursive step that joins against the CTE itself. PG evaluates the base case, feeds the results into the recursive step, then feeds those results back in, until a step returns zero rows. Two rules you must memorize before any interview. First, the recursive step sees only the rows added in the previous iteration, not the full accumulated set. Second, if the recursion never returns zero rows, the query runs forever (or until `statement_timeout`).

First-job interview entry-point. Be ready to write a recursive CTE that walks an `employees(id, manager_id)` table upward from a given employee to the CEO, and to explain what `UNION` vs `UNION ALL` means in that context (`UNION ALL` is always what you want in recursive CTEs unless you are explicitly dedup-ing to break cycles).

### Senior @ FAANG: materialization, fences, and graph traversal at scale

CTEs changed meaning in PG12. Before PG12, every CTE was an optimization fence: PG always materialized the result and the outer query could not push predicates into it. Legacy codebases written against PG 9.6 and 10 often rely on this accidentally, using CTEs as a manual way to force execution order. Since PG12 the default is `NOT MATERIALIZED` for CTEs that are referenced once and are not recursive, which means PG inlines them and may push predicates through. This is usually a win but occasionally flips a plan in a way that tanks performance.

Explicit hints. You control behavior with `WITH foo AS MATERIALIZED (...)` to force the fence, and `WITH foo AS NOT MATERIALIZED (...)` to force inlining. Use `MATERIALIZED` when the CTE is expensive, referenced multiple times, or when predicate pushdown would defeat an index (for example when the CTE uses a window function whose result the outer `WHERE` would filter incorrectly). Use `NOT MATERIALIZED` when the CTE is a readability wrapper around a simple filter and you want the planner to fuse it with the outer scan. In code review, call out any CTE referenced exactly once without an explicit hint and ask whether the author verified the plan with `EXPLAIN`.

Recursive CTEs for graph traversal. Classic uses: organizational hierarchies, bill of materials (parts that contain parts), category trees, friend-of-friend up to depth N, package dependency closures. Rules for production recursion: always include an explicit depth counter and a `WHERE depth < N` stop condition, always check for cycles with an array path (`path || c.id` and `NOT c.id = ANY(path)`), and always `EXPLAIN` the plan on realistic data before shipping. The planner cannot estimate recursion cardinality well, so the outer query often gets a bad join order. A common fix is to materialize the recursive CTE explicitly and then join against it.

```sql
WITH RECURSIVE subtree AS MATERIALIZED (
    SELECT id, parent_id, 0 AS depth, ARRAY[id] AS path
    FROM categories WHERE id = $1
    UNION ALL
    SELECT c.id, c.parent_id, s.depth + 1, s.path || c.id
    FROM categories c
    JOIN subtree s ON c.parent_id = s.id
    WHERE s.depth < 16 AND NOT c.id = ANY(s.path)
)
SELECT * FROM subtree;
```

Scale limits. Recursive CTEs in PG are single-threaded and hold intermediate results in `work_mem`. For friend-of-friend on a social graph with tens of millions of edges, recursion in PG is the wrong tool. Move to a purpose-built graph store (Neo4j, or Apache AGE as a PG extension that gives Cypher semantics on top of PG tables) or precompute closures in a materialized view refreshed on a schedule. Bill-of-materials with modest fan-out (under a few thousand leaves per root) is well within PG's comfort zone. Recursion over millions of rows is not.

Writable CTEs. `WITH deleted AS (DELETE FROM stale RETURNING *) INSERT INTO archive SELECT * FROM deleted` is a common pattern for atomic move-between-tables. Important subtlety: the visibility rules say the sub-statements see the database snapshot as it was at the start of the outer statement, not each other's changes. You cannot `INSERT` into a table in one CTE and `SELECT` the new rows from it in another CTE of the same statement. Many engineers learn this the hard way during an incident.

Fence for plan stability. When a planner regression appears after a PG major upgrade, forcing `MATERIALIZED` on a CTE is a legitimate short-term mitigation while you diagnose the root cause. Record the decision in a comment with the PG version and bug link. Revisit after the next minor upgrade. Do not leave `MATERIALIZED` hints scattered across the codebase as the "style" choice. They are a planner override, and planner overrides age poorly.

---
