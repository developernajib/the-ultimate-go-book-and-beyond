## 52D.14 Common Mistakes

**1. Not separating domain events from integration events.**

Domain events contain rich domain types. Integration events published to Kafka should be simplified, versioned DTOs. Don't publish your domain event directly to Kafka - translate it first.

**2. Huge event payloads.**

An event should record what happened, not snapshot the entire aggregate state. `MoneyWithdrawn{AmountCents: 5000, BalanceAfter: 95000}` is correct. An event containing the entire account history is wrong.

**3. Eventual consistency violations.**

A common mistake: showing a user their updated balance immediately after a deposit, reading from the (not yet updated) read model. Design your UI and API to handle this: either read from the write side for immediate confirmation, or use optimistic UI updates.

**4. Not handling projection failures.**

If a projector fails mid-batch, some events are projected and some are not. The projection is now inconsistent. Always track the last projected event position, and design projectors to be idempotent - projecting the same event twice should produce the same result.

**5. Using CQRS and Event Sourcing for everything.**

This is the most common mistake. Apply these patterns only where the complexity pays off: high-value, complex domains with audit requirements, read/write asymmetry, or need for temporal queries. Your user settings service does not need event sourcing.

**6. Not versioning events.**

As your domain evolves, event schemas change. If you add a field to an event, historical events don't have it. Implement upcasting: when deserializing an old event, upgrade it to the current version.

```go
// Upcast: V1 MoneyDeposited didn't have BalanceAfter
// V2 adds BalanceAfter
func (s *JSONEventSerializer) upcasterForMoneyDeposited(v1 json.RawMessage) (json.RawMessage, error) {
    var payload map[string]any
    if err := json.Unmarshal(v1, &payload); err != nil {
        return nil, err
    }
    // Add missing field with a default
    if _, ok := payload["balance_after"]; !ok {
        payload["balance_after"] = 0 // will be corrected by replaying earlier events
    }
    return json.Marshal(payload)
}
```

### Junior → FAANG: Turning Mistake Patterns into Code Review Habits

The six mistakes in this section are your code review checklist. Before approving any PR that touches event sourcing or CQRS, mentally scan each one.

Mistake 1 (domain events vs integration events): look for places where the codebase publishes a domain event struct directly to Kafka or NATS. If the domain event contains unexported fields, typed IDs, or internal enums, it is the wrong type to publish externally. The integration event should be a plain, JSON-serializable DTO.

Mistake 2 (huge event payloads): open the event structs and estimate their serialized size. If any event would produce more than 1-2 KB of JSON for a typical instance, question what is in it. Events should carry what happened plus the IDs needed to correlate with other data, not a full snapshot of all related entities.

Mistake 3 (eventual consistency violations): search for API handlers that write via the command side and immediately read from the query side. Those call sites are potential "I can't see my own write" bugs. Either return the new state from the command response, or document the lag acceptance explicitly.

Mistake 4 (projector idempotency): for every `INSERT` in a projector, check for `ON CONFLICT`. For every `UPDATE` that increments a counter, flag it as non-idempotent and require the PR author to explain how they handle duplicate delivery.

Mistake 5 (CQRS everywhere): ask in every PR that introduces CQRS or Event Sourcing: "what is the specific problem this solves?" If the answer is "it's the architecture we use," that is not an answer.

Mistake 6 (event versioning): whenever a PR changes an event struct, check whether the `Deserialize` switch case was updated and whether an upcaster was added for historical events that lack the new field.

### Senior @ FAANG: The Organizational Dimension of Common Mistakes

The six mistakes in this section have individual fixes (documented here and in the code), but they also have organizational causes. Senior engineers address both.

Mistake 1 (domain vs integration events) recurs because teams do not have a clear policy on what crosses service boundaries. The fix is not just technical: it requires a published API contract for each service that distinguishes internal event schemas (owned by the service, can change freely) from external event schemas (public contract, versioned, governed by a compatibility policy). Without this policy, every engineer makes a judgment call, and the calls are inconsistent. The staff-level contribution is authoring the policy and the tooling to enforce it (schema registry, compatibility checks in CI).

Mistake 3 (eventual consistency violations) is often discovered not in code review but in QA or production. The reason: developers test by running the command and then immediately reading the result in the same test thread, which often works because the projector runs synchronously in test mode. The failure only manifests when projectors are async, which is production-only in many setups. The mitigation is a test mode that enforces async projection even in unit tests, forcing developers to confront the lag during development rather than at production deployment.

Mistake 5 (CQRS everywhere) is an architectural governance failure. It happens when CQRS is adopted as a team-wide standard before the team has the operational maturity to maintain projections, rebuild procedures, and lag monitoring. The pattern then accumulates technical debt at scale because teams apply it to services where the read/write model shapes are identical and the projection is a pass-through copy. The staff-level intervention is an adoption gate: require teams to document the read/write shape divergence before introducing CQRS, and require a working rebuild procedure and lag SLO before a CQRS service goes to production.

Mistake 6 (event versioning) is the most dangerous at scale because it is silent. Events written in an old schema are deserialized by new code that has no upcaster. Instead of an error, the struct gets zero values for missing fields. The account's `channel` field defaults to `""` instead of `"unknown"`. Projections built from these events have incorrect data, and the bug may not be noticed until a compliance audit. The mitigation is a schema registry with required version metadata, and a deserialization test fixture that includes event payloads from every historical schema version, verified to deserialize correctly with the current upcasting chain.

---
