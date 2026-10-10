## Summary

Temporal provides durable execution for Go programs, replacing ad-hoc job queues and state machines with a single programming model:

- **Execution model**: Workflows are deterministic Go functions. Every state transition (activity completion, timer fire, signal receipt) is durably persisted in an event history. On crash, Temporal replays history to reconstruct in-memory state. From the workflow's perspective, crashes never happened.

- **Activities**: All non-deterministic side effects live in activities - HTTP calls, database writes, third-party APIs. Activities have configurable `RetryPolicy` with `NonRetryableErrorTypes` for business errors that should not be retried. Long-running activities must heartbeat with `activity.RecordHeartbeat(ctx, progress)` - the progress is preserved across retries.

- **Signals and queries**: Signals (fire-and-forget) inject external events into running workflows. Queries (read-only) inspect workflow state without interrupting execution. `workflow.NewSelector` handles multiple concurrent signal channels without deadlocks.

- **Updates**: The Update primitive combines signal semantics (modify state) with query semantics (return a response) in a single synchronous call. Validators reject illegal updates before any state changes are made.

- **Saga pattern**: Workflows track which steps completed in a slice. On failure, compensating activities run in reverse order with aggressive retries. Temporal's durability eliminates the "lost compensation" problem - the compensation list survives crashes.

- **Versioning**: `workflow.GetVersion(ctx, changeID, minSupported, maxSupported)` creates safe code branching points. Old in-flight executions replay with the version recorded in their history. New executions use the new code path. Never remove version gates while old executions exist.

- **Testing**: `testsuite.NewTestWorkflowEnvironment` runs workflow code synchronously with mocked activities and time. `RegisterDelayedCallback` fires at precise simulated times to test timers. `OnActivity` stubs return predetermined results.

- **Worker tuning**: `MaxConcurrentActivityExecutionSize` is the primary knob. Set it based on available memory per activity. `WorkerStopTimeout` must be ≥ the longest expected activity duration for graceful shutdown.

- **Search attributes**: Custom indexed fields on workflow executions. Register with `temporal search-attribute create --name <key> --type <type>` (or legacy `tctl namespace update --search_attr_key`) then `UpsertSearchAttributes` in workflow code. Query running workflows by customer ID, status, value, or any custom field.

- **Observability**: Temporal SDK auto-exports Prometheus metrics via tally. Monitor `task_schedule_to_start` latency (backlog detector) and `worker_task_slots_available` (capacity detector). Use the Temporal Web UI for event history inspection and stuck workflow diagnosis.

- **Temporal vs job queues**: Job queues execute isolated tasks with retry. Temporal orchestrates multi-step processes with durable state, long timers, fan-out/fan-in, compensation, and human-in-the-loop workflows - without external state management.

### Junior -> FAANG: What to Carry Out of This Chapter

The chapter covers a large surface area. The items that pay dividends in a first job and in FAANG interviews are a focused subset.

Own these deeply: the event-history replay model (Q1 in the interview section is foundational), the determinism rules (what is forbidden in workflow code and why), activity retry policy design (especially `NonRetryableErrorTypes`), and the saga compensation pattern with its reversal order. These four topics cover the majority of practical Temporal work and the majority of interview coverage.

Understand these well enough to use: signals and queries (know which is fire-and-forget and which is synchronous read), `workflow.GetVersion` (know when to add it and the three rules for lifecycle management), `WorkerStopTimeout` (know why it must match the longest activity), and heartbeating with checkpointing (know how `GetHeartbeatDetails` enables resume-on-retry).

Aware of but not required to master immediately: Updates, Worker Versioning, Temporal Schedules, and multi-region replication. These are senior-track topics that become relevant after your first few months of production Temporal experience.

The single most important first-job habit: before every PR that touches a workflow function, ask whether the change affects the replay path. If it adds, removes, or reorders any blocking operation (activity call, timer, signal receive), wrap it in a `GetVersion` gate or discuss with the team why it is safe not to.

### Senior @ FAANG: Platform Maturity and the Long-Term Arc of Temporal Adoption

The summary above describes what Temporal does. The senior track is about what Temporal enables organizationally and where adoption goes wrong at scale.

**The adoption arc.** Most teams start Temporal with one use case (the order saga, the approval workflow) and expand from there. The first year is productive because the team is small and the constraints (determinism, versioning, heartbeating) are learned by the founding engineers. The second year introduces organizational scaling challenges: new engineers join who have not internalized the determinism model, new teams start workflows without consistent naming or search attribute conventions, and the version gate backlog grows. The staff-level responsibility at year two is to build the platform infrastructure that makes the correct behavior the default: a shared client library that configures metrics and tracing, a linter that enforces the determinism rules, a Golden Path template that includes correct timeout and retry defaults, and a code review checklist for workflow changes.

**The "Temporal tax" conversation.** At scale, teams push back on Temporal's operational overhead: the determinism constraints slow down feature development, version gates accumulate, and the testsuite abstractions require learning before they are productive. A staff engineer needs to be able to quantify the value of the durability guarantee against this cost. The right frame: Temporal's value is in eliminating classes of production incidents (lost compensations, partial failures without cleanup, crashed job runners that lose state). Quantify the incident cost before Temporal in engineering hours and customer impact, and compare it to the ongoing Temporal development overhead. For workflows that span multiple services and require compensation, the math almost always favors Temporal.

**Evaluating Temporal Cloud vs self-hosted.** The decision is not purely technical. Temporal Cloud eliminates cluster operations but introduces a per-action cost model that must be forecast against workflow volume. Self-hosted Temporal gives full control but requires a dedicated platform team to operate Cassandra or Postgres, tune the History service, and manage Elasticsearch for advanced visibility. The crossover point depends on the ratio of platform engineering capacity to workflow volume. Teams with fewer than three platform engineers should default to Temporal Cloud until they have the operational capacity to run a stateful distributed system reliably. Teams above 500k workflow actions per day should model the cost crossover carefully before committing to either option.

**Long-term: Temporal as a platform primitive.** At FAANG scale, Temporal becomes a platform-level primitive like a message queue or a distributed cache: it is provisioned centrally, accessed through a shared client library, and governed by a platform team. The platform team owns namespace provisioning, quota management, operational alerting, and the shared client library. Product teams own their workflows, activities, and task-queue design. This separation of concerns enables Temporal adoption to scale across hundreds of teams without the platform becoming a bottleneck.

The final bar-raiser signal: a staff or principal engineer candidate should be able to draw the boundary between platform responsibility and product team responsibility in a Temporal deployment, explain the governance mechanisms at each boundary (namespace isolation, quota limits, version gate review, search attribute registration), and describe the operational runbooks that make the platform self-service for product teams. That level of systems thinking separates L6 from L7 in distributed systems platform roles.
