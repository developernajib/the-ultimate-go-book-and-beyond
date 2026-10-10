# Chapter 52L: Advanced Workflow Patterns

*A workflow is a unit of business logic, not a unit of infrastructure. When you conflate the two, you end up rebuilding Temporal badly.*

Building basic Temporal workflows is straightforward. Building workflows that handle thousands of concurrent instances, evolve under deployment, decompose complex processes into testable units, and recover from every class of failure requires patterns that are not obvious from the documentation alone. The gap between a demo workflow and a production workflow is the gap between understanding the happy path and understanding how distributed durable execution fails.

The saga pattern is central to this chapter. When a business process spans multiple services - an e-commerce order that charges a payment, reserves inventory, schedules shipping, and sends a confirmation email - any step can fail after previous steps have already succeeded. Without compensation, partial failures leave the system in an inconsistent state: the customer is charged but no inventory is reserved. The saga pattern addresses this by pairing each forward action with a compensating action that semantically undoes it. Orchestration-based sagas - where a central workflow function sequences both the forward steps and the compensating steps - are far easier to reason about and debug than choreography-based sagas, where each service publishes events that trigger other services' reactions. Temporal is purpose-built for orchestration-based sagas.

Fan-out/fan-in, hierarchical workflow decomposition, human-in-the-loop patterns, and workflow versioning complete the advanced toolkit. Fan-out allows a parent workflow to spawn dozens or hundreds of child workflows or activity coroutines in parallel, collecting their results when all complete - a pattern essential for batch processing, parallel enrichment, and distributed map-reduce. Hierarchical decomposition allows large, complex business processes to be broken into child workflows with clear boundaries, enabling independent testing and reuse. Human-in-the-loop workflows park execution until a human approves a step via signal, enabling approval chains that can span days. Versioning - the hardest operational challenge in workflow systems - allows code changes to be deployed while thousands of existing workflow instances continue executing their original logic.

**What you'll learn in this chapter:**
- Implement fan-out/fan-in patterns using child workflows and `workflow.Go` coroutines with result aggregation and partial failure handling
- Build saga orchestration in Temporal with compensation trees, rollback ordering, and idempotent compensating activities
- Design hierarchical workflow decomposition strategies that maximize testability and minimize inter-workflow coupling
- Implement human-in-the-loop approval workflows using signals with timeout and escalation fallback
- Apply activity batching to aggregate high-frequency events before external API calls, reducing latency and rate-limit exposure
- Write workflow-as-code that is deterministic, testable, and free of the anti-patterns that cause non-determinism errors
- Version running workflows safely using `workflow.GetVersion` with backward-compatible branching strategies
- Build event-driven workflow triggers that react to Kafka, webhook, and database CDC events without polling

**Why this matters at scale:**
Payment dispute workflows at companies like Stripe follow the saga pattern: charge the customer, reserve escrow funds, notify the merchant, and on dispute resolution, execute a compensation tree that reverses each step in the correct order. Reservation systems use hierarchical workflow decomposition, delegating to child workflows for payment, notification, calendar blocking, and compliance checks. Financial platforms use human-in-the-loop patterns for large withdrawal approvals, where amounts above a threshold require manual review before the workflow proceeds. CI/CD systems implement fan-out/fan-in for parallel job execution, a pattern directly analogous to Temporal child workflows.

**Prerequisites:** Chapter 52K (Temporal deep dive - execution model, activities, signals, queries), Go concurrency (Chapter 11), and Chapter 50 (distributed transactions and the saga pattern in theory).

### Junior → FAANG: Bridging the Gap Between Demo and Production Workflows

Junior engineers typically first encounter Temporal through tutorials that demonstrate happy-path workflows: start an activity, wait for the result, return. The gap to production becomes apparent the moment a second requirement appears, such as "what happens if step 3 fails after step 2 succeeded?" The patterns in this chapter exist precisely to answer that question systematically.

Key gaps to close before your first production workflow:

**Non-determinism is your most common interview topic.** Temporal replays workflow history to reconstruct state. Any code path that produces different results on replay (wall clock time, random numbers, goroutines, network calls) breaks replay and causes a panic in production. Every pattern in this chapter is constructed to avoid that class of error. If an interviewer asks "what can go wrong in a Temporal workflow?", non-determinism is the primary answer.

**Compensation is not optional for multi-step processes.** If a workflow touches three services and the third fails, the first two have already committed. Without a compensation tree, the system is permanently inconsistent. Demonstrate at interview that you reach for compensation immediately when multi-service flows appear on the whiteboard, not as an afterthought.

**The happy path is not a test.** A test that only exercises the success path provides little confidence. Mock the activity at the second step to fail and verify that compensating activities fire. The `testsuite.TestWorkflowEnvironment` package makes this straightforward, and FAANG interviews commonly probe whether you test the failure paths specifically.

**Understanding execution model before writing code.** A workflow function runs on a Temporal worker thread but executes as a coroutine: it yields when waiting for an activity result or timer, and another workflow can execute on the same thread during that yield. Misunderstanding this leads to shared-state bugs and incorrect concurrency assumptions.

Entry-level interview question framing: "Describe a workflow that sends a welcome email, provisions an account, and applies a referral bonus in parallel. What happens if account provisioning fails after the email was sent?" The answer should demonstrate fan-out (parallel execution), awareness that email cannot be undone (semantic compensation), and how you would model the provisioning failure as the fatal step.

### Senior @ FAANG: Architectural Thinking for Workflow Platform Adoption

At the senior and staff level, the decision is not "how do I write a Temporal workflow?" but "when is Temporal the right tool, what is the platform contract for teams using it, and what operational commitments does adoption create?" This chapter's patterns are the vocabulary of that conversation.

**Platform capability mapping to patterns.** Each pattern in this chapter addresses a category of problem. Before mandating which pattern to use, a staff engineer maps the problem taxonomy to the capability set:

- Multi-service write with any-step failure risk: saga with compensation tree.
- Throughput-bounded parallel processing with bounded history: concurrency-controlled child workflow fan-out.
- Human decision gate with SLA enforcement: human-in-the-loop with timer escalation.
- Long-lived loops (event processors, pollers): `ContinueAsNew` to prevent history growth.
- Code change while executions are running: `workflow.GetVersion` gating, or Worker Build IDs for fleet-scale.

The staff engineer's job is to publish this map as a decision guide, so teams do not re-derive it independently (and incorrectly) each time.

**ADR: Orchestration versus choreography at the platform boundary.** The canonical ADR records: "Within a bounded context, use Temporal orchestration. Across bounded context boundaries, publish domain events and let receiving contexts start their own workflows." This keeps inter-team coupling in the event schema, not in workflow code. It also means that when another team's service goes down, your workflow pauses at the signal wait rather than failing, which is the correct behavior.

**Maturity model for workflow adoption.** A useful internal framework for evaluating a team's workflow health:

- Level 1: Activities are idempotent, workflows have retry policies.
- Level 2: Saga compensation covers all failure paths, including compensation failure.
- Level 3: Versioning gates are present on all production changes, with a documented gate-cleanup policy.
- Level 4: Workflow observability is wired: structured logs with workflow ID and run ID correlation, metrics on activity duration by type, alerting on stuck workflows.
- Level 5: Workflow patterns are tested for failure paths, time-based paths (escalation, timeout), and concurrent signal delivery.

Teams that self-assess at Level 1 and deploy complex sagas produce the incidents that staff engineers are called in to debug at 2am.

**Bar-raiser signals for workflow system design.** At L6/L7 system design reviews, the bar-raiser listens for these indicators:

The candidate separates the saga from its compensation policy. "We log compensation failures and page on-call" is a policy. "We silently swallow compensation errors" fails the bar.

The candidate proactively addresses history growth. Any workflow with an unbounded loop (event consumer, recurring job) must use `ContinueAsNew` or be modeled as a recurring scheduled workflow. Candidates who design unbounded history are implicitly designing a time-bomb.

The candidate names the deployment contract. "We deploy a new binary and all executions migrate automatically" is incorrect for behavioral changes. The correct answer specifies which changes require version gates, which require a new task queue, and which can be deployed without coordination.

The candidate understands the non-determinism failure mode. A non-determinism panic in a running execution means the workflow is stuck: it cannot proceed until a code rollback or a manual reset. At scale, a bad deployment that introduces non-determinism can freeze thousands of in-flight executions simultaneously. The candidate should propose canary deployment of workflow workers and smoke-testing on a shadow task queue before fleet rollout.

**Governance: who owns the compensation contract.** In multi-team sagas (where each step calls a service owned by a different team), the compensation activity for each step must be implemented and maintained by the team that owns the forward action. The orchestrating workflow team cannot implement `CancelInventoryReservation` correctly. Only the inventory team can. This is a governance decision that must be made before adoption, not discovered during an incident.

---
