## The Workflow Pattern Landscape

Workflow orchestration patterns address recurring coordination problems (fan-out, compensation, human approval, batching) that appear across industries and technology stacks. The taxonomy below organizes these patterns by their primary characteristic: parallelism strategy, failure mode, or interaction model.

```
┌───────────────────────────────────────────────────────────────────────┐
│                    WORKFLOW PATTERN TAXONOMY                          │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  PARALLEL PATTERNS          SEQUENTIAL PATTERNS                       │
│  ─────────────────          ────────────────────                      │
│  Fan-Out / Fan-In           Pipeline / Chain                          │
│  Scatter-Gather             Saga (Orchestration)                      │
│  Map-Reduce                 State Machine                             │
│  Parallel Branches          Approval Workflow                         │
│                                                                       │
│  REACTIVE PATTERNS          TEMPORAL PATTERNS                         │
│  ─────────────────          ──────────────────                        │
│  Event-Driven               Cron / Scheduled                          │
│  Signal-Based               Timeout / Deadline                        │
│  External Wait              Rate-Limited                              │
│  Callback                   Delayed Execution                         │
│                                                                       │
│  HIERARCHICAL PATTERNS      RESILIENCE PATTERNS                       │
│  ─────────────────────      ───────────────────                       │
│  Parent/Child               Circuit Breaker                           │
│  Dynamic Spawning           Retry with Backoff                        │
│  Supervisor Tree            Compensation / Undo                       │
│  Aggregator                 Idempotent Actions                        │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

Each category addresses a different coordination concern. Parallel patterns maximize throughput by running independent work concurrently. Sequential patterns enforce ordering constraints where steps depend on prior results. Reactive patterns decouple workflow execution from the events that drive it, while temporal patterns add time-based behavior like scheduling and deadlines. Hierarchical patterns decompose large workflows into smaller, independently testable units. Resilience patterns handle the failures that distributed systems inevitably produce.

The sections that follow implement the most commonly needed patterns from this taxonomy using Temporal's Go SDK, with production-grade error handling and compensation logic.

### Junior → FAANG: Reading the Pattern Map Before Writing Code

Most junior engineers skip taxonomy and go directly to implementation. The cost of that shortcut is choosing the wrong pattern and spending a week building the wrong thing. The taxonomy above is a decision aid: when a new coordination problem arrives, locate it in the map before writing a single line.

**How to use the taxonomy in an interview.** When a system design question involves workflow coordination, narrating your placement of the problem in the taxonomy demonstrates structured thinking. "This is a parallel pattern with independent units of work and a result aggregation step, so fan-out/fan-in applies here. If any unit can fail without failing the whole job, I need the partial-failure variant" shows a candidate who reasons from patterns, not from code.

**Common first-job mistakes when ignoring taxonomy:**

- Using a sequential pipeline where a parallel pattern would halve latency.
- Using event-driven choreography where orchestration is needed, then discovering mid-project that end-to-end tracing is impossible.
- Modeling a human approval step as a polling loop inside an activity instead of a signal-wait inside the workflow, which burns worker threads and leaks heartbeat timeouts.

**The four categories to memorize.** At entry level, the categories that appear in every FAANG workflow interview are: parallel (fan-out/fan-in), resilience (saga, retry), human interaction (signal-wait with timer), and versioning (GetVersion gates). Everything else in the taxonomy is a specialization of these four.

**Prerequisite check.** If you cannot explain why Go channels are unsuitable for Temporal workflows (they are non-deterministic across replay), you are not ready to implement any pattern in this chapter. Resolve that gap in Chapter 11 before continuing.

### Senior @ FAANG: Pattern Selection as Platform Policy

The taxonomy is not just a reading guide. At staff level, it becomes the basis for platform documentation that prevents teams from re-deriving (and mis-deriving) patterns independently. Publishing a "pattern selection guide" with decision criteria for each category is a force multiplier that scales your architectural judgment across dozens of teams.

**Pattern selection criteria for the ADR template.** Each pattern category in the taxonomy carries specific adoption criteria that belong in your internal ADR template:

Parallel patterns: use when tasks are independent (no shared mutable state between branches), when the aggregate latency would otherwise be additive, and when partial failure is explicitly modeled. Do not use when tasks share a transactional boundary that requires all-or-nothing semantics.

Resilience patterns: saga applies when steps span service ownership boundaries and each step's commit is observable to external parties (chargeback windows, inventory holds). Use a database transaction within a single service. Never use saga where an actual ACID transaction is available.

Reactive patterns: signal-based interaction is correct for human-paced decisions and for external system callbacks where polling would be wasteful. Do not use polling activities for events that arrive on a predictable schedule of minutes or longer. Use a timer instead.

Hierarchical patterns: use child workflows when each unit of work needs an independent history (long-running, potentially versioned independently) or when concurrency must be bounded by a sliding window managed by a selector. Prefer activities within a single workflow when the work is short-lived and shares the parent's versioning and timeout policy.

**Maturity signal: the platform has no pattern documentation.** If teams at your organization are writing workflows without a pattern selection guide, the observable symptom is workflow sprawl: dozens of different approaches to the same coordination problem, none of which compose with each other. Staff-level impact in this situation is producing the pattern taxonomy as a lightweight internal spec and running a working group session to align existing workflows against it.

**L6/L7 system design signal: naming the anti-pattern.** The strongest signal in a senior interview is naming not just the correct pattern but the anti-pattern it replaces and why the anti-pattern fails at scale. "Teams reach for polling loops in activities when they need signal-wait, and the result is worker thread exhaustion at 10k concurrent approval requests" demonstrates production experience at scale, not just textbook knowledge.

**Governance: pattern registry.** Organizations running Temporal at scale (hundreds of workflows, multiple teams) benefit from a pattern registry: a versioned document that enumerates approved patterns, their selection criteria, their test requirements, and their versioning contract. The registry is the governance artifact that turns one-off architectural decisions into reusable policy. Maintaining it is a staff engineer's ongoing contribution, not a one-time project.

---
