## Learning Objectives

By the end of this chapter, you will be able to:

- **Configure connection pools optimally** using database/sql and pgxpool settings
- **Implement read/write splitting** with primary and replica databases
- **Design sharding strategies** using hash-based, range-based, and consistent hashing
- **Build cross-shard query patterns** including scatter-gather and two-phase commit
- **Integrate with PgBouncer** for connection multiplexing at scale
- **Monitor pool health** with Prometheus metrics and alerting
- **Handle shard rebalancing** when adding or removing database nodes

### Junior → FAANG: what to actually know before you interview on this

Before you sit for a backend interview that touches databases, you need to be able to answer five questions without hedging. First, what is the difference between `MaxOpenConns` and `MaxIdleConns` in `database/sql`? Open is the ceiling on total connections the pool will allocate, idle is how many it keeps warm when load drops. Second, what does `MaxConnLifetime` protect you from? Load balancer connection rebalancing, stale TLS sessions, and DNS changes when the primary fails over. Third, why does a pool of 1000 on one service break your database? Because Postgres spawns a backend process per connection and lock-manager contention goes superlinear past a few hundred. Fourth, what is a prepared statement and why does it matter for PgBouncer? Prepared statements live on the backend connection, so if PgBouncer reuses a backend across clients you get "prepared statement does not exist" errors unless you are on PG14+ with the named-prepared-statement patch. Fifth, how do you route a read to a replica in Go? You keep two `*sql.DB` pools, a primary and a replica, and your repository layer picks based on a boolean flag or a transaction context. That is the floor. The rest of this chapter builds the ceiling.

### Senior @ FAANG: objectives for staff/principal engineers

At staff level, the objectives above are table stakes. What you are actually learning in this chapter is how to reason about connection pools as a shared resource across an organization, not a service-local config knob. Concretely you should be able to produce: (1) an ADR comparing native pgxpool, PgBouncer transaction mode, PgCat, Supavisor, and RDS Proxy for your org's workload mix, with explicit decision criteria on prepared statements, session state, multi-tenancy, and failover, and (2) a pool-math runbook that takes RPS, p50/p99 query latency, and replica count and outputs safe pool sizes at every layer (app, pooler, backend). (3) a read-replica routing policy that specifies when read-after-write requires primary sticky routing, how replica lag is measured and enforced, and what happens during replica failover. (4) an observability contract (OTEL spans for acquire/release, Prometheus histograms for wait time, alerting thresholds on saturation and waiter depth). (5) a sharding governance model that defines when a team is allowed to shard, what shard-key review looks like, and how online resharding is operated. If you cannot write these artifacts, you are not yet operating at staff level on data infrastructure, regardless of title.

---
