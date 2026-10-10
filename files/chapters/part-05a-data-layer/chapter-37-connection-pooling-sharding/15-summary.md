## Summary

Connection pooling and sharding essentials:

1. **Pool Configuration**: Tune MaxOpenConns based on database limits and app instances
2. **pgx Pools**: Use BeforeAcquire/AfterRelease hooks for connection health
3. **Read Replicas**: Implement read/write splitting for scale
4. **Sharding**: Use consistent hashing for even distribution with minimal data movement
5. **Cross-Shard**: Implement scatter-gather patterns, avoid cross-shard transactions
6. **PgBouncer**: Use transaction pooling for high-connection workloads
7. **Monitoring**: Track pool utilization, connection wait times, and query latencies

### Junior → FAANG: What to Actually Remember from This Chapter

If you only retain seven things, make them these. First, a connection is a server-side resource, not a client-side object. Second, pool size is computed from server capacity down, not from client demand up. Third, `ConnMaxLifetime` must be strictly less than the shortest server-side or network-side idle timeout. Fourth, the shard key is a tattoo, it cannot be changed without rewriting every query. Fifth, cross-shard joins do not exist in SQL, they are application-layer scatter-gather. Sixth, reads from replicas can be stale, and every read should be tagged with a freshness requirement. Seventh, the acquire path must always have a context deadline.

Worked example of applying these seven. You are asked to add a new endpoint that lists a user's recent orders. Rule 7 says wrap the call with a context deadline. Rule 6 says decide whether the read needs read-your-writes (if yes, use primary or the recent-writes cache). Rule 4 says the query must filter by the shard key (user_id), so the endpoint signature takes user_id as a required parameter. Rule 5 says if you also need to show the customer's name from a different service, do not join, fetch separately. Rule 2 says before you deploy, check that your service's pool budget still fits in the cluster-wide connection total. Rule 3 says check that `ConnMaxLifetime` is 5 minutes or less. Rule 1 says each pooled connection you add costs 5 to 10 MB of server memory. That is the entire thought process, seven checkboxes.

First-job context. In your first year nobody will explicitly ask you to go through this checklist. You will be expected to have internalized it. Build a personal checklist in your notes and run it on every PR that touches the data layer for the first six months. After six months it becomes reflex.

Interview entry point for this chapter. The canonical one-liner is "walk me through what happens when a Go service connects to Postgres and runs a query." If you can narrate the TCP handshake, the session state negotiation, the pool's `Acquire` call, the query execution, the row streaming, and the `Release`, with awareness of pool saturation and connection recycling at each step, you are at the L4 bar. Add the PgBouncer layer, replica routing, and sharding and you are at L5.

### Senior @ FAANG: The Charter, the Maturity Model, and the One-Year Rollout

At staff and principal level, this chapter compresses to a single charter document. The database-platform team owns pool sizing, shard routing, replica routing, cross-shard write patterns, resharding workflows, and the observability stack. Application teams consume, they do not implement. Any deviation requires a written ADR and a 90-day review.

Maturity model summary. L1 is no pool tuning. L2 is static per-service pool tuning. L3 is a shared client library with typed sessions and bounded pools. L4 is sharded topology with a shared router and saga-based cross-shard writes. L5 is self-service platform with automated rebalancing and a published SLO catalog. Know which level your org is at and name the next one as your two-quarter OKR.

One-year rollout for a mid-tier platform team. Quarter 1, deploy observability so every service reports pool utilization, wait time, acquire failures, and per-query replica-lag bounds. Quarter 2, ship the shared client library with typed sessions, bounded pools, and acquire timeouts as the default. Migrate the 10 highest-traffic services. Quarter 3, extend the library with shard routing for the 3 sharded tables you have already. Begin the reshard-workflow project for the next table slated for sharding. Quarter 4, ship the reshard workflow, complete the first live reshard on the lowest-risk table, and publish the playbook. Two-year horizon, complete the service migration, deprecate all bespoke pools and routers, introduce per-tenant shard isolation for the top 1 percent of customers.

Bar-raiser closing prompt. "You are interviewing for the staff role that owns this charter. Pitch the first year." Strong candidate opens with observability as the foundation, commits to measurable outcomes per quarter (reduce connection-count incidents by 80 percent, reduce replica-lag incidents to zero, ship one live reshard), names the stakeholders (SRE, application teams, analytics), names the risks (library adoption stalls, reshard incident damages trust, observability rollout conflicts with existing dashboards), and names the cross-team rituals (weekly platform office hours, monthly ADR review, quarterly SLO review). Weak candidate lists features without outcomes. The charter is a contract with the company, not a backlog.

Final note. Every pattern in this chapter can be implemented wrong and still pass code review. The discipline that separates senior work is insisting on the ADR before the code, the observability before the library, and the runbook before the rollout. Build that habit now, and the rest of the career compounds.

---
