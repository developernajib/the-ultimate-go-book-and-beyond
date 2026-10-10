## 83D.3 Section 1: Easy Questions (1-10)

### Q1: Second Highest Salary

**Difficulty:** Easy
**Company:** Amazon, Meta
**Topic:** Subquery, LIMIT/OFFSET

**Schema:**
```sql
CREATE TABLE employees (
    id       SERIAL PRIMARY KEY,
    name     VARCHAR(100) NOT NULL,
    salary   INTEGER NOT NULL
);
```

**Question:** Find the second highest salary. Return NULL if there is no second highest.

**Solution:**
```sql
SELECT MAX(salary) AS second_highest_salary
FROM employees
WHERE salary < (SELECT MAX(salary) FROM employees);
```

**Alternative using DENSE_RANK:**
```sql
SELECT salary AS second_highest_salary
FROM (
    SELECT salary, DENSE_RANK() OVER (ORDER BY salary DESC) AS rnk
    FROM employees
) ranked
WHERE rnk = 2
LIMIT 1;
```

**Explanation:** The first approach finds the max salary that is strictly less than the overall max. If all salaries are the same, the subquery returns no rows and MAX returns NULL. The window function approach assigns ranks and picks rank 2.

**Go Integration (sqlc):**
```go
// query.sql
// -- name: GetSecondHighestSalary :one
// SELECT MAX(salary) AS second_highest_salary
// FROM employees
// WHERE salary < (SELECT MAX(salary) FROM employees);

func (s *Service) GetSecondHighestSalary(ctx context.Context) (*int32, error) {
    return s.queries.GetSecondHighestSalary(ctx)
}
```

---

### Q2: Duplicate Emails

**Difficulty:** Easy
**Company:** Meta
**Topic:** GROUP BY, HAVING

**Schema:**
```sql
CREATE TABLE person (
    id    SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL
);
```

**Question:** Find all duplicate emails.

**Solution:**
```sql
SELECT email
FROM person
GROUP BY email
HAVING COUNT(*) > 1;
```

**Explanation:** GROUP BY collapses rows by email, HAVING filters groups to those with more than one occurrence. This is O(n) with a hash aggregate.

**Go Integration (pgx):**
```go
func (r *Repository) FindDuplicateEmails(ctx context.Context) ([]string, error) {
    rows, err := r.pool.Query(ctx,
        "SELECT email FROM person GROUP BY email HAVING COUNT(*) > 1")
    if err != nil {
        return nil, fmt.Errorf("query duplicate emails: %w", err)
    }
    defer rows.Close()

    var emails []string
    for rows.Next() {
        var email string
        if err := rows.Scan(&email); err != nil {
            return nil, fmt.Errorf("scan email: %w", err)
        }
        emails = append(emails, email)
    }
    return emails, rows.Err()
}
```

---

### Q3: Customers Who Never Order

**Difficulty:** Easy
**Company:** Amazon
**Topic:** LEFT JOIN, IS NULL

**Schema:**
```sql
CREATE TABLE customers (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);

CREATE TABLE orders (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id)
);
```

**Question:** Find customers who have never placed an order.

**Solution:**
```sql
SELECT c.name AS customers
FROM customers c
LEFT JOIN orders o ON c.id = o.customer_id
WHERE o.id IS NULL;
```

**Alternative with NOT EXISTS:**
```sql
SELECT name AS customers
FROM customers c
WHERE NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.customer_id = c.id
);
```

**Explanation:** LEFT JOIN keeps all customers. Those without orders have NULL in the orders columns. NOT EXISTS is often more readable and equally performant with proper indexing on `orders.customer_id`.

**Index recommendation:**
```sql
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
```

---

### Q4: Rising Temperature

**Difficulty:** Easy
**Company:** Amazon
**Topic:** Self JOIN, date arithmetic

**Schema:**
```sql
CREATE TABLE weather (
    id          SERIAL PRIMARY KEY,
    record_date DATE NOT NULL,
    temperature INTEGER NOT NULL
);
```

**Question:** Find all dates where the temperature was higher than the previous day.

**Solution:**
```sql
SELECT w1.id
FROM weather w1
JOIN weather w2 ON w1.record_date = w2.record_date + INTERVAL '1 day'
WHERE w1.temperature > w2.temperature;
```

**Alternative with LAG:**
```sql
SELECT id
FROM (
    SELECT id, temperature,
           LAG(temperature) OVER (ORDER BY record_date) AS prev_temp
    FROM weather
) sub
WHERE temperature > prev_temp;
```

**Explanation:** The self-join approach matches each day with the previous day. The LAG window function approach is cleaner and avoids the join. Both assume no gaps in dates (the LAG approach handles gaps incorrectly if dates are not consecutive).

---

### Q5: Employees Earning More Than Their Managers

**Difficulty:** Easy
**Company:** Meta
**Topic:** Self JOIN

**Schema:**
```sql
CREATE TABLE employee (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    salary     INTEGER NOT NULL,
    manager_id INTEGER REFERENCES employee(id)
);
```

**Question:** Find employees who earn more than their managers.

**Solution:**
```sql
SELECT e.name AS employee
FROM employee e
JOIN employee m ON e.manager_id = m.id
WHERE e.salary > m.salary;
```

**Explanation:** Self-join the employee table - once as the employee, once as the manager. Filter where the employee's salary exceeds the manager's salary.

---

### Q6: Delete Duplicate Emails

**Difficulty:** Easy
**Company:** Meta
**Topic:** DELETE with self-join

**Schema:** Same `person` table as Q2.

**Question:** Delete all duplicate emails, keeping only the one with the smallest id.

**Solution:**
```sql
DELETE FROM person p1
USING person p2
WHERE p1.email = p2.email
  AND p1.id > p2.id;
```

**Standard SQL alternative:**
```sql
DELETE FROM person
WHERE id NOT IN (
    SELECT MIN(id) FROM person GROUP BY email
);
```

**Explanation:** The USING syntax is PostgreSQL-specific and efficient. For each duplicate group, we keep the row with the minimum id and delete the rest.

---

### Q7: Combine Two Tables

**Difficulty:** Easy
**Company:** Amazon
**Topic:** LEFT JOIN

**Schema:**
```sql
CREATE TABLE person (
    person_id  SERIAL PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name  VARCHAR(100) NOT NULL
);

CREATE TABLE address (
    address_id SERIAL PRIMARY KEY,
    person_id  INTEGER REFERENCES person(person_id),
    city       VARCHAR(100),
    state      VARCHAR(100)
);
```

**Question:** Report first name, last name, city, and state for every person (even if they have no address).

**Solution:**
```sql
SELECT p.first_name, p.last_name, a.city, a.state
FROM person p
LEFT JOIN address a ON p.person_id = a.person_id;
```

**Explanation:** LEFT JOIN ensures all persons are included. Those without an address get NULLs for city and state.

---

### Q8: Classes with More Than 5 Students

**Difficulty:** Easy
**Company:** Amazon
**Topic:** GROUP BY, HAVING, DISTINCT

**Schema:**
```sql
CREATE TABLE courses (
    student VARCHAR(100) NOT NULL,
    class   VARCHAR(100) NOT NULL
);
```

**Question:** Find classes with at least 5 students.

**Solution:**
```sql
SELECT class
FROM courses
GROUP BY class
HAVING COUNT(DISTINCT student) >= 5;
```

**Explanation:** COUNT(DISTINCT student) handles the case where the same student might be listed multiple times for the same class.

---

### Q9: Not Boring Movies

**Difficulty:** Easy
**Company:** Amazon
**Topic:** WHERE, MOD, ORDER BY

**Schema:**
```sql
CREATE TABLE cinema (
    id          SERIAL PRIMARY KEY,
    movie       VARCHAR(255) NOT NULL,
    description VARCHAR(255),
    rating      DECIMAL(3,1) NOT NULL
);
```

**Question:** Find movies with an odd-numbered ID and a description that is not "boring". Order by rating descending.

**Solution:**
```sql
SELECT *
FROM cinema
WHERE id % 2 = 1
  AND description != 'boring'
ORDER BY rating DESC;
```

**Explanation:** `id % 2 = 1` selects odd IDs. Simple filtering and ordering.

---

### Q10: Big Countries

**Difficulty:** Easy
**Company:** Meta
**Topic:** WHERE, OR

**Schema:**
```sql
CREATE TABLE world (
    name       VARCHAR(100) PRIMARY KEY,
    continent  VARCHAR(100),
    area       INTEGER,
    population BIGINT,
    gdp        BIGINT
);
```

**Question:** Find countries with area >= 3,000,000 or population >= 25,000,000.

**Solution:**
```sql
SELECT name, population, area
FROM world
WHERE area >= 3000000 OR population >= 25000000;
```

**Alternative using UNION (can be faster with separate indexes):**
```sql
SELECT name, population, area FROM world WHERE area >= 3000000
UNION
SELECT name, population, area FROM world WHERE population >= 25000000;
```


### Junior → FAANG: Easy SQL Interview Questions: Building the Foundation

Easy SQL questions test the fundamentals: SELECT with WHERE, ORDER BY, LIMIT, GROUP BY, and HAVING. They also cover basic JOINs (INNER and LEFT) and simple aggregates (COUNT, SUM, AVG, MIN, MAX). The goal at this level is correctness and completeness: does your query return the right rows, and does it handle the edge cases (NULL values, empty groups, zero counts). Practice writing each query type from memory, not from looking at a reference, to build the muscle memory needed for time-pressured interviews.

### Senior @ FAANG: Easy SQL as a Diagnostic Tool for Interview Readiness

Senior candidates who find easy SQL questions challenging have a skill gap that will surface in system design discussions about database access patterns, in data model reviews, and in debugging database performance issues. The calibration question is: can you write any easy SQL query correctly on the first attempt without syntax errors and with correct NULL handling? If not, the fix is 30 minutes per day of SQL practice on a platform like LeetCode or Mode Analytics for two weeks. The senior-level concern is not that you cannot write easy SQL but that you cannot read the SQL your ORM generates and reason about whether it is correct and efficient.

---
