## Summary

Redis essentials for Go:

1. **Data Structures**: Strings, hashes, lists, sets, sorted sets
2. **Caching**: Cache-aside, write-through, tagged cache
3. **Locking**: Distributed locks with Lua scripts
4. **Rate Limiting**: Fixed window, sliding window, token bucket
5. **Pub/Sub**: Real-time messaging
6. **Streams**: Persistent message queues
7. **Pipelining**: Batch operations for performance

### Junior to FAANG: The Minimum Viable Redis Mental Model

If you remember nothing else from this chapter, keep these seven rules in your head. Each one maps to an incident that has already happened at FAANG scale, and each one is worth more than a textbook's worth of theoretical knowledge.

Rule 1: never discard a Redis error. `val, _ := rdb.Get(...)` is a code review block. There are four error classes and they need four responses.

Rule 2: every write carries an explicit TTL unless the workload is one of a known allowlist of durable uses (idempotency keys, rate limiter state, fencing tokens). A zero TTL in a cache workload is a memory leak waiting to happen.

Rule 3: the single-threaded event loop means one slow command blocks everyone. KEYS, FLUSHALL, large DEL on bigkeys, and non-trivial Lua scripts are latency amplifiers. Use SCAN, UNLINK, and bounded Lua.

Rule 4: distributed locks require Lua-script-based owner verification on release. SETNX plus plain DEL leaks locks under GC pauses. Fencing tokens plus idempotent writes are the only correctness guarantee.

Rule 5: cache stampedes are solved by TTL jitter, single-flight coordination, and proactive refresh. Choose at least two of the three for every hot key.

Rule 6: cluster mode forbids multi-key operations across slots. Use hashtags `{user:42}:profile` and `{user:42}:orders` to colocate keys that must be operated on together.

Rule 7: Valkey 8.0 is the 2026 default for new Go services without Redis Stack module dependencies. Redis 8.0 remains for enterprise modules and existing Redis Enterprise contracts. The wire protocol is identical for the core command set.

Interview entry-point for the summary. If an interviewer asks "what is the one thing you wish every engineer knew about Redis," answer rule 3. The single-threaded event loop is the foundation of every Redis pitfall. Once you understand that one command blocks all commands, every performance pitfall becomes predictable.

### Senior at FAANG: Summary as Readiness Checklist and Governance Bar

At staff and principal level, the summary of the chapter is not a memorization aid. It is a readiness checklist for promoting a Redis deployment from one maturity level to the next. Below is the L1 to L5 checklist derived from every section of this chapter, suitable for a bar-raiser readiness review.

L1 readiness (single instance, development or very small production):
- Error handling: all Redis calls check both redis.Nil and general errors.
- TTL discipline: every write has an explicit TTL or is on the durable allowlist.
- Basic monitoring: uptime, memory usage, slowlog threshold of 10 ms.
- No forbidden commands: rename-command entries for KEYS, FLUSHALL, CONFIG SET, DEBUG.

L2 readiness (primary plus replica, production ready):
- L1 plus:
- Sentinel quorum with at least three Sentinels across failure domains.
- Replication lag alerting at 5 seconds warn, 30 seconds page.
- AOF configured with appendfsync everysec for durability workloads.
- Runbook sections for failover, memory pressure, latency spike.
- Client-side connection pool sized to 2x expected peak concurrency.

L3 readiness (Redis Cluster, horizontally scaled):
- L2 plus:
- Minimum three primaries and three replicas across at least two failure domains.
- Hashtag discipline enforced by linter in CI.
- Cross-slot multi-key operation audit complete with zero violations.
- Cluster failover tested quarterly in staging.
- Per-slot capacity planning with headroom for resharding.
- Automated bigkey scanner running weekly via redis-cli --bigkeys on a replica.
- Automated hotkey scanner running weekly via redis-cli --hotkeys on a replica.
- Lua script review gate for any new script, with 50 microsecond CPU budget.

L4 readiness (multi-region Cluster, critical workloads):
- L3 plus:
- Per-workload Redis deployment with isolated maxmemory-policy.
- ACLs scoped per application with key prefix glob plus command category allowlist.
- Cross-region read replicas with lag monitoring and automatic fallback.
- Dual-write migration tooling available for version upgrades.
- Shadow-read diff tooling available for cluster topology changes.
- Traffic replay harness for performance regression testing before upgrade.
- ADR library covering: cluster migration, Valkey migration, failover, memory governance, lock policy, rate limiter policy, cache stampede policy.
- Chaos engineering tests for Redis node loss, network partition, and slow-network scenarios.

L5 readiness (multi-region active-active, global scale):
- L4 plus:
- Redis Enterprise CRDTs for active-active replication (no open-source Valkey equivalent exists yet, so this tier is commercial-only).
- Conflict resolution semantics documented per data type in use.
- Regional ownership model for key ranges if using sharded-by-region pattern.
- RPO and RTO targets published and tested (RPO near zero for active-active, RPO less than 5 seconds for active-passive with async replication).
- Cost model per region showing price per million operations and per GB-month of storage.
- Disaster recovery drills quarterly covering full region loss.
- Capacity planning with 2-year growth projection per region.
- Bar-raiser review for any change to cluster topology, replication pattern, or version.

Governance bar checklist. Every Redis deployment above L2 must satisfy:
- Library wrapper enforces error handling, TTL, jitter, and pipeline auto-batching.
- CI linter enforces forbidden commands, cross-slot safety, hashtag discipline.
- Runtime policy enforces rename-command, ACLs, maxmemory-policy, slowlog.
- Review gates enforce Lua script CPU budget, cluster migration ADR, and cross-region topology changes.
- Observability covers hit rate, latency percentiles, memory usage, evicted keys, slowlog rate, replication lag, connection count, big-key count, hot-key list.
- Runbooks cover stampede, memory explosion, lock race, hotkey, bigkey, failover, cluster resharding.

ADR inventory required at L4+. At minimum the following decisions must be documented as ADRs with context, decision, consequence, and alternatives rejected: Redis versus Valkey, standalone versus Cluster, eviction policy per workload, persistence policy per workload, replication topology per region, lock library choice, rate limiter algorithm, cache invalidation strategy, key schema versioning, migration policy for breaking schema changes.

Staff interview signal. When an interviewer asks "walk me through how your team runs Redis in production," the staff-level answer walks through the maturity level, the governance layers, the ADR inventory, and the open risks. The principal-level answer adds the cost model, the org design (who owns Redis, who consumes Redis, how decisions are made), and the two-year roadmap. If you cannot answer all of those for your current deployment, the deployment is at a lower maturity level than you think and the remediation plan should be your next three quarters of work.

Closing thought for principal-level readers. Redis is a tool, not a strategy. The strategic question is always "what data model does this workload need, and is Redis the right implementation for it." Cache-aside on a stateless HTTP service with seconds of staleness tolerance is a good fit. Financial ledger with strict linearizability is not. Getting this classification right at design time is worth 10x the effort of tuning the implementation later. The maturity model in this chapter exists to make that classification visible, repeatable, and governed across a fleet.

---
