## FAANG Interview Q&A: Failed Projects and Migrations

These questions surface whether you can learn from public failures and apply the engineering principles to your own migration and project planning.

### 1. Healthcare.gov cost $1.7 billion and failed on launch. What went wrong from an engineering perspective?

Expected points: no incremental delivery (big-bang launch), integration testing pushed to the end, no realistic load testing, unclear ownership across contractors, and no rollback path because there was no previous system to roll back to. Translate to Go services: every migration must have a rollback at every milestone, and every milestone must be independently releasable.

### 2. Knight Capital lost $440 million in 45 minutes because of a deployment that left obsolete code paths active on one of eight servers. What is the engineering lesson?

The class of failure is heterogeneous fleet state. Prevention: immutable deployments where every server runs the exact same binary, automated verification that deployed state matches intended state before traffic is routed, feature flags that are strictly additive (never reuse a flag name for a different purpose), and a kill switch that terminates the entire fleet if any server reports an inconsistent state. The Knight failure is the strongest existence proof that manual deployment steps are incompatible with trading-speed systems.

### 3. Describe a time a migration you were involved in failed or was significantly harder than planned.

Interviewers look for honesty. Identify the specific mistake: underestimated data volume, unvalidated assumption about downstream consumers, test coverage gap, or stakeholder alignment that only existed on paper. Describe the concrete lesson you applied to the next migration. Avoid the temptation to blame external factors.

### 4. Design a migration plan from a Go monolith to microservices for a system handling 10k QPS.

A Staff-level answer covers: start with a bounded-context analysis, extract the first service behind a feature flag with traffic percentages, run the old and new paths in shadow mode for at least two weeks, compare outputs via a reconciliation job, cut over fully only after drift is below 0.1%, and preserve the rollback path for at least 30 days. Discuss how you would handle the data layer (shared database initially, extracted later as a separate phase), and why you should never do monolith-to-microservices and data-extraction in the same migration.

### 5. Amazon's 2018 Prime Day outage was caused by auto-scaling that could not keep up with demand. How would you design auto-scaling for a Go service that must handle a predictable traffic spike?

Cover: pre-warming instances before the predicted spike (auto-scaling is reactive and has a cold-start lag), overprovisioning as insurance (cost of extra capacity is orders of magnitude less than the cost of an outage), load shedding with priority queues (P0 traffic served, P3 dropped first), circuit breakers on downstream dependencies that also need to scale, and a load test at the predicted peak at least one week before the event. Mention GOMEMLIMIT and GOGC tuning for container environments so Go's GC behavior matches the actual memory ceiling.

---

### Junior → FAANG: Using the Five Questions to Structure Behavioral and System Design Answers

The five questions above cover the full spectrum of migration and project failure interview formats: post-mortem analysis (Q1, Q2), behavioral storytelling (Q3), system design with migration constraints (Q4), and capacity planning under known load (Q5). For each question, the structure is consistent: name the failure class from this chapter, explain the root cause in one sentence, describe the specific mitigation pattern in Go, and generalize to the broader architectural principle. For Q2 (Knight Capital), that structure is: "The failure class is heterogeneous fleet state. A manual deployment step left one of eight servers running obsolete code, which reactivated a dead code path that should have been deleted in 2003. The mitigation is immutable deployments with automated fleet consistency verification: every server must hash its deployed binary and report it to a central verification service before accepting traffic. The general principle is that any system with financial or safety consequences must be incapable of reaching a partially-deployed state." This structure demonstrates both technical depth and the ability to connect technical details to historical incidents.

### Senior @ FAANG: Bar-Raiser Migration Questions and Organizational Failure Prevention

At the bar-raiser level, every question above has an organizational dimension that distinguishes L6 answers from L4 answers. Q1 (Healthcare.gov): the bar-raiser follow-up is "how do you ensure that integration test coverage is visible to the person who can delay the launch?" The answer requires a reporting mechanism, not just a testing mechanism: test coverage must be a named metric in the project status report, with a defined go/no-go threshold. Q4 (monolith to microservices): the bar-raiser follow-up is "how do you ensure that every team extracting a service follows the same migration protocol?" The answer requires a shared migration library and a production readiness review gate, not individual team compliance with documentation. Q5 (Prime Day auto-scaling): the bar-raiser follow-up is "how do you ensure that every service in the critical path has been load tested before the event?" The answer requires an organization-wide traffic event readiness review with mandatory load test evidence for each critical service, not an assumption that teams have done it independently. At the bar-raiser level, the interviewer is assessing whether you can design organizational processes that make the correct behavior automatic and the incorrect behavior structurally prevented, not whether you personally understand the technical principles. Every answer that ends with "and we would document this in a runbook" is an L4 answer. Every answer that ends with "and the platform enforces this through an automated gate that no team can bypass" is an L6 answer.

---
