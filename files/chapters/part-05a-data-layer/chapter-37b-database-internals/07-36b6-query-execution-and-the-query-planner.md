## 37B.6 Query Execution and the Query Planner

### How PostgreSQL Parses, Plans, and Executes Queries

Every SQL statement passes through four stages before any data moves. Understanding this pipeline explains why some queries are slow before they touch a single row: the planner may spend significant time evaluating candidate plans, or the rewriter may expand a view into a much larger query than you wrote.

```
Query Lifecycle:

Client sends SQL text
        |
        v
[Parser]
  - Lexical analysis: tokenize SQL text
  - Syntactic analysis: build parse tree
  - Semantic analysis: resolve table/column names, check types
        |
        v
[Rewriter]
  - Apply view definitions (replace view references with subqueries)
  - Apply row security policies (append WHERE conditions)
        |
        v
[Planner / Optimizer]
  - Generate candidate execution plans (dozens to thousands)
  - Estimate cost of each plan using statistics
  - Select the plan with lowest estimated cost
        |
        v
[Executor]
  - Execute the chosen plan
  - Return rows to client
```

### EXPLAIN Output Anatomy

The `EXPLAIN` command shows the execution plan the planner chose without running the query. Each line represents a plan node, indented to show parent-child relationships. The cost numbers, row estimates, and width values tell you what the planner expects. Learning to read this output quickly is the single most valuable database debugging skill.

```sql
EXPLAIN SELECT * FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'active'
  AND o.created_at > NOW() - INTERVAL '7 days';
Hash Join  (cost=245.00..892.30 rows=1200 width=128)
  Hash Cond: (o.user_id = u.id)
  ->  Index Scan using idx_orders_status_created on orders o
        (cost=0.56..412.10 rows=1200 width=96)
        Index Cond: (status = 'active')
        Filter: (created_at > (now() - '7 days'::interval))
  ->  Hash  (cost=120.00..120.00 rows=10000 width=32)
        ->  Seq Scan on users u  (cost=0.00..120.00 rows=10000 width=32)
```

**Reading cost estimates**: `(startup_cost..total_cost)`
- `startup_cost`: cost before first row can be returned (e.g., building hash table)
- `total_cost`: cost to return all rows
- `rows`: estimated row count
- `width`: estimated average row size in bytes

**Cost unit** = time to read one sequential disk page (arbitrary, relative unit). Default values: `seq_page_cost=1.0`, `random_page_cost=4.0` (tune for SSD: `random_page_cost=1.1`).

### EXPLAIN ANALYZE: Actual vs Estimated Rows

`EXPLAIN ANALYZE` actually **runs the query** and shows actual runtime statistics:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders WHERE user_id = 42 AND status = 'active';
Index Scan using idx_orders_user_id on orders
  (cost=0.56..24.10 rows=8 width=96)
  (actual time=0.042..0.215 rows=143 loops=1)
  Index Cond: (user_id = 42)
  Filter: (status = 'active')
  Rows Removed by Filter: 12
Buffers: shared hit=18 read=3
Planning Time: 0.412 ms
Execution Time: 0.318 ms
```

Key things to look for:

| Field | What it reveals |
|---|---|
| `rows=8` vs `actual rows=143` | Planner massively underestimated (stale stats) |
| `Rows Removed by Filter: 12` | Index fetched 155 rows, filter removed 12 |
| `Buffers: shared hit=18 read=3` | 18 pages from cache, 3 from disk |
| `loops=N` | Node executed N times (nested loop inner side) |

**Large discrepancy between estimated and actual rows** is the most important diagnostic. It means the planner is making wrong decisions. Fix: run `ANALYZE orders;` to refresh statistics.

### Scan Types: When Each Is Used

PostgreSQL chooses between several scan strategies based on index availability, selectivity estimates, and table size. The planner picks whichever has the lowest estimated cost. A sequential scan reads every page in order. An index scan does random reads via the index. A bitmap scan sits between the two by building a bitmap of matching pages first, then reading them in physical order.

```
Scan Type Decision Tree:

Is the WHERE clause selective (< ~5-10% of rows)?
  YES --> Is there an index on the filter columns?
    YES --> Index Scan or Index Only Scan
    NO  --> Seq Scan (no index available)
  NO  --> Seq Scan (faster than many random index reads)

Special cases:
  - Multiple index conditions: Bitmap Heap Scan (combine index results)
  - Very selective but large result: Bitmap Heap Scan
  - All needed columns in index: Index Only Scan
Bitmap Heap Scan:

Step 1: Bitmap Index Scan
  - Scan index, build in-memory bitmap of matching page numbers
  - Multiple indexes can be combined: BitmapAnd / BitmapOr

Step 2: Bitmap Heap Scan
  - Read heap pages in physical order (avoids random I/O)
  - Re-check conditions (lossy bitmap may have false positives)

Advantage: Converts random I/O into sequential I/O for medium-selectivity queries
```

### Join Strategies: Nested Loop, Hash Join, Merge Join

PostgreSQL has three physical join algorithms, each suited to different data sizes and index availability. The planner evaluates all three and picks the cheapest. Knowing which algorithm was selected helps you understand whether adding an index, increasing `work_mem`, or restructuring the query would help.

```
Nested Loop Join:
  For each row in outer table:
    For each matching row in inner table (via index):
      Output combined row

  Best when: outer is small, inner has an index
  Complexity: O(outer * inner_matches) with index = O(outer * log(inner))

  EXPLAIN output:
  Nested Loop
    -> Seq Scan on users (outer, small)
    -> Index Scan on orders using idx_orders_user_id (inner)
         Index Cond: (user_id = users.id)
Hash Join:
  Phase 1 (build): scan smaller table, build hash table in memory
  Phase 2 (probe): scan larger table, probe hash table for matches

  Best when: neither table has a useful index, one fits in work_mem
  Complexity: O(build + probe) = O(n + m)

  EXPLAIN output:
  Hash Join
    Hash Cond: (orders.user_id = users.id)
    -> Seq Scan on orders (probe side, larger)
    -> Hash
         -> Seq Scan on users (build side, smaller)
Merge Join:
  Both inputs must be sorted on the join key (or sorted on the fly).
  Merge the two sorted streams like merge sort.

  Best when: both inputs are already sorted (index scans on join key)
  Complexity: O(n log n) if sorting needed, O(n) if pre-sorted

  EXPLAIN output:
  Merge Join
    Merge Cond: (users.id = orders.user_id)
    -> Index Scan on users using users_pkey (sorted by id)
    -> Index Scan on orders using idx_orders_user_id (sorted by user_id)
```

### Why the Planner Makes Wrong Choices (Stale Statistics)

The planner relies on statistics in `pg_statistic` (user-friendly view: `pg_stats`):
- `n_distinct`: estimated number of distinct values
- `correlation`: how correlated physical order is with logical order (1.0 = sorted)
- `most_common_vals` / `most_common_freqs`: top N values and their frequencies
- `histogram_bounds`: distribution of values

```sql
-- View statistics for a column
SELECT
    attname,
    n_distinct,
    correlation,
    most_common_vals,
    most_common_freqs,
    histogram_bounds
FROM pg_stats
WHERE tablename = 'orders'
  AND attname = 'status';
```

**Statistics go stale when**:
- Large bulk inserts/deletes without running `ANALYZE`
- The default `default_statistics_target = 100` is too low for skewed distributions
- Autovacuum is not running frequently enough

**Fix stale statistics**:
```sql
-- Refresh statistics on a table
ANALYZE orders;

-- Increase statistics target for a skewed column (0-10000, default 100)
ALTER TABLE orders ALTER COLUMN user_id SET STATISTICS 500;
ANALYZE orders;
```

### Go Code: Using EXPLAIN from Application Code

This code runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and parses the output into Go structs for programmatic analysis. The `AnalyzePlan` function checks for sequential scans, large row estimation errors, and low cache hit ratios, returning actionable warnings. You can integrate this into integration tests or development tooling to catch query regressions before they reach production.

```go
package planner

import (
    "context"
    "encoding/json"
    "fmt"
    "strings"

    "github.com/jackc/pgx/v5/pgxpool"
)

// PlanNode represents a node in the JSON EXPLAIN output.
type PlanNode struct {
    NodeType          string     `json:"Node Type"`
    StartupCost       float64    `json:"Startup Cost"`
    TotalCost         float64    `json:"Total Cost"`
    PlanRows          int        `json:"Plan Rows"`
    ActualRows        int        `json:"Actual Rows"`
    ActualLoops       int        `json:"Actual Loops"`
    RowsRemovedFilter int        `json:"Rows Removed by Filter"`
    SharedHitBlocks   int        `json:"Shared Hit Blocks"`
    SharedReadBlocks  int        `json:"Shared Read Blocks"`
    Plans             []PlanNode `json:"Plans"`
}

type ExplainOutput struct {
    Plan         PlanNode `json:"Plan"`
    PlanningTime float64  `json:"Planning Time"`
    ExecTime     float64  `json:"Execution Time"`
}

// ExplainJSON runs EXPLAIN ANALYZE with JSON output for programmatic parsing.
func ExplainJSON(ctx context.Context, pool *pgxpool.Pool, query string, args ...any) (*ExplainOutput, error) {
    explainQuery := fmt.Sprintf("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) %s", query)

    var raw []byte
    err := pool.QueryRow(ctx, explainQuery, args...).Scan(&raw)
    if err != nil {
        return nil, fmt.Errorf("explain json: %w", err)
    }

    var outputs []ExplainOutput
    if err := json.Unmarshal(raw, &outputs); err != nil {
        return nil, fmt.Errorf("unmarshal explain: %w", err)
    }
    if len(outputs) == 0 {
        return nil, fmt.Errorf("empty explain output")
    }

    return &outputs[0], nil
}

// QueryHealthReport summarizes potential issues with a query plan.
type QueryHealthReport struct {
    HasSeqScan           bool
    RowEstimationError   float64 // ratio of actual/estimated rows
    CacheHitRatio        float64
    ExecutionTimeMs      float64
    Warnings             []string
}

// AnalyzePlan produces a health report from EXPLAIN ANALYZE output.
func AnalyzePlan(out *ExplainOutput) *QueryHealthReport {
    report := &QueryHealthReport{
        ExecutionTimeMs: out.ExecTime,
    }

    analyzeNode(out.Plan, report)

    totalBlocks := out.Plan.SharedHitBlocks + out.Plan.SharedReadBlocks
    if totalBlocks > 0 {
        report.CacheHitRatio = float64(out.Plan.SharedHitBlocks) / float64(totalBlocks)
    }

    if report.HasSeqScan {
        report.Warnings = append(report.Warnings, "Sequential scan detected - consider adding an index")
    }
    if report.RowEstimationError > 10 {
        report.Warnings = append(report.Warnings,
            fmt.Sprintf("Row estimation error: %.1fx - run ANALYZE to refresh statistics", report.RowEstimationError),
        )
    }
    if report.CacheHitRatio < 0.95 && totalBlocks > 0 {
        report.Warnings = append(report.Warnings,
            fmt.Sprintf("Low cache hit ratio: %.1f%% - consider increasing shared_buffers", report.CacheHitRatio*100),
        )
    }

    return report
}

func analyzeNode(node PlanNode, report *QueryHealthReport) {
    if strings.Contains(node.NodeType, "Seq Scan") {
        report.HasSeqScan = true
    }

    if node.PlanRows > 0 && node.ActualRows > 0 {
        ratio := float64(node.ActualRows) / float64(node.PlanRows)
        if ratio > report.RowEstimationError {
            report.RowEstimationError = ratio
        }
        inverseRatio := float64(node.PlanRows) / float64(node.ActualRows)
        if inverseRatio > report.RowEstimationError {
            report.RowEstimationError = inverseRatio
        }
    }

    for _, child := range node.Plans {
        analyzeNode(child, report)
    }
}
```

### Junior to FAANG: Reading Plans Without Guessing

The hardest habit to break coming from a web-framework background is treating EXPLAIN as a wall of numbers. Read it inside-out: the deepest indented node runs first and feeds its parent. Each node declares an operation, an estimated row count, and an actual row count after EXPLAIN ANALYZE. Your job on a first read is to find the node where estimated and actual diverge by an order of magnitude, because that is where the planner lost.

Worked example. A page that loaded in 40ms in staging takes 8 seconds in production. You run EXPLAIN ANALYZE and see a Nested Loop with outer rows estimated at 10 and actual at 50000. Each inner lookup is cheap, but the loop multiplies. The fix is rarely "add an index on the inner table", because the inner already has one. The fix is to make the planner stop picking Nested Loop by correcting the outer estimate. Run ANALYZE, or raise default_statistics_target for the filtering column, or add an extended statistic if two correlated columns are driving the misestimate.

Interview entry-point prompts:
- What does cost=0.56..24.10 mean? Startup cost (time until the first row can emerge) and total cost (time to return every row), in units of one sequential page read.
- When would you prefer Seq Scan over Index Scan? When the predicate matches more than roughly 5 to 10 percent of rows, because the random I/O of following the index exceeds the sequential bandwidth of reading the whole heap.
- Why does a Nested Loop with 1 outer row and 1M inner rows often beat a Hash Join? Because the loop executes once and probes the inner index in O(log n), never materializing the inner side.

### Senior at FAANG: Planner Internals, Plan Stability, and Regression Hunting

The Postgres cost model is additive over plan nodes. Each node's cost combines CPU cost (cpu_tuple_cost, cpu_index_tuple_cost, cpu_operator_cost) with I/O cost (seq_page_cost, random_page_cost), weighted by expected tuple counts flowing through. Selectivity estimates feed the tuple counts, and join cardinality is the product of input cardinalities times join selectivity. The weak link is selectivity: for a predicate like status = 'active', the planner reads most_common_vals and most_common_freqs. For a predicate not in MCV, it falls back to the histogram and assumes uniform distribution within buckets. For multi-column predicates the default assumption is independence, which is almost always wrong for columns like (country, city) or (user_id, status). Extended statistics (CREATE STATISTICS name (dependencies, ndistinct, mcv) ON a, b FROM t) fix this and are the staff-level tool most engineers forget exists.

Join reordering. For fewer than geqo_threshold (default 12) relations in a FROM list, Postgres uses a dynamic programming search (System-R style) that evaluates all left-deep and bushy plans up to its pruning rules. Beyond the threshold it switches to the Genetic Query Optimizer (GEQO), which samples the plan space with crossover and mutation. GEQO is non-deterministic by default because it seeds from geqo_seed, so plans can drift between runs on the same data. For a reporting workload with 20+ joins, either raise geqo_threshold and accept longer planning time, or set geqo_seed to a fixed value, or rewrite the query to materialize intermediate joins via WITH MATERIALIZED blocks.

pg_hint_plan is the production escape hatch when the planner consistently picks a bad plan and statistics tuning does not move it. It is widely used at companies running thousands of query variants where the long tail of poorly planned queries outweighs the risk of pinned hints. A hint like /*+ IndexScan(orders idx_orders_user_id_created) Leading((users orders)) NestLoop(users orders) */ forces a specific shape. The senior argument against hints is that they hide underlying distribution changes. The argument for them is that a pinned plan that is 20 percent suboptimal beats an unpinned plan that occasionally picks a 50x-worse shape.

Plan stability and parameter sniffing. Postgres PREPARE generates a custom plan for the first five executions and, starting with the sixth, considers switching to a generic plan that does not look at parameter values. The choice is governed by plan_cache_mode. The failure mode is: the first five executions happen during warmup with rare parameter values, the planner decides "these always filter to few rows, use Nested Loop", then switches to generic plan, which also assumes low cardinality. A call with a common parameter value then runs Nested Loop over millions of rows. Detection: enable auto_explain with auto_explain.log_min_duration, auto_explain.log_analyze, and auto_explain.log_nested_statements, then diff the plan for the same prepared statement across slow and fast executions. Mitigation: set plan_cache_mode = force_custom_plan for pools serving highly skewed parameter distributions, or use pgbouncer in session mode so your application code can DEALLOCATE ALL and re-prepare after detecting regression.

Statistics staleness in practice. Bulk loads bypass autovacuum's change counter because COPY FREEZE does not increment n_mod_since_analyze proportionally. After every bulk load, run ANALYZE explicitly. Partitioned tables have two layers of statistics: per-partition and on the parent via pg_statistic with inh=true. The inherited statistics only refresh when you ANALYZE the parent, not when individual partitions are analyzed. Queries that filter on partition-pruning predicates are fine, but queries that aggregate across partitions planned on stale parent stats will pick the wrong join order.

auto_explain deployment. In production, auto_explain.log_min_duration = '500ms' is the canonical starting point. Leave log_analyze off by default (it adds 30 to 50 percent overhead via instrumentation). Turn log_analyze on only during incident investigation, and set sample_rate below 1.0 to avoid flooding logs. Pair auto_explain output with a plan fingerprint (hash the normalized plan tree) so you can group regressions and count occurrences rather than reading thousands of individual plans.

Executor architecture. The Volcano model (one tuple per Next() call) is still the baseline. Postgres 11+ added JIT compilation via LLVM for tuple deforming and expression evaluation, triggered when total plan cost exceeds jit_above_cost (default 100000). JIT helps CPU-bound analytical queries on wide rows but adds compile latency on every execution unless plan caching kicks in. For OLTP it often hurts more than it helps. Benchmark with jit = off for your workload before accepting the default. The forthcoming batch executor (vectorized execution) is an active area of work, tracked under the Postgres "executor batching" threads, and will narrow the gap with Snowflake/DuckDB-style engines for analytical queries.

Regression hunting runbook. When a query slows down overnight: (1) capture the current plan via EXPLAIN ANALYZE with the exact parameters that are slow, (2) capture the previous plan from auto_explain logs, (3) diff node shapes (Hash vs Nested Loop vs Merge), (4) diff estimated row counts at the point where the plans diverge, (5) check pg_stat_user_tables.last_analyze and n_mod_since_analyze for the tables involved, (6) check pg_stats for the filter columns against known-good values from the prior day if you archive them, (7) if statistics look fine, examine parameter skew and plan_cache_mode. Never jump to "add an index" before finishing this sequence.

---
