# Chapter 83D: SQL Interview Questions for Go Engineers


### Junior → FAANG: SQL Interview Preparation Overview

SQL interview questions at FAANG companies focus on practical query writing, query optimization, and data modeling. The minimum preparation covers SELECT with joins, aggregations, and GROUP BY. Subqueries and CTEs. Window functions (ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD). And query optimization (reading EXPLAIN output, identifying missing indexes). Know the difference between INNER, LEFT, RIGHT, and FULL OUTER joins, and when each is appropriate. Common mistake: knowing JOIN syntax without understanding the row count implications of each join type.

### Senior @ FAANG: SQL as a Platform Engineering Concern at the Senior Level

At the senior and staff level, SQL interview questions probe your ability to design schemas that support efficient queries at scale, diagnose query performance problems in production, and make trade-off decisions about normalization, indexing, and query patterns. Bar-raisers ask about the interaction between indexes and query plans: when does an index not get used (e.g., a function applied to an indexed column in the WHERE clause, or a leading column mismatch in a composite index), and what is the cost of maintaining an index on a high-write-rate table. Staff-level concerns include database schema governance: how do you enforce schema standards across multiple teams, how do you manage schema migrations in a CI/CD pipeline, and how do you handle the case where a schema change requires multiple deployments to avoid downtime (the expand-contract pattern).

