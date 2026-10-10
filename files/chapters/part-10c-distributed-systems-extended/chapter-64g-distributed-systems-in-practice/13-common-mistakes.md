## Common Mistakes and How to Avoid Them

### 1. Not Documenting Partition Behavior

Every service that depends on a network-accessible resource should document: what happens if that resource is unreachable? Most services don't. This becomes a problem during incidents when engineers can't tell if degraded behavior is expected or a bug.

**Fix**: Add a `PARTITION_BEHAVIOR.md` or section in the service README:
```markdown
- Redis unavailable: Serve stale cache for up to 30 minutes. After TTL expiry, return 503.
- PostgreSQL unavailable: Return 503 immediately. No cache fallback for writes.
- Kafka unavailable: Buffer events in memory up to 10,000 items. After buffer full, return 503.
```

### Junior → FAANG: Common Mistakes as a Pre-Submission Checklist

The six common mistakes in this section and the following file represent the most frequently cited issues in FAANG distributed systems code reviews. Before submitting any pull request that touches a distributed service, scan the code for each one: undocumented partition behavior, wall clock used for event ordering, PACELC "else" case ignored, retry without idempotency key, tests that only cover happy paths, and `context.Background()` used in handlers that receive an incoming context.

Of these six, the most commonly missed by engineers new to distributed systems is retry without idempotency. The instinct is to add retries to improve reliability. The correct instinct is to ask "is this operation safe to retry?" before adding retries. Payment and email operations are not safe to retry without deduplication. Most operations can be made safe with an idempotency key. Knowing this distinction and applying it automatically is a first-job skill that pays dividends throughout a career.

For interviews: when asked "how do you make your service reliable?", the answer that includes idempotency keys, context propagation, and documented partition behavior is the L5 answer. The answer that only mentions retries and load balancing is the L4 answer.

### Senior @ FAANG: Mistake Prevention as Platform Defaults

At senior level, the goal is to make each of these mistakes structurally difficult to make, not just to document them. The most valuable interventions are platform-level defaults that encode the correct behavior.

**Partition behavior documentation as a deployment requirement.** If the deployment pipeline requires a `partition_behavior` field in the service manifest before a service can be promoted to production, the documentation gap becomes a deployment blocker rather than a code review suggestion. Staff engineers propose this as a platform policy and implement the manifest validation in the deployment tooling. The field does not need to be long: three lines per dependency, as shown in the example, is sufficient. The requirement makes the conversation about partition behavior happen during design (where it is cheap) rather than during an incident (where it is expensive).

**Idempotency key enforcement at the framework level.** Services at FAANG that handle payment, order, or any financially consequential operation should use a framework that enforces idempotency key extraction at the request handling layer. The framework extracts the idempotency key from the request header, checks it against a deduplication store, and either processes the request (key not seen) or returns the cached result (key already processed). Application code never needs to implement this check manually. Staff engineers build or adopt this framework and require its use for all financially consequential endpoints via code review policy and static analysis.

**`context.Background()` as a lint error.** Using `context.Background()` inside a request handler that receives a context is a correctness error: it discards the caller's deadline, disconnects the cancellation chain, and breaks distributed tracing. This is detectable by static analysis. `go vet` does not catch it by default, but custom lint rules (using `golangci-lint` with a custom analyzer) can flag calls to `context.Background()` in functions that have a `context.Context` parameter. Making this a blocking lint error eliminates the entire class of "forgot to propagate context" bugs without requiring code review to catch them.

**Wall clock for event ordering as an architectural constraint.** Using `time.Now()` for distributed event ordering is not a coding mistake: it is an architectural mistake that requires an architectural fix. The correct platform response is to make HLC the default timestamp type in all event and message schemas, so that engineers who follow the standard schema automatically get causal ordering. The wall clock timestamp remains as a display-only field. This architectural default converts a class of correctness bugs into a configuration error (using the wrong timestamp field) that is much more visible and much easier to catch in code review.

---
