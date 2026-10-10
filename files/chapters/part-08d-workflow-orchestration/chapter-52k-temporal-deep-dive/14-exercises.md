## Exercises

These exercises require a running Temporal server. Use `docker compose up` with the official Temporal Docker Compose file to start a local cluster with the Web UI at `localhost:8080`.

1. **E-commerce Order Saga**: Build a complete order saga with 5 steps (inventory reservation, payment, shipping, loyalty points, confirmation), each with a compensation. Write tests for: happy path, failure at each step verifying correct compensations, and retry behavior for transient errors.

2. **Human-in-the-Loop Approval**: Build a loan application workflow that: starts pending approval, accepts an `approve` or `reject` signal with a reviewer ID, times out after 7 days if no decision, sends reminder signals at day 3 and day 6. Query the workflow for current status at any time.

3. **Cron Data Sync**: Implement a daily data synchronization workflow that reads from a Postgres table, transforms records, and writes to a data warehouse. Use heartbeating with row-number checkpoints to support resumption after crash.

4. **Versioned Workflow Migration**: Start 10 workflow executions using `OrderWorkflowV1`. Add a new step (audit logging) as `OrderWorkflowV2` using `GetVersion`. Verify that in-flight v1 workflows complete correctly while new executions use v2.

5. **Metrics and Alerting**: Add Prometheus metrics to the Temporal worker: workflow completion rate, activity error rate, task queue backlog (via Temporal's SDK metrics), and p99 workflow duration. Set up an alert for task queue backlog > 100 tasks.

### Junior -> FAANG: How to Approach These Exercises

These exercises are deliberately open-ended because real Temporal work requires design decisions, not just filling in code templates. Before writing any code for each exercise, write a brief design note: what workflow type will you use, what activities will you define, what retry policy makes sense for each activity, and what signals or queries will callers need.

Exercise 1 (order saga) is the most important for interview preparation. Work through it until you can explain the compensation chain for every failure scenario without looking at your code. Interviewers frequently ask "what happens if the payment succeeds but the shipment fails?" and expect you to walk through the compensation steps in order.

Exercise 2 (human-in-the-loop approval) teaches `workflow.NewSelector` and timer management. The 7-day timer combined with 3-day and 6-day reminder signals requires at least two nested selectors or a loop with decreasing timer intervals. Think through how the workflow state evolves at each signal point before coding.

For exercise 4 (versioned migration), use `docker compose up` to run a local Temporal server, start 10 v1 executions, keep them running while you deploy v2, and then verify that the v1 executions complete without nondeterminism errors. This is the closest you can get to a realistic production versioning scenario without a real production environment.

### Senior @ FAANG: Extended Exercises for Platform-Level Depth

**Exercise 6: Multi-tenant namespace isolation.** Design a Temporal namespace strategy for a SaaS platform with three tiers of customers: free (low priority, shared workers), pro (dedicated workers, higher concurrency), and enterprise (dedicated workers, dedicated namespace, custom retention). Implement the worker registration, task-queue routing, and client configuration for each tier. Add a priority-based routing mechanism that routes enterprise workflows to their dedicated task queue while free-tier workflows wait in a shared queue. Measure the latency difference between tiers under simulated load.

**Exercise 7: Workflow replay testing with golden histories.** Take a completed workflow execution from exercise 1 and save its event history as a JSON file using `temporal workflow show --workflow-id <id> --output json` (or legacy `tctl wf get-history --output json`). Write a replay test using `worker.WorkflowReplayer` that loads the golden history and replays it against the current workflow code. Now introduce a breaking change (remove one activity call), run the replay test, and confirm it catches the nondeterminism error. Add the replay test to the project's CI configuration so it runs on every pull request.

**Exercise 8: Temporal Schedules with overlap policy.** Rewrite exercise 3 (cron data sync) using the Temporal Schedules API instead of `CronSchedule`. Configure the overlap policy to `Skip` (do not start a new run if the previous is still running). Add a manual trigger that forces an immediate run regardless of the schedule. Implement a backfill operation that re-runs the sync for the previous 3 days. Verify that the schedule respects the overlap policy when the sync takes longer than its scheduled interval.

**Exercise 9: Multi-region failover simulation.** Set up two local Temporal clusters (using two separate Docker Compose environments on different ports). Configure asynchronous history replication by writing a simple replication script that exports history from cluster 1 and imports it to cluster 2 (simulating what Temporal's native replication does). Simulate a failover by stopping cluster 1 and starting workflows on cluster 2. Verify that workflows can resume from the last replicated history event. Document the data loss window (the gap between last replication and failover).

**Exercise 10: Custom data converter for PII compliance.** Implement a custom `DataConverter` for the Temporal SDK that encrypts activity input and output payloads containing PII fields (customer ID, payment info). The encryption key should be fetched from a mock key management service inside the converter. Verify that the Temporal Web UI shows encrypted payloads rather than plaintext. Test that replay works correctly when the decryption key is available on the worker but not in the Temporal server's persistence layer.

---
