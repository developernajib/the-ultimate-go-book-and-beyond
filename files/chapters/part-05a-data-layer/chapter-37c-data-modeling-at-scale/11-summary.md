## Summary

Data modeling is where most scalability problems originate. The decisions made in schema design echo through years of query performance, migration complexity, and operational overhead.

Key principles to carry forward:

1. **Normalize first, denormalize deliberately**: Start with normalized schema and denormalize only when profiling proves it necessary. Unplanned denormalization creates data consistency nightmares.

2. **JSONB for semi-structured, not for everything**: JSONB is a powerful escape hatch for variable attributes but is not a replacement for proper schema design. Use it when the attribute set is genuinely variable and not frequently used in WHERE clauses.

3. **Zero-downtime migrations are a skill**: The expand-and-contract pattern applies to every non-trivial schema change. Batch backfills with pauses. Online index creation with CONCURRENTLY. NOT VALID constraints validated separately. These are not edge cases - they are standard practice.

4. **Microservices require accepting eventual consistency**: When services own their own databases, cross-service joins are impossible. Event-driven sync with local projections is the right pattern. Design your data models for the queries each service needs, not for normalized "truth."

5. **Match the tool to the workload**: Time-series data belongs in TimescaleDB or ClickHouse, not in a generic PostgreSQL table with no partitioning. Hierarchical data modeled as a closure table or with ltree is 10x more efficient than recursive CTEs on an adjacency list. Full-text search belongs in a proper search index, not LIKE '%keyword%'.

6. **Anti-patterns are expensive**: The god table, EAV, missing indexes, and string-everywhere patterns are not just ugly - they actively hurt query performance, data integrity, and developer productivity. Recognize and eliminate them.

### Junior → FAANG: Carrying This Chapter Into Your First Job

The decisions in this chapter will shape the first two years of your backend career. The junior who joins a team and proposes a polymorphic foreign key in week two loses credibility that takes quarters to rebuild. The junior who in week two says "I notice this schema has eight Boolean flags, can we capture the legal state combinations somewhere" earns a reputation for thoughtfulness that compounds.

Prerequisite gaps to fill in the first 30 days of your first job. Read every migration in the repo going back one year. Map the consumer graph of the five busiest tables, because when you break one you want to know who calls you. Find the oldest nullable column and ask someone what `NULL` means for it. If nobody knows, you have found your first most useful tech-debt ticket.

Worked example of the reflex this chapter should build. You are handed a ticket "add a `favorite_color` column to users". The L3 response is to write the migration. The L4 response is to ask four questions first. Is this data per-user or per-tenant-per-user? Is `NULL` legal and what does it mean? What is the query pattern that motivates this column, and does it justify a column versus a row in a preferences table? What is the blast radius if this column is wrong for 0.1 percent of rows? Those four questions take three minutes and prevent six months of regret.

First-job interview entry-point for internal mobility. When you are ready to go for an L4 promotion 18 months in, your schema review artifacts are your strongest evidence. Save every non-trivial migration PR description you write. Save the one where you caught an anti-pattern in review. Save the postmortem where a schema decision caused an incident. Those artifacts are the promotion packet material that actually matters.

"Why did this fail?" applied to your first incident. Every first-year engineer causes a data incident. When it happens, the junior-who-stays-junior blames the tooling. The junior-who-becomes-L4 writes the postmortem, names the anti-pattern, proposes the preventative mechanism (lint rule, review checklist item, contract assertion), and lands it in the next sprint. The incident is the gift. The preventative mechanism is what you do with it.

### Senior @ FAANG: Carrying This Chapter Into Platform Leadership

At staff and principal level, the summary of a data modeling chapter is not "I know the patterns". It is "I know which patterns to enforce, which to tolerate, and which to invest in removing across the organization". The chapter distills into six organizational levers.

Lever one, the schema lint floor. Every org of more than 20 backend engineers should have a schema lint tool in CI. The lint rules that earn their keep are the ones that block nullable foreign keys without rationale, `text` columns whose values are constrained in practice, missing indexes on foreign keys, timestamps without timezone, primary keys that are not `bigint` or `uuid`, and tables without `created_at` and `updated_at`. A lint that fires on fewer than 5 percent of PRs is too lenient. A lint that fires on more than 40 percent is creating process theater. Calibrate.

Lever two, the schema review board. At 50-plus engineers, ad hoc review does not scale. A board with a written charter, a rotating chair, a documented decision log, an escape hatch for incident-driven changes, and a weekly digest becomes the organizational memory for schema evolution. Most orgs under-invest in the decision log and over-invest in the meeting cadence. Invert that. The decision log is the durable artifact. The meeting is replaceable.

Lever three, the data contract registry. At 150-plus engineers with more than one pod producing data consumed by more than one pod downstream, contracts become load-bearing. A registry with versioned schemas, declared consumers, schema stability windows, freshness SLOs, completeness SLOs, dual-write guarantees during migration windows, deprecation notice periods, and on-call rotations for violations transforms "somebody broke our pipeline" from an outage into a protocol. Without the registry, you will have this outage once per quarter forever.

Lever four, the maturity model roadmap. L1 through L5 as described in the anti-patterns section. The roadmap commits to moving one notch per year. It names the prerequisite investment for each notch. It names the organizational owner. A roadmap that cannot be expressed in a single page is not a roadmap, it is a wishlist.

Lever five, the ADR culture. Every non-trivial schema decision lands with an ADR that answers the eight questions named earlier (access pattern, amplification, rollback plan, consumer contracts, blast radius, hot key risk, QPS budget, ownership and SLA). The ADRs accumulate into an organizational memory that survives engineer turnover. Without ADRs, every two years a new engineer proposes the same denormalization that was tried and failed in year three.

Lever six, the postmortem-to-preventative-mechanism loop. When a data modeling decision causes an incident, the postmortem is not complete until it names a preventative mechanism (lint rule, ADR template field, contract assertion, review board criterion) and that mechanism is landed. An org whose postmortem-to-mechanism conversion rate is below 50 percent is accumulating entropy faster than it can shed it. Measure that rate. Report it.

Governance maturity curve. An organization at L1 ships anti-patterns weekly. At L2 it ships them monthly but spots them in review half the time. At L3 the lint catches most of them before merge. At L4 the contracts catch them before they reach consumers. At L5 the platform makes them structurally impossible because the schema authoring tool does not offer them as options. Most FAANG OLTP stacks in April 2026 are at L3 with aspirations to L4. Moving from L3 to L4 is a three-to-five quarter staff-led investment. Budget accordingly.

Bar-raiser self-check for promotion readiness. You are ready for L6 on data modeling when you can walk into a schema review and identify the three highest-risk decisions in any proposal within five minutes, name the organizational mechanism that should have caught each, and propose the migration path if the mechanism did not exist yet. You are ready for L7 when you can look at an org's data platform investment portfolio and say "these three initiatives are underfunded, these two are over-scoped, this one should be killed, and here is the reallocation that gets us to L4 maturity in four quarters". If you cannot do the L6 check yet, practice on open-source schema PRs. If you cannot do the L7 check yet, shadow a staff engineer through one quarter of planning.

---
