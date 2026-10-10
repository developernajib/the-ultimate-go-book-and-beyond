## Summary

1. **Master window functions.** They appear in 80% of medium/hard SQL interview questions. DENSE_RANK, LAG, and SUM OVER are the most common.

2. **Know the gaps-and-islands technique.** The `value - ROW_NUMBER()` trick solves consecutive-sequence problems elegantly.

3. **Understand query optimization.** Be ready to discuss EXPLAIN output, index selection, and why keyset pagination beats OFFSET.

4. **Practice pivot queries.** CASE-based pivots are asked frequently and are easy to get wrong.

5. **Recursive CTEs** are essential for tree/graph structures in SQL (org charts, bill of materials, category trees).

6. **Always discuss Go integration.** Show you can write the SQL AND integrate it into a Go service with proper error handling, connection pooling, and parameterized queries.

7. **In system design rounds,** lead with access patterns, then design the schema to support them. Discuss indexing, sharding, and caching strategies.

---

*Next chapter: Chapter 83E - Low-Level Design in Go*


### Junior → FAANG: SQL Interview Key Takeaways

The key takeaways from SQL interview preparation: master the JOIN types and their row count implications. Know when to use subqueries versus CTEs versus window functions. Understand the index-query relationship well enough to read a basic EXPLAIN output. And handle NULL values explicitly in every query. The actionable next step is to write and verify solutions to 20 SQL problems from this chapter without external reference, then check each solution for NULL correctness and index usage.

### Senior @ FAANG: SQL Takeaways as a Data Literacy Benchmark

Senior engineers should treat SQL fluency as a data literacy benchmark, not just an interview preparation topic. The engineers who ship the fastest at data-intensive companies are those who can independently query their production databases, validate their data models against real data, and debug data quality issues without routing every question through a data team. This autonomy requires not just SQL fluency but also knowledge of the production database's schema, the team's query patterns, and the performance characteristics of the database at the team's data volume. Building this knowledge proactively, rather than waiting for an incident to require it, is a signal of senior-level ownership.

