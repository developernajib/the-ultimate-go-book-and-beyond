## Summary

Event-driven architecture enables loosely coupled, scalable systems. Key takeaways:

1. **Events vs Commands**: Events are facts (past tense), commands are requests (imperative)
2. **Message Brokers**: Kafka for high-throughput streaming, RabbitMQ for complex routing, NATS for low-latency
3. **Exactly-Once**: Use the outbox pattern with database transactions for reliable event publishing
4. **Event Sourcing**: Store events as the source of truth, rebuild state by replaying
5. **CQRS**: Separate read and write models for optimized queries
6. **Projections**: Build materialized views from event streams
7. **Versioning**: Plan for event schema evolution from the start
8. **Idempotency**: Handle duplicate events gracefully

### Junior → FAANG: Turning the Summary Into an Interview Preparation Checklist

The eight points in this summary are the vocabulary of any EDA discussion. Before any technical interview that touches distributed systems, verify you can do the following for each point.

For events vs commands: give a concrete example of each from a domain you have worked in (not an order system, since that is in the chapter). Applying the concept to a new domain shows you understand it, not just memorized it.

For message brokers: state one scenario where Kafka is wrong and RabbitMQ is right, one where NATS is right and Kafka is overkill, and one where none of the three is the right choice (hint: Redis Streams or a managed service like SQS).

For exactly-once: trace the complete flow of an order creation through the outbox pattern in 30 seconds or less. Producer writes both rows in one transaction, commit, relay polls, relay publishes to Kafka, relay marks as sent. Consumer checks deduplication table, processes, records event ID, commits. This flow should be automatic.

For event sourcing: explain the `applyEvent` invariant (no side effects, pure state reconstruction) and the snapshot tradeoff (faster load at the cost of snapshot write overhead) in under one minute.

For CQRS: state the eventual consistency implication (read model may lag the write model by milliseconds to seconds) and one API design pattern that addresses it (polling with command ID, or accepting stale data with a documented SLO).

For versioning: name the three compatibility modes (backward, forward, full) and which one you would enforce by default in a CI pipeline and why (full, because it is safe regardless of producer/consumer deploy order).

For idempotency: distinguish natural idempotency (an upsert that produces the same result on repeated application) from enforced idempotency (a deduplication table keyed on event ID). Know when each is appropriate.

### Senior @ FAANG: What the Summary Omits That Staff Engineers Must Know

The eight summary points are correct but incomplete for a staff-level practitioner. Here is what the summary does not cover that a bar-raiser will probe.

**Operational concerns are first-class architecture.** The summary covers design patterns but not the operational properties that determine whether those patterns are viable in production. For a staff engineer, every pattern comes with an operational corollary: event sourcing requires a projection rebuilder and a rebuild runbook, the outbox requires a relay health dashboard and a lag alert, and CQRS requires a consistency SLO for the read model and a documented API contract. If you cannot articulate the operational requirements of each pattern, you have not fully specified the design.

**Schema governance is the glue that holds EDA together.** The summary mentions versioning but not the schema registry, compatibility enforcement, consumer census, and deprecation process that make versioning workable at scale. At staff level, schema governance is the most important non-code architectural decision in an EDA system. Getting it right prevents a category of production incidents. Getting it wrong creates a hidden tax that grows with every new event type and every new consumer.

**The organizational structure shapes the architecture.** Conway's Law applies directly to EDA: the event schema boundaries will mirror the team boundaries. Events that cross team boundaries are public APIs and require the full rigor of public API governance (versioning, deprecation policy, consumer census, compatibility SLO). Events within a single team's bounded context can evolve more freely. A staff engineer designs event schemas with team structure in mind, not just domain modeling.

**Failure mode analysis is the senior signal.** For every component in the summary (broker, outbox relay, projection, CQRS read model), a bar-raiser will ask: what happens when this component fails? What does the system do, what does the user see, and how long until recovery? If your answer is "it falls back gracefully" without a specific description of what "gracefully" means in practice, you have not thought it through. Write the failure modes down for each component before the interview.

---
