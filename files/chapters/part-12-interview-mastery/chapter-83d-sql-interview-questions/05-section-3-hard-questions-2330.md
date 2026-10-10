## 83D.5 Section 3: Hard Questions (23-30)

### Q23: Recursive Org Chart (All Reports)

**Difficulty:** Hard
**Company:** Amazon, Google
**Topic:** Recursive CTE

**Schema:**
```sql
CREATE TABLE org (
    emp_id     INTEGER PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    manager_id INTEGER REFERENCES org(emp_id)
);
```

**Question:** Find all direct and indirect reports of a given manager.

**Solution:**
```sql
WITH RECURSIVE reports AS (
    -- Base case: direct reports
    SELECT emp_id, name, manager_id, 1 AS depth
    FROM org
    WHERE manager_id = 1  -- target manager's emp_id

    UNION ALL

    -- Recursive case: reports of reports
    SELECT o.emp_id, o.name, o.manager_id, r.depth + 1
    FROM org o
    JOIN reports r ON o.manager_id = r.emp_id
)
SELECT emp_id, name, depth
FROM reports
ORDER BY depth, name;
```

**Go Integration (pgx):**
```go
type Employee struct {
    ID    int32
    Name  string
    Depth int
}

func (r *Repository) GetAllReports(ctx context.Context, managerID int32) ([]Employee, error) {
    rows, err := r.pool.Query(ctx, `
        WITH RECURSIVE reports AS (
            SELECT emp_id, name, manager_id, 1 AS depth
            FROM org WHERE manager_id = $1
            UNION ALL
            SELECT o.emp_id, o.name, o.manager_id, r.depth + 1
            FROM org o JOIN reports r ON o.manager_id = r.emp_id
        )
        SELECT emp_id, name, depth FROM reports ORDER BY depth, name`,
        managerID)
    if err != nil {
        return nil, fmt.Errorf("query reports: %w", err)
    }
    defer rows.Close()

    var employees []Employee
    for rows.Next() {
        var e Employee
        if err := rows.Scan(&e.ID, &e.Name, &e.Depth); err != nil {
            return nil, fmt.Errorf("scan employee: %w", err)
        }
        employees = append(employees, e)
    }
    return employees, rows.Err()
}
```

---

### Q24: Gaps and Islands

**Difficulty:** Hard
**Company:** Amazon
**Topic:** Window functions, islands technique

**Schema:**
```sql
CREATE TABLE logins (
    user_id    INTEGER NOT NULL,
    login_date DATE NOT NULL,
    PRIMARY KEY (user_id, login_date)
);
```

**Question:** Find the longest consecutive login streak for each user.

**Solution:**
```sql
WITH streaks AS (
    SELECT user_id, login_date,
           login_date - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY login_date))::INTEGER AS island
    FROM logins
)
SELECT user_id,
       MIN(login_date) AS streak_start,
       MAX(login_date) AS streak_end,
       COUNT(*) AS streak_length
FROM streaks
GROUP BY user_id, island
ORDER BY user_id, streak_length DESC;
```

**To get only the longest streak per user:**
```sql
WITH streaks AS (
    SELECT user_id, login_date,
           login_date - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY login_date))::INTEGER AS island
    FROM logins
),
streak_lengths AS (
    SELECT user_id, island, COUNT(*) AS streak_length,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC) AS rnk
    FROM streaks
    GROUP BY user_id, island
)
SELECT user_id, streak_length AS longest_streak
FROM streak_lengths
WHERE rnk = 1;
```

**Explanation:** The `login_date - ROW_NUMBER()` trick assigns the same "island" value to consecutive dates. When there is a gap, the island value changes. This is the fundamental "gaps and islands" technique.

---

### Q25: Pivot Table (Rows to Columns)

**Difficulty:** Hard
**Company:** Meta
**Topic:** CASE, aggregation, pivot

**Schema:**
```sql
CREATE TABLE sales (
    id       SERIAL PRIMARY KEY,
    product  VARCHAR(100) NOT NULL,
    quarter  VARCHAR(2) NOT NULL, -- 'Q1', 'Q2', 'Q3', 'Q4'
    amount   DECIMAL(10,2) NOT NULL
);
```

**Question:** Pivot the data so each product is a row with columns for Q1, Q2, Q3, Q4 totals.

**Solution:**
```sql
SELECT product,
       SUM(CASE WHEN quarter = 'Q1' THEN amount ELSE 0 END) AS q1,
       SUM(CASE WHEN quarter = 'Q2' THEN amount ELSE 0 END) AS q2,
       SUM(CASE WHEN quarter = 'Q3' THEN amount ELSE 0 END) AS q3,
       SUM(CASE WHEN quarter = 'Q4' THEN amount ELSE 0 END) AS q4,
       SUM(amount) AS total
FROM sales
GROUP BY product
ORDER BY product;
```

**PostgreSQL-specific with crosstab:**
```sql
SELECT *
FROM crosstab(
    'SELECT product, quarter, SUM(amount) FROM sales GROUP BY product, quarter ORDER BY 1, 2',
    'SELECT DISTINCT quarter FROM sales ORDER BY 1'
) AS ct(product VARCHAR, q1 DECIMAL, q2 DECIMAL, q3 DECIMAL, q4 DECIMAL);
```

---

### Q26: Moving Average

**Difficulty:** Medium-Hard
**Company:** Meta
**Topic:** Window frames, AVG OVER

**Schema:**
```sql
CREATE TABLE stock_prices (
    trade_date DATE PRIMARY KEY,
    price      DECIMAL(10,2) NOT NULL
);
```

**Question:** Calculate the 7-day moving average of stock prices.

**Solution:**
```sql
SELECT trade_date, price,
       ROUND(AVG(price) OVER (
           ORDER BY trade_date
           ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ), 2) AS moving_avg_7d,
       COUNT(*) OVER (
           ORDER BY trade_date
           ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ) AS window_size
FROM stock_prices
ORDER BY trade_date;
```

**Explanation:** `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW` creates a 7-row window. The `window_size` column helps identify the first 6 rows where the window is not yet full.

---

### Q27: Retention Rate

**Difficulty:** Hard
**Company:** Meta, Amazon
**Topic:** Self-join, date functions, cohort analysis

**Schema:**
```sql
CREATE TABLE user_activity (
    user_id       INTEGER NOT NULL,
    activity_date DATE NOT NULL
);
```

**Question:** Calculate Day-1 and Day-7 retention rates by signup cohort (first activity date).

**Solution:**
```sql
WITH first_activity AS (
    SELECT user_id, MIN(activity_date) AS signup_date
    FROM user_activity
    GROUP BY user_id
),
cohort AS (
    SELECT fa.signup_date,
           COUNT(DISTINCT fa.user_id) AS cohort_size,
           COUNT(DISTINCT CASE
               WHEN ua.activity_date = fa.signup_date + INTERVAL '1 day'
               THEN fa.user_id
           END) AS day1_retained,
           COUNT(DISTINCT CASE
               WHEN ua.activity_date = fa.signup_date + INTERVAL '7 days'
               THEN fa.user_id
           END) AS day7_retained
    FROM first_activity fa
    LEFT JOIN user_activity ua ON fa.user_id = ua.user_id
    GROUP BY fa.signup_date
)
SELECT signup_date,
       cohort_size,
       day1_retained,
       ROUND(day1_retained::DECIMAL / cohort_size * 100, 2) AS day1_retention_pct,
       day7_retained,
       ROUND(day7_retained::DECIMAL / cohort_size * 100, 2) AS day7_retention_pct
FROM cohort
ORDER BY signup_date;
```

**Explanation:** First find each user's signup date. Then check if they were active 1 day and 7 days later. Group by signup cohort to get retention rates.

---

### Q28: Funnel Analysis

**Difficulty:** Hard
**Company:** Meta
**Topic:** CASE, conditional aggregation, funnel

**Schema:**
```sql
CREATE TABLE events (
    user_id    INTEGER NOT NULL,
    event_name VARCHAR(100) NOT NULL, -- 'page_view', 'add_to_cart', 'checkout', 'purchase'
    event_time TIMESTAMP NOT NULL
);
```

**Question:** Build a conversion funnel showing drop-off at each stage.

**Solution:**
```sql
WITH user_funnel AS (
    SELECT user_id,
           MAX(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS viewed,
           MAX(CASE WHEN event_name = 'add_to_cart' THEN 1 ELSE 0 END) AS added,
           MAX(CASE WHEN event_name = 'checkout' THEN 1 ELSE 0 END) AS checked_out,
           MAX(CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END) AS purchased
    FROM events
    GROUP BY user_id
)
SELECT
    SUM(viewed) AS page_views,
    SUM(added) AS add_to_carts,
    SUM(checked_out) AS checkouts,
    SUM(purchased) AS purchases,
    ROUND(SUM(added)::DECIMAL / NULLIF(SUM(viewed), 0) * 100, 2) AS view_to_cart_pct,
    ROUND(SUM(checked_out)::DECIMAL / NULLIF(SUM(added), 0) * 100, 2) AS cart_to_checkout_pct,
    ROUND(SUM(purchased)::DECIMAL / NULLIF(SUM(checked_out), 0) * 100, 2) AS checkout_to_purchase_pct
FROM user_funnel;
```

---

### Q29: Finding Mutual Friends

**Difficulty:** Hard
**Company:** Meta
**Topic:** Self-join, set intersection

**Schema:**
```sql
CREATE TABLE friendships (
    user_id1 INTEGER NOT NULL,
    user_id2 INTEGER NOT NULL,
    PRIMARY KEY (user_id1, user_id2),
    CHECK (user_id1 < user_id2)
);
```

**Question:** For users 1 and 2, find their mutual friends.

**Solution:**
```sql
WITH friends_of_1 AS (
    SELECT user_id2 AS friend_id FROM friendships WHERE user_id1 = 1
    UNION
    SELECT user_id1 FROM friendships WHERE user_id2 = 1
),
friends_of_2 AS (
    SELECT user_id2 AS friend_id FROM friendships WHERE user_id1 = 2
    UNION
    SELECT user_id1 FROM friendships WHERE user_id2 = 2
)
SELECT f1.friend_id AS mutual_friend
FROM friends_of_1 f1
JOIN friends_of_2 f2 ON f1.friend_id = f2.friend_id;
```

**Generic version - mutual friends for any pair:**
```sql
CREATE OR REPLACE FUNCTION mutual_friends(a INTEGER, b INTEGER)
RETURNS TABLE(friend_id INTEGER) AS $$
    WITH all_friends AS (
        SELECT user_id1 AS uid, user_id2 AS fid FROM friendships
        UNION ALL
        SELECT user_id2, user_id1 FROM friendships
    )
    SELECT af1.fid AS friend_id
    FROM all_friends af1
    JOIN all_friends af2 ON af1.fid = af2.fid
    WHERE af1.uid = a AND af2.uid = b;
$$ LANGUAGE sql;
```

---

### Q30: Session Analysis (Sessionization)

**Difficulty:** Hard
**Company:** Amazon, Google
**Topic:** LAG, conditional window functions

**Schema:**
```sql
CREATE TABLE clicks (
    user_id    INTEGER NOT NULL,
    click_time TIMESTAMP NOT NULL,
    page       VARCHAR(255) NOT NULL
);
```

**Question:** Define a session as a series of clicks where no gap exceeds 30 minutes. Assign session IDs and find average session duration.

**Solution:**
```sql
WITH click_gaps AS (
    SELECT user_id, click_time, page,
           EXTRACT(EPOCH FROM (
               click_time - LAG(click_time) OVER (PARTITION BY user_id ORDER BY click_time)
           )) / 60.0 AS gap_minutes
    FROM clicks
),
sessionized AS (
    SELECT *,
           SUM(CASE WHEN gap_minutes > 30 OR gap_minutes IS NULL THEN 1 ELSE 0 END)
               OVER (PARTITION BY user_id ORDER BY click_time) AS session_id
    FROM click_gaps
)
SELECT user_id, session_id,
       MIN(click_time) AS session_start,
       MAX(click_time) AS session_end,
       EXTRACT(EPOCH FROM (MAX(click_time) - MIN(click_time))) / 60.0 AS duration_minutes,
       COUNT(*) AS click_count
FROM sessionized
GROUP BY user_id, session_id
ORDER BY user_id, session_start;
```

**Average session duration:**
```sql
WITH -- (same CTEs as above) ...
session_stats AS (
    SELECT user_id, session_id,
           EXTRACT(EPOCH FROM (MAX(click_time) - MIN(click_time))) / 60.0 AS duration_minutes
    FROM sessionized
    GROUP BY user_id, session_id
)
SELECT ROUND(AVG(duration_minutes)::DECIMAL, 2) AS avg_session_minutes
FROM session_stats
WHERE duration_minutes > 0; -- exclude single-click sessions
```

**Explanation:** The sessionization technique uses LAG to find time gaps, then a running SUM of "new session" flags to assign session IDs. This is a standard technique at Meta and Amazon.


### Junior → FAANG: Hard SQL Interview Questions: Window Functions and Complex Aggregations

Hard SQL questions typically involve window functions, complex ranking, or multi-dimensional aggregation that cannot be expressed with simple GROUP BY. Window functions (ROW_NUMBER, RANK, DENSE_RANK, NTILE, LAG, LEAD, FIRST_VALUE, LAST_VALUE) perform calculations across a partition of rows without collapsing the partition into a single row. Practice the PARTITION BY and ORDER BY clauses within window functions, and understand the FRAME clause (ROWS BETWEEN, RANGE BETWEEN) for rolling calculations.

### Senior @ FAANG: Hard SQL at the Senior Bar: Performance Implications and OLAP Architecture

At the senior level, hard SQL questions probe your understanding of why window functions are expensive at scale: they require sorting the partition, which is an O(n log n) operation, and the partition must fit in memory for the sort to be efficient. For large datasets, window functions can consume significant memory and time, which motivates the use of pre-aggregated data stores (OLAP cubes, materialized views, or columnar stores like Redshift and BigQuery that are optimized for analytical queries). The bar-raiser probes: 'if this window function runs on a table with 100 billion rows, what are the challenges?'. The correct answer covers partitioning strategies (process the query in parallel across partitions), materialized views (pre-compute the window function result and update it incrementally), and the trade-off between query freshness and query performance for analytical workloads.

---
