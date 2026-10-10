## Interview Questions

### Q1: What is the difference between orchestration and choreography in workflow patterns?

**What FAANG expects:** Define both, give the canonical trade-off (visibility vs coupling), and name when each wins. Orchestration: central coordinator, end-to-end visibility, coupling in one place. Choreography: event-driven, loose coupling, harder to trace end-to-end. Bonus for citing the pragmatic hybrid: orchestrate within a bounded context, choreograph across bounded contexts.

**Answer:** Orchestration uses a central coordinator that explicitly directs each service, making the flow visible in one place. Temporal implements orchestration: the workflow function is the coordinator. Choreography uses events where each service reacts autonomously, no central driver. Choreography provides looser coupling but makes failure tracing and backpressure harder. Orchestration is preferable when you need compensation, end-to-end visibility, or complex branching. choreography wins when services are owned by different teams and the process is truly one-way.

**Follow-ups:**
- *How do you get end-to-end observability in a choreographed flow?* OpenTelemetry trace propagation on the event envelope, plus a reporting service that joins the trace spans. You are rebuilding orchestration at the observability layer.
- *Can you combine them?* Yes, and large systems do. Each bounded context orchestrates internally (Temporal, Saga) and publishes domain events for other contexts to choreograph on.
- *Which is cheaper to operate at 100 services?* Choreography, by far. No central coordinator becomes a scaling or reliability bottleneck. The cost is debugging.

### Q2: How does the saga pattern differ from distributed transactions (2PC)?

**What FAANG expects:** 2PC = blocking locks across participants, needs simultaneous availability, and chokes on coordinator failure. Saga = async, commit-as-you-go with compensating transactions, tolerates partial availability. Bonus for noting saga is *eventually consistent* with compensation windows where external observers can see intermediate states.

**Answer:** 2PC holds locks across all participants and requires simultaneous availability of every service plus the coordinator. Sagas use compensating transactions instead: each step commits immediately, and failures trigger reverse compensations. Sagas tolerate partial availability and scale horizontally, but require each activity to be idempotent and compensatable. In Temporal, the saga is orchestration-based: the workflow function drives forward steps and executes compensations on failure.

**Follow-ups:**
- *What does "compensation" even mean for a non-reversible action?* It is *semantic* undo, not transactional rollback. Sending an email cannot be undone. You send a correction email. Charging a card is compensated by a refund. Model the business intent, not the raw operation.
- *What happens when a compensation itself fails?* Retry per its own policy. If retries exhaust, the workflow goes to a human-review state via a signal wait. Do not silently drop.
- *When should you still pick 2PC?* Inside a single database that supports it (Postgres + XA) when the transactional cost is lower than implementing idempotent compensation. Almost never across services.

### Q3: When would you use `ContinueAsNew` vs parent/child workflows?

**What FAANG expects:** CAN = same workflow type, fresh history, sequential continuation. Child workflows = separate executions with independent history, parallel-capable, scoped failure domain. Bonus for recognizing that CAN loses open signals buffered after the decision (must carry state forward explicitly) and that child workflows let you version independently.

**Answer:** Use `ContinueAsNew` for long-running workflows with unbounded history (event-processing loops, indefinite pollers). It starts a new workflow run with a fresh history while preserving the workflow ID. Use parent/child workflows when you need parallel execution of independent work units, separate histories, independent versioning, or a scoped failure domain. Child workflows can run in parallel. CAN is sequential continuation.

**Follow-ups:**
- *What gets lost across Continue-As-New?* Signals received after the CAN call land in the new run, but any in-memory state not explicitly passed to the new run is gone. Plan the CAN payload carefully.
- *Can a child workflow outlive its parent?* Yes, set `ParentClosePolicy` to `ABANDON`. Useful for fan-out-and-forget patterns, dangerous for everything else because now the parent cannot signal the child.
- *How many child workflows is too many?* Fan-out to thousands is fine. Past ~10k, consider batching or a hierarchical orchestrator to keep parent history bounded.

### Q4: How do you handle workflow versioning without breaking in-flight executions?

**What FAANG expects:** `workflow.GetVersion` at each change point, never remove a gate while old executions exist, and unique change IDs per logical change. Bonus for mentioning Worker Versioning / Build IDs as the server-side alternative that routes executions to specific worker builds without code-level gates.

**Answer:** Use `workflow.GetVersion(ctx, changeID, minSupported, maxSupported)` at each branching point. On first execution, it returns `maxSupported` and records the version in history. On replay, it returns the version recorded at that point, so old executions continue taking the old path. Maintain backward compatibility across versions by inspecting the returned value. Never remove old code paths until all in-flight workflows at that version have completed.

**Follow-ups:**
- *What if you forget to gate a behavioral change?* Replay of in-flight executions diverges at the first differing decision, raising nondeterminism. The workflow is stuck until you roll back or add a gate.
- *When do you pick Worker Versioning over `GetVersion`?* For large fleets where code-level gates would pile up. Build IDs and compatibility sets keep the version logic at the deployment layer. Assign each deployment a Build ID, pin compatible sets, and the server routes accordingly.
- *How do you know an old gate is safe to delete?* Query for executions still pinned to that version. Zero running plus zero started-recently means the gate can go on the next deploy.

### Q5: What makes an activity idempotent, and why does it matter?

**What FAANG expects:** Definition (same inputs produce same observable result regardless of how many times you run it), the reason (Temporal retries on timeout so the server cannot always know if an earlier attempt actually succeeded), and the concrete patterns: idempotency keys, `ON CONFLICT DO NOTHING`, check-and-create, deterministic natural keys. Bonus for explaining the timeout-after-success footgun that makes idempotency non-negotiable.

**Answer:** An idempotent activity produces the same observable result when executed multiple times with the same inputs. This matters because Temporal retries on any failure mode it sees, including `StartToCloseTimeout` triggered on a request that actually succeeded downstream but whose response got lost. Patterns:

- **Idempotency keys** on external API calls (Stripe-style), the server dedupes on replay.
- **`ON CONFLICT DO NOTHING`** or UPSERT in database writes.
- **Check-and-create** pattern for creating external resources.
- **Natural keys** (order ID, user ID) over auto-generated IDs to make dedup possible.
- **Atomic compare-and-set** for state transitions.

**Follow-ups:**
- *What is the canonical idempotency-key contract?* Stripe's: accept an `Idempotency-Key` header, persist first response for 24 hours, return the cached response for repeat requests within the window. This is what every production system copies.
- *Is "only retry on connection errors" a substitute for idempotency?* No. A response can be lost after the server committed, and the SDK has no way to tell. You must assume any retried request may have already succeeded.
- *Does this apply to workflow code too?* Workflow code itself does not retry (replay reproduces the same decisions). But every *activity* must be idempotent because activities genuinely retry.

### Junior → FAANG: How to Structure Your Interview Answers on Workflow Patterns

Workflow orchestration is a common system design topic at FAANG because it appears in almost every backend system: order processing, data pipelines, approval flows, notification systems. The five questions above cover the canonical topics. Here is how to structure your approach at the entry level.

**Lead with the problem, then the solution.** Do not open with "Temporal uses workflow.GetVersion." Open with "When you redeploy a worker while thousands of workflows are executing, the replayed execution sees different code than the original execution, causing a nondeterminism error. The solution is to gate behavioral changes behind `workflow.GetVersion` markers in the history." This framing shows you understand the problem that motivates the pattern.

**Draw before you code.** For saga questions, draw the forward steps and their compensations on the whiteboard before writing code. The drawing clarifies the LIFO ordering, makes the compensation tree structure visible, and gives you a plan to code from. Interviewers evaluate your design process, not just your final answer.

**Enumerate failure cases explicitly.** For any pattern question, the interviewer expects you to address failure cases without being prompted. For fan-out: what if one activity fails? For saga: what if the compensation fails? For approval: what if the approver never responds? Proactively covering failure cases demonstrates that your mental model is production-realistic, not just happy-path.

**Know one concrete example for each pattern.** A concrete example ("Stripe uses idempotency keys exactly this way") is more convincing than an abstract explanation. For each pattern in this chapter, prepare one real-world example you can cite.

**If you do not know the answer to a follow-up, say so and reason from first principles.** "I haven't implemented Worker Build IDs specifically, but reasoning from the problem: if `GetVersion` gates accumulate over time, you want a way to express compatibility at the deployment level rather than the code level. Build IDs assigned to specific deployments would let the server route executions to compatible workers without requiring code gates." This is more impressive than a confident wrong answer.

### Senior @ FAANG: Interview Signals at L6/L7 for Workflow Architecture

At the senior and staff level, workflow interview questions are not about syntax or API knowledge. They probe architectural judgment, failure-mode thinking, and platform-scale reasoning. The bar-raiser is looking for signals that the candidate operates at the L6/L7 scope.

**L6/L7 signal: the candidate reframes the problem.** A L4 candidate answers "how do you implement a saga?" by describing the compensation tree. A L6 candidate answers by first asking: "Is this a saga or a distributed transaction problem? What is the team boundary here? Does each step cross a service boundary or are they within one service?" The reframing reveals that the candidate evaluates whether the saga pattern is appropriate before implementing it.

**L6/L7 signal: the candidate addresses the operational lifecycle, not just the implementation.** Saga, fan-out, versioning: each pattern has an operational lifecycle (gate cleanup, compensation runbooks, cluster capacity). A candidate who describes only the initial implementation and ignores the lifecycle is demonstrating L4 scope. An L6 candidate includes: "After shipping this, we need a gate deletion policy because gates accumulate. We need an alert for workflows that are stuck in compensation. We need a test that replays representative histories before each deployment."

**L6/L7 signal: the candidate distinguishes the pattern from its implementation.** The saga pattern is a concept from distributed systems theory. Temporal's orchestration-based saga is one implementation. The candidate who can explain the pattern without referencing Temporal, then explain why Temporal's implementation is preferable to choreography-based alternatives, is demonstrating knowledge at a level above the tooling.

**L6/L7 signal: the candidate raises the governance question without prompting.** "Who owns the compensation activity for the inventory step?" is not in the implementation. It is a governance question. Raising it demonstrates that the candidate thinks about multi-team systems, not just single-workflow implementations. At FAANG, workflows span team boundaries by design. Staff engineers make the cross-team contracts explicit before the code is written.

**L6/L7 signal: quantitative reasoning about scale limits.** "At 50,000 history events per workflow, and each fan-out activity contributing 3 events, the maximum fan-out in a single workflow is roughly 16,000 items before the history limit is reached. For larger inputs, we need hierarchical child workflows." This quantitative reasoning applied directly to the problem, without being prompted, is a bar-raiser signal. Prepare one quantitative limit for each pattern (history events for fan-out, task queue throughput for batching, selector overhead for concurrency control) and use it appropriately.

---
