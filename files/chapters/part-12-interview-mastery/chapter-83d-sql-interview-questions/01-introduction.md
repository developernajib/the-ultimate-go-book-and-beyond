## 83D.1 Overview

Even as a Go backend engineer, SQL questions are a staple of FAANG interviews. Amazon, Meta, and Google all include SQL rounds - sometimes as standalone assessments, sometimes embedded in system design discussions. This chapter covers 30 SQL interview questions with complete solutions, explanations, and Go integration patterns using `sqlc` and `pgx`.


### Junior → FAANG: Getting Started with SQL Interview Questions

SQL questions in interviews are a direct test of whether you can translate a business question into a correct query. The most common entry-level gaps are not knowing when to use GROUP BY versus HAVING, confusing WHERE (filters before aggregation) and HAVING (filters after aggregation), and forgetting to handle NULL values in aggregations and comparisons. Practice writing queries from scratch rather than modifying existing ones, and run them against a real database to verify correctness.

### Senior @ FAANG: SQL Interview Mastery as a Data-Engineering Collaboration Skill

At the senior level, SQL fluency is a collaboration prerequisite for working with data engineering and analytics teams. Senior engineers who can write efficient queries, read EXPLAIN plans, and identify index usage patterns can debug data quality issues and performance problems without requiring a data engineer's help every time. This autonomy is valued at companies like Stripe, Airbnb, and Lyft where backend engineers are expected to own their data stack end-to-end. Staff engineers also need to evaluate when a SQL query is the wrong tool: some computations that look like SQL problems are better served by a stream processing system (Flink, Spark Streaming) or a pre-aggregated data store.

---

