## Summary

This chapter surveyed modern data architecture patterns and their Go implementations:

- **Lambda Architecture (legacy in 2026)**: Batch layer for correct historical computation plus speed layer for real-time approximation. Still taught because you will inherit Lambda estates. Its killer problem was drift between the two codepaths, not cost.

- **Kappa Architecture (default in 2026)**: Single stream processing pipeline for both real-time and historical data. Kafka or Redpanda log retention enables reprocessing at 10x to 100x ingestion rate on Flink. Go services typically consume pre-aggregated output from Flink, or run stateless transforms via Benthos/Redpanda Connect.

- **Event Sourcing**: Append-only event log as the system of record. Aggregates reconstructed by replaying events. Optimistic concurrency via version checks prevents split-brain. Event store implemented on Postgres with `UNIQUE(aggregate_id, version)`.

- **CQRS Projections**: Read models built from events, separate from write models. `ProjectionManager` subscribes to events and dispatches to `Projection` handlers. Reset + replay enables bug-free read model evolution.

- **CDC**: Debezium-format events from Kafka give fine-grained table-level change visibility. LSN-based idempotency prevents duplicate processing. CDC events can feed directly into event sourcing pipelines.

- **Data Mesh**: Teams own data products end-to-end. `DataProductRegistry` catalogs available products. `DataContract` validates consumer agreements against producer SLOs. Health checks verify freshness and completeness SLOs continuously.

- **Windowed Aggregations**: Tumbling windows via truncated time keys. Watermarks handle late-arriving events. Flush triggered when watermark passes window end time.

### Junior → FAANG: What to Actually Remember From This Chapter

If you take only three things from this chapter into your first data-platform rotation, take these. First, dual writes are the enemy, and the transactional outbox pattern plus CDC is the answer for 90 percent of production services. Memorize the outbox schema and the Debezium operational model because you will debug them. Second, event sourcing is not free, and the operational cost shows up as projection rebuilds, snapshot policies, and schema evolution pain. Only reach for it when the audit or temporal-query requirement is explicit and funded. Third, exactly-once is an end-to-end property, and the broker alone cannot guarantee it, the sink must cooperate through idempotent writes or transactional protocols.

Mental model for your first year. When you see a new pipeline, trace the data from source to sink and ask at each hop: what is the delivery guarantee, what is the ordering guarantee, what is the retention, and who owns the schema. Those four questions map onto every architecture in the chapter and will let you reason about unfamiliar systems by analogy. When the pipeline breaks, run the five-check list from the interview chapter: consumer lag, watermark advance, checkpoint completion, schema registry compatibility, CDC replication slot lag. Those five checks plus the four questions above are your working toolkit for on-call and for interviews at L3 and L4.

Reflex to build. When a peer proposes event sourcing for a new service, ask what audit or temporal query the product team has specifically requested. If the answer is vague, push back with an outbox plus CDC alternative that achieves the audit goal without the projection rebuild burden. This reflex is the difference between a junior who follows trends and a junior who becomes mid-level quickly.

### Senior @ FAANG: Charter, Maturity, and the Next Three Investments

At staff and principal scope the summary of this chapter is not a pattern list, it is a charter. The charter you write for your data platform names the products, the SLAs, the governance board, the contracts, and the incident response structure. If any of those sections are missing, the platform is operating on goodwill and will degrade the moment the founding architect changes teams. The charter is the artifact that persists across reorgs.

Maturity model recap. L1: analyst SQL running in production on the OLTP replica, no platform, no governance, frequent incidents. L2: CDC is wired, a warehouse exists, but schemas drift and producers write directly. L3: schema registry is in place, contracts exist on tier-1 datasets, a small platform team owns the paved road, SLOs exist but are aspirational. L4: lineage covers tier-1 and tier-2 datasets, SLOs have teeth, platform team is funded at 8 to 15 engineers, domain teams own their data products in practice not just in org charts. L5: self-service domain onboarding, automated contract evolution, federated governance board meets monthly with named decision rights, chargeback model operational, data platform charter reviewed annually at the board level. Staff architects identify the current rung, the next rung, the quarters of investment needed, and the risk of staying still.

ADR discipline. Every significant data architecture decision in the chapter deserves an ADR. Why Kappa over Lambda. Why event sourcing for this aggregate and not that one. Why outbox over Debezium for this service. Why Flink over a Go stateful processor at this scale. Why data mesh with these preconditions and not without. The ADR practice is what turns a collection of patterns into an architectural memory that outlives individual engineers.

Governance rules to encode in platform tooling. Application code may not write to the warehouse directly, enforced by network policy and code review. Any schema change on a tier-1 dataset requires a contract review, enforced by CI. Any new data product registration requires an SLO, a named owner, and a lineage declaration, enforced by the registry API. Any exactly-once claim requires a named end-to-end test, enforced by platform certification. These rules are boring precisely because they are where the staff-level work happens, and encoding them in tooling is what prevents the platform from regressing as the org scales.

The next three investments for any growing data platform in 2026 are typically these. Lineage coverage expansion from tier-1 to tier-2 and tier-3 datasets using OpenLineage or DataHub. Contract enforcement automation that moves from advisory to blocking in CI. Self-service domain onboarding that reduces a new data product's time-to-production from weeks to hours. Naming these three investments with named owners and named quarterly milestones is the output of a staff-level architect's quarterly planning cycle. Any review deck that ends without these three items named is incomplete.

Closing frame. The patterns in this chapter are 20 years of industry learning distilled into Go implementations. The value of knowing them is not the code, it is the ability to pick the right pattern for the right problem at the right scale with the right organizational support. That judgment is what FAANG interviewers test for at L5 and above, and it is what distinguishes a senior engineer from a senior technologist. Build the judgment by building the systems, writing the ADRs, and owning the incidents.
