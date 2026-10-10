## 33.5 Window Functions

### Using Window Functions

Window functions compute aggregates over a sliding frame of rows without collapsing them into a single output row. They are ideal for running totals, rankings, and moving averages that require both the per-row value and an aggregate over a related partition.

```go
package main

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

type SalesReport struct {
    Date               time.Time
    RevenueCents       int64
    RunningTotalCents  int64
    DayOverDayCents    int64
    MovingAvg7DayCents int64
    Rank               int
}

func getSalesReport(ctx context.Context, pool *pgxpool.Pool) ([]SalesReport, error) {
    query := `
        SELECT
            date,
            revenue_cents,
            SUM(revenue_cents) OVER (ORDER BY date) as running_total_cents,
            revenue_cents - LAG(revenue_cents, 1, revenue_cents) OVER (ORDER BY date) as day_over_day_cents,
            ROUND(AVG(revenue_cents) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW))::bigint as moving_avg_7day_cents,
            RANK() OVER (ORDER BY revenue_cents DESC) as rank
        FROM daily_sales
        WHERE date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY date
    `

    rows, err := pool.Query(ctx, query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var reports []SalesReport
    for rows.Next() {
        var r SalesReport
        if err := rows.Scan(&r.Date, &r.RevenueCents, &r.RunningTotalCents, &r.DayOverDayCents, &r.MovingAvg7DayCents, &r.Rank); err != nil {
            return nil, err
        }
        reports = append(reports, r)
    }

    return reports, rows.Err()
}

// Percentile calculations
type UserStats struct {
    UserID          int64
    TotalOrders     int
    TotalSpentCents int64
    SpentPercentile float64
}

func getUserSpendingPercentiles(ctx context.Context, pool *pgxpool.Pool) ([]UserStats, error) {
    query := `
        SELECT
            user_id,
            COUNT(*) as total_orders,
            SUM(amount_cents) as total_spent_cents,
            PERCENT_RANK() OVER (ORDER BY SUM(amount_cents)) as percentile
        FROM orders
        GROUP BY user_id
        ORDER BY total_spent_cents DESC
    `
    rows, err := pool.Query(ctx, query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var stats []UserStats
    for rows.Next() {
        var s UserStats
        if err := rows.Scan(&s.UserID, &s.TotalOrders, &s.TotalSpentCents, &s.SpentPercentile); err != nil {
            return nil, err
        }
        stats = append(stats, s)
    }

    return stats, rows.Err()
}
```

### Junior → FAANG: entry-point to window functions

If you have only used `GROUP BY`, window functions feel magical. The key insight is that `OVER (...)` does not collapse rows. Each row keeps its identity and gets an extra column computed against a frame. The frame has three parts: `PARTITION BY` (independent buckets), `ORDER BY` (direction inside the bucket), and the frame clause (`ROWS BETWEEN ... AND ...` or `RANGE BETWEEN ...`).

Worked example. You have a `logins(user_id, login_at)` table and want, for each login, the time since that user's previous login.

```sql
SELECT user_id, login_at,
       login_at - LAG(login_at) OVER (PARTITION BY user_id ORDER BY login_at) AS gap
FROM logins;
```

Without the window, you would self-join the table to itself on `login_at < login_at` and pick the max, which is both slower and harder to read. Common first-job uses: sessionization, pagination with stable tie-breaking via `ROW_NUMBER()`, and de-duplication via `ROW_NUMBER() OVER (PARTITION BY natural_key ORDER BY updated_at DESC) = 1`.

Interview entry-point questions you should be able to answer cold: the difference between `RANK`, `DENSE_RANK`, and `ROW_NUMBER` on ties, what `LAG(col, 1, col)` does (the third argument is the default when no previous row exists), and why `SUM(x) OVER (ORDER BY d)` defaults to `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` (running total) rather than the full partition.

### Senior @ FAANG: frames, spills, and approximate percentiles

Window functions are the most common source of silent performance regressions in analytics queries. A staff engineer owns the nuance.

Default frame surprises. `SUM(x) OVER (ORDER BY d)` uses `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, which includes peers (rows with equal `ORDER BY` values). If `d` has duplicates, your running total jumps by the sum of the peer group at once. That is almost never what an unsuspecting engineer wanted. Use `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` for true row-by-row running totals. In code review, flag every `OVER (ORDER BY ...)` without an explicit frame and ask the author to prove they meant `RANGE`.

`ROWS` vs `RANGE` vs `GROUPS`. `ROWS` counts physical rows, `RANGE` counts values relative to the current row's `ORDER BY` key (and requires a single numeric or temporal key for offsets like `RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW`), and `GROUPS` (PG11+) counts peer groups. For a trailing 7-day moving average on irregular timestamps, `RANGE` is correct because `ROWS 6 PRECEDING` assumes evenly spaced rows.

`ORDER BY` in the window vs the outer query. These are independent. `ROW_NUMBER() OVER (ORDER BY created_at DESC)` assigns numbers in timestamp order but the outer query can still return them in any order. Do not assume result ordering without an outer `ORDER BY`. Conversely, the outer `ORDER BY` does not influence the window frame, so `SELECT SUM(x) OVER () FROM t ORDER BY y` still sums the whole partition regardless of `y`.

Sort spilling and `work_mem`. Each distinct `PARTITION BY` / `ORDER BY` requires a sort unless an index provides the order. With `EXPLAIN (ANALYZE, BUFFERS)` look for `WindowAgg` nodes and the `Sort` underneath. If `Sort Method: external merge Disk: NNNkB` appears, you are spilling to disk. Options: raise `work_mem` for the session (`SET LOCAL work_mem = '256MB'` inside a transaction), add a covering index on `(partition_cols, order_cols)` so the planner can use an `Index Scan` with no sort, or reduce the input via a CTE filter before the window. A single query with multiple independent windows can produce multiple sorts. Reuse the same `PARTITION BY ... ORDER BY` shape across windows so the planner can compute them in one pass (`WindowAgg` can chain when the frames are compatible).

Percentile families. PG has three shapes, and they are not interchangeable. `PERCENT_RANK()` is a window function returning relative rank in `[0, 1]`. `percentile_cont(fraction) WITHIN GROUP (ORDER BY x)` and `percentile_disc(...)` are ordered-set aggregates. `cont` interpolates between values (p50 of `{1, 2}` is `1.5`), `disc` returns an actual value from the set. For latency SLOs use `disc` when you need a real observed sample and `cont` when you need a smooth estimate. On billions of rows, exact percentiles require a full sort and blow `work_mem`. Use approximations: the `tdigest` extension gives mergeable sketches with controllable error (`tdigest(latency, 100)` with ~1% error at tails), and `hyperloglog` covers distinct counts. For PG17 with `pg_duckdb` or Citus columnar, approximate analytics can run directly in the same cluster without a separate OLAP stack.

Anti-patterns to reject in review. `COUNT(*) OVER ()` on a large table when the caller only needed a boolean "are there more pages" (use `EXISTS` with `LIMIT 1` instead). `LAG` chains across partitions that differ only by a nullable column (nulls form their own partition and break assumptions). Nested windows (PG does not support them directly, people simulate with a subquery and re-sort, doubling cost). Using `RANK()` for top-N when `ROW_NUMBER()` is what you actually need, then being surprised when ties return more than N rows.

Operational discipline. Analytics queries that touch many partitions over full history should run on a read replica with a higher `work_mem` and `hash_mem_multiplier`, not on the primary. When a product query becomes an analytics query, that is the signal to move it, not the signal to tune the primary harder.

---
