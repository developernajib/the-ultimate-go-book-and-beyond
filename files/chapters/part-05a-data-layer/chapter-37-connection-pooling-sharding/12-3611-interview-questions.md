## 37.11 Interview Questions

### Question 1: How do you size a connection pool?

**Answer:**
Connection pool sizing depends on several factors:

```go
// Formula from HikariCP (applies to any pool)
// connections = ((core_count * 2) + effective_spindle_count)

// For cloud databases:
poolSize := (dbMaxConnections - reserved) / appInstances

// Example calculation:
// - PostgreSQL RDS: max_connections = 400
// - Reserved for admin/migrations/replication: 20
// - App pods: 10
// - Per-pod pool = (400 - 20) / 10 = 38
// - With 20% headroom: ~30

// However, more isn't always better:
// - 4-core database server = optimal 8-12 connections
// - Beyond that, context switching and lock contention hurt throughput
```

Key considerations:
- **Database limits**: Postgres `max_connections`, minus replication slots, minus admin/migration reservation.
- **Application instances**: divide the total budget across all pods, including scale-out headroom.
- **Query duration**: longer queries = larger pool (Little's Law: concurrency = throughput * latency).
- **Resource usage**: each Postgres backend is ~5-10 MB RSS plus shared buffers per connection.
- **Pool chain math**: `app_pool * pods <= pgbouncer_pool <= postgres_max_connections - reserved`. Violate and you cascade-fail.

**What FAANG expects:** cite HikariCP's "about 2x cores" rule *and* explain why - Postgres backends are OS processes competing for CPU and shared buffers. Beyond ~2x cores, extra connections add context-switch overhead without throughput. Mention that PgBouncer inverts the calculation: at 1000 clients you want a small backend pool (20-50) and let PgBouncer queue. Staff-level answers also cover Little's Law and tail-latency implications of queueing.

**Follow-ups:**
- Your pool size is 25, p99 query latency is 50ms, how many QPS can you sustain? (Little's Law: 25 / 0.050 = 500 QPS steady-state, less under bursts.)
- What metrics tell you the pool is too small vs too large? (Too small: `WaitCount` / `AcquireDuration` rising, request timeouts. Too large: Postgres CPU saturation, `pg_stat_activity` full of idle connections, shared-buffer thrashing.)
- How does this change when you add PgBouncer? (App-side pool becomes a client-side queue. Keep it small - 5-10 - and let PgBouncer multiplex.)

### Question 2: What are the trade-offs between different sharding strategies?

**Answer:**

| Strategy | Pros | Cons | Best For |
|----------|------|------|----------|
| **Hash** | Even distribution, simple routing | Hard to range query, resharding pain | User data, sessions |
| **Range** | Range queries work, easy to add shards | Hot spots on latest data | Time-series, logs |
| **Directory** | Flexible, custom routing | Extra lookup, SPoF risk | Heterogeneous tenants |
| **Consistent hash** | ~K/N keys move on resize | Slightly uneven, needs vNodes | Caches, dynamic clusters |
| **Geo / affinity** | Data near users, compliance | Cross-region joins expensive | Multi-region SaaS, GDPR |

```go
// Hash sharding - good for random access
shardIdx := fnv32(userID) % numShards   // hash first, then modulo

// Range sharding - good for time-series
// Postgres declarative partitioning by month - drop old partitions in O(1)

// Consistent hashing - good for dynamic clusters
node := consistentHash.GetNode(key) // Only ~1/N keys move on add/remove
```

**What FAANG expects:** demonstrate you understand that the shard key is *effectively unchangeable* once you have production data. Discuss hot-key problems concretely (monotonic IDs concentrate writes on the last shard. `country_code` has too few values). Name real systems: Vitess for MySQL (YouTube, Slack, Block), Citus for Postgres, pgcat as a modern proxy, DynamoDB for NoSQL. Staff answers cover the celebrity problem - Shopify's Black Friday merchants, Discord's largest servers - and sub-sharding strategies.

**Follow-ups:**
- Your shard key is `user_id`, but one "user" is a bot that generates 50% of traffic. How do you handle it? (Sub-shard the bot - bot_id space partitioned across all shards. Or detect and route bot traffic to dedicated shards.)
- How do you support queries that don't include the shard key? (Secondary index table mapping secondary key -> shard, cached aggressively. Or scatter-gather with bounded fan-out. Or denormalize into a read-optimized store.)
- Why does Twitter's Snowflake ID make a bad shard key if used directly? (Monotonic timestamps in the high bits mean all new writes go to one shard.)

### Question 3: How do you handle cross-shard transactions?

**Answer:**
The best answer is **you don't** - redesign to avoid them. When you must:

```go
// Option 1: Saga pattern (preferred - non-blocking, composable)
// Each step is a local transaction - failures trigger compensating actions in reverse.
// Use a durable workflow engine (Temporal is the Go standard) so state survives crashes.

// Option 2: Outbox pattern (for cross-shard event propagation)
// Write business record and "event to publish" row in SAME local transaction,
// then a worker drains the outbox. At-least-once delivery - consumers must be idempotent.

// Option 3: Two-Phase Commit (last resort)
func TwoPhaseCommit(shards []*sql.DB, ops []Operation) error {
    // Phase 1: PREPARE TRANSACTION on every participant
    // Phase 2: COMMIT PREPARED on every participant
    //
    // Risks: coordinator crash between phases leaves prepared txns holding locks -     // Postgres pins WAL and blocks autovacuum until resolved. Monitor pg_prepared_xacts.
}
```

Production teams avoid cross-shard transactions by:
1. Choosing shard keys that co-locate related data (tenant_id, account_id).
2. Denormalizing - duplicate data so updates are single-shard.
3. Using eventual consistency with idempotent operations and compensating workflows.

**What FAANG expects:** lead with "don't do it, redesign the shard key." If forced, propose saga/outbox over 2PC and explain *why*: 2PC blocks on coordinator failure, Postgres prepared transactions pin WAL and cause autovacuum to stall, and the CAP trade-off forces unavailability during partitions. Name Temporal or Cadence for workflow orchestration. Senior candidates mention that Google Spanner uses 2PC under the hood but can afford it because of TrueTime and Paxos-replicated participants - don't try this at home.

**Follow-ups:**
- A user transfers $100 from account A (shard 1) to account B (shard 2). Walk through the saga. (Debit A with transfer_id. On success, credit B. On B failure, compensating credit to A. All steps idempotent by transfer_id.)
- What happens if your saga orchestrator crashes mid-flight? (Durable workflow engine replays from last checkpoint. Without one, you leak inconsistencies.)
- Why is the outbox pattern better than "just publish to Kafka after commit"? (Dual-write problem: DB commit succeeds, Kafka publish fails, state diverges. Outbox makes the publish part of the DB transaction.)

### Question 4: How do you add a new shard without downtime?

**Answer:**
Online resharding with consistent hashing and dual-writes:

```go
// 1. Add new shard to cluster (empty), update ring config
// 2. Start dual-write: writes go to both old and new shard for affected key range
// 3. Backfill: copy existing data in background, track progress per key
// 4. Verify: read from both, compare, fix drift
// 5. Flip reads to new shard (one atomic config update)
// 6. Stop dual-write
// 7. Delete old data
```

With **consistent hashing + virtual nodes**, only ~1/N keys move when a shard is added, vs ~(N-1)/N for naive modulo. For a 10 TB cluster going from 10 to 11 shards: ~1 TB moves (consistent) vs ~9 TB (modulo). Vitess automates this entire pipeline (Resharding / VReplication) and is why Slack and YouTube use it.

**What FAANG expects:** describe the dual-write / backfill / cutover sequence precisely, mention consistent hashing with vNodes as the mechanism that minimizes data movement, and name Vitess/Citus/pgcat as industry-standard automation. Discuss verification - read both sides, compare checksums, handle drift. Staff answers cover failure modes: what if backfill crashes halfway? (Resumable from checkpoint.) What if dual-write diverges? (Async reconciliation job, then manual review.) What about ongoing schema migrations during reshard? (Freeze DDL or coordinate via Vitess VReplication.)

**Follow-ups:**
- How do you verify the new shard has correct data before cutting over reads? (Read-compare: for a sample of keys, read both shards, verify equal. For full confidence, checksum partitions with `COUNT(*)` and `MD5(array_agg(...))`.)
- What if the old shard is at 95% disk and you can't afford to keep data during dual-write? (You're in trouble. Capacity planning failed. Temporary remediation: per-row TTL on old shard for rows migrated, or pause new writes and do offline migration.)
- Why not just take a brief write lock and copy atomically? (At scale the copy takes hours-to-days. No lock that long is acceptable. Online migration is the only option.)

### Question 5: What is PgBouncer and when would you use it?

**Answer:**
PgBouncer is a lightweight connection pooler that sits between the application and PostgreSQL, multiplexing thousands of client connections onto tens of backend connections:

```
App (1000s of clients) -> PgBouncer (50 backends) -> PostgreSQL
```

**Use cases:**
1. Many short-lived or idle connections (serverless, PHP-style per-request connects).
2. Postgres `max_connections` too low for your fleet size.
3. Microservices with many services each wanting its own pool.
4. Reducing the cost of TLS handshakes on every request.

**Pool modes:**
- **Session**: full Postgres semantics, no multiplexing benefit.
- **Transaction** (default): multiplex per transaction. Historically broke prepared statements, `LISTEN/NOTIFY`, session advisory locks, and temp tables. **PgBouncer 1.21+ (2023) added prepared-statement support in transaction mode** via `max_prepared_statements` - a major unblock for pgx and ORM users.
- **Statement**: per-statement multiplexing. Breaks multi-statement transactions. Rarely used.

```go
// Modern pgx config for PgBouncer 1.21+ transaction mode with prepared statements:
// (leave DefaultQueryExecMode at default - pgx uses extended protocol, PgBouncer
// transparently rewrites statement names)

// Keep app-side pool small - PgBouncer is doing the real pooling:
poolConfig.MaxConns = 10

// For older PgBouncer without prepared-statement support:
// poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
```

**Alternative: pgcat** (Rust, by PostgresML) - does everything PgBouncer does plus built-in sharding, replica load balancing, and prepared-statement support from day one. Worth evaluating for greenfield deployments.

**What FAANG expects:** explain the mode trade-offs fluently, know the 1.21+ prepared-statement change (major interview signal that you follow the ecosystem), mention pgcat as the modern Rust alternative, and describe the full connection chain (app -> pooler -> Postgres) with the pool math. Senior candidates discuss operational concerns: PgBouncer is single-threaded, so CPU-bound at ~5-20k QPS per instance - run multiple behind a TCP load balancer for scale. High availability requires 2+ PgBouncer instances. failover strategies via HAProxy or Patroni.

**Follow-ups:**
- Why is PgBouncer single-threaded, and how do you scale past its throughput ceiling? (libevent-based. Scale by running N instances behind a TCP LB or via SO_REUSEPORT.)
- Your app uses `LISTEN/NOTIFY` for cache invalidation. Can you use transaction mode? (No - subscription dies on connection reassignment. Either use session mode for those connections, dedicate a session-mode pool, or switch to Redis pub/sub / NATS.)
- What's the difference between PgBouncer's pool and pgxpool? Can you remove the app-side pool entirely? (They solve different problems: pgxpool caches connection objects and prepared statements in-process. PgBouncer multiplexes at the network level. You still want a small pgxpool to avoid per-request connect handshakes to PgBouncer.)

### Junior → FAANG: Entry-Point Framing for Pool and Shard Interviews

If you are prepping for your first backend phone screen, the interviewer is not testing whether you memorized the HikariCP formula. They are testing whether you can reason about a shared remote resource under contention. The difference between a no-hire and a hire on these five questions is almost always whether you ask about the workload shape before answering.

Worked example for Question 1. Interviewer says "size a pool for a web service hitting Postgres." Junior answer, "50 connections." Mid answer, apply `2 * cores` and cite HikariCP. Hire-level answer, "I need three numbers first. How many service instances will run, what is the Postgres `max_connections`, and what is the p99 query latency. Given those, I will compute per-instance budget from Little's Law and the server capacity, then pick the lower. If p99 is 50ms and target is 500 QPS per instance, I need 25 concurrent slots. If server budget allows only 20 per instance, I take 20 and accept the throughput ceiling or add PgBouncer."

Worked example for Question 2. "Shard a users table." Junior says "hash by user_id." Hire-level says "I need to know the query patterns. If 90 percent of queries are by user_id, hash by user_id. If 50 percent are range scans by created_at, I have a shard-key fight, and I probably denormalize a time-ordered index into a separate store rather than range-shard. What are the top 5 queries by volume?"

First-job framing. In your first year at a FAANG you will not design a shard scheme from scratch. You will maintain one someone else designed poorly. The interview is a proxy for "can you read an existing shard scheme and tell me what queries it makes expensive." Practice by taking any open-source schema (GitLab, Discourse, Mastodon) and writing a one-page analysis of what sharding by each plausible key would cost.

"Why did this fail?" reflex for interviews. When the interviewer says "this query got slow in production, what happened," the ranked candidate causes are (1) query plan flipped due to stats change, (2) replica lag pushed reads to primary, (3) pool saturation queued the query, (4) a hot shard received a traffic spike, (5) PgBouncer transaction-mode broke a prepared statement cache. Walking through these five out loud, in order, is the signal the interviewer is grading.

### Senior @ FAANG: Signal Ladders, Bar-Raiser Prompts, and Interview Calibration

At L5 and above the interview shifts from "do you know the answer" to "do you know which answer applies to this context, and can you write the ADR after the meeting." Here is the calibrated signal ladder I use when I am the bar raiser on a database-platform loop.

Signal ladder for Question 1 (pool sizing). L3 recites `2 * cores`. L4 does the arithmetic with `max_connections` and instance count. L5 applies Little's Law and discusses tail latency under queueing. L6 proposes the shared client library that makes misconfiguration impossible and discusses the PgBouncer inversion. L7 describes the control plane that sizes pools dynamically based on observed load, the migration plan to deploy it across 400 services, and the failure mode (control plane outage defaults to last-known-good config, not to zero).

Signal ladder for Question 2 (sharding strategy). L3 picks hash and stops. L4 compares hash versus range with hot-spot examples. L5 discusses consistent hashing with vNodes and the celebrity problem. L6 designs the directory service with caching, failure modes, and a migration path from modulo to consistent hash. L7 writes the ADR covering shard-key immutability, the query review process, and the analytics off-ramp for queries that cannot be served from the sharded store.

Bar-raiser prompt 1, "shard a 10TB Postgres live." Strong candidate covers capacity analysis first (what fraction is index, what fraction is hot working set, what is the read/write ratio), picks consistent hashing with 128 vNodes per shard, designs a dual-write layer with a feature flag per tenant range, plans backfill at 10 percent of peak IOPS to avoid impacting production, specifies verification by row-count plus sampled `MD5(row::text)` comparison, specifies cutover as an atomic config update not a code deploy, and specifies rollback as flipping the feature flag back. Weak candidate jumps to "use Vitess."

Bar-raiser prompt 2, "design a read-replica routing layer for 50 services." Strong candidate treats this as a platform problem not a library problem. They design a typed session API (`Session.RequireFresh`, `Session.AllowStale(d)`, `Session.ReadYourWrites(userID)`), a centralized routing daemon or sidecar that checks replica lag, a fallback to primary when all replicas exceed lag threshold, a circuit breaker per replica, observability for route decisions, a rollout plan that starts in shadow mode, and an SLA for stale-read bound. They name GitHub's `freno` and Shopify's `ghostferry`-adjacent tooling as prior art.

Bar-raiser prompt 3, "reshard live production from 8 to 16 shards without downtime." Strong candidate walks through (1) extend ring to 16 vNodes mapped to 8 physical shards, (2) deploy new 8 physical shards empty, (3) remap half the vNodes to new shards in the config, (4) start dual-write with tombstoned reads still going to old, (5) backfill with progress tracked per vNode, (6) verify per-vNode checksum match, (7) flip reads vNode-by-vNode not all-at-once so blast radius is bounded, (8) stop dual-write per vNode once reads are stable for 24 hours, (9) drop old data after 7-day retention for rollback. They name the failure modes (dual-write divergence, backfill lag approaching real-time causing write amplification, cutover coinciding with an unrelated incident) and the mitigations (async reconciliation job, rate-limited backfill, a change-freeze window).

Bar-raiser prompt 4, "debug pool starvation at 99.99p without adding capacity." Strong candidate starts with `pg_stat_activity` to find long-running queries, checks `pg_stat_statements` for regressed plans, inspects the app for missing context deadlines, looks at the load balancer for retry storms amplifying load, and checks for a slow downstream (a `LEFT JOIN` to a table with a stale stat). They know the anti-pattern fix (raising `MaxOpenConns`) and why it makes things worse (moves contention from app queue to Postgres backend contention). They name specific Postgres views and extensions (`pg_stat_activity`, `pg_stat_statements`, `auto_explain`, `pg_wait_sampling`).

Bar-raiser prompt 5, "migrate a monolith DB to sharded topology over 18 months." Strong candidate frames this as a program not a project. They identify the 3 to 5 highest-value tables to shard first, design the shard-key per table with sign-off from the owning team, build the dual-write layer once and reuse it, define exit criteria per table (100 percent traffic on sharded topology, old table retained read-only for 30 days), track program OKRs (tables migrated, cross-shard query count reduction, p99 latency delta). They name the organizational risk (one team blocks the program by refusing to pick a shard key) and the mitigation (escalation path to a single VP, RACI matrix per table).

Calibration note for interviewers. If a candidate produces the mechanical answer to all five questions but cannot produce any of these bar-raiser answers, they are L4. If they produce two out of five bar-raiser answers with prompting, they are L5. If they produce all five without prompting and name prior art (Vitess, pgcat, freno, Notion's sharding posts, Stripe's DocDB, Discord's Cassandra-to-ScyllaDB migration), they are L6 or above. Do not confuse fluency with seniority, probe for the ADR discipline and the rollout plan.

---
