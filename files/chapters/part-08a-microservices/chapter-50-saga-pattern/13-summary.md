## Summary

The saga pattern replaces distributed transactions with a sequence of local transactions, each paired with a compensating action that semantically undoes its effect on failure. The result is eventual consistency rather than ACID atomicity, which is the right tradeoff for most business workflows running across independent services with separate databases.

1. **Choreography** works well for simple, linear workflows with two to four participants. Each service listens for domain events and decides what to do next. The tradeoff is that the overall saga flow is implicit, scattered across event handlers rather than visible in a single place, which makes debugging and state tracking harder as the number of participants grows.

2. **Orchestration** centralizes the workflow in a coordinator that issues commands to participants and maintains explicit state for each saga instance. This makes the complete flow visible in one place, simplifies compensation logic, and enables crash recovery through persistent state. The tradeoff is that the orchestrator becomes a single point of failure, which you mitigate with high availability and distributed locking.

3. **Temporal** eliminates most hand-built saga infrastructure. Workflows execute as normal sequential Go code, but Temporal persists every activity result and replays history on worker restart. Compensation uses `defer`, and Temporal handles retries, timeouts, and crash recovery automatically. Use Temporal when you need durable execution guarantees without building the persistence and recovery machinery yourself.

4. **Compensation design** determines whether your saga actually maintains consistency. Every forward action needs a compensating action. Compensations must be idempotent because retries are inevitable. Some compensations are semantically imperfect (non-refundable purchases, sent emails). Model these explicitly with compensation result types and manual intervention workflows rather than pretending they fully reverse the action.

5. **Monitoring** requires saga-specific metrics beyond standard request-level instrumentation: in-flight saga count, step duration histograms, compensation frequency, and stuck-saga detection. Alert on sagas that exceed their deadline or accumulate excessive compensation retries. Move sagas that cannot make progress to a dead letter state that triggers manual review.

### Junior -> FAANG: Consolidating the Chapter Into Interview-Ready Knowledge

The five points above are the five answers to the five most common saga interview questions. Map each to an interview question before you close the chapter.

Point 1 (choreography vs. orchestration) is the answer to "explain the two main saga patterns and when you would use each." Your answer should include step count as the primary discriminator (choreography for two to four steps, orchestration for five or more), team boundaries as the secondary discriminator (choreography works when the same team owns all participants, orchestration works when participants are owned by different teams and you need centralized visibility), and Temporal as the production default for anything with more than three steps or non-trivial compensation.

Point 2 (orchestration with persistent state) is the answer to "how does your saga survive a process crash?" Your answer must include: state written to durable storage before and after each step, recovery query on startup for in-progress sagas, and idempotent step execution so re-running a step after recovery is safe.

Point 3 (Temporal) is the answer to "what workflow engine would you use and why." Your answer must include the determinism constraint (no `time.Now`, no direct goroutines in workflow code), the at-least-once activity guarantee (and why activities must be idempotent as a result), and the ergonomic benefit (plain Go code with `defer` for compensation, no state machine configuration).

Point 4 (compensation design) is the answer to "how do you handle partial failures in a saga." Your answer must go beyond "compensate in reverse order" to include: idempotency requirement for all compensations, semantic compensation impossibility for non-refundable purchases or sent emails, and the dead-letter state with human intervention workflow for compensation failures.

Point 5 (monitoring) is the answer to "how would you know if your saga system was having problems." Your answer must name specific metrics (in-flight count, compensation rate, step duration histograms) and specific alerts (stuck saga by SLO, compensation failure rate spike) rather than "I would check the logs."

### Senior @ FAANG: Chapter Synthesis from a Platform Perspective

Each of the five summary points above represents a platform capability, not just an implementation choice. Staff engineers reading this chapter should ask: which of these five capabilities is currently absent from our platform, and which one, if addressed, would provide the most value?

**Point 1: Saga variant selection governance.** Most platforms start with one saga variant and later encounter workflows where the other variant would have been better. Staff engineers establish a decision framework: a one-page ADR template that forces teams to answer "step count, team topology, observability requirements, and compensation complexity" before selecting a variant. The framework is enforced in architecture review, not just suggested in documentation.

**Point 2: Crash recovery as a tested requirement.** Persistent state is necessary but not sufficient. The orchestrator's recovery logic must be tested with actual process crashes in a staging environment, not just unit tested with mock databases. Staff engineers build a chaos testing suite that kills the orchestrator at each step of a sample saga and verifies that recovery produces the correct terminal state. This suite runs in CI for every change to the orchestrator.

**Point 3: Temporal adoption strategy.** If your organization is not yet on Temporal, the adoption question is not whether to adopt it but how to migrate existing hand-rolled orchestrators without disrupting in-flight sagas. The migration strategy is: run both engines in parallel, new sagas go to Temporal, old sagas run to completion on the hand-rolled engine, decommission the hand-rolled engine when its saga count reaches zero. The risk is operational: for 3 to 6 months you operate two systems. Staff engineers quantify this risk against the operational risk of continuing to maintain the hand-rolled engine.

**Point 4: Compensation completeness audit.** At scale, new saga steps are added by engineers who may not fully understand the compensation requirements. An audit process (quarterly or triggered by incidents) reviews every saga step and validates that its compensation function handles all three cases: full reversal, partial reversal, and semantic impossibility. Steps that have never had their compensation tested in production are flagged for fault injection testing.

**Point 5: Saga observability standardization.** The most valuable action a platform team can take for saga observability is to provide a canonical metrics library that all saga implementations import. The library emits the mandatory metric set with the correct label cardinality, the correct histogram bucket boundaries, and the correct naming convention, without each team having to implement this correctly independently. Combined with a mandatory Grafana dashboard template and mandatory alert rules checked into the platform's Terraform repository, this converts saga observability from a per-team responsibility to a platform guarantee.

---
