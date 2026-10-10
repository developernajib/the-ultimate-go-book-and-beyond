## Architecture Overview

The following diagram contrasts two-phase commit with the two saga variants (choreography and orchestration), and shows how compensation flows through each. The bottom sections cover Temporal's architecture for durable workflow execution and the three compensation strategies (backward recovery, forward recovery, and pivot transaction) that govern how a saga responds to step failures.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                        SAGA PATTERN ARCHITECTURE                                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────────────── Traditional 2PC ─────────────────────────────┐    │
│  │                                                                           │   │
│  │     ┌───────────────────────────────────────────────────────────────┐    │    │
│  │     │                    Transaction Coordinator                    │     │   │
│  │     └────────────┬───────────────┬───────────────┬──────────────────┘    │    │
│  │                  │ PREPARE       │ PREPARE       │ PREPARE               │    │
│  │                  ▼               ▼               ▼                       │    │
│  │            ┌─────────┐     ┌─────────┐     ┌─────────┐                   │    │
│  │            │ Service │     │ Service │     │ Service │  ← BLOCKING       │    │
│  │            │    A    │     │    B    │     │    C    │  ← LOCKS HELD     │    │
│  │            └─────────┘     └─────────┘     └─────────┘  ← SINGLE POINT   │    │
│  │                                                           OF FAILURE     │    │
│  └───────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌───────────────────── Choreography-Based Saga ────────────────────────────┐    │
│  │                                                                           │   │
│  │   ┌─────────┐   Event    ┌─────────┐   Event    ┌─────────┐              │    │
│  │   │ Order   │───────────►│Inventory│───────────►│ Payment │              │    │
│  │   │ Service │◄───────────│ Service │◄───────────│ Service │              │    │
│  │   └─────────┘  Compensate└─────────┘  Compensate└─────────┘              │    │
│  │        │                      │                      │                    │   │
│  │        ▼                      ▼                      ▼                    │   │
│  │   ┌─────────┐           ┌─────────┐           ┌─────────┐                │    │
│  │   │Orders DB│           │Inventory│           │ Payments│                │    │
│  │   │         │           │   DB    │           │   DB    │                │    │
│  │   └─────────┘           └─────────┘           └─────────┘                │    │
│  │                                                                           │   │
│  │   Pros: Loose coupling, no SPOF    Cons: Hard to track, cyclic deps     │     │
│  └───────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌───────────────────── Orchestration-Based Saga ───────────────────────────┐    │
│  │                                                                           │   │
│  │                    ┌─────────────────────────┐                            │   │
│  │                    │    Saga Orchestrator    │                            │   │
│  │                    │  ┌─────────────────┐    │                            │   │
│  │                    │  │ Saga Definition │    │                            │   │
│  │                    │  │ ┌─────┬─────┐   │    │                            │   │
│  │                    │  │ │Step1│Comp1│   │    │                            │   │
│  │                    │  │ ├─────┼─────┤   │    │                            │   │
│  │                    │  │ │Step2│Comp2│   │    │                            │   │
│  │                    │  │ ├─────┼─────┤   │    │                            │   │
│  │                    │  │ │Step3│Comp3│   │    │                            │   │
│  │                    │  │ └─────┴─────┘   │    │                            │   │
│  │                    │  └─────────────────┘    │                            │   │
│  │                    └───────────┬─────────────┘                            │   │
│  │            ┌───────────────────┼───────────────────┐                      │   │
│  │            │                   │                   │                      │   │
│  │            ▼                   ▼                   ▼                      │   │
│  │      ┌─────────┐         ┌─────────┐         ┌─────────┐                  │   │
│  │      │ Order   │         │Inventory│         │ Payment │                  │   │
│  │      │ Service │         │ Service │         │ Service │                  │   │
│  │      └─────────┘         └─────────┘         └─────────┘                  │   │
│  │                                                                           │   │
│  │   Pros: Clear state, easy monitoring    Cons: SPOF, coupling to orch    │     │
│  └───────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                             SAGA EXECUTION FLOW                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   Happy Path (All Steps Succeed):                                                │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │                                                                          │   │
│   │   T1: Create Order ──► T2: Reserve Inventory ──► T3: Process Payment     │   │
│   │        ✓                     ✓                         ✓                 │   │
│   │                                                                          │   │
│   │   Result: Order Completed Successfully                                   │   │
│   └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│   Failure Path (Step 3 Fails):                                                   │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │                                                                          │   │
│   │   T1: Create Order ──► T2: Reserve Inventory ──► T3: Process Payment     │   │
│   │        ✓                     ✓                         ✗                 │   │
│   │                                                                          │   │
│   │        │                     │                         │                 │   │
│   │        │              ┌──────┴──────┐           ┌──────┴──────┐          │   │
│   │        │              │  COMPENSATE │           │   FAILED    │          │   │
│   │        │              └──────┬──────┘           └─────────────┘          │   │
│   │        │                     │                                           │   │
│   │   C1: Cancel Order ◄─ C2: Release Inventory                              │   │
│   │        ✓                     ✓                                           │   │
│   │                                                                          │   │
│   │   Result: Saga Compensated, System Consistent                            │   │
│   └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                         TEMPORAL WORKFLOW ENGINE                                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐    │
│   │                         Temporal Cluster                                │    │
│   │   ┌─────────────────────────────────────────────────────────────────┐   │    │
│   │   │                      Frontend Service                           │   │    │
│   │   │   • gRPC API for clients                                        │   │    │
│   │   │   • Rate limiting, routing                                      │   │    │
│   │   └─────────────────────────────────────────────────────────────────┘   │    │
│   │                              │                                          │    │
│   │   ┌─────────────────────────────────────────────────────────────────┐   │    │
│   │   │                      History Service                            │   │    │
│   │   │   • Workflow execution history                                  │   │    │
│   │   │   • Event sourcing for replay                                   │   │    │
│   │   └─────────────────────────────────────────────────────────────────┘   │    │
│   │                              │                                          │    │
│   │   ┌─────────────────────────────────────────────────────────────────┐   │    │
│   │   │                      Matching Service                           │   │    │
│   │   │   • Task queue management                                       │   │    │
│   │   │   • Worker polling                                              │   │    │
│   │   └─────────────────────────────────────────────────────────────────┘   │    │
│   │                              │                                          │    │
│   │   ┌─────────────────────────────────────────────────────────────────┐   │    │
│   │   │                        Worker Service                           │   │    │
│   │   │   • Internal background tasks                                   │   │    │
│   │   │   • Timer management                                            │   │    │
│   │   └─────────────────────────────────────────────────────────────────┘   │    │
│   └─────────────────────────────────────────────────────────────────────────┘    │
│                              │                                                   │
│                              ▼                                                   │
│   ┌─────────────────────────────────────────────────────────────────────────┐    │
│   │                         Your Worker Process                             │    │
│   │   ┌───────────────────────────────────────────────────────────────┐     │    │
│   │   │   Workflow: OrderSaga                                         │     │    │
│   │   │   ├── Activity: CreateOrder                                   │     │    │
│   │   │   ├── Activity: ReserveInventory                              │     │    │
│   │   │   ├── Activity: ProcessPayment                                │     │    │
│   │   │   └── Compensation Activities (on failure)                    │     │    │
│   │   └───────────────────────────────────────────────────────────────┘     │    │
│   └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                     COMPENSATION STRATEGIES                                      │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   Backward Recovery (Default):                                                   │
│   ┌─────────────────────────────────────────────────────────────────────────┐    │
│   │   Step 1 ─► Step 2 ─► Step 3 ─► Step 4 ✗                                │    │
│   │                           │                                             │    │
│   │            ┌──────────────┘                                             │    │
│   │            ▼                                                            │    │
│   │   Comp 1 ◄─ Comp 2 ◄─ Comp 3                                            │    │
│   │   (Execute compensations in reverse order)                              │    │
│   └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│   Forward Recovery (Retry):                                                      │
│   ┌─────────────────────────────────────────────────────────────────────────┐    │
│   │   Step 1 ─► Step 2 ─► Step 3 ✗ ─► Retry ─► Step 3 ✓ ─► Step 4           │    │
│   │                                                                         │    │
│   │   (Retry failed step with backoff before compensating)                  │    │
│   └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│   Pivot Transaction:                                                             │
│   ┌─────────────────────────────────────────────────────────────────────────┐    │
│   │   Step 1 ─► Step 2 ─► [PIVOT] ─► Step 3 ─► Step 4                       │    │
│   │             Retryable │ Must     │ Never rollback                       │    │
│   │                      ▼ Succeed                                          │    │
│   │              Point of no return - compensate left, continue right       │    │
│   └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading Architecture Diagrams in Interviews

Architecture diagrams like the one above appear in whiteboard interviews and system design rounds. Knowing how to read and talk through a diagram is a skill distinct from knowing the underlying concepts.

When a diagram shows two-phase commit with a coordinator in the middle, the point is not the boxes. The point is the lines labeled "PREPARE" going out simultaneously and the implied step where the coordinator waits for all three "READY" responses before sending "COMMIT." The question to ask yourself is: what happens if the coordinator crashes after sending "COMMIT" to service A but before sending it to service B? That is the failure mode two-phase commit cannot recover from without a human administrator checking transaction logs.

When the diagram shows the choreography flow with arrows between services and reverse arrows labeled "Compensate," the visual is telling you that compensation travels in the opposite direction of the forward flow. In an interview, draw this yourself and label the arrows. Interviewers reward candidates who can sketch a system while talking rather than just describing it abstractly.

The compensation strategies section shows three recovery modes. Practice associating each with a concrete business example: backward recovery is "the payment failed so cancel the inventory reservation and then cancel the order record." Forward recovery is "the inventory service timed out but we know it probably succeeded so retry the call before triggering compensation." Pivot transaction is "we captured the payment, which is irreversible, so everything after this point retries rather than rolls back."

A common first-job mistake is treating the pivot as always being the payment step. The pivot is wherever the cost of undoing exceeds the cost of retrying forward. For a freight booking system, the pivot might be when a truck is dispatched. For a hotel booking, it might be when the check-in window opens.

### Senior @ FAANG: Platform Architecture Implications of Each Saga Variant

The architecture diagram captures three saga variants, but it does not capture the organizational implications of choosing each one. At FAANG scale those implications dominate the technical trade-offs.

**Choreography at scale:** The diagram's "loose coupling, no SPOF" benefit is real at the service level but misleading at the platform level. With 30 teams each publishing events, the implicit saga flow exists only in documentation and institutional memory. Staff engineers who have run large choreography-based systems describe the debugging problem as "event archaeology": given a failed order saga correlation ID, you must trace the event chain across six Kafka topics spanning four teams' consumer groups to understand what happened and where compensation fired. This is operationally untenable without tooling. FAANG teams that use choreography mandate a saga-correlation service that subscribes to all relevant topics and reconstructs the full saga timeline into a queryable store.

**Orchestration SPOF mitigation:** The diagram correctly notes that the orchestrator is a single point of failure. At FAANG scale the mitigation is not just HA deployment. It is: (1) the orchestrator must write saga state transactionally before sending any command, (2) each orchestrator instance must compete for saga ownership using a distributed lock with automatic expiry, (3) a separate recovery worker queries for sagas whose lock has expired and re-acquires them. This is essentially what Temporal implements internally. Understanding this at the mechanism level is the difference between deploying Temporal correctly and deploying it incorrectly (for example, running only one worker pod and calling it "HA").

**Temporal's architecture in the diagram:** The history service stores the full event log for every workflow execution. This is the mechanism behind crash recovery and deterministic replay. Staff engineers who evaluate Temporal for their platform need to understand that the history service is the performance bottleneck for high-volume, short-lived workflows: each workflow event is a Cassandra write and a gRPC round trip. For sagas running at 50,000 per second (realistic for a large e-commerce checkout), you need multiple Temporal namespaces, careful task queue partitioning, and activity worker scaling that matches the throughput of each step independently rather than treating all activities as identical.

**Compensation strategy selection is a product decision:** The three compensation strategies in the diagram (backward, forward, pivot) look like engineering choices. At the senior level they are product decisions. "Who decides whether a failed payment triggers backward compensation or forward recovery?" should have a written answer in a runbook, not an implicit default in the code. Forward recovery means the customer waits while you retry. Backward recovery means the customer sees a failure and must restart. The product team should make this choice with awareness of the user experience trade-off.

---
