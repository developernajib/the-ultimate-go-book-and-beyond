## Learning Objectives

By the end of this chapter, you will be able to:

- **Understand the distributed transaction problem** and why traditional ACID transactions don't scale across microservices
- **Implement choreography-based sagas** using event-driven communication patterns
- **Build orchestration-based sagas** with centralized coordinators for complex workflows
- **Design compensating transactions** that handle partial failures gracefully
- **Integrate with Temporal** for production-grade durable saga execution
- **Monitor and observe saga execution** with detailed metrics and alerting
- **Apply saga patterns** proven at high-scale distributed systems in production

### Junior -> FAANG: Mapping Objectives to Interview Competencies

Each objective in this list corresponds to a category of technical question that appears in systems design and behavioral interviews. Learning objectives that candidates skip, because they look "soft," are often exactly the ones that separate a hire from a no-hire at mid-level.

"Understand the distributed transaction problem" maps to the classic question "why can't you just use a database transaction across services?" You need a crisp two-sentence answer: each service owns its own database, there is no shared transaction coordinator across service boundaries, and even if there were, two-phase commit holds locks across all participants until the coordinator receives all votes, which breaks availability under any partition. Practice saying this out loud until it takes under 30 seconds.

"Design compensating transactions that handle partial failures gracefully" is the most commonly failed objective. Interviewers ask you to design a five-step saga and then ask "what happens if step three fails, and what happens if the compensation for step two also fails?" A junior answer says "retry the compensation." A strong answer says "retry with jitter up to N attempts, then move the saga to a dead-letter state, alert the on-call team with full context, and provide a runbook for manual resolution."

"Integrate with Temporal" is the objective that demonstrates production awareness. You do not need to have operated Temporal in production. You do need to know that Temporal workflows must be deterministic, what that means in practice (no `time.Now`, no direct goroutines, no random numbers outside `workflow.SideEffect`), and why Temporal provides at-least-once activity execution rather than exactly-once.

First-job habit: for every saga design you work on, write out the failure matrix before writing code. Rows are steps, columns are possible failure modes (network timeout, service returns error, service crashes after succeeding). The matrix makes gaps in your compensation design visible before they reach production.

### Senior @ FAANG: Translating Objectives into Platform Decisions

At senior level, each learning objective becomes a governance question rather than an implementation question. The objective "implement choreography-based sagas using event-driven communication" becomes "when does your organization approve a choreography-based saga versus requiring orchestration, and who makes that call?" Without a written policy, every team re-decides this independently and you end up with inconsistent compensation semantics across the platform.

The objective "building orchestration-based saga coordinators" becomes "what is the approved orchestration engine, what namespacing and isolation policy governs it, and who owns the on-call rotation for the orchestration infrastructure?" At FAANG scale, Temporal or an equivalent engine typically runs as a shared platform service owned by a distributed-systems platform team, not by each product team independently. Staff engineers negotiate the interface between the platform and the product teams.

The objective "monitor and observe saga execution" becomes a cross-team standard: which metrics are mandatory for every saga, which labels are required on every metric (saga type, step name, compensation flag), what the canonical alert names are, and how saga observability integrates with the broader incident management system. Without this standard, every team invents its own dashboard and on-call engineers cannot reason about sagas they did not write.

The objective "apply saga patterns proven at high-scale distributed systems" requires that you can name specific constraints at those systems and not just the pattern name. Uber's Cadence-based sagas have a deterministic replay constraint identical to Temporal. Netflix's Conductor uses a declarative JSON DSL that non-engineers can modify. Amazon's Step Functions are managed but vendor-locked to the AWS execution model. Knowing these constraints lets you evaluate vendor trade-offs in an architectural review, which is an explicit expectation at L6 and above.

---
