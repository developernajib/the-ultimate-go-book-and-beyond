## Common Mistakes and Anti-Patterns

These mistakes appear repeatedly in production data architecture implementations. Most stem from applying a pattern without accounting for the operational costs it introduces.

| Mistake | Problem | Fix |
|---------|---------|-----|
| Lambda with divergent batch/speed logic | Results differ depending on query time | Use Kappa: single processing path |
| Event sourcing every table | Complexity without benefit | Use ES only for core domain aggregates with complex business rules |
| No optimistic concurrency in event store | Concurrent writes corrupt version sequence | Always check expectedVersion before append |
| Projections without reset capability | Can't fix bugs in read models | Implement `Reset()` + replay from event store |
| CDC without idempotency | Re-processing creates duplicate events | Use LSN as idempotency key |
| No schema registry | Breaking schema changes cause pipeline failures | Use Confluent Schema Registry for Avro/Protobuf |
| Late data without watermarks | Windows close before all events arrive | Implement watermark-based window triggering |
| Data mesh without contracts | Consumers silently break on schema changes | Enforce data contracts via CI |
| Projection rebuilds blocking traffic | Rebuild takes hours, blocking reads | Build to a new table version, swap atomically |

### Junior → FAANG: Why Each Mistake Bites in Your First On-Call

As a junior engineer you rarely design these systems, but you inherit them. The failure modes in the table above show up as pages at 3am, and the root cause is almost always a pattern applied without its supporting scaffolding. Event sourcing without snapshots means a replay that used to take 2 minutes now takes 40 because the aggregate accumulated six years of events. CDC without an outbox means your payment service wrote to Postgres, crashed before publishing to Kafka, and now the warehouse shows a charge that the OLTP database never saw. Dual-write hazard is the most common first-job incident: the service writes to the database and then writes to Kafka in the same handler, one side fails, and the two stores diverge silently for weeks until a finance reconciliation job catches it.

Worked example. A junior on the payments team adds a new column `refund_reason` to the `payments` table. The CDC connector is configured with schema evolution disabled, so the Debezium connector halts. The warehouse stops receiving new rows. Nobody notices for 36 hours because the dashboard shows cached data. The fix is not just turning on schema evolution, it is understanding that the schema registry is the contract between producer and consumer and that any column change is a product decision, not a migration. The reflex to build in your first year is "what is the contract, who owns it, and what happens when it changes." When a pipeline breaks, ask three questions in order: did the schema change, did the watermark advance, and is the offset committed. Those three questions cover 80 percent of pipeline incidents.

Interview entry-point for L3 and L4. Expect to be asked "what is the difference between at-least-once and exactly-once delivery, and when does it matter." A strong junior answer names idempotency keys, names the outbox pattern, and admits that true exactly-once is a property of the end-to-end system including the sink, not just the broker. You do not need to design Flink checkpointing, you need to show that you understand why dual writes are dangerous and why the transactional outbox is the standard fix.

### Senior @ FAANG: Anti-Pattern Taxonomy, ADRs, and Governance at Staff Level

At staff and principal level the anti-patterns in the table are symptoms. The disease is organizational. Event sourcing every table is a symptom of an architect who read a blog post. CQRS for CRUD is a symptom of a team that confuses complexity with rigor. Data mesh without a platform is a symptom of a VP who wanted decentralization without funding the paved road. Your job is to diagnose the disease, not patch the symptom, and to encode the diagnosis in an ADR that future teams can read.

Anti-pattern ADR template. Every rejected pattern deserves a written record. Title, context, decision, consequences, and a revisit date. Example. "ADR-0147: Reject event sourcing for the user-profile service. Context: team proposed ES to gain audit trail. Decision: use append-only audit log table with CDC to warehouse instead. Consequences: simpler read path, no projection rebuild burden, audit queries run against warehouse with 15-minute freshness SLO. Revisit: if audit requirements move to real-time or if regulatory scope expands to full state reconstruction." This ADR prevents the next team from rediscovering the same tradeoff.

Governance anti-patterns specific to staff scope. Writing to OLTP and warehouse directly from application code is the single most common architecture smell in Series B to Series D companies. The fix is a standing rule enforced by code review and platform tooling: application code writes to OLTP only, CDC moves data to the warehouse, and any exception requires a platform-team-approved ADR. Missing schema registry at 200-plus engineers is an existential risk, not a tech-debt ticket. Lineage gaps mean a regulator request takes six weeks instead of six hours, and at SOX or GDPR scope that is a board-level issue.

Bar-raiser scenario. A candidate proposes data mesh for a 500-engineer org. The staff-level response is not to accept or reject but to ask about the platform investment. Data mesh without a platform team of 8 to 15 engineers, a contract enforcement CI pipeline, a lineage tool like OpenLineage or DataHub, and a central metadata store is decentralization theater. The correct ADR records the preconditions: platform team staffed, contract DSL defined, two pilot domains onboarded, lineage coverage above 80 percent on tier-1 datasets. Without those preconditions the mesh rollout fails within 18 months and the org reconsolidates under a central data team, having burned two years.

Maturity indicators. L1 teams write to the warehouse from application code. L2 teams use CDC but have no schema registry. L3 teams have a registry and contracts on tier-1 datasets. L4 teams have lineage, SLOs on freshness and completeness, and a platform team that owns the paved road. L5 teams have self-service domain onboarding, automated contract evolution, and a data platform charter with a governance board that meets monthly. Knowing which rung your org sits on and what the next rung costs in headcount and quarters is the staff-level skill that separates architects from technologists.

---
