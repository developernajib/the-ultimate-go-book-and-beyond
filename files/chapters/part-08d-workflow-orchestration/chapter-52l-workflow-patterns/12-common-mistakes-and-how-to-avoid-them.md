## Common Mistakes and How to Avoid Them

These are the most frequent issues encountered when building Temporal workflows in production. Most stem from violating the determinism constraint or from misunderstanding how Temporal replays workflow history.

| Mistake | Problem | Solution |
|---------|---------|----------|
| Non-deterministic code in workflows | Workflow replay fails with different results | Never use `time.Now()`, `rand`, goroutines, or I/O directly in workflow code |
| Missing compensation on all failure paths | Partial state left behind on errors | Use `CompensationTree` - add compensation immediately after each successful step |
| Not using `GetVersion` for workflow changes | In-flight workflows break on redeploy | Use `workflow.GetVersion()` for every change that affects execution path |
| Overly large workflow inputs | Serialization overhead, context limits | Pass IDs, not full objects, and fetch data in activities |
| Blocking activities without heartbeat | Long-running activities silently fail | Heartbeat every 30s in activities longer than 1 minute |
| Spawning thousands of child workflows at once | Temporal cluster overload | Use concurrency-controlled fan-out with `workflow.NewSelector` |
| Signals lost before workflow starts | Race condition on workflow start | Use `workflow.GetSignalChannel` at workflow start, or use `SignalWithStart` client API |
| Ignoring activity idempotency | Double-execution causes duplicate side effects | Design activities as idempotent and use idempotency keys in external APIs |
| Testing with real Temporal | Flaky, slow tests | Use `testsuite.TestWorkflowEnvironment` for all unit tests |
| Workflow history growth | Performance degradation | Use `workflow.ContinueAsNew` for workflows with unbounded loops |

### Junior → FAANG: Internalizing These as First-Job Habits

Each mistake in the table above is learnable from a list, but it only sticks when you have seen it fail. Build these into your code review habit before your first production incident.

**The non-determinism check is a code review gate.** When reviewing a workflow, scan every line for: `time.Now()` (use `workflow.Now()`), `rand.Float64()` (pre-generate in an activity), goroutines (use `workflow.Go` coroutines), file or network I/O (move to an activity), and any dependency on a global variable that might change between executions. If you see any of these in workflow code, flag it before merge. Non-determinism bugs do not show up in tests. They show up after a worker restart in production.

**Register compensation immediately, not at the end.** The correct pattern is: step succeeds, add compensation, move to next step. Not: all steps run, then register compensations. Code reviews should verify that every `workflow.ExecuteActivity` call for a compensatable step is immediately followed by a `compensations.AddCompensation` call.

**Heartbeat length is not the same as activity timeout.** A common confusion: setting `StartToCloseTimeout` to 10 minutes and assuming the activity will not be retimed out before then. If `HeartbeatTimeout` is set to 30 seconds and the activity does not heartbeat, it is timed out after 30 seconds regardless of the start-to-close setting. Always set both values and ensure heartbeat calls are at the correct interval.

**`workflow.GetVersion` at every behavioral change, no exceptions.** If there is doubt about whether a change is behavioral, add the gate. The cost of an unnecessary gate is one extra line in the history. The cost of a missing gate is a production incident. Default to gating.

**Write the test before the workflow code.** The test suite above was written to match the workflow implementations. In practice, write the test signatures first (mocked activities, expected outcomes), then implement the workflow to make them pass. The test forces you to enumerate failure cases that you might otherwise skip during implementation.

### Senior @ FAANG: Mistake Prevention at the Platform Level

Individual mistakes are prevented by code review and testing discipline. Platform-level prevention requires systematic controls that catch entire categories of mistakes before they reach production.

**Static analysis for workflow non-determinism.** The most impactful platform investment for non-determinism prevention is a static analysis tool (linter) that detects non-deterministic patterns in workflow code. Go's analysis framework allows writing custom analyzers that check: usage of `time.Now` without the `workflow.` prefix, usage of `math/rand` outside of activities, goroutine creation (`go func()`) outside of `workflow.Go`, and imports of packages that perform I/O (net/http, os). A linter that catches these at CI time removes an entire class of production incidents. This tool is a platform team deliverable, not a per-team responsibility.

**Compensation coverage as a required test metric.** Every workflow with a saga compensation tree must have a test that exercises the compensation path for each step. A platform requirement can enforce this: the CI pipeline checks that for every `AddCompensation` call in the workflow code, there is a corresponding test that mocks the triggering failure and asserts the compensation activity is called. This is a custom test coverage metric, not a line-coverage metric.

**History size monitoring in staging.** Many history-growth problems (unbounded loops, missing `ContinueAsNew`, excessive fan-out) are detectable in staging before they affect production. The platform CI pipeline can include a workflow history size assertion: run the workflow against a representative input in the staging Temporal cluster, query the resulting history event count, and fail the build if it exceeds a configurable threshold (e.g., 5,000 events for a single execution). This catches the "we spawned 10,000 activities in one workflow" class of mistake automatically.

**`GetVersion` gate deletion pipeline.** The versioning mistake category (not using `GetVersion`, or not cleaning up old gates) is addressable with a scheduled gate cleanup pipeline. The pipeline queries the Temporal cluster for running executions at each version, emits a metric (how many executions are still at each version), and generates a report of gates that are safe to delete. Teams review this report as part of their sprint cycle. This turns gate hygiene from an ad-hoc activity into a systematic process.

**Idempotency contract as a service requirement.** The mistake of ignoring activity idempotency is preventable by making idempotency a first-class service contract requirement. The service registry for each activity includes: "Is this activity idempotent? What is the idempotency scope (key, time window)? What are the deduplication semantics?" Activities that are not idempotent are flagged and require explicit documentation of the failure mode and acceptable risk. This makes the implicit contract explicit and auditable.

**The on-call runbook for each mistake category.** Each mistake category in the table has an associated on-call runbook: what symptoms appear (nondeterminism errors, stuck workflows, duplicate side effects), what diagnostic commands to run, and what remediations are available (rollback, version gate addition, manual workflow reset). Publishing these runbooks and including them in on-call training reduces the time-to-recovery for the inevitable incident.

---
