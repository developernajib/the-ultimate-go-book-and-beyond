## Exercises

**Exercise 1**: Create a table with 10 million rows and two indexes: one on a UUID column and one on a BIGSERIAL. Measure insert rate with `EXPLAIN ANALYZE` on bulk inserts. Compare B-tree height using `bt_metap()`.

**Exercise 2**: Use `pageinspect`'s `heap_page_items()` to observe `xmin`/`xmax` values before and after an UPDATE. Run `VACUUM` and observe the dead tuples disappear.

**Exercise 3**: Write a Go function that runs a query, captures `EXPLAIN ANALYZE` JSON output, and alerts (logs a warning) when estimated rows differ from actual rows by more than 10x.

**Exercise 4**: Set up PostgreSQL streaming replication locally using Docker. Measure replication lag under write load. Simulate a failover by stopping the primary and promoting the standby.

**Exercise 5**: Create a JSONB column with 5 million rows. Benchmark: (a) without GIN index, (b) with default GIN index, (c) with `jsonb_path_ops` GIN index. Compare query times and index sizes.

**Exercise 6**: Reproduce table bloat: insert 1M rows, update all rows 5 times without running VACUUM. Observe `n_dead_tup`, `pg_relation_size`, and query performance. Then run `VACUUM ANALYZE` and observe the difference.

**Exercise 7**: Implement the `ReadWriteSplit` pattern in Go with proper failover - if a replica fails, fall back to primary automatically. Add health-check goroutines that remove unhealthy replicas from rotation.

**Exercise 8**: Write a Go service that processes bank transfers using `SERIALIZABLE` isolation with automatic retry. Load-test it with 100 concurrent goroutines transferring between 10 accounts. Verify that no money is created or destroyed.

### Junior to FAANG: how to actually do these exercises

Prerequisite setup. Spin up Postgres 18 locally via `docker run --name pg18 -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:18`. Enable extensions you will need: `CREATE EXTENSION pgstattuple; CREATE EXTENSION pageinspect; CREATE EXTENSION pg_stat_statements;` and reload config. Without these, several exercises give partial results.

Worked starter for exercise 1 (UUID vs BIGSERIAL). The first-job instinct is "insert and time". The better instinct is "insert, measure, then look at the physical shape".

```sql
CREATE TABLE t_uuid    (id uuid      PRIMARY KEY DEFAULT gen_random_uuid(), payload text);
CREATE TABLE t_bigserial (id bigserial PRIMARY KEY,                          payload text);

INSERT INTO t_uuid(payload)      SELECT repeat('x',100) FROM generate_series(1,10000000);
INSERT INTO t_bigserial(payload) SELECT repeat('x',100) FROM generate_series(1,10000000);

SELECT pg_size_pretty(pg_relation_size('t_uuid_pkey'))      AS uuid_idx_size,
       pg_size_pretty(pg_relation_size('t_bigserial_pkey')) AS bigserial_idx_size;

-- Height via pageinspect
SELECT level FROM bt_metap('t_uuid_pkey');
SELECT level FROM bt_metap('t_bigserial_pkey');
```

Expected observation. The UUID index is roughly 1.5 to 2x larger for the same row count because random inserts leave leaf pages 70-75% full on average (post-split), while sequential inserts leave them packed. Tree height is often the same (fanout dominates), which is a good lesson: the performance delta is not about tree height, it is about cache residency and split cost.

"Why did this fail?" reflex to practice in exercise 6 (bloat). After 5x updates without VACUUM, `pg_relation_size('t')` will be roughly 6x the starting size. `n_dead_tup` will be roughly 5M. Run `VACUUM ANALYZE` and observe: `n_dead_tup` drops to zero, but `pg_relation_size` stays the same. The lesson is that VACUUM reclaims space for reuse, it does not return pages to the OS. Only `VACUUM FULL`, `CLUSTER`, or `pg_repack` does that. This is the number-one misconception juniors have about vacuum, and you want to hit it hands-on.

Interview entry-point framing. After every exercise, write a three-sentence summary in your notes: what you expected, what you observed, what internal mechanism explains the delta. Interviewers at L3/L4 ask "have you ever debugged a slow query" and the candidate who can say "yes, I reproduced the bloat scenario, saw page-fullness drop to 40%, ran pg_repack, and watched the scan time fall from 2s to 40ms" has a story. The candidate who says "yes, I tuned random_page_cost" does not.

### Senior at FAANG: these exercises scaled to a platform discipline

The eight exercises above are individual-contributor learning tasks. The senior-track version is "make these exercises the acceptance criteria for a new database hire and use them as the source material for platform tooling you actually ship".

Exercise 1 at staff scale. The real question is not "which PK is faster" but "how does the platform prevent teams from choosing the wrong PK". Build a schema-review linter as the deliverable. Inputs: migration SQL file. Outputs: warnings for `uuid DEFAULT gen_random_uuid()` on high-write tables, suggestions for UUIDv7 or ULID, estimated index size delta. Integrate with the CI pipeline. Ship it as a pre-merge check. That is the staff deliverable.

Exercise 4 at staff scale. The exercise is "set up streaming replication". The staff version is "write the Patroni + etcd + pg_failover_slots runbook, run a chaos drill that kills the primary at random in a staging cluster, measure actual RTO, and produce an ADR that documents the failover topology with explicit RPO and RTO numbers signed off by the business owner". You should do a chaos drill at least quarterly. If you cannot, your HA is not HA, it is hope.

Exercise 7 at staff scale. The exercise is "implement ReadWriteSplit with failover". The staff version is "design the connection routing layer for the platform". Decisions: do we use an application-side router (the pattern in the chapter), a connection-pooling middleware (pgcat with query routing), or a managed router (RDS Proxy, Aurora reader endpoint)? What is the bounded-staleness contract for read-after-write? How do you ensure that a replica that has been ejected for lag is not re-added before it catches up? What metric drives ejection, `replay_lag` in seconds or `sent_lsn - replay_lsn` in bytes (answer: both, because an idle primary makes time-based lag look fine when the byte lag is growing)?

Exercise 8 at staff scale. The exercise is SERIALIZABLE with retries. The staff version is "write the SDK wrapper that every service in the org must use for transactional code, make it mandatory via a linter, and provide observability such that retry storms surface as metrics, not as vanishing user traffic". The wrapper should: retry 40001 with exponential backoff and jitter up to a bounded number of attempts, emit a counter per queryid and retry-count pair, fail loudly on non-retryable errors, propagate context cancellation, and integrate with tracing so a retried transaction shows up as a single logical span with a retry count attribute.

Platform-deliverable capstone. Take the eight exercises and produce one of these for your organization. (1) A schema-review linter (exercises 1, 3, 5). (2) A bloat and XID wraparound monitoring dashboard with tiered alerts (exercises 2, 6). (3) An HA chaos drill runbook with quarterly execution (exercise 4). (4) A connection-routing layer with documented bounded-staleness contract (exercise 7). (5) An SDK transaction wrapper with mandatory adoption (exercise 8). Each is a staff-level deliverable. Each one prevents a recurring class of incident. A staff engineer who has shipped two of these is hired. A principal has shipped all five across multiple organizations and can explain the tradeoffs of each in front of a VP.

ADR-as-homework. For each exercise, write the ADR that would accompany the change if it were a platform decision. Include Context (what problem), Decision (what change), Consequences (including the costs), Alternatives Considered (and why rejected), and Revisit Triggers (what would change the decision). The discipline of writing ADRs for exercises is how you train the muscle for writing ADRs under time pressure in a real incident review.

Maturity check. After completing these exercises, ask yourself: can I now lead an incident review where the root cause is in any of these areas? If yes, you are at L5. Can I design the platform controls that prevent the incident class? If yes, L6. Can I decide whether the organization should invest in building those controls versus buying a managed database service versus tolerating the incident rate? If yes, L7. The exercises are the same. The seniority is in the answer you give after finishing them.

---

*Next: Chapter 37C - Data Modeling at Scale*
