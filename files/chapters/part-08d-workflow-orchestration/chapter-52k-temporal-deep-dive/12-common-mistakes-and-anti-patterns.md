## Common Mistakes and Anti-Patterns

| Mistake | Problem | Fix |
|---------|---------|-----|
| Non-deterministic workflow code | Replay diverges: workflow panics | Never use `rand`, `time.Now()`, goroutines, maps in workflows |
| Side effects in workflow code | Re-executed on replay, causes double mutations | Move ALL side effects into activities |
| Missing heartbeat in long activities | Activity times out, Temporal cancels it | Call `activity.RecordHeartbeat(ctx, progress)` every 30-60s |
| Workflow ID not deterministic | Multiple executions for same business entity | Use `"order-" + orderID` as workflow ID |
| Over-broad retry policy | Business errors are retried infinitely | Set `NonRetryableErrorTypes` for non-transient errors |
| No version gating | Old in-flight workflows break on code change | Always use `workflow.GetVersion()` for code changes |
| Testing with mocked time | Tests don't cover timer logic | Use `env.SetTestTimeout()` and `env.RegisterDelayedCallback` |
| Blocking on channels without selector | Deadlocks in complex signal handling | Use `workflow.NewSelector` for multiple channel waits |
| Using Updates without validators | Illegal state accepted | Always register a Validator on UpdateHandlerOptions |
| Worker MaxConcurrency too high | Worker OOM kills, Temporal retries | Profile memory per activity, set MaxConcurrent conservatively |
| Not draining worker on shutdown | In-flight activities dropped, retried elsewhere | Set WorkerStopTimeout ≥ longest activity runtime |

### Junior -> FAANG: Mistakes That Kill Workflows in Production

The most dangerous mistakes in this table are the ones that are invisible in development and only surface under production conditions. Non-deterministic workflow code is the classic example: using `time.Now()` or `rand` in a workflow function works fine on the first execution, but crashes on replay after a worker restart. You will not see the crash in local testing because workers rarely restart in development.

The "over-broad retry policy" mistake is subtle. The code compiles and tests pass. The problem only becomes visible when a permanent business error (card declined, product not found) retries three times against the payment service, either creating duplicate charge attempts or hammering an already-stressed external API. Always set `NonRetryableErrorTypes` for any error type that is permanent by nature.

Worked example for the interview: a workflow ID that is not deterministic (using a UUID generated at call time rather than derived from the business entity ID) means that if the client retries the workflow start call after a timeout, it creates a second execution for the same business entity. Two parallel executions for the same order both charge the customer and both create shipments. Deterministic workflow IDs make the start call idempotent.

First-job habit: audit every workflow function for the word "time.Now", "rand.", and "http." before the code review. Any of those three in workflow code is a bug.

### Senior @ FAANG: Anti-Pattern Root Causes and Systemic Prevention

**Why non-determinism errors cluster in new teams.** The determinism constraint is invisible until replay happens. Replay happens when a worker restarts, which in local development almost never happens. In production, workers restart on deploys, node preemptions, and OOM kills. A team that ships to production for the first time often sees a flood of nondeterminism panics on the first deploy because their workers restarted and replayed workflow code that contains `time.Now()` or direct HTTP calls. The fix is to enforce the constraint in code review before it reaches production: add a linter rule (or at minimum a checklist item) that rejects workflow functions using the standard library time, rand, or net/http packages directly.

**The "side effects in workflow code" mistake at scale.** This mistake often manifests as a workflow that works correctly for weeks and then silently starts producing duplicate database writes or duplicate external API calls after a production incident forces a worker restart. The root cause: a developer moved a database call out of an activity and into the workflow function for "convenience" because the call was read-only at the time. Later, the call was changed to an upsert. The duplicate write on replay is now a correctness bug. The systemic prevention: enforce at code review that workflow functions may only call `workflow.*` SDK functions and call other functions that are pure (no I/O). Any function that could possibly reach outside the process belongs in an activity.

**Compensation retry exhaustion as a pager event.** The common anti-pattern is setting the same retry policy for forward activities and compensations. Forward activities can afford to fail after a few retries: the workflow handles the failure by running compensations. But compensations that fail after a few retries leave the system in an inconsistent state with no further automated recovery. The correct policy: compensations have a much higher retry count (10-20) and a longer maximum interval. When compensation retries are exhausted, the workflow must not silently fail. It must transition to a "compensation_failed" state that triggers a pager alert and waits for a human-confirmation signal before terminating.

**Worker MaxConcurrency set too high as a latent OOM bomb.** This anti-pattern is common in teams that set concurrency to "match the number of CPUs" without measuring actual activity memory usage. The OOM kill happens under load: activities are small in isolation but accumulate when 100 are running simultaneously. The OOM kill causes all in-flight activities to retry on other workers, which may themselves be at capacity, causing a cascade. The systemic prevention: load test the worker at the target concurrency level in a staging environment with realistic activity payloads before setting the production concurrency limit. Instrument worker container memory usage with a Prometheus alert at 80% of the container limit.

**Version gate accumulation as technical debt.** After months of development, a workflow function can accumulate a dozen `GetVersion` calls. The workflow code becomes difficult to read and reason about because every decision point is guarded by a version check. The systemic prevention: track active `GetVersion` gates in the codebase with a comment indicating the deployment version when the gate was added and when it can be removed. A weekly CI job queries for running workflow executions that predate each gate's deployment time. When that count reaches zero, the gate is eligible for removal. Make gate removal a first-class engineering task, not an afterthought.

---
