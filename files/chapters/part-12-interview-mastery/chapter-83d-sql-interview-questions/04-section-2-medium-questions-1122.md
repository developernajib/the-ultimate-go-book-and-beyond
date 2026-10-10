## 83D.4 Section 2: Medium Questions (11-22)

### Q11: Department Highest Salary

**Difficulty:** Medium
**Company:** Amazon, Meta
**Topic:** Window functions, JOIN

**Schema:**
```sql
CREATE TABLE department (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);

CREATE TABLE employee (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    salary        INTEGER NOT NULL,
    department_id INTEGER REFERENCES department(id)
);
```

**Question:** Find the employee with the highest salary in each department.

**Solution:**
```sql
SELECT d.name AS department, e.name AS employee, e.salary
FROM employee e
JOIN department d ON e.department_id = d.id
WHERE (e.department_id, e.salary) IN (
    SELECT department_id, MAX(salary)
    FROM employee
    GROUP BY department_id
);
```

**Window function approach:**
```sql
SELECT department, employee, salary
FROM (
    SELECT d.name AS department,
           e.name AS employee,
           e.salary,
           RANK() OVER (PARTITION BY e.department_id ORDER BY e.salary DESC) AS rnk
    FROM employee e
    JOIN department d ON e.department_id = d.id
) ranked
WHERE rnk = 1;
```

**Explanation:** RANK handles ties (multiple employees with the same highest salary). The subquery approach also handles ties because the IN check matches salary values.

---

### Q12: Nth Highest Salary

**Difficulty:** Medium
**Company:** Amazon
**Topic:** Window functions, parameterized queries

**Question:** Write a function to get the nth highest salary.

**Solution:**
```sql
CREATE OR REPLACE FUNCTION get_nth_highest_salary(n INTEGER)
RETURNS TABLE(salary INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT e.salary
    FROM employee e
    ORDER BY e.salary DESC
    OFFSET n - 1
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;
```

**Go Integration (pgx):**
```go
func (r *Repository) GetNthHighestSalary(ctx context.Context, n int) (*int32, error) {
    var salary *int32
    err := r.pool.QueryRow(ctx,
        `SELECT DISTINCT salary FROM employee ORDER BY salary DESC OFFSET $1 LIMIT 1`,
        n-1,
    ).Scan(&salary)
    if err == pgx.ErrNoRows {
        return nil, nil
    }
    return salary, err
}
```

---

### Q13: Rank Scores

**Difficulty:** Medium
**Company:** Meta
**Topic:** DENSE_RANK

**Schema:**
```sql
CREATE TABLE scores (
    id    SERIAL PRIMARY KEY,
    score DECIMAL(5,2) NOT NULL
);
```

**Question:** Rank scores. If two scores are the same, they should have the same rank, and the next rank should be consecutive (dense ranking).

**Solution:**
```sql
SELECT score,
       DENSE_RANK() OVER (ORDER BY score DESC) AS rank
FROM scores
ORDER BY score DESC;
```

**Explanation:** DENSE_RANK assigns consecutive ranks with no gaps for ties. RANK would leave gaps (e.g., 1, 1, 3). ROW_NUMBER would give unique ranks (1, 2, 3) even for ties.

---

### Q14: Consecutive Numbers

**Difficulty:** Medium
**Company:** Amazon
**Topic:** LAG/LEAD, self-join

**Schema:**
```sql
CREATE TABLE logs (
    id  SERIAL PRIMARY KEY,
    num INTEGER NOT NULL
);
```

**Question:** Find all numbers that appear at least three times consecutively.

**Solution:**
```sql
SELECT DISTINCT num AS consecutive_nums
FROM (
    SELECT num,
           LAG(num, 1) OVER (ORDER BY id) AS prev1,
           LAG(num, 2) OVER (ORDER BY id) AS prev2
    FROM logs
) sub
WHERE num = prev1 AND num = prev2;
```

**Self-join approach:**
```sql
SELECT DISTINCT l1.num AS consecutive_nums
FROM logs l1
JOIN logs l2 ON l1.id = l2.id - 1
JOIN logs l3 ON l2.id = l3.id - 1
WHERE l1.num = l2.num AND l2.num = l3.num;
```

**Explanation:** The window function approach is cleaner. LAG(num, 1) gives the previous row's num, LAG(num, 2) gives two rows back. If all three match, we have three consecutive occurrences.

---

### Q15: Department Top Three Salaries

**Difficulty:** Hard (but commonly asked as Medium)
**Company:** Amazon, Meta
**Topic:** DENSE_RANK, PARTITION BY

**Schema:** Same as Q11.

**Question:** Find employees who earn one of the top three salaries in their department.

**Solution:**
```sql
SELECT department, employee, salary
FROM (
    SELECT d.name AS department,
           e.name AS employee,
           e.salary,
           DENSE_RANK() OVER (PARTITION BY e.department_id ORDER BY e.salary DESC) AS rnk
    FROM employee e
    JOIN department d ON e.department_id = d.id
) ranked
WHERE rnk <= 3;
```

**Explanation:** DENSE_RANK within each department partition assigns ranks. Ties share the same rank, so if three people tie for the highest salary, they all get rank 1.

---

### Q16: Exchange Seats

**Difficulty:** Medium
**Company:** Meta
**Topic:** CASE, MOD

**Schema:**
```sql
CREATE TABLE seat (
    id      SERIAL PRIMARY KEY,
    student VARCHAR(100) NOT NULL
);
```

**Question:** Swap every two consecutive students' seat IDs. If the number of students is odd, the last student's ID stays unchanged.

**Solution:**
```sql
SELECT
    CASE
        WHEN id % 2 = 1 AND id = (SELECT MAX(id) FROM seat) THEN id
        WHEN id % 2 = 1 THEN id + 1
        ELSE id - 1
    END AS id,
    student
FROM seat
ORDER BY id;
```

**Explanation:** Odd IDs become even (id+1) and even IDs become odd (id-1), except the last student if the count is odd - their ID stays the same.

---

### Q17: Tree Node Classification

**Difficulty:** Medium
**Company:** Amazon
**Topic:** CASE, self-referential

**Schema:**
```sql
CREATE TABLE tree (
    id   INTEGER PRIMARY KEY,
    p_id INTEGER REFERENCES tree(id)
);
```

**Question:** Classify each node as Root, Inner, or Leaf.

**Solution:**
```sql
SELECT id,
    CASE
        WHEN p_id IS NULL THEN 'Root'
        WHEN id IN (SELECT p_id FROM tree WHERE p_id IS NOT NULL) THEN 'Inner'
        ELSE 'Leaf'
    END AS type
FROM tree;
```

**Explanation:** Root has no parent (p_id IS NULL). Inner nodes appear as someone's parent. Everything else is a leaf.

---

### Q18: Trips and Users (Cancellation Rate)

**Difficulty:** Hard (commonly asked at Medium level)
**Company:** Meta, Uber
**Topic:** JOIN, CASE, GROUP BY, filtering

**Schema:**
```sql
CREATE TABLE trips (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL,
    driver_id   INTEGER NOT NULL,
    city_id     INTEGER NOT NULL,
    status      VARCHAR(50) NOT NULL, -- 'completed', 'canceled_by_driver', 'canceled_by_client'
    request_at  DATE NOT NULL
);

CREATE TABLE users (
    users_id INTEGER PRIMARY KEY,
    banned   VARCHAR(3) NOT NULL, -- 'Yes' or 'No'
    role     VARCHAR(10) NOT NULL -- 'client' or 'driver'
);
```

**Question:** Find the cancellation rate for unbanned users between '2013-10-01' and '2013-10-03', rounded to 2 decimal places.

**Solution:**
```sql
SELECT t.request_at AS day,
       ROUND(
           SUM(CASE WHEN t.status != 'completed' THEN 1 ELSE 0 END)::DECIMAL
           / COUNT(*), 2
       ) AS cancellation_rate
FROM trips t
JOIN users c ON t.client_id = c.users_id AND c.banned = 'No'
JOIN users d ON t.driver_id = d.users_id AND d.banned = 'No'
WHERE t.request_at BETWEEN '2013-10-01' AND '2013-10-03'
GROUP BY t.request_at
ORDER BY t.request_at;
```

**Explanation:** Join with users twice - once for client, once for driver - filtering out banned users. Then calculate the ratio of non-completed trips.

---

### Q19: Human Traffic of Stadium

**Difficulty:** Hard
**Company:** Amazon
**Topic:** Window functions, consecutive rows

**Schema:**
```sql
CREATE TABLE stadium (
    id         SERIAL PRIMARY KEY,
    visit_date DATE NOT NULL,
    people     INTEGER NOT NULL
);
```

**Question:** Find rows where people >= 100 for three or more consecutive IDs.

**Solution:**
```sql
WITH high_traffic AS (
    SELECT *,
           id - ROW_NUMBER() OVER (ORDER BY id) AS grp
    FROM stadium
    WHERE people >= 100
)
SELECT id, visit_date, people
FROM high_traffic
WHERE grp IN (
    SELECT grp FROM high_traffic GROUP BY grp HAVING COUNT(*) >= 3
)
ORDER BY id;
```

**Explanation:** The trick `id - ROW_NUMBER()` assigns the same group number to consecutive qualifying rows. If a group has 3+ members, all its rows qualify. This is a classic "islands" technique.

---

### Q20: Median Employee Salary

**Difficulty:** Hard
**Company:** Meta
**Topic:** Window functions, median calculation

**Schema:** Same employee table.

**Question:** Find the median salary per department.

**Solution:**
```sql
WITH ranked AS (
    SELECT department_id, salary,
           ROW_NUMBER() OVER (PARTITION BY department_id ORDER BY salary) AS rn,
           COUNT(*) OVER (PARTITION BY department_id) AS cnt
    FROM employee
)
SELECT department_id,
       AVG(salary) AS median_salary
FROM ranked
WHERE rn IN (FLOOR((cnt + 1.0) / 2), CEIL((cnt + 1.0) / 2))
GROUP BY department_id;
```

**Explanation:** For odd counts, FLOOR and CEIL give the same middle index. For even counts, they give the two middle indices. AVG of those gives the median.

---

### Q21: Cumulative Sum (Running Total)

**Difficulty:** Medium
**Company:** Amazon
**Topic:** SUM OVER, window frames

**Schema:**
```sql
CREATE TABLE transactions (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL,
    amount_cents BIGINT NOT NULL,
    txn_date    DATE NOT NULL
);
```

**Question:** For each account, compute the running total of amounts ordered by date.

**Solution:**
```sql
SELECT account_id, txn_date, amount_cents,
       SUM(amount_cents) OVER (
           PARTITION BY account_id
           ORDER BY txn_date
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_total
FROM transactions
ORDER BY account_id, txn_date;
```

**Go Integration (pgx):**
```go
type TransactionWithRunningTotal struct {
    AccountID         int32
    TxnDate           time.Time
    AmountCents       int64
    RunningTotalCents int64
}

func (r *Repository) GetRunningTotals(ctx context.Context, accountID int32) ([]TransactionWithRunningTotal, error) {
    rows, err := r.pool.Query(ctx, `
        SELECT account_id, txn_date, amount_cents,
               SUM(amount_cents) OVER (
                   PARTITION BY account_id ORDER BY txn_date
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS running_total
        FROM transactions
        WHERE account_id = $1
        ORDER BY txn_date`, accountID)
    if err != nil {
        return nil, fmt.Errorf("query running totals: %w", err)
    }
    defer rows.Close()

    var results []TransactionWithRunningTotal
    for rows.Next() {
        var t TransactionWithRunningTotal
        if err := rows.Scan(&t.AccountID, &t.TxnDate, &t.AmountCents, &t.RunningTotalCents); err != nil {
            return nil, fmt.Errorf("scan row: %w", err)
        }
        results = append(results, t)
    }
    return results, rows.Err()
}
```

---

### Q22: Year-over-Year Growth

**Difficulty:** Medium
**Company:** Meta, Amazon
**Topic:** LAG, window functions, date functions

**Schema:**
```sql
CREATE TABLE revenue (
    id      SERIAL PRIMARY KEY,
    year    INTEGER NOT NULL,
    month   INTEGER NOT NULL,
    amount_cents BIGINT NOT NULL
);
```

**Question:** Calculate year-over-year revenue growth percentage for each month.

**Solution:**
```sql
SELECT year, month, amount_cents,
       LAG(amount_cents) OVER (PARTITION BY month ORDER BY year) AS prev_year_amount_cents,
       ROUND(
           (amount_cents - LAG(amount_cents) OVER (PARTITION BY month ORDER BY year))
           / LAG(amount_cents) OVER (PARTITION BY month ORDER BY year)::numeric * 100, 2
       ) AS yoy_growth_pct
FROM revenue
ORDER BY month, year;
```

**Explanation:** PARTITION BY month ensures we compare the same month across years. LAG gives us the previous year's amount for that month.


### Junior → FAANG: Medium SQL Interview Questions: Joins and Subqueries

Medium SQL questions introduce self-joins, correlated subqueries, and multi-step aggregations. Common patterns: finding duplicates (self-join on a non-unique column), finding the second-highest value (subquery with MAX and NOT IN, or ROW_NUMBER), and finding records that satisfy conditions across related tables (EXISTS versus IN). The most common error at this level is writing a correlated subquery that produces correct results but runs in O(n^2) time because it is evaluated once per row in the outer query.

### Senior @ FAANG: Medium SQL at the Senior Bar: Query Optimization and CTE Refactoring

At the senior level, medium SQL questions are evaluated not just for correctness but for optimization. A correlated subquery that can be rewritten as a JOIN is a common optimization opportunity: the optimizer can usually convert the JOIN to an efficient hash join or merge join, while the correlated subquery forces a nested loop evaluation. CTEs (Common Table Expressions) are the readability tool that separates readable, maintainable SQL from unreadable nested subqueries. Senior candidates should reflexively use CTEs for multi-step queries and should be able to explain when a CTE is or is not materialized by the query planner (PostgreSQL materializes CTEs by default in older versions, which can prevent the optimizer from pushing conditions into the CTE, the MATERIALIZED and NOT MATERIALIZED hints address this).

---
