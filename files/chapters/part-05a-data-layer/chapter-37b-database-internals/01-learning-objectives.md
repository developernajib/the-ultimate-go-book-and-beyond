## Learning Objectives

By the end of this chapter you will be able to:

- Explain B-tree and LSM-tree index structures from first principles, including how insertions, deletions, and compaction work
- Describe how PostgreSQL's Write-Ahead Log guarantees durability and enables replication and PITR
- Explain MVCC's visibility rules, how dead tuples accumulate, and why autovacuum matters
- Read and interpret `EXPLAIN ANALYZE` output to diagnose real performance issues
- Choose the correct index type (B-tree, GIN, GiST, BRIN, partial, expression) for a given access pattern
- Describe the four transaction isolation levels and the anomalies they prevent
- Size a connection pool correctly and explain the trade-offs between PgBouncer pooling modes
- Answer 20+ FAANG-level database internals interview questions confidently

### Junior to FAANG: Calibrated Outcomes by Seniority

Junior engineers working through this chapter should target three concrete outcomes. First, you should be able to look at a slow query and name the five places it can go wrong: parser, planner, buffer cache, index traversal, heap access. Second, you should be able to write a migration that adds an index `CONCURRENTLY` without understanding why that keyword exists becoming a blocker, because you know it avoids the exclusive lock a naked `CREATE INDEX` would take. Third, you should be able to read a `pg_stat_activity` snapshot and identify an idle-in-transaction connection that is blocking autovacuum from reclaiming dead tuples. Those three skills are the foundation of the mid-level database competency bar at Google, Meta, and Amazon.

A worked interview example that maps to this objective set: "Your `orders` table has 50 million rows and queries by `customer_id` started getting slow last week. Walk me through diagnosis." The answer sequence is check `pg_stat_user_tables` for sequential scans, run `EXPLAIN (ANALYZE, BUFFERS)` on a representative query, check `pg_stats` for correlation and `n_distinct` on `customer_id`, consider whether a partial index on `status = 'active'` is enough, and finally check `pg_stat_progress_vacuum` and dead tuple counts. A junior who can narrate that sequence without prompting lands the offer. One who jumps straight to "add an index" without measuring does not.

### Senior at FAANG: Objectives as Platform Contracts

At staff and principal level the learning objectives are not personal skills, they are organizational capabilities you are responsible for guaranteeing across a fleet. "Choose the correct index type" becomes "define the index review policy that catches GIN-on-small-table mistakes at code review time". "Explain WAL and PITR" becomes "own the RPO and RTO SLOs for the primary transactional fleet and prove them with quarterly restore drills from object storage". "Size a connection pool correctly" becomes "define the capacity model that ties PgBouncer pool size, Postgres `max_connections`, worker count per application, and per-query memory budget into a single coherent formula that application teams can self-serve against".

The senior-track objective the rest of this chapter is secretly aimed at is the ability to make storage engine decisions defensible under adversarial review. When a sister team proposes moving a write-heavy workload to a new datastore, you need to be able to reason in public about the write amplification curve of their current B-tree engine, the space amplification of the LSM alternative they are proposing, the bloom filter false positive rate implications for their specific key distribution, and the compaction CPU budget on the instance type they have in mind. Landing those arguments with quantitative estimates rather than vibes is the difference between senior and staff on the database track. The objectives in this chapter are the minimum toolkit for that conversation.

---
