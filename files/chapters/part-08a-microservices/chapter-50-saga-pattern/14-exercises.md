## Exercises

1. **Implement Choreography Saga**: Build an order processing saga using Kafka events with order, inventory, and payment services.

2. **Build Orchestrator with Recovery**: Create a saga orchestrator that can recover from crashes and resume incomplete sagas.

3. **Add Timeout Handling**: Implement step-level timeouts with automatic compensation when exceeded.

4. **Implement Saga Dashboard**: Build a UI to visualize saga state, show in-progress sagas, and display compensation history.

5. **Create Temporal Workflow**: Implement the order saga using Temporal with proper compensation handling.

6. **Add Saga Metrics**: Instrument sagas with Prometheus metrics and create Grafana dashboards.

7. **Handle Partial Failures**: Implement manual intervention endpoints for sagas that fail compensation.

8. **Build Saga Testing Framework**: Create a framework to test saga workflows with simulated failures at each step.

### Junior -> FAANG: How to Use These Exercises for Interview Preparation

Eight exercises spread across multiple sessions produce better retention than completing all eight in a single sitting. The exercises are grouped by the skills they test, and the skill groupings map to specific interview question types.

Exercises 1 and 2 test your ability to implement a saga from scratch, which maps to coding interviews and take-home assignments. Do these with a timer. Exercise 1 should take you under 90 minutes on a second attempt. If it takes longer, identify the specific part that slows you down (event routing, Kafka configuration, idempotency handling) and practice that part in isolation.

Exercises 3 and 6 test your operational thinking (timeout handling and metrics), which maps to system design interviews and the "how would you make this production-ready" portion of coding interviews. Practice talking out loud while implementing these, because the interview version of these questions expects verbal explanation of trade-offs alongside code.

Exercises 4 and 7 (dashboard and manual intervention) test your SRE and product thinking, which maps to behavioral interviews about handling incidents and cross-functional collaboration. For exercise 7, think about who receives the alert when a saga fails compensation and what information they need to resolve the issue without reading source code.

Exercises 5 and 8 (Temporal workflow and testing framework) are the differentiators at senior level. Exercise 5 requires understanding Temporal's determinism constraints. Exercise 8 requires designing a testing abstraction that simulates failure at arbitrary saga steps, which is a genuine distributed systems engineering problem. If you can complete exercise 8 with a clean API and a test that verifies compensation runs correctly on step-3 failure, you have demonstrated L5-level technical depth on this topic.

### Senior @ FAANG: Designing These Exercises for Candidate Evaluation

These exercises serve two purposes: learning for the reader and evaluation material for interviewers. A staff engineer designing a technical interview or take-home assessment for a distributed systems role would select from this list based on the level being evaluated.

For an L4 take-home, exercises 1 and 3 are appropriate. The expected deliverable is a working implementation with unit tests, basic error handling, and a README explaining the compensation strategy. The evaluation criteria are correctness (does the saga converge to a terminal state in all tested scenarios), code quality (appropriate separation of concerns, clear naming), and operational awareness (does the candidate mention the transactional outbox gap, even if they do not implement it).

For an L5 take-home, exercises 1 and 2 together, with the requirement to make the orchestrator in exercise 2 handle concurrent instances safely. The expected deliverable adds distributed locking, proper idempotency in every compensation function, and a test that simulates a crash-and-recovery scenario. The evaluation criteria add correctness under concurrency and crash recovery to the L4 criteria.

For an L6 system design, exercises 4 and 7 combined into a 45-minute design discussion: "design the operational tooling for a saga-based order management system, including the dashboard, alerting strategy, and manual intervention workflow." The expected deliverable is a verbal architecture with component descriptions, not code. The evaluation criteria are breadth (does the candidate cover monitoring, alerting, escalation, runbook, and manual remediation tools), depth (does the candidate name specific metrics, alert thresholds, and SLO values rather than generic categories), and organizational thinking (does the candidate identify who owns the tooling, who is on-call, and how the tooling integrates with the broader incident management system).

Exercise 8 (testing framework) is appropriate as a supplemental question for any level, because it reveals how the candidate thinks about testability at the infrastructure level. A strong junior candidate treats it as "mock the downstream services." A strong senior candidate treats it as "provide a failure injection API that can simulate failure at any step with configurable error types, combined with a verification API that asserts the saga's terminal state and the compensation actions that were executed." The senior answer is immediately useful in a real codebase. The junior answer requires rewriting for each new saga type.

---
