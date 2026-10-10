## Summary

Common workflow patterns that appear in production Temporal deployments:

- **Fan-out/fan-in** runs activities in parallel and aggregates results, reducing latency for multi-service calls
- **Saga with compensation trees** manages distributed transactions without locks, executing compensations in LIFO order on failure
- **State machines** model business processes as explicit state transitions driven by signals, producing an auditable history
- **Human-in-the-loop** patterns park workflow execution until a human decides, with timer-based reminders and escalation
- **Activity batching** groups high-frequency operations into single activity calls, reducing history size and API pressure
- **Dynamic child workflows** distribute large-scale parallel work across independent execution histories with concurrency control
- **Event-driven triggers** route domain events to workflow starts and signals through an event router
- **Versioning** with `GetVersion` allows code changes while in-flight workflows continue executing their original logic

The e-commerce case study demonstrated how these patterns compose: parallel validation, signal-based payment callbacks, per-warehouse fulfillment with saga compensation, and async post-processing through child workflows.

The central insight is that workflows are Go code, not configuration. The full expressiveness of the language (variables, conditions, loops, error handling) combines with Temporal's durable execution to handle coordination problems that would otherwise require custom infrastructure.

### Junior → FAANG: What to Take Away from This Chapter

Eight core workflow patterns govern production pipelines. At the entry level, the goal is not to memorize the implementations but to recognize which pattern applies when a coordination problem appears.

**The pattern recognition checklist:**

- Independent parallel tasks with result aggregation: fan-out/fan-in.
- Multi-service writes where any step can fail after prior steps committed: saga with compensation.
- Business process with explicit state transitions and audit trail: state machine with signals.
- Decision that requires a human, with a time-based fallback: human-in-the-loop.
- High-frequency items that must reach an external API without triggering rate limits: activity batching.
- Large-scale parallel work that would overflow one workflow's history: dynamic child workflows.
- External system events that should start or modify workflows: event-driven triggers.
- Behavioral change that must not break in-flight executions: `GetVersion` versioning.

**Three habits to develop immediately:**

First, register compensation immediately after each successful forward step. Never defer compensation registration to the end of the workflow.

Second, use `workflow.Now(ctx)` instead of `time.Now()` inside workflow functions, always.

Third, write the failure-path test before the happy-path test for any saga workflow.

**Interview preparation summary.** The five questions in the interview section cover 80% of FAANG workflow questions. Practice answering each one out loud, including the follow-ups, before your interview. The follow-ups are harder than the primary questions and are where candidates are differentiated.

### Senior @ FAANG: Platform Thinking Across This Chapter's Patterns

At staff level, the patterns in this chapter are not individual tools but a vocabulary for platform-level workflow design. The staff engineer's contribution is transforming this vocabulary into organizational capability.

**From pattern knowledge to platform policy.** Each pattern in this chapter has a corresponding platform policy that teams should follow without re-deriving it:

- Fan-out: max concurrency per workflow type must be documented and enforced via selector-based concurrency control.
- Saga: every multi-service write workflow must have a compensation coverage test and a compensation failure runbook.
- State machine: all state transitions must be explicit, audited, and protected by `GetVersion` gates on change.
- Human-in-the-loop: approval SLAs must be defined and monitored with external observability, not just tracked within the workflow.
- Batching: batch sizes are derived from external API contracts and SLA budgets, not from convenience.
- Child workflows: parent-child lifecycle policy (terminate, abandon, request-cancel) must be explicitly specified for each usage.
- Event-driven: event routers must handle at-least-once delivery with deduplication at the workflow ID level.
- Versioning: every behavioral change requires a `GetVersion` gate, versioning tests, and a gate lifecycle policy.

**The platform maturity journey for this chapter's material.** Level 1: teams use Temporal but patterns are inconsistent, compensations are ad-hoc, versioning is a recurring incident source. Level 3: all patterns from this chapter are used correctly by all teams, versioning is gated without exception, saga tests cover compensation paths. Level 5: pattern selection is automated (a scaffolding tool generates the correct boilerplate for each pattern), versioning is managed by Worker Build IDs with code gates reserved for structural changes, and history size is continuously monitored with alerts. The distance from level 1 to level 5 is 12 to 24 months of deliberate platform investment for a 20-team organization. Staff engineers set the roadmap and sequence the investments.

**The chapter's central insight at L6 scope.** "Workflows are Go code, not configuration" is true and important. The L6 extension is: "Workflows are the domain model of your business processes, expressed in code. Every pattern in this chapter is a design decision about how your business handles uncertainty, failure, and time. The implementation language is Go. The subject matter is your business." This framing keeps the engineering decisions anchored to business requirements rather than drifting into technical elegance for its own sake.
