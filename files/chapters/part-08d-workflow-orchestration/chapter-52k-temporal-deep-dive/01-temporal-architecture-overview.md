## Temporal Architecture Overview

Temporal separates workflow execution state from worker compute. The server cluster stores all workflow history durably while workers poll for tasks and execute activities in their own processes. The following diagram maps the relationships between the Temporal server components and Go SDK workers.

```
┌────────────────────────────────────────────────────────────────────┐
│                        Temporal Cluster                            │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────────┐   │
│  │ Frontend Svc │   │  History Svc │   │  Matching Svc         │   │
│  │ (gRPC API)   │   │ (durability) │   │  (task queue routing) │   │
│  └──────┬───────┘   └──────┬───────┘   └──────────┬────────────┘   │
│         │                  │                       │               │
│  ┌──────▼──────────────────▼───────────────────────▼────────────┐  │
│  │                  Persistence (Cassandra / PostgreSQL)         │ │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
         ▲                                      ▲
         │ gRPC                                 │ gRPC
   ┌─────┴────────┐                    ┌────────┴──────┐
   │   Client     │                    │    Worker     │
   │  (start/query│                    │  (polls tasks)│
   │   workflow)  │                    │  Activities   │
   └──────────────┘                    │  Workflows    │
                                       └───────────────┘

Execution Model:
1. Client starts workflow execution (returns a handle immediately)
2. Temporal persists workflow state durably
3. Worker polls task queue, picks up workflow task
4. Workflow code runs deterministically; activity calls are recorded
5. On crash/restart, Temporal replays history to restore state
6. Activities execute on workers, results stored in history
7. Workflow completes when last step returns
```

The **Frontend Service** handles all gRPC calls from clients and workers. The **History Service** owns the workflow state - it persists events, manages timers, and drives workflow task scheduling. The **Matching Service** routes tasks to workers by matching task queue names to registered pollers. All three services are backed by a persistence layer (Cassandra, PostgreSQL, or MySQL).

Workers are stateless. If a worker crashes, the Temporal server detects the missed heartbeat or task timeout and reschedules the work on another available worker. This separation of state (server) from compute (worker) is what makes the system fault-tolerant.

### Junior -> FAANG: Reading the Architecture Before Writing Code

The most common beginner mistake with Temporal is treating the worker process like an application server that owns state. The architecture diagram makes the correct mental model explicit: state lives in the Temporal cluster, compute lives in the worker. Internalizing this prevents a class of errors where developers store critical data in worker-local variables expecting it to survive restarts.

Worked example: suppose you write a workflow that accumulates results in a package-level slice. The first execution populates the slice. The worker restarts. On replay, the workflow runs again and the slice starts empty. The replay diverges from the original history. This is a nondeterminism error and the workflow panics. The fix is that all accumulated state must flow through activity return values recorded in history, or through signals/updates that are also recorded.

Know the three server components by name and function before your FAANG phone screen. Interviewers use them to probe your depth. Frontend is the gRPC gateway. History owns the event log and timer scheduling. Matching routes tasks to pollers by task-queue name. If the Matching service is slow, task-queue latency rises even when workers are idle, because task dispatch goes through Matching. That is a non-obvious failure mode worth memorizing.

First-job habit: when a workflow is stuck, your first diagnostic step is to look at the task-queue poller count in the Temporal Web UI. Zero pollers means workers are not running. That eliminates the server-side components immediately.

### Senior @ FAANG: Cluster Topology as an Operational Decision

The architecture diagram describes a single-cluster deployment. Production systems at FAANG scale introduce multi-region, multi-cluster, and Temporal Cloud topologies, each with different failure domains and operational responsibilities.

**History service sharding.** The History service shards workflow executions across its instances by workflow ID. A poorly distributed workflow ID space (all IDs with the same prefix) causes hot shards. The Temporal server hashes workflow IDs, so normally distribution is even. But applications that use a monotonically incrementing integer as a workflow ID prefix (e.g., `order-0001`, `order-0002`) get even distribution automatically because the hash spreads them. Applications that hash an external ID before using it as a workflow ID prefix risk creating hot shards if the external IDs cluster. Test with a realistic ID distribution during load testing.

**Persistence layer choice.** Cassandra provides linear write scalability but requires careful tuning of compaction and read-repair strategies. PostgreSQL is operationally simpler but has a write bottleneck around the History service's workflow task table. Most teams starting fresh choose PostgreSQL (or MySQL) up to roughly 10k concurrent workflows, then evaluate Cassandra. Temporal Cloud abstracts this entirely at the cost of per-action pricing.

**Cross-cluster routing and Temporal's multi-cluster replication.** Temporal supports asynchronous multi-cluster replication for active-passive failover. Workflow history replicates from a primary to a standby cluster with some replication lag. Failover promotes the standby to primary. Workflows that were in-flight at failover time replay from the last replicated history event, which may be seconds behind the actual last event. Activities that completed after the replication lag window will be re-executed on failover. Designing activities to be idempotent is therefore not optional in a multi-cluster setup.

**Worker fleet sizing.** The `MaxConcurrentActivityExecutionSize` and `MaxConcurrentWorkflowTaskExecutionSize` settings on the worker are the primary capacity levers. A staff-level design doc should derive these from activity memory footprint and CPU profile, not from default values. A worker running 100 concurrent HTTP-call activities at 5MB response payload each holds 500MB in-flight. Container memory limits must account for that headroom plus the base worker process memory. The correct pattern is to profile one activity execution, multiply by the concurrency target, and add 20% overhead.

**Namespace-level quotas at scale.** Temporal Cloud and self-hosted Temporal both enforce per-namespace rate limits on workflow start rate, signal rate, and visibility query rate. A platform team that provisions one namespace per team can apply differential quotas: high-volume order processing gets a higher start rate than low-volume admin workflows. Quota exhaustion is surfaced as gRPC `ResourceExhausted` errors on the client. Platform engineers must expose namespace quota utilization as a first-class metric and alert before saturation, not after.

---
