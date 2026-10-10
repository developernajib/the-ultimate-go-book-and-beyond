## Exercises

1. **Fan-Out with Partial Failure Handling**: Extend `DynamicFanOutWorkflow` to collect both successes and failures, returning a `PartialResult` struct. Ensure the workflow never fails entirely due to individual item failures.

2. **Saga with Retry Budgets**: Modify `TravelBookingSagaWorkflow` to track retry count per step and give up with compensation after 3 retries total (not per step).

3. **Multi-Tier Approval Escalation**: Extend `MultiLevelApprovalWorkflow` to dynamically determine approval levels from a database activity based on the request amount and category.

4. **Time-Based Batching**: Implement `AdaptiveBatchWorkflow` that collects items for up to 5 minutes OR 1000 items (whichever comes first), processing whichever condition triggers.

5. **Event-Driven Chaining**: Implement an `EventChainWorkflow` that processes a user lifecycle: signup → email verification → first purchase → loyalty tier upgrade. Each step triggers the next via signals.

6. **Zero-Downtime Workflow Migration**: Take an existing v1 workflow and add three feature increments using `GetVersion`, writing tests that verify each version produces the correct code path.

### Junior → FAANG: How to Approach These Exercises

These exercises are not solved by reading the chapter code and making small modifications. Each one requires you to make a design decision before writing a line. The design decision is the exercise.

**Exercise 1 (Partial failure fan-out).** The key decision is: what does `PartialResult` look like? Define the struct before writing the workflow code. The struct should contain separate slices for successes and failures, plus a method that returns whether the result meets an acceptable threshold. Writing the struct first forces you to think about how the caller will use the result, which is the correct design-first approach.

**Exercise 2 (Retry budgets in saga).** The challenge is tracking retry count across multiple activities within a single saga execution. The retry count is workflow state, not activity state. Store it in a variable alongside the `CompensationTree`. Increment it on each activity error. When it reaches 3, call `compensations.Compensate` regardless of which step failed. Verify this with a test that makes the first activity fail twice (transient) then succeed, and the third fail on the first try (total 3 retries), triggering compensation.

**Exercise 3 (Dynamic approval levels from a database).** The lookup activity must be idempotent: the same requester plus amount plus category must return the same approval chain on every call. Design the activity's database query to be read-only (no mutations), and consider caching the result in a workflow variable so subsequent replays do not re-query.

**Exercises 4 and 5** build on the windowed batch and event-driven patterns respectively. Write tests first. Define the assertion (what the workflow's behavior should be at the threshold and before the threshold) before writing the workflow code.

**Exercise 6 (Zero-downtime migration).** Before writing any code, draw the version gate diagram: three horizontal lines (one per feature increment), each with an old code path below and a new code path above. Write the test for each version boundary (v1 history replays correctly against v3 code) before adding the `GetVersion` gates. The test is the specification.

### Senior @ FAANG: Extending These Exercises to Staff-Level Concerns

Each exercise has a natural extension that lifts it from individual pattern implementation to platform-level design. Use these extensions for senior interview preparation or for designing production systems.

**Exercise 1 extended: partial failure as a platform contract.** Define the partial failure policy as a configurable parameter on the fan-out function, not as a hardcoded behavior. The parameter specifies the acceptable error rate (0.0 = fail on any error, 1.0 = best effort). Write a test that verifies the fail-fast behavior at 0.0 and the best-effort behavior at 1.0. Document in the function's GoDoc why the parameter exists and what each policy implies for the caller.

**Exercise 2 extended: retry budget registry.** Generalize the per-workflow retry budget into a retry budget registry that tracks budget across multiple workflow types for the same business transaction. If an order workflow and its child fulfillment workflow share a total retry budget of 5, the registry must be consulted before each retry across both workflows. This requires an activity-backed registry with atomic decrement semantics, implemented as an idempotent database update.

**Exercise 3 extended: approval routing governance.** The dynamic approval levels from a database must be version-controlled. A change to the approval routing rules must not affect in-progress approvals (a saga that started with 2-level approval must not suddenly require 3 levels mid-saga). Implement this by persisting the resolved approval chain at the start of the workflow as workflow state, and using the persisted chain rather than re-querying the database for each level. This is the correct pattern for any external configuration that must remain stable for the lifetime of a workflow execution.

**Exercise 6 extended: version gate lifecycle automation.** After implementing the three-increment migration, write a tool that queries the Temporal cluster for running executions at each version marker level and outputs a report: "N executions are still running at version 1, M at version 2, P at version 3." Schedule this tool as a daily report. Define the criteria for when each version gate is safe to delete (zero executions at that version for 7 consecutive days). This automation is the production companion to the `GetVersion` implementation.

---
