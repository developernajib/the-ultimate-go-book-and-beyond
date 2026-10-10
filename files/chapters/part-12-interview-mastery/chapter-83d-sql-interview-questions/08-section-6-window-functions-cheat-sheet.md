## 83D.8 Section 6: Window Functions Cheat Sheet

| Function | Purpose | Example |
|---|---|---|
| `ROW_NUMBER()` | Unique sequential rank | Pagination, dedup |
| `RANK()` | Rank with gaps on ties | Competition ranking |
| `DENSE_RANK()` | Rank without gaps | Top-N per group |
| `NTILE(n)` | Divide into n buckets | Percentile analysis |
| `LAG(col, n)` | Previous row value | Day-over-day change |
| `LEAD(col, n)` | Next row value | Forward-looking calc |
| `FIRST_VALUE(col)` | First in window | Reference point |
| `LAST_VALUE(col)` | Last in window | Needs proper frame |
| `SUM() OVER` | Running/window sum | Running totals |
| `AVG() OVER` | Running/window average | Moving averages |
| `COUNT() OVER` | Running/window count | Cumulative counts |

### Window Frame Syntax

The frame clause is the most misunderstood part of window functions: it controls which rows within the current partition are included in the aggregate calculation relative to the current row. The default frame (`RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`) works correctly for simple running totals, but breaks when you need a sliding window of fixed size, for example, a 7-day moving average. Switching from `RANGE` to `ROWS` gives you precise row-count-based boundaries, while `RANGE` with an `INTERVAL` lets you define time-based windows that automatically handle gaps in your data.

```sql
-- Default: RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
SUM(amount) OVER (ORDER BY date)

-- Explicit row-based window
SUM(amount) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)

-- All rows in partition
SUM(amount) OVER (PARTITION BY dept_id)

-- Custom range
AVG(price) OVER (ORDER BY date RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW)
```


### Junior → FAANG: Window Functions Quick Reference

Window functions are tested heavily in analytics SQL interviews. The essential reference: ROW_NUMBER() assigns a unique sequential number to each row within a partition. RANK() assigns the same rank to tied rows with gaps after ties. DENSE_RANK() assigns the same rank to tied rows without gaps. LAG(col, n) accesses a value from n rows before the current row in the partition. LEAD(col, n) accesses a value from n rows after. All window functions use the OVER clause with optional PARTITION BY (defines the group) and ORDER BY (defines the order within the group).

### Senior @ FAANG: Window Functions in Production: Materialization and Incremental Computation

At the senior level, window functions are a tool with known performance trade-offs that inform architecture decisions. A common pattern is to replace an expensive window function on a large table with a pre-aggregated table updated by a background job: instead of computing ROW_NUMBER() on every query, maintain a sorted-order column that is updated on inserts and updates. This trades query simplicity for write complexity. The correct choice depends on the read-to-write ratio and the latency requirement. Staff-level concerns include incremental computation: if the underlying data changes, how do you update the pre-aggregated result efficiently without recomputing the entire window? This is the domain of streaming SQL systems (Flink SQL, Spark Structured Streaming) that maintain stateful aggregations over an event stream with low-latency updates.

---
