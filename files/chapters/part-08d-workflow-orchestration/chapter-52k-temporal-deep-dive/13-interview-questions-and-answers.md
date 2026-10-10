## Interview Questions and Answers

### Q1: How does Temporal guarantee workflow durability across crashes?

**What FAANG expects:** Name the mechanism (event-sourced history + deterministic replay), show you understand *why* the workflow function must be deterministic, and call out the failure mode ("nondeterminism error" panic) with at least two concrete Go footguns. Bonus for naming the three server components (Frontend, History, Matching) and the persistence layer.

**Answer:** Temporal persists every workflow decision (activity scheduled, timer started, signal received) to its event history in Cassandra/PostgreSQL/MySQL before dispatching the next task to the worker. On crash, the server ships the full history to a fresh worker and replays it through the workflow code to reconstruct in-memory state. The workflow function is deterministic: given the same sequence of events, it produces the same decisions at the same positions. Non-deterministic operations (random, `time.Now()`, goroutines, Go map iteration, direct I/O) are forbidden in workflow code because replay would diverge, producing a nondeterminism error.

**Follow-ups:**
- *Where does the determinism boundary actually live?* In the workflow function only. Activities run with full I/O freedom. The rule is: anything non-deterministic must be inside an activity (persisted result) or a `workflow.SideEffect` (also persisted).
- *What happens if the server persists an event but the worker never acknowledged it?* The next task will include the event. Idempotency of activities is your responsibility since activities may be retried after a "successful" execution the server never recorded.
- *Can you rebuild history from logs or an external store?* No, history *is* the source of truth and lives in the Temporal persistence layer. Back up Cassandra/Postgres like any other primary datastore.

### Q2: What is the difference between workflow timeout and activity timeout?

**What FAANG expects:** Name all six timeouts and explain which one you reach for first. Most production Temporal users set `StartToCloseTimeout` (required, no default) and leave the rest at zero or workflow-scoped defaults. Bonus for calling out `ScheduleToStartTimeout` as a worker-pool saturation signal, and `HeartbeatTimeout` as the stuck-worker detector for long activities.

**Answer:** Temporal defines six timeout types across two levels.

**Workflow-level:**
- `WorkflowExecutionTimeout` caps the entire workflow including all Continue-As-New runs.
- `WorkflowRunTimeout` caps a single run (a new run after Continue-As-New resets it).
- `WorkflowTaskTimeout` caps a single workflow task (the worker must return decisions within it, default 10s).

**Activity-level:**
- `StartToCloseTimeout` caps a single activity execution attempt (most commonly set, required).
- `ScheduleToCloseTimeout` caps total time including all retries and scheduling delays.
- `ScheduleToStartTimeout` caps the wait between scheduling and worker pickup. If this fires, the worker pool for that task queue is saturated.
- `HeartbeatTimeout` triggers when a long-running activity stops heartbeating, detecting stuck or dead workers.

**Follow-ups:**
- *Which timeout fires first if you set all of them?* Whichever is most restrictive for the current phase. `ScheduleToStartTimeout` can fire before the activity even starts. `StartToCloseTimeout` caps the execution phase specifically.
- *What is the right default for a short activity?* `StartToCloseTimeout` equal to p99 latency + buffer. Skip `ScheduleToCloseTimeout` unless you want a hard retry ceiling.
- *Why heartbeat at all?* The server cannot distinguish a slow activity from a dead worker without a liveness signal. Heartbeating also checkpoints progress, so retries can resume instead of restarting.

### Q3: Explain the Saga pattern and how Temporal simplifies its implementation.

**What FAANG expects:** Define Saga (local transactions + compensations), give the textbook example (book flight, book hotel, charge card), explain why orchestration without Temporal requires a state machine plus crash-safe compensation bookkeeping, and then show how durable execution collapses that into a sequential Go function with `defer` style compensation. Bonus for noting that compensations have their own retry policies and are also activities.

**Answer:** A Saga is a sequence of local transactions where each step has a compensating transaction that undoes its effect. If step N fails, the saga runs compensations for steps N-1 through 1 in reverse. Without an orchestration framework, you need a state machine to track which steps completed, crash-safe persistence of that state, and code that handles compensation failures and retries.

Temporal removes this infrastructure. Workflow state is durable and survives crashes, so the completed-steps list is never lost. Each compensation activity has its own retry policy. The Go code reads as a sequential function that records compensations on success and runs them in reverse on failure. The workflow does not need a database for its own state management.

**Follow-ups:**
- *What if a compensation itself fails?* It retries per its own retry policy. If retries are exhausted, the workflow can either fail terminally (pager alert) or transition to a human-review state via a signal wait.
- *Orchestration vs choreography, when does Temporal lose?* Choreography (event-driven, no central coordinator) beats orchestration when you have many independent bounded contexts that should not know about one another. Temporal is the right choice when *one* business process owns the end-to-end outcome.
- *Saga vs 2PC?* 2PC requires a blocking coordinator and locks across services. Saga is async and non-blocking at the cost of compensation semantics (you are undoing, not rolling back). Almost all production distributed transactions are sagas now.

### Q4: What is the difference between a Signal, a Query, and an Update in Temporal?

**What FAANG expects:** Three primitives, their semantics, and when to pick which. Signals are fire-and-forget and buffer. Queries are synchronous reads and cannot mutate. updates (GA in Temporal Server 1.24, Nov 2024) are synchronous RPCs into the workflow with a validator and a return value. Bonus for calling out signal buffering while the workflow is sleeping.

**Answer:**
- **Signal:** Fire-and-forget message that modifies workflow state. The caller does not wait for the workflow to process it. Signals are buffered on the server if the workflow is between tasks. Use for: cancel requests, external events, approval decisions.
- **Query:** Read-only inspection of workflow state. The query function runs synchronously against current state and returns a result. No state changes allowed. Use for: "what is the current status of this order?"
- **Update:** Synchronous signal with a return value (GA in Temporal Server 1.24). The caller blocks until the workflow processes the update. Has a Validator function that can reject the update before any state changes. Use for: adding items to an in-flight order, approving with a result, interactive workflow interactions.

**Follow-ups:**
- *Why was Update added if signals + queries already existed?* Signal+query was the workaround: send signal, poll query. Update collapses that into one RPC with proper back-pressure and a validator-based reject path. It is strictly better for request/response interactions.
- *What happens to a signal sent while the workflow is sleeping for 30 days?* Buffered on the server. When the sleep ends or the workflow otherwise resumes, it processes the buffered signal.
- *Can a query see uncommitted state?* A query runs on the cached workflow state after the last committed task. It cannot see mid-task state.

### Q5: How do you safely deploy a code change to a Temporal workflow that has in-flight executions?

**What FAANG expects:** `workflow.GetVersion` as the primary tool, plus the rule that deterministic history must still replay for old executions. Bonus for explaining the "patching"/versioning lifecycle (add gate, wait for old executions to drain, remove gate) and for mentioning Worker Versioning / Build IDs as the server-side alternative that routes specific executions to specific worker builds.

**Answer:** Use `workflow.GetVersion(ctx, changeID, minSupported, maxSupported)`. On first execution, this returns `maxSupported` and records the version in history. On replay, it returns the version recorded at that point. This creates branching points: old executions take the old path, new executions take the new path.

```go
v := workflow.GetVersion(ctx, "add-audit-step", workflow.DefaultVersion, 1)
if v >= 1 {
    workflow.ExecuteActivity(ctx, auditOpts, "AuditOrder", orderID)
}
```

Rules: (1) never remove a `GetVersion` call while old executions still exist, (2) use unique change IDs per logical change, (3) after all old executions complete, you can remove the gate.

**Follow-ups:**
- *What is Worker Versioning and when do you pick it over `GetVersion`?* Worker Versioning assigns a Build ID to workers and routes executions to compatible versions. It lives at the deployment layer instead of the code layer. Prefer it for large fleets where code-level gates would pile up.
- *How do you know when it is safe to remove a gate?* Query for running executions on that workflow type. Zero running plus zero opened-recently means you can delete the gate on the next deploy.
- *What breaks if you just push a new version without a gate?* Replay of in-flight executions diverges at the first differing decision, raising a nondeterminism error. The workflow is then stuck until you roll back or add a gate.

### Q6: Why must workflow code be deterministic, and what common Go patterns violate this?

**What FAANG expects:** Replay divergence causes nondeterminism panics. Be ready to enumerate the concrete Go patterns that break it and the Temporal-safe replacement for each. Bonus for knowing that map iteration order changed in Go 1.12 specifically to catch code that relied on the old order, which also helps Temporal workflow determinism audits.

**Answer:** Temporal reconstructs state by replaying event history through the workflow function. If replay produces different decisions than the original run, the server raises a nondeterminism error and halts the workflow. Common violations in Go:

1. **`time.Now()`** returns different values on replay. Use `workflow.Now(ctx)`.
2. **`math/rand` / `crypto/rand`** vary between runs. Use `workflow.SideEffect` or a dedicated activity.
3. **Map iteration order** is randomized per run. Sort keys before iterating.
4. **Native goroutines** have non-deterministic scheduling. Use `workflow.Go`, which is coroutine-based and deterministic.
5. **`http.Get`, DB calls, file I/O** must live in activities, never in workflow code.
6. **Global mutable state** differs between replay and original. All state must flow through workflow locals or activity returns.

**Follow-ups:**
- *How do you test for nondeterminism before production?* The test framework's replay tests (`WorkflowReplayer`) take a history file and re-run it through current workflow code. Golden histories in CI catch accidental breaks.
- *Is `workflow.SideEffect` the same as an activity?* No. `SideEffect` runs in the workflow worker, result is recorded to history, no retries, no timeouts. Cheaper than activities for "record this local computation" cases like generating a UUID.
- *What about `context.Context` deadlines inside a workflow?* Safe because they come from `workflow.Context`, which is deterministic. Never mix in a `context.Background` from outside.

### Q7: How does Temporal compare to a job queue like Redis/BullMQ, Celery, or River?

**What FAANG expects:** Job queues are stateless per task and push orchestration back onto the caller. Temporal owns durable orchestration state end-to-end. Give the break-even point: if your workflow has one step and simple retry needs, a job queue is lighter. If it has multi-step fan-out, long waits, or compensation, Temporal pays for itself. Bonus for mentioning `riverqueue/river` (Go-native, Postgres-backed, 2024+) as the modern lightweight alternative.

**Answer:** Job queues execute single tasks asynchronously and retry on failure. They are stateless between retries: if a task needs to fan out to 50 subtasks and wait for all to finish, you build that orchestration yourself with database state.

Temporal provides durable orchestration: the workflow function retains in-memory state across crashes, timer events, and asynchronous waits. Fan-out/fan-in, long-running timers, saga compensation, and human-in-the-loop approval are built-in primitives.

Rule of thumb: use a job queue (`river`, asynq, Celery, BullMQ) for simple async tasks. Use Temporal when your process involves multiple steps, compensating transactions, long waits, or human approval.

**Follow-ups:**
- *What about just running a goroutine with retry?* Survives only the process lifetime. One deploy or crash and the work is lost. Acceptable for best-effort background tasks, not for anything the business cares about.
- *Could you build Temporal's guarantees on top of River?* You can build *some* of them (durability via Postgres) but not the coroutine-based deterministic replay model without replicating significant SDK machinery. At that point you are building Temporal.
- *When is Temporal the wrong choice?* Pure async work with no orchestration (send an email, process an image). Also CPU-bound batch work where event-sourcing overhead exceeds the value of durability.

### Q8: What is the maximum event history size and what happens when it is reached?


**What FAANG expects:** Know the default limits (warning at 10k events or 10MB, termination at 50k events or 50MB) and the remedy (Continue-As-New with the current state as the new input). Bonus for explaining why long-running workflows must *design* for Continue-As-New from day one, and for calling out the new `workflow.UpdateInfo` / history length accessors used to decide when to roll over.

**Answer:** Temporal's default warning kicks in around 10,000 events or 10MB of history. Workflows are terminated at 50,000 events or 50MB. The remedy is Continue-As-New: start a fresh workflow run with clean history while preserving the state you pass to the new run.

```go
func LongRunningWorkflow(ctx workflow.Context, state WorkflowState) error {
    for {
        var result BatchResult
        if err := workflow.ExecuteActivity(ctx, actOpts, "ProcessBatch", state.Cursor).Get(ctx, &result); err != nil {
            return err
        }
        state.Cursor = result.NextCursor
        state.ProcessedCount += result.Count

        info := workflow.GetInfo(ctx)
        if info.GetCurrentHistoryLength() > 40_000 {
            return workflow.NewContinueAsNewError(ctx, LongRunningWorkflow, state)
        }
        if result.Done {
            return nil
        }
    }
}
```

**Follow-ups:**
- *Why not just raise the limit?* Larger histories mean longer replay, more worker memory, and slower recovery. The 50k/50MB cap is a forcing function toward a better design.
- *What is lost across Continue-As-New?* The old run's signals buffered after the CAN call are delivered to the new run only if you carry them into the state. Same for open child workflows: they must be plumbed explicitly.
- *How does this interact with visibility?* Each CAN creates a new run with a new RunID. Search attributes carry over if you pass them in `ContinueAsNewOptions`. Dashboards counting "runs" will see an inflated number. Count by WorkflowID instead.

### Junior -> FAANG: How to Use These Q&A Pairs in Preparation

Each question in this section is designed to expose the reasoning FAANG interviewers actually want to see, not just a recitation of API documentation. The framing at the top of each question ("What FAANG expects") is the calibration signal. If your answer covers those points plus one follow-up, you are at the passing bar. If you cover all three follow-ups with concrete examples, you are above the bar.

The prerequisite gap for most candidates is depth on Q1 (durability) and Q6 (determinism). These two questions are the foundation. If you cannot explain event-sourced history and the replay model clearly, the other questions will not land well because they all build on that foundation.

Worked study approach: read each answer out loud as if you are on a phone screen. Then cover the answer and try to reconstruct it from the "What FAANG expects" framing alone. The follow-up questions are what separates a "hire" from a "strong hire": be ready to go one level deeper than the main answer on each one.

First-job interview tip: if you are asked a Temporal question you have not seen before, anchor your reasoning on the event-history model. Almost every Temporal behavior (retries, versioning, Continue-As-New, signals) can be explained by reasoning about what gets written to history and what happens during replay. That model is your foundation.

### Senior @ FAANG: Bar-Raiser Signals and L6/L7 Interview Framing

**What bar-raisers test that regular interviewers do not.** A bar-raiser interviewing for an L6 or L7 role expects you to reason about Temporal as a platform with organizational tradeoffs, not just as a technology with API semantics. The questions will shift from "how does X work" to "when would you not use Temporal", "how would you govern Temporal adoption across 20 teams", and "what would a production incident look like and how would you manage the response."

**The "when would you not use Temporal" framing.** The strongest L6 signal is articulating genuine tradeoffs without being defensive about the technology. Temporal is the wrong choice when: the workflow is a single activity with simple retry (use a job queue, the overhead is unnecessary), the team has no operational capacity to run a stateful distributed system (use Temporal Cloud or a managed alternative), the business logic changes too rapidly to manage version gates (consider a lower-ceremony orchestration approach), or the workflow volume is so low that the infrastructure cost is not justified. Candidates who can only argue for Temporal in all scenarios raise concerns about judgment.

**Governance Q&A at the staff level.** Be ready for: "How would you roll out Temporal across an organization that has 50 services?" The expected answer covers: phased adoption starting with the highest-complexity use cases, a Golden Path (shared client library, pre-configured metrics, task-queue naming convention), a namespace isolation strategy, a training program for determinism constraints, and an on-call integration that routes Temporal-specific alerts to a platform team rather than product teams. Candidates who can describe this rollout in terms of risk mitigation and operational maturity are at the L7 range.

**Incident management Q&A.** "Walk me through a Temporal production incident you would expect to see and how you would resolve it." Strong candidates describe a specific incident class (e.g., History service shard hotspot caused by a monotonically increasing workflow ID prefix), identify the root cause through metric analysis (schedule-to-start latency spike on a specific task queue correlated with History service CPU on specific shards), apply a targeted fix (change the workflow ID scheme to use a hash prefix), and implement a prevention mechanism (load testing with realistic workflow ID distributions before production). Incident management depth is a primary L6/L7 differentiator in distributed systems interviews.

---
